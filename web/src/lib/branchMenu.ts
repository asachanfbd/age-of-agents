/**
 * Whether anything is really working in a Project's own folder right now — the pure, client-side
 * mirror of the daemon's own rule (server/src/worker/projectFolderGuard.ts's `isProjectFolderBusy`),
 * which the branch menu's sync button and existing-branch entries are driven by instead of the
 * Project's overall `status`. A planning session (`kind: 'plan'`) never touches project files, so it
 * never counts, however many are running and whatever state they're in. A coding Task or
 * WorkflowRun in its own worktree never touches the Project's own folder either. Only a live coding
 * Task with no worktree, or an unsettled WorkflowRun with no worktree (including one waiting between
 * steps for approval or attention), makes the folder busy.
 */
import type { TaskData } from '../types';
import type { WorkflowRunRecord } from './serverApi';

const UNSETTLED_RUN_STATUSES: WorkflowRunRecord['status'][] = ['starting', 'running', 'awaiting-approval', 'needs-attention', 'completing'];

type FolderTask = Pick<TaskData, 'kind' | 'status' | 'worktreePath'>;
type FolderRun = Pick<WorkflowRunRecord, 'worktreePath' | 'status'>;

export function isProjectFolderBusy(tasks: FolderTask[], runs: FolderRun[]): boolean {
  const taskInFolder = tasks.some((task) => task.kind !== 'plan' && !task.worktreePath && (task.status === 'developing' || task.status === 'blocked'));
  if (taskInFolder) return true;
  return runs.some((run) => !run.worktreePath && UNSETTLED_RUN_STATUSES.includes(run.status));
}
