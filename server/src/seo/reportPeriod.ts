import { retentionCutoff } from '../buildings/retention.ts';
import { addDays, daysBetween, pacificToday, weekKey } from './dates.ts';
import { SeoInputError } from './errors.ts';
import { parseRange, previousWindow } from './period.ts';
import type { DateWindow } from './period.ts';

export const PERIOD_PRESETS = ['week', 'month', 'last-28', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export interface PeriodRequest {
  preset: PeriodPreset;
  from?: unknown;
  to?: unknown;
  compareFrom?: unknown;
  compareTo?: unknown;
  includePartial: boolean;
}

export interface PeriodContext {
  now: Date;
  /** The last day the sync marked final, or null when nothing is final yet. */
  lastFinalDay: string | null;
  retentionMonths: number;
}

export interface ResolvedPeriod {
  preset: PeriodPreset;
  includePartial: boolean;
  /** Weeks start on Monday. */
  weekStart: 'monday';
  /** The windows as asked for, before the retention window and the partial-day rule trimmed them. */
  requested: { current: DateWindow; previous: DateWindow };
  /** What the report covers; null when nothing of the window is left to show. */
  current: DateWindow | null;
  previous: DateWindow | null;
  oldestRetained: string;
  /** Per side: the window reached before the oldest retained day (`before` = entirely, `partly` = clipped). */
  clipped: { current: 'before' | 'partly' | null; previous: 'before' | 'partly' | null };
  /** Days dropped from the end of the current window because they are today or not final yet. */
  trimmedDays: number;
  lengths: { current: number; previous: number };
  /** The windows differ in length, so totals are compared per day. */
  perDay: boolean;
  key: string;
}

export const oldestRetainedDay = (months: number, now: Date): string => retentionCutoff({ months }, now);

const monday = (day: string): string => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
  return addDays(day, 1 - dow);
};

const firstOfMonth = (day: string): string => `${day.slice(0, 7)}-01`;

/** The first day of the month before the one `day` falls in. */
const monthBefore = (day: string): DateWindow => {
  const to = addDays(firstOfMonth(day), -1);
  return { from: firstOfMonth(to), to };
};

const lengthOf = (w: DateWindow | null): number => (w ? daysBetween(w.from, w.to).length : 0);

function clipToRetention(window: DateWindow, oldest: string): { window: DateWindow | null; clipped: 'before' | 'partly' | null } {
  if (window.to < oldest) return { window: null, clipped: 'before' };
  if (window.from < oldest) return { window: { from: oldest, to: window.to }, clipped: 'partly' };
  return { window, clipped: null };
}

/**
 * Turns a preset (or a custom range) into the two windows a report compares. Weeks start on Monday. The current window
 * ends at the last final day unless partial days are asked for; both windows are limited to the retained data.
 */
export function resolvePeriod(request: PeriodRequest, context: PeriodContext): ResolvedPeriod {
  const { now, lastFinalDay, retentionMonths } = context;
  const today = pacificToday(now);
  const yesterday = addDays(today, -1);
  const end = request.includePartial ? today : lastFinalDay && lastFinalDay < today ? lastFinalDay : yesterday;

  let current: DateWindow;
  let previous: DateWindow;
  if (request.preset === 'custom') {
    current = parseRange(request.from, request.to, now);
    const hasCompare = request.compareFrom !== undefined || request.compareTo !== undefined;
    previous = hasCompare ? parseRange(request.compareFrom, request.compareTo, now) : previousWindow(current);
  } else if (request.preset === 'week') {
    const start = monday(today);
    current = { from: start, to: addDays(start, 6) };
    previous = { from: addDays(start, -7), to: addDays(start, -1) };
  } else if (request.preset === 'month') {
    current = { from: firstOfMonth(today), to: today };
    previous = monthBefore(today);
  } else {
    current = { from: addDays(end, -27), to: end };
    previous = { from: addDays(end, -55), to: addDays(end, -28) };
  }

  const oldest = oldestRetainedDay(retentionMonths, now);
  const trimmedTo = current.to > end ? end : current.to;
  const heldBack = current.to < today ? current.to : today;
  const trimmedDays = heldBack > end ? daysBetween(end >= current.from ? addDays(end, 1) : current.from, heldBack).length : 0;
  const afterTrim: DateWindow | null = trimmedTo < current.from ? null : { from: current.from, to: trimmedTo };
  const cur = afterTrim ? clipToRetention(afterTrim, oldest) : { window: null, clipped: null };
  const prev = clipToRetention(previous, oldest);
  const lengths = { current: lengthOf(cur.window), previous: lengthOf(prev.window) };
  const periodKey = [request.preset, cur.window?.from ?? '-', cur.window?.to ?? '-', prev.window?.from ?? '-', prev.window?.to ?? '-', request.includePartial ? 'partial' : 'final'].join('|');
  return {
    preset: request.preset, includePartial: request.includePartial, weekStart: 'monday', requested: { current, previous },
    current: cur.window, previous: prev.window, oldestRetained: oldest, clipped: { current: cur.clipped, previous: prev.clipped },
    trimmedDays, lengths, perDay: lengths.current !== lengths.previous, key: periodKey,
  };
}

/** The Monday-to-Sunday week before the one `today` falls in, and the week before that. */
export function lastFullWeek(today: string): { current: DateWindow; previous: DateWindow } {
  const start = monday(today);
  return { current: { from: addDays(start, -7), to: addDays(start, -1) }, previous: { from: addDays(start, -14), to: addDays(start, -8) } };
}

/** The calendar month before the one `today` falls in, and the month before that. */
export function lastFullMonth(today: string): { current: DateWindow; previous: DateWindow } {
  const current = monthBefore(today);
  return { current, previous: monthBefore(current.from) };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Week 41 2026" for a week, "September 2026" for a month; the ISO week decides the year. */
export function defaultReportName(cadence: 'weekly' | 'monthly', current: DateWindow): string {
  if (cadence === 'monthly') return `${MONTHS[Number(current.from.slice(5, 7)) - 1]} ${current.from.slice(0, 4)}`;
  const [year, week] = weekKey(current.from).split('-W');
  return `Week ${Number(week)} ${year}`;
}

export const MAX_REPORT_NAME = 80;

/** A report name from the person: trimmed, and the default when empty. */
export function reportName(input: unknown, fallback: string): string {
  if (input === undefined || input === null) return fallback;
  if (typeof input !== 'string') throw new SeoInputError('name must be text');
  const name = input.trim();
  if (!name) return fallback;
  if ([...name].length > MAX_REPORT_NAME) throw new SeoInputError(`name must be at most ${MAX_REPORT_NAME} characters`);
  return name;
}
