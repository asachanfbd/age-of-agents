import { randomUUID } from 'node:crypto';
import { getStore, guardedWrite } from '../buildings/buildingStorage.ts';
import { assertWritable } from '../buildings/normalize.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import type { ReplaceStep } from '../buildings/contract.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { pacificToday } from './dates.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, SeoNotFoundError } from './errors.ts';
import { csvLine, parseKeywordImport } from './keywordCsv.ts';
import type { Changes, ClusterRec, EditState, KeywordRec } from './keywordClusters.ts';
import { createCluster, deleteCluster, mergeClusters, moveKeywords, recordFor, renameCluster, splitCluster } from './keywordClusters.ts';
import { addSums, groupStats, shownOf, trendOf, zeroSums } from './keywordMetrics.ts';
import type { GroupStats, KeywordStat, ShownMetrics } from './keywordMetrics.ts';
import {
  cannibalisationRule, CANNIBALISATION_MIN_IMPRESSIONS, CANNIBALISATION_MIN_PAGES, displayOf, impressionsByPage, isCannibalised, MAX_BULK_KEYS,
  nameKeyOf, normalizeKeyword, requireKeyword, requireName, requireStatus,
} from './keywordRules.ts';
import type { KeywordSource, KeywordStatus, Volume } from './keywordRules.ts';
import { columnsOf, rowArray } from './keywordTables.ts';
import type { ClusterRow, KeywordRow, KeywordTableName, SuggestionRow, VolumeRow } from './keywordTables.ts';
import type { Sums } from './metrics.ts';
import { coverageFor, MAX_OFFSET, oneOf, readLedgers, textParam, wholeParam, windowsOf } from './pages.ts';
import type { Ledgers } from './pages.ts';
import type { Coverage, DateWindow, Delta, Windows } from './period.ts';
import { gscPropertyOf, settingsOf } from './siteAccess.ts';
import { isSiteHost, normalizePageUrl, pathOf } from './urls.ts';

export const KEYWORD_PAGE_SIZE = 50;
export const MAX_KEYWORD_PAGE_SIZE = 500;
/** Pages listed for one keyword; it may have more. */
export const MAX_KEYWORD_PAGES = 100;

export const KEYWORD_SORTS = ['keyword', 'clicks', 'impressions', 'ctr', 'position', 'change', 'volume', 'pages'] as const;
export const CLUSTER_SORTS = ['name', 'keywords', 'clicks', 'impressions', 'ctr', 'position', 'change', 'volume', 'pages'] as const;
export const KEYWORD_FILTERS = ['all', 'tracking', 'target', 'ignored', 'pinned', 'cannibalised', 'no-cluster'] as const;
export const CLUSTER_FILTERS = ['all', 'pinned', 'cannibalised', 'unclustered'] as const;
type KeywordSort = (typeof KEYWORD_SORTS)[number];
type ClusterSort = (typeof CLUSTER_SORTS)[number];

// ---- stored state -------------------------------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/** Runs one change to a Building's keywords at a time, so two edits (or an edit and a finishing run) never overwrite each other. */
export function withKeywordLock<T>(buildingId: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(buildingId) ?? Promise.resolve()).then(work, work);
  locks.set(buildingId, next.catch(() => undefined));
  return next;
}

export async function readRows<T>(store: BulkStore, table: KeywordTableName): Promise<T[]> {
  const { rows } = await store.groupSums({ source: table, groupBy: columnsOf(table) });
  return rows as unknown as T[];
}

const keywordFromRow = (r: KeywordRow): KeywordRec => ({
  key: r.key, display: r.display, sources: r.sources ? (r.sources.split(',') as KeywordRec['sources']) : [], status: r.status as KeywordStatus,
  pinned: r.pinned === 1, clusterId: r.clusterId || null, targetPage: r.targetPage, createdAt: r.createdAt,
});
const keywordToRow = (k: KeywordRec): KeywordRow => ({ key: k.key, display: k.display, sources: k.sources.join(','), status: k.status, pinned: k.pinned ? 1 : 0, clusterId: k.clusterId ?? '', targetPage: k.targetPage, createdAt: k.createdAt });
const clusterFromRow = (r: ClusterRow): ClusterRec => ({ id: r.uid, name: r.name, nameKey: r.nameKey, pinned: r.pinned === 1, createdAt: r.createdAt });
const clusterToRow = (c: ClusterRec): ClusterRow => ({ uid: c.id, name: c.name, nameKey: c.nameKey, pinned: c.pinned ? 1 : 0, createdAt: c.createdAt });

export interface Stored { keywords: Map<string, KeywordRec>; clusters: Map<string, ClusterRec>; volumes: Map<string, Volume> }

export async function readStored(store: BulkStore): Promise<Stored> {
  const [keywords, clusters, volumes] = await Promise.all([readRows<KeywordRow>(store, 'seo_keywords'), readRows<ClusterRow>(store, 'seo_clusters'), readRows<VolumeRow>(store, 'seo_keyword_volumes')]);
  return {
    keywords: new Map(keywords.map((r) => [r.key, keywordFromRow(r)])),
    clusters: new Map(clusters.map((r) => [r.uid, clusterFromRow(r)])),
    volumes: new Map(volumes.map((r) => [r.key, { kind: r.kind as Volume['kind'], low: r.low, high: r.high, fetchedAt: r.fetchedAt }])),
  };
}

export interface Universe {
  /** Normalised keyword -> text shown for it. */
  display: Map<string, string>;
  /** Normalised keyword -> the spellings Search Console stored, needed to read its rows back. */
  raws: Map<string, string[]>;
  /** Queries that could not become keywords (empty, or longer than the limit). */
  skipped: number;
  capped: boolean;
}

/** Every query Search Console has ever reported for the property, merged by normalised spelling. */
export async function gscUniverse(store: BulkStore, property: string | null): Promise<Universe> {
  const out: Universe = { display: new Map(), raws: new Map(), skipped: 0, capped: false };
  if (!property) return out;
  const result = await store.groupSums({ source: 'rollup:gsc_query_month', groupBy: ['query'], where: { property } });
  out.capped = result.capped;
  const queries = [...new Set(result.rows.map((r) => String(r.query)))].sort();
  for (const query of queries) {
    const key = normalizeKeyword(query);
    if (!key) { out.skipped++; continue; }
    if (!out.display.has(key)) out.display.set(key, displayOf(query));
    out.raws.set(key, [...(out.raws.get(key) ?? []), query]);
  }
  return out;
}

export const stepsOf = (changes: Changes): ReplaceStep[] => [
  ...[...changes.clusters].map(([id, c]): ReplaceStep => ({ table: 'seo_clusters', where: { uid: id }, rows: c ? [rowArray('seo_clusters', clusterToRow(c))] : [] })),
  ...[...changes.keywords.values()].map((k): ReplaceStep => ({ table: 'seo_keywords', where: { key: k.key }, rows: [rowArray('seo_keywords', keywordToRow(k))] })),
];

export interface Context { project: ProjectRecord; store: BulkStore; property: string | null; siteUrl: string }

export async function contextOf(project: ProjectRecord): Promise<Context & { settings: Awaited<ReturnType<typeof settingsOf>> }> {
  const settings = await settingsOf(project);
  return { project, store: await getStore(project), property: gscPropertyOf(settings), siteUrl: settings.siteUrl, settings };
}

/** Loads the current state, lets `plan` decide the changes, and writes them in one step: all of them land or none do. */
async function edit<T extends { changes: Changes }>(project: ProjectRecord, plan: (state: EditState, ctx: Context) => T | Promise<T>): Promise<T> {
  assertWritable(project);
  return withKeywordLock(project.id, async () => {
    const ctx = await contextOf(project);
    const [stored, universe] = await Promise.all([readStored(ctx.store), gscUniverse(ctx.store, ctx.property)]);
    const state: EditState = { clusters: stored.clusters, keywords: stored.keywords, gscDisplay: (key) => universe.display.get(key) ?? null, newId: randomUUID, now: () => seoDeps().now().toISOString() };
    const result = await plan(state, ctx);
    const steps = stepsOf(result.changes);
    if (steps.length) await guardedWrite(project, (s) => s.replaceRows(steps));
    return result;
  });
}

// ---- query ---------------------------------------------------------------------------------------------------------

interface BaseQuery { windows: Windows; dir: 'asc' | 'desc'; search: string; limit: number; offset: number }
export interface KeywordsQuery extends BaseQuery { sort: KeywordSort; filter: (typeof KEYWORD_FILTERS)[number]; cluster: string }
export interface ClustersQuery extends BaseQuery { sort: ClusterSort; filter: (typeof CLUSTER_FILTERS)[number] }

function baseQuery(raw: Record<string, unknown>, ledgers: Ledgers, now: Date): BaseQuery {
  const search = textParam(raw.search, 'search');
  return {
    windows: windowsOf(raw, ledgers, now),
    dir: oneOf(raw.dir, 'dir', ['asc', 'desc'] as const, 'desc'),
    search: normalizeKeyword(search) ?? '',
    limit: wholeParam(raw.limit, 'limit', 1, MAX_KEYWORD_PAGE_SIZE, KEYWORD_PAGE_SIZE),
    offset: wholeParam(raw.offset, 'offset', 0, MAX_OFFSET, 0),
  };
}

export const parseKeywordsQuery = (raw: Record<string, unknown>, ledgers: Ledgers, now: Date): KeywordsQuery => ({
  ...baseQuery(raw, ledgers, now), sort: oneOf(raw.sort, 'sort', KEYWORD_SORTS, 'clicks'), filter: oneOf(raw.filter, 'filter', KEYWORD_FILTERS, 'all'), cluster: textParam(raw.cluster, 'cluster'),
});

export const parseClustersQuery = (raw: Record<string, unknown>, ledgers: Ledgers, now: Date): ClustersQuery => ({
  ...baseQuery(raw, ledgers, now), sort: oneOf(raw.sort, 'sort', CLUSTER_SORTS, 'clicks'), filter: oneOf(raw.filter, 'filter', CLUSTER_FILTERS, 'all'),
});

// ---- the model: every keyword with its numbers ----------------------------------------------------------------------

export interface Item {
  key: string;
  keyword: string;
  sources: KeywordSource[];
  status: KeywordStatus;
  pinned: boolean;
  clusterId: string | null;
  targetPage: string | null;
  stat: KeywordStat;
  cannibalised: boolean;
}

interface Model {
  windows: Windows;
  coverage: { current: Coverage; previous: Coverage | null };
  available: { current: boolean; previous: boolean };
  ledgers: Ledgers;
  universe: Universe;
  stored: Stored;
  items: Item[];
  capped: boolean;
  ctx: Context & { settings: Awaited<ReturnType<typeof settingsOf>> };
  now: Date;
}

async function gatherRows(ctx: Context, window: DateWindow, byPage: boolean) {
  return ctx.store.groupSums({
    source: 'gsc_rows', groupBy: byPage ? ['query', 'page'] : ['query'], measures: ['clicks', 'impressions', 'positionImpressions'],
    where: { property: ctx.property! }, range: { col: 'day', ...window },
  });
}

const sumsOf = (r: Record<string, string | number>): Sums => ({ clicks: Number(r.clicks), impressions: Number(r.impressions), positionImpressions: Number(r.positionImpressions) });

/** Reads the universe, the stored records and the range's totals once; every report and drill-down is built from this. */
export async function buildModel(project: ProjectRecord, parse: (ledgers: Ledgers, now: Date) => { windows: Windows }): Promise<Model> {
  const ctx = await contextOf(project);
  const now = seoDeps().now();
  const ledgers = await readLedgers(ctx.store, ctx.settings, pacificToday(now));
  const { windows } = parse(ledgers, now);
  const coverage = coverageFor(ledgers, windows).gsc;
  const available = { current: coverage.current.state !== 'none' && !!ctx.property, previous: !!coverage.previous && coverage.previous.state !== 'none' && !!ctx.property };
  const [stored, universe] = await Promise.all([readStored(ctx.store), gscUniverse(ctx.store, ctx.property)]);

  const current = new Map<string, Sums>();
  const previous = new Map<string, Sums>();
  const pageRows = new Map<string, Array<{ page: string; impressions: number }>>();
  let capped = universe.capped;
  const display = new Map(universe.display);
  const accumulate = (into: Map<string, Sums>, key: string, sums: Sums) => addSums(into.get(key) ?? into.set(key, zeroSums()).get(key)!, sums);
  if (available.current) {
    const result = await gatherRows(ctx, windows.current, true);
    capped ||= result.capped;
    for (const r of result.rows) {
      const key = normalizeKeyword(r.query);
      if (!key) continue;
      if (!display.has(key)) display.set(key, displayOf(String(r.query)));
      const sums = sumsOf(r);
      accumulate(current, key, sums);
      if (sums.impressions > 0) (pageRows.get(key) ?? pageRows.set(key, []).get(key)!).push({ page: String(r.page), impressions: sums.impressions });
    }
  }
  if (available.previous && windows.previous) {
    const result = await gatherRows(ctx, windows.previous, false);
    capped ||= result.capped;
    for (const r of result.rows) {
      const key = normalizeKeyword(r.query);
      if (key) accumulate(previous, key, sumsOf(r));
    }
  }

  const keys = new Set([...display.keys(), ...stored.keywords.keys()]);
  const items = [...keys].map((key): Item => {
    const rec = stored.keywords.get(key);
    const perPage = impressionsByPage(pageRows.get(key) ?? []);
    const clusterId = rec?.clusterId && stored.clusters.has(rec.clusterId) ? rec.clusterId : null;
    return {
      key, keyword: rec?.display ?? display.get(key)!,
      sources: [...(display.has(key) ? ['gsc' as const] : []), ...(rec?.sources ?? [])],
      status: rec?.status ?? 'tracking', pinned: rec?.pinned ?? false, clusterId, targetPage: rec?.targetPage || null,
      stat: { key, display: rec?.display ?? display.get(key)!, current: current.get(key) ?? zeroSums(), previous: previous.get(key) ?? zeroSums(), pages: [...perPage.keys()], volume: stored.volumes.get(key) ?? null },
      cannibalised: isCannibalised(perPage.values()),
    };
  });
  return { windows, coverage, available, ledgers, universe, stored, items, capped, ctx, now };
}

// ---- rows ----------------------------------------------------------------------------------------------------------

const shownOrNull = (sums: Sums, ok: boolean): ShownMetrics | null => (ok ? shownOf(sums) : null);

export interface KeywordRowOut {
  key: string; keyword: string; sources: KeywordSource[]; status: KeywordStatus; pinned: boolean; clusterId: string | null; clusterName: string | null;
  targetPage: string | null; current: ShownMetrics | null; previous: ShownMetrics | null; change: Delta | null; pages: number; cannibalised: boolean; volume: Volume | null;
}

function keywordRow(model: Model, item: Item): KeywordRowOut {
  const current = shownOrNull(item.stat.current, model.available.current);
  const previous = shownOrNull(item.stat.previous, model.available.previous);
  return {
    key: item.key, keyword: item.keyword, sources: item.sources, status: item.status, pinned: item.pinned, clusterId: item.clusterId,
    clusterName: item.clusterId ? model.stored.clusters.get(item.clusterId)?.name ?? null : null, targetPage: item.targetPage,
    current, previous, change: current && previous ? groupStats([item.stat], model.available).change : null,
    pages: item.stat.pages.length, cannibalised: item.cannibalised, volume: item.stat.volume,
  };
}

const nullLast = (a: number | null | undefined, b: number | null | undefined, dir: 'asc' | 'desc') => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : dir === 'asc' ? a - b : b - a);
const alpha = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function metricOf(sort: string, m: { current: ShownMetrics | null; change: Delta | null; pages: number; volume: { high: number } | null }): number | null {
  switch (sort) {
    case 'clicks': return m.current?.clicks ?? null;
    case 'impressions': return m.current?.impressions ?? null;
    case 'ctr': return m.current?.ctr ?? null;
    case 'position': return m.current?.position ?? null;
    case 'change': return m.change ? (m.change.isNew ? Number.MAX_SAFE_INTEGER : m.change.pct) : null;
    case 'volume': return m.volume?.high ?? null;
    case 'pages': return m.pages;
    default: return null;
  }
}

function matchesKeywordFilter(row: KeywordRowOut, filter: KeywordsQuery['filter']): boolean {
  switch (filter) {
    case 'all': return true;
    case 'pinned': return row.pinned;
    case 'cannibalised': return row.cannibalised;
    case 'no-cluster': return row.clusterId === null;
    default: return row.status === filter;
  }
}

function orderedKeywords(model: Model, query: KeywordsQuery): KeywordRowOut[] {
  let items = model.items;
  if (query.cluster) {
    if (query.cluster !== 'unclustered' && !model.stored.clusters.has(query.cluster)) throw new SeoNotFoundError('That cluster does not exist');
    items = items.filter((i) => (query.cluster === 'unclustered' ? i.clusterId === null : i.clusterId === query.cluster));
  }
  const rows = items.filter((i) => !query.search || i.key.includes(query.search)).map((i) => keywordRow(model, i)).filter((r) => matchesKeywordFilter(r, query.filter));
  return rows.sort((a, b) => {
    if (query.sort === 'keyword') return (query.dir === 'asc' ? 1 : -1) * alpha(a.key, b.key);
    return nullLast(metricOf(query.sort, a), metricOf(query.sort, b), query.dir) || alpha(a.key, b.key);
  });
}

const gscBlock = (model: Model) => ({ connected: !!model.ctx.property, coverage: model.coverage });

function adsBlock(model: Model) {
  const ads = model.ctx.settings.connections.ads;
  return { connected: ads.connected && !!ads.customerId, error: ads.reason ?? null };
}

/** Keywords of one cluster, of Unclustered, or all of them: filtered, sorted and paged. */
export async function keywordsReport(project: ProjectRecord, raw: Record<string, unknown>) {
  let query!: KeywordsQuery;
  const model = await buildModel(project, (ledgers, now) => (query = parseKeywordsQuery(raw, ledgers, now)));
  const rows = orderedKeywords(model, query);
  return {
    range: model.windows.current, previousRange: model.windows.previous, gsc: gscBlock(model), ads: adsBlock(model), capped: model.capped,
    cannibalisationRule: cannibalisationRule(), total: rows.length, offset: query.offset, limit: query.limit, rows: rows.slice(query.offset, query.offset + query.limit),
  };
}

export interface ClusterRowOut extends GroupStats { id: string | null; name: string; pinned: boolean; cannibalised: number }

function clusterRows(model: Model): ClusterRowOut[] {
  const members = new Map<string | null, Item[]>();
  for (const item of model.items) (members.get(item.clusterId) ?? members.set(item.clusterId, []).get(item.clusterId)!).push(item);
  const row = (id: string | null, name: string, pinned: boolean): ClusterRowOut => {
    const list = members.get(id) ?? [];
    return { id, name, pinned, ...groupStats(list.map((i) => i.stat), model.available), cannibalised: list.filter((i) => i.cannibalised).length };
  };
  const out = [...model.stored.clusters.values()].map((c) => row(c.id, c.name, c.pinned));
  if (members.has(null)) out.push(row(null, 'Unclustered', false));
  return out;
}

function orderedClusters(model: Model, query: ClustersQuery): ClusterRowOut[] {
  const itemsOf = (id: string | null) => model.items.filter((i) => i.clusterId === id);
  const rows = clusterRows(model).filter((r) => {
    if (query.filter === 'pinned' && !r.pinned) return false;
    if (query.filter === 'cannibalised' && !r.cannibalised) return false;
    if (query.filter === 'unclustered' && r.id !== null) return false;
    if (!query.search) return true;
    return nameKeyOf(r.name).includes(query.search) || itemsOf(r.id).some((i) => i.key.includes(query.search));
  });
  const pick = (r: ClusterRowOut) => (query.sort === 'keywords' ? r.keywords : metricOf(query.sort, r));
  return rows.sort((a, b) => {
    if (query.sort === 'name') return (query.dir === 'asc' ? 1 : -1) * alpha(nameKeyOf(a.name), nameKeyOf(b.name));
    // Unclustered always sorts after the real clusters on ties so it does not jump around.
    return nullLast(pick(a), pick(b), query.dir) || alpha(nameKeyOf(a.name), nameKeyOf(b.name)) || alpha(a.id ?? '', b.id ?? '');
  });
}

/** Cluster rows (collapsed view): combined numbers per cluster, with the totals the page header shows. */
export async function clustersReport(project: ProjectRecord, raw: Record<string, unknown>) {
  let query!: ClustersQuery;
  const model = await buildModel(project, (ledgers, now) => (query = parseClustersQuery(raw, ledgers, now)));
  const rows = orderedClusters(model, query);
  const suggestions = (await readRows<SuggestionRow>(model.ctx.store, 'seo_cluster_suggestions')).filter((s) => s.status === 'pending');
  return {
    range: model.windows.current, previousRange: model.windows.previous, gsc: gscBlock(model), ads: adsBlock(model), capped: model.capped,
    skippedQueries: model.universe.skipped, cannibalisationRule: cannibalisationRule(),
    totals: { keywords: model.items.length, clusters: model.stored.clusters.size, unclustered: model.items.filter((i) => i.clusterId === null).length, pendingSuggestions: suggestions.length },
    total: rows.length, offset: query.offset, limit: query.limit, rows: rows.slice(query.offset, query.offset + query.limit),
  };
}

// ---- drill-down ----------------------------------------------------------------------------------------------------

/** Pages that received impressions for one keyword, its position trend, the intended target and whether pages compete for it. */
export async function keywordDetail(project: ProjectRecord, raw: Record<string, unknown>) {
  const key = requireKeyword(raw.key);
  const model = await buildModel(project, (ledgers, now) => ({ windows: windowsOf(raw, ledgers, now) }));
  const item = model.items.find((i) => i.key === key);
  if (!item) throw new SeoNotFoundError('That keyword is not tracked in this Building');
  const row = keywordRow(model, item);
  const raws = model.universe.raws.get(key) ?? [];
  const { ctx, windows } = model;
  const span: DateWindow = { from: windows.previous?.from ?? windows.current.from, to: windows.current.to };
  const pages: Array<{ url: string; path: string; sums: Sums }> = [];
  const perDay = new Map<string, Sums>();
  if (ctx.property && raws.length) {
    const match = { col: 'query', exact: raws, prefixes: [] as string[] };
    const measures = ['clicks', 'impressions', 'positionImpressions'];
    const [byPage, byDay] = await Promise.all([
      ctx.store.groupSums({ source: 'gsc_rows', groupBy: ['page'], measures, where: { property: ctx.property }, match, range: { col: 'day', ...windows.current } }),
      ctx.store.groupSums({ source: 'gsc_rows', groupBy: ['day'], measures, where: { property: ctx.property }, match, range: { col: 'day', ...span } }),
    ]);
    const merged = new Map<string, Sums>();
    for (const r of byPage.rows) {
      const url = normalizePageUrl(r.page);
      if (url) addSums(merged.get(url) ?? merged.set(url, zeroSums()).get(url)!, sumsOf(r));
    }
    for (const [url, sums] of merged) if (sums.impressions > 0 || sums.clicks > 0) pages.push({ url, path: pathOf(url), sums });
    for (const r of byDay.rows) perDay.set(String(r.day), sumsOf(r));
  }
  pages.sort((a, b) => b.sums.clicks - a.sums.clicks || b.sums.impressions - a.sums.impressions || alpha(a.url, b.url));
  const competing = pages.filter((p) => p.sums.impressions >= CANNIBALISATION_MIN_IMPRESSIONS).map((p) => p.url);
  return {
    ...row, range: windows.current, previousRange: windows.previous, gsc: gscBlock(model), ads: adsBlock(model),
    pageList: pages.slice(0, MAX_KEYWORD_PAGES).map((p) => ({ url: p.url, path: p.path, ...shownOf(p.sums), isTarget: p.url === item.targetPage })),
    pagesTotal: pages.length,
    trend: trendOf(span, windows.current.from, new Set(model.ledgers.gsc.keys()), perDay),
    cannibalisation: { flagged: item.cannibalised, rule: cannibalisationRule(), minImpressions: CANNIBALISATION_MIN_IMPRESSIONS, minPages: CANNIBALISATION_MIN_PAGES, competingPages: item.cannibalised ? competing : [] },
  };
}

// ---- export --------------------------------------------------------------------------------------------------------

const EXPORT_HEADER = ['Keyword', 'Cluster', 'Status', 'Pinned', 'Sources', 'Clicks', 'Impressions', 'CTR', 'Position', 'Change in clicks', 'Pages', 'Cannibalised', 'Volume low', 'Volume high', 'Volume precision', 'Target page'];

/** Every keyword that matches the filters (not one page of them) as CSV. Empty means no data, never zero. */
export async function exportKeywords(project: ProjectRecord, raw: Record<string, unknown>): Promise<string> {
  let query!: KeywordsQuery;
  const model = await buildModel(project, (ledgers, now) => (query = parseKeywordsQuery(raw, ledgers, now)));
  const lines = orderedKeywords(model, query).map((r) => csvLine([
    r.keyword, r.clusterName, r.status, r.pinned ? 'yes' : 'no', r.sources.join(' '), r.current?.clicks, r.current?.impressions, r.current?.ctr, r.current?.position,
    r.change ? (r.change.isNew ? 'new' : r.change.pct) : null, r.pages, r.cannibalised ? 'yes' : 'no', r.volume?.low, r.volume?.high, r.volume?.kind, r.targetPage,
  ]));
  return `${[csvLine(EXPORT_HEADER), ...lines].join('\r\n')}\r\n`;
}

// ---- edits ---------------------------------------------------------------------------------------------------------

export interface AddResult { added: number; existing: number; duplicates: number; rejected: Array<{ line: number; reason: string }> }

function addSource(rec: KeywordRec, source: Exclude<KeywordSource, 'gsc'>): KeywordRec {
  return rec.sources.includes(source) ? rec : { ...rec, sources: [...rec.sources, source] };
}

function targetPageOf(ctx: Context, value: unknown): string {
  if (value === null || value === '' || value === undefined) return '';
  const url = normalizePageUrl(value);
  if (!url) throw new SeoInputError('the target page must be a full http or https address');
  if (!isSiteHost(url, ctx.siteUrl, ctx.property)) throw new SeoInputError('the target page must be on this Building\'s site');
  return url;
}

/** Adds typed-in keywords (source manual). A keyword that is already known only gains the source. */
export async function addKeywords(project: ProjectRecord, input: unknown): Promise<AddResult> {
  if (!Array.isArray(input) || !input.length) throw new SeoInputError('keywords must be a list with at least one keyword');
  if (input.length > MAX_BULK_KEYS) throw new SeoInputError(`at most ${MAX_BULK_KEYS} keywords can be added at once`);
  return (await edit(project, (state) => {
    const changes: Changes = { clusters: new Map(), keywords: new Map() };
    const result: AddResult = { added: 0, existing: 0, duplicates: 0, rejected: [] };
    input.forEach((text, index) => {
      const key = normalizeKeyword(text);
      if (!key) return void result.rejected.push({ line: index + 1, reason: 'the keyword is empty or longer than 500 characters' });
      if (changes.keywords.has(key)) { result.duplicates++; return; }
      const known = state.keywords.get(key);
      if (known || state.gscDisplay(key) !== null) {
        result.existing++;
        if (!known || !known.sources.includes('manual')) changes.keywords.set(key, addSource(recordFor(state, key, 'manual'), 'manual'));
        return;
      }
      result.added++;
      changes.keywords.set(key, { key, display: displayOf(text as string), sources: ['manual'], status: 'tracking', pinned: false, clusterId: null, targetPage: '', createdAt: state.now() });
    });
    return { changes, result };
  })).result;
}

/** Adds the rows of an uploaded CSV (source import). Rows that cannot be used are reported with their reason and skipped. */
export async function importKeywords(project: ProjectRecord, csv: unknown): Promise<AddResult> {
  const parsed = parseKeywordImport(csv);
  return (await edit(project, (state, ctx) => {
    const changes: Changes = { clusters: new Map(), keywords: new Map() };
    const result: AddResult = { added: 0, existing: 0, duplicates: parsed.duplicates, rejected: [...parsed.rejected] };
    const byName = new Map([...state.clusters.values()].map((c) => [c.nameKey, c]));
    for (const row of parsed.rows) {
      let target = '';
      try { target = targetPageOf(ctx, row.targetPage); } catch (error) { result.rejected.push({ line: row.line, reason: (error as Error).message }); continue; }
      const known = state.keywords.get(row.keyword);
      const existed = !!known || state.gscDisplay(row.keyword) !== null;
      let rec = existed ? addSource(recordFor(state, row.keyword, 'import'), 'import') : { key: row.keyword, display: row.display, sources: ['import' as const], status: 'tracking' as const, pinned: false, clusterId: null, targetPage: '', createdAt: state.now() };
      if (row.status) rec = { ...rec, status: row.status };
      if (target) rec = { ...rec, targetPage: target };
      if (row.cluster) {
        const name = displayOf(row.cluster);
        let cluster = byName.get(nameKeyOf(name));
        if (!cluster) {
          cluster = { id: state.newId(), name, nameKey: nameKeyOf(name), pinned: true, createdAt: state.now() };
          byName.set(cluster.nameKey, cluster);
          changes.clusters.set(cluster.id, cluster);
        }
        rec = { ...rec, clusterId: cluster.id, pinned: true };
      }
      changes.keywords.set(row.keyword, rec);
      if (existed) result.existing++; else result.added++;
    }
    result.rejected.sort((a, b) => a.line - b.line);
    return { changes, result };
  })).result;
}

/** Changes a keyword's status or target page; a null or empty target clears it. */
export async function updateKeyword(project: ProjectRecord, input: { key?: unknown; status?: unknown; targetPage?: unknown }): Promise<KeywordRec> {
  const key = requireKeyword(input.key);
  if (input.status === undefined && input.targetPage === undefined) throw new SeoInputError('status or targetPage is required');
  return (await edit(project, (state, ctx) => {
    const rec = recordFor(state, key);
    if (input.status !== undefined) rec.status = requireStatus(input.status);
    if (input.targetPage !== undefined) rec.targetPage = targetPageOf(ctx, input.targetPage);
    return { changes: { clusters: new Map(), keywords: new Map([[key, rec]]) }, rec };
  })).rec;
}

export const clusterCreate = (project: ProjectRecord, name: unknown) => edit(project, (state) => createCluster(state, name)).then((r) => r.cluster);
export const clusterRename = (project: ProjectRecord, id: unknown, name: unknown) => edit(project, (state) => ({ changes: renameCluster(state, id, name) })).then(() => undefined);
export const clusterMerge = (project: ProjectRecord, sourceIds: unknown, targetId: unknown) => edit(project, (state) => ({ changes: mergeClusters(state, sourceIds, targetId) })).then(() => undefined);
export const clusterSplit = (project: ProjectRecord, id: unknown, keys: unknown, name: unknown) => edit(project, (state) => splitCluster(state, id, keys, name)).then((r) => r.cluster);
export const clusterDelete = (project: ProjectRecord, id: unknown) => edit(project, (state) => ({ changes: deleteCluster(state, id) })).then(() => undefined);
/** `clusterId` is required: null means Unclustered, and leaving it out is a mistake rather than a move. */
export const keywordsMove = (project: ProjectRecord, keys: unknown, clusterId: unknown) => {
  if (clusterId === undefined) throw new SeoInputError('clusterId is required; use null to move keywords to Unclustered');
  return edit(project, (state) => ({ changes: moveKeywords(state, keys, clusterId) })).then(() => undefined);
};

// ---- suggestions for pinned keywords -------------------------------------------------------------------------------

export async function listSuggestions(project: ProjectRecord) {
  const store = await getStore(project);
  const [rows, clusters] = await Promise.all([readRows<SuggestionRow>(store, 'seo_cluster_suggestions'), readRows<ClusterRow>(store, 'seo_clusters')]);
  const names = new Map(clusters.map((c) => [c.uid, c.name]));
  return rows.filter((s) => s.status === 'pending').sort((a, b) => alpha(a.createdAt, b.createdAt) || alpha(a.key, b.key))
    .map((s) => ({ id: s.uid, key: s.key, keyword: s.display, fromCluster: names.get(s.fromClusterId) ?? null, toName: s.toName, createdAt: s.createdAt }));
}

async function suggestionOf(store: BulkStore, id: unknown): Promise<SuggestionRow> {
  const found = (await readRows<SuggestionRow>(store, 'seo_cluster_suggestions')).find((s) => s.uid === id && s.status === 'pending');
  if (!found) throw new SeoNotFoundError('That suggestion does not exist or was already handled');
  return found;
}

const writeSuggestion = (project: ProjectRecord, s: SuggestionRow, status: string) =>
  guardedWrite(project, (store) => store.replaceRows([{ table: 'seo_cluster_suggestions', where: { uid: s.uid }, rows: [rowArray('seo_cluster_suggestions', { ...s, status })] }]));

export async function dismissSuggestion(project: ProjectRecord, id: unknown): Promise<void> {
  assertWritable(project);
  await withKeywordLock(project.id, async () => writeSuggestion(project, await suggestionOf(await getStore(project), id), 'dismissed'));
}

/** Applies a suggestion the person agreed to. A suggestion whose keyword has moved since is dropped, because it no longer describes the keyword. */
export async function applySuggestion(project: ProjectRecord, id: unknown): Promise<void> {
  assertWritable(project);
  await withKeywordLock(project.id, async () => {
    const store = await getStore(project);
    const suggestion = await suggestionOf(store, id);
    const stored = await readStored(store);
    const keyword = stored.keywords.get(suggestion.key);
    if (!keyword || (keyword.clusterId ?? '') !== suggestion.fromClusterId) {
      await writeSuggestion(project, suggestion, 'dismissed');
      throw new SeoConflictError('That keyword has been moved since the suggestion was made, so the suggestion was dropped');
    }
    const now = seoDeps().now().toISOString();
    const nameKey = nameKeyOf(suggestion.toName);
    let cluster = [...stored.clusters.values()].find((c) => c.nameKey === nameKey);
    const changes: Changes = { clusters: new Map(), keywords: new Map() };
    if (!cluster) { cluster = { id: randomUUID(), name: requireName(suggestion.toName), nameKey, pinned: false, createdAt: now }; changes.clusters.set(cluster.id, cluster); }
    changes.keywords.set(keyword.key, { ...keyword, clusterId: cluster.id });
    await guardedWrite(project, (s) => s.replaceRows([...stepsOf(changes), { table: 'seo_cluster_suggestions', where: { uid: suggestion.uid }, rows: [rowArray('seo_cluster_suggestions', { ...suggestion, status: 'applied' })] }]));
  });
}

