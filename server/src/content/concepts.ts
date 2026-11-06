import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentInputError, ContentNotFoundError } from './errors.ts';
import { escapeLike, parseBrief, parseInstant, parseLimit, parseOffset, parsePostShape, parseTitle } from './validate.ts';
import { ASSET_STATES, assetsNeeded, finalizeCheck, IMPORTED_READ_ONLY, isConceptAssetKind, isPlatform, PLATFORMS, POST_STATUSES, postNeeds, statusAfterAssetDrafting } from './rules.ts';
import type { AssetKind, AssetState, Platform, PostStatus } from './rules.ts';
import { PLATFORM_LABELS } from './rules.ts';
import { existingCompositionId } from './remotionProject.ts';
import { statRowsByPost, statSummaries } from './statStore.ts';
import { postResults } from './results.ts';
import type { PostResultView } from './results.ts';
import { isOverallResult } from './targetRules.ts';
import type { StatsSummary } from './statStore.ts';
import { viewsOf as viewsCount } from './stats.ts';

interface ConceptRow { id: string; title: string; brief: string; archived: number; createdAt: number; updatedAt: number; seq: number; imported: number; importSessionId: string | null }
export interface PostRow { id: string; conceptId: string; platform: Platform; format: string; scheduledAt: number; status: PostStatus; note: string | null; createdAt: number; publishedAt: number | null; liveUrl: string | null; externalAssets: string | null }
export interface AssetRow { id: string; conceptId: string; postId: string | null; kind: AssetKind; state: AssetState; content: string | null; finalizedAt: number | null; round: number }

export interface AssetView { id: string; kind: AssetKind; postId: string | null; state: AssetState; content: string | null; finalizedAt: string | null; round: number }
export interface PostView {
  id: string; conceptId: string; platform: Platform; format: string; scheduledAt: string; status: PostStatus; note: string | null; createdAt: string;
  /** The assets this post needs, each with its current state. */
  needs: AssetView[];
  /** Set while the post is published. */
  publishedAt: string | null;
  liveUrl: string | null;
  /** Stats of a published post: how many snapshots, the latest and its change since the one before. */
  stats: StatsSummary | null;
  /** A published post's result against its platform's targets; null while it is not published. */
  result: PostResultView | null;
  /** An imported post's free text about images or video kept elsewhere. */
  externalAssets: string | null;
}
export interface ConceptView {
  id: string; title: string; brief: string; archived: boolean; createdAt: string; updatedAt: string;
  /** Made outside the system: its posts are published directly and its content is read-only. */
  imported: boolean;
  posts: PostView[]; assets: AssetView[];
  progress: { finalized: number; needed: number };
  /** The Concept's Remotion composition once the Video tab has scaffolded it, else null (the Remotion tab is disabled). */
  compositionId: string | null;
}
/** Per platform, over every published post of the matching Concepts (not only the page): judged posts are those with a result other than too early or no target. */
export interface PlatformResultSummary { platform: Platform; judged: number; onTarget: number; tooEarly: number; noTarget: number }
export interface ConceptPage { rows: ConceptView[]; total: number; limit: number; offset: number; hasMore: boolean; summary: PlatformResultSummary[] }

const iso = (ms: number): string => new Date(ms).toISOString();
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An id from a URL is only ever looked up, never joined into a path, unless it matches the shape this module generates. */
export const isRecordId = (value: string): boolean => ID.test(value);

export const conceptDir = (ctx: ContentCtx, conceptId: string): string => path.join(ctx.dir, 'concepts', conceptId);
/** The finalized script as a file agents of the other tabs read; it exists only while the script is finalized. */
export const scriptFile = (ctx: ContentCtx, conceptId: string): string => path.join(conceptDir(ctx, conceptId), 'script', 'script.md');
/** Where a post's own files (stats sources) live inside its Concept's folder. */
export const postDir = (ctx: ContentCtx, conceptId: string, postId: string): string => path.join(conceptDir(ctx, conceptId), 'posts', postId);

function assetView(r: AssetRow): AssetView {
  return { id: r.id, kind: r.kind, postId: r.postId, state: r.state, content: r.content, finalizedAt: r.finalizedAt === null ? null : iso(r.finalizedAt), round: r.round };
}

function conceptRow(ctx: ContentCtx, id: string): ConceptRow {
  const row = ctx.db.prepare('SELECT * FROM concepts WHERE id = ?').get(id) as ConceptRow | undefined;
  if (!row) throw new ContentNotFoundError('That concept does not exist');
  return row;
}
export function postRow(ctx: ContentCtx, conceptId: string, postId: string): PostRow {
  const row = ctx.db.prepare('SELECT * FROM posts WHERE id = ? AND conceptId = ?').get(postId, conceptId) as PostRow | undefined;
  if (!row) throw new ContentNotFoundError('That post does not exist');
  return row;
}

function viewsOf(ctx: ContentCtx, rows: ConceptRow[]): ConceptView[] {
  if (!rows.length) return [];
  const marks = rows.map(() => '?').join(',');
  const ids = rows.map((r) => r.id);
  const posts = ctx.db.prepare(`SELECT * FROM posts WHERE conceptId IN (${marks}) ORDER BY scheduledAt, createdAt, id`).all(...ids) as PostRow[];
  const assets = ctx.db.prepare(`SELECT * FROM assets WHERE conceptId IN (${marks}) ORDER BY rowid`).all(...ids) as AssetRow[];
  const publishedIds = posts.filter((p) => p.status === 'published').map((p) => p.id);
  const statRows = statRowsByPost(ctx, publishedIds);
  const stats = statSummaries(ctx, publishedIds, statRows);
  const results = postResults(ctx, posts.filter((p) => p.status === 'published'), statRows);
  return rows.map((c) => {
    const mine = assets.filter((a) => a.conceptId === c.id);
    const conceptAssets = mine.filter((a) => a.postId === null);
    const assetOf = (post: PostRow, kind: AssetKind) => mine.find((a) => a.kind === kind && a.postId === (isConceptAssetKind(kind) ? null : post.id));
    const postViews = posts.filter((p) => p.conceptId === c.id).map((p): PostView => {
      const needs = postNeeds(p.platform, p.format, c.imported === 1, (kind) => assetOf(p, kind)?.state).map((kind) => assetOf(p, kind)!);
      return { id: p.id, conceptId: p.conceptId, platform: p.platform, format: p.format, scheduledAt: iso(p.scheduledAt), status: p.status, note: p.note, createdAt: iso(p.createdAt), needs: needs.map(assetView),
        publishedAt: p.publishedAt === null ? null : iso(p.publishedAt), liveUrl: p.liveUrl, stats: stats.get(p.id) ?? null, result: results.get(p.id) ?? null, externalAssets: p.externalAssets };
    });
    const needed = postViews.reduce((n, p) => n + p.needs.length, 0);
    const finalized = postViews.reduce((n, p) => n + p.needs.filter((a) => a.state === 'finalized').length, 0);
    return { id: c.id, title: c.title, brief: c.brief, archived: c.archived === 1, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt), imported: c.imported === 1, posts: postViews, assets: conceptAssets.map(assetView), progress: { finalized, needed }, compositionId: existingCompositionId(ctx, c.id) };
  });
}

export function getConcept(ctx: ContentCtx, id: string): ConceptView {
  return viewsOf(ctx, [conceptRow(ctx, id)])[0]!;
}

/** Refuses a change to an imported Concept's content; 404 when there is no such Concept. */
export function refuseImported(ctx: ContentCtx, conceptId: string): void {
  if (conceptRow(ctx, conceptId).imported === 1) throw new ContentConflictError(IMPORTED_READ_ONLY);
}

/** The Concepts one import session saved, oldest first. */
export function conceptsOfImportSession(ctx: ContentCtx, sessionId: string): ConceptView[] {
  return viewsOf(ctx, ctx.db.prepare('SELECT * FROM concepts WHERE importSessionId = ? ORDER BY createdAt, seq').all(sessionId) as ConceptRow[]);
}

export interface PostInput { platform: Platform; format: string; scheduledAt: number }
function parsePostInput(body: unknown): PostInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return { ...parsePostShape(b.platform, b.format), scheduledAt: parseInstant(b.scheduledAt) };
}

function insertAsset(ctx: ContentCtx, conceptId: string, postId: string | null, kind: AssetKind): void {
  ctx.db.prepare('INSERT INTO assets (id, conceptId, postId, kind) VALUES (?, ?, ?, ?)').run(randomUUID(), conceptId, postId, kind);
}
/** A post's own assets are created with it; a Concept-level one it needs (the thumbnail of its first video post) only when the Concept has none yet. */
export function insertPost(ctx: ContentCtx, conceptId: string, input: PostInput): string {
  const id = randomUUID();
  ctx.db.prepare('INSERT INTO posts (id, conceptId, platform, format, scheduledAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, conceptId, input.platform, input.format, input.scheduledAt, ctx.now());
  for (const kind of assetsNeeded(input.platform, input.format)) {
    if (!isConceptAssetKind(kind)) insertAsset(ctx, conceptId, id, kind);
    else if (!ctx.db.prepare('SELECT 1 FROM assets WHERE conceptId = ? AND postId IS NULL AND kind = ?').get(conceptId, kind)) insertAsset(ctx, conceptId, null, kind);
  }
  return id;
}

/** A Concept row with its script and video assets, numbered after every other Concept. Run inside a transaction. */
export function insertConcept(ctx: ContentCtx, id: string, row: { title: string; brief: string; importSessionId?: string }): void {
  const now = ctx.now();
  const seq = (ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM concepts').get() as { n: number }).n;
  ctx.db.prepare('INSERT INTO concepts (id, title, brief, createdAt, updatedAt, seq, imported, importSessionId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, row.title, row.brief, now, now, seq, row.importSessionId ? 1 : 0, row.importSessionId ?? null);
  insertAsset(ctx, id, null, 'script');
  insertAsset(ctx, id, null, 'video');
}

/** Creates the Concept, its script and video assets, any first posts (with the thumbnail when one is a video) and its folder. Invalid input writes nothing. */
export async function createConcept(ctx: ContentCtx, body: unknown): Promise<ConceptView> {
  const b = (body ?? {}) as Record<string, unknown>;
  const title = parseTitle(b.title), brief = parseBrief(b.brief);
  if (b.posts !== undefined && !Array.isArray(b.posts)) throw new ContentInputError('posts must be a list', 'posts');
  const posts = ((b.posts as unknown[] | undefined) ?? []).map(parsePostInput);
  const id = randomUUID();
  ctx.db.transaction(() => {
    insertConcept(ctx, id, { title, brief });
    for (const post of posts) insertPost(ctx, id, post);
  })();
  try { await mkdir(conceptDir(ctx, id), { recursive: true }); } catch (e) { ctx.db.prepare('DELETE FROM concepts WHERE id = ?').run(id); throw e; }
  return getConcept(ctx, id);
}

interface ResultPostRow { id: string; conceptId: string; platform: Platform; publishedAt: number }
const publishedPostRows = (ctx: ContentCtx, from = 'posts p', clause = ''): ResultPostRow[] =>
  ctx.db.prepare(`SELECT p.id, p.conceptId, p.platform, p.publishedAt FROM ${from} ${clause} ${clause ? 'AND' : 'WHERE'} p.status = 'published' AND p.publishedAt IS NOT NULL`).all() as ResultPostRow[];

/** Concepts with a published post of this result; with a platform filter only that platform's posts count. */
function conceptIdsWithResult(ctx: ContentCtx, result: string, platform?: string): string[] {
  const posts = publishedPostRows(ctx).filter((p) => !platform || p.platform === platform);
  const results = postResults(ctx, posts);
  return [...new Set(posts.filter((p) => results.get(p.id)?.overall === result).map((p) => p.conceptId))];
}

function platformSummary(ctx: ContentCtx, clause: string, params: unknown[]): PlatformResultSummary[] {
  const posts = ctx.db.prepare(`SELECT p.id, p.platform, p.publishedAt FROM posts p JOIN concepts c ON c.id = p.conceptId ${clause} AND p.status = 'published' AND p.publishedAt IS NOT NULL`).all(...(params as never[])) as ResultPostRow[];
  const results = postResults(ctx, posts);
  return PLATFORMS.map((platform) => {
    const mine = posts.filter((p) => p.platform === platform).map((p) => results.get(p.id)!.overall);
    return { platform, judged: mine.filter((o) => o === 'on-target' || o === 'partly' || o === 'below-target').length, onTarget: mine.filter((o) => o === 'on-target').length, tooEarly: mine.filter((o) => o === 'too-early').length, noTarget: mine.filter((o) => o === 'no-target').length };
  });
}

export function listConcepts(ctx: ContentCtx, query: Record<string, unknown>): ConceptPage {
  const limit = parseLimit(query.limit), offset = parseOffset(query.offset);
  const where: string[] = [], params: unknown[] = [];
  if (query.archived !== undefined && query.archived !== 'true' && query.archived !== 'false') throw new ContentInputError('archived must be true or false', 'archived');
  where.push('c.archived = ?'); params.push(query.archived === 'true' ? 1 : 0);
  if (query.imported !== undefined) {
    if (query.imported !== 'true' && query.imported !== 'false') throw new ContentInputError('imported must be true or false', 'imported');
    where.push('c.imported = ?'); params.push(query.imported === 'true' ? 1 : 0);
  }
  if (query.status !== undefined) {
    if (!(POST_STATUSES as readonly unknown[]).includes(query.status)) throw new ContentInputError('status must be draft, finalized or published', 'status');
    where.push('EXISTS (SELECT 1 FROM posts p WHERE p.conceptId = c.id AND p.status = ?)'); params.push(query.status);
  }
  if (query.platform !== undefined) {
    if (!isPlatform(query.platform)) throw new ContentInputError('platform must be linkedin, instagram, x, facebook or blog', 'platform');
    where.push('EXISTS (SELECT 1 FROM posts p WHERE p.conceptId = c.id AND p.platform = ?)'); params.push(query.platform);
  }
  if (query.q !== undefined) {
    if (typeof query.q !== 'string') throw new ContentInputError('q must be text', 'q');
    const needle = `%${escapeLike(query.q.trim().toLowerCase())}%`;
    where.push("(LOWER(c.title) LIKE ? ESCAPE '\\' OR LOWER(c.brief) LIKE ? ESCAPE '\\')"); params.push(needle, needle);
  }
  const sort = query.sort === undefined ? 'newest' : query.sort;
  if (sort !== 'newest' && sort !== 'views') throw new ContentInputError('sort must be newest or views', 'sort');
  if (query.result !== undefined && !isOverallResult(query.result)) throw new ContentInputError('result must be on-target, partly, below-target, too-early or no-target', 'result');
  const summary = platformSummary(ctx, `WHERE ${where.join(' AND ')}`, params);
  if (query.result !== undefined) {
    const ids = conceptIdsWithResult(ctx, query.result, query.platform as string | undefined);
    where.push(`c.id IN (${ids.map(() => '?').join(',') || "''"})`); params.push(...ids);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  if (sort === 'views') return { ...listByViews(ctx, clause, params, limit, offset), summary };
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM concepts c ${clause}`).get(...(params as never[])) as { n: number }).n;
  const rows = ctx.db.prepare(`SELECT c.* FROM concepts c ${clause} ORDER BY c.createdAt DESC, c.seq DESC LIMIT ? OFFSET ?`).all(...(params as never[]), limit, offset) as ConceptRow[];
  return { rows: viewsOf(ctx, rows), total, limit, offset, hasMore: offset + rows.length < total, summary };
}

/** "Most views": a Concept ranks by its best published post's latest views; Concepts without stats come last, newest first. */
function listByViews(ctx: ContentCtx, clause: string, params: unknown[], limit: number, offset: number): Omit<ConceptPage, 'summary'> {
  const all = ctx.db.prepare(`SELECT c.* FROM concepts c ${clause} ORDER BY c.createdAt DESC, c.seq DESC`).all(...(params as never[])) as ConceptRow[];
  const posts = ctx.db.prepare("SELECT id, conceptId FROM posts WHERE status = 'published'").all() as Array<{ id: string; conceptId: string }>;
  const summaries = statSummaries(ctx, posts.map((p) => p.id));
  const best = new Map<string, number>();
  for (const p of posts) {
    const views = summaries.get(p.id)?.latest ? viewsCount(summaries.get(p.id)!.latest!.counts) : null;
    if (views !== null && views > (best.get(p.conceptId) ?? -1)) best.set(p.conceptId, views);
  }
  const ranked = all.map((c, i) => ({ c, i, views: best.get(c.id) ?? -1 })).sort((a, b) => b.views - a.views || a.i - b.i).map((x) => x.c);
  const rows = ranked.slice(offset, offset + limit);
  return { rows: viewsOf(ctx, rows), total: all.length, limit, offset, hasMore: offset + rows.length < all.length };
}

export function patchConcept(ctx: ContentCtx, id: string, body: unknown): ConceptView {
  const row = conceptRow(ctx, id);
  const b = (body ?? {}) as Record<string, unknown>;
  const title = b.title === undefined ? row.title : parseTitle(b.title);
  const brief = b.brief === undefined ? row.brief : parseBrief(b.brief);
  if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new ContentInputError('archived must be true or false', 'archived');
  const archived = b.archived === undefined ? row.archived : b.archived ? 1 : 0;
  const changed = title !== row.title || brief !== row.brief || archived !== row.archived;
  if (changed) ctx.db.prepare('UPDATE concepts SET title = ?, brief = ?, archived = ?, updatedAt = ? WHERE id = ?').run(title, brief, archived, ctx.now(), id);
  return getConcept(ctx, id);
}

export async function deleteConcept(ctx: ContentCtx, id: string): Promise<void> {
  conceptRow(ctx, id);
  ctx.db.prepare('DELETE FROM concepts WHERE id = ?').run(id);
  await rm(conceptDir(ctx, id), { recursive: true, force: true });
}

export const touch = (ctx: ContentCtx, conceptId: string) => ctx.db.prepare('UPDATE concepts SET updatedAt = ? WHERE id = ?').run(ctx.now(), conceptId);

export function createPost(ctx: ContentCtx, conceptId: string, body: unknown): PostView {
  refuseImported(ctx, conceptId);
  const input = parsePostInput(body);
  const id = ctx.db.transaction(() => { const postId = insertPost(ctx, conceptId, input); touch(ctx, conceptId); return postId; })();
  return getConcept(ctx, conceptId).posts.find((p) => p.id === id)!;
}

export const postOf = (ctx: ContentCtx, conceptId: string, postId: string): PostView => getConcept(ctx, conceptId).posts.find((p) => p.id === postId)!;

/** Only the date and time can change; a different platform or format is a new post. */
export function patchPost(ctx: ContentCtx, conceptId: string, postId: string, body: unknown): PostView {
  postRow(ctx, conceptId, postId);
  const b = (body ?? {}) as Record<string, unknown>;
  for (const field of ['platform', 'format']) if (b[field] !== undefined) throw new ContentInputError(`${field} cannot be changed; add a new post instead`, field);
  if (b.scheduledAt !== undefined) {
    ctx.db.prepare('UPDATE posts SET scheduledAt = ? WHERE id = ?').run(parseInstant(b.scheduledAt), postId);
    touch(ctx, conceptId);
  }
  return postOf(ctx, conceptId, postId);
}

/**
 * Deletes a post with its assets, their drafts (both cascade) and its folder. `endSessions` gets the post's asset ids
 * first, so no session of a deleted asset keeps running.
 */
export async function deletePost(ctx: ContentCtx, conceptId: string, postId: string, endSessions: (assetIds: string[]) => Promise<void>): Promise<void> {
  const row = postRow(ctx, conceptId, postId);
  if (row.status === 'published') throw new ContentConflictError('A published post cannot be deleted');
  const assetIds = (ctx.db.prepare('SELECT id FROM assets WHERE postId = ?').all(postId) as { id: string }[]).map((a) => a.id);
  await endSessions(assetIds);
  ctx.db.transaction(() => { ctx.db.prepare('DELETE FROM posts WHERE id = ?').run(postId); touch(ctx, conceptId); })();
  await rm(postDir(ctx, conceptId, postId), { recursive: true, force: true });
}

/** Finalizes a draft post once every asset it needs is finalized; otherwise 409 with the missing asset kinds. */
export function finalizePost(ctx: ContentCtx, conceptId: string, postId: string): PostView {
  const row = postRow(ctx, conceptId, postId);
  refuseImported(ctx, conceptId);
  if (row.status !== 'draft') throw new ContentConflictError(`A ${row.status} post cannot be finalized`);
  const view = postOf(ctx, conceptId, postId);
  const check = finalizeCheck(assetsNeeded(row.platform, row.format), (kind) => view.needs.find((a) => a.kind === kind)?.state);
  if (!check.ok) throw new ContentConflictError(`Not every asset is finalized yet: ${check.missing.join(', ')}`, { missing: check.missing });
  ctx.db.prepare("UPDATE posts SET status = 'finalized', note = NULL WHERE id = ?").run(postId);
  touch(ctx, conceptId);
  return postOf(ctx, conceptId, postId);
}

export function unfinalizePost(ctx: ContentCtx, conceptId: string, postId: string): PostView {
  const row = postRow(ctx, conceptId, postId);
  refuseImported(ctx, conceptId);
  if (row.status !== 'finalized') throw new ContentConflictError(`A ${row.status} post cannot go back to draft`);
  ctx.db.prepare("UPDATE posts SET status = 'draft', note = NULL WHERE id = ?").run(postId);
  touch(ctx, conceptId);
  return postOf(ctx, conceptId, postId);
}

/**
 * Sets one asset's state (later tasks call this; no route does yet). An asset going back to `drafting` moves each
 * finalized post that needs it back to draft and leaves a note for the Overview.
 */
export function setAssetState(ctx: ContentCtx, assetId: string, state: AssetState, content?: string | null): void {
  if (!(ASSET_STATES as readonly string[]).includes(state)) throw new ContentInputError('state must be empty, drafting or finalized', 'state');
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow | undefined;
  if (!asset) throw new ContentNotFoundError('That asset does not exist');
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE assets SET state = ?, content = COALESCE(?, content), finalizedAt = ?, round = round + ? WHERE id = ?')
      .run(state, content ?? null, state === 'finalized' ? ctx.now() : null, state === 'drafting' ? 1 : 0, assetId);
    if (state === 'drafting') demotePostsNeeding(ctx, asset);
    touch(ctx, asset.conceptId);
  })();
}

function demotePostsNeeding(ctx: ContentCtx, asset: AssetRow): void {
  const finalized = ctx.db.prepare("SELECT * FROM posts WHERE conceptId = ? AND status = 'finalized'").all(asset.conceptId) as PostRow[];
  for (const post of finalized) {
    const needs = assetsNeeded(post.platform, post.format).includes(asset.kind);
    if (!needs || (asset.postId !== null && asset.postId !== post.id)) continue;
    const status = statusAfterAssetDrafting(post.status);
    ctx.db.prepare('UPDATE posts SET status = ?, note = ? WHERE id = ?').run(status, `Back to draft: the ${asset.kind} for this ${PLATFORM_LABELS[post.platform]} post is being redrafted`, post.id);
  }
}

/** One asset of a Concept; 404 when the Concept has no such asset. */
export function assetRowOf(ctx: ContentCtx, conceptId: string, assetId: string): AssetRow {
  const row = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND conceptId = ?').get(assetId, conceptId) as AssetRow | undefined;
  if (!row) throw new ContentNotFoundError('That asset does not exist');
  return row;
}

/** The post an asset belongs to, or null for a Concept-level asset. */
export function postOfAsset(ctx: ContentCtx, asset: AssetRow): PostView | null {
  return asset.postId === null ? null : postOf(ctx, asset.conceptId, asset.postId) ?? null;
}

/** The asset's round counter moves on to a fresh round; its state stays as it is. */
export function nextAssetRound(ctx: ContentCtx, assetId: string): void {
  ctx.db.prepare('UPDATE assets SET round = round + 1 WHERE id = ?').run(assetId);
}

/** True while a published post uses the asset, so it cannot be reopened (the script is never used by a post). */
export function usedByPublishedPost(ctx: ContentCtx, asset: AssetRow): boolean {
  if (asset.kind === 'script') return false;
  const published = ctx.db.prepare("SELECT * FROM posts WHERE conceptId = ? AND status = 'published'").all(asset.conceptId) as PostRow[];
  return published.some((p) => (asset.postId === null || asset.postId === p.id) && assetsNeeded(p.platform, p.format).includes(asset.kind));
}
