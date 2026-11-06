import type { AssetRow } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { ContentInputError } from './errors.ts';
import { REFERENCE_LIMIT_DEFAULT, REFERENCE_LIMIT_MAX } from './limits.ts';
import { isPlatform } from './rules.ts';
import type { Platform } from './rules.ts';
import { postResults } from './results.ts';
import type { PostResultView } from './results.ts';
import { countsOf, statRowsByPost } from './statStore.ts';
import type { StatCounts } from './stats.ts';
import { isOverallResult } from './targetRules.ts';
import type { OverallResult } from './targetRules.ts';
import { charCount } from './validate.ts';

export const PERFORMANCE_LIMIT_DEFAULT = 20;
export const PERFORMANCE_LIMIT_MAX = 100;
/** Posts in the insights data file. */
export const INSIGHTS_POSTS_MAX = 200;
/** Text and script excerpts are cut to this many characters (code points). */
export const EXCERPT_MAX = 1_000;
export const HOOK_LINES = 3;

export interface PerformanceItem {
  postId: string; conceptId: string; conceptTitle: string; conceptBrief: string;
  platform: Platform; format: string;
  publishedAt: string;
  /** In the Building's time zone. */
  publishedWeekday: string; publishedHour: number;
  text: string | null; textLength: number | null;
  /** The finalized script's first lines, and its start. */
  hook: string | null; scriptExcerpt: string | null;
  videoSeconds: number | null; imageCount: number | null;
  /** Null only for an imported post without snapshots, which only the insights data holds. */
  stats: { capturedAt: string; counts: StatCounts; engagementRate: number | null } | null;
  results: PostResultView;
  /** The post belongs to a Concept made outside the system. */
  imported: boolean;
}

const ALL_FORMATS = ['text', 'image', 'carousel', 'video', 'reel', 'article'];

export interface PostFilter { platform?: Platform; format?: string; limit: number }
export interface PerformanceQuery extends PostFilter { result?: OverallResult }

/** A session tool's closed platform and format values, and a limit that is refused, not clamped, over `max`. */
function parsePostFilter({ platform, format, limit }: Record<string, unknown>, fallback: number, max: number): PostFilter {
  if (platform !== undefined && !isPlatform(platform)) throw new ContentInputError('platform must be linkedin, instagram, x, facebook or blog', 'platform');
  if (format !== undefined && !(typeof format === 'string' && ALL_FORMATS.includes(format))) {
    throw new ContentInputError('format must be text, image, carousel, video, reel or article', 'format');
  }
  let n = fallback;
  if (limit !== undefined) {
    n = typeof limit === 'number' ? limit : typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > max) throw new ContentInputError(`limit must be a whole number from 1 to ${max}`, 'limit');
  }
  return { platform: platform as Platform | undefined, format: format as string | undefined, limit: n };
}

/** The `get_performance` arguments. */
export function parsePerformanceQuery(query: Record<string, unknown>): PerformanceQuery {
  const { result } = query;
  if (result !== undefined && !isOverallResult(result)) throw new ContentInputError('result must be on-target, partly, below-target, too-early or no-target', 'result');
  return { ...parsePostFilter(query, PERFORMANCE_LIMIT_DEFAULT, PERFORMANCE_LIMIT_MAX), result: result as OverallResult | undefined };
}

/** The `get_reference_content` arguments. */
export const parseReferenceQuery = (query: Record<string, unknown>): PostFilter => parsePostFilter(query, REFERENCE_LIMIT_DEFAULT, REFERENCE_LIMIT_MAX);

const cut = (text: string, max = EXCERPT_MAX): string => [...text].slice(0, max).join('');
const firstLines = (text: string): string => text.split(/\r?\n/).slice(0, HOOK_LINES).join('\n');

function weekdayAndHour(ms: number, timeZone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return { weekday: parts.find((p) => p.type === 'weekday')!.value, hour: Number(parts.find((p) => p.type === 'hour')!.value) };
}

function imageCountOf(asset: AssetRow | undefined): number | null {
  if (asset?.state !== 'finalized' || !asset.content) return null;
  try { const list = JSON.parse(asset.content) as unknown; return Array.isArray(list) ? list.length : null; } catch { return null; }
}

interface Candidate { id: string; conceptId: string; platform: Platform; format: string; publishedAt: number; title: string; brief: string; imported: number }

/**
 * Published posts that have at least one snapshot, newest published first, as the insights agent and `get_performance` see them.
 * The insights data (`statslessImported`) also takes imported posts without snapshots, whose text still shows what was written.
 * The result filter runs before the limit.
 */
export function performanceItems(ctx: ContentCtx, query: PerformanceQuery, { statslessImported = false } = {}): PerformanceItem[] {
  const hasStats = 'EXISTS (SELECT 1 FROM post_stats s WHERE s.postId = p.id)';
  const where = ["p.status = 'published'", 'p.publishedAt IS NOT NULL', statslessImported ? `(${hasStats} OR c.imported = 1)` : hasStats];
  const params: string[] = [];
  if (query.platform) { where.push('p.platform = ?'); params.push(query.platform); }
  if (query.format) { where.push('p.format = ?'); params.push(query.format); }
  const candidates = ctx.db.prepare(
    `SELECT p.id, p.conceptId, p.platform, p.format, p.publishedAt, c.title, c.brief, c.imported FROM posts p JOIN concepts c ON c.id = p.conceptId WHERE ${where.join(' AND ')} ORDER BY p.publishedAt DESC, p.createdAt DESC, p.id`,
  ).all(...params) as Candidate[];
  const rows = statRowsByPost(ctx, candidates.map((p) => p.id));
  const results = postResults(ctx, candidates, rows);
  const kept = candidates.filter((p) => !query.result || results.get(p.id)!.overall === query.result).slice(0, query.limit);
  const zone = ctx.timezone();
  return kept.map((p) => {
    const assets = ctx.db.prepare('SELECT * FROM assets WHERE conceptId = ?').all(p.conceptId) as AssetRow[];
    const finalized = (a: AssetRow | undefined): string | null => (a?.state === 'finalized' ? a.content : null);
    const text = finalized(assets.find((a) => a.postId === p.id && (a.kind === 'post-text' || a.kind === 'article')));
    const script = finalized(assets.find((a) => a.kind === 'script' && a.postId === null));
    const video = assets.find((a) => a.kind === 'video' && a.postId === null);
    const render = video ? ctx.db.prepare("SELECT durationMs FROM video_renders WHERE assetId = ? AND status = 'done' AND durationMs IS NOT NULL ORDER BY createdAt DESC LIMIT 1").get(video.id) as { durationMs: number } | undefined : undefined;
    const latest = rows.get(p.id)?.[0];
    const result = results.get(p.id)!;
    const when = weekdayAndHour(p.publishedAt, zone);
    return {
      postId: p.id, conceptId: p.conceptId, conceptTitle: p.title, conceptBrief: p.brief, platform: p.platform, format: p.format,
      publishedAt: new Date(p.publishedAt).toISOString(), publishedWeekday: when.weekday, publishedHour: when.hour,
      text: text === null ? null : cut(text), textLength: text === null ? null : charCount(text),
      hook: script === null ? null : firstLines(script), scriptExcerpt: script === null ? null : cut(script),
      videoSeconds: render && (p.format === 'video' || p.format === 'reel') ? Math.round(render.durationMs / 100) / 10 : null,
      imageCount: imageCountOf(assets.find((a) => a.postId === p.id && a.kind === 'image-set')),
      stats: latest ? { capturedAt: new Date(latest.capturedAt).toISOString(), counts: countsOf(latest), engagementRate: result.engagementRate } : null,
      results: result,
      imported: p.imported === 1,
    };
  });
}
