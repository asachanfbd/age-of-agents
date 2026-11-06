import { createQuietProject } from './helpers/quietProject.ts';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';

/**
 * REST coverage for task 2.005's testing-setup routes, against a real in-process server. As in
 * workflowApi.test.ts, the fixture executors' binaries don't exist, so a started step session fails
 * fast and never reaches a real CLI — these tests only check the routes' contracts and the state
 * they create synchronously. The approval flow itself is covered in testingSetup.test.ts.
 */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'testing-setup-api-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  const { createDaemonServer } = await import('../src/server.ts');
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const post = (pathname: string, body: unknown = {}) => api(pathname, { method: 'POST', body: JSON.stringify(body) });

async function newProject(name: string): Promise<string> {
  return (await createQuietProject(name)).body.id;
}

test('GET /testing/setup is null for a Project with no setup and 404 for an unknown Project', async () => {
  const projectId = await newProject('No Setup');
  assert.deepEqual(await api(`/api/projects/${projectId}/testing/setup`), { status: 200, body: null });
  assert.equal((await api('/api/projects/nope/testing/setup')).status, 404);
});

test('POST /testing/setup creates the setup (201), then returns the same one (200, existing) on the next click', async () => {
  const projectId = await newProject('Setup Start');
  const first = await post(`/api/projects/${projectId}/testing/setup`);
  assert.equal(first.status, 201);
  assert.equal(first.body.existing, false);
  assert.equal(first.body.planItem.title, 'Set up testing');
  assert.deepEqual(first.body.planItem.testingSetup, { mode: 'setup' });
  assert.equal(first.body.run.workflowId, 'testing-setup');

  const second = await post(`/api/projects/${projectId}/testing/setup`);
  assert.equal(second.status, 200);
  assert.equal(second.body.existing, true);
  assert.equal(second.body.planItem.id, first.body.planItem.id);
  assert.equal(second.body.run.id, first.body.run.id);

  const found = await api(`/api/projects/${projectId}/testing/setup`);
  assert.equal(found.body.planItem.id, first.body.planItem.id);
  assert.equal(found.body.active, true);
  await post(`/api/testing-setup/${first.body.run.id}/reject`);
});

test('POST /testing/setup validates executorId and 404s an unknown Project or executor', async () => {
  const projectId = await newProject('Setup Validation');
  assert.equal((await post(`/api/projects/${projectId}/testing/setup`, { executorId: 5 })).status, 400);
  assert.equal((await post(`/api/projects/${projectId}/testing/setup`, { executorId: '' })).status, 400);
  assert.equal((await post(`/api/projects/${projectId}/testing/setup`, { executorId: 'nope' })).status, 404);
  assert.equal((await post('/api/projects/nope/testing/setup')).status, 404);
  assert.deepEqual((await api(`/api/projects/${projectId}/plan`)).body.items, []);
});

test('the approve, revise and reject routes validate input and only act on a paused testing setup', async () => {
  const projectId = await newProject('Setup Actions');
  const { body } = await post(`/api/projects/${projectId}/testing/setup`);
  const runId = body.run.id;

  assert.equal((await post(`/api/testing-setup/${runId}/approve`, {})).status, 400);
  assert.equal((await post(`/api/testing-setup/${runId}/approve`, { proposalRound: 0 })).status, 400);
  assert.equal((await post(`/api/testing-setup/${runId}/approve`, { proposalRound: 1 })).status, 409, 'not awaiting approval');
  assert.equal((await post(`/api/workflow-runs/${runId}/approve`)).status, 409);
  assert.equal((await post(`/api/testing-setup/${runId}/revise`, { comment: '  ' })).status, 400);
  assert.equal((await post(`/api/testing-setup/${runId}/revise`, { comment: 'smaller' })).status, 409);
  assert.equal((await post('/api/testing-setup/no-such-run/approve', { proposalRound: 1 })).status, 404);

  const rejected = await post(`/api/testing-setup/${runId}/reject`);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'stopped');
  assert.equal((await post(`/api/testing-setup/${runId}/reject`)).status, 409);
  assert.deepEqual((await api(`/api/projects/${projectId}/testing/setup`)).body, null);
});

test('the testing-setup routes refuse an ordinary workflow run, and a client cannot mark its own item as a setup', async () => {
  const projectId = await newProject('Setup Forgery');
  const created = await post(`/api/projects/${projectId}/plan-items`, { title: 'Ordinary', description: 'x', testingSetup: { mode: 'setup' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.testingSetup, undefined);
  const patched = await api(`/api/plan-items/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ testingSetup: { mode: 'setup' } }) });
  assert.equal(patched.body.testingSetup, undefined);

  const executed = await post(`/api/plan-items/${created.body.id}/execute`);
  const runId = executed.body.id;
  assert.equal((await post(`/api/testing-setup/${runId}/approve`, { proposalRound: 1 })).status, 409);
  assert.equal((await post(`/api/testing-setup/${runId}/revise`, { comment: 'x' })).status, 409);
  assert.equal((await post(`/api/testing-setup/${runId}/reject`)).status, 409);
  await post(`/api/workflow-runs/${runId}/stop`);
});
