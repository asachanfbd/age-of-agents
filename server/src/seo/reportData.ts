import { getStore } from '../buildings/buildingStorage.ts';
import type { BulkStore } from '../buildings/bulkClient.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { readLinks } from './backlinks.ts';
import { listSnapshots, readSnapshot } from './crawl/store.ts';
import { pacificToday } from './dates.ts';
import { seoDeps } from './deps.ts';
import { SeoInputError } from './errors.ts';
import { readInspections } from './inspection.ts';
import { buildModel } from './keywords.ts';
import { oneOf, readLedgers, wholeParam } from './pages.ts';
import { avgPositionOf } from './metrics.ts';
import { buildReport, DEFAULT_MIN_IMPRESSIONS } from './reportBuild.ts';
import type { CrawlDigest, DayTotals, IndexChange, MoverIn, ReportData, ReportInputs, WorkItem } from './reportBuild.ts';
import { PERIOD_PRESETS, resolvePeriod } from './reportPeriod.ts';
import type { PeriodRequest, ResolvedPeriod } from './reportPeriod.ts';
import { gscPropertyOf, settingsOf } from './siteAccess.ts';
import { readTasks } from './taskStore.ts';
import { normalizePageUrl } from './urls.ts';
import type { DateWindow } from './period.ts';

export interface ReportQuery { period: PeriodRequest; minImpressions: number }

const flag = (value: unknown, name: string): boolean => {
  if (value === undefined || value === '' || value === '0' || value === 'false' || value === false) return false;
  if (value === '1' || value === 'true' || value === true) return true;
  throw new SeoInputError(`${name} must be true or false`);
};

/** Reads a report request from query parameters or a body. */
export function parseReportQuery(raw: Record<string, unknown>): ReportQuery {
  return {
    period: {
      preset: oneOf(raw.preset, 'preset', PERIOD_PRESETS, 'last-28'),
      from: raw.from, to: raw.to, compareFrom: raw.compareFrom, compareTo: raw.compareTo,
      includePartial: flag(raw.includePartial, 'includePartial'),
    },
    minImpressions: wholeParam(raw.minImpressions, 'minImpressions', 0, Number.MAX_SAFE_INTEGER, DEFAULT_MIN_IMPRESSIONS),
  };
}

const lastFinal = (ledger: Map<string, boolean>): string | null => [...ledger].reduce<string | null>((latest, [d, final]) => (final && (!latest || d > latest) ? d : latest), null);

const emptyDay = (): DayTotals => ({ clicks: 0, impressions: 0, positionImpressions: 0, sessions: 0, keyEvents: 0 });

/** Days that count: fetched and final, or every fetched day when partial days are asked for. Today is never final. */
function usableDays(ledger: Map<string, boolean>, includePartial: boolean, today: string): Set<string> {
  return new Set([...ledger].filter(([d, final]) => includePartial || (final && d < today)).map(([d]) => d));
}

const spanOf = (period: ResolvedPeriod): DateWindow | null => {
  const windows = [period.current, period.previous].filter((w): w is DateWindow => w !== null);
  return windows.length ? { from: windows.reduce((m, w) => (w.from < m ? w.from : m), windows[0]!.from), to: windows.reduce((m, w) => (w.to > m ? w.to : m), windows[0]!.to) } : null;
};

async function dailyTotals(store: BulkStore, source: string, measures: string[], property: string, span: DateWindow): Promise<{ daily: Map<string, DayTotals>; capped: boolean }> {
  const result = await store.groupSums({ source, groupBy: ['day'], measures, where: { property }, range: { col: 'day', ...span } });
  const daily = new Map<string, DayTotals>();
  for (const r of result.rows) {
    const t = emptyDay();
    for (const m of measures) (t as unknown as Record<string, number>)[m] = Number(r[m]);
    daily.set(String(r.day), t);
  }
  return { daily, capped: result.capped };
}

interface Sums { clicks: number; impressions: number; positionImpressions: number }
const zero = (): Sums => ({ clicks: 0, impressions: 0, positionImpressions: 0 });
const addInto = (into: Sums, from: Sums): void => { into.clicks += from.clicks; into.impressions += from.impressions; into.positionImpressions += from.positionImpressions; };

function moverOf(name: string, cur: Sums, prev: Sums): MoverIn {
  return {
    name, clicksCurrent: cur.clicks, clicksPrevious: prev.clicks, impressionsCurrent: cur.impressions, impressionsPrevious: prev.impressions,
    positionCurrent: avgPositionOf(cur), positionPrevious: avgPositionOf(prev),
  };
}

async function pageMovers(store: BulkStore, property: string, period: ResolvedPeriod): Promise<{ rows: MoverIn[]; capped: boolean }> {
  const sums = new Map<string, { cur: Sums; prev: Sums }>();
  let capped = false;
  for (const [which, window] of [['cur', period.current], ['prev', period.previous]] as const) {
    if (!window) continue;
    const result = await store.groupSums({ source: 'rollup:gsc_page_day', groupBy: ['page'], measures: ['clicks', 'impressions', 'positionImpressions'], where: { property }, range: { col: 'day', ...window } });
    capped ||= result.capped;
    for (const r of result.rows) {
      const url = normalizePageUrl(r.page);
      if (!url) continue;
      const entry = sums.get(url) ?? sums.set(url, { cur: zero(), prev: zero() }).get(url)!;
      addInto(entry[which], { clicks: Number(r.clicks), impressions: Number(r.impressions), positionImpressions: Number(r.positionImpressions) });
    }
  }
  return { rows: [...sums].map(([url, s]) => moverOf(url, s.cur, s.prev)), capped };
}

async function keywordInputs(project: ProjectRecord, period: ResolvedPeriod) {
  const none = { keywords: [] as MoverIn[], clusters: [] as MoverIn[], positions: { current: null, previous: null } as ReportInputs['keywordPositions'], capped: false };
  if (!period.current || !period.previous) return none;
  const model = await buildModel(project, () => ({ windows: { current: period.current!, previous: period.previous } }));
  const keywords = model.items.map((i) => moverOf(i.keyword, i.stat.current, i.stat.previous));
  const grouped = new Map<string, { name: string; cur: Sums; prev: Sums }>();
  for (const i of model.items) {
    const cluster = i.clusterId ? model.stored.clusters.get(i.clusterId) : null;
    if (!cluster) continue;
    const entry = grouped.get(cluster.id) ?? grouped.set(cluster.id, { name: cluster.name, cur: zero(), prev: zero() }).get(cluster.id)!;
    addInto(entry.cur, i.stat.current);
    addInto(entry.prev, i.stat.previous);
  }
  return {
    keywords, clusters: [...grouped.values()].map((c) => moverOf(c.name, c.cur, c.prev)), capped: model.capped,
    positions: {
      current: model.available.current ? model.items.map((i) => avgPositionOf(i.stat.current)) : null,
      previous: model.available.previous ? model.items.map((i) => avgPositionOf(i.stat.previous)) : null,
    },
  };
}

async function readIndexing(store: BulkStore): Promise<ReportInputs['indexing']> {
  const [urls, log, inspected] = await Promise.all([
    store.groupSums({ source: 'seo_sitemap_urls', groupBy: ['url', 'firstSeen'] }),
    store.groupSums({ source: 'seo_index_changes', groupBy: ['url', 'fromState', 'toState', 'at'] }),
    readInspections(store),
  ]);
  const changes = log.rows.map((r): IndexChange => ({ url: String(r.url), toState: String(r.toState), at: String(r.at) }));
  // Inspections made before the change log existed leave their state only in `seo_inspections`; that answer is the URL's baseline.
  const logged = new Set(changes.map((c) => c.url));
  for (const row of inspected.values()) if (row.state && row.inspectedAt && !logged.has(row.url)) changes.push({ url: row.url, toState: row.state, at: row.inspectedAt });
  // A URL whose first logged change starts from a known state (the log began mid-history) was in that state at the end of the day before it.
  const earliest = new Map<string, { fromState: string; at: string }>();
  for (const r of log.rows) { const u = String(r.url); const at = String(r.at); if (!earliest.has(u) || at < earliest.get(u)!.at) earliest.set(u, { fromState: String(r.fromState), at }); }
  for (const [url, first] of earliest) if (first.fromState) changes.push({ url, toState: first.fromState, at: new Date(Date.parse(`${first.at.slice(0, 10)}T00:00:00Z`) - 1000).toISOString() });
  const first = new Map<string, string>();
  for (const r of urls.rows) { const u = String(r.url); const f = String(r.firstSeen); if (!first.has(u) || f < first.get(u)!) first.set(u, f); }
  return {
    submitted: [...first].map(([url, firstSeen]) => ({ url, firstSeen })),
    changes,
  };
}

const dayOf = (iso: string): string => iso.slice(0, 10);

async function digestOfSnapshot(buildingId: string, id: string): Promise<CrawlDigest> {
  const snapshot = await readSnapshot(buildingId, id);
  return {
    finishedAt: snapshot.finishedAt, edges: snapshot.links.map((l) => `${l.from} > ${l.to}`),
    outbound: Object.fromEntries(snapshot.pages.filter((p) => p.outbound > 0).map((p) => [p.url, p.outbound])), orphans: snapshot.pages.filter((p) => p.orphan).length,
  };
}

async function readCrawl(buildingId: string, period: ResolvedPeriod): Promise<ReportInputs['crawl']> {
  const complete = (await listSnapshots(buildingId)).filter((m) => m.status === 'complete');
  if (!period.current) return { count: complete.length, before: null, after: null };
  const after = complete.find((m) => dayOf(m.finishedAt) <= period.current!.to);
  const before = complete.find((m) => dayOf(m.finishedAt) < period.current!.from);
  return { count: complete.length, before: before && after && before.id !== after.id ? await digestOfSnapshot(buildingId, before.id) : null, after: after && before && before.id !== after.id ? await digestOfSnapshot(buildingId, after.id) : null };
}

async function readWork(project: ProjectRecord): Promise<ReportInputs['work']> {
  const tasks = await readTasks(project);
  const day = (iso: string) => pacificToday(new Date(iso));
  const completedTasks: WorkItem[] = [];
  const agentRuns: WorkItem[] = [];
  for (const t of tasks) {
    if (t.source === 'manual' && t.status === 'done' && t.completedAt) completedTasks.push({ id: t.id, title: t.title, kind: t.kind, at: day(t.completedAt) });
    else if (t.source === 'agent' && t.runId) agentRuns.push({ id: t.id, title: t.title, kind: t.slot, at: day(t.createdAt) });
  }
  return { completedTasks, agentRuns, anyTasks: tasks.length > 0 };
}

/** Reads everything one report needs from the Building's data. The pure builder does the maths. */
export async function gatherInputs(project: ProjectRecord, query: ReportQuery): Promise<ReportInputs> {
  const settings = await settingsOf(project);
  const store = await getStore(project);
  const now = seoDeps().now();
  const today = pacificToday(now);
  const ledgers = await readLedgers(store, settings, today);
  const gscProperty = gscPropertyOf(settings);
  const ga4 = settings.connections.ga4;
  const ga4Property = ga4.connected && ga4.property ? ga4.property : null;
  const period = resolvePeriod(query.period, { now, lastFinalDay: lastFinal(gscProperty ? ledgers.gsc : ledgers.ga4), retentionMonths: settings.retentionMonths });
  const span = spanOf(period);
  let capped = false;

  const gsc = { daily: new Map<string, DayTotals>(), days: usableDays(ledgers.gsc, period.includePartial, today) };
  const ga4Data = { daily: new Map<string, DayTotals>(), days: usableDays(ledgers.ga4, period.includePartial, today) };
  let pages: MoverIn[] = [];
  if (span && gscProperty) {
    const daily = await dailyTotals(store, 'rollup:gsc_daily', ['clicks', 'impressions', 'positionImpressions'], gscProperty, span);
    gsc.daily = daily.daily;
    capped ||= daily.capped;
    const moved = await pageMovers(store, gscProperty, period);
    pages = moved.rows;
    capped ||= moved.capped;
  }
  if (span && ga4Property) {
    const daily = await dailyTotals(store, 'rollup:ga4_daily', ['sessions', 'keyEvents'], ga4Property, span);
    ga4Data.daily = daily.daily;
    capped ||= daily.capped;
  }
  const keywords = gscProperty ? await keywordInputs(project, period) : { keywords: [], clusters: [], positions: { current: null, previous: null }, capped: false };
  const { links, imported } = await readLinks(project);

  return {
    period, siteHost: new URL(settings.siteUrl).host, generatedAt: now.toISOString(),
    sources: { gsc: gscProperty !== null, ga4: ga4Property !== null },
    gsc, ga4: ga4Data, minImpressions: query.minImpressions, pages, keywords: keywords.keywords, clusters: keywords.clusters, keywordPositions: keywords.positions,
    backlinks: { imported, links: links.map((l) => ({ sourceUrl: l.sourceUrl, sourceHost: l.sourceHost, targetUrl: l.targetUrl, firstSeen: l.firstSeen, lostAt: l.lostAt, sourceDr: l.sourceDr, sourceUr: l.sourceUr })) },
    indexing: await readIndexing(store), crawl: await readCrawl(project.id, period), work: await readWork(project), capped: capped || keywords.capped,
  };
}

/** The live report for a request. */
export async function liveReport(project: ProjectRecord, rawQuery: Record<string, unknown>): Promise<ReportData> {
  return buildReport(await gatherInputs(project, parseReportQuery(rawQuery)));
}
