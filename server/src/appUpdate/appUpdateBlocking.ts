/**
 * Task 7.001: whether it's safe to apply a 'server'-classified app update right now — i.e. whether
 * the owner has anything in flight that a stop/pull/install/restart would kill out from under them.
 * Three independently-zero counts, computed fresh on demand (cheap, no caching needed — see
 * appUpdateService.ts's `getStatus`, which recomputes this on every call rather than trusting a
 * cached reading that could be up to APP_UPDATE_REFRESH_MS stale).
 *
 * Deliberately broader than `worker/projectFolderGuard.ts`'s "is this Project's folder busy" check:
 * that guard exists to protect one Project's working directory, so it exempts worktree-isolated work
 * and ignores planning sessions entirely. An app update restarts the whole daemon (the server path) or
 * swaps the whole web build (the web-only path), so EVERY live Task/WorkflowRun/TestRun/CommandRun/
 * terminal session across every Project counts here, worktree or not.
 */
import { testRunsDb, commandRunsDb } from '../db/collections.ts';
import type { AppUpdateBlockingCounts } from '../domain/types.ts';
import type { TerminalSessionHost } from '../terminal/terminalSessionManager.ts';

export const ZERO_APP_UPDATE_BLOCKING: AppUpdateBlockingCounts = {
  testRuns: 0,
  commands: 0,
  terminalSessions: 0,
};

/** The one slice of the terminal-session registry this needs: liveness per task, plus its live-session count. */
export type BlockingSessionRegistry = Pick<TerminalSessionHost, 'has' | 'count'>;

export async function computeBlockingCounts(sessions: BlockingSessionRegistry): Promise<AppUpdateBlockingCounts> {
  const testRuns = (await testRunsDb.find((run) => run.status === 'queued' || run.status === 'running')).length;

  // Every origin, including 'sync' (the branch-sync button's run) — unlike the folder-busy guard,
  // nothing here is exempted by where or why a command is running.
  const commands = (await commandRunsDb.find((run) => run.status === 'running')).length;

  // The registry's own live-session count — every Task, planning and ad-hoc *inspect* CLI runs in a
  // PTY, so this is the one source of truth for "a CLI is open". Stored Task/WorkflowRun statuses are
  // deliberately not consulted: a stale 'running' row with no process behind it must never hold an update.
  const terminalSessions = sessions.count();

  return { testRuns, commands, terminalSessions };
}

/** Idle means every one of the three counts reads zero individually — not just their sum. */
export function isIdle(counts: AppUpdateBlockingCounts): boolean {
  return (
    counts.testRuns === 0 &&
    counts.commands === 0 &&
    counts.terminalSessions === 0
  );
}
