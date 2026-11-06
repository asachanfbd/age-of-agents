/**
 * Pure view-models for the Internal links tab: the crawl bar, node size and colour, filters, highlights, the layout budget
 * and the matrix limits. Free of React and WebGL so the rules are testable without a DOM.
 */

export interface CrawlSettingsDto { pageCap: number; requestsPerSecond: number; timeoutSeconds: number; pageSizeMb: number }
export interface SettingRangeDto { min: number; max: number; label: string; whole: boolean }

export interface SnapshotDto {
  id: string;
  startedAt: string;
  finishedAt: string;
  status: 'complete' | 'partial';
  stopReason: 'stopped' | 'failed' | null;
  capped: boolean;
  incomplete: boolean;
  host: string;
  seededFrom: 'sitemaps' | 'home';
  settings: CrawlSettingsDto;
  /** Present when most requested addresses gave no links or redirected to themselves. */
  warning?: { affected: number; total: number } | null;
  stats: { pages: number; fetched: number; failed: number; blockedByRobots: number; skippedUrlSpace: number; links: number; externalLinks: number; uncrawledLinks: number };
}

export interface RunDto {
  runId: string;
  snapshotId: string;
  status: 'running' | 'complete' | 'stopped' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  queued: number;
  failed: number;
  error: string | null;
  resumable: boolean;
}

export interface OverviewDto {
  host: string;
  snapshots: SnapshotDto[];
  run: RunDto | null;
  settings: CrawlSettingsDto;
  defaults: CrawlSettingsDto;
  ranges: Record<keyof CrawlSettingsDto, SettingRangeDto>;
}

export interface GraphNodeDto {
  url: string; path: string; section: string; status: number | null; error: string | null; depth: number | null; inbound: number; outbound: number;
  noindex: boolean; canonicalElsewhere: boolean; inSitemap: boolean; orphan: boolean; title: string | null;
}
/** `[fromIndex, toIndex, flags, linkCount]`; flags add 1 (nofollow), 2 (via a redirect), 4 (target is broken). */
export type GraphEdgeDto = [number, number, number, number];
export const EDGE_NOFOLLOW = 1;
export const EDGE_REDIRECT = 2;
export const EDGE_BROKEN = 4;

export interface GraphDto {
  snapshot: SnapshotDto;
  thresholds: { deepClicks: number; fewInbound: number };
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export interface PageLinkDto { url: string; path: string; anchor: string; location: 'nav' | 'header' | 'footer' | 'body'; nofollow: boolean; via: string | null; broken: boolean }
export interface PageLinksDto {
  snapshot: SnapshotDto;
  page: GraphNodeDto & { description: string | null; canonical: string | null; externalLinks: number; fetchedAt: string };
  linkedFrom: { total: number; links: PageLinkDto[] };
  linksTo: { total: number; links: PageLinkDto[] };
  redirectsFrom: string[];
}

export interface MatrixCellDto { count: number; anchors: string[]; locations: string[] }
export interface MatrixDto {
  snapshot: SnapshotDto;
  rows: Array<{ url: string; path: string }>;
  cols: Array<{ url: string; path: string }>;
  cells: Array<Array<MatrixCellDto | null>>;
  rowTotals: number[];
  colTotals: number[];
}

export interface CompareDto {
  from: SnapshotDto; to: SnapshotDto;
  pagesAdded: { total: number; items: string[] }; pagesRemoved: { total: number; items: string[] };
  statusChanged: { total: number; items: Array<{ url: string; from: number | null; to: number | null }> };
  linksAdded: { total: number; items: Array<{ from: string; to: string; anchor: string }> };
  linksRemoved: { total: number; items: Array<{ from: string; to: string; anchor: string }> };
}

export const MAX_MATRIX_SIDE = 30;

/** The crawl's own rules, stated on screen next to the Crawl site button. */
export function capsLine(host: string, s: CrawlSettingsDto): string {
  return `Host ${host} · up to ${s.pageCap.toLocaleString('en-US')} pages · ${s.requestsPerSecond} request${s.requestsPerSecond === 1 ? '' : 's'} per second · ${s.timeoutSeconds} s timeout · ${s.pageSizeMb} MB page limit · robots.txt respected · no JavaScript rendering · external links counted, not followed`;
}

export const runProgress = (run: Pick<RunDto, 'fetched' | 'queued' | 'failed'>) =>
  `${run.fetched.toLocaleString('en-US')} fetched · ${run.queued.toLocaleString('en-US')} queued · ${run.failed.toLocaleString('en-US')} failed`;

export function snapshotLabel(s: Pick<SnapshotDto, 'startedAt' | 'status' | 'warning'>): string {
  const status = s.status === 'partial' ? 'Partial' : 'Complete';
  return `${s.startedAt.slice(0, 10)} ${s.startedAt.slice(11, 16)} · ${s.warning ? `${status}, with warning` : status}`;
}

export const warningText = (w: { affected: number; total: number }): string =>
  `Most pages have no outgoing links or redirect to themselves (${w.affected.toLocaleString('en-US')} of ${w.total.toLocaleString('en-US')}). This crawl is not reliable even though it finished.`;

export type CrawlBarState = 'never' | 'running' | 'stopped' | 'failed' | 'ready';

/** What the crawl bar shows: a stopped or failed run that can be continued offers Resume. */
export function crawlBarState(overview: Pick<OverviewDto, 'run' | 'snapshots'>): CrawlBarState {
  const run = overview.run;
  if (run?.status === 'running') return 'running';
  if (run?.status === 'stopped' && run.resumable) return 'stopped';
  if (run?.status === 'failed') return 'failed';
  return overview.snapshots.length ? 'ready' : 'never';
}

// ---- graph: size, colour, filters, highlights ----------------------------------------------------------------------------

export type SizeBy = 'inbound' | 'clicks';
export type ColourBy = 'section' | 'status' | 'indexing';
export const MIN_RADIUS = 2;
export const MAX_RADIUS = 14;

/** Radius grows with the square root of inbound links; by clicks, the home page is largest and unreachable pages smallest. */
export function nodeRadius(node: Pick<GraphNodeDto, 'inbound' | 'depth'>, by: SizeBy, maxInbound: number, maxDepth: number): number {
  if (by === 'inbound') return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(node.inbound / Math.max(1, maxInbound));
  if (node.depth === null) return MIN_RADIUS;
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * (1 - node.depth / Math.max(1, maxDepth));
}

const PALETTE = ['#2f81f7', '#2fb89a', '#d29922', '#a371f7', '#f0883e', '#db61a2', '#56d4dd', '#7ee787', '#ff7b72', '#8b949e'];
const STATUS_COLOURS = { ok: '#2fb89a', redirect: '#d29922', error: '#f85149', unknown: '#8b949e' } as const;
const INDEX_COLOURS = { indexable: '#2f81f7', noindex: '#f0883e', canonical: '#a371f7' } as const;

export function statusClass(node: Pick<GraphNodeDto, 'status' | 'error'>): keyof typeof STATUS_COLOURS {
  if (node.status === null) return node.error === 'robots' ? 'unknown' : 'error';
  if (node.status >= 400) return 'error';
  if (node.status >= 300) return 'redirect';
  return 'ok';
}

export const indexingState = (node: Pick<GraphNodeDto, 'noindex' | 'canonicalElsewhere'>): keyof typeof INDEX_COLOURS =>
  node.noindex ? 'noindex' : node.canonicalElsewhere ? 'canonical' : 'indexable';

/** Sections in order of size, so the biggest sections get the first palette colours; the rest share the last grey. */
export function sectionColours(nodes: Array<Pick<GraphNodeDto, 'section'>>): Map<string, string> {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.section, (counts.get(n.section) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([s]) => s);
  return new Map(ordered.map((s, i) => [s, PALETTE[Math.min(i, PALETTE.length - 1)]!]));
}

export function nodeColour(node: GraphNodeDto, by: ColourBy, sections: Map<string, string>): string {
  if (by === 'status') return STATUS_COLOURS[statusClass(node)];
  if (by === 'indexing') return INDEX_COLOURS[indexingState(node)];
  return sections.get(node.section) ?? PALETTE[PALETTE.length - 1]!;
}

export function legendFor(by: ColourBy, sections: Map<string, string>): Array<{ label: string; colour: string }> {
  if (by === 'status') return [{ label: '2xx', colour: STATUS_COLOURS.ok }, { label: '3xx', colour: STATUS_COLOURS.redirect }, { label: '4xx/5xx or failed', colour: STATUS_COLOURS.error }, { label: 'blocked by robots.txt', colour: STATUS_COLOURS.unknown }];
  if (by === 'indexing') return [{ label: 'Indexable', colour: INDEX_COLOURS.indexable }, { label: 'noindex', colour: INDEX_COLOURS.noindex }, { label: 'Canonical elsewhere', colour: INDEX_COLOURS.canonical }];
  return [...sections.entries()].slice(0, 10).map(([label, colour]) => ({ label, colour }));
}

export interface GraphFilters { section: string; status: 'all' | 'ok' | 'redirect' | 'error'; maxDepth: number | null; minInbound: number; search: string }
export const NO_FILTERS: GraphFilters = { section: 'all', status: 'all', maxDepth: null, minInbound: 0, search: '' };

/** Indexes of the pages that pass every filter at once; the search is a case-insensitive substring of the address or title. */
export function visibleNodes(graph: Pick<GraphDto, 'nodes'>, f: GraphFilters): Set<number> {
  const search = f.search.trim().toLowerCase();
  const out = new Set<number>();
  graph.nodes.forEach((n, i) => {
    if (f.section !== 'all' && n.section !== f.section) return;
    if (f.status !== 'all' && statusClass(n) !== f.status) return;
    if (f.maxDepth !== null && (n.depth === null || n.depth > f.maxDepth)) return;
    if (n.inbound < f.minInbound) return;
    if (search && !n.path.toLowerCase().includes(search) && !(n.title ?? '').toLowerCase().includes(search)) return;
    out.add(i);
  });
  return out;
}

/** An edge is drawn only when both of its pages are. */
export const visibleEdges = (graph: Pick<GraphDto, 'edges'>, nodes: Set<number>): GraphEdgeDto[] => graph.edges.filter((e) => nodes.has(e[0]) && nodes.has(e[1]));

export function showingText(graph: GraphDto, nodes: Set<number>, edges: GraphEdgeDto[]): string {
  return `Showing ${nodes.size.toLocaleString('en-US')} of ${graph.nodes.length.toLocaleString('en-US')} pages · ${edges.length.toLocaleString('en-US')} links`;
}

export type HighlightKind = 'orphans' | 'deep' | 'few-inbound' | 'broken' | 'redirects';
export const HIGHLIGHTS: Array<{ key: HighlightKind; label: string }> = [
  { key: 'orphans', label: 'Orphan pages' }, { key: 'deep', label: 'Deep pages' }, { key: 'few-inbound', label: 'Few inbound links' }, { key: 'broken', label: 'Broken links' }, { key: 'redirects', label: 'Redirect links' },
];

/** Pages and edges that match any switched-on highlight. Deep pages are further than the threshold from home; the home page is never "few inbound". */
export function highlighted(graph: GraphDto, on: Set<HighlightKind>): { nodes: Set<number>; edges: Set<number> } {
  const nodes = new Set<number>();
  const edges = new Set<number>();
  const { deepClicks, fewInbound } = graph.thresholds;
  graph.nodes.forEach((n, i) => {
    if (on.has('orphans') && n.orphan) nodes.add(i);
    if (on.has('deep') && n.depth !== null && n.depth > deepClicks) nodes.add(i);
    if (on.has('few-inbound') && n.depth !== 0 && n.status !== null && n.inbound < fewInbound) nodes.add(i);
  });
  graph.edges.forEach((e, i) => {
    if (on.has('broken') && e[2] & EDGE_BROKEN) { edges.add(i); nodes.add(e[1]); }
    if (on.has('redirects') && e[2] & EDGE_REDIRECT) edges.add(i);
  });
  return { nodes, edges };
}

/** The index Enter in the search box selects: the first match in the current order. */
export const firstMatch = (graph: Pick<GraphDto, 'nodes'>, f: GraphFilters): number | null => {
  const [first] = visibleNodes(graph, f);
  return first ?? null;
};

export const sectionsOf = (graph: Pick<GraphDto, 'nodes'>): string[] => [...new Set(graph.nodes.map((n) => n.section))].sort();

// ---- layout budget -------------------------------------------------------------------------------------------------------

export interface LayoutBudget { iterations: number; labels: boolean; thinEdges: boolean }

/** The layout runs in a worker for a time that shrinks as the graph grows; big graphs drop labels and thin their edges. */
export function layoutBudget(nodeCount: number): LayoutBudget {
  return {
    iterations: nodeCount <= 500 ? 600 : nodeCount <= 1500 ? 400 : nodeCount <= 3000 ? 250 : 150,
    labels: nodeCount <= 400,
    thinEdges: nodeCount > 800,
  };
}

// ---- matrix --------------------------------------------------------------------------------------------------------------

export type SideKind = 'rows' | 'cols';

/** Adds pages to a matrix side; the side holds at most 30, and the message says so when more are offered. */
export function addToSide(current: string[], additions: string[]): { urls: string[]; message: string | null } {
  const merged = [...new Set([...current, ...additions])];
  if (merged.length <= MAX_MATRIX_SIDE) return { urls: merged, message: null };
  return { urls: merged.slice(0, MAX_MATRIX_SIDE), message: `A matrix side holds at most ${MAX_MATRIX_SIDE} pages; the first ${MAX_MATRIX_SIDE} were kept.` };
}

export function pagesInSection(graph: Pick<GraphDto, 'nodes'>, section: string): string[] {
  return graph.nodes.filter((n) => n.section === section).map((n) => n.url);
}

export function matrixCellTitle(from: string, to: string, cell: MatrixCellDto | null): string {
  if (!cell) return `${from} → ${to}: no link`;
  return `${from} → ${to}: ${cell.count} link${cell.count === 1 ? '' : 's'} · ${cell.anchors.map((a) => a || '(no anchor)').join(', ')} · in ${cell.locations.join(', ')}`;
}

export function matrixParams(snapshot: string, rows: string[], cols: string[], name?: string) {
  return { snapshot, rows, cols, ...(name ? { name } : {}) };
}

// ---- compare -------------------------------------------------------------------------------------------------------------

export type CompareTile = 'pagesAdded' | 'pagesRemoved' | 'linksAdded' | 'linksRemoved' | 'statusChanged';
export const COMPARE_TILES: Array<{ key: CompareTile; label: string }> = [
  { key: 'pagesAdded', label: 'Pages added' }, { key: 'pagesRemoved', label: 'Pages removed' }, { key: 'linksAdded', label: 'Links added' }, { key: 'linksRemoved', label: 'Links removed' }, { key: 'statusChanged', label: 'Status changes' },
];

export const noChanges = (d: CompareDto) => COMPARE_TILES.every((t) => d[t.key].total === 0);

// ---- crawl log -----------------------------------------------------------------------------------------------------------

export type LogFilter = 'all' | 'redirects' | 'http-errors' | 'errors' | 'self-redirects' | 'zero-links';
export const LOG_CHIPS: Array<{ key: LogFilter; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'redirects', label: 'Redirects' }, { key: 'http-errors', label: '4xx/5xx' },
  { key: 'errors', label: 'Errors' }, { key: 'self-redirects', label: 'Self-redirects' }, { key: 'zero-links', label: 'Zero links found' },
];

export interface CrawlLogRowDto {
  n: number; url: string; from: string; status: number | null; contentType: string | null; redirectTo: string | null; selfRedirect: boolean;
  error: string | null; internalLinks: number; externalLinks: number; zeroLinks: boolean;
}

export interface CrawlLogDto {
  snapshot: SnapshotDto;
  summary: { requested: number; ok: number; redirected: number; failed: number; other: number; internalLinks: number; externalLinks: number };
  counts: Record<LogFilter, number>;
  /** Rows matching the filter and search; `rows` holds at most the first `MAX_LOG_ROWS` of them. */
  matched: number;
  rows: CrawlLogRowDto[];
}

export interface CrawlLogPageDto {
  row: CrawlLogRowDto;
  /** False when this page's link list was not saved (an older snapshot, or beyond the storage cap). */
  stored: boolean;
  linksFound: { total: number; links: Array<{ url: string; anchor: string; location: 'nav' | 'header' | 'footer' | 'body'; nofollow: boolean; crawled: boolean }> };
  /** `complete` is false when the stored link lists hit the cap or are absent, so sources may be missing. */
  linkedFrom: { total: number; pages: string[]; complete: boolean };
}

export const MAX_LOG_ROWS = 1000;

export function logParams(snapshot: string, filter: LogFilter, search: string): URLSearchParams {
  const params = new URLSearchParams({ snapshot });
  if (filter !== 'all') params.set('filter', filter);
  if (search.trim()) params.set('q', search.trim());
  return params;
}

const n = (value: number) => value.toLocaleString('en-US');

export function logSummaryText(s: CrawlLogDto['summary']): string {
  return `${n(s.requested)} requested · ${n(s.ok)} OK · ${n(s.redirected)} redirected · ${n(s.failed)} failed${s.other ? ` · ${n(s.other)} other` : ''} · ${n(s.internalLinks)} internal and ${n(s.externalLinks)} external links found`;
}

/** The "from" column: the sitemap, the page that linked here, or why there is no page. */
export function fromLabel(from: string): string {
  return from === 'start' ? 'start page' : from;
}

export const logShowingText = (log: Pick<CrawlLogDto, 'matched' | 'rows'>): string =>
  log.rows.length < log.matched ? `Showing the first ${n(log.rows.length)} of ${n(log.matched)} matching requests. Export the CSV for all of them.` : `${n(log.matched)} matching request${log.matched === 1 ? '' : 's'}`;

export const logExportText = (rows: number, filename: string): string => `${n(rows)} row${rows === 1 ? '' : 's'} exported to ${filename}`;

// ---- Pages tab -----------------------------------------------------------------------------------------------------------

export interface PageInternalDto { inbound: number; outbound: number; orphan: boolean }

/** Inbound/outbound cells in the Pages table: a dash until a crawl has seen the page. */
export const internalCell = (value: number | undefined): string => (value === undefined ? '—' : value.toLocaleString('en-US'));
