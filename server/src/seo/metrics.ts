import { SeoInputError } from './errors.ts';

export interface Sums { clicks: number; impressions: number; positionImpressions: number }

/** Adds search-metric sums; the sums are what the roll-ups store, so a merge is plain addition. */
export function mergeSums(a: Sums, b: Sums): Sums {
  return { clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions, positionImpressions: a.positionImpressions + b.positionImpressions };
}

/** Click-through rate, or null when there were no impressions (a zero would claim the page was shown and never clicked). */
export function ctrOf(s: Pick<Sums, 'clicks' | 'impressions'>): number | null {
  return s.impressions > 0 ? s.clicks / s.impressions : null;
}

/** Average position weighted by impressions, or null when there were none. */
export function avgPositionOf(s: Pick<Sums, 'impressions' | 'positionImpressions'>): number | null {
  return s.impressions > 0 ? s.positionImpressions / s.impressions : null;
}

export interface GscMetricRow { page: string; query: string; clicks: number; impressions: number; ctr: number; position: number }

/** Rejects a row Google could not have sent, so one bad value fails the day instead of poisoning the totals. */
export function assertValidGscRow(row: GscMetricRow): void {
  const whole = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!whole(row.clicks) || !whole(row.impressions)) throw new SeoInputError('clicks and impressions must be whole numbers from 0 to 2^53-1');
  if (typeof row.ctr !== 'number' || !(row.ctr >= 0 && row.ctr <= 1)) throw new SeoInputError('ctr must be between 0 and 1');
  if (typeof row.position !== 'number' || !Number.isFinite(row.position) || row.position < 0) throw new SeoInputError('position must be zero or more');
  if (typeof row.page !== 'string' || typeof row.query !== 'string') throw new SeoInputError('page and query must be text');
}

/** How the Ads Keyword Planner reported a search volume. */
export type AdsVolume = { kind: 'exact'; value: number } | { kind: 'range'; low: number; high: number } | { kind: 'unknown' };

/** Accounts with little spend get volumes rounded to a power of ten (10, 100, 1000, ...), which really means "this much up to ten times more". */
const BUCKETS = new Set([0, 10, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000]);

export function parseAdsVolume(value: unknown): AdsVolume {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { kind: 'unknown' };
  if (BUCKETS.has(value) && value > 0) return { kind: 'range', low: value, high: value * 10 };
  return { kind: 'exact', value };
}

/** A whole keyword set counts as a range as soon as any volume is bucketed; no volumes means unknown. */
export function classifyAdsVolumes(values: unknown[]): 'exact' | 'range' | 'unknown' {
  const parsed = values.map(parseAdsVolume).filter((v) => v.kind !== 'unknown');
  if (!parsed.length) return 'unknown';
  return parsed.some((v) => v.kind === 'range') ? 'range' : 'exact';
}
