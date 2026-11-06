import type { ExecutorLimits } from '../../src/executors/executorLimits.ts';
import type { ApiResponse, FileEntry } from '../../src/scheduler/pollDetection.ts';
import type { RunListener, RunStarter, RunState, RunStatus } from '../../src/scheduler/scheduler.ts';
import type { DetectMode, ScheduledJobRecord } from '../../src/scheduler/types.ts';

// Imports only types from src: loading a src module here would run before a test file sets its data directory.

/** A clock and a one-shot timer the test moves by hand. A timer fires only when the test calls `fire()` at or after its time. */
export function fakeClock(start: string) {
  let t = Date.parse(start);
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    set(value: string | number) { t = typeof value === 'string' ? Date.parse(value) : value; },
    advance(ms: number) { t += ms; },
    setTimer(fn: () => void, delayMs: number) {
      const id = ++nextId;
      timers.set(id, { at: t + delayMs, fn });
      return () => { timers.delete(id); };
    },
    pending: () => timers.size,
    /** When the earliest armed timer is due, or null with none armed. */
    nextTimerAt: () => (timers.size ? Math.min(...[...timers.values()].map((timer) => timer.at)) : null),
    /** Fires every timer that is due now, earliest first; returns how many fired. */
    fire() {
      const due = [...timers].filter(([, timer]) => timer.at <= t).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      return due.length;
    },
  };
}

/** A promise a test resolves by hand, to hold an operation at a chosen point. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

export interface FakeStart { runId: string; projectId: string; job: ScheduledJobRecord }

/**
 * A run starter that starts nothing real: it hands out run ids, keeps each run's state, and lets the test settle runs.
 * `capacity` is how many runs a Building may have going (unlimited unless set); `busy` holds a Building's slot the way
 * a manually started task would.
 */
export function fakeStarter(NoFreeSlotError: new () => Error) {
  const listeners = new Set<RunListener>();
  const states = new Map<string, RunState>();
  const runProject = new Map<string, string>();
  const starts: FakeStart[] = [];
  const capacity = new Map<string, number>();
  const busy = new Set<string>();
  /** Runs of a saved command: like the real starter, they take no worker slot. */
  const commandRuns = new Set<string>();
  const going = (projectId: string) => [...states].filter(([runId, state]) => runProject.get(runId) === projectId && !commandRuns.has(runId) && state.status === 'running').length;
  const fake = {
    starts, states, capacity, busy,
    /** Awaited inside every start, before it is counted: hold a start here, or move the clock to make it slow. */
    onStart: null as ((start: { projectId: string; job: ScheduledJobRecord }) => unknown) | null,
    /** The next start fails during set-up with this error. */
    failNext: null as Error | null,
    /** Fails every start during set-up. */
    failAll: null as Error | null,
    starter: {
      async start({ project, job }) {
        await fake.onStart?.({ projectId: project.id, job });
        const failure = fake.failNext ?? fake.failAll;
        fake.failNext = null;
        if (failure) throw failure;
        const usesSlot = job.target.kind !== 'command';
        if (usesSlot && (busy.has(project.id) || going(project.id) >= (capacity.get(project.id) ?? Infinity))) throw new NoFreeSlotError();
        const runId = `run-${starts.length + 1}`;
        if (!usesSlot) commandRuns.add(runId);
        states.set(runId, { status: 'running', note: null });
        runProject.set(runId, project.id);
        starts.push({ runId, projectId: project.id, job: structuredClone(job) });
        return { runId };
      },
      async state(runId) { return states.get(runId) ?? null; },
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    } satisfies RunStarter,
    /** Moves a run to a state and tells the scheduler, as the worker manager's run events do. */
    settle(runId: string, status: RunStatus, note: string | null = null) {
      states.set(runId, { status, note });
      for (const listener of listeners) listener.runChanged(runId, { status, note });
      if (status !== 'running') for (const listener of listeners) listener.slotFreed(runProject.get(runId)!);
    },
    /** Deletes a run, telling the scheduler. */
    remove(runId: string) {
      states.delete(runId);
      for (const listener of listeners) listener.runChanged(runId, null);
    },
    /** Releases a slot `busy` was holding. */
    free(projectId: string) {
      busy.delete(projectId);
      for (const listener of listeners) listener.slotFreed(projectId);
    },
    subscribers: () => listeners.size,
  };
  return fake;
}

/** A fake folder (path to [modified time, content]) and a fake HTTP endpoint, with switches to make either fail or stall. */
export function fakeSources() {
  const sources = {
    tree: {} as Record<string, [number, string]>,
    fileError: null as Error | null,
    fileReads: [] as { path: string; detect: DetectMode }[],
    response: { status: 200, body: '{}' } as ApiResponse,
    apiError: null as Error | null,
    apiCalls: [] as string[],
    /** Awaited inside every fetch, before it answers. */
    onFetch: null as (() => unknown) | null,
    /** Awaited inside every folder read, before it answers; it gets the read's abort signal. */
    onRead: null as ((signal: AbortSignal) => unknown) | null,
    async readFiles(path: string, detect: DetectMode, signal: AbortSignal): Promise<FileEntry[]> {
      sources.fileReads.push({ path, detect });
      await sources.onRead?.(signal);
      if (sources.fileError) throw sources.fileError;
      return Object.entries(sources.tree).map(([file, [mtimeMs, content]]) => ({ path: file, mtimeMs, size: content.length, ...(detect === 'hash' ? { hash: `h:${content}` } : {}) }));
    },
    async fetchApi(url: string): Promise<ApiResponse> {
      sources.apiCalls.push(url);
      await sources.onFetch?.();
      if (sources.apiError) throw sources.apiError;
      return { ...sources.response };
    },
  };
  return sources;
}

/** A usage reading: `[used percentage, reset time or null]` per window. */
export function usageReading(fiveHour: [number, string | null] | null, sevenDay: [number, string | null] | null = null): ExecutorLimits {
  const window = (value: [number, string | null] | null) => value && { usedPercentage: value[0], resetsAt: value[1] === null ? null : Date.parse(value[1]) / 1000 };
  return { observedAt: 1, fiveHour: window(fiveHour), sevenDay: window(sevenDay) };
}
