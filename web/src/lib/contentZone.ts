/** Wall-clock arithmetic in the Building's IANA time zone, using only Intl. The browser's own zone is never consulted. */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }
export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute! };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const dayText = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
/** The calendar date of an instant in the zone, `YYYY-MM-DD`. */
export function localDay(ms: number, tz: string): string { const p = localParts(ms, tz); return dayText(p.year, p.month, p.day); }
export function localTime(ms: number, tz: string): string { const p = localParts(ms, tz); return `${pad(p.hour)}:${pad(p.minute)}`; }

function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** The instant a wall-clock time happens in the zone; in a skipped hour (DST gap) it lands just after the gap. */
export function zonedMs(day: string, minutes: number, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = naive - offsetAt(naive, tz);
  guess = naive - offsetAt(guess, tz);
  return guess;
}

/** `datetime-local` text (`YYYY-MM-DDTHH:mm`) read as a Building-zone wall-clock time, as an ISO instant; null when malformed. */
export function localTextToInstant(text: string, tz: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!m) return null;
  const ms = zonedMs(m[1]!, Number(m[2]) * 60 + Number(m[3]), tz);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An instant as `datetime-local` text in the Building zone. */
export const instantToLocalText = (instant: string | number, tz: string): string => {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  return `${localDay(ms, tz)}T${localTime(ms, tz)}`;
};

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dayText(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayMon(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The zones to offer: the browser's zone first, then the runtime's list (a short fallback list when it has none), with the Building's own zone included. */
export function timezoneOptions(browserZone: string, supported: string[] | null, current?: string): string[] {
  const list = supported && supported.length ? supported : ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
  const rest = list.filter((z) => z !== browserZone && z !== current);
  return [...new Set([browserZone, ...(current ? [current] : []), ...rest])];
}

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function supportedTimezones(): string[] | null {
  try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? null; } catch { return null; }
}
