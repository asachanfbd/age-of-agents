import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { ContentConflictError } from './errors.ts';
import { contentJobs } from './jobs.ts';
import { STUDIO_IDLE_MS, STUDIO_LOG_EVENT_MS, STUDIO_LOG_LINE_MAX, STUDIO_LOG_LINES, STUDIO_START_TIMEOUT_MS } from './limits.ts';
import { ensureProject, remotionDir, setupView } from './remotionProject.ts';
import type { SetupView } from './remotionProject.ts';
import { remotionBin } from './videoDeps.ts';

/**
 * Remotion Studio for the Remotion tab: at most one process per Building, serving the shared project on a free port of
 * 127.0.0.1. It is a tracked `remotion-studio` job, and stops on Stop, when no Remotion tab has sent a heartbeat for
 * `STUDIO_IDLE_MS`, when the Building is deleted, and on daemon shutdown. Nothing is kept across a daemon restart.
 */

export type StudioState = 'stopped' | 'starting' | 'running' | 'failed';
export interface StudioView {
  state: StudioState;
  /** `http://127.0.0.1:<port>` while running; the web appends the composition id. */
  url: string | null;
  error: string | null;
  /** The newest lines Studio printed, ANSI colours removed. */
  log: string[];
  /** Starting, but waiting for the project's dependency install first. */
  waitingForSetup: boolean;
}
export interface StudioEvent { type: 'remotionStudio'; buildingId: string; studio: StudioView }

export interface StudioProcess { kill(): void }
export interface StudioSpawnRequest {
  dir: string;
  port: number;
  onOutput(text: string, stream: 'stdout' | 'stderr'): void;
  /** Called once when the process ends, or could not start (`error`). */
  onExit(code: number | null, error?: Error): void;
}
export interface StudioSpawner { spawn(request: StudioSpawnRequest): StudioProcess }

export interface StudioDeps {
  spawner: StudioSpawner;
  findPort(): Promise<number>;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  setup: { view(ctx: ContentCtx): SetupView; ensure(ctx: ContentCtx): Promise<boolean> };
  startTimeoutMs: number;
  idleMs: number;
}

export const STUDIO_HOST = '127.0.0.1';
export const NEEDS_VIDEO_SESSION = 'Start the video in the Video tab first';
export const READ_ONLY_NEEDS_INSTALL = "Studio can't start: this Building is read-only and the Remotion project still needs its packages installed.";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** Studio prints "Server ready - Local: http://localhost:<port>, Network: …" once it serves; only a line naming our port counts. */
export function isReadyLine(line: string, port: number): boolean {
  const plain = stripAnsi(line);
  if (!/\bServer ready\b/.test(plain)) return false;
  return [...plain.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g)].some((m) => Number(m[1]) === port);
}

const validPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65_535;

interface Entry {
  view: StudioView;
  /** Bumped by every start and stop, so callbacks of an earlier process are ignored. */
  generation: number;
  child: StudioProcess | null;
  port: number | null;
  jobId: string | null;
  partial: { stdout: string; stderr: string };
  cancelIdle: (() => void) | null;
  cancelStartTimeout: (() => void) | null;
  cancelLogEvent: (() => void) | null;
}

const stoppedView = (): StudioView => ({ state: 'stopped', url: null, error: null, log: [], waitingForSetup: false });

export function createRemotionStudios(deps: StudioDeps) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: StudioEvent) => void>();

  const viewOf = (entry: Entry | undefined): StudioView => (entry ? { ...entry.view, log: [...entry.view.log] } : stoppedView());
  function emit(buildingId: string): void {
    const entry = entries.get(buildingId);
    entry?.cancelLogEvent?.();
    if (entry) entry.cancelLogEvent = null;
    const event: StudioEvent = { type: 'remotionStudio', buildingId, studio: viewOf(entry) };
    for (const listener of listeners) listener(event);
  }
  /** Log lines alone are published at most once per `STUDIO_LOG_EVENT_MS`. */
  function emitLogSoon(buildingId: string, entry: Entry): void {
    if (entry.cancelLogEvent) return;
    entry.cancelLogEvent = deps.setTimer(() => { entry.cancelLogEvent = null; emit(buildingId); }, STUDIO_LOG_EVENT_MS);
  }

  function clearTimers(entry: Entry): void {
    entry.cancelIdle?.(); entry.cancelIdle = null;
    entry.cancelStartTimeout?.(); entry.cancelStartTimeout = null;
  }
  function armIdle(buildingId: string, entry: Entry): void {
    entry.cancelIdle?.();
    entry.cancelIdle = deps.setTimer(() => { entry.cancelIdle = null; stop(buildingId); }, deps.idleMs);
  }

  function appendOutput(entry: Entry, text: string, stream: 'stdout' | 'stderr'): string[] {
    const parts = (entry.partial[stream] + text).split(/\r?\n/);
    entry.partial[stream] = parts.pop()!;
    const lines = parts.map((line) => stripAnsi(line).slice(0, STUDIO_LOG_LINE_MAX));
    entry.view.log = [...entry.view.log, ...lines].slice(-STUDIO_LOG_LINES);
    return lines;
  }

  function fail(buildingId: string, entry: Entry, error: string): void {
    entry.generation++;
    entry.child?.kill();
    entry.child = null;
    clearTimers(entry);
    entry.view = { ...entry.view, state: 'failed', url: null, error, waitingForSetup: false };
    if (entry.jobId) contentJobs.end(entry.jobId, 'failed', error);
    entry.jobId = null;
    emit(buildingId);
  }

  async function launch(ctx: ContentCtx, entry: Entry, generation: number): Promise<void> {
    const { buildingId } = ctx;
    const current = () => entry.generation === generation;
    if (entry.view.waitingForSetup) {
      const ready = await deps.setup.ensure(ctx);
      if (!current()) return;
      if (!ready) { fail(buildingId, entry, deps.setup.view(ctx).error ?? 'Remotion setup failed'); return; }
      entry.view.waitingForSetup = false;
      emit(buildingId);
    }
    let port: number;
    try {
      port = await deps.findPort();
    } catch (error) {
      if (current()) fail(buildingId, entry, `No free port for Remotion Studio: ${(error as Error).message}`);
      return;
    }
    if (!current()) return;
    if (!validPort(port)) { fail(buildingId, entry, `No free port for Remotion Studio: ${String(port)} is not a port`); return; }
    entry.port = port;
    const onOutput = (text: string, stream: 'stdout' | 'stderr') => {
      if (!current()) return;
      const lines = appendOutput(entry, text, stream);
      if (entry.view.state === 'starting' && lines.some((line) => isReadyLine(line, port))) {
        entry.cancelStartTimeout?.(); entry.cancelStartTimeout = null;
        entry.view = { ...entry.view, state: 'running', url: `http://${STUDIO_HOST}:${port}`, error: null };
        if (entry.jobId) contentJobs.progress(entry.jobId, { phase: 'running' }, true);
        emit(buildingId);
      } else if (lines.length) emitLogSoon(buildingId, entry);
    };
    const onExit = (code: number | null, error?: Error) => {
      if (!current()) return;
      entry.child = null;
      const message = error
        ? `Remotion Studio could not start: ${error.message}`
        : entry.view.state === 'running' ? `Remotion Studio stopped unexpectedly (exit code ${code})` : `Remotion Studio exited with code ${code} before it was ready`;
      fail(buildingId, entry, message);
    };
    try {
      entry.child = deps.spawner.spawn({ dir: remotionDir(ctx), port, onOutput, onExit });
    } catch (error) {
      fail(buildingId, entry, `Remotion Studio could not start: ${(error as Error).message}`);
      return;
    }
    if (!current()) return;
    entry.cancelStartTimeout = deps.setTimer(() => {
      entry.cancelStartTimeout = null;
      if (current() && entry.view.state === 'starting') fail(buildingId, entry, `Remotion Studio did not start within ${Math.round(deps.startTimeoutMs / 1000)} seconds`);
    }, deps.startTimeoutMs);
  }

  /**
   * Starts Studio, or reuses the one that is starting or running. 409 while the Building has no Remotion project yet, and on
   * a read-only Building whose project still needs its install. A writable one runs (or waits for) the install first.
   */
  function start(ctx: ContentCtx, options: { readOnly: boolean }): StudioView {
    const { buildingId } = ctx;
    const known = entries.get(buildingId);
    if (known && (known.view.state === 'starting' || known.view.state === 'running')) {
      armIdle(buildingId, known);
      return viewOf(known);
    }
    if (!existsSync(path.join(remotionDir(ctx), 'src', 'index.ts'))) throw new ContentConflictError(NEEDS_VIDEO_SESSION);
    const setup = deps.setup.view(ctx);
    if (options.readOnly && setup.status !== 'ready') throw new ContentConflictError(READ_ONLY_NEEDS_INSTALL);
    const entry: Entry = known ?? { view: stoppedView(), generation: 0, child: null, port: null, jobId: null, partial: { stdout: '', stderr: '' }, cancelIdle: null, cancelStartTimeout: null, cancelLogEvent: null };
    entries.set(buildingId, entry);
    const generation = ++entry.generation;
    entry.partial = { stdout: '', stderr: '' };
    entry.port = null;
    entry.view = { state: 'starting', url: null, error: null, log: [], waitingForSetup: setup.status !== 'ready' };
    entry.jobId = contentJobs.begin({ buildingId, kind: 'remotion-studio', percent: null, phase: 'starting' });
    armIdle(buildingId, entry);
    emit(buildingId);
    void launch(ctx, entry, generation);
    return viewOf(entry);
  }

  /** Stops Studio; a no-op when it is not starting or running. */
  function stop(buildingId: string): StudioView {
    const entry = entries.get(buildingId);
    if (!entry || (entry.view.state !== 'starting' && entry.view.state !== 'running')) return viewOf(entry);
    entry.generation++;
    entry.child?.kill();
    entry.child = null;
    clearTimers(entry);
    entry.view = { ...entry.view, state: 'stopped', url: null, error: null, waitingForSetup: false };
    if (entry.jobId) contentJobs.end(entry.jobId, 'stopped');
    entry.jobId = null;
    emit(buildingId);
    return viewOf(entry);
  }

  /** A Remotion tab is visible: the idle timer starts again. Starts nothing. */
  function heartbeat(buildingId: string): StudioView {
    const entry = entries.get(buildingId);
    if (entry && (entry.view.state === 'starting' || entry.view.state === 'running')) armIdle(buildingId, entry);
    return viewOf(entry);
  }

  /** The Building is being deleted: Studio stops and is forgotten. */
  function forget(buildingId: string): void {
    stop(buildingId);
    const entry = entries.get(buildingId);
    entry?.cancelLogEvent?.();
    entries.delete(buildingId);
  }

  /** Daemon shutdown: synchronous, for the process 'exit' handler. */
  function killAll(): void {
    for (const entry of entries.values()) {
      entry.generation++;
      entry.child?.kill();
      entry.child = null;
    }
  }

  return {
    view: (buildingId: string): StudioView => viewOf(entries.get(buildingId)),
    start, stop, heartbeat, forget, killAll,
    onEvent(listener: (event: StudioEvent) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type RemotionStudios = ReturnType<typeof createRemotionStudios>;

/** A free TCP port on 127.0.0.1, found by binding port 0 there and letting it go. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, STUDIO_HOST, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const LOOPBACK_PRELOAD = path.join(import.meta.dirname, 'studioLoopback.cjs');

/**
 * `remotion studio` in its own process group (so stopping it also ends the bundler it starts), without opening a browser, and
 * with `--force-new` so a Studio left over from another process is never reused. Studio has no host option, so the
 * `studioLoopback.cjs` preload binds it to 127.0.0.1.
 */
export const remotionStudioSpawner: StudioSpawner = {
  spawn({ dir, port, onOutput, onExit }) {
    const ownGroup = process.platform !== 'win32';
    const child = spawn(remotionBin(dir), ['studio', 'src/index.ts', `--port=${port}`, '--no-open', '--force-new'], {
      cwd: dir,
      detached: ownGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development', BROWSER: 'none', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(LOOPBACK_PRELOAD)}`.trim() },
    });
    let ended = false;
    const end = (code: number | null, error?: Error) => { if (!ended) { ended = true; onExit(code, error); } };
    child.stdout.on('data', (chunk: Buffer) => onOutput(chunk.toString(), 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => onOutput(chunk.toString(), 'stderr'));
    child.on('error', (error) => end(null, error));
    child.on('close', (code) => end(code));
    return {
      kill() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (ownGroup && child.pid) process.kill(-child.pid, 'SIGTERM');
          else child.kill();
        } catch { child.kill(); }
      },
    };
  },
};

const defaults = (): StudioDeps => ({
  spawner: remotionStudioSpawner,
  findPort: findFreePort,
  setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); },
  setup: { view: setupView, ensure: (ctx) => ensureProject(ctx) },
  startTimeoutMs: STUDIO_START_TIMEOUT_MS,
  idleMs: STUDIO_IDLE_MS,
});

let deps = defaults();
/** The daemon's one instance; its pieces are replaceable for tests through `configureStudio`. */
export const remotionStudios = createRemotionStudios({
  spawner: { spawn: (request) => deps.spawner.spawn(request) },
  findPort: () => deps.findPort(),
  setTimer: (fn, ms) => deps.setTimer(fn, ms),
  setup: { view: (ctx) => deps.setup.view(ctx), ensure: (ctx) => deps.setup.ensure(ctx) },
  get startTimeoutMs() { return deps.startTimeoutMs; },
  get idleMs() { return deps.idleMs; },
});
/** Test seam: replaces some pieces; the rest stay. */
export function configureStudio(patch: Partial<StudioDeps>): void { deps = { ...deps, ...patch }; }
export function resetStudio(): void { deps = defaults(); }
