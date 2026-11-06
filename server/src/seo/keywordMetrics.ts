import { daysBetween } from './dates.ts';
import { avgPositionOf, ctrOf } from './metrics.ts';
import type { Sums } from './metrics.ts';
import { deltaOf } from './period.ts';
import type { Delta } from './period.ts';
import { sumVolumes } from './keywordRules.ts';
import type { Volume, VolumeSum } from './keywordRules.ts';

export const zeroSums = (): Sums => ({ clicks: 0, impressions: 0, positionImpressions: 0 });

/** Search counts stay below 2^53; a sum that would pass it stops there instead of losing digits. */
const saturate = (n: number) => Math.min(n, Number.MAX_SAFE_INTEGER);

export function addSums(into: Sums, from: Sums): Sums {
  into.clicks = saturate(into.clicks + from.clicks);
  into.impressions = saturate(into.impressions + from.impressions);
  into.positionImpressions += from.positionImpressions;
  return into;
}

export interface ShownMetrics { clicks: number; impressions: number; ctr: number | null; position: number | null }

/** What a row shows for a window. Zero impressions give no CTR and no position (a zero would claim the keyword ranked first). */
export function shownOf(sums: Sums): ShownMetrics {
  return { clicks: sums.clicks, impressions: sums.impressions, ctr: ctrOf(sums), position: avgPositionOf(sums) };
}

export interface KeywordStat {
  key: string;
  display: string;
  /** Totals for the range; zeros when the range is covered but the keyword had no rows. */
  current: Sums;
  previous: Sums;
  /** Normalised addresses of the pages that received impressions for the keyword in the range. */
  pages: string[];
  volume: Volume | null;
}

export interface BestKeyword { key: string; keyword: string; clicks: number }

export interface GroupStats {
  keywords: number;
  /** Null when the range has no Search Console data at all (never zero). */
  current: ShownMetrics | null;
  previous: ShownMetrics | null;
  /** Relative change in clicks against the previous period. */
  change: Delta | null;
  best: BestKeyword | null;
  pages: number;
  volume: VolumeSum | null;
}

export interface Availability { current: boolean; previous: boolean }

/** The member with the most clicks; ties go to more impressions, then alphabetical. A group with no impressions has no best. */
export function bestOf(members: KeywordStat[]): BestKeyword | null {
  const best = [...members].sort((a, b) => b.current.clicks - a.current.clicks || b.current.impressions - a.current.impressions || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];
  return best && best.current.impressions > 0 ? { key: best.key, keyword: best.display, clicks: best.current.clicks } : null;
}

/**
 * Combines keywords into one row. CTR is recomputed from the combined clicks and impressions (not averaged), position is
 * weighted by impressions, the page count is a union, and ignored keywords count like any other.
 */
export function groupStats(members: KeywordStat[], available: Availability): GroupStats {
  const current = zeroSums();
  const previous = zeroSums();
  const pages = new Set<string>();
  for (const m of members) {
    addSums(current, m.current);
    addSums(previous, m.previous);
    for (const p of m.pages) pages.add(p);
  }
  const shownCurrent = available.current ? shownOf(current) : null;
  const shownPrevious = available.previous ? shownOf(previous) : null;
  return {
    keywords: members.length,
    current: shownCurrent,
    previous: shownPrevious,
    change: shownCurrent && shownPrevious ? deltaOf(shownCurrent.clicks, shownPrevious.clicks) : null,
    best: available.current ? bestOf(members) : null,
    pages: pages.size,
    volume: sumVolumes(members.map((m) => m.volume)),
  };
}

export interface TrendPoint { day: string; period: 'current' | 'previous'; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null }

/** One point per day. A day that was never fetched is null throughout, which is different from a fetched day with no rows (zero clicks). */
export function trendOf(span: { from: string; to: string }, currentFrom: string, fetched: ReadonlySet<string>, perDay: ReadonlyMap<string, Sums>): TrendPoint[] {
  return daysBetween(span.from, span.to).map((day): TrendPoint => {
    const period = day >= currentFrom ? 'current' : 'previous';
    if (!fetched.has(day)) return { day, period, clicks: null, impressions: null, ctr: null, position: null };
    const sums = perDay.get(day) ?? zeroSums();
    return { day, period, ...shownOf(sums) };
  });
}

/** Lines the previous period's points up under the current ones by day offset (the first previous day under the first current day). */
export function alignPrevious(points: TrendPoint[]): Array<{ offset: number; current: TrendPoint | null; previous: TrendPoint | null }> {
  const current = points.filter((p) => p.period === 'current');
  const previous = points.filter((p) => p.period === 'previous');
  return Array.from({ length: Math.max(current.length, previous.length) }, (_, offset) => ({ offset, current: current[offset] ?? null, previous: previous[offset] ?? null }));
}
