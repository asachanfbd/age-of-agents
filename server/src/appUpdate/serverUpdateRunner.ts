/**
 * Task 7.001: the server-path update's orchestration — stop → pull → install → start, with a
 * best-effort recovery attempt baked into every failure branch, since the one thing that must never
 * happen is the owner being left with nothing running. Pure and fully fake-injectable so every
 * branch (tests 51-56 in server/tests/appUpdate*.test.ts) can be exercised without ever shelling out
 * to git/npm or the real scripts/prod-start.sh / scripts/prod-stop.sh — the real steps are built by
 * `server/bin/run-app-update.mjs`, a thin, intentionally untested entry point (acceptance criterion
 * 11 covers that boundary manually instead), run as a detached child of the daemon so it survives the
 * daemon's own shutdown (see that file and appUpdateService.ts's doc comment on why `detached: true`
 * is what makes that safe).
 */

export interface ServerUpdateSteps {
  stop(): Promise<void>;
  pull(): Promise<{ ok: boolean; output: string }>;
  installAll(): Promise<{ ok: boolean; output: string }>;
  /** Builds + starts BOTH processes (equivalent to prod-start.sh) — a build failure or either process exiting immediately after start are both reported as ok:false here; the caller doesn't need to know which. */
  start(): Promise<{ ok: boolean; output: string }>;
  resetToCommit(sha: string): Promise<{ ok: boolean; output: string }>;
}

export interface ServerUpdateResult {
  ok: boolean;
  updatedToCommit?: string;
  failureMessage?: string;
  recovered: boolean;
}

const ROLLBACK_FAILED_NOTE =
  ' The previous version could not be restored without discarding local changes, so the checkout stays on the updated commit and your changes were left untouched.';

/** Restores `sha`, returning a note for the failure message when that was not possible. */
async function rollback(steps: ServerUpdateSteps, sha: string): Promise<string> {
  const result = await steps.resetToCommit(sha);
  return result.ok ? '' : `${ROLLBACK_FAILED_NOTE}${result.output ? ` (${result.output})` : ''}`;
}

export async function runServerUpdate(
  steps: ServerUpdateSteps,
  context: { previousCommit: string; newCommit: string },
): Promise<ServerUpdateResult> {
  await steps.stop();

  const pulled = await steps.pull();
  if (!pulled.ok) {
    // Nothing changed — still on previousCommit. Processes are already stopped; just start them again.
    const restarted = await steps.start();
    return { ok: false, failureMessage: pulled.output || 'git pull failed.', recovered: restarted.ok };
  }

  const installed = await steps.installAll();
  if (!installed.ok) {
    const note = await rollback(steps, context.previousCommit);
    const restarted = await steps.start();
    return { ok: false, failureMessage: `${installed.output || 'npm run install:all failed.'}${note}`, recovered: restarted.ok };
  }

  const started = await steps.start();
  if (!started.ok) {
    // Covers both a build failure inside start() and either process exiting immediately after launch.
    const note = await rollback(steps, context.previousCommit);
    // Best-effort second attempt — the owner must not be left with nothing running. Logged by the
    // caller (run-app-update.mjs appends every step's output to app-update.log); if this ALSO fails,
    // still return rather than throw — recovered: false is the one case where nothing is running,
    // and it must be recorded, never silently swallowed.
    const secondAttempt = await steps.start();
    return { ok: false, failureMessage: `${started.output || 'Starting the updated app failed.'}${note}`, recovered: secondAttempt.ok };
  }

  return { ok: true, updatedToCommit: context.newCommit, recovered: true };
}
