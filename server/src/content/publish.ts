import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentInputError } from './errors.ts';
import { getConcept, postOf, postRow, touch } from './concepts.ts';
import type { PostView } from './concepts.ts';
import { earliestCapture } from './statStore.ts';
import { parseLiveUrl, parsePastInstant } from './stats.ts';
import type { PostRow } from './concepts.ts';

const requireStatus = (row: PostRow, status: PostRow['status'], action: string): void => {
  if (row.status !== status) throw new ContentConflictError(`A ${row.status} post cannot be ${action}`);
};

/** Marks a finalized post as published by hand. The time defaults to now and may not be more than the tolerance ahead. */
export function publishPost(ctx: ContentCtx, conceptId: string, postId: string, body: Record<string, unknown>): PostView {
  const row = postRow(ctx, conceptId, postId);
  requireStatus(row, 'finalized', 'published');
  const liveUrl = parseLiveUrl(body.liveUrl);
  const publishedAt = body.publishedAt === undefined || body.publishedAt === null ? ctx.now() : parsePastInstant(body.publishedAt, 'publishedAt', ctx.now());
  // An ordinary post's note is a "back to draft" warning that no longer applies; an imported post's note is the owner's own.
  const note = getConcept(ctx, conceptId).imported ? row.note : null;
  ctx.db.prepare("UPDATE posts SET status = 'published', publishedAt = ?, liveUrl = ?, note = ? WHERE id = ?").run(publishedAt, liveUrl, note, postId);
  touch(ctx, conceptId);
  return postOf(ctx, conceptId, postId);
}

/** Changes the URL (`null` clears it) and the published time of a published post; the time cannot move past a snapshot already captured. */
export function editPublishDetails(ctx: ContentCtx, conceptId: string, postId: string, body: Record<string, unknown>): PostView {
  const row = postRow(ctx, conceptId, postId);
  requireStatus(row, 'published', 'edited');
  const liveUrl = body.liveUrl === undefined ? row.liveUrl : parseLiveUrl(body.liveUrl);
  let publishedAt = row.publishedAt!;
  if (body.publishedAt !== undefined) {
    publishedAt = parsePastInstant(body.publishedAt, 'publishedAt', ctx.now());
    const first = earliestCapture(ctx, postId);
    if (first !== null && publishedAt > first) throw new ContentInputError('publishedAt cannot be after a stats snapshot that was already captured', 'publishedAt');
  }
  ctx.db.prepare('UPDATE posts SET publishedAt = ?, liveUrl = ? WHERE id = ?').run(publishedAt, liveUrl, postId);
  touch(ctx, conceptId);
  return postOf(ctx, conceptId, postId);
}

/** Back to finalized: the URL and time are cleared, the stats stay and show again on the next publish. */
export function unpublishPost(ctx: ContentCtx, conceptId: string, postId: string): PostView {
  const row = postRow(ctx, conceptId, postId);
  requireStatus(row, 'published', 'unpublished');
  ctx.db.prepare("UPDATE posts SET status = 'finalized', publishedAt = NULL, liveUrl = NULL WHERE id = ?").run(postId);
  touch(ctx, conceptId);
  return postOf(ctx, conceptId, postId);
}
