import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';

/** The step-note route's statuses and bodies, over HTTP. No CLI is started: a run is a record inserted straight into the database. */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let token: string;
const titled: string[] = [];
let collections: typeof import('../src/db/collections.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'step-notes-api-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  const { createDaemonServer } = await import('../src/server.ts');
  const { createPlanItemTitler } = await import('../src/projects/planItemTitler.ts');
  token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
  collections = await import('../src/db/collections.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  // No real CLI names anything: the background titler is replaced.
  server = createDaemonServer({ planItemTitler: { ...createPlanItemTitler(), requestTitle: (item: { id: string }) => { titled.push(item.id); }, requestSessionTitle: () => {} } });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(pathname: string, init: RequestInit & { auth?: string | null } = {}) {
  const { auth, ...rest } = init;
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: `Bearer ${auth ?? token}` }), ...rest.headers },
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body };
}

const send = (method: string, pathname: string, body?: unknown) =>
  api(pathname, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function newItem(): Promise<{ id: string; projectId: string }> {
  const project = (await send('POST', '/api/projects', { name: `Step Notes API ${Math.random()}`, position: null })).body;
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'T', description: 'D' });
  return { id: item.id, projectId: project.id };
}

const put = (itemId: string, stepId: string, body: unknown) => send('PUT', `/api/plan-items/${itemId}/step-notes/${stepId}`, body);

test('PUT stores a trimmed note on an idle task, replaces it and clears it', async () => {
  const { id } = await newItem();
  const saved = await put(id, 'build', { note: '  hello  ' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.stepNotes, { build: 'hello' });
  assert.deepEqual((await put(id, 'docs', { note: 'x' })).body.stepNotes, { build: 'hello', docs: 'x' });
  assert.deepEqual((await put(id, 'build', { note: '   ' })).body.stepNotes, { docs: 'x' });
  assert.deepEqual((await put(id, 'docs', { note: null })).body.stepNotes, {});
});

test('PUT accepts 4000 characters and refuses 4001, leaving the stored note', async () => {
  const { id } = await newItem();
  assert.equal((await put(id, 'build', { note: 'x'.repeat(4000) })).status, 200);
  const refused = await put(id, 'build', { note: 'y'.repeat(4001) });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /4000/);
  assert.equal((await planItemService.getPlanItem(id)).stepNotes!.build, 'x'.repeat(4000));
});

test('PUT refuses a missing or non-text note, a bad step id and an unknown task', async () => {
  const { id } = await newItem();
  assert.equal((await put(id, 'build', {})).status, 400);
  assert.equal((await send('PUT', `/api/plan-items/${id}/step-notes/build`)).status, 400);
  for (const note of [5, {}, [], true]) assert.equal((await put(id, 'build', { note })).status, 400);
  for (const stepId of ['Bad', '__proto__', '-x']) assert.equal((await put(id, stepId, { note: 'x' })).status, 400, stepId);
  assert.equal((await put('missing', 'build', { note: 'x' })).status, 404);
});

test('PUT refuses a step outside the latest run\'s workflow, and the run detail lists the notes', async () => {
  const { id, projectId } = await newItem();
  const now = new Date().toISOString();
  const run = await collections.workflowRunsDb.insert({
    id: 'run-notes-1', projectId, planItemId: id, workflowId: 'w', status: 'running', currentStepId: 'build',
    workflowSnapshot: { id: 'w', name: 'W', description: '', steps: [{ id: 'build', name: 'Dev', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'x' }] },
    executorId: 'test-claude-cli', prUrl: null, completionReport: null, attentionReason: null, createdAt: now, updatedAt: now,
  } as never);
  await planItemService.updatePlanItem(id, { workflowRunId: run.id });
  const refused = await put(id, 'docs', { note: 'x' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not a step of this task's workflow/);
  assert.equal((await put(id, 'build', { note: 'go' })).status, 200);
  const detail = await send('GET', `/api/workflow-runs/${run.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.stepNotes, { build: 'go' });
});
