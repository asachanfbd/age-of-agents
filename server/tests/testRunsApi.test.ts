import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { TaskRecord } from '../src/domain/types.ts';
import { createFakeHarness, JUNIT_FAIL, sampleConfig, waitUntil } from './helpers/testRunFakes.ts';
import type { FakeHarness } from './helpers/testRunFakes.ts';

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let harness: FakeHarness;
let projectService: typeof import('../src/projects/projectService.ts');
let collections: typeof import('../src/db/collections.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'test-runs-api-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  projectService = await import('../src/projects/projectService.ts');
  collections = await import('../src/db/collections.ts');
  const { createDaemonServer } = await import('../src/server.ts');
  const { createTestRunner } = await import('../src/testing/testRunner.ts');
  harness = createFakeHarness();
  server = createDaemonServer({ testRunner: createTestRunner(harness.deps) });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const post = (pathname: string, body: unknown = {}) => api(pathname, { method: 'POST', body: JSON.stringify(body) });

let count = 0;
async function createProjectWithConfig() {
  // Created through the service, not POST /api/projects, so no docs-bootstrap Task (and no real CLI) starts.
  const project = await projectService.createProject({ name: `Test Runs API ${(count += 1)}`, position: null });
  const dir = path.join(projectService.projectAbsolutePath(project), '.docs', 'testing');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(sampleConfig()));
  return project;
}

async function waitForStatus(runId: string, status: string) {
  await waitUntil(async () => (await api(`/api/test-runs/${runId}`)).body.status === status);
}

test('enqueue, live WS events, full run, history and overview through REST', async () => {
  const project = await createProjectWithConfig();
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
  const messages: { type: string; runId?: string; run?: { id: string; status: string } }[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => ws.once('open', resolve));

  const created = await post(`/api/projects/${project.id}/test-runs`, { suiteId: 'unit', actionId: 'run' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'queued');
  assert.equal(created.body.trigger, 'manual');

  const child = await harness.nextProcess();
  child.write('1 failing\n');
  harness.writeArtifact(child, 'junit.xml', JUNIT_FAIL);
  child.exit(1);
  await waitForStatus(created.body.id, 'failed');

  const full = await api(`/api/test-runs/${created.body.id}`);
  assert.equal(full.body.exitCode, 1);
  assert.equal(full.body.result.outcome, 'failed');
  assert.equal(full.body.result.cases.length, 2);
  assert.equal(full.body.output, '1 failing\n');

  await waitUntil(() => messages.some((m) => m.type === 'testRun' && m.run?.status === 'failed'));
  assert.ok(messages.some((m) => m.type === 'testRunLog' && m.runId === created.body.id));
  ws.close();

  const history = await api(`/api/projects/${project.id}/test-runs?suiteId=unit&status=failed&limit=10&offset=0`);
  assert.equal(history.status, 200);
  assert.equal(history.body.total, 1);
  assert.equal(history.body.runs[0].output, undefined);

  const overview = await api(`/api/projects/${project.id}/testing`);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.config.state, 'valid');
  assert.equal(overview.body.suites[0].latestResult.id, created.body.id);
  assert.deepEqual(overview.body.queue, []);
});

test('Run all, stop and remove through REST', async () => {
  const project = await createProjectWithConfig();
  const batch = await post(`/api/projects/${project.id}/test-runs/run-all`);
  assert.equal(batch.status, 201);
  assert.equal(batch.body.runs.length, 3);
  const [first, second, third] = batch.body.runs;

  await harness.nextProcess();
  assert.equal((await post(`/api/test-runs/${second.id}/stop`)).status, 409);
  const removed = await api(`/api/test-runs/${third.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal((await api(`/api/test-runs/${third.id}`)).status, 404);
  assert.equal((await api(`/api/test-runs/${first.id}`, { method: 'DELETE' })).status, 409);

  const stopped = await post(`/api/test-runs/${first.id}/stop`);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'stopped');
  (await harness.nextProcess()).exit(0);
  await waitForStatus(second.id, 'passed');

  const duplicate = await post(`/api/projects/${project.id}/test-runs`, { suiteId: 'lint', actionId: 'check' });
  assert.equal(duplicate.status, 201);
  assert.equal((await post(`/api/projects/${project.id}/test-runs`, { suiteId: 'lint', actionId: 'check' })).status, 409);
  (await harness.nextProcess()).exit(0);
  await waitForStatus(duplicate.body.id, 'passed');
});

test('an agent run supplies a taskId and runs in that Task worktree', async () => {
  const project = await createProjectWithConfig();
  const worktree = path.join(projectService.projectWorktreesRoot(project), 'api-task');
  await mkdir(path.join(worktree, '.docs', 'testing'), { recursive: true });
  await writeFile(path.join(worktree, '.docs', 'testing', 'config.json'), JSON.stringify(sampleConfig()));
  await collections.tasksDb.insert({ id: 'api-task', projectId: project.id, worktreePath: worktree } as TaskRecord);

  const created = await post(`/api/projects/${project.id}/test-runs`, { suiteId: 'lint', actionId: 'check', taskId: 'api-task' });
  assert.equal(created.status, 201);
  assert.equal(created.body.trigger, 'agent');
  assert.equal(created.body.taskId, 'api-task');
  const child = await harness.nextProcess();
  assert.equal(child.cwd, worktree);
  child.exit(0);
  await waitForStatus(created.body.id, 'passed');
  assert.equal((await api(`/api/test-runs/${created.body.id}`)).body.branch, 'task-branch');

  const batch = await post(`/api/projects/${project.id}/test-runs/run-all`, { taskId: 'api-task' });
  assert.equal(batch.status, 201);
  assert.ok(batch.body.runs.every((r: { executionRoot: string }) => r.executionRoot === worktree));
  for (const run of batch.body.runs) {
    const next = await harness.nextProcess();
    if (run.suite.id === 'unit') harness.writeArtifact(next, 'junit.xml', '<testsuite><testcase name="a"/></testsuite>');
    if (run.suite.id === 'security') harness.writeArtifact(next, 'out/semgrep.sarif', '{"runs":[]}');
    next.exit(0);
    await waitForStatus(run.id, 'passed');
  }
});

test('REST validation and error statuses', async () => {
  const project = await createProjectWithConfig();
  const runs = `/api/projects/${project.id}/test-runs`;
  assert.equal((await post(runs, { suiteId: 'unit' })).status, 400);
  assert.equal((await post(runs, { suiteId: 'unit', actionId: 7 })).status, 400);
  assert.equal((await post(runs, { suiteId: 'unit', actionId: 'run', taskId: '' })).status, 400);
  assert.equal((await post(`${runs}/run-all`, { taskId: 5 })).status, 400);
  assert.equal((await post(runs, { suiteId: 'nope', actionId: 'run' })).status, 404);
  assert.equal((await post(runs, { suiteId: 'e2e', actionId: 'run' })).status, 409);
  assert.equal((await post(runs, { suiteId: 'unit', actionId: 'run', taskId: 'no-such-task' })).status, 404);
  assert.equal((await post('/api/projects/missing/test-runs', { suiteId: 'unit', actionId: 'run' })).status, 404);

  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'status=bogus', 'suiteId=a&suiteId=b']) {
    assert.equal((await api(`${runs}?${query}`)).status, 400, query);
  }
  assert.equal((await api('/api/projects/missing/test-runs')).status, 404);
  assert.equal((await api('/api/projects/missing/testing')).status, 404);
  assert.equal((await api('/api/test-runs/missing')).status, 404);
  assert.equal((await post('/api/test-runs/missing/stop')).status, 404);
  assert.equal((await api('/api/test-runs/missing', { method: 'DELETE' })).status, 404);

  const bare = await projectService.createProject({ name: 'No testing config', position: null });
  const absent = await post(`/api/projects/${bare.id}/test-runs/run-all`);
  assert.equal(absent.status, 409);
  assert.match(absent.body.error, /no testing config/);
  const overview = await api(`/api/projects/${bare.id}/testing`);
  assert.deepEqual(overview.body, { config: { state: 'absent', path: '.docs/testing/config.json' }, suites: [], queue: [] });
});

test('testing.failed is an accepted Notification kind', async () => {
  const created = await post('/api/notifications', { kind: 'testing.failed', subject: { type: 'project', projectId: 'some-project' }, title: 'Unit failed', description: 'x' });
  assert.equal(created.status, 201);
  assert.equal(created.body.kind, 'testing.failed');
});

test('deleting a project stops its tests and removes its run history', async () => {
  const project = await createProjectWithConfig();
  const created = await post(`/api/projects/${project.id}/test-runs`, { suiteId: 'lint', actionId: 'check' });
  const child = await harness.nextProcess();
  const deleted = await api(`/api/projects/${project.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.ok(child.killed);
  assert.equal((await api(`/api/test-runs/${created.body.id}`)).status, 404);
});
