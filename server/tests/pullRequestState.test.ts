import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PlanItemRecord, ProjectRecord, WorkflowRunRecord } from '../src/domain/types.ts';
import type { BranchPullRequest } from '../src/projects/git.ts';
import type { PullRequestStateDeps, PullRequestStateService } from '../src/projects/pullRequestStateService.ts';
import type { WorkerEvent } from '../src/worker/workerManager.ts';
import { startPullRequestHarness, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/**
 * Task 10.022: the daemon reads each finished task's own pull request (open, merged, closed, none or
 * unknown) so an open one keeps the task in "PR not merged yet". The provider is faked at the lookup;
 * `ghBranchPullRequests` is covered separately against canned `gh` output.
 */

let h: PullRequestHarness;
let mod: typeof import('../src/projects/pullRequestStateService.ts');
let git: typeof import('../src/projects/git.ts');

before(async () => {
  h = await startPullRequestHarness('pr-state-');
  mod = await import('../src/projects/pullRequestStateService.ts');
  git = await import('../src/projects/git.ts');
});
after(async () => { await h.close(); });

type Answers = Record<string, BranchPullRequest | undefined>;
interface Fake { service: PullRequestStateService; calls: string[][]; events: WorkerEvent[]; answers: Answers; fail: { value: boolean }; sleeps: number[]; emit(event: WorkerEvent): void }

function makeService(overrides: Partial<PullRequestStateDeps> = {}): Fake {
  const calls: string[][] = [];
  const events: WorkerEvent[] = [];
  const sleeps: number[] = [];
  const answers: Answers = {};
  const fail = { value: false };
  let listener: ((event: WorkerEvent) => void) | null = null;
  const service = mod.createPullRequestStateService({
    getProject: h.projectService.getProject,
    listProjects: h.projectService.listProjects,
    lookup: async (_project, branches) => {
      calls.push(branches);
      if (fail.value) throw new Error('offline');
      const map = new Map<string, BranchPullRequest>();
      for (const branch of branches) { const answer = answers[branch]; if (answer) map.set(branch, answer); }
      return map;
    },
    onWorkerEvent: (next) => { listener = next; return () => { listener = null; }; },
    publish: (event) => { events.push(event); },
    sleep: async (ms) => { sleeps.push(ms); },
    ...overrides,
  });
  return { service, calls, events, answers, fail, sleeps, emit: (event) => listener?.(event) };
}

interface TaskOptions { branch?: string | null; baseBranch?: string | null; autoMerge?: boolean; runStatus?: WorkflowRunRecord['status']; prConflict?: boolean; itemConflict?: boolean; testingSetup?: boolean; archived?: boolean; pullRequest?: PlanItemRecord['pullRequest'] }

async function task(project: ProjectRecord, options: TaskOptions = {}): Promise<{ item: PlanItemRecord; branch: string }> {
  const now = new Date().toISOString();
  const itemId = randomUUID();
  const runId = randomUUID();
  const branch = options.branch ?? `feature/${itemId}`;
  await h.collections.workflowRunsDb.insert({
    id: runId, projectId: project.id, planItemId: itemId, workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'Software development', description: '', enabled: true, steps: [] },
    status: options.runStatus ?? 'completed', currentStepId: null, executorId: 'test-claude-cli', prUrl: null, completionReport: null,
    attentionReason: null, loopRoundAllowance: 0,
    ...(options.branch === null ? {} : { branch }),
    ...(options.baseBranch === null ? {} : { baseBranch: options.baseBranch ?? 'main' }),
    ...(options.prConflict ? { prConflict: { number: 1 } } : {}),
    createdAt: now, updatedAt: now, completedAt: now,
  } as unknown as WorkflowRunRecord);
  const item = await h.collections.planItemsDb.insert({
    id: itemId, projectId: project.id, title: 'T', description: '', status: 'done', order: 1, taskIds: [], milestoneId: null, workflowRunId: runId,
    createdAt: now, updatedAt: now,
    ...(options.archived ? { archived: true } : {}),
    ...(options.itemConflict ? { prConflict: { number: 1 } } : {}),
    ...(options.testingSetup ? { testingSetup: { mode: 'setup' } } : {}),
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.autoMerge ? { autoMerge: { enabled: true, state: 'waiting', reasons: [], warnings: [], prNumber: null, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: now } } : {}),
  } as unknown as PlanItemRecord);
  return { item, branch };
}

const readOf = async (item: PlanItemRecord) => (await h.collections.planItemsDb.get(item.id))!.pullRequest;
const planItemEvents = (fake: Fake) => fake.events.filter((event) => event.type === 'planItem');

test('every PR state the provider can answer is stored on the task, and announced', async () => {
  const project = await h.createProject('states');
  const fake = makeService();
  const tasks = await Promise.all((['open', 'merged', 'closed', 'none'] as const).map(async (state, index) => {
    const t = await task(project);
    fake.answers[t.branch] = { state, number: state === 'none' ? null : 10 + index };
    return { ...t, state, number: state === 'none' ? null : 10 + index };
  }));
  await fake.service.refreshProject(project.id);
  for (const t of tasks) assert.deepEqual({ state: (await readOf(t.item))?.state, number: (await readOf(t.item))?.prNumber }, { state: t.state, number: t.number });
  assert.equal(planItemEvents(fake).length, 4);
});

test('an unchanged reading is not announced again, and a changed one is', async () => {
  const project = await h.createProject('changes');
  const fake = makeService();
  const t = await task(project);
  fake.answers[t.branch] = { state: 'open', number: 5 };
  await fake.service.refreshProject(project.id);
  await fake.service.refreshProject(project.id);
  assert.equal(planItemEvents(fake).length, 1);
  fake.answers[t.branch] = { state: 'merged', number: 5 };
  await fake.service.refreshProject(project.id);
  assert.equal(planItemEvents(fake).length, 2);
  assert.equal((await readOf(t.item))?.state, 'merged');
});

test('a failed lookup (outage) changes nothing: the last reading stays and a never-read task stays unread', async () => {
  const project = await h.createProject('outage');
  const fake = makeService();
  const read = await task(project);
  const unread = await task(project);
  fake.answers[read.branch] = { state: 'open', number: 3 };
  await fake.service.refreshProject(project.id);
  fake.fail.value = true;
  await fake.service.refreshProject(project.id);
  assert.equal((await readOf(read.item))?.state, 'open');
  assert.equal(await readOf(unread.item), undefined);
  fake.fail.value = false;
  fake.answers[unread.branch] = { state: 'closed', number: 4 };
  await fake.service.refreshProject(project.id);
  assert.equal((await readOf(unread.item))?.state, 'closed');
});

test('a partial answer updates only the branches the provider answered', async () => {
  const project = await h.createProject('partial');
  const fake = makeService();
  const a = await task(project);
  const b = await task(project);
  fake.answers[a.branch] = { state: 'open', number: 1 };
  await fake.service.refreshProject(project.id);
  assert.equal((await readOf(a.item))?.state, 'open');
  assert.equal(await readOf(b.item), undefined);
});

test('tasks that own no pull request are never looked up', async () => {
  const project = await h.createProject('ineligible');
  const fake = makeService();
  await task(project, { autoMerge: true });
  await task(project, { itemConflict: true });
  await task(project, { prConflict: true });
  await task(project, { testingSetup: true });
  await task(project, { archived: true });
  await task(project, { runStatus: 'running' });
  await task(project, { branch: null });
  await task(project, { baseBranch: null });
  await task(project, { pullRequest: { state: 'merged', prNumber: 2, readAt: new Date().toISOString() } });
  await fake.service.refreshProject(project.id);
  assert.deepEqual(fake.calls, []);
});

test('a project without a linked repository is never looked up', async () => {
  const project = await h.createProject('norepo');
  await h.collections.projectsDb.update(project.id, { repositoryUrl: undefined } as Partial<ProjectRecord>);
  const fake = makeService();
  await task(project);
  await fake.service.refreshProject(project.id);
  assert.deepEqual(fake.calls, []);
});

test('lookups are batched, spaced, and capped per refresh; never-read tasks go first and the rest carry over', async () => {
  const project = await h.createProject('budget');
  const fake = makeService({ batchSize: 3, budgetPerRefresh: 7 });
  const tasks = [];
  for (let i = 0; i < 10; i += 1) tasks.push(await task(project));
  for (const t of tasks) fake.answers[t.branch] = { state: 'open', number: 1 };
  await fake.service.refreshProject(project.id);
  assert.deepEqual(fake.calls.map((c) => c.length), [3, 3, 1]);
  assert.equal(fake.sleeps.length, 2);
  await fake.service.refreshProject(project.id);
  const second = fake.calls.slice(3).flat();
  const first = new Set(fake.calls.slice(0, 3).flat());
  assert.equal(second.filter((branch) => !first.has(branch)).length >= 3, true, 'the three never-read tasks are asked first');
  const unread = await Promise.all(tasks.map((t) => readOf(t.item)));
  assert.equal(unread.filter((reading) => reading === undefined).length, 0);
});

test('a task that completes, or a merge from the PR tab, triggers a reading; overlapping refreshes coalesce', async () => {
  const project = await h.createProject('triggers');
  const fake = makeService();
  const stop = fake.service.start();
  try {
    const t = await task(project);
    fake.answers[t.branch] = { state: 'open', number: 8 };
    fake.emit({ type: 'workflowRun', run: { id: 'r', projectId: project.id, status: 'completed' } } as unknown as WorkerEvent);
    await fake.service.refreshProject(project.id);
    assert.equal((await readOf(t.item))?.state, 'open');
    fake.emit({ type: 'workflowRun', run: { id: 'r', projectId: project.id, status: 'running' } } as unknown as WorkerEvent);
  } finally { stop(); }
  const before = fake.calls.length;
  await Promise.all([fake.service.refreshProject(project.id), fake.service.refreshProject(project.id), fake.service.refreshProject(project.id)]);
  assert.ok(fake.calls.length - before <= 2, 'a burst costs at most one extra round');
});

test('a task archived or switched to Auto-merge while the provider answers is left alone', async () => {
  const project = await h.createProject('race');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fake = makeService({ lookup: async (_p, branches) => { await gate; return new Map(branches.map((b) => [b, { state: 'open' as const, number: 1 }])); } });
  const archived = await task(project);
  const switched = await task(project);
  const refreshing = fake.service.refreshProject(project.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await h.collections.planItemsDb.update(archived.item.id, { archived: true });
  await h.collections.planItemsDb.update(switched.item.id, { autoMerge: { enabled: true, state: 'waiting', reasons: [], warnings: [], prNumber: null, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: '' } });
  release();
  await refreshing;
  assert.equal(await readOf(archived.item), undefined);
  assert.equal(await readOf(switched.item), undefined);
});

test('refreshAll covers every project with a repository, and a missing project is ignored', async () => {
  const project = await h.createProject('all');
  const fake = makeService();
  const t = await task(project);
  fake.answers[t.branch] = { state: 'none', number: null };
  await fake.service.refreshAll();
  assert.equal((await readOf(t.item))?.state, 'none');
  await fake.service.refreshProject('missing-project');
});

test('ownBranchOf holds only a completed, non-Auto-merge task with its own branch', () => {
  const project = { repositoryUrl: 'https://github.com/o/r' };
  const item = { id: 'i' } as PlanItemRecord;
  const run = { status: 'completed', branch: 'b', baseBranch: 'main' } as WorkflowRunRecord;
  assert.equal(mod.ownBranchOf(project, item, run), 'b');
  assert.equal(mod.ownBranchOf(project, item, undefined), null);
  assert.equal(mod.ownBranchOf({ repositoryUrl: undefined }, item, run), null);
});

// ---- ghBranchPullRequests: the real `gh` call, with canned output ----

const node = (number: number, state: string, mergedAt: string | null = null, repo: string | null = 'Owner/repo') => ({ number, state, mergedAt, headRepository: repo ? { nameWithOwner: repo } : null });
const answer = (...perBranch: unknown[][]) => JSON.stringify({ data: { repository: Object.fromEntries(perBranch.map((nodes, i) => [`p${i}`, { nodes }])) } });

test('the newest PR of the branch decides; a merged one beats a closed state; none when there is no PR', async () => {
  const out = await git.ghBranchPullRequests('.', 'Owner/repo', ['a', 'b', 'c', 'd', 'e'], async () => answer(
    [node(5, 'CLOSED'), node(9, 'OPEN')],
    [node(7, 'CLOSED', '2026-01-01T00:00:00Z')],
    [node(3, 'CLOSED')],
    [],
    [node(2, 'MERGED')],
  ));
  assert.deepEqual([...out], [['a', { state: 'open', number: 9 }], ['b', { state: 'merged', number: 7 }], ['c', { state: 'closed', number: 3 }], ['d', { state: 'none', number: null }], ['e', { state: 'merged', number: 2 }]]);
});

test('a fork\'s PR from a same-named branch is not the task\'s own', async () => {
  const out = await git.ghBranchPullRequests('.', 'Owner/repo', ['main'], async () => answer([node(40, 'OPEN', null, 'stranger/repo'), node(41, 'OPEN', null, null)]));
  assert.deepEqual(out.get('main'), { state: 'none', number: null });
});

test('branch names travel as variables, never inside the query text, and the repository slug compares case-insensitively', async () => {
  const branches = ['a;b', '--x', 'with space', 'feature/ünï', 'x'.repeat(300)];
  let args: string[] = [];
  const out = await git.ghBranchPullRequests('.', 'owner/REPO', branches, async (_cwd, given) => { args = given; return answer(...branches.map(() => [node(2 ** 31, 'OPEN')])); });
  const query = args[args.indexOf('-f') + 1]!;
  for (const branch of branches) assert.ok(!query.includes(branch));
  branches.forEach((branch, i) => assert.ok(args.includes(`b${i}=${branch}`)));
  assert.equal(out.get('x'.repeat(300))?.number, 2 ** 31);
});

test('no branches means no call; unreadable or failing answers throw so the caller can treat them as unknown', async () => {
  assert.equal((await git.ghBranchPullRequests('.', 'o/r', [], async () => { throw new Error('called'); })).size, 0);
  for (const bad of ['not json', '{}', JSON.stringify({ data: { repository: { p0: {} } } })]) {
    await assert.rejects(() => git.ghBranchPullRequests('.', 'o/r', ['a'], async () => bad));
  }
  await assert.rejects(() => git.ghBranchPullRequests('.', 'o/r', ['a'], async () => { throw new git.GhError('gh not signed in'); }), /not signed in/);
});
