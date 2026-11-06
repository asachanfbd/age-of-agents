import { ApiError, serverApi } from '../lib/serverApi';
import type { HistoryPage, JobHistoryEntry, JobRequest, SchedulesView } from '../lib/schedules';

/**
 * The Schedules area's part of the world store: each Building's jobs, each opened job's history, and the actions the
 * panel and the editor call. A refused change (400 with a field, 409 with a reason) is handed back to the caller to
 * show where it happened, so it never becomes a notification.
 */

export type ScheduleResult = { ok: true } | { ok: false; status: number; error: string; field: string | null };
export type RunNowResult = ScheduleResult & { queued?: boolean };

export interface SchedulesState {
  /** Keyed by Building id; absent until `loadSchedules` has answered for that Building. */
  schedulesByProject: Record<string, SchedulesView>;
  scheduleLoadErrorByProject: Record<string, string>;
  /** Keyed by job id; only jobs whose history was opened. */
  scheduleHistoryByJob: Record<string, HistoryPage>;
  /** A refused Run now, shown on that job until the next action. */
  scheduleRunErrorByJob: Record<string, string>;
  loadSchedules: (projectId: string) => Promise<void>;
  createScheduleJob: (projectId: string, job: JobRequest) => Promise<ScheduleResult>;
  updateScheduleJob: (projectId: string, jobId: string, patch: JobRequest) => Promise<ScheduleResult>;
  deleteScheduleJob: (projectId: string, jobId: string) => Promise<ScheduleResult>;
  runScheduleJobNow: (projectId: string, jobId: string) => Promise<RunNowResult>;
  setScheduleTimezone: (projectId: string, timezone: string | null) => Promise<ScheduleResult>;
  restoreScheduleDefaults: (projectId: string) => Promise<ScheduleResult>;
  /** Loads a job's newest history page, or with `more` the page after what is already loaded. */
  loadScheduleHistory: (projectId: string, jobId: string, options?: { more?: boolean }) => Promise<void>;
}

type Set = (partial: Partial<SchedulesState> | ((state: SchedulesState) => Partial<SchedulesState>)) => void;

function failure(error: unknown): ScheduleResult & { ok: false } {
  const field = error instanceof ApiError && typeof error.details.field === 'string' ? error.details.field : null;
  return { ok: false, status: error instanceof ApiError ? error.status : 0, error: error instanceof Error ? error.message : 'The request failed', field };
}

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/** New entries first, then the ones already loaded, each id once. */
function mergeEntries(loaded: readonly JobHistoryEntry[], incoming: readonly JobHistoryEntry[]): JobHistoryEntry[] {
  const byId = new Map([...loaded, ...incoming].map((entry) => [entry.id, entry]));
  return [...byId.values()].sort((a, b) => b.seq - a.seq);
}

export type ScheduleEvent =
  | { type: 'schedules'; projectId: string; schedules: SchedulesView }
  | { type: 'scheduleEntry'; projectId: string; jobId: string; entry: JobHistoryEntry };

/** Folds a live schedule event in. Only what is already loaded is kept up to date; an event for anything else is dropped. */
export function mergeScheduleEvent(state: Partial<Pick<SchedulesState, 'schedulesByProject' | 'scheduleHistoryByJob'>>, event: ScheduleEvent): Partial<SchedulesState> {
  const { schedulesByProject = {}, scheduleHistoryByJob = {} } = state;
  if (event.type === 'schedules') {
    if (!schedulesByProject[event.projectId]) return {};
    const jobIds = new Set(event.schedules.jobs.map((job) => job.id));
    // The history of a job that is gone goes with it.
    const remaining = Object.fromEntries(Object.entries(scheduleHistoryByJob)
      .filter(([jobId, page]) => jobIds.has(jobId) || page.entries.every((entry) => entry.projectId !== event.projectId)));
    return { schedulesByProject: { ...schedulesByProject, [event.projectId]: event.schedules }, scheduleHistoryByJob: remaining };
  }
  const page = scheduleHistoryByJob[event.jobId];
  if (!page) return {};
  return { scheduleHistoryByJob: { ...scheduleHistoryByJob, [event.jobId]: { ...page, entries: mergeEntries(page.entries, [event.entry]) } } };
}

export function createSchedulesSlice(set: Set, get: () => SchedulesState): SchedulesState {
  const storeView = (view: SchedulesView) => set((state) => ({
    schedulesByProject: { ...state.schedulesByProject, [view.projectId]: view },
    scheduleLoadErrorByProject: without(state.scheduleLoadErrorByProject, view.projectId),
  }));
  /** Runs one change: clears any refused Run now first, re-reads the Building's jobs after, and reports a refusal back. */
  const change = async (projectId: string, call: () => Promise<unknown>): Promise<ScheduleResult> => {
    set({ scheduleRunErrorByJob: {} });
    try {
      await call();
      storeView(await serverApi.getSchedules(projectId));
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  };

  return {
    schedulesByProject: {},
    scheduleLoadErrorByProject: {},
    scheduleHistoryByJob: {},
    scheduleRunErrorByJob: {},

    loadSchedules: async (projectId) => {
      try {
        // Stored under the Building the request was for, so a reply that arrives after switching Buildings lands on its own.
        storeView(await serverApi.getSchedules(projectId));
      } catch (error) {
        set((state) => ({ scheduleLoadErrorByProject: { ...state.scheduleLoadErrorByProject, [projectId]: failure(error).error } }));
      }
    },

    createScheduleJob: (projectId, job) => change(projectId, () => serverApi.createScheduleJob(projectId, job)),
    updateScheduleJob: (projectId, jobId, patch) => change(projectId, () => serverApi.updateScheduleJob(projectId, jobId, patch)),
    setScheduleTimezone: (projectId, timezone) => change(projectId, () => serverApi.setScheduleTimezone(projectId, timezone)),
    restoreScheduleDefaults: (projectId) => change(projectId, () => serverApi.restoreScheduleDefaults(projectId)),

    deleteScheduleJob: async (projectId, jobId) => {
      const result = await change(projectId, () => serverApi.deleteScheduleJob(projectId, jobId));
      if (result.ok) set((state) => ({ scheduleHistoryByJob: without(state.scheduleHistoryByJob, jobId) }));
      return result;
    },

    runScheduleJobNow: async (projectId, jobId) => {
      let queued = false;
      const result = await change(projectId, async () => {
        const started = await serverApi.runScheduleJobNow(projectId, jobId);
        queued = started.entry.outcome === 'queued';
        set((state) => mergeScheduleEvent(state, { type: 'scheduleEntry', projectId, jobId, entry: started.entry }));
      });
      if (result.ok) return { ok: true, queued };
      if (result.status === 409) {
        // Shown on the job itself, not as a toast, so the reason stays visible.
        set({ scheduleRunErrorByJob: { [jobId]: result.error } });
        // A start that failed at set-up left a failed entry and may have switched the job off: show both.
        await get().loadSchedules(projectId);
        if (get().scheduleHistoryByJob[jobId]) await get().loadScheduleHistory(projectId, jobId);
      }
      return result;
    },

    loadScheduleHistory: async (projectId, jobId, options = {}) => {
      const loaded = options.more ? get().scheduleHistoryByJob[jobId] : undefined;
      if (options.more && !loaded?.nextCursor) return;
      try {
        const page = await serverApi.getScheduleHistory(projectId, jobId, loaded?.nextCursor ?? undefined);
        set((state) => ({ scheduleHistoryByJob: { ...state.scheduleHistoryByJob, [jobId]: { entries: mergeEntries(loaded?.entries ?? [], page.entries), nextCursor: page.nextCursor } } }));
      } catch (error) {
        set((state) => ({ scheduleLoadErrorByProject: { ...state.scheduleLoadErrorByProject, [projectId]: failure(error).error } }));
      }
    },
  };
}
