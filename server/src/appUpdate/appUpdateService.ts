/**
 * Task 7.001 ("idle-aware app updates"): the stateful service behind the footer item and update
 * popover — owns the in-memory `AppUpdateStatus` (lost on a daemon restart, by design: a held update
 * does not survive one — see `initialize`'s own doc comment for the one thing that DOES survive),
 * and the hold/cancel/apply/auto-fire state machine.
 *
 * Ownership split with appUpdateDetector.ts: `checkNow` asks the detector for a fresh reading of
 * everything a `git fetch` can tell you (availability, branch, commits, classification, ...) and the
 * detector carries this service's own fields (`phase`/`updatedToCommit`/`failureMessage`/
 * `failureLogPath`) through unchanged — this service is the only thing that ever changes those four,
 * and it does so directly (`setCurrent`), re-deriving `canApply`/`applyBlockedReason` through the
 * same `computeApplyFields` the detector itself uses, rather than re-running a git check just to
 * learn its own state transition. `blocking` is recomputed fresh on *every* read (`getStatus` as well
 * as `checkNow`) rather than trusted from a previous tick — see appUpdateBlocking.ts's doc comment on
 * why it's cheap enough to never cache.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { APP_CHECKOUT_ROOT, IS_PROD_MODE, REPO_ROOT, RUN_DIR } from '../config.ts';
import { computeAppUpdateStatus, computeApplyFields } from './appUpdateDetector.ts';
import { computeBlockingCounts, isIdle, ZERO_APP_UPDATE_BLOCKING, type BlockingSessionRegistry } from './appUpdateBlocking.ts';
import { syncAppUpdateNotification } from './appUpdatePoller.ts';
import { runWebOnlyUpdate, type WebOnlyUpdateSteps } from './webOnlyUpdateRunner.ts';
import { realWebOnlySteps } from './realWebOnlySteps.ts';
import { terminalSessionManager } from '../terminal/terminalSessionManager.ts';
import type { AppUpdateStatus } from '../domain/types.ts';

/** `canApply` currently false because an update is already `'held'`/`'updating'` — a dedicated class so the API layer maps it to 409, distinct from "not updatable for any other reason" (400). */
export class AppUpdateAlreadyInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppUpdateAlreadyInProgressError';
  }
}

/** `canApply` currently false for any reason OTHER than already being held/updating (dev mode, not available, cant-auto-update, could-not-check) — maps to 400. */
export class AppUpdateNotApplicableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppUpdateNotApplicableError';
  }
}

export type AppUpdateEvent = { type: 'appUpdate'; status: AppUpdateStatus };
type Listener = (event: AppUpdateEvent) => void;

const RESULT_FILENAME = 'app-update-result.json';
const LOG_FILENAME = 'app-update.log';
const DEFAULT_HELD_WATCHER_INTERVAL_MS = 2_000;
/**
 * How long a just-reached 'updated'/'failed' phase stays visible before the next `checkNow`/`getStatus`
 * reverts it to 'idle' on its own — Code Review round 1, issue 2: without this, `phase` was carried
 * forward unchanged forever (`computeAppUpdateStatus` always copies it from `previous`), so the footer
 * got stuck on "Updated to <sha>" with no actions and never discovered a later update again without a
 * full process restart. Time-based (not "reset on the next tick") specifically because the recurring
 * poller's own first tick fires within microseconds of `initialize()` setting this phase — resetting
 * on tick-count rather than elapsed time would wipe it out before any real client had a chance to see
 * it at all after a restart. Five minutes is ample time for a reconnecting tab to read it and short
 * enough to still read as "briefly" per the spec.
 */
export const TERMINAL_PHASE_DISPLAY_MS = 5 * 60_000;

/** The never-checked-yet default — before `initialize`'s first `checkNow` ever resolves. */
function initialStatus(): AppUpdateStatus {
  return {
    mode: IS_PROD_MODE ? 'prod' : 'dev',
    canApply: false,
    applyBlockedReason: null,
    availability: 'could-not-check',
    branch: '',
    currentCommit: null,
    aheadBy: 0,
    behindBy: 0,
    classification: null,
    installWebDeps: false,
    incomingCommits: [],
    incomingCommitsTruncated: false,
    cantUpdateReason: null,
    blockingFiles: [],
    blockingFilesTotal: 0,
    checkError: null,
    checkedAt: null,
    lastSuccessfulCheckAt: null,
    phase: 'idle',
    blocking: ZERO_APP_UPDATE_BLOCKING,
    updatedToCommit: null,
    failureMessage: null,
    failureLogPath: null,
  };
}

/**
 * Spawns `server/bin/run-app-update.mjs` detached, as the leader of its own process group, so that
 * when the bin script's own `stop()` step later runs scripts/prod-stop.sh (which SIGTERMs the
 * DAEMON's process group), this updater process itself — being in a *different* group — is
 * unaffected. That's the entire mechanism behind "survives the daemon's own shutdown": not anything
 * about `unref()` (which only stops this process from keeping the daemon's event loop alive, and
 * matters not at all once the daemon exits anyway), but `detached: true` putting the child in its own
 * process group before the daemon's own group gets signalled.
 */
function defaultStartServerUpdate(context: { previousCommit: string; newCommit: string }): void {
  const binPath = path.join(REPO_ROOT, 'server', 'bin', 'run-app-update.mjs');
  mkdirSync(RUN_DIR, { recursive: true });
  const logFd = openSync(path.join(RUN_DIR, LOG_FILENAME), 'a');
  const child = spawn(process.execPath, [binPath, context.previousCommit, context.newCommit], {
    cwd: APP_CHECKOUT_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, AGENT_VISUAL_OS_APP_ROOT: APP_CHECKOUT_ROOT, AGENT_VISUAL_OS_RUN_DIR: RUN_DIR },
  });
  child.unref();
}

export interface AppUpdateServiceOptions {
  /** Injectable so tests never touch the real terminal-session registry. */
  sessions?: BlockingSessionRegistry;
  /** Injectable so tests never shell out to real git/npm/vite — see webOnlyUpdateRunner.ts. */
  webOnlySteps?: WebOnlyUpdateSteps;
  /** Injectable so tests never spawn the real detached bin/run-app-update.mjs. */
  startServerUpdate?: (context: { previousCommit: string; newCommit: string }) => void;
  /** How often the held watcher re-checks blocking counts — overridable so tests don't wait on the real 2s cadence. */
  heldWatcherIntervalMs?: number;
  /** Where the leftover update-result file (from a previous process) is read on `initialize` — overridable so tests never touch the real `.run/`. */
  runDir?: string;
  /** How long `'updated'`/`'failed'` stays visible before auto-reverting to `'idle'` — overridable so tests don't wait on the real 5-minute default. */
  terminalPhaseDisplayMs?: number;
  /** Injectable clock, for the same reason — see `terminalPhaseDisplayMs`. */
  now?: () => number;
}

export function createAppUpdateService(options: AppUpdateServiceOptions = {}) {
  const sessions = options.sessions ?? terminalSessionManager;
  const webOnlySteps = options.webOnlySteps ?? realWebOnlySteps;
  const startServerUpdate = options.startServerUpdate ?? defaultStartServerUpdate;
  const heldWatcherIntervalMs = options.heldWatcherIntervalMs ?? DEFAULT_HELD_WATCHER_INTERVAL_MS;
  const runDir = options.runDir ?? RUN_DIR;
  const terminalPhaseDisplayMs = options.terminalPhaseDisplayMs ?? TERMINAL_PHASE_DISPLAY_MS;
  const now = options.now ?? Date.now;

  let current: AppUpdateStatus = initialStatus();
  let heldWatcher: NodeJS.Timeout | null = null;
  /** When the current 'updated'/'failed' phase was entered; null whenever `current.phase` isn't one of those two — see `settleTerminalPhase`. */
  let terminalPhaseEnteredAt: number | null = null;
  const listeners = new Set<Listener>();

  function onEvent(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(): void {
    for (const listener of listeners) listener({ type: 'appUpdate', status: current });
  }

  function setCurrent(patch: Partial<AppUpdateStatus>): void {
    current = { ...current, ...patch };
    emit();
  }

  /** The only way `phase` should ever become `'updated'`/`'failed'` — records when, for `settleTerminalPhase` to time against. */
  function enterTerminalPhase(patch: Partial<AppUpdateStatus>): void {
    terminalPhaseEnteredAt = now();
    setCurrent(patch);
  }

  /**
   * Called from every public read (`getStatus`, `checkNow`) before anything else touches `current`:
   * once a terminal phase has been visible for `terminalPhaseDisplayMs`, reverts it to `'idle'` (and
   * clears the fields that went with it) so the footer/actions return to normal and a later update is
   * still discoverable without the daemon needing to restart — see `TERMINAL_PHASE_DISPLAY_MS`'s own
   * doc comment for why this is time-based rather than "reset after being observed once".
   */
  function settleTerminalPhase(): void {
    if (current.phase !== 'updated' && current.phase !== 'failed') return;
    if (terminalPhaseEnteredAt !== null && now() - terminalPhaseEnteredAt < terminalPhaseDisplayMs) return;
    terminalPhaseEnteredAt = null;
    setCurrent({
      phase: 'idle',
      updatedToCommit: null,
      failureMessage: null,
      failureLogPath: null,
      ...computeApplyFields(current.mode, current.availability, 'idle'),
    });
  }

  async function freshBlocking() {
    return computeBlockingCounts(sessions);
  }

  async function getStatus(): Promise<AppUpdateStatus> {
    settleTerminalPhase();
    return { ...current, blocking: await freshBlocking() };
  }

  /** Forces an immediate detection pass + notification sync — the manual "Check now" action and the recurring poll tick both just call this. */
  async function checkNow(): Promise<AppUpdateStatus> {
    settleTerminalPhase();
    const detected = await computeAppUpdateStatus(current);
    const blocking = await freshBlocking();
    current = { ...detected, blocking };
    await syncAppUpdateNotification(current);
    emit();
    return current;
  }

  function clearHeldWatcher(): void {
    if (heldWatcher) {
      clearInterval(heldWatcher);
      heldWatcher = null;
    }
  }

  function startHeldWatcher(context: { previousCommit: string; newCommit: string }): void {
    clearHeldWatcher();
    heldWatcher = setInterval(() => {
      void (async () => {
        const counts = await freshBlocking();
        if (!isIdle(counts)) return;
        clearHeldWatcher();
        setCurrent({ phase: 'updating', ...computeApplyFields(current.mode, current.availability, 'updating') });
        startServerUpdate(context);
      })();
    }, heldWatcherIntervalMs);
    heldWatcher.unref?.();
  }

  async function runWebOnlyFlow(): Promise<void> {
    const result = await runWebOnlyUpdate(webOnlySteps, { installWebDeps: current.installWebDeps });
    if (result.ok) {
      const updatedToCommit = current.incomingCommits[0]?.sha ?? current.currentCommit ?? null;
      // Refresh detection now that we've actually pulled — BEFORE flipping phase to 'updated' —
      // this is also what resolves the app.update_available Notification, since availability
      // naturally becomes 'up-to-date'. Awaiting this first (not after) matters for more than
      // ordering: `checkNow` carries this service's own `phase`/etc. fields through from `current`
      // unchanged (still 'updating' at this point), so it's always safe to call; doing it last would
      // let a caller polling for `phase === 'updated'` race this call's own git fetch against
      // anything else touching the checkout concurrently (a real daemon has nothing else doing
      // that, but a test fixture's own cleanup can, and did — this ordering is what fixes that).
      await checkNow();
      enterTerminalPhase({
        phase: 'updated',
        updatedToCommit,
        failureMessage: null,
        failureLogPath: null,
        ...computeApplyFields(current.mode, current.availability, 'updated'),
      });
    } else {
      enterTerminalPhase({
        phase: 'failed',
        failureMessage: result.failureMessage ?? 'The web-only update failed.',
        failureLogPath: null,
        ...computeApplyFields(current.mode, current.availability, 'failed'),
      });
    }
  }

  /** `canApply` must currently be true (checked first: already-held/updating is 409, everything else blocking it is 400). */
  function apply(): AppUpdateStatus {
    if (current.phase === 'held' || current.phase === 'updating') {
      throw new AppUpdateAlreadyInProgressError(current.applyBlockedReason ?? 'An update is already in progress.');
    }
    if (!current.canApply) {
      throw new AppUpdateNotApplicableError(
        current.applyBlockedReason ?? current.cantUpdateReason ?? current.checkError ?? 'This update cannot be applied.',
      );
    }

    if (current.classification === 'web-only') {
      setCurrent({ phase: 'updating', ...computeApplyFields(current.mode, current.availability, 'updating') });
      void runWebOnlyFlow();
      return current;
    }

    const context = {
      previousCommit: current.currentCommit ?? '',
      newCommit: current.incomingCommits[0]?.sha ?? current.currentCommit ?? '',
    };
    setCurrent({ phase: 'held', ...computeApplyFields(current.mode, current.availability, 'held') });
    startHeldWatcher(context);
    return current;
  }

  /** A no-op (200, unchanged status) when nothing is held — never throws. */
  function cancel(): AppUpdateStatus {
    if (current.phase !== 'held') return current;
    clearHeldWatcher();
    setCurrent({ phase: 'idle', ...computeApplyFields(current.mode, current.availability, 'idle') });
    return current;
  }

  /**
   * Consumes `<runDir>/app-update-result.json` left by a previous process's detached server-path
   * updater, if any — "once" semantics via read-then-delete, not a persisted flag, so a later restart
   * (e.g. `node --watch` in dev) never re-reports it. A held update is never recreated here: in-memory
   * state starts fresh on every construction, so that's automatic — nothing to code for it.
   */
  async function initialize(): Promise<void> {
    const resultPath = path.join(runDir, RESULT_FILENAME);
    try {
      const raw = await readFile(resultPath, 'utf-8');
      await rm(resultPath, { force: true });
      const parsed = JSON.parse(raw) as { ok: boolean; updatedToCommit?: string; failureMessage?: string };
      if (parsed.ok) {
        enterTerminalPhase({
          phase: 'updated',
          updatedToCommit: parsed.updatedToCommit ?? null,
          failureMessage: null,
          failureLogPath: LOG_FILENAME,
          ...computeApplyFields(current.mode, current.availability, 'updated'),
        });
      } else {
        enterTerminalPhase({
          phase: 'failed',
          failureMessage: parsed.failureMessage ?? 'The update failed.',
          failureLogPath: LOG_FILENAME,
          ...computeApplyFields(current.mode, current.availability, 'failed'),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rm(resultPath, { force: true }).catch(() => {});
      }
    }
    await checkNow();
  }

  function dispose(): void {
    clearHeldWatcher();
  }

  return { getStatus, checkNow, apply, cancel, initialize, onEvent, dispose };
}

export type AppUpdateService = ReturnType<typeof createAppUpdateService>;

/** The one instance the daemon actually runs against — see api/router.ts, api/ws.ts and index.ts. */
export const appUpdateService = createAppUpdateService();
