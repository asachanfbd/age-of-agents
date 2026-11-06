import assert from 'node:assert/strict';
import { settledExecute } from './helpers/startRun.ts';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import type { CliSessionLookup, TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import { installDocsRetroFixture } from './fixtures/docsRetroFixture.ts';
import { autoAdvanceTerminalSteps, type StepAction } from './helpers/terminalStepFakes.ts';

/**
 * Engine coverage for later rounds (task 5.006): a step running again in the same run continues its
 * latest session and is sent only what's new — the review's issues or the person's comment for the
 * step making the fix, a short note plus the re-run steps' latest rounds for anything else — and falls
 * back to a new session with the full briefing when that session can't be continued. Also covers
 * Request changes going back to the approval step's chosen earlier step. CLI sessions are the
 * scripted fakes from helpers/terminalStepFakes.ts; claude-cli rounds get a session id, so they
 * resume by default.
 */

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');
let collections: typeof import('../src/db/collections.ts');

type Manager = ReturnType<typeof import('../src/worker/workerManager.ts')['createWorkerManager']>;

const STEPS = [
  { id: 'ui', name: 'UI Planning', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Plan the UI, or skip if none.' },
  { id: 'plan', name: 'Test Case Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'List test cases.' },
  { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Implement the task.' },
  { id: 'review', name: 'Code Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Review the diff.', loopBack: { toStepId: 'build', maxRounds: 3 } },
  { id: 'signoff', name: 'Human Code Review', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Write a review brief.', requestChangesToStepId: 'build' },
  { id: 'docs', name: 'Docs & Retro', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Update docs and retro.' },
];

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-round-continuation-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  await installDocsRetroFixture(process.env.AGENT_VISUAL_OS_CATALOG_DIR);

  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workflowService = await import('../src/catalog/workflowService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
  collections = await import('../src/db/collections.ts');

  await workflowService.updateWorkflow('software-development', { name: 'Round Continuation', description: 'Test workflow.', steps: STEPS });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fakeSummarizerTurn(): Promise<ClaudeTurnResult> {
  return {
    sessionId: 'summary-session',
    status: 'done',
    message: 'ok',
    extra: { tldr: 'Done.', requirement: 'req', whatWasDeveloped: 'dev', reviewHighlights: 'None', docsUpdated: 'None', retroUpdates: 'None' },
    raw: { type: 'result' },
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Counts each step's calls, so an action can script a different outcome per round. */
function counted(action: (id: string, call: number, exit: () => void) => unknown): StepAction {
  let calls = 0;
  return (id, exit) => action(id, ++calls, exit);
}

interface Harness {
  manager: Manager;
  starts: TerminalSessionStart[];
  lookups: CliSessionLookup[];
  runId: string;
  itemId: string;
  projectId: string;
  /** Every start of one step, in order. */
  startsFor(stepId: string): Promise<TerminalSessionStart[]>;
  stepIdsInStartOrder(): Promise<string[]>;
  rounds(stepId: string): Promise<import('../src/domain/types.ts').StepRunRecord[]>;
  waitForStatus(status: string): Promise<void>;
  /** With `deferStops`: the Task ids whose stop is held, and a call that lets their sessions exit. */
  heldStops: string[];
  releaseStops(): void;
}

/**
 * Starts a run of the fixture workflow whose steps follow `actions` (ui is skipped and plan/build/
 * signoff/docs complete unless overridden). `sessionExists` stands in for the CLI's saved-session
 * check; every lookup it gets is recorded. `deferStops` holds each stopped session's exit until
 * `releaseStops`, like a real process exiting some time after it is killed.
 */
async function startRun(name: string, actions: (ref: { current?: Manager }) => Record<string, StepAction>, opts: { sessionExists?: (lookup: CliSessionLookup) => boolean; executorId?: string; deferStops?: boolean } = {}): Promise<Harness> {
  const project = await projectService.createProject({ name, position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Do the thing', description: 'A test task.' });
  const ref: { current?: Manager } = {};
  const done = (summary: string): StepAction => counted((id, call) => ref.current!.completeStep(id, { summary: `${summary} round ${call}` }));
  const { host, starts } = autoAdvanceTerminalSteps(ref, {
    ui: (id) => ref.current!.skipStep(id, { reason: 'No UI.' }),
    plan: done('planned'),
    build: done('built'),
    review: counted((id, call) => ref.current!.completeStep(id, { summary: `clean round ${call}`, verdict: 'pass' })),
    signoff: done('brief'),
    docs: done('docs'),
    ...actions(ref),
  });
  const lookups: CliSessionLookup[] = [];
  host.sessionExists = (lookup) => { lookups.push(lookup); return opts.sessionExists?.(lookup) ?? true; };
  const heldStops: string[] = [];
  const stopNow = host.stop.bind(host);
  if (opts.deferStops) host.stop = (taskId) => { heldStops.push(taskId); return true; };
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  ref.current = manager;
  const first = await settledExecute(manager)(item.id, opts.executorId ? { executorId: opts.executorId } : {});
  const runId = first.workflowRunId!;
  const stepOf = async (start: TerminalSessionStart) => (await manager.getTask(start.taskId)).workflowStepId;
  return {
    manager, starts, lookups, runId, itemId: item.id, projectId: project.id, heldStops,
    releaseStops() { for (const taskId of new Set(heldStops.splice(0))) stopNow(taskId); },
    async startsFor(stepId) {
      const matched: TerminalSessionStart[] = [];
      for (const start of starts) if (await stepOf(start) === stepId) matched.push(start);
      return matched;
    },
    async stepIdsInStartOrder() {
      const ids: string[] = [];
      for (const start of starts) ids.push((await stepOf(start))!);
      return ids;
    },
    async rounds(stepId) {
      return (await manager.getWorkflowRunDetail(runId)).steps.find((s) => s.step.id === stepId)!.rounds;
    },
    async waitForStatus(status) {
      await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === status);
    },
  };
}

async function sessionOfRound(h: Harness, stepId: string, round: number): Promise<string | null> {
  const stepRun = (await h.rounds(stepId)).find((r) => r.round === round)!;
  return (await h.manager.getTask(stepRun.taskId!)).sessionId;
}

const BRIEFING_SECTIONS = [/# Task:/, /# Your step:/, /Implement the task\./, /# Earlier stages' outputs/, /# Permissions/, /# How to finish/];

function assertNoBriefing(prompt: string, label: string): void {
  for (const section of BRIEFING_SECTIONS) assert.doesNotMatch(prompt, section, `${label} is not re-briefed (${section})`);
}

const reviewIssuesOnce = (ref: { current?: Manager }) => ({
  review: counted((id, call) => ref.current!.completeStep(id, call === 1
    ? { summary: 'Stale deep link re-opens the campaign.', verdict: 'issues' }
    : { summary: `clean round ${call}`, verdict: 'pass' })),
});

// ---- Part 1: each round type continues the step's latest session ----

test('a loop continues both sessions: Development gets only the review\'s issues, Code Review gets the note and Development\'s latest summary', async () => {
  const h = await startRun('Loop Resumes', reviewIssuesOnce);
  await h.waitForStatus('awaiting-approval');

  const [build1, build2] = await h.startsFor('build');
  assert.equal(build1!.resume, false, 'round 1 always starts a new session');
  assert.match(build1!.prompt, /# Task: Do the thing/);
  assert.equal(build2!.resume, true);
  assert.equal(build2!.sessionId, await sessionOfRound(h, 'build', 1), 'Development round 2 continues round 1\'s session');
  for (const key of ['kind', 'bin', 'env', 'cwd', 'autonomy', 'readOnly', 'disallowedTools', 'systemPrompt'] as const) assert.deepEqual(build2![key], build1![key], `later round keeps ${key}`);
  assert.deepEqual(build2!.mcpServers?.map(({ name, tools }) => ({ name, tools })), build1!.mcpServers?.map(({ name, tools }) => ({ name, tools })));
  assert.equal(await sessionOfRound(h, 'build', 2), build2!.sessionId, 'the new round records the continued session');
  assert.match(build2!.prompt, /^Code Review round 1 found issues\. Fix every point it raised/);
  assert.match(build2!.prompt, /Stale deep link re-opens the campaign\./);
  assertNoBriefing(build2!.prompt, 'the fix round');

  const [review1, review2] = await h.startsFor('review');
  assert.equal(review2!.resume, true);
  assert.equal(review2!.sessionId, await sessionOfRound(h, 'review', 1), 'Code Review round 2 continues round 1\'s session');
  assert.match(review2!.prompt, /^Development has addressed your previous review\. Re-review the current changes and call `complete_step` with a new `verdict`/);
  assert.match(review2!.prompt, /## Development \(latest round\)\n\nSummary: built round 2/);
  assert.doesNotMatch(review2!.prompt, /built round 1/, 'only the fix step\'s latest round');
  assert.doesNotMatch(review2!.prompt, /planned round 1/, 'steps that did not run again are left out');
  for (const section of BRIEFING_SECTIONS.filter((s) => s.source !== 'Implement the task\\.')) assert.doesNotMatch(review2!.prompt, section);

  // Tools and permissions are the same as round 1.
  assert.deepEqual(review2!.disallowedTools, review1!.disallowedTools);
  assert.equal(review2!.readOnly, true);
  assert.equal(build2!.disallowedTools, undefined);
  assert.deepEqual(build2!.mcpServers?.map((s) => s.name), ['agent_visual_os_step', 'agent_visual_os_tests']);

  assert.deepEqual((await h.rounds('build')).map((r) => r.round), [1, 2]);
  assert.deepEqual((await h.rounds('review')).map((r) => r.verdict), ['issues', 'pass']);
  const context = await collections.taskContextsDb.get((await h.rounds('build'))[1]!.taskId!);
  assert.equal(context?.turns[0]?.content, build2!.prompt, 'the continued message is the round\'s recorded prompt');

  const [signoff] = await h.startsFor('signoff');
  assert.equal(signoff!.resume, false);
  assert.equal(signoff!.prompt.split('## Code Review').length - 1, 1, 'a step after the loop lists the review stage once');
  await h.manager.stopWorkflowRun(h.runId);
});

test('a continued review still has to give a verdict', async () => {
  let refused: Error | undefined;
  const h = await startRun('Resumed Verdict', (ref) => ({
    review: counted(async (id, call) => {
      if (call === 1) return ref.current!.completeStep(id, { summary: 'issue', verdict: 'issues' });
      refused = await ref.current!.completeStep(id, { summary: 'no verdict' }).then(() => undefined, (error: Error) => error);
      return ref.current!.completeStep(id, { summary: 'fine', verdict: 'pass' });
    }),
  }));
  await h.waitForStatus('awaiting-approval');
  assert.equal((await h.startsFor('review'))[1]!.resume, true);
  assert.match(refused?.message ?? '', /verdict/);
  await h.manager.stopWorkflowRun(h.runId);
});

test('each round continues the step\'s latest round, and "run another round" continues too, within the loop budget', async () => {
  const h = await startRun('Latest Round', (ref) => ({
    review: counted((id, call) => ref.current!.completeStep(id, { summary: `issue list ${call}`, verdict: 'issues' })),
  }));
  await h.waitForStatus('needs-attention');
  assert.equal((await h.rounds('review')).length, 3, 'the budget still stops the loop at maxRounds');
  assert.match((await h.manager.getWorkflowRunDetail(h.runId)).run.attentionReason ?? '', /still found issues after 3 round\(s\)/);

  const buildStarts = await h.startsFor('build');
  assert.equal(buildStarts.length, 3);
  assert.match(buildStarts[2]!.prompt, /issue list 2/);
  assert.doesNotMatch(buildStarts[2]!.prompt, /issue list 1/, 'only the latest review\'s issues');

  // Tell round 3's session apart from round 1's: the override must continue the latest.
  const build3 = (await h.rounds('build'))[2]!;
  await collections.tasksDb.update(build3.taskId!, { sessionId: 'build-round-3-session' });
  await h.manager.decideWorkflowRunLoop(h.runId, 'another-round', 'Look closer.');
  await h.waitForStatus('needs-attention');

  const build4 = (await h.startsFor('build'))[3]!;
  assert.equal(build4.resume, true);
  assert.equal(build4.sessionId, 'build-round-3-session');
  assert.match(build4.prompt, /^Code Review round 3 found issues\./);
  assert.match(build4.prompt, /issue list 3/);
  assert.match(build4.prompt, /Human override: run another review round\. Look closer\./);
  assertNoBriefing(build4.prompt, 'the override round');
  const review4 = (await h.startsFor('review'))[3]!;
  assert.equal(review4.resume, true);
  assert.equal(review4.sessionId, await sessionOfRound(h, 'review', 3));
  assert.equal((await h.rounds('review')).length, 4, 'the override allows exactly one more round');
  await h.manager.stopWorkflowRun(h.runId);
});

test('a step between the fix step and its review continues its session with the note', async () => {
  await workflowService.createWorkflow({
    id: 'with-lint', name: 'With Lint', description: 'Build, lint, review.',
    steps: [
      { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Implement the task.' },
      { id: 'lint', name: 'Lint', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Lint it.' },
      { id: 'review', name: 'Code Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Review.', loopBack: { toStepId: 'build', maxRounds: 2 } },
    ],
  });
  const project = await projectService.createProject({ name: 'Between Steps', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Lint task', description: 'x' });
  const ref: { current?: Manager } = {};
  const { host, starts } = autoAdvanceTerminalSteps(ref, {
    build: counted((id, call) => ref.current!.completeStep(id, { summary: `built ${call}` })),
    lint: counted((id, call) => ref.current!.completeStep(id, { summary: `linted ${call}` })),
    ...reviewIssuesOnce(ref),
  });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  ref.current = manager;
  const first = await settledExecute(manager)(item.id, { workflowId: 'with-lint' });
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');
  const lintStarts = [];
  for (const start of starts) if ((await manager.getTask(start.taskId)).workflowStepId === 'lint') lintStarts.push(start);
  assert.equal(lintStarts[1]!.resume, true);
  assert.match(lintStarts[1]!.prompt, /^Since your previous round, these steps have new results: Development, Code Review\. Redo this step against the current changes/);
  assert.match(lintStarts[1]!.prompt, /Summary: built 2/);
  const reviewStart = starts.at(-1)!;
  assert.match(reviewStart.prompt, /^Development, Lint have addressed your previous review/);
  assert.equal((await manager.getWorkflowRunDetail(first.workflowRunId!)).run.status, 'completed');
});

// ---- Fallback: a new session with the full briefing plus the new input ----

/** Rewrites the Task of `stepId`'s round `round` in the same run as `taskId` — how a test makes an earlier session unresumable. */
async function patchRoundTask(taskId: string, stepId: string, round: number, patch: Partial<import('../src/domain/types.ts').TaskRecord>): Promise<void> {
  const runId = (await collections.tasksDb.get(taskId))!.workflowRunId!;
  const [stepRun] = await collections.stepRunsDb.find((s) => s.runId === runId && s.stepId === stepId && s.round === round);
  // Wait for that round's session exit to settle, since settling records its session id again.
  await waitUntil(async () => (await collections.tasksDb.get(stepRun!.taskId!))!.status !== 'developing');
  await collections.tasksDb.update(stepRun!.taskId!, patch);
}

test('fallback: with no recorded session the fix round starts a new session with the full briefing plus the issues, and the run completes', async () => {
  const h = await startRun('Fallback No Session', (ref) => ({
    review: counted(async (id, call) => {
      if (call === 1) await patchRoundTask(id, 'build', 1, { sessionId: null });
      return ref.current!.completeStep(id, call === 1 ? { summary: 'Stale deep link re-opens the campaign.', verdict: 'issues' } : { summary: 'clean', verdict: 'pass' });
    }),
  }));
  await h.waitForStatus('awaiting-approval');
  const build2 = (await h.startsFor('build'))[1]!;
  assert.equal(build2.resume, false);
  assert.ok(build2.sessionId, 'a new session id');
  assert.notEqual(build2.sessionId, (await h.startsFor('build'))[0]!.sessionId);
  assert.match(build2.prompt, /# Task: Do the thing/);
  assert.match(build2.prompt, /# Your step: Development\n\nImplement the task\.\n\nCode Review round 1 found issues\. Fix every point it raised/);
  assert.match(build2.prompt, /Stale deep link re-opens the campaign\./);
  assert.match(build2.prompt, /# How to finish/);
  assert.equal((await h.startsFor('review'))[1]!.resume, true, 'the review\'s own session is still continued');

  await h.manager.approveWorkflowRun(h.runId);
  await waitUntil(async () => (await planItemService.getPlanItem(h.itemId)).status === 'done');
  assert.equal((await h.manager.getWorkflowRunDetail(h.runId)).run.status, 'completed');
});

test('fallback: a review whose earlier round ran on another executor starts fresh with the briefing, the note and Development\'s latest summary, then gives its verdict', async () => {
  const h = await startRun('Fallback Executor', (ref) => ({
    build: counted(async (id, call) => {
      if (call === 2) await patchRoundTask(id, 'review', 1, { executorId: 'test-claude-cli-alt' });
      return ref.current!.completeStep(id, { summary: `built round ${call}` });
    }),
    ...reviewIssuesOnce(ref),
  }));
  await h.waitForStatus('awaiting-approval');
  const review2 = (await h.startsFor('review'))[1]!;
  assert.equal(review2.resume, false);
  assert.match(review2.prompt, /# Your step: Code Review\n\nReview the diff\.\n\nDevelopment has addressed your previous review\./);
  assert.match(review2.prompt, /Summary: built round 2/);
  assert.match(review2.prompt, /`complete_step` MUST also include `verdict`/);
  assert.equal((await h.rounds('review'))[1]!.verdict, 'pass');
  await h.manager.stopWorkflowRun(h.runId);
});

test('fallback: when the CLI no longer has the saved session every later round starts fresh, and the run completes', async () => {
  const h = await startRun('Fallback Missing Session', reviewIssuesOnce, { sessionExists: () => false });
  await h.waitForStatus('awaiting-approval');
  const [build1, build2] = await h.startsFor('build');
  const [review1, review2] = await h.startsFor('review');
  assert.equal(build2!.resume, false);
  assert.equal(review2!.resume, false);
  assert.match(build2!.prompt, /# Task: Do the thing[\s\S]*Stale deep link re-opens the campaign\./);
  assert.deepEqual(h.lookups.map((l) => [l.kind, l.sessionId]), [
    ['claude-cli', build1!.sessionId],
    ['claude-cli', review1!.sessionId],
  ], 'only later rounds ask whether the earlier session still exists');
  await h.manager.approveWorkflowRun(h.runId);
  await waitUntil(async () => (await planItemService.getPlanItem(h.itemId)).status === 'done');
});

test('fallback: a codex step that never reported a session id starts fresh and the run still moves on', async () => {
  const h = await startRun('Fallback Codex', reviewIssuesOnce, { executorId: 'test-codex-cli' });
  await h.waitForStatus('awaiting-approval');
  const build2 = (await h.startsFor('build'))[1]!;
  assert.equal(build2.kind, 'codex-cli');
  assert.equal(build2.resume, false);
  assert.match(build2.prompt, /# Task: Do the thing[\s\S]*Code Review round 1 found issues/);
  assert.equal(h.lookups.length, 0, 'with no session id there is nothing to look up');
  await h.manager.stopWorkflowRun(h.runId);
});

// ---- Part 2: Request changes goes back to the chosen step ----

test('Request changes on Human Code Review continues Development with the comment, then Code Review, then waits for approval again', async () => {
  const h = await startRun('Request Changes Routed', () => ({}));
  await h.waitForStatus('awaiting-approval');
  const startedBefore = (await h.stepIdsInStartOrder()).length;

  await h.manager.requestChangesWorkflowRun(h.runId, 'Use the new wording.');
  await waitUntil(async () => (await h.rounds('signoff')).length === 2);
  await h.waitForStatus('awaiting-approval');

  const signoffRounds = await h.rounds('signoff');
  assert.equal(signoffRounds[0]!.status, 'changes-requested');
  assert.deepEqual([signoffRounds[0]!.approval?.decision, signoffRounds[0]!.approval?.comment], ['changes-requested', 'Use the new wording.']);
  assert.deepEqual((await h.stepIdsInStartOrder()).slice(startedBefore), ['build', 'review', 'signoff']);

  const [build1, build2] = await h.startsFor('build');
  assert.equal(build2!.resume, true);
  assert.equal(build2!.sessionId, build1!.sessionId);
  assert.match(build2!.prompt, /^The human reviewer requested changes: Use the new wording\./);
  assert.doesNotMatch(build2!.prompt, /clean round 1/, 'no earlier review in the message');
  assertNoBriefing(build2!.prompt, 'the routed round');

  const review2 = (await h.startsFor('review'))[1]!;
  assert.equal(review2.resume, true);
  assert.match(review2.prompt, /^Development has addressed your previous review[\s\S]*Summary: built round 2/);

  const signoff2 = (await h.startsFor('signoff'))[1]!;
  assert.equal(signoff2.resume, true);
  assert.match(signoff2.prompt, /^Since your previous round, these steps have new results: Development, Code Review\./);

  const detail = await h.manager.getWorkflowRunDetail(h.runId);
  assert.equal(detail.run.currentStepId, 'signoff');
  assert.equal((await h.rounds('docs')).length, 0);
  const openWorkflowNotifications = (await notificationService.listNotifications({ projectId: h.projectId, resolved: false })).filter((n) => n.kind.startsWith('workflow.'));
  assert.equal(openWorkflowNotifications.length, 1);

  await h.manager.approveWorkflowRun(h.runId);
  await waitUntil(async () => (await planItemService.getPlanItem(h.itemId)).status === 'done');
  assert.equal((await h.manager.getWorkflowRunDetail(h.runId)).run.status, 'completed');
});

test('with a request-changes target but no earlier session, the fresh round still carries the comment', async () => {
  const h = await startRun('Routed Fallback', () => ({}));
  await h.waitForStatus('awaiting-approval');
  await collections.tasksDb.update((await h.rounds('build'))[0]!.taskId!, { sessionId: null });
  await h.manager.requestChangesWorkflowRun(h.runId, 'Use the new wording.');
  await waitUntil(async () => (await h.rounds('signoff')).length === 2);
  await h.waitForStatus('awaiting-approval');
  const build2 = (await h.startsFor('build'))[1]!;
  assert.equal(build2.resume, false);
  assert.match(build2.prompt, /# Task: Do the thing[\s\S]*The human reviewer requested changes: Use the new wording\./);
  await h.manager.stopWorkflowRun(h.runId);
});

test('after going back, a review that finds issues loops through Development again before approval', async () => {
  const h = await startRun('Routed Then Loop', (ref) => ({
    review: counted((id, call) => ref.current!.completeStep(id, call === 2 ? { summary: 'Missed a test.', verdict: 'issues' } : { summary: `clean ${call}`, verdict: 'pass' })),
  }));
  await h.waitForStatus('awaiting-approval');
  await h.manager.requestChangesWorkflowRun(h.runId, 'Rename it.');
  await waitUntil(async () => (await h.rounds('signoff')).length === 2);
  await h.waitForStatus('awaiting-approval');
  const buildStarts = await h.startsFor('build');
  assert.equal(buildStarts.length, 3);
  assert.match(buildStarts[1]!.prompt, /Rename it\./);
  assert.match(buildStarts[2]!.prompt, /^Code Review round 2 found issues[\s\S]*Missed a test\./);
  assert.equal(buildStarts[2]!.sessionId, buildStarts[1]!.sessionId);
  assert.deepEqual((await h.rounds('review')).map((r) => r.verdict), ['pass', 'issues', 'pass']);
  await h.manager.stopWorkflowRun(h.runId);
});

test('the loop budget counts every review round in the run, including ones after going back', async () => {
  const h = await startRun('Routed Budget', (ref) => ({
    review: counted((id, call) => ref.current!.completeStep(id, call === 2 ? { summary: 'ok', verdict: 'pass' } : { summary: `issues ${call}`, verdict: 'issues' })),
  }));
  await h.waitForStatus('awaiting-approval');
  await h.manager.requestChangesWorkflowRun(h.runId, 'One more thing.');
  await h.waitForStatus('needs-attention');
  assert.equal((await h.rounds('review')).length, 3);
  assert.equal((await h.rounds('build')).length, 3, 'no further Development round once the budget is used');
  assert.match((await h.manager.getWorkflowRunDetail(h.runId)).run.attentionReason ?? '', /after 3 round\(s\)/);
  await h.manager.stopWorkflowRun(h.runId);
});

test('an approval step without the setting re-runs itself, continuing its own session with the comment', async () => {
  const h = await startRun('Request Changes Unset', (ref) => ({
    ui: counted((id, call) => ref.current!.completeStep(id, { summary: `mockup ${call}` })),
  }));
  await h.waitForStatus('awaiting-approval');
  assert.equal((await h.manager.getWorkflowRunDetail(h.runId)).run.currentStepId, 'ui');
  await h.manager.requestChangesWorkflowRun(h.runId, 'Bigger buttons.');
  await waitUntil(async () => (await h.rounds('ui')).length === 2);
  await h.waitForStatus('awaiting-approval');
  assert.deepEqual(await h.stepIdsInStartOrder(), ['ui', 'ui'], 'no other step starts');
  const [ui1, ui2] = await h.startsFor('ui');
  assert.equal(ui2!.resume, true);
  assert.equal(ui2!.sessionId, ui1!.sessionId);
  assert.match(ui2!.prompt, /^The human reviewer requested changes: Bigger buttons\./);
  assert.deepEqual((await h.rounds('ui')).map((r) => r.status), ['changes-requested', 'done']);
  assert.equal((await h.manager.getWorkflowRunDetail(h.runId)).run.currentStepId, 'ui');
  await h.manager.stopWorkflowRun(h.runId);
});

test('Request changes follows the run\'s frozen snapshot', async () => {
  const h = await startRun('Snapshot Target', (ref) => ({ build: counted((id, call) => (call === 1 ? ref.current!.completeStep(id, { summary: 'built' }) : undefined)) }));
  await h.waitForStatus('awaiting-approval');
  const workflow = (await workflowService.getWorkflow('software-development'))!;
  await workflowService.updateWorkflow('software-development', { steps: workflow.steps.map(({ requestChangesToStepId: _unset, ...step }) => step) });
  try {
    await h.manager.requestChangesWorkflowRun(h.runId, 'Fix it.');
    await waitUntil(async () => (await h.rounds('build')).length === 2);
    assert.equal((await h.manager.getWorkflowRunDetail(h.runId)).run.currentStepId, 'build', 'the Catalog edit does not change the running run');
  } finally {
    await workflowService.updateWorkflow('software-development', { steps: STEPS });
  }
  await h.manager.stopWorkflowRun(h.runId);
});

test('a snapshot target that is not an earlier step re-runs the approval step itself', async () => {
  const h = await startRun('Invalid Snapshot Target', () => ({}));
  await h.waitForStatus('awaiting-approval');
  const run = (await collections.workflowRunsDb.get(h.runId))!;
  await collections.workflowRunsDb.update(h.runId, {
    workflowSnapshot: { ...run.workflowSnapshot, steps: run.workflowSnapshot.steps.map((s) => (s.id === 'signoff' ? { ...s, requestChangesToStepId: 'docs' } : s)) },
  });
  await h.manager.requestChangesWorkflowRun(h.runId, 'Again.');
  await waitUntil(async () => (await h.rounds('signoff')).length === 2);
  await h.waitForStatus('awaiting-approval');
  assert.equal((await h.rounds('build')).length, 1, 'a later step is never a target');
  await h.manager.stopWorkflowRun(h.runId);
});

test('two Request changes clicks at once start exactly one Development round', async () => {
  const h = await startRun('Double Request Changes', (ref) => ({ build: counted((id, call) => (call === 1 ? ref.current!.completeStep(id, { summary: 'built' }) : undefined)) }));
  await h.waitForStatus('awaiting-approval');
  const results = await Promise.allSettled([
    h.manager.requestChangesWorkflowRun(h.runId, 'First.'),
    h.manager.requestChangesWorkflowRun(h.runId, 'Second.'),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await h.rounds('build')).length, 2);
  await h.manager.stopWorkflowRun(h.runId);
});

const RETRY_PROMPT = 'Your previous attempt at this step was interrupted or failed before it finished. Continue.';

test('Retry after a routed round fails continues that step\'s session with the retry message', async () => {
  const h = await startRun('Retry Routed', (ref) => ({
    build: counted((id, call, exit) => (call === 2 ? exit() : ref.current!.completeStep(id, { summary: `built ${call}` }))),
  }));
  await h.waitForStatus('awaiting-approval');
  await h.manager.requestChangesWorkflowRun(h.runId, 'Change it.');
  await h.waitForStatus('needs-attention');
  await h.manager.retryWorkflowStep(h.runId);
  await waitUntil(async () => (await h.rounds('build')).length === 3);
  const [, build2, build3] = await h.startsFor('build');
  assert.equal(build3!.resume, true);
  assert.equal(build3!.sessionId, build2!.sessionId);
  assert.equal(build3!.prompt, RETRY_PROMPT);
  assertNoBriefing(build3!.prompt, 'the retried round');
  for (const key of ['kind', 'bin', 'env', 'cwd', 'autonomy', 'readOnly', 'disallowedTools', 'systemPrompt'] as const) assert.deepEqual(build3![key], build2![key], `retry keeps ${key}`);
  await h.manager.stopWorkflowRun(h.runId);
});

test('Retry while the step\'s question is pending stops that session quietly, continues it once, and the run stays running', async () => {
  const h = await startRun('Retry Question', () => ({ plan: () => undefined }), { deferStops: true });
  await waitUntil(async () => (await h.startsFor('plan')).length === 1);
  const plan1 = (await h.startsFor('plan'))[0]!;
  await h.manager.handleTerminalHook(plan1.taskId, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Which database?' });
  await h.waitForStatus('needs-attention');

  const retried = h.manager.retryWorkflowStep(h.runId);
  await waitUntil(async () => h.heldStops.includes(plan1.taskId));
  assert.equal((await h.rounds('plan'))[0]!.status, 'stopped', 'the old round is settled before its session exits');
  h.releaseStops();
  await retried;

  const [, plan2] = await h.startsFor('plan');
  assert.equal((await h.startsFor('plan')).length, 2, 'exactly one new start');
  assert.equal(plan2!.resume, true);
  assert.equal(plan2!.sessionId, plan1.sessionId);
  assert.equal(plan2!.prompt, RETRY_PROMPT);
  await waitUntil(async () => (await h.manager.getTask(plan1.taskId)).status !== 'developing');
  const detail = await h.manager.getWorkflowRunDetail(h.runId);
  assert.equal(detail.run.status, 'running');
  assert.doesNotMatch(detail.run.attentionReason ?? '', /ended without completing/, 'the old session\'s exit does not flag the run');
  assert.deepEqual((await h.rounds('plan')).map((r) => r.status), ['stopped', 'running']);
  h.releaseStops();
  await h.manager.stopWorkflowRun(h.runId);
  h.releaseStops();
});

test('Retry after a loop runs out of rounds starts a fresh review round with the full briefing', async () => {
  const h = await startRun('Retry Loop Exhausted', (ref) => ({
    review: counted((id, call) => ref.current!.completeStep(id, call <= 3 ? { summary: `issues ${call}`, verdict: 'issues' } : { summary: 'clean', verdict: 'pass' })),
  }));
  await h.waitForStatus('needs-attention');
  assert.equal((await h.rounds('review')).at(-1)!.status, 'done');
  await h.manager.retryWorkflowStep(h.runId);
  await waitUntil(async () => (await h.rounds('review')).length === 4);
  const review4 = (await h.startsFor('review'))[3]!;
  assert.equal(review4.resume, false);
  assert.match(review4.prompt, /# Task: Do the thing/);
  assert.doesNotMatch(review4.prompt, /previous attempt at this step was interrupted/);
  await h.manager.stopWorkflowRun(h.runId);
});

test('Retry when the CLI no longer has the failed round\'s session starts fresh with the full briefing', async () => {
  let sessionGone = false;
  const h = await startRun('Retry Session Gone', (ref) => ({
    build: counted((id, call, exit) => (call === 2 ? exit() : ref.current!.completeStep(id, { summary: `built ${call}` }))),
  }), { sessionExists: () => !sessionGone });
  await h.waitForStatus('awaiting-approval');
  await h.manager.requestChangesWorkflowRun(h.runId, 'Change it.');
  await h.waitForStatus('needs-attention');
  sessionGone = true;
  await h.manager.retryWorkflowStep(h.runId);
  await waitUntil(async () => (await h.rounds('build')).length === 3);
  const [, build2, build3] = await h.startsFor('build');
  assert.equal(build3!.resume, false);
  assert.notEqual(build3!.sessionId, build2!.sessionId);
  assert.match(build3!.prompt, /# Task: Do the thing/);
  assert.doesNotMatch(build3!.prompt, /previous attempt at this step was interrupted/);
  assert.doesNotMatch(build3!.prompt, /Change it\.\n\nAddress them/, 'a retry is not a request for changes');
  await h.manager.stopWorkflowRun(h.runId);
});

test('Retry when the failed round ran on another executor starts fresh on the configured executor', async () => {
  const h = await startRun('Retry Executor Changed', (ref) => ({
    build: counted((id, call, exit) => (call === 2 ? exit() : ref.current!.completeStep(id, { summary: `built ${call}` }))),
  }));
  await h.waitForStatus('awaiting-approval');
  await h.manager.requestChangesWorkflowRun(h.runId, 'Change it.');
  await h.waitForStatus('needs-attention');
  await patchRoundTask((await h.startsFor('build'))[1]!.taskId, 'build', 2, { executorId: 'test-claude-cli-alt' });
  await h.manager.retryWorkflowStep(h.runId);
  await waitUntil(async () => (await h.rounds('build')).length === 3);
  const [build1, , build3] = await h.startsFor('build');
  assert.equal(build3!.resume, false);
  assert.match(build3!.prompt, /# Task: Do the thing/);
  assert.equal((await h.manager.getTask(build3!.taskId)).executorId, (await h.manager.getTask(build1!.taskId)).executorId);
  await h.manager.stopWorkflowRun(h.runId);
});

test('resuming a run stopped during a routed round still continues its session with "Continue."', async () => {
  const h = await startRun('Stop Routed', (ref) => ({
    build: counted((id, call) => (call === 1 ? ref.current!.completeStep(id, { summary: 'built' }) : undefined)),
  }));
  await h.waitForStatus('awaiting-approval');
  await h.manager.requestChangesWorkflowRun(h.runId, 'Change it.');
  await waitUntil(async () => (await h.rounds('build')).length === 2);
  await h.manager.stopWorkflowRun(h.runId);
  await waitUntil(async () => (await h.manager.getTask((await h.rounds('build'))[1]!.taskId!)).status !== 'developing');
  await waitUntil(async () => (await projectService.getProject(h.projectId)).status === 'idle');
  await h.manager.resumeWorkflowRun(h.runId);
  const [, build2, build3] = await h.startsFor('build');
  assert.equal(build3!.prompt, 'Continue.');
  assert.equal(build3!.resume, true);
  assert.equal(build3!.sessionId, build2!.sessionId);
  for (const key of ['kind', 'bin', 'env', 'cwd', 'autonomy', 'readOnly', 'disallowedTools', 'systemPrompt'] as const) assert.deepEqual(build3![key], build2![key], `stopped-run continuation keeps ${key}`);
  await h.manager.stopWorkflowRun(h.runId);
});

test('a stopped run whose session is gone resumes with the plain briefing, not "Continue."', async () => {
  const h = await startRun('Stop Fallback', () => ({ plan: () => undefined }), { sessionExists: () => false });
  await waitUntil(async () => (await h.startsFor('plan')).length === 1);
  await h.manager.stopWorkflowRun(h.runId);
  await waitUntil(async () => (await h.manager.getTask((await h.rounds('plan'))[0]!.taskId!)).status !== 'developing');
  await waitUntil(async () => (await projectService.getProject(h.projectId)).status === 'idle');
  await h.manager.resumeWorkflowRun(h.runId);
  const plan2 = (await h.startsFor('plan'))[1]!;
  assert.equal(plan2.resume, false);
  assert.match(plan2.prompt, /# Your step: Test Case Planning\n\nList test cases\.\n\n#/);
  assert.doesNotMatch(plan2.prompt, /Continue\./);
  await h.manager.stopWorkflowRun(h.runId);
});
