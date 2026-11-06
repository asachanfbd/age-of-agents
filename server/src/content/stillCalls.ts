import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getConcept } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentNotFoundError } from './errors.ts';
import type { ImageCallState, ImageSize } from './imageRules.ts';
import { contentJobs } from './jobs.ts';
import { remotionDir } from './remotionProject.ts';
import type { RenderOutcome, RenderQueue, StillKind } from './renderQueue.ts';
import { videoDeps } from './videoDeps.ts';

/**
 * The render calls of the tabs that render still compositions to PNG (Images, Thumbnail): one row per call in `image_renders`, keyed
 * by asset id, run through the Building's one render queue (shared with the video) within the images' time limits. Each call
 * replaces its round's PNGs; the tab owns where its rounds live and what Finalize keeps.
 */

export type CallStatus = Exclude<ImageCallState, 'none'>;

export interface CallRow {
  id: string; assetId: string; round: number; status: CallStatus; compositionIds: string; width: number; height: number; done: number;
  error: string | null; createdAt: number; finishedAt: number | null;
}

export interface StillCallDto {
  id: string; status: CallStatus; compositionIds: string[]; width: number; height: number;
  /** Stills finished and asked for. */
  done: number; total: number;
  error: string | null;
  /** Queued only: 1 for the next render to start. */
  queuePosition: number | null;
  /** Queued only: what runs now in this Building. */
  waitingFor: { conceptTitle: string; kind: StillKind | 'video' } | null;
  createdAt: string; finishedAt: string | null;
}

/** What one tab's renders are called and named. */
export interface StillCallSpec {
  kind: StillKind;
  /** One still in messages: "image", "thumbnail". */
  noun: string;
  fileName(index: number): string;
  /** The 1-based index of one of this tab's file names, else null. */
  parseFileName(name: string): number | null;
  timeoutMessage(index: number, compositionId: string, ms: number): string;
  callTimeoutMessage(index: number, compositionId: string, ms: number): string;
}

/** The session record fields a render call reads. */
export interface StillSessionRef { id: string; conceptId: string; assetId: string; tab: string; round: number }

export interface RenderedStill { index: number; compositionId: string; width: number; height: number }

const INTERRUPTED = 'Interrupted by a daemon restart';
const RENDER_STOPPED = 'The render was stopped';

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
export const idsOf = (row: CallRow): string[] => JSON.parse(row.compositionIds) as string[];

export function createStillCalls(queue: RenderQueue, spec: StillCallSpec) {
  /** Calls recorded but not handed to the queue yet; a reconcile must not take them for leftovers of a restart. */
  const handingOver = new Set<string>();

  /** A call the database still calls queued or running but this process does not hold was cut off by a restart. */
  function reconcile(ctx: ContentCtx, assetId: string): void {
    for (const row of ctx.db.prepare("SELECT id, status FROM image_renders WHERE assetId = ? AND status IN ('queued', 'running')").all(assetId) as { id: string; status: CallStatus }[]) {
      if (queue.has(row.id) || handingOver.has(row.id)) continue;
      ctx.db.prepare('UPDATE image_renders SET status = ?, error = ?, finishedAt = ? WHERE id = ?').run(row.status === 'running' ? 'failed' : 'stopped', INTERRUPTED, ctx.now(), row.id);
    }
  }

  function callDto(ctx: ContentCtx, row: CallRow): StillCallDto {
    const runningJob = row.status === 'queued' ? queue.running(ctx.buildingId) : null;
    let waitingFor: StillCallDto['waitingFor'] = null;
    if (runningJob) { try { waitingFor = { conceptTitle: getConcept(ctx, runningJob.conceptId).title, kind: runningJob.kind ?? 'video' }; } catch { waitingFor = null; } }
    const ids = idsOf(row);
    return {
      id: row.id, status: row.status, compositionIds: ids, width: row.width, height: row.height, done: row.done, total: ids.length, error: row.error,
      queuePosition: row.status === 'queued' ? queue.position(row.id) : null, waitingFor,
      createdAt: iso(row.createdAt)!, finishedAt: iso(row.finishedAt),
    };
  }

  const latestCall = (ctx: ContentCtx, assetId: string, round: number): CallRow | undefined =>
    ctx.db.prepare('SELECT * FROM image_renders WHERE assetId = ? AND round = ? ORDER BY rowid DESC LIMIT 1').get(assetId, round) as CallRow | undefined;

  /** Each round's newest call, newest round first: a round's PNGs on disk are its newest call's. */
  function newestPerRound(ctx: ContentCtx, assetId: string): CallRow[] {
    const all = ctx.db.prepare('SELECT * FROM image_renders WHERE assetId = ? ORDER BY round DESC, rowid DESC').all(assetId) as CallRow[];
    return all.filter((c, i) => all.findIndex((x) => x.round === c.round) === i);
  }

  /** The rendered PNGs of a round folder, in render order. */
  async function roundFiles(dir: string): Promise<{ index: number; name: string; file: string }[]> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => spec.parseFileName(n) !== null).sort();
    return names.map((name) => ({ index: spec.parseFileName(name)!, name, file: path.join(dir, name) }));
  }

  /** The round's newest call as Finalize sees it, with how many stills it asked for; a finished call whose files went missing is no complete set. */
  async function roundState(ctx: ContentCtx, assetId: string, round: number, dir: string): Promise<{ state: ImageCallState; count: number }> {
    const call = latestCall(ctx, assetId, round);
    if (!call) return { state: 'none', count: 0 };
    const count = idsOf(call).length;
    if (call.status !== 'done') return { state: call.status, count };
    return { state: (await roundFiles(dir)).length < count ? 'failed' : 'done', count };
  }

  /** A second call is refused while one of the asset's runs or waits. */
  function refuseBusy(ctx: ContentCtx, assetId: string, message: string): void {
    reconcile(ctx, assetId);
    if (ctx.db.prepare("SELECT 1 FROM image_renders WHERE assetId = ? AND status IN ('queued', 'running')").get(assetId)) throw new ContentConflictError(message);
  }

  /** Records a checked call as queued. Runs in the Building's write queue, after `refuseBusy`. */
  function record(ctx: ContentCtx, assetId: string, round: number, ids: string[], size: ImageSize): CallRow {
    const row: CallRow = {
      id: randomUUID(), assetId, round, status: 'queued', compositionIds: JSON.stringify(ids),
      width: size.width, height: size.height, done: 0, error: null, createdAt: ctx.now(), finishedAt: null,
    };
    ctx.db.prepare('INSERT INTO image_renders (id, assetId, round, status, compositionIds, width, height, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.assetId, row.round, row.status, row.compositionIds, row.width, row.height, row.createdAt);
    handingOver.add(row.id);
    return row;
  }

  /** Renders each still in turn, within its own time limit and the call's, stopping when `signal` aborts. */
  async function renderAll(ctx: ContentCtx, row: CallRow, dir: string, signal: AbortSignal, onStill: (done: number) => void): Promise<void> {
    const ids = idsOf(row);
    const { stillTimeoutMs, callTimeoutMs } = videoDeps().imageLimits;
    const deadline = Date.now() + callTimeoutMs;
    await mkdir(dir, { recursive: true });
    for (const [i, compositionId] of ids.entries()) {
      const index = i + 1;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(spec.callTimeoutMessage(index, compositionId, callTimeoutMs));
      const perStill = new AbortController();
      const onAbort = () => perStill.abort();
      signal.addEventListener('abort', onAbort);
      let timedOut: string | null = null;
      const cancel = videoDeps().setTimer(() => {
        timedOut = stillTimeoutMs <= left ? spec.timeoutMessage(index, compositionId, stillTimeoutMs) : spec.callTimeoutMessage(index, compositionId, callTimeoutMs);
        perStill.abort();
      }, Math.min(stillTimeoutMs, left));
      try {
        await videoDeps().stillRenderer.still({ dir: remotionDir(ctx), compositionId, output: path.join(dir, spec.fileName(index)), width: row.width, height: row.height, signal: perStill.signal });
      } catch (error) {
        if (timedOut) throw new Error(timedOut);
        throw new Error(`${spec.noun} ${index} (${compositionId}): ${(error as Error).message}`);
      } finally {
        cancel();
        signal.removeEventListener('abort', onAbort);
      }
      if (timedOut) throw new Error(timedOut);
      signal.throwIfAborted();
      onStill(index);
    }
  }

  /** Queues the recorded call and waits for it, writing into `dir`; returns what the agent is told, or throws the failure. */
  async function run(ctx: ContentCtx, conceptId: string, row: CallRow, dir: string, publish: () => Promise<unknown>): Promise<{ round: number; stills: RenderedStill[]; queued: boolean }> {
    const ids = idsOf(row);
    const notify = () => publish().catch(() => undefined);
    const queued = queue.running(ctx.buildingId) !== null;
    const pending = queue.enqueue({
      id: row.id, buildingId: ctx.buildingId, conceptId, assetId: row.assetId, kind: spec.kind,
      // The call's own limits fire first; this is only a backstop.
      timeoutMs: videoDeps().imageLimits.callTimeoutMs + 10_000,
      work: (signal) => renderAll(ctx, row, dir, signal, (done) => {
        ctx.db.prepare('UPDATE image_renders SET done = ? WHERE id = ?').run(done, row.id);
        contentJobs.progress(row.id, { done }, true);
        void notify();
      }),
      onStart: () => {
        ctx.db.prepare("UPDATE image_renders SET status = 'running' WHERE id = ?").run(row.id);
        contentJobs.begin({ id: row.id, buildingId: ctx.buildingId, kind: spec.kind, conceptId, assetId: row.assetId, renderId: row.id, done: 0, total: ids.length, percent: null });
        void notify();
      },
      onProgress: () => undefined,
    });
    handingOver.delete(row.id);
    await notify();
    const outcome: RenderOutcome = await pending;
    const error = outcome.status === 'failed' ? outcome.error : outcome.status === 'stopped' ? RENDER_STOPPED : null;
    if (ctx.db.prepare('SELECT 1 FROM image_renders WHERE id = ?').get(row.id)) {
      ctx.db.prepare('UPDATE image_renders SET status = ?, error = ?, finishedAt = ? WHERE id = ?').run(outcome.status, error, ctx.now(), row.id);
      void notify();
    }
    contentJobs.end(row.id, outcome.status === 'done' ? 'complete' : outcome.status, error ?? undefined);
    if (outcome.status !== 'done') throw new ContentConflictError(outcome.status === 'stopped' ? RENDER_STOPPED : `Render failed: ${error}`);
    return { round: row.round, stills: ids.map((compositionId, i) => ({ index: i + 1, compositionId, width: row.width, height: row.height })), queued };
  }

  /** Stops one of the asset's running or waiting calls. */
  function stop(ctx: ContentCtx, assetId: string, renderId: string): StillCallDto {
    const row = ctx.db.prepare('SELECT * FROM image_renders WHERE id = ? AND assetId = ?').get(renderId, assetId) as CallRow | undefined;
    if (!row) throw new ContentNotFoundError('That render does not exist');
    if (!queue.stop(row.id)) throw new ContentConflictError('That render is not running or waiting');
    return callDto(ctx, ctx.db.prepare('SELECT * FROM image_renders WHERE id = ?').get(row.id) as CallRow);
  }

  return { reconcile, callDto, latestCall, newestPerRound, roundFiles, roundState, refuseBusy, record, run, stop };
}

export type StillCalls = ReturnType<typeof createStillCalls>;
