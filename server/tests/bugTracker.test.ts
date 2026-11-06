import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import type { PlanItemRecord, TaskRecord, WorkflowRunRecord } from '../src/domain/types.ts';
import { ZERO_TOKEN_USAGE } from '../src/domain/types.ts';
import type { WorkerEvent } from '../src/worker/workerManager.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';
import { settledExecute } from './helpers/startRun.ts';

/**
 * The bug tracker against a real WorkerManager with a fake terminal host: report sessions, the
 * tools they and coding sessions get, filing, grouping order and what a restart keeps. Route
 * statuses and `{ error }` bodies are in bugApi.test.ts.
 */

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let collections: typeof import('../src/db/collections.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let planModule: typeof import('../src/projects/plan.ts');
let bugs: typeof import('../src/projects/bugs.ts');
let bugTrackerModule: typeof import('../src/worker/bugTracker.ts');
let bugReportTool: typeof import('../src/terminal/bugReportTool.ts');
let testTaskTool: typeof import('../src/terminal/testTaskTool.ts');
let terminalSessionManager: typeof import('../src/terminal/terminalSessionManager.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');
let executorService: typeof import('../src/executors/executorService.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'bug-tracker-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  projectService = await import('../src/projects/projectService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  collections = await import('../src/db/collections.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  planModule = await import('../src/projects/plan.ts');
  bugs = await import('../src/projects/bugs.ts');
  bugTrackerModule = await import('../src/worker/bugTracker.ts');
  bugReportTool = await import('../src/terminal/bugReportTool.ts');
  testTaskTool = await import('../src/terminal/testTaskTool.ts');
  terminalSessionManager = await import('../src/terminal/terminalSessionManager.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
  workflowService = await import('../src/catalog/workflowService.ts');
  executorService = await import('../src/executors/executorService.ts');

  // The fixture Catalog has only Software Development; the "Fix a bug" slot defaults to `bug-fix`.
  const base = (await workflowService.getDefaultWorkflow())!;
  await workflowService.createWorkflow({ id: 'bug-fix', name: 'Bug Fix', description: 'Fix a reported bug.', branchType: 'bugfix', steps: base.steps });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}


/** The old bug report session can no longer be created through the app; its tests start one the way an existing session was created. */
function withLegacyBugReportStarter<M extends { startTask: (input: any) => Promise<any> }>(manager: M) {
  return Object.assign(manager, {
    startBugReportSession: (input: { projectId: string; description: string; executorId?: string }) =>
      manager.startTask({ ...input, kind: 'plan', planningPurpose: 'bug-report', deferCli: !input.executorId }),
  });
}

let projectCount = 0;

/** A Project, a manager on a fake terminal, and the events it emits. */
async function world(name = `Bug Project ${++projectCount}`) {
  const project = await projectService.createProject({ name, position: null });
  const terminal = fakeTerminalHost();
  const manager = withLegacyBugReportStarter(workerManagerModule.createWorkerManager({ terminalSessions: terminal.host }));
  const events: WorkerEvent[] = [];
  manager.onWorkerEvent((event) => events.push(event));
  const exitAll = async () => {
    for (const start of terminal.starts) start.onExit(0);
    await waitUntil(async () => (await projectService.getProject(project.id)).status === 'idle');
  };
  return { project, terminal, manager, events, exitAll };
}

type World = Awaited<ReturnType<typeof world>>;

const reportSession = (w: World, description = 'Saving a note loses it') =>
  w.manager.startBugReportSession({ projectId: w.project.id, description, executorId: 'test-claude-cli' });

/** A task as it is once it has run: any status but a never-started pending. */
async function startedTask(projectId: string, title: string, patch: Partial<PlanItemRecord> = {}): Promise<PlanItemRecord> {
  const item = await planItemService.createPlanItem({ projectId, title, description: '' });
  return (await collections.planItemsDb.update(item.id, { status: 'done', ...patch }))!;
}

const report = (fields: Record<string, unknown> = {}) => bugs.parseBugReport({ title: 'Crash on save', infoStatus: 'needs-more-info', ...fields });
const agentBug = (fields: Record<string, unknown> = {}) => bugs.parseAgentBug({
  title: 'Flaky date test', suiteId: 'server', actionId: 'tests', caseId: 'formats dates', description: 'AssertionError: expected 1 got 2', ...fields,
});
const REPORT_TOOLS = ['list_tasks', 'create_bug', 'update_bug', 'delete_bug', 'create_task', 'update_task', 'delete_task', 'reopen_bug'];
const planItems = (projectId: string) => planItemService.listPlanItems(projectId);
const bugEvents = (events: WorkerEvent[], id: string) => events.filter((event) => event.type === 'planItem' && event.planItem.id === id);

// ---- Tool availability and instructions (U31–U39) ----

test('I5 U35 U36 a report session is a numbered, read-only CLI session with the bug and task tools', async () => {
  const w = await world();
  const session = await reportSession(w);
  assert.equal(session.kind, 'plan');
  assert.equal(session.planningPurpose, 'bug-report');
  assert.equal(session.planningSessionNumber, 1);
  assert.equal(session.branch, undefined, 'no branch');
  assert.equal(session.worktreePath, undefined, 'no worktree');
  const start = w.terminal.starts[0]!;
  assert.deepEqual(start.disallowedTools, planModule.PLAN_DISALLOWED_TOOLS, 'Claude denies shell and file-editing tools, as for planning');
  assert.equal(start.readOnly, true);
  assert.deepEqual(start.mcpServers?.map((server) => server.name), [bugReportTool.BUG_REPORT_MCP_SERVER_NAME]);
  assert.deepEqual(start.mcpServers?.[0]?.tools, REPORT_TOOLS);
  assert.equal(start.mcpServers?.[0]?.env.AGENT_VISUAL_OS_TASK_ID, session.id);
  assert.equal(start.prompt, `Saving a note loses it\n\n${bugReportTool.BUG_REPORT_INSTRUCTIONS}`);
  assert.doesNotMatch(start.systemPrompt, /list_test_actions/, 'no testing tools');

  // The planning session beside it shares the number counter and gets none of the bug tools.
  const planning = await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-codex-cli', kind: 'plan' });
  assert.equal(planning.planningSessionNumber, 2);
  const planningStart = w.terminal.starts[1]!;
  assert.deepEqual(planningStart.mcpServers?.map((server) => server.name), ['agent_visual_os']);
  assert.doesNotMatch(planningStart.prompt, /create_bug/);
  assert.doesNotMatch(planningStart.prompt, /reopen_bug/, 'only a report session may reopen a bug');

  // Codex: the same read-only sandbox arguments a planning session gets.
  const codexSession = await w.manager.startBugReportSession({ projectId: w.project.id, description: 'Another', executorId: 'test-codex-cli' });
  const codexStart = w.terminal.starts[2]!;
  const sandbox = (input: typeof codexStart) => terminalSessionManager.interactiveCliArgs(input).filter((arg, index, args) => arg === '--sandbox' || args[index - 1] === '--sandbox' || arg === '--ask-for-approval' || args[index - 1] === '--ask-for-approval');
  assert.deepEqual(sandbox(codexStart), ['--sandbox', 'read-only', '--ask-for-approval', 'never']);
  assert.deepEqual(sandbox(codexStart), sandbox(planningStart));
  assert.equal(codexSession.planningSessionNumber, 3);
  await w.exitAll();
});

test('U31 U33 a freeform execute Task gets the bug-filing tool; a planning session and a report session do not', async () => {
  const w = await world();
  await w.manager.startTask({ projectId: w.project.id, description: 'Build it', executorId: 'test-claude-cli' });
  const coding = w.terminal.starts[0]!;
  const testServer = coding.mcpServers?.find((server) => server.name === testTaskTool.TEST_TASK_MCP_SERVER_NAME);
  assert.ok(testServer?.tools.includes('report_unrelated_test_failure'));
  assert.match(coding.systemPrompt, /report_unrelated_test_failure/);
  await w.exitAll();

  await reportSession(w);
  await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  for (const start of w.terminal.starts.slice(1)) {
    assert.equal(start.mcpServers?.some((server) => server.tools.includes('report_unrelated_test_failure')), false);
    assert.doesNotMatch(start.systemPrompt, /report_unrelated_test_failure/);
  }
  await w.exitAll();
});

test('U37 the agent tool instructions say: only unrelated failing tests; failures from your own changes are yours to fix', () => {
  assert.match(testTaskTool.TESTING_TOOL_INSTRUCTIONS, /only for one that is unrelated to your current task/);
  assert.match(testTaskTool.TESTING_TOOL_INSTRUCTIONS, /A failure caused by your own changes is yours to fix/);
});

test('U38 the report session instructions say: never refuse to file, an honest Info status, self-contained bugs, find the introducing task', () => {
  const text = bugReportTool.BUG_REPORT_INSTRUCTIONS;
  assert.match(text, /never refuse to file for lack of it/);
  assert.match(text, /Set the info status honestly/);
  assert.match(text, /sees only its title and description, never this conversation/);
  assert.match(text, /Identify which task introduced it/);
  assert.match(text, /read-only: it cannot write or change any project file/);
});

/** Launches a bundled MCP script and reads its tool list. */
async function listMcpTools(launch: { command: string; args: string[]; env: Record<string, string> }) {
  const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    const reply = JSON.parse((await lines.next()).value as string);
    return reply.result.tools as { name: string; inputSchema: { required?: string[] } }[];
  } finally {
    child.stdin.end();
    child.kill();
  }
}

test('U39 the relay scripts expose exactly the named tools, with title marked required', async () => {
  const reportTools = await listMcpTools(bugReportTool.bugReportMcpServer('task-1'));
  assert.deepEqual(reportTools.map((tool) => tool.name), REPORT_TOOLS);
  assert.deepEqual(reportTools.find((tool) => tool.name === 'create_bug')!.inputSchema.required, ['title', 'infoStatus']);
  assert.deepEqual(reportTools.find((tool) => tool.name === 'update_bug')!.inputSchema.required, ['id']);
  assert.deepEqual(reportTools.find((tool) => tool.name === 'reopen_bug')!.inputSchema.required, ['bugId', 'reason']);

  const testTools = await listMcpTools(testTaskTool.testTaskMcpServer('task-1'));
  assert.deepEqual(testTools.map((tool) => tool.name), Object.values(testTaskTool.TEST_TASK_TOOLS));
  assert.deepEqual(testTools.find((tool) => tool.name === 'report_unrelated_test_failure')!.inputSchema.required, ['title', 'suiteId', 'actionId', 'caseId', 'description']);
});

// ---- Report session lifecycle (I5–I14) ----

test('I6 a report session starts beside a coding Task holding the Project\'s only slot', async () => {
  const w = await world();
  await w.manager.startTask({ projectId: w.project.id, description: 'Hold the slot', executorId: 'test-claude-cli' });
  const session = await reportSession(w);
  assert.equal(session.status, 'developing');
  await assert.rejects(w.manager.startTask({ projectId: w.project.id, description: 'Second coder', executorId: 'test-claude-cli' }), workerManagerModule.TaskConflictError);
  await w.exitAll();
});

test('I7 a structured executor is refused exactly as Plan refuses it, and nothing is created', async () => {
  const w = await world();
  await assert.rejects(w.manager.startBugReportSession({ projectId: w.project.id, description: 'x', executorId: 'test-unsupported' }), workerManagerModule.PlanningRequiresCliError);
  await assert.rejects(w.manager.startBugReportSession({ projectId: w.project.id, description: 'x', executorId: 'no-such-agent' }), executorService.ExecutorNotFoundError);
  assert.deepEqual(await w.manager.listTasksForProject(w.project.id), []);
});

test('I8 I9 I10 I11 with no agent the session is created without a CLI, stays editable, and starts later with its stored description', async () => {
  const w = await world();
  const pending = await w.manager.startBugReportSession({ projectId: w.project.id, description: 'First words' });
  assert.equal(pending.cliNotStarted, true);
  assert.equal(pending.status, 'stopped');
  assert.equal(pending.planningSessionNumber, 1, 'the number is taken at creation');
  assert.equal(pending.description, 'First words');
  assert.equal(w.terminal.starts.length, 0, 'no terminal starts');
  assert.deepEqual((await projectService.getProject(w.project.id)).activeTaskIds, [], 'it holds no slot');

  const edited = await w.manager.updateDeferredSessionDescription(pending.id, 'Better words');
  assert.equal(edited.description, 'Better words');
  assert.equal((await w.manager.getTask(pending.id)).description, 'Better words');

  // A refused agent leaves the session not started.
  await assert.rejects(w.manager.launchDeferredSession(pending.id, { executorId: 'no-such-agent' }), executorService.ExecutorNotFoundError);
  await assert.rejects(w.manager.launchDeferredSession(pending.id, { executorId: 'test-unsupported' }), workerManagerModule.PlanningRequiresCliError);
  assert.equal((await w.manager.getTask(pending.id)).cliNotStarted, true);
  assert.equal(w.terminal.starts.length, 0);

  const started = await w.manager.launchDeferredSession(pending.id, { executorId: 'test-claude-cli' });
  assert.equal(started.id, pending.id);
  assert.equal(started.status, 'developing');
  assert.equal(started.cliNotStarted, false);
  assert.equal(started.executorId, 'test-claude-cli');
  assert.equal(started.planningSessionNumber, 1);
  assert.equal(w.terminal.starts.length, 1);
  assert.equal(w.terminal.starts[0]!.prompt, `Better words\n\n${bugReportTool.BUG_REPORT_INSTRUCTIONS}`);
  assert.deepEqual(w.terminal.starts[0]!.mcpServers?.map((server) => server.name), [bugReportTool.BUG_REPORT_MCP_SERVER_NAME]);

  await assert.rejects(w.manager.launchDeferredSession(pending.id, { executorId: 'test-claude-cli' }), workerManagerModule.SessionAlreadyStartedError, 'a second start');
  await assert.rejects(w.manager.updateDeferredSessionDescription(pending.id, 'Too late'), workerManagerModule.SessionAlreadyStartedError);
  assert.equal(w.terminal.starts.length, 1);
  await w.exitAll();
});

test('I12 I13 a not-started session survives a restart, is never auto-completed, refuses its tools, and can be archived or deleted', async () => {
  const w = await world();
  const pending = await w.manager.startBugReportSession({ projectId: w.project.id, description: 'Waiting for an agent' });

  // A daemon restart: a fresh manager recovering interrupted work.
  const restarted = workerManagerModule.createWorkerManager({ terminalSessions: fakeTerminalHost().host });
  await restarted.resumeInterruptedTasks();
  const after = await restarted.getTask(pending.id);
  assert.equal(after.status, 'stopped');
  assert.equal(after.cliNotStarted, true);
  assert.equal(after.failureReason, null, 'not marked failed');
  assert.equal(after.archived, undefined);

  await assert.rejects(w.manager.createReportedBug(pending.id, report()), bugTrackerModule.TaskNotBugReportSessionError);
  await assert.rejects(w.manager.listBugReportTasks(pending.id), bugTrackerModule.TaskNotBugReportSessionError);
  await assert.rejects(w.manager.resumeTerminalTask(pending.id), workerManagerModule.TerminalSessionNotResumableError);

  await w.manager.archiveSession(pending.id, true);
  assert.equal((await w.manager.getTask(pending.id)).archived, true);
  await w.manager.archiveSession(pending.id, false);
  await w.manager.deleteSession(pending.id);
  await assert.rejects(w.manager.getTask(pending.id), workerManagerModule.TaskNotFoundError);
});

test('a resumed or followed-up report session is still a report session: same tools, same instructions, and it can file and change its bugs', async () => {
  const w = await world();
  const first = await reportSession(w);
  const earlier = await w.manager.createReportedBug(first.id, report({ title: 'Filed before the resume' }));
  const settle = async (task: TaskRecord, startIndex: number) => {
    w.terminal.starts[startIndex]!.onExit(0);
    await waitUntil(async () => (await w.manager.getTask(task.id)).status === 'stopped');
    await waitUntil(async () => (await projectService.getProject(w.project.id)).status === 'idle');
  };
  await settle(first, 0);

  const continued: [string, () => Promise<TaskRecord>][] = [
    ['resume', () => w.manager.resumeTerminalTask(first.id)],
    ['follow-up', async () => w.manager.followUpTask((await w.manager.listTasksForProject(w.project.id)).at(-1)!.id, 'One more bug: the list flickers')],
  ];
  for (const [index, [how, start]] of continued.entries()) {
    const next = await start();
    assert.notEqual(next.id, first.id, how);
    assert.equal(next.kind, 'plan', how);
    assert.equal(next.planningPurpose, 'bug-report', how);
    assert.equal(next.planningSessionNumber, first.planningSessionNumber, how);
    const launch = w.terminal.starts[index + 1]!;
    assert.deepEqual(launch.mcpServers?.map((server) => server.name), [bugReportTool.BUG_REPORT_MCP_SERVER_NAME], `${how}: the bug tools, not the planning tools`);
    assert.deepEqual(launch.mcpServers?.[0]?.tools, REPORT_TOOLS);
    assert.equal(launch.mcpServers?.[0]?.env.AGENT_VISUAL_OS_TASK_ID, next.id);
    assert.equal(launch.readOnly, true);
    assert.deepEqual(launch.disallowedTools, planModule.PLAN_DISALLOWED_TOOLS);
    assert.doesNotMatch(launch.prompt, /PLANNING session/, how);
    if (how === 'follow-up') assert.equal(launch.prompt, `One more bug: the list flickers\n\n${bugReportTool.BUG_REPORT_INSTRUCTIONS}`);

    const filed = await w.manager.createReportedBug(next.id, report({ title: `Filed after the ${how}` }));
    assert.equal(filed.bug!.reportSessionNumber, first.planningSessionNumber);
    const updated = await w.manager.updateReportedBug(next.id, earlier.id, { severity: index === 0 ? 'low' : 'high' });
    assert.equal(updated.bug!.severity, index === 0 ? 'low' : 'high', `${how}: a bug filed before it is still its own`);
    await assert.rejects(w.manager.createPlanningTask(next.id, { title: 'T', description: '' }), workerManagerModule.TaskNotPlanningSessionError);
    await assert.rejects(w.manager.createReportedBug(first.id, report()), bugTrackerModule.TaskNotBugReportSessionError, 'the settled earlier turn cannot file');
    await settle(next, index + 1);
  }
  const members = await w.manager.listTasksForProject(w.project.id);
  assert.equal(members.length, 3);
  assert.ok(members.every((member) => member.planningPurpose === 'bug-report' && member.planningCreatedTaskCount === 3), 'every turn of the conversation carries the purpose and the count');

  // After a daemon restart the settled session is untouched and resumes as a report session.
  const terminal = fakeTerminalHost();
  const restarted = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  await restarted.resumeInterruptedTasks();
  const resumed = await restarted.resumeTerminalTask(members.at(-1)!.id);
  assert.equal(resumed.planningPurpose, 'bug-report');
  assert.deepEqual(terminal.starts[0]!.mcpServers?.map((server) => server.name), [bugReportTool.BUG_REPORT_MCP_SERVER_NAME]);
  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await projectService.getProject(w.project.id)).status === 'idle');
});

test('a finished report session is announced as a bug report session, not a planning session', async () => {
  const w = await world();
  const session = await reportSession(w);
  w.terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await w.manager.getTask(session.id)).status === 'stopped');
  await w.manager.completeTerminalTask(session.id);
  const titles = (await notificationService.listNotifications()).filter((notification) => notification.subject.type === 'task' && notification.subject.taskId === session.id).map((notification) => notification.title);
  assert.deepEqual(titles, ['Bug report session #1 finished']);
});

// ---- Report session tools (I15–I34) ----

test('I15 the session lists its own Project\'s tasks with type and status, and nothing of another Project', async () => {
  const w = await world();
  const other = await world();
  const foreign = await startedTask(other.project.id, '9.001: Foreign secret task');
  const mine = await startedTask(w.project.id, '4.002: Add login');
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: mine.id }));

  const listed = await w.manager.listBugReportTasks(session.id);
  assert.deepEqual(listed.map(({ id, type, status }) => ({ id, type, status })), [
    { id: mine.id, type: 'task', status: 'done' },
    { id: bug.id, type: 'bug', status: 'pending' },
  ]);
  const body = JSON.stringify(listed);
  assert.equal(body.includes(foreign.id), false);
  assert.equal(body.includes('Foreign secret task'), false);
  assert.equal(body.includes(other.project.id), false);
  await w.exitAll();
});

test('I16 U21 U22 a full report files a numbered bug under its introducing task, with the structured description and an event', async () => {
  const w = await world();
  const introducer = await startedTask(w.project.id, '4.002: Add login');
  const otherIntroducer = await startedTask(w.project.id, '4.003: Add logout');
  const session = await reportSession(w);

  const bug = await w.manager.createReportedBug(session.id, report({
    title: 'Login button does nothing', severity: 'high', infoStatus: 'enough', suspectedLocation: 'web/login',
    introducedByTaskId: introducer.id, commit: 'abc1234', summary: 'Clicking Login is ignored', expectedVsActual: 'Logs in; nothing happens', stepsToReproduce: 'Open the app, click Login',
  }));

  assert.equal(bug.type, 'bug');
  assert.equal(bug.title, '4.002.001: Login button does nothing');
  assert.equal(bug.status, 'pending');
  assert.equal(bug.planningRef, undefined, 'a bug is not a planning task');
  assert.deepEqual(bug.bug, {
    severity: 'high', infoStatus: 'enough', suspectedLocation: 'web/login',
    introducedBy: { planItemId: introducer.id, number: '4.002', title: 'Add login', commit: 'abc1234' },
    foundWhileWorkingOn: null, reportSessionNumber: 1, testRef: null, groupOrder: null,
    summary: 'Clicking Login is ignored', expectedVsActual: 'Logs in; nothing happens', stepsToReproduce: 'Open the app, click Login',
    regressions: [],
  });
  assert.equal(bug.description, [
    '## Summary\n\nClicking Login is ignored',
    '## Expected vs actual\n\nLogs in; nothing happens',
    '## Steps to reproduce\n\nOpen the app, click Login',
    '## Suspected location\n\nweb/login',
    '## Introduced by\n\n4.002: Add login (commit abc1234)',
  ].join('\n\n'));
  assert.equal(bugEvents(w.events, bug.id).length, 1);
  assert.equal((bugEvents(w.events, bug.id)[0] as { planItem: PlanItemRecord }).planItem.type, 'bug');

  assert.equal((await w.manager.createReportedBug(session.id, report({ introducedByTaskId: introducer.id }))).title, '4.002.002: Crash on save');
  assert.equal((await w.manager.createReportedBug(session.id, report({ introducedByTaskId: otherIntroducer.id }))).title, '4.003.001: Crash on save', 'the counter is per introducing task');
  assert.equal((await w.manager.getTask(session.id)).planningCreatedTaskCount, 3);
  await w.exitAll();
});

test('I17 I32 U24 U25 a thin report still files, as B.NNN, and no description mentions the session', async () => {
  const w = await world();
  const handAdded = await startedTask(w.project.id, 'Typed by hand');
  const session = await reportSession(w, 'SECRET-CONVERSATION-MARKER the note vanished');

  const thin = await w.manager.createReportedBug(session.id, report({ title: 'Note vanishes' }));
  assert.equal(thin.title, 'B.001: Note vanishes');
  assert.equal(thin.description.match(/^Unknown$/gm)?.length, 5);
  assert.equal(thin.bug!.infoStatus, 'needs-more-info');
  assert.equal(thin.bug!.introducedBy, null);

  const second = await w.manager.createReportedBug(session.id, report({ title: 'Another' }));
  assert.equal(second.title, 'B.002: Another');
  const underHandAdded = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: handAdded.id }));
  assert.equal(underHandAdded.title, 'B.003: Crash on save', 'an introducing task with no number gives B.NNN');
  assert.deepEqual(underHandAdded.bug!.introducedBy, { planItemId: handAdded.id, number: null, title: 'Typed by hand', commit: null });

  for (const item of await planItems(w.project.id)) {
    assert.doesNotMatch(item.description, /SECRET-CONVERSATION-MARKER|session/i);
  }
  await w.exitAll();
});

test('U23 U26 U28 a number is never reused, a bug can introduce a bug, and regrouping keeps the number', async () => {
  const w = await world();
  const introducer = await startedTask(w.project.id, '4.002: Add login');
  const elsewhere = await startedTask(w.project.id, '6.001: Add search');
  const session = await reportSession(w);

  const first = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: introducer.id }));
  await w.manager.deleteReportedBug(session.id, first.id);
  const next = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: introducer.id }));
  assert.equal(next.title, '4.002.002: Crash on save', '4.002.001 is not handed out again');

  const standalone = await w.manager.createReportedBug(session.id, report());
  await w.manager.deleteReportedBug(session.id, standalone.id);
  assert.equal((await w.manager.createReportedBug(session.id, report())).title, 'B.002: Crash on save');

  // A bug that has started can itself be named as the introducing task.
  await collections.planItemsDb.update(next.id, { status: 'done' });
  const child = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: next.id }));
  assert.equal(child.title, '4.002.002.001: Crash on save');

  const moved = await w.manager.updateReportedBug(session.id, child.id, { introducedByTaskId: elsewhere.id });
  assert.equal(moved.title, '4.002.002.001: Crash on save', 'changing the introducing task does not renumber');
  assert.equal(moved.bug!.introducedBy!.number, '6.001');
  await w.exitAll();
});

test('I21 I22 the introducing task must be this Project\'s and must have started; every started state is accepted', async () => {
  const w = await world();
  const other = await world();
  const foreign = await startedTask(other.project.id, '9.001: Foreign');
  const neverStarted = await planItemService.createPlanItem({ projectId: w.project.id, title: '4.009: Not started', description: '' });
  const session = await reportSession(w);

  await assert.rejects(w.manager.createReportedBug(session.id, report({ introducedByTaskId: 'no-such-task' })), planItemService.PlanItemNotFoundError);
  await assert.rejects(w.manager.createReportedBug(session.id, report({ introducedByTaskId: foreign.id })), planItemService.PlanItemNotFoundError);
  await assert.rejects(
    w.manager.createReportedBug(session.id, report({ introducedByTaskId: neverStarted.id })),
    (error) => error instanceof bugs.BugIntroducerNotStartedError && /has not started yet/.test((error as Error).message),
  );
  const readyBug = await w.manager.createReportedBug(session.id, report());
  await assert.rejects(w.manager.createReportedBug(session.id, report({ introducedByTaskId: readyBug.id })), bugs.BugIntroducerNotStartedError, 'a never-started bug');
  assert.equal((await planItems(w.project.id)).filter((item) => item.type === 'bug').length, 1, 'nothing was created by the refused calls');

  const states: Partial<PlanItemRecord>[] = [{ status: 'done' }, { status: 'developing' }, { status: 'blocked' }, { status: 'stopped' }, { status: 'failed' }, { status: 'done', archived: true }];
  for (const [index, patch] of states.entries()) {
    const introducer = await startedTask(w.project.id, `5.00${index + 1}: State ${index}`, patch);
    const bug = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: introducer.id }));
    assert.equal(bug.title, `5.00${index + 1}.001: Crash on save`);
  }
  await w.exitAll();
});

test('I24 I25 I28 only a running report session may use the tools, and only on bugs it filed', async () => {
  const w = await world();
  const session = await reportSession(w);
  const otherSession = await reportSession(w, 'A second report');
  const planning = await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  const coding = await w.manager.startTask({ projectId: w.project.id, description: 'Code', executorId: 'test-claude-cli' });
  const ordinary = await planItemService.createPlanItem({ projectId: w.project.id, title: 'Ordinary task', description: '' });
  const mine = await w.manager.createReportedBug(session.id, report());
  const theirs = await w.manager.createReportedBug(otherSession.id, report());
  const agentFound = (await w.manager.fileAgentBug(coding.id, agentBug())).bug;

  for (const caller of [planning.id, coding.id]) {
    await assert.rejects(w.manager.createReportedBug(caller, report()), bugTrackerModule.TaskNotBugReportSessionError);
    await assert.rejects(w.manager.listBugReportTasks(caller), bugTrackerModule.TaskNotBugReportSessionError);
    await assert.rejects(w.manager.updateReportedBug(caller, mine.id, { severity: 'low' }), bugTrackerModule.TaskNotBugReportSessionError);
    await assert.rejects(w.manager.deleteReportedBug(caller, mine.id), bugTrackerModule.TaskNotBugReportSessionError);
  }
  await assert.rejects(w.manager.createReportedBug('no-such-task', report()), workerManagerModule.TaskNotFoundError);
  // A report session may not use a planning session's task tools either.
  await assert.rejects(w.manager.createPlanningTask(session.id, { title: 'T', description: '' }), workerManagerModule.TaskNotPlanningSessionError);

  for (const id of [theirs.id, agentFound.id, 'no-such-item']) {
    await assert.rejects(w.manager.updateReportedBug(session.id, id, { severity: 'low' }), planItemService.PlanItemNotFoundError);
    await assert.rejects(w.manager.deleteReportedBug(session.id, id), planItemService.PlanItemNotFoundError);
  }
  await assert.rejects(w.manager.updateReportedBug(session.id, ordinary.id, { severity: 'low' }), bugs.ReportedItemKindError);
  await assert.rejects(w.manager.deleteReportedBug(session.id, ordinary.id), bugs.ReportedItemKindError);

  // A session in another Project cannot reach this Project's bug.
  const other = await world();
  const foreignSession = await reportSession(other);
  assert.equal(foreignSession.planningSessionNumber, session.planningSessionNumber, 'both are session 1 of their own Project');
  await assert.rejects(other.manager.updateReportedBug(foreignSession.id, mine.id, { severity: 'low' }), planItemService.PlanItemNotFoundError);
  await assert.rejects(other.manager.deleteReportedBug(foreignSession.id, mine.id), planItemService.PlanItemNotFoundError);
  assert.equal((await planItemService.getPlanItem(mine.id)).bug!.severity, null);

  // A finished report session can no longer file.
  await w.exitAll();
  await assert.rejects(w.manager.createReportedBug(session.id, report()), bugTrackerModule.TaskNotBugReportSessionError);
  await other.exitAll();
});

test('I26 I27 a session updates each field of its own ready bug, and clearing the introducing task makes the bug standalone', async () => {
  const w = await world();
  const introducer = await startedTask(w.project.id, '4.002: Add login');
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: introducer.id, commit: 'abc' }));
  const before = w.events.length;

  const updated = await w.manager.updateReportedBug(session.id, bug.id, bugs.parseBugReportPatch({
    title: 'Crash when saving twice', severity: 'critical', infoStatus: 'enough', suspectedLocation: 'server/save', commit: 'def5678',
    summary: 'Second save crashes', expectedVsActual: 'Saves; crashes', stepsToReproduce: 'Save twice',
  }));
  assert.equal(updated.title, '4.002.001: Crash when saving twice', 'the number is unchanged');
  assert.equal(updated.bug!.severity, 'critical');
  assert.equal(updated.bug!.infoStatus, 'enough');
  assert.deepEqual(updated.bug!.introducedBy, { planItemId: introducer.id, number: '4.002', title: 'Add login', commit: 'def5678' });
  assert.match(updated.description, /## Summary\n\nSecond save crashes/);
  assert.match(updated.description, /## Suspected location\n\nserver\/save/);
  assert.match(updated.description, /\(commit def5678\)/);
  assert.equal(w.events.slice(before).filter((event) => event.type === 'planItem' && event.planItem.id === bug.id).length, 1);

  const standalone = await w.manager.updateReportedBug(session.id, bug.id, bugs.parseBugReportPatch({ introducedByTaskId: null }));
  assert.equal(standalone.bug!.introducedBy, null);
  assert.equal(standalone.title, '4.002.001: Crash when saving twice');
  assert.match(standalone.description, /## Introduced by\n\nUnknown$/);

  // The commit belongs to the introducing task it was found in.
  const other = await startedTask(w.project.id, '6.001: Add search');
  const patchOf = (fields: Record<string, unknown>) => w.manager.updateReportedBug(session.id, bug.id, bugs.parseBugReportPatch(fields));
  const commitOf = async (fields: Record<string, unknown>) => (await patchOf(fields)).bug!.introducedBy?.commit;
  assert.equal(await commitOf({ introducedByTaskId: introducer.id, commit: 'aaa1111' }), 'aaa1111');
  const moved = await patchOf({ introducedByTaskId: other.id });
  assert.deepEqual(moved.bug!.introducedBy, { planItemId: other.id, number: '6.001', title: 'Add search', commit: null }, 'a different task does not inherit the old commit');
  assert.match(moved.description, /## Introduced by\n\n6\.001: Add search$/);
  assert.equal(await commitOf({ introducedByTaskId: introducer.id, commit: 'bbb2222' }), 'bbb2222', 'a different task with its own commit');
  assert.equal(await commitOf({ introducedByTaskId: introducer.id }), 'bbb2222', 'the same task named again keeps its commit');
  assert.equal(await commitOf({ severity: 'low' }), 'bbb2222', 'an unrelated change keeps it');
  assert.equal(await commitOf({ introducedByTaskId: introducer.id, commit: null }), null, 'null clears it, with the task named');
  assert.equal(await commitOf({ commit: 'ccc3333' }), 'ccc3333');
  assert.equal(await commitOf({ commit: null }), null, 'and with the task left alone');
  assert.equal(await commitOf({ introducedByTaskId: other.id, commit: null }), null);

  await assert.rejects(w.manager.updateReportedBug(session.id, bug.id, { summary: 's'.repeat(20_000) }), bugs.BugValidationError, 'an over-long composed description');
  assert.equal((await planItemService.getPlanItem(bug.id)).bug!.summary, 'Second save crashes', 'the refused update changed nothing');
  await w.exitAll();
});

test('I29 I30 a started bug can no longer be changed or deleted; deleting a ready one is announced and counted as removed', async () => {
  const w = await world();
  const session = await reportSession(w);
  for (const status of ['developing', 'blocked', 'stopped', 'failed', 'done'] as const) {
    const bug = await w.manager.createReportedBug(session.id, report());
    await collections.planItemsDb.update(bug.id, { status });
    await assert.rejects(w.manager.updateReportedBug(session.id, bug.id, { severity: 'low' }), bugs.BugStartedError, status);
    await assert.rejects(w.manager.deleteReportedBug(session.id, bug.id), bugs.BugStartedError, status);
  }

  const ready = await w.manager.createReportedBug(session.id, report());
  await w.manager.deleteReportedBug(session.id, ready.id);
  assert.ok(w.events.some((event) => event.type === 'planItemDeleted' && event.id === ready.id));
  const filed = (await w.manager.getTask(session.id)).planningCreatedTaskCount!;
  const existing = (await planItems(w.project.id)).filter((item) => item.bug?.reportSessionNumber === 1).length;
  assert.equal(filed - existing, 1, 'removed = filed minus existing');
  await w.exitAll();
});

test('I31 two bugs filed at once get distinct ids, consecutive numbers and a stable order', async () => {
  const w = await world();
  const session = await reportSession(w);
  const [a, b] = await Promise.all([
    w.manager.createReportedBug(session.id, report({ title: 'First' })),
    w.manager.createReportedBug(session.id, report({ title: 'Second' })),
  ]);
  assert.notEqual(a.id, b.id);
  assert.deepEqual([a.title, b.title], ['B.001: First', 'B.002: Second']);
  assert.deepEqual((await planItems(w.project.id)).map((item) => item.id), [a.id, b.id]);
  assert.deepEqual((await planItems(w.project.id)).map((item) => item.id), [a.id, b.id], 'the order is the same on every read');
  await w.exitAll();
});

test('I33 I34 filing needs no repository and raises no notification', async () => {
  const w = await world();
  assert.equal(w.project.repositoryUrl, undefined);
  const session = await reportSession(w);
  const notificationsBefore = (await notificationService.listNotifications()).length;
  const bug = await w.manager.createReportedBug(session.id, report());
  assert.equal(bug.bug!.introducedBy, null, 'no commit without an introducing task');
  assert.equal((await notificationService.listNotifications()).length, notificationsBefore);
  await w.exitAll();
});

// ---- Planning sessions and the Info flag (I35–I37) ----

test('I35 I36 a planning session lists bugs but cannot change or delete one, and its created-task count ignores bugs', async () => {
  const w = await world();
  const planning = await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  const task = await w.manager.createPlanningTask(planning.id, { title: 'Add login', description: '' });
  await collections.planItemsDb.update(task.id, { status: 'done' });
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: task.id }));

  assert.ok((await w.manager.listPlanningTasks(planning.id)).some((item) => item.id === bug.id && item.type === 'bug'));
  await assert.rejects(w.manager.updatePlanningTask(planning.id, bug.id, { title: 'Hijacked' }), bugs.BugNotPlanningTaskError);
  await assert.rejects(w.manager.deletePlanningTask(planning.id, bug.id), bugs.BugNotPlanningTaskError);
  assert.equal((await planItemService.getPlanItem(bug.id)).title, '1.001.001: Crash on save');
  assert.equal((await w.manager.getTask(planning.id)).planningCreatedTaskCount, 1, 'a bug against its task is not one of its created tasks');
  await w.exitAll();
});

test('I37 the person flips Info status on a ready bug only', async () => {
  const w = await world();
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report());
  const task = await planItemService.createPlanItem({ projectId: w.project.id, title: 'Ordinary', description: '' });
  const before = w.events.length;

  const flipped = await w.manager.setBugInfoStatus(bug.id, 'enough');
  assert.equal(flipped.bug!.infoStatus, 'enough');
  assert.equal(w.events.slice(before).filter((event) => event.type === 'planItem' && event.planItem.id === bug.id).length, 1);
  await assert.rejects(w.manager.setBugInfoStatus(task.id, 'enough'), bugs.BugValidationError);
  await collections.planItemsDb.update(bug.id, { status: 'developing' });
  await assert.rejects(w.manager.setBugInfoStatus(bug.id, 'needs-more-info'), bugs.BugStartedError);
  assert.equal((await planItemService.getPlanItem(bug.id)).bug!.infoStatus, 'enough');
  await w.exitAll();
});

// ---- Session completion (I38–I44) ----

test('I38 I40 a session that filed nothing is never auto-completed, and a live one waits for its turn to settle', async () => {
  const w = await world();
  const empty = await reportSession(w);
  w.terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await w.manager.getTask(empty.id)).status === 'stopped');
  assert.equal((await w.manager.getTask(empty.id)).archived, undefined);

  const live = await reportSession(w, 'Second report');
  const bug = await w.manager.createReportedBug(live.id, report());
  await w.manager.deleteReportedBug(live.id, bug.id);
  assert.equal((await w.manager.getTask(live.id)).archived, undefined, 'a live turn is never interrupted');
  w.terminal.starts[1]!.onExit(0);
  await waitUntil(async () => !!(await w.manager.getTask(live.id)).planningCompletedAt);
  assert.equal((await w.manager.getTask(live.id)).archived, true);
  assert.equal((await w.manager.getTask(empty.id)).archived, undefined, 'the empty session still waits in Planning');
});

test('I39 I44 I47 I48 an idle session completes once its last ready bug is accepted to start; a refused start changes nothing', async () => {
  const w = await world();
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report());
  w.terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await w.manager.getTask(session.id)).status === 'stopped');
  assert.equal((await w.manager.getTask(session.id)).archived, undefined, 'idle with a ready bug: it stays');

  // The Project's one slot is held, so the start is refused: 409, the bug still ready, nothing queued.
  const holder = await w.manager.startTask({ projectId: w.project.id, description: 'Hold the slot', executorId: 'test-claude-cli' });
  await assert.rejects(w.manager.executePlanItem(bug.id, { executorId: 'test-claude-cli' }), workerManagerModule.TaskConflictError);
  assert.equal((await planItemService.getPlanItem(bug.id)).status, 'pending');
  assert.deepEqual(await w.manager.listPlanItemQueue(w.project.id), []);
  assert.equal((await w.manager.getTask(session.id)).archived, undefined, 'a refused start does not change eligibility');
  w.terminal.starts.find((start) => start.taskId === holder.id)!.onExit(0);
  await waitUntil(async () => (await projectService.getProject(w.project.id)).status === 'idle');

  const before = w.events.length;
  await settledExecute(w.manager)(bug.id, { executorId: 'test-claude-cli' });
  const started = await planItemService.getPlanItem(bug.id);
  assert.equal(started.status, 'developing', 'it leaves ready at once');
  assert.equal(started.type, 'bug');
  assert.equal(started.bug!.infoStatus, 'needs-more-info', 'attributes are kept');
  assert.ok(w.events.slice(before).some((event) => event.type === 'planItem' && event.planItem.id === bug.id && event.planItem.status === 'developing'));
  await waitUntil(async () => !!(await w.manager.getTask(session.id)).planningCompletedAt);
  assert.equal((await w.manager.getTask(session.id)).archived, true);

  // Marked complete by hand, the bug is still a bug with its attributes.
  await w.manager.completePlanItem(bug.id);
  const done = await planItemService.getPlanItem(bug.id);
  assert.equal(done.status, 'done');
  assert.equal(done.type, 'bug');
  assert.deepEqual(done.bug, started.bug);
  await w.exitAll();
});

test('I41 I42 I43 manual completion, restore and deletion of a session never touch its bugs', async () => {
  const w = await world();
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report());
  const snapshot = await planItemService.getPlanItem(bug.id);
  w.terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await w.manager.getTask(session.id)).status === 'stopped');

  await w.manager.completePlanningSession(session.id);
  assert.equal((await w.manager.getTask(session.id)).archived, true);
  assert.deepEqual(await planItemService.getPlanItem(bug.id), snapshot, 'bugs untouched by manual completion');

  await w.manager.archiveSession(session.id, false);
  const restored = await w.manager.getTask(session.id);
  assert.equal(restored.archived, false);
  assert.equal(restored.planningCompletedAt, null);
  assert.equal(restored.planningAutoCompleteArmed, true, 'its ready bug re-arms completion');
  assert.deepEqual(await planItemService.getPlanItem(bug.id), snapshot);

  await w.manager.deleteSession(session.id);
  assert.deepEqual(await planItemService.getPlanItem(bug.id), snapshot, 'deleting the session leaves its bugs');
});

// ---- Starting a bug (I45–I50) ----

test('I45 I49 I50 a bug started with no workflow runs the Bug Fix slot; an explicit workflow wins; a disabled Bug Fix falls back to the default', async () => {
  const w = await world();
  const session = await reportSession(w);
  const [slotBug, explicitBug, fallbackBug] = [await w.manager.createReportedBug(session.id, report()), await w.manager.createReportedBug(session.id, report()), await w.manager.createReportedBug(session.id, report())];
  await w.exitAll();
  const defaultWorkflow = (await workflowService.getDefaultWorkflow())!;
  assert.notEqual(defaultWorkflow.id, 'bug-fix');

  const runOf = async (id: string) => (await w.manager.getWorkflowRun((await planItemService.getPlanItem(id)).workflowRunId!))!;
  const settle = async (id: string) => { await w.manager.stopWorkflowRun((await runOf(id)).id); await w.exitAll(); };

  assert.equal(slotBug.bug!.infoStatus, 'needs-more-info');
  await settledExecute(w.manager)(slotBug.id, { executorId: 'test-claude-cli' });
  assert.equal((await runOf(slotBug.id)).workflowId, 'bug-fix', 'a "Needs more info" bug starts, on the Bug Fix workflow');
  await settle(slotBug.id);

  await settledExecute(w.manager)(explicitBug.id, { executorId: 'test-claude-cli', workflowId: defaultWorkflow.id });
  assert.equal((await runOf(explicitBug.id)).workflowId, defaultWorkflow.id);
  await settle(explicitBug.id);

  await workflowService.updateWorkflow('bug-fix', { enabled: false });
  try {
    await settledExecute(w.manager)(fallbackBug.id, { executorId: 'test-claude-cli' });
    assert.equal((await runOf(fallbackBug.id)).workflowId, defaultWorkflow.id);
    await settle(fallbackBug.id);
  } finally {
    await workflowService.updateWorkflow('bug-fix', { enabled: true });
  }

  // An ordinary task is unaffected: it runs the Project's default workflow.
  const task = await planItemService.createPlanItem({ projectId: w.project.id, title: 'Ordinary', description: '' });
  await settledExecute(w.manager)(task.id, { executorId: 'test-claude-cli' });
  assert.equal((await runOf(task.id)).workflowId, defaultWorkflow.id);
  await settle(task.id);
});

// ---- Introducing task removed (I51–I52) ----

test('I51 I52 I58 deleting or archiving the introducing task leaves the bug and its copied number and title; its group still reorders', async () => {
  const w = await world();
  const introducer = await startedTask(w.project.id, '4.002: Add login');
  const session = await reportSession(w);
  const first = await w.manager.createReportedBug(session.id, report({ title: 'One', introducedByTaskId: introducer.id }));
  const second = await w.manager.createReportedBug(session.id, report({ title: 'Two', introducedByTaskId: introducer.id }));

  await w.manager.archivePlanItem(introducer.id, true);
  assert.deepEqual((await planItemService.getPlanItem(first.id)).bug, first.bug, 'archiving leaves the bug unchanged');

  await w.manager.deletePlanItem(introducer.id);
  const kept = await planItemService.getPlanItem(first.id);
  assert.deepEqual(kept.bug!.introducedBy, { planItemId: introducer.id, number: '4.002', title: 'Add login', commit: null });
  assert.equal(kept.title, '4.002.001: One');
  assert.equal((await planItems(w.project.id)).length, 2, 'the plan still reads without error');

  await w.manager.reorderBugGroup(w.project.id, introducer.id, [second.id, first.id]);
  assert.equal((await planItemService.getPlanItem(second.id)).bug!.groupOrder, 0);
  assert.equal((await planItemService.getPlanItem(first.id)).bug!.groupOrder, 1);
  await w.exitAll();
});

// ---- Reorder (I53–I64) ----

test('I53 I56 I57 I63 a bug group reorders only as its exact ready set, and nothing else about the bugs changes', async () => {
  const w = await world();
  const introducer = await startedTask(w.project.id, '4.002: Add login');
  const otherIntroducer = await startedTask(w.project.id, '4.003: Add logout');
  const session = await reportSession(w);
  const file = (title: string, introducedByTaskId?: string) => w.manager.createReportedBug(session.id, report({ title, introducedByTaskId }));
  const [a, b, c] = [await file('A', introducer.id), await file('B', introducer.id), await file('C', introducer.id)];
  const elsewhere = await file('Elsewhere', otherIntroducer.id);
  const standalone = await file('Standalone');
  const ordinary = await planItemService.createPlanItem({ projectId: w.project.id, title: 'Ordinary', description: '' });
  const groupOrder = async () => Promise.all([a, b, c].map(async (bug) => (await planItemService.getPlanItem(bug.id)).bug!.groupOrder));
  const before = w.events.length;

  await w.manager.reorderBugGroup(w.project.id, introducer.id, [c.id, a.id, b.id]);
  assert.deepEqual(await groupOrder(), [1, 2, 0]);
  assert.deepEqual(w.events.slice(before).filter((event) => event.type === 'planItem').map((event) => (event as { planItem: PlanItemRecord }).planItem.id), [c.id, a.id, b.id]);
  for (const bug of [a, b, c]) {
    const now = await planItemService.getPlanItem(bug.id);
    assert.equal(now.title, bug.title, 'reordering changes no number or title');
    assert.equal(now.order, bug.order);
  }

  const conflict = bugTrackerModule.BugGroupConflictError;
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, introducer.id, [a.id, b.id, c.id, elsewhere.id]), conflict, 'a bug of another group');
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, introducer.id, [a.id, b.id, standalone.id]), conflict, 'a standalone bug');
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, introducer.id, [a.id, b.id, ordinary.id]), conflict, 'an ordinary task');
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, introducer.id, [a.id, b.id]), conflict, 'a missing ready bug');
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, introducer.id, [a.id, b.id, 'no-such-bug']), planItemService.PlanItemNotFoundError);
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, 'no-such-task', []), planItemService.PlanItemNotFoundError);
  assert.deepEqual(await groupOrder(), [1, 2, 0], 'every refusal left the order intact');

  // A stale order: a bug filed after the ids were captured.
  const captured = [a.id, b.id, c.id];
  const late = await file('Late', introducer.id);
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, introducer.id, captured), conflict);
  assert.equal(late.bug!.groupOrder, null, 'an unpositioned bug follows the positioned ones');

  await collections.planItemsDb.update(late.id, { status: 'developing' });
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, introducer.id, [...captured, late.id]), conflict, 'a started bug');
  await w.manager.reorderBugGroup(w.project.id, introducer.id, [a.id, b.id, c.id]);
  assert.deepEqual(await groupOrder(), [0, 1, 2]);
  await w.exitAll();
});

test('I55 a bug group in another Project cannot be reordered from here', async () => {
  const w = await world();
  const other = await world();
  const foreignIntroducer = await startedTask(other.project.id, '9.001: Foreign');
  const foreignSession = await reportSession(other);
  const foreignBug = await other.manager.createReportedBug(foreignSession.id, report({ introducedByTaskId: foreignIntroducer.id }));
  const introducer = await startedTask(w.project.id, '4.002: Add login');
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report({ introducedByTaskId: introducer.id }));

  await assert.rejects(w.manager.reorderBugGroup(w.project.id, foreignIntroducer.id, [foreignBug.id]), planItemService.PlanItemNotFoundError);
  await assert.rejects(w.manager.reorderBugGroup(w.project.id, introducer.id, [bug.id, foreignBug.id]), planItemService.PlanItemNotFoundError);
  assert.equal((await planItemService.getPlanItem(foreignBug.id)).bug!.groupOrder, null);
  await w.exitAll();
  await other.exitAll();
});

/** A Project with every kind of top-level Planning entry: a conversation (with a group beneath it), a top-level group, a standalone bug, a report session and a standalone task. */
async function mixedQueue() {
  const w = await world();
  const planning = await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  const nestedIntroducer = await w.manager.createPlanningTask(planning.id, { title: 'In a live conversation', description: '' });
  await collections.planItemsDb.update(nestedIntroducer.id, { status: 'done' });
  const topIntroducer = await startedTask(w.project.id, '7.001: Standalone introducer');
  const session = await reportSession(w);
  const file = (title: string, introducedByTaskId?: string) => w.manager.createReportedBug(session.id, report({ title, introducedByTaskId }));
  const nestedBug = await file('Under a conversation', nestedIntroducer.id);
  const [groupBugA, groupBugB] = [await file('Group A', topIntroducer.id), await file('Group B', topIntroducer.id)];
  const standaloneBug = await file('Standalone bug');
  const standaloneTask = await planItemService.createPlanItem({ projectId: w.project.id, title: 'Standalone task', description: '' });
  return { w, planning, session, nestedIntroducer, topIntroducer, nestedBug, groupBugA, groupBugB, standaloneBug, standaloneTask };
}

test('I59 I60 the top-level order takes sessions, standalone tasks and bugs, and top-level introducing-task cards', async () => {
  const q = await mixedQueue();
  const { w } = q;
  assert.equal(q.groupBugB.planningQueueOrder, q.groupBugA.planningQueueOrder, 'a bug joining a group takes the group\'s slot');
  const order = async (id: string) => (await planItemService.getPlanItem(id)).planningQueueOrder;
  const full = [
    { kind: 'reference' as const, id: q.topIntroducer.id },
    { kind: 'session' as const, id: q.session.id },
    { kind: 'task' as const, id: q.standaloneBug.id },
    { kind: 'session' as const, id: q.planning.id },
    { kind: 'task' as const, id: q.standaloneTask.id },
  ];

  await w.manager.reorderPlanningQueue(w.project.id, full);
  assert.deepEqual([await order(q.groupBugA.id), await order(q.groupBugB.id)], [0, 0], 'every ready bug of the group holds its slot');
  assert.equal((await w.manager.getTask(q.session.id)).planningQueueOrder, 1);
  assert.equal(await order(q.standaloneBug.id), 2);
  assert.equal((await w.manager.getTask(q.planning.id)).planningQueueOrder, 3);
  assert.equal(await order(q.standaloneTask.id), 4);
  const titles = async () => Promise.all([q.groupBugA, q.groupBugB, q.standaloneBug].map(async (bug) => (await planItemService.getPlanItem(bug.id)).title));
  assert.deepEqual(await titles(), ['7.001.001: Group A', '7.001.002: Group B', 'B.001: Standalone bug'], 'no number or title changes');

  const without = (id: string) => full.filter((entry) => entry.id !== id);
  await assert.rejects(w.manager.reorderPlanningQueue(w.project.id, [...without(q.topIntroducer.id), { kind: 'reference', id: 'no-such-task' }]), planItemService.PlanItemNotFoundError, 'an unknown reference id');
  await assert.rejects(w.manager.reorderPlanningQueue(w.project.id, [...full, { kind: 'reference', id: q.nestedIntroducer.id }]), workerManagerModule.PlanningQueueConflictError, 'a reference under a conversation');
  await assert.rejects(w.manager.reorderPlanningQueue(w.project.id, without(q.topIntroducer.id)), workerManagerModule.PlanningQueueConflictError, 'a top-level reference left out');
  await assert.rejects(w.manager.reorderPlanningQueue(w.project.id, [...full, { kind: 'task', id: q.groupBugA.id }]), planItemService.PlanItemNotFoundError, 'a bug inside a group is not a top-level entry');
  await assert.rejects(w.manager.reorderPlanningQueue(w.project.id, [...full, { kind: 'task', id: q.nestedBug.id }]), planItemService.PlanItemNotFoundError);
  assert.deepEqual([await order(q.groupBugA.id), await order(q.standaloneBug.id), await order(q.standaloneTask.id)], [0, 2, 4], 'every refusal left the order intact');

  // Its conversation has no ready task left, so it completes once idle; the nested group then becomes a top-level entry of its own.
  await w.exitAll();
  await waitUntil(async () => !!(await w.manager.getTask(q.planning.id)).archived);
  await w.manager.reorderPlanningQueue(w.project.id, [...without(q.planning.id), { kind: 'reference', id: q.nestedIntroducer.id }]);
  assert.equal(await order(q.nestedBug.id), 4);
});

test('I61 a top-level reorder whose write fails midway restores sessions, tasks and references and publishes nothing', async () => {
  const q = await mixedQueue();
  const { w } = q;
  const snapshot = async () => ({
    items: (await planItems(w.project.id)).map((item) => [item.id, item.planningQueueOrder, item.updatedAt]),
    sessions: (await w.manager.listTasksForProject(w.project.id)).map((task) => [task.id, task.planningQueueOrder]),
  });
  const before = await snapshot();
  const eventsBefore = w.events.length;
  const original = collections.tasksDb.update.bind(collections.tasksDb);
  collections.tasksDb.update = async (id, patch) => {
    if ('planningQueueOrder' in patch && (patch as Partial<TaskRecord>).planningQueueOrder === 3) throw new Error('disk full');
    return original(id, patch);
  };
  try {
    await assert.rejects(w.manager.reorderPlanningQueue(w.project.id, [
      { kind: 'reference', id: q.topIntroducer.id },
      { kind: 'task', id: q.standaloneBug.id },
      { kind: 'task', id: q.standaloneTask.id },
      { kind: 'session', id: q.session.id },
      { kind: 'session', id: q.planning.id },
    ]), /disk full/);
  } finally {
    collections.tasksDb.update = original;
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(w.events.length, eventsBefore, 'no event');
  await w.exitAll();
});

test('I62 with no bugs the mixed Planning queue behaves exactly as before', async () => {
  const w = await world();
  const planning = await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  const nested = await w.manager.createPlanningTask(planning.id, { title: 'Nested', description: '' });
  const standalone = await planItemService.createPlanItem({ projectId: w.project.id, title: 'Standalone', description: '' });
  await w.manager.reorderPlanningQueue(w.project.id, [{ kind: 'task', id: standalone.id }, { kind: 'session', id: planning.id }]);
  assert.equal((await planItemService.getPlanItem(standalone.id)).planningQueueOrder, 0);
  assert.equal((await w.manager.getTask(planning.id)).planningQueueOrder, 1);
  await assert.rejects(w.manager.reorderPlanningQueue(w.project.id, [{ kind: 'task', id: nested.id }, { kind: 'session', id: planning.id }]), planItemService.PlanItemNotFoundError);
  await assert.rejects(w.manager.reorderPlanningQueue(w.project.id, [{ kind: 'session', id: planning.id }]), workerManagerModule.PlanningQueueConflictError);
  await w.exitAll();
});

test('I3 I64 after a daemon restart the type, attributes, group order, top-level order and session counts are identical', async () => {
  const q = await mixedQueue();
  const { w } = q;
  await collections.planItemsDb.insert({
    id: `legacy-${w.project.id}`, projectId: w.project.id, title: 'Stored before types existed', description: '', status: 'pending', order: 99,
    taskIds: [], milestoneId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await w.manager.reorderBugGroup(w.project.id, q.topIntroducer.id, [q.groupBugB.id, q.groupBugA.id]);
  await w.exitAll();
  const beforeItems = await planItems(w.project.id);
  const beforeTasks = await w.manager.listTasksForProject(w.project.id);

  // A restart reads everything back from the files.
  const { FileDatabase } = await import('../src/db/FileDatabase.ts');
  const reloadedItems = (await new FileDatabase<PlanItemRecord>(path.join(process.env.AGENT_VISUAL_OS_DATA_DIR!, 'plan-items.json')).find((item) => item.projectId === w.project.id))
    .map(planItemService.readPlanItem).sort((a, b) => a.order - b.order);
  const reloadedTasks = await new FileDatabase<TaskRecord>(path.join(process.env.AGENT_VISUAL_OS_DATA_DIR!, 'tasks.json')).find((task) => task.projectId === w.project.id);
  // A file holds no `undefined`, so both sides are compared as JSON.
  const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const byId = <T extends { id: string }>(records: T[]) => [...records].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(reloadedItems, asStored(beforeItems));
  assert.deepEqual(byId(reloadedTasks), asStored(byId(beforeTasks)));

  const legacy = reloadedItems.find((item) => item.id === `legacy-${w.project.id}`)!;
  assert.equal(legacy.type, 'task', 'a pre-change record reads as a task');
  assert.equal('bug' in legacy, false);
  assert.deepEqual(reloadedItems.filter((item) => item.id === q.groupBugA.id || item.id === q.groupBugB.id).map((item) => item.bug!.groupOrder), [1, 0]);
  assert.equal(reloadedTasks.find((task) => task.id === q.session.id)!.planningCreatedTaskCount, 4);
  assert.equal(reloadedTasks.find((task) => task.id === q.session.id)!.planningPurpose, 'bug-report');
});

// ---- Agent-found bugs (I65–I78) ----

async function codingTask(w: World, description = 'Build the feature'): Promise<TaskRecord> {
  return w.manager.startTask({ projectId: w.project.id, description, executorId: 'test-claude-cli' });
}

/** A workflow step Task inserted as the engine leaves it: developing, in the Project's active set, on a step that may or may not edit code. */
async function stepTask(w: World, canEditCode: boolean, patch: Partial<TaskRecord> = {}): Promise<TaskRecord> {
  const item = await planItemService.createPlanItem({ projectId: w.project.id, title: '8.001: The task being worked on', description: '' });
  const runId = `run-${item.id}`;
  const now = new Date().toISOString();
  await collections.workflowRunsDb.insert({
    id: runId, projectId: w.project.id, planItemId: item.id, workflowId: 'wf', status: 'running', currentStepId: 'step',
    workflowSnapshot: { id: 'wf', name: 'WF', steps: [{ id: 'step', name: 'Step', canEditCode }] },
    createdAt: now, updatedAt: now, completedAt: null,
  } as unknown as WorkflowRunRecord);
  const task = await collections.tasksDb.insert({
    id: `step-${item.id}`, projectId: w.project.id, templateId: 'builder', executorId: 'test-claude-cli', executionMode: 'terminal',
    description: 'Run the step', status: 'developing', autonomy: 'auto', manager: false, kind: 'execute', planItemId: item.id,
    workflowRunId: runId, workflowStepId: 'step', sessionId: null, blockedQuestion: null, failureReason: null,
    tokenUsage: ZERO_TOKEN_USAGE, createdAt: now, updatedAt: now, completedAt: null, ...patch,
  });
  if (task.status === 'developing' && !patch.id) {
    const project = await projectService.getProject(w.project.id);
    await collections.projectsDb.update(w.project.id, { activeTaskIds: [...project.activeTaskIds, task.id] });
  }
  return task;
}

test('I65 I76 I77 a developing, active coding Task files a standalone "Needs more info" bug for an unrelated failing test', async () => {
  const w = await world();
  const step = await stepTask(w, true);
  const notificationsBefore = (await notificationService.listNotifications()).length;

  const result = await w.manager.fileAgentBug(step.id, agentBug({ severity: 'critical', introducedByTaskId: step.planItemId, infoStatus: 'enough' }));
  assert.equal(result.existing, false);
  const bug = result.bug;
  assert.equal(bug.type, 'bug');
  assert.equal(bug.title, 'B.001: Flaky date test');
  assert.equal(bug.bug!.infoStatus, 'needs-more-info', 'an "enough" the agent sent is ignored');
  assert.equal(bug.bug!.severity, null, 'a severity the agent sent is ignored');
  assert.equal(bug.bug!.introducedBy, null, 'an introducing task the agent sent is ignored');
  assert.deepEqual(bug.bug!.foundWhileWorkingOn, { planItemId: step.planItemId, number: '8.001', title: 'The task being worked on' });
  assert.equal(bug.bug!.reportSessionNumber, null, 'it belongs to no report session');
  assert.deepEqual(bug.bug!.testRef, { suiteId: 'server', actionId: 'tests', caseId: 'formats dates' });
  assert.match(bug.description, /AssertionError: expected 1 got 2/, 'the failure excerpt');
  assert.match(bug.description, /Failing case: formats dates/);
  assert.equal(bugEvents(w.events, bug.id).length, 1);
  assert.equal((await notificationService.listNotifications()).length, notificationsBefore);
});

test('I66 I67 I78 only a developing, active session that may edit code can file; everything else is refused', async () => {
  const w = await world();
  const refused = (taskId: string, what: string) => assert.rejects(w.manager.fileAgentBug(taskId, agentBug()), bugTrackerModule.TaskNotBugFilingSessionError, what);

  assert.equal((await w.manager.fileAgentBug((await stepTask(w, true)).id, agentBug())).existing, false, 'a canEditCode step');
  await refused((await stepTask(w, false)).id, 'a read-only step');
  for (const status of ['done', 'stopped', 'failed', 'blocked'] as const) await refused((await stepTask(w, true, { status })).id, `a ${status} caller`);
  // A step session reopened for inspection is a settled Task: it is no longer doing its task.
  await refused((await stepTask(w, true, { status: 'done', runtimeStatus: 'completed' })).id, 'a reopened step session');
  const inactive = await stepTask(w, true);
  await collections.projectsDb.update(w.project.id, { activeTaskIds: [] });
  await refused(inactive.id, 'developing but not in activeTaskIds');
  await assert.rejects(w.manager.fileAgentBug('no-such-task', agentBug()), workerManagerModule.TaskNotFoundError);

  const planning = await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  const session = await reportSession(w);
  await refused(planning.id, 'a planning session');
  await refused(session.id, 'a report session');
  assert.equal((await planItems(w.project.id)).filter((item) => item.type === 'bug').length, 1, 'only the allowed call created a bug');
  await w.exitAll();
});

test('I70 I71 I72 the same test case returns the open bug; a closed one or any different id files a new bug', async () => {
  const w = await world();
  const first = await codingTask(w);
  const { bug } = await w.manager.fileAgentBug(first.id, agentBug());
  const bugCount = async () => (await planItems(w.project.id)).filter((item) => item.type === 'bug').length;

  const again = await w.manager.fileAgentBug(first.id, agentBug({ title: 'Different words, same test', caseId: '  formats dates ' }));
  assert.equal(again.existing, true);
  assert.equal(again.bug.id, bug.id);
  assert.equal(again.bug.title, 'B.001: Flaky date test', 'the existing bug is returned unchanged');
  assert.equal(await bugCount(), 1);

  // Another Task of the same Project hits the same test.
  await w.exitAll();
  const second = await codingTask(w, 'Another task');
  assert.equal((await w.manager.fileAgentBug(second.id, agentBug())).bug.id, bug.id);

  for (const status of ['developing', 'stopped'] as const) {
    await collections.planItemsDb.update(bug.id, { status });
    assert.equal((await w.manager.fileAgentBug(second.id, agentBug())).existing, true, `${status} still matches`);
  }
  assert.equal(await bugCount(), 1);

  for (const different of [{ caseId: 'parses dates' }, { actionId: 'lint' }, { caseId: 'Formats dates' }, { suiteId: 'Server' }]) {
    assert.equal((await w.manager.fileAgentBug(second.id, agentBug(different))).existing, false, JSON.stringify(different));
  }
  assert.equal(await bugCount(), 5);

  await collections.planItemsDb.update(bug.id, { status: 'done' });
  const afterDone = await w.manager.fileAgentBug(second.id, agentBug());
  assert.equal(afterDone.existing, false, 'a completed bug no longer stands for the test');
  await collections.planItemsDb.update(afterDone.bug.id, { archived: true });
  assert.equal((await w.manager.fileAgentBug(second.id, agentBug())).existing, false, 'nor does an archived one');
  assert.equal(await bugCount(), 7);
  await w.exitAll();
});

test('I73 I74 the same test in another Project is a new bug, and two identical calls at once create one', async () => {
  const w = await world();
  const other = await world();
  const task = await codingTask(w);
  const otherTask = await codingTask(other);

  const [a, b] = await Promise.all([w.manager.fileAgentBug(task.id, agentBug()), w.manager.fileAgentBug(task.id, agentBug())]);
  assert.equal(a.bug.id, b.bug.id);
  assert.deepEqual([a.existing, b.existing].sort(), [false, true]);
  assert.equal((await planItems(w.project.id)).length, 1);

  const elsewhere = await other.manager.fileAgentBug(otherTask.id, agentBug());
  assert.equal(elsewhere.existing, false);
  assert.notEqual(elsewhere.bug.id, a.bug.id);
  assert.equal(elsewhere.bug.title, 'B.001: Flaky date test', 'numbered per Project');
  await w.exitAll();
  await other.exitAll();
});

test('a freeform coding Task with no task of its own files a bug with no "Found while working on"', async () => {
  const w = await world();
  const task = await codingTask(w);
  assert.equal(task.planItemId, null);
  assert.equal((await w.manager.fileAgentBug(task.id, agentBug())).bug.bug!.foundWhileWorkingOn, null);
  await w.exitAll();
});

test('I2 I1 the existing creation paths always create a task', async () => {
  const w = await world();
  const planning = await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  const planned = await w.manager.createPlanningTask(planning.id, { title: 'Add login', description: '' });
  const byHand = await planItemService.createPlanItem({ projectId: w.project.id, title: 'By hand', description: '' });
  for (const item of [planned, byHand]) {
    assert.equal(item.type, 'task');
    assert.equal('bug' in item, false);
  }
  await w.exitAll();
});

// ---- Tasks filed by a report session (I1–I34 of the task-filing plan) ----

const taskDraft = (fields: Record<string, unknown> = {}) => bugs.parseReportedTask({ title: 'Add a diagnostics view', description: 'Build a view that shows X. Full brief.', ...fields });

test('I1 I6 I9 I11 I13 a report session files an unstarted task: listed, announced, owned, counted, and linked to its own bug', async () => {
  const w = await world();
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report());
  const before = w.events.length;
  const task = await w.manager.createReportedTask(session.id, taskDraft({ relatedBugId: bug.id }));

  assert.equal(task.type, 'task');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.taskIds, []);
  assert.equal(task.workflowRunId, null);
  assert.equal(task.title, 'Add a diagnostics view', 'plain title: no number prefix');
  assert.equal(task.reportSessionNumber, session.planningSessionNumber);
  assert.deepEqual(task.relatedBug, { planItemId: bug.id, number: 'B.001', title: 'Crash on save' });
  assert.equal('bug' in task, false);
  assert.ok(w.events.slice(before).some((event) => event.type === 'planItem' && event.planItem.id === task.id));
  assert.ok((await planItems(w.project.id)).some((item) => item.id === task.id));
  assert.equal((await planItemService.getPlanItem(bug.id)).title, bug.title, 'the bug record is unchanged');
  assert.equal((await w.manager.getTask(session.id)).planningCreatedTaskCount, 2, 'bug + task');
  assert.equal((await collections.projectsDb.get(w.project.id))!.bugSequence, 1, 'a task spends no bug number');

  const unlinked = await w.manager.createReportedTask(session.id, taskDraft({ relatedBugId: null }));
  assert.equal('relatedBug' in unlinked, false);
  const blankTitle = await w.manager.createReportedTask(session.id, taskDraft({ title: '', description: 'Line one\nmore' }));
  assert.equal(blankTitle.title, 'Line one', 'a description-only task gets the provisional title');
  await w.exitAll();
});

test('I7 I8 I10 a task may link to an own started bug; another session\'s bug, a task or an unknown id is refused and creates nothing', async () => {
  const w = await world();
  const session = await reportSession(w);
  const other = await reportSession(w, 'Another');
  const mine = await w.manager.createReportedBug(session.id, report());
  const theirs = await w.manager.createReportedBug(other.id, report());
  const plain = await planItemService.createPlanItem({ projectId: w.project.id, title: 'Plain', description: '' });
  await collections.planItemsDb.update(mine.id, { status: 'developing' });
  const count = (await planItems(w.project.id)).length;
  const created = (await w.manager.getTask(session.id)).planningCreatedTaskCount;

  const started = await w.manager.createReportedTask(session.id, taskDraft({ relatedBugId: mine.id }));
  assert.equal(started.relatedBug!.planItemId, mine.id);
  const second = await w.manager.createReportedTask(session.id, taskDraft({ title: 'Second', relatedBugId: mine.id }));
  assert.equal((await planItems(w.project.id)).length, count + 2);

  for (const id of [theirs.id, plain.id, started.id, 'no-such-bug']) {
    await assert.rejects(w.manager.createReportedTask(session.id, taskDraft({ relatedBugId: id })), bugs.BugValidationError, id);
  }
  assert.equal((await planItems(w.project.id)).length, count + 2, 'refused calls create nothing');
  assert.equal((await w.manager.getTask(session.id)).planningCreatedTaskCount, created! + 2);

  await collections.planItemsDb.delete(mine.id);
  assert.equal((await planItemService.getPlanItem(second.id)).relatedBug!.planItemId, mine.id, 'a deleted bug leaves the stored link');
  await w.exitAll();
});

test('I3 I4 I5 I30 a session task is created and started like a board task: default workflow, never started by the session', async () => {
  const w = await world();
  const session = await reportSession(w);
  const task = await w.manager.createReportedTask(session.id, taskDraft());
  const board = await planItemService.createPlanItem({ projectId: w.project.id, title: task.title, description: task.description });
  const strip = ({ id: _id, createdAt: _c, updatedAt: _u, order: _o, planningQueueOrder: _q, reportSessionNumber: _r, ...rest }: PlanItemRecord) => rest;
  assert.deepEqual(strip(task), strip(board), 'same record as the board create flow, apart from ownership');

  assert.equal((await w.manager.getTask(session.id)).status, 'developing');
  assert.equal((await planItemService.getPlanItem(task.id)).status, 'pending');
  assert.deepEqual(await w.manager.listPlanItemQueue(w.project.id), []);
  await w.exitAll();
  assert.equal((await planItemService.getPlanItem(task.id)).workflowRunId ?? null, null, 'still unstarted after the session ends');

  const defaultWorkflow = (await workflowService.getDefaultWorkflow())!;
  await settledExecute(w.manager)(task.id, { executorId: 'test-claude-cli' });
  const run = (await w.manager.getWorkflowRun((await planItemService.getPlanItem(task.id)).workflowRunId!))!;
  assert.equal(run.workflowId, defaultWorkflow.id, 'not the Bug Fix workflow');
  await w.manager.stopWorkflowRun(run.id);
  await w.exitAll();
});

test('I14 I15 I16 update_task changes an own ready task, sets, changes and clears the link, and refuses a started one', async () => {
  const w = await world();
  const session = await reportSession(w);
  const bugA = await w.manager.createReportedBug(session.id, report());
  const bugB = await w.manager.createReportedBug(session.id, report({ title: 'Other crash' }));
  const task = await w.manager.createReportedTask(session.id, taskDraft());

  const before = w.events.length;
  const retitled = await w.manager.updateReportedTask(session.id, task.id, bugs.parseReportedTaskPatch({ title: 'New title' }));
  assert.equal(retitled.title, 'New title');
  assert.equal(retitled.description, task.description, 'other fields stay');
  assert.ok(retitled.updatedAt >= task.updatedAt);
  assert.ok(w.events.slice(before).some((event) => event.type === 'planItem' && event.planItem.id === task.id));

  assert.equal((await w.manager.updateReportedTask(session.id, task.id, { relatedBugId: bugA.id })).relatedBug!.planItemId, bugA.id);
  assert.equal((await w.manager.updateReportedTask(session.id, task.id, { relatedBugId: bugB.id })).relatedBug!.planItemId, bugB.id);
  await assert.rejects(w.manager.updateReportedTask(session.id, task.id, { relatedBugId: 'no-such-bug' }), bugs.BugValidationError);
  assert.equal((await planItemService.getPlanItem(task.id)).relatedBug!.planItemId, bugB.id, 'an invalid link leaves the record unchanged');
  const cleared = await w.manager.updateReportedTask(session.id, task.id, { relatedBugId: null });
  assert.equal('relatedBug' in cleared, false);
  assert.equal('relatedBug' in await planItemService.getPlanItem(task.id), false);

  const startedStates: Partial<PlanItemRecord>[] = [
    { status: 'developing' }, { status: 'done' }, { status: 'failed' }, { status: 'stopped' }, { status: 'blocked' }, { taskIds: ['run-1'] }, { workflowRunId: 'wf-1' },
  ];
  for (const state of startedStates) {
    const own = await w.manager.createReportedTask(session.id, taskDraft());
    await collections.planItemsDb.update(own.id, state);
    await assert.rejects(w.manager.updateReportedTask(session.id, own.id, { title: 'Changed' }), bugs.ReportedTaskStartedError, JSON.stringify(state));
    await assert.rejects(w.manager.deleteReportedTask(session.id, own.id), bugs.ReportedTaskStartedError, JSON.stringify(state));
    assert.equal((await planItemService.getPlanItem(own.id)).title, task.title, 'a started task is not changed or removed');
  }
  await w.exitAll();
});

test('I17 I19 I20 delete_task removes an own ready task; ownership and kind are enforced; only a running report session may call', async () => {
  const w = await world();
  const session = await reportSession(w);
  const otherSession = await reportSession(w, 'Another');
  const planning = await w.manager.startTask({ projectId: w.project.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  const mine = await w.manager.createReportedTask(session.id, taskDraft());
  const theirs = await w.manager.createReportedTask(otherSession.id, taskDraft());
  const manual = await planItemService.createPlanItem({ projectId: w.project.id, title: 'Manual', description: '' });
  const planned = await planItemService.createPlanningPlanItem({ projectId: w.project.id, session: 9, title: 'Planned', description: '' });
  const bug = await w.manager.createReportedBug(session.id, report());

  for (const id of [theirs.id, manual.id, planned.id, 'no-such-item']) {
    await assert.rejects(w.manager.updateReportedTask(session.id, id, { title: 'x' }), planItemService.PlanItemNotFoundError, id);
    await assert.rejects(w.manager.deleteReportedTask(session.id, id), planItemService.PlanItemNotFoundError, id);
  }
  await assert.rejects(w.manager.updateReportedTask(session.id, bug.id, { title: 'x' }), bugs.ReportedItemKindError);
  await assert.rejects(w.manager.deleteReportedTask(session.id, bug.id), bugs.ReportedItemKindError);
  await assert.rejects(w.manager.updateReportedBug(session.id, mine.id, { severity: 'low' }), bugs.ReportedItemKindError);
  await assert.rejects(w.manager.deleteReportedBug(session.id, mine.id), bugs.ReportedItemKindError);
  for (const caller of [planning.id]) {
    await assert.rejects(w.manager.createReportedTask(caller, taskDraft()), bugTrackerModule.TaskNotBugReportSessionError);
    await assert.rejects(w.manager.updateReportedTask(caller, mine.id, { title: 'x' }), bugTrackerModule.TaskNotBugReportSessionError);
    await assert.rejects(w.manager.deleteReportedTask(caller, mine.id), bugTrackerModule.TaskNotBugReportSessionError);
  }
  await assert.rejects(w.manager.createReportedTask('no-such-task', taskDraft()), workerManagerModule.TaskNotFoundError);

  const before = w.events.length;
  await w.manager.deleteReportedTask(session.id, mine.id);
  assert.ok(w.events.slice(before).some((event) => event.type === 'planItemDeleted' && event.id === mine.id));
  assert.equal((await planItems(w.project.id)).some((item) => item.id === mine.id), false);

  await w.exitAll();
  await assert.rejects(w.manager.createReportedTask(session.id, taskDraft()), bugTrackerModule.TaskNotBugReportSessionError, 'a finished session cannot file');
});

test('I12 I29 a ready task keeps the session open; accepting or deleting the last item completes it; deleting the session leaves its tasks', async () => {
  const w = await world();
  const session = await reportSession(w);
  const task = await w.manager.createReportedTask(session.id, taskDraft());
  w.terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await w.manager.getTask(session.id)).status === 'stopped');
  assert.equal((await w.manager.getTask(session.id)).archived, undefined, 'idle with a ready task: it stays');

  await settledExecute(w.manager)(task.id, { executorId: 'test-claude-cli' });
  await waitUntil(async () => !!(await w.manager.getTask(session.id)).planningCompletedAt);

  const w2 = await world();
  const second = await reportSession(w2);
  const only = await w2.manager.createReportedTask(second.id, taskDraft());
  await w2.manager.deleteReportedTask(second.id, only.id);
  w2.terminal.starts[0]!.onExit(0);
  await waitUntil(async () => !!(await w2.manager.getTask(second.id)).planningCompletedAt);
  await w.exitAll();
  await w2.exitAll();
});

test('I22 two tasks filed at once get distinct ids and both are listed', async () => {
  const w = await world();
  const session = await reportSession(w);
  const [a, b] = await Promise.all([
    w.manager.createReportedTask(session.id, taskDraft({ title: 'A' })),
    w.manager.createReportedTask(session.id, taskDraft({ title: 'B' })),
  ]);
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await planItems(w.project.id)).filter((item) => item.reportSessionNumber).map((item) => item.title), ['A', 'B']);
  await w.exitAll();
});

test('I24 I34 tasks keep their link and owner after a restart; a legacy item without the new fields reads as a plain task', async () => {
  const w = await world();
  const session = await reportSession(w);
  const bug = await w.manager.createReportedBug(session.id, report());
  const task = await w.manager.createReportedTask(session.id, taskDraft({ relatedBugId: bug.id }));
  await collections.planItemsDb.insert({
    id: `legacy-${w.project.id}`, projectId: w.project.id, title: 'Legacy', description: '', status: 'pending', order: 99,
    taskIds: [], milestoneId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await w.exitAll();
  const { FileDatabase } = await import('../src/db/FileDatabase.ts');
  const reloaded = (await new FileDatabase<PlanItemRecord>(path.join(process.env.AGENT_VISUAL_OS_DATA_DIR!, 'plan-items.json')).find((item) => item.projectId === w.project.id)).map(planItemService.readPlanItem);
  const stored = reloaded.find((item) => item.id === task.id)!;
  assert.deepEqual(stored.relatedBug, { planItemId: bug.id, number: 'B.001', title: 'Crash on save' });
  assert.equal(stored.reportSessionNumber, session.planningSessionNumber);
  const legacy = reloaded.find((item) => item.id === `legacy-${w.project.id}`)!;
  assert.equal(legacy.type, 'task');
  assert.equal('relatedBug' in legacy, false);
  assert.equal(legacy.reportSessionNumber, undefined);
});

test('I26 I27 I31 the report session has exactly the seven MCP tools and a planning or coding session gets no task tools of this server', async () => {
  const w = await world();
  const session = await reportSession(w);
  const start = w.terminal.starts[0]!;
  assert.deepEqual(start.mcpServers?.[0]?.tools, REPORT_TOOLS);
  assert.deepEqual(start.disallowedTools, planModule.PLAN_DISALLOWED_TOOLS, 'shell and file-editing tools stay denied');
  assert.equal(start.readOnly, true);
  await w.manager.createReportedTask(session.id, taskDraft());
  assert.ok((await w.manager.listBugReportTasks(session.id)).some((item) => item.type === 'task'), 'list_tasks lists the task');
  const coding = await w.manager.startTask({ projectId: w.project.id, description: 'Code', executorId: 'test-claude-cli' });
  assert.ok(!w.terminal.starts.find((s) => s.taskId === coding.id)!.mcpServers?.some((server) => server.name === bugReportTool.BUG_REPORT_MCP_SERVER_NAME));
  await w.exitAll();
});

test('U21 the prompt names the task tools and the bug-versus-task rules', () => {
  const text = bugReportTool.BUG_REPORT_INSTRUCTIONS;
  for (const name of Object.values(bugReportTool.BUG_REPORT_TOOLS)) assert.match(text, new RegExp(`\`${name}\``));
  assert.match(text, /File every defect as a bug, and use a task only for new capability or improvement/);
  assert.match(text, /say whether you chose a bug or a task and why/);
  assert.match(text, /never turn a defect into a task to avoid reporting it/);
  assert.match(text, /never started automatically/);
  assert.match(text, /read-only: it cannot write or change any project file/);
  assert.doesNotMatch(text, /four bug tools|Its only output is the bugs you file/);
});

test('U22 U23 the relay exposes the task tools with their schemas and routes calls to the task endpoints', async () => {
  const tools = await listMcpTools(bugReportTool.bugReportMcpServer('task-1'));
  assert.deepEqual(tools.map((tool) => tool.name), REPORT_TOOLS);
  const schema = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema as { required?: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
  assert.deepEqual(schema('create_task').required, ['title', 'description']);
  assert.equal('priority' in schema('create_task').properties, false);
  assert.deepEqual(schema('update_task').required, ['id']);
  assert.deepEqual(schema('delete_task').required, ['id']);
  for (const name of ['create_task', 'update_task', 'delete_task']) assert.equal(schema(name).additionalProperties, false);

  const requests: { method: string; url: string; body: string }[] = [];
  const { createServer } = await import('node:http');
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'DELETE') { res.statusCode = 204; res.end(); return; }
      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.end(JSON.stringify({ id: 'item-1', title: 'Add a diagnostics view' }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  try {
    const launch = bugReportTool.bugReportMcpServer('task-1');
    const address = stub.address() as { port: number };
    const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env, AGENT_VISUAL_OS_BUGS_URL: `http://127.0.0.1:${address.port}/api/agent-bugs` }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const call = async (name: string, args: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
      return JSON.parse((await lines.next()).value as string).result.content[0].text as string;
    };
    assert.equal(await call('create_task', { title: 'T', description: 'D', relatedBugId: 'b1' }), 'Filed task item-1: Add a diagnostics view');
    assert.equal(await call('update_task', { id: '../x', title: 'N' }), 'Updated task item-1: Add a diagnostics view');
    assert.equal(await call('delete_task', { id: 'item-1' }), 'Deleted task item-1');
    child.stdin.end();
    child.kill();
  } finally {
    await new Promise((resolve) => stub.close(resolve));
  }
  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ['POST', '/api/agent-bugs/tasks?taskId=task-1'],
    ['PATCH', '/api/agent-bugs/tasks/..%2Fx?taskId=task-1'],
    ['DELETE', '/api/agent-bugs/tasks/item-1?taskId=task-1'],
  ]);
  assert.deepEqual(JSON.parse(requests[0]!.body), { title: 'T', description: 'D', relatedBugId: 'b1' });
});
