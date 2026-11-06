/**
 * Pure view-models for the SEO Pages tab: how a metric cell reads, how a change is coloured, how the range and sort map to
 * request parameters, and the drill-down's states. Free of React so the rules are testable without a DOM.
 */

export type MetricKey = 'clicks' | 'impressions' | 'ctr' | 'position' | 'sessions' | 'keyEvents';
export const METRIC_COLUMNS: Array<{ key: MetricKey; label: string; source: 'gsc' | 'ga4'; digits: number; percent?: boolean }> = [
  { key: 'clicks', label: 'Clicks', source: 'gsc', digits: 0 },
  { key: 'impressions', label: 'Impressions', source: 'gsc', digits: 0 },
  { key: 'ctr', label: 'CTR', source: 'gsc', digits: 1, percent: true },
  { key: 'position', label: 'Avg. position', source: 'gsc', digits: 1 },
  { key: 'sessions', label: 'Sessions', source: 'ga4', digits: 0 },
  { key: 'keyEvents', label: 'Key events', source: 'ga4', digits: 0 },
];

export interface DeltaDto { abs: number; pct: number | null; isNew: boolean }
export interface CoverageDto { covered: number; total: number; state: 'none' | 'partial' | 'full' }
export interface MetricsDto { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null; sessions: number | null; keyEvents: number | null }
export interface PageRowDto {
  url: string;
  path: string;
  /** Link counts from the newest crawl; absent before the first crawl or when the crawl did not see the page. */
  internal?: { inbound: number; outbound: number; orphan: boolean };
  sources: { gsc: boolean; ga4: boolean; sitemaps: number };
  current: MetricsDto;
  previous: MetricsDto | null;
  delta: Record<MetricKey, DeltaDto | null>;
}
export interface ServiceCoverageDto { connected: boolean; coverage: { current: CoverageDto; previous: CoverageDto | null } }
export interface PagesDto {
  range: { from: string; to: string };
  previousRange: { from: string; to: string } | null;
  gsc: ServiceCoverageDto;
  ga4: ServiceCoverageDto;
  total: number;
  offset: number;
  limit: number;
  capped: boolean;
  /** True once a crawl exists, so a missing `internal` means the page was not crawled rather than that nothing ran. */
  crawled: boolean;
  /** The newest crawl did not finish, so the link counts may be incomplete. */
  crawlPartial: boolean;
  rows: PageRowDto[];
}

export interface PageDetailDto {
  url: string;
  path: string;
  range: { from: string; to: string };
  previousRange: { from: string; to: string } | null;
  gsc: ServiceCoverageDto;
  ga4: ServiceCoverageDto;
  current: MetricsDto;
  previous: MetricsDto | null;
  delta: Record<MetricKey, DeltaDto | null>;
  trend: Array<{ day: string; period: 'current' | 'previous' } & MetricsDto>;
  queries: { rows: Array<{ query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }>; total: number; showingFirst: number | null };
  crawl: CrawlBlockDto;
  sitemaps: Array<{ url: string; lastmod: string | null }>;
  indexing: IndexingDto;
}

export type CrawlBlockDto =
  | { available: false; title: null; description: null }
  | { available: true; found: false; crawledAt: string; partial: boolean; title: null; description: null }
  | {
    available: true; found: true; crawledAt: string; partial: boolean; url: string; path: string; status: number | null; error: string | null; title: string | null; description: string | null;
    canonical: string | null; noindex: boolean; depth: number | null; inbound: number; outbound: number; externalLinks: number; inSitemap: boolean; orphan: boolean;
  };

export interface IndexingDto { state: 'indexed' | 'not-indexed' | 'unknown' | 'never'; reason: string | null; raw: string | null; inspectedAt: string | null; waitingForQuota: boolean; error: string | null }

export type CellState = { kind: 'value'; text: string } | { kind: 'no-data'; text: '—' } | { kind: 'not-connected'; text: 'Not connected' };

/** A metric cell: "Not connected" for a service that is not set up, an em dash for a gap, otherwise the number (a real zero is `0`). */
export function metricCell(column: (typeof METRIC_COLUMNS)[number], value: number | null | undefined, connected: { gsc: boolean; ga4: boolean }): CellState {
  if (!connected[column.source]) return { kind: 'not-connected', text: 'Not connected' };
  if (value === null || value === undefined || Number.isNaN(value)) return { kind: 'no-data', text: '—' };
  const shown = column.percent ? value * 100 : value;
  return { kind: 'value', text: shown.toLocaleString('en-US', { minimumFractionDigits: column.digits, maximumFractionDigits: column.digits }) + (column.percent ? '%' : '') };
}

export interface DeltaView { text: string; tone: 'good' | 'bad' | 'neutral' }

/** The change against the previous period. A lower position is an improvement, so its colours are inverted. */
export function deltaView(key: MetricKey, delta: DeltaDto | null | undefined): DeltaView | null {
  if (!delta) return null;
  if (delta.isNew) return { text: 'new', tone: key === 'position' ? 'neutral' : 'good' };
  const pct = delta.pct === null ? '' : ` (${delta.pct > 0 ? '+' : ''}${(delta.pct * 100).toFixed(0)}%)`;
  const sign = delta.abs > 0 ? '+' : '';
  const shown = key === 'ctr' ? `${sign}${(delta.abs * 100).toFixed(1)} pts` : `${sign}${Number.isInteger(delta.abs) ? delta.abs : delta.abs.toFixed(1)}`;
  const better = key === 'position' ? delta.abs < 0 : delta.abs > 0;
  return { text: `${shown}${key === 'ctr' ? '' : pct}`, tone: delta.abs === 0 ? 'neutral' : better ? 'good' : 'bad' };
}

export function banners(data: Pick<PagesDto, 'gsc' | 'ga4'>): string[] {
  const out: string[] = [];
  if (!data.gsc.connected) out.push('Connect Search Console to see clicks, impressions, CTR and position.');
  if (!data.ga4.connected) out.push('Google Analytics is not connected, so sessions and key events are not shown.');
  for (const [label, s] of [['Search Console', data.gsc], ['Analytics', data.ga4]] as const) {
    if (s.connected && s.coverage.current.state === 'partial') out.push(`${label} has data for ${s.coverage.current.covered} of ${s.coverage.current.total} days in this range; totals cover only those days.`);
    if (s.connected && s.coverage.current.state === 'none') out.push(`${label} has no data for this range yet.`);
  }
  return out;
}

export type PageSort = 'path' | MetricKey;
export type PageFilter = 'all' | 'no-clicks' | 'no-impressions' | 'changed';

/** Clicking the sorted column flips its direction; a new column starts high-to-low (path and position start A-to-Z / best first). */
export function nextSort(current: { sort: PageSort; dir: 'asc' | 'desc' }, key: PageSort): { sort: PageSort; dir: 'asc' | 'desc' } {
  if (current.sort === key) return { sort: key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { sort: key, dir: key === 'path' || key === 'position' ? 'asc' : 'desc' };
}

export interface PagesControls { days: number | 'custom'; from?: string; to?: string; compare: boolean; sort: PageSort; dir: 'asc' | 'desc'; filter: PageFilter; search: string; prefix: string; offset: number }
export const DEFAULT_CONTROLS: PagesControls = { days: 28, compare: true, sort: 'clicks', dir: 'desc', filter: 'all', search: '', prefix: '', offset: 0 };
export const PAGE_SIZE = 50;

/** Request parameters: no dates for the default range (the server ends it at the last final day), none for compare when it is off. */
export function pagesParams(c: PagesControls, rangeEnd: string | null): URLSearchParams {
  const p = new URLSearchParams();
  if (c.days === 'custom' && c.from && c.to) { p.set('from', c.from); p.set('to', c.to); } else if (c.days !== 28 && c.days !== 'custom' && rangeEnd) {
    const to = new Date(`${rangeEnd}T00:00:00Z`);
    const from = new Date(to.getTime() - (c.days - 1) * 86_400_000);
    p.set('from', from.toISOString().slice(0, 10)); p.set('to', rangeEnd);
  }
  p.set('compare', c.compare ? 'previous' : 'none');
  p.set('sort', c.sort); p.set('dir', c.dir); p.set('filter', c.filter);
  if (c.search) p.set('search', c.search);
  if (c.prefix) p.set('prefix', c.prefix);
  p.set('limit', String(PAGE_SIZE)); p.set('offset', String(c.offset));
  return p;
}

export type DrillState = 'gsc-not-connected' | 'no-data' | 'no-impressions' | 'ready';

export function drillState(d: Pick<PageDetailDto, 'gsc' | 'current'>): DrillState {
  if (!d.gsc.connected) return 'gsc-not-connected';
  if (d.current.impressions === null) return 'no-data';
  return d.current.impressions === 0 ? 'no-impressions' : 'ready';
}

export const crawlLabel = (crawl: CrawlBlockDto) => ({ title: crawl.title ?? 'Not crawled yet', description: crawl.description ?? 'Not crawled yet' });

/** The drill-down's Internal links block: the crawl's numbers, or the reason there are none. */
export function internalBlock(crawl: CrawlBlockDto): { kind: 'no-crawl' } | { kind: 'not-seen' } | { kind: 'seen'; facts: Array<[string, string]> } {
  if (!crawl.available) return { kind: 'no-crawl' };
  if (!crawl.found) return { kind: 'not-seen' };
  return {
    kind: 'seen',
    facts: [
      ['Crawled', `${crawl.crawledAt.slice(0, 10)}${crawl.partial ? ' (partial crawl)' : ''}`],
      ['Status', `${crawl.status ?? crawl.error ?? '—'} · ${crawl.depth === null ? 'not reachable from home' : `${crawl.depth} click${crawl.depth === 1 ? '' : 's'} from home`}`],
      ['Inbound', crawl.orphan ? '0 — an orphan: in a sitemap, nothing links to it' : `${crawl.inbound} page${crawl.inbound === 1 ? '' : 's'} link here`],
      ['Outbound', `${crawl.outbound} internal · ${crawl.externalLinks} external`],
      ['Canonical', crawl.canonical ?? '—'],
      ['Indexing', crawl.noindex ? 'noindex' : 'indexable'],
    ],
  };
}

export function indexingLabel(i: IndexingDto): string {
  if (i.waitingForQuota) return 'Waiting for quota';
  if (i.state === 'never') return 'Not inspected yet';
  const base = i.state === 'indexed' ? 'Indexed' : i.state === 'not-indexed' ? `Not indexed${i.reason ? `: ${i.reason}` : ''}` : 'Unknown';
  return `${base} (may be out of date)`;
}

/** The sparkline's points for one metric; gap days stay null so the chart breaks instead of dropping to zero. */
export function trendSeries(d: Pick<PageDetailDto, 'trend'>, key: MetricKey): Array<{ day: string; period: 'current' | 'previous'; value: number | null }> {
  return d.trend.map((p) => ({ day: p.day, period: p.period, value: p[key] }));
}
