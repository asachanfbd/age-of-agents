import { randomUUID } from 'node:crypto';

/** The shape every tracked background job shares; a registry's own job type adds its kind and progress. */
export interface TrackedJob {
  /** Unique per job, not per Building: a Building can run several jobs at once. */
  id: string;
  buildingId: string;
  status: 'running' | 'complete' | 'stopped' | 'failed';
  startedAt: string;
  error?: string;
}

/** At most one progress event per job in this window; start and end events are never held back. */
export const PROGRESS_INTERVAL_MS = 1_000;

/**
 * Long-running jobs published so the status footer can list them without their Building being open. Only running jobs are held;
 * a job leaves the registry before its end event is emitted, so a snapshot never lists a job that has ended.
 */
export function createJobRegistry<J extends TrackedJob, E>(options: { now: () => Date; event: (job: J) => E }) {
  const running = new Map<string, J>();
  const lastProgressAt = new Map<string, number>();
  const listeners = new Set<(event: E) => void>();
  const emit = (job: J) => { for (const listener of listeners) listener(options.event({ ...job })); };

  return {
    on(listener: (event: E) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    list: (): J[] => [...running.values()].map((job) => ({ ...job })),
    begin(input: Omit<J, 'id' | 'status' | 'startedAt'> & { id?: string; startedAt?: string }): string {
      const job = { ...input, id: input.id ?? randomUUID(), status: 'running', startedAt: input.startedAt ?? options.now().toISOString() } as J;
      running.set(job.id, job);
      lastProgressAt.set(job.id, options.now().getTime());
      emit(job);
      return job.id;
    },
    /** Merges `patch` into the job; the event is throttled unless `immediate` (a step few enough to send each one, or a change of phase the footer must show at once). */
    progress(id: string, patch: Partial<Omit<J, 'id' | 'status'>>, immediate = false): void {
      const job = running.get(id);
      if (!job) return;
      Object.assign(job, patch);
      const at = options.now().getTime();
      if (!immediate && at - (lastProgressAt.get(id) ?? 0) < PROGRESS_INTERVAL_MS) return;
      lastProgressAt.set(id, at);
      emit(job);
    },
    /** Removes the job, then emits its end. A job that already ended (or never began) is ignored. */
    end(id: string, status: Exclude<TrackedJob['status'], 'running'>, error?: string): void {
      const job = running.get(id);
      if (!job) return;
      running.delete(id);
      lastProgressAt.delete(id);
      emit({ ...job, status, ...(error && { error }) });
    },
  };
}
