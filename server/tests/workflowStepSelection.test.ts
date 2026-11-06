import assert from 'node:assert/strict';
import { settledEnqueue, settledExecute } from './helpers/startRun.ts';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import type { StepRunRecord, WorkflowRecord } from '../src/domain/types.ts';
import type { TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import { installDocsRetroFixture } from './fixtures/docsRetroFixture.ts';
import { autoAdvanceTerminalSteps, type StepAction } from './helpers/terminalStepFakes.ts';

/**
 * Coverage for task 5.007: steps unchecked in the Start task dialog. The pure selection rules
 * (`worker/stepSelection.ts`), and the run engine with those steps recorded as skipped at start:
 * never started, never paused on or looped through, and still skipped after a retry, a resume, a
 * loop or Request changes. Also covers a start that waits in the queue first. Sessions are the
 * scripted fakes from helpers/terminalStepFakes.ts; no real CLI or repository.
 */

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');
let collections: typeof import('../src/db/collections.ts');
let stepSelection: typeof import('../src/worker/stepSelection.ts');

type Manager = ReturnType<typeof import('../src/worker/workerManager.ts')['createWorkerManager']>;

const STEPS = [
  { id: 'ui', name: 'UI Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Plan the UI.' },
  { id: 'plan', name: 'Test Case Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'List test cases.' },
  { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Implement the task.' },
  { id: 'review', name: 'Code Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Review the diff.', loopBack: { toStepId: 'build', maxRounds: 3 } },
  { id: 'signoff', name: 'Human Code Review', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Write a review brief.', requestChangesToStepId: 'build' },
  { id: 'docs', name: 'Docs & Retro', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Update docs and retro.' },
];

const WORKFLOW: WorkflowRecord = { id: 'wf', name: 'Software development', description: '', enabled: true, steps: STEPS };
const REASON = 'Skipped when the task was started';

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-step-selection-test-'));
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
  stepSelection = await import('../src/worker/stepSelection.ts');

  await workflowService.updateWorkflow('software-development', { name: 'Step Selection', description: 'Test workflow.', steps: STEPS });
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

function counted(action: (id: string, call: number, exit: () => void) => unknown): StepAction {
  let calls = 0;
  return (id, exit) => action(id, ++calls, exit);
}

interface Harness {
  manager: Manager;
  starts: TerminalSessionStart[];
  projectId: string;
  itemId: string;
  runId: string;
  stepIdsInStartOrder(): Promise<string[]>;
  rounds(stepId: string): Promise<StepRunRecord[]>;
  waitForStatus(status: string): Promise<void>;
  waitForCompletion(): Promise<void>;
}

/** Every step completes (review passes) unless `actions` overrides it. */
function scriptedManager(actions: (ref: { current?: Manager }) => Record<string, StepAction> = () => ({})) {
  const ref: { current?: Manager } = {};
  const done = (summary: string): StepAction => counted((id, call) => ref.current!.completeStep(id, { summary: `${summary} round ${call}` }));
  const { host, starts } = autoAdvanceTerminalSteps(ref, {
    ui: done('ui'),
    plan: done('planned'),
    build: done('built'),
    review: counted((id, call) => ref.current!.completeStep(id, { summary: `clean round ${call}`, verdict: 'pass' })),
    signoff: done('brief'),
    docs: done('docs'),
    ...actions(ref),
  });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  ref.current = manager;
  return { manager, starts };
}

function harness(manager: Manager, starts: TerminalSessionStart[], projectId: string, itemId: string, runId: string): Harness {
  return {
    manager, starts, projectId, itemId, runId,
    async stepIdsInStartOrder() {
      const ids: string[] = [];
      for (const start of starts) ids.push((await manager.getTask(start.taskId)).workflowStepId!);
      return ids;
    },
    async rounds(stepId) {
      return (await manager.getWorkflowRunDetail(runId)).steps.find((s) => s.step.id === stepId)!.rounds;
    },
    async waitForStatus(status) {
      await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === status);
    },
    async waitForCompletion() {
      await waitUntil(async () => (await planItemService.getPlanItem(itemId)).status === 'done');
    },
  };
}

async function newItem(name: string) {
  const project = await projectService.createProject({ name, position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Do the thing', description: 'A test task.' });
  return { project, item };
}

async function startRun(name: string, skippedStepIds: string[], actions?: (ref: { current?: Manager }) => Record<string, StepAction>): Promise<Harness> {
  const { project, item } = await newItem(name);
  const { manager, starts } = scriptedManager(actions);
  const first = await settledExecute(manager)(item.id, { skippedStepIds });
  return harness(manager, starts, project.id, item.id, first.workflowRunId!);
}

function assertSkippedAtStart(rounds: StepRunRecord[], label: string): void {
  assert.equal(rounds.length, 1, `${label} has exactly one round`);
  const [round] = rounds;
  assert.equal(round!.status, 'skipped', label);
  assert.equal(round!.skippedReason, REASON, label);
  assert.equal(round!.summary, `Skipped: ${REASON}`, label);
  assert.equal(round!.taskId, null, `${label} never gets a Task`);
  assert.equal(round!.round, 1, label);
  assert.deepEqual(round!.outputs, [], label);
}

// ---- The selection rules ----

test('stepParentId: a looping review depends on its loop target, an approval step on its Request changes target', () => {
  const [ui, , build, review, signoff] = STEPS;
  assert.equal(stepSelection.stepParentId(STEPS, review!), 'build');
  assert.equal(stepSelection.stepParentId(STEPS, signoff!), 'build');
  assert.equal(stepSelection.stepParentId(STEPS, ui!), null);
  assert.equal(stepSelection.stepParentId(STEPS, build!), null);
});

test('stepParentId ignores a Request changes target on a step that isn\'t an approval step, and a target that isn\'t earlier', () => {
  const steps = [
    { ...STEPS[0]!, id: 'a' },
    { ...STEPS[0]!, id: 'b', requestChangesToStepId: 'a' },
    { ...STEPS[0]!, id: 'c', requiresApproval: true, requestChangesToStepId: 'd' },
    { ...STEPS[0]!, id: 'd', loopBack: { toStepId: 'missing', maxRounds: 1 } },
    { ...STEPS[0]!, id: 'e', requiresApproval: true, requestChangesToStepId: 'e' },
  ];
  for (const step of steps) assert.equal(stepSelection.stepParentId(steps, step), null, step.id);
});

test('resolveSkippedStepIds: nothing skipped, de-duplicated ids in workflow order, and a dependent skipped with its parent', () => {
  assert.deepEqual(stepSelection.resolveSkippedStepIds(WORKFLOW, undefined), []);
  assert.deepEqual(stepSelection.resolveSkippedStepIds(WORKFLOW, []), []);
  assert.deepEqual(stepSelection.resolveSkippedStepIds(WORKFLOW, ['plan', 'ui', 'plan']), ['ui', 'plan']);
  assert.deepEqual(stepSelection.resolveSkippedStepIds(WORKFLOW, ['signoff', 'review', 'build']), ['build', 'review', 'signoff']);
  assert.deepEqual(stepSelection.resolveSkippedStepIds(WORKFLOW, ['review']), ['review'], 'skipping a dependent leaves its parent to run');
});

test('resolveSkippedStepIds refuses unknown ids, skipping every step, and a dependent left running without its parent', () => {
  const refuses = (ids: string[], message: RegExp) => assert.throws(
    () => stepSelection.resolveSkippedStepIds(WORKFLOW, ids),
    (error: Error) => error instanceof stepSelection.InvalidStepSelectionError && message.test(error.message),
  );
  refuses(['nope', 'ui'], /aren't in Software development: nope/);
  refuses(STEPS.map((s) => s.id), /at least one step must run/);
  refuses(['build'], /"Code Review" depends on "Development"/);
  refuses(['build', 'review'], /"Human Code Review" depends on "Development"/);
});

// ---- Starting a run ----

test('AC 4: UI Planning and Test Case Planning unchecked are recorded skipped, get no session, and the run begins at Development', async () => {
  const h = await startRun('Skip Planning', ['plan', 'ui'], () => ({ build: () => undefined }));
  const detail = await h.manager.getWorkflowRunDetail(h.runId);
  assert.deepEqual(detail.run.skippedStepIds, ['ui', 'plan']);
  assert.equal(detail.run.currentStepId, 'build');
  assertSkippedAtStart(await h.rounds('ui'), 'UI Planning');
  assertSkippedAtStart(await h.rounds('plan'), 'Test Case Planning');
  assert.deepEqual(await h.stepIdsInStartOrder(), ['build']);
  const tasks = await collections.tasksDb.find((t) => t.workflowRunId === h.runId);
  assert.deepEqual(tasks.map((t) => t.workflowStepId), ['build'], 'no Task for a skipped step');

  const prompt = h.starts[0]!.prompt;
  assert.match(prompt, /## UI Planning[\s\S]*\(skipped: Skipped when the task was started\)/);
  assert.match(prompt, /## Test Case Planning[\s\S]*\(skipped: Skipped when the task was started\)/);
  assert.equal((await workflowService.getWorkflow('software-development'))!.steps.length, STEPS.length, 'the Catalog workflow is unchanged');
  assert.equal(detail.run.workflowSnapshot.steps.length, STEPS.length, 'the snapshot keeps the skipped steps');
  await h.manager.stopWorkflowRun(h.runId);
});

test('a start without skippedStepIds runs every step, from the first', async () => {
  const h = await startRun('No Skips', [], () => ({ ui: () => undefined }));
  const detail = await h.manager.getWorkflowRunDetail(h.runId);
  assert.equal(detail.run.skippedStepIds, undefined);
  assert.equal(detail.run.currentStepId, 'ui');
  assert.ok(detail.steps.every((s) => s.rounds.every((r) => r.status !== 'skipped')));
  await h.manager.stopWorkflowRun(h.runId);
});

test('an invalid selection is refused before anything starts, leaving the item as it was', async () => {
  const { item } = await newItem('Invalid Selection');
  const { manager, starts } = scriptedManager();
  await assert.rejects(settledExecute(manager)(item.id, { skippedStepIds: STEPS.map((s) => s.id) }), stepSelection.InvalidStepSelectionError);
  await assert.rejects(settledExecute(manager)(item.id, { skippedStepIds: ['build'] }), stepSelection.InvalidStepSelectionError);
  const after = await planItemService.getPlanItem(item.id);
  assert.equal(after.status, 'pending');
  assert.ok(!after.workflowRunId);
  assert.equal(starts.length, 0);
  assert.equal((await collections.workflowRunsDb.find((r) => r.planItemId === item.id)).length, 0);
});

test('when the first running step fails to launch, the run fails, keeping its skipped rounds but no round for the step that never ran', async () => {
  const { item } = await newItem('Launch Failure');
  const failing = workerManagerModule.createWorkerManager({
    runClaudeTurn: fakeSummarizerTurn,
    terminalSessions: {
      start: () => { throw new Error('spawn failed'); },
      attach: () => () => undefined, write() {}, resize() {}, stop: () => true, has: () => false, isAttached: () => false, count: () => 0,
    },
  });
  await assert.rejects(settledExecute(failing)(item.id, { skippedStepIds: ['ui'] }), /spawn failed/);
  const [run] = await collections.workflowRunsDb.find((r) => r.planItemId === item.id);
  assert.equal(run!.status, 'failed');
  const rounds = await collections.stepRunsDb.find((s) => s.runId === run!.id);
  assert.deepEqual(rounds.map((s) => [s.stepId, s.status]), [['ui', 'skipped']], 'only the step skipped at start has a round');
  assert.equal((await planItemService.getPlanItem(item.id)).status, 'failed');
});

// ---- Advancing past skipped steps ----

test('AC 5: an unchecked approval step never pauses the run, which carries on to the next step and completes', async () => {
  const h = await startRun('Skip Approval', ['signoff']);
  await h.waitForCompletion();
  const detail = await h.manager.getWorkflowRunDetail(h.runId);
  assert.equal(detail.run.status, 'completed');
  assert.deepEqual(await h.stepIdsInStartOrder(), ['ui', 'plan', 'build', 'review', 'docs']);
  assertSkippedAtStart(await h.rounds('signoff'), 'Human Code Review');
  const notifications = await notificationService.listNotifications({ projectId: h.projectId });
  assert.ok(!notifications.some((n) => /needs approval/.test(n.title)), 'no approval notification');
  assert.match(detail.run.completionReport ?? '', /dev/);
});

test('an unchecked loop review never runs, so Development goes straight on and gets a single round', async () => {
  const h = await startRun('Skip Review', ['review']);
  await h.waitForStatus('awaiting-approval');
  assert.deepEqual(await h.stepIdsInStartOrder(), ['ui', 'plan', 'build', 'signoff']);
  assert.equal((await h.rounds('build')).length, 1);
  assertSkippedAtStart(await h.rounds('review'), 'Code Review');
  await h.manager.approveWorkflowRun(h.runId);
  await h.waitForCompletion();
  assert.deepEqual(await h.stepIdsInStartOrder(), ['ui', 'plan', 'build', 'signoff', 'docs']);
});

test('with every step after Development skipped, the run goes straight to Complete', async () => {
  const h = await startRun('Skip Tail', ['review', 'signoff', 'docs']);
  await h.waitForCompletion();
  assert.equal((await h.manager.getWorkflowRunDetail(h.runId)).run.status, 'completed');
  assert.deepEqual(await h.stepIdsInStartOrder(), ['ui', 'plan', 'build']);
});

test('the Complete stage summarizes skipped steps with the fixed reason', async () => {
  const inputs: string[] = [];
  const { project, item } = await newItem('Complete Summary');
  const ref: { current?: Manager } = {};
  const { host } = autoAdvanceTerminalSteps(ref, {
    build: (id) => ref.current!.completeStep(id, { summary: 'built' }),
    review: (id) => ref.current!.completeStep(id, { summary: 'clean', verdict: 'pass' }),
  });
  const manager = workerManagerModule.createWorkerManager({
    runClaudeTurn: async (input) => { inputs.push(JSON.stringify(input)); return fakeSummarizerTurn(); },
    terminalSessions: host,
  });
  ref.current = manager;
  const first = await settledExecute(manager)(item.id, { skippedStepIds: ['ui', 'plan', 'signoff', 'docs'] });
  const h = harness(manager, [], project.id, item.id, first.workflowRunId!);
  await h.waitForCompletion();
  assert.ok(inputs.some((i) => i.includes('Skipped: Skipped when the task was started')));
});

test('an agent skip_step followed by a step skipped at start advances past both', async () => {
  const h = await startRun('Agent Skip Then Start Skip', ['plan'], (ref) => ({
    ui: (id) => ref.current!.skipStep(id, { reason: 'No UI.' }),
    build: () => undefined,
  }));
  await waitUntil(async () => h.starts.length === 2);
  assert.deepEqual(await h.stepIdsInStartOrder(), ['ui', 'build']);
  assert.equal((await h.rounds('ui'))[0]!.skippedReason, 'No UI.');
  await h.manager.stopWorkflowRun(h.runId);
});

test('approving a step whose next step was skipped advances past it', async () => {
  const h = await startRun('Approve Past Skip', ['docs']);
  await h.waitForStatus('awaiting-approval');
  await h.manager.approveWorkflowRun(h.runId);
  await h.waitForCompletion();
  assert.deepEqual(await h.stepIdsInStartOrder(), ['ui', 'plan', 'build', 'review', 'signoff']);
});

test('"continue anyway" after an exhausted loop advances past a skipped step', async () => {
  const h = await startRun('Loop Continue Past Skip', ['signoff'], (ref) => ({
    review: (id) => ref.current!.completeStep(id, { summary: 'still broken', verdict: 'issues' }),
    docs: () => undefined,
  }));
  await h.waitForStatus('needs-attention');
  await h.manager.decideWorkflowRunLoop(h.runId, 'continue');
  await waitUntil(async () => (await h.manager.getWorkflowRunDetail(h.runId)).run.currentStepId === 'docs');
  assertSkippedAtStart(await h.rounds('signoff'), 'Human Code Review');
  await h.manager.stopWorkflowRun(h.runId);
});

// ---- AC 6: skipped steps stay skipped ----

test('retrying a failed step never brings a skipped step back', async () => {
  const h = await startRun('Retry Keeps Skips', ['ui', 'plan'], (ref) => ({
    build: counted((id, call, exit) => (call === 1 ? exit() : ref.current!.completeStep(id, { summary: 'built' }))),
    review: () => undefined,
  }));
  await h.waitForStatus('needs-attention');
  await h.manager.retryWorkflowStep(h.runId);
  await waitUntil(async () => h.starts.length === 3);
  assert.deepEqual((await h.rounds('build')).map((r) => r.status), ['failed', 'done']);
  assertSkippedAtStart(await h.rounds('ui'), 'UI Planning');
  assertSkippedAtStart(await h.rounds('plan'), 'Test Case Planning');
  assert.deepEqual(await h.stepIdsInStartOrder(), ['build', 'build', 'review']);
  await h.manager.stopWorkflowRun(h.runId);
});

test('resuming a stopped run only re-runs the stopped step', async () => {
  const h = await startRun('Resume Keeps Skips', ['ui', 'plan'], () => ({ build: () => undefined }));
  await h.manager.stopWorkflowRun(h.runId);
  await waitUntil(async () => (await h.manager.getTask(h.starts[0]!.taskId)).status === 'stopped');
  await h.manager.resumeWorkflowRun(h.runId);
  assert.deepEqual(await h.stepIdsInStartOrder(), ['build', 'build']);
  assertSkippedAtStart(await h.rounds('ui'), 'UI Planning');
  assertSkippedAtStart(await h.rounds('plan'), 'Test Case Planning');
  await h.manager.stopWorkflowRun(h.runId);
});

test('a review loop re-runs Development and the review but never the skipped steps, and still skips the approval after it', async () => {
  const h = await startRun('Loop Keeps Skips', ['ui', 'plan', 'signoff'], (ref) => ({
    review: counted((id, call) => ref.current!.completeStep(id, call === 1 ? { summary: 'issue', verdict: 'issues' } : { summary: 'clean', verdict: 'pass' })),
  }));
  await h.waitForCompletion();
  assert.deepEqual(await h.stepIdsInStartOrder(), ['build', 'review', 'build', 'review', 'docs']);
  for (const stepId of ['ui', 'plan', 'signoff']) assertSkippedAtStart(await h.rounds(stepId), stepId);
});

test('"run another round" on an exhausted loop leaves the skipped steps alone', async () => {
  const h = await startRun('Another Round Keeps Skips', ['ui', 'plan'], (ref) => ({
    review: counted((id, call) => ref.current!.completeStep(id, call <= 3 ? { summary: 'issue', verdict: 'issues' } : { summary: 'clean', verdict: 'pass' })),
    signoff: () => undefined,
  }));
  await h.waitForStatus('needs-attention');
  await h.manager.decideWorkflowRunLoop(h.runId, 'another-round');
  await waitUntil(async () => (await h.manager.getWorkflowRunDetail(h.runId)).run.currentStepId === 'signoff');
  assertSkippedAtStart(await h.rounds('ui'), 'UI Planning');
  assertSkippedAtStart(await h.rounds('plan'), 'Test Case Planning');
  await h.manager.stopWorkflowRun(h.runId);
});

test('Request changes goes back to Development and forward again without re-entering a skipped step', async () => {
  const h = await startRun('Request Changes Keeps Skips', ['plan']);
  await h.waitForStatus('awaiting-approval');
  await h.manager.requestChangesWorkflowRun(h.runId, 'Rename the button.');
  await h.waitForStatus('awaiting-approval');
  assert.deepEqual(await h.stepIdsInStartOrder(), ['ui', 'build', 'review', 'signoff', 'build', 'review', 'signoff']);
  assertSkippedAtStart(await h.rounds('plan'), 'Test Case Planning');
  await h.manager.stopWorkflowRun(h.runId);
});

test('starting over after a stop runs every step again: the old run\'s choice is not carried over', async () => {
  const h = await startRun('Start Over', ['ui', 'plan'], () => ({ build: () => undefined, ui: () => undefined }));
  await h.manager.stopWorkflowRun(h.runId);
  await waitUntil(async () => (await h.manager.getTask(h.starts[0]!.taskId)).status === 'stopped');
  const second = await settledExecute(h.manager)(h.itemId);
  assert.notEqual(second.workflowRunId, h.runId);
  assert.equal(second.workflowStepId, 'ui');
  assert.equal((await h.manager.getWorkflowRunDetail(second.workflowRunId!)).run.skippedStepIds, undefined);
  await h.manager.stopWorkflowRun(second.workflowRunId!);
});

test('a daemon restart never tries to relaunch a skipped round', async () => {
  const h = await startRun('Restart With Skips', ['ui', 'plan'], () => ({ build: () => undefined }));
  const starts: string[] = [];
  const recovery = workerManagerModule.createWorkerManager({
    runClaudeTurn: fakeSummarizerTurn,
    terminalSessions: {
      start: (input) => { starts.push(input.taskId); },
      attach: () => () => undefined, write() {}, resize() {}, stop: () => true, has: () => false, isAttached: () => false, count: () => 0,
    },
  });
  await recovery.resumeInterruptedTasks();
  assert.deepEqual(starts, []);
  assertSkippedAtStart(await h.rounds('ui'), 'UI Planning');
  await recovery.stopWorkflowRun(h.runId);
});

// ---- AC 7: the start queue keeps the choice ----

/** A project whose executor is held by a running item, so the next start queues. */
async function busyProject(name: string) {
  const { project, item: holder } = await newItem(name);
  const { manager, starts } = scriptedManager(() => ({ ui: () => undefined, build: () => undefined }));
  const held = await settledExecute(manager)(holder.id);
  return { project, holder, manager, starts, holderRunId: held.workflowRunId! };
}

test('a queued start stores the whole choice and starts later skipping exactly those steps', async () => {
  const { project, holder, manager, holderRunId } = await busyProject('Queued Start');
  const waiting = await planItemService.createPlanItem({ projectId: project.id, title: 'Queued', description: 'x' });
  const queued = await settledEnqueue(manager)(waiting.id, { workflowId: 'software-development', createBranch: false, skippedStepIds: ['ui', 'plan'] });
  assert.equal(queued.started, false);
  if (queued.started) return;
  assert.deepEqual(queued.entry.skippedStepIds, ['ui', 'plan']);
  assert.equal(queued.entry.workflowId, 'software-development');
  assert.equal(queued.entry.createBranch, false);

  await manager.stopWorkflowRun(holderRunId);
  await manager.completePlanItem(holder.id);
  await waitUntil(async () => Boolean((await planItemService.getPlanItem(waiting.id)).workflowRunId));
  const runId = (await planItemService.getPlanItem(waiting.id)).workflowRunId!;
  const detail = await manager.getWorkflowRunDetail(runId);
  assert.deepEqual(detail.run.skippedStepIds, ['ui', 'plan']);
  assert.equal(detail.run.currentStepId, 'build');
  await manager.stopWorkflowRun(runId);
});

test('a queued start uses the chosen agent, not a stale one saved on the item', async () => {
  const { project, holder, manager, holderRunId } = await busyProject('Queue Ignores Stale Worker');
  const waiting = await planItemService.createPlanItem({ projectId: project.id, title: 'Queued', description: 'x' });
  // Stands in for an old assignment, or any other stale `executorId` already on the item — it must
  // never win over what the Start task dialog actually chose.
  await collections.planItemsDb.update(waiting.id, { executorId: 'test-codex-cli' });
  const queued = await settledEnqueue(manager)(waiting.id, { executorId: 'test-claude-cli' });
  assert.equal(queued.started, false);
  if (queued.started) return;
  assert.equal(queued.entry.executorId, 'test-claude-cli', 'the dialog\'s choice, not the stale saved one');

  await manager.stopWorkflowRun(holderRunId);
  await manager.completePlanItem(holder.id);
  await waitUntil(async () => Boolean((await planItemService.getPlanItem(waiting.id)).workflowRunId));
  const runId = (await planItemService.getPlanItem(waiting.id)).workflowRunId!;
  assert.equal((await manager.getWorkflowRunDetail(runId)).run.executorId, 'test-claude-cli');
  await manager.stopWorkflowRun(runId);
});

test('re-queueing an already-queued item or reordering the queue keeps each entry\'s choice', async () => {
  const { project, manager, holderRunId } = await busyProject('Queue Reorder');
  const a = await planItemService.createPlanItem({ projectId: project.id, title: 'A', description: 'x' });
  const b = await planItemService.createPlanItem({ projectId: project.id, title: 'B', description: 'x' });
  await settledEnqueue(manager)(a.id, { skippedStepIds: ['ui'] });
  await settledEnqueue(manager)(b.id, { skippedStepIds: ['docs'] });
  const again = await settledEnqueue(manager)(a.id, { queueIndex: 1, skippedStepIds: ['plan'] });
  assert.equal(again.started, false);
  const reordered = await manager.reorderPlanItemQueue(project.id, (await manager.listPlanItemQueue(project.id)).map((e) => e.id).reverse());
  assert.deepEqual(reordered.map((e) => [e.planItemId, e.skippedStepIds]), [[a.id, ['ui']], [b.id, ['docs']]]);
  for (const entry of reordered) await manager.removeQueuedPlanItemExecution(entry.id);
  await manager.stopWorkflowRun(holderRunId);
});

test('a legacy queue entry without a choice starts every step, and an entry the workflow no longer accepts is dropped', async () => {
  const { project, holder, manager, holderRunId } = await busyProject('Queue Legacy');
  const bad = await planItemService.createPlanItem({ projectId: project.id, title: 'Bad', description: 'x' });
  const legacy = await planItemService.createPlanItem({ projectId: project.id, title: 'Legacy', description: 'x' });
  const now = new Date().toISOString();
  await collections.planItemQueueDb.insert({ id: randomUUID(), projectId: project.id, planItemId: bad.id, skippedStepIds: STEPS.map((s) => s.id), position: 0, createdAt: now });
  await collections.planItemQueueDb.insert({ id: randomUUID(), projectId: project.id, planItemId: legacy.id, position: 1, createdAt: now });

  await manager.stopWorkflowRun(holderRunId);
  await manager.completePlanItem(holder.id);
  await waitUntil(async () => Boolean((await planItemService.getPlanItem(legacy.id)).workflowRunId));
  assert.ok(!(await planItemService.getPlanItem(bad.id)).workflowRunId, 'the invalid entry was dropped');
  assert.deepEqual(await manager.listPlanItemQueue(project.id), []);
  const runId = (await planItemService.getPlanItem(legacy.id)).workflowRunId!;
  assert.equal((await manager.getWorkflowRunDetail(runId)).run.currentStepId, 'ui');
  await manager.stopWorkflowRun(runId);
});
