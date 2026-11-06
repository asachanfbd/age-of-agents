import { SeoInputError } from './errors.ts';
import { parseAdsVolume } from './metrics.ts';
import { normalizePageUrl } from './urls.ts';

/** Longest keyword or cluster name kept; longer text is refused (a Search Console query that long is skipped and counted). */
export const MAX_KEYWORD_LENGTH = 500;
/** Two or more pages that each have at least this many impressions for one keyword in the range are competing for it. */
export const CANNIBALISATION_MIN_IMPRESSIONS = 5;
export const CANNIBALISATION_MIN_PAGES = 2;
/** Keywords one clustering run sends to the agent, highest impressions first; the rest wait for the next run. */
export const CLUSTER_RUN_CAP = 500;
/** Keywords per agent request. */
export const CLUSTER_BATCH_SIZE = 100;
/** Keywords that one bulk move, split or accept may name. */
export const MAX_BULK_KEYS = 500;
/** Competitor domains one research run may be given. */
export const MAX_COMPETITORS = 10;
/** Volumes above this are not believable for one keyword and are treated as unknown. */
export const MAX_VOLUME = 1_000_000_000;

export const KEYWORD_STATUSES = ['tracking', 'target', 'ignored'] as const;
export type KeywordStatus = (typeof KEYWORD_STATUSES)[number];
export type KeywordSource = 'gsc' | 'manual' | 'import' | 'research';

/**
 * The one spelling of a keyword, so variants count as one: Unicode compatibility form (full-width letters become plain
 * ones), lower case, accents removed, every run of whitespace (tabs, newlines, no-break spaces) collapsed to one space,
 * ends trimmed. Punctuation is kept, so `c++` and `c` stay different. Returns null for anything that is not text, is
 * empty after trimming, or is longer than the limit.
 */
export function normalizeKeyword(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_KEYWORD_LENGTH * 4) return null;
  const key = input.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim();
  return key && key.length <= MAX_KEYWORD_LENGTH ? key : null;
}

export function requireKeyword(input: unknown): string {
  const key = normalizeKeyword(input);
  if (!key) throw new SeoInputError(`a keyword must be text of 1 to ${MAX_KEYWORD_LENGTH} characters`);
  return key;
}

/** The text shown for a keyword: what was first typed or seen, with whitespace tidied. */
export const displayOf = (input: string): string => input.replace(/\s+/gu, ' ').trim();

export function requireName(input: unknown, what = 'name'): string {
  const name = typeof input === 'string' ? displayOf(input) : '';
  if (!name || name.length > MAX_KEYWORD_LENGTH) throw new SeoInputError(`${what} must be text of 1 to ${MAX_KEYWORD_LENGTH} characters`);
  return name;
}

/** Cluster names are compared without regard to case, accents or spacing. */
export const nameKeyOf = (name: string): string => normalizeKeyword(name) ?? name.toLowerCase();

export const isStatus = (value: unknown): value is KeywordStatus => typeof value === 'string' && (KEYWORD_STATUSES as readonly string[]).includes(value);

export function requireStatus(value: unknown): KeywordStatus {
  if (!isStatus(value)) throw new SeoInputError(`status must be one of ${KEYWORD_STATUSES.join(', ')}`);
  return value;
}

/** Accepts the spellings a spreadsheet produces (`Tracking`, `TARGET`); anything else is null. */
export function statusFromText(value: unknown): KeywordStatus | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isStatus(text) ? text : null;
}

/** A stored or reported volume: exact (low = high) or a range with the day it was fetched. */
export interface Volume { kind: 'exact' | 'range'; low: number; high: number; fetchedAt: string }

/** Reads an Ads number into a volume; null when Ads gave nothing believable. */
export function volumeFrom(value: unknown, fetchedAt: string): Volume | null {
  if (typeof value === 'number' && value > MAX_VOLUME) return null;
  const parsed = parseAdsVolume(value);
  if (parsed.kind === 'exact') return { kind: 'exact', low: parsed.value, high: parsed.value, fetchedAt };
  if (parsed.kind === 'range') return { kind: 'range', low: parsed.low, high: parsed.high, fetchedAt };
  return null;
}

export interface VolumeSum {
  low: number;
  high: number;
  /** True when every counted volume was exact, so low equals high. */
  exact: boolean;
  /** Keywords with no volume; the sum covers only the others. */
  missing: number;
}

/** Sums volumes: exact ones add up exactly, and any range makes the sum a range. Null when no keyword has a volume. */
export function sumVolumes(volumes: Array<Pick<Volume, 'kind' | 'low' | 'high'> | null | undefined>): VolumeSum | null {
  let low = 0;
  let high = 0;
  let exact = true;
  let known = 0;
  for (const v of volumes) {
    if (!v) continue;
    known++;
    low += v.low;
    high += v.high;
    if (v.kind === 'range') exact = false;
  }
  return known ? { low, high, exact, missing: volumes.length - known } : null;
}

/** Adds page impressions per normalised address, so `/a/` and `/a?utm_source=x` count as one page. Rows with an unusable address are dropped. */
export function impressionsByPage(rows: Array<{ page: string; impressions: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const url = normalizePageUrl(r.page);
    if (url) out.set(url, (out.get(url) ?? 0) + r.impressions);
  }
  return out;
}

/** A keyword is cannibalised when at least two pages each have the minimum impressions for it. */
export function isCannibalised(pageImpressions: Iterable<number>): boolean {
  let pages = 0;
  for (const impressions of pageImpressions) if (impressions >= CANNIBALISATION_MIN_IMPRESSIONS) pages++;
  return pages >= CANNIBALISATION_MIN_PAGES;
}

export const cannibalisationRule = (): string =>
  `Two or more pages each received at least ${CANNIBALISATION_MIN_IMPRESSIONS} impressions for this keyword in the range.`;
