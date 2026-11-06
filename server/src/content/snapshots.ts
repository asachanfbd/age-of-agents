import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentNotFoundError } from './errors.ts';
import { postDir, postRow, touch } from './concepts.ts';
import type { PostRow } from './concepts.ts';
import { claimExtraction, discardExtraction, runExtraction, stageExtraction, sweepExtractions } from './extractions.ts';
import type { ExtractionDeps, ExtractionInput } from './extractions.ts';
import { statRow, statRows, statView, countsOf, sourcesOf } from './statStore.ts';
import type { StatRow, StatView } from './statStore.ts';
import { parseSnapshot } from './stats.ts';
import type { StatCounts, SnapshotInput } from './stats.ts';
import type { ExtractionAnswer } from './statsAgent.ts';

const statDir = (ctx: ContentCtx, post: PostRow, statId: string): string => path.join(postDir(ctx, post.conceptId, post.id), 'stats', statId);

export function publishedPost(ctx: ContentCtx, conceptId: string, postId: string): PostRow {
  const post = postRow(ctx, conceptId, postId);
  if (post.status !== 'published') throw new ContentConflictError(`Stats can only be added to a published post, and this one is ${post.status}`);
  return post;
}

export function listStats(ctx: ContentCtx, conceptId: string, postId: string): { snapshots: StatView[] } {
  postRow(ctx, conceptId, postId);
  return { snapshots: statRows(ctx, postId).map(statView) };
}

export async function createStat(ctx: ContentCtx, conceptId: string, postId: string, body: Record<string, unknown>): Promise<StatView> {
  const post = publishedPost(ctx, conceptId, postId);
  const input = parseSnapshot(body, { format: post.format, publishedAt: post.publishedAt!, now: ctx.now() });
  const id = randomUUID();
  await sweepExtractions(ctx);
  const sources = body.extractionId === undefined || body.extractionId === null ? [] : await claimExtraction(ctx, postId, body.extractionId, statDir(ctx, post, id));
  try {
    ctx.db.prepare('INSERT INTO post_stats (id, postId, capturedAt, enteredAt, counts, watchTime, note, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, postId, input.capturedAt, ctx.now(), JSON.stringify(input.counts), input.watchTime, input.note, JSON.stringify(sources));
  } catch (e) {
    await rm(statDir(ctx, post, id), { recursive: true, force: true });
    throw e;
  }
  touch(ctx, conceptId);
  return statView(statRow(ctx, postId, id)!);
}

function rowOf(ctx: ContentCtx, postId: string, statId: string): StatRow {
  const row = statRow(ctx, postId, statId);
  if (!row) throw new ContentNotFoundError('That stats snapshot does not exist');
  return row;
}

/** A patch is validated like a new snapshot after merging over the stored one; `null` clears a count or the watch time. */
export function patchStat(ctx: ContentCtx, conceptId: string, postId: string, statId: string, body: Record<string, unknown>): StatView {
  const post = publishedPost(ctx, conceptId, postId);
  const row = rowOf(ctx, postId, statId);
  const base: SnapshotInput = { capturedAt: row.capturedAt, counts: countsOf(row) as StatCounts, watchTime: row.watchTime, note: row.note };
  const next = parseSnapshot(body, { format: post.format, publishedAt: post.publishedAt!, now: ctx.now(), base });
  ctx.db.prepare('UPDATE post_stats SET capturedAt = ?, counts = ?, watchTime = ?, note = ? WHERE id = ?').run(next.capturedAt, JSON.stringify(next.counts), next.watchTime, next.note, statId);
  touch(ctx, conceptId);
  return statView(rowOf(ctx, postId, statId));
}

export async function deleteStat(ctx: ContentCtx, conceptId: string, postId: string, statId: string): Promise<void> {
  const post = publishedPost(ctx, conceptId, postId);
  rowOf(ctx, postId, statId);
  ctx.db.prepare('DELETE FROM post_stats WHERE id = ?').run(statId);
  touch(ctx, conceptId);
  await rm(statDir(ctx, post, statId), { recursive: true, force: true });
}

/** A kept screenshot or the pasted text. The stored name is never used from a request: the source is found by its id. */
export async function statSource(ctx: ContentCtx, conceptId: string, postId: string, statId: string, sourceId: string): Promise<{ name: string; contentType: string; bytes: Buffer }> {
  const post = postRow(ctx, conceptId, postId);
  const source = sourcesOf(rowOf(ctx, postId, statId)).find((s) => s.id === sourceId);
  if (!source) throw new ContentNotFoundError('That source does not exist');
  return { name: source.name, contentType: source.contentType, bytes: await readFile(path.join(statDir(ctx, post, statId), source.file)) };
}

export type ExtractionReply = ({ ok: true; extractionId: string } & ExtractionAnswer) | { ok: false; reason: string };

/**
 * Reads pasted text and screenshots with the agent. Only the staging and the final check run in the Building's write
 * queue; the agent itself runs outside it (it can take two minutes), so a post that was unpublished or deleted in
 * the meantime discards the result.
 */
export async function extractStats(ctx: ContentCtx, deps: ExtractionDeps, conceptId: string, postId: string, input: ExtractionInput): Promise<ExtractionReply> {
  const staged = await ctx.exclusive(async () => {
    const post = publishedPost(ctx, conceptId, postId);
    await sweepExtractions(ctx);
    return { post, ...(await stageExtraction(ctx, postId, input)) };
  });
  const outcome = await runExtraction(deps, staged.dir, staged.post.platform, staged.post.format, input, staged.sources);
  return ctx.exclusive(async () => {
    const current = ctx.db.prepare('SELECT status FROM posts WHERE id = ?').get(postId) as { status: string } | undefined;
    if ('reason' in outcome || current?.status !== 'published') {
      await discardExtraction(ctx, postId, staged.id).catch(() => undefined);
      if (!current || current.status !== 'published') throw new ContentConflictError('The post is no longer published');
      return { ok: false as const, reason: (outcome as { reason: string }).reason };
    }
    return { ok: true as const, extractionId: staged.id, ...outcome.answer };
  });
}

export const discardStatExtraction = (ctx: ContentCtx, conceptId: string, postId: string, id: string): Promise<void> => {
  postRow(ctx, conceptId, postId);
  return discardExtraction(ctx, postId, id);
};
