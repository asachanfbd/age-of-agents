import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { postDir, postOfAsset } from './concepts.ts';
import type { AssetRow, PostView } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentNotFoundError } from './errors.ts';
import { callTimeoutMessage, defaultImageSize, finalizeImagesBlocker, imageFileName, imageTimeoutMessage, parseCompositionIds, parseImageFileName, parseImageSize, requireOwnIds } from './imageRules.ts';
import type { ImageSize } from './imageRules.ts';
import { postStills, setupView, writeRegistry } from './remotionProject.ts';
import type { SetupView } from './remotionProject.ts';
import type { RenderQueue } from './renderQueue.ts';
import { imageRange } from './rules.ts';
import type { ImageRange, Platform } from './rules.ts';
import { createStillCalls, idsOf } from './stillCalls.ts';
import type { CallRow, StillCallDto, StillSessionRef } from './stillCalls.ts';
import { buildZip } from './zip.ts';
import type { ZipEntry } from './zip.ts';

/**
 * The Images tab's own state around the shared agent pane (`studioSessions.ts`): `render_images` calls (`stillCalls.ts`), which render
 * a post's still compositions to PNG through the Building's one render queue, the round folders they write, and the Finalize count rule.
 * Each call replaces its round's images.
 */

export type ImageCallDto = StillCallDto;

export interface ImageFileDto { index: number; name: string; compositionId: string | null; width: number; height: number; size: number; url: string; downloadUrl: string }

export interface ImageRoundDto {
  round: number;
  /** The round's newest `render_images` call; its images are the only ones on disk. */
  call: ImageCallDto;
  images: ImageFileDto[];
  zipUrl: string | null;
}

export interface ImagesPart {
  setup: SetupView;
  /** Why no session runs (no default agent, a failed start); null while one runs or is starting. */
  blockedReason: string | null;
  platform: Platform;
  format: string;
  defaultSize: ImageSize;
  range: ImageRange;
  /** The post's still composition ids, sorted. */
  stills: string[];
  /** Every round that rendered, newest first. */
  rounds: ImageRoundDto[];
  /** Why Finalize is refused now, or null. */
  finalizeBlocked: string | null;
}

export interface ImageStudioDeps {
  /** The asset's view is rebuilt and sent to every listener. */
  publish(ctx: ContentCtx, conceptId: string, assetId: string): Promise<unknown>;
  queue: RenderQueue;
}

/** `<concept>/posts/<postId>/images/round-<n>/`. */
export const imagesRoundDir = (ctx: ContentCtx, conceptId: string, postId: string, round: number): string => path.join(postDir(ctx, conceptId, postId), 'images', `round-${round}`);
/** A rendered image as the image-set asset's content refers to it: relative to the Concept's folder. */
export const imageRef = (postId: string, round: number, name: string): string => `posts/${postId}/images/round-${round}/${name}`;

/** An image-set asset and its post, found by the asset id alone (the file routes carry no Concept id). */
export function imageAssetOf(ctx: ContentCtx, assetId: string): { asset: AssetRow; post: PostView } {
  const asset = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND kind = 'image-set'").get(assetId) as AssetRow | undefined;
  const post = asset ? postOfAsset(ctx, asset) : null;
  if (!asset || !post) throw new ContentNotFoundError('That image set does not exist');
  return { asset, post };
}

export function createImageStudio(deps: ImageStudioDeps) {
  const { queue } = deps;
  const calls = createStillCalls(queue, { kind: 'images', noun: 'image', fileName: imageFileName, parseFileName: parseImageFileName, timeoutMessage: imageTimeoutMessage, callTimeoutMessage });

  async function roundView(ctx: ContentCtx, asset: AssetRow, post: PostView, call: CallRow): Promise<ImageRoundDto> {
    const { round } = call;
    const base = `/api/projects/${ctx.buildingId}/content/assets/${asset.id}/images/rounds/${round}`;
    const ids = idsOf(call);
    const images = await Promise.all((await calls.roundFiles(imagesRoundDir(ctx, post.conceptId, post.id, round))).map(async (f) => ({
      index: f.index, name: f.name, compositionId: ids[f.index - 1] ?? null, width: call.width, height: call.height,
      size: (await stat(f.file).catch(() => null))?.size ?? 0,
      url: `${base}/${f.name}`, downloadUrl: `${base}/${f.name}?download=1`,
    })));
    return { round, call: calls.callDto(ctx, call), images, zipUrl: images.length ? `${base}/images.zip` : null };
  }

  /** Why Finalize is refused for the asset's current round, or null. */
  async function blocker(ctx: ContentCtx, asset: AssetRow, post: PostView): Promise<string | null> {
    const { state, count } = await calls.roundState(ctx, asset.id, asset.round, imagesRoundDir(ctx, post.conceptId, post.id, asset.round));
    return finalizeImagesBlocker(post.platform, post.format, state, count);
  }

  /** The Images tab's part of the asset's view. */
  async function part(ctx: ContentCtx, asset: AssetRow, blockedReason: string | null): Promise<ImagesPart> {
    const { post } = imageAssetOf(ctx, asset.id);
    calls.reconcile(ctx, asset.id);
    return {
      setup: setupView(ctx), blockedReason, platform: post.platform, format: post.format,
      defaultSize: defaultImageSize(post.platform, post.format)!, range: imageRange(post.platform, post.format)!,
      stills: (await postStills(ctx, post.conceptId, post.id).catch(() => [])).map((s) => s.id),
      rounds: await Promise.all(calls.newestPerRound(ctx, asset.id).map((call) => roundView(ctx, asset, post, call))),
      finalizeBlocked: asset.state === 'finalized' ? null : await blocker(ctx, asset, post),
    };
  }

  // ---- the session's tool -----------------------------------------------------------------------

  /** The checks `render_images` makes before anything is queued, then the round's old images go. Runs in the Building's write queue. */
  async function prepare(ctx: ContentCtx, session: StillSessionRef, body: { compositionIds?: unknown; width?: unknown; height?: unknown }): Promise<CallRow> {
    if (session.tab !== 'images') throw new ContentConflictError('This tool belongs to the Images tab');
    const { post } = imageAssetOf(ctx, session.assetId);
    const ids = parseCompositionIds(body.compositionIds);
    const size = parseImageSize(body, defaultImageSize(post.platform, post.format)!);
    calls.refuseBusy(ctx, session.assetId, 'A render is already running or waiting for these images');
    // The registry must list every still file the agent wrote before the renderer bundles the project.
    await writeRegistry(ctx);
    requireOwnIds(ids, (await postStills(ctx, post.conceptId, post.id)).map((s) => s.id));
    await rm(imagesRoundDir(ctx, post.conceptId, post.id, session.round), { recursive: true, force: true });
    return calls.record(ctx, session.assetId, session.round, ids, size);
  }

  /** Queues the call and waits for it; returns what the agent is told, or throws the failure. */
  async function run(ctx: ContentCtx, session: StillSessionRef, row: CallRow): Promise<{ round: number; images: { index: number; compositionId: string; width: number; height: number }[]; queued: boolean }> {
    const { post } = imageAssetOf(ctx, row.assetId);
    const out = await calls.run(ctx, session.conceptId, row, imagesRoundDir(ctx, post.conceptId, post.id, row.round), () => deps.publish(ctx, session.conceptId, row.assetId));
    return { round: out.round, images: out.stills, queued: out.queued };
  }

  // ---- the owner's routes -----------------------------------------------------------------------

  async function stopRender(ctx: ContentCtx, assetId: string, renderId: string): Promise<ImageCallDto> {
    imageAssetOf(ctx, assetId);
    return calls.stop(ctx, assetId, renderId);
  }

  /** One rendered PNG; the name is checked against the closed file-name pattern, never joined as given. */
  async function imageFile(ctx: ContentCtx, assetId: string, round: number, name: string): Promise<{ file: string; name: string }> {
    const { post } = imageAssetOf(ctx, assetId);
    if (!Number.isInteger(round) || round < 1 || parseImageFileName(name) === null) throw new ContentNotFoundError('That image does not exist');
    const file = path.join(imagesRoundDir(ctx, post.conceptId, post.id, round), name);
    await stat(file).catch(() => { throw new ContentNotFoundError('That image does not exist'); });
    return { file, name: `round-${round}-${name}` };
  }

  /** Every image of the round in render order, stored uncompressed; 404 when it has none. */
  async function roundZip(ctx: ContentCtx, assetId: string, round: number): Promise<Buffer> {
    const { post } = imageAssetOf(ctx, assetId);
    if (!Number.isInteger(round) || round < 1) throw new ContentNotFoundError('That round does not exist');
    const files = await calls.roundFiles(imagesRoundDir(ctx, post.conceptId, post.id, round));
    const entries: ZipEntry[] = [];
    for (const f of files) { const bytes = await readFile(f.file).catch(() => null); if (bytes) entries.push({ name: f.name, bytes }); }
    if (!entries.length) throw new ContentNotFoundError('There are no images to download');
    return buildZip(entries);
  }

  // ---- lifecycle hooks the agent pane calls -----------------------------------------------------

  /** The finalized content: the round's images as paths relative to the Concept's folder, once the newest call fits the format. */
  async function finalizeImages(ctx: ContentCtx, asset: AssetRow): Promise<string> {
    const { post } = imageAssetOf(ctx, asset.id);
    calls.reconcile(ctx, asset.id);
    const reason = await blocker(ctx, asset, post);
    if (reason) throw new ContentConflictError(reason);
    const files = await calls.roundFiles(imagesRoundDir(ctx, post.conceptId, post.id, asset.round));
    return JSON.stringify(files.map((f) => imageRef(post.id, asset.round, f.name)));
  }

  const stopForAsset = (buildingId: string, assetId: string): void => queue.stopAsset(buildingId, assetId);

  return { part, prepare, run, stopRender, imageFile, roundZip, finalizeImages, stopForAsset };
}

export type ImageStudio = ReturnType<typeof createImageStudio>;
