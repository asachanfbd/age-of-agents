/**
 * Pure view-models for the Reports tab: the period controls and the request they make, the scorecard tiles with their
 * direction cues, the chart geometry, the lists, the AI panel states and the saved-report list. Kept free of React so the
 * rules are testable without a DOM.
 */

export type Preset = 'week' | 'month' | 'last-28' | 'custom';
export type TileState = 'ok' | 'not-connected' | 'not-available' | 'no-data' | 'hidden';
export type Direction = 'up' | 'down' | 'flat';
export type Verdict = 'better' | 'worse' | 'flat';
type Unit = 'count' | 'percent' | 'position';

export interface DayWindow { from: string; to: string }

export interface PeriodDto {
  preset: Preset;
  includePartial: boolean;
  requested: { current: DayWindow; previous: DayWindow };
  current: DayWindow | null;
  previous: DayWindow | null;
  oldestRetained: string;
  clipped: { current: 'before' | 'partly' | null; previous: 'before' | 'partly' | null };
  trimmedDays: number;
  lengths: { current: number; previous: number };
  perDay: boolean;
  key: string;
}

export interface TileDto {
  key: string;
  label: string;
  unit: Unit;
  state: TileState;
  current: number | null;
  previous: number | null;
  change: number | null;
  changePct: number | null;
  isNew: boolean;
  perDay: boolean;
  direction: Direction | null;
  verdict: Verdict | null;
  glyph: string | null;
  missing: 'current' | 'previous' | null;
  detail: string | null;
  note: string | null;
}

export interface ChartPointDto { n: number; current: number | null; previous: number | null; currentDay: string | null; previousDay: string | null }
export interface ChartDto { key: string; label: string; unit: Unit; state: 'ok' | 'not-connected' | 'no-data'; points: ChartPointDto[] }

export interface MoverDto { name: string; clicksCurrent: number; clicksPrevious: number; change: number; impressions: number; positionCurrent: number | null; positionPrevious: number | null; positionChange: number | null }
export interface MoverListsDto { gains: MoverDto[]; losses: MoverDto[]; positionGains: MoverDto[]; positionLosses: MoverDto[]; belowThreshold: number }
export interface LinkRowDto { sourceUrl: string; sourceHost: string; targetUrl: string; dr: number | null; ur: number | null; on: string }
export interface WorkItemDto { id: string; title: string; kind: string; at: string }

export interface SummaryDto { paragraph: string; actions: string[]; generatedAt: string; periodKey: string; digest: string; label: 'AI-generated' }

export interface ReportDto {
  schema: 1;
  state: 'ok' | 'setup';
  site: string;
  generatedAt: string;
  digest: string;
  period: PeriodDto;
  notes: string[];
  setup: string[];
  coverage: { gsc: { current: number; previous: number; total: { current: number; previous: number } }; ga4: { current: number; previous: number; total: { current: number; previous: number } } };
  tiles: TileDto[];
  charts: ChartDto[];
  minImpressions: number;
  movers: { pages: MoverListsDto; keywords: MoverListsDto; clusters: MoverListsDto };
  backlinks: { available: boolean; added: LinkRowDto[]; lost: LinkRowDto[]; addedTotal: number; lostTotal: number; coverage: { dr: string | null; ur: string | null } };
  indexing: { available: boolean; newlyIndexed: string[]; newlyExcluded: string[]; newlyIndexedTotal: number; newlyExcludedTotal: number };
  internalLinks: { available: boolean; reason: string | null; added: number; removed: number; addedSample: string[]; removedSample: string[]; orphansBefore: number | null; orphansAfter: number | null; newlyOverLimit: string[] };
  work: { tasks: WorkItemDto[]; agentRuns: WorkItemDto[] };
  summary: SummaryDto | null;
}

export interface SavedMetaDto { id: string; name: string; source: 'manual' | 'scheduled'; savedAt: string; periodKey: string; from: string; to: string; hasSummary: boolean }
export interface SavedReportDto extends SavedMetaDto { report: ReportDto }

export interface ScheduleStateDto {
  available: boolean;
  schedules: Array<{ id: string; cadence: 'weekly' | 'monthly'; enabled: boolean; cron: string | null; nextRunAt: string | null }>;
}

// ---- controls -------------------------------------------------------------------------------------------------------------

export const PRESET_OPTIONS: Array<{ key: Preset; label: string }> = [
  { key: 'week', label: 'This week vs last week' },
  { key: 'month', label: 'This month vs last month' },
  { key: 'last-28', label: 'Last 28 days vs previous 28' },
  { key: 'custom', label: 'Custom range' },
];

export const DEFAULT_MIN_IMPRESSIONS = 50;

export interface Controls { preset: Preset; from: string; to: string; compareFrom: string; compareTo: string; includePartial: boolean; minImpressions: number }

export const DEFAULT_CONTROLS: Controls = { preset: 'last-28', from: '', to: '', compareFrom: '', compareTo: '', includePartial: false, minImpressions: DEFAULT_MIN_IMPRESSIONS };

/** The request a set of controls makes: custom dates only for a custom range, the comparison only when overridden. */
export function reportParams(c: Controls): URLSearchParams {
  const p = new URLSearchParams({ preset: c.preset });
  if (c.preset === 'custom') {
    p.set('from', c.from);
    p.set('to', c.to);
    if (c.compareFrom || c.compareTo) { p.set('compareFrom', c.compareFrom); p.set('compareTo', c.compareTo); }
  }
  if (c.includePartial) p.set('includePartial', 'true');
  if (c.minImpressions !== DEFAULT_MIN_IMPRESSIONS) p.set('minImpressions', String(c.minImpressions));
  return p;
}

/** The body for a save or an AI summary: the same fields as the query, as an object. */
export const reportBody = (c: Controls): Record<string, string> => Object.fromEntries(reportParams(c));

/** Why the controls cannot be sent yet, or null. */
export function controlsError(c: Controls): string | null {
  if (!Number.isSafeInteger(c.minImpressions) || c.minImpressions < 0) return 'The minimum impressions must be a whole number from 0.';
  if (c.preset !== 'custom') return null;
  if (!c.from || !c.to) return 'Choose a start and an end date.';
  if (c.from > c.to) return 'The start date must not be after the end date.';
  if ((c.compareFrom && !c.compareTo) || (!c.compareFrom && c.compareTo)) return 'Give both comparison dates, or neither.';
  if (c.compareFrom && c.compareFrom > c.compareTo) return 'The comparison start must not be after its end.';
  return null;
}

// ---- text -------------------------------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(day: string, withYear = false): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m! - 1]}${withYear ? ` ${y}` : ''}`;
}

export function formatWindow(w: DayWindow | null): string {
  if (!w) return 'no data';
  return w.from === w.to ? formatDay(w.from, true) : `${formatDay(w.from, w.from.slice(0, 4) !== w.to.slice(0, 4))} – ${formatDay(w.to, true)}`;
}

/** "17 Sep – 14 Oct 2026 vs 20 Aug – 16 Sep 2026 · weeks start Monday · 28 days vs 28 days". */
export function rangeLine(period: PeriodDto): string {
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  return `${formatWindow(period.current)} vs ${formatWindow(period.previous)} · weeks start Monday · ${days(period.lengths.current)} vs ${days(period.lengths.previous)}`;
}

const group = (n: number, digits: number) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pctOf = (n: number): string => group(n, Number.isInteger(n) ? 0 : 1);
const DIGITS: Record<Unit, number> = { count: 0, percent: 2, position: 1 };

function valueText(tile: TileDto, value: number | null): string {
  if (value === null) return 'no data';
  const digits = Number.isInteger(value) && tile.unit === 'count' ? 0 : tile.unit === 'count' ? 1 : DIGITS[tile.unit];
  return `${group(value, digits)}${tile.unit === 'percent' ? '%' : ''}`;
}

export type Tone = 'good' | 'bad' | 'neutral';

export interface TileView {
  key: string;
  label: string;
  state: TileState;
  /** The headline: the value, "Not connected", "Not available yet" or "no data". */
  value: string;
  comparison: string;
  /** "▲ +56 (+20%) better"; empty when there is no change to show. */
  change: string;
  glyph: string | null;
  word: Verdict | null;
  tone: Tone;
  detail: string | null;
  note: string | null;
  action: 'connect' | 'import' | null;
  /** Screen-reader text; the glyph and word are in it, so colour is never the only cue. */
  label_aria: string;
}

const CONNECT_ACTION: Record<string, 'connect' | 'import'> = { clicks: 'connect', impressions: 'connect', ctr: 'connect', position: 'connect', sessions: 'connect', keyEvents: 'connect', top3: 'connect', top10: 'connect', top20: 'connect' };

export function tileView(tile: TileDto): TileView {
  const base = { key: tile.key, label: tile.label, state: tile.state, detail: tile.detail, note: tile.note, glyph: null as string | null, word: null as Verdict | null, tone: 'neutral' as Tone, change: '', comparison: '', action: null as 'connect' | 'import' | null };
  if (tile.state === 'not-connected') return { ...base, value: 'Not connected', action: CONNECT_ACTION[tile.key] ?? 'connect', label_aria: `${tile.label}: not connected` };
  if (tile.state === 'not-available') return { ...base, value: 'Not available yet', action: tile.key === 'indexed' ? 'connect' : 'import', label_aria: `${tile.label}: not available yet` };
  if (tile.state === 'no-data') return { ...base, value: 'no data', label_aria: `${tile.label}: no data` };
  const value = valueText(tile, tile.current);
  const comparison = valueText(tile, tile.previous);
  let change = '';
  if (tile.change !== null && tile.glyph) {
    const sign = tile.change > 0 ? '+' : '';
    const pct = tile.isNew ? 'new' : tile.changePct === null ? '' : `${tile.changePct > 0 ? '+' : ''}${pctOf(tile.changePct)}%`;
    const unit = tile.unit === 'percent' ? ' points' : '';
    change = `${tile.glyph} ${sign}${group(tile.change, tile.perDay ? 1 : DIGITS[tile.unit])}${unit}${pct ? ` (${pct})` : ''} ${tile.verdict}${tile.perDay ? ' per day' : ''}`;
  }
  const tone: Tone = tile.verdict === 'better' ? 'good' : tile.verdict === 'worse' ? 'bad' : 'neutral';
  return {
    ...base, value, comparison: tile.missing === 'previous' ? 'comparison: no data' : `comparison ${comparison}`, change, glyph: tile.glyph, word: tile.verdict, tone,
    label_aria: `${tile.label}: ${value}, ${tile.missing ? `${tile.missing} period has no data` : change || 'no change'}`,
  };
}

// ---- charts -----------------------------------------------------------------------------------------------------------------------

export interface ChartModel {
  key: string;
  label: string;
  state: ChartDto['state'];
  currentPath: string;
  /** Drawn dashed, so the comparison stays distinguishable without colour. */
  previousPath: string;
  previousDashed: true;
  min: number;
  max: number;
  ariaLabel: string;
}

export const CHART_WIDTH = 100;
export const CHART_HEIGHT = 36;

function pathOf(values: Array<number | null>, min: number, max: number, invert: boolean): string {
  const span = max - min || 1;
  const step = values.length > 1 ? CHART_WIDTH / (values.length - 1) : 0;
  let drawing = false;
  let out = '';
  values.forEach((value, i) => {
    if (value === null) { drawing = false; return; }
    const ratio = (value - min) / span;
    const y = (invert ? ratio : 1 - ratio) * CHART_HEIGHT;
    out += `${drawing ? 'L' : 'M'}${(i * step).toFixed(1)} ${y.toFixed(1)} `;
    drawing = true;
  });
  return out.trim();
}

/** Geometry for one trend chart: two lines on one scale, gaps break the line, and position runs upward as it improves. */
export function chartModel(chart: ChartDto): ChartModel {
  const all = chart.points.flatMap((p) => [p.current, p.previous]).filter((v): v is number => v !== null);
  const min = all.length ? Math.min(...all) : 0;
  const max = all.length ? Math.max(...all) : 0;
  const invert = chart.key === 'position';
  const days = chart.points.length;
  return {
    key: chart.key, label: chart.label, state: chart.state, min, max, previousDashed: true,
    currentPath: pathOf(chart.points.map((p) => p.current), min, max, invert), previousPath: pathOf(chart.points.map((p) => p.previous), min, max, invert),
    ariaLabel: chart.state === 'ok' ? `${chart.label} over ${days} days, from ${group(min, 2)} to ${group(max, 2)}; dashed line is the comparison period${invert ? '; lower is better' : ''}` : `${chart.label}: ${chart.state === 'not-connected' ? 'not connected' : 'no data'}`,
  };
}

// ---- lists ----------------------------------------------------------------------------------------------------------------------------

export interface MoverRow { name: string; clicks: string; change: string; glyph: string; word: 'gain' | 'loss'; impressions: string; position: string }

const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${group(n, digits)}`;

export function moverRows(list: MoverDto[], word: 'gain' | 'loss', perDay: boolean): MoverRow[] {
  return list.map((m) => ({
    name: m.name, clicks: `${group(m.clicksPrevious, 0)} → ${group(m.clicksCurrent, 0)}`, change: `${signed(m.change, perDay ? 1 : 0)}${perDay ? ' per day' : ''}`,
    glyph: word === 'gain' ? '▲' : '▼', word, impressions: group(m.impressions, 0),
    position: m.positionCurrent !== null && m.positionPrevious !== null ? `${group(m.positionPrevious, 1)} → ${group(m.positionCurrent, 1)}` : 'no data',
  }));
}

export function positionRows(list: MoverDto[], word: 'gain' | 'loss'): MoverRow[] {
  return list.map((m) => ({
    name: m.name, clicks: `${group(m.clicksPrevious, 0)} → ${group(m.clicksCurrent, 0)}`, change: m.positionChange === null ? 'no data' : signed(Math.round(m.positionChange * 10) / 10, 1),
    glyph: word === 'gain' ? '▲' : '▼', word, impressions: group(m.impressions, 0), position: `${group(m.positionPrevious ?? 0, 1)} → ${group(m.positionCurrent ?? 0, 1)}`,
  }));
}

export const linkCell = (n: number | null): string => (n === null ? 'no data' : group(n, 0));

export function moversEmptyText(report: ReportDto, list: MoverListsDto): string | null {
  if (list.gains.length || list.losses.length || list.positionGains.length || list.positionLosses.length) return null;
  return `Nothing reached ${group(report.minImpressions, 0)} impressions in both periods.`;
}

// ---- the AI summary --------------------------------------------------------------------------------------------------------------------------

export type SummaryStatus = 'empty' | 'generating' | 'ready' | 'stale' | 'failed';

export function summaryStatus(summary: SummaryDto | null, report: ReportDto, busy: boolean, failed: string | null): SummaryStatus {
  if (busy) return 'generating';
  if (failed && !summary) return 'failed';
  if (!summary) return 'empty';
  return summary.digest === report.digest ? 'ready' : 'stale';
}

export const summaryButtonLabel = (status: SummaryStatus): string => (status === 'generating' ? 'Writing…' : status === 'empty' || status === 'failed' ? 'Write an AI summary' : 'Regenerate');

export const summaryCaption = (summary: SummaryDto, report: ReportDto): string =>
  `AI-generated · for ${formatWindow(report.period.current)} vs ${formatWindow(report.period.previous)}${summary.digest === report.digest ? '' : ' · written for different numbers'}`;

// ---- saving and the saved list ----------------------------------------------------------------------------------------------------------------

export const MAX_REPORT_NAME = 80;

export function saveNameError(name: string): string | null {
  return [...name.trim()].length > MAX_REPORT_NAME ? `The name can be at most ${MAX_REPORT_NAME} characters.` : null;
}

export function savedBadges(meta: SavedMetaDto): string[] {
  return [meta.source === 'scheduled' ? 'Scheduled' : 'Manual', ...(meta.hasSummary ? ['AI summary'] : [])];
}

export const savedCount = (n: number): string => `Saved reports (${n})`;

export function savedConfirmation(meta: { name: string }, count: number): string {
  return `Saved "${meta.name}". You now have ${count} saved report${count === 1 ? '' : 's'}.`;
}

export const SAVED_BANNER = 'Saved snapshot, independent of live data. The numbers do not change when the underlying data is discarded.';

// ---- exports ---------------------------------------------------------------------------------------------------------------------------------

export const EXPORTS: Array<{ label: string; format: 'csv' | 'md' | 'html'; table?: string }> = [
  { label: 'CSV: scorecard', format: 'csv', table: 'scorecard' },
  { label: 'CSV: pages', format: 'csv', table: 'pages' },
  { label: 'CSV: keywords', format: 'csv', table: 'keywords' },
  { label: 'CSV: clusters', format: 'csv', table: 'clusters' },
  { label: 'CSV: backlinks', format: 'csv', table: 'backlinks' },
  { label: 'Markdown', format: 'md' },
  { label: 'Print view (save as PDF)', format: 'html' },
];

/** The path (below the Building's SEO routes) of an export of a saved report, or of the live one. */
export function exportPath(saved: string | null, item: (typeof EXPORTS)[number], controls: Controls): string {
  const query = new URLSearchParams(saved ? {} : reportParams(controls));
  query.set('format', item.format);
  if (item.table) query.set('table', item.table);
  return `reports/${saved ? `${encodeURIComponent(saved)}/` : 'live/'}export?${query}`;
}

// ---- the schedule -----------------------------------------------------------------------------------------------------------------------------

export interface ScheduleView { available: boolean; note: string | null; rows: Array<{ cadence: 'weekly' | 'monthly'; label: string; enabled: boolean; id: string | null; next: string | null }> }

export const SCHEDULE_CRON = { weekly: '0 8 * * 1', monthly: '0 8 1 * *' } as const;
export const SCHEDULE_ACTION = { weekly: 'report-weekly', monthly: 'report-monthly' } as const;

export function scheduleView(state: ScheduleStateDto | null): ScheduleView {
  if (!state || !state.available) return { available: false, note: 'Reports are saved by hand here: the scheduler is not running. Save a report when you want one.', rows: [] };
  const row = (cadence: 'weekly' | 'monthly') => {
    const found = state.schedules.find((s) => s.cadence === cadence);
    return { cadence, label: cadence === 'weekly' ? 'Save a report every Monday' : 'Save a report on the 1st of each month', enabled: found?.enabled ?? false, id: found?.id ?? null, next: found?.enabled ? found.nextRunAt : null };
  };
  return { available: true, note: null, rows: [row('weekly'), row('monthly')] };
}
