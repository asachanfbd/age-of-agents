import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { conceptDir } from './concepts.ts';
import type { AssetRow } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentNotFoundError } from './errors.ts';
import { parseImageSize, requireOwnIds } from './imageRules.ts';
import type { ImageSize } from './imageRules.ts';
import { setupView, thumbnailStills, writeRegistry } from './remotionProject.ts';
import type { SetupView } from './remotionProject.ts';
import type { RenderQueue } from './renderQueue.ts';
import { createStillCalls, idsOf } from './stillCalls.ts';
import type { CallRow, RenderedStill, StillCallDto, StillSessionRef } from './stillCalls.ts';
import {
  finalizeThumbnailBlocker, parseChosenThumbnail, parseThumbnailFileName, parseThumbnailIds, THUMBNAIL_SIZE, thumbnailCallTimeoutMessage, thumbnailFileName, thumbnailTimeoutMessage,
} from './thumbnailRules.ts';

/**
 * The Thumbnail tab's own state around the shared agent pane (`studioSessions.ts`): `render_thumbnails` calls (`stillCalls.ts`), which
 * render the Concept's thumbnail stills to PNG through the Building's one render queue, the round folders they write, and Finalize,
 * where the owner picks the one final thumbnail. Each call replaces its round's thumbnails.
 */

export interface ThumbnailFileDto { index: number; name: string; compositionId: string | null; width: number; height: number; size: number; url: string; downloadUrl: string }

export interface ThumbnailRoundDto {
  round: number;
  /** The round's newest `render_thumbnails` call; its thumbnails are the only ones on disk. */
  call: StillCallDto;
  thumbnails: ThumbnailFileDto[];
}

export interface ThumbnailPart {
  setup: SetupView;
  /** Why no session runs (no default agent, a failed start); null while one runs or is starting. */
  blockedReason: string | null;
  defaultSize: ImageSize;
  /** The Concept's thumbnail still ids, sorted. */
  stills: string[];
  /** Every round that rendered, newest first. Finalize picks from the current round's thumbnails. */
  rounds: ThumbnailRoundDto[];
  /** Why Finalize is refused now, or null. */
  finalizeBlocked: string | null;
  /** The finalized thumbnail; null unless finalized. */
  final: { round: number; name: string; url: string; downloadUrl: string } | null;
}

export interface ThumbnailStudioDeps {
  /** The asset's view is rebuilt and sent to every listener. */
  publish(ctx: ContentCtx, conceptId: string, assetId: string): Promise<unknown>;
  queue: RenderQueue;
}

/** `<concept>/thumbnail/round-<n>/`. */
export const thumbnailRoundDir = (ctx: ContentCtx, conceptId: string, round: number): string => path.join(conceptDir(ctx, conceptId), 'thumbnail', `round-${round}`);
/** A rendered thumbnail as the asset's content refers to it: relative to the Concept's folder. */
export const thumbnailRef = (round: number, name: string): string => `thumbnail/round-${round}/${name}`;

/** A thumbnail asset, found by its id alone (the file routes carry no Concept id). */
export function thumbnailAssetOf(ctx: ContentCtx, assetId: string): AssetRow {
  const asset = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND kind = 'thumbnail'").get(assetId) as AssetRow | undefined;
  if (!asset) throw new ContentNotFoundError('That thumbnail does not exist');
  return asset;
}

/** The round and file name of a finalized thumbnail's content (`["thumbnail/round-<n>/thumb-NN.png"]`), or null. */
function finalOf(asset: AssetRow): { round: number; name: string } | null {
  if (asset.state !== 'finalized' || !asset.content) return null;
  try {
    const [ref] = JSON.parse(asset.content) as unknown[];
    const m = typeof ref === 'string' ? /^thumbnail\/round-(\d+)\/([^/]+)$/.exec(ref) : null;
    return m ? { round: Number(m[1]), name: m[2]! } : null;
  } catch { return null; }
}

export function createThumbnailStudio(deps: ThumbnailStudioDeps) {
  const { queue } = deps;
  const calls = createStillCalls(queue, {
    kind: 'thumbnail', noun: 'thumbnail', fileName: thumbnailFileName, parseFileName: parseThumbnailFileName,
    timeoutMessage: thumbnailTimeoutMessage, callTimeoutMessage: thumbnailCallTimeoutMessage,
  });
  const urlBase = (ctx: ContentCtx, assetId: string, round: number) => `/api/projects/${ctx.buildingId}/content/assets/${assetId}/thumbnail/rounds/${round}`;

  async function roundView(ctx: ContentCtx, asset: AssetRow, call: CallRow): Promise<ThumbnailRoundDto> {
    const { round } = call;
    const base = urlBase(ctx, asset.id, round);
    const ids = idsOf(call);
    const thumbnails = await Promise.all((await calls.roundFiles(thumbnailRoundDir(ctx, asset.conceptId, round))).map(async (f) => ({
      index: f.index, name: f.name, compositionId: ids[f.index - 1] ?? null, width: call.width, height: call.height,
      size: (await stat(f.file).catch(() => null))?.size ?? 0,
      url: `${base}/${f.name}`, downloadUrl: `${base}/${f.name}?download=1`,
    })));
    return { round, call: calls.callDto(ctx, call), thumbnails };
  }

  /** The current round's state for Finalize: the refusal, or null, and how many thumbnails its newest call made. */
  async function current(ctx: ContentCtx, asset: AssetRow): Promise<{ reason: string | null; count: number }> {
    const { state, count } = await calls.roundState(ctx, asset.id, asset.round, thumbnailRoundDir(ctx, asset.conceptId, asset.round));
    return { reason: finalizeThumbnailBlocker(state, count), count };
  }

  /** The Thumbnail tab's part of the asset's view. */
  async function part(ctx: ContentCtx, asset: AssetRow, blockedReason: string | null): Promise<ThumbnailPart> {
    calls.reconcile(ctx, asset.id);
    const final = finalOf(asset);
    const base = final && urlBase(ctx, asset.id, final.round);
    return {
      setup: setupView(ctx), blockedReason, defaultSize: { ...THUMBNAIL_SIZE },
      stills: (await thumbnailStills(ctx, asset.conceptId).catch(() => [])).map((s) => s.id),
      rounds: await Promise.all(calls.newestPerRound(ctx, asset.id).map((call) => roundView(ctx, asset, call))),
      finalizeBlocked: asset.state === 'finalized' ? null : (await current(ctx, asset)).reason,
      final: final && { ...final, url: `${base}/${final.name}`, downloadUrl: `${base}/${final.name}?download=1` },
    };
  }

  // ---- the session's tool -----------------------------------------------------------------------

  /** The checks `render_thumbnails` makes before anything is queued, then the round's old thumbnails go. Runs in the Building's write queue. */
  async function prepare(ctx: ContentCtx, session: StillSessionRef, body: { compositionIds?: unknown; width?: unknown; height?: unknown }): Promise<CallRow> {
    if (session.tab !== 'thumbnail') throw new ContentConflictError('This tool belongs to the Thumbnail tab');
    const asset = thumbnailAssetOf(ctx, session.assetId);
    const ids = parseThumbnailIds(body.compositionIds);
    const size = parseImageSize(body, THUMBNAIL_SIZE);
    calls.refuseBusy(ctx, asset.id, 'A render is already running or waiting for these thumbnails');
    // The registry must list every still file the agent wrote before the renderer bundles the project.
    await writeRegistry(ctx);
    requireOwnIds(ids, (await thumbnailStills(ctx, asset.conceptId)).map((s) => s.id), "this Concept's thumbnail stills");
    await rm(thumbnailRoundDir(ctx, asset.conceptId, session.round), { recursive: true, force: true });
    return calls.record(ctx, asset.id, session.round, ids, size);
  }

  /** Queues the call and waits for it; returns what the agent is told, or throws the failure. */
  async function run(ctx: ContentCtx, session: StillSessionRef, row: CallRow): Promise<{ round: number; thumbnails: RenderedStill[]; queued: boolean }> {
    const out = await calls.run(ctx, session.conceptId, row, thumbnailRoundDir(ctx, session.conceptId, row.round), () => deps.publish(ctx, session.conceptId, row.assetId));
    return { round: out.round, thumbnails: out.stills, queued: out.queued };
  }

  // ---- the owner's routes -----------------------------------------------------------------------

  function stopRender(ctx: ContentCtx, assetId: string, renderId: string): StillCallDto {
    thumbnailAssetOf(ctx, assetId);
    return calls.stop(ctx, assetId, renderId);
  }

  /** One rendered PNG; the name is checked against the closed file-name pattern, never joined as given. */
  async function thumbnailFile(ctx: ContentCtx, assetId: string, round: number, name: string): Promise<{ file: string; name: string }> {
    const asset = thumbnailAssetOf(ctx, assetId);
    if (!Number.isInteger(round) || round < 1 || parseThumbnailFileName(name) === null) throw new ContentNotFoundError('That thumbnail does not exist');
    const file = path.join(thumbnailRoundDir(ctx, asset.conceptId, round), name);
    await stat(file).catch(() => { throw new ContentNotFoundError('That thumbnail does not exist'); });
    return { file, name: `round-${round}-${name}` };
  }

  // ---- lifecycle hooks the agent pane calls -----------------------------------------------------

  /** The finalized content: the owner's pick (`body.file`) from the current round's finished newest call, as a one-path JSON list. */
  async function finalizeThumbnail(ctx: ContentCtx, asset: AssetRow, body: { file?: unknown }): Promise<string> {
    calls.reconcile(ctx, asset.id);
    const { reason, count } = await current(ctx, asset);
    if (reason) throw new ContentConflictError(reason);
    return JSON.stringify([thumbnailRef(asset.round, parseChosenThumbnail(body.file, count))]);
  }

  const stopForAsset = (buildingId: string, assetId: string): void => queue.stopAsset(buildingId, assetId);

  return { part, prepare, run, stopRender, thumbnailFile, finalizeThumbnail, stopForAsset };
}

export type ThumbnailStudio = ReturnType<typeof createThumbnailStudio>;
