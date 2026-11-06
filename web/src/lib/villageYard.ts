import { buildPlanningQueue, buildPlanningRows, itemCompletedAt, latestItemTask, pendingTaskRows, PLANNING_LIVE_DOT, PLANNING_LIVE_TITLE, stoppedWithoutRun } from './projectTasks';
import type { PlanningRow } from './projectTasks';
import { buildTaskGroups, findWorkflowRun } from './workflowTaskGroups';
import { cardDetail, splitTaskNumber } from './taskBoard';
import type { CardDetail } from './taskBoard';
import { chainKey } from './taskChain';
import { COMMANDS_CAP, CRATE_CAP, MERGE_CAP, PLANNING_CAP, WORK_CAP } from './villageLayout';
import type { SlotArea } from './villageLayout';
import type { CommandRun, TestRun, WorkflowRunRecord } from './serverApi';
import type { AutoMergeData, PlanItemData, TaskData } from '../types';

/**
 * What the 3D village shows in each Project's yard, derived from the data the app already receives
 * (plan items, tasks, workflow runs, command and test runs). Pure: the scene only draws what these
 * return. See docs/blueprint.md's "3D village" section for the rules in plain words.
 *
 * Every task is one entity, keyed `task:<plan item id>`, whether it is a crate on the pending stack,
 * a box in the work zone or a robot in the PR queue, so it can never show twice and moving between
 * zones is one walk.
 */

// ---- Work zone: task boxes; commands zone: machines ----

export type TaskWorkState = 'needs-you' | 'running' | 'stopped';
/** The work zone's kinds, in priority order: the "+N more" breakdown lists them in this order. */
export const WORK_PRIORITY: readonly TaskWorkState[] = ['needs-you', 'running', 'stopped'];

export interface TaskTooltip {
  /** "#13.002 Sidebar polish", cut with an ellipsis. */
  title: string;
  /** "Waiting for you" (amber), or "Stopped"/"Failed" (red). */
  status: { text: string; tone: 'amber' | 'red' } | null;
  /** "Development · writing code", or the step name alone when no summary is known. */
  step: string | null;
  /** "step 4 of 7"; null when the step's position is unknown. */
  position: string | null;
}

export interface TaskWorkItem {
  key: string;
  itemId: string;
  state: TaskWorkState;
  /** When its latest attempt started: a retry counts as a fresh start. */
  startedAt: string;
  tooltip: TaskTooltip;
}

export interface MachineWorkItem {
  key: string;
  runKind: 'command' | 'test';
  runId: string;
  name: string;
  /** A failed run whose log nobody has opened yet: a red machine. */
  failed: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MergeWaitItem {
  key: string;
  itemId: string;
  title: string;
  prNumber: number | null;
  hint: MergeHint | null;
  autoMerge: boolean;
  /** When the task started waiting (finished its run): the queue's order. */
  waitingSince: string;
}

export interface PlanningSeat {
  key: string;
  /** The session's latest Task, which opening it shows. */
  taskId: string;
  sessionNumber: number | null;
  live: PlanningRow['live'];
  startedAt: string;
}

/** How a task's robot leaves once it is in no area: carried into the warehouse, or a quiet fade where it stands. */
export type YardExit = 'carry-in' | 'quiet';

export interface YardModel {
  /** False until the Project's plan has loaded: the yard then shows only its warehouse. */
  loaded: boolean;
  /** Pending tasks' keys (`pendingTaskRows`), in the Planning column's order: one crate each on the stack. */
  pending: string[];
  /** Tasks, most attention-worthy first (see `WORK_PRIORITY`), ties earliest-started. */
  work: TaskWorkItem[];
  /** Command and test machines, earliest-started first. */
  commands: MachineWorkItem[];
  /** Earliest-waiting first. */
  merge: MergeWaitItem[];
  /** Earliest-started first. */
  planning: PlanningSeat[];
  /** For a finished task in no area: how its robot leaves. Anything else in no area leaves quietly. */
  exits: Record<string, YardExit>;
}

export const taskKey = (itemId: string): string => `task:${itemId}`;

export interface YardSources {
  projectId: string;
  /** Undefined until the plan has loaded. */
  items: PlanItemData[] | undefined;
  tasksById: Record<string, TaskData>;
  /** The Project's Task ids, most recent first; undefined until loaded. */
  taskIds: string[] | undefined;
  workflowRuns: WorkflowRunRecord[];
  commandRuns: readonly YardCommandRun[];
  testRuns: readonly YardTestRun[];
}

/** The parts of a command run the yard reads; never its streamed output. */
export type YardCommandRun = Pick<CommandRun, 'id' | 'projectId' | 'status' | 'origin' | 'failureUnopened' | 'location' | 'commandName' | 'startedAt' | 'completedAt'>;
/** The parts of a test run the yard reads. */
export type YardTestRun = Pick<TestRun, 'id' | 'projectId' | 'status' | 'failureUnopened' | 'taskId' | 'startedAt' | 'completedAt'> & {
  suite: Pick<TestRun['suite'], 'label'>;
  action: Pick<TestRun['action'], 'label'>;
};

const sameCommandRun = (a: YardCommandRun, b: YardCommandRun) =>
  a.id === b.id && a.projectId === b.projectId && a.status === b.status && a.origin === b.origin && a.failureUnopened === b.failureUnopened
  && a.location?.kind === b.location?.kind && (a.location?.kind === 'task' ? a.location.planItemId : null) === (b.location?.kind === 'task' ? b.location.planItemId : null)
  && a.commandName === b.commandName && a.startedAt === b.startedAt && a.completedAt === b.completedAt;

const sameTestRun = (a: YardTestRun, b: YardTestRun) =>
  a.id === b.id && a.projectId === b.projectId && a.status === b.status && a.failureUnopened === b.failureUnopened && a.taskId === b.taskId
  && a.startedAt === b.startedAt && a.completedAt === b.completedAt && a.suite.label === b.suite.label && a.action.label === b.action.label;

const sameList = <T>(same: (a: T, b: T) => boolean) => (a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((run, i) => same(run, b[i]!));

/** True when two run lists match on everything the yard reads, so a streamed log chunk changes nothing. */
export const sameYardCommandRuns = sameList(sameCommandRun);
export const sameYardTestRuns = sameList(sameTestRun);

/** A Project's runs (every Project's when `projectId` is null), in the store's order. */
export function projectRuns<T extends { projectId: string }>(byId: Record<string, T>, projectId: string | null): T[] {
  const runs = Object.values(byId);
  return projectId === null ? runs : runs.filter((run) => run.projectId === projectId);
}

/** Undefined for an unknown time, so sorting puts it last. */
const timeOf = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

const compareKeys = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const compareStarts = (a: { startedAt: string | null; key: string }, b: { startedAt: string | null; key: string }) =>
  timeOf(a.startedAt) - timeOf(b.startedAt) || compareKeys(a, b);

/** Needs you, then Running, then Stopped/Failed; ties go to the earliest-started, then the key. */
export function compareWork(a: TaskWorkItem, b: TaskWorkItem): number {
  return WORK_PRIORITY.indexOf(a.state) - WORK_PRIORITY.indexOf(b.state) || compareStarts(a, b);
}

// ---- Merge wait ----

export type MergeStatus =
  | { kind: 'working' }
  | { kind: 'waiting'; prNumber: number | null }
  | { kind: 'finished'; exit: YardExit };

/** The daemon's reason for an Auto-merge that stopped because the PR was closed (server/src/projects/pullRequestMerge.ts's UNMERGEABLE_REASONS.closed). */
const PR_CLOSED_REASON = 'This PR is closed';

/**
 * Whether a task's finished work is still waiting to be merged. It waits once its run has finished
 * its steps and its pull request is open: with Auto-merge on, every state but merged and "no PR"
 * (including failed and can't merge, which the Tasks board lists under Needs you instead); with it
 * off, while the last reading says open. A task with no PR of its own (a conflict run, a testing
 * setup, a hand-completed task, a run on the Project's own branch) never waits and is carried in.
 * A PR closed without merging leaves quietly.
 */
export function mergeStatus(item: PlanItemData, run: Pick<WorkflowRunRecord, 'status' | 'branch' | 'baseBranch'> | null | undefined): MergeStatus {
  if (item.status !== 'done' && run?.status !== 'completed') return { kind: 'working' };
  if (item.prConflict || item.testingSetup || !item.workflowRunId) return { kind: 'finished', exit: 'carry-in' };
  if (run && !(run.branch && run.baseBranch)) return { kind: 'finished', exit: 'carry-in' };
  const autoMerge = item.autoMerge;
  if (autoMerge?.enabled) {
    if (autoMerge.state === 'merged' || autoMerge.state === 'no-pr') return { kind: 'finished', exit: 'carry-in' };
    if (autoMerge.state === 'cannot-merge' && autoMerge.reasons.includes(PR_CLOSED_REASON)) return { kind: 'finished', exit: 'quiet' };
    return { kind: 'waiting', prNumber: autoMerge.prNumber ?? item.pullRequest?.prNumber ?? null };
  }
  const reading = item.pullRequest?.state;
  if (reading === 'open') return { kind: 'waiting', prNumber: item.pullRequest!.prNumber };
  return { kind: 'finished', exit: reading === 'closed' ? 'quiet' : 'carry-in' };
}

export type MergeHint = 'Conflicts' | 'Checks failing' | 'Review required' | 'Behind base' | 'Blocked';

/**
 * Matched against the daemon's own blocker wording (server/src/projects/pullRequestMerge.ts's
 * MERGE_BLOCKERS), in this precedence. The web has no shared copy of those strings, so a wording
 * change on the server drops the hint to "Blocked" rather than showing a wrong one.
 */
const BLOCKER_HINTS: readonly [string, MergeHint][] = [
  ['Checks are failing', 'Checks failing'],
  ['A review is required', 'Review required'],
  ['Changes were requested', 'Review required'],
  ['The branch is out of date with its base', 'Behind base'],
];

/** Why a waiting PR isn't merged, when Auto-merge knows; null otherwise (the tooltip then just says it is waiting). */
export function mergeHint(autoMerge: AutoMergeData | undefined): MergeHint | null {
  if (!autoMerge?.enabled) return null;
  if (autoMerge.state === 'resolving') return 'Conflicts';
  if (autoMerge.state !== 'blocked') return null;
  for (const [prefix, hint] of BLOCKER_HINTS) {
    if (autoMerge.reasons.some((reason) => reason.startsWith(prefix))) return hint;
  }
  return 'Blocked';
}

// ---- Tooltip text ----

export const TITLE_LIMIT = 40;

/** Cuts to `limit` characters (by code point, so an emoji is never split), ending in an ellipsis when cut. */
export function truncate(text: string, limit: number = TITLE_LIMIT): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
}

/** "#13.002 Sidebar polish": the task's number then its name; just the name for a hand-typed task. */
export function taskTitleLine(title: string): string {
  const { number, name } = splitTaskNumber(title);
  return truncate(number ? `#${number} ${name}` : name);
}

export const WAITING_FOR_YOU = 'Waiting for you';

/** A box's tooltip. `run` is the task's own WorkflowRun; a task without one (freeform) shows its title and status only. */
export function taskTooltip(title: string, state: TaskWorkState, run: WorkflowRunRecord | null, stopWord: 'Stopped' | 'Failed' = 'Failed'): TaskTooltip {
  const steps = run?.workflowSnapshot.steps ?? [];
  const index = run?.currentStepId ? steps.findIndex((step) => step.id === run.currentStepId) : -1;
  const step = index >= 0 ? steps[index]! : null;
  const summary = run?.currentStepProgress?.currentLabel?.trim() || null;
  return {
    title: taskTitleLine(title),
    status: state === 'needs-you' ? { text: WAITING_FOR_YOU, tone: 'amber' } : state === 'stopped' ? { text: stopWord, tone: 'red' } : null,
    step: step ? (summary ? `${step.name} · ${summary}` : step.name) : null,
    position: step ? `step ${index + 1} of ${steps.length}` : null,
  };
}

export interface MergeTooltip { title: string; pr: string; autoMerge: string }

export function mergeTooltip(item: Pick<MergeWaitItem, 'title' | 'prNumber' | 'hint' | 'autoMerge'>): MergeTooltip {
  const reason = item.hint ?? 'Waiting to be merged';
  return {
    title: item.title,
    pr: item.prNumber === null ? reason : `PR #${String(item.prNumber)} · ${reason}`,
    autoMerge: item.autoMerge ? 'Auto-merge on' : 'Auto-merge off',
  };
}

/**
 * A machine's elapsed time, without seconds so its tag changes at most once a minute: "<1m" under a
 * minute, "5m", "2h 1m"; hours only past a day ("26h 5m"). A start in the future (clock skew), or
 * a missing or unreadable one, reads "<1m".
 */
export function machineElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const elapsedMs = (from: string | null, to: number): number => to - timeOf(from);

/** How long until the elapsed label above changes, so the tag re-renders once a minute and no more. */
export function msUntilNextMinute(startedAt: string | null, now: number): number {
  const ms = elapsedMs(startedAt, now);
  if (!Number.isFinite(ms) || ms < 0) return 60_000;
  return 60_000 - (ms % 60_000);
}

export interface MachineTooltip { title: string; kindLabel: 'Command' | 'Test run'; status: string; failed: boolean }

export function machineTooltip(item: MachineWorkItem, now: number): MachineTooltip {
  const status = item.failed
    ? (item.completedAt ? `Failed after ${machineElapsed(timeOf(item.completedAt) - timeOf(item.startedAt))}` : 'Failed')
    : `Running · ${machineElapsed(elapsedMs(item.startedAt, now))}`;
  return { title: truncate(item.name), kindLabel: item.runKind === 'command' ? 'Command' : 'Test run', status, failed: item.failed };
}

export interface PlanningTooltip { title: string; live: string; dotClass: string }

/** The Planning board card's own words and dot colour for the session's live state. */
export function planningTooltip(seat: Pick<PlanningSeat, 'sessionNumber' | 'live'>): PlanningTooltip {
  return {
    title: seat.sessionNumber === null ? 'Planning' : `Planning #${String(seat.sessionNumber)}`,
    live: PLANNING_LIVE_TITLE[seat.live],
    dotClass: PLANNING_LIVE_DOT[seat.live],
  };
}

// ---- Building the model ----

/** A red machine also clears once the task it ran for is archived or deleted; one from the main checkout clears only by opening its log. */
function linkedItemGone(planItemId: string | null | undefined, itemsById: Map<string, PlanItemData>): boolean {
  if (!planItemId) return false;
  const item = itemsById.get(planItemId);
  return !item || !!item.archived;
}

function machines(sources: YardSources, itemsById: Map<string, PlanItemData>): MachineWorkItem[] {
  const out: MachineWorkItem[] = [];
  for (const run of sources.commandRuns) {
    if (run.projectId !== sources.projectId || run.origin === 'sync') continue;
    const failed = run.status === 'failed' && run.failureUnopened === true;
    if (run.status !== 'running' && !failed) continue;
    if (failed && run.location?.kind === 'task' && linkedItemGone(run.location.planItemId, itemsById)) continue;
    out.push({ key: `command:${run.id}`, runKind: 'command', runId: run.id, name: run.commandName, failed, startedAt: run.startedAt, completedAt: run.completedAt });
  }
  for (const run of sources.testRuns) {
    if (run.projectId !== sources.projectId) continue;
    // Status 'failed' is a normal result (the tests failed); only 'error' means the run itself broke.
    const failed = run.status === 'error' && run.failureUnopened === true;
    if (run.status !== 'running' && !failed) continue;
    if (failed && run.taskId) {
      const task = sources.tasksById[run.taskId];
      if (task ? linkedItemGone(task.planItemId, itemsById) : sources.taskIds !== undefined) continue;
    }
    out.push({ key: `test:${run.id}`, runKind: 'test', runId: run.id, name: `${run.suite.label}: ${run.action.label}`, failed, startedAt: run.startedAt, completedAt: run.completedAt });
  }
  return out.sort(compareStarts);
}

function planningSeats(sources: YardSources): PlanningSeat[] {
  if (!sources.taskIds) return [];
  return buildPlanningRows({ taskIds: sources.taskIds, tasksById: sources.tasksById, showArchived: false, now: 0 })
    .filter((row) => row.completedAt === null)
    .map((row) => ({ key: `plan:${chainKey(sources.tasksById[row.id]!)}`, taskId: row.id, sessionNumber: row.sessionNumber, live: row.live, startedAt: row.metrics.startedAt }))
    .sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt) || compareKeys(a, b));
}

/**
 * One Project's yard. Tasks follow the Tasks board's own grouping (`buildTaskGroups`), split further:
 * the Planning column's task cards are pending crates (`pendingTaskRows`); Running gets a box with a
 * working robot; Needs you a box with a waiting robot; a stopped or failed run (or freeform task) a
 * red box; finished work waiting on its PR (`mergeStatus`) a robot in the PR queue. Tasks waiting
 * for their parents, archived or deleted get nothing.
 */
export function buildYardModel(sources: YardSources): YardModel {
  const items = sources.items;
  if (!items) return { loaded: false, pending: [], work: [], commands: [], merge: [], planning: [], exits: {} };
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const runs = sources.workflowRuns;
  const runOf = (item: PlanItemData) => findWorkflowRun({ workflowRunId: item.workflowRunId ?? null }, runs);
  const groups = buildTaskGroups({ items, tasksById: sources.tasksById, workflowRunsByProject: { [sources.projectId]: runs }, projectId: sources.projectId, showArchived: false, now: 0 });

  const work: TaskWorkItem[] = [];
  const merge: MergeWaitItem[] = [];
  const startedAt = (item: PlanItemData) => latestItemTask(item, sources.tasksById)?.createdAt ?? item.createdAt;
  const addBox = (item: PlanItemData, state: TaskWorkState, run: WorkflowRunRecord | null, stopWord: 'Stopped' | 'Failed' = 'Failed') =>
    work.push({ key: taskKey(item.id), itemId: item.id, state, startedAt: startedAt(item), tooltip: taskTooltip(item.title, state, run, stopWord) });
  const addMergeWait = (item: PlanItemData, run: WorkflowRunRecord | null): boolean => {
    const status = mergeStatus(item, run);
    if (status.kind !== 'waiting') return status.kind === 'finished';
    merge.push({
      key: taskKey(item.id),
      itemId: item.id,
      title: taskTitleLine(item.title),
      prNumber: status.prNumber,
      hint: mergeHint(item.autoMerge),
      autoMerge: !!item.autoMerge?.enabled,
      waitingSince: itemCompletedAt(item, latestItemTask(item, sources.tasksById), run ?? undefined) ?? item.updatedAt,
    });
    return true;
  };

  for (const row of groups.running) addBox(itemsById.get(row.id)!, 'running', runOf(itemsById.get(row.id)!));
  for (const row of groups.prNotMerged) addMergeWait(itemsById.get(row.id)!, runOf(itemsById.get(row.id)!));
  for (const row of groups.needsYou) {
    const item = itemsById.get(row.id)!;
    const run = runOf(item);
    if (addMergeWait(item, run)) continue;
    if (run?.status === 'failed') addBox(item, 'stopped', run, 'Failed');
    else if (run?.status === 'stopped') addBox(item, 'stopped', run, 'Stopped');
    else addBox(item, 'needs-you', run);
  }
  for (const row of groups.open) {
    if (stoppedWithoutRun(row)) addBox(itemsById.get(row.id)!, 'stopped', null, row.state === 'failed' ? 'Failed' : 'Stopped');
  }
  const queue = buildPlanningQueue({ items, taskIds: sources.taskIds ?? [], tasksById: sources.tasksById, now: 0, openRows: groups.open });

  const exits: Record<string, YardExit> = {};
  for (const item of items) {
    if (item.archived) continue;
    const status = mergeStatus(item, runOf(item));
    if (status.kind === 'finished') exits[taskKey(item.id)] = status.exit;
  }

  return {
    loaded: true,
    pending: pendingTaskRows(queue).map((row) => taskKey(row.id)),
    work: work.sort(compareWork),
    commands: machines(sources, itemsById),
    merge: merge.sort((a, b) => timeOf(a.waitingSince) - timeOf(b.waitingSince) || compareKeys(a, b)),
    planning: planningSeats(sources),
    exits,
  };
}

// ---- Caps, overflow and sticky slots ----

export const AREA_CAPS: Record<SlotArea, number> = { work: WORK_CAP, commands: COMMANDS_CAP, merge: MERGE_CAP, planning: PLANNING_CAP };

export interface AreaLayout {
  /** Shown entity key → slot index (0 … cap - 1). */
  slots: Record<string, number>;
  /** Keys beyond the cap. */
  hidden: string[];
}

/**
 * Which items show and where. `ranked` (most important first) decides which `cap` items show; a
 * shown item keeps the slot it had in `previous` until it leaves, and a newcomer takes the lowest
 * free slot, so nothing else moves when work comes and goes.
 */
export function assignSlots(ranked: readonly string[], cap: number, previous: Record<string, number> | undefined): AreaLayout {
  const shown = ranked.slice(0, cap);
  const slots: Record<string, number> = {};
  const taken = new Set<number>();
  for (const key of shown) {
    const slot = previous?.[key];
    if (slot !== undefined && slot < cap && !taken.has(slot)) { slots[key] = slot; taken.add(slot); }
  }
  let next = 0;
  for (const key of shown) {
    if (key in slots) continue;
    while (taken.has(next)) next += 1;
    slots[key] = next;
    taken.add(next);
  }
  return { slots, hidden: ranked.slice(cap) };
}

export type YardLayout = { loaded: boolean } & Record<SlotArea, AreaLayout>;

export const SLOT_AREAS: readonly SlotArea[] = ['work', 'commands', 'merge', 'planning'];

/** Lays out a whole yard, keeping each shown item's slot from `previous`; every zone is assigned on its own. */
export function layoutYard(model: YardModel, previous: YardLayout | null): YardLayout {
  const layout = { loaded: model.loaded } as YardLayout;
  for (const area of SLOT_AREAS) layout[area] = assignSlots(model[area].map((item) => item.key), AREA_CAPS[area], previous?.[area].slots);
  return layout;
}

/** Exact counts of the work tasks hidden behind "+N more", per kind, in priority order (kinds with none left out). */
export function hiddenWorkCounts(model: YardModel, layout: YardLayout): [TaskWorkState, number][] {
  const hidden = new Set(layout.work.hidden);
  return WORK_PRIORITY.map((kind): [TaskWorkState, number] => [kind, model.work.filter((item) => hidden.has(item.key) && item.state === kind).length])
    .filter(([, count]) => count > 0);
}

const KIND_WORDS: Record<TaskWorkState, string> = { 'needs-you': 'Needs you', running: 'Running', stopped: 'Stopped/Failed' };

export const MORE_CLICK_HINT = 'Click to open the Tasks tab';

/** The "+N more" marker's tooltip: "3 more hidden: 1 Running, 2 Stopped/Failed" or "4 more hidden: 4 commands". */
export function overflowText(area: SlotArea, model: YardModel, layout: YardLayout): string {
  const count = layout[area].hidden.length;
  if (area === 'merge') return `${count} more hidden: ${count} waiting to merge`;
  if (area === 'planning') return `${count} more hidden: ${count} planning`;
  if (area === 'commands') return `${count} more hidden: ${count} ${count === 1 ? 'command' : 'commands'}`;
  const parts = hiddenWorkCounts(model, layout).map(([kind, n]) => `${n} ${KIND_WORDS[kind]}`);
  return `${count} more hidden: ${parts.join(', ')}`;
}

// ---- The pending stack ----

/** What the pending dock draws: `resting` crates on the pallet with `transit` ones (about to be fetched) on top, never more than `CRATE_CAP`; the badge prints the exact count, and none at 0. */
export interface PendingStackView { resting: number; transit: number; badge: string | null }

/**
 * `pendingCount` tasks still pending plus `inTransit` crates a robot is on its way to fetch (their
 * tasks have already left the pending count): the transit crates stay drawn on top until lifted, so
 * the stack never shrinks before the lift.
 */
export function pendingStack(pendingCount: number, inTransit: number): PendingStackView {
  const transit = Math.min(inTransit, CRATE_CAP);
  return { resting: Math.min(pendingCount, CRATE_CAP - transit), transit, badge: pendingCount > 0 ? String(pendingCount) : null };
}

export const PENDING_CLICK_HINT = 'Click to open Tasks › Pending only';

/** The stack's tooltip lines: "Pending dock", "13 pending tasks (12 crates shown)", and the click hint. */
export function pendingTooltip(pendingCount: number): string[] {
  const count = pendingCount === 0 ? 'No pending tasks' : `${pendingCount} pending ${pendingCount === 1 ? 'task' : 'tasks'}`;
  return ['Pending dock', pendingCount > CRATE_CAP ? `${count} (${CRATE_CAP} crates shown)` : count, PENDING_CLICK_HINT];
}

/** How the stack changes with a model change: crates dropped onto it and crates faded off its top. A crate fetched by a robot is neither. */
export interface StackChange { drops: number; fades: number }

/**
 * Follows the net change in the pending count, after the crates robots fetch (`pick-up`s): a new
 * pending task drops a crate on, one archived, deleted, started behind "+N more" or failed straight
 * away fades the top crate. Swapping tasks at the same count shows nothing, and so does a first load or reload.
 */
export function stackChange(previous: YardModel | null, next: YardModel, transitions: Record<string, YardTransition>): StackChange {
  if (!previous?.loaded) return { drops: 0, fades: 0 };
  const pickUps = Object.values(transitions).filter((transition) => transition === 'pick-up').length;
  const net = next.pending.length - previous.pending.length + pickUps;
  return { drops: Math.max(0, net), fades: Math.max(0, -net) };
}

/** Seconds a robot waits in the doorway before fetching its crate, so simultaneous starts leave one after another. */
export const pickUpDelay = (order: number): number => order * 0.4;

/**
 * The crates still on their way to a bay after a model change: one a robot is still fetching stays
 * on the stack while its task keeps its bay and only stays or changes pose, plus this change's new
 * pick-ups. A task that stops, fails, finishes or leaves meanwhile ends its walk, so its crate is
 * released (the stopped task's red box stands in the bay instead).
 */
export function survivingTransit(transit: Iterable<string>, layout: YardLayout, transitions: Record<string, YardTransition>, pickUps: readonly string[]): Set<string> {
  const walking = [...transit].filter((key) => key in layout.work.slots && (transitions[key] === 'stay' || transitions[key] === 'pose'));
  return new Set([...walking, ...pickUps]);
}

/** The tasks fetching a crate in this change, in work priority order: each one's index is its `pickUpDelay` order. */
export function pickUpOrder(model: YardModel, transitions: Record<string, YardTransition>): string[] {
  return model.work.filter((item) => transitions[item.key] === 'pick-up').map((item) => item.key);
}

// ---- Lifecycle: what moves when the yard changes ----

export type YardTransition =
  /** Shown in place with no walk: first load, a reload, coming back to 3D, or a box/machine that just appeared. */
  | 'appear'
  /** Promoted from behind "+N more": it fades in at its slot. */
  | 'fade-in'
  /** A robot walks out of the warehouse to its slot (a task was retried or released from waiting, a planning session began). */
  | 'walk-out'
  /** A pending task started: a robot walks to the pending dock, lifts its crate and carries it to its work bay. */
  | 'pick-up'
  /** Running ⇄ Needs you: same robot and slot, only its pose changes. */
  | 'pose'
  /** Stopped or failed: the robot walks back inside and the red box stays. */
  | 'return-to-dome'
  /** Finished with an open PR: the robot picks the box up and carries it to the PR queue. */
  | 'carry-to-merge'
  /** Finished (or merged): the robot carries the box into the warehouse and both disappear. */
  | 'carry-in'
  /** Archived, deleted, PR closed, pushed behind "+N more", or a machine whose run ended: it fades where it stands. */
  | 'quiet-leave'
  | 'stay';

interface Placement { area: SlotArea; state?: TaskWorkState }

function placements(model: YardModel, layout: YardLayout): Map<string, Placement> {
  const states = new Map(model.work.map((item) => [item.key, item.state]));
  const out = new Map<string, Placement>();
  for (const area of SLOT_AREAS) {
    for (const key of Object.keys(layout[area].slots)) out.set(key, { area, state: states.get(key) });
  }
  return out;
}

const hiddenKeys = (layout: YardLayout) => new Set(SLOT_AREAS.flatMap((area) => layout[area].hidden));

/**
 * How each shown (or just-left) entity moves from `previous` to `next`. With no `previous`, or one
 * from before the plan loaded, everything appears in place: a reload or a return to 3D never
 * replays a walk. Only changes after that animate.
 */
export function yardTransitions(previous: { model: YardModel; layout: YardLayout } | null, next: { model: YardModel; layout: YardLayout }): Record<string, YardTransition> {
  const now = placements(next.model, next.layout);
  const out: Record<string, YardTransition> = {};
  if (!previous || !previous.layout.loaded) {
    for (const key of now.keys()) out[key] = 'appear';
    return out;
  }
  const before = placements(previous.model, previous.layout);
  const wasPending = new Set(previous.model.pending);
  const wasHidden = hiddenKeys(previous.layout);
  const isHidden = hiddenKeys(next.layout);
  const robotAt = (place: Placement | undefined) => place?.state === 'running' || place?.state === 'needs-you';

  for (const [key, place] of now) {
    const prior = before.get(key);
    if (!prior) {
      if (wasHidden.has(key)) out[key] = 'fade-in';
      else if (wasPending.has(key) && robotAt(place)) out[key] = 'pick-up';
      else if (place.area === 'planning' || robotAt(place)) out[key] = 'walk-out';
      else out[key] = 'appear';
    } else if (prior.area !== place.area) {
      out[key] = prior.area === 'work' && place.area === 'merge' ? 'carry-to-merge' : 'appear';
    } else if (place.area === 'work' && prior.state !== place.state) {
      if (prior.state === 'stopped') out[key] = 'walk-out';
      else if (place.state === 'stopped') out[key] = 'return-to-dome';
      else out[key] = 'pose';
    } else {
      out[key] = 'stay';
    }
  }
  for (const [key, prior] of before) {
    if (now.has(key)) continue;
    const finished = next.model.exits[key];
    out[key] = !isHidden.has(key) && finished === 'carry-in' && prior.area !== 'planning' ? 'carry-in' : 'quiet-leave';
  }
  return out;
}

// ---- Workspace totals (the strip above the village) ----

export interface WorkspaceTotals { pending: number; inProgress: number; needsYou: number; waitingToMerge: number; stopped: number; commands: number; planning: number }

export const EMPTY_TOTALS: WorkspaceTotals = { pending: 0, inProgress: 0, needsYou: 0, waitingToMerge: 0, stopped: 0, commands: 0, planning: 0 };

const TOTAL_OF: Record<TaskWorkState, 'inProgress' | 'needsYou' | 'stopped'> = { running: 'inProgress', 'needs-you': 'needsYou', stopped: 'stopped' };

/** Exact counts across every Project's yard model: never capped. */
export function workspaceTotals(models: YardModel[]): WorkspaceTotals {
  const totals = { ...EMPTY_TOTALS };
  for (const model of models) {
    totals.pending += model.pending.length;
    for (const item of model.work) totals[TOTAL_OF[item.state]] += 1;
    totals.commands += model.commands.length;
    totals.waitingToMerge += model.merge.length;
    totals.planning += model.planning.length;
  }
  return totals;
}

// ---- Clicks ----

export type YardTarget =
  | { kind: 'dome' }
  | { kind: 'pending' }
  | { kind: 'task'; itemId: string }
  | { kind: 'planning'; taskId: string }
  | { kind: 'command'; runId: string }
  | { kind: 'test'; runId: string }
  | { kind: 'more' };

/** The slice of a scene node `yardTargetOf` walks: its tagged target and its parent. */
export interface YardTargetNode {
  userData: { yardTarget?: unknown };
  parent: YardTargetNode | null;
}

/** The clicked item, from the nearest ancestor tagged with a `yardTarget`; null for bare ground and untagged parts. */
export function yardTargetOf(node: YardTargetNode | null): YardTarget | null {
  for (let current = node; current; current = current.parent) {
    if (current.userData.yardTarget) return current.userData.yardTarget as YardTarget;
  }
  return null;
}

/** A release opens something only when its press began on this yard and the pointer never became a drag. */
export function isYardClick(pressStarted: boolean, dragged: boolean): boolean {
  return pressStarted && !dragged;
}

export interface YardClickState {
  projects: { id: string }[];
  planByProject: Record<string, { items: PlanItemData[] } | undefined>;
  tasksById: Record<string, TaskData>;
}

export interface YardClickActions {
  openWorkspace: (projectId: string) => void;
  openWorkspacePendingTasks: (projectId: string) => void;
  openWorkspaceCardDetail: (projectId: string, detail: CardDetail | null) => void;
  openPlanningSession: (projectId: string, taskId: string) => void;
  openCommandRunFromVillage: (projectId: string, runId: string) => void;
  openTestRunFromFooter: (projectId: string, runId: string) => void;
}

/**
 * Opens what a click in a yard is about: the warehouse its Project Workspace; the pending stack the
 * Tasks tab filtered to pending tasks; a task's box or robot that
 * task's run (or session, or details), as its board card would; a planning robot its session; a
 * command machine Settings › Commands with that run's log; a test machine its Testing run; "+N more"
 * the Tasks tab. A Project or task gone by the time of the click opens nothing.
 */
export function openYardTarget(projectId: string, target: YardTarget, state: YardClickState, actions: YardClickActions): void {
  if (!state.projects.some((project) => project.id === projectId)) return;
  switch (target.kind) {
    case 'dome':
    case 'more':
      actions.openWorkspace(projectId);
      return;
    case 'pending':
      actions.openWorkspacePendingTasks(projectId);
      return;
    case 'task': {
      const item = state.planByProject[projectId]?.items.find((entry) => entry.id === target.itemId);
      if (!item) return;
      const last = latestItemTask(item, state.tasksById);
      actions.openWorkspaceCardDetail(projectId, cardDetail({ id: item.id, canOpenSession: !!last, latestTaskId: last?.id ?? null, workflowRunId: item.workflowRunId }));
      return;
    }
    case 'planning':
      actions.openPlanningSession(projectId, target.taskId);
      return;
    case 'command':
      actions.openCommandRunFromVillage(projectId, target.runId);
      return;
    case 'test':
      actions.openTestRunFromFooter(projectId, target.runId);
  }
}
