/**
 * Pure view-models for the SEO Keywords tab: how a cluster or keyword row reads, volume cells (exact versus range), run
 * and cap messages, the drill-down's trend bars and cannibalisation text, request parameters and the virtual list's window
 * maths. Free of React so the rules are testable without a DOM.
 */
import type { DeltaDto, ServiceCoverageDto } from './seoPages';

export interface RangeDto { from: string; to: string }
export interface ShownDto { clicks: number; impressions: number; ctr: number | null; position: number | null }
export interface VolumeDto { kind: 'exact' | 'range'; low: number; high: number; fetchedAt: string }
export interface VolumeSumDto { low: number; high: number; exact: boolean; missing: number }
export interface AdsBlockDto { connected: boolean; error: string | null }

export interface ClusterRowDto {
  id: string | null;
  name: string;
  pinned: boolean;
  keywords: number;
  current: ShownDto | null;
  previous: ShownDto | null;
  change: DeltaDto | null;
  best: { key: string; keyword: string; clicks: number } | null;
  pages: number;
  volume: VolumeSumDto | null;
  cannibalised: number;
}

export interface KeywordRowDto {
  key: string;
  keyword: string;
  sources: string[];
  status: 'tracking' | 'target' | 'ignored';
  pinned: boolean;
  clusterId: string | null;
  clusterName: string | null;
  targetPage: string | null;
  current: ShownDto | null;
  previous: ShownDto | null;
  change: DeltaDto | null;
  pages: number;
  cannibalised: boolean;
  volume: VolumeDto | null;
}

export interface ClustersDto {
  range: RangeDto;
  previousRange: RangeDto | null;
  gsc: ServiceCoverageDto;
  ads: AdsBlockDto;
  capped: boolean;
  skippedQueries: number;
  cannibalisationRule: string;
  totals: { keywords: number; clusters: number; unclustered: number; pendingSuggestions: number };
  total: number;
  offset: number;
  limit: number;
  rows: ClusterRowDto[];
}

export interface KeywordsDto {
  range: RangeDto;
  previousRange: RangeDto | null;
  gsc: ServiceCoverageDto;
  ads: AdsBlockDto;
  capped: boolean;
  cannibalisationRule: string;
  total: number;
  offset: number;
  limit: number;
  rows: KeywordRowDto[];
}

export interface TrendPointDto { day: string; period: 'current' | 'previous'; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null }

export interface KeywordDetailDto extends KeywordRowDto {
  range: RangeDto;
  previousRange: RangeDto | null;
  gsc: ServiceCoverageDto;
  ads: AdsBlockDto;
  pageList: Array<{ url: string; path: string; isTarget: boolean } & ShownDto>;
  pagesTotal: number;
  trend: TrendPointDto[];
  cannibalisation: { flagged: boolean; rule: string; minImpressions: number; minPages: number; competingPages: string[] };
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped';
export interface RunDto {
  id: string;
  kind: 'cluster' | 'research';
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: { done: number; total: number };
  notices: string[];
  error: string | null;
  adsError: string | null;
  result: Record<string, number>;
}

export interface SuggestionDto { id: string; key: string; keyword: string; fromCluster: string | null; toName: string; createdAt: string }
export interface ProposalDto { id: string; key: string; keyword: string; origin: 'agent' | 'ads'; reason: string; status: 'pending' | 'accepted' | 'rejected'; volume: VolumeDto | null; createdAt: string }
export interface ProposalsDto { volumeAvailable: boolean; adsError: string | null; market: { languageId: string; locationId: string } | null; proposals: ProposalDto[] }
export interface AddResultDto { added: number; existing: number; duplicates: number; rejected: Array<{ line: number; reason: string }> }

// ---- cells -----------------------------------------------------------------------------------------------------------

const NO_DATA = '—';

export const countText = (n: number | null | undefined): string => (n === null || n === undefined || Number.isNaN(n) ? NO_DATA : n.toLocaleString('en-US'));
export const ctrText = (ctr: number | null | undefined): string => (ctr === null || ctr === undefined ? NO_DATA : `${(ctr * 100).toFixed(1)}%`);
export const positionText = (p: number | null | undefined): string => (p === null || p === undefined ? NO_DATA : p.toFixed(1));

export interface ChangeView { text: string; tone: 'good' | 'bad' | 'neutral' }

/** The change in clicks against the previous period; null when there is nothing to compare. */
export function changeView(change: DeltaDto | null | undefined): ChangeView | null {
  if (!change) return null;
  if (change.isNew) return { text: 'new', tone: 'good' };
  if (change.pct === null) return null;
  const pct = Math.round(change.pct * 100);
  return { text: `${pct > 0 ? '+' : ''}${pct}% clicks`, tone: pct > 0 ? 'good' : pct < 0 ? 'bad' : 'neutral' };
}

/** 999, 1K, 1.5K, 2.6M: the short form used inside a range such as "1.4K–2.6K". */
export function compactNumber(n: number): string {
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (Math.abs(n) >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (Math.abs(n) >= 1000) return `${trim(n / 1000)}K`;
  return String(n);
}

export const compactRange = (low: number, high: number): string => `${compactNumber(low)}–${compactNumber(high)}`;

export interface VolumeCell { text: string; title: string; precision: 'exact' | 'range' | 'none' }

/** One keyword's volume: exact or range, the "Connect Google Ads" prompt when Ads is not connected, and a dash when it is connected but gave nothing. */
export function volumeCell(volume: VolumeDto | null | undefined, adsConnected: boolean): VolumeCell {
  if (!volume) return adsConnected ? { text: NO_DATA, title: 'No volume from Google Ads for this keyword', precision: 'none' } : { text: 'Connect Google Ads for volume', title: 'Connect Google Ads in Settings → Connections', precision: 'none' };
  const day = volume.fetchedAt.slice(0, 10);
  return volume.kind === 'exact'
    ? { text: `${volume.low.toLocaleString('en-US')} exact`, title: `Exact monthly searches, fetched ${day}`, precision: 'exact' }
    : { text: `${volume.low.toLocaleString('en-US')}–${volume.high.toLocaleString('en-US')} range`, title: `Google Ads gave a range, fetched ${day}`, precision: 'range' };
}

/** A cluster's volume sum: exact when every volume is, a range as soon as any is, and a note when some keywords have none. */
export function volumeSumCell(sum: VolumeSumDto | null | undefined, adsConnected: boolean): VolumeCell {
  if (!sum) return volumeCell(null, adsConnected);
  const text = sum.exact ? sum.low.toLocaleString('en-US') : compactRange(sum.low, sum.high);
  return { text, title: `${sum.exact ? 'Exact sum' : 'Sum of exact and range volumes'}${sum.missing ? `; ${sum.missing} keyword${sum.missing === 1 ? ' has' : 's have'} no volume` : ''}`, precision: sum.exact ? 'exact' : 'range' };
}

export interface ClusterRowView {
  name: string;
  keywords: string;
  clicks: string;
  impressions: string;
  ctr: string;
  position: string;
  change: ChangeView | null;
  best: string;
  pages: string;
  volume: VolumeCell;
  pinBadge: boolean;
  isUnclustered: boolean;
}

export function clusterRowView(row: ClusterRowDto, adsConnected: boolean): ClusterRowView {
  return {
    name: row.name, keywords: countText(row.keywords), clicks: countText(row.current?.clicks), impressions: countText(row.current?.impressions),
    ctr: ctrText(row.current?.ctr), position: positionText(row.current?.position), change: changeView(row.change),
    best: row.best?.keyword ?? NO_DATA, pages: countText(row.pages), volume: volumeSumCell(row.volume, adsConnected), pinBadge: row.pinned, isUnclustered: row.id === null,
  };
}

export interface KeywordRowView { keyword: string; clicks: string; impressions: string; ctr: string; position: string; change: ChangeView | null; pages: string; volume: VolumeCell; pinBadge: boolean; status: KeywordRowDto['status']; target: string; cannibalised: boolean; noData: boolean }

export function keywordRowView(row: KeywordRowDto, adsConnected: boolean): KeywordRowView {
  return {
    keyword: row.keyword, clicks: countText(row.current?.clicks), impressions: countText(row.current?.impressions), ctr: ctrText(row.current?.ctr), position: positionText(row.current?.position),
    change: changeView(row.change), pages: countText(row.pages), volume: volumeCell(row.volume, adsConnected), pinBadge: row.pinned, status: row.status,
    target: row.targetPage ? new URL(row.targetPage).pathname : NO_DATA, cannibalised: row.cannibalised, noData: row.current === null,
  };
}

// ---- runs ------------------------------------------------------------------------------------------------------------

export interface RunView { label: string; active: boolean; tone: 'running' | 'good' | 'bad' | 'neutral'; progress: string | null; notices: string[]; error: string | null; adsError: string | null }

const RUN_LABELS: Record<RunStatus, string> = { queued: 'Queued', running: 'Running', succeeded: 'Done', failed: 'Failed', stopped: 'Stopped' };

export function runView(run: RunDto | null | undefined): RunView | null {
  if (!run) return null;
  const active = run.status === 'queued' || run.status === 'running';
  return {
    label: RUN_LABELS[run.status], active, tone: active ? 'running' : run.status === 'succeeded' ? 'good' : run.status === 'failed' ? 'bad' : 'neutral',
    progress: run.progress.total > 0 ? `${run.progress.done} of ${run.progress.total} keywords` : null, notices: run.notices, error: run.error, adsError: run.adsError,
  };
}

/** The cap message of a clustering run, or null when it covered everything. */
export const capMessage = (run: RunDto | null | undefined): string | null => run?.notices.find((n) => /^Processed \d+ of \d+/.test(n)) ?? null;

/** What the person is told when a finished run changed nothing, so a stop or failure reads as "your clusters are unchanged". */
export function runOutcome(run: RunDto | null | undefined): string | null {
  if (!run) return null;
  if (run.status === 'failed') return `The run failed${run.error ? `: ${run.error}` : ''}. Your clusters are unchanged.`;
  if (run.status === 'stopped') return 'The run was stopped. Your clusters are unchanged.';
  if (run.status === 'succeeded' && run.kind === 'cluster') {
    const r = run.result;
    return `Placed ${r.placed ?? 0} keywords${r.clustersCreated ? ` in ${r.clustersCreated} new cluster${r.clustersCreated === 1 ? '' : 's'}` : ''}${r.suggestions ? `; ${r.suggestions} suggestion${r.suggestions === 1 ? '' : 's'} for keywords you placed by hand` : ''}.`;
  }
  if (run.status === 'succeeded') return `${run.result.proposed ?? 0} new keyword idea${run.result.proposed === 1 ? '' : 's'} to review. Nothing is tracked until you accept it.`;
  return null;
}

export const suggestionsBanner = (count: number): string | null => (count > 0 ? `${count} suggested change${count === 1 ? '' : 's'} for keywords you placed by hand. Nothing was moved.` : null);

// ---- selection and list state ------------------------------------------------------------------------------------------

export const toggleSelected = (selected: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
};

export function bulkBar(selected: ReadonlySet<string>): { visible: boolean; label: string } {
  return { visible: selected.size > 0, label: `${selected.size} keyword${selected.size === 1 ? '' : 's'} selected` };
}

/** Expanded clusters survive a refetch: only clusters that no longer exist are dropped. */
export function keepExpanded(expanded: ReadonlySet<string>, rows: ReadonlyArray<{ id: string | null }>): Set<string> {
  const present = new Set(rows.map((r) => r.id ?? 'unclustered'));
  return new Set([...expanded].filter((id) => present.has(id)));
}

export const expandKey = (id: string | null): string => id ?? 'unclustered';

// ---- request parameters ------------------------------------------------------------------------------------------------

export type ClusterSort = 'name' | 'keywords' | 'clicks' | 'impressions' | 'ctr' | 'position' | 'change' | 'volume' | 'pages';
export type KeywordSort = 'keyword' | 'clicks' | 'impressions' | 'ctr' | 'position' | 'change' | 'volume' | 'pages';
export type KeywordFilter = 'all' | 'tracking' | 'target' | 'ignored' | 'pinned' | 'cannibalised' | 'no-cluster';
export type ClusterFilter = 'all' | 'pinned' | 'cannibalised' | 'unclustered';

export interface KeywordControls { days: number | 'custom'; from?: string; to?: string; compare: boolean; sort: ClusterSort; dir: 'asc' | 'desc'; filter: KeywordFilter; search: string }
export const DEFAULT_KEYWORD_CONTROLS: KeywordControls = { days: 28, compare: true, sort: 'clicks', dir: 'desc', filter: 'all', search: '' };
export const KEYWORD_PAGE_SIZE = 50;

const rangeParams = (c: KeywordControls, rangeEnd: string | null, p: URLSearchParams) => {
  if (c.days === 'custom' && c.from && c.to) { p.set('from', c.from); p.set('to', c.to); } else if (c.days !== 28 && c.days !== 'custom' && rangeEnd) {
    const to = new Date(`${rangeEnd}T00:00:00Z`);
    p.set('from', new Date(to.getTime() - (c.days - 1) * 86_400_000).toISOString().slice(0, 10)); p.set('to', rangeEnd);
  }
  p.set('compare', c.compare ? 'previous' : 'none');
};

/** Cluster rows: the cluster-level filter is the cannibalised/pinned/unclustered one; keyword-only filters (status) do not apply to clusters. */
export function clustersParams(c: KeywordControls, rangeEnd: string | null, offset: number): URLSearchParams {
  const p = new URLSearchParams();
  rangeParams(c, rangeEnd, p);
  p.set('sort', c.sort); p.set('dir', c.dir);
  const filter: ClusterFilter = c.filter === 'pinned' || c.filter === 'cannibalised' ? c.filter : c.filter === 'no-cluster' ? 'unclustered' : 'all';
  p.set('filter', filter);
  if (c.search) p.set('search', c.search);
  p.set('limit', String(KEYWORD_PAGE_SIZE)); p.set('offset', String(offset));
  return p;
}

export function keywordsParams(c: KeywordControls, rangeEnd: string | null, cluster: string, offset: number): URLSearchParams {
  const p = new URLSearchParams();
  rangeParams(c, rangeEnd, p);
  p.set('sort', c.sort === 'name' || c.sort === 'keywords' ? 'clicks' : c.sort); p.set('dir', c.dir); p.set('filter', c.filter);
  if (c.search) p.set('search', c.search);
  p.set('cluster', cluster);
  p.set('limit', String(KEYWORD_PAGE_SIZE)); p.set('offset', String(offset));
  return p;
}

export function nextClusterSort(current: Pick<KeywordControls, 'sort' | 'dir'>, key: ClusterSort): Pick<KeywordControls, 'sort' | 'dir'> {
  if (current.sort === key) return { sort: key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { sort: key, dir: key === 'name' || key === 'position' ? 'asc' : 'desc' };
}

// ---- virtual list ----------------------------------------------------------------------------------------------------

export interface WindowInput { count: number; rowHeight: number; scrollTop: number; viewport: number; overscan: number }
export interface WindowRange { start: number; end: number; padTop: number; padBottom: number }

/** The rows to draw for a scroll position, plus spacers for the rest, so 50,000 rows cost the same as 50. */
export function windowRange({ count, rowHeight, scrollTop, viewport, overscan }: WindowInput): WindowRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.min(count - 1, Math.max(0, Math.floor(scrollTop / rowHeight)));
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/** Whether to ask the server for the next page: the window is near the end of what is loaded, more exists, and no request is in flight. */
export function shouldLoadMore(input: { loaded: number; total: number; windowEnd: number; pending: boolean; threshold: number }): boolean {
  return !input.pending && input.loaded < input.total && input.windowEnd >= input.loaded - input.threshold;
}

/** Merges a fetched page into the rows already loaded, by position, so a repeated request cannot duplicate rows. */
export function mergePage<T>(loaded: readonly T[], page: readonly T[], offset: number): T[] {
  const next = loaded.slice(0, offset);
  next.push(...page);
  return next;
}

// ---- drill-down ------------------------------------------------------------------------------------------------------

export interface TrendBar { day: string; height: number; tone: 'gap' | 'current' | 'previous' }

/** One bar per day: gaps are full-height grey (never zero), the previous period is lighter. */
export function trendBars(trend: readonly TrendPointDto[], metric: 'clicks' | 'impressions' = 'clicks'): TrendBar[] {
  const max = Math.max(1, ...trend.map((p) => p[metric] ?? 0));
  return trend.map((p) => (p[metric] === null ? { day: p.day, height: 100, tone: 'gap' as const } : { day: p.day, height: Math.max(2, (p[metric]! / max) * 100), tone: p.period }));
}

/** The warning's text, with the numbers the server uses. */
export const cannibalisationText = (c: KeywordDetailDto['cannibalisation']): string =>
  `${c.minPages} or more pages each received at least ${c.minImpressions} impressions for this keyword in the range, so they may compete with each other.`;

export type KeywordDrillState = 'gsc-not-connected' | 'no-data' | 'no-pages' | 'ready';

export function keywordDrillState(d: Pick<KeywordDetailDto, 'gsc' | 'current' | 'pageList'>): KeywordDrillState {
  if (!d.gsc.connected) return 'gsc-not-connected';
  if (d.current === null) return 'no-data';
  return d.pageList.length ? 'ready' : 'no-pages';
}

// ---- research ----------------------------------------------------------------------------------------------------------

export const SOURCE_LABELS: Record<ProposalDto['origin'], string> = { agent: 'Agent', ads: 'Google Ads' };

export interface ProposalView { keyword: string; source: string; reason: string; volume: VolumeCell; pending: boolean }

export function proposalView(p: ProposalDto, adsConnected: boolean): ProposalView {
  return { keyword: p.keyword, source: SOURCE_LABELS[p.origin], reason: p.reason, volume: volumeCell(p.volume, adsConnected), pending: p.status === 'pending' };
}

/** "Accept all remaining" touches only rows still waiting for a decision. */
export const pendingIds = (proposals: readonly ProposalDto[]): string[] => proposals.filter((p) => p.status === 'pending').map((p) => p.id);

/** Competitor domains typed one per line or separated by commas. */
export const parseCompetitors = (text: string): string[] => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

export function importSummary(r: AddResultDto): string {
  const parts = [`${r.added} added`, `${r.existing} already tracked`];
  if (r.duplicates) parts.push(`${r.duplicates} repeated in the file`);
  if (r.rejected.length) parts.push(`${r.rejected.length} rejected`);
  return parts.join(', ');
}

export const exportFileName = (range: RangeDto): string => `keywords-${range.from}-to-${range.to}.csv`;

export function emptyMessage(data: Pick<ClustersDto, 'gsc' | 'totals'>, searching: boolean): string | null {
  if (searching) return 'No clusters or keywords match your search.';
  if (data.totals.keywords > 0) return null;
  return data.gsc.connected ? 'No keywords yet. They appear after the first Search Console sync, or add or import some.' : 'Connect Search Console to see the queries people use to find the site, or add or import keywords.';
}
