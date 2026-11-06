/**
 * One render at a time per Building, video, image and thumbnail renders alike: a FIFO per Building, with Stop for a running or waiting render and a timeout. It knows nothing
 * about storage; the caller records each outcome. Different Buildings render in parallel.
 */

/** The still renders that share the queue with the video: an image set's and a thumbnail's. */
export type StillKind = 'images' | 'thumbnail';

export type RenderOutcome = { status: 'done' } | { status: 'failed'; error: string } | { status: 'stopped' };

export interface RenderJob {
  id: string;
  buildingId: string;
  conceptId: string;
  /** What is rendered, for a waiting render's "waiting for" line. */
  kind?: StillKind | 'video';
  /** The asset the render is for, so one asset's renders can be stopped without touching the others of its Concept. */
  assetId?: string;
  /** Overrides the queue's timeout for this job. */
  timeoutMs?: number;
  /** Does the render; must stop when `signal` aborts. */
  work(signal: AbortSignal, onProgress: (frame: number, totalFrames: number) => void): Promise<void>;
  onStart(): void;
  onProgress(frame: number, totalFrames: number): void;
}

export interface RenderQueueOptions {
  timeoutMs(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

interface Entry { job: RenderJob; resolve: (outcome: RenderOutcome) => void; abort: AbortController | null; stopped: boolean }

export const timeoutMessage = (ms: number): string => `Render timed out after ${ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${ms} ms`}`;

export function createRenderQueue(options: RenderQueueOptions) {
  const lanes = new Map<string, Entry[]>();
  const lane = (buildingId: string): Entry[] => { let l = lanes.get(buildingId); if (!l) { l = []; lanes.set(buildingId, l); } return l; };

  async function runHead(buildingId: string): Promise<void> {
    const entry = lanes.get(buildingId)?.[0];
    if (!entry || entry.abort) return;
    entry.abort = new AbortController();
    let timedOut = false;
    const ms = entry.job.timeoutMs ?? options.timeoutMs();
    const cancel = options.setTimer(() => { timedOut = true; entry.abort!.abort(); }, ms);
    entry.job.onStart();
    let outcome: RenderOutcome;
    try {
      await entry.job.work(entry.abort.signal, (frame, total) => entry.job.onProgress(frame, total));
      outcome = entry.stopped ? { status: 'stopped' } : timedOut ? { status: 'failed', error: timeoutMessage(ms) } : { status: 'done' };
    } catch (error) {
      outcome = entry.stopped ? { status: 'stopped' } : { status: 'failed', error: timedOut ? timeoutMessage(ms) : (error as Error).message };
    } finally {
      cancel();
    }
    const l = lane(buildingId);
    l.splice(l.indexOf(entry), 1);
    if (!l.length) lanes.delete(buildingId);
    entry.resolve(outcome);
    void runHead(buildingId);
  }

  return {
    /** Queues the render; resolves when it has finished, failed, timed out or been stopped. */
    enqueue(job: RenderJob): Promise<RenderOutcome> {
      return new Promise((resolve) => {
        lane(job.buildingId).push({ job, resolve, abort: null, stopped: false });
        void runHead(job.buildingId);
      });
    },
    /** Stops a running render (its work is aborted) or drops a waiting one (its work never runs). False when it is not queued. */
    stop(id: string): boolean {
      for (const [buildingId, entries] of lanes) {
        const entry = entries.find((e) => e.job.id === id);
        if (!entry) continue;
        entry.stopped = true;
        if (entry.abort) { entry.abort.abort(); return true; }
        entries.splice(entries.indexOf(entry), 1);
        if (!entries.length) lanes.delete(buildingId);
        entry.resolve({ status: 'stopped' });
        return true;
      }
      return false;
    },
    /** 0 while running, 1 for the first waiting render, and so on; null when not queued. */
    position(id: string): number | null {
      for (const entries of lanes.values()) {
        const i = entries.findIndex((e) => e.job.id === id);
        if (i >= 0) return i;
      }
      return null;
    },
    /** The render now running in the Building, if any. */
    running: (buildingId: string): RenderJob | null => lanes.get(buildingId)?.[0]?.job ?? null,
    has: (id: string): boolean => [...lanes.values()].some((entries) => entries.some((e) => e.job.id === id)),
    /** Stops every render of the Building, or of one Concept in it. */
    stopWhere(buildingId: string, conceptId?: string): void {
      for (const entry of [...(lanes.get(buildingId) ?? [])]) if (!conceptId || entry.job.conceptId === conceptId) this.stop(entry.job.id);
    },
    /** Stops every render of one asset. */
    stopAsset(buildingId: string, assetId: string): void {
      for (const entry of [...(lanes.get(buildingId) ?? [])]) if (entry.job.assetId === assetId) this.stop(entry.job.id);
    },
  };
}

export type RenderQueue = ReturnType<typeof createRenderQueue>;
