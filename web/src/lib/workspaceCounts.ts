import { buildTaskGroups, isBlockedWaiting } from './workflowTaskGroups';
import type { PlanItemQueueEntry, WorkflowRunRecord } from './serverApi';
import type { PlanItemData, TaskData } from '../types';

/**
 * The status footer's workspace-wide task counts, using the Tasks board's own grouping
 * (`buildTaskGroups`, `buildPlanningRows`), except that a task only waiting for its parents is never Active.
 */

/**
 * Task cards by state: `active` has a live run, `blocked` needs the person (including a task whose parents
 * are blocked), `pending` is not started or only waiting for its parents.
 */
export interface TaskCounts {
  active: number;
  blocked: number;
  pending: number;
}

export interface WorkspaceCounts {
  tasks: TaskCounts;
}

/** One project's board inputs, as the store holds them — any part may still be loading (undefined). */
export interface ProjectBoardData {
  projectId: string;
  items: PlanItemData[] | undefined;
  taskIds: string[] | undefined;
  runs: WorkflowRunRecord[] | undefined;
  /** The project's waiting list; its tasks count as pending. */
  queue?: PlanItemQueueEntry[];
}

const NO_TASKS: TaskCounts = { active: 0, blocked: 0, pending: 0 };

/** The board builders take `now` only for elapsed-time metrics, which no count reads, so any instant will do. */
const ANY_TIME = 0;

/**
 * A project's task counts. Without its plan, tasks and runs all loaded a card could land in the wrong
 * column (a running card looks not-started until its run arrives), so a loading project counts nothing.
 */
export function countProjectTasks(project: ProjectBoardData, tasksById: Record<string, TaskData>): TaskCounts {
  const { items, taskIds, runs, projectId, queue } = project;
  if (!items || !taskIds || !runs) return NO_TASKS;
  const groups = buildTaskGroups({ items, tasksById, workflowRunsByProject: { [projectId]: runs }, projectId, showArchived: false, now: ANY_TIME, queue });
  return {
    active: groups.running.length,
    blocked: groups.needsYou.length + groups.waiting.filter(isBlockedWaiting).length,
    // A not-started Planning card is still to do and has never run; a waiting task has not started running either.
    pending: groups.open.filter((row) => row.state === 'todo' && !row.workflowRunId).length + groups.waiting.filter((row) => !isBlockedWaiting(row)).length,
  };
}

/** The store slices the totals are built from (see `worldStore.ts`), each keyed by project id. */
export interface WorkspaceBoards {
  projects: { id: string }[];
  planByProject: Record<string, { items: PlanItemData[] } | undefined>;
  taskIdsByProject: Record<string, string[] | undefined>;
  workflowRunsByProject: Record<string, WorkflowRunRecord[] | undefined>;
  tasksById: Record<string, TaskData>;
  planItemQueueByProject?: Record<string, PlanItemQueueEntry[] | undefined>;
}

/** Totals across every project. */
export function summarizeWorkspaceCounts(boards: WorkspaceBoards): WorkspaceCounts {
  const tasks = { ...NO_TASKS };
  for (const { id } of boards.projects) {
    const counts = countProjectTasks(
      { projectId: id, items: boards.planByProject[id]?.items, taskIds: boards.taskIdsByProject[id], runs: boards.workflowRunsByProject[id], queue: boards.planItemQueueByProject?.[id] },
      boards.tasksById,
    );
    tasks.active += counts.active;
    tasks.blocked += counts.blocked;
    tasks.pending += counts.pending;
  }
  return { tasks };
}
