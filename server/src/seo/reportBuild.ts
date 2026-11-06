import { createHash } from 'node:crypto';
import { daysBetween } from './dates.ts';
import type { DateWindow } from './period.ts';
import type { ResolvedPeriod } from './reportPeriod.ts';

/*
 * Rounding rules (shown to the person in the report notes):
 * - CTR is shown as a percentage to 2 decimals, average position to 1 decimal, counts as whole numbers (1 decimal when
 *   compared per day), percentage changes to 1 decimal.
 * - Rounding is half away from zero on the unrounded value, and every change is computed from unrounded values.
 * - A change that rounds to zero is "flat".
 * - Winners and losers tie-break on impressions (largest first), then alphabetically.
 */

export const DEFAULT_MIN_IMPRESSIONS = 50;
export const MAX_MOVERS = 10;
export const MAX_LISTED_LINKS = 25;
export const MAX_LISTED_CHANGES = 25;
export const MAX_OUTBOUND_LINKS = 100;

/** Half away from zero. The value is trimmed to 12 significant digits first so 2.045 * 100 does not land on 204.49999999999997. */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = Number((Math.abs(value) * factor).toPrecision(12));
  const rounded = Math.round(scaled) / factor;
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

export type MetricKey =
  | 'clicks' | 'impressions' | 'ctr' | 'position' | 'sessions' | 'keyEvents' | 'indexed' | 'top3' | 'top10' | 'top20'
  | 'newBacklinks' | 'lostBacklinks' | 'referringDomains' | 'avgDr' | 'avgUr' | 'tasksCompleted';

type Unit = 'count' | 'percent' | 'position';
type Source = 'gsc' | 'ga4' | 'sitemaps' | 'backlinks' | 'tasks';
interface MetricDef { key: MetricKey; label: string; unit: Unit; better: 'higher' | 'lower'; source: Source; kind: 'total' | 'rate' | 'snapshot'; digits: number }

export const METRICS: MetricDef[] = [
  { key: 'clicks', label: 'Clicks', unit: 'count', better: 'higher', source: 'gsc', kind: 'total', digits: 0 },
  { key: 'impressions', label: 'Impressions', unit: 'count', better: 'higher', source: 'gsc', kind: 'total', digits: 0 },
  { key: 'ctr', label: 'CTR', unit: 'percent', better: 'higher', source: 'gsc', kind: 'rate', digits: 2 },
  { key: 'position', label: 'Average position', unit: 'position', better: 'lower', source: 'gsc', kind: 'rate', digits: 1 },
  { key: 'sessions', label: 'Sessions', unit: 'count', better: 'higher', source: 'ga4', kind: 'total', digits: 0 },
  { key: 'keyEvents', label: 'Key events', unit: 'count', better: 'higher', source: 'ga4', kind: 'total', digits: 0 },
  { key: 'indexed', label: 'Indexed pages', unit: 'count', better: 'higher', source: 'sitemaps', kind: 'snapshot', digits: 0 },
  { key: 'top3', label: 'Keywords in top 3', unit: 'count', better: 'higher', source: 'gsc', kind: 'snapshot', digits: 0 },
  { key: 'top10', label: 'Keywords in top 10', unit: 'count', better: 'higher', source: 'gsc', kind: 'snapshot', digits: 0 },
  { key: 'top20', label: 'Keywords in top 20', unit: 'count', better: 'higher', source: 'gsc', kind: 'snapshot', digits: 0 },
  { key: 'newBacklinks', label: 'New backlinks', unit: 'count', better: 'higher', source: 'backlinks', kind: 'total', digits: 0 },
  { key: 'lostBacklinks', label: 'Lost backlinks', unit: 'count', better: 'lower', source: 'backlinks', kind: 'total', digits: 0 },
  { key: 'referringDomains', label: 'Referring domains', unit: 'count', better: 'higher', source: 'backlinks', kind: 'snapshot', digits: 0 },
  { key: 'avgDr', label: 'Average DR', unit: 'count', better: 'higher', source: 'backlinks', kind: 'snapshot', digits: 1 },
  { key: 'avgUr', label: 'Average UR', unit: 'count', better: 'higher', source: 'backlinks', kind: 'snapshot', digits: 1 },
  { key: 'tasksCompleted', label: 'Tasks completed', unit: 'count', better: 'higher', source: 'tasks', kind: 'total', digits: 0 },
];

export const KEY_NUMBER_KEYS: MetricKey[] = METRICS.map((m) => m.key);

export type TileState = 'ok' | 'not-connected' | 'not-available' | 'no-data' | 'hidden';
export type Direction = 'up' | 'down' | 'flat';
export type Verdict = 'better' | 'worse' | 'flat';
export const GLYPHS: Record<Direction, string> = { up: '▲', down: '▼', flat: '■' };

export interface Tile {
  key: MetricKey;
  label: string;
  unit: Unit;
  state: TileState;
  /** Values as shown: percentages already multiplied by 100, rounded. Null for a side with no data. */
  current: number | null;
  previous: number | null;
  /** The change in the same unit, from unrounded values; per day when the periods differ in length. */
  change: number | null;
  changePct: number | null;
  /** From zero to something: no percentage. */
  isNew: boolean;
  perDay: boolean;
  direction: Direction | null;
  verdict: Verdict | null;
  glyph: string | null;
  /** Which side has no data, when exactly one does. */
  missing: 'current' | 'previous' | null;
  detail: string | null;
  note: string | null;
}

export interface Side { value: number | null; /** Days the value covers (for per-day comparison of totals). */ days: number; detail?: string | null }

export interface TileInput { key: MetricKey; state: Exclude<TileState, 'no-data'>; current: Side; previous: Side; note?: string | null }

const unitScale = (unit: Unit): number => (unit === 'percent' ? 100 : 1);

/** One scorecard tile: value, change against the comparison (absolute and relative), and a direction that never depends on colour. */
export function makeTile(input: TileInput, perDay: boolean): Tile {
  const def = METRICS.find((m) => m.key === input.key)!;
  const base: Tile = {
    key: def.key, label: def.label, unit: def.unit, state: input.state, current: null, previous: null, change: null, changePct: null, isNew: false, perDay: false,
    direction: null, verdict: null, glyph: null, missing: null, detail: input.current.detail ?? null, note: input.note ?? null,
  };
  if (input.state !== 'ok') return base;
  const { current, previous } = input;
  if (current.value === null && previous.value === null) return { ...base, state: 'no-data' };
  const scale = unitScale(def.unit);
  const compareDay = perDay && def.kind === 'total';
  const tile: Tile = { ...base, current: current.value === null ? null : roundTo(current.value * scale, def.digits), previous: previous.value === null ? null : roundTo(previous.value * scale, def.digits), perDay: compareDay };
  if (current.value === null || previous.value === null) return { ...tile, missing: current.value === null ? 'current' : 'previous' };
  const a = (current.value * scale) / (compareDay ? Math.max(current.days, 1) : 1);
  const b = (previous.value * scale) / (compareDay ? Math.max(previous.days, 1) : 1);
  const digits = compareDay ? 1 : def.digits;
  const change = roundTo(a - b, digits);
  const isNew = b === 0 && a > 0 && change !== 0;
  const direction: Direction = change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const verdict: Verdict = direction === 'flat' ? 'flat' : (direction === 'up') === (def.better === 'higher') ? 'better' : 'worse';
  return {
    ...tile, change, changePct: b === 0 || direction === 'flat' ? null : roundTo(((a - b) / b) * 100, 1), isNew, direction, verdict, glyph: GLYPHS[direction],
    note: compareDay ? `Compared per day (${current.days} vs ${previous.days} days).${input.note ? ` ${input.note}` : ''}` : tile.note,
  };
}

// ---- data the report is built from -------------------------------------------------------------------------------

export interface DayTotals { clicks: number; impressions: number; positionImpressions: number; sessions: number; keyEvents: number }

export interface MoverIn {
  name: string;
  clicksCurrent: number;
  clicksPrevious: number;
  impressionsCurrent: number;
  impressionsPrevious: number;
  positionCurrent: number | null;
  positionPrevious: number | null;
}

export interface Mover { name: string; clicksCurrent: number; clicksPrevious: number; change: number; impressions: number; positionCurrent: number | null; positionPrevious: number | null; positionChange: number | null }

export interface MoverLists { gains: Mover[]; losses: Mover[]; positionGains: Mover[]; positionLosses: Mover[]; belowThreshold: number }

const alpha = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const validPosition = (p: number | null): p is number => p !== null && Number.isFinite(p) && p > 0;

/**
 * Largest gains and losses in clicks, and in average position, between the periods. A row counts only when it reached the
 * impressions threshold in both periods. Totals are compared per day when the periods differ in length.
 */
export function rankMovers(rows: MoverIn[], options: { minImpressions: number; daysCurrent: number; daysPrevious: number; limit?: number }): MoverLists {
  const limit = options.limit ?? MAX_MOVERS;
  const perDay = options.daysCurrent !== options.daysPrevious;
  const dc = Math.max(options.daysCurrent, 1);
  const dp = Math.max(options.daysPrevious, 1);
  const eligible = rows.filter((r) => r.impressionsCurrent >= options.minImpressions && r.impressionsPrevious >= options.minImpressions);
  const movers = eligible.map((r): Mover => {
    const bothPositions = validPosition(r.positionCurrent) && validPosition(r.positionPrevious);
    return {
      name: r.name, clicksCurrent: r.clicksCurrent, clicksPrevious: r.clicksPrevious,
      change: perDay ? roundTo(r.clicksCurrent / dc - r.clicksPrevious / dp, 1) : r.clicksCurrent - r.clicksPrevious,
      impressions: r.impressionsCurrent, positionCurrent: r.positionCurrent, positionPrevious: r.positionPrevious,
      positionChange: bothPositions ? r.positionCurrent! - r.positionPrevious! : null,
    };
  });
  const byImpressions = (a: Mover, b: Mover) => b.impressions - a.impressions || alpha(a.name, b.name);
  const rankedBy = (select: (m: Mover) => number | null, sign: 1 | -1) => movers
    .filter((m) => { const v = select(m); return v !== null && v * sign > 0; })
    .sort((a, b) => Math.abs(select(b)!) - Math.abs(select(a)!) || byImpressions(a, b))
    .slice(0, limit);
  return {
    gains: rankedBy((m) => m.change, 1), losses: rankedBy((m) => m.change, -1),
    // A lower position number is better, so an improvement is a negative change.
    positionGains: rankedBy((m) => (m.positionChange === null ? null : roundTo(m.positionChange, 1)), -1),
    positionLosses: rankedBy((m) => (m.positionChange === null ? null : roundTo(m.positionChange, 1)), 1),
    belowThreshold: rows.length - eligible.length,
  };
}

/** Counts of keywords by average position, cumulative: top 3 is inside top 10 is inside top 20. Positions of 0 or below, NaN and missing ones are ignored. */
export function positionBuckets(positions: ReadonlyArray<number | null | undefined>): { top3: number; top10: number; top20: number } {
  const out = { top3: 0, top10: 0, top20: 0 };
  for (const p of positions) {
    if (p === null || p === undefined || !Number.isFinite(p) || p <= 0) continue;
    if (p <= 3) out.top3++;
    if (p <= 10) out.top10++;
    if (p <= 20) out.top20++;
  }
  return out;
}

export interface LinkIn { sourceUrl: string; sourceHost: string; targetUrl: string; firstSeen: string; lostAt: string; sourceDr: number | null; sourceUr: number | null }

const day = (value: string): string => value.slice(0, 10);
const inWindow = (value: string, w: DateWindow): boolean => !!value && day(value) >= w.from && day(value) <= w.to;

export interface LinkRow { sourceUrl: string; sourceHost: string; targetUrl: string; dr: number | null; ur: number | null; on: string }

const byDr = (a: LinkRow, b: LinkRow): number => (a.dr === null ? (b.dr === null ? 0 : 1) : b.dr === null ? -1 : b.dr - a.dr) || alpha(a.sourceUrl, b.sourceUrl);
const rowOf = (l: LinkIn, on: string): LinkRow => ({ sourceUrl: l.sourceUrl, sourceHost: l.sourceHost, targetUrl: l.targetUrl, dr: l.sourceDr, ur: l.sourceUr, on: day(on) });

/** Links first seen in the window, and links lost in it. A link that is both appears in both lists. */
export function linkChanges(links: LinkIn[], window: DateWindow): { added: LinkRow[]; lost: LinkRow[] } {
  return {
    added: links.filter((l) => inWindow(l.firstSeen, window)).map((l) => rowOf(l, l.firstSeen)).sort(byDr),
    lost: links.filter((l) => inWindow(l.lostAt, window)).map((l) => rowOf(l, l.lostAt)).sort(byDr),
  };
}

/** Links that were live at the end of `end`: seen by then and not lost by then. */
export const liveAt = (links: LinkIn[], end: string): LinkIn[] => links.filter((l) => day(l.firstSeen) <= end && (!l.lostAt || day(l.lostAt) > end));

export interface DrUrSummary { links: number; withDr: number; withUr: number; avgDr: number | null; avgUr: number | null; referringDomains: number }

/** Averages over the links that have a value; a DR of 0 counts, a missing one does not. */
export function summariseLinks(live: LinkIn[]): DrUrSummary {
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const drs = live.map((l) => l.sourceDr).filter((v): v is number => v !== null);
  const urs = live.map((l) => l.sourceUr).filter((v): v is number => v !== null);
  return { links: live.length, withDr: drs.length, withUr: urs.length, avgDr: mean(drs), avgUr: mean(urs), referringDomains: new Set(live.map((l) => l.sourceHost)).size };
}

// ---- indexing changes ----------------------------------------------------------------------------------------------

export interface IndexChange { url: string; toState: string; at: string }

const stateBefore = (changes: IndexChange[], url: string, cutoff: string): string => {
  let state = '';
  let at = '';
  for (const c of changes) if (c.url === url && c.at < cutoff && c.at >= at) { state = c.toState; at = c.at; }
  return state;
};

/**
 * URLs that were known and not indexed when the window began and are indexed when it ends, and the other way round. A URL
 * that returns to where it was appears in neither, and a URL first inspected inside the window has no earlier state, so it is
 * a baseline rather than a change.
 */
export function indexingChanges(changes: IndexChange[], window: DateWindow): { newlyIndexed: string[]; newlyExcluded: string[] } {
  const start = window.from;
  const endCutoff = `${window.to}￿`;
  const urls = [...new Set(changes.map((c) => c.url))].sort();
  const newlyIndexed: string[] = [];
  const newlyExcluded: string[] = [];
  for (const url of urls) {
    const before = stateBefore(changes, url, start);
    const after = stateBefore(changes, url, endCutoff);
    if (after === 'indexed' && before !== '' && before !== 'indexed') newlyIndexed.push(url);
    else if (before === 'indexed' && after === 'not-indexed') newlyExcluded.push(url);
  }
  return { newlyIndexed, newlyExcluded };
}

/** The day the earliest known indexing state dates from; before it nothing is known, which is "no data" and not 0. */
export const knownFromOf = (changes: IndexChange[]): string | null => changes.reduce<string | null>((m, c) => (m === null || c.at < m ? c.at : m), null)?.slice(0, 10) ?? null;

/** Submitted pages seen by the end of the window, and how many of them were indexed then; null when the end is before any known state. */
export function indexedCounts(submitted: Array<{ url: string; firstSeen: string }>, changes: IndexChange[], end: string): { submitted: number; indexed: number } | null {
  const knownFrom = knownFromOf(changes);
  if (knownFrom === null || end < knownFrom) return null;
  const known = submitted.filter((s) => day(s.firstSeen) <= end);
  const endCutoff = `${end}￿`;
  return { submitted: known.length, indexed: known.filter((s) => stateBefore(changes, s.url, endCutoff) === 'indexed').length };
}

// ---- internal links --------------------------------------------------------------------------------------------------

export interface CrawlDigest { finishedAt: string; edges: string[]; outbound: Record<string, number>; orphans: number }

export interface InternalLinkChanges {
  available: boolean;
  reason: string | null;
  added: number;
  removed: number;
  addedSample: string[];
  removedSample: string[];
  orphansBefore: number | null;
  orphansAfter: number | null;
  newlyOverLimit: string[];
}

export function internalLinkChanges(before: CrawlDigest | null, after: CrawlDigest | null): InternalLinkChanges {
  const none = { added: 0, removed: 0, addedSample: [], removedSample: [], orphansBefore: null, orphansAfter: null, newlyOverLimit: [] };
  if (!before || !after) return { available: false, reason: 'Needs two crawls: one before the period and one by its end.', ...none };
  const old = new Set(before.edges);
  const now = new Set(after.edges);
  const added = [...now].filter((e) => !old.has(e)).sort();
  const removed = [...old].filter((e) => !now.has(e)).sort();
  const over = Object.entries(after.outbound).filter(([url, n]) => n > MAX_OUTBOUND_LINKS && (before.outbound[url] ?? 0) <= MAX_OUTBOUND_LINKS).map(([url]) => url).sort();
  return {
    available: true, reason: null, added: added.length, removed: removed.length, addedSample: added.slice(0, MAX_LISTED_CHANGES), removedSample: removed.slice(0, MAX_LISTED_CHANGES),
    orphansBefore: before.orphans, orphansAfter: after.orphans, newlyOverLimit: over.slice(0, MAX_LISTED_CHANGES),
  };
}

// ---- the report ------------------------------------------------------------------------------------------------------

export interface ChartPoint { n: number; current: number | null; previous: number | null; currentDay: string | null; previousDay: string | null }
export interface Chart { key: 'clicks' | 'impressions' | 'ctr' | 'position' | 'sessions' | 'keyEvents'; label: string; unit: Unit; state: 'ok' | 'not-connected' | 'no-data'; points: ChartPoint[] }

export interface WorkItem { id: string; title: string; kind: string; at: string }

export interface AiSummary { paragraph: string; actions: string[]; generatedAt: string; periodKey: string; digest: string; label: 'AI-generated' }

export interface ReportInputs {
  period: ResolvedPeriod;
  siteHost: string;
  generatedAt: string;
  sources: { gsc: boolean; ga4: boolean };
  /** Per-day totals and the days that were fetched, after the final-day rule. */
  gsc: { daily: Map<string, DayTotals>; days: Set<string> };
  ga4: { daily: Map<string, DayTotals>; days: Set<string> };
  minImpressions: number;
  pages: MoverIn[];
  keywords: MoverIn[];
  clusters: MoverIn[];
  /** Average position per keyword with impressions, per side; null when GSC has no data for that window. */
  keywordPositions: { current: Array<number | null> | null; previous: Array<number | null> | null };
  backlinks: { imported: boolean; links: LinkIn[] };
  indexing: { submitted: Array<{ url: string; firstSeen: string }>; changes: IndexChange[] };
  crawl: { count: number; before: CrawlDigest | null; after: CrawlDigest | null };
  work: { completedTasks: WorkItem[]; agentRuns: WorkItem[]; anyTasks: boolean };
  /** A read hit its row limit, so some numbers may be low. */
  capped: boolean;
}

export interface ReportData {
  schema: 1;
  state: 'ok' | 'setup';
  site: string;
  generatedAt: string;
  digest: string;
  period: ResolvedPeriod;
  notes: string[];
  setup: string[];
  coverage: { gsc: { current: number; previous: number; total: { current: number; previous: number } }; ga4: { current: number; previous: number; total: { current: number; previous: number } } };
  tiles: Tile[];
  charts: Chart[];
  minImpressions: number;
  movers: { pages: MoverLists; keywords: MoverLists; clusters: MoverLists };
  backlinks: { available: boolean; added: LinkRow[]; lost: LinkRow[]; addedTotal: number; lostTotal: number; coverage: { dr: string | null; ur: string | null } };
  indexing: { available: boolean; newlyIndexed: string[]; newlyExcluded: string[]; newlyIndexedTotal: number; newlyExcludedTotal: number };
  internalLinks: InternalLinkChanges;
  work: { tasks: WorkItem[]; agentRuns: WorkItem[] };
  summary: AiSummary | null;
}

const SETUP_STEPS = [
  'Connect Search Console in Connections to see clicks, impressions, CTR and positions.',
  'Connect Google Analytics to add sessions and key events.',
  'Add sitemaps so indexed pages can be tracked.',
  'Import backlinks (CSV) to see new and lost links with DR and UR.',
  'Run an internal links crawl, twice, to see link changes.',
];

const windowDays = (w: DateWindow | null): string[] => (w ? daysBetween(w.from, w.to) : []);

function sum(window: DateWindow | null, data: { daily: Map<string, DayTotals>; days: Set<string> }): { totals: DayTotals; covered: number } {
  const totals: DayTotals = { clicks: 0, impressions: 0, positionImpressions: 0, sessions: 0, keyEvents: 0 };
  let covered = 0;
  for (const d of windowDays(window)) {
    if (!data.days.has(d)) continue;
    covered++;
    const t = data.daily.get(d);
    if (!t) continue;
    for (const k of Object.keys(totals) as Array<keyof DayTotals>) totals[k] += t[k];
  }
  return { totals, covered };
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

function seriesOf(inputs: ReportInputs, key: Chart['key'], data: { daily: Map<string, DayTotals>; days: Set<string> }): ChartPoint[] {
  const cur = windowDays(inputs.period.current);
  const prev = windowDays(inputs.period.previous);
  const valueOn = (d: string | undefined): number | null => {
    if (!d || !data.days.has(d)) return null;
    const t = data.daily.get(d) ?? { clicks: 0, impressions: 0, positionImpressions: 0, sessions: 0, keyEvents: 0 };
    if (key === 'ctr') return ratio(t.clicks, t.impressions);
    if (key === 'position') return ratio(t.positionImpressions, t.impressions);
    return t[key];
  };
  return Array.from({ length: Math.max(cur.length, prev.length) }, (_, i) => ({ n: i + 1, current: valueOn(cur[i]), previous: valueOn(prev[i]), currentDay: cur[i] ?? null, previousDay: prev[i] ?? null }));
}

const LABELS = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<MetricKey, MetricDef>;

/** Builds the whole report from gathered inputs. The result holds every number and list the view needs, so a saved copy never reads live tables. */
export function buildReport(inputs: ReportInputs): ReportData {
  const { period } = inputs;
  const empty = !inputs.sources.gsc && !inputs.sources.ga4 && !inputs.backlinks.imported && inputs.crawl.count === 0 && inputs.indexing.submitted.length === 0 && !inputs.work.anyTasks;
  const base = {
    schema: 1 as const, site: inputs.siteHost, generatedAt: inputs.generatedAt, period, minImpressions: inputs.minImpressions, summary: null,
  };
  const blankMovers: MoverLists = { gains: [], losses: [], positionGains: [], positionLosses: [], belowThreshold: 0 };
  if (empty) {
    return {
      ...base, state: 'setup', digest: '', notes: [], setup: SETUP_STEPS, coverage: { gsc: { current: 0, previous: 0, total: { current: 0, previous: 0 } }, ga4: { current: 0, previous: 0, total: { current: 0, previous: 0 } } },
      tiles: [], charts: [], movers: { pages: blankMovers, keywords: blankMovers, clusters: blankMovers },
      backlinks: { available: false, added: [], lost: [], addedTotal: 0, lostTotal: 0, coverage: { dr: null, ur: null } },
      indexing: { available: false, newlyIndexed: [], newlyExcluded: [], newlyIndexedTotal: 0, newlyExcludedTotal: 0 },
      internalLinks: internalLinkChanges(null, null), work: { tasks: [], agentRuns: [] },
    };
  }

  const gscCur = sum(period.current, inputs.gsc);
  const gscPrev = sum(period.previous, inputs.gsc);
  const ga4Cur = sum(period.current, inputs.ga4);
  const ga4Prev = sum(period.previous, inputs.ga4);
  const perDay = period.perDay;
  const tiles: Tile[] = [];
  const add = (input: TileInput) => tiles.push(makeTile(input, perDay));
  const side = (value: number | null, days: number, detail: string | null = null): Side => ({ value, days, detail });

  // Search Console and Analytics
  const searchTile = (key: MetricKey, pick: (t: DayTotals) => number | null) => {
    const curOk = gscCur.covered > 0;
    const prevOk = gscPrev.covered > 0;
    add({
      key, state: inputs.sources.gsc ? 'ok' : 'not-connected',
      current: side(curOk ? pick(gscCur.totals) : null, gscCur.covered), previous: side(prevOk ? pick(gscPrev.totals) : null, gscPrev.covered),
      note: key === 'position' ? 'Impression-weighted Search Console average.' : null,
    });
  };
  searchTile('clicks', (t) => t.clicks);
  searchTile('impressions', (t) => t.impressions);
  searchTile('ctr', (t) => ratio(t.clicks, t.impressions));
  searchTile('position', (t) => ratio(t.positionImpressions, t.impressions));
  const analyticsTile = (key: MetricKey, pick: (t: DayTotals) => number) => add({
    key, state: inputs.sources.ga4 ? 'ok' : 'not-connected',
    current: side(ga4Cur.covered > 0 ? pick(ga4Cur.totals) : null, ga4Cur.covered), previous: side(ga4Prev.covered > 0 ? pick(ga4Prev.totals) : null, ga4Prev.covered),
  });
  analyticsTile('sessions', (t) => t.sessions);
  analyticsTile('keyEvents', (t) => t.keyEvents);

  // Indexing
  const submittedKnown = inputs.indexing.submitted.length > 0;
  const idxCur = period.current ? indexedCounts(inputs.indexing.submitted, inputs.indexing.changes, period.current.to) : null;
  const idxPrev = period.previous ? indexedCounts(inputs.indexing.submitted, inputs.indexing.changes, period.previous.to) : null;
  const knownFrom = knownFromOf(inputs.indexing.changes);
  add({
    key: 'indexed', state: submittedKnown ? 'ok' : 'not-available',
    current: side(idxCur ? idxCur.indexed : null, 1, idxCur ? `of ${idxCur.submitted} submitted` : null), previous: side(idxPrev ? idxPrev.indexed : null, 1, idxPrev ? `of ${idxPrev.submitted} submitted` : null),
  });

  // Keyword buckets: Search Console averages per keyword, not rank tracking
  const buckets = (positions: Array<number | null> | null) => (positions ? positionBuckets(positions) : null);
  const bCur = buckets(inputs.keywordPositions.current);
  const bPrev = buckets(inputs.keywordPositions.previous);
  for (const key of ['top3', 'top10', 'top20'] as const) {
    add({ key, state: inputs.sources.gsc ? 'ok' : 'not-connected', current: side(bCur ? bCur[key] : null, 1), previous: side(bPrev ? bPrev[key] : null, 1), note: 'From each keyword\'s Search Console average position, not rank tracking.' });
  }

  // Backlinks
  const linksOn = inputs.backlinks.imported;
  const changesCur = period.current ? linkChanges(inputs.backlinks.links, period.current) : null;
  const changesPrev = period.previous ? linkChanges(inputs.backlinks.links, period.previous) : null;
  const liveCur = period.current ? summariseLinks(liveAt(inputs.backlinks.links, period.current.to)) : null;
  const livePrev = period.previous ? summariseLinks(liveAt(inputs.backlinks.links, period.previous.to)) : null;
  const curLen = period.lengths.current;
  const prevLen = period.lengths.previous;
  add({ key: 'newBacklinks', state: linksOn ? 'ok' : 'not-available', current: side(changesCur ? changesCur.added.length : null, curLen), previous: side(changesPrev ? changesPrev.added.length : null, prevLen) });
  add({ key: 'lostBacklinks', state: linksOn ? 'ok' : 'not-available', current: side(changesCur ? changesCur.lost.length : null, curLen), previous: side(changesPrev ? changesPrev.lost.length : null, prevLen) });
  add({ key: 'referringDomains', state: linksOn ? 'ok' : 'not-available', current: side(liveCur ? liveCur.referringDomains : null, 1), previous: side(livePrev ? livePrev.referringDomains : null, 1) });
  const drUrState = (field: 'withDr' | 'withUr') => (linksOn && liveCur && liveCur[field] > 0 ? 'ok' : 'hidden') as Exclude<TileState, 'no-data'>;
  const coverageOf = (s: DrUrSummary | null, field: 'withDr' | 'withUr', label: string) => (s && s[field] > 0 ? `${s[field]} of ${s.links} links have ${label}` : null);
  add({ key: 'avgDr', state: drUrState('withDr'), current: side(liveCur?.avgDr ?? null, 1, coverageOf(liveCur, 'withDr', 'DR')), previous: side(livePrev?.avgDr ?? null, 1, coverageOf(livePrev, 'withDr', 'DR')) });
  add({ key: 'avgUr', state: drUrState('withUr'), current: side(liveCur?.avgUr ?? null, 1, coverageOf(liveCur, 'withUr', 'UR')), previous: side(livePrev?.avgUr ?? null, 1, coverageOf(livePrev, 'withUr', 'UR')) });

  // Work done
  const tasksIn = (w: DateWindow | null) => (w ? inputs.work.completedTasks.filter((t) => inWindow(t.at, w)).length : null);
  add({ key: 'tasksCompleted', state: 'ok', current: side(tasksIn(period.current), curLen), previous: side(tasksIn(period.previous), prevLen) });

  const visible = tiles.filter((t) => t.state !== 'hidden');

  const charts: Chart[] = (['clicks', 'impressions', 'ctr', 'position'] as const).map((key): Chart => {
    const points = seriesOf(inputs, key, inputs.gsc);
    return { key, label: LABELS[key].label, unit: LABELS[key].unit, points, state: !inputs.sources.gsc ? 'not-connected' : points.every((p) => p.current === null && p.previous === null) ? 'no-data' : 'ok' };
  });
  for (const key of ['sessions', 'keyEvents'] as const) {
    const points = seriesOf(inputs, key, inputs.ga4);
    charts.push({ key, label: LABELS[key].label, unit: LABELS[key].unit, points, state: !inputs.sources.ga4 ? 'not-connected' : points.every((p) => p.current === null && p.previous === null) ? 'no-data' : 'ok' });
  }

  const moverOptions = { minImpressions: inputs.minImpressions, daysCurrent: gscCur.covered || curLen, daysPrevious: gscPrev.covered || prevLen };
  const hasMovers = !!period.current && !!period.previous && inputs.sources.gsc;
  const movers = {
    pages: hasMovers ? rankMovers(inputs.pages, moverOptions) : blankMovers,
    keywords: hasMovers ? rankMovers(inputs.keywords, moverOptions) : blankMovers,
    clusters: hasMovers ? rankMovers(inputs.clusters, moverOptions) : blankMovers,
  };

  const listed = changesCur ?? { added: [], lost: [] };
  const idx = period.current ? indexingChanges(inputs.indexing.changes, period.current) : { newlyIndexed: [], newlyExcluded: [] };
  const work = {
    tasks: inputs.work.completedTasks.filter((t) => !!period.current && inWindow(t.at, period.current)),
    agentRuns: inputs.work.agentRuns.filter((t) => !!period.current && inWindow(t.at, period.current)),
  };

  const notes: string[] = [];
  const range = (w: DateWindow | null) => (w ? `${w.from} to ${w.to}` : '');
  if (period.clipped.current || period.clipped.previous) {
    notes.push(`Search and analytics data is only kept back to ${period.oldestRetained} (the oldest retained day). ${period.clipped.current === 'before' ? 'The selected range is entirely before it.' : ''}${period.clipped.current === 'partly' ? 'The selected range reaches before it, so only the retained days are shown.' : ''}${period.clipped.previous === 'before' ? ' The comparison range is entirely before it, so there is nothing to compare with.' : ''}${period.clipped.previous === 'partly' ? ' The comparison range reaches before it and is clipped.' : ''}`.replace(/\s+/g, ' ').trim());
  }
  if (submittedKnown && ((period.current && !idxCur) || (period.previous && !idxPrev))) notes.push(knownFrom ? `Indexing is known from ${knownFrom}; the indexed-pages count has no data before it.` : 'No page has been checked for indexing yet, so the indexed-pages count has no data.');
  if (period.trimmedDays > 0) notes.push(`${period.trimmedDays} recent day${period.trimmedDays === 1 ? '' : 's'} (today or not final yet) ${period.trimmedDays === 1 ? 'is' : 'are'} left out. Turn on "Include partial days" to include ${period.trimmedDays === 1 ? 'it' : 'them'}.`);
  if (period.includePartial) notes.push('Partial days are included, so the latest numbers can still change.');
  if (perDay) notes.push(`The periods differ in length (${curLen} vs ${prevLen} days), so totals are compared per day; rates and averages are compared directly.`);
  if (inputs.sources.gsc && gscCur.covered > 0 && gscCur.covered < curLen) notes.push(`Search Console data covers ${gscCur.covered} of ${curLen} days in the selected range.`);
  if (inputs.sources.ga4 && ga4Cur.covered > 0 && ga4Cur.covered < curLen) notes.push(`Analytics data covers ${ga4Cur.covered} of ${curLen} days in the selected range.`);
  if (inputs.capped) notes.push('Some lists hit their row limit, so some numbers may be low.');
  if (!period.current) notes.push(`There is no final data in the selected range${range(period.requested.current) ? ` (${range(period.requested.current)})` : ''} yet.`);

  const report: ReportData = {
    ...base, state: 'ok', digest: '', notes, setup: [],
    coverage: {
      gsc: { current: gscCur.covered, previous: gscPrev.covered, total: { current: curLen, previous: prevLen } },
      ga4: { current: ga4Cur.covered, previous: ga4Prev.covered, total: { current: curLen, previous: prevLen } },
    },
    tiles: visible, charts, movers,
    backlinks: {
      available: linksOn, added: listed.added.slice(0, MAX_LISTED_LINKS), lost: listed.lost.slice(0, MAX_LISTED_LINKS), addedTotal: listed.added.length, lostTotal: listed.lost.length,
      coverage: { dr: coverageOf(liveCur, 'withDr', 'DR'), ur: coverageOf(liveCur, 'withUr', 'UR') },
    },
    indexing: {
      available: submittedKnown, newlyIndexed: idx.newlyIndexed.slice(0, MAX_LISTED_CHANGES), newlyExcluded: idx.newlyExcluded.slice(0, MAX_LISTED_CHANGES),
      newlyIndexedTotal: idx.newlyIndexed.length, newlyExcludedTotal: idx.newlyExcluded.length,
    },
    internalLinks: period.current && period.previous ? internalLinkChanges(inputs.crawl.before, inputs.crawl.after) : internalLinkChanges(null, null),
    work,
  };
  report.digest = digestOf(report);
  return report;
}

/** A short fingerprint of the numbers, so an AI summary can tell when the report it was written for has changed. */
export function digestOf(report: Pick<ReportData, 'period' | 'tiles'>): string {
  return createHash('sha256').update(JSON.stringify([report.period.key, report.tiles.map((t) => [t.key, t.state, t.current, t.previous])])).digest('hex').slice(0, 16);
}

/** The key numbers a linked Building reads: the current value of every metric, null where there is no data. */
export function keyNumbers(report: Pick<ReportData, 'tiles'>): Record<MetricKey, number | null> {
  const out = Object.fromEntries(KEY_NUMBER_KEYS.map((k) => [k, null])) as Record<MetricKey, number | null>;
  for (const t of report.tiles) if (t.state === 'ok') out[t.key] = t.current;
  return out;
}
