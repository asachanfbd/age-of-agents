import { CrmInputError } from './errors.ts';
import { addDays, dayBounds, isIsoDay, weekday } from './zoned.ts';

export const PERIODS = ['day', 'week', 'month'] as const;
export type PeriodKind = (typeof PERIODS)[number];
export interface Window { kind: PeriodKind; startDay: string; endDay: string; start: number; end: number; label: string }

const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const nextMonth = (day: string) => { const [y, m] = day.split('-').map(Number) as [number, number]; return m === 12 ? `${String(y + 1).padStart(4, '0')}-01-01` : `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-01`; };
const prevMonth = (day: string) => { const [y, m] = day.split('-').map(Number) as [number, number]; return m === 1 ? `${String(y - 1).padStart(4, '0')}-12-01` : `${String(y).padStart(4, '0')}-${String(m - 1).padStart(2, '0')}-01`; };

/** ISO week number and week-year (Monday start; week 1 holds the first Thursday). */
export function isoWeek(day: string): { year: number; week: number } {
  const monday = addDays(day, -((weekday(day) + 6) % 7));
  const thursday = addDays(monday, 3);
  const year = Number(thursday.slice(0, 4));
  const jan1 = `${String(year).padStart(4, '0')}-01-01`;
  const firstMonday = addDays(jan1, -((weekday(jan1) + 6) % 7) + (((weekday(jan1) + 6) % 7) > 3 ? 7 : 0));
  return { year, week: Math.floor((Date.parse(`${monday}T00:00:00Z`) - Date.parse(`${firstMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1 };
}

export function windowFor(kind: PeriodKind, anyDay: string, tz: string): Window {
  let startDay: string, endDay: string, label: string;
  if (kind === 'day') { startDay = anyDay; endDay = addDays(anyDay, 1); label = anyDay; }
  else if (kind === 'week') {
    startDay = addDays(anyDay, -((weekday(anyDay) + 6) % 7)); endDay = addDays(startDay, 7);
    const w = isoWeek(anyDay); label = `${w.year}-W${String(w.week).padStart(2, '0')}`;
  } else { startDay = monthStart(anyDay); endDay = nextMonth(anyDay); label = anyDay.slice(0, 7); }
  return { kind, startDay, endDay, start: dayBounds(startDay, tz).start, end: dayBounds(endDay, tz).start, label };
}

export function previousWindow(w: Window, tz: string): Window {
  const anyDay = w.kind === 'day' ? addDays(w.startDay, -1) : w.kind === 'week' ? addDays(w.startDay, -7) : prevMonth(w.startDay);
  return windowFor(w.kind, anyDay, tz);
}

export function parsePeriod(kind: unknown, date: unknown, today: string, tz: string): Window {
  if (!PERIODS.includes(kind as PeriodKind)) throw new CrmInputError('period must be day, week or month', 'period');
  if (date !== undefined && date !== '' && !isIsoDay(date)) throw new CrmInputError('date must be a date like 2026-03-14', 'date');
  return windowFor(kind as PeriodKind, (date as string) || today, tz);
}
