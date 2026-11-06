import { parentPort } from 'node:worker_threads';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ReplaceStep, RollupSpec, StorageSpec, TableSpec } from './contract.ts';
import { buildAggregateQuery, buildListQuery, encodeCursor, QueryError } from './query.ts';
import type { AggregateRequest, GroupSumsRequest, ListRequest } from './query.ts';
import { rollupTable, schemaStatements, tableIndexes } from './schema.ts';
import { retentionCutoff } from './retention.ts';
import { DEFAULT_SYNTHETIC, hasSyntheticData, syntheticRows } from './syntheticData.ts';

/**
 * One Building's SQLite database, owned by this worker thread so synchronous database work never blocks the
 * daemon. Every long operation is a sequence of short transactions with a yield between them, which is what lets
 * progress, cancel and other queries get through while it runs. See bulkClient.ts for the message protocol.
 */

const BATCH_ROWS = 5000;
const RETENTION_CHUNK = 20_000;

type Statement = Database.Statement<any[]>;

let db: Database.Database;
let spec: StorageSpec;
let faultInjection = false;
let fault: { code: string; atRow?: number } | null = null;
const cancelled = new Set<number>();
const statements = new Map<string, Statement>();

function post(message: unknown): void {
  parentPort!.postMessage(message);
}

function tableOf(name: string): TableSpec {
  const table = spec.tables.find((t) => t.name === name);
  if (!table) throw new QueryError(`unknown table "${name}"`);
  return table;
}

function prepared(sql: string): Statement {
  let stmt = statements.get(sql);
  if (!stmt) { stmt = db.prepare(sql); statements.set(sql, stmt); }
  return stmt;
}

function openDatabase(file: string): Database.Database {
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.pragma('synchronous = NORMAL');
  // A fixed page cache keeps the daemon's memory flat however large the file grows.
  d.pragma('cache_size = -65536');
  return d;
}

function readVersion(): number | null {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_meta'").get();
  if (!has) return null;
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

function writeVersion(version: number): void {
  db.prepare("INSERT INTO _meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
}

function ensureSchema(): void {
  for (const sql of schemaStatements(spec)) db.exec(sql);
}

interface OpenParams { file: string; spec: StorageSpec; version: number; backupDir: string; faultInjection?: boolean }
interface OpenResult { status: 'ok' | 'migrated' | 'newer' | 'failed'; version: number; backupFile?: string; error?: string }

async function open(p: OpenParams): Promise<OpenResult> {
  spec = p.spec; faultInjection = p.faultInjection === true;
  await mkdir(path.dirname(p.file), { recursive: true });
  db = openDatabase(p.file);
  const stored = readVersion();
  if (stored === null) {
    db.transaction(() => { ensureSchema(); writeVersion(p.version); })();
    return { status: 'ok', version: p.version };
  }
  if (stored > p.version) return { status: 'newer', version: stored };
  if (stored === p.version) { ensureSchema(); return { status: 'ok', version: stored }; }

  await mkdir(p.backupDir, { recursive: true });
  const backupFile = path.join(p.backupDir, `pre-migrate-v${stored}-${Date.now()}.sqlite`);
  await db.backup(backupFile);
  try {
    db.transaction(() => {
      for (const step of p.spec.migrations.filter((m) => m.toVersion > stored)) {
        for (const sql of step.sql) db.exec(sql);
        writeVersion(step.toVersion);
      }
      ensureSchema();
    })();
    return { status: 'migrated', version: p.version, backupFile };
  } catch (error) {
    db.close();
    statements.clear();
    await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(p.file + suffix, { force: true })));
    await copyFile(backupFile, p.file);
    db = openDatabase(p.file);
    return { status: 'failed', version: stored, backupFile, error: (error as Error).message };
  }
}

function maybeFault(rowIndex: number): void {
  if (!fault || (fault.atRow !== undefined && rowIndex !== fault.atRow)) return;
  const { code } = fault;
  fault = null;
  throw Object.assign(new Error(code === 'SQLITE_FULL' ? 'database or disk is full' : 'injected failure'), { code });
}

/** Inserts rows and maintains the roll-ups in one transaction, so a failure leaves none of the batch and the roll-ups never disagree with the raw rows. Returns how many rows were actually added. */
function insertRows(table: TableSpec, rows: Array<Array<string | number>>): number {
  const cols = table.columns.map((c) => c.name);
  const verb = table.onConflict === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT';
  const insert = prepared(`${verb} INTO ${table.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const rollups = spec.rollups.filter((r) => r.table === table.name);
  const accumulators = rollups.map(() => new Map<string, { group: Array<string | number>; sums: number[]; rows: number }>());
  const idx = (names: string[]) => names.map((n) => cols.indexOf(n));
  const plans = rollups.map((r) => ({ groups: idx(r.groupBy), measures: idx(r.measures) }));

  return db.transaction(() => {
    let inserted = 0;
    rows.forEach((row, rowIndex) => {
      if (faultInjection) maybeFault(rowIndex);
      if (insert.run(...row).changes === 0) return;
      inserted++;
      plans.forEach((plan, i) => {
        const group = plan.groups.map((g) => row[g] as string | number);
        const key = group.join('\u0000');
        let acc = accumulators[i]!.get(key);
        if (!acc) { acc = { group, sums: plan.measures.map(() => 0), rows: 0 }; accumulators[i]!.set(key, acc); }
        plan.measures.forEach((m, j) => { acc!.sums[j]! += row[m] as number; });
        acc.rows++;
      });
    });
    rollups.forEach((r, i) => {
      const columns = [...r.groupBy, ...r.measures, 'rows'];
      const upsert = prepared(`INSERT INTO ${rollupTable(r.name)} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        + ` ON CONFLICT(${r.groupBy.join(', ')}) DO UPDATE SET ${[...r.measures, 'rows'].map((c) => `${c} = ${c} + excluded.${c}`).join(', ')}`);
      for (const acc of accumulators[i]!.values()) upsert.run(...acc.group, ...acc.sums, acc.rows);
    });
    return inserted;
  })();
}

function list(p: { table: string; request: ListRequest }) {
  const query = buildListQuery(tableOf(p.table), p.request);
  const rows = prepared(query.sql).all(...query.params) as Array<Record<string, string | number>>;
  let nextCursor: string | null = null;
  if (rows.length > query.pageSize) {
    rows.pop();
    const last = rows[rows.length - 1]!;
    nextCursor = encodeCursor(query.sortCol === 'id' ? last.id! : last[query.sortCol]!, last.id as number);
  }
  return { rows, nextCursor, total: null };
}

function aggregate(p: { rollup: string; request: AggregateRequest }) {
  const rollup = spec.rollups.find((r) => r.name === p.rollup);
  if (!rollup) throw new QueryError(`unknown rollup "${p.rollup}"`);
  const query = buildAggregateQuery(rollup, p.request);
  return { rows: prepared(query.sql).all(...query.params), source: rollupTable(rollup.name) };
}

const yieldToMessages = () => new Promise<void>((resolve) => setImmediate(resolve));

interface JobContext { id: number }

/** Pulls up to `n` rows without closing the generator (a for-of `break` would). */
function takeBatch<T>(it: Iterator<T>, n: number): T[] {
  const out: T[] = [];
  while (out.length < n) {
    const next = it.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

/** Tables at least this big, when empty, are loaded without their secondary indexes, which are built once at the end: random index inserts into a multi-million-row table are far slower than one sorted index build. */
const DEFERRED_INDEX_ROWS = 500_000;

async function ingestSynthetic(ctx: JobContext, p: { table: string; rows: number; seed?: number; days?: number }) {
  const table = tableOf(p.table);
  if (!hasSyntheticData(p.table)) throw new QueryError(`${p.table} has no synthetic data`);
  const rows = syntheticRows(p.table, { ...DEFAULT_SYNTHETIC, rows: p.rows, seed: p.seed ?? 1, days: p.days ?? DEFAULT_SYNTHETIC.days });
  const indexes = tableIndexes(table);
  const deferIndexes = p.rows >= DEFERRED_INDEX_ROWS && !prepared(`SELECT 1 FROM ${table.name} LIMIT 1`).get();
  if (deferIndexes) for (const index of indexes) db.exec(`DROP INDEX IF EXISTS ${index.name}`);
  let done = 0;
  try {
    while (done < p.rows) {
      if (cancelled.has(ctx.id)) return { inserted: done, total: p.rows, cancelled: true };
      const batch = takeBatch(rows, BATCH_ROWS);
      if (!batch.length) break;
      insertRows(table, batch);
      done += batch.length;
      post({ id: ctx.id, type: 'progress', done, total: p.rows });
      await yieldToMessages();
    }
    return { inserted: done, total: p.rows, cancelled: false };
  } finally {
    if (deferIndexes) {
      post({ id: ctx.id, type: 'progress', done, total: p.rows, phase: 'indexing' });
      await yieldToMessages();
      for (const index of indexes) db.exec(index.sql);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

/** The tables a retention run prunes and the first day it keeps. `months` overrides the rule's window for one Building. */
function retentionScope(p: { now: string; months?: number }) {
  const rule = spec.retention!;
  const cutoff = retentionCutoff({ months: p.months ?? rule.months }, new Date(p.now));
  return { rule, cutoff, tables: [rule.table, ...(rule.alsoTables ?? [])].map(tableOf) };
}

/** What a retention run would remove, without removing it. */
function retentionPreview(_ctx: JobContext, p: { now: string; months?: number }) {
  if (!spec.retention) return { cutoff: null, tables: [] };
  const { rule, cutoff, tables } = retentionScope(p);
  return { cutoff, tables: tables.map((t) => ({ table: t.name, count: (prepared(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${rule.timeColumn} < ?`).get(cutoff) as { n: number }).n })) };
}

/** Deletes rows older than the cutoff in short transactions, taking them out of the roll-ups too unless the rule keeps roll-up totals. */
async function runRetention(ctx: JobContext, p: { now: string; compact?: boolean; months?: number }) {
  if (!spec.retention) return { removed: 0, cutoff: null, cancelled: false };
  const { rule, cutoff, tables } = retentionScope(p);
  const pending = tables.reduce((sum, t) => sum + (prepared(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${rule.timeColumn} < ?`).get(cutoff) as { n: number }).n, 0);
  let removed = 0;
  for (const table of tables) {
    const rollups = rule.mode === 'discard' ? spec.rollups.filter((r) => r.table === table.name) : [];
    for (;;) {
      if (cancelled.has(ctx.id)) return { removed, cutoff, cancelled: true };
      const ids = JSON.stringify((prepared(`SELECT id FROM ${table.name} WHERE ${rule.timeColumn} < ? ORDER BY ${rule.timeColumn} LIMIT ${RETENTION_CHUNK}`).all(cutoff) as Array<{ id: number }>).map((r) => r.id));
      if (ids === '[]') break;
      removed += db.transaction(() => {
        for (const r of rollups) subtractFromRollup(r, 'id IN (SELECT value FROM json_each(?))', [ids]);
        return prepared(`DELETE FROM ${table.name} WHERE id IN (SELECT value FROM json_each(?))`).run(ids).changes;
      })();
      post({ id: ctx.id, type: 'progress', done: removed, total: pending });
      await yieldToMessages();
    }
  }
  if (p.compact) db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { removed, cutoff, cancelled: false };
}

/** Takes the rows matching `where` out of a roll-up's sums; groups left with no rows are dropped. */
function subtractFromRollup(r: RollupSpec, where: string, params: unknown[]): void {
  const groups = prepared(`SELECT ${[...r.groupBy, ...r.measures.map((m) => `SUM(${m}) AS ${m}`), 'COUNT(*) AS rows'].join(', ')} FROM ${r.table} WHERE ${where} GROUP BY ${r.groupBy.join(', ')}`).all(...params) as Array<Record<string, string | number>>;
  const update = prepared(`UPDATE ${rollupTable(r.name)} SET ${[...r.measures, 'rows'].map((c) => `${c} = ${c} - ?`).join(', ')} WHERE ${r.groupBy.map((g) => `${g} = ?`).join(' AND ')}`);
  for (const g of groups) update.run(...r.measures.map((m) => g[m]!), g.rows!, ...r.groupBy.map((c) => g[c]!));
  prepared(`DELETE FROM ${rollupTable(r.name)} WHERE rows <= 0`).run();
}

/**
 * Replaces the rows matching each step's `where` with the step's new rows, keeping the roll-ups in step, for all steps in
 * one transaction: either every step lands or none does, so a failure never leaves a half-written day.
 */
function replaceRows(p: { steps: ReplaceStep[] }) {
  return db.transaction(() => {
    let removed = 0;
    let inserted = 0;
    for (const step of p.steps) {
      const table = tableOf(step.table);
      const cols = Object.keys(step.where);
      if (!cols.length) throw new QueryError('replace needs at least one match column');
      for (const c of cols) if (!table.columns.some((col) => col.name === c)) throw new QueryError(`${table.name} has no column "${c}"`);
      const clause = cols.map((c) => `${c} = ?`).join(' AND ');
      const values = cols.map((c) => step.where[c]!);
      for (const r of spec.rollups.filter((x) => x.table === table.name)) subtractFromRollup(r, clause, values);
      removed += prepared(`DELETE FROM ${table.name} WHERE ${clause}`).run(...values).changes;
      inserted += insertRows(table, step.rows);
    }
    return { removed, inserted };
  })();
}

/** The most groups one `groupSums` call returns; a caller that hits it is told so and shows a "first N" notice. */
const MAX_GROUPS = 500_000;

/**
 * Sums numeric columns per group over a table or a roll-up (`source` is a table name, or `rollup:<name>`), unlike
 * `aggregate` without the 200-group page cap. Identifiers come from the storage spec; every value is bound. `match` keeps
 * rows whose column equals one of `exact` or starts with one of `prefixes`.
 */
function groupSums(p: GroupSumsRequest): { rows: Array<Record<string, string | number>>; capped: boolean } {
  const rollup = p.source.startsWith('rollup:') ? spec.rollups.find((r) => r.name === p.source.slice(7)) : undefined;
  if (p.source.startsWith('rollup:') && !rollup) throw new QueryError(`unknown roll-up "${p.source}"`);
  const table = rollup ? undefined : tableOf(p.source);
  const columns = new Set(rollup ? [...rollup.groupBy, ...rollup.measures] : table!.columns.map((c) => c.name));
  const sums = new Set(rollup ? rollup.measures : table!.columns.filter((c) => c.type !== 'text').map((c) => c.name));
  const known = (col: string) => { if (!columns.has(col)) throw new QueryError(`${p.source} has no column "${col}"`); return col; };
  const groupBy = (p.groupBy ?? []).map(known);
  const measures = (p.measures ?? []).map((m) => { if (!sums.has(m)) throw new QueryError(`${p.source} cannot sum "${m}"`); return m; });
  const where: string[] = [];
  const params: Array<string | number> = [];
  for (const [col, value] of Object.entries(p.where ?? {})) { where.push(`${known(col)} = ?`); params.push(value); }
  if (p.range) { where.push(`${known(p.range.col)} BETWEEN ? AND ?`); params.push(p.range.from, p.range.to); }
  if (p.match) {
    const col = known(p.match.col);
    const parts = [...(p.match.exact.length ? [`${col} IN (${p.match.exact.map(() => '?').join(', ')})`] : []), ...p.match.prefixes.map(() => `${col} LIKE ? ESCAPE '\\'`)];
    if (!parts.length) throw new QueryError('match needs a value');
    where.push(`(${parts.join(' OR ')})`);
    params.push(...p.match.exact, ...p.match.prefixes.map((v) => `${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  }
  const rowCount = rollup ? 'SUM(rows)' : 'COUNT(*)';
  const select = [...groupBy, ...measures.map((m) => `SUM(${m}) AS ${m}`), `${rowCount} AS rows`];
  const badOrder = (col: string): never => { throw new QueryError(`cannot order ${p.source} by "${col}"`); };
  const orderCol = p.orderBy ? (p.orderBy === 'rows' ? 'rows' : [...groupBy, ...measures].includes(p.orderBy) ? p.orderBy : badOrder(p.orderBy)) : null;
  const limit = Math.min(Math.max(1, Math.floor(p.limit ?? MAX_GROUPS)), MAX_GROUPS);
  const from = rollup ? rollupTable(rollup.name) : table!.name;
  const sql = `SELECT ${select.join(', ')} FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : ''}`
    + `${orderCol ? ` ORDER BY ${orderCol} ${p.dir === 'asc' ? 'ASC' : 'DESC'}` : ''} LIMIT ${limit + 1}`;
  const rows = db.prepare(sql).all(...params) as Array<Record<string, string | number>>;
  return { rows: rows.slice(0, limit), capped: rows.length > limit };
}

type Handler = (ctx: JobContext, p: any) => unknown;

const handlers: Record<string, Handler> = {
  open: (_c, p) => open(p),
  insert: (_c, p: { table: string; rows: Array<Array<string | number>> }) => ({ inserted: insertRows(tableOf(p.table), p.rows) }),
  list: (_c, p) => list(p),
  aggregate: (_c, p) => aggregate(p),
  groupSums: (_c, p) => groupSums(p),
  count: (_c, p: { table: string }) => ({ count: (prepared(`SELECT COUNT(*) AS n FROM ${tableOf(p.table).name}`).get() as { n: number }).n }),
  ingestSynthetic,
  retention: runRetention,
  retentionPreview,
  replaceRows: (_c, p) => replaceRows(p),
  backup: async (_c, p: { dest: string }) => { await mkdir(path.dirname(p.dest), { recursive: true }); await db.backup(p.dest); return { dest: p.dest }; },
  setFault: (_c, p: { fault: { code: string; atRow?: number } | null }) => { if (!faultInjection) throw new Error('fault injection is not enabled'); fault = p.fault; return {}; },
  close: () => { db?.close(); return {}; },
};

parentPort!.on('message', (msg: { id: number; op: string; cancel?: number } & Record<string, unknown>) => {
  if (msg.op === 'cancel') { cancelled.add(msg.cancel as number); return; }
  const handler = handlers[msg.op];
  void (async () => {
    try {
      if (!handler) throw new Error(`unknown operation "${msg.op}"`);
      post({ id: msg.id, type: 'result', value: await handler({ id: msg.id }, msg) });
    } catch (error) {
      const e = error as Error & { code?: string };
      post({ id: msg.id, type: 'error', error: { message: e.message, code: e.code, name: e.name, status: e instanceof QueryError ? 400 : undefined } });
    } finally {
      cancelled.delete(msg.id);
    }
  })();
});
