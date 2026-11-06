import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TerminalSessionHost } from '../terminal/terminalSessionManager.ts';
import { PROGRESS_INTERVAL_MS } from '../jobs/jobRegistry.ts';
import { conceptDir, getConcept } from './concepts.ts';
import type { AssetRow } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentNotFoundError } from './errors.ts';
import { contentJobs } from './jobs.ts';
import { compositionIdFor, isProjectReady, mediaFolderForAgent, remotionDir, setupView } from './remotionProject.ts';
import type { SetupView } from './remotionProject.ts';
import { createRenderQueue } from './renderQueue.ts';
import type { RenderOutcome } from './renderQueue.ts';
import { recordSpeakingRate } from './speakingSpeed.ts';
import { typeIntoSession } from './typeIntoSession.ts';
import { confirmBlocker, confirmMessage, isConfirmed, markConfirmed, patchChecklistItem, readChecklist, scriptChanged, setChecklist, writeChecklist } from './videoChecklist.ts';
import type { Checklist } from './videoChecklist.ts';
import { videoDeps } from './videoDeps.ts';
import { listMedia } from './videoMedia.ts';
import type { MediaItem } from './videoMedia.ts';

/**
 * The Video tab's own state around the shared agent pane (`studioSessions.ts`): the round's checklist and its Confirm, the final render
 * and its queue, and the session tools `set_checklist` and `list_media`.
 */

export type RenderStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

interface RenderRow {
  id: string; assetId: string; round: number; k: number; status: RenderStatus; compositionId: string;
  durationMs: number | null; size: number | null; error: string | null; createdAt: number; finishedAt: number | null;
}

export interface RenderDto {
  id: string; round: number; k: number; name: string; status: RenderStatus;
  /** Running only: 0 to 100, with the frame counts once the renderer reports them. */
  percent: number | null; frame: number | null; totalFrames: number | null;
  /** Queued only: 1 for the next render to start. */
  queuePosition: number | null;
  /** Queued only: the title of the Concept whose render runs now. */
  waitingFor: string | null;
  durationMs: number | null; size: number | null; error: string | null; createdAt: string; finishedAt: string | null;
  fileUrl: string | null;
}

export interface VideoPart {
  setup: SetupView;
  /** Why no session runs (no default agent, a failed start); null while one runs or is starting. */
  blockedReason: string | null;
  /** The script was finalized again after this round's session started. */
  scriptChanged: boolean;
  compositionId: string;
  checklist: Checklist;
  /** Every round's renders, newest first. */
  renders: RenderDto[];
  /** The Concept's media, newest first. */
  media: MediaItem[];
}

/** The session record fields this module reads. */
export interface VideoSessionRef { id: string; buildingId: string; conceptId: string; assetId: string; tab: string; round: number }

export interface VideoStudioDeps {
  host: TerminalSessionHost;
  /** The asset's view is rebuilt and sent to every listener. */
  publish(ctx: ContentCtx, conceptId: string, assetId: string): Promise<unknown>;
  /** The newest session record of the asset. */
  currentSession(assetId: string): Promise<VideoSessionRef | undefined>;
}

export const WAITING_FOR_CONFIRM = 'Waiting for the owner to confirm assets';
const INTERRUPTED = 'Interrupted by a daemon restart';

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
export const renderName = (k: number): string => `render-${k}.mp4`;
/** `concepts/<conceptId>/video/round-<n>/render-<k>.mp4` inside the Building's folder. */
export const renderFile = (ctx: ContentCtx, conceptId: string, round: number, k: number): string => path.join(conceptDir(ctx, conceptId), 'video', `round-${round}`, renderName(k));

/** The finalized video's file and what its render measured, or null while the video is not finalized. */
export function finalizedVideo(ctx: ContentCtx, conceptId: string): { file: string; durationMs: number | null; size: number | null } | null {
  const asset = ctx.db.prepare("SELECT content FROM assets WHERE conceptId = ? AND postId IS NULL AND kind = 'video' AND state = 'finalized'").get(conceptId) as { content: string | null } | undefined;
  const row = asset?.content ? ctx.db.prepare("SELECT round, k, durationMs, size FROM video_renders WHERE id = ? AND status = 'done'").get(asset.content) as { round: number; k: number; durationMs: number | null; size: number | null } | undefined : undefined;
  return row ? { file: renderFile(ctx, conceptId, row.round, row.k), durationMs: row.durationMs, size: row.size } : null;
}

/** The Concept's one video asset. */
export function videoAssetOf(ctx: ContentCtx, conceptId: string): AssetRow {
  getConcept(ctx, conceptId);
  const row = ctx.db.prepare("SELECT * FROM assets WHERE conceptId = ? AND kind = 'video' AND postId IS NULL").get(conceptId) as AssetRow | undefined;
  if (!row) throw new ContentNotFoundError('This Concept has no video');
  return row;
}

const rendersOf = (ctx: ContentCtx, assetId: string): RenderRow[] =>
  ctx.db.prepare('SELECT * FROM video_renders WHERE assetId = ? ORDER BY round DESC, k DESC').all(assetId) as RenderRow[];

export function createVideoStudio(deps: VideoStudioDeps) {
  const queue = createRenderQueue({ timeoutMs: () => videoDeps().limits.renderTimeoutMs, setTimer: (fn, ms) => videoDeps().setTimer(fn, ms) });
  const progress = new Map<string, { frame: number; totalFrames: number }>();
  /** Renders recorded but not handed to the queue yet; a reconcile must not take them for leftovers of a restart. */
  const handingOver = new Set<string>();
  const lastPublish = new Map<string, number>();

  /** A render the database still calls queued or running but this process does not hold was cut off by a restart. */
  function reconcile(ctx: ContentCtx, assetId: string): void {
    for (const row of ctx.db.prepare("SELECT id, status FROM video_renders WHERE assetId = ? AND status IN ('queued', 'running')").all(assetId) as { id: string; status: RenderStatus }[]) {
      if (queue.has(row.id) || handingOver.has(row.id)) continue;
      ctx.db.prepare('UPDATE video_renders SET status = ?, error = ?, finishedAt = ? WHERE id = ?').run(row.status === 'running' ? 'failed' : 'stopped', INTERRUPTED, ctx.now(), row.id);
    }
  }

  function renderDto(ctx: ContentCtx, conceptId: string, row: RenderRow): RenderDto {
    const live = progress.get(row.id);
    const position = row.status === 'queued' ? queue.position(row.id) : null;
    const runningJob = row.status === 'queued' ? queue.running(ctx.buildingId) : null;
    let waitingFor: string | null = null;
    if (runningJob) { try { waitingFor = getConcept(ctx, runningJob.conceptId).title; } catch { waitingFor = null; } }
    return {
      id: row.id, round: row.round, k: row.k, name: renderName(row.k), status: row.status,
      percent: row.status === 'running' ? (live ? Math.floor((live.frame / live.totalFrames) * 100) : 0) : null,
      frame: row.status === 'running' ? live?.frame ?? null : null, totalFrames: row.status === 'running' ? live?.totalFrames ?? null : null,
      queuePosition: position, waitingFor,
      durationMs: row.durationMs, size: row.size, error: row.error, createdAt: iso(row.createdAt)!, finishedAt: iso(row.finishedAt),
      fileUrl: row.status === 'done' ? `/api/projects/${ctx.buildingId}/content/concepts/${conceptId}/video/renders/${row.id}/file` : null,
    };
  }

  /** The Video tab's part of the asset's view. */
  function part(ctx: ContentCtx, conceptId: string, asset: AssetRow, blockedReason: string | null): VideoPart {
    reconcile(ctx, asset.id);
    const round = Math.max(asset.round, 1);
    return {
      setup: setupView(ctx), blockedReason, scriptChanged: scriptChanged(ctx, asset.id, round),
      compositionId: compositionIdFor(ctx, conceptId),
      checklist: readChecklist(ctx, asset.id, round),
      renders: rendersOf(ctx, asset.id).map((r) => renderDto(ctx, conceptId, r)),
      media: listMedia(ctx, conceptId),
    };
  }

  const publishVideo = (ctx: ContentCtx, conceptId: string) => deps.publish(ctx, conceptId, videoAssetOf(ctx, conceptId).id);

  // ---- the owner's routes ---------------------------------------------------------------------

  async function currentRound(ctx: ContentCtx, conceptId: string): Promise<{ asset: AssetRow; round: number }> {
    const asset = videoAssetOf(ctx, conceptId);
    return { asset, round: Math.max(asset.round, 1) };
  }

  async function checklist(ctx: ContentCtx, conceptId: string): Promise<Checklist> {
    const { asset, round } = await currentRound(ctx, conceptId);
    return readChecklist(ctx, asset.id, round);
  }

  async function patchItem(ctx: ContentCtx, conceptId: string, itemId: string, body: unknown): Promise<Checklist> {
    const { asset, round } = await currentRound(ctx, conceptId);
    if (asset.state === 'finalized') throw new ContentConflictError('The video is finalized. Reopen it to change the checklist.');
    const list = patchChecklistItem(ctx, asset.id, round, itemId, body, listMedia(ctx, conceptId).map((m) => m.id));
    await deps.publish(ctx, conceptId, asset.id);
    return list;
  }

  /**
   * Locks the checklist and pastes the asset message into the agent's terminal, then presses Enter (see `typeIntoSession`).
   */
  async function confirm(ctx: ContentCtx, conceptId: string): Promise<Checklist> {
    const { asset, round } = await currentRound(ctx, conceptId);
    if (asset.state === 'finalized') throw new ContentConflictError('The video is finalized');
    const list = readChecklist(ctx, asset.id, round);
    const blocker = confirmBlocker(list);
    if (blocker) throw new ContentConflictError(blocker);
    const session = await deps.currentSession(asset.id);
    if (!session || session.round !== round || !deps.host.has(session.id)) throw new ContentConflictError('The agent session has ended. Resume it, then confirm.');
    markConfirmed(ctx, asset.id, round);
    await typeIntoSession(deps.host, session.id, confirmMessage(mediaFolderForAgent(conceptId), listMedia(ctx, conceptId), list.items), videoDeps().submitDelayMs);
    await deps.publish(ctx, conceptId, asset.id);
    return readChecklist(ctx, asset.id, round);
  }

  function renderRow(ctx: ContentCtx, assetId: string, renderId: string): RenderRow {
    const row = ctx.db.prepare('SELECT * FROM video_renders WHERE id = ? AND assetId = ?').get(renderId, assetId) as RenderRow | undefined;
    if (!row) throw new ContentNotFoundError('That render does not exist');
    return row;
  }

  async function renders(ctx: ContentCtx, conceptId: string): Promise<{ renders: RenderDto[] }> {
    const asset = videoAssetOf(ctx, conceptId);
    reconcile(ctx, asset.id);
    return { renders: rendersOf(ctx, asset.id).map((r) => renderDto(ctx, conceptId, r)) };
  }

  async function renderFileOf(ctx: ContentCtx, conceptId: string, renderId: string): Promise<{ file: string; name: string }> {
    const row = renderRow(ctx, videoAssetOf(ctx, conceptId).id, renderId);
    if (row.status !== 'done') throw new ContentNotFoundError('That render has no file');
    const file = renderFile(ctx, conceptId, row.round, row.k);
    await stat(file).catch(() => { throw new ContentNotFoundError('That render file is missing on disk'); });
    return { file, name: `round-${row.round}-${renderName(row.k)}` };
  }

  async function stopRender(ctx: ContentCtx, conceptId: string, renderId: string): Promise<RenderDto> {
    const row = renderRow(ctx, videoAssetOf(ctx, conceptId).id, renderId);
    if (!queue.stop(row.id)) throw new ContentConflictError('That render is not running or waiting');
    return renderDto(ctx, conceptId, renderRow(ctx, row.assetId, row.id));
  }

  // ---- the session's tools ---------------------------------------------------------------------

  const requireVideoSession = (session: VideoSessionRef): void => {
    if (session.tab !== 'video') throw new ContentConflictError('This tool belongs to the Video tab');
  };

  function toolSetChecklist(ctx: ContentCtx, session: VideoSessionRef, items: unknown): Checklist {
    requireVideoSession(session);
    return setChecklist(ctx, session.assetId, session.round, items);
  }

  /** `report_speaking_rate`: what the agent measured in one of the Concept's audio or video files. */
  function toolReportSpeakingRate(ctx: ContentCtx, session: VideoSessionRef, body: Record<string, unknown>) {
    requireVideoSession(session);
    return recordSpeakingRate(ctx, session.conceptId, body);
  }

  /** `list_media` (video, images and thumbnail): every file with what the agent needs to use it, and (video only) the checklist items each is linked to. */
  function toolListMedia(ctx: ContentCtx, session: VideoSessionRef) {
    if (session.tab !== 'images' && session.tab !== 'thumbnail') requireVideoSession(session);
    const items = session.tab === 'video' ? readChecklist(ctx, session.assetId, session.round).items : [];
    return {
      folder: mediaFolderForAgent(session.conceptId),
      media: listMedia(ctx, session.conceptId).map((m) => ({
        id: m.id, name: m.name, kind: m.kind, size: m.size, durationMs: m.durationMs, width: m.width, height: m.height, path: m.path,
        checklistItems: items.filter((i) => i.mediaIds.includes(m.id)).map((i) => i.id),
      })),
    };
  }

  /** Renders recorded and queued that have not ended yet; tests wait on them. */
  const pending = new Set<Promise<void>>();

  /**
   * Finalize's render: checks, records and queues the Concept's composition for the asset's round, then returns without
   * waiting. `onDone` runs once the render has succeeded; a failed or stopped render only leaves its row (and error) behind,
   * so the asset stays drafting. Runs in the Building's write queue.
   */
  function startFinalRender(ctx: ContentCtx, conceptId: string, asset: AssetRow, onDone: (renderId: string) => Promise<void>): void {
    reconcile(ctx, asset.id);
    const round = Math.max(asset.round, 1);
    if (!isConfirmed(ctx, asset.id, round)) throw new ContentConflictError(WAITING_FOR_CONFIRM);
    if (!isProjectReady(ctx)) throw new ContentConflictError('Remotion is still being set up.');
    if (rendersOf(ctx, asset.id).some((r) => r.status === 'queued' || r.status === 'running')) throw new ContentConflictError('Finalize waits until the render finishes or is stopped.');
    const k = (ctx.db.prepare('SELECT COALESCE(MAX(k), 0) + 1 AS n FROM video_renders WHERE assetId = ? AND round = ?').get(asset.id, round) as { n: number }).n;
    const row: RenderRow = { id: randomUUID(), assetId: asset.id, round, k, status: 'queued', compositionId: compositionIdFor(ctx, conceptId), durationMs: null, size: null, error: null, createdAt: ctx.now(), finishedAt: null };
    ctx.db.prepare('INSERT INTO video_renders (id, assetId, round, k, status, compositionId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.assetId, row.round, row.k, row.status, row.compositionId, row.createdAt);
    handingOver.add(row.id);
    const tracked: Promise<void> = runRender(ctx, conceptId, row).then((done) => (done ? onDone(row.id) : undefined)).catch(() => undefined).finally(() => { pending.delete(tracked); });
    pending.add(tracked);
  }

  /** Queues the render and waits for it; true when it succeeded. The row and the footer job record every outcome. */
  async function runRender(ctx: ContentCtx, conceptId: string, row: RenderRow): Promise<boolean> {
    const output = renderFile(ctx, conceptId, row.round, row.k);
    const outcome = await enqueueRender(ctx, conceptId, row, output);
    progress.delete(row.id);
    lastPublish.delete(row.id);
    let durationMs: number | null = null, size: number | null = null;
    if (outcome.status === 'done') {
      size = (await stat(output).catch(() => null))?.size ?? null;
      durationMs = (await videoDeps().prober.probe(remotionDir(ctx), output, 'video').catch(() => null))?.durationMs ?? null;
    } else {
      await rm(output, { force: true });
    }
    const error = outcome.status === 'failed' ? outcome.error : outcome.status === 'stopped' ? 'The render was stopped' : null;
    const stillThere = ctx.db.prepare('SELECT 1 FROM video_renders WHERE id = ?').get(row.id);
    if (stillThere) {
      ctx.db.prepare('UPDATE video_renders SET status = ?, error = ?, durationMs = ?, size = ?, finishedAt = ? WHERE id = ?').run(outcome.status, error, durationMs, size, ctx.now(), row.id);
      void publishVideo(ctx, conceptId).catch(() => undefined);
    }
    contentJobs.end(row.id, outcome.status === 'done' ? 'complete' : outcome.status, error ?? undefined);
    return outcome.status === 'done' && !!stillThere;
  }

  function enqueueRender(ctx: ContentCtx, conceptId: string, row: RenderRow, output: string): Promise<RenderOutcome> {
    const pendingOutcome = queue.enqueue({
      id: row.id, buildingId: ctx.buildingId, conceptId, assetId: row.assetId, kind: 'video',
      work: async (signal, onProgress) => {
        await mkdir(path.dirname(output), { recursive: true });
        await videoDeps().renderer.render({ dir: remotionDir(ctx), compositionId: row.compositionId, output, signal, onProgress });
      },
      onStart: () => {
        ctx.db.prepare("UPDATE video_renders SET status = 'running' WHERE id = ?").run(row.id);
        contentJobs.begin({ id: row.id, buildingId: ctx.buildingId, kind: 'render', conceptId, renderId: row.id, percent: 0 });
        void publishVideo(ctx, conceptId).catch(() => undefined);
      },
      onProgress: (frame, totalFrames) => {
        progress.set(row.id, { frame, totalFrames });
        contentJobs.progress(row.id, { percent: Math.floor((frame / totalFrames) * 100) });
        const now = Date.now();
        if (now - (lastPublish.get(row.id) ?? 0) < PROGRESS_INTERVAL_MS) return;
        lastPublish.set(row.id, now);
        void publishVideo(ctx, conceptId).catch(() => undefined);
      },
    });
    handingOver.delete(row.id);
    void publishVideo(ctx, conceptId).catch(() => undefined);
    return pendingOutcome;
  }

  // ---- lifecycle hooks the agent pane calls -------------------------------------------------------

  /** Whether the render is a finished one of this asset. */
  const doneRender = (ctx: ContentCtx, assetId: string, renderId: string): boolean =>
    !!ctx.db.prepare("SELECT 1 FROM video_renders WHERE id = ? AND assetId = ? AND status = 'done'").get(renderId, assetId);

  const stopForConcept = (buildingId: string, conceptId: string): void => queue.stopWhere(buildingId, conceptId);
  const stopForAsset = (buildingId: string, assetId: string): void => queue.stopAsset(buildingId, assetId);
  const stopForBuilding = (buildingId: string): void => queue.stopWhere(buildingId);

  /** A reopened round starts with the finalized round's checklist, ticks and links kept, not confirmed. */
  function carryChecklist(ctx: ContentCtx, assetId: string, fromRound: number, toRound: number): void {
    writeChecklist(ctx, assetId, toRound, readChecklist(ctx, assetId, fromRound).items);
  }

  return {
    part, checklist, patchItem, confirm, renders, renderFileOf, stopRender,
    toolSetChecklist, toolReportSpeakingRate, toolListMedia, startFinalRender, doneRender, settled: () => Promise.all([...pending]).then(() => undefined),
    stopForConcept, stopForAsset, stopForBuilding, carryChecklist, publishVideo,
    /** The Building's one render queue, shared with the Images tab's still renders. */
    queue,
  };
}

export type VideoStudio = ReturnType<typeof createVideoStudio>;
