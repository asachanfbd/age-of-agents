import type { ContentCtx } from './context.ts';
import { countsOf, statRowsByPost } from './statStore.ts';
import type { StatRow } from './statStore.ts';
import { engagementRateOf, evaluatePost } from './targetRules.ts';
import type { PostResult } from './targetRules.ts';
import type { Platform } from './rules.ts';
import { evaluationDays, readAllTargets } from './targets.ts';

/** A published post's result plus the engagement rate of its latest snapshot (null without views or snapshots). */
export interface PostResultView extends PostResult { engagementRate: number | null }

export interface ResultPost { id: string; platform: Platform; publishedAt: number | null }

/** Results of the published posts among `posts`, computed from the current targets and window (nothing is stored). */
export function postResults(ctx: ContentCtx, posts: ResultPost[], byPost?: Map<string, StatRow[]>): Map<string, PostResultView> {
  const published = posts.filter((p): p is ResultPost & { publishedAt: number } => p.publishedAt !== null);
  const rows = byPost ?? statRowsByPost(ctx, published.map((p) => p.id));
  const targets = readAllTargets(ctx), windowDays = evaluationDays(ctx), now = ctx.now();
  const out = new Map<string, PostResultView>();
  for (const post of published) {
    const snapshots = (rows.get(post.id) ?? []).map((r) => ({ capturedAt: r.capturedAt, counts: countsOf(r) }));
    const result = evaluatePost({ platform: post.platform, publishedAt: post.publishedAt, snapshots, targets: targets[post.platform], windowDays, now });
    out.set(post.id, { ...result, engagementRate: snapshots[0] ? engagementRateOf(post.platform, snapshots[0].counts) : null });
  }
  return out;
}
