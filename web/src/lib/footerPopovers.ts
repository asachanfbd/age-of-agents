import { buildTaskGroups, findWorkflowRun, isBlockedWaiting } from './workflowTaskGroups';
import { buildPlanningQueue } from './projectTasks';
import type { OpenTaskRow } from './projectTasks';
import { countProjectTasks } from './workspaceCounts';
import { queuedBadge } from './waitingList';
import type { WorkspaceBoards } from './workspaceCounts';
import { cardDetail, splitTaskNumber } from './taskBoard';
import type { CardDetail } from './taskBoard';
import { formatRelativeTime } from './sessionTiming';
import type { ExecutorProfile, WorkflowRunRecord } from './serverApi';
import type { PlanItemData, ProjectData, TaskData } from '../types';

/**
 * What each status-footer count's popover lists. Rows come from the same board builders as the footer
 * numbers (`workspaceCounts.ts`), so a list always has exactly as many rows as its number.
 */

export type FooterProjectKind = 'working' | 'blocked';
export type FooterTaskKind = 'active' | 'blocked' | 'pending';

export const EMPTY_PROJECT_MESSAGES: Record<FooterProjectKind, string> = {
  working: 'No working projects',
  blocked: 'No blocked projects',
};

/** The word that names a row's state, so colour is never the only cue. */
export const TASK_KIND_WORD: Record<FooterTaskKind, string> = { active: 'Active', blocked: 'Needs you', pending: 'Pending' };

/** The dot colour of each state, matching the footer's own task dots. */
export const TASK_KIND_DOT: Record<FooterTaskKind, string> = { active: 'bg-warning', blocked: 'bg-destructive', pending: 'bg-muted-foreground' };

/** The word for a task that is only waiting for its parents; it counts and sorts as Pending. */
export const WAITING_WORD = 'Waiting';

export const EMPTY_TASKS_MESSAGE = 'No active, blocked or pending tasks';

/** Any instant will do: the board builders use `now` only for elapsed-time metrics, which no row reads. */
const ANY_TIME = 0;

export interface FooterProjectRow {
  projectId: string;
  name: string;
  /** Null while the project's plan, tasks and runs are still loading. */
  running: number | null;
  needsYou: number | null;
}

export interface FooterTaskRow {
  /** The plan item's id. */
  id: string;
  kind: FooterTaskKind;
  /** The word naming the row's state: `TASK_KIND_WORD[kind]`, or `WAITING_WORD` for a task waiting for its parents. */
  label: string;
  projectId: string;
  title: string;
  detail: string;
  /** Null when no coding agent is assigned. */
  agent: string | null;
  startedAt: string | null;
  /** When it entered its current step or began needing you; null when the data holds no such instant. */
  inStateSince: string | null;
  createdAt: string;
  open: CardDetail;
}

export type FooterTaskCounts = Record<FooterTaskKind, number>;

export interface FooterTaskGroup {
  projectId: string;
  projectName: string;
  /** Active rows first, then blocked, then pending. */
  rows: FooterTaskRow[];
  counts: FooterTaskCounts;
}

export interface FooterBoards extends WorkspaceBoards {
  projects: ProjectData[];
  executors: Pick<ExecutorProfile, 'id' | 'label'>[];
}

const byName = (a: { name: string; id?: string }, b: { name: string; id?: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id ?? '').localeCompare(b.id ?? '');

const byTitle = (a: { title: string; id: string }, b: { title: string; id: string }) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** Projects of one status, A–Z, each with its Running and Needs-you card counts. */
export function buildProjectRows(boards: FooterBoards, kind: FooterProjectKind): FooterProjectRow[] {
  const status = kind === 'working' ? 'developing' : 'blocked';
  return boards.projects
    .filter((project) => project.status === status)
    .sort((a, b) => byName(a, b))
    .map((project) => {
      const items = boards.planByProject[project.id]?.items;
      const taskIds = boards.taskIdsByProject[project.id];
      const runs = boards.workflowRunsByProject[project.id];
      const loaded = !!items && !!taskIds && !!runs;
      const counts = countProjectTasks({ projectId: project.id, items, taskIds, runs, queue: boards.planItemQueueByProject?.[project.id] }, boards.tasksById);
      return { projectId: project.id, name: project.name, running: loaded ? counts.active : null, needsYou: loaded ? counts.blocked : null };
    });
}

/** "2 running · 1 needs you" — zero counts and a still-loading project show nothing. */
export function projectRowCounts(row: Pick<FooterProjectRow, 'running' | 'needsYou'>): string {
  const parts: string[] = [];
  if (row.running) parts.push(`${row.running} running`);
  if (row.needsYou) parts.push(`${row.needsYou} needs you`);
  return parts.join(' · ');
}

const BLOCKED_REASONS: Partial<Record<WorkflowRunRecord['status'], string>> = {
  'awaiting-approval': 'Awaiting approval',
  'needs-attention': 'Needs attention',
  failed: 'Failed',
  stopped: 'Stopped',
};

function activeDetail(run: WorkflowRunRecord | null): string {
  const steps = run?.workflowSnapshot.steps ?? [];
  const index = steps.findIndex((step) => step.id === run?.currentStepId);
  return index < 0 ? 'Running' : `${steps[index]!.name} · step ${index + 1} of ${steps.length}`;
}

/** The row's title with its `<session>.<task>` number shown once, adding it from the planning reference when the title lacks it. */
export function titleWithNumber(item: Pick<PlanItemData, 'title' | 'planningRef'> | undefined, fallbackTitle: string): string {
  const title = item?.title ?? fallbackTitle;
  if (splitTaskNumber(title).number || !item?.planningRef) return title;
  return `${item.planningRef.session}.${String(item.planningRef.task).padStart(3, '0')}: ${title}`;
}

function pendingDetail(item: PlanItemData | undefined, tasksById: Record<string, TaskData>): string {
  if (!item?.planningTaskId && !item?.planningRef) return '';
  const sessionTask = item.planningTaskId ? tasksById[item.planningTaskId] : undefined;
  const number = item.planningRef?.session ?? sessionTask?.planningSessionNumber;
  const label = number ? `From planning session ${number}` : 'From a planning session';
  return sessionTask?.title ? `${label}: ${sessionTask.title}` : label;
}

/** Planning column order: planning sessions' ready tasks in place, loose tasks by queue slot. */
function planningOrder(items: PlanItemData[], taskIds: string[], tasksById: Record<string, TaskData>): string[] {
  return buildPlanningQueue({ items, taskIds, tasksById, now: ANY_TIME }).flatMap((entry) =>
    entry.kind === 'session' ? entry.session.ready.map((row) => row.id) : [entry.id],
  );
}

const waitingReason = (row: OpenTaskRow): string => (row.queued ? queuedBadge(row.queued.position) : row.waiting?.reasons[0]?.text ?? WAITING_WORD);

function stateSince(kind: FooterTaskKind, row: OpenTaskRow, run: WorkflowRunRecord | null, tasksById: Record<string, TaskData>): string | null {
  if (kind === 'pending') return null;
  if (kind === 'active') return run?.currentStepRoundStartedAt ?? null;
  if (run) return run.updatedAt;
  return row.latestTaskId ? tasksById[row.latestTaskId]?.updatedAt ?? null : null;
}

function toTaskRow(
  kind: FooterTaskKind,
  row: OpenTaskRow,
  context: { projectId: string; item: PlanItemData | undefined; run: WorkflowRunRecord | null; boards: FooterBoards },
): FooterTaskRow {
  const { projectId, item, run, boards } = context;
  const executorId = row.workerId ?? run?.executorId ?? null;
  const isWaiting = !run && !!(row.waiting || row.queued);
  const detail = isWaiting
    ? waitingReason(row)
    : kind === 'active' ? activeDetail(run) : kind === 'blocked' ? (run ? BLOCKED_REASONS[run.status] ?? 'Needs attention' : 'Waiting for your answer') : pendingDetail(item, boards.tasksById);
  return {
    id: row.id,
    kind,
    label: isWaiting && kind === 'pending' ? WAITING_WORD : TASK_KIND_WORD[kind],
    projectId,
    title: titleWithNumber(item, row.title),
    detail,
    agent: executorId ? boards.executors.find((executor) => executor.id === executorId)?.label ?? executorId : null,
    startedAt: row.metrics?.startedAt ?? null,
    inStateSince: stateSince(kind, row, run, boards.tasksById),
    createdAt: row.createdAt,
    open: cardDetail(row),
  };
}

/** Longest in the current state first; rows with no such instant follow, then by title. */
function compareInState(a: FooterTaskRow, b: FooterTaskRow): number {
  if (a.inStateSince && b.inStateSince && a.inStateSince !== b.inStateSince) return a.inStateSince < b.inStateSince ? -1 : 1;
  if (!!a.inStateSince !== !!b.inStateSince) return a.inStateSince ? -1 : 1;
  return byTitle(a, b);
}

const TASK_KINDS: FooterTaskKind[] = ['active', 'blocked', 'pending'];

/** One project's rows of one kind, in that kind's order; empty while the project is still loading. */
function projectRowsOfKind(boards: FooterBoards, projectId: string, kind: FooterTaskKind): FooterTaskRow[] {
  const items = boards.planByProject[projectId]?.items;
  const taskIds = boards.taskIdsByProject[projectId];
  const runs = boards.workflowRunsByProject[projectId];
  if (!items || !taskIds || !runs) return [];
  const built = buildTaskGroups({ items, tasksById: boards.tasksById, workflowRunsByProject: { [projectId]: runs }, projectId, showArchived: false, now: ANY_TIME, queue: boards.planItemQueueByProject?.[projectId] });
  const waitingRows = built.waiting.filter((row) => isBlockedWaiting(row) === (kind === 'blocked'));
  const source = kind === 'active' ? built.running : kind === 'blocked' ? [...built.needsYou, ...waitingRows] : [...waitingRows, ...built.open.filter((row) => row.state === 'todo' && !row.workflowRunId)];
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const rows = source.map((row) => toTaskRow(kind, row, { projectId, item: itemsById.get(row.id), run: findWorkflowRun(row, runs), boards }));
  if (kind === 'pending') {
    const rank = new Map(planningOrder(items, taskIds, boards.tasksById).map((id, index) => [id, index]));
    const isWaitingRow = (row: FooterTaskRow) => row.label === WAITING_WORD;
    // Started tasks waiting on parents come before the not-started queue, which keeps its planning order.
    return rows.sort((a, b) => Number(isWaitingRow(b)) - Number(isWaitingRow(a)) || (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || byTitle(a, b));
  }
  return rows.sort(compareInState);
}

/** A project's place in the Tasks popup: rank 1 (active only) … 5 (pending only); null when it has no tasks. */
export function projectRank({ active, blocked, pending }: FooterTaskCounts): 1 | 2 | 3 | 4 | 5 | null {
  if (active + blocked + pending === 0) return null;
  if (pending > 0) return active + blocked > 0 ? 4 : 5;
  if (blocked === 0) return 1;
  return active === 0 ? 2 : 3;
}

/** Negative when `a` sorts first. Ratios are compared by cross-multiplication in BigInt, so they stay exact at any size. */
function compareWithinRank(rank: number, a: FooterTaskCounts, b: FooterTaskCounts): number {
  const total = (c: FooterTaskCounts) => c.active + c.blocked + c.pending;
  const higherRatio = (num: (c: FooterTaskCounts) => number) => {
    const diff = BigInt(num(b)) * BigInt(total(a)) - BigInt(num(a)) * BigInt(total(b));
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  };
  switch (rank) {
    case 1: return a.active - b.active;
    case 2: return a.blocked - b.blocked;
    case 3: return higherRatio((c) => c.active);
    case 4: return higherRatio((c) => c.active + c.blocked);
    default: return a.pending - b.pending;
  }
}

/** Popup order of two non-empty projects by counts alone: rank first, then the rank's own comparison. */
export function compareProjectCounts(a: FooterTaskCounts, b: FooterTaskCounts): number {
  const rank = projectRank(a)!;
  return rank - projectRank(b)! || compareWithinRank(rank, a, b);
}

/**
 * Every active, blocked and pending task, grouped by project and ranked so projects with live work come
 * first (see `projectRank` and `compareWithinRank`); remaining ties fall to project name, then id. Projects
 * still loading and projects with no such tasks are left out.
 */
export function buildTasksPopupGroups(boards: FooterBoards): FooterTaskGroup[] {
  const ranked: { group: FooterTaskGroup; rank: number }[] = [];
  for (const project of boards.projects) {
    const byKind = TASK_KINDS.map((kind) => projectRowsOfKind(boards, project.id, kind));
    const counts: FooterTaskCounts = { active: byKind[0]!.length, blocked: byKind[1]!.length, pending: byKind[2]!.length };
    const rank = projectRank(counts);
    if (rank) ranked.push({ rank, group: { projectId: project.id, projectName: project.name, rows: byKind.flat(), counts } });
  }
  return ranked
    .sort((a, b) => compareProjectCounts(a.group.counts, b.group.counts) || byName({ name: a.group.projectName, id: a.group.projectId }, { name: b.group.projectName, id: b.group.projectId }))
    .map(({ group }) => group);
}

/** "1 active, 1 blocked, 5 pending" — zero counts omitted. */
export function taskCountsLabel(counts: FooterTaskCounts): string {
  return TASK_KINDS.filter((kind) => counts[kind] > 0).map((kind) => `${counts[kind]} ${kind}`).join(', ');
}

/** "Started 3h ago · step started 12m ago" / "Started 3h ago · needs you since 12m ago" / "Created 5d ago". */
export function taskRowTimeLabel(kind: FooterTaskKind, row: Pick<FooterTaskRow, 'startedAt' | 'inStateSince' | 'createdAt'>, now: Date): string {
  if (kind === 'pending') return `Created ${formatRelativeTime(row.createdAt, now)}`;
  const parts: string[] = [];
  if (row.startedAt) parts.push(`Started ${formatRelativeTime(row.startedAt, now)}`);
  if (row.inStateSince) parts.push(`${kind === 'active' ? 'step started' : 'needs you since'} ${formatRelativeTime(row.inStateSince, now)}`);
  return parts.join(' · ');
}

/**
 * The detail to open for a clicked task row: the one a board click would open, or — when that run, task
 * or item has since vanished — null, which opens the project's board instead.
 */
export function resolveCardDetail(detail: CardDetail | null, projectId: string, boards: Pick<WorkspaceBoards, 'planByProject' | 'workflowRunsByProject' | 'tasksById'>): CardDetail | null {
  if (!detail) return null;
  if (detail.kind === 'task') return boards.tasksById[detail.id] ? detail : null;
  if (detail.kind === 'run') return boards.workflowRunsByProject[projectId]?.some((run) => run.id === detail.id) ? detail : null;
  return boards.planByProject[projectId]?.items.some((item) => item.id === detail.id) ? detail : null;
}
