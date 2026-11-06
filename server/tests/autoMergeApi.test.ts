import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { PlanItemRecord, ProjectRecord } from '../src/domain/types.ts';
import { startPullRequestHarness, waitUntil, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/** Integration cases I54 to I66 of task 10.017: the Auto-merge routes over HTTP. */

let h: PullRequestHarness;
let server: HttpServer;
let base: string;
let project: ProjectRecord;
let svc: typeof import('../src/projects/autoMergeService.ts');
let service: import('../src/projects/autoMergeService.ts').AutoMergeService;

before(async () => {
  h = await startPullRequestHarness('auto-merge-api-');
  svc = await import('../src/projects/autoMergeService.ts');
  const actions = await import('../src/projects/pullRequestActions.ts');
  const { createDaemonServer } = await import('../src/server.ts');
  service = svc.createAutoMergeService({
    getProject: h.projectService.getProject,
    readPullRequest: actions.readPullRequest,
    mergePullRequest: actions.mergePullRequest,
    startConflictRun: h.manager.startConflictRun,
    activeConflictRun: h.manager.activeConflictRun,
    latestConflictRun: h.manager.latestConflictRun,
    executorUnavailableReason: async () => null,
    onWorkerEvent: h.manager.onWorkerEvent,
    publish: () => undefined,
    runPollMs: 10,
  });
  server = createDaemonServer({ pullRequests: h.pullRequests, autoMerge: service });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  base = `http://127.0.0.1:${address.port}`;
  project = await h.createProject('Auto-merge API');
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
const put = (target: ProjectRecord, id: string, body: unknown) =>
  call(`/api/projects/${target.id}/plan-items/${encodeURIComponent(id)}/auto-merge`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
const retry = (target: ProjectRecord, id: string) => call(`/api/projects/${target.id}/plan-items/${encodeURIComponent(id)}/auto-merge/retry`, { method: 'POST' });

let counter = 3000;
async function task(target: ProjectRecord, options: { withRun?: boolean; branch?: boolean; pr?: Record<string, unknown> } = {}): Promise<{ id: string; number: number }> {
  counter += 1;
  const number = counter;
  const now = new Date().toISOString();
  const id = randomUUID();
  let workflowRunId: string | null = null;
  if (options.withRun !== false) {
    await h.publishPullRequest({ number, branch: `feature/api-${number}`, files: { [`api-${number}.txt`]: 'x\n' }, pullRequest: options.pr });
    workflowRunId = randomUUID();
    await h.collections.workflowRunsDb.insert({
      id: workflowRunId, projectId: target.id, planItemId: id, workflowId: 'software-development',
      workflowSnapshot: { id: 'software-development', name: 'Software development', description: '', enabled: true, steps: [{ id: 'development', name: 'Development', canEditCode: true, requiresApproval: false, agentId: 'software-engineer', instructions: '' }] },
      status: 'completed', currentStepId: null, executorId: 'test-claude-cli', prUrl: `https://github.com/test/repo/pull/${number}`,
      completionReport: null, attentionReason: null, loopRoundAllowance: 0, ...(options.branch === false ? {} : { branch: `feature/api-${number}`, baseBranch: 'main' }),
      createdAt: now, updatedAt: now, completedAt: now,
    });
  }
  await h.collections.planItemsDb.insert({
    id, projectId: target.id, title: `API task ${number}`, description: '', status: 'done', order: number, taskIds: [], milestoneId: null, workflowRunId, createdAt: now, updatedAt: now,
  } as PlanItemRecord);
  return { id, number };
}

test('I54 enabling returns 200 with the task and its auto-merge state; the state is stored', async () => {
  const t = await task(project, { pr: { isDraft: true } });
  const res = await put(project, t.id, { enabled: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, t.id);
  assert.equal(res.body.autoMerge.enabled, true);
  await waitUntil(async () => (await h.collections.planItemsDb.get(t.id))!.autoMerge!.state === 'blocked', 'the evaluation');
  await service.idle();
});

test('I55 disabling returns 200, also on a task that cannot have a PR', async () => {
  const t = await task(project, { branch: false });
  const res = await put(project, t.id, { enabled: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.autoMerge, undefined);
});

for (const [name, body] of [
  ['invalid JSON', '{"enabled": tru'],
  ['a string', { enabled: 'true' }],
  ['a number', { enabled: 1 }],
  ['no field', {}],
  ['null', 'null'],
  ['an array', [true]],
] as const) {
  test(`I56 ${name} is 400 with an error`, async () => {
    const t = await task(project, { withRun: false });
    const res = await put(project, t.id, body);
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, 'string');
  });
}

test('I56 an oversize body is refused, not applied', async () => {
  const t = await task(project, { withRun: false });
  const res = await put(project, t.id, { enabled: true, padding: 'x'.repeat(2_000_000) });
  assert.ok(res.status === 400 || res.status === 413, `got ${res.status}`);
  assert.equal((await h.collections.planItemsDb.get(t.id))!.autoMerge, undefined);
});

test('I57 an unknown task is 404, including a very long id and a path-like one', async () => {
  for (const id of ['nope', 'x'.repeat(10_000), '../x', '..%2Fx']) {
    const res = await put(project, id, { enabled: true });
    assert.equal(res.status, 404, id.slice(0, 20));
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal((await retry(project, 'nope')).status, 404);
});

test('I58 a task of another project is 404', async () => {
  const other = await h.createProject('Auto-merge other');
  const t = await task(other, { withRun: false });
  assert.equal((await put(project, t.id, { enabled: true })).status, 404);
  assert.equal((await h.collections.planItemsDb.get(t.id))!.autoMerge, undefined);
});

test('I59 a project with no linked repository is 409', async () => {
  const bare = await h.projectService.createProject({ name: 'No repo', position: null });
  const t = await task(bare, { withRun: false });
  const res = await put(bare, t.id, { enabled: true });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no linked repository/);
});

test('I60 a run without its own branch is 409', async () => {
  const t = await task(project, { branch: false });
  const res = await put(project, t.id, { enabled: true });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /own branch/);
});

test('I61 setting the same value twice is idempotent and does not reset the state', async () => {
  const t = await task(project, { pr: { isDraft: true } });
  await put(project, t.id, { enabled: true });
  await service.idle();
  const first = (await h.collections.planItemsDb.get(t.id))!.autoMerge!;
  assert.equal(first.state, 'blocked');
  const again = await put(project, t.id, { enabled: true });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.autoMerge, first);
});

test('I62 Retry is 200 on a failed task, 409 otherwise, 404 for an unknown task', async () => {
  const t = await task(project);
  assert.equal((await retry(project, t.id)).status, 409, 'never enabled');
  await h.gh.patch({ fail: { merge: 'X refused' } });
  await put(project, t.id, { enabled: true });
  await service.idle();
  await h.gh.patch({ fail: {} });
  assert.equal((await h.collections.planItemsDb.get(t.id))!.autoMerge!.state, 'failed');
  const res = await retry(project, t.id);
  assert.equal(res.status, 200);
  await service.idle();
  assert.equal((await h.collections.planItemsDb.get(t.id))!.autoMerge!.state, 'merged');
  assert.equal((await retry(project, t.id)).status, 409, 'merged cannot be retried');
});

test('I65 a credential is absent from the stored state and the response, including inside URLs in gh error text', async () => {
  const { rememberSecret } = await import('../src/redaction.ts');
  const secret = 'ghp_realLookingTokenValue9876';
  rememberSecret(secret);
  const t = await task(project);
  await h.gh.patch({ fail: { read: `gh command failed: Command failed: gh api graphql\nfatal: unable to access 'https://x-access-token:${secret}@github.com/test/repo.git/': Could not resolve host` } });
  const res = await put(project, t.id, { enabled: true });
  await service.idle();
  await h.gh.patch({ fail: {} });
  const stored = JSON.stringify((await h.collections.planItemsDb.get(t.id))!);
  const notifications = JSON.stringify(await h.collections.notificationsDb.find(() => true));
  assert.equal(stored.includes(secret), false);
  assert.equal(JSON.stringify(res.body).includes(secret), false);
  assert.equal(notifications.includes(secret), false);
  assert.equal((await h.collections.planItemsDb.get(t.id))!.autoMerge!.state, 'provider');
});

test('I66 a stored task from before the field existed reads as off', async () => {
  const t = await task(project, { withRun: false });
  const res = await call(`/api/projects/${project.id}/plan`);
  const found = res.body.items.find((candidate: { id: string }) => candidate.id === t.id);
  assert.ok(found);
  assert.equal(found.autoMerge, undefined);
});

test('a manual merge from the PR tab sends the task that owns the PR to Merged', async () => {
  const t = await task(project, { pr: { isDraft: true } });
  await put(project, t.id, { enabled: true });
  await service.idle();
  await h.gh.setPull(t.number, { isDraft: false });
  const res = await call(`/api/projects/${project.id}/pull-requests/${t.number}/merge`, { method: 'POST', body: '{}' });
  assert.equal(res.body.outcome, 'merged');
  await waitUntil(async () => (await h.collections.planItemsDb.get(t.id))!.autoMerge!.state === 'merged', 'the task to read Merged');
});
