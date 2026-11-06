import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { conceptDir, getConcept } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { ContentInputError, ContentNotFoundError, ContentTooLargeError } from './errors.ts';
import { cleanUploadName, MEDIA_TYPES, mediaTypeOf, parseRename, sniffMedia, SNIFF_BYTES } from './mediaTypes.ts';
import type { MediaKind } from './mediaTypes.ts';
import { mediaDir, remotionDir } from './remotionProject.ts';
import { videoDeps } from './videoDeps.ts';

/**
 * The Video tab's media: files of a Concept (not of a round, so a discarded session keeps them), stored in the shared Remotion
 * project's `public/concepts/<conceptId>/media/` where both the agent and Remotion read them. Rows live in `media`.
 */

interface MediaRow {
  id: string; conceptId: string; name: string; kind: MediaKind; size: number; durationMs: number | null; width: number | null; height: number | null;
  hasThumbnail: number; probed: number; createdAt: number; seq: number;
}

export interface MediaItem {
  id: string; name: string; kind: MediaKind; size: number; durationMs: number | null; width: number | null; height: number | null;
  hasThumbnail: boolean; createdAt: string;
  /** Relative to the Remotion project's `public/` folder: what a composition passes to `staticFile`. */
  path: string;
  fileUrl: string;
  thumbnailUrl: string | null;
}

const thumbsDir = (ctx: ContentCtx, conceptId: string): string => path.join(conceptDir(ctx, conceptId), 'media-thumbs');
const thumbFile = (ctx: ContentCtx, row: Pick<MediaRow, 'conceptId' | 'id'>): string => path.join(thumbsDir(ctx, row.conceptId), `${row.id}.jpg`);
export const mediaFile = (ctx: ContentCtx, row: Pick<MediaRow, 'conceptId' | 'name'>): string => path.join(mediaDir(ctx, row.conceptId), row.name);
const uploadsDir = (ctx: ContentCtx): string => path.join(remotionDir(ctx), '.uploads');

function itemOf(ctx: ContentCtx, row: MediaRow): MediaItem {
  const url = `/api/projects/${ctx.buildingId}/content/concepts/${row.conceptId}/media/${row.id}`;
  // An image is its own thumbnail; a video's is a generated poster frame; audio has none.
  const thumb = row.kind === 'image' || row.hasThumbnail === 1;
  return {
    id: row.id, name: row.name, kind: row.kind, size: row.size, durationMs: row.durationMs, width: row.width, height: row.height,
    hasThumbnail: thumb, createdAt: new Date(row.createdAt).toISOString(),
    path: `concepts/${row.conceptId}/media/${row.name}`, fileUrl: `${url}/file`, thumbnailUrl: thumb ? `${url}/thumbnail` : null,
  };
}

const rowsOf = (ctx: ContentCtx, conceptId: string): MediaRow[] => ctx.db.prepare('SELECT * FROM media WHERE conceptId = ? ORDER BY createdAt DESC, seq DESC').all(conceptId) as MediaRow[];

/** The Concept's media, newest first. */
export const listMedia = (ctx: ContentCtx, conceptId: string): MediaItem[] => rowsOf(ctx, conceptId).map((r) => itemOf(ctx, r));

export function mediaRow(ctx: ContentCtx, conceptId: string, mediaId: string): MediaRow {
  const row = ctx.db.prepare('SELECT * FROM media WHERE id = ? AND conceptId = ?').get(mediaId, conceptId) as MediaRow | undefined;
  if (!row) throw new ContentNotFoundError('That media file does not exist');
  return row;
}

/** Counts bytes as they stream, keeps the first bytes for sniffing, and fails past the limit. */
function meter(limit: number): Transform & { head: Buffer; total: number } {
  const chunks: Buffer[] = [];
  let kept = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, done) {
      t.total += chunk.length;
      if (t.total > limit) { done(new ContentTooLargeError(`A file can be at most ${formatLimit(limit)}`)); return; }
      if (kept < SNIFF_BYTES) { chunks.push(chunk.subarray(0, SNIFF_BYTES - kept)); kept += Math.min(chunk.length, SNIFF_BYTES - kept); t.head = Buffer.concat(chunks); }
      done(null, chunk);
    },
  }) as Transform & { head: Buffer; total: number };
  t.head = Buffer.alloc(0);
  t.total = 0;
  return t;
}

const formatLimit = (bytes: number): string => (bytes >= 1024 ** 3 ? `${+(bytes / 1024 ** 3).toFixed(2)} GB` : `${bytes} bytes`);

/** A declared `Content-Length`: absent is fine (chunked), not a whole number or over the limit is 400. */
export function checkDeclaredLength(header: string | undefined, limit: number): void {
  if (header === undefined) return;
  const size = /^\d+$/.test(header) ? Number(header) : Number.NaN;
  if (!Number.isSafeInteger(size)) throw new ContentInputError('Content-Length is not a valid size', 'file');
  if (size > limit) throw new ContentInputError(`A file can be at most ${formatLimit(limit)}`, 'file');
}

export interface UploadInput { rawName: unknown; body: Readable; declaredLength: string | undefined }

/**
 * Streams an upload to a temporary file (never held in memory), sniffs it, then commits it in the Building's write queue: the
 * count limit, a clean unique name and the row. Anything refused leaves nothing on disk.
 */
export async function receiveMedia(ctx: ContentCtx, conceptId: string, input: UploadInput): Promise<MediaItem> {
  const { limits } = videoDeps();
  if (typeof input.rawName !== 'string' || !input.rawName.trim()) throw new ContentInputError('name is required', 'name');
  const rawName = input.rawName;
  mediaTypeOf(rawName);
  checkDeclaredLength(input.declaredLength, limits.mediaMaxBytes);
  getConcept(ctx, conceptId);
  if (rowsOf(ctx, conceptId).length >= limits.mediaFilesMax) throw new ContentInputError(`At most ${limits.mediaFilesMax} files per Concept`, 'file');
  await mkdir(uploadsDir(ctx), { recursive: true });
  const tmp = path.join(uploadsDir(ctx), `${randomUUID()}.part`);
  const counter = meter(limits.mediaMaxBytes);
  try {
    await pipeline(input.body, counter, createWriteStream(tmp));
    const kind = sniffMedia(rawName, counter.head);
    return await ctx.exclusive(async () => {
      const rows = rowsOf(ctx, conceptId);
      if (rows.length >= limits.mediaFilesMax) throw new ContentInputError(`At most ${limits.mediaFilesMax} files per Concept`, 'file');
      const name = cleanUploadName(rawName, rows.map((r) => r.name));
      await mkdir(mediaDir(ctx, conceptId), { recursive: true });
      await rename(tmp, path.join(mediaDir(ctx, conceptId), name));
      const id = randomUUID();
      const seq = (ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM media').get() as { n: number }).n;
      ctx.db.prepare('INSERT INTO media (id, conceptId, name, kind, size, createdAt, seq) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, conceptId, name, kind, counter.total, ctx.now(), seq);
      return itemOf(ctx, mediaRow(ctx, conceptId, id));
    });
  } catch (error) {
    await rm(tmp, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') throw new ContentInputError('The upload was interrupted', 'file');
    throw error;
  }
}

/**
 * Reads duration and size and makes a video's poster frame, when the Remotion project can (its bundled ffprobe). A failure only
 * hides the thumbnail; a file the tools could not reach yet stays unprobed and is tried again after the project is set up.
 */
export async function probeMedia(ctx: ContentCtx, conceptId: string, mediaId: string): Promise<boolean> {
  const row = (() => { try { return mediaRow(ctx, conceptId, mediaId); } catch { return null; } })();
  if (!row || row.probed) return false;
  const { prober } = videoDeps();
  const file = mediaFile(ctx, row);
  const dir = remotionDir(ctx);
  let probe: Awaited<ReturnType<typeof prober.probe>> | null = null;
  try { probe = await prober.probe(dir, file, row.kind); } catch { /* not available yet, or unreadable */ }
  let thumb = false;
  if (probe && row.kind === 'video') {
    try { await mkdir(thumbsDir(ctx, conceptId), { recursive: true }); await prober.thumbnail(dir, file, thumbFile(ctx, row)); thumb = existsSync(thumbFile(ctx, row)); } catch { thumb = false; }
  }
  const stillThere = ctx.db.prepare('SELECT 1 FROM media WHERE id = ?').get(mediaId);
  if (!stillThere) return false;
  if (!probe) return false;
  ctx.db.prepare('UPDATE media SET durationMs = ?, width = ?, height = ?, hasThumbnail = ?, probed = 1 WHERE id = ?').run(probe.durationMs, probe.width, probe.height, thumb ? 1 : 0, mediaId);
  return true;
}

/** Media of the Building that has not been probed yet (uploaded before the Remotion project was installed). */
export const unprobedMedia = (ctx: ContentCtx): { id: string; conceptId: string }[] =>
  ctx.db.prepare('SELECT id, conceptId FROM media WHERE probed = 0').all() as { id: string; conceptId: string }[];

export async function renameMedia(ctx: ContentCtx, conceptId: string, mediaId: string, body: unknown): Promise<MediaItem> {
  const row = mediaRow(ctx, conceptId, mediaId);
  const others = rowsOf(ctx, conceptId).filter((r) => r.id !== mediaId).map((r) => r.name);
  const name = parseRename((body as { name?: unknown } | undefined)?.name, row.name, others);
  if (name !== row.name) {
    await rename(mediaFile(ctx, row), path.join(mediaDir(ctx, conceptId), name));
    ctx.db.prepare('UPDATE media SET name = ? WHERE id = ?').run(name, mediaId);
  }
  return itemOf(ctx, mediaRow(ctx, conceptId, mediaId));
}

/** Removes the file, its thumbnail and its row, and unlinks it from the checklist items of every round. */
export async function deleteMedia(ctx: ContentCtx, conceptId: string, mediaId: string): Promise<void> {
  const row = mediaRow(ctx, conceptId, mediaId);
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM media WHERE id = ?').run(mediaId);
    const items = ctx.db.prepare("SELECT rowid, mediaIds FROM video_checklist_items WHERE mediaIds LIKE ?").all(`%${mediaId}%`) as { rowid: number; mediaIds: string }[];
    for (const item of items) {
      const ids = (JSON.parse(item.mediaIds) as string[]).filter((id) => id !== mediaId);
      ctx.db.prepare('UPDATE video_checklist_items SET mediaIds = ? WHERE rowid = ?').run(JSON.stringify(ids), item.rowid);
    }
  })();
  await rm(mediaFile(ctx, row), { force: true });
  await rm(thumbFile(ctx, row), { force: true });
}

/** The stored file and its type for a download or the player. */
export async function mediaFileOf(ctx: ContentCtx, conceptId: string, mediaId: string): Promise<{ file: string; mime: string; name: string }> {
  const row = mediaRow(ctx, conceptId, mediaId);
  const file = mediaFile(ctx, row);
  await stat(file).catch(() => { throw new ContentNotFoundError('That media file is missing on disk'); });
  return { file, mime: MEDIA_TYPES[path.extname(row.name).slice(1).toLowerCase()]!.mime, name: row.name };
}

/** An image serves itself; a video its poster frame; audio, or a video without one, is 404. */
export async function thumbnailOf(ctx: ContentCtx, conceptId: string, mediaId: string): Promise<{ file: string; mime: string }> {
  const row = mediaRow(ctx, conceptId, mediaId);
  if (row.kind === 'image') return mediaFileOf(ctx, conceptId, mediaId);
  if (row.kind === 'video' && row.hasThumbnail) return { file: thumbFile(ctx, row), mime: 'image/jpeg' };
  throw new ContentNotFoundError('This file has no thumbnail');
}
