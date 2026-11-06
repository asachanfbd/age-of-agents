/**
 * Cron expressions and timezone arithmetic for the Building scheduler. Pure: every function takes the instant and the
 * timezone it works in, so tests drive it with fixed dates.
 *
 * Dialect: five fields (minute, hour, day of month, month, day of week) with `* , - /`, month and weekday names in any
 * case, weekday 0 and 7 both Sunday, plus `@hourly @daily @weekly @monthly @yearly`. When both day fields are
 * restricted, a day matching either one runs. No seconds field.
 *
 * Daylight saving: a local time that does not exist runs once, at the first instant after the clocks jump; a local
 * time that happens twice runs on its first occurrence only.
 */

export interface CronSchedule {
  /** The expression with single spaces between fields (a macro is kept as its lowercase name). */
  expression: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** Whether the day field was left as `*`: an unrestricted day field never widens the other one. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

export type CronParseResult = { ok: true; schedule: CronSchedule } | { ok: false; error: string };

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec { label: string; min: number; max: number; names?: string[]; nameOffset?: number }

const FIELDS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { label: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES, nameOffset: 0 },
];

class CronFieldError extends Error {}

function parseValue(text: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named !== -1) return named + (spec.nameOffset ?? 0);
  if (!/^\d{1,3}$/.test(text)) throw new CronFieldError(`${spec.label} "${text}" is not a value from ${spec.min} to ${spec.max}`);
  const value = Number(text);
  if (value < spec.min || value > spec.max) throw new CronFieldError(`${spec.label} "${text}" is out of range (${spec.min}-${spec.max})`);
  return value;
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range, stepText, ...extra] = part.split('/');
    if (!range || extra.length) throw new CronFieldError(`${spec.label} "${part}" is not valid`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,3}$/.test(stepText) || Number(stepText) === 0) throw new CronFieldError(`${spec.label} step "${stepText}" must be a whole number above 0`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === '*') {
      [from, to] = [spec.min, spec.max];
    } else {
      const [fromText, toText, ...more] = range.split('-');
      if (!fromText || more.length || toText === '') throw new CronFieldError(`${spec.label} "${part}" is not valid`);
      from = parseValue(fromText, spec);
      // `5/15` means "from 5 to the end, every 15".
      to = toText === undefined ? (stepText === undefined ? from : spec.max) : parseValue(toText, spec);
      if (to < from) throw new CronFieldError(`${spec.label} range "${range}" runs backwards`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(input: unknown): CronParseResult {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Invalid cron expression: it is empty' };
  const trimmed = input.trim();
  let expression = trimmed.split(/\s+/).join(' ');
  let fields = expression;
  if (trimmed.startsWith('@')) {
    const macro = MACROS[trimmed.toLowerCase()];
    if (!macro) return { ok: false, error: `Invalid cron expression: "${trimmed}" is not one of ${Object.keys(MACROS).join(', ')}` };
    expression = trimmed.toLowerCase();
    fields = macro;
  }
  const parts = fields.split(' ');
  if (parts.length !== FIELDS.length) return { ok: false, error: `Invalid cron expression: it needs 5 fields (minute hour day month weekday) and has ${parts.length}` };
  try {
    const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = parts.map((part, index) => parseField(part, FIELDS[index]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
    const daysOfWeek = new Set([...rawDaysOfWeek].map((day) => day % 7));
    return { ok: true, schedule: { expression, minutes, hours, daysOfMonth, months, daysOfWeek, anyDayOfMonth: parts[2] === '*', anyDayOfWeek: parts[4] === '*' } };
  } catch (error) {
    if (error instanceof CronFieldError) return { ok: false, error: `Invalid cron expression: ${error.message}` };
    throw error;
  }
}

// ---- Timezones ----

const IANA_NAME = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/;

/** An IANA name such as `Asia/Kolkata`, or `UTC`. */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || (value !== 'UTC' && !IANA_NAME.test(value))) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A Building with no timezone of its own uses the host's. */
export function resolveTimezone(timezone: string | null | undefined, hostTimezone: string): string {
  return timezone ?? hostTimezone;
}

export function hostTimezone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The largest instant a `Date` can hold, less a margin so a search can step forward without overflowing. */
const MAX_INSTANT = 8.64e15 - 400 * DAY;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', era: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * The wall-clock reading of `instant` in `timezone`, as a "naive" timestamp: the milliseconds a UTC clock showing the
 * same date and time would have. Wall-clock arithmetic is then plain UTC arithmetic.
 */
export function wallClockOf(instant: number, timezone: string): number {
  const parts: Record<string, number> = {};
  let bce = false;
  for (const part of formatterFor(timezone).formatToParts(new Date(instant))) {
    if (part.type === 'era') bce = part.value.startsWith('B');
    else if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const year = bce ? 1 - parts.year! : parts.year!;
  const wall = new Date(0);
  wall.setUTCFullYear(year, parts.month! - 1, parts.day!);
  wall.setUTCHours(parts.hour!, parts.minute!, parts.second!, 0);
  return wall.getTime() + (((instant % 1000) + 1000) % 1000);
}

function offsetAt(instant: number, timezone: string): number {
  return wallClockOf(instant, timezone) - instant;
}

/** The first minute in `(before, after]` whose offset is the one in force at `after`: the instant the clocks changed. */
function transitionBetween(before: number, after: number, timezone: string): number {
  const target = offsetAt(after, timezone);
  let low = Math.floor(before / MINUTE);
  let high = Math.ceil(after / MINUTE);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(middle * MINUTE, timezone) === target) high = middle;
    else low = middle;
  }
  return high * MINUTE;
}

/**
 * The instant a wall-clock minute runs at. A time that happens twice gives its first occurrence; a time the clocks
 * skip gives the instant of the jump itself.
 */
function instantOfWallClock(wall: number, timezone: string): number {
  const offsets = [...new Set([offsetAt(wall - DAY, timezone), offsetAt(wall + DAY, timezone)])];
  const candidates = offsets.map((offset) => wall - offset).filter((instant) => wallClockOf(instant, timezone) === wall);
  if (candidates.length) return Math.min(...candidates);
  const [first, second] = [wall - Math.max(...offsets), wall - Math.min(...offsets)];
  return transitionBetween(first, second, timezone);
}

function dayMatches(schedule: CronSchedule, wall: Date): boolean {
  const byMonthDay = schedule.daysOfMonth.has(wall.getUTCDate());
  const byWeekday = schedule.daysOfWeek.has(wall.getUTCDay());
  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek) return true;
  if (schedule.anyDayOfMonth) return byWeekday;
  if (schedule.anyDayOfWeek) return byMonthDay;
  return byMonthDay || byWeekday;
}

/** Far enough ahead to reach the next 29 February from anywhere, including across a skipped leap year. */
const SEARCH_YEARS = 9;

/** The next matching wall-clock minute strictly after `wall`, or null when the expression never matches in the search window. */
function nextWallClock(schedule: CronSchedule, wall: number): number | null {
  const cursor = new Date(Math.floor(wall / MINUTE) * MINUTE + MINUTE);
  const lastYear = cursor.getUTCFullYear() + SEARCH_YEARS;
  while (cursor.getUTCFullYear() <= lastYear) {
    if (!schedule.months.has(cursor.getUTCMonth() + 1)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(schedule, cursor)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
    } else if (!schedule.hours.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
    } else if (!schedule.minutes.has(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
    } else {
      return cursor.getTime();
    }
  }
  return null;
}

/** The first instant strictly after `from` at which the schedule runs, or null when there is none to find. */
export function nextRun(schedule: CronSchedule, from: number, timezone: string): number | null {
  if (!Number.isFinite(from) || from > MAX_INSTANT) return null;
  let wall: number | null = wallClockOf(from, timezone);
  for (;;) {
    wall = nextWallClock(schedule, wall);
    if (wall === null) return null;
    const instant = instantOfWallClock(wall, timezone);
    // A slot at or before `from` is the second pass of a repeated hour, or the jump a skipped slot already ran at.
    if (instant > from) return instant;
  }
}

/** The next `count` run times after `from`, oldest first. */
export function upcomingRuns(schedule: CronSchedule, from: number, timezone: string, count: number): number[] {
  const runs: number[] = [];
  let cursor = from;
  while (runs.length < count) {
    const next = nextRun(schedule, cursor, timezone);
    if (next === null) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

/** Widening look-back windows: a schedule that did not run in one window runs at most a few times in the next. */
const LOOK_BACK = [HOUR, DAY, 32 * DAY, 366 * DAY, (SEARCH_YEARS + 1) * 366 * DAY];

/** The latest slot in `(after, now]`, or null when none fell in it. Does not visit every slot of a long gap. */
export function latestMissedRun(schedule: CronSchedule, after: number, now: number, timezone: string): number | null {
  if (!(after < now)) return null;
  for (const span of LOOK_BACK) {
    const start = Math.max(after, now - span);
    let latest: number | null = null;
    for (let next = nextRun(schedule, start, timezone); next !== null && next <= now; next = nextRun(schedule, next, timezone)) latest = next;
    if (latest !== null || start === after) return latest;
  }
  return null;
}

/** The local calendar day of `instant`, as `YYYY-MM-DD`. */
export function localDay(instant: number, timezone: string): string {
  return new Date(wallClockOf(instant, timezone)).toISOString().slice(0, 10);
}
