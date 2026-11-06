import { USAGE_REFRESH_MS } from '../executors/usagePoller.ts';
import type { QuotaFailure, QuotaReading, QuotaWindowKey } from './types.ts';

/**
 * Two sampling intervals plus a minute of slack: readings further apart than this are not joined, and
 * a boundary reading must fall this close to an activity's start or end. The slack keeps one skipped
 * sample, or a slow provider answer, from sitting on the edge and reading as a gap.
 */
export const GAP_THRESHOLD_MS = 2 * USAGE_REFRESH_MS + 60_000;
/** Provider reset times can wobble by a second or two between checks; a larger move means a new window. */
const RESET_TIME_TOLERANCE_MS = 60_000;

/** Remaining capacity is the inverse of the provider's used percentage. */
export function remainingPercent(usedPercentage: number): number {
  return 100 - usedPercentage;
}

export interface SeriesPoint {
  at: number;
  remaining: number;
  used: number;
  resetsAt: number | null;
  /** Points sharing a segment may be joined by a line; a gap or a reset starts a new one. */
  segment: number;
}

export type GapReason = 'no-readings' | 'check-failed' | 'window-unavailable';

/** A stretch with no trustworthy value for this window. Never drawn as a flat line. */
export interface SeriesGap {
  from: number;
  to: number;
  reason: GapReason;
}

/** Capacity came back: the window reset, or remaining went up. Never counted as consumption. */
export interface SeriesReset {
  at: number;
  before: number;
  after: number;
}

export interface WindowSeries {
  points: SeriesPoint[];
  gaps: SeriesGap[];
  resets: SeriesReset[];
}

function isReset(before: SeriesPoint, after: SeriesPoint): boolean {
  if (after.remaining > before.remaining) return true;
  if (before.resetsAt === null) return false;
  if (before.resetsAt <= after.at) return true;
  return after.resetsAt !== null && Math.abs(after.resetsAt - before.resetsAt) > RESET_TIME_TOLERANCE_MS;
}

/**
 * One window's history as line segments, gaps and reset markers. `readings` and `failures` must be
 * sorted by time. The two windows are analysed separately, so one can have a gap or a reset while the
 * other carries on.
 */
export function buildWindowSeries(readings: QuotaReading[], failures: QuotaFailure[], window: QuotaWindowKey): WindowSeries {
  const series: WindowSeries = { points: [], gaps: [], resets: [] };
  let segment = 0;
  let failureIndex = 0;
  let unavailableSincePrevious = false;
  for (const reading of readings) {
    const value = reading[window];
    if (!value) { unavailableSincePrevious = true; continue; }
    const point: SeriesPoint = { at: reading.at, remaining: remainingPercent(value.usedPercentage), used: value.usedPercentage, resetsAt: value.resetsAt, segment };
    const previous = series.points.at(-1);
    if (previous) {
      while (failureIndex < failures.length && failures[failureIndex]!.at <= previous.at) failureIndex += 1;
      const failedBetween = failureIndex < failures.length && failures[failureIndex]!.at < point.at;
      const reason: GapReason | null = unavailableSincePrevious ? 'window-unavailable'
        : failedBetween ? 'check-failed'
        : point.at - previous.at > GAP_THRESHOLD_MS ? 'no-readings'
        : null;
      if (reason) {
        series.gaps.push({ from: previous.at, to: point.at, reason });
        segment += 1;
      } else if (isReset(previous, point)) {
        series.resets.push({ at: point.at, before: previous.remaining, after: point.remaining });
        segment += 1;
      }
      point.segment = segment;
    }
    unavailableSincePrevious = false;
    series.points.push(point);
  }
  const last = series.points.at(-1);
  const lastFailure = failures.at(-1);
  if (last && lastFailure && lastFailure.at > last.at) series.gaps.push({ from: last.at, to: lastFailure.at, reason: 'check-failed' });
  return series;
}

/** The part of a series that falls in, or touches, a time range. Points keep their segment numbers. */
export function sliceSeries(series: WindowSeries, from: number, to: number): WindowSeries {
  return {
    points: series.points.filter((point) => point.at >= from && point.at <= to),
    gaps: series.gaps.filter((gap) => gap.to >= from && gap.from <= to),
    resets: series.resets.filter((reset) => reset.at >= from && reset.at <= to),
  };
}

export type DecreaseUnavailableReason = 'missing-boundary-reading' | 'reset' | 'gap' | 'in-progress';

/** The observed fall in remaining capacity across a period, in percentage points, or why it cannot be stated. */
export type ObservedDecrease =
  | { available: true; points: number; from: number; to: number }
  | { available: false; reason: DecreaseUnavailableReason };

/**
 * The fall in remaining capacity between the reading just before `start` and the one just after
 * `end`. Stated only when both readings exist close to the boundaries and nothing between them is
 * unknown: no reset, no failed check, no missing reading. It measures the whole account, so it is an
 * estimate of impact, never a token count.
 */
export function observedDecrease(series: WindowSeries, start: number, end: number | null): ObservedDecrease {
  if (end === null) return { available: false, reason: 'in-progress' };
  const { points } = series;
  let before = -1;
  for (let index = 0; index < points.length && points[index]!.at <= start; index += 1) before = index;
  const after = points.findIndex((point) => point.at >= end);
  const first = points[before];
  const last = points[after];
  if (!first || !last || start - first.at > GAP_THRESHOLD_MS || last.at - end > GAP_THRESHOLD_MS) {
    return { available: false, reason: 'missing-boundary-reading' };
  }
  if (first.segment !== last.segment) {
    const reset = series.resets.some((marker) => marker.at > first.at && marker.at <= last.at);
    return { available: false, reason: reset ? 'reset' : 'gap' };
  }
  return { available: true, points: roundPoints(first.remaining - last.remaining), from: first.at, to: last.at };
}

/** Percentages arrive as floats; keep two decimals so differences do not show rounding noise. */
function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A fall in remaining capacity between two consecutive, joined readings. */
export interface SeriesDrop {
  from: number;
  to: number;
  points: number;
}

export function findDrops(series: WindowSeries): SeriesDrop[] {
  const drops: SeriesDrop[] = [];
  for (let index = 1; index < series.points.length; index += 1) {
    const previous = series.points[index - 1]!;
    const point = series.points[index]!;
    const fall = roundPoints(previous.remaining - point.remaining);
    if (point.segment === previous.segment && fall > 0) drops.push({ from: previous.at, to: point.at, points: fall });
  }
  return drops;
}

/**
 * Joins drops into stretches, adding their falls together. Drops that follow one another directly
 * always join; drops with level readings between them join when `mayBridge` allows that interval.
 */
export function mergeDrops(drops: SeriesDrop[], mayBridge: (from: number, to: number) => boolean): SeriesDrop[] {
  const merged: SeriesDrop[] = [];
  for (const drop of drops) {
    const previous = merged.at(-1);
    if (previous && (previous.to === drop.from || mayBridge(previous.to, drop.from))) {
      merged[merged.length - 1] = { from: previous.from, to: drop.to, points: roundPoints(previous.points + drop.points) };
    } else merged.push(drop);
  }
  return merged;
}

/** Whether a series is unbroken across `[from, to]`: no gap and no reset inside it. */
export function isUnbroken(series: WindowSeries, from: number, to: number): boolean {
  return !series.gaps.some((gap) => gap.from < to && gap.to > from) && !series.resets.some((reset) => reset.at > from && reset.at <= to);
}

export type CapacityState = 'measured' | 'stale' | 'failed' | 'expired' | 'unavailable' | 'awaiting';
/** A reading older than three sampling intervals no longer describes "now". */
export const STALE_AFTER_MS = 15 * 60_000;

/** What can be said about one window right now. Only `measured`, `stale` and `failed` carry a value. */
export interface CurrentCapacity {
  state: CapacityState;
  remaining: number | null;
  used: number | null;
  observedAt: number | null;
  resetsAt: number | null;
}

/**
 * The current state of one window. A window with no reading, no value, or a reset time already
 * passed has no percentage: none of them is a measured 0% or 100%.
 */
export function currentCapacity(latest: QuotaReading | undefined, window: QuotaWindowKey, now: number, lastFailureAt: number | null): CurrentCapacity {
  const empty = { remaining: null, used: null, observedAt: latest?.at ?? null, resetsAt: null };
  if (!latest) return { ...empty, state: 'awaiting' };
  const value = latest[window];
  if (!value) return { ...empty, state: 'unavailable' };
  if (value.resetsAt !== null && value.resetsAt <= now) return { ...empty, state: 'expired', resetsAt: value.resetsAt };
  const state: CapacityState = lastFailureAt !== null && lastFailureAt > latest.at ? 'failed' : now - latest.at > STALE_AFTER_MS ? 'stale' : 'measured';
  return { state, remaining: remainingPercent(value.usedPercentage), used: value.usedPercentage, observedAt: latest.at, resetsAt: value.resetsAt };
}
