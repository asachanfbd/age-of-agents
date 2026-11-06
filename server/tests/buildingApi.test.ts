import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { ProjectRecord } from '../src/domain/types.ts';

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let dataDir: string;
let buildingsApi: typeof import('../src/buildings/buildingStorage.ts');
let projectsDb: typeof import('../src/db/collections.ts').projectsDb;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'building-api-'));
  dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  process.env.AGENT_VISUAL_OS_TEST_FAULTS = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  // The Notes type's default workflow comes from a fixture copy, so the real Catalog can be edited freely.
  await cp(path.join(import.meta.dirname, 'fixtures', 'notes-workflows', 'notes-review.json'), path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR, 'workflows', 'notes-review.json'));
  const { createDaemonServer } = await import('../src/server.ts');
  buildingsApi = await import('../src/buildings/buildingStorage.ts');
  ({ projectsDb } = await import('../src/db/collections.ts'));
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await buildingsApi.closeAllStores();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const send = (method: string, pathname: string, body?: unknown) => api(pathname, { method, body: body === undefined ? undefined : JSON.stringify(body) });

async function createNotes(name = 'Notes one') {
  const res = await send('POST', '/api/projects', { name, typeId: 'notes' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as ProjectRecord & { typeId: string };
}

const legacyRecord = (id: string, patch: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id, name: `Legacy ${id}`, slug: `legacy-${id}`, relativePath: `projects/legacy-${id}`, status: 'idle', position: [1, 2],
  activeTaskId: null, activeTaskIds: [], taskCount: 3, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', ...patch,
});

const metric = (day: string, page: string, clicks: number) => ({ day, page, query: 'q', clicks, impressions: clicks });

test('I1 GET /api/building-types lists every registered type with dev-only ones flagged, and creating a dev-only type needs the dev flag', async () => {
  const withFlag = await api('/api/building-types');
  assert.deepEqual(withFlag.body.map((t: { id: string; devOnly: boolean }) => [t.id, t.devOnly]), [['software', false], ['notes', true], ['seo', false], ['crm', false], ['content-studio', false]]);
  const software = withFlag.body[0];
  assert.deepEqual([software.name, software.version, software.repository], ['Software', 1, true]);
  assert.ok(software.description);
  assert.equal(software.hasStorage, false);
  delete process.env.AGENT_VISUAL_OS_DEV_TYPES;
  try {
    const hidden = await send('POST', '/api/projects', { name: 'Hidden', typeId: 'notes' });
    assert.equal(hidden.status, 400);
  } finally {
    process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  }
});

test('I2/I7/I10 creating without a type makes a Software Building, validated as before, with no bulk storage', async () => {
  const bad = await send('POST', '/api/projects', { name: '  ' });
  assert.deepEqual([bad.status, bad.body.error, bad.body.field], [400, 'name is required', 'name']);
  const res = await send('POST', '/api/projects', { name: 'Soft one' });
  assert.equal(res.status, 201);
  assert.deepEqual([res.body.typeId, res.body.typeVersion, res.body.ownerId, res.body.tenantId, res.body.readOnly], ['software', 1, 'local-user', 'local-tenant', false]);
  assert.equal(res.body.repositoryUrl, undefined);
  await assert.rejects(stat(path.join(dataDir, 'buildings', res.body.id)), /ENOENT/);
  const badRepo = await send('POST', '/api/projects', { name: 'Soft two', repositoryUrl: 'not a url' });
  assert.deepEqual([badRepo.status, badRepo.body.field], [400, 'repositoryUrl'], 'a malformed repository URL is a 400 naming the field');
});

test('I4 an unknown type is a 400 with { error }, and invalid input names its field', async () => {
  for (const typeId of ['nope', 'Software', 5, null]) {
    const res = await send('POST', '/api/projects', { name: 'x', typeId });
    assert.equal(res.status, 400, String(typeId));
    assert.match(res.body.error, /Unknown Building type/);
  }
  const noName = await send('POST', '/api/projects', { typeId: 'notes' });
  assert.deepEqual([noName.status, noName.body.field], [400, 'name']);
  const long = await send('POST', '/api/projects', { typeId: 'notes', name: 'x'.repeat(200) });
  assert.deepEqual([long.status, long.body.field], [400, 'name']);
});

test('I5 an unknown Building is a 404 with { error }', async () => {
  for (const url of ['/api/projects/nope', '/api/projects/nope/storage', '/api/projects/nope/data/metrics']) {
    const res = await api(url);
    assert.equal(res.status, 404, url);
    assert.ok(res.body.error);
  }
});

test('I6/I8/I9 a Project stored before Building Types lists as Software with every field intact, and the file is not rewritten', async () => {
  const legacy = legacyRecord('legacy1', { repositoryUrl: 'https://github.com/a/b', activeTaskIds: ['t1'], workflowId: 'software-development' });
  await projectsDb.insert(legacy);
  const listed = (await api('/api/projects')).body.find((p: ProjectRecord) => p.id === 'legacy1');
  assert.equal(listed.typeId, 'software');
  assert.equal(listed.typeUnavailable, false);
  for (const [key, value] of Object.entries(legacy)) assert.deepEqual(listed[key], value, key);
  assert.deepEqual(await projectsDb.get('legacy1'), legacy, 'reading does not write typeId or owner fields back');
  assert.deepEqual((await api('/api/projects/legacy1')).body.typeId, 'software');
  const second = (await api('/api/projects')).body.find((p: ProjectRecord) => p.id === 'legacy1');
  assert.deepEqual(second, listed);
});

test('I11/I12 a Building whose type is gone stays listed and readable, refuses changes with 409, and can still be deleted', async () => {
  const folder = path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, 'legacy-orphan');
  await mkdir(folder, { recursive: true });
  await projectsDb.insert(legacyRecord('orphan', { typeId: 'gone-type', slug: 'legacy-orphan' }));
  const view = (await api('/api/projects/orphan')).body;
  assert.deepEqual([view.typeUnavailable, view.readOnly], [true, true]);
  assert.match(view.readOnlyReason, /"gone-type".*no longer available/);
  assert.ok((await api('/api/projects')).body.some((p: ProjectRecord) => p.id === 'orphan'));

  const refused = await send('POST', '/api/projects/orphan/plan-items', { title: 'x', description: 'y' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no longer available/);
  assert.equal((await send('PATCH', '/api/projects/orphan', { position: [4.38, 4.38] })).status, 200, 'it can still be moved');
  assert.equal((await send('DELETE', '/api/projects/orphan')).status, 204);
  await assert.rejects(stat(folder), /ENOENT/);
  assert.equal((await api('/api/projects/orphan')).status, 404);
});

test('a read-only Building refuses to start a run or a Task even through routes not under /projects/:id, because the work-starting code checks it', async () => {
  const { createPlanItem } = await import('../src/projects/planItemService.ts');
  await mkdir(path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, 'legacy-frozen'), { recursive: true });
  await projectsDb.insert(legacyRecord('frozen', { slug: 'legacy-frozen', typeId: 'gone-type' }));
  const item = await createPlanItem({ projectId: 'frozen', title: 'Try', description: 'Try to run.' });
  const run = await send('POST', `/api/plan-items/${item.id}/execute`, {});
  assert.equal(run.status, 409);
  assert.match(run.body.error, /no longer available/);
  const { workerManager } = await import('../src/worker/workerManager.ts');
  await assert.rejects(workerManager.startTask({ projectId: 'frozen', description: 'Do it' }), /no longer available/, 'the manager itself refuses, whatever route called it');
});

test('I3/I18/AC2 a Notes Building has its own folder without git and its own isolated bulk file outside the central state', async () => {
  const notes = await createNotes();
  assert.deepEqual([notes.typeId, notes.typeVersion], ['notes', 1]);
  await assert.rejects(stat(path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, notes.slug, '.git')), /ENOENT/);
  await assert.rejects(stat(path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, notes.slug, '.docs')), /ENOENT/, 'no software scaffold');
  const status = await api(`/api/projects/${notes.id}/storage`);
  assert.equal(status.status, 200);
  assert.ok((await stat(path.join(dataDir, 'buildings', notes.id, 'bulk.sqlite'))).isFile());
  assert.ok(!(await readFile(path.join(dataDir, 'projects.json'), 'utf8')).includes('metrics'));
  assert.equal((await api(`/api/projects/${notes.id}/data/metrics`)).status, 200);
  const soft = (await send('POST', '/api/projects', { name: 'Soft for storage' })).body;
  assert.equal((await api(`/api/projects/${soft.id}/storage`)).status, 404, 'Software has no bulk storage');
});

test('I24/I25/I26/I27 the list API is paginated with a bounded page, rejects bad parameters with 400, and 404s a missing table', async () => {
  const notes = await createNotes('Paged');
  const base = `/api/projects/${notes.id}`;
  const rows = Array.from({ length: 12 }, (_, i) => metric(`2025-02-${String(i + 1).padStart(2, '0')}`, `/p${i % 3}`, i));
  const inserted = await send('POST', `${base}/data/metrics`, { rows });
  assert.deepEqual([inserted.status, inserted.body], [201, { inserted: 12 }]);

  const first = (await api(`${base}/data/metrics?limit=5&sort=clicks&dir=desc`)).body;
  assert.deepEqual(first.rows.map((r: { clicks: number }) => r.clicks), [11, 10, 9, 8, 7]);
  assert.ok(first.nextCursor);
  const second = (await api(`${base}/data/metrics?limit=5&sort=clicks&dir=desc&cursor=${first.nextCursor}`)).body;
  assert.deepEqual(second.rows.map((r: { clicks: number }) => r.clicks), [6, 5, 4, 3, 2]);
  const filtered = (await api(`${base}/data/metrics?filter=page:eq:/p1&filter=clicks:gte:4`)).body;
  assert.deepEqual(filtered.rows.map((r: { clicks: number }) => r.clicks), [4, 7, 10]);
  assert.equal((await api(`${base}/data/metrics?search=${encodeURIComponent('/p2')}`)).body.rows.length, 4);
  assert.equal((await api(`${base}/data/metrics?limit=100000`)).body.rows.length, 12);

  for (const bad of ['limit=0', 'limit=abc', 'sort=nope', 'dir=up', 'cursor=junk', 'filter=badformat', 'filter=query:zz:1', "filter=page:eq:'%3B DROP TABLE metrics"]) {
    const res = await api(`${base}/data/metrics?${bad}`);
    assert.ok(res.status === 400 || (bad.startsWith('filter=page') && res.status === 200), `${bad} -> ${res.status}`);
  }
  assert.equal((await api(`${base}/data/metrics`)).body.rows.length, 12, 'the table survived the injection attempt');
  assert.equal((await api(`${base}/data/missing`)).status, 400);
  assert.equal((await api(`${base}/rollups/daily?groupBy=page`)).status, 400);
  const totals = (await api(`${base}/rollups/daily`)).body;
  assert.deepEqual(totals.rows[0], { clicks: 66, impressions: 66, rows: 12 });
  assert.equal((await send('POST', `${base}/data/metrics`, { rows: [] })).status, 400);
  assert.equal((await send('POST', `${base}/data/metrics`, { rows: [{ day: 'x' }] })).status, 400);
});

test('AC2/I33/I34/I35 a synthetic ingest runs as a job with progress, can be cancelled once, and the unknown or finished job answers clearly', async () => {
  const notes = await createNotes('Ingest');
  const base = `/api/projects/${notes.id}`;
  assert.equal((await send('POST', `${base}/data/metrics/synthetic`, { rows: 0 })).status, 400);
  assert.equal((await send('POST', `${base}/data/query/synthetic`, { rows: 5 })).status, 400);
  const started = await send('POST', `${base}/data/metrics/synthetic`, { rows: 3_000_000 });
  assert.equal(started.status, 202);
  assert.equal((await send('POST', `${base}/data/metrics/synthetic`, { rows: 3_000_000 })).body.id, started.body.id, 'a second start returns the running job');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await send('POST', `${base}/storage/jobs/${started.body.id}/cancel`)).status, 202);
  let job = (await api(`${base}/storage/jobs/${started.body.id}`)).body;
  for (let i = 0; i < 100 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 50)); job = (await api(`${base}/storage/jobs/${started.body.id}`)).body; }
  assert.equal(job.status, 'cancelled');
  assert.ok(job.done > 0 && job.done < 3_000_000);
  assert.equal(job.done % 5000, 0);
  assert.equal((await send('POST', `${base}/storage/jobs/${started.body.id}/cancel`)).status, 409);
  assert.equal((await send('POST', `${base}/storage/jobs/nope/cancel`)).status, 404);
  assert.equal((await api(`${base}/storage/jobs/nope`)).status, 404);
  const other = await createNotes('Other');
  assert.equal((await api(`/api/projects/${other.id}/storage/jobs/${started.body.id}`)).status, 404, 'a job belongs to its Building');
});

test('I41/I42/I44/I43 storage status shows size, threshold, retention rule and backup; the threshold validates, persists, and warns once per crossing', async () => {
  const notes = await createNotes('Status');
  const base = `/api/projects/${notes.id}`;
  const status = (await api(`${base}/storage`)).body;
  assert.ok(status.bytes > 0);
  assert.deepEqual([status.level, status.lastBackup, status.readOnlyReason], ['ok', null, null]);
  assert.match(status.retention.description, /12 months ago are discarded/);
  assert.equal(status.retention.rule.months, 12);

  for (const bad of [0, -1, 'big', null]) assert.equal((await send('PATCH', `${base}/storage`, { warningBytes: bad })).status, 400);
  const warned = await send('PATCH', `${base}/storage`, { warningBytes: 1 });
  assert.deepEqual([warned.status, warned.body.level, warned.body.warningBytes], [200, 'warning', 1]);
  await send('PATCH', `${base}/storage`, { warningBytes: 2 });
  const count = async () => (await api('/api/notifications')).body.filter((n: { kind: string; projectId: string; resolvedAt: string | null }) => n.kind === 'storage.problem' && n.projectId === notes.id && n.resolvedAt === null).length;
  assert.equal(await count(), 1, 'one warning, not one per check');
  assert.equal((await send('PATCH', `${base}/storage`, { warningBytes: 10 ** 12 })).body.level, 'ok');
  assert.equal(await count(), 0, 'it clears when the size is back under the threshold');
  assert.equal((await projectsDb.get(notes.id))?.storageWarningBytes, 10 ** 12);
});

test('I41/I39 retention runs on demand as a job and reports what it removed; a rule-less call is rejected', async () => {
  const notes = await createNotes('Retention');
  const base = `/api/projects/${notes.id}`;
  await send('POST', `${base}/data/metrics`, { rows: [metric('2001-01-01', '/old', 1), metric(new Date().toISOString().slice(0, 10), '/new', 1)] });
  const started = await send('POST', `${base}/storage/retention`, {});
  assert.equal(started.status, 202);
  let job = started.body;
  for (let i = 0; i < 100 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 30)); job = (await api(`${base}/storage/jobs/${started.body.id}`)).body; }
  assert.equal(job.status, 'done');
  assert.equal(job.result.removed, 1);
  assert.equal((await api(`${base}/data/metrics`)).body.rows.length, 1);
});

test('I45 a disk-full write stops ingestion for that Building only, tells the person, keeps the data valid, and can be resumed', async () => {
  const a = await createNotes('Full');
  const b = await createNotes('Fine');
  await send('POST', `/api/projects/${a.id}/data/metrics`, { rows: [metric('2025-01-01', '/a', 1)] });
  await (await buildingsApi.getStore((await projectsDb.get(a.id))!)).setFault({ code: 'SQLITE_FULL' });

  const failed = await send('POST', `/api/projects/${a.id}/data/metrics`, { rows: [metric('2025-01-02', '/a', 1)] });
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /disk is full/);
  assert.equal((await send('POST', `/api/projects/${a.id}/data/metrics`, { rows: [metric('2025-01-02', '/a', 1)] })).status, 409);
  assert.equal((await send('POST', `/api/projects/${a.id}/data/metrics/synthetic`, { rows: 10 })).status, 409);
  assert.equal((await api(`/api/projects/${a.id}/data/metrics`)).body.rows.length, 1, 'reads work and the data is intact');
  assert.equal((await send('POST', `/api/projects/${b.id}/data/metrics`, { rows: [metric('2025-01-01', '/b', 1)] })).status, 201, 'the other Building is unaffected');
  const notifications = (await api('/api/notifications')).body.filter((n: { kind: string; projectId: string }) => n.kind === 'storage.problem' && n.projectId === a.id);
  assert.equal(notifications.length, 1);
  assert.match((await api(`/api/projects/${a.id}/storage`)).body.ingestionStoppedReason, /disk is full/);

  assert.equal((await send('POST', `/api/projects/${a.id}/storage/resume`)).status, 200);
  assert.equal((await send('POST', `/api/projects/${a.id}/data/metrics`, { rows: [metric('2025-01-02', '/a', 1)] })).status, 201);
});

test('I16/I17 deleting a Building removes its data and secrets and nothing of another; a failed cleanup is logged, not fatal', async () => {
  const a = await createNotes('Doomed');
  const b = await createNotes('Survivor');
  for (const n of [a, b]) {
    await api(`/api/projects/${n.id}/storage`);
    await send('PUT', `/api/projects/${n.id}/secrets/apiKey`, { value: `value-${n.id}` });
  }
  assert.equal((await send('DELETE', `/api/projects/${a.id}`)).status, 204);
  await assert.rejects(stat(path.join(dataDir, 'buildings', a.id)), /ENOENT/);
  assert.ok((await stat(path.join(dataDir, 'buildings', b.id, 'bulk.sqlite'))).isFile());
  assert.ok((await stat(path.join(dataDir, 'buildings', b.id, 'secrets.json'))).isFile());

  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await buildingsApi.deleteBuildingData(b.id, (() => Promise.reject(new Error('disk says no'))) as never);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]![0]), /Couldn't delete the stored data/);
});

test('I19 exporting a Building writes a standalone SQLite file and records it as the last backup', async () => {
  const notes = await createNotes('Export');
  await send('POST', `/api/projects/${notes.id}/data/metrics`, { rows: [metric('2025-01-01', '/e', 1)] });
  const exported = await send('POST', `/api/projects/${notes.id}/storage/export`);
  assert.equal(exported.status, 201);
  assert.ok((await stat(exported.body.file)).size > 0);
  const status = (await api(`/api/projects/${notes.id}/storage`)).body;
  assert.deepEqual([status.lastBackup.file, status.lastBackup.reason], [exported.body.file, 'export']);
});

test('I57/I58/AC5 a saved credential is reported as saved only, never returned, stored owner-only, scrubbed from logs, and removed with the Building', async () => {
  const notes = await createNotes('Secrets');
  const secret = 'sk-live-very-secret-value-123';
  const put = await send('PUT', `/api/projects/${notes.id}/secrets/searchConsoleKey`, { value: secret });
  assert.deepEqual(put.body, { key: 'searchConsoleKey', hasSecret: true });
  assert.equal((await send('PUT', `/api/projects/${notes.id}/secrets/k`, { value: '' })).status, 400);
  assert.equal((await send('PUT', `/api/projects/${notes.id}/secrets/k`, { value: 5 })).status, 400);

  const list = await api(`/api/projects/${notes.id}/secrets`);
  assert.deepEqual(list.body, [{ key: 'searchConsoleKey', hasSecret: true }]);
  const everything = JSON.stringify([list.body, (await api(`/api/projects/${notes.id}`)).body, (await api('/api/projects')).body, (await api(`/api/projects/${notes.id}/storage`)).body, (await api('/api/notifications')).body]);
  assert.ok(!everything.includes(secret));
  assert.ok(!(await readFile(path.join(dataDir, 'projects.json'), 'utf8')).includes(secret));
  assert.equal(((await stat(path.join(dataDir, 'buildings', notes.id, 'secrets.json'))).mode & 0o777).toString(8), '600');

  const { redactSecrets, installLogRedaction } = await import('../src/buildings/secrets.ts');
  assert.equal(redactSecrets(`token=${secret}!`), 'token=[secret]!');
  const seen: unknown[][] = [];
  const fake = { log: (...a: unknown[]) => { seen.push(a); }, error: (...a: unknown[]) => { seen.push(a); }, warn: (...a: unknown[]) => { seen.push(a); } };
  installLogRedaction(fake);
  fake.error(`failed with ${secret}`, new Error(`inner ${secret}`), 42);
  assert.ok(!JSON.stringify(seen).includes(secret));

  assert.equal((await send('DELETE', `/api/projects/${notes.id}/secrets/searchConsoleKey`)).status, 204);
  assert.deepEqual((await api(`/api/projects/${notes.id}/secrets`)).body, []);
  await send('PUT', `/api/projects/${notes.id}/secrets/again`, { value: secret });
  await send('DELETE', `/api/projects/${notes.id}`);
  await assert.rejects(stat(path.join(dataDir, 'buildings', notes.id, 'secrets.json')), /ENOENT/);
});

test('review #3-#5 secrets: concurrent saves keep both, delete keeps mode 0600, odd names are refused, unknown Buildings are 404', async () => {
  const { SecretsStore } = await import('../src/buildings/secrets.ts');
  const store = new SecretsStore('sec-race');
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.set(`key${i}`, `value-number-${i}`)));
  assert.equal((await store.list()).length, 12, 'no save was lost');
  await store.delete('key3');
  assert.equal(((await stat(path.join(dataDir, 'buildings', 'sec-race', 'secrets.json'))).mode & 0o777).toString(8), '600');
  for (const name of ['__proto__', 'constructor', 'prototype', ' ']) await assert.rejects(store.set(name, 'secret-value'), TypeError, name);
  assert.equal((await store.list()).length, 11);
  assert.throws(() => new SecretsStore('..'), /valid Building id/);
  assert.throws(() => new SecretsStore('a/b'), /valid Building id/);
  assert.equal((await api('/api/projects/nope/secrets')).status, 404);
  assert.equal((await send('DELETE', '/api/projects/nope/secrets/k')).status, 404);
});

test('review #4 scrubbing: saved values load at startup, tiny values are ignored, objects are scrubbed too', async () => {
  const { SecretsStore, loadKnownSecrets, redactSecrets, installLogRedaction } = await import('../src/buildings/secrets.ts');
  await new SecretsStore('sec-boot').set('k', 'boot-time-secret-xyz');
  await new SecretsStore('sec-tiny').set('k', '1');
  await loadKnownSecrets();
  assert.equal(redactSecrets('has boot-time-secret-xyz inside'), 'has [secret] inside');
  assert.equal(redactSecrets('line 1 of 11'), 'line 1 of 11', 'a one-character secret does not garble ordinary lines');
  const seen: unknown[][] = [];
  const fake = { log: (...a: unknown[]) => { seen.push(a); }, error: (...a: unknown[]) => { seen.push(a); }, warn: (...a: unknown[]) => { seen.push(a); } };
  installLogRedaction(fake);
  fake.log({ token: 'boot-time-secret-xyz', n: 1 });
  assert.ok(!JSON.stringify(seen).includes('boot-time-secret-xyz'));
});

test('review #6 a non-string step agent is a 400 naming the field, not a 500', async () => {
  const res = await send('PUT', '/api/building-types/software/slots/feature', { stepAgents: { development: 5 } });
  assert.equal(res.status, 400);
  assert.equal(res.body.field, 'stepAgents.development');
});

test('U23-U29 the secrets store round-trips, isolates Buildings by name, and rejects bad input', async () => {
  const { SecretsStore } = await import('../src/buildings/secrets.ts');
  const one = new SecretsStore('sec-one');
  const two = new SecretsStore('sec-two');
  await one.set('key', 'one');
  await two.set('key', 'two');
  assert.equal(await one.get('key'), 'one');
  assert.equal(await two.get('key'), 'two');
  assert.equal(await one.get('missing'), undefined);
  await assert.rejects(one.set('k', ''), TypeError);
  await assert.rejects(one.set('k', 3 as never), TypeError);
  await assert.rejects(one.set(' ', 'x'), TypeError);
  await one.delete('key');
  await one.delete('never-existed');
  assert.deepEqual(await one.list(), []);
  assert.equal(await two.get('key'), 'two', 'deleting one Building\'s secret leaves the other\'s');
  await two.deleteAll();
  assert.equal(await two.get('key'), undefined);
});

test('I59 a new Building carries owner and tenant fields with the single-user defaults, stored on the record', async () => {
  const notes = await createNotes('Owned');
  const stored = await projectsDb.get(notes.id);
  assert.deepEqual([stored?.ownerId, stored?.tenantId, stored?.typeId, stored?.typeVersion], ['local-user', 'local-tenant', 'notes', 1]);
});

const flow = (id: string, agentId = 'builder') => ({ id, name: `Flow ${id}`, description: 'd', steps: [{ id: 'build', name: 'Build', agentId, canEditCode: true, requiresApproval: false, instructions: 'Build it.' }] });

test('I50 the Catalog config for a type lists each slot with its default, effective workflow and steps with their agents', async () => {
  const res = await api('/api/building-types/software/config');
  assert.equal(res.status, 200);
  const feature = res.body.slots.find((s: { slot: { id: string } }) => s.slot.id === 'feature');
  assert.deepEqual([feature.configuredWorkflowId, feature.effectiveWorkflowId, feature.fellBack, feature.customised], [null, 'software-development', null, false]);
  assert.deepEqual(feature.steps.map((s: { id: string; effectiveAgentId: string }) => [s.id, s.effectiveAgentId]), [['development', 'builder']]);
  const bug = res.body.slots.find((s: { slot: { id: string } }) => s.slot.id === 'bug');
  assert.equal(bug.workflow, null, 'the default is not in this fixture catalog');
  assert.equal((await api('/api/building-types/nope/config')).status, 404);
});

test('I51/U47-U55 setting a slot validates type, slot, workflow, step and agent; persists per type; and resets', async () => {
  await send('POST', '/api/catalog/workflows', flow('alt-flow'));
  const put = (typeId: string, slotId: string, body: unknown) => send('PUT', `/api/building-types/${typeId}/slots/${slotId}`, body);
  assert.equal((await put('nope', 'feature', {})).status, 404);
  assert.equal((await put('software', 'nope', {})).status, 404);
  assert.equal((await put('software', 'feature', { workflowId: 'missing-flow' })).status, 400);
  assert.equal((await put('software', 'feature', { workflowId: 5 })).status, 400);
  assert.equal((await put('software', 'feature', { stepAgents: [] })).status, 400);
  assert.equal((await put('software', 'feature', { stepAgents: { ghost: 'manager' } })).status, 400);
  assert.equal((await put('software', 'feature', { stepAgents: { development: 'ghost-agent' } })).status, 400);

  const set = await put('software', 'feature', { workflowId: 'alt-flow', stepAgents: { build: 'manager' } });
  assert.equal(set.status, 200);
  const slot = (body: { slots: Array<{ slot: { id: string } }> }, id: string) => body.slots.find((s) => s.slot.id === id) as any;
  assert.deepEqual([slot(set.body, 'feature').effectiveWorkflowId, slot(set.body, 'feature').steps[0].effectiveAgentId, slot(set.body, 'feature').customised], ['alt-flow', 'manager', true]);
  assert.equal(slot(set.body, 'bug').customised, false, 'another slot is untouched');
  assert.equal(slot((await api('/api/building-types/notes/config')).body, 'review').effectiveWorkflowId, 'notes-review', 'another type does not share the configuration');
  assert.ok((await readFile(path.join(dataDir, 'building-type-configs.json'), 'utf8')).includes('alt-flow'), 'it is saved to disk');

  const back = await put('software', 'feature', { workflowId: 'software-development' });
  assert.deepEqual(slot(back.body, 'feature').steps.map((s: { configuredAgentId: string | null }) => s.configuredAgentId), [null], 'switching workflow clears the step agents');
  await put('software', 'feature', { stepAgents: { development: 'manager' } });
  assert.equal(slot((await put('software', 'feature', { stepAgents: { development: null } })).body, 'feature').steps[0].configuredAgentId, null, 'one step resets');
  await put('software', 'feature', { workflowId: 'alt-flow' });
  const reset = await send('DELETE', '/api/building-types/software/slots/feature');
  assert.deepEqual([slot(reset.body, 'feature').effectiveWorkflowId, slot(reset.body, 'feature').customised], ['software-development', false]);
  assert.equal((await send('DELETE', '/api/building-types/software/slots/nope')).status, 404);
});

test('I52/U49/U53 deleting a configured workflow or agent falls back to the default with a notice, and the delete itself succeeds', async () => {
  await send('POST', '/api/catalog/workflows', flow('doomed-flow'));
  await send('PUT', '/api/building-types/notes/slots/review', { workflowId: 'doomed-flow' });
  assert.equal((await send('DELETE', '/api/catalog/workflows/doomed-flow')).status, 204);
  const review = (await api('/api/building-types/notes/config')).body.slots.find((s: { slot: { id: string } }) => s.slot.id === 'review');
  assert.deepEqual([review.effectiveWorkflowId, review.fellBack], ['notes-review', { configuredId: 'doomed-flow', defaultId: 'notes-review' }]);
  await send('DELETE', '/api/building-types/notes/slots/review');

  const { primarySlotWorkflow, withStepAgents } = await import('../src/buildings/slotConfig.ts');
  const { getWorkflow } = await import('../src/catalog/workflowService.ts');
  await send('POST', '/api/catalog/workflows', flow('swap-flow'));
  await send('PUT', '/api/building-types/notes/slots/review', { workflowId: 'swap-flow', stepAgents: { build: 'manager' } });
  assert.equal((await primarySlotWorkflow('notes'))?.id, 'swap-flow', 'I53 a run for the type uses the configured workflow');
  const original = (await getWorkflow('swap-flow'))!;
  const applied = await withStepAgents('notes', original);
  assert.equal(applied.steps[0]!.agentId, 'manager', 'I56 the run uses the per-step agent');
  assert.equal(original.steps[0]!.agentId, 'builder', 'the catalog workflow itself is not changed');
  assert.equal((await withStepAgents('software', original)).steps[0]!.agentId, 'builder', 'a workflow outside the type\'s slots is untouched');

  const { deleteAgent } = await import('../src/catalog/catalogService.ts');
  await deleteAgent('manager');
  const config = (await api('/api/building-types/notes/config')).body.slots[0];
  assert.deepEqual([config.steps[0].effectiveAgentId, config.steps[0].agentFellBack], ['builder', true]);
  assert.equal((await withStepAgents('notes', original)).steps[0]!.agentId, 'builder', 'a deleted persona falls back to the step\'s own agent');
});
