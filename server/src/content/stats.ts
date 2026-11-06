import { ContentInputError } from './errors.ts';
import { COUNT_MAX, FUTURE_TOLERANCE_MS, LIVE_URL_MAX, STATS_NOTE_MAX, WATCH_TIME_MAX } from './limits.ts';
import type { Platform } from './rules.ts';
import { charCount, parseInstant } from './validate.ts';

export const STAT_FIELDS = ['impressions', 'reach', 'views', 'likes', 'comments', 'shares', 'saves', 'linkClicks', 'profileVisits', 'followersGained'] as const;
export type StatField = (typeof STAT_FIELDS)[number];
export type StatCounts = Record<StatField, number | null>;
export const isStatField = (key: string): key is StatField => (STAT_FIELDS as readonly string[]).includes(key);

export interface PlatformField { key: StatField; label: string }
const f = (key: StatField, label: string): PlatformField => ({ key, label });
/** The counts each platform's form offers, under that platform's own labels. The server accepts every field for every platform. */
export const PLATFORM_STAT_FIELDS: Record<Platform, PlatformField[]> = {
  linkedin: [f('impressions', 'Impressions'), f('likes', 'Reactions'), f('comments', 'Comments'), f('shares', 'Reposts'), f('linkClicks', 'Clicks'), f('followersGained', 'Followers gained')],
  instagram: [f('reach', 'Reach'), f('views', 'Views'), f('likes', 'Likes'), f('comments', 'Comments'), f('shares', 'Shares'), f('saves', 'Saves'), f('profileVisits', 'Profile visits'), f('followersGained', 'Followers gained')],
  x: [f('impressions', 'Views'), f('likes', 'Likes'), f('comments', 'Replies'), f('shares', 'Reposts'), f('saves', 'Bookmarks'), f('linkClicks', 'Link clicks'), f('profileVisits', 'Profile visits')],
  facebook: [f('reach', 'Reach'), f('views', 'Views'), f('likes', 'Reactions'), f('comments', 'Comments'), f('shares', 'Shares'), f('linkClicks', 'Link clicks')],
  blog: [f('views', 'Views'), f('linkClicks', 'Link clicks'), f('comments', 'Comments')],
};

export const hasWatchTime = (format: string): boolean => format === 'video' || format === 'reel';

export const emptyCounts = (): StatCounts => Object.fromEntries(STAT_FIELDS.map((k) => [k, null])) as StatCounts;

/** A whole number from 0 to `COUNT_MAX`; `null` and omitted both mean unknown (never zero). */
function parseCount(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > COUNT_MAX) {
    throw new ContentInputError(`${field} must be a whole number from 0 to ${COUNT_MAX}`, `counts.${field}`);
  }
  return value;
}

/** Counts from a body, starting from `base`: an explicit `null` clears a count, an omitted key keeps it, an unknown key is refused. */
export function parseCounts(value: unknown, base: StatCounts = emptyCounts()): StatCounts {
  if (value === undefined) return { ...base };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContentInputError('counts must be an object', 'counts');
  const out = { ...base };
  for (const [key, raw] of Object.entries(value)) {
    if (!isStatField(key)) throw new ContentInputError(`${key} is not a stats field`, `counts.${key}`);
    out[key] = parseCount(raw, key);
  }
  return out;
}

export function requireAnyCount(counts: StatCounts): void {
  if (STAT_FIELDS.every((k) => counts[k] === null)) throw new ContentInputError('Enter at least one count', 'counts');
}

/** Seconds with at most one decimal; only video and reel posts have one. `null` and omitted mean none. */
export function parseWatchTime(value: unknown, format: string): number | null {
  if (value === null || value === undefined) return null;
  if (!hasWatchTime(format)) throw new ContentInputError('Average watch time is only for video and reel posts', 'watchTime');
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > WATCH_TIME_MAX || Math.round(value * 10) / 10 !== value) {
    throw new ContentInputError(`watchTime must be seconds from 0 to ${WATCH_TIME_MAX} with at most 1 decimal`, 'watchTime');
  }
  return value;
}

export function parseNote(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ContentInputError('note must be text', 'note');
  const note = value.trim();
  if (charCount(note) > STATS_NOTE_MAX) throw new ContentInputError(`note must be at most ${STATS_NOTE_MAX} characters`, 'note');
  return note;
}

/** An `http(s)` URL of at most `LIVE_URL_MAX` characters; absent, `null` and empty text mean no URL. */
export function parseLiveUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ContentInputError('liveUrl must be text', 'liveUrl');
  const text = value.trim();
  if (!text) return null;
  if (charCount(text) > LIVE_URL_MAX) throw new ContentInputError(`liveUrl must be at most ${LIVE_URL_MAX} characters`, 'liveUrl');
  let ok = false;
  try { const u = new URL(text); ok = (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch { ok = false; }
  if (!ok) throw new ContentInputError('liveUrl must be an http or https URL', 'liveUrl');
  return text;
}

/** An ISO instant that is not more than the tolerance ahead of `now`. */
export function parsePastInstant(value: unknown, field: string, now: number): number {
  const ms = parseInstant(value, field);
  if (ms > now + FUTURE_TOLERANCE_MS) throw new ContentInputError(`${field} cannot be in the future`, field);
  return ms;
}

export interface SnapshotInput { capturedAt: number; counts: StatCounts; watchTime: number | null; note: string }

/** Validates a new snapshot body, or a patch merged over `base`. Every refusal names its field. */
export function parseSnapshot(body: Record<string, unknown>, ctx: { format: string; publishedAt: number; now: number; base?: SnapshotInput }): SnapshotInput {
  const { base } = ctx;
  const capturedAt = body.capturedAt === undefined && base ? base.capturedAt : parsePastInstant(body.capturedAt, 'capturedAt', ctx.now);
  // An untouched time on an edit is not re-checked: a republish moves the published time past older snapshots.
  const touched = body.capturedAt !== undefined || !base;
  if (touched && capturedAt < ctx.publishedAt) throw new ContentInputError('capturedAt cannot be before the post was published', 'capturedAt');
  const counts = parseCounts(body.counts, base?.counts);
  const watchTime = body.watchTime === undefined && base ? base.watchTime : parseWatchTime(body.watchTime, ctx.format);
  const note = body.note === undefined && base ? base.note : parseNote(body.note);
  requireAnyCount(counts);
  return { capturedAt, counts, watchTime, note };
}

/** Change since the previous snapshot, per field; `null` when either side is unknown, so unknown never reads as zero. */
export function statsDelta(latest: StatCounts, previous: StatCounts | null): StatCounts | null {
  if (!previous) return null;
  return Object.fromEntries(STAT_FIELDS.map((k) => [k, latest[k] === null || previous[k] === null ? null : latest[k]! - previous[k]!])) as StatCounts;
}

/** What "Most views" sorts on: views, or impressions where a platform (X) reports its views under that name. */
export const viewsOf = (counts: StatCounts): number | null => counts.views ?? counts.impressions;
