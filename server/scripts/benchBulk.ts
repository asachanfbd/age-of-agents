/**
 * Benchmark of the per-Building bulk data layer at the task's scale targets.
 *   node scripts/benchBulk.ts [--metrics 10000000] [--lists 1000000] [--runs 15] [--dir <folder>]
 * Writes one Markdown report to stdout. Not part of `npm test`; the numbers it prints are recorded in docs/architecture.md.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BulkStore } from '../src/buildings/bulkClient.ts';
import { NOTES_STORAGE } from '../src/buildings/types/notes.ts';

const arg = (name: string, fallback: number) => Number(process.argv[process.argv.indexOf(`--${name}`) + 1]) || fallback;
const metricsRows = arg('metrics', 10_000_000);
const listRows = arg('lists', 1_000_000);
const runs = arg('runs', 15);
const dirIdx = process.argv.indexOf('--dir');
const dir = dirIdx > 0 ? process.argv[dirIdx + 1]! : await mkdtemp(path.join(tmpdir(), 'bench-bulk-'));
const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

const store = new BulkStore({ file: path.join(dir, 'bulk.sqlite'), spec: NOTES_STORAGE, version: 1, backupDir: path.join(dir, 'backups') });
await store.open();

const rss: number[] = [process.memoryUsage().rss];
let worstLag = 0;
let last = performance.now();
const lagTimer = setInterval(() => { const n = performance.now(); worstLag = Math.max(worstLag, n - last - 10); last = n; rss.push(process.memoryUsage().rss); }, 10);
const rssBefore = rss[0]!;

async function ingest(table: string, rows: number) {
  const t = performance.now();
  await store.startJob('ingestSynthetic', { table, rows }).result;
  const seconds = (performance.now() - t) / 1000;
  return `${rows.toLocaleString('en-US')} ${table} rows in ${seconds.toFixed(0)} s (${Math.round(rows / seconds).toLocaleString('en-US')} rows/s)`;
}

const ingestLines = [await ingest('metrics', metricsRows), await ingest('notes', listRows)];
const rssDuring = Math.max(...rss);
const dbBytes = (await stat(path.join(dir, 'bulk.sqlite'))).size;

async function time(label: string, target: number, fn: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); samples.push(performance.now() - t); }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)]!;
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!;
  return `| ${label} | ${p50.toFixed(1)} | ${p95.toFixed(1)} | ${target} | ${p95 <= target ? 'met' : '**MISSED**'} |`;
}

const mid = (await store.list('metrics', { sort: 'day', limit: 200 })).nextCursor;
const lastDay = (await store.list('metrics', { sort: 'day', dir: 'desc', limit: 1 })).rows[0]!.day as string;
const yearStart = (await store.list('metrics', { sort: 'day', limit: 1 })).rows[0]!.day as string;
const rows = [
  await time('metrics: first page, sort day', 1000, () => store.list('metrics', { sort: 'day', limit: 50 })),
  await time('metrics: sort clicks desc', 1000, () => store.list('metrics', { sort: 'clicks', dir: 'desc', limit: 50 })),
  await time('metrics: filter page = X', 1000, () => store.list('metrics', { filters: [{ col: 'page', op: 'eq', value: '/page-77' }], limit: 50 })),
  await time('metrics: filter page = X, sort day desc', 1000, () => store.list('metrics', { filters: [{ col: 'page', op: 'eq', value: '/page-77' }], sort: 'day', dir: 'desc', limit: 50 })),
  await time('metrics: filter page = X, sort clicks desc', 1000, () => store.list('metrics', { filters: [{ col: 'page', op: 'eq', value: '/page-77' }], sort: 'clicks', dir: 'desc', limit: 50 })),
  await time('metrics: filter day range, sort clicks desc', 1000, () => store.list('metrics', { filters: [{ col: 'day', op: 'gte', value: lastDay }], sort: 'clicks', dir: 'desc', limit: 50 })),
  await time('metrics: search query text', 1000, () => store.list('metrics', { search: 'query 49999', limit: 50 })),
  await time('metrics: mid-table cursor page', 1000, () => store.list('metrics', { sort: 'day', limit: 50, cursor: mid! })),
  await time('list table: sort title', 1000, () => store.list('notes', { sort: 'title', limit: 50 })),
  await time('list table: search keyword', 1000, () => store.list('notes', { search: 'keyword 123456', limit: 50 })),
  await time('aggregate: 12-month totals', 2000, () => store.aggregate('daily', { range: { col: 'day', from: yearStart, to: lastDay } })),
  await time('aggregate: clicks per day (365 rows)', 2000, () => store.aggregate('daily', { groupBy: ['day'], limit: 200 })),
  await time('aggregate: top 10 pages over 12 months', 2000, () => store.aggregate('day_page', { groupBy: ['page'], orderBy: 'clicks', limit: 10 })),
  await time('aggregate: top 10 pages, last 30 days', 2000, () => store.aggregate('day_page', { groupBy: ['page'], range: { col: 'day', from: lastDay.slice(0, 8) + '01' }, orderBy: 'clicks', limit: 10 })),
];

const t0 = performance.now();
const retention = await store.startJob<{ removed: number }>('retention', { now: new Date(Date.parse(`${lastDay}T00:00:00Z`) + 40 * 86_400_000).toISOString() }).result;
const retentionSeconds = (performance.now() - t0) / 1000;
clearInterval(lagTimer);
const rssAfter = process.memoryUsage().rss;

console.log(`## Bulk data layer benchmark

Node ${process.version}, better-sqlite3, ${process.platform} ${process.arch}. Targets are in milliseconds.

### Ingest and size
${ingestLines.map((l) => `- ${l}`).join('\n')}
- Database file: ${mb(dbBytes)} for ${metricsRows.toLocaleString('en-US')} metric rows and ${listRows.toLocaleString('en-US')} list rows (all indexes and roll-ups)
- Daemon process RSS: ${mb(rssBefore)} before, ${mb(rssDuring)} peak during ingest, ${mb(rssAfter)} after the queries
- Worst event-loop lag in the daemon process while ingesting and querying: ${worstLag.toFixed(0)} ms

### Queries (${runs} runs each, milliseconds)
| Query | p50 | p95 | Target | Result |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

### Retention
- Discarded ${retention.removed.toLocaleString('en-US')} rows older than the 12-month cutoff (clock moved 40 days ahead) in ${retentionSeconds.toFixed(1)} s, in chunks of 20,000 rows with roll-ups reduced to match
`);

await store.close();
if (dirIdx < 0) await rm(dir, { recursive: true, force: true });
