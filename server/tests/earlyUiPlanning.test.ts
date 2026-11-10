import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import type { PlanItemRecord, ProjectRecord, TaskRecord, WorkflowRunRecord } from '../src/domain/types.ts';
import type { DependencyGit } from '../src/projects/dependencyGit.ts';
import type { DependencyService } from '../src/projects/dependencyService.ts';
import { installDocsRetroFixture } from './fixtures/docsRetroFixture.ts';
import { autoAdvanceTerminalSteps, type StepAction } from './helpers/terminalStepFakes.ts';

/**
 * Integration cases of task 38.002: a waiting task's UI Planning runs early through the real workflow engine
 * and dependency service, in a temp git repository with scripted agents. Parent tasks are fake runs whose
 * merge state a fake DependencyGit reports; the children run for real (branch, worktree, step rounds).
 */

let root: string;
let git: typeof import('../src/projects/git.ts');
let projects: typeof import('../src/projects/projectService.ts');
let worker: typeof import('../src/worker/workerManager.ts');
let deps: typeof import('../src/projects/dependencyService.ts');
let db: typeof import('../src/db/collections.ts');
let notifications: typeof import('../src/notifications/notificationService.ts');
let workflows: typeof import('../src/catalog/workflowService.ts');

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'early-ui-planning-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures/executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(root, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  await installDocsRetroFixture(process.env.AGENT_VISUAL_OS_CATALOG_DIR);
  process.env.GIT_CONFIG_COUNT = '3';
  process.env.GIT_CONFIG_KEY_0 = `url.${root}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test/';
  process.env.GIT_CONFIG_KEY_1 = 'user.name'; process.env.GIT_CONFIG_VALUE_1 = 'Test';
  process.env.GIT_CONFIG_KEY_2 = 'user.email'; process.env.GIT_CONFIG_VALUE_2 = 'test@example.com';
  git = await import('../src/projects/git.ts');
  await git.git(root, ['init', '--bare', '--initial-branch=main', 'repo']);
  await git.git(root, ['clone', path.join(root, 'repo'), 'seed']);
  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'existing code');
  await git.git(seed, ['add', '.']); await git.git(seed, ['commit', '-m', 'initial']);
  await git.git(seed, ['push', 'origin', 'main']);
  projects = await import('../src/projects/projectService.ts');
  worker = await import('../src/worker/workerManager.ts');
  deps = await import('../src/projects/dependencyService.ts');
  db = await import('../src/db/collections.ts');
  notifications = await import('../src/notifications/notificationService.ts');
  workflows = await import('../src/catalog/workflowService.ts');
  await workflows.updateWorkflow('software-development', {
    name: 'Software Development', description: 'UI Planning, then the rest.',
    steps: [
      { id: 'ui-planning', name: 'UI Planning', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Plan the UI.' },
      { id: 'test-case-planning', name: 'Test Case Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'List the cases.' },
      { id: 'development', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build it.' },
    ],
  });
  await workflows.createWorkflow({
    id: 'no-early-step', name: 'No early step', description: 'Starts with the plan.',
    steps: [
      { id: 'test-case-planning', name: 'Test Case Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'List the cases.' },
      { id: 'development', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build it.' },
    ],
  });
});
after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

type Manager = ReturnType<typeof import('../src/worker/workerManager.ts')['createWorkerManager']>;
interface World { present: Set<string>; heads: Map<string, string> }
interface Env {
  manager: Manager;
  service: DependencyService;
  project: ProjectRecord;
  world: World;
  actions: Record<string, StepAction>;
  /** Every step session started, with its prompt. */
  starts: { taskId: string; prompt: string }[];
  stop: () => void;
}

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

let counter = 0;

async function makeEnv(name: string): Promise<Env> {
  counter += 1;
  const project = await projects.createProject({ name: `${name} ${counter}`, position: null, repositoryUrl: 'https://github.com/test/repo' });
  const managerRef: { current?: Manager } = {};
  const actions: Record<string, StepAction> = {
    'ui-planning': (id) => managerRef.current!.completeStep(id, { summary: 'UI plan ready.', outputs: [{ name: 'Card', format: 'html', content: '<p>card</p>' }] }),
  };
  const proxy = new Proxy(actions, { get: (target, key: string) => target[key] });
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, proxy);
  const manager = worker.createWorkerManager({ terminalSessions: host });
  managerRef.current = manager;
  const world: World = { present: new Set(), heads: new Map() };
  const fakeGit: DependencyGit = {
    checkedOutBranch: async () => 'main',
    branchHead: async (_p, branch) => world.heads.get(branch) ?? null,
    isAncestor: async (_p, commit) => world.present.has(commit),
    commitsAhead: async () => 1,
    pullRequest: async () => null,
  };
  const service = deps.createDependencyService({
    getProject: projects.getProject,
    git: fakeGit,
    syncOf: () => null,
    startPlanItem: (id, options) => manager.enqueuePlanItemExecution(id, options),
    enableAutoMerge: async (_projectId, id) => (await db.planItemsDb.get(id))!,
    early: {
      earlyStepFor: (id, options) => manager.earlyStepForStart(id, options),
      startEarlyRun: (id, options) => manager.enqueuePlanItemExecution(id, { ...options, early: true }),
      queuedStartOf: async (id) => (await manager.listPlanItemQueue(project.id)).find((entry) => entry.planItemId === id) ?? null,
      removeQueuedStart: (entryId) => manager.removeQueuedPlanItemExecution(entryId),
      releaseHeldRun: (runId) => manager.releaseHeldRun(runId),
      discardEarlyRun: (runId) => manager.discardEarlyRun(runId),
    },
    onWorkerEvent: manager.onWorkerEvent,
    onProjectSync: () => () => undefined,
    publish: manager.publishEvent,
    schedule: () => () => undefined,
  });
  const stopService = service.start();
  const stop = () => { stopService(); manager.dispose(); };
  stops.push(stop);
  return { manager, service, project, world, actions, starts: starts as unknown as Env['starts'], stop };
}

async function waitUntil(check: () => Promise<boolean> | boolean, what = 'condition', timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function task(env: Env, extra: Partial<PlanItemRecord> = {}): Promise<PlanItemRecord> {
  counter += 1;
  const now = new Date().toISOString();
  return db.planItemsDb.insert({
    id: randomUUID(), projectId: env.project.id, title: `38.${String(counter).padStart(3, '0')}: Task ${counter}`, description: 'A task.', status: 'pending',
    order: counter, taskIds: [], milestoneId: null, workflowRunId: null, createdAt: now, updatedAt: now, ...extra,
  } as PlanItemRecord);
}

/** A parent with a fake run on its own branch; `mergeParent` makes the fake git report it merged. */
async function parent(env: Env): Promise<PlanItemRecord> {
  const item = await task(env, { status: 'developing' });
  const now = new Date().toISOString();
  const run = await db.workflowRunsDb.insert({
    id: randomUUID(), projectId: env.project.id, planItemId: item.id, workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'Software development', description: '', enabled: true, steps: [] },
    status: 'running', currentStepId: null, branch: `parent/${item.id}`, baseBranch: 'main', executorId: 'test-claude-cli', prUrl: null,
    completionReport: null, attentionReason: null, loopRoundAllowance: 0, createdAt: now, updatedAt: now, completedAt: null,
  });
  env.world.heads.set(`parent/${item.id}`, `commit-${item.id}`);
  return (await db.planItemsDb.update(item.id, { workflowRunId: run.id }))!;
}

async function mergeParent(env: Env, item: PlanItemRecord): Promise<void> {
  const current = (await db.planItemsDb.get(item.id))!;
  const run = (await db.workflowRunsDb.get(current.workflowRunId!))!;
  await db.workflowRunsDb.update(run.id, { status: 'completed', completedAt: new Date().toISOString() });
  env.world.heads.set(run.branch!, `commit-${item.id}`);
  env.world.present.add(`commit-${item.id}`);
  await db.planItemsDb.update(item.id, { status: 'done' });
  await env.service.evaluateProject(env.project.id);
  await env.service.idle();
}

const itemOf = async (id: string) => (await db.planItemsDb.get(id))!;
const runOf = async (id: string): Promise<WorkflowRunRecord | null> => {
  const item = await itemOf(id);
  return item.workflowRunId ? (await db.workflowRunsDb.get(item.workflowRunId)) ?? null : null;
};
const stepRunsOf = async (runId: string) => (await db.stepRunsDb.find((stepRun) => stepRun.runId === runId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const statusIs = (id: string, status: WorkflowRunRecord['status']) => async () => (await runOf(id))?.status === status;

async function startChild(env: Env, child: PlanItemRecord, options: Parameters<DependencyService['startWhenReady']>[2] = {}, waits?: boolean) {
  const result = await env.service.startWhenReady(env.project.id, child.id, options, waits);
  await env.service.idle();
  return result;
}

/** Holds `count` slots with fake live Tasks; returns a function that frees them. */
async function fillSlots(env: Env, count: number): Promise<() => Promise<void>> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.tasksDb.insert({
      id, projectId: env.project.id, templateId: 'builder', executorId: 'test-claude-cli', description: `Filler ${i}`, status: 'developing',
      autonomy: 'auto', manager: false, kind: 'execute', planItemId: null, runtimeStatus: 'starting', createdAt: now, updatedAt: now, completedAt: null,
    } as unknown as TaskRecord);
    ids.push(id);
  }
  await projects.patchProjectWith(env.project.id, async (current) => ({ activeTaskIds: [...(current.activeTaskIds ?? []), ...ids] }));
  return async () => {
    for (const id of ids) await db.tasksDb.update(id, { status: 'done' });
    await projects.patchProjectWith(env.project.id, async (current) => ({ activeTaskIds: (current.activeTaskIds ?? []).filter((id) => !ids.includes(id)) }));
    await env.manager.advanceQueueIfIdle(env.project.id);
  };
}

const openApprovals = async (env: Env) => (await notifications.listNotifications({ resolved: false }))
  .filter((n) => n.kind === 'workflow.awaiting_approval' && n.subject.type === 'project' && n.subject.projectId === env.project.id);

test('I1–I3 A <- B <- C with the setting off: B and C reach UI Planning approval before A merges, then continue in order, each from a branch reset to the merged base', async () => {
  const env = await makeEnv('Chain');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  const c = await task(env, { dependsOn: [b.id], uiPlanningWaitsForParent: false });
  await startChild(env, b);
  await startChild(env, c);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'B awaiting approval');
  await waitUntil(statusIs(c.id, 'awaiting-approval'), 'C awaiting approval');

  // I1: only UI Planning ran, the tasks still wait, and each approval was asked like a normal one.
  for (const id of [b.id, c.id]) {
    const run = (await runOf(id))!;
    assert.deepEqual((await stepRunsOf(run.id)).map((s) => s.stepId), ['ui-planning']);
    assert.deepEqual(run.early, { stepId: 'ui-planning', revisions: 0 });
    assert.ok((await itemOf(id)).waiting, 'still waiting for its parents');
  }
  const approvals = await openApprovals(env);
  assert.equal(approvals.length, 1, 'one project-scoped approval notice, raised like a normal approval request');
  assert.match(approvals[0]!.description, /"UI Planning" is ready for your review\./);

  // I2: approved, both are held and nothing later runs.
  await env.manager.approveWorkflowRun((await runOf(b.id))!.id);
  await env.manager.approveWorkflowRun((await runOf(c.id))!.id);
  await env.service.idle();
  for (const id of [b.id, c.id]) {
    const run = (await runOf(id))!;
    assert.equal(run.status, 'held');
    assert.deepEqual((await stepRunsOf(run.id)).map((s) => s.stepId), ['ui-planning']);
    assert.ok((await itemOf(id)).waiting);
  }
  // I9: repeated evaluations while the parents are not merged never continue a held run.
  for (let i = 0; i < 3; i += 1) { await env.service.evaluateProject(env.project.id); await env.service.idle(); }
  assert.equal((await runOf(b.id))!.status, 'held');

  // I3: A lands in main; B's branch is reset onto it and Test Case Planning starts; C stays held.
  const projectDir = projects.projectAbsolutePath(env.project);
  await writeFile(path.join(projectDir, 'parent-a.txt'), 'A');
  await git.git(projectDir, ['add', '.']); await git.git(projectDir, ['commit', '-m', 'A merged']);
  const mainHead = await git.git(projectDir, ['rev-parse', 'main']);
  await mergeParent(env, a);
  await waitUntil(async () => (await stepRunsOf((await runOf(b.id))!.id)).some((s) => s.stepId === 'test-case-planning'), 'B test-case-planning');
  const bRun = (await runOf(b.id))!;
  assert.equal(bRun.status, 'running');
  assert.equal(bRun.early, undefined, 'an ordinary run from now on');
  assert.equal((await itemOf(b.id)).waiting, undefined);
  assert.equal(await git.git(bRun.worktreePath!, ['rev-parse', 'HEAD']), mainHead, 'B continues from the merged base');
  assert.equal((await runOf(c.id))!.status, 'held');
  const started = (await notifications.listNotifications({ resolved: false })).find((n) => n.kind === 'dependency.started' && n.subject.type === 'autoMerge' && n.subject.planItemId === b.id);
  assert.equal(started?.description, 'All parent tasks are merged, so this task started by itself.', 'I24: continuing raises dependency.started');

  // I25: Test Case Planning was briefed with the approved UI plan.
  const tcp = (await stepRunsOf(bRun.id)).find((s) => s.stepId === 'test-case-planning')!;
  const prompt = env.starts.find((start) => start.taskId === tcp.taskId)!.prompt;
  assert.match(prompt, /UI plan ready\./, 'the approved UI Planning summary');
  assert.match(prompt, /Decision: APPROVED/);

  // B merges: C continues.
  await db.workflowRunsDb.update(bRun.id, { status: 'completed' });
  env.world.heads.set(bRun.branch!, 'commit-b');
  env.world.present.add('commit-b');
  await env.service.evaluateProject(env.project.id);
  await env.service.idle();
  await waitUntil(async () => (await stepRunsOf((await runOf(c.id))!.id)).some((s) => s.stepId === 'test-case-planning'), 'C test-case-planning');
});

test('I4 with the setting on nothing runs until the parent is merged', async () => {
  const env = await makeEnv('Setting on');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  const result = await startChild(env, b, {}, true);
  assert.equal(result.started, false);
  assert.equal((await itemOf(b.id)).uiPlanningWaitsForParent, true, 'the start saved the chosen value');
  assert.equal((await itemOf(b.id)).workflowRunId, null);
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 0);
  await mergeParent(env, a);
  await waitUntil(async () => (await runOf(b.id)) !== null, 'B started after the merge');
  assert.equal((await runOf(b.id))!.early, undefined, 'a normal run');
});

test('I5 I6 I7 slots: a full cap queues the early run, the approval pause frees the slot, and an approval with merged parents waits in line', async () => {
  const env = await makeEnv('Slots');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  const free = await fillSlots(env, 6);
  await startChild(env, b);
  const queue = await env.manager.listPlanItemQueue(env.project.id);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.early, true);
  assert.equal((await itemOf(b.id)).workflowRunId, null, 'no run while it waits for a slot');
  await free();
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'B awaiting approval after a slot freed');
  assert.deepEqual((await stepRunsOf((await runOf(b.id))!.id)).map((s) => s.stepId), ['ui-planning']);

  // I6: the paused run holds no slot — six other tasks fit.
  const refill = await fillSlots(env, 6);
  // I7: the parent merges, then the approval: the task waits in the slot line for Test Case Planning.
  await mergeParent(env, a);
  assert.equal((await runOf(b.id))!.status, 'awaiting-approval', 'still waiting for the approval');
  await env.manager.approveWorkflowRun((await runOf(b.id))!.id);
  await env.service.idle();
  await waitUntil(async () => (await env.manager.listPlanItemQueue(env.project.id)).some((entry) => entry.resumeRunId), 'resume entry queued');
  const run = (await runOf(b.id))!;
  assert.equal(run.status, 'held');
  assert.equal(run.early?.released, true);
  assert.equal((await itemOf(b.id)).waiting, undefined, 'no longer waits for parents, only for a slot');
  assert.ok(!(await stepRunsOf(run.id)).some((s) => s.stepId === 'test-case-planning'));
  await refill();
  await waitUntil(async () => (await stepRunsOf(run.id)).some((s) => s.stepId === 'test-case-planning'), 'test-case-planning after the slot freed');
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 0);
});

test('I8 I32 approval with the parents already merged and a free slot continues at once, exactly once', async () => {
  const env = await makeEnv('Merged first');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'B awaiting approval');
  await mergeParent(env, a);
  await env.manager.approveWorkflowRun((await runOf(b.id))!.id);
  await env.service.idle();
  await waitUntil(async () => (await stepRunsOf((await runOf(b.id))!.id)).some((s) => s.stepId === 'test-case-planning'), 'continued');
  for (let i = 0; i < 3; i += 1) { await env.service.evaluateProject(env.project.id); await env.service.idle(); }
  assert.equal((await stepRunsOf((await runOf(b.id))!.id)).filter((s) => s.stepId === 'test-case-planning').length, 1, 'one Test Case Planning round');
});

test('I10 I11 Request changes runs the revision round early, and waits in the slot line when the cap is full', async () => {
  const env = await makeEnv('Revision');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'round 1 approval');
  const runId = (await runOf(b.id))!.id;
  await env.manager.requestChangesWorkflowRun(runId, 'Bigger buttons.');
  await waitUntil(async () => (await stepRunsOf(runId)).filter((s) => s.stepId === 'ui-planning').length === 2, 'round 2');
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'round 2 approval');
  assert.equal((await runOf(b.id))!.early?.revisions, 1);

  // I11: cap full: the next revision is held with a pending round and a resume entry.
  const free = await fillSlots(env, 6);
  await env.manager.requestChangesWorkflowRun(runId, 'Smaller buttons.');
  const held = (await runOf(b.id))!;
  assert.equal(held.status, 'held');
  assert.ok(held.early?.pendingRevision);
  assert.ok((await env.manager.listPlanItemQueue(env.project.id)).some((entry) => entry.resumeRunId === runId));
  await env.service.evaluateProject(env.project.id); await env.service.idle();
  assert.equal((await stepRunsOf(runId)).filter((s) => s.stepId === 'ui-planning').length, 2, 'a held revision is never released by the evaluation');
  await free();
  await waitUntil(async () => (await stepRunsOf(runId)).filter((s) => s.stepId === 'ui-planning').length === 3, 'round 3 once a slot freed');
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'round 3 approval');
  await env.manager.approveWorkflowRun(runId);
  await env.service.idle();
  assert.equal((await runOf(b.id))!.status, 'held');
  assert.ok(!(await stepRunsOf(runId)).some((s) => s.stepId === 'test-case-planning'));
});

test('I12 a skipped early UI Planning (no UI surface) asks for no approval, is held, and continues on merge', async () => {
  const env = await makeEnv('Skip');
  env.actions['ui-planning'] = (id) => env.manager.skipStep(id, { reason: 'No UI in this task.' });
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'held'), 'held after the skip');
  const run = (await runOf(b.id))!;
  assert.equal(run.early?.skipped, true);
  assert.equal((await stepRunsOf(run.id))[0]!.skippedReason, 'No UI in this task.');
  assert.equal((await openApprovals(env)).length, 0);
  await mergeParent(env, a);
  await waitUntil(async () => (await stepRunsOf(run.id)).some((s) => s.stepId === 'test-case-planning'), 'continued');
});

test('I13 I14 Cancel waiting discards the early run — running, at approval or held — and a queued early start leaves the line', async () => {
  for (const at of ['running', 'awaiting-approval', 'held'] as const) {
    const env = await makeEnv(`Cancel ${at}`);
    if (at === 'running') delete env.actions['ui-planning'];
    const a = await parent(env);
    const b = await task(env, { dependsOn: [a.id] });
    await startChild(env, b);
    await waitUntil(statusIs(b.id, at === 'held' ? 'awaiting-approval' : at), `reached ${at}`);
    if (at === 'held') { await env.manager.approveWorkflowRun((await runOf(b.id))!.id); await env.service.idle(); }
    const run = (await runOf(b.id))!;
    assert.equal(run.status, at);
    const projectDir = projects.projectAbsolutePath(env.project);
    const item = await env.service.cancelWaiting(env.project.id, b.id);
    assert.equal(item.waiting, undefined);
    const after = await itemOf(b.id);
    assert.equal(after.workflowRunId, null);
    assert.equal(after.status, 'pending');
    assert.deepEqual(after.taskIds, []);
    assert.equal(await db.workflowRunsDb.get(run.id), undefined, `${at}: the run is deleted`);
    assert.equal((await stepRunsOf(run.id)).length, 0);
    assert.equal(await git.localBranchExists(projectDir, run.branch!), false, `${at}: the local branch is removed`);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(run.worktreePath!), false, `${at}: the worktree is removed`);
    assert.equal((await openApprovals(env)).length, 0, `${at}: no approval notice is left`);
  }
  const env = await makeEnv('Cancel queued');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await fillSlots(env, 6);
  await startChild(env, b);
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 1);
  await env.service.cancelWaiting(env.project.id, b.id);
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 0);
  assert.equal((await itemOf(b.id)).workflowRunId, null);
});

test('I15 I16 clearing or swapping parents during early UI Planning is allowed; a cleared task continues as a normal run after approval', async () => {
  const env = await makeEnv('Clear parents');
  const a = await parent(env);
  const d = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'approval');
  const runId = (await runOf(b.id))!.id;
  await env.service.setDependencies(env.project.id, b.id, [d.id]);
  await env.service.idle();
  assert.deepEqual((await itemOf(b.id)).dependsOn, [d.id]);
  assert.equal((await runOf(b.id))!.id, runId, 'I16: swapping a parent leaves the early run alone');
  await env.service.setDependencies(env.project.id, b.id, []);
  await env.service.idle();
  assert.equal((await runOf(b.id))!.status, 'awaiting-approval', 'nothing later runs before the approval');
  await env.manager.approveWorkflowRun(runId);
  await env.service.idle();
  await waitUntil(async () => (await stepRunsOf(runId)).some((s) => s.stepId === 'test-case-planning'), 'continued as a normal run');

  // A normally started task still cannot change its parents.
  await assert.rejects(env.service.setDependencies(env.project.id, b.id, [a.id]), /ready task that has not started/);
});

test('I17 a parent that fails blocks the child but keeps the held run', async () => {
  const env = await makeEnv('Blocked');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'approval');
  await env.manager.approveWorkflowRun((await runOf(b.id))!.id);
  await db.workflowRunsDb.update((await itemOf(a.id)).workflowRunId!, { status: 'failed' });
  await env.service.evaluateProject(env.project.id);
  await env.service.idle();
  assert.equal((await itemOf(b.id)).waiting?.state, 'blocked');
  assert.equal((await runOf(b.id))!.status, 'held');
  assert.ok((await notifications.listNotifications({ resolved: false })).some((n) => n.kind === 'dependency.blocked' && n.subject.type === 'autoMerge' && n.subject.planItemId === b.id));
  await db.workflowRunsDb.update((await itemOf(a.id)).workflowRunId!, { status: 'running' });
  await env.service.evaluateProject(env.project.id);
  await env.service.idle();
  assert.equal((await itemOf(b.id)).waiting?.state, 'waiting', 'retrying the parent returns the child to waiting');
});

test('I18 archiving or deleting a task discards its early run', async () => {
  const env = await makeEnv('Archive');
  const a = await parent(env);
  const archived = await task(env, { dependsOn: [a.id] });
  const deleted = await task(env, { dependsOn: [a.id] });
  await startChild(env, archived);
  await startChild(env, deleted);
  await waitUntil(statusIs(archived.id, 'awaiting-approval'), 'archived approval');
  await waitUntil(statusIs(deleted.id, 'awaiting-approval'), 'deleted approval');
  const archivedRun = (await runOf(archived.id))!;
  const deletedRun = (await runOf(deleted.id))!;
  const item = await env.manager.archivePlanItem(archived.id, true);
  assert.equal(item.archived, true);
  assert.equal(item.waiting, undefined);
  assert.equal(item.workflowRunId, null);
  assert.equal(await db.workflowRunsDb.get(archivedRun.id), undefined);
  await env.manager.deletePlanItem(deleted.id);
  assert.equal(await db.workflowRunsDb.get(deletedRun.id), undefined);
  const projectDir = projects.projectAbsolutePath(env.project);
  assert.equal(await git.localBranchExists(projectDir, archivedRun.branch!), false);
  assert.equal(await git.localBranchExists(projectDir, deletedRun.branch!), false);
});

test('I19 I31 turning the setting on takes a queued early start out of the line, off starts it, and it locks once UI Planning started', async () => {
  const env = await makeEnv('Toggle');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  const free = await fillSlots(env, 6);
  await startChild(env, b);
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 1);
  await env.service.setUiPlanningWaits(env.project.id, b.id, true);
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 0, 'on: out of the line');
  assert.equal((await itemOf(b.id)).workflowRunId, null);
  await free();
  await env.service.setUiPlanningWaits(env.project.id, b.id, false);
  await env.service.idle();
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'off: UI Planning started');
  // I31: the evaluation that started it ran first, so the toggle now finds it started.
  await assert.rejects(env.service.setUiPlanningWaits(env.project.id, b.id, true), /UI Planning has already started/);
});

test('I22 a held run survives a restart and continues once its parents merge', async () => {
  const env = await makeEnv('Restart');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'approval');
  await env.manager.approveWorkflowRun((await runOf(b.id))!.id);
  await env.service.idle();
  env.stop();
  const restarted = await makeEnv('Restart again');
  // The restarted daemon reads the same records; point it at the first project.
  const manager = restarted.manager;
  await manager.resumeInterruptedTasks();
  await manager.reconcileStalePlanItems();
  assert.equal((await runOf(b.id))!.status, 'held', 'not orphaned or flagged by the restart');
  const service2 = deps.createDependencyService({
    getProject: projects.getProject,
    git: { checkedOutBranch: async () => 'main', branchHead: async () => `commit-${a.id}`, isAncestor: async () => true, commitsAhead: async () => 1, pullRequest: async () => null },
    syncOf: () => null,
    startPlanItem: (id, options) => manager.enqueuePlanItemExecution(id, options),
    enableAutoMerge: async (_projectId, id) => (await db.planItemsDb.get(id))!,
    early: {
      earlyStepFor: (id, options) => manager.earlyStepForStart(id, options),
      startEarlyRun: (id, options) => manager.enqueuePlanItemExecution(id, { ...options, early: true }),
      queuedStartOf: async () => null,
      removeQueuedStart: async () => undefined,
      releaseHeldRun: (runId) => manager.releaseHeldRun(runId),
      discardEarlyRun: (runId) => manager.discardEarlyRun(runId),
    },
    onWorkerEvent: manager.onWorkerEvent,
    onProjectSync: () => () => undefined,
    publish: manager.publishEvent,
    schedule: () => () => undefined,
  });
  await db.workflowRunsDb.update((await itemOf(a.id)).workflowRunId!, { status: 'completed' });
  await service2.evaluateProject(env.project.id);
  await service2.idle();
  await waitUntil(async () => (await stepRunsOf((await runOf(b.id))!.id)).some((s) => s.stepId === 'test-case-planning'), 'continued after the restart');
});

test('I23 approve, request changes, resume and stop on a held run are refused', async () => {
  const env = await makeEnv('Held actions');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'approval');
  const runId = (await runOf(b.id))!.id;
  await env.manager.approveWorkflowRun(runId);
  await env.service.idle();
  for (const action of [
    () => env.manager.approveWorkflowRun(runId), () => env.manager.requestChangesWorkflowRun(runId, 'x'),
    () => env.manager.resumeWorkflowRun(runId), () => env.manager.stopWorkflowRun(runId),
  ]) await assert.rejects(action(), (error: Error) => error instanceof worker.WorkflowRunNotActionableError && /"held"/.test(error.message));
});

test('I26 I27 no early run for a workflow without the early step, with UI Planning unselected, or for an in-place start', async () => {
  const env = await makeEnv('No early');
  const a = await parent(env);
  const custom = await task(env, { dependsOn: [a.id] });
  const skipped = await task(env, { dependsOn: [a.id] });
  const inPlace = await task(env, { dependsOn: [a.id] });
  await startChild(env, custom, { workflowId: 'no-early-step' });
  await startChild(env, skipped, { skippedStepIds: ['ui-planning'] });
  await startChild(env, inPlace, { createBranch: false });
  for (const item of [custom, skipped, inPlace]) {
    assert.equal((await itemOf(item.id)).workflowRunId, null);
    assert.ok((await itemOf(item.id)).waiting);
  }
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 0);
  await mergeParent(env, a);
  await waitUntil(async () => (await runOf(skipped.id)) !== null, 'skipped started');
  assert.deepEqual((await runOf(skipped.id))!.skippedStepIds, ['ui-planning'], 'the waiting options replay skippedStepIds');
});

test('I33 repeated evaluations while early UI Planning runs never create a second run or queue entry', async () => {
  const env = await makeEnv('Idempotent');
  delete env.actions['ui-planning'];
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'running'), 'running');
  for (let i = 0; i < 4; i += 1) { await env.service.evaluateProject(env.project.id); await env.service.idle(); }
  assert.equal((await db.workflowRunsDb.find((run) => run.planItemId === b.id)).length, 1);
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 0);
});

test('I7 a released run never jumps the line: with tasks already queued it waits behind them', async () => {
  const env = await makeEnv('Line order');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'approval');
  const free = await fillSlots(env, 6);
  const plain = await task(env);
  const queued = await env.manager.enqueuePlanItemExecution(plain.id, {});
  assert.equal(queued.started, false);
  await mergeParent(env, a);
  await env.manager.approveWorkflowRun((await runOf(b.id))!.id);
  await env.service.idle();
  await waitUntil(async () => (await env.manager.listPlanItemQueue(env.project.id)).length === 2, 'two in line');
  const line = await env.manager.listPlanItemQueue(env.project.id);
  assert.deepEqual(line.map((entry) => entry.planItemId), [plain.id, b.id], 'the released run waits behind the earlier start');
  assert.equal(line[1]!.resumeRunId, (await runOf(b.id))!.id);
  await assert.rejects(env.manager.removeQueuedPlanItemExecution(line[1]!.id), /can't be taken out of the line/);
  await free();
  await waitUntil(async () => (await stepRunsOf((await runOf(b.id))!.id)).some((s) => s.stepId === 'test-case-planning'), 'continued once slots freed');
  assert.ok((await itemOf(plain.id)).workflowRunId, 'the earlier start went first');
});

test('I18 archiving a task whose approved UI plan was released but still waits for a slot discards the run and its place in line', async () => {
  const env = await makeEnv('Archive released');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  await startChild(env, b);
  await waitUntil(statusIs(b.id, 'awaiting-approval'), 'approval');
  const free = await fillSlots(env, 6);
  await mergeParent(env, a);
  await env.manager.approveWorkflowRun((await runOf(b.id))!.id);
  await env.service.idle();
  await waitUntil(async () => (await env.manager.listPlanItemQueue(env.project.id)).some((entry) => entry.resumeRunId), 'released and queued');
  const run = (await runOf(b.id))!;
  assert.equal(run.early?.released, true);
  assert.equal((await itemOf(b.id)).waiting, undefined);

  const archived = await env.manager.archivePlanItem(b.id, true);
  assert.equal(archived.archived, true);
  assert.equal(archived.workflowRunId, null);
  await free();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await db.workflowRunsDb.get(run.id), undefined, 'no run');
  assert.equal((await db.stepRunsDb.find((stepRun) => stepRun.runId === run.id && stepRun.stepId === 'test-case-planning')).length, 0, 'no Test Case Planning');
  assert.equal((await env.manager.listPlanItemQueue(env.project.id)).length, 0, 'no queue entry');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(run.worktreePath!), false, 'no worktree');
  assert.equal(await git.localBranchExists(projects.projectAbsolutePath(env.project), run.branch!), false, 'no branch');
});

test('I19 a refused early start is logged once, not on every evaluation', async () => {
  const env = await makeEnv('Refused early');
  const a = await parent(env);
  const b = await task(env, { dependsOn: [a.id] });
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const service = deps.createDependencyService({
      getProject: projects.getProject,
      git: { checkedOutBranch: async () => 'main', branchHead: async () => null, isAncestor: async () => false, commitsAhead: async () => 1, pullRequest: async () => null },
      syncOf: () => null,
      startPlanItem: async () => { throw new Error('not used'); },
      enableAutoMerge: async (_projectId, id) => (await db.planItemsDb.get(id))!,
      early: {
        earlyStepFor: async () => 'ui-planning',
        startEarlyRun: async () => { throw new Error('The workflow check failed'); },
        queuedStartOf: async () => null,
        removeQueuedStart: async () => undefined,
        releaseHeldRun: async () => false,
        discardEarlyRun: async () => undefined,
      },
      onWorkerEvent: () => () => undefined,
      onProjectSync: () => () => undefined,
      publish: () => undefined,
      schedule: () => () => undefined,
    });
    await service.startWhenReady(env.project.id, b.id, {});
    for (let i = 0; i < 3; i += 1) { await service.evaluateProject(env.project.id); await service.idle(); }
  } finally {
    console.error = original;
  }
  assert.equal(errors.filter((args) => String(args[0]).includes('Could not start the early UI Planning')).length, 1);
  assert.ok((await itemOf(b.id)).waiting, 'still waiting');
  await db.planItemsDb.update(b.id, { waiting: undefined });
});
