import { addDays, daysBetween, isIsoDay, pacificToday } from './dates.ts';
import { SeoInputError } from './errors.ts';
import { avgPositionOf, ctrOf } from './metrics.ts';

export const DEFAULT_RANGE_DAYS = 28;
/** The longest range the Pages table compares; two of them must fit in what retention can hold. */
export const MAX_RANGE_DAYS = 400;

export interface DateWindow { from: string; to: string }
export interface Windows { current: DateWindow; previous: DateWindow | null }

/** The 28 days ending at the last final day, compared with the 28 before. Without any data the range ends yesterday (Pacific). */
export function defaultWindows(lastFinalDay: string | null, now: Date): Windows {
  const to = lastFinalDay ?? addDays(pacificToday(now), -1);
  return windowsFor({ from: addDays(to, -(DEFAULT_RANGE_DAYS - 1)), to }, true);
}

/** The same-length window immediately before `current`. */
export function previousWindow(current: DateWindow): DateWindow {
  const length = daysBetween(current.from, current.to).length;
  return { from: addDays(current.from, -length), to: addDays(current.from, -1) };
}

export const windowsFor = (current: DateWindow, compare: boolean): Windows => ({ current, previous: compare ? previousWindow(current) : null });

/** Validates a requested range: real dates, in order, not in the future (Pacific), and not longer than the limit. */
export function parseRange(from: unknown, to: unknown, now: Date): DateWindow {
  if (!isIsoDay(from) || !isIsoDay(to)) throw new SeoInputError('from and to must be dates written YYYY-MM-DD');
  if (from > to) throw new SeoInputError('from must not be after to');
  if (to > pacificToday(now)) throw new SeoInputError('to must not be in the future');
  if (daysBetween(from, to).length > MAX_RANGE_DAYS) throw new SeoInputError(`the date range may cover at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

export interface Coverage {
  /** Days in the window the sync has fetched. */
  covered: number;
  total: number;
  /** none: nothing fetched, so every value is "no data". partial: some days are missing, so values cover only part of the window. */
  state: 'none' | 'partial' | 'full';
}

export function coverageOf(window: DateWindow, fetchedDays: ReadonlySet<string>): Coverage {
  const days = daysBetween(window.from, window.to);
  const covered = days.filter((d) => fetchedDays.has(d)).length;
  return { covered, total: days.length, state: covered === 0 ? 'none' : covered === days.length ? 'full' : 'partial' };
}

export interface Totals { clicks: number; impressions: number; positionImpressions: number; sessions: number; keyEvents: number }
export const zeroTotals = (): Totals => ({ clicks: 0, impressions: 0, positionImpressions: 0, sessions: 0, keyEvents: 0 });

export const addTotals = (into: Totals, from: Partial<Totals>): void => {
  into.clicks += from.clicks ?? 0;
  into.impressions += from.impressions ?? 0;
  into.positionImpressions += from.positionImpressions ?? 0;
  into.sessions += from.sessions ?? 0;
  into.keyEvents += from.keyEvents ?? 0;
};

export interface Metrics { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null; sessions: number | null; keyEvents: number | null }
export const emptyMetrics = (): Metrics => ({ clicks: null, impressions: null, ctr: null, position: null, sessions: null, keyEvents: null });

/**
 * The metrics a page shows for one window. Search metrics are null when the window has no Search Console data at all, and
 * analytics metrics when it has no Analytics data: a gap is never a zero. CTR is total clicks over total impressions and
 * position is weighted by impressions.
 */
export function metricsOf(totals: Totals, gsc: Coverage, ga4: Coverage): Metrics {
  const metrics = emptyMetrics();
  if (gsc.state !== 'none') Object.assign(metrics, { clicks: totals.clicks, impressions: totals.impressions, ctr: ctrOf(totals), position: avgPositionOf(totals) });
  if (ga4.state !== 'none') Object.assign(metrics, { sessions: totals.sessions, keyEvents: totals.keyEvents });
  return metrics;
}

export interface Delta { abs: number; /** Relative change; null when the previous value was 0. */ pct: number | null; isNew: boolean }

/** Change against the previous period. No change at all (both 0) and a missing side give null; from 0 to something is "new". */
export function deltaOf(current: number | null, previous: number | null): Delta | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? null : { abs: current, pct: null, isNew: true };
  return { abs: current - previous, pct: (current - previous) / previous, isNew: false };
}

export type MetricKey = keyof Metrics;
export const METRIC_KEYS: MetricKey[] = ['clicks', 'impressions', 'ctr', 'position', 'sessions', 'keyEvents'];

export function deltasOf(current: Metrics, previous: Metrics | null): Record<MetricKey, Delta | null> {
  return Object.fromEntries(METRIC_KEYS.map((k) => [k, previous ? deltaOf(current[k], previous[k]) : null])) as Record<MetricKey, Delta | null>;
}

/** Ranks "changed most": relative change in clicks (new counts as the largest), then absolute change. Rows without a change rank last. */
export function changeScore(delta: Delta | null): number {
  if (!delta || delta.abs === 0) return -1;
  return delta.isNew ? Number.MAX_SAFE_INTEGER : Math.abs(delta.pct!);
}
