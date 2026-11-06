import type { PlanItemData, TaskData } from '../types';
import { plural } from './text';

/**
 * View-model for bugs on the Tasks board. A bug is a plan item of type 'bug': the same card as a
 * task plus a Bug badge, severity, Info status and the task that introduced it. Ready bugs are
 * grouped under an introducing-task reference card. Everything here is pure; the board, the dialogs
 * and the detail views only render what these return.
 */

export type BugSeverity = 'critical' | 'high' | 'medium' | 'low';
export type BugInfoStatus = 'enough' | 'needs-more-info';

export interface BugTaskRef {
  planItemId: string;
  number: string | null;
  title: string;
}

export interface BugIntroducedBy extends BugTaskRef {
  commit: string | null;
}

export type BugRegressionReporter = { kind: 'person' } | { kind: 'report-session'; sessionNumber: number };

/** One report that a completed bug's fix did not cure it. Mirrors server/src/domain/types.ts's BugRegression. */
export interface BugRegression {
  reason: string;
  reportedAt: string;
  reporter: BugRegressionReporter;
}

/** Mirrors server/src/domain/types.ts's BugAttributes. */
export interface BugAttributes {
  severity: BugSeverity | null;
  infoStatus: BugInfoStatus | null;
  introducedBy: BugIntroducedBy | null;
  suspectedLocation: string | null;
  foundWhileWorkingOn: BugTaskRef | null;
  reportSessionNumber: number | null;
  testRef: { suiteId: string; actionId: string; caseId: string } | null;
  groupOrder: number | null;
  /** Oldest first, as stored; a bug from before regressions existed has none. */
  regressions: BugRegression[];
}

const SEVERITIES: BugSeverity[] = ['critical', 'high', 'medium', 'low'];
const INFO_STATUSES: BugInfoStatus[] = ['enough', 'needs-more-info'];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

function readTaskRef(value: unknown): BugTaskRef | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.planItemId !== 'string' || !raw.planItemId) return null;
  return { planItemId: raw.planItemId, number: textOrNull(raw.number), title: typeof raw.title === 'string' ? raw.title : '' };
}

function readRegressions(value: unknown): BugRegression[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): BugRegression[] => {
    const raw = asRecord(entry);
    const reporter = asRecord(raw?.reporter);
    if (!raw || typeof raw.reason !== 'string' || typeof raw.reportedAt !== 'string' || !reporter) return [];
    if (reporter.kind === 'person') return [{ reason: raw.reason, reportedAt: raw.reportedAt, reporter: { kind: 'person' } }];
    if (reporter.kind === 'report-session' && typeof reporter.sessionNumber === 'number') {
      return [{ reason: raw.reason, reportedAt: raw.reportedAt, reporter: { kind: 'report-session', sessionNumber: reporter.sessionNumber } }];
    }
    return [];
  });
}

/** A bug's attributes as the daemon sent them; anything missing or unreadable is null, never an error. */
export function readBugAttributes(value: unknown): BugAttributes {
  const raw = asRecord(value) ?? {};
  const introducedBy = readTaskRef(raw.introducedBy);
  const testRef = asRecord(raw.testRef);
  return {
    severity: SEVERITIES.includes(raw.severity as BugSeverity) ? raw.severity as BugSeverity : null,
    infoStatus: INFO_STATUSES.includes(raw.infoStatus as BugInfoStatus) ? raw.infoStatus as BugInfoStatus : null,
    introducedBy: introducedBy ? { ...introducedBy, commit: textOrNull(asRecord(raw.introducedBy)!.commit) } : null,
    suspectedLocation: textOrNull(raw.suspectedLocation),
    foundWhileWorkingOn: readTaskRef(raw.foundWhileWorkingOn),
    reportSessionNumber: typeof raw.reportSessionNumber === 'number' ? raw.reportSessionNumber : null,
    testRef: testRef && typeof testRef.suiteId === 'string' && typeof testRef.actionId === 'string' && typeof testRef.caseId === 'string'
      ? { suiteId: testRef.suiteId, actionId: testRef.actionId, caseId: testRef.caseId }
      : null,
    groupOrder: typeof raw.groupOrder === 'number' && Number.isFinite(raw.groupOrder) ? raw.groupOrder : null,
    regressions: readRegressions(raw.regressions),
  };
}

type Typed = Pick<PlanItemData, 'type' | 'bug'>;

/** An item with no type is a task. */
export const isBugItem = (item: Pick<PlanItemData, 'type'>): boolean => item.type === 'bug';

const bugOf = (item: Typed): BugAttributes | null => (isBugItem(item) ? item.bug ?? readBugAttributes(null) : null);

/** A ready bug waits in Planning: not started and not archived. */
export const isReadyBug = (item: Pick<PlanItemData, 'type' | 'status' | 'archived'>): boolean =>
  isBugItem(item) && item.status === 'pending' && !item.archived;

/** The id of the task a bug is grouped under while it is ready, or null for a standalone bug or a task. */
export const bugGroupId = (item: Typed): string | null => bugOf(item)?.introducedBy?.planItemId ?? null;

// ---- Badges and labels ----

/** The card's type badge. A bug never carries the Planning label. */
export const BUG_BADGE_LABEL = 'Bug';

const SEVERITY_NAMES: Record<BugSeverity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** "High severity"; null when no severity is set, so no badge shows. */
export const severityBadgeLabel = (severity: BugSeverity | null): string | null => (severity ? `${SEVERITY_NAMES[severity]} severity` : null);

export const INFO_STATUS_LABELS: Record<BugInfoStatus, string> = { enough: 'Enough info', 'needs-more-info': 'Needs more info' };

const COMMIT_DISPLAY_LENGTH = 7;

/** "4.002: Add login" — a task as a bug names it, from the number and title copied when the bug was filed. */
export const taskRefLabel = (ref: Pick<BugTaskRef, 'number' | 'title'>): string => [ref.number, ref.title].filter(Boolean).join(': ');

/** "4.002: Add login · abc1234" — the introducing task and, when found, its commit shortened. */
export function introducedByText(ref: BugIntroducedBy): string {
  return ref.commit ? `${taskRefLabel(ref)} · ${ref.commit.slice(0, COMMIT_DISPLAY_LENGTH)}` : taskRefLabel(ref);
}

/** A task a bug names, and whether it can still be opened: `taskId` is null once that task is gone. */
export interface BugTaskLink {
  text: string;
  taskId: string | null;
}

/** What a bug's card shows beyond a task's. */
export interface BugCardInfo {
  /** "High severity", or null when unset. */
  severityLabel: string | null;
  /** "Needs more info" is a badge; "Enough info" is plain footer text; an unset flag shows neither. */
  needsMoreInfo: boolean;
  footer: string | null;
  introducedBy: BugTaskLink | null;
  /** "Regressed ×2" once a regression was reported; null for a bug that never regressed. */
  regressedLabel: string | null;
}

const linkTo = (ref: BugTaskRef, text: string, existingIds: ReadonlySet<string>): BugTaskLink => ({ text, taskId: existingIds.has(ref.planItemId) ? ref.planItemId : null });

/** The card extras for a bug; undefined for a task. `existingIds` are the plan items that still exist. */
export function bugCardInfo(item: Typed, existingIds: ReadonlySet<string>): BugCardInfo | undefined {
  const bug = bugOf(item);
  if (!bug) return undefined;
  return {
    severityLabel: severityBadgeLabel(bug.severity),
    needsMoreInfo: bug.infoStatus === 'needs-more-info',
    footer: bug.infoStatus === 'enough' ? INFO_STATUS_LABELS.enough : null,
    introducedBy: bug.introducedBy ? linkTo(bug.introducedBy, introducedByText(bug.introducedBy), existingIds) : null,
    regressedLabel: regressedBadgeLabel(regressionsOf(bug).length),
  };
}

// ---- Bug and task links ----

/** A task filed in a bug report session carries a copy of the bug it relates to; anything unreadable is null. */
export const readRelatedBug = readTaskRef;

/** "Related to 10.010.003: title" on a task, "Related task: title" on a bug. `itemId` is null once the other item is gone, so the line is plain text. */
export interface RelatedLink {
  prefix: 'Related to' | 'Related task';
  text: string;
  itemId: string | null;
}

/**
 * The links a card shows to the other side of a bug/task pair filed in one report session: a task
 * names its bug (kept, struck through, once the bug is gone); a bug lists the tasks that name it
 * (a deleted or archived task drops out).
 */
export function relatedLinks(item: Pick<PlanItemData, 'id' | 'type' | 'relatedBug'>, items: readonly Pick<PlanItemData, 'id' | 'title' | 'relatedBug' | 'archived'>[]): RelatedLink[] {
  if (isBugItem(item)) {
    return items
      .filter((other) => !other.archived && readRelatedBug(other.relatedBug)?.planItemId === item.id)
      .map((task) => ({ prefix: 'Related task', text: task.title, itemId: task.id }));
  }
  const bug = readRelatedBug(item.relatedBug);
  if (!bug) return [];
  return [{ prefix: 'Related to', text: taskRefLabel(bug), itemId: items.some((other) => other.id === bug.planItemId) ? bug.planItemId : null }];
}

// ---- Detail view ----

export interface BugDetailRow {
  label: string;
  text: string;
}

const UNKNOWN = 'Unknown';
const NOT_SET = 'Not set';

/** The bug's attribute rows, in the order the detail view lists them, as plain text. "Found while working on" shows only on an agent-found bug. */
export function bugDetailRows(item: Typed): BugDetailRow[] {
  const bug = bugOf(item);
  if (!bug) return [];
  return [
    { label: 'Severity', text: bug.severity ? SEVERITY_NAMES[bug.severity] : NOT_SET },
    { label: 'Info status', text: bug.infoStatus ? INFO_STATUS_LABELS[bug.infoStatus] : NOT_SET },
    { label: 'Introduced by', text: bug.introducedBy ? introducedByText(bug.introducedBy) : UNKNOWN },
    { label: 'Suspected location', text: bug.suspectedLocation ?? UNKNOWN },
    ...(bug.foundWhileWorkingOn ? [{ label: 'Found while working on', text: taskRefLabel(bug.foundWhileWorkingOn) }] : []),
  ];
}

/** The Info status switch works only while the bug has not started. */
export const canChangeInfoStatus = (item: Pick<PlanItemData, 'type' | 'status'>): boolean => isBugItem(item) && item.status === 'pending';

// ---- Introducing-task groups ----

const GROUP_PREFIX = 'bugs:';
const REFERENCE_PREFIX = 'reference:';

/** The drag-and-drop group a bug under one introducing task belongs to, distinct from any planning session's group. */
export const bugGroupKey = (introducerId: string): string => `${GROUP_PREFIX}${introducerId}`;

/** The introducing task's id for a bug group key; null for a planning session's group. */
export const bugGroupIntroducerId = (group: string): string | null => (group.startsWith(GROUP_PREFIX) ? group.slice(GROUP_PREFIX.length) : null);

/** A top-level reference card's id on the board, kept apart from the id of the task it stands for. */
export const referenceCardId = (introducerId: string): string => `${REFERENCE_PREFIX}${introducerId}`;

export type ReferenceStatus = 'Running' | 'Needs you' | 'Failed' | 'Stopped' | 'Completed' | 'Removed';

/** The introducing task's reference card and the ready bugs nested beneath it. `Row` is the board's open-task row. */
export interface BugReferenceGroup<Row> {
  /** The introducing task's plan item id. */
  id: string;
  number: string | null;
  title: string;
  /** The task's current status; "Removed" once it was deleted; null for a task that has not started. */
  status: ReferenceStatus | null;
  /** The task no longer exists: the card shows the stored number and title, struck through, and opens nothing. */
  removed: boolean;
  /** The planning session that created the introducing task, when it has one: the group sits beneath that conversation while it is on the board. */
  sessionNumber: number | null;
  /** Where the group sits in the shared top-level Planning order. */
  queueOrder: number;
  expandedByDefault: boolean;
  bugs: Row[];
}

const waitingForInput = (task: Pick<TaskData, 'executionMode' | 'runtimeStatus'> | undefined) =>
  task?.executionMode === 'terminal' && task.runtimeStatus === 'waiting_input';

/** An introducing task's status in the board's own words; null while it has not started. */
export function referenceStatus(item: Pick<PlanItemData, 'status' | 'taskIds'>, tasksById: Record<string, TaskData>): ReferenceStatus | null {
  if (item.status === 'done') return 'Completed';
  if (item.status === 'blocked' || waitingForInput(tasksById[item.taskIds[item.taskIds.length - 1] ?? ''])) return 'Needs you';
  if (item.status === 'developing') return 'Running';
  if (item.status === 'failed') return 'Failed';
  return item.status === 'stopped' ? 'Stopped' : null;
}

/** A group opens by default while its introducing task is being worked on; idle, finished and removed ones start collapsed. */
export const expandsByDefault = (status: ReferenceStatus | null): boolean => status === 'Running' || status === 'Needs you';

/** A group's order: saved positions first, then unpositioned bugs in creation order, ties by id. */
export function compareBugGroupOrder(a: PlanItemData, b: PlanItemData): number {
  const rank = (item: PlanItemData) => bugOf(item)?.groupOrder ?? Number.POSITIVE_INFINITY;
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Every introducing task that has at least one ready bug, with those bugs in group order. A group
 * disappears when its last ready bug starts, is archived or is deleted. A bug whose row is not
 * among `rowsById` (it is not waiting in Planning) is left out.
 */
export function buildBugGroups<Row>(input: {
  items: PlanItemData[];
  tasksById: Record<string, TaskData>;
  rowsById: ReadonlyMap<string, Row>;
}): BugReferenceGroup<Row>[] {
  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  const byIntroducer = new Map<string, PlanItemData[]>();
  for (const item of input.items) {
    const groupId = bugGroupId(item);
    if (groupId && isReadyBug(item) && input.rowsById.has(item.id)) byIntroducer.set(groupId, [...(byIntroducer.get(groupId) ?? []), item]);
  }
  return [...byIntroducer].map(([id, bugs]) => {
    const introducer = itemsById.get(id);
    const stored = bugs[0]!.bug!.introducedBy!;
    const status: ReferenceStatus | null = introducer ? referenceStatus(introducer, input.tasksById) : 'Removed';
    const orders = bugs.map((bug) => bug.planningQueueOrder).filter((order): order is number => order !== undefined);
    return {
      id,
      number: stored.number,
      title: stored.title,
      status,
      removed: !introducer,
      sessionNumber: introducer?.planningRef?.session ?? null,
      queueOrder: orders.length ? Math.min(...orders) : -new Date(bugs[0]!.createdAt).getTime(),
      expandedByDefault: expandsByDefault(status),
      bugs: [...bugs].sort(compareBugGroupOrder).map((bug) => input.rowsById.get(bug.id)!),
    };
  });
}

/** Whether a group shows open: the person's toggle for as long as the view is mounted, else the default. */
export const isGroupExpanded = (toggles: Readonly<Record<string, boolean>>, group: { id: string; expandedByDefault: boolean }): boolean =>
  toggles[group.id] ?? group.expandedByDefault;

/** "Bugs · 2 ready" — always the number of cards nested beneath the reference card. */
export const bugGroupCountLabel = (count: number): string => `Bugs · ${count} ready`;

/** "Planning · 1 task ready · 2 bugs": the ready-task count as before, then the bugs grouped beneath this conversation, omitted at zero. */
export function conversationExpanderLabel(taskCount: number, bugCount: number): string {
  return `Planning · ${plural(taskCount, 'task')} ready${bugCount ? ` · ${plural(bugCount, 'bug')}` : ''}`;
}

/** How many ready bugs sit beneath a conversation: the sum of its reference cards' counts. */
export const nestedBugCount = (references: { bugs: unknown[] }[] | undefined): number =>
  (references ?? []).reduce((sum, reference) => sum + reference.bugs.length, 0);

/** "Moved bug up within its introducing task's group." / "Moved task up within its planning group." — what a group reorder announces. */
export function groupMoveAnnouncement(group: string, direction: 'up' | 'down'): string {
  return bugGroupIntroducerId(group) ? `Moved bug ${direction} within its introducing task's group.` : `Moved task ${direction} within its planning group.`;
}

// ---- Bug-filing sessions: Plan & bugs, and the earlier bug report session ----

type SessionTask = Pick<TaskData, 'kind' | 'planningPurpose'> | undefined;

/** The earlier bug report session: existing ones keep their tools, label and board appearance. */
export const isBugReportSession = (task: SessionTask): boolean => task?.kind === 'plan' && task.planningPurpose === 'bug-report';

/** The combined session that files tasks and bugs and sets their dependencies. */
export const isPlanAndBugsSession = (task: SessionTask): boolean => task?.kind === 'plan' && task.planningPurpose === 'plan-and-bugs';

export type SessionKind = 'planning' | 'bug-report' | 'plan-and-bugs';

/** Which of the three planning-style session kinds a 'plan' Task is. */
export const sessionKindOf = (task: SessionTask): SessionKind => (isPlanAndBugsSession(task) ? 'plan-and-bugs' : isBugReportSession(task) ? 'bug-report' : 'planning');

/** The Plan & bugs session's type label, always shown in text. */
export const PLAN_AND_BUGS_LABEL = 'Plan & bugs';

/** A Plan & bugs session's status badge: "CLI not started" before it has a CLI, "Planning" while the agent works, "Needs you" while it waits, none between turns. */
export function planAndBugsStatusLabel(session: { live: 'running' | 'blocked' | 'idle'; cliNotStarted: boolean }): string | null {
  if (session.cliNotStarted) return 'CLI not started';
  return session.live === 'running' ? 'Planning' : session.live === 'blocked' ? 'Needs you' : null;
}

/** The tasks and bugs a Plan & bugs session filed that still exist: its numbered tasks and its bugs (the daemon's `linkedSessionNumber`). */
export function planAndBugsLinkedItems(items: PlanItemData[], sessionNumber: number | null): PlanItemData[] {
  return sessionNumber
    ? items.filter((item) => (item.planningRef?.session ?? (isBugItem(item) ? bugOf(item)?.reportSessionNumber : item.reportSessionNumber)) === sessionNumber)
    : [];
}

/** "Plan & bugs · 2 tasks ready · 1 bug": the ready tasks, then the ready bugs when there are any; a session that filed nothing says so. */
export function planAndBugsExpanderLabel(taskCount: number, bugCount: number, filedCount: number): string {
  if (!filedCount) return `${PLAN_AND_BUGS_LABEL} · nothing filed yet`;
  return `${PLAN_AND_BUGS_LABEL} · ${plural(taskCount, 'task')} ready${bugCount ? ` · ${plural(bugCount, 'bug')}` : ''}`;
}

/** The session card's and view's type label, always shown in text. */
export const BUG_REPORT_LABEL = 'Bug report';

/** The bugs and tasks a report session filed that still exist; none for a session with no number. */
export function bugReportLinkedItems(items: PlanItemData[], sessionNumber: number | null): PlanItemData[] {
  return sessionNumber ? items.filter((item) => (isBugItem(item) ? bugOf(item)?.reportSessionNumber : item.reportSessionNumber) === sessionNumber) : [];
}

/** A report session's status badge: "CLI not started" before it has a CLI, "Reporting" while the agent works, "Needs you" while it waits, none between turns. */
export function bugReportStatusLabel(session: { live: 'running' | 'blocked' | 'idle'; cliNotStarted: boolean }): string | null {
  if (session.cliNotStarted) return 'CLI not started';
  return session.live === 'running' ? 'Reporting' : session.live === 'blocked' ? 'Needs you' : null;
}

const ARCHIVED_NOUN: Record<SessionKind, string> = { planning: 'planning', 'bug-report': 'bug report', 'plan-and-bugs': 'plan & bugs' };

/** An archived session card's footer: "Completed planning" or "Archived planning", with the session's own noun for the other kinds. */
export function archivedSessionLabel(session: { completedAt: string | null; kind: SessionKind }): string {
  return `${session.completedAt ? 'Completed' : 'Archived'} ${ARCHIVED_NOUN[session.kind]}`;
}

/** The type label on a session's card, in text: "Plan & bugs", "Bug report" or "Planning". */
export const sessionTypeLabel = (kind: SessionKind): string => (kind === 'plan-and-bugs' ? PLAN_AND_BUGS_LABEL : kind === 'bug-report' ? BUG_REPORT_LABEL : 'Planning');

/**
 * The line under a report session's card: its bugs are not nested under it, so it says where they
 * are. Its tasks sit in the Unstarted column like any task, so they are only counted.
 */
export function bugReportCardLine(session: { cliNotStarted: boolean; readyCount: number; readyTaskCount?: number; filedCount: number }): string {
  if (session.cliNotStarted) return 'Waiting for a coding agent';
  if (!session.filedCount) return 'No bugs filed yet';
  const tasks = session.readyTaskCount ?? 0;
  if (!tasks) return `${plural(session.readyCount, 'bug')} ready · shown under their introducing tasks`;
  return session.readyCount
    ? `${plural(session.readyCount, 'bug')} ready, ${plural(tasks, 'task')} filed · bugs shown under their introducing tasks`
    : `${plural(tasks, 'task')} filed`;
}

// ---- Report bug dialog and the not-started session ----

export interface ReportDialogState {
  /** "Send" starts the CLI at once; "Create session" creates the session with no CLI. */
  sendLabel: 'Send' | 'Create session';
  notice: string | null;
}

/** With no agent available the person can still describe the work and create the session; it starts once an agent is picked on its own screen. */
export function reportDialogState(hasAgent: boolean): ReportDialogState {
  return hasAgent
    ? { sendLabel: 'Send', notice: null }
    : {
      sendLabel: 'Create session',
      notice: 'No coding agent is available right now. You can still describe the work and create the session; pick an agent on the session screen to start it once one is available.',
    };
}

/** Start session needs an agent picked (the picker only ever selects an available one) and a description that is not blank. */
export function canStartDeferredSession(input: { description: string; executorId: string }): boolean {
  return !!input.description.trim() && input.executorId !== '';
}

// ---- Start task dialog ----

/** The Software type's "Fix a bug" slot's built-in workflow — see server/src/buildings/types/software.ts. */
export const BUG_FIX_WORKFLOW_ID = 'bug-fix';
const BUG_SLOT_ID = 'bug';

/** The workflow the "Fix a bug" slot resolves to, from the Building Type's configuration; the built-in Bug Fix until that has loaded. */
export function bugSlotWorkflowId(slots: { slot: { id: string }; effectiveWorkflowId: string }[] | undefined): string {
  return slots?.find((config) => config.slot.id === BUG_SLOT_ID)?.effectiveWorkflowId ?? BUG_FIX_WORKFLOW_ID;
}

export interface StartWorkflowChoice {
  workflowId: string;
  /** Says so when a bug could not preselect its bug workflow. */
  fallbackNote: string | null;
}

/**
 * The workflow the Start task dialog preselects. A task gets the Project's default, as before. A
 * bug gets its bug workflow when that is enabled; otherwise the Project's default, with a line
 * saying so. The person may pick any other workflow.
 */
export function startWorkflowChoice(input: { bug: boolean; projectDefaultId: string; enabledIds: string[]; bugWorkflowId: string }): StartWorkflowChoice {
  if (!input.bug || input.enabledIds.includes(input.bugWorkflowId)) {
    return { workflowId: input.bug ? input.bugWorkflowId : input.projectDefaultId, fallbackNote: null };
  }
  return {
    workflowId: input.projectDefaultId,
    fallbackNote: "The Bug Fix workflow is disabled or missing, so this project's default workflow is selected instead.",
  };
}

/** The Start task dialog's warning line for a bug marked "Needs more info". Advisory: Start stays enabled. */
export function startInfoWarning(item: Typed | undefined): string | null {
  return item && bugOf(item)?.infoStatus === 'needs-more-info'
    ? 'This bug is marked "Needs more info". The agent may have to investigate before it can fix it. You can still start it.'
    : null;
}

// ---- Regressions ----

/** A bug's regressions; a bug object that never went through `readBugAttributes` may not carry the list. */
const regressionsOf = (bug: BugAttributes | null): BugRegression[] => bug?.regressions ?? [];

/** The longest reason the daemon accepts; a longer one is refused, never cut. */
export const REGRESSION_REASON_MAX = 20_000;

/** "Regressed ×2"; null for none, so a bug that never regressed shows no badge. */
export const regressedBadgeLabel = (count: number): string | null => (count >= 1 ? `Regressed ×${count}` : null);

/** Only a completed bug (archived or not) can be reported as a regression. */
export const canReportRegression = (item: Pick<PlanItemData, 'type' | 'status'>): boolean => isBugItem(item) && item.status === 'done';

/** The bug's regressions, newest first; reports made at the same instant keep the later-recorded one first. */
export function regressionsNewestFirst(item: Typed): BugRegression[] {
  const list = regressionsOf(bugOf(item));
  return list.map((regression, index) => ({ regression, index }))
    .sort((a, b) => b.regression.reportedAt.localeCompare(a.regression.reportedAt) || b.index - a.index)
    .map(({ regression }) => regression);
}

/** "You" for the person, else "Bug report session 3". */
export const regressionReporterLabel = (reporter: BugRegressionReporter): string =>
  (reporter.kind === 'person' ? 'You' : `Bug report session ${reporter.sessionNumber}`);

/** A regression's date for the list; an unreadable timestamp shows as "Unknown date" rather than "Invalid Date". */
export function regressionDateLabel(reportedAt: string): string {
  const time = new Date(reportedAt);
  return Number.isNaN(time.getTime()) ? 'Unknown date' : time.toISOString().slice(0, 10);
}

/** The reason counter under the textarea, e.g. "12 / 20,000". */
export const regressionCounterLabel = (reason: string): string => `${reason.length.toLocaleString('en-US')} / ${REGRESSION_REASON_MAX.toLocaleString('en-US')}`;

/** Submit needs a reason that is non-blank after trimming and, trimmed, no longer than the limit. */
export function isRegressionReasonValid(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed !== '' && trimmed.length <= REGRESSION_REASON_MAX;
}
