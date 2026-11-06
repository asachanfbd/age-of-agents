import type { TokenUsage } from './serverApi';

/** All-zero usage — `sumTokenUsage`'s identity value and the base case for an empty chain. */
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };

function formatDateTime(date: Date): { date: string; time: string } {
  return {
    date: date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** A single point in time as one compact "Sep 13, 2:04 PM"-style string — the same date/time formatting `formatSessionTimespan` uses for a range, for a caller (e.g. a Notification's `createdAt`) that only has one instant to show. */
export function formatTimestamp(iso: string): string {
  const { date, time } = formatDateTime(new Date(iso));
  return `${date}, ${time}`;
}

/**
 * One session's start/end as a single compact line for a list row (`ProjectWorkspaceModal.tsx`'s
 * task rows and planning-session cards): same calendar day shows the date
 * once with both times ("Sep 13, 2:04 PM – 2:19 PM"); different days show each side its own date
 * ("Sep 13, 2:04 PM – Sep 14, 9:00 AM"). `endIso`
 * is null for a session with no settled end yet (still actively `'developing'` — see
 * `ProjectWorkspaceModal.tsx`'s `sessionEnd`), which reads as open-ended ("Sep 13, 2:04 PM – now")
 * rather than guessing a completion time that doesn't exist.
 */
export function formatSessionTimespan(startIso: string, endIso: string | null): string {
  const start = new Date(startIso);
  const startParts = formatDateTime(start);
  if (!endIso) return `${startParts.date}, ${startParts.time} – now`;
  const end = new Date(endIso);
  const endParts = formatDateTime(end);
  if (isSameCalendarDay(start, end)) return `${startParts.date}, ${startParts.time} – ${endParts.time}`;
  return `${startParts.date}, ${startParts.time} – ${endParts.date}, ${endParts.time}`;
}

/**
 * "1h 12m"-style compact duration — never a bare "0m" so an instant/near-zero span still reads as a
 * duration. With `seconds`, a span under an hour keeps its seconds ("45s", "2m 10s"); an hour or
 * more still reads "1h 5m".
 */
export function formatCompactDuration(ms: number, { seconds = false }: { seconds?: boolean } = {}): string {
  if (seconds && ms < 3_600_000) return formatMinutesSeconds(ms);
  if (ms < 60_000) return '<1m';
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** "45s" / "2m 10s" / "2m" for a span under an hour — "<1s" rather than a bare "0s". */
function formatMinutesSeconds(ms: number): string {
  if (ms < 1_000) return '<1s';
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (minutes === 0) return `${secs}s`;
  return secs === 0 ? `${minutes}m` : `${minutes}m ${secs}s`;
}

/**
 * Human-readable duration for a session list row, matching this app's terse UI text. A session
 * with no settled end yet (`endIso` null) measures up to `now` instead and is suffixed "so far",
 * so it reads as ongoing rather than as a duration that goes stale the moment time passes.
 */
export function formatSessionDuration(startIso: string, endIso: string | null, now: Date = new Date()): string {
  const end = endIso ? new Date(endIso) : now;
  const ms = Math.max(0, end.getTime() - new Date(startIso).getTime());
  const compact = formatCompactDuration(ms);
  return endIso ? compact : `${compact} so far`;
}

/**
 * Sums several Tasks' `tokenUsage` (a follow-up chain's total) — the input to
 * `formatSessionTokens`. A missing/null entry (a Task record predating token tracking) counts as
 * zero rather than throwing, so one old Task in a chain doesn't blank out the whole summary.
 */
export function sumTokenUsage(usages: (TokenUsage | null | undefined)[]): TokenUsage {
  return usages.reduce<TokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + (usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (usage?.outputTokens ?? 0),
      cacheCreationInputTokens: total.cacheCreationInputTokens + (usage?.cacheCreationInputTokens ?? 0),
      cacheReadInputTokens: total.cacheReadInputTokens + (usage?.cacheReadInputTokens ?? 0),
      totalCostUsd: total.totalCostUsd + (usage?.totalCostUsd ?? 0),
    }),
    ZERO_USAGE,
  );
}

/**
 * A session list row's token count, formatted like the footer's own agent-usage strip (see
 * `TopBar.tsx`: `${n.toLocaleString()} tokens`, and the same input+output+cache totalling
 * `server/src/executors/executorUsage.ts` uses) — reusing that convention rather than inventing a
 * second one. Returns null when there's nothing meaningful to show (a Task predating token
 * tracking, or one that used none), so callers can omit the segment instead of showing "0 tokens".
 */
export function formatSessionTokens(tokenUsage: TokenUsage | null | undefined): string | null {
  if (!tokenUsage) return null;
  const total = tokenUsage.inputTokens + tokenUsage.outputTokens + tokenUsage.cacheCreationInputTokens + tokenUsage.cacheReadInputTokens;
  return total > 0 ? `${total.toLocaleString()} tokens` : null;
}

/** Compact "31.4k"/"2.3M"-style count for a total this large, dropping a trailing ".0" — below 1,000 shows the exact number. Used by the project popup's rows, which have no room for a 7-digit figure. */
export function formatTokenCount(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${total}`;
}

/**
 * A session list row's token count, abbreviated ("744k tokens") rather than `formatSessionTokens`'
 * exact `toLocaleString()` figure — used where a compact row has no room for a 7-digit number.
 * Same null-for-nothing-to-show behavior as `formatSessionTokens`.
 */
export function formatSessionTokensCompact(tokenUsage: TokenUsage | null | undefined): string | null {
  if (!tokenUsage) return null;
  const total = tokenUsage.inputTokens + tokenUsage.outputTokens + tokenUsage.cacheCreationInputTokens + tokenUsage.cacheReadInputTokens;
  return total > 0 ? `${formatTokenCount(total)} tokens` : null;
}

/** A point in time as epoch ms or any `Date`-readable string; NaN when it can't be read or is outside the `Date` range. */
const toInstant = (at: string | number): number => new Date(at).getTime();

/** Which calendar day `ms` falls on in `timeZone`, as a whole-day count, so two instants' difference is their distance in local days. */
function calendarDay(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(ms).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000;
}

/**
 * An instant as a short relative label, past or future: "just now" within a minute either side,
 * "12m ago"/"in 12m", "3h ago"/"in 3h" (under a day, even across midnight), "yesterday"/"tomorrow",
 * "5d ago"/"in 5d", then a plain date once it's 30 days or more away. With a `timeZone`, the day
 * words, day counts and the plain date follow that zone's calendar days; without one, days are
 * elapsed 24h spans. An unreadable instant gives ''.
 */
export function formatRelativeTime(at: string | number, now: Date = new Date(), timeZone?: string): string {
  const atMs = toInstant(at);
  if (Number.isNaN(atMs)) return '';
  const deltaMs = atMs - now.getTime();
  const future = deltaMs > 0;
  const span = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`);
  const minutes = Math.floor(Math.abs(deltaMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return span(minutes, 'm');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return span(hours, 'h');
  // A day or more apart always reads at least one day, even when a 25h DST day keeps both instants on one calendar day.
  const days = Math.max(1, timeZone ? Math.abs(calendarDay(atMs, timeZone) - calendarDay(now.getTime(), timeZone)) : Math.floor(hours / 24));
  if (days === 1) return future ? 'tomorrow' : 'yesterday';
  if (days < 30) return span(days, 'd');
  return new Date(atMs).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric', ...(timeZone ? { timeZone } : {}) });
}

/** The exact wall-clock time of an instant, "Mon 26 Oct, 15:00" (or "15:00" without the date), in `timeZone` or the runtime's own zone. */
export function formatExactTime(at: string | number, timeZone?: string, withDate = true): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(toInstant(at));
}
