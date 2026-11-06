import type { TaskData } from '../types';

/** What the terminal last said about its CLI process: running, gone, or not yet known. */
export type TerminalSessionState = 'unknown' | 'live' | 'ended';

type StepSessionTask = Pick<TaskData, 'status' | 'workflowRunId' | 'sessionId' | 'executionMode'>;

/**
 * Which inspect-session control the Session pane offers for a workflow step (see
 * server/src/worker/workerManager.ts's `reopenStepSession`/`closeStepSession`): only once its Task
 * has settled with a recorded CLI conversation id — "resume" while its terminal has ended, "stop"
 * while it is live again (a settled step's live session can only be a reopened one).
 */
export function stepSessionAction(task: StepSessionTask, state: TerminalSessionState): 'resume' | 'stop' | null {
  const settled = task.status !== 'developing' && task.status !== 'blocked';
  if (!settled || task.executionMode !== 'terminal' || !task.workflowRunId || !task.sessionId) return null;
  if (state === 'ended') return 'resume';
  return state === 'live' ? 'stop' : null;
}

export type StepSessionOutcome = { ok: true; note: string | null } | { ok: false; error: string };

async function attempt(action: () => Promise<string | null>): Promise<StepSessionOutcome> {
  try {
    return { ok: true, note: await action() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Asks the daemon to reopen the session and reports where its CLI is working. */
export function reopenStepSession(
  taskId: string,
  reopen: (taskId: string, mode?: 'permissions' | 'read-only') => Promise<{ location: 'worktree' | 'recreated-worktree' | 'project'; mode: 'permissions' | 'read-only'; reason?: string }>,
  mode?: 'permissions' | 'read-only',
): Promise<StepSessionOutcome> {
  return attempt(async () => {
    const { location, mode: openedMode, reason } = await reopen(taskId, mode);
    if (location === 'recreated-worktree') return "Working copy recreated from the task branch for this session.";
    if (location === 'project') return reason ?? `This session opened ${openedMode === 'read-only' ? 'read-only ' : ''}in the project folder.`;
    return null;
  });
}

/** Asks the daemon to end a reopened session; the terminal's own `ended` frame then brings Resume back. */
export function stopStepSession(taskId: string, close: (taskId: string) => Promise<void>): Promise<StepSessionOutcome> {
  return attempt(async () => { await close(taskId); return null; });
}
