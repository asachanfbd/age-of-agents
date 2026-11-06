import type { CalendarPostDto } from './contentTypes';
import { placedAt, placedDay } from './contentStats';
import { addDays, localDay, weekdayMon } from './contentZone';

export const MAX_CHIPS_PER_DAY = 3;

/** `YYYY-MM` of an instant in the Building zone ("today's month"). */
export const monthOf = (ms: number, tz: string): string => localDay(ms, tz).slice(0, 7);

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

const daysIn = (month: string): number => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export interface DayCell { day: string; inMonth: boolean; posts: CalendarPostDto[]; shown: CalendarPostDto[]; more: number }

/** The month as whole Monday-first weeks. Each post lands on its day in the Building zone (its published day once published), in time order. */
export function monthGrid(month: string, posts: CalendarPostDto[], tz: string): DayCell[][] {
  const first = `${month}-01`;
  const start = addDays(first, -weekdayMon(first));
  const weeks = Math.ceil((weekdayMon(first) + daysIn(month)) / 7);
  const byDay = new Map<string, CalendarPostDto[]>();
  for (const post of [...posts].sort((a, b) => Date.parse(placedAt(a)) - Date.parse(placedAt(b)))) {
    const day = placedDay(post, tz);
    byDay.set(day, [...(byDay.get(day) ?? []), post]);
  }
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, d): DayCell => {
    const day = addDays(start, w * 7 + d);
    const list = byDay.get(day) ?? [];
    return { day, inMonth: day.startsWith(month), posts: list, shown: list.slice(0, MAX_CHIPS_PER_DAY), more: Math.max(0, list.length - MAX_CHIPS_PER_DAY) };
  }));
}

export const moreLabel = (n: number): string => `+${n} more`;
