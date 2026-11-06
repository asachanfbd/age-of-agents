import { SeoInputError } from '../errors.ts';

/** User agent sent to the site and matched against robots.txt groups. */
export const CRAWL_USER_AGENT = 'agent-visual-os-seo';

export interface CrawlSettings {
  pageCap: number;
  requestsPerSecond: number;
  timeoutSeconds: number;
  pageSizeMb: number;
}

export const DEFAULT_CRAWL_SETTINGS: CrawlSettings = { pageCap: 3000, requestsPerSecond: 2, timeoutSeconds: 15, pageSizeMb: 2 };

interface Range { min: number; max: number; label: string; whole: boolean }
export const SETTING_RANGES: Record<keyof CrawlSettings, Range> = {
  pageCap: { min: 1, max: 10_000, label: 'Page cap', whole: true },
  requestsPerSecond: { min: 0.1, max: 10, label: 'Requests per second', whole: false },
  timeoutSeconds: { min: 1, max: 60, label: 'Timeout (seconds)', whole: true },
  pageSizeMb: { min: 0.1, max: 10, label: 'Page size limit (MB)', whole: false },
};

/** Fixed crawl rules (not user-configurable). */
export const MAX_REDIRECT_HOPS = 10;
export const MAX_RETRIES = 3;
export const MAX_WAIT_MS = 60_000;
export const MAX_CRAWL_DELAY_MS = 10_000;
export const MAX_ANCHOR = 200;
export const MAX_TITLE = 300;
export const MAX_DESCRIPTION = 500;
export const MAX_LINKS_PER_PAGE = 500;
/** Per-page link lists kept in a snapshot, in crawl order; later pages lose their lists so a snapshot stays near 12 MB. */
export const MAX_STORED_LINKS = 100_000;
/** A crawl is flagged when more than this share of requested addresses gave no links or redirected to themselves. */
export const WARNING_SHARE = 0.5;
/** HTML pages need at least this many internal links on average, or the crawl is flagged as possibly incomplete. */
export const INCOMPLETE_AVG_LINKS = 1;
export const INCOMPLETE_MIN_PAGES = 3;
/** Highlight defaults (screen-side) are documented in docs/seo-building.md. */
export const DEEP_PAGE_CLICKS = 3;
export const FEW_INBOUND = 2;

function checkSetting(key: keyof CrawlSettings, value: unknown): number {
  const r = SETTING_RANGES[key];
  const n = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n < r.min || n > r.max || (r.whole && !Number.isInteger(n))) {
    throw new SeoInputError(`${r.label} must be ${r.whole ? 'a whole number' : 'a number'} from ${r.min} to ${r.max}`);
  }
  return n;
}

/** Applies a partial change on top of the current settings; every given value must be inside its range. */
export function mergeSettings(current: CrawlSettings, patch: unknown): CrawlSettings {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new SeoInputError('Crawl settings must be an object');
  const next = { ...current };
  for (const key of Object.keys(SETTING_RANGES) as Array<keyof CrawlSettings>) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) next[key] = checkSetting(key, value);
  }
  return next;
}

/** Milliseconds between the starts of two requests. */
export const paceMs = (requestsPerSecond: number): number => {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) throw new SeoInputError('Requests per second must be above 0');
  return Math.round(1000 / requestsPerSecond);
};

/** How long to wait before retry number `attempt` (0-based): `Retry-After` when given, else exponential; never above the maximum wait. */
export function backoffMs(attempt: number, retryAfter: string | null, now: Date): number {
  let wait = Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
  if (retryAfter) {
    const delay = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now.getTime();
    if (Number.isFinite(delay) && delay >= 0) wait = delay;
  }
  return Math.min(wait, MAX_WAIT_MS);
}

/** Beyond this many different query strings on one path the rest are treated as an endless URL space (calendars, filters). */
export const MAX_QUERY_VARIANTS_PER_PATH = 20;
const MAX_QUERY_PARAMS = 3;
const MAX_PATH_DEPTH = 10;
const MAX_SEGMENT_REPEATS = 2;

/** Whether an address looks like part of an endless URL space; `variants` counts the query strings already seen per path. */
export function isUrlSpaceTrap(url: string, variants: Map<string, number>): boolean {
  const { pathname, searchParams } = new URL(url);
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > MAX_PATH_DEPTH) return true;
  const counts = new Map<string, number>();
  for (const s of segments) counts.set(s, (counts.get(s) ?? 0) + 1);
  if ([...counts.values()].some((c) => c > MAX_SEGMENT_REPEATS)) return true;
  if ([...searchParams.keys()].length > MAX_QUERY_PARAMS) return true;
  if ([...searchParams.keys()].length === 0) return false;
  const seen = (variants.get(pathname) ?? 0) + 1;
  variants.set(pathname, seen);
  return seen > MAX_QUERY_VARIANTS_PER_PATH;
}
