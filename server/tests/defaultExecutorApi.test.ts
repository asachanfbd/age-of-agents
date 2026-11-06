import { createQuietProject } from './helpers/quietProject.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';

/** Task 19.001: the default coding agent over HTTP and /ws, plus the start routes' autoMerge option. Quota comes from fixture status-line caches; no real account is read. */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
const configDirs: Record<string, string> = {};
const autoMergeCalls: { projectId: string; itemId: string; enabled: boolean }[] = [];
let startWhenReadyResult: { started: boolean; entry?: { id: string; planItemId: string } } = { started: false };

const IDS = ['alpha', 'beta', 'gamma'];

async function setUsage(id: string, fiveHour: number | null, resetsInMs: number | null = 3_600_000): Promise<void> {
  const rate_limits = fiveHour === null ? {} : { five_hour: { used_percentage: fiveHour, ...(resetsInMs === null ? {} : { resets_at: (Date.now() + resetsInMs) / 1000 }) } };
  await writeFile(path.join(configDirs[id]!, 'context-village-usage.json'), JSON.stringify({ observed_at: Date.now() / 1000, rate_limits }));
}

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'default-executor-api-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(tempRoot, 'executors.json');
  for (const id of IDS) { configDirs[id] = path.join(tempRoot, `config-${id}`); await mkdir(configDirs[id]!, { recursive: true }); }
  await writeFile(process.env.AGENT_VISUAL_OS_EXECUTORS_PATH, JSON.stringify({
    executors: IDS.map((id) => ({ id, label: id.toUpperCase(), kind: 'claude-cli', bin: `${id}-missing-bin`, env: { CLAUDE_CONFIG_DIR: configDirs[id] } })),
  }));
  await setUsage('alpha', 40);
  await setUsage('beta', 10);
  await setUsage('gamma', 70);

  const { createDaemonServer } = await import('../src/server.ts');
  const fakeAutoMerge = { setEnabled: async (projectId: string, itemId: string, enabled: boolean) => { autoMergeCalls.push({ projectId, itemId, enabled }); return {}; } };
  const fakeDependencies = {
    startWhenReady: async () => (startWhenReadyResult.started ? { started: true, run: { id: 'run-1' } } : startWhenReadyResult.entry ? { started: false, item: {}, entry: startWhenReadyResult.entry } : { started: false, item: {} }),
  };
  server = createDaemonServer({ autoMerge: fakeAutoMerge as never, dependencies: fakeDependencies as never });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5 });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const put = (body: unknown) => api('/api/executors/default', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
const defaultOf = async () => ((await api('/api/executors')).body as { id: string; isDefault: boolean }[]).filter((e) => e.isDefault).map((e) => e.id);
const switchNotes = async () => ((await api('/api/notifications')).body as { kind: string; resolvedAt: string | null; description: string; severity: string; subject: unknown; title: string }[]).filter((n) => n.kind === 'executor.default_switched');

function listenForDefaultEvents(): { events: unknown[]; ready: Promise<void>; close: () => void } {
  const events: unknown[] = [];
  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
  socket.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'executors.default_changed') events.push(event); });
  return { events, ready: new Promise((resolve) => socket.on('open', () => resolve())), close: () => socket.close() };
}
const eventually = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100 && !(await check()); i += 1) await new Promise((r) => setTimeout(r, 20)); };

test('I02 I01 I20 with no stored default the list read picks the most-quota-left agent silently, and isDefault marks at most one agent', async () => {
  const listener = listenForDefaultEvents();
  await listener.ready;
  const list = await api('/api/executors');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.filter((e: { isDefault: boolean }) => e.isDefault).map((e: { id: string }) => e.id), ['beta']);
  assert.ok(list.body.every((e: { isDefault: unknown }) => typeof e.isDefault === 'boolean'));
  await eventually(() => listener.events.length > 0);
  assert.deepEqual(listener.events, [{ type: 'executors.default_changed', defaultExecutorId: 'beta', previousExecutorId: null, reason: 'initial' }]);
  assert.deepEqual(await switchNotes(), [], 'the first pick is silent');
  listener.close();
});

test('I17 the stored default is on disk and a better agent later changes nothing (sticky)', async () => {
  const stored = JSON.parse(await readFile(path.join(tempRoot, 'data', 'default-executor.json'), 'utf8'));
  assert.equal(stored.records[0].executorId, 'beta');
  await setUsage('alpha', 0);
  assert.deepEqual(await defaultOf(), ['beta']);
});

test('I03-I10 I13 I14 PUT answers 200, 400, 404 and refuses a malformed body in that order', async () => {
  assert.deepEqual((await put({ executorId: 'alpha' })).body, { defaultExecutorId: 'alpha' });
  assert.deepEqual(await defaultOf(), ['alpha']);
  for (const body of ['not json', { }, { executorId: 5 }, { executorId: null }, { executorId: ['alpha'] }, { executorId: { a: 1 } }, { executorId: '' }, [], '"alpha"', 'null']) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error);
  }
  for (const id of ['ALPHA', ' alpha ', 'nope']) assert.equal((await put({ executorId: id })).status, 404, id);
  assert.deepEqual(await defaultOf(), ['alpha'], 'a refused request changes nothing');
});

test('I04 I15 I16 I21 setting the current default is a no-op, a manual change emits manual and resolves the switch notification', async () => {
  const listener = listenForDefaultEvents();
  await listener.ready;
  assert.equal((await put({ executorId: 'alpha' })).status, 200);
  assert.equal((await put({ executorId: 'gamma' })).status, 200);
  await eventually(() => listener.events.length > 0);
  assert.deepEqual(listener.events, [{ type: 'executors.default_changed', defaultExecutorId: 'gamma', previousExecutorId: 'alpha', reason: 'manual' }]);
  listener.close();
});

test('I11 I12 S18 I21 an exhausted default switches on the next read with an info notification, and a manual choice resolves it', async () => {
  const listener = listenForDefaultEvents();
  await listener.ready;
  await setUsage('gamma', 100, 3_600_000);
  const refused = await put({ executorId: 'gamma' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /GAMMA is out of quota/);
  await setUsage('alpha', 100, 7_200_000);
  assert.deepEqual(await defaultOf(), ['beta'], 'switched to the available agent with the most quota left');
  await eventually(() => listener.events.length > 0);
  assert.deepEqual(listener.events, [{ type: 'executors.default_changed', defaultExecutorId: 'beta', previousExecutorId: 'gamma', reason: 'exhausted' }]);
  const [note] = await switchNotes();
  assert.equal(note?.severity, 'info');
  assert.equal(note?.title, 'Default coding agent changed');
  assert.deepEqual(note?.subject, { type: 'app' });
  assert.match(note!.description, /^GAMMA has used its 5-hour limit \(resets .+\)\. New sessions now use BETA\.$/);
  assert.equal(note?.resolvedAt, null);

  await setUsage('gamma', 100, 3_600_000);
  await setUsage('beta', 100, 3_600_000);
  await api('/api/executors');
  assert.deepEqual(await defaultOf(), ['beta'], 'I16 every agent out: unchanged');
  assert.equal((await switchNotes()).length, 1, 'I16 no new notification');

  await setUsage('beta', 90);
  await setUsage('alpha', 5, 3_600_000);
  await api('/api/executors');
  assert.deepEqual(await defaultOf(), ['beta'], 'beta is available again, so it stays');
  await setUsage('beta', 100, 3_600_000);
  await api('/api/executors');
  assert.deepEqual(await defaultOf(), ['alpha'], 'S43 a second switch updates the unresolved notification');
  const notes = await switchNotes();
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.description, /^BETA has used its 5-hour limit/);

  assert.equal((await put({ executorId: 'alpha' })).status, 200, 'no-op, notification stays');
  assert.equal((await put({ executorId: 'gamma' })).status, 409);
  await setUsage('gamma', 1);
  assert.equal((await put({ executorId: 'gamma' })).status, 200);
  assert.ok((await switchNotes())[0]!.resolvedAt, 'I21 resolved by the manual change');
  listener.close();
});

test('I12 S31 S44 an unknown reset is named so, an Analytics Refresh re-checks, and a switch after a manual choice raises a new notification', async () => {
  await setUsage('alpha', 10); await setUsage('beta', 20); await setUsage('gamma', 30);
  assert.equal((await put({ executorId: 'beta' })).status, 200);
  await setUsage('alpha', 100, null);
  const refused = await put({ executorId: 'alpha' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /ALPHA is out of quota .*reset time is unknown/, 'I12');
  const before = (await switchNotes()).length;
  await setUsage('beta', 100, 3_600_000);
  assert.equal((await api('/api/analytics/agents/alpha/refresh', { method: 'POST' })).status, 200);
  // Read from disk, not through GET /api/executors, which would re-check by itself.
  const stored = async () => JSON.parse(await readFile(path.join(tempRoot, 'data', 'default-executor.json'), 'utf8')).records[0].executorId;
  await eventually(async () => (await stored()) !== 'beta');
  assert.equal(await stored(), 'gamma', 'S31 the refresh alone triggered the switch');
  const notes = await switchNotes();
  assert.equal(notes.length, before + 1, 'S44 the earlier notification was resolved by the manual choice, so this one is new');
  assert.equal(notes.filter((n) => n.resolvedAt === null).length, 1);
  await setUsage('alpha', 5); await setUsage('beta', 5);
});

test('I18 I19 editing keeps the default and deleting it switches with the removed text', async () => {
  await setUsage('alpha', 20); await setUsage('beta', 30); await setUsage('gamma', 50);
  assert.deepEqual(await defaultOf(), ['gamma']);
  assert.equal((await api('/api/executors/gamma', { method: 'PATCH', body: JSON.stringify({ label: 'Renamed Gamma', kind: 'codex-cli' }) })).status, 200);
  assert.deepEqual(await defaultOf(), ['gamma'], 'I19');
  const listener = listenForDefaultEvents();
  await listener.ready;
  assert.equal((await api('/api/executors/gamma', { method: 'DELETE' })).status, 204);
  assert.deepEqual(await defaultOf(), ['alpha']);
  await eventually(() => listener.events.length > 0);
  assert.deepEqual(listener.events, [{ type: 'executors.default_changed', defaultExecutorId: 'alpha', previousExecutorId: 'gamma', reason: 'removed' }]);
  const [note] = await switchNotes();
  assert.equal(note?.description, 'Renamed Gamma was removed. New sessions now use ALPHA.');
  listener.close();
});

test('I26 I40 the start routes reject a non-boolean autoMerge with 400, before any 409', async () => {
  const created = await createQuietProject('Auto-merge Start Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Merge me', description: '' }) });
  for (const route of [`/api/plan-items/${item.body.id}/execute`, `/api/projects/${created.body.id}/plan-items/${item.body.id}/start-when-ready`]) {
    for (const autoMerge of ['true', 1, 0, null, [], {}, 'x']) {
      const res = await api(route, { method: 'POST', body: JSON.stringify({ autoMerge }) });
      assert.equal(res.status, 400, `${route} ${JSON.stringify(autoMerge)}`);
      assert.match(res.body.error, /autoMerge must be a boolean/);
    }
    assert.equal((await api(route, { method: 'POST', body: JSON.stringify({ autoMerge: 'x', createBranch: false }) })).status, 400);
  }
  assert.deepEqual(autoMergeCalls, []);
});

test('I27 I28 I36 autoMerge true with no separate branch or no repository is a 409 with Auto-merge\'s reason, and nothing starts', async () => {
  const { projectsDb, planItemsDb } = await import('../src/db/collections.ts');
  const { autoMergeIneligibleReason } = await import('../src/projects/autoMerge.ts');
  const created = await createQuietProject('No Repo Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'No repo', description: '' }) });
  const noRepoReason = autoMergeIneligibleReason({ repositoryUrl: undefined } as never, null)!;
  for (const route of [`/api/plan-items/${item.body.id}/execute`, `/api/projects/${created.body.id}/plan-items/${item.body.id}/start-when-ready`]) {
    const res = await api(route, { method: 'POST', body: JSON.stringify({ autoMerge: true }) });
    assert.equal(res.status, 409, route);
    assert.equal(res.body.error, noRepoReason);
  }
  assert.equal((await planItemsDb.get(item.body.id))?.status, 'pending', 'nothing started');

  await projectsDb.update(created.body.id, { repositoryUrl: 'https://github.com/example/repo' });
  const ownBranch = autoMergeIneligibleReason({ repositoryUrl: 'x' } as never, { branch: undefined, baseBranch: undefined })!;
  for (const route of [`/api/plan-items/${item.body.id}/execute`, `/api/projects/${created.body.id}/plan-items/${item.body.id}/start-when-ready`]) {
    const res = await api(route, { method: 'POST', body: JSON.stringify({ autoMerge: true, createBranch: false }) });
    assert.equal(res.status, 409, route);
    assert.equal(res.body.error, ownBranch);
  }
  assert.deepEqual(autoMergeCalls, []);
});

test('I24 I29 I30 I31 execute leaves autoMerge alone when absent, applies false without a branch, and a start at the task limit queues, and a refused start changes nothing', async () => {
  const { tasksDb, projectsDb } = await import('../src/db/collections.ts');
  const created = await createQuietProject('Execute Auto-merge Project');
  const projectId = created.body.id as string;
  const first = await api(`/api/projects/${projectId}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Absent', description: '' }) });

  const refusedItem = await api(`/api/projects/${projectId}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Refused', description: '' }) });
  const now = new Date().toISOString();
  await tasksDb.insert({
    id: 'holder-1', projectId, templateId: 'builder', executorId: 'alpha', status: 'developing', autonomy: 'auto', manager: false, kind: 'execute', planItemId: null,
    sessionId: 'sess', blockedQuestion: null, failureReason: null, runtimeStatus: 'starting', description: 'Holds the only slot',
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 }, createdAt: now, updatedAt: now, completedAt: null,
  } as never);
  await projectsDb.update(projectId, { activeTaskIds: ['holder-1'] });
  const refused = await api(`/api/plan-items/${refusedItem.body.id}/execute`, { method: 'POST', body: JSON.stringify({ autoMerge: false }) });
  assert.equal(refused.status, 202, 'at the task limit the start waits in line instead of being refused');
  assert.equal(refused.body.started, false);
  assert.equal(refused.body.entry.planItemId, refusedItem.body.id);
  assert.deepEqual(autoMergeCalls, [{ projectId, itemId: refusedItem.body.id, enabled: false }], 'a queued start saves Auto-merge like an accepted one');
  autoMergeCalls.length = 0;
  const waiting = await api(`/api/projects/${projectId}/plan-item-queue`);
  assert.deepEqual(waiting.body.map((entry: { id: string }) => entry.id), [refused.body.entry.id]);
  assert.equal((await api(`/api/plan-item-queue/${refused.body.entry.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/plan-item-queue/${refused.body.entry.id}`, { method: 'DELETE' })).status, 404);
  const badOptions = await api(`/api/plan-items/${refusedItem.body.id}/execute`, { method: 'POST', body: JSON.stringify({ autoMerge: false, workflowId: 'no-such-workflow' }) });
  assert.equal(badOptions.status, 400);
  assert.deepEqual(autoMergeCalls, [], 'I33 bad options leave Auto-merge alone');
  await tasksDb.update('holder-1', { status: 'stopped' });
  await projectsDb.update(projectId, { activeTaskIds: [] });

  const absent = await api(`/api/plan-items/${first.body.id}/execute`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(absent.status, 201);
  assert.deepEqual(autoMergeCalls, [], 'I24 absent leaves it unchanged');
  const other = await createQuietProject('Execute Off Project');
  const secondItem = await api(`/api/projects/${other.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Off', description: '' }) });
  const off = await api(`/api/plan-items/${secondItem.body.id}/execute`, { method: 'POST', body: JSON.stringify({ autoMerge: false, createBranch: false }) });
  assert.equal(off.status, 201, 'I29 false needs no branch');
  assert.deepEqual(autoMergeCalls, [{ projectId: other.body.id, itemId: secondItem.body.id, enabled: false }]);
  autoMergeCalls.length = 0;
});

test('I34 I37 start-when-ready saves autoMerge when the start is accepted, started or waiting', async () => {
  const { projectsDb } = await import('../src/db/collections.ts');
  autoMergeCalls.length = 0;
  const created = await createQuietProject('Waiting Auto-merge Project');
  await projectsDb.update(created.body.id, { repositoryUrl: 'https://github.com/example/repo' });
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Wait', description: '' }) });
  const route = `/api/projects/${created.body.id}/plan-items/${item.body.id}/start-when-ready`;
  startWhenReadyResult = { started: false };
  const waiting = await api(route, { method: 'POST', body: JSON.stringify({ autoMerge: true }) });
  assert.equal(waiting.status, 202);
  startWhenReadyResult = { started: true };
  const started = await api(route, { method: 'POST', body: JSON.stringify({ autoMerge: false }) });
  assert.equal(started.status, 201);
  await api(route, { method: 'POST', body: JSON.stringify({}) });
  assert.deepEqual(autoMergeCalls, [
    { projectId: created.body.id, itemId: item.body.id, enabled: true },
    { projectId: created.body.id, itemId: item.body.id, enabled: false },
  ], 'absent adds no call');
});

test('31.003 I17 start-when-ready released at capacity answers 202 with the entry and saves autoMerge', async () => {
  const { projectsDb } = await import('../src/db/collections.ts');
  autoMergeCalls.length = 0;
  const created = await createQuietProject('Queued Dependent Project');
  await projectsDb.update(created.body.id, { repositoryUrl: 'https://github.com/example/repo' });
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Queued child', description: '' }) });
  startWhenReadyResult = { started: false, entry: { id: 'entry-x', planItemId: item.body.id } };
  try {
    const res = await api(`/api/projects/${created.body.id}/plan-items/${item.body.id}/start-when-ready`, { method: 'POST', body: JSON.stringify({ autoMerge: true }) });
    assert.equal(res.status, 202);
    assert.equal(res.body.started, false);
    assert.equal(res.body.entry.id, 'entry-x');
    assert.deepEqual(autoMergeCalls, [{ projectId: created.body.id, itemId: item.body.id, enabled: true }]);
  } finally {
    startWhenReadyResult = { started: false };
  }
});
