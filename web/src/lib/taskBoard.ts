import type { PlanItemData, TaskData } from '../types';
import { pendingTaskRows, planningQueueTasks } from './projectTasks';
import type { CompletedRow, OpenTaskRow, PlanningQueueEntry, StepCardElapsed, StepCardProgress, TaskMetrics } from './projectTasks';
import type { WorkflowRunRecord } from './serverApi';
import { formatCompactDuration, formatRelativeTime, formatTimestamp } from './sessionTiming';
import { groupMoveAnnouncement, isBugItem } from './bugs';
import { plural } from './text';

/**
 * The Tasks tab's kanban board: its four columns, detail actions, and drag-and-drop decisions.
 */

export type BoardColumn = 'planning' | 'running' | 'needsYou' | 'done';

/** Left to right. */
export const BOARD_COLUMNS: BoardColumn[] = ['planning', 'running', 'needsYou', 'done'];

/** Task actions surfaced by the applicable detail view. */
export type OpenCardAction =
  | 'open'
  | 'start'
  | 'resume'
  | 'pause'
  | 'edit'
  | 'duplicate'
  | 'interimCommit'
  | 'complete'
  | 'archive'
  | 'delete';

/** Whether clicking the card has a detail view to open: its WorkflowRun, or its latest Task's session. */
export const canOpenCard = (row: Pick<OpenTaskRow, 'workflowRunId' | 'canOpenSession'>) => !!row.workflowRunId || row.canOpenSession;

/**
 * What clicking a card opens — every card opens something: its WorkflowRun, else its latest Task's
 * session, else (a task that has never run, or one marked done by hand) the plan item's own details.
 */
export type CardDetail = { kind: 'run'; id: string; focus?: RunFocus } | { kind: 'task'; id: string } | { kind: 'item'; id: string };

/** A step round to open a WorkflowRun's detail on, in place of its current step. `round` is null when only the step is known. */
export interface RunFocus { stepId: string; round: number | null }

export function cardDetail(row: Pick<OpenTaskRow, 'id' | 'canOpenSession' | 'latestTaskId'> & { workflowRunId?: string | null }): CardDetail {
  if (row.workflowRunId) return { kind: 'run', id: row.workflowRunId };
  if (row.canOpenSession && row.latestTaskId) return { kind: 'task', id: row.latestTaskId };
  return { kind: 'item', id: row.id };
}

/** How far (px) the pointer may move between press and release for it still to count as a click on a card. */
const CLICK_DRIFT_PX = 4;

/**
 * Whether a click on a card should open it: not the tail end of a drag. A click with no recorded press
 * (assistive tech activating it) always counts. The browser's own drag-and-drop already swallows the
 * click after a real drag; this also covers a press that moved a little without starting one.
 */
export function isCardClick(down: { x: number; y: number } | null, up: { x: number; y: number }): boolean {
  return !down || Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_DRIFT_PX;
}

/** A title's number — a planning task's `<session>.<task>` ("3.002: Add login" → "3.002" and "Add login") or a bug's ("3.002.001", "B.004"); null for a hand-typed title. */
export function splitTaskNumber(title: string): { number: string | null; name: string } {
  const match = /^(\d+(?:\.\d{3,})+|B\.\d{3,}):\s*(.*)$/s.exec(title);
  return match ? { number: match[1]!, name: match[2]! } : { number: null, name: title };
}

/** Where a plan item came from: the planning session that wrote it (with its number once that Task is loaded), or by hand. */
function provenanceLabel(item: Pick<PlanItemData, 'planningTaskId' | 'planningRef' | 'type' | 'bug'>, tasksById: Record<string, Pick<TaskData, 'planningSessionNumber'>>): string {
  if (isBugItem(item)) return item.bug?.reportSessionNumber ? `From bug report session ${item.bug.reportSessionNumber}` : 'Found by a coding agent';
  if (!item.planningTaskId && !item.planningRef) return 'Added manually';
  const number = item.planningRef?.session ?? (item.planningTaskId ? tasksById[item.planningTaskId]?.planningSessionNumber : undefined);
  return number ? `From planning session ${number}` : 'From a planning session';
}

/**
 * A task details header's title: the item's title without the `<session>.<task>` prefix, that
 * `number` on its own, and a durable provenance label that remains visible after execution or
 * deletion of the planning conversation that created it.
 */
export function taskItemInfo(
  item: Pick<PlanItemData, 'title' | 'planningTaskId' | 'planningRef' | 'createdAt' | 'type' | 'bug'>,
  tasksById: Record<string, Pick<TaskData, 'planningSessionNumber'>>,
): { name: string; number: string | null; provenance: string; meta: string[] } {
  const { number, name } = splitTaskNumber(item.title);
  const provenance = provenanceLabel(item, tasksById);
  return { name, number, provenance, meta: [...(number ? [number] : []), provenance, `Created ${formatTimestamp(item.createdAt)}`] };
}

/**
 * The task details header's run control: Stop while any of the item's CLIs is live (running, or
 * waiting on input) in a run that can still stop, Resume once the run is stopped, else neither — a
 * task that hasn't started, or whose run has finished.
 */
export type RunControl = 'stop' | 'resume' | null;

export function runControl(run: Pick<WorkflowRunRecord, 'status'> | null, tasks: Pick<TaskData, 'status'>[]): RunControl {
  if (!run) return null;
  if (run.status === 'stopped') return 'resume';
  if (run.status === 'completed') return null;
  // Setting up has no session yet, but Stop cancels the setup.
  if (run.status === 'starting') return 'stop';
  return tasks.some((task) => task.status === 'developing' || task.status === 'blocked') ? 'stop' : null;
}

const LIVE_RUN_STATUSES: ReadonlySet<WorkflowRunRecord['status']> = new Set(['starting', 'running', 'completing']);

/**
 * The task details header's compact timing: when the run started, when it ended ("Running" while it
 * still is, "—" when it halted without finishing), and the total time spent (`planItemSpentMs`).
 */
export function runTimingParts(run: Pick<WorkflowRunRecord, 'status' | 'createdAt' | 'completedAt'>, spentMs: number): string[] {
  const ended = run.completedAt ? formatTimestamp(run.completedAt) : LIVE_RUN_STATUSES.has(run.status) ? 'Running' : '—';
  return [`Started ${formatTimestamp(run.createdAt)}`, `Ended ${ended}`, `${formatCompactDuration(spentMs)} spent`];
}

/** Only the actions that apply to the row right now — nothing is shown disabled. */
export function openCardActions(row: OpenTaskRow): OpenCardAction[] {
  const applies: Record<OpenCardAction, boolean> = {
    open: canOpenCard(row),
    start: row.primary === 'start',
    resume: row.primary === 'resume',
    pause: row.primary === 'pause',
    edit: row.canEdit,
    duplicate: true,
    interimCommit: row.canInterimCommit,
    complete: row.canComplete,
    archive: row.canArchive,
    delete: row.canDelete,
  };
  return (Object.keys(applies) as OpenCardAction[]).filter((action) => applies[action]);
}

export type CompletedCardAction = 'open' | 'archive' | 'unarchive' | 'delete';

/** A finished (or archived) card can only be opened (once it has a session) or, for a plan item, archived/unarchived or deleted. */
export function completedCardActions(row: Pick<CompletedRow, 'canOpenSession' | 'latestTaskId' | 'canArchive' | 'canUnarchive' | 'canDelete'>): CompletedCardAction[] {
  return [
    ...(row.canOpenSession && row.latestTaskId ? ['open' as const] : []),
    ...(row.canArchive ? ['archive' as const] : []),
    ...(row.canUnarchive ? ['unarchive' as const] : []),
    ...(row.canDelete ? ['delete' as const] : []),
  ];
}

/** The card footer's time: when execution started ("Started 5m ago"), or "Not started" for a task that never ran. */
export function cardStartedLabel(metrics: Pick<TaskMetrics, 'startedAt'> | null, now: Date): string {
  return metrics ? `Started ${formatRelativeTime(metrics.startedAt, now)}` : 'Not started';
}

/** The footer time for a task held back by unmerged parents: the person already started it, so it reads "Waiting", not "Not started". */
export function cardFooterStartedLabel(row: { metrics: Pick<TaskMetrics, 'startedAt'> | null; waiting?: unknown }, now: Date): string {
  return row.waiting && !row.metrics ? 'Waiting' : cardStartedLabel(row.metrics, now);
}

/**
 * The Running card's progress line (tasks 5.017 + 5.003): the current step's name, its live elapsed
 * time, and its checklist progress — each shown only once there's something to show. `elapsed` is
 * null for a run record written before task 5.003's round-timing fields existed; `checklist` is null
 * before the step's agent has ever called `report_progress` this round. Null only when there's
 * nothing at all — no current step, or (old record, no report yet) neither piece of data.
 */
export function stepCardProgress(
  run: Pick<WorkflowRunRecord, 'currentStepId' | 'workflowSnapshot' | 'currentStepProgress' | 'currentStepRoundStartedAt' | 'currentStepPriorRoundsMs'>,
): StepCardProgress | null {
  const step = run.currentStepId ? run.workflowSnapshot.steps.find((s) => s.id === run.currentStepId) : undefined;
  if (!step) return null;
  const elapsed = run.currentStepRoundStartedAt ? { roundStartedAt: run.currentStepRoundStartedAt, priorMs: run.currentStepPriorRoundsMs ?? 0 } : null;
  const progress = run.currentStepProgress;
  const checklist = progress ? { done: progress.done, total: progress.total, estimate: progress.estimate } : null;
  return elapsed || checklist ? { stepName: step.name, elapsed, checklist } : null;
}

/** A card's live elapsed time, in ms: every earlier round's total plus how long the active round has been running. */
export function stepCardElapsedMs(elapsed: Pick<StepCardElapsed, 'roundStartedAt' | 'priorMs'>, now: number): number {
  return elapsed.priorMs + Math.max(0, now - new Date(elapsed.roundStartedAt).getTime());
}

/** "Development · 3m 12s · 3/7 · ~10m left" — step name once, then its live elapsed time and checklist counts/estimate, each omitted when there's nothing to show for it. */
export function cardProgressLine(progress: StepCardProgress, now: number): string {
  const parts = [progress.stepName];
  if (progress.elapsed) parts.push(formatCompactDuration(stepCardElapsedMs(progress.elapsed, now), { seconds: true }));
  if (progress.checklist) {
    parts.push(`${progress.checklist.done}/${progress.checklist.total}`);
    if (progress.checklist.estimate) parts.push(progress.checklist.estimate);
  }
  return parts.join(' · ');
}

/** A card as drag-and-drop sees it. `primary` says whether an open card can start. */
export interface BoardCard {
  id: string;
  primary?: OpenTaskRow['primary'];
  /** The group a nested card sits in — a planning session's id for its tasks, or `bugGroupKey` for the bugs under one introducing task: it reorders only within that group, or leaves for Running. */
  group?: string;
  /** An introducing-task reference card: it holds a place in the top-level order but is never dragged or moved itself. */
  locked?: boolean;
}

/**
 * Whether a column's cards can be dragged: every column but Completed, which is ordered by completion
 * time (`buildCompletedRows`), so there's no manual order to change and nothing leaves it by drag.
 */
export const canDragFrom = (column: BoardColumn) => column !== 'done';

/** Whether this card can be picked up: a card of a draggable column that is not a reference card. */
export const canDragCard = (column: BoardColumn, card: Pick<BoardCard, 'locked'>) => canDragFrom(column) && !card.locked;

/** What a keyboard move says to a screen reader once it has been applied. */
export function dropAnnouncement<T extends BoardCard>(drop: BoardDrop<T>, direction: 'up' | 'down'): string {
  if (drop.kind === 'start') return 'Opening start options.';
  return drop.kind === 'reorderGroup' ? groupMoveAnnouncement(drop.group, direction) : `Moved card ${direction}.`;
}

/** What a key press on part of a Planning card does. */
export type BoardKeyAction = 'open' | 'reorder' | 'toggle' | null;

/**
 * The keyboard contract of a Planning card's parts. The card body opens on Enter or Space and
 * reorders on Alt+Up/Down. A drag handle only reorders: Enter and Space never open the detail from
 * it. An expander only toggles. A reference card opens its introducing task and never moves; once
 * that task is removed it does nothing.
 */
export function boardKeyAction(part: 'card' | 'handle' | 'expander' | 'reference', event: { key: string; altKey: boolean }, removed = false): BoardKeyAction {
  const activates = !event.altKey && (event.key === 'Enter' || event.key === ' ');
  const moves = event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown');
  if (part === 'expander') return activates ? 'toggle' : null;
  if (part === 'reference') return activates && !removed ? 'open' : null;
  if (part === 'handle') return moves ? 'reorder' : null;
  return activates ? 'open' : moves ? 'reorder' : null;
}

/** Only Completed can collapse to a narrow strip (task 5.018) — Planning, Running and Needs you always show in full. */
export const canCollapse = (column: BoardColumn) => column === 'done';

/**
 * Where a dragged card lands: a column, and the position in it (0 = top, length = bottom) — among the
 * column's top-level cards, or, with `group`, among that planning group's nested tasks.
 */
export interface BoardDropTarget {
  column: BoardColumn;
  index: number;
  group?: string;
}

/** What a drop asks for: top-level cards or one planning group's tasks in a new sequence, or starting a Planning task after confirmation. */
export type BoardDrop<T extends BoardCard> =
  | { kind: 'reorder'; ids: string[] }
  | { kind: 'reorderGroup'; group: string; ids: string[] }
  | { kind: 'start'; card: T };

type BoardColumns<T extends BoardCard> = Record<BoardColumn, T[]>;

/** Which column a card is in, and the card itself; null when no column has it. */
export function findCard<T extends BoardCard>(columns: BoardColumns<T>, id: string): { column: BoardColumn; card: T } | null {
  for (const column of BOARD_COLUMNS) {
    const card = columns[column].find((candidate) => candidate.id === id);
    if (card) return { column, card };
  }
  return null;
}

/**
 * Whether the dragged card may be dropped on `column` (inside `group`'s list, when given): among its own
 * peers in its own column (a reorder — never in Completed, see `canDragFrom`), or from Planning onto
 * Running when it can start — the only move between columns. A nested task's peers are its own group's
 * tasks, so it can't land at the top level or in another group. Everything else, reaching Completed
 * included, moves by itself as its run progresses.
 */
export function canDropOn<T extends BoardCard>(columns: BoardColumns<T>, draggedId: string, column: BoardColumn, group?: string): boolean {
  const found = findCard(columns, draggedId);
  if (!found || !canDragCard(found.column, found.card)) return false;
  if (found.column === column) return found.card.group === group;
  return found.column === 'planning' && column === 'running' && found.card.primary === 'start';
}

/** The cards `card` reorders among: its own planning group's tasks, or its column's top-level cards. */
export function reorderPeers<T extends BoardCard>(cards: T[], card: BoardCard): T[] {
  return cards.filter((candidate) => candidate.group === card.group);
}

/** `current` with `id` placed at `index` (clamped). Taking the card out from above the drop point shifts that point up by one. */
function placeAt(current: string[], id: string, index: number): string[] {
  const others = current.filter((other) => other !== id);
  const from = current.indexOf(id);
  const at = Math.max(0, Math.min(from !== -1 && from < index ? index - 1 : index, others.length));
  return [...others.slice(0, at), id, ...others.slice(at)];
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Works out what dropping `draggedId` at `target` changes, or null when nothing would: an unknown or
 * Completed card, a move between columns other than Planning → Running, a nested task outside its own
 * group, or a drop back onto its own place.
 */
export function planBoardDrop<T extends BoardCard>(columns: BoardColumns<T>, draggedId: string, target: BoardDropTarget): BoardDrop<T> | null {
  if (!canDropOn(columns, draggedId, target.column, target.group)) return null;
  const { column, card } = findCard(columns, draggedId)!;
  if (column !== target.column) return { kind: 'start', card };
  const current = reorderPeers(columns[column], card).map((candidate) => candidate.id);
  const ids = placeAt(current, draggedId, target.index);
  if (sameOrder(ids, current)) return null;
  return card.group ? { kind: 'reorderGroup', group: card.group, ids } : { kind: 'reorder', ids };
}

// ---- "Pending only": the board filtered to pending tasks (opened from a 3D yard's crate stack) ----

export interface PendingOnlyView {
  /** The pending task cards (`pendingTaskRows`) in board order, nested ones flattened, sessions left out. */
  cards: OpenTaskRow[];
  /** Every other column, collapsed to a strip with its exact count. */
  strips: { column: Exclude<BoardColumn, 'planning'>; count: number }[];
  /** The line beside the filter chip. */
  hint: string;
}

export const PENDING_ONLY_EMPTY = 'No task is waiting to start.';

/** What the Tasks board shows with the "Pending only" filter on; `counts` are the other columns' card counts. */
export function pendingOnlyView(queue: readonly PlanningQueueEntry[], counts: Record<Exclude<BoardColumn, 'planning'>, number>): PendingOnlyView {
  const cards = pendingTaskRows(queue);
  const sessions = queue.filter((entry) => entry.kind === 'session').length;
  const others = planningQueueTasks(queue).length - cards.length + counts.running + counts.needsYou + counts.done;
  const hidden = [sessions && plural(sessions, 'planning session'), others && plural(others, 'other task')].filter(Boolean);
  const hiddenLine = hidden.length === 0 ? '' : ` ${hidden.join(' and ')} ${sessions + others === 1 ? 'is' : 'are'} hidden.`;
  return {
    cards,
    strips: (['running', 'needsYou', 'done'] as const).map((column) => ({ column, count: counts[column] })),
    hint: cards.length === 0 ? PENDING_ONLY_EMPTY : `Not-started tasks from the Planning column.${hiddenLine}`,
  };
}
