/**
 * Whether anything is really working in a Project's own folder right now — the one rule behind
 * every guard that must only block on folder work: starting a new in-place Task
 * (`workerManager.ts`'s `executePlanItem`), and switching or syncing the Project's checked-out
 * branch (`projectService.ts`'s `checkoutProjectBranch`, `commandRunner.ts`'s `runProjectSync`).
 *
 * A planning session never touches project files and needs no branch, so it never counts, however
 * many are running and whatever state they're in. A coding Task or WorkflowRun in its own worktree
 * never touches the Project's own folder either, so it never counts. Only a live coding Task with no
 * worktree, or an unsettled WorkflowRun with no worktree (including one waiting between steps for
 * approval or attention — it still owns the folder), makes the folder busy. Shared by every caller
 * above so they can never disagree about what counts as "busy".
 */
import { tasksDb, workflowRunsDb } from '../db/collections.ts';
import type { ProjectRecord, TaskRecord, WorkflowRunRecord } from '../domain/types.ts';
import { terminalSessionManager, type TerminalSessionHost } from '../terminal/terminalSessionManager.ts';

/** The one question liveness asks of the terminal-session host: is this Task's CLI process registered right now? */
export type SessionRegistry = Pick<TerminalSessionHost, 'has'>;

/** `createBranch: false` asks to work in the Project's own directory, but another Task or unsettled WorkflowRun is already working there — or, for a branch switch/sync, that same work is still going on. */
export class ProjectFolderBusyError extends Error {
  constructor(project: Pick<ProjectRecord, 'name'>, action: 'start' | 'git' = 'start') {
    const advice = action === 'start'
      ? 'start this one on a new branch instead, or wait for that one to finish'
      : 'wait for it to finish, or let it run in its own worktree, before switching or syncing branches';
    super(`Work is already running in project "${project.name}"'s own folder — ${advice}`);
    this.name = 'ProjectFolderBusyError';
  }
}

/** Back-compat read of a Project's active-task set for a record written before `activeTaskIds` existed — see its doc comment on ProjectRecord. */
export function activeTaskIdsOf(project: ProjectRecord): string[] {
  return project.activeTaskIds ?? (project.activeTaskId ? [project.activeTaskId] : []);
}

export function isActiveTask(task: TaskRecord | undefined): task is TaskRecord {
  return task?.status === 'developing' || task?.status === 'blocked';
}

/**
 * Whether a Task is really running right now — the check behind every "is this still in progress?"
 * guard (concurrency, the Project's folder, archive, delete, mark complete). Its stored status must
 * say developing/blocked AND its CLI session must actually be registered — or it was only just
 * created and that session is still being launched ('starting'). A stored status alone isn't
 * trusted: a lost exit or a late hook can leave it stale, and a stale one must never hold a slot or
 * block the user.
 */
export function isLiveTask(task: TaskRecord | undefined, sessions: SessionRegistry): task is TaskRecord {
  return isActiveTask(task) && (sessions.has(task.id) || task.runtimeStatus === 'starting');
}

/**
 * The Project's active-task set as it really is right now: only members really running (`isLiveTask`).
 * `activeTaskIds` can hold stale ids — a legacy record, or a Task settled/deleted by a path that
 * never reconciled the set — and those must never hold a concurrency slot or the Project's folder.
 */
export async function liveTasksOf(project: ProjectRecord, sessions: SessionRegistry): Promise<TaskRecord[]> {
  return (await Promise.all(activeTaskIdsOf(project).map((id) => tasksDb.get(id)))).filter((task) => isLiveTask(task, sessions));
}

export const UNSETTLED_RUN_STATUSES: WorkflowRunRecord['status'][] = ['starting', 'running', 'awaiting-approval', 'needs-attention', 'completing'];

/**
 * Refuses (ProjectFolderBusyError) while anything else works in the Project's own directory: an
 * active coding Task without a worktree, or an unsettled WorkflowRun without one — an in-place run
 * still owns the folder between steps, e.g. while it waits for approval. Planning sessions never
 * write project files, so they don't count.
 */
export async function assertProjectFolderFree(project: ProjectRecord, sessions: SessionRegistry, action: 'start' | 'git' = 'start'): Promise<void> {
  if (await isProjectFolderBusy(project, sessions)) throw new ProjectFolderBusyError(project, action);
}

/** The boolean `assertProjectFolderFree` throws on — exposed so callers that need the value itself (rather than a thrown error) can ask the same question, e.g. the API surface the web reads to drive its branch menu. */
export async function isProjectFolderBusy(project: ProjectRecord, sessions: SessionRegistry): Promise<boolean> {
  const taskInFolder = (await liveTasksOf(project, sessions)).some((task) => task.kind !== 'plan' && !task.worktreePath);
  if (taskInFolder) return true;
  const runsInFolder = await workflowRunsDb.find((run) => run.projectId === project.id && !run.worktreePath && UNSETTLED_RUN_STATUSES.includes(run.status));
  return runsInFolder.length > 0;
}

/** The real terminal-session host, for callers (outside tests) that don't already have a `SessionRegistry` in hand. */
export function defaultSessionRegistry(): SessionRegistry {
  return terminalSessionManager;
}
