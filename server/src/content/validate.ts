import { ContentInputError } from './errors.ts';
import { BRIEF_MAX, DEFAULT_TIMEZONE, LIST_DEFAULT, LIST_LIMIT_MAX, NAME_MAX, TITLE_MAX } from './limits.ts';
import { isFormatOf, isPlatform } from './rules.ts';
import type { Platform } from './rules.ts';

/** Characters, not UTF-16 units, so 80 emoji count as 80. */
export const charCount = (s: string): number => [...s].length;

export function parseName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ContentInputError('name is required', 'name');
  const name = value.trim();
  if (charCount(name) > NAME_MAX) throw new ContentInputError(`name must be at most ${NAME_MAX} characters`, 'name');
  return name;
}

export function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ContentInputError('title is required', 'title');
  const title = value.trim();
  if (charCount(title) > TITLE_MAX) throw new ContentInputError(`title must be at most ${TITLE_MAX} characters`, 'title');
  return title;
}

/** Omitted and empty are the same: no brief. */
export function parseBrief(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ContentInputError('brief must be text', 'brief');
  if (charCount(value) > BRIEF_MAX) throw new ContentInputError(`brief must be at most ${BRIEF_MAX} characters`, 'brief');
  return value;
}

const ZONE_SHAPE = /^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)*$/;
/** An IANA zone name the runtime knows, spelled with its capitals (`europe/berlin`, `UTC+2` and offsets are refused). */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !ZONE_SHAPE.test(value) || (value !== DEFAULT_TIMEZONE && !value.includes('/'))) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

export function parseTimezone(value: unknown): string {
  if (!isValidTimezone(value)) throw new ContentInputError('timezone must be an IANA time zone name such as Europe/Berlin', 'timezone');
  return value;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** An ISO instant with `Z` or an offset; local time without an offset and date-only text are refused. */
export function parseInstant(value: unknown, field = 'scheduledAt'): number {
  const ms = typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new ContentInputError(`${field} must be an ISO date and time with Z or an offset`, field);
  return ms;
}

export function parsePostShape(platform: unknown, format: unknown): { platform: Platform; format: string } {
  if (!isPlatform(platform)) throw new ContentInputError('platform must be linkedin, instagram, x, facebook or blog', 'platform');
  if (!isFormatOf(platform, format)) throw new ContentInputError(`format is not available on ${platform}`, 'format');
  return { platform, format: format as string };
}

/** Missing means the default page; above the maximum is clamped; zero, negative, fractional or non-numeric is refused. */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return LIST_DEFAULT;
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ContentInputError('limit must be a positive whole number', 'limit');
  return Math.min(n, LIST_LIMIT_MAX);
}

export function parseOffset(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) throw new ContentInputError('offset must be a whole number from 0', 'offset');
  return n;
}

export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
