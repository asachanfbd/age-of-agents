import { bugReportCountsLabel, bugReportHistory, isWaitingForInput, latestItemTask, planAndBugsCountsLabel, planAndBugsHistory, planningHistoryCountsLabel, planningLinkedItems, planningTaskCategory, planningTaskHistory } from './projectTasks';
import { bugReportLinkedItems, isBugItem, planAndBugsLinkedItems, relatedLinks } from './bugs';
import type { RelatedLink, SessionKind } from './bugs';
import { dependencyChip, dependencyLabel } from './dependencies';
import type { CompletedRow } from './projectTasks';
import { cardDetail, splitTaskNumber } from './taskBoard';
import type { CardDetail } from './taskBoard';
import type { PlanItemData, TaskData } from '../types';

/**
 * View-model for the planning session view's task panel: the tasks one planning session created, in
 * the order it created them, beside the session's CLI. Pure, like `projectTasks.ts`; the panel only
 * renders what these return.
 */

/** The panel shows only on a viewport strictly wider than this. */
export const TASK_PANEL_BREAKPOINT_PX = 1200;

export const showsTaskPanel = (viewportWidth: number) => viewportWidth > TASK_PANEL_BREAKPOINT_PX;

/** Which column is wide beside the session's CLI: the CLI (70/30, the default) or the task list (30/70). */
export type TaskPanelArrangement = 'cli-wide' | 'tasks-wide';

export const DEFAULT_TASK_PANEL_ARRANGEMENT: TaskPanelArrangement = 'cli-wide';

/** The held arrangement and its toggle, passed from the project popup down to the session view. */
export interface TaskPanelSwap {
  arrangement: TaskPanelArrangement;
  onToggle: () => void;
}

export const toggleTaskPanelArrangement = (arrangement: TaskPanelArrangement): TaskPanelArrangement =>
  arrangement === 'tasks-wide' ? 'cli-wide' : 'tasks-wide';

export interface TaskPanelLayout {
  cliClass: string;
  panelClass: string;
  /** Names what a click does now; used as the swap control's accessible name and tooltip. */
  swapLabel: 'Widen tasks' | 'Widen CLI';
  /** The swap control's on/off state: on while the task list is the wide column. */
  swapPressed: boolean;
}

/** An unknown value reads as the default. The two flex weights are an exact swap of each other. */
export function taskPanelLayout(arrangement: TaskPanelArrangement): TaskPanelLayout {
  return arrangement === 'tasks-wide'
    ? { cliClass: 'flex-[3]', panelClass: 'flex-[7]', swapLabel: 'Widen CLI', swapPressed: true }
    : { cliClass: 'flex-[7]', panelClass: 'flex-[3]', swapLabel: 'Widen tasks', swapPressed: false };
}

export interface PanelBadge {
  /** The board's own status words, plus "Ready" for a task that hasn't started. */
  label: 'Ready' | NonNullable<CompletedRow['statusBadge']>;
  variant: 'outline' | 'success' | 'warning' | 'secondary' | 'soft-destructive';
}

export interface PlanningPanelRow {
  /** The plan item's id. */
  id: string;
  /** The `<session>.<task>` number, or null for a title without one. */
  number: string | null;
  /** The title without its number. */
  title: string;
  /** The plan item's whole title, as the board names the task (in its Start task dialog, for one). */
  fullTitle: string;
  description: string;
  category: 'ready' | 'started' | 'completed';
  badge: PanelBadge;
  /** A ready row expands in place; a started or completed one opens in its viewer. */
  action: 'expand' | 'open';
  /** A bug-filing session's row only: the other half of a bug/task pair. */
  related?: RelatedLink[];
  /** A bug-filing session's started row: its owner can no longer change or withdraw it. */
  lockedLabel?: string;
  /** A Plan & bugs session's row only: whether the item is a task or a bug. */
  kindTag?: 'Task' | 'Bug';
  /** A Plan & bugs session's row only: "Depends on #1.001, #B.002", from the item's parents. */
  dependsOnChip?: string;
}

const READY: PanelBadge = { label: 'Ready', variant: 'outline' };
const NEEDS_YOU: PanelBadge = { label: 'Needs you', variant: 'warning' };
const COMPLETED: PanelBadge = { label: 'Completed', variant: 'success' };

/** A started task's run state, in the board's wording and colours. */
function startedBadge(item: Pick<PlanItemData, 'status'>, latestTask: TaskData | undefined): PanelBadge {
  if (isWaitingForInput(latestTask) || item.status === 'blocked') return NEEDS_YOU;
  if (item.status === 'developing') return { label: 'Running', variant: 'success' };
  if (item.status === 'stopped') return { label: 'Stopped', variant: 'secondary' };
  return { label: 'Failed', variant: 'soft-destructive' };
}

/** Creation order: the session's own task number, ties by id. Board reordering never moves a row. */
const byCreationNumber = (a: PlanItemData, b: PlanItemData) =>
  (a.planningRef?.task ?? 0) - (b.planningRef?.task ?? 0) || a.id.localeCompare(b.id);

/** A bug has no session task number: the order it was filed in, ties by id. */
const byCreationTime = (a: PlanItemData, b: PlanItemData) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** The session's ready, started and completed tasks. Archived-not-done ones are left out. */
export function planningSessionTaskRows(items: PlanItemData[], tasksById: Record<string, TaskData>, sessionNumber: number | null): PlanningPanelRow[] {
  return panelRows(planningLinkedItems(items, sessionNumber).slice().sort(byCreationNumber), tasksById);
}

/** The bugs and tasks a report session filed, in the order it filed them, with the same badges and actions as a planning session's tasks. */
export function bugReportSessionRows(items: PlanItemData[], tasksById: Record<string, TaskData>, sessionNumber: number | null): PlanningPanelRow[] {
  return panelRows(bugReportLinkedItems(items, sessionNumber).slice().sort(byCreationTime), tasksById, items, 'bug-report');
}

/** The tasks and bugs a Plan & bugs session filed, in the order it filed them, each tagged and with the parents it waits for. */
export function planAndBugsSessionRows(items: PlanItemData[], tasksById: Record<string, TaskData>, sessionNumber: number | null): PlanningPanelRow[] {
  return panelRows(planAndBugsLinkedItems(items, sessionNumber).slice().sort(byCreationTime), tasksById, items, 'plan-and-bugs');
}

const LOCKED_LABEL = 'Started – locked';

/** The "Depends on" chip of a row: its parents by number, or "a deleted task" for one that is gone. */
function dependsOnChipOf(item: PlanItemData, items: PlanItemData[]): { dependsOnChip?: string } {
  const labels = (item.dependsOn ?? []).map((id) => { const parent = items.find((entry) => entry.id === id); return parent ? dependencyLabel(parent) : 'a deleted task'; });
  const chip = dependencyChip(labels);
  return chip ? { dependsOnChip: chip } : {};
}

function panelRows(linked: PlanItemData[], tasksById: Record<string, TaskData>, items: PlanItemData[] = [], kind: SessionKind = 'planning'): PlanningPanelRow[] {
  return linked
    .flatMap((item): PlanningPanelRow[] => {
      const category = planningTaskCategory(item);
      if (category === 'archived') return [];
      const { number, name } = splitTaskNumber(item.title);
      const badge = category === 'ready' ? READY : category === 'completed' ? COMPLETED : startedBadge(item, latestItemTask(item, tasksById));
      return [{ id: item.id, number, title: name, fullTitle: item.title, description: item.description, category, badge, action: category === 'ready' ? 'expand' : 'open',
        ...(kind !== 'planning' ? { related: relatedLinks(item, items), ...(category !== 'ready' ? { lockedLabel: LOCKED_LABEL } : {}) } : {}),
        ...(kind === 'plan-and-bugs' ? { kindTag: isBugItem(item) ? 'Bug' as const : 'Task' as const, ...dependsOnChipOf(item, items) } : {}) }];
    });
}

/** What the panel and the history strip call a session's items: tasks for a planning conversation, bugs for a bug report session. */
export interface SessionPanelWording {
  heading: 'Session tasks' | 'Session bugs and tasks';
  historyHeading: 'Planning history' | 'Bug report history' | 'Plan & bugs history';
  emptyText: string;
}

const BUGS_AND_TASKS_EMPTY = 'Bugs and tasks this session files will appear here.';

export const sessionPanelWording = (kind: SessionKind): SessionPanelWording => (kind === 'plan-and-bugs'
  ? { heading: 'Session bugs and tasks', historyHeading: 'Plan & bugs history', emptyText: BUGS_AND_TASKS_EMPTY }
  : kind === 'bug-report'
    ? { heading: 'Session bugs and tasks', historyHeading: 'Bug report history', emptyText: BUGS_AND_TASKS_EMPTY }
    : { heading: 'Session tasks', historyHeading: 'Planning history', emptyText: 'Tasks this session creates will appear here.' });

/** A session's history counts and ready items, over what its kind files: tasks, bugs, or both. */
export function sessionHistoryView(input: { items: PlanItemData[]; sessionNumber: number | null; createdTaskCount: number; kind: SessionKind }) {
  const { items, sessionNumber, createdTaskCount } = input;
  if (input.kind === 'plan-and-bugs') {
    const history = planAndBugsHistory(items, sessionNumber, createdTaskCount);
    return { history, countsLabel: planAndBugsCountsLabel(history) };
  }
  if (input.kind === 'bug-report') {
    const history = bugReportHistory(items, sessionNumber, createdTaskCount);
    return { history, countsLabel: bugReportCountsLabel(history) };
  }
  const history = planningTaskHistory(items, sessionNumber, createdTaskCount);
  return { history, countsLabel: planningHistoryCountsLabel(history) };
}

/** The panel's rows, its header counts (the history strip's own) and whether to show the empty line. `kind` picks what the session's rows are: tasks, bugs, or both. */
export function buildPlanningTaskPanel(input: {
  items: PlanItemData[];
  tasksById: Record<string, TaskData>;
  sessionNumber: number | null;
  createdTaskCount: number;
  kind: SessionKind;
}): { rows: PlanningPanelRow[]; countsLabel: string; empty: boolean } {
  const rowsOf = input.kind === 'plan-and-bugs' ? planAndBugsSessionRows : input.kind === 'bug-report' ? bugReportSessionRows : planningSessionTaskRows;
  const rows = rowsOf(input.items, input.tasksById, input.sessionNumber);
  return { rows, countsLabel: sessionHistoryView(input).countsLabel, empty: rows.length === 0 };
}

/**
 * What opening a row shows, resolved the way a board card's click is (`cardDetail`): the task's
 * WorkflowRun, else its latest Task's session, else the item's own details. Null once the item is gone.
 */
export function planningRowDetail(items: PlanItemData[], tasksById: Record<string, TaskData>, itemId: string): CardDetail | null {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) return null;
  const latestTask = latestItemTask(item, tasksById);
  return cardDetail({ id: item.id, workflowRunId: item.workflowRunId, canOpenSession: !!latestTask, latestTaskId: latestTask?.id ?? null });
}

/**
 * Where Back leads from a viewer: the planning session whose panel opened it, for as long as that
 * session's Task exists, else the board (null). An archived session still counts: starting its last
 * ready task completes and archives it while its view stays open.
 */
export function detailBackTarget(originSessionId: string | null, tasksById: Record<string, Pick<TaskData, 'id'>>): CardDetail | null {
  const origin = originSessionId ? tasksById[originSessionId] : undefined;
  return origin ? { kind: 'task', id: origin.id } : null;
}

/** `expanded` with `id` flipped, as a new set. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Whether a row shows expanded: only a ready row can, so one started or deleted elsewhere closes. */
export const isRowExpanded = (expanded: ReadonlySet<string>, row: Pick<PlanningPanelRow, 'id' | 'action'>) =>
  row.action === 'expand' && expanded.has(row.id);
