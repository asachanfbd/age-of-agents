import { formatCompactDuration } from './sessionTiming';
import { groupTaskChains } from './taskChain';
import { bugCardInfo, isBugItem, relatedLinks, bugGroupId, bugReportLinkedItems, buildBugGroups, compareBugGroupOrder, isBugReportSession, isReadyBug, planAndBugsLinkedItems, referenceCardId, sessionKindOf, type SessionKind } from './bugs';
import type { BugCardInfo, BugReferenceGroup, RelatedLink } from './bugs';
import type { EarlyPhase } from './earlyUiPlanning';
import type { ExecutorProfile, PlanItemQueueEntry, TokenUsage, WorkflowRunRecord } from './serverApi';
import { queuePlaces } from './waitingList';
import type { QueuedPlace } from './waitingList';
import { dependencyLabel } from './dependencies';
import { completedAutoMergeHold } from './autoMerge';
import type { HoldableItem } from './autoMerge';
import { taskPrView } from './taskPullRequest';
import type { TaskPrView } from './taskPullRequest';
import type { AutoMergeData, PlanItemData, TaskData, WaitingData } from '../types';

/**
 * View-models for the project popup's unified Tasks board: planning conversations, tasks in each
 * execution state, and archived items. Everything here is pure — the popup only
 * renders what these return, and the per-row `can*` flags decide which controls are enabled.
 */

/**
 * How an open task is progressing. 'todo' hasn't been started; 'blocked' waits on an answer;
 * 'failed'/'stopped' can be re-run or, for a terminal Task, resumed.
 */
export type OpenTaskState = 'todo' | 'executing' | 'paused' | 'blocked' | 'failed' | 'stopped';

/**
 * What the row's play/pause control does. 'none' means no control (a blocked Task is answered from
 * its session view instead).
 */
export type PrimaryAction = 'start' | 'pause' | 'resume' | 'none';

/**
 * Why a row needs the user, shown even when the row is collapsed: 'input' — a Task is blocked waiting
 * for an answer; 'failed' — it failed and nothing has resolved it yet. Null when nothing is needed.
 */
export type Attention = 'input' | 'failed' | null;

export interface TaskMetrics {
  tokens: number;
  /** When the earliest Task in this row started. */
  startedAt: string;
  /** Total time Tasks in this row have run, in ms. */
  spentMs: number;
}

export interface OpenTaskRow {
  id: string;
  title: string;
  description: string;
  state: OpenTaskState;
  archived: boolean;
  workerId: string | null;
  /** Null until the item has run at least one Task. */
  metrics: TaskMetrics | null;
  createdAt: string;
  latestTaskId: string | null;
  primary: PrimaryAction;
  attention: Attention;
  canEdit: boolean;
  canComplete: boolean;
  /** Completing a paused terminal Task goes through its session (`completeTerminalTask`), which settles it done directly — not a plain status change. */
  completesViaSession: boolean;
  /** The latest Task is still running on a repository branch, so its work so far can be committed and pushed (`interimCommitTask`). */
  canInterimCommit: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canOpenSession: boolean;
  /** The most recent WorkflowRun executing this item, if any has ever started — see `lib/workflowTaskGroups.ts`'s `buildTaskGroups`/`findWorkflowRun`, which group and look up rows by this id. */
  workflowRunId: string | null;
  /** The task's Auto-merge, for the card's chip; absent until it was ever switched on. */
  autoMerge?: AutoMergeData;
  /** The task's own pull request as the card shows it (tag, badge, hint), for a task without Auto-merge. */
  pr?: TaskPrView;
  /** Ids of the tasks this one waits for. */
  dependsOn?: string[];
  /** How the parents are named on the card's chip (`dependencyLabel`), in `dependsOn` order. */
  dependsOnLabels?: string[];
  /** Set while the task waits for its parents; it shows as Waiting/Blocked (the board puts it in Running) and offers no Start. */
  waiting?: WaitingData;
  /** Set while the task waits in line for a free slot at the Project's task limit; the board groups it with the waiting tasks. */
  queued?: QueuedPlace;
  /** How far a waiting task's early UI Planning has got (set by `buildTaskGroups`, which knows the run). */
  earlyPhase?: EarlyPhase;
  /** The card's type badge, for an item that isn't an ordinary task — see `planItemTypeLabel`. */
  typeLabel?: string;
  /** Set only on a bug: its Bug badge extras, wherever the card shows — see `lib/bugs.ts`'s `bugCardInfo`. */
  bug?: BugCardInfo;
  /** The bug/task pair links of an item filed in a bug report session; absent when there are none. */
  related?: RelatedLink[];
  /**
   * The Running column card's step-name/live-timer/"N/M · ~estimate" line (tasks 5.017 + 5.003) — set
   * only by `buildTaskGroups` for a row it places in the `running` group, from that row's own
   * WorkflowRun; absent everywhere else (including a running row with neither piece of data yet,
   * which shows nothing extra, exactly today's card). See `lib/taskBoard.ts`'s `stepCardProgress`.
   */
  progress?: StepCardProgress | null;
}

/** A Running card's live-timer inputs (task 5.003) — see `lib/taskBoard.ts`'s `stepCardElapsedMs`. */
export interface StepCardElapsed {
  /** The current round's own `createdAt`. */
  roundStartedAt: string;
  /** Every earlier round's own ms, already summed. */
  priorMs: number;
}

/** A Running card's checklist inputs (task 5.017), once the agent has reported progress this round. */
export interface StepCardChecklist {
  done: number;
  total: number;
  estimate: string | null;
}

/** One Running card's progress line (tasks 5.017 + 5.003) — see `lib/taskBoard.ts`'s `stepCardProgress`/`cardProgressLine`. */
export interface StepCardProgress {
  stepName: string;
  /** Null for a run record written before task 5.003's round-timing fields existed. */
  elapsed: StepCardElapsed | null;
  /** Null until the step's agent has called `report_progress` this round. */
  checklist: StepCardChecklist | null;
}

export interface PlanningRow {
  /** The chain's latest Task id — what opening the session shows. */
  id: string;
  title: string;
  description: string;
  workerId: string;
  metrics: TaskMetrics;
  archived: boolean;
  /** 'running' while a turn is in flight, 'blocked' waiting on an answer, otherwise 'idle' (between turns). */
  live: 'running' | 'blocked' | 'idle';
  attention: Attention;
  canArchive: boolean;
  queueOrder: number;
  sessionNumber: number | null;
  completedAt: string | null;
  createdTaskCount: number;
  /** Planning conversation, earlier bug report session, or Plan & bugs session. */
  kind: SessionKind;
  /** Created with no coding agent available: no CLI yet. */
  cliNotStarted: boolean;
}

/** A planning session's live-state words, shared by the Planning board card and the 3D village's planning robots. */
export const PLANNING_LIVE_TITLE: Record<PlanningRow['live'], string> = {
  running: 'Running',
  blocked: 'Waiting for input',
  idle: 'Between turns',
};

/** A planning session's live-state dot colour, shared by every view that marks a session's state. */
export const PLANNING_LIVE_DOT: Record<PlanningRow['live'], string> = {
  running: 'bg-success',
  blocked: 'bg-warning',
  idle: 'bg-muted-foreground/50',
};

export interface PlanningGroup extends PlanningRow {
  /** The ready tasks nested beneath a planning or Plan & bugs session; always empty for a bug report session, whose bugs sit under their introducing tasks. */
  ready: OpenTaskRow[];
  startedCount: number;
  completedCount: number;
  archivedCount: number;
  removedCount: number;
  /** A bug-filing session's ready-bug count; its bugs are not in `ready`. */
  readyBugCount?: number;
  /** A bug-filing session's ready-task count: nested in `ready` for Plan & bugs, otherwise in the Unstarted column like any task. */
  readyTaskCount?: number;
  /** Introducing-task cards shown beneath this conversation, after its ready tasks: bugs against tasks it created. Absent when there are none. */
  references?: BugReferenceGroup<OpenTaskRow>[];
}

type GroupOrdered = Pick<PlanItemData, 'planningGroupOrder' | 'planningRef'>;

/** A planning group's ready-task order (mirrors the daemon's): saved positions first, then unpositioned tasks oldest first, so new tasks join the end. */
export function comparePlanningGroupOrder(a: GroupOrdered, b: GroupOrdered): number {
  const rank = (item: GroupOrdered) => item.planningGroupOrder ?? Number.POSITIVE_INFINITY;
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  return (a.planningRef?.task ?? 0) - (b.planningRef?.task ?? 0);
}

/** A linked task's planning history category; the four never overlap. */
export type PlanningTaskCategory = 'ready' | 'started' | 'completed' | 'archived';

/**
 * Ready is unarchived pending; started is unarchived and neither pending nor done (stopped, failed and
 * blocked included); completed is done, archived or not; archived is archived and not done.
 */
export function planningTaskCategory(item: Pick<PlanItemData, 'status' | 'archived'>): PlanningTaskCategory {
  if (item.status === 'done') return 'completed';
  if (item.archived) return 'archived';
  return item.status === 'pending' ? 'ready' : 'started';
}

/** The plan items a planning session created that still exist; none for a session with no number. */
export function planningLinkedItems(items: PlanItemData[], sessionNumber: number | null): PlanItemData[] {
  return sessionNumber ? items.filter((item) => item.planningRef?.session === sessionNumber) : [];
}

/** What became of the items one session created: its ready ones in `order`, and a count per other category. Removed is what it created that no longer exists. */
function sessionHistory(linked: PlanItemData[], createdCount: number, order: (a: PlanItemData, b: PlanItemData) => number) {
  const count = (category: PlanningTaskCategory) => linked.filter((item) => planningTaskCategory(item) === category).length;
  return {
    ready: linked.filter((item) => planningTaskCategory(item) === 'ready').sort(order),
    startedCount: count('started'),
    completedCount: count('completed'),
    archivedCount: count('archived'),
    removedCount: Math.max(createdCount - linked.length, 0),
  };
}

export type SessionHistory = ReturnType<typeof sessionHistory>;

export function planningTaskHistory(items: PlanItemData[], sessionNumber: number | null, createdTaskCount: number): SessionHistory {
  return sessionHistory(planningLinkedItems(items, sessionNumber), createdTaskCount, comparePlanningGroupOrder);
}

/** A bug report session's history, by the same categories as a planning conversation's, over the bugs it filed. */
export function bugReportHistory(items: PlanItemData[], sessionNumber: number | null, filedCount: number): SessionHistory & { taskCount: number } {
  const linked = bugReportLinkedItems(items, sessionNumber);
  return { ...sessionHistory(linked, filedCount, compareBugGroupOrder), taskCount: linked.filter((item) => !isBugItem(item)).length };
}

/** A Plan & bugs session's history over the tasks and bugs it filed, ready ones in group order. */
export function planAndBugsHistory(items: PlanItemData[], sessionNumber: number | null, filedCount: number): SessionHistory {
  return sessionHistory(planAndBugsLinkedItems(items, sessionNumber), filedCount, comparePlanningGroupOrder);
}

/** The history of the session kind the row stands for. */
function historyOf(kind: SessionKind, items: PlanItemData[], sessionNumber: number | null, filedCount: number): SessionHistory {
  return (kind === 'plan-and-bugs' ? planAndBugsHistory : kind === 'bug-report' ? bugReportHistory : planningTaskHistory)(items, sessionNumber, filedCount);
}

function otherCategoriesLabel(history: SessionHistory): string[] {
  return [
    history.startedCount ? `${history.startedCount} started` : '',
    history.completedCount ? `${history.completedCount} completed` : '',
    history.archivedCount ? `${history.archivedCount} archived` : '',
    history.removedCount ? `${history.removedCount} removed` : '',
  ].filter(Boolean);
}

/** "2 tasks ready · 1 bug · 1 started": a Plan & bugs session's ready tasks, its ready bugs when it has any, then every other category that has items. */
export function planAndBugsCountsLabel(history: SessionHistory): string {
  const bugs = history.ready.filter(isBugItem).length;
  const tasks = history.ready.length - bugs;
  return [`${tasks} ${tasks === 1 ? 'task' : 'tasks'} ready`, bugs ? `${bugs} ${bugs === 1 ? 'bug' : 'bugs'}` : '', ...otherCategoriesLabel(history)].filter(Boolean).join(' · ');
}

function historyCountsLabel(history: SessionHistory, noun: string): string {
  return [`${history.ready.length} ${history.ready.length === 1 ? noun : `${noun}s`} ready`, ...otherCategoriesLabel(history)].join(' · ');
}

/** "2 tasks ready · 1 started · 1 removed": the ready count always, every other category only when it has any. */
export const planningHistoryCountsLabel = (history: SessionHistory): string => historyCountsLabel(history, 'task');

/** "2 bugs ready · 1 started": a bug report session's counts, in the same shape. Counts "items" once it has filed a task. */
export const bugReportCountsLabel = (history: SessionHistory & { taskCount?: number }): string => historyCountsLabel(history, history.taskCount ? 'item' : 'bug');

/**
 * One top-level entry of the Planning column: a session (planning conversation or bug report), a
 * standalone task or bug, or a top-level introducing-task reference card (`id` is that task's id)
 * with its ready bugs.
 */
export type PlanningQueueEntry =
  | { kind: 'session'; id: string; order: number; session: PlanningGroup }
  | { kind: 'task'; id: string; order: number; task: OpenTaskRow }
  | { kind: 'reference'; id: string; order: number; reference: BugReferenceGroup<OpenTaskRow> };

export interface CompletedRow {
  /** A plan item's id, or a Task's id for a settled Task with no plan item. */
  id: string;
  kind: 'item' | 'task';
  title: string;
  description: string;
  workerId: string | null;
  metrics: TaskMetrics | null;
  /** Set for a Task that finished 'failed' with no plan item to keep it open. */
  failed: boolean;
  /** The item's actual status, including when an unfinished item was archived. */
  statusBadge: 'Running' | 'Needs you' | 'Failed' | 'Stopped' | 'Completed' | null;
  attention: Attention;
  createdAt: string;
  /** When it finished (`itemCompletedAt`, or a Task's settle) — what Completed and Archived sort by, newest first; null when unknown. */
  completedAt: string | null;
  latestTaskId: string | null;
  canOpenSession: boolean;
  /** The plan item's WorkflowRun, if it ran through one — opening the card shows that run (`cardDetail`), not just its last step's session. */
  workflowRunId: string | null;
  /** The task's Auto-merge, for the card's chip; absent until it was ever switched on. */
  autoMerge?: AutoMergeData;
  /** The task's own pull request as the card shows it (tag, badge, hint), for a task without Auto-merge. */
  pr?: TaskPrView;
  /** Only a plan item can be archived or deleted — there is no Task delete endpoint yet. */
  canArchive: boolean;
  /** Only on the Archived tab (`buildArchivedRows`): the item can be put back on the board. */
  canUnarchive: boolean;
  canDelete: boolean;
  /** The card's type badge, for an item that isn't an ordinary task — see `planItemTypeLabel`. */
  typeLabel?: string;
  /** Set only on a bug — see `OpenTaskRow.bug`. */
  bug?: BugCardInfo;
}

/** A worker's display name: its executor label, 'Unassigned' when none is set, or the raw id if that executor was since deleted. */
export function workerLabel(executors: Pick<ExecutorProfile, 'id' | 'label'>[], executorId: string | null): string {
  if (!executorId) return 'Unassigned';
  return executors.find((executor) => executor.id === executorId)?.label ?? executorId;
}

/** First line of a multi-line description — a session/row's one-line title. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim());
  return (line ?? text).trim();
}

/**
 * The description to show (and copy) on a task session: the linked plan item's own description,
 * which is what the user wrote, falling back to the full prompt the task ran with.
 */
export function taskDescriptionText(task: Pick<TaskData, 'description'>, planItem?: Pick<PlanItemData, 'description'> | null): string {
  return planItem?.description.trim() || task.description.trim();
}

const tokenTotal = (usage: TokenUsage | null | undefined): number =>
  usage ? usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens : 0;

/** When a settled Task finished: `completedAt`, else its last modification. */
const taskSettledAt = (task: Pick<TaskData, 'completedAt' | 'updatedAt'>) => task.completedAt ?? task.updatedAt;

/** When a Task stopped consuming time: now while it is actively running, otherwise its last settle. */
function taskEndMs(task: TaskData, now: number): number {
  if (task.status === 'developing') return now;
  return new Date(taskSettledAt(task)).getTime();
}

/** A timestamp in ms, or NaN when it's missing or unparseable. */
const timeOf = (timestamp: string | null | undefined) => (timestamp ? Date.parse(timestamp) : NaN);

/**
 * When a plan item was completed: its WorkflowRun's `completedAt` when the run has one; otherwise the later
 * of the item's own last change (a hand-marked completion sets it) and its latest Task's settle. Null when
 * none of those is known.
 */
export function itemCompletedAt(
  item: Pick<PlanItemData, 'updatedAt'>,
  latestTask: Pick<TaskData, 'completedAt' | 'updatedAt'> | undefined,
  run: Pick<WorkflowRunRecord, 'completedAt'> | undefined,
): string | null {
  if (run?.completedAt) return run.completedAt;
  const candidates = [item.updatedAt, latestTask && taskSettledAt(latestTask)].filter((at): at is string => !Number.isNaN(timeOf(at)));
  return candidates.reduce<string | null>((latest, at) => (latest === null || timeOf(at) > timeOf(latest) ? at : latest), null);
}

/**
 * Rows newest-completed first, so a card that has just finished tops its list; rows with no `completedAt`
 * go last. Ties keep their given order (`Array#sort` is stable) — `NaN || 0` makes two unknowns a tie.
 */
export function sortByCompletedDesc<T extends Pick<CompletedRow, 'completedAt'>>(rows: T[]): T[] {
  const rank = (row: T) => {
    const time = timeOf(row.completedAt);
    return Number.isNaN(time) ? -Infinity : time;
  };
  return [...rows].sort((a, b) => rank(b) - rank(a) || 0);
}

/** Tokens, earliest start and total run time across a set of Tasks; null for none. */
export function taskMetrics(tasks: TaskData[], now: number): TaskMetrics | null {
  if (tasks.length === 0) return null;
  const startedAt = tasks.reduce((earliest, task) => (task.createdAt < earliest ? task.createdAt : earliest), tasks[0]!.createdAt);
  return {
    tokens: tasks.reduce((sum, task) => sum + tokenTotal(task.tokenUsage), 0),
    startedAt,
    spentMs: tasks.reduce((sum, task) => sum + Math.max(0, taskEndMs(task, now) - new Date(task.createdAt).getTime()), 0),
  };
}

const isActive = (status: PlanItemData['status']) => status === 'developing' || status === 'blocked';

function itemTasks(item: Pick<PlanItemData, 'taskIds'>, tasksById: Record<string, TaskData>): TaskData[] {
  return item.taskIds.map((id) => tasksById[id]).filter((task): task is TaskData => !!task);
}

/**
 * Total time the item's Tasks have spent, in ms: each Task's `(completedAt ?? updatedAt, or now while
 * it runs) − createdAt`, summed (see `taskMetrics`). 0 before anything has run.
 */
export function planItemSpentMs(item: Pick<PlanItemData, 'taskIds'>, tasksById: Record<string, TaskData>, now: number): number {
  return taskMetrics(itemTasks(item, tasksById), now)?.spentMs ?? 0;
}

/** The item's latest Task — the one whose session a detail view names — or undefined before it has run. */
export function latestItemTask(item: Pick<PlanItemData, 'taskIds'>, tasksById: Record<string, TaskData>): TaskData | undefined {
  const lastId = item.taskIds[item.taskIds.length - 1];
  return lastId ? tasksById[lastId] : undefined;
}

/** Why the item can't be archived right now (the daemon refuses while it's developing), or null when it can. */
export function archiveBlockedReason(item: Pick<PlanItemData, 'status'>): string | null {
  return item.status === 'developing' ? 'Stop the task before archiving it.' : null;
}

/**
 * Which of archive / mark complete / delete apply to a plan item — the same rules for a board card's
 * task details. A WorkflowRun-backed item can be completed or deleted while it runs (the
 * daemon halts the run first); a pre-workflow item with a live Task can't.
 */
export function planItemActions(item: Pick<PlanItemData, 'status' | 'workflowRunId'>): { canArchive: boolean; canComplete: boolean; canDelete: boolean } {
  const settledOrRun = !isActive(item.status) || !!item.workflowRunId;
  return { canArchive: !archiveBlockedReason(item), canComplete: item.status !== 'done' && settledOrRun, canDelete: settledOrRun };
}

/** A paused terminal Task finishes through `completeTerminalTask`, settling it done directly — wherever "Mark complete" is clicked. */
export const completesViaSession = (task: TaskData) => task.executionMode === 'terminal' && task.status === 'stopped';

/** A settled terminal session with a saved session id can be reopened (`resumeTerminalTask`) — until it's archived. */
export const canResumeSession = (task: TaskData) =>
  !task.archived && task.executionMode === 'terminal' && !!task.sessionId && (task.status === 'done' || task.status === 'failed' || task.status === 'stopped');

/** Mirrors the daemon's `interimCommitTask` guard: only an ongoing Task on a repository branch still has uncommitted work to push. */
export const canInterimCommit = (task: TaskData) => (task.status === 'developing' || task.status === 'blocked') && !!task.branch;

/** What to tell the user after an interim commit — `committed` is false when the branch had no new changes. */
export const interimCommitNotice = ({ committed, message }: { committed: boolean; message: string }) =>
  committed ? `Committed and pushed "${message}".` : 'Nothing new to commit — the branch is pushed and up to date.';

/** A settled terminal Task with a saved session can be reopened rather than re-run from scratch. */
const isResumable = (item: PlanItemData, last: TaskData | undefined) =>
  (item.status === 'failed' || item.status === 'stopped') && last?.executionMode === 'terminal' && !!last.sessionId;

/** A terminal Task whose CLI is waiting on the person, which the board shows as "Needs you" whatever the item's status. */
export const isWaitingForInput = (task: Pick<TaskData, 'executionMode' | 'runtimeStatus'> | undefined) =>
  task?.executionMode === 'terminal' && task.runtimeStatus === 'waiting_input';

function openState(item: PlanItemData, resumable: boolean, last: TaskData | undefined): OpenTaskState {
  if (isWaitingForInput(last)) return 'blocked';
  if (item.status === 'developing') return 'executing';
  if (item.status === 'blocked') return 'blocked';
  if (item.status === 'pending') return 'todo';
  if (item.status === 'stopped') return resumable ? 'paused' : 'stopped';
  return 'failed';
}

const openAttention = (state: OpenTaskState): Attention => (state === 'blocked' ? 'input' : state === 'failed' ? 'failed' : null);

/** The most urgent reason among rows — waiting on the user outranks a failure — for a group-level indicator. */
export function worstAttention(rows: { attention: Attention }[]): Attention {
  if (rows.some((row) => row.attention === 'input')) return 'input';
  return rows.some((row) => row.attention === 'failed') ? 'failed' : null;
}

function primaryAction(state: OpenTaskState, resumable: boolean): PrimaryAction {
  if (state === 'executing') return 'pause';
  if (state === 'blocked') return 'none';
  return resumable ? 'resume' : 'start';
}

/** A card's type badge: "PR conflicts" for the conflict-resolution run the PR tab's Merge started; none for an ordinary task. */
export function planItemTypeLabel(item: Pick<PlanItemData, 'prConflict'>): string | undefined {
  return item.prConflict ? 'PR conflicts' : undefined;
}

function typeLabelOf(item: Pick<PlanItemData, 'prConflict'>): { typeLabel?: string } {
  const typeLabel = planItemTypeLabel(item);
  return typeLabel ? { typeLabel } : {};
}

/** A bug's card extras; nothing for a task, so a task's row is exactly what it was. */
function bugInfoOf(item: PlanItemData, existingIds: ReadonlySet<string>): { bug?: BugCardInfo } {
  const bug = bugCardInfo(item, existingIds);
  return bug ? { bug } : {};
}

/** The card's links to its bug/task counterpart; nothing for an item outside a report session's pair. */
function relatedOf(item: PlanItemData, items: PlanItemData[]): { related?: RelatedLink[] } {
  const related = relatedLinks(item, items);
  return related.length ? { related } : {};
}

/** The card's `pr` field for a finished task; nothing for a task still working, whose reading (if any) is not about its current run. */
function prViewOf(item: PlanItemData, run?: WorkflowRunRecord): { pr?: TaskPrView } {
  const finished = item.status === 'done' || run?.status === 'completed';
  const pr = finished ? taskPrView(item, run) : null;
  return pr ? { pr } : {};
}

const idsOf = (items: PlanItemData[]): ReadonlySet<string> => new Set(items.map((item) => item.id));

/**
 * Tasks not yet completed, in plan order, filtered to the archived or active set.
 * An item counts as archived once it's archived itself (`PATCH /api/plan-items/:id {archived}`) or,
 * from before items could be, its latest Task's session was archived (`archiveSession`).
 */
export function buildOpenTaskRows(input: {
  items: PlanItemData[];
  tasksById: Record<string, TaskData>;
  showArchived: boolean;
  now: number;
  /** Also keep these finished (`done`) items: tasks still held back from Completed by an unmerged PR. */
  keepDone?: (item: PlanItemData) => boolean;
  /** The Project's waiting list; a listed task is marked `queued` with its place in line. */
  queue?: readonly PlanItemQueueEntry[];
}): OpenTaskRow[] {
  const { items, tasksById, showArchived, now } = input;
  const places = queuePlaces(input.queue);
  const existingIds = idsOf(items);
  return items
    .filter((item) => item.status !== 'done' || !!input.keepDone?.(item))
    .map((item): OpenTaskRow => {
      const tasks = itemTasks(item, tasksById);
      const last = latestItemTask(item, tasksById);
      const resumable = isResumable(item, last);
      const state = openState(item, resumable, last);
      const { canArchive, canComplete, canDelete } = planItemActions(item);
      return {
        id: item.id,
        title: item.title,
        description: item.description,
        state,
        archived: !!item.archived || !!last?.archived,
        workerId: item.executorId ?? last?.executorId ?? item.waiting?.options.executorId ?? null,
        metrics: taskMetrics(tasks, now),
        createdAt: item.createdAt,
        latestTaskId: last?.id ?? null,
        attention: openAttention(state),
        primary: item.waiting || places.has(item.id) ? 'none' : primaryAction(state, resumable),
        canEdit: item.status === 'pending',
        canComplete,
        // A run-backed item completes through its plan item, which commits and completes the run.
        completesViaSession: !item.workflowRunId && !!last && completesViaSession(last),
        canInterimCommit: !!last && canInterimCommit(last),
        canArchive,
        canDelete,
        canOpenSession: !!last,
        workflowRunId: item.workflowRunId ?? null,
        ...(item.autoMerge ? { autoMerge: item.autoMerge } : {}),
        ...prViewOf(item),
        ...(item.dependsOn?.length ? { dependsOn: item.dependsOn, dependsOnLabels: item.dependsOn.map((id) => { const parent = items.find((entry) => entry.id === id); return parent ? dependencyLabel(parent) : 'a deleted task'; }) } : {}),
        ...(item.waiting ? { waiting: item.waiting } : {}),
        ...(places.has(item.id) ? { queued: places.get(item.id) } : {}),
        ...typeLabelOf(item),
        ...bugInfoOf(item, existingIds),
        ...relatedOf(item, items),
      };
    })
    .filter((row) => row.archived === showArchived);
}

/** A planning session's generated title, or its opening prompt's first line until that arrives. `chain` is the session's Tasks, in any order. */
export function planningSessionName(chain: TaskData[]): string {
  const opening = chain.reduce((earliest, task) => (task.createdAt < earliest.createdAt ? task : earliest));
  return chain.find((task) => task.title)?.title ?? firstLine(opening.description);
}

/** "3: Plan the backend" — the session's name, numbered with what its created tasks are titled with when the session has one. */
export function planningSessionTitle(chain: TaskData[]): string {
  const number = chain.find((task) => task.planningSessionNumber)?.planningSessionNumber;
  const name = planningSessionName(chain);
  return number ? `${number}: ${name}` : name;
}

/**
 * Planning sessions: every 'plan'-kind conversation chain, newest first, filtered to the archived or
 * active set. Plan & bugs sessions are planning-type and always listed; the earlier bug report
 * sessions are left out unless `includeBugReports`, so every count of planning sessions stays a count of those.
 */
export function buildPlanningRows(input: {
  taskIds: string[];
  tasksById: Record<string, TaskData>;
  showArchived: boolean;
  now: number;
  includeBugReports?: boolean;
}): PlanningRow[] {
  const { taskIds, tasksById, showArchived, now } = input;
  return groupTaskChains(taskIds, tasksById, 'plan')
    .filter((chain) => !!chain[0]!.archived === showArchived && (input.includeBugReports || !isBugReportSession(chain[0])))
    .map((chain): PlanningRow => {
      const latest = chain[0]!;
      const waiting = chain.some((task) => task.executionMode === 'terminal' && task.runtimeStatus === 'waiting_input');
      const running = chain.some((task) => task.status === 'developing');
      const blocked = chain.some((task) => task.status === 'blocked');
      // The latest prompt, unless it's what the (not yet generated) title already shows.
      const prompt = firstLine(latest.description);
      return {
        id: latest.id,
        title: planningSessionTitle(chain),
        description: prompt === planningSessionName(chain) ? '' : prompt,
        workerId: latest.executorId,
        metrics: taskMetrics(chain, now)!,
        archived: !!latest.archived,
        live: waiting || blocked ? 'blocked' : running ? 'running' : 'idle',
        attention: waiting || blocked ? 'input' : null,
        canArchive: !running && !blocked,
        queueOrder: latest.planningQueueOrder ?? -new Date(latest.createdAt).getTime(),
        sessionNumber: latest.planningSessionNumber ?? null,
        completedAt: latest.planningCompletedAt ?? null,
        createdTaskCount: latest.planningCreatedTaskCount ?? 0,
        kind: sessionKindOf(latest),
        cliNotStarted: !!latest.cliNotStarted,
      };
    });
}

/**
 * The Planning column's persisted mixed top-level queue and what nests beneath each entry: a
 * conversation's ready tasks, and ready bugs under the reference card of the task that introduced
 * them. That card sits beneath the introducing task's conversation while it is on the board, and
 * at the top level otherwise. A bug report session nests nothing.
 */
export function buildPlanningQueue(input: {
  items: PlanItemData[];
  taskIds: string[];
  tasksById: Record<string, TaskData>;
  now: number;
  openRows?: OpenTaskRow[];
}): PlanningQueueEntry[] {
  const sessions = buildPlanningRows({ taskIds: input.taskIds, tasksById: input.tasksById, showArchived: false, now: input.now, includeBugReports: true });
  const archivedSessions = buildPlanningRows({ taskIds: input.taskIds, tasksById: input.tasksById, showArchived: true, now: input.now, includeBugReports: true });
  const openRows = input.openRows ?? buildOpenTaskRows({ items: input.items, tasksById: input.tasksById, showArchived: false, now: input.now });
  const rowsById = new Map(openRows.map((row) => [row.id, row]));
  const activeSessions = new Map(sessions.flatMap((session) => session.sessionNumber ? [[session.sessionNumber, session] as const] : []));
  const archivedByNumber = new Map(archivedSessions.flatMap((session) => session.sessionNumber ? [[session.sessionNumber, session] as const] : []));
  const bugGroups = buildBugGroups({ items: input.items, tasksById: input.tasksById, rowsById });
  const conversationOf = (group: BugReferenceGroup<OpenTaskRow>) => (group.sessionNumber ? activeSessions.get(group.sessionNumber) : undefined);
  const entries: PlanningQueueEntry[] = sessions.map((session) => {
    const history = historyOf(session.kind, input.items, session.sessionNumber, session.createdTaskCount);
    // A bug report session nests nothing; a Plan & bugs session nests its tasks (its bugs sit under introducing tasks or alone).
    const ready = session.kind === 'bug-report' ? [] : history.ready
      .filter((item) => !isBugItem(item))
      .map((item) => rowsById.get(item.id))
      .filter((row): row is OpenTaskRow => !!row);
    const references = bugGroups.filter((group) => conversationOf(group)?.id === session.id);
    return {
      kind: 'session', id: session.id, order: session.queueOrder,
      session: {
        ...session,
        ready,
        startedCount: history.startedCount,
        completedCount: history.completedCount,
        archivedCount: history.archivedCount,
        removedCount: history.removedCount,
        ...(session.kind !== 'planning' ? { readyBugCount: history.ready.filter(isBugItem).length, readyTaskCount: history.ready.filter((item) => !isBugItem(item)).length } : {}),
        ...(references.length ? { references } : {}),
      },
    };
  });
  for (const group of bugGroups) {
    if (!conversationOf(group)) entries.push({ kind: 'reference', id: group.id, order: group.queueOrder, reference: group });
  }
  // A released task with no saved queue slot sits in its completed parent's slot, in the group's order.
  const releasedOrders = new Map<string, number>();
  for (const [number, session] of archivedByNumber) {
    const { ready } = planningTaskHistory(input.items, number, session.createdTaskCount);
    ready.forEach((item, index) => releasedOrders.set(item.id, session.queueOrder + (index + 1) / (ready.length + 1)));
  }
  for (const item of input.items) {
    if (item.archived || (item.status === 'pending' && item.planningRef && activeSessions.has(item.planningRef.session))) continue;
    // A ready bug with a known introducing task shows under that task's reference card, not on its own.
    if (isReadyBug(item) && bugGroupId(item)) continue;
    const row = rowsById.get(item.id);
    if (row) entries.push({ kind: 'task', id: item.id, order: item.planningQueueOrder ?? releasedOrders.get(item.id) ?? -new Date(item.createdAt).getTime(), task: row });
  }
  return entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The Planning column's task cards in board order: top-level tasks, each session's ready tasks, and
 * each reference card's bugs. Sessions and reference cards themselves are not task cards.
 */
export function planningQueueTasks(queue: readonly PlanningQueueEntry[]): OpenTaskRow[] {
  const bugsOf = (groups: readonly BugReferenceGroup<OpenTaskRow>[] | undefined) => (groups ?? []).flatMap((group) => group.bugs);
  return queue.flatMap((entry) => {
    if (entry.kind === 'task') return [entry.task];
    if (entry.kind === 'reference') return entry.reference.bugs;
    return [...entry.session.ready, ...bugsOf(entry.session.references)];
  });
}

/** A card that stopped or failed with no run of its own (a freeform task): a red box in the 3D yard, not a pending task. */
export const stoppedWithoutRun = (row: Pick<OpenTaskRow, 'workflowRunId' | 'state'>): boolean =>
  !row.workflowRunId && (row.state === 'failed' || row.state === 'stopped');

/**
 * The Project's pending tasks: its Planning column's task cards (`planningQueueTasks`), each once,
 * minus those that stopped or failed with no run. The 3D yard's crate stack and the Tasks tab's
 * "Pending only" filter both show exactly these, so the stack's badge equals the filter's count.
 */
export function pendingTaskRows(queue: readonly PlanningQueueEntry[]): OpenTaskRow[] {
  const seen = new Set<string>();
  return planningQueueTasks(queue).filter((row) => {
    if (stoppedWithoutRun(row) || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/** An entry's id as a board card. A reference card gets one of its own, so it never collides with the task it stands for. */
export const queueCardId = (entry: Pick<PlanningQueueEntry, 'kind' | 'id'>): string => (entry.kind === 'reference' ? referenceCardId(entry.id) : entry.id);

/**
 * The top-level order to save after a drop: `cardIds` (board card ids, in their new sequence) as the
 * daemon's `{ kind, id }` entries. Null when a card is not a top-level Planning entry, so the caller
 * can treat the drop as some other column's reorder.
 */
export function planningQueueOrderEntries(queue: PlanningQueueEntry[], cardIds: string[]): { kind: PlanningQueueEntry['kind']; id: string }[] | null {
  const byCardId = new Map(queue.map((entry) => [queueCardId(entry), entry]));
  const entries = cardIds.map((id) => byCardId.get(id));
  return entries.every((entry) => !!entry) ? entries.map((entry) => ({ kind: entry!.kind, id: entry!.id })) : null;
}

/**
 * Completed: plan items marked done (by a finished Task or by hand) or whose WorkflowRun completed, and any
 * settled execute Task that no longer belongs to a listed plan item (a freeform run, or one whose item was
 * deleted) — all newest-completed first (`sortByCompletedDesc`), so the column has no manual order.
 */
export function buildCompletedRows(input: {
  items: PlanItemData[];
  taskIds: string[];
  tasksById: Record<string, TaskData>;
  /** The Project's WorkflowRuns — an item whose run completed is completed whatever its own status says. */
  workflowRuns?: WorkflowRunRecord[];
  now: number;
  /** Every plan item id of the Project, when `items` is only part of them, so a bug still links to its introducing task. */
  allItemIds?: ReadonlySet<string>;
}): CompletedRow[] {
  const { items, taskIds, tasksById, now } = input;
  const itemIds = new Set(items.map((item) => item.id));
  const existingIds = input.allItemIds ?? itemIds;
  const runsById = indexRuns(input.workflowRuns);
  const runOf = (item: PlanItemData) => (item.workflowRunId ? runsById.get(item.workflowRunId) : undefined);
  // A finished task stays out of Completed while its PR is unmerged (Auto-merge on: the daemon's state; off: the last PR reading).
  const isCompleted = (item: PlanItemData) => (item.status === 'done' || runOf(item)?.status === 'completed') && !completedAutoMergeHold(item, runOf(item));

  const fromItems = items
    .filter((item) => isCompleted(item) && !item.archived)
    .map((item) => itemCardRow(item, tasksById, runsById, now, existingIds));

  const fromTasks = taskIds
    .map((id) => tasksById[id])
    .filter((task): task is TaskData => !!task && !task.archived && task.kind === 'execute' && (task.status === 'done' || task.status === 'failed'))
    .filter((task) => !task.planItemId || !itemIds.has(task.planItemId))
    .map((task): CompletedRow => ({
      id: task.id,
      kind: 'task',
      title: firstLine(task.description),
      description: task.failureReason ?? '',
      workerId: task.executorId,
      metrics: taskMetrics([task], now),
      failed: task.status === 'failed',
      statusBadge: task.status === 'failed' ? 'Failed' : 'Completed',
      attention: task.status === 'failed' ? 'failed' : null,
      createdAt: task.createdAt,
      completedAt: taskSettledAt(task),
      latestTaskId: task.id,
      canOpenSession: true,
      workflowRunId: null,
      canArchive: false,
      canUnarchive: false,
      canDelete: false,
    }));

  return sortByCompletedDesc([...fromItems, ...fromTasks]);
}

const indexRuns = (runs: WorkflowRunRecord[] = []) => new Map(runs.map((run) => [run.id, run]));

/** A plan item as a finished-style card row (Completed column, Archived tab): archivable and deletable. */
function itemCardRow(item: PlanItemData, tasksById: Record<string, TaskData>, runsById: Map<string, WorkflowRunRecord>, now: number, existingIds: ReadonlySet<string>): CompletedRow {
  const tasks = itemTasks(item, tasksById);
  const last = tasks[tasks.length - 1];
  const run = item.workflowRunId ? runsById.get(item.workflowRunId) : undefined;
  const statusBadge = item.status === 'pending' ? null
    : item.status === 'developing' ? 'Running'
    : item.status === 'blocked' ? 'Needs you'
    : item.status === 'failed' ? 'Failed'
    : item.status === 'stopped' ? 'Stopped'
    : 'Completed';
  return {
    id: item.id,
    kind: 'item',
    title: item.title,
    description: item.description,
    workerId: item.executorId ?? last?.executorId ?? null,
    metrics: taskMetrics(tasks, now),
    failed: false,
    statusBadge: run?.status === 'completed' ? 'Completed' : statusBadge,
    attention: null,
    createdAt: item.createdAt,
    completedAt: itemCompletedAt(item, last, run),
    latestTaskId: last?.id ?? null,
    canOpenSession: !!last,
    workflowRunId: item.workflowRunId ?? null,
    ...(item.autoMerge ? { autoMerge: item.autoMerge } : {}),
    ...prViewOf(item, run),
    canArchive: true,
    canUnarchive: false,
    canDelete: true,
    ...typeLabelOf(item),
    ...bugInfoOf(item, existingIds),
  };
}

/** Whether the project has any archived plan item — what shows the workspace's Archived tab. */
export const hasArchivedItems = (items: Pick<PlanItemData, 'archived'>[], tasks: Pick<TaskData, 'kind' | 'archived'>[] = []) =>
  items.some((item) => item.archived) || tasks.some((task) => task.kind === 'plan' && !!task.archived);

/**
 * The Archived tab: every archived plan item (whatever its status), newest-completed first like the
 * Completed column, as cards that can be unarchived or (when `planItemActions` allows) deleted.
 */
export function buildArchivedRows(input: { items: PlanItemData[]; tasksById: Record<string, TaskData>; workflowRuns?: WorkflowRunRecord[]; now: number; allItemIds?: ReadonlySet<string> }): CompletedRow[] {
  const runsById = indexRuns(input.workflowRuns);
  const existingIds = input.allItemIds ?? idsOf(input.items);
  return sortByCompletedDesc(
    input.items
      .filter((item) => item.archived)
      .map((item) => ({ ...itemCardRow(item, input.tasksById, runsById, input.now, existingIds), canArchive: false, canUnarchive: true, canDelete: planItemActions(item).canDelete })),
  );
}

/** One alert for a bulk action where some items failed: "Couldn't archive 2 of 5 tasks: <each distinct reason>". */
export function bulkFailureMessage(verb: string, failures: string[], total: number): string {
  return `Couldn't ${verb} ${failures.length} of ${total} ${total === 1 ? 'task' : 'tasks'}: ${[...new Set(failures)].join('; ')}`;
}

/** "1h 12m spent" — total run time for a row that has run. */
export function spentLabel(metrics: TaskMetrics): string {
  return `${formatCompactDuration(metrics.spentMs)} spent`;
}

/** A project's plan items split three ways — what the three-colour progress bar draws. */
export interface TaskProgress {
  done: number;
  inProgress: number;
  pending: number;
  total: number;
}

/**
 * Counts plan items as done, in progress (running, blocked on an answer, or finished but waiting for
 * its PR to merge) or pending (everything
 * else — not started, paused, stopped or failed and waiting to be re-run).
 */
export function taskProgress(items: HoldableItem[]): TaskProgress {
  const held = (item: (typeof items)[number]) => item.status === 'done' && !!completedAutoMergeHold(item, null);
  const done = items.filter((item) => item.status === 'done' && !held(item)).length;
  const inProgress = items.filter((item) => isActive(item.status) || held(item)).length;
  return { done, inProgress, pending: items.length - done - inProgress, total: items.length };
}

/** "3 done · 1 in progress · 2 pending" — the progress bar's accessible label and tooltip. */
export function taskProgressLabel({ done, inProgress, pending }: TaskProgress): string {
  return `${done} done · ${inProgress} in progress · ${pending} pending`;
}
