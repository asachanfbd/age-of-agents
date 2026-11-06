import type { AssetRow } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { REFERENCE_EXCERPT_MAX, REFERENCE_LIST_MAX } from './limits.ts';
import type { PostFilter } from './performance.ts';
import { postResults } from './results.ts';
import type { PostResultView } from './results.ts';
import { PLATFORM_LABELS } from './rules.ts';
import type { Platform } from './rules.ts';
import { countsOf, statRowsByPost } from './statStore.ts';
import type { StatCounts } from './stats.ts';
import { STUDIO_TOOLS } from './studioTabs.ts';

export interface ReferencePost {
  postId: string; platform: Platform; format: string; text: string | null; liveUrl: string | null; publishedAt: string; externalAssets: string | null;
  stats: { capturedAt: string; counts: StatCounts; engagementRate: number | null } | null;
  results: PostResultView;
}
export interface ReferenceConcept { conceptId: string; title: string; brief: string; script: string | null; posts: ReferencePost[] }

interface Row { id: string; conceptId: string; platform: Platform; format: string; publishedAt: number; liveUrl: string | null; externalAssets: string | null; title: string; brief: string }
interface Group { conceptId: string; title: string; brief: string; posts: Row[] }

/** Imported Concepts with a matching published post, the newest published first; archived ones stay useful as examples. */
function matchingConcepts(ctx: ContentCtx, matches: (row: Row) => boolean, limit: number): Group[] {
  const rows = ctx.db.prepare(`SELECT p.id, p.conceptId, p.platform, p.format, p.publishedAt, p.liveUrl, p.externalAssets, c.title, c.brief FROM posts p JOIN concepts c ON c.id = p.conceptId
    WHERE c.imported = 1 AND p.status = 'published' AND p.publishedAt IS NOT NULL ORDER BY p.publishedAt DESC, p.createdAt DESC, p.id`).all() as Row[];
  const groups = new Map<string, Group>();
  for (const row of rows.filter(matches)) {
    const group = groups.get(row.conceptId) ?? { conceptId: row.conceptId, title: row.title, brief: row.brief, posts: [] };
    group.posts.push(row);
    groups.set(row.conceptId, group);
  }
  return [...groups.values()].slice(0, limit);
}

const textsOf = (ctx: ContentCtx, conceptId: string): AssetRow[] =>
  ctx.db.prepare("SELECT * FROM assets WHERE conceptId = ? AND kind IN ('script', 'post-text', 'article') AND state = 'finalized'").all(conceptId) as AssetRow[];
const scriptOf = (assets: AssetRow[]): string | null => assets.find((a) => a.kind === 'script')?.content ?? null;
const postText = (assets: AssetRow[], postId: string): string | null => assets.find((a) => a.postId === postId)?.content ?? null;

/** The `get_reference_content` answer: with a filter, each Concept lists only its matching posts. */
export function referenceItems(ctx: ContentCtx, filter: PostFilter): ReferenceConcept[] {
  const matches = (r: Row) => (!filter.platform || r.platform === filter.platform) && (!filter.format || r.format === filter.format);
  const groups = matchingConcepts(ctx, matches, filter.limit);
  const posts = groups.flatMap((g) => g.posts);
  const stats = statRowsByPost(ctx, posts.map((p) => p.id));
  const results = postResults(ctx, posts, stats);
  return groups.map((g) => {
    const assets = textsOf(ctx, g.conceptId);
    return {
      conceptId: g.conceptId, title: g.title, brief: g.brief, script: scriptOf(assets),
      posts: g.posts.map((p) => {
        const latest = stats.get(p.id)?.[0], result = results.get(p.id)!;
        return {
          postId: p.id, platform: p.platform, format: p.format, text: postText(assets, p.id), liveUrl: p.liveUrl, publishedAt: new Date(p.publishedAt).toISOString(), externalAssets: p.externalAssets,
          stats: latest ? { capturedAt: new Date(latest.capturedAt).toISOString(), counts: countsOf(latest), engagementRate: result.engagementRate } : null,
          results: result,
        };
      }),
    };
  });
}

const excerpt = (text: string): string => [...text].slice(0, REFERENCE_EXCERPT_MAX).join('').replace(/\s+/g, ' ').trim();

function line(ctx: ContentCtx, group: Group): string {
  const assets = textsOf(ctx, group.conceptId);
  const text = group.posts.map((p) => postText(assets, p.id)).find((t) => t !== null) ?? scriptOf(assets);
  const kinds = group.posts.map((p) => `${PLATFORM_LABELS[p.platform]} ${p.format}`).join(', ');
  const date = new Date(group.posts[0]!.publishedAt).toISOString().slice(0, 10);
  return `- ${group.title} (${kinds}, published ${date})${text ? `: ${excerpt(text)}` : ''}`;
}

/** The "Reference content" section of every session's instructions. An empty platform list (a Concept without posts) matches every platform. */
export function referenceSection(ctx: ContentCtx, platforms: readonly Platform[]): string {
  const groups = matchingConcepts(ctx, (r) => !platforms.length || platforms.includes(r.platform), REFERENCE_LIST_MAX);
  const list = groups.length ? groups.map((g) => line(ctx, g)).join('\n') : '(none yet)';
  return `## Reference content\n\nConcepts flagged imported are the owner's earlier work from outside this system. Read them for voice, structure, hooks and length before you write, and never copy them. The \`${STUDIO_TOOLS.getReferenceContent}\` tool returns their full text, stats and results.\n\nNewest imported Concepts for this work:\n${list}`;
}
