import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { BuildingTypeDefinition, StorageSpec } from '../src/buildings/contract.ts';
import type { ProjectRecord } from '../src/domain/types.ts';

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let dataDir: string;
let storage: typeof import('../src/buildings/buildingStorage.ts');
let registry: typeof import('../src/buildings/registry.ts');
let projectsDb: typeof import('../src/db/collections.ts').projectsDb;
let notesType: BuildingTypeDefinition;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'building-life-'));
  dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  storage = await import('../src/buildings/buildingStorage.ts');
  registry = await import('../src/buildings/registry.ts');
  ({ projectsDb } = await import('../src/db/collections.ts'));
  ({ notesType } = await import('../src/buildings/types/notes.ts'));
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await storage.closeAllStores();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const send = (method: string, pathname: string, body?: unknown) => api(pathname, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };

const ledgerStorage = (migrationSql?: string[]): StorageSpec => ({
  tables: [{ name: 't', columns: [{ name: 'a', type: 'text' }, ...(migrationSql ? [{ name: 'b', type: 'integer' as const }] : [])], sortable: ['a'], filterable: ['a'] }],
  rollups: [], migrations: migrationSql ? [{ toVersion: 2, sql: migrationSql }] : [],
});
const ledger = (id: string, migrationSql?: string[]): BuildingTypeDefinition => ({
  ...notesType, id, name: id, version: migrationSql ? 2 : 1, storage: ledgerStorage(migrationSql), slots: notesType.slots,
});

async function createOf(typeId: string, name: string): Promise<ProjectRecord> {
  const res = await send('POST', '/api/projects', { name, typeId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('AC2/I60 a Notes Building end to end: create, ingest, restart, still there, delete, files gone', async () => {
  const notes = await createOf('notes', 'End to end');
  const base = `/api/projects/${notes.id}`;
  const started = await send('POST', `${base}/data/metrics/synthetic`, { rows: 20_000 });
  await until(async () => (await api(`${base}/storage/jobs/${started.body.id}`)).body.status === 'done');
  const before = (await api(`${base}/rollups/daily`)).body.rows[0];
  assert.equal(before.rows, 20_000);

  await storage.closeStore(notes.id); // what a daemon restart does to the open handles
  const after = (await api(`${base}/rollups/daily`)).body.rows[0];
  assert.deepEqual(after, before);
  assert.equal((await api(`${base}/data/metrics?limit=3&sort=clicks&dir=desc`)).body.rows.length, 3);
  assert.equal((await api(`${base}/storage`)).body.retention.rule.months, 12);

  assert.equal((await send('DELETE', base)).status, 204);
  await assert.rejects(stat(path.join(dataDir, 'buildings', notes.id)), /ENOENT/);
  assert.equal((await api(base)).status, 404);
});

test('I46 a type bump migrates the Building at startup: backup first, version recorded, data kept', async () => {
  registry.registerBuildingType(ledger('ledger-ok'));
  const building = await createOf('ledger-ok', 'Ledger ok');
  await send('POST', `/api/projects/${building.id}/data/t`, { rows: [{ a: 'x' }] });
  await storage.closeStore(building.id);

  registry.unregisterBuildingType('ledger-ok');
  registry.registerBuildingType(ledger('ledger-ok', ['ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 5']));
  await storage.migrateAllBuildings();
  const stored = (await projectsDb.get(building.id))!;
  assert.equal(stored.typeVersion, 2);
  assert.equal(stored.lastBackup?.reason, 'migration');
  assert.ok((await stat(stored.lastBackup!.file)).size > 0);
  assert.equal((await api(`/api/projects/${building.id}/data/t`)).body.rows[0].b, 5);

  await storage.closeStore(building.id);
  const backupsBefore = stored.lastBackup!.file;
  await storage.migrateAllBuildings();
  assert.equal((await projectsDb.get(building.id))!.lastBackup?.file, backupsBefore, 'I49 a current Building takes no new backup');
});

test('I47 a failing migration restores the backup and leaves the Building read-only with the error shown', async () => {
  registry.registerBuildingType(ledger('ledger-bad'));
  const building = await createOf('ledger-bad', 'Ledger bad');
  await send('POST', `/api/projects/${building.id}/data/t`, { rows: [{ a: 'keep' }] });
  await storage.closeStore(building.id);

  registry.unregisterBuildingType('ledger-bad');
  registry.registerBuildingType(ledger('ledger-bad', ['ALTER TABLE t ADD COLUMN b INTEGER NOT NULL', 'NOT SQL AT ALL']));
  await storage.migrateAllBuildings();
  const view = (await api(`/api/projects/${building.id}`)).body;
  assert.deepEqual([view.readOnly, view.typeUnavailable, view.typeVersion], [true, false, 1]);
  assert.match(view.readOnlyReason, /Migration to version 2 failed and was rolled back from backup/);
  assert.equal((await api(`/api/projects/${building.id}/storage`)).body.readOnlyReason, view.readOnlyReason);
  assert.equal((await send('POST', `/api/projects/${building.id}/data/t`, { rows: [{ a: 'no' }] })).status, 409);
  assert.equal((await send('POST', `/api/projects/${building.id}/storage/retention`)).status, 409);
  assert.deepEqual((await api(`/api/projects/${building.id}/data/t`)).body.rows.map((r: { a: string }) => r.a), ['keep'], 'reads still work on the restored data');
  assert.equal((await send('DELETE', `/api/projects/${building.id}`)).status, 204);
});

test('U58 data newer than the running code makes the Building read-only', async () => {
  registry.registerBuildingType(ledger('ledger-new', ['ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0']));
  const building = await createOf('ledger-new', 'Ledger new');
  await storage.closeStore(building.id);
  registry.unregisterBuildingType('ledger-new');
  registry.registerBuildingType({ ...ledger('ledger-new'), version: 1 });
  await storage.migrateAllBuildings();
  const view = (await api(`/api/projects/${building.id}`)).body;
  assert.equal(view.readOnly, true);
  assert.match(view.readOnlyReason, /newer than the version 1/);
});

test('I41 retention runs on a schedule driven by an injected clock, and the size check runs with it', async () => {
  const notes = await createOf('notes', 'Scheduled');
  const base = `/api/projects/${notes.id}`;
  await send('POST', `${base}/data/metrics`, { rows: [{ day: '2020-01-01', page: '/old', query: 'q', clicks: 1, impressions: 1 }, { day: '2029-12-01', page: '/new', query: 'q', clicks: 1, impressions: 1 }] });
  await storage.runScheduledMaintenance(new Date('2030-01-01T00:00:00Z'));
  await until(async () => (await api(`${base}/data/metrics`)).body.rows.length === 1);
  assert.equal((await api(`${base}/data/metrics`)).body.rows[0].page, '/new');

  await send('POST', `${base}/data/metrics`, { rows: [{ day: '2020-02-02', page: '/old2', query: 'q', clicks: 1, impressions: 1 }] });
  const stop = storage.startStorageMaintenance(20, () => new Date('2030-01-01T00:00:00Z'));
  try {
    await until(async () => (await api(`${base}/data/metrics`)).body.rows.length === 1);
  } finally {
    stop();
  }
});

test('nothing is dropped by maintenance when the type has no retention rule', async () => {
  registry.registerBuildingType(ledger('ledger-plain'));
  const building = await createOf('ledger-plain', 'Plain');
  await send('POST', `/api/projects/${building.id}/data/t`, { rows: [{ a: 'ancient' }] });
  await storage.runScheduledMaintenance(new Date('2100-01-01'));
  assert.equal((await api(`/api/projects/${building.id}/data/t`)).body.rows.length, 1);
});

const uniqueLedger = (): BuildingTypeDefinition => ({
  ...notesType, id: 'ledger-unique', name: 'Unique', storage: {
    tables: [{ name: 'kw', columns: [{ name: 'word', type: 'text' }, { name: 'volume', type: 'integer' }], sortable: ['word'], filterable: ['word'], uniqueKey: ['word'], onConflict: 'fail' }],
    rollups: [], migrations: [],
  },
});

test('review #1 a duplicate key from the caller is a 409 for that request and does not stop ingestion for the Building', async () => {
  registry.registerBuildingType(uniqueLedger());
  const building = await createOf('ledger-unique', 'Unique words');
  const base = `/api/projects/${building.id}`;
  assert.equal((await send('POST', `${base}/data/kw`, { rows: [{ word: 'a', volume: 1 }] })).status, 201);
  const dup = await send('POST', `${base}/data/kw`, { rows: [{ word: 'b', volume: 2 }, { word: 'a', volume: 9 }] });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /refused by the table/);
  assert.equal((await api(`${base}/storage`)).body.ingestionStoppedReason, null, 'ingestion keeps running');
  const notices = (await api('/api/notifications')).body.filter((n: { kind: string; projectId: string }) => n.kind === 'storage.problem' && n.projectId === building.id);
  assert.equal(notices.length, 0, 'no storage notification for a caller\'s bad data');
  assert.equal((await send('POST', `${base}/data/kw`, { rows: [{ word: 'c', volume: 3 }] })).status, 201);
  assert.equal((await api(`${base}/data/kw`)).body.rows.length, 2, 'the failed batch left nothing behind');
  assert.equal((await send('POST', `${base}/data/kw`, { rows: [{ word: 'd', volume: 'many' }] })).status, 400, 'a mistyped value is refused before the worker');
});

test('review #1 only real storage faults count as storage faults', async () => {
  const { StorageOpError } = await import('../src/buildings/bulkClient.ts');
  const err = (code?: string, status?: number) => new StorageOpError({ message: 'x', code, status });
  for (const code of ['SQLITE_FULL', 'SQLITE_IOERR_WRITE', 'SQLITE_READONLY', 'SQLITE_CORRUPT', 'SQLITE_CANTOPEN']) assert.equal(storage.isStorageFault(err(code)), true, code);
  for (const code of ['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_BUSY', undefined]) assert.equal(storage.isStorageFault(err(code)), false, String(code));
  assert.equal(storage.isStorageFault(err('SQLITE_FULL', 400)), false);
});

test('review #2 a table cannot declare an onConflict mode the store does not implement', () => {
  const bad = ledger('ledger-replace');
  (bad.storage!.tables[0] as { onConflict?: string }).onConflict = 'replace';
  assert.throws(() => registry.registerBuildingType(bad), /unsupported onConflict "replace"/);
});

test('review #7 a second start with different settings is refused, finished jobs are pruned per Building', async () => {
  const notes = await createOf('notes', 'Jobs');
  const base = `/api/projects/${notes.id}`;
  const first = await send('POST', `${base}/data/metrics/synthetic`, { rows: 2_000_000 });
  assert.equal(first.status, 202);
  assert.equal((await send('POST', `${base}/data/metrics/synthetic`, { rows: 2_000_000 })).body.id, first.body.id, 'same settings share the running job');
  const other = await send('POST', `${base}/data/metrics/synthetic`, { rows: 5 });
  assert.equal(other.status, 409);
  assert.match(other.body.error, /different settings/);
  await send('POST', `${base}/storage/jobs/${first.body.id}/cancel`);
  await until(async () => (await api(`${base}/storage/jobs/${first.body.id}`)).body.status !== 'running');
  for (let i = 0; i < 25; i++) {
    const job = await send('POST', `${base}/data/metrics/synthetic`, { rows: 10 + i });
    await until(async () => (await api(`${base}/storage/jobs/${job.body.id}`)).body.status === 'done');
  }
  assert.equal((await api(`${base}/storage/jobs/${first.body.id}`)).status, 404, 'the oldest finished job was dropped');
});
