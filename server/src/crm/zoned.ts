/** Calendar-date and wall-clock arithmetic in an IANA time zone (the Building's), using only Intl. */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}

/** "HH:MM" to minutes after midnight; null when malformed ("24:00" and "9:5" are refused). */
export function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }
export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const dayText = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

/** "Today" as the calendar date in the zone. */
export function localDay(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return dayText(p.year, p.month, p.day);
}

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (y < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCFullYear(y);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  dt.setUTCFullYear(dt.getUTCFullYear());
  return dayText(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 0 = Sunday. */
export function weekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time (day plus minutes after midnight) happens in the zone. In a skipped hour it lands just after the gap. */
export function zonedMs(day: string, minutes: number, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = naive - offsetAt(naive, tz);
  guess = naive - offsetAt(guess, tz);
  return guess;
}

/** Start of the day and start of the next day, so a DST day is 23 or 25 hours long. */
export function dayBounds(day: string, tz: string): { start: number; end: number } {
  return { start: zonedMs(day, 0, tz), end: zonedMs(addDays(day, 1), 0, tz) };
}

/** Due time `days` calendar days after `fromMs`, keeping the same local wall-clock time (DST-safe). */
export function addLocalDays(fromMs: number, days: number, tz: string): number {
  const p = localParts(fromMs, tz);
  const day = addDays(dayText(p.year, p.month, p.day), days);
  return zonedMs(day, p.hour * 60 + p.minute, tz) + p.second * 1000 + (fromMs % 1000 + 1000) % 1000;
}

export interface Interval { start: number; end: number }

/** The parts of `window` not covered by any `busy` interval. */
export function freeIntervals(window: Interval, busy: Interval[]): Interval[] {
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, window.start), end: Math.min(b.end, window.end) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of clipped) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}
