import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import type { DependentStartOptions, PlanItemRecord, ProjectRecord, ProjectSyncState, WorkflowRunRecord } from '../src/domain/types.ts';
import type { DependencyGit } from '../src/projects/dependencyGit.ts';
import type { DependencyDeps, DependencyService } from '../src/projects/dependencyService.ts';
import type { WorkerEvent } from '../src/worker/workerManager.ts';
import { startPullRequestHarness, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/**
 * Integration cases of task 10.018: the dependent-task service over fake git, fake runs and an
 * injected clock; the data and project come from the shared pull-request harness (no real task
 * is started).
 */

let h: PullRequestHarness;
let project: ProjectRecord;
let svc: typeof import('../src/projects/dependencyService.ts');
let notifications: typeof import('../src/notifications/notificationService.ts');

before(async () => {
  h = await startPullRequestHarness('dependency-service-');
  svc = await import('../src/projects/dependencyService.ts');
  notifications = await import('../src/notifications/notificationService.ts');
  project = await h.createProject('Dependencies');
});
after(async () => { await h.close(); });

const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  // Leftover waiting tasks of one test must not be evaluated by the next test's service.
  for (const item of await h.collections.planItemsDb.find((entry) => entry.waiting !== undefined)) {
    await h.collections.planItemsDb.update(item.id, { waiting: undefined });
  }
});

interface GitWorld {
  checkedOut: string | null;
  /** branch -> head commit */
  heads: Map<string, string>;
  /** commits present in the checked-out branch */
  present: Set<string>;
  aheadOf: Map<string, number>;
  prs: Map<string, { state: 'open' | 'closed' | 'merged'; mergeCommit: string | null }>;
}
const world = (): GitWorld => ({ checkedOut: 'main', heads: new Map(), present: new Set(), aheadOf: new Map(), prs: new Map() });
const fakeGit = (w: GitWorld): DependencyGit => ({
  checkedOutBranch: async () => w.checkedOut,
  branchHead: async (_p, branch) => w.heads.get(branch) ?? null,
  isAncestor: async (_p, commit) => w.present.has(commit),
  commitsAhead: async (_p, branch) => w.aheadOf.get(branch) ?? null,
  pullRequest: async (_p, branch) => w.prs.get(branch) ?? null,
});

interface Harness {
  service: DependencyService;
  w: GitWorld;
  clock: { now: number };
  starts: { id: string; options: DependentStartOptions }[];
  rejectStarts: { error: Error | null };
  events: WorkerEvent[];
  workerListeners: ((event: WorkerEvent) => void)[];
  syncListeners: ((projectId: string) => void)[];
  tick: () => void;
  sync: { state: ProjectSyncState | null };
  autoMerged: string[];
}

function makeService(overrides: Partial<DependencyDeps> = {}): Harness {
  const w = world();
  const clock = { now: Date.parse('2026-06-01T00:00:00.000Z') };
  const starts: Harness['starts'] = [];
  const rejectStarts: Harness['rejectStarts'] = { error: null };
  const events: WorkerEvent[] = [];
  const workerListeners: Harness['workerListeners'] = [];
  const syncListeners: Harness['syncListeners'] = [];
  const sync: Harness['sync'] = { state: null };
  const autoMerged: string[] = [];
  let tick: () => void = () => undefined;
  const service = svc.createDependencyService({
    getProject: h.projectService.getProject,
    git: fakeGit(w),
    syncOf: () => sync.state,
    startPlanItem: async (id, options) => {
      if (rejectStarts.error) throw rejectStarts.error;
      starts.push({ id, options });
      // What an accepted start does to the item.
      const run = await finishedRun(id, 'running');
      await h.collections.planItemsDb.update(id, { status: 'developing', workflowRunId: run.id, waiting: undefined });
      return { started: true, run };
    },
    enableAutoMerge: async (_projectId, id) => { autoMerged.push(id); return (await h.collections.planItemsDb.get(id))!; },
    onWorkerEvent: (listener) => { workerListeners.push(listener); return () => undefined; },
    onProjectSync: (listener) => { syncListeners.push(listener); return () => undefined; },
    publish: (event) => { events.push(event); },
    now: () => clock.now,
    schedule: (fn) => { tick = fn; return () => undefined; },
    ...overrides,
  });
  return { service, w, clock, starts, rejectStarts, events, workerListeners, syncListeners, tick: () => tick(), sync, autoMerged };
}

let counter = 0;

async function finishedRun(planItemId: string, status: WorkflowRunRecord['status'], extra: Partial<WorkflowRunRecord> = {}): Promise<WorkflowRunRecord> {
  const now = new Date().toISOString();
  return h.collections.workflowRunsDb.insert({
    id: randomUUID(), projectId: project.id, planItemId, workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'Software development', description: '', enabled: true, steps: [] },
    status, currentStepId: null, executorId: 'test-claude-cli', prUrl: null, completionReport: null, attentionReason: null,
    loopRoundAllowance: 0, createdAt: now, updatedAt: now, completedAt: status === 'completed' ? now : null, ...extra,
  });
}

async function readyTask(extra: Partial<PlanItemRecord> = {}): Promise<PlanItemRecord> {
  counter += 1;
  const now = new Date().toISOString();
  return h.collections.planItemsDb.insert({
    id: randomUUID(), projectId: project.id, title: `10.${String(counter).padStart(3, '0')}: Task ${counter}`, description: '', status: 'pending',
    order: counter, taskIds: [], milestoneId: null, workflowRunId: null, createdAt: now, updatedAt: now, ...extra,
  } as PlanItemRecord);
}

interface ParentOptions { world: GitWorld; status?: WorkflowRunRecord['status']; commit?: string; present?: boolean; autoMerge?: boolean; prUrl?: string | null; branch?: string | null; archived?: boolean }
/** A parent task with a run in the given state and a branch whose head is `commit`. */
async function parentTask(options: ParentOptions): Promise<PlanItemRecord> {
  const item = await readyTask({ status: 'developing', ...(options.archived ? { archived: true } : {}) });
  const commit = options.commit ?? `commit-${item.id}`;
  const branch = `task/${item.id}`;
  const run = await finishedRun(item.id, options.status ?? 'completed', {
    ...(options.branch === null ? {} : { branch, baseBranch: 'main' }),
    prUrl: options.prUrl === undefined ? 'https://github.com/test/repo/pull/1' : options.prUrl,
  });
  options.world.heads.set(branch, commit);
  if (options.present) options.world.present.add(commit);
  const autoMerge = options.autoMerge ? { enabled: true, state: 'waiting', reasons: [], warnings: [], prNumber: null, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: run.updatedAt } : undefined;
  return (await h.collections.planItemsDb.update(item.id, { workflowRunId: run.id, ...(autoMerge ? { autoMerge } : {}) } as Partial<PlanItemRecord>))!;
}

const reload = async (item: PlanItemRecord) => (await h.collections.planItemsDb.get(item.id))!;
const setMerged = (w: GitWorld, parent: PlanItemRecord, commit: string) => { w.heads.get(`task/${parent.id}`); w.present.add(commit); };
const active = async (item: PlanItemRecord) => (await notifications.listNotifications({ projectId: item.projectId })).filter((n) => n.subject.type === 'autoMerge' && n.subject.planItemId === item.id && n.resolvedAt === null);

async function waitingChild(t: Harness, parents: PlanItemRecord[], options: DependentStartOptions = { executorId: 'test-claude-cli' }, extra: Partial<PlanItemRecord> = {}) {
  const child = await readyTask(extra);
  await t.service.setDependencies(project.id, child.id, parents.map((parent) => parent.id));
  const result = await t.service.startWhenReady(project.id, child.id, options);
  return { child, result };
}

// ---- Validation and persistence ----

test('I2/I3 an unknown task, or one of another project, is a 404 (PlanItemNotFoundError)', async () => {
  const t = makeService();
  const child = await readyTask();
  await assert.rejects(() => t.service.setDependencies(project.id, child.id, ['missing']), { name: 'PlanItemNotFoundError' });
  await assert.rejects(() => t.service.setDependencies(project.id, 'missing', []), { name: 'PlanItemNotFoundError' });
  const other = await h.createProject('Other project');
  const foreign = await h.collections.planItemsDb.insert({ ...(await readyTask()), id: randomUUID(), projectId: other.id });
  await assert.rejects(() => t.service.setDependencies(project.id, child.id, [foreign.id]), { name: 'PlanItemNotFoundError' });
  await assert.rejects(() => t.service.setDependencies(project.id, foreign.id, []), { name: 'PlanItemNotFoundError' });
});

test('I1 malformed input is a DependencyInvalidError, checked before anything else', async () => {
  const t = makeService();
  const child = await readyTask();
  for (const bad of ['a', [1], [''], undefined]) {
    await assert.rejects(() => t.service.setDependencies(project.id, child.id, bad), { name: 'DependencyInvalidError' });
  }
});

test('I4/I5 a cycle and a self-dependency are conflicts; I6 adding to a started task is a conflict', async () => {
  const t = makeService();
  const a = await readyTask();
  const b = await readyTask();
  await t.service.setDependencies(project.id, b.id, [a.id]);
  await assert.rejects(() => t.service.setDependencies(project.id, a.id, [b.id]), { name: 'DependencyConflictError', message: /cycle/ });
  await assert.rejects(() => t.service.setDependencies(project.id, a.id, [a.id]), { name: 'DependencyConflictError', message: /itself/ });
  const started = await readyTask({ status: 'developing', workflowRunId: 'run' });
  await assert.rejects(() => t.service.setDependencies(project.id, started.id, [a.id]), { name: 'DependencyConflictError', message: /ready task/ });
});

test('I7 a project without a linked repository has no dependencies (409)', async () => {
  const t = makeService();
  const bare = await h.projectService.createProject({ name: 'No repo', position: null });
  const now = new Date().toISOString();
  const make = () => h.collections.planItemsDb.insert({ id: randomUUID(), projectId: bare.id, title: 'x', description: '', status: 'pending', order: 1, taskIds: [], milestoneId: null, workflowRunId: null, createdAt: now, updatedAt: now } as PlanItemRecord);
  const [a, b] = [await make(), await make()];
  await assert.rejects(() => t.service.setDependencies(bare.id, b.id, [a.id]), { name: 'DependencyConflictError', message: /linked repository/ });
});

test('I8 dependencies are added, removed and stored; I9 a task stored before this change has none', async () => {
  const t = makeService();
  const a = await readyTask();
  const b = await readyTask();
  assert.equal(a.dependsOn, undefined);
  const added = await t.service.setDependencies(project.id, b.id, [a.id, a.id]);
  assert.deepEqual(added.dependsOn, [a.id]);
  assert.deepEqual((await reload(b)).dependsOn, [a.id]);
  assert.ok(t.events.some((event) => event.type === 'planItem' && event.planItem.id === b.id));
  const removed = await t.service.setDependencies(project.id, b.id, []);
  assert.deepEqual(removed.dependsOn, []);
});

test('I30 the depth cap is enforced with a clear message', async () => {
  const t = makeService();
  const { MAX_DEPENDENCY_DEPTH } = await import('../src/projects/dependencies.ts');
  let previous = await readyTask();
  for (let i = 1; i < MAX_DEPENDENCY_DEPTH; i += 1) {
    const next = await readyTask();
    await t.service.setDependencies(project.id, next.id, [previous.id]);
    previous = next;
  }
  const tooDeep = await readyTask();
  await assert.rejects(() => t.service.setDependencies(project.id, tooDeep.id, [previous.id]), { message: new RegExp(`at most ${MAX_DEPENDENCY_DEPTH} tasks`) });
});

// ---- Start, waiting and cancel ----

test('I10 Start with an unsatisfied parent creates no run, stores the options and keeps the task in Planning', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const options = { executorId: 'test-claude-cli', workflowId: 'software-development', createBranch: true, skippedStepIds: ['review'] };
  const { child, result } = await waitingChild(t, [parent], options);
  assert.equal(result.started, false);
  const stored = await reload(child);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.workflowRunId, null);
  assert.equal(stored.waiting!.state, 'waiting');
  assert.deepEqual(stored.waiting!.options, options);
  assert.equal(stored.waiting!.reasons[0]!.text, `Waiting for #${/10\.(\d+)/.exec(parent.title)![0]} to finish`);
  assert.equal(t.starts.length, 0);
});

test('I10b Start with every parent satisfied starts at once with the given options', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, present: true });
  const child = await readyTask();
  await t.service.setDependencies(project.id, child.id, [parent.id]);
  const result = await t.service.startWhenReady(project.id, child.id, { executorId: 'test-claude-cli' });
  assert.equal(result.started, true);
  assert.deepEqual(t.starts, [{ id: child.id, options: { executorId: 'test-claude-cli' } }]);
});

test('31.003 a dependent task released while the Project is at its task limit joins the waiting list instead of failing', async () => {
  const entry = { id: 'entry-1', projectId: 'p', planItemId: 'c', createdAt: '2026-06-01T00:00:00.000Z' };
  const t = makeService({ startPlanItem: async () => ({ started: false, entry }) });
  const parent = await parentTask({ world: t.w, present: true });
  const child = await readyTask();
  await t.service.setDependencies(project.id, child.id, [parent.id]);
  const result = await t.service.startWhenReady(project.id, child.id, { executorId: 'test-claude-cli' });
  assert.equal(result.started, false);
  assert.deepEqual('entry' in result && result.entry, entry);
  assert.equal((await reload(child)).waiting, undefined, 'it no longer waits for its parents');
});

test('31.003 I15 a start with unsatisfied parents still waits for them and answers with the waiting item, not a queue entry', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const { child, result } = await waitingChild(t, [parent], { executorId: 'test-claude-cli' });
  assert.equal(result.started, false);
  assert.equal('entry' in result, false);
  assert.equal((await reload(child)).waiting?.state, 'waiting');
});

test('31.003 I16 parents merged later while the Project is full: the child joins the waiting list and stops waiting for parents', async () => {
  const entry = { id: 'entry-2', projectId: 'p', planItemId: 'c', createdAt: '2026-06-01T00:00:00.000Z' };
  const queued: string[] = [];
  const t = makeService({ startPlanItem: async (id) => { queued.push(id); return { started: false, entry }; } });
  const parent = await parentTask({ world: t.w, present: true, status: 'running' });
  const { child } = await waitingChild(t, [parent], { executorId: 'test-claude-cli' });
  await h.collections.workflowRunsDb.update(parent.workflowRunId!, { status: 'completed' });
  await t.service.evaluateProject(project.id);
  assert.deepEqual(queued, [child.id]);
  assert.equal((await reload(child)).waiting, undefined);
  await t.service.evaluateProject(project.id);
  assert.deepEqual(queued, [child.id], 'a queued child is not started a second time');
});

test('I11 a rejected immediate start leaves the task exactly where it was', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, present: true });
  const child = await readyTask();
  await t.service.setDependencies(project.id, child.id, [parent.id]);
  t.rejectStarts.error = new Error('usage limit reached');
  const before = await reload(child);
  await assert.rejects(() => t.service.startWhenReady(project.id, child.id, {}), /usage limit/);
  assert.deepEqual(await reload(child), before);
});

test('start-when-ready refuses a task without dependencies and one that already started', async () => {
  const t = makeService();
  const lone = await readyTask();
  await assert.rejects(() => t.service.startWhenReady(project.id, lone.id, {}), { name: 'DependencyConflictError', message: /no dependencies/ });
  const started = await readyTask({ status: 'developing', workflowRunId: 'run' });
  await assert.rejects(() => t.service.startWhenReady(project.id, started.id, {}), { name: 'DependencyConflictError' });
});

test('I12 Cancel waiting returns the task to plain ready with its position intact; cancelling when not waiting is a conflict', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const { child } = await waitingChild(t, [parent], {}, { planningQueueOrder: -42, planningGroupOrder: 3 });
  const cancelled = await t.service.cancelWaiting(project.id, child.id);
  assert.equal(cancelled.waiting, undefined);
  assert.equal(cancelled.planningQueueOrder, -42);
  assert.equal(cancelled.planningGroupOrder, 3);
  assert.deepEqual(cancelled.dependsOn, [parent.id]);
  await assert.rejects(() => t.service.cancelWaiting(project.id, child.id), { name: 'DependencyConflictError' });
  t.w.present.add(t.w.heads.get(`task/${parent.id}`)!);
  await t.service.evaluateProject(project.id);
  assert.equal(t.starts.length, 0);
});

// ---- Satisfaction through the service ----

test('U6/I36 a parent already merged before the dependency was added is satisfied at once, with auto-merge absent', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, present: true });
  const child = await readyTask();
  await t.service.setDependencies(project.id, child.id, [parent.id]);
  const status = await t.service.statusOf(project.id, child.id);
  assert.deepEqual(status.map((entry) => entry.satisfied), [true]);
});

test('U2 a squash merge: the last commit is absent but the PR merge commit is present', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w });
  t.w.prs.set(`task/${parent.id}`, { state: 'merged', mergeCommit: 'squash-commit' });
  const { child } = await waitingChild(t, [parent]);
  assert.match((await reload(child)).waiting!.reasons[0]!.text, /pull needed/);
  t.w.present.add('squash-commit');
  await t.service.evaluateProject(project.id);
  assert.equal(t.starts[0]!.id, child.id);
});

test('U5 a parent that finished with no commits and no PR is satisfied', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, prUrl: null });
  t.w.aheadOf.set(`task/${parent.id}`, 0);
  const child = await readyTask();
  await t.service.setDependencies(project.id, child.id, [parent.id]);
  assert.equal((await t.service.startWhenReady(project.id, child.id, {})).started, true);
});

test('a parent that ran in the project folder (no branch of its own) is satisfied', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, branch: null });
  const child = await readyTask();
  await t.service.setDependencies(project.id, child.id, [parent.id]);
  assert.equal((await t.service.startWhenReady(project.id, child.id, {})).started, true);
});

test('the waiting reasons follow the parent: toggle auto-merge, awaiting merge, pull needed with a blocker, wrong branch', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w });
  const { child } = await waitingChild(t, [parent]);
  const text = async () => (await reload(child)).waiting!.reasons[0]!;
  assert.equal((await text()).action, 'toggle-auto-merge');

  await h.collections.planItemsDb.update(parent.id, { autoMerge: { enabled: true, state: 'merging', reasons: [], warnings: [], prNumber: 1, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: '' } });
  await t.service.evaluateProject(project.id);
  assert.match((await text()).text, /to be merged$/);

  t.w.prs.set(`task/${parent.id}`, { state: 'merged', mergeCommit: 'm1' });
  t.sync.state = { projectId: project.id, branch: 'main', status: 'behind', aheadBy: 0, behindBy: 1, checkedAt: '', deferredReason: 'not pulled: a task is running in the main folder' };
  await t.service.evaluateProject(project.id);
  assert.match((await text()).text, /Waiting for main to receive .* \(pull needed\) \(not pulled: a task is running in the main folder\)/);
  assert.equal((await text()).action, 'sync');

  t.w.checkedOut = 'feature/x';
  await t.service.evaluateProject(project.id);
  assert.equal((await text()).text, 'Different branch checked out than main');
  assert.equal(t.starts.length, 0);
});

test('I27 checking out the right branch lets the child start', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, present: true });
  t.w.checkedOut = 'other';
  t.w.present.delete(t.w.heads.get(`task/${parent.id}`)!);
  t.w.prs.set(`task/${parent.id}`, { state: 'merged', mergeCommit: 'mc' });
  const { child } = await waitingChild(t, [parent]);
  t.service.start();
  assert.equal((await reload(child)).waiting!.reasons[0]!.text, 'Different branch checked out than main');
  t.w.checkedOut = 'main';
  t.w.present.add('mc');
  t.syncListeners.forEach((listener) => listener(project.id));
  await t.service.idle();
  assert.deepEqual(t.starts.map((s) => s.id), [child.id]);
});

// ---- Triggers, idempotency, ordering ----

test('I13/I18 a parent run event starts the child once, however often it is evaluated', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const { child } = await waitingChild(t, [parent], { executorId: 'x-agent' });
  t.service.start();
  await t.service.idle();
  stops.push(() => undefined);
  const run = await h.collections.workflowRunsDb.get(parent.workflowRunId!);
  await h.collections.workflowRunsDb.update(run!.id, { status: 'completed' });
  t.w.present.add(t.w.heads.get(`task/${parent.id}`)!);
  for (let i = 0; i < 5; i += 1) t.workerListeners.forEach((listener) => listener({ type: 'workflowRun', run: { ...run!, status: 'completed' } }));
  await Promise.all([t.service.evaluateProject(project.id), t.service.evaluateProject(project.id), t.service.evaluateProject(project.id)]);
  await t.service.idle();
  assert.deepEqual(t.starts, [{ id: child.id, options: { executorId: 'x-agent' } }]);
  const started = await reload(child);
  assert.equal(started.waiting, undefined);
  assert.equal(started.status, 'developing');
  assert.equal((await active(child)).filter((n) => n.kind === 'dependency.started').length, 1);
});

test('I14 a branch-sync event re-evaluates the project', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w });
  t.w.prs.set(`task/${parent.id}`, { state: 'merged', mergeCommit: 'pulled' });
  const { child } = await waitingChild(t, [parent]);
  t.service.start();
  t.w.present.add('pulled');
  t.syncListeners.forEach((listener) => listener(project.id));
  await t.service.idle();
  assert.deepEqual(t.starts.map((s) => s.id), [child.id]);
});

test('I15 removing the last blocker starts the child', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'failed' });
  const { child } = await waitingChild(t, [parent]);
  assert.equal((await reload(child)).waiting!.state, 'blocked');
  await t.service.setDependencies(project.id, child.id, []);
  await t.service.idle();
  assert.deepEqual(t.starts.map((s) => s.id), [child.id]);
});

test('I16 daemon start evaluates, and waiting tasks persisted by an earlier service resume', async () => {
  const first = makeService();
  const parent = await parentTask({ world: first.w, status: 'running' });
  const { child } = await waitingChild(first, [parent], { executorId: 'persisted' });
  const second = makeService();
  second.w.heads = first.w.heads;
  second.w.present = first.w.present;
  await h.collections.workflowRunsDb.update(parent.workflowRunId!, { status: 'completed' });
  second.w.present.add(first.w.heads.get(`task/${parent.id}`)!);
  second.service.start();
  await second.service.idle();
  assert.deepEqual(second.starts, [{ id: child.id, options: { executorId: 'persisted' } }]);
});

test('I17 the periodic check evaluates on the injected schedule', async () => {
  let scheduled: { ms: number } | null = null;
  const t = makeService({ schedule: (fn, ms) => { scheduled = { ms }; t.tick = fn; return () => undefined; } } as Partial<DependencyDeps>);
  const parent = await parentTask({ world: t.w });
  const { child } = await waitingChild(t, [parent]);
  t.service.start();
  await t.service.idle();
  assert.equal(scheduled!.ms, 30_000);
  assert.equal(t.starts.length, 0);
  t.w.present.add(t.w.heads.get(`task/${parent.id}`)!);
  t.tick();
  await t.service.idle();
  assert.deepEqual(t.starts.map((s) => s.id), [child.id]);
});

test('I20/U25 several children becoming ready start in planning order, then task number', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const late = (await waitingChild(t, [parent], {}, { planningQueueOrder: 9 })).child;
  const second = (await waitingChild(t, [parent], {}, { planningQueueOrder: 1, planningGroupOrder: 2, planningRef: { session: 4, task: 2 } })).child;
  const first = (await waitingChild(t, [parent], {}, { planningQueueOrder: 1, planningGroupOrder: 1, planningRef: { session: 4, task: 3 } })).child;
  t.w.present.add(t.w.heads.get(`task/${parent.id}`)!);
  await h.collections.workflowRunsDb.update(parent.workflowRunId!, { status: 'completed' });
  await t.service.evaluateProject(project.id);
  assert.deepEqual(t.starts.map((s) => s.id), [first.id, second.id, late.id]);
});

test('I21 a rejected automatic start leaves the child Waiting with the reason and retries at the next evaluation', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, present: true, status: 'running' });
  const { child } = await waitingChild(t, [parent], { executorId: 'limited' });
  await h.collections.workflowRunsDb.update(parent.workflowRunId!, { status: 'completed' });
  t.rejectStarts.error = new Error('The usage limit of "Claude" is reached.');
  await t.service.evaluateProject(project.id);
  const waiting = (await reload(child)).waiting!;
  assert.equal(waiting.state, 'waiting');
  assert.match(waiting.reasons[0]!.text, /Could not start yet: .*usage limit/);
  const stamp = (await reload(child)).updatedAt;
  await t.service.evaluateProject(project.id);
  assert.equal((await reload(child)).updatedAt, stamp);
  t.rejectStarts.error = null;
  await t.service.evaluateProject(project.id);
  assert.deepEqual(t.starts.map((s) => s.id), [child.id]);
});

test('U30 evaluating twice on the same input changes nothing and requests no second start', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const { child } = await waitingChild(t, [parent]);
  const before = await reload(child);
  await t.service.evaluateProject(project.id);
  await t.service.evaluateProject(project.id);
  assert.deepEqual(await reload(child), before);
  assert.equal(t.starts.length, 0);
});

// ---- Blocked chains and parent changes ----

test('I22/I23 a failed parent blocks and notifies once; resuming the parent lets the child proceed', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'failed' });
  const { child } = await waitingChild(t, [parent]);
  assert.equal((await reload(child)).waiting!.state, 'blocked');
  await t.service.evaluateProject(project.id);
  await t.service.evaluateProject(project.id);
  const blocked = (await active(child)).filter((n) => n.kind === 'dependency.blocked');
  assert.equal(blocked.length, 1);
  assert.match(blocked[0]!.description, /parent #10\.\d+ failed/);
  await h.collections.workflowRunsDb.update(parent.workflowRunId!, { status: 'running' });
  await t.service.evaluateProject(project.id);
  assert.equal((await reload(child)).waiting!.state, 'waiting');
  assert.equal((await active(child)).filter((n) => n.kind === 'dependency.blocked').length, 0);
  await h.collections.workflowRunsDb.update(parent.workflowRunId!, { status: 'completed' });
  t.w.present.add(t.w.heads.get(`task/${parent.id}`)!);
  await t.service.evaluateProject(project.id);
  assert.equal(t.starts.length, 1);
});

test('I24/U16/U26 a deleted parent blocks the child, the dependency record stays, and the child never starts silently', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const { child } = await waitingChild(t, [parent]);
  t.service.start();
  await h.collections.planItemsDb.delete(parent.id);
  t.workerListeners.forEach((listener) => listener({ type: 'planItemDeleted', id: parent.id, projectId: project.id }));
  await t.service.idle();
  const stored = await reload(child);
  assert.equal(stored.waiting!.state, 'blocked');
  assert.equal(stored.waiting!.reasons[0]!.text, 'Blocked: a parent task was deleted');
  assert.deepEqual(stored.dependsOn, [parent.id]);
  assert.equal(t.starts.length, 0);
  await t.service.setDependencies(project.id, child.id, []);
  await t.service.idle();
  assert.equal(t.starts.length, 1);
});

test('U15 an archived-unmerged parent blocks the child', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, archived: true });
  const { child } = await waitingChild(t, [parent]);
  assert.match((await reload(child)).waiting!.reasons[0]!.text, /archived without being merged/);
});

test('I25 a parent re-run after being satisfied sends a waiting child back to waiting', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, present: true });
  const second = await parentTask({ world: t.w, status: 'running' });
  const { child } = await waitingChild(t, [parent, second]);
  assert.equal((await reload(child)).waiting!.reasons.length, 1);
  await h.collections.workflowRunsDb.update(parent.workflowRunId!, { status: 'running' });
  await t.service.evaluateProject(project.id);
  assert.equal((await reload(child)).waiting!.reasons.length, 2);
  assert.equal(t.starts.length, 0);
});

test('U17 every parent must be satisfied: diamond shapes start the grandchild last', async () => {
  const t = makeService();
  const root = await parentTask({ world: t.w, present: true });
  const left = await parentTask({ world: t.w, present: true });
  const right = await parentTask({ world: t.w });
  const { child } = await waitingChild(t, [left, right]);
  assert.equal(t.starts.length, 0);
  assert.equal(root.dependsOn, undefined);
  t.w.present.add(t.w.heads.get(`task/${right.id}`)!);
  await t.service.evaluateProject(project.id);
  assert.deepEqual(t.starts.map((s) => s.id), [child.id]);
});

test('I35 deleting or cancelling a waiting child means it never starts', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const { child } = await waitingChild(t, [parent]);
  await h.collections.planItemsDb.delete(child.id);
  await h.collections.workflowRunsDb.update(parent.workflowRunId!, { status: 'completed' });
  t.w.present.add(t.w.heads.get(`task/${parent.id}`)!);
  await t.service.evaluateProject(project.id);
  assert.equal(t.starts.length, 0);
});

test('I32 events are published for waiting, blocked and started', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'failed' });
  const { child } = await waitingChild(t, [parent]);
  const published = () => t.events.filter((event) => event.type === 'planItem' && event.planItem.id === child.id).map((event) => (event as { planItem: PlanItemRecord }).planItem.waiting?.state);
  assert.ok(published().includes('blocked'));
});

// ---- Notifications ----

test('I33/U29 a manual-merge wait notifies once at 30 minutes and not before', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w });
  const { child } = await waitingChild(t, [parent]);
  const longWaits = async () => (await active(child)).filter((n) => n.kind === 'dependency.long_wait');
  t.clock.now += 30 * 60_000 - 1_000;
  await t.service.evaluateProject(project.id);
  assert.equal((await longWaits()).length, 0);
  t.clock.now += 1_000;
  await t.service.evaluateProject(project.id);
  assert.equal((await longWaits()).length, 1);
  assert.equal((await reload(child)).waiting!.longWaitNotified, true);
  t.clock.now += 60 * 60_000;
  await t.service.evaluateProject(project.id);
  assert.equal((await longWaits()).length, 1);
});

test('a wait on a running parent never counts as a long manual wait', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'running' });
  const { child } = await waitingChild(t, [parent]);
  t.clock.now += 5 * 60 * 60_000;
  await t.service.evaluateProject(project.id);
  assert.equal((await active(child)).length, 0);
});

test('cancelling resolves the task\'s dependency notifications', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w, status: 'failed' });
  const { child } = await waitingChild(t, [parent]);
  assert.equal((await active(child)).length, 1);
  await t.service.cancelWaiting(project.id, child.id);
  assert.equal((await active(child)).length, 0);
});

// ---- Chain shortcut ----

test('I31 chain: every ready task depends on the previous one, optionally with auto-merge; order and titles are unchanged', async () => {
  const t = makeService();
  const session = 700 + counter;
  const tasks = [];
  for (let i = 1; i <= 3; i += 1) tasks.push(await readyTask({ planningRef: { session, task: i }, planningGroupOrder: i }));
  const started = await readyTask({ status: 'developing', workflowRunId: 'r', planningRef: { session, task: 4 }, planningGroupOrder: 4 });
  const snapshot = (await Promise.all([...tasks, started].map(reload))).map(({ title, order, planningGroupOrder, planningRef }) => ({ title, order, planningGroupOrder, planningRef }));
  const result = await t.service.chainGroup(project.id, session, true);
  assert.equal(result.length, 4);
  assert.deepEqual((await reload(tasks[1]!)).dependsOn, [tasks[0]!.id]);
  assert.deepEqual((await reload(tasks[2]!)).dependsOn, [tasks[1]!.id]);
  assert.equal((await reload(tasks[0]!)).dependsOn, undefined);
  assert.equal((await reload(started)).dependsOn, undefined);
  assert.deepEqual(t.autoMerged.sort(), tasks.map((task) => task.id).sort());
  assert.deepEqual((await Promise.all([...tasks, started].map(reload))).map(({ title, order, planningGroupOrder, planningRef }) => ({ title, order, planningGroupOrder, planningRef })), snapshot);
  const without = makeService();
  await without.service.chainGroup(project.id, session, false);
  assert.deepEqual(without.autoMerged, []);
});

test('chain on a group with fewer than two ready tasks changes nothing', async () => {
  const t = makeService();
  const session = 900 + counter;
  const only = await readyTask({ planningRef: { session, task: 1 } });
  await t.service.chainGroup(project.id, session, false);
  assert.equal((await reload(only)).dependsOn, undefined);
});

test('a chain whose auto-merge cannot be turned on saves no dependency; a chain evaluates waiting tasks afterwards', async () => {
  const t = makeService({ enableAutoMerge: async () => { throw new Error('This project has no linked repository'); } });
  const session = 1_200 + counter;
  const first = await readyTask({ planningRef: { session, task: 1 }, planningGroupOrder: 1 });
  const second = await readyTask({ planningRef: { session, task: 2 }, planningGroupOrder: 2 });
  await assert.rejects(() => t.service.chainGroup(project.id, session, true), /linked repository/);
  assert.equal((await reload(second)).dependsOn, undefined);
  const ok = makeService();
  await ok.service.chainGroup(project.id, session, false);
  await ok.service.idle();
  assert.deepEqual((await reload(second)).dependsOn, [first.id]);
});

test('a chain leaves an already waiting task alone', async () => {
  const t = makeService();
  const session = 1_400 + counter;
  const parent = await parentTask({ world: t.w, status: 'running' });
  const a = await readyTask({ planningRef: { session, task: 1 }, planningGroupOrder: 1 });
  const { child: waiter } = await waitingChild(t, [parent], {}, { planningRef: { session, task: 2 }, planningGroupOrder: 2 });
  const b = await readyTask({ planningRef: { session, task: 3 }, planningGroupOrder: 3 });
  await t.service.chainGroup(project.id, session, false);
  assert.deepEqual((await reload(waiter)).dependsOn, [parent.id]);
  assert.deepEqual((await reload(b)).dependsOn, [a.id]);
});

test('a rejected automatic start does not reset the long-wait clock', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w });
  const { child } = await waitingChild(t, [parent]);
  const since = (await reload(child)).waiting!.manualWaitSince;
  assert.ok(since);
  t.clock.now += 10 * 60_000;
  t.w.present.add(t.w.heads.get(`task/${parent.id}`)!);
  t.rejectStarts.error = new Error('usage limit reached');
  await t.service.evaluateProject(project.id);
  const waiting = (await reload(child)).waiting!;
  assert.match(waiting.reasons[0]!.text, /Could not start yet/);
  assert.equal(waiting.manualWaitSince, since);
});

// ---- Bugs in dependency chains (task 27.001) ----

const bugAttributes = { severity: null, infoStatus: 'needs-more-info', introducedBy: null, suspectedLocation: null, foundWhileWorkingOn: null, reportSessionNumber: null, testRef: null, groupOrder: null, regressions: [] };
const readyBug = (extra: Partial<PlanItemRecord> = {}) => readyTask({ type: 'bug', bug: bugAttributes as PlanItemRecord['bug'], ...extra });

test('SI27 SI19 a bug is a child and a parent: dependencies are set and listed with the same labels', async () => {
  const t = makeService();
  const task = await readyTask();
  const bug = await readyBug({ title: 'B.004: Crash on save' });
  const bugChild = await readyBug();
  assert.deepEqual((await t.service.setDependencies(project.id, bugChild.id, [task.id, bug.id])).dependsOn, [task.id, bug.id]);
  const taskChild = await readyTask();
  await t.service.setDependencies(project.id, taskChild.id, [bug.id]);
  const status = await t.service.statusOf(project.id, taskChild.id);
  assert.equal(status[0]!.label, '#B.004');
  assert.equal(status[0]!.satisfied, false);
  await assert.rejects(() => t.service.setDependencies(project.id, bug.id, [taskChild.id]), { name: 'DependencyConflictError', message: /cycle/ }, 'a cycle through a bug');
});

test('SI29 SI30 a ready bug waits for a task parent and starts by itself once it is merged', async () => {
  const t = makeService();
  const parent = await parentTask({ world: t.w });
  const { child, result } = await waitingChild(t, [parent], { executorId: 'test-claude-cli', workflowId: 'bug-fix' }, { type: 'bug', bug: bugAttributes as PlanItemRecord['bug'] });
  assert.equal(result.started, false);
  assert.equal((await reload(child)).status, 'pending', 'stays in Planning until accepted');
  assert.equal((await reload(child)).waiting!.state, 'waiting');
  t.w.present.add(t.w.heads.get(`task/${parent.id}`)!);
  await t.service.evaluateProject(project.id);
  assert.deepEqual(t.starts, [{ id: child.id, options: { executorId: 'test-claude-cli', workflowId: 'bug-fix' } }]);
  const started = (await notifications.listNotifications({ projectId: project.id })).find((n) => n.kind === 'dependency.started' && n.subject.type === 'autoMerge' && n.subject.planItemId === child.id);
  assert.ok(started, 'the started notification is raised for a bug');
});

test('SI31 a task waits for a bug parent and starts when the bug is merged', async () => {
  const t = makeService();
  const bug = await parentTask({ world: t.w });
  await h.collections.planItemsDb.update(bug.id, { type: 'bug', bug: bugAttributes as PlanItemRecord['bug'] });
  const { child } = await waitingChild(t, [bug]);
  assert.equal(t.starts.length, 0);
  t.w.present.add(t.w.heads.get(`task/${bug.id}`)!);
  await t.service.evaluateProject(project.id);
  assert.equal(t.starts[0]!.id, child.id);
});

test('SI28 SI32 SI33 a failed or deleted bug parent blocks the child with the usual actions and notifies', async () => {
  const t = makeService();
  const failed = await parentTask({ world: t.w, status: 'failed' });
  await h.collections.planItemsDb.update(failed.id, { type: 'bug', bug: bugAttributes as PlanItemRecord['bug'] });
  const { child } = await waitingChild(t, [failed]);
  const waiting = (await reload(child)).waiting!;
  assert.equal(waiting.state, 'blocked');
  assert.equal(waiting.reasons[0]!.action, 'retry-parent');
  assert.equal((await active(child)).filter((n) => n.kind === 'dependency.blocked').length, 1);

  const doomed = await readyBug();
  const { child: other } = await waitingChild(t, [doomed]);
  await h.collections.planItemsDb.delete(doomed.id);
  await t.service.evaluateProject(project.id);
  const blocked = (await reload(other)).waiting!;
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.reasons[0]!.action, 'remove-dependency');
  assert.match(blocked.reasons[0]!.text, /a parent task was deleted/);
});

test('SI36 Chain tasks links the session\'s tasks and leaves its bugs alone', async () => {
  const t = makeService();
  const session = 700 + counter;
  const planningRef = (task: number) => ({ session, task });
  const first = await readyTask({ planningRef: planningRef(1) });
  const bug = await readyBug({ planningRef: planningRef(2) });
  const second = await readyTask({ planningRef: planningRef(3) });
  const updated = await t.service.chainGroup(project.id, session, false);
  assert.deepEqual(updated.find((item) => item.id === second.id)!.dependsOn, [first.id]);
  assert.equal((await reload(bug)).dependsOn, undefined);
});
