import type { DependencyActionName, DependencyReasonData, PlanItemData, WaitingData } from '../types';
import { isBugItem } from './bugs';

/**
 * What a task's dependencies look like: the details panel's "Depends on" section, the board card's
 * waiting state and the Start dialog's confirmation. Pure, so the wording and rules live in one
 * place; the daemon owns the dependencies, the reasons and the start (server/src/projects/dependencyService.ts).
 */

const NUMBERED_TITLE = /^\s*(\d+(?:\.\d+)+|B\.\d+|P\.\d+\s+T\d+):/;

/** How a task is named in the picker and the lists: its planning number when the title has one, else the title. */
export function dependencyLabel(item: Pick<PlanItemData, 'title'>): string {
  const number = NUMBERED_TITLE.exec(item.title)?.[1];
  return number ? `#${number.replace(/\s+/g, ' ')}` : item.title;
}

export const ACTION_LABELS: Record<DependencyActionName, string> = {
  'toggle-auto-merge': 'Turn on auto-merge',
  sync: 'Sync now',
  'remove-dependency': 'Remove dependency',
  'retry-parent': 'Retry parent',
};

/** A task that has not run yet and is not archived: the only kind whose dependencies can change. */
export const canEditDependencies = (item: Pick<PlanItemData, 'status' | 'workflowRunId' | 'taskIds' | 'archived' | 'prConflict' | 'testingSetup'>): boolean =>
  item.status === 'pending' && !item.workflowRunId && item.taskIds.length === 0 && !item.archived && !item.prConflict && !item.testingSetup;

/**
 * The state a task shows in the parent picker; null when it cannot be chosen as a parent. A parent is
 * either ready or started and not merged yet: archived, merged, failed, stopped, PR-conflict and
 * testing-setup tasks are never offered.
 */
export function parentState(item: PlanItemData): ParentState | null {
  if (item.archived || item.prConflict || item.testingSetup) return null;
  if (canEditDependencies(item)) return 'Ready';
  if (item.status === 'developing') return 'In progress';
  if (item.status === 'blocked') return 'Needs you';
  const merged = item.autoMerge?.state === 'merged' || item.pullRequest?.state === 'merged';
  return item.status === 'done' && !merged ? 'Waiting to merge' : null;
}

/**
 * Whether starting the task must go through start-when-ready rather than a plain execute: the daemon
 * refuses to execute a task that has parents or is already waiting for them (server/src/api/router.ts).
 */
export const startsWhenReady = (item: Pick<PlanItemData, 'dependsOn' | 'waiting'> | undefined): boolean =>
  !!(item?.dependsOn?.length || item?.waiting);

/** Whether the task can be chosen as a parent (wider than `canEditDependencies`, which is the child rule). */
export const canBeParent = (item: PlanItemData): boolean => parentState(item) !== null;

export interface ParentView { id: string; label: string; title: string; missing: boolean }

/** Where a task stands when it is offered as a parent: ready (unstarted) or started but not merged yet. */
export type ParentState = 'Ready' | 'In progress' | 'Needs you' | 'Waiting to merge';

export interface PickerOption { id: string; label: string; title: string; state: ParentState; /** Whether the parent is a task or a bug; the picker shows it as a tag. */ kind: 'Task' | 'Bug'; /** Why choosing it would be refused by the daemon; the option stays visible but flagged. */ flag: string | null }

export type DependsOnSection =
  | { mode: 'hidden' }
  | { mode: 'unavailable'; reason: string }
  | { mode: 'editable' | 'readonly'; parents: ParentView[]; options: PickerOption[] };

export const NO_REPOSITORY_REASON = 'Dependencies need a linked repository: this project has none.';

/** Whether `candidate` is, directly or through other tasks, a dependent of `itemId` (so depending on it would make a cycle). */
function dependsOnTransitively(candidate: string, itemId: string, byId: ReadonlyMap<string, PlanItemData>, seen = new Set<string>()): boolean {
  if (candidate === itemId) return true;
  if (seen.has(candidate)) return false;
  seen.add(candidate);
  return (byId.get(candidate)?.dependsOn ?? []).some((parent) => dependsOnTransitively(parent, itemId, byId, seen));
}

/** Options for the picker: the project's other tasks that can be a parent (ready first, then started ones, each in plan order), minus the ones already chosen; options that would form a cycle are flagged. */
export function pickerOptions(item: PlanItemData, items: readonly PlanItemData[]): PickerOption[] {
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  const chosen = new Set(item.dependsOn ?? []);
  const options: PickerOption[] = [];
  for (const entry of items) {
    const state = parentState(entry);
    if (!state || entry.projectId !== item.projectId || entry.id === item.id || chosen.has(entry.id)) continue;
    options.push({
      id: entry.id, label: dependencyLabel(entry), title: entry.title, state, kind: isBugItem(entry) ? 'Bug' : 'Task',
      flag: dependsOnTransitively(entry.id, item.id, byId) ? 'Would make the tasks wait for each other' : null,
    });
  }
  return [...options.filter((option) => option.state === 'Ready'), ...options.filter((option) => option.state !== 'Ready')];
}

/** The details panel's "Depends on" section: editable for a ready, unstarted task, read-only once it started, unavailable without a repository. */
export function dependsOnSection(item: PlanItemData, items: readonly PlanItemData[], repositoryUrl: string | null | undefined): DependsOnSection {
  const ids = item.dependsOn ?? [];
  if (!repositoryUrl) return ids.length === 0 && !canEditDependencies(item) ? { mode: 'hidden' } : { mode: 'unavailable', reason: NO_REPOSITORY_REASON };
  const editable = canEditDependencies(item);
  if (!editable && ids.length === 0) return { mode: 'hidden' };
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  const parents = ids.map((id): ParentView => {
    const parent = byId.get(id);
    return { id, label: parent ? dependencyLabel(parent) : 'Deleted task', title: parent?.title ?? '', missing: !parent };
  });
  return { mode: editable ? 'editable' : 'readonly', parents, options: editable ? pickerOptions(item, items) : [] };
}

export interface WaitingView {
  kind: 'waiting' | 'blocked';
  badge: 'Waiting' | 'Blocked';
  reasons: DependencyReasonData[];
  /** Cancel waiting is offered on both: it returns the task to plain ready. */
  canCancel: boolean;
  /** A waiting or blocked task has no Start: it starts by itself, or the person cancels first. */
  canStart: false;
}

/** The card's and details' waiting state; null for a task that is not waiting. */
export function waitingView(waiting: WaitingData | undefined): WaitingView | null {
  if (!waiting) return null;
  const blocked = waiting.state === 'blocked';
  return { kind: waiting.state, badge: blocked ? 'Blocked' : 'Waiting', reasons: waiting.reasons, canCancel: true, canStart: false };
}

export interface StartConfirmParent { id: string; label: string; title: string; satisfied: boolean; status: string }

/** The Start dialog's confirmation: the parents that are not satisfied yet, with where each stands. Empty means the task starts at once. */
export function startConfirm(parents: readonly { id: string; label: string; title: string; satisfied: boolean; reason: DependencyReasonData | null }[]): StartConfirmParent[] {
  return parents.filter((parent) => !parent.satisfied).map((parent) => ({ id: parent.id, label: parent.label, title: parent.title, satisfied: false, status: parent.reason?.text ?? 'Not merged yet' }));
}

const CHIP_NAMED = 2;

/** The card's "Depends on #12, #13" chip text; null when the task has no parents. More than two are summarised as "+N". */
export function dependencyChip(labels: readonly string[] | undefined): string | null {
  if (!labels?.length) return null;
  const extra = labels.length - CHIP_NAMED;
  return `Depends on ${labels.slice(0, CHIP_NAMED).join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
}

export const START_WHEN_MERGED_LABEL = 'Start when parents are merged';

export interface DependencyNode<T> { row: T; children: DependencyNode<T>[] }

/**
 * Arranges one column's rows as a forest: a row nests under the first of its parents (`dependsOn`) that
 * is in the same list. Rows whose parents are elsewhere (or whose nesting would form a cycle) stay at
 * the top level, in their original order.
 */
export function dependencyForest<T extends { id: string; dependsOn?: string[] }>(rows: readonly T[]): DependencyNode<T>[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parentOf = new Map<string, string>();
  for (const row of rows) {
    const parent = (row.dependsOn ?? []).find((id) => id !== row.id && byId.has(id));
    if (parent) parentOf.set(row.id, parent);
  }
  const reachesItself = (start: string): boolean => {
    const seen = new Set<string>();
    for (let id = parentOf.get(start); id !== undefined; id = parentOf.get(id)) {
      if (id === start) return true;
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return false;
  };
  for (const row of rows) if (reachesItself(row.id)) parentOf.delete(row.id);
  const nodes = new Map(rows.map((row): [string, DependencyNode<T>] => [row.id, { row, children: [] }]));
  const roots: DependencyNode<T>[] = [];
  for (const row of rows) {
    const parent = parentOf.get(row.id);
    (parent ? nodes.get(parent)!.children : roots).push(nodes.get(row.id)!);
  }
  return roots;
}

/** Tasks that can be picked as a parent right now (ready or started, not merged) and do not form a cycle. */
export function linkCandidates(item: PlanItemData, items: readonly PlanItemData[]): PickerOption[] {
  return pickerOptions(item, items).filter((option) => option.flag === null);
}

/**
 * What dropping the card `parentId` onto the card `childId` means: the dropped-on task now depends on the
 * dragged one. Null when the link is not allowed (no repository, the dropped-on task not ready, the dragged one not a parent candidate, a
 * cycle, or already linked).
 */
export function planLinkDrop(parentId: string, childId: string, items: readonly PlanItemData[], repositoryUrl: string | null | undefined): { itemId: string; dependsOn: string[] } | null {
  const child = items.find((entry) => entry.id === childId);
  if (!repositoryUrl || !child || !canEditDependencies(child)) return null;
  if (!linkCandidates(child, items).some((option) => option.id === parentId)) return null;
  return { itemId: childId, dependsOn: [...(child.dependsOn ?? []), parentId] };
}
