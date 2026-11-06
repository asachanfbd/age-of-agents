/**
 * Benchmark of the SEO Building's data model at the foundation's scale targets.
 *   node scripts/benchSeo.ts [--gsc 10000000] [--ga4 1000000] [--runs 15] [--dir <folder>]
 * Rows go in through the same `insert` path a sync uses (roll-ups maintained in the same transaction), in
 * day-sized batches. Writes one Markdown report to stdout. Not part of `npm test`; results are recorded in docs/seo-building.md.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BulkStore } from '../src/buildings/bulkClient.ts';
import { SEO_STORAGE } from '../src/buildings/types/seo.ts';
import { addDays, monthKey, weekKey } from '../src/seo/dates.ts';
import { mulberry32 } from '../src/buildings/syntheticData.ts';

const arg = (name: string, fallback: number) => Number(process.argv[process.argv.indexOf(`--${name}`) + 1]) || fallback;
const gscRows = arg('gsc', 10_000_000);
const ga4Rows = arg('ga4', 1_000_000);
const runs = arg('runs', 15);
const DAYS = 365;
const PROPERTY = 'https://example.com/';
const dirIdx = process.argv.indexOf('--dir');
const dir = dirIdx > 0 ? process.argv[dirIdx + 1]! : await mkdtemp(path.join(tmpdir(), 'bench-seo-'));
const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
const lastDay = '2026-03-14';
const firstDay = addDays(lastDay, -(DAYS - 1));

const store = new BulkStore({ file: path.join(dir, 'bulk.sqlite'), spec: SEO_STORAGE, version: 1, backupDir: path.join(dir, 'backups') });
await store.open();

const rss: number[] = [process.memoryUsage().rss];
let worstLag = 0;
let last = performance.now();
const lagTimer = setInterval(() => { const n = performance.now(); worstLag = Math.max(worstLag, n - last - 10); last = n; rss.push(process.memoryUsage().rss); }, 10);

async function ingest(table: 'gsc_rows' | 'ga4_rows', total: number) {
  const rand = mulberry32(table === 'gsc_rows' ? 1 : 2);
  const perDay = Math.ceil(total / DAYS);
  const t = performance.now();
  for (let d = 0; d < DAYS; d++) {
    const day = addDays(firstDay, d);
    const keys = [day, weekKey(day), monthKey(day)];
    const count = Math.min(perDay, total - d * perDay);
    for (let from = 0; from < count; from += 5000) {
      const batch: Array<Array<string | number>> = [];
      for (let i = from; i < Math.min(count, from + 5000); i++) {
        const page = `/page-${Math.floor(rand() * 3000)}-${i % 7}`;
        const impressions = 1 + Math.floor(rand() * 200);
        batch.push(table === 'gsc_rows'
          ? [PROPERTY, ...keys, page, `query ${i} of ${day}`, Math.floor(impressions * rand() * 0.3), impressions, impressions * (1 + rand() * 30)]
          : [PROPERTY, ...keys, `${page}-${i}`, impressions, Math.floor(rand() * 5)]);
      }
      await store.insert(table, batch);
    }
    await store.replaceRows([{ table: 'fetch_ledger', where: { dataset: table === 'gsc_rows' ? 'gsc' : 'ga4', property: PROPERTY, day }, rows: [[table === 'gsc_rows' ? 'gsc' : 'ga4', PROPERTY, day, 1, new Date().toISOString(), count]] }]);
  }
  const seconds = (performance.now() - t) / 1000;
  return `${total.toLocaleString('en-US')} ${table} in ${seconds.toFixed(0)} s (${Math.round(total / seconds).toLocaleString('en-US')} rows/s)`;
}

const ingestLines = [await ingest('gsc_rows', gscRows), await ingest('ga4_rows', ga4Rows)];
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

const eqProperty = { col: 'property', op: 'eq' as const, value: PROPERTY };
const rows = [
  await time('GSC rows: first page, sort day', 1000, () => store.list('gsc_rows', { sort: 'day', filters: [eqProperty], limit: 50 })),
  await time('GSC rows: property, newest first', 1000, () => store.list('gsc_rows', { sort: 'day', dir: 'desc', filters: [eqProperty], limit: 50 })),
  await time('GSC rows: one day, one page', 1000, () => store.list('gsc_rows', { filters: [eqProperty, { col: 'day', op: 'eq', value: lastDay }, { col: 'page', op: 'eq', value: '/page-77-0' }], limit: 50 })),
  await time('GA4 rows: one day', 1000, () => store.list('ga4_rows', { filters: [eqProperty, { col: 'day', op: 'eq', value: lastDay }], sort: 'day', limit: 50 })),
  await time('Ledger: 365 fetched days', 1000, () => store.list('fetch_ledger', { sort: 'day', limit: 200, filters: [{ col: 'dataset', op: 'eq', value: 'gsc' }] })),
  await time('Aggregate: 12-month totals', 2000, () => store.aggregate('gsc_monthly', { where: { property: PROPERTY } })),
  await time('Aggregate: clicks per day (200 rows)', 2000, () => store.aggregate('gsc_daily', { groupBy: ['property', 'day'], where: { property: PROPERTY }, limit: 200 })),
  await time('Aggregate: weekly series', 2000, () => store.aggregate('gsc_weekly', { groupBy: ['property', 'week'], where: { property: PROPERTY }, limit: 200 })),
  await time('Aggregate: one page, daily history', 2000, () => store.aggregate('gsc_page_day', { groupBy: ['page', 'day'], where: { property: PROPERTY, page: '/page-77-0' }, limit: 200 })),
  await time('Aggregate: top 10 queries this month', 2000, () => store.aggregate('gsc_query_month', { groupBy: ['query'], where: { property: PROPERTY, month: monthKey(lastDay) }, orderBy: 'clicks', limit: 10 })),
  await time('Aggregate: top 10 pages this month', 2000, () => store.aggregate('gsc_page_month', { groupBy: ['page'], where: { property: PROPERTY, month: monthKey(lastDay) }, orderBy: 'clicks', limit: 10 })),
  await time('Aggregate: GA4 daily series', 2000, () => store.aggregate('ga4_daily', { groupBy: ['property', 'day'], where: { property: PROPERTY }, limit: 200 })),
];

const t0 = performance.now();
const retention = await store.startJob<{ removed: number }>('retention', { now: new Date(`${addDays(lastDay, 31)}T12:00:00Z`).toISOString(), months: 12 }).result;
const retentionSeconds = (performance.now() - t0) / 1000;
clearInterval(lagTimer);

console.log(`## SEO data model benchmark

Node ${process.version}, better-sqlite3, ${process.platform} ${process.arch}. Targets are in milliseconds.

### Ingest and size
${ingestLines.map((l) => `- ${l}`).join('\n')}
- Database file: ${mb(dbBytes)} for ${gscRows.toLocaleString('en-US')} Search Console rows and ${ga4Rows.toLocaleString('en-US')} Analytics rows (all indexes and roll-ups)
- Daemon process RSS: ${mb(rss[0]!)} before, ${mb(rssDuring)} peak during ingest, ${mb(process.memoryUsage().rss)} after the queries
- Worst event-loop lag in the daemon process while ingesting and querying: ${worstLag.toFixed(0)} ms

### Queries (${runs} runs each, milliseconds)
| Query | p50 | p95 | Target | Result |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

### Retention
- Discarded ${retention.removed.toLocaleString('en-US')} rows older than the 12-month cutoff (clock moved 31 days ahead) in ${retentionSeconds.toFixed(1)} s, in chunks of 20,000 rows with roll-ups reduced to match
`);

await store.close();
if (dirIdx < 0) await rm(dir, { recursive: true, force: true });
