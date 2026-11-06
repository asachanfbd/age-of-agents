import { getStore } from '../buildings/buildingStorage.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { addDays, daysBetween, pacificToday } from './dates.ts';
import { seoDeps } from './deps.ts';
import { SeoInputError, SeoNotFoundError } from './errors.ts';
import { readInspections } from './inspection.ts';
import { readLedger } from './ledger.ts';
import type { Dataset } from './ledger.ts';
import { avgPositionOf, ctrOf } from './metrics.ts';
import { addTotals, changeScore, coverageOf, defaultWindows, deltasOf, MAX_RANGE_DAYS, metricsOf, parseRange, windowsFor, zeroTotals } from './period.ts';
import type { Coverage, DateWindow, Delta, Metrics, MetricKey, Totals, Windows } from './period.ts';
import { gscPropertyOf, settingsOf } from './siteAccess.ts';
import { indexingOf } from './sitemapUrls.ts';
import { crawlBlockFor, internalCountsFor } from './crawl/service.ts';
import { normalizePageUrl, pageUrlFromPath, pathOf, rawVariants } from './urls.ts';

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_TEXT = 500;
export const MAX_OFFSET = 10_000_000;
/** Queries shown for one page; the page may have more. */
export const MAX_PAGE_QUERIES = 100;
const QUERY_SCAN_LIMIT = 5000;

export const PAGE_SORTS = ['path', 'clicks', 'impressions', 'ctr', 'position', 'sessions', 'keyEvents'] as const;
export const PAGE_FILTERS = ['all', 'no-clicks', 'no-impressions', 'changed'] as const;
type PageSort = (typeof PAGE_SORTS)[number];
type PageFilter = (typeof PAGE_FILTERS)[number];

export interface PagesQuery {
  windows: Windows;
  sort: PageSort;
  dir: 'asc' | 'desc';
  filter: PageFilter;
  search: string;
  prefix: string;
  limit: number;
  offset: number;
}

export function textParam(value: unknown, name: string): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new SeoInputError(`${name} must be text of at most ${MAX_TEXT} characters`);
  return value;
}

export function wholeParam(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new SeoInputError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new SeoInputError(`${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}

export interface Ledgers { gsc: Map<string, boolean>; ga4: Map<string, boolean> }

/** The days each dataset has fetched, for as far back as a comparison can reach. */
export async function readLedgers(store: BulkStore, settings: Awaited<ReturnType<typeof settingsOf>>, today: string): Promise<Ledgers> {
  const from = addDays(today, -(2 * MAX_RANGE_DAYS + 30));
  const read = (dataset: Dataset) => {
    const c = settings.connections[dataset];
    return c.connected && c.property ? readLedger(store, dataset, c.property, from) : Promise.resolve(new Map<string, boolean>());
  };
  return { gsc: await read('gsc'), ga4: await read('ga4') };
}

const lastFinalDay = (ledger: Map<string, boolean>): string | null => [...ledger.entries()].reduce<string | null>((latest, [day, final]) => (final && (!latest || day > latest) ? day : latest), null);

/** The requested windows, or the default 28 days ending at the last final Search Console day compared with the 28 before. */
export function windowsOf(query: Record<string, unknown>, ledgers: Ledgers, now: Date): Windows {
  const compare = oneOf(query.compare, 'compare', ['previous', 'none'] as const, 'previous') === 'previous';
  if (query.from === undefined && query.to === undefined) {
    const defaults = defaultWindows(lastFinalDay(ledgers.gsc), now);
    return compare ? defaults : { current: defaults.current, previous: null };
  }
  if (query.from === undefined || query.to === undefined) throw new SeoInputError('from and to must be given together');
  return windowsFor(parseRange(query.from, query.to, now), compare);
}

export function parsePagesQuery(query: Record<string, unknown>, ledgers: Ledgers, now: Date): PagesQuery {
  return {
    windows: windowsOf(query, ledgers, now),
    sort: oneOf(query.sort, 'sort', PAGE_SORTS, 'clicks'),
    dir: oneOf(query.dir, 'dir', ['asc', 'desc'] as const, 'desc'),
    filter: oneOf(query.filter, 'filter', PAGE_FILTERS, 'all'),
    search: textParam(query.search, 'search').toLowerCase(),
    prefix: textParam(query.prefix, 'prefix'),
    limit: wholeParam(query.limit, 'limit', 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
    offset: wholeParam(query.offset, 'offset', 0, MAX_OFFSET, 0),
  };
}

interface PageAccumulator { url: string; current: Totals; previous: Totals; gsc: boolean; ga4: boolean; sitemaps: number }

export interface PageRow {
  url: string;
  path: string;
  sources: { gsc: boolean; ga4: boolean; sitemaps: number };
  current: Metrics;
  previous: Metrics | null;
  delta: Record<MetricKey, Delta | null>;
}

interface Dataflow { windows: Windows; accumulators: Map<string, PageAccumulator>; capped: boolean }

const accumulatorFor = (map: Map<string, PageAccumulator>, url: string): PageAccumulator => {
  let a = map.get(url);
  if (!a) { a = { url, current: zeroTotals(), previous: zeroTotals(), gsc: false, ga4: false, sitemaps: 0 }; map.set(url, a); }
  return a;
};

async function gatherTotals(store: BulkStore, settings: Awaited<ReturnType<typeof settingsOf>>, windows: Windows): Promise<Dataflow> {
  const accumulators = new Map<string, PageAccumulator>();
  let capped = false;
  const gscProperty = gscPropertyOf(settings);
  const ga4 = settings.connections.ga4;
  const spans: Array<['current' | 'previous', DateWindow]> = [['current', windows.current], ...(windows.previous ? [['previous', windows.previous] as ['previous', DateWindow]] : [])];
  for (const [which, window] of spans) {
    if (gscProperty) {
      const result = await store.groupSums({ source: 'rollup:gsc_page_day', groupBy: ['page'], measures: ['clicks', 'impressions', 'positionImpressions'], where: { property: gscProperty }, range: { col: 'day', ...window } });
      capped ||= result.capped;
      for (const r of result.rows) {
        const url = normalizePageUrl(r.page);
        if (!url) continue;
        const a = accumulatorFor(accumulators, url);
        a.gsc = true;
        addTotals(a[which], { clicks: Number(r.clicks), impressions: Number(r.impressions), positionImpressions: Number(r.positionImpressions) });
      }
    }
    if (ga4.connected && ga4.property) {
      const result = await store.groupSums({ source: 'ga4_rows', groupBy: ['page'], measures: ['sessions', 'keyEvents'], where: { property: ga4.property }, range: { col: 'day', ...window } });
      capped ||= result.capped;
      for (const r of result.rows) {
        const url = pageUrlFromPath(String(r.page), settings.siteUrl);
        if (!url) continue;
        const a = accumulatorFor(accumulators, url);
        a.ga4 = true;
        addTotals(a[which], { sessions: Number(r.sessions), keyEvents: Number(r.keyEvents) });
      }
    }
  }
  const listed = await store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['url'] });
  capped ||= listed.capped;
  for (const r of listed.rows) accumulatorFor(accumulators, String(r.url)).sitemaps = Number(r.rows);
  return { windows, accumulators, capped };
}

const nullLast = (a: number | null, b: number | null, dir: 'asc' | 'desc') => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : dir === 'asc' ? a - b : b - a);

export function sortRows(rows: PageRow[], sort: PageSort, dir: 'asc' | 'desc'): PageRow[] {
  const byPath = (a: PageRow, b: PageRow) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  return [...rows].sort((a, b) => {
    if (sort === 'path') return (dir === 'asc' ? 1 : -1) * byPath(a, b);
    return nullLast(a.current[sort], b.current[sort], dir) || byPath(a, b);
  });
}

/** "Changed most": pages whose clicks changed, ranked by relative change (new counts as the largest), then absolute change. */
export function changedMost(rows: PageRow[]): PageRow[] {
  return rows
    .filter((r) => changeScore(r.delta.clicks) >= 0)
    .sort((a, b) => changeScore(b.delta.clicks) - changeScore(a.delta.clicks) || Math.abs(b.delta.clicks!.abs) - Math.abs(a.delta.clicks!.abs) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function filterRows(rows: PageRow[], query: Pick<PagesQuery, 'filter' | 'search' | 'prefix'>): PageRow[] {
  const prefix = query.prefix && !query.prefix.startsWith('/') ? `/${query.prefix}` : query.prefix;
  return rows.filter((r) => {
    if (prefix && !r.path.startsWith(prefix)) return false;
    if (query.search && !r.url.toLowerCase().includes(query.search)) return false;
    if (query.filter === 'no-clicks') return r.current.impressions !== null && r.current.impressions > 0 && r.current.clicks === 0;
    if (query.filter === 'no-impressions') return r.current.impressions === 0;
    return true;
  });
}

function rowsFrom(flow: Dataflow, coverage: { gsc: { current: Coverage; previous: Coverage | null }; ga4: { current: Coverage; previous: Coverage | null } }): PageRow[] {
  return [...flow.accumulators.values()].map((a): PageRow => {
    const current = metricsOf(a.current, coverage.gsc.current, coverage.ga4.current);
    const previous = coverage.gsc.previous && coverage.ga4.previous ? metricsOf(a.previous, coverage.gsc.previous, coverage.ga4.previous) : null;
    return { url: a.url, path: pathOf(a.url), sources: { gsc: a.gsc, ga4: a.ga4, sitemaps: a.sitemaps }, current, previous, delta: deltasOf(current, previous) };
  });
}

export function coverageFor(ledgers: Ledgers, windows: Windows) {
  const of = (ledger: Map<string, boolean>) => ({
    current: coverageOf(windows.current, new Set(ledger.keys())),
    previous: windows.previous ? coverageOf(windows.previous, new Set(ledger.keys())) : null,
  });
  return { gsc: of(ledgers.gsc), ga4: of(ledgers.ga4) };
}

/** The Pages table: every known page with its metrics for the range and the one before it, filtered, sorted and paged. */
export async function pagesReport(project: ProjectRecord, rawQuery: Record<string, unknown>) {
  const settings = await settingsOf(project);
  const store = await getStore(project);
  const now = seoDeps().now();
  const ledgers = await readLedgers(store, settings, pacificToday(now));
  const query = parsePagesQuery(rawQuery, ledgers, now);
  const flow = await gatherTotals(store, settings, query.windows);
  const coverage = coverageFor(ledgers, query.windows);
  const filtered = filterRows(rowsFrom(flow, coverage), query);
  const ordered = query.filter === 'changed' ? changedMost(filtered) : sortRows(filtered, query.sort, query.dir);
  const crawl = await internalCountsFor(project.id);
  const rows = ordered.slice(query.offset, query.offset + query.limit).map((row) => {
    const internal = crawl?.counts.get(row.url);
    return internal ? { ...row, internal } : row;
  });
  return {
    range: query.windows.current, previousRange: query.windows.previous,
    gsc: { connected: gscPropertyOf(settings) !== null, coverage: coverage.gsc },
    ga4: { connected: settings.connections.ga4.connected && !!settings.connections.ga4.property, coverage: coverage.ga4 },
    total: ordered.length, offset: query.offset, limit: query.limit, capped: flow.capped, crawled: crawl !== null, crawlPartial: crawl?.partial ?? false,
    rows,
  };
}

interface DayPoint { day: string; period: 'current' | 'previous'; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null; sessions: number | null; keyEvents: number | null }

/** Drill-down for one page: trend, the queries behind it, sitemap membership and indexing state. */
export async function pageDetail(project: ProjectRecord, rawQuery: Record<string, unknown>) {
  const url = normalizePageUrl(rawQuery.url);
  if (!url) throw new SeoInputError('url must be a full http or https address of 2,048 characters or fewer');
  const settings = await settingsOf(project);
  const store = await getStore(project);
  const now = seoDeps().now();
  const ledgers = await readLedgers(store, settings, pacificToday(now));
  const windows = windowsOf(rawQuery, ledgers, now);
  const gscProperty = gscPropertyOf(settings);
  const ga4 = settings.connections.ga4;
  const variants = rawVariants(url);
  const span: DateWindow = { from: windows.previous?.from ?? windows.current.from, to: windows.current.to };

  const gscDays = new Map<string, Totals>();
  if (gscProperty) {
    const { rows } = await store.groupSums({ source: 'rollup:gsc_page_day', groupBy: ['day'], measures: ['clicks', 'impressions', 'positionImpressions'], where: { property: gscProperty }, match: { col: 'page', exact: variants, prefixes: [] }, range: { col: 'day', ...span } });
    for (const r of rows) gscDays.set(String(r.day), { ...zeroTotals(), clicks: Number(r.clicks), impressions: Number(r.impressions), positionImpressions: Number(r.positionImpressions) });
  }
  const ga4Days = new Map<string, Totals>();
  if (ga4.connected && ga4.property) {
    const path = new URL(url).pathname;
    const bare = path === '/' ? '' : path;
    const { rows } = await store.groupSums({ source: 'ga4_rows', groupBy: ['page', 'day'], measures: ['sessions', 'keyEvents'], where: { property: ga4.property }, match: { col: 'page', exact: [bare || '/', `${bare}/`], prefixes: [`${bare}?`, `${bare}/?`] }, range: { col: 'day', ...span } });
    for (const r of rows) {
      if (pageUrlFromPath(String(r.page), settings.siteUrl) !== url) continue;
      const totals = ga4Days.get(String(r.day)) ?? zeroTotals();
      addTotals(totals, { sessions: Number(r.sessions), keyEvents: Number(r.keyEvents) });
      ga4Days.set(String(r.day), totals);
    }
  }

  const { rows: memberships } = await store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['sitemap', 'lastmod'], where: { url } });
  if (!gscDays.size && !ga4Days.size && !memberships.length && !(await hasHistory(store, gscProperty, variants))) throw new SeoNotFoundError('That page is not known to this Building');

  const trend = trendOf(windows, span, ledgers, gscDays, ga4Days);
  const totalsOf = (period: 'current' | 'previous') => {
    const window = period === 'current' ? windows.current : windows.previous!;
    const t = zeroTotals();
    for (const d of daysBetween(window.from, window.to)) { addTotals(t, gscDays.get(d) ?? {}); addTotals(t, ga4Days.get(d) ?? {}); }
    return t;
  };
  const coverage = coverageFor(ledgers, windows);
  const current = metricsOf(totalsOf('current'), coverage.gsc.current, coverage.ga4.current);
  const previous = windows.previous ? metricsOf(totalsOf('previous'), coverage.gsc.previous!, coverage.ga4.previous!) : null;

  const queries = gscProperty ? await queriesOf(store, gscProperty, variants, windows.current) : { rows: [], total: 0, showingFirst: null };
  const inspection = (await readInspections(store, [url])).get(url);
  return {
    url, path: pathOf(url), range: windows.current, previousRange: windows.previous,
    gsc: { connected: gscProperty !== null, coverage: coverage.gsc }, ga4: { connected: ga4.connected && !!ga4.property, coverage: coverage.ga4 },
    current, previous, delta: deltasOf(current, previous), trend, queries,
    crawl: await crawlBlockFor(project.id, url),
    sitemaps: memberships.map((m) => ({ url: String(m.sitemap), lastmod: String(m.lastmod) || null })),
    indexing: indexingOf(inspection),
  };
}

export async function hasHistory(store: BulkStore, property: string | null, variants: string[]): Promise<boolean> {
  if (!property) return false;
  const { rows } = await store.groupSums({ source: 'rollup:gsc_page_day', groupBy: ['page'], where: { property }, match: { col: 'page', exact: variants, prefixes: [] }, limit: 1 });
  return rows.length > 0;
}

function trendOf(windows: Windows, span: DateWindow, ledgers: Ledgers, gscDays: Map<string, Totals>, ga4Days: Map<string, Totals>): DayPoint[] {
  return daysBetween(span.from, span.to).map((day): DayPoint => {
    const period = day >= windows.current.from ? 'current' : 'previous';
    const point: DayPoint = { day, period, clicks: null, impressions: null, ctr: null, position: null, sessions: null, keyEvents: null };
    if (ledgers.gsc.has(day)) {
      const t = gscDays.get(day) ?? zeroTotals();
      Object.assign(point, { clicks: t.clicks, impressions: t.impressions, ctr: ctrOf(t), position: avgPositionOf(t) });
    }
    if (ledgers.ga4.has(day)) {
      const t = ga4Days.get(day) ?? zeroTotals();
      Object.assign(point, { sessions: t.sessions, keyEvents: t.keyEvents });
    }
    return point;
  });
}

async function queriesOf(store: BulkStore, property: string, variants: string[], window: DateWindow) {
  const { rows } = await store.groupSums({ source: 'gsc_rows', groupBy: ['query'], measures: ['clicks', 'impressions', 'positionImpressions'], where: { property }, match: { col: 'page', exact: variants, prefixes: [] }, range: { col: 'day', ...window }, limit: QUERY_SCAN_LIMIT });
  const all = rows.map((r) => {
    const t = { ...zeroTotals(), clicks: Number(r.clicks), impressions: Number(r.impressions), positionImpressions: Number(r.positionImpressions) };
    return { query: String(r.query), clicks: t.clicks, impressions: t.impressions, ctr: ctrOf(t), position: avgPositionOf(t) };
  }).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0));
  return { rows: all.slice(0, MAX_PAGE_QUERIES), total: all.length, showingFirst: all.length > MAX_PAGE_QUERIES ? MAX_PAGE_QUERIES : null };
}
