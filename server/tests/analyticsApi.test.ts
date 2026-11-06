import assert from 'node:assert/strict';
import { settledExecute } from './helpers/startRun.ts';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ExecutorProfile, TaskRecord } from '../src/domain/types.ts';
import type { ExecutorLimits } from '../src/executors/executorLimits.ts';
import type { AgentDayView, StepRoundRow } from '../src/analytics/analyticsService.ts';
import type { HistoryStorage } from '../src/analytics/analyticsHistory.ts';
import type { TokenCounts } from '../src/analytics/types.ts';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import { fakeClock, fakeProvider, HOUR, limits, MINUTE, tokens, type FakeClock } from './helpers/analyticsFakes.ts';
import { autoAdvanceTerminalSteps, fakeTerminalHost, type StepAction } from './helpers/terminalStepFakes.ts';

/**
 * Agent analytics through the daemon's own HTTP API, with real Task and WorkflowRun events feeding the
 * recorder. Provider readings and CLI usage are fakes on an injected clock; no account, credential or
 * CLI is touched. The fixture's profiles are placeholders that could never run.
 */

const SECRET_PROMPT = 'SECRET-PROMPT-TEXT';
const DAY = 24 * HOUR;
const CLAUDE = 'test-claude-cli';
const TWIN = 'test-claude-cli-twin';
const ALT = 'test-claude-cli-alt';
const STEPS = [
  { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Implement the task.' },
  { id: 'review', name: 'Code Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Review the diff.', loopBack: { toStepId: 'build', maxRounds: 3 } },
  { id: 'signoff', name: 'Human Code Review', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Write a review brief.' },
];

let tempRoot: string;
let executorsPath: string;
let baseUrl: string;
let server: HttpServer;
let clock: FakeClock;
let hookToken: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let collections: typeof import('../src/db/collections.ts');
let analyticsModule: typeof import('../src/analytics/index.ts');
let identity: typeof import('../src/analytics/accountIdentity.ts');
let fileStorage: HistoryStorage;
let analytics: ReturnType<typeof import('../src/analytics/index.ts')['createAnalytics']>;
let providers: { claude: ReturnType<typeof fakeProvider>; codex: ReturnType<typeof fakeProvider> };
const storageFaults = { failWrites: false };
const cliUsage = new Map<string, TokenCounts | null>();

type Manager = ReturnType<typeof import('../src/worker/workerManager.ts')['createWorkerManager']>;

/** History on real files under the temp data dir, with a switch that makes saving fail. */
function faultyStorage(inner: HistoryStorage): HistoryStorage {
  return { read: (name) => inner.read(name), write: async (name, text) => { if (storageFaults.failWrites) throw new Error('disk full'); await inner.write(name, text); } };
}

function buildAnalytics(storage: HistoryStorage, listExecutors?: () => Promise<ExecutorProfile[]>) {
  const claude = fakeProvider('claude-cli', clock, (executor) => identity.accountIdentity(executor));
  const codex = fakeProvider('codex-cli', clock, (executor) => identity.accountIdentity(executor));
  // Only the default Claude account is signed in; the alternate one has no access.
  claude.accepts = (executor) => !executor.env.CLAUDE_CONFIG_DIR;
  codex.accepts = () => false;
  const built = analyticsModule.createAnalytics({
    storage,
    now: clock.now,
    listExecutors,
    pollers: { 'claude-cli': claude.poller, 'codex-cli': codex.poller },
    readLimits: async (executor) => (executor.kind === 'codex-cli' ? codex : claude).poller.get(executor),
    readUsage: async (_kind, file) => {
      const usage = cliUsage.get(file);
      return usage ? { usage, conversation: null } : null;
    },
  });
  return { built, claude, codex };
}

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'analytics-api-'));
  executorsPath = path.join(tempRoot, 'executors.json');
  const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures', 'executors.json'), 'utf8')) as { executors: ExecutorProfile[] };
  // A second profile on the same account as the first, and a credential-like value that must never be saved.
  fixture.executors.push({ id: TWIN, label: 'Test Claude CLI (twin profile)', kind: 'claude-cli', bin: 'claude-twin', env: {} });
  fixture.executors.find((executor) => executor.id === ALT)!.env.ANTHROPIC_API_KEY = 'sk-SECRET-CREDENTIAL';
  await writeFile(executorsPath, JSON.stringify(fixture));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = executorsPath;
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  collections = await import('../src/db/collections.ts');
  analyticsModule = await import('../src/analytics/index.ts');
  identity = await import('../src/analytics/accountIdentity.ts');
  hookToken = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
  const workflowService = await import('../src/catalog/workflowService.ts');
  const { fileHistoryStorage } = await import('../src/analytics/analyticsHistory.ts');
  const { createDaemonServer } = await import('../src/server.ts');
  await workflowService.updateWorkflow('software-development', { name: 'Software Development', description: 'Test workflow.', steps: STEPS });

  clock = fakeClock(Date.now());
  fileStorage = faultyStorage(fileHistoryStorage(path.join(tempRoot, 'data', 'analytics')));
  const first = buildAnalytics(fileStorage);
  analytics = first.built;
  providers = first;
  // The CLI hook route drives the daemon's own manager, so its events are recorded too.
  workerManagerModule.workerManager.onWorkerEvent((event) => analytics.recorder.handle(event));
  server = createDaemonServer({ analytics: { service: analytics.service, recordCliUsage: (session, turnEnded) => { void analytics.recorder.recordCliUsage(session, turnEnded); } } });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

/** The agent's view of the day around the injected clock. */
async function day(agentId = CLAUDE): Promise<AgentDayView> {
  const { status, body } = await api(`/api/analytics/agents/${agentId}?from=${clock.now() - 12 * HOUR}&to=${clock.now() + 12 * HOUR}`);
  assert.equal(status, 200);
  return body as AgentDayView;
}

async function steps(agentId = CLAUDE): Promise<StepRoundRow[]> {
  const { status, body } = await api(`/api/analytics/agents/${agentId}/steps`);
  assert.equal(status, 200);
  return body.rows as StepRoundRow[];
}

const refresh = (agentId = CLAUDE) => api(`/api/analytics/agents/${agentId}/refresh`, { method: 'POST' });

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One sample at the clock's time with the given used percentages, as the daemon's timer would take it. */
async function sample(fiveHour: number | null, sevenDay: number | null, resets?: Parameters<typeof limits>[3]): Promise<void> {
  providers.claude.next = limits(clock.now(), fiveHour, sevenDay, resets);
  await analytics.sampler.tick();
}

let projectCount = 0;
async function newProject() {
  // Created through the service, not POST /api/projects, so no docs-bootstrap Task (and no real CLI) starts.
  return projectService.createProject({ name: `Analytics ${(projectCount += 1)}`, position: null });
}

async function fakeSummarizerTurn(): Promise<ClaudeTurnResult> {
  return {
    sessionId: 'summary-session', status: 'done', message: 'ok',
    extra: { tldr: 'Done.', requirement: 'req', whatWasDeveloped: 'dev', reviewHighlights: 'None', docsUpdated: 'None', retroUpdates: 'None' },
    usage: { inputTokens: 11, outputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    raw: { type: 'result' },
  };
}

async function onlyClaude(): Promise<ExecutorProfile[]> {
  const { listExecutors } = await import('../src/executors/executorService.ts');
  return (await listExecutors()).filter((executor) => executor.id === CLAUDE);
}

/** A manager whose events feed the analytics recorder, as the daemon's own does. */
function recordedManager(deps: Parameters<typeof workerManagerModule.createWorkerManager>[0]): Manager {
  const manager = workerManagerModule.createWorkerManager({
    runClaudeTurn: fakeSummarizerTurn,
    trackBackgroundTurn: analytics.recorder.trackBackground,
    // Headless turns pick the least-used agent; pin it so no real limits (or keychain) are ever read.
    listExecutors: onlyClaude,
    getExecutorLimits: async () => null,
    ...deps,
  });
  manager.onWorkerEvent((event) => analytics.recorder.handle(event));
  return manager;
}

/** Starts a workflow run whose steps follow `actions`; a step with no action stays running. */
async function startRun(actions: (ref: { current?: Manager }) => Record<string, StepAction>) {
  const project = await newProject();
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Ship analytics', description: `${SECRET_PROMPT} build it` });
  const ref: { current?: Manager } = {};
  const { host, starts } = autoAdvanceTerminalSteps(ref, actions(ref));
  host.sessionExists = () => true;
  const manager = recordedManager({ terminalSessions: host });
  ref.current = manager;
  const first = await settledExecute(manager)(item.id, { executorId: CLAUDE });
  const runId = first.workflowRunId!;
  const roundTask = async (stepId: string, round: number) => {
    const stepRun = (await manager.getWorkflowRunDetail(runId)).steps.find((entry) => entry.step.id === stepId)!.rounds.find((entry) => entry.round === round);
    return stepRun?.taskId ?? null;
  };
  const waitForStatus = (status: string) => waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === status);
  return { manager, project, item, runId, starts, roundTask, waitForStatus };
}

const recorded = async () => { await analytics.recorder.idle(); };
/**
 * Waits until the Task's session is closed in history. A Task's stored status changes a moment before
 * its final event is emitted, so the Task record alone does not say the recorder has seen the end.
 */
async function sessionEnded(taskId: string): Promise<void> {
  await waitUntil(async () => { await recorded(); return (await analytics.history.activity(taskId))?.endedAt != null; });
}
const activityOf = async (taskId: string) => (await day()).activities.find((activity) => activity.id === taskId);

// ---- Readings ----

test('I05 with no configured agents the list is empty and nothing is invented', async () => {
  const { built } = buildAnalytics({ read: async () => null, write: async () => undefined }, async () => []);
  assert.deepEqual((await built.service.listAgents()).agents, []);
  await built.sampler.tick();
  await assert.rejects(built.service.getDay(CLAUDE, clock.now() - HOUR, clock.now()), /has no analytics/);
});

test('I03 a day with no readings returns empty series and an awaiting state, not zeros', async () => {
  const view = await day();
  assert.deepEqual([view.series.fiveHour, view.series.sevenDay], [{ points: [], gaps: [], resets: [] }, { points: [], gaps: [], resets: [] }]);
  assert.deepEqual(view.current.fiveHour, { state: 'awaiting', remaining: null, used: null, observedAt: null, resetsAt: null });
  assert.deepEqual([view.check.lastSuccessAt, view.unattributed], [null, []]);
});

test('I18 a planning session and a coding Task running together on one account appear as two overlapping intervals flagged shared', async () => {
  // Readings bracket both sessions: one just before they start, one just after they end. Run first,
  // while the injected clock still matches the real time the Task events are stamped with.
  await sample(20, 39);
  const run = await startRun(() => ({}));
  const codingTask = await waitFor(() => run.roundTask('build', 1));
  const terminal = fakeTerminalHost();
  const planner = recordedManager({ terminalSessions: terminal.host });
  const plan = await planningSession(planner, (await newProject()).id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  terminal.starts[0]!.onExit(0);
  await run.manager.stopWorkflowRun(run.runId);
  await run.waitForStatus('stopped');
  await sessionEnded(codingTask);
  await sessionEnded(plan.id);
  // The next scheduled sample, five minutes on: still close enough to the sessions' end to bound them.
  clock.advance(5 * MINUTE);
  await sample(21.5, 39.5);

  const view = await day();
  const [coding, planning] = [view.activities.find((activity) => activity.id === codingTask)!, view.activities.find((activity) => activity.id === plan.id)!];
  assert.deepEqual([coding.kind, planning.kind, planning.workflow, planning.label], ['coding', 'planning', null, 'Planning session #1']);
  assert.ok(coding.startedAt < planning.endedAt! && planning.startedAt < coding.endedAt!, 'the two intervals overlap');
  for (const activity of [coding, planning]) {
    assert.deepEqual([activity.decrease.fiveHour.available, activity.decrease.fiveHour.sharedWith], [true, 1]);
    assert.equal(activity.decrease.fiveHour.available && activity.decrease.fiveHour.points, 1.5, 'each shows the whole decrease, undivided');
  }
  assert.deepEqual(planning.target, { kind: 'task', projectId: planning.target!.projectId, taskId: plan.id });
});

test('I27 the agents list and its footer usage figures are unchanged by collection', async () => {
  const before = (await api('/api/executors')).body as (ExecutorProfile & { usage: unknown; limits: ExecutorLimits | null })[];
  clock.advance(MINUTE);
  await sample(22, 40);
  const afterSample = (await api('/api/executors')).body as typeof before;
  assert.deepEqual(afterSample.map((executor) => [executor.id, executor.usage]), before.map((executor) => [executor.id, executor.usage]));
  assert.deepEqual(Object.keys(afterSample[0]!).sort(), ['bin', 'env', 'id', 'isDefault', 'kind', 'label', 'limits', 'usage']);
});

test('I01 analytics for an agent returns current remaining for both windows with observation and reset times', async () => {
  clock.advance(5 * MINUTE);
  const resets = { fiveHour: clock.now() + 3 * HOUR, sevenDay: clock.now() + 4 * DAY };
  await sample(22, 40, resets);
  const view = await day();
  assert.deepEqual(view.current.fiveHour, { state: 'measured', remaining: 78, used: 22, observedAt: clock.now(), resetsAt: resets.fiveHour });
  assert.deepEqual(view.current.sevenDay, { state: 'measured', remaining: 60, used: 40, observedAt: clock.now(), resetsAt: resets.sevenDay });
  assert.deepEqual([view.check.lastSuccessAt, view.check.lastFailure, view.agent.id, view.agent.retired], [clock.now(), null, CLAUDE, false]);
});

test('I06 calling the read endpoints ten times adds no readings', async () => {
  const before = (await day()).series.fiveHour.points.length;
  for (let call = 0; call < 10; call += 1) {
    await day();
    await api('/api/analytics/agents');
    await api(`/api/analytics/agents/${CLAUDE}/steps`);
    await api('/api/executors');
  }
  assert.equal((await day()).series.fiveHour.points.length, before);
});

test('I07 with the sampler running on a fake clock and no client connected, twelve ticks store twelve points', async () => {
  const before = (await analytics.history.readingsFor(identity.accountIdentity({ kind: 'claude-cli', bin: '', env: {} }))).length;
  for (let tick = 0; tick < 12; tick += 1) {
    clock.advance(5 * MINUTE);
    await sample(23 + tick * 0.5, 40);
  }
  const view = await day();
  assert.equal(view.series.fiveHour.points.length, before + 12);
  assert.deepEqual(view.series.fiveHour.gaps, []);
  assert.equal(new Set(view.series.fiveHour.points.map((point) => point.at)).size, before + 12, 'one point per observation');
});

test('I02 analytics for a selected day returns that day\'s readings, gaps, resets and activity, and only that day\'s', async () => {
  // Half an hour without a reading, then the 5h window resets.
  clock.advance(30 * MINUTE);
  await sample(31, 41);
  clock.advance(5 * MINUTE);
  await sample(2, 41.5, { fiveHour: clock.now() + 5 * HOUR });
  const view = await day();
  assert.deepEqual(view.series.fiveHour.gaps.map((gap) => gap.reason), ['no-readings']);
  assert.deepEqual(view.series.fiveHour.resets.map((reset) => [reset.at, reset.after]), [[clock.now(), 98]]);
  assert.deepEqual(view.series.sevenDay.resets, [], 'the 7d window carries on through a 5h reset');
  assert.ok(view.series.fiveHour.points.every((point) => point.at >= view.range.from && point.at <= view.range.to));
  const earlier = (await api(`/api/analytics/agents/${CLAUDE}?from=${clock.now() - 3 * DAY}&to=${clock.now() - 2 * DAY}`)).body as AgentDayView;
  assert.deepEqual([earlier.series.fiveHour.points, earlier.activities], [[], []]);
});

test('I04 a day outside retention, a malformed range and an unknown agent each return a clear error', async () => {
  const outside = await api(`/api/analytics/agents/${CLAUDE}?from=${clock.now() - 92 * DAY}&to=${clock.now() - 91 * DAY}`);
  assert.deepEqual([outside.status, outside.body.error], [400, 'That day is older than the 90 days of history kept']);
  const malformed = await api(`/api/analytics/agents/${CLAUDE}?from=yesterday&to=today`);
  assert.deepEqual([malformed.status, malformed.body.error], [400, 'from and to must be times in milliseconds']);
  assert.equal((await api(`/api/analytics/agents/${CLAUDE}`)).status, 400, 'a missing range is malformed too');
  assert.equal((await api(`/api/analytics/agents/${CLAUDE}?from=${clock.now()}&to=${clock.now() - HOUR}`)).status, 400);
  assert.equal((await api(`/api/analytics/agents/${CLAUDE}?from=${clock.now() - 3 * DAY}&to=${clock.now()}`)).status, 400);
  assert.equal((await api(`/api/analytics/agents/${CLAUDE}?from=${clock.now() + DAY}&to=${clock.now() + 2 * DAY}`)).status, 400);
  for (const pathname of [`/api/analytics/agents/nobody?from=${clock.now() - HOUR}&to=${clock.now()}`, '/api/analytics/agents/nobody/steps']) {
    const unknown = await api(pathname);
    assert.deepEqual([unknown.status, /has no analytics/.test(unknown.body.error)], [404, true]);
  }
  assert.equal((await api('/api/analytics/agents/nobody/refresh', { method: 'POST' })).status, 404);
});

test('I09 manual refresh: eligible returns a new reading; a second call inside the throttle keeps it and says when another check is eligible', async () => {
  clock.advance(5 * MINUTE);
  providers.claude.next = limits(clock.now(), 5, 42);
  const first = await refresh();
  assert.deepEqual([first.status, first.body.result, first.body.check.lastSuccessAt], [200, 'refreshed', clock.now()]);
  const calls = providers.claude.calls;
  const observedAt = clock.now();
  clock.advance(10_000);
  const second = await refresh();
  assert.deepEqual([second.status, second.body.result, second.body.check.lastSuccessAt, second.body.nextEligibleAt], [200, 'not-eligible', observedAt, observedAt + MINUTE]);
  assert.equal(providers.claude.calls, calls, 'the provider was not contacted again');
  assert.equal((await day()).check.nextEligibleAt, observedAt + MINUTE);
});

test('I10 a manual refresh the provider fails returns the failure with the last good reading and its time, and history is unchanged', async () => {
  const before = await day();
  clock.advance(5 * MINUTE);
  providers.claude.next = new Error('provider offline');
  const failed = await refresh();
  assert.deepEqual([failed.status, failed.body.result, failed.body.failureReason], [200, 'failed', 'provider-error']);
  assert.deepEqual(failed.body.check.lastFailure, { at: clock.now(), reason: 'provider-error' });
  assert.equal(failed.body.check.lastSuccessAt, before.check.lastSuccessAt);
  const view = await day();
  assert.deepEqual(view.series.fiveHour.points, before.series.fiveHour.points, 'no reading was lost or invented');
  assert.deepEqual([view.current.fiveHour.state, view.current.fiveHour.remaining, view.current.fiveHour.observedAt], ['failed', 95, before.check.lastSuccessAt]);
  assert.deepEqual(view.series.fiveHour.gaps.at(-1), { from: before.check.lastSuccessAt, to: clock.now(), reason: 'check-failed' });
});

test('I11 a history-write failure during refresh still returns the fresh reading, with a save-error flag', async () => {
  clock.advance(HOUR);
  providers.claude.next = limits(clock.now(), 9, 43);
  storageFaults.failWrites = true;
  try {
    const result = await refresh();
    assert.deepEqual([result.body.result, result.body.check.lastSuccessAt], ['refreshed', clock.now()]);
    assert.match(result.body.history.saveError, /could not be saved/);
    const view = await day();
    assert.deepEqual([view.current.fiveHour.remaining, view.history.saveError !== null], [91, true]);
  } finally {
    storageFaults.failWrites = false;
  }
  clock.advance(5 * MINUTE);
  await sample(10, 43);
  assert.equal((await day()).history.saveError, null, 'the next good save clears the flag');
});

test('I12 two profiles on one account return the same series and a shared-account notice naming the other profile', async () => {
  const [own, twin, alt] = [await day(CLAUDE), await day(TWIN), await day(ALT)];
  assert.deepEqual(twin.series, own.series);
  assert.deepEqual([own.agent.sharedWith, twin.agent.sharedWith, alt.agent.sharedWith], [['Test Claude CLI (twin profile)'], ['Test Claude CLI'], []]);
  assert.deepEqual(alt.series.fiveHour.points, [], 'another account has its own, empty, series');
  const agents = (await api('/api/analytics/agents')).body.agents as { id: string }[];
  assert.deepEqual(agents.map((agent) => agent.id), [CLAUDE, ALT, 'test-codex-cli', 'test-unsupported', TWIN]);
});

test('I08 history written before a daemon restart is served after it', async () => {
  const before = await day();
  const restarted = buildAnalytics(fileStorage).built;
  const view = await restarted.service.getDay(CLAUDE, before.range.from, before.range.to);
  assert.deepEqual(view.series, before.series);
  assert.equal(view.check.lastSuccessAt, before.check.lastSuccessAt);
  assert.deepEqual((await restarted.service.listAgents()).agents.map((agent) => agent.id), [CLAUDE, ALT, 'test-codex-cli', 'test-unsupported', TWIN]);
});

// ---- Activity ----

test('I14 starting a step round opens an interval; completing it closes the interval at the real completion time', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const run = await startRun((ref) => ({ build: async (id) => { await held; await ref.current!.completeStep(id, { summary: 'built' }); } }));
  const taskId = await waitFor(() => run.roundTask('build', 1));
  await recorded();
  const open = (await activityOf(taskId))!;
  assert.deepEqual([open.kind, open.endedAt, open.workflow, open.label, open.projectName], ['coding', null, { name: 'Software Development', stepName: 'Development', round: 1 }, 'Ship analytics', run.project.name]);
  assert.deepEqual(open.target, { kind: 'run', projectId: run.project.id, runId: run.runId, stepId: 'build', round: 1 });

  release();
  await waitUntil(async () => (await run.manager.getTask(taskId)).status === 'done');
  await sessionEnded(taskId);
  await recorded();
  const task = await run.manager.getTask(taskId);
  const closed = (await activityOf(taskId))!;
  assert.equal(closed.endedAt, Date.parse(task.runtimeStatusChangedAt!));
  assert.deepEqual(closed.segments, [{ state: 'active', start: closed.startedAt, end: closed.endedAt }]);
  assert.equal(closed.approximate, false);
  await run.manager.stopWorkflowRun(run.runId);
});

/** Polls until `read` gives a value. */
async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  let value: T | null = null;
  await waitUntil(async () => (value = await read()) !== null);
  return value!;
}

test('I15 a round that pauses for user input and resumes yields two active segments and one waiting segment', async () => {
  const run = await startRun(() => ({}));
  const taskId = await waitFor(() => run.roundTask('build', 1));
  await run.manager.handleTerminalHook(taskId, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Which database?' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await run.manager.handleTerminalHook(taskId, { hook_event_name: 'UserPromptSubmit' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await run.manager.completeStep(taskId, { summary: 'built' });
  await waitUntil(async () => (await run.manager.getTask(taskId)).status === 'done');
  await sessionEnded(taskId);
  await recorded();
  const activity = (await activityOf(taskId))!;
  assert.deepEqual(activity.segments.map((segment) => segment.state), ['active', 'waiting', 'active']);
  const [first, waiting, second] = activity.segments;
  assert.ok(waiting!.end! - waiting!.start >= 10, 'the wait has its real length');
  assert.equal(activity.activeMs, first!.end! - first!.start + second!.end! - second!.start);
  await run.manager.stopWorkflowRun(run.runId);
});

test('I16 stopping, failing and awaiting approval each end the active segment', async () => {
  const stopped = await startRun(() => ({}));
  const stoppedTask = await waitFor(() => stopped.roundTask('build', 1));
  await stopped.manager.stopWorkflowRun(stopped.runId);
  await stopped.waitForStatus('stopped');
  await sessionEnded(stoppedTask);

  const failed = await startRun(() => ({ build: (_id, exit) => exit() }));
  await failed.waitForStatus('needs-attention');
  const failedTask = (await failed.roundTask('build', 1))!;
  await sessionEnded(failedTask);

  const approval = await startRun((ref) => ({
    build: (id) => ref.current!.completeStep(id, { summary: 'built' }),
    review: (id) => ref.current!.completeStep(id, { summary: 'clean', verdict: 'pass' }),
    signoff: (id) => ref.current!.completeStep(id, { summary: 'brief' }),
  }));
  await approval.waitForStatus('awaiting-approval');
  const approvalTask = (await approval.roundTask('signoff', 1))!;
  // The step's session is closed just after it reports; the wait for approval starts there.
  await waitUntil(async () => (await approval.manager.getTask(approvalTask)).status !== 'developing');
  await sessionEnded(approvalTask);

  await recorded();
  for (const [name, taskId] of [['stopped', stoppedTask], ['ended without completing', failedTask], ['awaiting approval', approvalTask]] as const) {
    const activity = (await activityOf(taskId))!;
    assert.ok(activity.endedAt !== null, `${name}: the interval is closed`);
    assert.ok(activity.segments.every((segment) => segment.end !== null), `${name}: nothing is still painted as active`);
  }
  const rows = await steps();
  assert.deepEqual(
    [stoppedTask, failedTask, approvalTask].map((taskId) => rows.find((row) => row.id === taskId)!.status),
    ['stopped', 'failed', 'completed'],
  );
  await approval.manager.stopWorkflowRun(approval.runId);
});

test('I17 a looped step yields a separate interval and comparison row per round, and I25 skipped steps, Complete and planning are not rows', async () => {
  let reviews = 0;
  const run = await startRun((ref) => ({
    build: (id) => ref.current!.completeStep(id, { summary: 'built' }),
    review: (id) => ref.current!.completeStep(id, (reviews += 1) === 1 ? { summary: 'issues found', verdict: 'issues' } : { summary: 'clean', verdict: 'pass' }),
    signoff: (id) => ref.current!.skipStep(id, { reason: 'Nothing to sign off.' }),
  }));
  await run.waitForStatus('completed');
  const plan = await planningSession(run.manager, run.project.id);
  await recorded();

  const rows = (await steps()).filter((row) => row.target?.kind === 'run' && row.target.runId === run.runId);
  assert.deepEqual(rows.map((row) => `${row.stepName} ${row.round}`).sort(), ['Code Review 1', 'Code Review 2', 'Development 1', 'Development 2']);
  assert.equal(new Set(rows.map((row) => row.id)).size, 4);
  assert.ok(rows.every((row) => row.status === 'completed' && row.workflowName === 'Software Development'));

  const view = await day();
  const ofRun = view.activities.filter((activity) => activity.target?.kind === 'run' && activity.target.runId === run.runId);
  // The skipped sign-off and the Complete stage are on the timeline, but neither is a comparison row.
  assert.deepEqual(ofRun.map((activity) => activity.workflow!.stepName).sort(), ['Code Review', 'Code Review', 'Complete', 'Development', 'Development', 'Human Code Review']);
  const complete = ofRun.find((activity) => activity.workflow!.stepName === 'Complete')!;
  assert.deepEqual([complete.kind, complete.label], ['background', 'Completion summary']);
  assert.ok(view.activities.some((activity) => activity.id === plan.id && activity.kind === 'planning'));
  assert.ok(!(await steps()).some((row) => row.id === plan.id || row.stepName === 'Complete'));
  assert.ok(!rows.some((row) => row.stepName === 'Human Code Review'), 'the round the agent skipped is not comparable');
});

/** A planning session on the claude profile, left running until the test settles it. */
async function planningSession(manager: Manager, projectId: string): Promise<TaskRecord> {
  return manager.startTask({ projectId, description: `${SECRET_PROMPT} plan the quarter`, kind: 'plan', executorId: CLAUDE });
}

test('I19 a background naming session appears as app background work', async () => {
  const { createPlanItemTitler } = await import('../src/projects/planItemTitler.ts');
  const project = await newProject();
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Untitled', description: `${SECRET_PROMPT} name me` });
  const titler = createPlanItemTitler({
    trackTurn: analytics.recorder.trackBackground,
    listExecutors: onlyClaude,
    getExecutorLimits: async () => null,
    runClaudeTurn: async () => ({ sessionId: 's', status: 'done', message: 'ok', extra: { title: 'Named task' }, usage: { inputTokens: 5, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 }, raw: { type: 'result' } }),
  });
  assert.equal((await titler.titlePlanItem(item))?.title, 'Named task');
  const naming = (await day()).activities.filter((activity) => activity.kind === 'background' && activity.label === 'Task naming');
  assert.equal(naming.length, 1);
  assert.deepEqual([naming[0]!.projectName, naming[0]!.agentLabel, naming[0]!.workflow], [project.name, 'Test Claude CLI', null]);
  assert.deepEqual(naming[0]!.target, { kind: 'item', projectId: project.id, planItemId: item.id });
});

test('I21 renaming a Project or Task keeps historical rows consistent and resolvable, and I20 deleting them leaves the rows readable with a deleted label and no link', async () => {
  const run = await startRun((ref) => ({ build: (id) => ref.current!.completeStep(id, { summary: 'built' }) }));
  const taskId = await waitFor(() => run.roundTask('build', 1));
  await waitUntil(async () => (await run.manager.getTask(taskId)).status === 'done');
  await sessionEnded(taskId);
  await run.manager.stopWorkflowRun(run.runId);
  await run.waitForStatus('stopped');
  await recorded();

  await collections.projectsDb.update(run.project.id, { name: 'Renamed project' });
  await planItemService.updatePlanItem(run.item.id, { title: 'Renamed task' });
  const renamed = (await activityOf(taskId))!;
  assert.deepEqual([renamed.projectName, renamed.label, renamed.deleted], [run.project.name, 'Ship analytics', false]);
  assert.deepEqual(renamed.target, { kind: 'run', projectId: run.project.id, runId: run.runId, stepId: 'build', round: 1 });

  await run.manager.deletePlanItem(run.item.id);
  const deleted = (await activityOf(taskId))!;
  assert.deepEqual([deleted.label, deleted.deleted, deleted.target], ['Deleted task', true, null]);
  assert.deepEqual([deleted.projectName, deleted.workflow?.stepName, deleted.startedAt], [run.project.name, 'Development', renamed.startedAt]);
  const row = (await steps()).find((entry) => entry.id === taskId)!;
  assert.deepEqual([row.label, row.deleted, row.target, row.stepName], ['Deleted task', true, null, 'Development']);

  const other = await startRun(() => ({}));
  const otherTask = await waitFor(() => other.roundTask('build', 1));
  await other.manager.stopWorkflowRun(other.runId);
  await other.waitForStatus('stopped');
  await sessionEnded(otherTask);
  await collections.projectsDb.delete(other.project.id);
  const orphan = (await activityOf(otherTask))!;
  assert.deepEqual([orphan.projectName, orphan.label, orphan.target], [other.project.name, 'Ship analytics', null]);
});

// ---- Tokens ----

function cliHook(taskId: string, event: Record<string, unknown>, cliKind = 'claude-cli') {
  return api('/api/cli-hooks', { method: 'POST', headers: { authorization: `Bearer ${hookToken}` }, body: JSON.stringify({ taskId, cliKind, event }) });
}

test('I22 a round whose CLI reported usage shows category counts and total; a round with none shows unavailable', async () => {
  const run = await startRun(() => ({}));
  const taskId = await waitFor(() => run.roundTask('build', 1));
  await recorded();
  const file = '/sessions/i22.jsonl';
  cliUsage.set(file, tokens(120, 30, 400, 9000));
  assert.equal((await cliHook(taskId, { hook_event_name: 'PostToolUse', session_id: 'i22', transcript_path: file })).status, 204);
  await recorded();
  assert.equal((await steps()).find((row) => row.id === taskId)!.tokens, null, 'a tool hook is not a usage report');
  assert.equal((await cliHook(taskId, { hook_event_name: 'Stop', session_id: 'i22', transcript_path: file })).status, 204);
  await recorded();
  const row = (await steps()).find((entry) => entry.id === taskId)!;
  assert.deepEqual(row.tokens, { counts: tokens(120, 30, 400, 9000), total: 9550, partial: false });
  assert.equal(row.comparison.tokens.value, 9550);
  await run.manager.stopWorkflowRun(run.runId);

  const silent = await startRun(() => ({}));
  const silentTask = await waitFor(() => silent.roundTask('build', 1));
  await cliHook(silentTask, { hook_event_name: 'Stop', session_id: 'i22-silent', transcript_path: '/sessions/none.jsonl' });
  await cliHook(silentTask, { hook_event_name: 'Stop' });
  await cliHook(silentTask, { hook_event_name: 'Stop', transcript_path: file }, 'unknown-cli');
  await recorded();
  assert.equal((await steps()).find((entry) => entry.id === silentTask)!.tokens, null);
  await silent.manager.stopWorkflowRun(silent.runId);
  assert.equal((await api('/api/cli-hooks', { method: 'POST', body: JSON.stringify({ taskId, cliKind: 'claude-cli', event: {} }) })).status, 401);
});

test('I23 a resumed session across two rounds assigns tokens to each round once; the rounds sum to the final cumulative report', async () => {
  let reviews = 0;
  const file = '/sessions/i23.jsonl';
  const run = await startRun((ref) => ({
    build: async (id) => {
      // The build step's CLI conversation is one session across both rounds.
      const round = (await ref.current!.getWorkflowRunDetail((await ref.current!.getTask(id)).workflowRunId!)).steps.find((entry) => entry.step.id === 'build')!.rounds.length;
      // A tool hook tells the daemon where the session file is. The step then reports complete inside
      // its turn, so its session is closed before any Stop hook: usage is read as the session ends.
      await cliHook(id, { hook_event_name: 'PostToolUse', session_id: 'i23', transcript_path: file });
      cliUsage.set(file, round === 1 ? tokens(100, 40, 10, 1000) : tokens(180, 90, 10, 2600));
      await ref.current!.completeStep(id, { summary: 'built' });
      // The Stop hook of the closed session arrives late and reports the same totals again.
      await cliHook(id, { hook_event_name: 'Stop', session_id: 'i23', transcript_path: file });
    },
    review: (id) => ref.current!.completeStep(id, (reviews += 1) === 1 ? { summary: 'issues', verdict: 'issues' } : { summary: 'clean', verdict: 'pass' }),
  }));
  // The sign-off step has no scripted action, so the run rests there with both build rounds settled.
  await waitUntil(async () => (await run.manager.getWorkflowRunDetail(run.runId)).run.currentStepId === 'signoff');
  await recorded();
  const builds = (await steps()).filter((row) => row.target?.kind === 'run' && row.target.runId === run.runId && row.stepName === 'Development').sort((a, b) => a.round! - b.round!);
  assert.deepEqual(builds.map((row) => row.tokens?.counts), [tokens(100, 40, 10, 1000), tokens(80, 50, 0, 1600)]);
  assert.equal(builds[0]!.tokens!.total + builds[1]!.tokens!.total, 180 + 90 + 10 + 2600);
  await run.manager.stopWorkflowRun(run.runId);
});

// ---- Step comparison ----

test('I24 the step comparison returns value, median and sample count per metric, and marks a round against a cohort of five', async () => {
  const file = '/sessions/i24.jsonl';
  const taskIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const run = await startRun((ref) => ({
      build: async (id) => {
        cliUsage.set(file, index === 5 ? tokens(2000, 500) : tokens(900, 100));
        await cliHook(id, { hook_event_name: 'Stop', session_id: `i24-${index}`, transcript_path: file });
        await ref.current!.completeStep(id, { summary: 'built' });
      },
    }));
    const taskId = await waitFor(() => run.roundTask('build', 1));
    await waitUntil(async () => (await run.manager.getTask(taskId)).status === 'done');
  await sessionEnded(taskId);
    await run.manager.stopWorkflowRun(run.runId);
    await run.waitForStatus('stopped');
    taskIds.push(taskId);
  }
  await recorded();
  // Judge the cohort on its own: rounds recorded by earlier tests are set aside for this check.
  const cohort = new Set(taskIds);
  const all = await analytics.history.activities();
  await analytics.history.putActivities(all.filter((record) => !cohort.has(record.id) && record.workflow).map((record) => ({ ...record, workflow: { ...record.workflow!, stepName: `${record.workflow!.stepName} (earlier test)` } })));

  const rows = (await steps()).filter((row) => cohort.has(row.id)).sort((a, b) => taskIds.indexOf(a.id) - taskIds.indexOf(b.id));
  assert.deepEqual(rows.map((row) => row.comparison.tokens.samples), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(rows.slice(0, 5).map((row) => row.highUsage), [[], [], [], [], []]);
  const judged = rows[5]!;
  assert.deepEqual(judged.comparison.tokens, { value: 2500, median: 1000, samples: 5, enoughHistory: true, highUsage: true });
  assert.ok(judged.highUsage.includes('tokens'));
  assert.equal(judged.comparison.activeDuration.samples, 5);
  assert.equal(typeof judged.comparison.activeDuration.median, 'number');
  assert.deepEqual([judged.comparison.fiveHourDecrease.samples, judged.comparison.fiveHourDecrease.median], [0, null], 'no readings bracket these rounds, so no quota baseline');
  assert.equal(rows[4]!.comparison.tokens.enoughHistory, false);
});

// ---- Profiles and privacy ----

test('I13 after deleting a profile, its history is listed as a retired agent', async () => {
  const before = await day(TWIN);
  assert.equal((await api(`/api/executors/${TWIN}`, { method: 'DELETE' })).status, 204);
  clock.advance(MINUTE);
  const agents = (await api('/api/analytics/agents')).body.agents as { id: string; label: string; retired: boolean; retiredAt: number | null; sharedWith: string[] }[];
  const retired = agents.find((agent) => agent.retired)!;
  assert.deepEqual([retired.label, retired.retiredAt, retired.id.startsWith('retired-'), retired.sharedWith], ['Test Claude CLI (twin profile)', clock.now(), true, []]);
  assert.deepEqual(agents.at(-1), retired, 'retired agents come after configured ones');
  assert.deepEqual(agents.find((agent) => agent.id === CLAUDE)!.sharedWith, [], 'no profile shares the account any more');
  const view = (await api(`/api/analytics/agents/${retired.id}?from=${before.range.from}&to=${before.range.to}`)).body as AgentDayView;
  assert.deepEqual(view.series.fiveHour.points, before.series.fiveHour.points);
  assert.equal((await api(`/api/analytics/agents/${TWIN}/steps`)).status, 404, 'the removed id no longer names a configured agent');
  assert.equal((await refresh(retired.id)).status, 404, 'a retired agent has nothing to refresh');
});

test('I26 the saved history and every analytics response hold no prompt text, transcript text, token strings or credential values', async () => {
  const directory = path.join(tempRoot, 'data', 'analytics');
  const files = await readdir(directory);
  assert.deepEqual(files.filter((name) => name.endsWith('.json')).sort(), ['activity-history.json', 'quota-history.json']);
  const saved = (await Promise.all(files.map((name) => readFile(path.join(directory, name), 'utf8')))).join('\n');
  const agents = (await api('/api/analytics/agents')).body.agents as { id: string }[];
  const responses = [(await api('/api/analytics/agents')).text];
  for (const agent of agents) {
    responses.push((await api(`/api/analytics/agents/${agent.id}?from=${clock.now() - 12 * HOUR}&to=${clock.now() + 12 * HOUR}`)).text, (await api(`/api/analytics/agents/${agent.id}/steps`)).text);
  }
  for (const text of [saved, ...responses]) {
    for (const secret of [SECRET_PROMPT, 'sk-SECRET-CREDENTIAL', 'ANTHROPIC_API_KEY', 'does-not-matter', hookToken, '/sessions/']) assert.ok(!text.includes(secret), `"${secret}" must not appear`);
  }
  assert.ok(saved.includes('Ship analytics'), 'a task title is metadata and is kept');
});
