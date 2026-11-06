/**
 * The pure rules of per-platform targets: engagement, the views rule and a post's result against its platform's targets.
 * `web/src/lib/contentTargets.ts` duplicates this file; `contentTargetRules.test.ts` pins them together on one fixture.
 */
import type { Platform } from './rules.ts';

export const COUNT_TARGET_MAX = 1_000_000_000_000;
export const DAY_MS = 86_400_000;

export const TARGET_FIELDS = ['views', 'likes', 'comments', 'shares', 'saves', 'engagementRate', 'followersGained'] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];
export type Targets = Record<TargetField, number | null>;
export const emptyTargets = (): Targets => ({ views: null, likes: null, comments: null, shares: null, saves: null, engagementRate: null, followersGained: null });

export const RESULTS = ['on-target', 'partly', 'below-target', 'too-early', 'no-target'] as const;
export type OverallResult = (typeof RESULTS)[number];
export const isOverallResult = (value: unknown): value is OverallResult => typeof value === 'string' && (RESULTS as readonly string[]).includes(value);
export type FieldState = 'hit' | 'missed' | 'no-data';

/** The counts the rules read; a snapshot's full counts satisfy it. */
export interface RuleCounts {
  impressions: number | null; views: number | null; likes: number | null; comments: number | null;
  shares: number | null; saves: number | null; followersGained: number | null;
}

/** LinkedIn and X report impressions where the other platforms report views. */
export const viewsOfPlatform = (platform: Platform, counts: Pick<RuleCounts, 'impressions' | 'views'>): number | null =>
  platform === 'linkedin' || platform === 'x' ? counts.impressions : counts.views;

/** Likes + comments + shares + saves, leaving out empty values; null when all four are empty. */
export function engagementOf(counts: Pick<RuleCounts, 'likes' | 'comments' | 'shares' | 'saves'>): number | null {
  const known = [counts.likes, counts.comments, counts.shares, counts.saves].filter((n): n is number => n !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** Engagement / views x 100 to 2 decimals; null without views or without engagement (never 0 or infinite). */
export function engagementRateOf(platform: Platform, counts: RuleCounts): number | null {
  const views = viewsOfPlatform(platform, counts), engagement = engagementOf(counts);
  if (views === null || views === 0 || engagement === null) return null;
  return Math.round((engagement / views) * 10_000) / 100;
}

/** The value a target field is judged on. */
export function fieldValue(field: TargetField, platform: Platform, counts: RuleCounts): number | null {
  if (field === 'views') return viewsOfPlatform(platform, counts);
  if (field === 'engagementRate') return engagementRateOf(platform, counts);
  return counts[field];
}

export interface SnapshotLike { capturedAt: number; counts: RuleCounts }
export interface FieldResult { field: TargetField; state: FieldState; value: number | null; target: number }
export interface ResultProgress { day: number; of: number; judgedOn: string; counts: Targets }
export interface PostResult {
  overall: OverallResult;
  fields: FieldResult[];
  /** The snapshot the result was judged on; null when too early or there is no target. */
  judgedFrom: string | null;
  /** Too early only: how far the window has come, with the latest snapshot's values. */
  progress: ResultProgress | null;
}

export const setFields = (targets: Targets): TargetField[] => TARGET_FIELDS.filter((f) => targets[f] !== null);

const valuesOf = (platform: Platform, counts: RuleCounts): Targets =>
  Object.fromEntries(TARGET_FIELDS.map((f) => [f, fieldValue(f, platform, counts)])) as Targets;

function overallOf(fields: FieldResult[]): OverallResult {
  const hits = fields.filter((f) => f.state === 'hit').length;
  if (hits === fields.length) return 'on-target';
  return hits > 0 ? 'partly' : 'below-target';
}

/**
 * A published post against its platform's targets. `snapshots` are newest first (captured time, then entry time, then
 * insertion order); the first one captured at least `windowDays` after publishing is judged. No target outranks too early.
 */
export function evaluatePost(input: { platform: Platform; publishedAt: number; snapshots: SnapshotLike[]; targets: Targets; windowDays: number; now: number }): PostResult {
  const { platform, publishedAt, snapshots, targets, windowDays, now } = input;
  const set = setFields(targets);
  if (!set.length) return { overall: 'no-target', fields: [], judgedFrom: null, progress: null };
  const due = publishedAt + windowDays * DAY_MS;
  const judged = snapshots.find((s) => s.capturedAt >= due);
  if (!judged) {
    const latest = snapshots[0];
    const progress = latest
      ? { day: Math.min(windowDays, Math.max(0, Math.floor((now - publishedAt) / DAY_MS))), of: windowDays, judgedOn: new Date(due).toISOString(), counts: valuesOf(platform, latest.counts) }
      : null;
    return { overall: 'too-early', fields: [], judgedFrom: null, progress };
  }
  const fields = set.map((field): FieldResult => {
    const value = fieldValue(field, platform, judged.counts), target = targets[field]!;
    return { field, value, target, state: value === null ? 'no-data' : value >= target ? 'hit' : 'missed' };
  });
  return { overall: overallOf(fields), fields, judgedFrom: new Date(judged.capturedAt).toISOString(), progress: null };
}
