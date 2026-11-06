import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { ContentCtx } from './context.ts';
import { conceptDir, insertConcept, insertPost, scriptFile } from './concepts.ts';
import { ContentInputError } from './errors.ts';
import { writeTextAtomic } from './files.ts';
import { EXTERNAL_ASSETS_MAX, IMPORT_POSTS_MAX } from './limits.ts';
import type { Platform } from './rules.ts';
import { parseLiveUrl, parseNote, parsePastInstant, parseSnapshot } from './stats.ts';
import type { SnapshotInput } from './stats.ts';
import { parseDraftText } from './studioDrafts.ts';
import { charCount, parseBrief, parseInstant, parsePostShape, parseTitle } from './validate.ts';

export interface ImportedPostInput {
  platform: Platform; format: string; text: string | null; scheduledAt: number; publishedAt: number;
  liveUrl: string | null; note: string | null; externalAssets: string | null; stats: SnapshotInput[];
}
export interface ImportedConceptInput { title: string; brief: string; script: string | null; posts: ImportedPostInput[] }
export interface ImportedConceptSaved { conceptId: string; title: string; posts: { postId: string; platform: Platform; format: string }[] }

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Null and omitted are the same to every optional field here. */
const given = (value: unknown): unknown => value ?? undefined;

/** Runs a shared parser for a nested field, so its refusal names the path from here (`stats[0].capturedAt`); `whole` replaces the field's name. */
function within<T>(prefix: string, parse: () => T, whole?: string): T {
  try { return parse(); } catch (e) {
    if (!(e instanceof ContentInputError)) throw e;
    throw new ContentInputError(e.message, whole ?? (e.field ? `${prefix}.${e.field}` : prefix));
  }
}

/** Omitted is no script; a blank one is a mistake, because the agent meant to send text. */
const parseScript = (value: unknown): string | null => (given(value) === undefined ? null : within('', () => parseDraftText(value), 'script'));

/** Blank text is no text: a post may be known only by its link and date. */
function parsePostText(value: unknown, platform: Platform): string | null {
  if (given(value) === undefined || (typeof value === 'string' && !value.trim())) return null;
  return parseDraftText(value, platform);
}

function parseExternalAssets(value: unknown): string | null {
  if (given(value) === undefined) return null;
  if (typeof value !== 'string') throw new ContentInputError('externalAssets must be text', 'externalAssets');
  const text = value.trim();
  if (charCount(text) > EXTERNAL_ASSETS_MAX) throw new ContentInputError(`externalAssets must be at most ${EXTERNAL_ASSETS_MAX} characters`, 'externalAssets');
  return text || null;
}

/** Each time takes the other when omitted, and now when both are. The published time is the one that may not be in the future. */
function parseTimes(b: Record<string, unknown>, now: number): { scheduledAt: number; publishedAt: number } {
  const scheduledAt = given(b.scheduledAt) === undefined ? null : parseInstant(b.scheduledAt);
  const raw = given(b.publishedAt) ?? given(b.scheduledAt);
  const publishedAt = raw === undefined ? now : parsePastInstant(raw, 'publishedAt', now);
  return { scheduledAt: scheduledAt ?? publishedAt, publishedAt };
}

function parseStats(value: unknown, format: string, publishedAt: number, now: number): SnapshotInput[] {
  if (given(value) === undefined) return [];
  if (!Array.isArray(value)) throw new ContentInputError('stats must be a list', 'stats');
  return value.map((item, i) => within(`stats[${i}]`, () => {
    if (!isPlainObject(item)) throw new ContentInputError('A snapshot must be an object');
    return parseSnapshot(item, { format, publishedAt, now });
  }));
}

function parsePost(item: unknown, now: number): ImportedPostInput {
  if (!isPlainObject(item)) throw new ContentInputError('A post must be an object');
  const { platform, format } = parsePostShape(item.platform, item.format);
  const text = parsePostText(item.text, platform);
  const times = parseTimes(item, now);
  return {
    platform, format, text, ...times, liveUrl: parseLiveUrl(item.liveUrl), note: parseNote(item.note) || null, externalAssets: parseExternalAssets(item.externalAssets),
    stats: parseStats(item.stats, format, times.publishedAt, now),
  };
}

function parseBody(body: unknown, now: number): ImportedConceptInput {
  if (!isPlainObject(body)) throw new ContentInputError('The request body must be a JSON object');
  const title = parseTitle(body.title), brief = parseBrief(body.brief), script = parseScript(body.script);
  if (!Array.isArray(body.posts) || body.posts.length < 1 || body.posts.length > IMPORT_POSTS_MAX) throw new ContentInputError(`posts must be a list of 1 to ${IMPORT_POSTS_MAX}`, 'posts');
  return { title, brief, script, posts: body.posts.map((item, i) => within(`posts[${i}]`, () => parsePost(item, now))) };
}

/**
 * The `save_imported_concept` body, with the limits ordinary drafts, publishing and stats follow. Every refusal names its
 * field (`posts[1].text`), in the message too, since the agent reads only the message.
 */
export function parseImportedConcept(body: unknown, now: number): ImportedConceptInput {
  try { return parseBody(body, now); } catch (e) {
    if (e instanceof ContentInputError && e.field) throw new ContentInputError(`${e.field}: ${e.message}`, e.field);
    throw e;
  }
}

function insertImportedPost(ctx: ContentCtx, conceptId: string, post: ImportedPostInput, now: number): string {
  const id = insertPost(ctx, conceptId, post);
  ctx.db.prepare("UPDATE posts SET status = 'published', publishedAt = ?, liveUrl = ?, note = ?, externalAssets = ? WHERE id = ?").run(post.publishedAt, post.liveUrl, post.note, post.externalAssets, id);
  if (post.text !== null) ctx.db.prepare("UPDATE assets SET state = 'finalized', content = ?, finalizedAt = ? WHERE postId = ? AND kind IN ('post-text', 'article')").run(post.text, now, id);
  const insertStat = ctx.db.prepare("INSERT INTO post_stats (id, postId, capturedAt, enteredAt, counts, watchTime, note, sources) VALUES (?, ?, ?, ?, ?, ?, ?, '[]')");
  for (const s of post.stats) insertStat.run(randomUUID(), id, s.capturedAt, now, JSON.stringify(s.counts), s.watchTime, s.note);
  return id;
}

/**
 * Stores one Concept made outside the system: every asset with content finalized, every post published, and nothing else
 * started (no session, retro or auto-start). All or nothing: a failure at any point leaves no rows and no folder.
 */
export async function saveImportedConcept(ctx: ContentCtx, input: ImportedConceptInput, importSessionId: string): Promise<ImportedConceptSaved> {
  const conceptId = randomUUID(), now = ctx.now();
  const postIds = ctx.db.transaction(() => {
    insertConcept(ctx, conceptId, { title: input.title, brief: input.brief, importSessionId });
    if (input.script !== null) ctx.db.prepare("UPDATE assets SET state = 'finalized', content = ?, finalizedAt = ? WHERE conceptId = ? AND postId IS NULL AND kind = 'script'").run(input.script, now, conceptId);
    return input.posts.map((post) => insertImportedPost(ctx, conceptId, post, now));
  })();
  try {
    await mkdir(conceptDir(ctx, conceptId), { recursive: true });
    if (input.script !== null) await writeTextAtomic(scriptFile(ctx, conceptId), input.script);
  } catch (e) {
    ctx.db.prepare('DELETE FROM concepts WHERE id = ?').run(conceptId);
    await rm(conceptDir(ctx, conceptId), { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return { conceptId, title: input.title, posts: input.posts.map((p, i) => ({ postId: postIds[i]!, platform: p.platform, format: p.format })) };
}
