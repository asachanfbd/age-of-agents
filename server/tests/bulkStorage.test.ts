import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { BulkStore, StorageCrashError, StorageOpError } from '../src/buildings/bulkClient.ts';
import type { StorageSpec } from '../src/buildings/contract.ts';
import { metricRows, DEFAULT_SYNTHETIC } from '../src/buildings/syntheticData.ts';
import { NOTES_STORAGE } from '../src/buildings/types/notes.ts';

let root: string;
const opened: BulkStore[] = [];

before(async () => { root = await mkdtemp(path.join(tmpdir(), 'bulk-test-')); });
after(async () => {
  await Promise.all(opened.map((s) => s.close().catch(() => undefined)));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

let counter = 0;
async function makeStore(spec: StorageSpec = NOTES_STORAGE, version = 1, name = `b${counter++}`, faultInjection = false) {
  const dir = path.join(root, name);
  const store = new BulkStore({ file: path.join(dir, 'bulk.sqlite'), spec, version, backupDir: path.join(dir, 'backups'), faultInjection });
  opened.push(store);
  const outcome = await store.open();
  return { store, dir, file: path.join(dir, 'bulk.sqlite'), outcome };
}

const metric = (day: string, page: string, clicks: number, impressions = clicks) => ({ day, page, query: 'q', clicks, impressions });
const arrays = (rows: ReturnType<typeof metric>[]) => rows.map((r) => [r.day, r.page, r.query, r.clicks, r.impressions]);

async function ingest(store: BulkStore, rows: number, onProgress?: (p: { done: number; total: number }) => void) {
  return store.startJob<{ inserted: number; cancelled: boolean }>('ingestSynthetic', { table: 'metrics', rows }, onProgress);
}

/** Every row of a table, paged with cursors only. */
async function readAll(store: BulkStore, table: string, request: Record<string, unknown>) {
  const out: Array<Record<string, string | number>> = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(table, { ...request, limit: 200, cursor });
    out.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

test('I15 data persists across closing and reopening the Building\'s storage', async () => {
  const a = await makeStore();
  await a.store.insert('metrics', arrays([metric('2025-01-01', '/a', 3)]));
  await a.store.close();
  const again = new BulkStore({ file: a.file, spec: NOTES_STORAGE, version: 1, backupDir: path.join(a.dir, 'backups') });
  opened.push(again);
  assert.equal((await again.count('metrics')).count, 1);
});

test('I13 two Buildings of the same type have separate files and never see each other\'s data', async () => {
  const [a, b] = [await makeStore(), await makeStore()];
  assert.notEqual(a.file, b.file);
  await a.store.insert('metrics', arrays([metric('2025-01-01', '/only-a', 1)]));
  assert.equal((await b.store.count('metrics')).count, 0);
  assert.deepEqual((await b.store.aggregate('daily', {})).rows, [{ clicks: null, impressions: null, rows: null }]);
});

test('I14 a corrupted Building file reports an error and leaves the other Building working', async () => {
  const a = await makeStore();
  const b = await makeStore();
  await a.store.close();
  await writeFile(a.file, 'this is not a database'.repeat(500));
  const broken = new BulkStore({ file: a.file, spec: NOTES_STORAGE, version: 1, backupDir: path.join(a.dir, 'backups') });
  opened.push(broken);
  await assert.rejects(broken.open(), StorageOpError);
  await b.store.insert('metrics', arrays([metric('2025-01-01', '/b', 2)]));
  assert.equal((await b.store.count('metrics')).count, 1);
});

test('I19 an export is a standalone, openable SQLite file with only that Building\'s data', async () => {
  const a = await makeStore();
  const other = await makeStore();
  await a.store.insert('metrics', arrays([metric('2025-01-01', '/a', 4)]));
  await other.store.insert('metrics', arrays([metric('2025-01-01', '/other', 9), metric('2025-01-02', '/other', 9)]));
  const dest = path.join(root, 'exports', 'a.sqlite');
  await a.store.backup(dest);
  const db = new Database(dest, { readonly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM metrics').get() as { n: number }).n, 1);
  db.close();
});

test('I20 list pages, filters, sorts and searches match an in-test computation over generated rows', async () => {
  const { store } = await makeStore();
  const total = 30_000;
  assert.equal((await (await ingest(store, total)).result).inserted, total);
  const truth = [...metricRows({ ...DEFAULT_SYNTHETIC, rows: total, seed: 1 })].map((r, i) => ({ id: i + 1, day: r[0] as string, page: r[1] as string, query: r[2] as string, clicks: r[3] as number, impressions: r[4] as number }));

  const first = await store.list('metrics', { limit: 5 });
  assert.deepEqual(first.rows.map((r) => r.id), [1, 2, 3, 4, 5]);

  const filtered = await readAll(store, 'metrics', { filters: [{ col: 'page', op: 'eq', value: '/page-7' }], sort: 'clicks', dir: 'desc' });
  const expected = truth.filter((r) => r.page === '/page-7').sort((x, y) => y.clicks - x.clicks || y.id - x.id);
  assert.deepEqual(filtered.map((r) => r.id), expected.map((r) => r.id));

  const searched = await readAll(store, 'metrics', { search: 'query 4999', sort: 'day' });
  assert.deepEqual(searched.map((r) => r.id).sort((x, y) => (x as number) - (y as number)), truth.filter((r) => r.query.includes('query 4999') || r.page.includes('query 4999')).map((r) => r.id));
});

test('I21 paging with cursors returns every row exactly once, including ties on the sort key', async () => {
  const { store } = await makeStore();
  await (await ingest(store, 5000)).result;
  for (const [sort, dir] of [['clicks', 'asc'], ['clicks', 'desc'], ['day', 'desc'], ['page', 'asc']]) {
    const ids = (await readAll(store, 'metrics', { sort, dir })).map((r) => r.id as number);
    assert.equal(ids.length, 5000, `${sort} ${dir}`);
    assert.equal(new Set(ids).size, 5000, `${sort} ${dir} has no duplicates`);
  }
});

test('I22 a row inserted between page fetches never causes a duplicate or a skip of existing rows', async () => {
  const { store } = await makeStore();
  await store.insert('metrics', arrays(Array.from({ length: 10 }, (_, i) => metric(`2025-01-${String(i + 1).padStart(2, '0')}`, '/p', i))));
  const page1 = await store.list('metrics', { sort: 'day', limit: 5 });
  await store.insert('metrics', arrays([metric('2025-01-03', '/late', 1)]));
  const page2 = await store.list('metrics', { sort: 'day', limit: 20, cursor: page1.nextCursor! });
  const ids = [...page1.rows, ...page2.rows].map((r) => r.id as number);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.filter((i) => i <= 10).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('I23/I30 aggregates match the raw rows, come from the roll-up table, and stay equal to raw after ingestion', async () => {
  const { store } = await makeStore();
  await (await ingest(store, 20_000)).result;
  const truth = [...metricRows({ ...DEFAULT_SYNTHETIC, rows: 20_000, seed: 1 })];
  const clicks = truth.reduce((s, r) => s + (r[3] as number), 0);
  const total = await store.aggregate('daily', {});
  assert.equal(total.source, 'rollup_daily');
  assert.deepEqual(total.rows[0], { clicks, impressions: truth.reduce((s, r) => s + (r[4] as number), 0), rows: 20_000 });

  const topPages = await store.aggregate('day_page', { groupBy: ['page'], orderBy: 'clicks', limit: 3 });
  const byPage = new Map<string, number>();
  for (const r of truth) byPage.set(r[1] as string, (byPage.get(r[1] as string) ?? 0) + (r[3] as number));
  const top = [...byPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([page]) => page);
  assert.deepEqual(topPages.rows.map((r) => r.page), top);

  const someDay = truth[0]![0] as string;
  const period = await store.aggregate('daily', { groupBy: ['day'], range: { col: 'day', from: someDay, to: someDay } });
  assert.equal(period.rows[0]!.clicks, truth.filter((r) => r[0] === someDay).reduce((s, r) => s + (r[3] as number), 0));
});

test('I24/I26/I27 a bad request fails as a 400-class error, never an SQL error; a missing table is rejected', async () => {
  const { store } = await makeStore();
  const reject = async (p: Promise<unknown>) => assert.rejects(p, (e: StorageOpError) => e instanceof StorageOpError && e.status === 400);
  await reject(store.list('metrics', { sort: 'nope' }));
  await reject(store.list('metrics', { limit: 0 }));
  await reject(store.list('missing', {}));
  await reject(store.aggregate('missing', {}));
  const huge = await store.list('metrics', { limit: 10_000_000 });
  assert.ok(huge.rows.length <= 200);
});

test('I25 no response ever holds more than the maximum page size', async () => {
  const { store } = await makeStore();
  await (await ingest(store, 1000)).result;
  assert.equal((await store.list('metrics', { limit: 100_000 })).rows.length, 200);
});

test('I28 a batch is atomic: a failure on row K leaves none of the batch or its roll-ups', async () => {
  const { store } = await makeStore(NOTES_STORAGE, 1, undefined, true);
  await store.insert('metrics', arrays([metric('2025-01-01', '/keep', 5)]));
  await store.setFault({ code: 'SQLITE_BUSY', atRow: 3 });
  await assert.rejects(store.insert('metrics', arrays(Array.from({ length: 6 }, (_, i) => metric('2025-01-02', `/x${i}`, 1)))), StorageOpError);
  assert.equal((await store.count('metrics')).count, 1);
  assert.deepEqual((await store.aggregate('daily', {})).rows[0], { clicks: 5, impressions: 5, rows: 1 });
});

test('I31 a duplicate key follows the type\'s conflict rule and the error is surfaced', async () => {
  const spec = (onConflict: 'fail' | 'ignore'): StorageSpec => ({
    tables: [{ name: 'kw', columns: [{ name: 'word', type: 'text' }, { name: 'volume', type: 'integer' }], sortable: ['word'], filterable: ['word'], uniqueKey: ['word'], onConflict }],
    rollups: [{ name: 'total', table: 'kw', groupBy: ['word'], measures: ['volume'] }], migrations: [],
  });
  const strict = await makeStore(spec('fail'));
  await strict.store.insert('kw', [['a', 1]]);
  await assert.rejects(strict.store.insert('kw', [['b', 2], ['a', 9]]), /UNIQUE/);
  assert.equal((await strict.store.count('kw')).count, 1);
  const lenient = await makeStore(spec('ignore'));
  await lenient.store.insert('kw', [['a', 1]]);
  assert.deepEqual(await lenient.store.insert('kw', [['a', 9], ['b', 2]]), { inserted: 1 });
  assert.deepEqual((await lenient.store.aggregate('total', { groupBy: ['word'] })).rows.map((r) => r.volume), [1, 2], 'an ignored row is not counted in the roll-up');
});

test('I29 a worker killed mid-ingest leaves only whole committed batches and roll-ups equal to the raw rows', async () => {
  const { store, file } = await makeStore();
  const job = await ingest(store, 400_000);
  const settled = job.result.catch((e) => e);
  await new Promise((r) => setTimeout(r, 300));
  await store.terminateForTest();
  assert.ok((await settled) instanceof StorageCrashError);

  const db = new Database(file, { readonly: true });
  const raw = db.prepare('SELECT COUNT(*) AS n, SUM(clicks) AS clicks FROM metrics').get() as { n: number; clicks: number };
  const rolled = db.prepare('SELECT SUM(rows) AS n, SUM(clicks) AS clicks FROM rollup_daily').get() as { n: number; clicks: number };
  db.close();
  assert.ok(raw.n > 0 && raw.n < 400_000, 'it was interrupted part-way');
  assert.equal(raw.n % 5000, 0, 'only whole batches are present');
  assert.deepEqual(rolled, raw);
  assert.equal((await store.count('metrics')).count, raw.n, 'the next call restarts the worker and reads the same data');
});

test('I32/I33 a long ingest reports monotonic progress and does not block the daemon or other Buildings', async () => {
  const a = await makeStore();
  const b = await makeStore();
  await b.store.insert('metrics', arrays([metric('2025-01-01', '/b', 1)]));
  const progress: number[] = [];
  let worstLag = 0;
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); worstLag = Math.max(worstLag, now - last - 10); last = now; }, 10);
  const job = await ingest(a.store, 150_000, (p) => progress.push(p.done));
  let otherAnswered = 0;
  while (!(await Promise.race([job.result.then(() => true), new Promise((r) => setTimeout(() => r(false), 20))]))) {
    assert.equal((await b.store.count('metrics')).count, 1);
    otherAnswered++;
  }
  clearInterval(timer);
  assert.ok(otherAnswered > 0, 'another Building answered during the ingest');
  assert.ok(worstLag < 1000, `event loop lag ${worstLag.toFixed(0)}ms stayed small`);
  assert.deepEqual(progress, [...progress].sort((x, y) => x - y));
  assert.equal(progress.at(-1), 150_000);
});

test('I34/I35 cancel stops between batches with only whole batches kept, and a later operation works', async () => {
  const { store } = await makeStore();
  const job = await ingest(store, 2_000_000);
  await new Promise((r) => setTimeout(r, 200));
  job.cancel();
  const result = await job.result;
  assert.equal(result.cancelled, true);
  const { count } = await store.count('metrics');
  assert.equal(count, result.inserted);
  assert.equal(count % 5000, 0);
  assert.ok(count > 0 && count < 2_000_000);
  assert.deepEqual(await store.insert('metrics', arrays([metric('2025-01-01', '/after', 1)])), { inserted: 1 });
});

test('I36 resident memory does not grow with data volume', async () => {
  const { store } = await makeStore();
  const measure = async () => { global.gc?.(); return process.memoryUsage().heapUsed; };
  await (await ingest(store, 10_000)).result;
  await store.list('metrics', { sort: 'clicks', limit: 200 });
  const small = await measure();
  await (await ingest(store, 200_000)).result;
  await store.list('metrics', { sort: 'clicks', limit: 200 });
  await store.aggregate('day_page', { groupBy: ['page'], orderBy: 'clicks' });
  const large = await measure();
  assert.ok(large - small < 40 * 1024 * 1024, `daemon heap grew ${((large - small) / 1048576).toFixed(1)} MB for 20x the data`);
});

test('I37/I38 a crashed worker rejects its pending calls and is restarted on next use; close releases the file', async () => {
  const { store, file } = await makeStore();
  await store.insert('metrics', arrays([metric('2025-01-01', '/a', 1)]));
  const slow = (await ingest(store, 500_000)).result.catch((e) => e);
  await new Promise((r) => setTimeout(r, 100));
  await store.terminateForTest();
  assert.ok((await slow) instanceof StorageCrashError);
  assert.equal(store.alive, false);
  assert.ok((await store.count('metrics')).count >= 1);
  assert.equal(store.alive, true);
  await store.close();
  assert.equal(store.alive, false);
  await assert.rejects(store.count('metrics'), StorageCrashError);
  await rm(file); // the file handle is released, so it can be removed
});

test('I45 a disk-full error is surfaced as such and the data stays valid', async () => {
  const { store } = await makeStore(NOTES_STORAGE, 1, undefined, true);
  await store.insert('metrics', arrays([metric('2025-01-01', '/a', 1)]));
  await store.setFault({ code: 'SQLITE_FULL' });
  await assert.rejects(store.insert('metrics', arrays([metric('2025-01-02', '/b', 1)])), (e: StorageOpError) => e.code === 'SQLITE_FULL');
  assert.equal((await store.count('metrics')).count, 1);
  assert.deepEqual(await store.insert('metrics', arrays([metric('2025-01-02', '/b', 1)])), { inserted: 1 });
});

test('fault injection is refused unless it was enabled when opening', async () => {
  const { store } = await makeStore();
  await assert.rejects(store.setFault({ code: 'SQLITE_FULL' }), /not enabled/);
});

test('I39/I40 retention deletes only rows older than the cutoff, keeps roll-ups consistent, and leaves other tables alone', async () => {
  const { store } = await makeStore();
  await store.insert('notes', [['n', 'b', '2020-01-01T00:00:00Z']]);
  await store.insert('metrics', arrays([
    metric('2024-01-01', '/old', 10), metric('2024-01-01', '/old2', 5), metric('2025-03-14', '/just-before', 2), metric('2025-03-15', '/on-cutoff', 3), metric('2025-12-01', '/new', 7),
  ]));
  const result = await store.startJob<{ removed: number; cutoff: string }>('retention', { now: '2026-03-15T00:00:00Z' }).result;
  assert.deepEqual([result.removed, result.cutoff], [3, '2025-03-15']);
  assert.deepEqual((await readAll(store, 'metrics', { sort: 'day' })).map((r) => r.page), ['/on-cutoff', '/new']);
  assert.deepEqual((await store.aggregate('daily', {})).rows[0], { clicks: 10, impressions: 10, rows: 2 });
  assert.deepEqual((await store.aggregate('daily', { groupBy: ['day'] })).rows.map((r) => r.day), ['2025-03-15', '2025-12-01']);
  assert.equal((await store.count('notes')).count, 1);
});

test('retention in roll-up mode keeps the roll-up totals for the discarded period', async () => {
  const spec: StorageSpec = { ...NOTES_STORAGE, retention: { ...NOTES_STORAGE.retention!, mode: 'rollup' } };
  const { store } = await makeStore(spec);
  await store.insert('metrics', arrays([metric('2024-01-01', '/old', 10), metric('2025-12-01', '/new', 7)]));
  await store.startJob('retention', { now: '2026-03-15T00:00:00Z' }).result;
  assert.equal((await store.count('metrics')).count, 1);
  assert.equal((await store.aggregate('daily', {})).rows[0]!.clicks, 17);
});

test('retention deletes in chunks with progress and can compact the file', async () => {
  const { store, file } = await makeStore();
  await (await ingest(store, 60_000)).result;
  const before = (await stat(file)).size;
  const progress: number[] = [];
  const result = await store.startJob<{ removed: number }>('retention', { now: new Date('2030-01-01').toISOString(), compact: true }, (p) => progress.push(p.done)).result;
  assert.equal(result.removed, 60_000);
  assert.equal(progress.at(-1), 60_000);
  assert.ok((await stat(file)).size < before, 'compacting shrinks the file');
  assert.equal((await store.aggregate('daily', {})).rows[0]!.rows, null, 'no roll-up rows remain');
});

test('a type without a retention rule never prunes', async () => {
  const { store } = await makeStore({ ...NOTES_STORAGE, retention: undefined });
  await store.insert('metrics', arrays([metric('1999-01-01', '/ancient', 1)]));
  assert.equal((await store.startJob<{ removed: number }>('retention', { now: '2030-01-01T00:00:00Z' }).result).removed, 0);
  assert.equal((await store.count('metrics')).count, 1);
});

const v1: StorageSpec = { tables: [{ name: 't', columns: [{ name: 'a', type: 'text' }], sortable: ['a'], filterable: ['a'] }], rollups: [], migrations: [] };
const v2 = (sql: string[]): StorageSpec => ({ ...v1, tables: [{ ...v1.tables[0]!, columns: [{ name: 'a', type: 'text' }, { name: 'b', type: 'integer' }] }], migrations: [{ toVersion: 2, sql }] });

async function reopen(dir: string, spec: StorageSpec, version: number) {
  const store = new BulkStore({ file: path.join(dir, 'bulk.sqlite'), spec, version, backupDir: path.join(dir, 'backups') });
  opened.push(store);
  return { store, outcome: await store.open() };
}

test('I46/I49 a migration takes a backup first, runs in one transaction and records the version; a current Building takes no backup', async () => {
  const { store, dir, outcome } = await makeStore(v1, 1, 'mig-ok');
  assert.equal(outcome.status, 'ok');
  await store.insert('t', [['x']]);
  await store.close();
  const unchanged = await reopen(dir, v1, 1);
  assert.equal(unchanged.outcome.status, 'ok');
  await unchanged.store.close();
  await assert.rejects(readdir(path.join(dir, 'backups')), /ENOENT/);

  const migrated = await reopen(dir, v2(['ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 7']), 2);
  assert.equal(migrated.outcome.status, 'migrated');
  assert.equal(migrated.outcome.version, 2);
  assert.equal((await readdir(path.join(dir, 'backups'))).length, 1);
  assert.equal((await migrated.store.list('t', {})).rows[0]!.b, 7);
  const backup = new Database(migrated.outcome.backupFile!, { readonly: true });
  assert.deepEqual(backup.prepare('SELECT * FROM t').all(), [{ id: 1, a: 'x' }], 'the backup holds the pre-migration data');
  backup.close();
});

test('I47/I48 a failing migration restores the backup, leaves no partial change and reports the error', async () => {
  const { store, dir } = await makeStore(v1, 1, 'mig-bad');
  await store.insert('t', [['x'], ['y']]);
  await store.close();
  const failed = await reopen(dir, v2(['CREATE TABLE half (z INTEGER)', 'ALTER TABLE t ADD COLUMN b INTEGER NOT NULL', 'THIS IS NOT SQL']), 2);
  assert.equal(failed.outcome.status, 'failed');
  assert.equal(failed.outcome.version, 1);
  assert.match(failed.outcome.error!, /syntax error|NOT NULL/i);
  await failed.store.close();
  const db = new Database(path.join(dir, 'bulk.sqlite'), { readonly: true });
  assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY id').all(), [{ a: 'x' }, { a: 'y' }]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half'").get(), undefined, 'the partly applied step was rolled back');
  db.close();
});

test('U58 data newer than the code opens as "newer" without being touched', async () => {
  const { store, dir } = await makeStore(v2(['ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0']), 2, 'mig-newer');
  await store.close();
  const older = await reopen(dir, v1, 1);
  assert.deepEqual([older.outcome.status, older.outcome.version], ['newer', 2]);
});

test('a large load into an empty table builds its indexes once at the end, and still has them after a cancel', async () => {
  const indexNames = (file: string) => {
    const db = new Database(file, { readonly: true });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix_metrics_%'").all() as Array<{ name: string }>).map((r) => r.name).sort();
    db.close();
    return names;
  };
  const expected = ['ix_metrics_clicks', 'ix_metrics_day', 'ix_metrics_impressions', 'ix_metrics_page', 'ix_metrics_page_day'];

  const done = await makeStore();
  const phases: Array<string | undefined> = [];
  const result = await done.store.startJob<{ inserted: number }>('ingestSynthetic', { table: 'metrics', rows: 600_000 }, (p) => phases.push(p.phase)).result;
  assert.equal(result.inserted, 600_000);
  assert.equal(phases.at(-1), 'indexing', 'the last progress report says the indexes are being built');
  assert.deepEqual(indexNames(done.file), expected);
  assert.equal((await done.store.list('metrics', { sort: 'clicks', dir: 'desc', limit: 1 })).rows.length, 1);

  const cancelled = await makeStore();
  const job = await ingest(cancelled.store, 5_000_000);
  await new Promise((r) => setTimeout(r, 300));
  job.cancel();
  assert.equal((await job.result).cancelled, true);
  assert.deepEqual(indexNames(cancelled.file), expected);
});
