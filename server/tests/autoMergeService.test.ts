import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import type { AutoMergeRecord, PlanItemRecord, ProjectRecord, WorkflowRunRecord, WorkflowStep } from '../src/domain/types.ts';
import type { AutoMergeDeps, AutoMergeService } from '../src/projects/autoMergeService.ts';
import type { WorkerEvent } from '../src/worker/workerManager.ts';
import { checksPayload, startPullRequestHarness, waitUntil, type PullRequestHarness } from './helpers/pullRequestHarness.ts';
import type { StepAction } from './helpers/terminalStepFakes.ts';

/**
 * Integration cases of task 10.017 (I1 to I53): the Auto-merge service over a scripted `gh`, real git
 * against a local bare remote, and conflict-resolution runs driven through the real workflow engine
 * with scripted terminal sessions. No task is started for real: completed runs are inserted.
 */

const DEV = 'test-claude-cli';
const OTHER = 'test-claude-cli-alt';
const STEP = 'resolve-conflicts';

let h: PullRequestHarness;
let svc: typeof import('../src/projects/autoMergeService.ts');
let notifications: typeof import('../src/notifications/notificationService.ts');
let actions: typeof import('../src/projects/pullRequestActions.ts');
let events: WorkerEvent[];
let nextNumber = 1000;

before(async () => {
  h = await startPullRequestHarness('auto-merge-');
  svc = await import('../src/projects/autoMergeService.ts');
  notifications = await import('../src/notifications/notificationService.ts');
  actions = await import('../src/projects/pullRequestActions.ts');
});
after(async () => { await h.close(); });

/** Services whose event listeners and timers must not outlive their test: a stale one would act on the next test's tasks. */
const started: (() => void)[] = [];
afterEach(async () => {
  for (const stop of started.splice(0)) stop();
  // Tasks left pending by a test must not be evaluated by the next test's service.
  const pending = await h.collections.planItemsDb.find((item) => item.autoMerge?.enabled === true);
  for (const item of pending) await h.collections.planItemsDb.update(item.id, { autoMerge: { ...item.autoMerge!, enabled: false } });
});
const startService = (service: AutoMergeService) => { started.push(service.start()); };

interface Spies { starts: { executorId: string; title: string }[]; merges: number[]; unavailable: Record<string, string> }

function makeService(overrides: Partial<AutoMergeDeps> = {}): { service: AutoMergeService; spies: Spies } {
  const spies: Spies = { starts: [], merges: [], unavailable: {} };
  events = [];
  const service = svc.createAutoMergeService({
    getProject: h.projectService.getProject,
    readPullRequest: actions.readPullRequest,
    mergePullRequest: async (project, reading) => { spies.merges.push(reading.number); return actions.mergePullRequest(project, reading); },
    startConflictRun: async (projectId, reading, executorId, autoMerge) => {
      spies.starts.push({ executorId, title: autoMerge.title });
      return h.manager.startConflictRun(projectId, reading, executorId, autoMerge);
    },
    activeConflictRun: h.manager.activeConflictRun,
    latestConflictRun: h.manager.latestConflictRun,
    executorUnavailableReason: async (id) => spies.unavailable[id] ?? null,
    onWorkerEvent: h.manager.onWorkerEvent,
    publish: (event) => { events.push(event); },
    runPollMs: 10,
    ...overrides,
  });
  return { service, spies };
}

const step = (id: string, canEditCode: boolean, executorId?: string): WorkflowStep => ({ id, name: id, canEditCode, requiresApproval: false, agentId: 'software-engineer', instructions: '', ...(executorId ? { executorId } : {}) });

interface Task { item: PlanItemRecord; run: WorkflowRunRecord; number: number }

/** A finished task: a plan item and its completed run, with the pull request its Complete step raised (already served by the fake `gh`). */
async function finishedTask(project: ProjectRecord, options: {
  pr?: Record<string, unknown>; steps?: WorkflowStep[]; executorId?: string; prUrl?: string | null; completionReport?: string | null; branch?: string | null; baseBranch?: string | null;
  autoMerge?: Partial<AutoMergeRecord>; runStatus?: WorkflowRunRecord['status']; withPull?: boolean;
} = {}): Promise<Task> {
  nextNumber += 1;
  const number = nextNumber;
  if (options.withPull !== false) {
    await h.publishPullRequest({ number, branch: `feature/task-${number}`, files: { [`task-${number}.txt`]: `work ${number}\n` }, pullRequest: { title: `Task ${number}`, ...options.pr } });
  }
  const now = new Date().toISOString();
  const itemId = randomUUID();
  const runId = randomUUID();
  const run: WorkflowRunRecord = {
    id: runId, projectId: project.id, planItemId: itemId, workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'Software development', description: '', enabled: true, steps: options.steps ?? [step('development', true, DEV)] },
    status: options.runStatus ?? 'completed', currentStepId: null, executorId: options.executorId ?? DEV,
    prUrl: options.prUrl === undefined ? `https://github.com/test/repo/pull/${number}` : options.prUrl,
    completionReport: options.completionReport ?? null, attentionReason: null, loopRoundAllowance: 0,
    ...(options.branch === null ? {} : { branch: options.branch ?? `feature/task-${number}` }),
    ...(options.baseBranch === null ? {} : { baseBranch: options.baseBranch ?? 'main' }),
    createdAt: now, updatedAt: now, completedAt: now,
  };
  await h.collections.workflowRunsDb.insert(run);
  const item = await h.collections.planItemsDb.insert({
    id: itemId, projectId: project.id, title: `Task ${number}`, description: 'work', status: 'done', order: number, taskIds: [], milestoneId: null,
    workflowRunId: runId, createdAt: now, updatedAt: now,
    ...(options.autoMerge ? { autoMerge: { enabled: true, state: 'waiting', reasons: [], warnings: [], prNumber: null, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: now, ...options.autoMerge } } : {}),
  } as PlanItemRecord);
  return { item, run, number };
}

const stateOf = async (task: Task) => (await h.collections.planItemsDb.get(task.item.id))!.autoMerge as AutoMergeRecord;
const mergeCalls = async (number?: number) => (await h.gh.callsTo('pr', 'merge')).filter((args) => number === undefined || args[2] === String(number));
const deleteCalls = async () => (await h.gh.calls()).filter((args) => args.includes('DELETE'));
const taskNotifications = async (task: Task) => (await notifications.listNotifications({ projectId: task.item.projectId })).filter((n) => n.subject.type === 'autoMerge' && n.subject.planItemId === task.item.id);
/** The task's open "needs you" notifications; the `automerge.merged` one is not among them (see `mergedNotifications`). */
const active = async (task: Task) => (await taskNotifications(task)).filter((n) => n.resolvedAt === null && n.kind !== 'automerge.merged');
const mergedNotifications = async (task: Task) => (await taskNotifications(task)).filter((n) => n.kind === 'automerge.merged');
const remoteBranches = async () => git(h.remote, ['branch', '--list']);
const failing = (key: 'read' | 'merge' | 'delete', text: string) => h.gh.patch({ fail: { [key]: text } });
const noFailure = () => h.gh.patch({ fail: {} });
const idleProject = (project: ProjectRecord) => waitUntil(async () => (await h.projectService.getProject(project.id)).status === 'idle', 'the project to go idle');

/** Waits until the conflict run's agent is up, so that stopping it is the same as the person stopping a working run. */
const runUp = (project: ProjectRecord, number: number) =>
  waitUntil(async () => (await h.manager.latestConflictRun(project.id, number))?.status === 'running', `the conflict run for #${number} to be running`);

async function enable(service: AutoMergeService, project: ProjectRecord, task: Task) {
  await service.setEnabled(project.id, task.item.id, true);
  await service.idle();
}

async function conflictingTask(project: ProjectRecord, options: Parameters<typeof finishedTask>[1] = {}): Promise<Task & { file: string }> {
  const task = await finishedTask(project, { ...options, pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', ...options.pr } });
  const file = `task-${task.number}.txt`;
  await git(h.seed, ['pull', '--quiet', 'origin', 'main']);
  await writeFile(path.join(h.seed, file), 'from the base branch\n');
  await git(h.seed, ['add', '.']);
  await git(h.seed, ['commit', '-m', `base change conflicting with ${task.number}`]);
  await git(h.seed, ['push', '--quiet', 'origin', 'main']);
  return { ...task, file };
}

/** The scripted agent: resolves the conflict in the run's worktree and tells the fake provider what the PR will read after the push. */
function resolvingAgent(task: Task & { file: string }, afterPush: Record<string, unknown> = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }): StepAction {
  return async (taskId) => {
    const cwd = h.terminal.starts.find((start) => start.taskId === taskId)!.cwd;
    await git(cwd, ['fetch', '--quiet', 'origin', 'main']);
    await assert.rejects(() => git(cwd, ['merge', 'origin/main']));
    await writeFile(path.join(cwd, task.file), 'resolved: both sides\n');
    await git(cwd, ['add', '.']);
    await git(cwd, ['commit', '--no-edit']);
    const resolved = await git(cwd, ['rev-parse', 'HEAD']);
    await h.gh.setPull(task.number, { headRefOid: resolved, ...afterPush });
    await h.manager.completeStep(taskId, { summary: 'Resolved.' });
  };
}

// ---- Lifecycle and happy paths ----

test('I1 a task with Auto-merge on and a clean PR merges itself with a merge commit, deleting the head branch, and ends Merged with a time', async () => {
  const project = await h.createProject('I1');
  const { service } = makeService();
  const task = await finishedTask(project);
  await h.gh.clearCalls();
  await enable(service, project, task);

  const state = await stateOf(task);
  assert.equal(state.state, 'merged');
  assert.ok(Date.parse(state.mergedAt!));
  assert.equal(state.prNumber, task.number);
  assert.deepEqual(await mergeCalls(), [['pr', 'merge', String(task.number), '--repo', 'test/repo', '--merge']]);
  assert.deepEqual(await deleteCalls(), [['api', '-X', 'DELETE', `repos/test/repo/git/refs/heads/feature/task-${task.number}`]]);
  assert.deepEqual(await active(task), [], 'a plain merge raises no notification');
});

test('I2 turned on while the task is running, nothing is merged until its Complete step has pushed and raised the PR; then one merge', async () => {
  const project = await h.createProject('I2');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { runStatus: 'running', prUrl: null });
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'waiting');
  assert.deepEqual(spies.merges, []);

  await h.collections.workflowRunsDb.update(task.run.id, { status: 'completing' });
  await service.evaluate(task.item.id);
  assert.equal((await stateOf(task)).state, 'waiting', 'still completing');

  const completed = await h.collections.workflowRunsDb.update(task.run.id, { status: 'completed', prUrl: `https://github.com/test/repo/pull/${task.number}` });
  startService(service);
  h.manager.publishEvent({ type: 'workflowRun', run: completed! });
  await waitUntil(async () => (await stateOf(task)).state === 'merged', 'the merge after completion');
  assert.deepEqual(spies.merges, [task.number]);
});

test('I3 turned on after completion with the PR still open, it is evaluated at once', async () => {
  const project = await h.createProject('I3');
  const { service, spies } = makeService();
  const task = await finishedTask(project);
  await service.setEnabled(project.id, task.item.id, true);
  await service.idle();
  assert.equal((await stateOf(task)).state, 'merged');
  assert.deepEqual(spies.merges, [task.number]);
});

test('I5 by default nothing is merged: a finished task with the toggle never switched on is left alone', async () => {
  const project = await h.createProject('I5');
  const { service, spies } = makeService();
  const task = await finishedTask(project);
  await service.evaluatePending();
  await service.idle();
  assert.deepEqual(spies.merges, []);
  assert.equal((await h.collections.planItemsDb.get(task.item.id))!.autoMerge, undefined);
});

test('I4 a run still awaiting its approval step is not merged; it is after approval', async () => {
  const project = await h.createProject('I4');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { runStatus: 'awaiting-approval', prUrl: null });
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'waiting');
  await h.collections.workflowRunsDb.update(task.run.id, { status: 'completed', prUrl: `https://github.com/test/repo/pull/${task.number}` });
  await service.evaluate(task.item.id);
  await service.idle();
  assert.deepEqual(spies.merges, [task.number]);
});

test('I6 only the task\'s own PR is merged: a decoy with the same title on another branch is untouched', async () => {
  const project = await h.createProject('I6');
  const { service, spies } = makeService();
  const decoy = await finishedTask(project, { pr: { title: 'Same title' } });
  const task = await finishedTask(project, { pr: { title: 'Same title' } });
  await enable(service, project, task);
  assert.deepEqual(spies.merges, [task.number]);
  assert.equal((await mergeCalls(decoy.number)).length, 0);
});

// ---- Conflict path ----

test('I7 a conflicting PR is resolved by a run with the Development step\'s agent and merged; the run is titled for this task', async () => {
  const project = await h.createProject('I7');
  const { service, spies } = makeService();
  const task = await conflictingTask(project, { steps: [step('planning', false, OTHER), step('development', true, DEV)], executorId: OTHER });
  h.stepActions[STEP] = resolvingAgent(task);
  await enable(service, project, task);
  await idleProject(project);

  assert.deepEqual(spies.starts, [{ executorId: DEV, title: `Auto-merge conflicts · Task ${task.number}` }]);
  const state = await stateOf(task);
  assert.equal(state.state, 'merged');
  assert.equal(state.runId !== null, true);
  const run = (await h.manager.latestConflictRun(project.id, task.number))!;
  assert.equal(run.prConflict!.autoMergeItemId, task.item.id);
  assert.equal(run.executorId, DEV);
  assert.equal((await h.collections.planItemsDb.get(run.planItemId))!.title, `Auto-merge conflicts · Task ${task.number}`);
  assert.equal((await mergeCalls(task.number)).length, 1, 'the run merged it once; auto-merge did not merge again');
});

for (const [id, name, steps, executorId, expected] of [
  ['I8', 'the first write-capable step\'s agent when the workflow has no Development step', [step('rca', false, OTHER), step('fix', true, DEV)], 'someone-else', DEV],
  ['I9', 'the task\'s primary agent when the steps have none of their own', [step('fix', true)], DEV, DEV],
] as const) {
  test(`${id} the conflict run uses ${name}`, async () => {
    const project = await h.createProject(id);
    const { service, spies } = makeService();
    const task = await conflictingTask(project, { steps: [...steps], executorId });
    h.stepActions[STEP] = () => undefined;
    await service.setEnabled(project.id, task.item.id, true);
    await runUp(project, task.number);
    assert.equal(spies.starts[0]!.executorId, expected);
    // The run is waited on inside the project's turn, so stop it to end the wait.
    await h.manager.stopWorkflowRun((await h.manager.latestConflictRun(project.id, task.number))!.id);
    await service.idle();
  });
}

test('I10 the manual flow still asks the person for an agent', async () => {
  const project = await h.createProject('I10');
  const task = await conflictingTask(project);
  const { ConflictAgentRequiredError } = await import('../src/projects/pullRequestService.ts');
  await assert.rejects(() => h.pullRequests.merge(project.id, task.number), ConflictAgentRequiredError);
});

test('I12 after the resolution the PR reads blocked: the run reports resolved and the task is blocked, then merges once checks pass', async () => {
  const project = await h.createProject('I12');
  const { service } = makeService();
  const task = await conflictingTask(project);
  h.stepActions[STEP] = resolvingAgent(task, { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', ...checksPayload([{ name: 'build', state: 'PENDING', required: true }]) });
  await enable(service, project, task);
  await idleProject(project);
  assert.equal((await stateOf(task)).state, 'blocked');
  assert.deepEqual((await stateOf(task)).reasons, ['Checks are still running: build']);
  assert.equal((await mergeCalls(task.number)).length, 0);

  await h.gh.setPull(task.number, checksPayload([{ name: 'build', state: 'SUCCESS', required: true }]));
  await service.evaluatePending();
  await service.idle();
  assert.equal((await stateOf(task)).state, 'merged');
});

// ---- Blocked and cannot-merge ----

test('I13 failing checks leave the task blocked with the reasons and one notification, and no merge call', async () => {
  const project = await h.createProject('I13');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { pr: { ...checksPayload([{ name: 'build', state: 'FAILURE', required: true }]) } });
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'blocked');
  assert.deepEqual((await stateOf(task)).reasons, ['Checks are failing: build']);
  const raised = await active(task);
  assert.deepEqual(raised.map((n) => n.kind), ['automerge.blocked']);
  assert.equal(raised[0]!.projectId, project.id);
  assert.deepEqual(spies.merges, []);
});

for (const [name, pr] of [
  ['pending checks', checksPayload([{ name: 'build', state: 'PENDING', required: true }])],
  ['changes requested', { reviewDecision: 'CHANGES_REQUESTED' }],
  ['a draft', { isDraft: true }],
  ['base protection', { mergeStateStatus: 'BLOCKED' }],
  ['an unknown merge state', { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }],
] as const) {
  test(`I14 ${name} is never overridden: no merge call, not even with the bypass`, async () => {
    const project = await h.createProject(`I14 ${name}`);
    const { service, spies } = makeService();
    const task = await finishedTask(project, { pr });
    await h.gh.patch({ protectedPulls: [task.number] });
    await enable(service, project, task);
    await service.evaluatePending();
    await service.idle();
    assert.equal((await stateOf(task)).state, 'blocked');
    assert.deepEqual(spies.merges, []);
    assert.equal((await mergeCalls(task.number)).length, 0);
    await h.gh.patch({ protectedPulls: [] });
  });
}

test('I15 when the blocker clears at a later check the task merges by itself and the notification resolves', async () => {
  const project = await h.createProject('I15');
  const { service } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  await enable(service, project, task);
  assert.equal((await active(task)).length, 1);
  await service.evaluatePending();
  await service.idle();
  assert.equal((await active(task)).length, 1, 'repeated looks keep one notification');

  await h.gh.setPull(task.number, { isDraft: false });
  await service.evaluatePending();
  await service.idle();
  assert.equal((await stateOf(task)).state, 'merged');
  assert.deepEqual(await active(task), []);
});

for (const [name, pr, reason] of [
  ['a closed PR', { state: 'CLOSED' }, 'This PR is closed'],
  ['no permission', null, 'Your account can\'t merge in this repository'],
  ['a missing head branch', { headRef: null }, 'The head branch no longer exists'],
] as const) {
  test(`I16 ${name} stops auto-merge with that reason, the toggle stays on, and repeated looks do nothing`, async () => {
    const project = await h.createProject(`I16 ${name}`);
    const { service, spies } = makeService();
    const task = await finishedTask(project, { pr: pr ?? {} });
    if (pr === null) await h.gh.setPull(task.number, {}, { viewerPermission: 'READ' });
    await enable(service, project, task);
    const state = await stateOf(task);
    assert.deepEqual([state.enabled, state.state, state.reasons], [true, 'cannot-merge', [reason]]);
    assert.deepEqual((await active(task)).map((n) => n.kind), ['automerge.failed']);
    await h.gh.clearCalls();
    await service.evaluatePending();
    await service.idle();
    assert.deepEqual(await mergeCalls(), [], 'an automatic look only watches for a merge elsewhere');
    assert.deepEqual(spies.merges, []);
    assert.equal((await stateOf(task)).state, 'cannot-merge');
  });
}

// ---- Provider and agent errors ----

for (const [id, text] of [
  ['I17', 'gh is not installed'],
  ['I18', 'To get started with GitHub CLI, please run:  gh auth login'],
  ['I19', 'gh command failed: Command failed: gh api graphql\nerror connecting to api.github.com'],
] as const) {
  test(`${id} "${text.slice(0, 24)}…" leaves the task waiting on the provider and it recovers at the next look`, async () => {
    const project = await h.createProject(id);
    const { service, spies } = makeService();
    const task = await finishedTask(project);
    await failing('read', text);
    await enable(service, project, task);
    const state = await stateOf(task);
    assert.equal(state.state, 'provider');
    assert.ok(state.reasons.length === 1 && state.reasons[0]!.length > 0);
    assert.deepEqual(spies.merges, []);
    assert.equal(state.enabled, true);

    await noFailure();
    await service.evaluatePending();
    await service.idle();
    assert.equal((await stateOf(task)).state, 'merged');
  });
}

test('I20 a task whose Complete step raised no PR shows "no PR to merge" with that step\'s error', async () => {
  const project = await h.createProject('I20');
  const { service } = makeService();
  const task = await finishedTask(project, { withPull: false, prUrl: null, completionReport: '**TL;DR:** done\n\n## Pull request\nCould not be created automatically: gh: not signed in' });
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'no-pr');
  assert.deepEqual((await stateOf(task)).reasons, ['gh: not signed in']);
  assert.deepEqual((await active(task)).map((n) => n.kind), ['automerge.failed']);
});

test('I21 an agent at its usage limit leaves the task waiting for an agent, and the run starts once it is available', async () => {
  const project = await h.createProject('I21');
  const { service, spies } = makeService();
  const task = await conflictingTask(project);
  spies.unavailable[DEV] = 'The usage limit of "Test Claude CLI" is reached.';
  h.stepActions[STEP] = resolvingAgent(task);
  await enable(service, project, task);
  assert.deepEqual([(await stateOf(task)).state, (await stateOf(task)).reasons], ['agent', ['The usage limit of "Test Claude CLI" is reached.']]);
  assert.deepEqual(spies.starts, []);

  delete spies.unavailable[DEV];
  await service.evaluatePending();
  await service.idle();
  await idleProject(project);
  assert.equal((await stateOf(task)).state, 'merged');
  assert.equal(spies.starts.length, 1);
});

test('I22 an agent removed from the configuration is "agent unavailable" too', async () => {
  const project = await h.createProject('I22');
  const { service, spies } = makeService();
  const task = await conflictingTask(project, { executorId: 'removed-agent', steps: [step('development', true)] });
  await enable(service, project, task);
  const state = await stateOf(task);
  assert.equal(state.state, 'agent');
  assert.match(state.reasons[0]!, /not configured/);
  assert.equal(await h.manager.latestConflictRun(project.id, task.number), null, 'no run was created');
  assert.equal(spies.starts.length, 1, 'the start was attempted once and refused');
});

test('I23 a conflict run that fails leaves the PR unmerged, the task Failed, and a conflict-failed notification', async () => {
  const project = await h.createProject('I23');
  const { service } = makeService();
  const task = await conflictingTask(project);
  h.stepActions[STEP] = resolvingAgent(task, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  await enable(service, project, task);
  await idleProject(project);
  const state = await stateOf(task);
  assert.equal(state.state, 'failed');
  assert.match(state.reasons[0]!, /still conflicts/);
  assert.deepEqual((await active(task)).map((n) => n.kind), ['automerge.conflict_failed']);
  assert.equal((await mergeCalls(task.number)).length, 0);

  await service.evaluatePending();
  await service.idle();
  assert.equal((await stateOf(task)).state, 'failed', 'an automatic look leaves a failure for the person');
});

test('I24 a conflict run the person stopped makes the task Failed', async () => {
  const project = await h.createProject('I24');
  const { service } = makeService();
  const task = await conflictingTask(project);
  h.stepActions[STEP] = () => undefined;
  const done = enable(service, project, task);
  await runUp(project, task.number);
  await h.manager.stopWorkflowRun((await h.manager.latestConflictRun(project.id, task.number))!.id);
  await done;
  assert.equal((await stateOf(task)).state, 'failed');
});

test('I25 Retry on a failed task starts exactly one new run with the same agent and clears the notification', async () => {
  const project = await h.createProject('I25');
  const { service, spies } = makeService();
  const task = await conflictingTask(project);
  h.stepActions[STEP] = resolvingAgent(task, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  await enable(service, project, task);
  await idleProject(project);
  assert.equal((await stateOf(task)).state, 'failed');
  assert.equal(spies.starts.length, 1);

  h.stepActions[STEP] = resolvingAgent(task);
  await h.gh.setPull(task.number, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  await service.retry(project.id, task.item.id);
  await service.idle();
  await idleProject(project);
  assert.equal(spies.starts.length, 2);
  assert.equal(spies.starts[1]!.executorId, spies.starts[0]!.executorId);
  assert.equal((await stateOf(task)).state, 'merged');
  assert.deepEqual(await active(task), []);
});

// ---- Toggle off, manual merge, idempotency ----

test('I26 switched off while blocked, the task never merges even after the blocker clears', async () => {
  const project = await h.createProject('I26');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  await enable(service, project, task);
  assert.equal((await active(task)).length, 1);
  await service.setEnabled(project.id, task.item.id, false);
  assert.deepEqual(await active(task), [], 'the pending notification resolves');
  await h.gh.setPull(task.number, { isDraft: false });
  await service.evaluatePending();
  await service.evaluate(task.item.id);
  await service.idle();
  assert.deepEqual(spies.merges, []);
  assert.equal((await stateOf(task)).enabled, false);
});

test('I27 switched off while a conflict run is going, the run is not killed and nothing is merged when it ends; a manual merge still works', async () => {
  const project = await h.createProject('I27');
  const { service, spies } = makeService();
  const task = await conflictingTask(project);
  let finish!: () => void;
  const resolve = resolvingAgent(task);
  h.stepActions[STEP] = (taskId) => new Promise<void>((release) => { finish = () => release(resolve(taskId, () => undefined) as unknown as void); });
  const waiting = enable(service, project, task);
  await waitUntil(() => finish !== undefined, 'the agent to start');
  await service.setEnabled(project.id, task.item.id, false);
  await waiting;
  const run = (await h.manager.latestConflictRun(project.id, task.number))!;
  assert.ok(['running', 'completing'].includes(run.status), 'the run was not stopped');

  finish();
  await waitUntil(async () => (await h.manager.latestConflictRun(project.id, task.number))!.status === 'completed', 'the run to end');
  await idleProject(project);
  assert.equal((await mergeCalls(task.number)).length, 0, 'nothing was merged');
  assert.equal((await h.manager.latestConflictRun(project.id, task.number))!.prConflict!.outcome, 'resolved');
  assert.deepEqual(spies.merges, []);
  const manual = await h.pullRequests.merge(project.id, task.number);
  assert.equal(manual.outcome, 'merged');
});

test('I28 switched off and on again while the run is going starts no second run; the task resumes when it ends', async () => {
  const project = await h.createProject('I28');
  const { service, spies } = makeService();
  const task = await conflictingTask(project);
  let finish!: () => void;
  const resolve = resolvingAgent(task);
  h.stepActions[STEP] = (taskId) => new Promise<void>((release) => { finish = () => release(resolve(taskId, () => undefined) as unknown as void); });
  const first = enable(service, project, task);
  await waitUntil(() => finish !== undefined, 'the agent to start');
  await service.setEnabled(project.id, task.item.id, false);
  await first;
  await service.setEnabled(project.id, task.item.id, true);
  await waitUntil(async () => (await stateOf(task)).state === 'resolving', 'resolving again');
  assert.equal(spies.starts.length, 1);
  finish();
  await service.idle();
  await idleProject(project);
  assert.equal((await stateOf(task)).state, 'merged');
  assert.equal(spies.starts.length, 1);
});

test('I29 a PR merged by hand first sends the task straight to Merged without a merge call', async () => {
  const project = await h.createProject('I29');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'blocked');
  await h.gh.setPull(task.number, { state: 'MERGED' });
  await service.pullRequestMerged(project.id, task.number);
  await service.idle();
  assert.equal((await stateOf(task)).state, 'merged');
  assert.deepEqual(spies.merges, []);
  assert.deepEqual(await active(task), []);
});

test('I31 repeated looks and many toggle flips merge once', async () => {
  const project = await h.createProject('I31');
  const { service, spies } = makeService();
  const task = await finishedTask(project);
  for (let i = 0; i < 3; i += 1) {
    await service.setEnabled(project.id, task.item.id, true);
    await service.setEnabled(project.id, task.item.id, false);
  }
  await service.setEnabled(project.id, task.item.id, true);
  await service.evaluatePending();
  await service.evaluate(task.item.id);
  await service.idle();
  await service.evaluate(task.item.id);
  await service.idle();
  assert.deepEqual(spies.merges, [task.number]);
  assert.equal((await mergeCalls(task.number)).length, 1);
});

test('I32 two evaluations at the same moment, with the merge held open at the provider, merge once', async () => {
  const project = await h.createProject('I32');
  const { service, spies } = makeService();
  const task = await finishedTask(project);
  await h.gh.patch({ mergeDelayMs: 150 });
  await service.setEnabled(project.id, task.item.id, true);
  await Promise.all([service.evaluate(task.item.id), service.evaluate(task.item.id), service.pullRequestMerged(project.id, task.number)]);
  await service.idle();
  await h.gh.patch({ mergeDelayMs: 0 });
  assert.deepEqual(spies.merges, [task.number]);
  assert.equal((await stateOf(task)).state, 'merged');
});

test('I33 repeated evaluation while a conflict run is going starts one run', async () => {
  const project = await h.createProject('I33');
  const { service, spies } = makeService();
  const task = await conflictingTask(project);
  h.stepActions[STEP] = () => undefined;
  const first = enable(service, project, task);
  await runUp(project, task.number);
  // They queue behind the project's current turn, which waits for the run.
  const repeats = Promise.all([service.evaluate(task.item.id), service.evaluatePending()]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(spies.starts.length, 1);
  assert.equal((await stateOf(task)).state, 'resolving');
  await h.manager.stopWorkflowRun((await h.manager.latestConflictRun(project.id, task.number))!.id);
  await Promise.all([first, repeats]);
  await service.idle();
  assert.equal(spies.starts.length, 1, 'the later looks started no second run');
});

// ---- Serialisation ----

test('I34 two tasks finishing together in one project merge one at a time', async () => {
  const project = await h.createProject('I34');
  let inside = 0;
  let overlapped = false;
  const { service, spies } = makeService({
    mergePullRequest: async (p, reading) => {
      inside += 1;
      overlapped ||= inside > 1;
      try { return await actions.mergePullRequest(p, reading); } finally { inside -= 1; }
    },
  });
  const first = await finishedTask(project);
  const second = await finishedTask(project);
  await h.gh.patch({ mergeDelayMs: 100 });
  await Promise.all([service.setEnabled(project.id, first.item.id, true), service.setEnabled(project.id, second.item.id, true)]);
  await service.idle();
  await h.gh.patch({ mergeDelayMs: 0 });
  assert.equal(overlapped, false);
  assert.equal((await stateOf(first)).state, 'merged');
  assert.equal((await stateOf(second)).state, 'merged');
  assert.equal(spies.merges.length, 0, 'the overridden merge dependency recorded the merges');
});

test('I35 a PR that was clean but conflicts once the previous merge landed takes the conflict path', async () => {
  const project = await h.createProject('I35');
  const { service, spies } = makeService();
  const first = await finishedTask(project);
  const second = await conflictingTask(project);
  // The second PR reads clean until the first one is merged.
  await h.gh.setPull(second.number, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  const original = h.gh.callsTo;
  assert.ok(original);
  h.stepActions[STEP] = resolvingAgent(second);
  await service.setEnabled(project.id, first.item.id, true);
  await service.idle();
  await h.gh.setPull(second.number, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  await service.setEnabled(project.id, second.item.id, true);
  await service.idle();
  await idleProject(project);
  assert.deepEqual(spies.merges.includes(first.number), true);
  assert.equal(spies.starts.length, 1);
  assert.equal((await stateOf(second)).state, 'merged');
});

test('I36 two projects are not serialised against each other', async () => {
  const one = await h.createProject('I36 a');
  const two = await h.createProject('I36 b');
  const slow: number[] = [];
  const { service } = makeService({
    readPullRequest: async (project, number) => {
      if (project.id === one.id) { slow.push(number); await new Promise((resolve) => setTimeout(resolve, 300)); }
      return actions.readPullRequest(project, number);
    },
  });
  const a = await finishedTask(one);
  const b = await finishedTask(two);
  const started = Date.now();
  await service.setEnabled(two.id, b.item.id, true);
  await service.setEnabled(one.id, a.item.id, true);
  await waitUntil(async () => (await stateOf(b)).state === 'merged', 'project two to merge');
  assert.ok(Date.now() - started < 300 || (await stateOf(a)).state !== 'merged', 'project two did not wait for project one');
  await service.idle();
  assert.deepEqual(slow, [a.number]);
});

test('I37 a failing first job does not stall the second', async () => {
  const project = await h.createProject('I37');
  const { service } = makeService({
    readPullRequest: async (p, number) => {
      if (number === first.number) throw new Error('unexpected failure');
      return actions.readPullRequest(p, number);
    },
  });
  const first = await finishedTask(project);
  const second = await finishedTask(project);
  await service.setEnabled(project.id, first.item.id, true);
  await service.setEnabled(project.id, second.item.id, true);
  await service.idle();
  assert.equal((await stateOf(first)).state, 'provider');
  assert.equal((await stateOf(second)).state, 'merged');
});

// ---- Restart ----

test('I38 a new service resumes a waiting task from its stored state', async () => {
  const project = await h.createProject('I38');
  const task = await finishedTask(project, { autoMerge: { state: 'waiting' } });
  const { service, spies } = makeService();
  startService(service);
  await waitUntil(async () => (await stateOf(task)).state === 'merged', 'the resumed merge');
  assert.deepEqual(spies.merges, [task.number]);
});

test('I39 a task left in "merging" reads the PR again: merged once, or Merged if it already was', async () => {
  const project = await h.createProject('I39');
  const open = await finishedTask(project, { autoMerge: { state: 'merging', prNumber: null } });
  const gone = await finishedTask(project, { pr: { state: 'MERGED' }, autoMerge: { state: 'merging' } });
  const { service, spies } = makeService();
  await service.evaluatePending();
  await service.idle();
  assert.equal((await stateOf(open)).state, 'merged');
  assert.equal((await stateOf(gone)).state, 'merged');
  assert.deepEqual(spies.merges, [open.number]);
});

test('I40 a task resolving with its run still going starts no new run on restart, and finishes when the run does', async () => {
  const project = await h.createProject('I40');
  const first = makeService();
  const task = await conflictingTask(project, { autoMerge: { state: 'waiting' } });
  h.stepActions[STEP] = () => undefined;
  const pendingWait = first.service.evaluate(task.item.id, { automatic: true });
  await runUp(project, task.number);
  const second = makeService();
  const resumed = second.service.evaluate(task.item.id, { automatic: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(second.spies.starts.length, 0);
  assert.equal((await stateOf(task)).state, 'resolving');
  await h.manager.stopWorkflowRun((await h.manager.latestConflictRun(project.id, task.number))!.id);
  await Promise.all([pendingWait, resumed]);
  assert.equal((await stateOf(task)).state, 'failed');
});

test('I41 a run that ended during downtime is evaluated at start', async () => {
  const project = await h.createProject('I41');
  const first = makeService();
  const task = await conflictingTask(project);
  h.stepActions[STEP] = resolvingAgent(task);
  await enable(first.service, project, task);
  await idleProject(project);
  assert.equal((await stateOf(task)).state, 'merged');
  // Same again, but the old process went away before it saw the end: its stored state still says resolving.
  const lagging = await conflictingTask(project);
  h.stepActions[STEP] = resolvingAgent(lagging);
  const started = await h.manager.startConflictRun(project.id, (await actions.readPullRequest(project, lagging.number)), DEV, { planItemId: lagging.item.id, title: 'x' });
  await h.collections.planItemsDb.update(lagging.item.id, { autoMerge: { enabled: true, state: 'resolving', reasons: [], warnings: [], prNumber: lagging.number, runId: started.run.id, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: new Date().toISOString() } });
  await waitUntil(async () => (await h.manager.latestConflictRun(project.id, lagging.number))!.status === 'completed', 'the run to end');
  await idleProject(project);
  const second = makeService();
  await second.service.evaluatePending();
  await second.service.idle();
  assert.equal((await stateOf(lagging)).state, 'merged');
  assert.equal(second.spies.starts.length, 0);
});

test('I42 a Merged task is never acted on again', async () => {
  const project = await h.createProject('I42');
  const { service, spies } = makeService();
  const task = await finishedTask(project);
  await enable(service, project, task);
  await h.gh.clearCalls();
  const again = makeService();
  startService(again.service);
  await again.service.evaluatePending();
  await again.service.evaluate(task.item.id);
  await again.service.idle();
  assert.deepEqual(await h.gh.calls(), []);
  assert.deepEqual(again.spies.merges, []);
  assert.equal(spies.merges.length, 1);
});

// ---- Deleted or archived, side effects ----

test('I43 a task deleted while pending is not merged and its notification resolves', async () => {
  const project = await h.createProject('I43');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  startService(service);
  await enable(service, project, task);
  assert.equal((await active(task)).length, 1);
  await h.collections.planItemsDb.delete(task.item.id);
  h.manager.publishEvent({ type: 'planItemDeleted', id: task.item.id, projectId: project.id });
  await h.gh.setPull(task.number, { isDraft: false });
  await service.evaluatePending();
  await service.evaluate(task.item.id);
  await service.idle();
  await waitUntil(async () => (await active(task)).length === 0, 'the notification to resolve');
  assert.deepEqual(spies.merges, []);
});

test('I44 a task archived while pending is cancelled without merging', async () => {
  const project = await h.createProject('I44');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  startService(service);
  await enable(service, project, task);
  const archived = await h.collections.planItemsDb.update(task.item.id, { archived: true });
  h.manager.publishEvent({ type: 'planItem', planItem: archived! });
  await h.gh.setPull(task.number, { isDraft: false });
  await service.evaluatePending();
  await service.evaluate(task.item.id);
  await service.idle();
  await waitUntil(async () => (await active(task)).length === 0, 'the notification to resolve');
  assert.deepEqual(spies.merges, []);
});

test('I45 a task deleted at the moment the provider is answering is not merged', async () => {
  const project = await h.createProject('I45');
  const { service, spies } = makeService({
    readPullRequest: async (p, number) => {
      const reading = await actions.readPullRequest(p, number);
      await h.collections.planItemsDb.delete(task.item.id);
      return reading;
    },
  });
  const task = await finishedTask(project);
  await service.setEnabled(project.id, task.item.id, true);
  await service.idle();
  assert.deepEqual(spies.merges, []);
});

test('I47 after a merge the branch sync reading is refreshed, and the checked-out branch is not pulled', async () => {
  const project = await h.createProject('I47');
  const { service } = makeService();
  const task = await finishedTask(project);
  const cwd = h.projectService.projectAbsolutePath(project);
  const headBefore = await git(cwd, ['rev-parse', 'HEAD']).catch(() => '');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const before = h.poller.gitSyncPoller.get(project.id)?.checkedAt ?? '';
  await enable(service, project, task);
  const sync = h.poller.gitSyncPoller.get(project.id);
  assert.ok(sync && sync.checkedAt > before);
  assert.equal(await git(cwd, ['rev-parse', 'HEAD']).catch(() => ''), headBefore);
});

test('I48 a failed deletion of the head branch is kept as a warning on a task that is still Merged', async () => {
  const project = await h.createProject('I48');
  const { service } = makeService();
  const task = await finishedTask(project);
  await failing('delete', 'gh: Resource not accessible by integration (HTTP 403)');
  await enable(service, project, task);
  await noFailure();
  const state = await stateOf(task);
  assert.equal(state.state, 'merged');
  assert.match(state.branchWarning ?? '', /was not deleted/);
  assert.equal(state.branchNote, null);
});

test('I49 a merge the provider refuses fails the task with its reason and one auto-merge-failed notification', async () => {
  const project = await h.createProject('I49');
  const { service } = makeService();
  const task = await finishedTask(project);
  await failing('merge', 'X Pull request is not mergeable: repository rules forbid merge commits');
  await enable(service, project, task);
  await noFailure();
  const state = await stateOf(task);
  assert.equal(state.state, 'failed');
  assert.match(state.reasons[0]!, /forbid merge commits/);
  assert.deepEqual((await active(task)).map((n) => n.kind), ['automerge.failed']);
});

// ---- Notifications and events ----

test('I50 the blocked notification is one per task, project-scoped, and resolves when the state changes', async () => {
  const project = await h.createProject('I50');
  const { service } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  await enable(service, project, task);
  await service.evaluatePending();
  await service.evaluatePending();
  await service.idle();
  const raised = await active(task);
  assert.equal(raised.length, 1);
  assert.deepEqual(raised[0]!.subject, { type: 'autoMerge', projectId: project.id, planItemId: task.item.id });
  assert.equal(raised[0]!.projectId, project.id);
  await h.gh.setPull(task.number, { isDraft: false });
  await service.evaluatePending();
  await service.idle();
  assert.deepEqual(await active(task), []);
});

test('I51 Retry on a failed task resolves its failure notification', async () => {
  const project = await h.createProject('I51');
  const { service } = makeService();
  const task = await finishedTask(project);
  await failing('merge', 'X refused');
  await enable(service, project, task);
  await noFailure();
  assert.equal((await active(task)).length, 1);
  await service.retry(project.id, task.item.id);
  await service.idle();
  assert.equal((await stateOf(task)).state, 'merged');
  assert.deepEqual(await active(task), []);
});

test('I53 every transition is published as a plan item change, and a fresh read of the task shows the stored state', async () => {
  const project = await h.createProject('I53');
  const { service } = makeService();
  const task = await finishedTask(project);
  await enable(service, project, task);
  const states = events
    .flatMap((event) => (event.type === 'planItem' && event.planItem.id === task.item.id ? [event.planItem.autoMerge!.state] : []))
    .filter((state, index, all) => state !== all[index - 1]);
  assert.deepEqual(states, ['waiting', 'merging', 'merged']);
  assert.equal((await h.collections.planItemsDb.get(task.item.id))!.autoMerge!.state, 'merged');
});

test('Retry is refused unless the task failed or waits for an agent; turning on is refused for a task that cannot have a PR; turning off always works', async () => {
  const project = await h.createProject('Guards');
  const { service } = makeService();
  const task = await finishedTask(project);
  await assert.rejects(() => service.retry(project.id, task.item.id), svc.AutoMergeNotRetryableError);
  const noBranch = await finishedTask(project, { branch: null, baseBranch: null });
  await assert.rejects(() => service.setEnabled(project.id, noBranch.item.id, true), svc.AutoMergeUnavailableError);
  await service.setEnabled(project.id, noBranch.item.id, false);
  assert.equal((await h.collections.planItemsDb.get(noBranch.item.id))!.autoMerge, undefined, 'off on a never-enabled task stores nothing');
  const { PlanItemNotFoundError } = await import('../src/projects/planItemService.ts');
  await assert.rejects(() => service.setEnabled(project.id, 'nope', true), PlanItemNotFoundError);
  const other = await h.createProject('Guards other');
  await assert.rejects(() => service.setEnabled(other.id, task.item.id, true), PlanItemNotFoundError);
});

// ---- Review round 1 ----

test('a failed task whose PR is then merged by hand goes to Merged, by the manual-merge shortcut and by the poll', async () => {
  const project = await h.createProject('R1 failed');
  const { service, spies } = makeService();
  const byHand = await finishedTask(project);
  const byGitHub = await finishedTask(project);
  await failing('merge', 'X refused');
  await enable(service, project, byHand);
  await enable(service, project, byGitHub);
  await noFailure();
  assert.equal((await stateOf(byHand)).state, 'failed');
  await h.gh.setPull(byHand.number, { state: 'MERGED' });
  await service.pullRequestMerged(project.id, byHand.number);
  await service.idle();
  assert.equal((await stateOf(byHand)).state, 'merged');
  assert.match((await stateOf(byHand)).branchNote ?? '', /outside auto-merge/);

  await h.gh.setPull(byGitHub.number, { state: 'MERGED' });
  await service.evaluatePending();
  await service.idle();
  assert.equal((await stateOf(byGitHub)).state, 'merged');
  assert.deepEqual(spies.merges, [byHand.number, byGitHub.number], 'one refused attempt each, and no merge call after the manual merge');
  assert.equal((await mergeCalls(byHand.number)).length, 1, 'only the refused attempt');
});

test('a merge that fails because the person merged by hand a moment earlier ends Merged, not Failed', async () => {
  const project = await h.createProject('R1 race');
  let reads = 0;
  const { service } = makeService({
    readPullRequest: async (p, number) => {
      reads += 1;
      if (reads === 2) await h.gh.setPull(number, { state: 'MERGED' });
      return actions.readPullRequest(p, number);
    },
    mergePullRequest: async () => { throw new Error('Pull request is already merged'); },
  });
  const task = await finishedTask(project);
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'merged');
  assert.deepEqual(await active(task), []);
});

test('the manual-merge shortcut finds a task that has not been looked at yet through its run\'s PR link', async () => {
  const project = await h.createProject('R1 unmarked');
  const { service } = makeService();
  const task = await finishedTask(project, { autoMerge: { state: 'waiting', prNumber: null } });
  await h.gh.setPull(task.number, { state: 'MERGED' });
  await service.pullRequestMerged(project.id, task.number);
  await service.idle();
  assert.equal((await stateOf(task)).state, 'merged');
});

test('a task switched off while a look is in progress stays off: no write restores it', async () => {
  const project = await h.createProject('R1 off');
  const { service } = makeService({
    readPullRequest: async (p, number) => {
      const reading = await actions.readPullRequest(p, number);
      await service.setEnabled(project.id, task.item.id, false);
      return reading;
    },
  });
  const task = await finishedTask(project, { pr: { isDraft: true } });
  await service.setEnabled(project.id, task.item.id, true);
  await service.idle();
  assert.equal((await stateOf(task)).enabled, false);
  assert.deepEqual(await active(task), []);
});

test('looking again at an unchanged state writes, publishes and raises nothing', async () => {
  const project = await h.createProject('R1 quiet');
  const { service } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  await enable(service, project, task);
  const stored = await stateOf(task);
  const before = events.length;
  const raisedAt = (await active(task))[0]!.updatedAt;
  await service.evaluatePending();
  await service.evaluatePending();
  await service.idle();
  assert.deepEqual(await stateOf(task), stored);
  assert.equal(events.length, before);
  assert.equal((await active(task))[0]!.updatedAt, raisedAt);
});

test('a conflict run that outlasts the wait bound releases the project\'s turn; a later look waits again and the task still ends Merged', async () => {
  const project = await h.createProject('R1 bound');
  const { service, spies } = makeService({ maxRunWaitMs: 150 });
  const slow = await conflictingTask(project);
  let finish!: () => void;
  const resolve = resolvingAgent(slow);
  h.stepActions[STEP] = (taskId) => new Promise<void>((release) => { finish = () => release(resolve(taskId, () => undefined) as unknown as void); });
  const quick = await finishedTask(project);
  await service.setEnabled(project.id, slow.item.id, true);
  await runUp(project, slow.number);
  await service.setEnabled(project.id, quick.item.id, true);
  await waitUntil(async () => (await stateOf(quick)).state === 'merged', 'the other task to merge while the run is still going');
  assert.equal((await stateOf(slow)).state, 'resolving');
  finish();
  await waitUntil(async () => (await h.manager.latestConflictRun(project.id, slow.number))!.status === 'completed', 'the run to end');
  await idleProject(project);
  await service.evaluatePending();
  await service.idle();
  assert.equal((await stateOf(slow)).state, 'merged');
  assert.equal(spies.starts.length, 1);
});

test('a failed read on an automatic look leaves a Failed or Can\'t-be-merged task as it is, and nothing starts on the next look', async () => {
  const project = await h.createProject('R2 dormant');
  const { service, spies } = makeService();
  const failed = await finishedTask(project);
  const stopped = await finishedTask(project, { pr: { state: 'CLOSED' } });
  await failing('merge', 'X refused');
  await enable(service, project, failed);
  await noFailure();
  await enable(service, project, stopped);
  assert.deepEqual([(await stateOf(failed)).state, (await stateOf(stopped)).state], ['failed', 'cannot-merge']);

  await failing('read', 'gh: not signed in');
  await service.evaluatePending();
  await service.idle();
  await noFailure();
  assert.deepEqual([(await stateOf(failed)).state, (await stateOf(stopped)).state], ['failed', 'cannot-merge']);
  await service.evaluatePending();
  await service.idle();
  assert.equal((await stateOf(failed)).state, 'failed');
  assert.deepEqual(spies.starts, []);
  assert.deepEqual(spies.merges, [failed.number], 'only the first, refused attempt');
});

// ---- Required checks and the merged notification (task 19.002) ----

const optionalFailing = () => checksPayload([{ name: 'build', state: 'SUCCESS', required: true }, { name: 'Vercel', state: 'FAILURE', required: false }]);

test('SI1 only an optional check failing: the PR is merged without the bypass, and the warning is kept on the task', async () => {
  const project = await h.createProject('SI1');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { pr: optionalFailing() });
  await h.gh.clearCalls();
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'merged');
  assert.deepEqual((await stateOf(task)).warnings, ['Optional checks failing: Vercel']);
  assert.deepEqual(spies.merges, [task.number]);
  assert.ok((await mergeCalls(task.number)).every((args) => !args.includes('--admin')), 'Auto-merge never bypasses');
});

test('SI2 a required check failing blocks with the check named, and raises the blocked notification', async () => {
  const project = await h.createProject('SI2');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { pr: checksPayload([{ name: 'build', state: 'FAILURE', required: true }, { name: 'lint', state: 'FAILURE', required: true }, { name: 'Vercel', state: 'FAILURE', required: false }]) });
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'blocked');
  assert.deepEqual((await stateOf(task)).reasons, ['Checks are failing: build, lint']);
  assert.deepEqual((await stateOf(task)).warnings, ['Optional checks failing: Vercel']);
  assert.deepEqual((await active(task)).map((n) => n.kind), ['automerge.blocked']);
  assert.deepEqual(spies.merges, []);
});

test('SI3 when GitHub does not say which checks are required, a failing check blocks with the suffix and nothing merges', async () => {
  const project = await h.createProject('SI3');
  const { service, spies } = makeService();
  const task = await finishedTask(project, { pr: checksPayload([{ name: 'Vercel', state: 'FAILURE', required: null }]) });
  await enable(service, project, task);
  assert.equal((await stateOf(task)).state, 'blocked');
  assert.deepEqual((await stateOf(task)).reasons, ['Checks are failing: Vercel (could not tell which checks are required)']);
  assert.deepEqual(spies.merges, []);
});

test('SI7/SI8 a merge by Auto-merge raises one info notification on the task\'s autoMerge subject, with the branch note or warning', async () => {
  const project = await h.createProject('SI7');
  const { service } = makeService();
  const task = await finishedTask(project);
  await enable(service, project, task);
  const [raised, ...rest] = await mergedNotifications(task);
  assert.equal(rest.length, 0);
  assert.equal(raised!.severity, 'info');
  assert.deepEqual(raised!.subject, { type: 'autoMerge', projectId: project.id, planItemId: task.item.id });
  assert.equal(raised!.title, `Auto-merge: ${task.item.title}`);
  assert.equal(raised!.description, `PR #${task.number} merged.`);
  assert.equal(raised!.resolvedAt, null);

  const kept = await finishedTask(project, { pr: { headRefName: 'main', headRef: { name: 'main' } } });
  await enable(service, project, kept);
  assert.match((await mergedNotifications(kept))[0]!.description, /^PR #\d+ merged\. "main" is the base or default branch, so it was kept\.$/);

  const undeleted = await finishedTask(project);
  await h.gh.patch({ fail: { delete: 'HTTP 403: Resource not accessible' } });
  await enable(service, project, undeleted);
  await noFailure();
  assert.match((await mergedNotifications(undeleted))[0]!.description, /^PR #\d+ merged\. The branch ".*" was not deleted: /);
});

test('SI9 a PR merged by hand while Auto-merge is on is recorded as Merged and notified', async () => {
  const project = await h.createProject('SI9');
  const { service } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  await enable(service, project, task);
  await h.gh.setPull(task.number, { state: 'MERGED' });
  await service.pullRequestMerged(project.id, task.number);
  await service.idle();
  assert.equal((await stateOf(task)).state, 'merged');
  const [raised] = await mergedNotifications(task);
  assert.match(raised!.description, /merged outside auto-merge/i);
});

test('SI11/SI12 with Auto-merge off nothing is raised, now or later', async () => {
  const project = await h.createProject('SI12');
  const { service } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  await enable(service, project, task);
  await service.setEnabled(project.id, task.item.id, false);
  await h.gh.setPull(task.number, { state: 'MERGED' });
  await service.pullRequestMerged(project.id, task.number);
  await service.evaluatePending();
  await service.idle();
  assert.deepEqual(await mergedNotifications(task), []);
});

test('SI13 Auto-merge turned on after the run completed still notifies on merge', async () => {
  const project = await h.createProject('SI13');
  const { service } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  assert.equal((await stateOf(task)), undefined);
  await h.gh.setPull(task.number, { state: 'OPEN', isDraft: false });
  await enable(service, project, task);
  assert.equal((await mergedNotifications(task)).length, 1);
});

test('SI14 Merged resolves the task\'s blocked notification and leaves another task\'s alone', async () => {
  const project = await h.createProject('SI14');
  const { service } = makeService();
  const task = await finishedTask(project, { pr: { isDraft: true } });
  const other = await finishedTask(project, { pr: { isDraft: true } });
  await enable(service, project, task);
  await enable(service, project, other);
  await h.gh.setPull(task.number, { isDraft: false });
  await service.evaluate(task.item.id);
  await service.idle();
  assert.equal((await stateOf(task)).state, 'merged');
  assert.deepEqual(await active(task), []);
  assert.equal((await active(other)).length, 1);
});

test('SI15 reading the merged notification resolves it, like a task completion', async () => {
  const project = await h.createProject('SI15');
  const { service } = makeService();
  const task = await finishedTask(project);
  await enable(service, project, task);
  const [raised] = await mergedNotifications(task);
  await notifications.markNotificationsRead([raised!.id]);
  const read = (await mergedNotifications(task))[0]!;
  assert.ok(read.readAt && read.resolvedAt);

  const second = await finishedTask(project);
  await enable(service, project, second);
  await notifications.markSubjectRead({ type: 'autoMerge', projectId: project.id, planItemId: second.item.id });
  assert.ok((await mergedNotifications(second))[0]!.resolvedAt);
});

test('SI16 looking again at a Merged task, or a restarted service, raises nothing more', async () => {
  const project = await h.createProject('SI16');
  const { service } = makeService();
  const task = await finishedTask(project);
  await enable(service, project, task);
  const before = (await mergedNotifications(task))[0]!;
  await service.evaluatePending();
  await service.evaluate(task.item.id);
  await service.idle();
  const restarted = makeService().service;
  await restarted.evaluate(task.item.id);
  await restarted.idle();
  const after = await mergedNotifications(task);
  assert.deepEqual(after.map((n) => n.id), [before.id]);
  assert.equal(after[0]!.updatedAt, before.updatedAt);
});

test('SI25 a merge the provider refuses raises no merged notification', async () => {
  const project = await h.createProject('SI25');
  const { service } = makeService();
  const task = await finishedTask(project);
  await failing('merge', 'X refused');
  await enable(service, project, task);
  await noFailure();
  assert.equal((await stateOf(task)).state, 'failed');
  assert.deepEqual(await mergedNotifications(task), []);
});
