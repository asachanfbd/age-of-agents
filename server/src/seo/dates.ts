import { retentionCutoff } from '../buildings/retention.ts';
import { SeoInputError } from './errors.ts';

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, days: number): string {
  return toDay(new Date(toDate(day).getTime() + days * DAY_MS));
}

/** Every day from `from` to `to` inclusive, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The ISO-8601 week a day falls in, as `YYYY-Www` (the week's Thursday decides the year). */
export function weekKey(day: string): string {
  const d = toDate(day);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(day: string): string {
  return day.slice(0, 7);
}

/** Search Console reports dates in Pacific time, so "today" for it is the Pacific calendar date. */
export function pacificToday(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts;
}

export const MIN_RETENTION_MONTHS = 1;
export const MAX_RETENTION_MONTHS = 36;
export const DEFAULT_RETENTION_MONTHS = 12;
/** Search Console only serves about 16 months of history. */
export const GSC_HISTORY_MONTHS = 16;

export function validateRetentionMonths(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_RETENTION_MONTHS || value > MAX_RETENTION_MONTHS) {
    throw new SeoInputError(`retentionMonths must be a whole number from ${MIN_RETENTION_MONTHS} to ${MAX_RETENTION_MONTHS}`);
  }
  return value;
}

/** First day to fetch for a dataset: the retention window, never further back than the service serves. */
export function backfillStart(today: string, retentionMonths: number, serviceMonths: number = Infinity): string {
  const months = Math.min(retentionMonths, serviceMonths);
  const d = new Date(0);
  const t = toDate(today);
  d.setUTCFullYear(t.getUTCFullYear(), t.getUTCMonth() - months, t.getUTCDate());
  return toDay(d);
}

/** Validates a `from`/`to` pair from a request: real dates, in order, and not wider than `maxDays`. */
export function parseDateRange(from: unknown, to: unknown, maxDays: number): { from: string; to: string } {
  if (!isIsoDay(from) || !isIsoDay(to)) throw new SeoInputError('from and to must be dates written YYYY-MM-DD');
  if (from > to) throw new SeoInputError('from must not be after to');
  if ((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS + 1 > maxDays) throw new SeoInputError(`the date range may cover at most ${maxDays} days`);
  return { from, to };
}

/**
 * The first day a sync fetches: the service's own history limit or the retention window counted from the Pacific date, but never
 * before the retention cutoff (UTC) that discarding uses. Without the clamp, for the hours when Pacific is a day behind UTC the
 * sync would fetch a day retention then discards, and fetch it again the next day.
 */
export function fetchStart(today: string, now: Date, retentionMonths: number, serviceMonths: number = Infinity): string {
  const byWindow = backfillStart(today, retentionMonths, serviceMonths);
  const cutoff = retentionCutoff({ months: retentionMonths }, now);
  return byWindow > cutoff ? byWindow : cutoff;
}
