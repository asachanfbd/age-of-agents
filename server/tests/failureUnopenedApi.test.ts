import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createFakeHarness, JUNIT_FAIL, sampleConfig, waitUntil } from './helpers/testRunFakes.ts';
import type { FakeHarness } from './helpers/testRunFakes.ts';

/**
 * The 3D village's red machines: a failed command or test run stays "unopened" (stored on the run, so
 * every browser and a reload agree) until someone opens its log. See CommandRunRecord.failureUnopened.
 */

let tempRoot: string;
let dataDir: string;
let baseUrl: string;
let server: HttpServer;
let harness: FakeHarness;
let projectService: typeof import('../src/projects/projectService.ts');
let commandService: typeof import('../src/commands/commandService.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'failure-unopened-api-'));
  dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  projectService = await import('../src/projects/projectService.ts');
  commandService = await import('../src/commands/commandService.ts');
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
const newProject = () => projectService.createProject({ name: `Unopened ${(count += 1)}`, position: null });

async function settledCommandRun(projectId: string, command: string) {
  const saved = await commandService.createCommand({ projectId, name: command, command });
  const started = await post(`/api/commands/${saved.id}/run`);
  assert.equal(started.status, 201);
  await waitUntil(async () => (await api(`/api/command-runs/${started.body.id}`)).body.status !== 'running', 5000);
  return (await api(`/api/command-runs/${started.body.id}`)).body;
}

test('IS08 a failed command run gets the unopened flag; success and stopped do not', async () => {
  const project = await newProject();
  const failed = await settledCommandRun(project.id, 'exit 3');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureUnopened, true);
  const ok = await settledCommandRun(project.id, 'true');
  assert.equal(ok.status, 'success');
  assert.equal(ok.failureUnopened, undefined);

  const saved = await commandService.createCommand({ projectId: project.id, name: 'Sleep', command: 'sleep 5' });
  const running = await post(`/api/commands/${saved.id}/run`);
  const stopped = await post(`/api/command-runs/${running.body.id}/stop`);
  assert.equal(stopped.body.status, 'stopped');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await api(`/api/command-runs/${running.body.id}`)).body.failureUnopened, undefined);
});

test('IS10 IS12 mark-opened clears the flag, persists it and broadcasts; a repeat or a non-failed run is a 200 no-op', async () => {
  const project = await newProject();
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
  const messages: { type: string; run?: { id: string; failureUnopened?: boolean } }[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => ws.once('open', resolve));

  const failed = await settledCommandRun(project.id, 'exit 1');
  const opened = await post(`/api/command-runs/${failed.id}/opened`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.failureUnopened, undefined);
  assert.equal((await api(`/api/command-runs/${failed.id}`)).body.failureUnopened, undefined, 'persisted');
  await waitUntil(() => messages.some((m) => m.type === 'commandRun' && m.run?.id === failed.id && m.run.failureUnopened === undefined));
  const before = messages.length;
  const again = await post(`/api/command-runs/${failed.id}/opened`);
  assert.equal(again.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.filter((m, i) => i >= before && m.run?.id === failed.id).length, 0, 'a repeat emits nothing');

  // IS12: opening a run that is still running does nothing; if it then fails, the flag is still set.
  const saved = await commandService.createCommand({ projectId: project.id, name: 'Later', command: 'sleep 0.3; exit 2' });
  const running = await post(`/api/commands/${saved.id}/run`);
  const early = await post(`/api/command-runs/${running.body.id}/opened`);
  assert.equal(early.status, 200);
  assert.equal(early.body.status, 'running');
  await waitUntil(async () => (await api(`/api/command-runs/${running.body.id}`)).body.status === 'failed', 5000);
  assert.equal((await api(`/api/command-runs/${running.body.id}`)).body.failureUnopened, true);
  const ok = await settledCommandRun(project.id, 'true');
  assert.equal((await post(`/api/command-runs/${ok.id}/opened`)).status, 200);
  ws.close();
});

test('IS11 IS17 mark-opened 404s for an unknown run and for a run of a deleted Project', async () => {
  assert.equal((await post('/api/command-runs/nope/opened')).status, 404);
  assert.equal((await post('/api/test-runs/nope/opened')).status, 404);
  const project = await newProject();
  const failed = await settledCommandRun(project.id, 'exit 1');
  await projectService.deleteProject(project.id);
  assert.equal((await post(`/api/command-runs/${failed.id}/opened`)).status, 404);

  const tested = await createProjectWithConfig();
  const failedTest = await finishedTestRun(tested.id, (child) => child.exit(1), 'error');
  await projectService.deleteProject(tested.id);
  assert.equal((await post(`/api/test-runs/${failedTest.id}/opened`)).status, 404);
});

test('IS14 IS15 the list filter returns only that Project\'s unopened failures; a bad value is a 400; runs without the field never match', async () => {
  const project = await newProject();
  const other = await newProject();
  const failed = await settledCommandRun(project.id, 'exit 1');
  const opened = await settledCommandRun(project.id, 'exit 1');
  await post(`/api/command-runs/${opened.id}/opened`);
  await settledCommandRun(project.id, 'true');
  await settledCommandRun(other.id, 'exit 1');
  // A failure recorded before the flag existed: no field at all.
  const { commandRunsDb } = await import('../src/db/collections.ts');
  await commandRunsDb.insert({ ...failed, id: 'legacy-failed', failureUnopened: undefined });

  const listed = await api(`/api/projects/${project.id}/command-runs?failureUnopened=true`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((run: { id: string }) => run.id), [failed.id]);
  const invalid = await api(`/api/projects/${project.id}/command-runs?failureUnopened=yes`);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'failureUnopened must be "true"');
  assert.equal((await api(`/api/projects/${project.id}/test-runs?failureUnopened=1`)).status, 400);
});

test('IS16 the flag survives a daemon restart (it is stored in the run file)', async () => {
  const project = await newProject();
  const failed = await settledCommandRun(project.id, 'exit 1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stored = (JSON.parse(await readFile(path.join(dataDir, 'command-runs.json'), 'utf8')) as { records: { id: string; failureUnopened?: boolean }[] }).records;
  assert.equal(stored.find((run) => run.id === failed.id)?.failureUnopened, true);
  const { FileDatabase } = await import('../src/db/FileDatabase.ts');
  const reopened = new FileDatabase<{ id: string; failureUnopened?: boolean }>(path.join(dataDir, 'command-runs.json'));
  assert.equal((await reopened.get(failed.id))?.failureUnopened, true);
});

async function createProjectWithConfig() {
  const project = await newProject();
  const dir = path.join(projectService.projectAbsolutePath(project), '.docs', 'testing');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(sampleConfig()));
  return project;
}

async function finishedTestRun(projectId: string, finish: (child: Awaited<ReturnType<FakeHarness['nextProcess']>>) => void, status: string) {
  const created = await post(`/api/projects/${projectId}/test-runs`, { suiteId: 'unit', actionId: 'run' });
  finish(await harness.nextProcess());
  await waitUntil(async () => (await api(`/api/test-runs/${created.body.id}`)).body.status === status);
  return (await api(`/api/test-runs/${created.body.id}`)).body;
}

test('IS09 IS13 test runs: failed and error get the flag, passed does not; mark-opened and the filter behave as for commands', async () => {
  const project = await createProjectWithConfig();
  const failed = await finishedTestRun(project.id, (child) => { harness.writeArtifact(child, 'junit.xml', JUNIT_FAIL); child.exit(1); }, 'failed');
  assert.equal(failed.failureUnopened, true);
  const errored = await finishedTestRun(project.id, (child) => child.exit(1), 'error');
  assert.equal(errored.failureUnopened, true);
  const passed = await finishedTestRun(project.id, (child) => { harness.writeArtifact(child, 'junit.xml', '<testsuite name="unit"><testcase classname="a" name="b"/></testsuite>'); child.exit(0); }, 'passed');
  assert.equal(passed.failureUnopened, undefined);

  const listed = await api(`/api/projects/${project.id}/test-runs?failureUnopened=true`);
  assert.deepEqual(listed.body.runs.map((run: { id: string }) => run.id).sort(), [failed.id, errored.id].sort());

  const opened = await post(`/api/test-runs/${failed.id}/opened`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.failureUnopened, undefined);
  assert.equal((await post(`/api/test-runs/${failed.id}/opened`)).status, 200, 'a repeat is a no-op');
  assert.equal((await post(`/api/test-runs/${passed.id}/opened`)).status, 200);
  assert.deepEqual((await api(`/api/projects/${project.id}/test-runs?failureUnopened=true`)).body.runs.map((run: { id: string }) => run.id), [errored.id]);
});

test('IS09 a stopped test run never gets the flag', async () => {
  const project = await createProjectWithConfig();
  const created = await post(`/api/projects/${project.id}/test-runs`, { suiteId: 'unit', actionId: 'run' });
  const child = await harness.nextProcess();
  await post(`/api/test-runs/${created.body.id}/stop`);
  child.exit(1);
  await waitUntil(async () => (await api(`/api/test-runs/${created.body.id}`)).body.status === 'stopped');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await api(`/api/test-runs/${created.body.id}`)).body.failureUnopened, undefined);
});
