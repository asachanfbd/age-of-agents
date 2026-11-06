import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { PlanItemRecord, ProjectRecord } from '../src/domain/types.ts';
import { startPullRequestHarness, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/** Integration cases I1 to I12 and I31 of task 10.018: the dependent-task routes over HTTP, with a fake git that reports no parent as merged. */

let h: PullRequestHarness;
let server: HttpServer;
let base: string;
let project: ProjectRecord;
let started: string[];

before(async () => {
  h = await startPullRequestHarness('dependency-api-');
  const { createDependencyService } = await import('../src/projects/dependencyService.ts');
  const { createDaemonServer } = await import('../src/server.ts');
  started = [];
  const service = createDependencyService({
    getProject: h.projectService.getProject,
    git: { checkedOutBranch: async () => 'main', branchHead: async () => null, isAncestor: async () => false, commitsAhead: async () => null, pullRequest: async () => null },
    syncOf: () => null,
    startPlanItem: async (id) => { started.push(id); throw new Error('no real runs in this test'); },
    enableAutoMerge: async (_projectId, id) => (await h.collections.planItemsDb.get(id))!,
    onWorkerEvent: () => () => undefined,
    onProjectSync: () => () => undefined,
    publish: () => undefined,
  });
  server = createDaemonServer({ pullRequests: h.pullRequests, dependencies: service });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  base = `http://127.0.0.1:${address.port}`;
  project = await h.createProject('Dependency API');
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
});

async function call(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const itemPath = (target: ProjectRecord, id: string, suffix: string) => `/api/projects/${target.id}/plan-items/${encodeURIComponent(id)}/${suffix}`;
const putDeps = (target: ProjectRecord, id: string, body: unknown) => call(itemPath(target, id, 'dependencies'), { method: 'PUT', body: JSON.stringify(body) });

let counter = 0;
async function task(target: ProjectRecord, extra: Partial<PlanItemRecord> = {}): Promise<PlanItemRecord> {
  counter += 1;
  const now = new Date().toISOString();
  return h.collections.planItemsDb.insert({
    id: randomUUID(), projectId: target.id, title: `10.${counter}: API task ${counter}`, description: '', status: 'pending', order: counter,
    taskIds: [], milestoneId: null, workflowRunId: null, createdAt: now, updatedAt: now, ...extra,
  } as PlanItemRecord);
}

test('I1 a malformed body is a 400', async () => {
  const child = await task(project);
  for (const body of [{}, { dependsOn: 'a' }, { dependsOn: [1] }, { dependsOn: [''] }, { dependsOn: ['  '] }, { dependsOn: Array.from({ length: 10_000 }, (_, i) => `t${i}`) }]) {
    assert.equal((await putDeps(project, child.id, body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await call(itemPath(project, child.id, 'dependencies'), { method: 'PUT', body: 'not json' })).status, 400);
});

test('I2/I3 an unknown task, or one of another project, is a 404', async () => {
  const child = await task(project);
  assert.equal((await putDeps(project, child.id, { dependsOn: ['missing'] })).status, 404);
  assert.equal((await putDeps(project, 'missing', { dependsOn: [] })).status, 404);
  const other = await h.createProject('Dependency API other');
  const foreign = await task(other);
  assert.equal((await putDeps(project, child.id, { dependsOn: [foreign.id] })).status, 404);
  assert.equal((await putDeps(project, foreign.id, { dependsOn: [] })).status, 404);
});

test('I4/I5/I6 a cycle, a self-dependency and a started task are 409', async () => {
  const a = await task(project);
  const b = await task(project);
  assert.equal((await putDeps(project, b.id, { dependsOn: [a.id] })).status, 200);
  assert.equal((await putDeps(project, a.id, { dependsOn: [b.id] })).status, 409);
  assert.equal((await putDeps(project, a.id, { dependsOn: [a.id] })).status, 409);
  const running = await task(project, { status: 'developing', workflowRunId: 'run' });
  assert.equal((await putDeps(project, running.id, { dependsOn: [a.id] })).status, 409);
});

test('I7 a project without a linked repository answers 409', async () => {
  const bare = await h.projectService.createProject({ name: 'Dependency API bare', position: null });
  const [a, b] = [await task(bare), await task(bare)];
  const res = await putDeps(bare, b.id, { dependsOn: [a.id] });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /linked repository/);
});

test('I8/I30 add and remove return the task; GET shows each parent and why it is not satisfied', async () => {
  const parent = await task(project, { status: 'developing', workflowRunId: null });
  const child = await task(project);
  const added = await putDeps(project, child.id, { dependsOn: [parent.id, parent.id] });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.dependsOn, [parent.id]);
  const status = await call(itemPath(project, child.id, 'dependencies'));
  assert.equal(status.status, 200);
  assert.equal(status.body[0].id, parent.id);
  assert.equal(status.body[0].satisfied, false);
  assert.match(status.body[0].reason.text, /^Waiting for #10\.\d+ to finish$/);
  assert.deepEqual((await putDeps(project, child.id, { dependsOn: [] })).body.dependsOn, []);
});

test('I10/I12 Start waits (202) with the stored options; Cancel waiting clears it (200), and a second cancel is 409', async () => {
  const parent = await task(project, { status: 'developing' });
  const child = await task(project, { planningQueueOrder: -7 });
  await putDeps(project, child.id, { dependsOn: [parent.id] });
  const res = await call(itemPath(project, child.id, 'start-when-ready'), { method: 'POST', body: JSON.stringify({ executorId: 'test-claude-cli' }) });
  assert.equal(res.status, 202);
  assert.equal(res.body.started, false);
  assert.deepEqual(res.body.item.waiting.options, { executorId: 'test-claude-cli' });
  assert.equal(res.body.item.status, 'pending');
  assert.equal((await putDeps(project, child.id, { dependsOn: [] })).status, 200);
  const cancelled = await call(itemPath(project, child.id, 'cancel-waiting'), { method: 'POST' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.waiting, undefined);
  assert.equal(cancelled.body.planningQueueOrder, -7);
  assert.equal((await call(itemPath(project, child.id, 'cancel-waiting'), { method: 'POST' })).status, 409);
});

test('start-when-ready validates its options (400) and refuses a task without dependencies (409)', async () => {
  const lone = await task(project);
  assert.equal((await call(itemPath(project, lone.id, 'start-when-ready'), { method: 'POST', body: JSON.stringify({ executorId: 'nope' }) })).status, 400);
  assert.equal((await call(itemPath(project, lone.id, 'start-when-ready'), { method: 'POST', body: '{}' })).status, 409);
});

test('I11 a rejected immediate start is an error and leaves the task unchanged', async () => {
  const done = await task(project, { status: 'developing', workflowRunId: null });
  // A parent with no run is never satisfied, so give the child a parent the fake git cannot satisfy: use a no-commit run.
  const now = new Date().toISOString();
  const runId = randomUUID();
  await h.collections.workflowRunsDb.insert({
    id: runId, projectId: project.id, planItemId: done.id, workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'Software development', description: '', enabled: true, steps: [] },
    status: 'completed', currentStepId: null, executorId: 'test-claude-cli', prUrl: null, completionReport: null,
    attentionReason: null, loopRoundAllowance: 0, createdAt: now, updatedAt: now, completedAt: now,
  });
  await h.collections.planItemsDb.update(done.id, { workflowRunId: runId });
  const child = await task(project);
  await putDeps(project, child.id, { dependsOn: [done.id] });
  const before = await h.collections.planItemsDb.get(child.id);
  const res = await call(itemPath(project, child.id, 'start-when-ready'), { method: 'POST', body: '{}' });
  assert.ok(res.status >= 400);
  assert.deepEqual(await h.collections.planItemsDb.get(child.id), before);
  assert.ok(started.includes(child.id));
});

test('a dependent or waiting task cannot be started through the plain execute route', async () => {
  const parent = await task(project);
  const child = await task(project, { dependsOn: [parent.id] });
  const res = await call(`/api/plan-items/${child.id}/execute`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /start-when-ready/);
});

test('I31 chain: 400 for a bad session or autoMerge, 200 with the chained group', async () => {
  const session = 5_000 + counter;
  const first = await task(project, { planningRef: { session, task: 1 }, planningGroupOrder: 1 });
  const second = await task(project, { planningRef: { session, task: 2 }, planningGroupOrder: 2 });
  assert.equal((await call(`/api/projects/${project.id}/planning-groups/abc/chain`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await call(`/api/projects/${project.id}/planning-groups/${session}/chain`, { method: 'POST', body: JSON.stringify({ autoMerge: 'yes' }) })).status, 400);
  const res = await call(`/api/projects/${project.id}/planning-groups/${session}/chain`, { method: 'POST', body: JSON.stringify({ autoMerge: true }) });
  assert.equal(res.status, 200);
  const byId = new Map(res.body.map((item: PlanItemRecord) => [item.id, item]));
  assert.deepEqual((byId.get(second.id) as PlanItemRecord).dependsOn, [first.id]);
  assert.equal((byId.get(first.id) as PlanItemRecord).dependsOn, undefined);
});
