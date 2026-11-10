import type { DependencyAction, DependencyReason, DependentStartOptions, PlanItemRecord, WorkflowRecord } from '../domain/types.ts';
import { comparePlanningGroupOrder } from './planItemService.ts';

/** The most parents one task can wait for, and the longest chain of dependent tasks the daemon accepts. */
export const MAX_PARENTS = 20;
export const MAX_DEPENDENCY_DEPTH = 10;

/** How long a chain may wait on a manual merge before the person is told. */
export const LONG_WAIT_MS = 30 * 60_000;

/** The dependency list is malformed (400). */
export class DependencyInvalidError extends Error {
  constructor(message: string) { super(message); this.name = 'DependencyInvalidError'; }
}

/** The change would break a rule (409): a cycle, a self-dependency, a started task, no repository, or a chain that is too deep. */
export class DependencyConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'DependencyConflictError'; }
}

/** Parses a `dependsOn` body value into distinct, trimmed task ids; null when it is not an array of non-blank strings within the cap. */
export function parseDependsOn(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARENTS) return null;
  if (!value.every((id) => typeof id === 'string' && id.trim())) return null;
  return [...new Set(value.map((id: string) => id.trim()))];
}

/** Parses the "UI planning waits for parent" body value: a boolean only, else null. */
export function parseUiPlanningWaits(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Parents of an item; absent on records stored before dependencies existed. */
export const parentsOf = (item: Pick<PlanItemRecord, 'dependsOn'>): string[] => item.dependsOn ?? [];

/** The number of tasks on the longest dependency path that starts at `id` (itself included), following parents. */
export function chainDepth(
  id: string,
  parentsById: ReadonlyMap<string, readonly string[]>,
  memo: Map<string, number> = new Map(),
  path: Set<string> = new Set(),
): number {
  const known = memo.get(id);
  if (known !== undefined) return known;
  if (path.has(id)) return 0;
  path.add(id);
  const depth = 1 + Math.max(0, ...(parentsById.get(id) ?? []).map((parent) => chainDepth(parent, parentsById, memo, path)));
  path.delete(id);
  memo.set(id, depth);
  return depth;
}

/** The longest chain that passes through `id`: the path above it (parents) plus the path below it (children). */
function longestChainThrough(id: string, parentsById: ReadonlyMap<string, readonly string[]>): number {
  const childrenById = new Map<string, string[]>();
  for (const [child, parents] of parentsById) for (const parent of parents) childrenById.set(parent, [...(childrenById.get(parent) ?? []), child]);
  return chainDepth(id, parentsById) + chainDepth(id, childrenById) - 1;
}

/**
 * Throws when giving `itemId` the parents `next` would break a rule: a self-dependency, a cycle, or
 * a chain deeper than the cap. `parentsById` holds the project's current dependencies.
 */
export function assertAcyclicAndShallow(itemId: string, next: readonly string[], parentsById: ReadonlyMap<string, readonly string[]>): void {
  if (next.includes(itemId)) throw new DependencyConflictError('A task cannot depend on itself.');
  const proposed = new Map(parentsById).set(itemId, next);
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (proposed.get(from) ?? []).some((parent) => reaches(parent, target, seen));
  };
  if (next.some((parent) => reaches(parent, itemId))) throw new DependencyConflictError('That would make the tasks wait for each other (a cycle).');
  if (longestChainThrough(itemId, proposed) > MAX_DEPENDENCY_DEPTH) {
    throw new DependencyConflictError(`A chain of dependent tasks can be at most ${MAX_DEPENDENCY_DEPTH} tasks long.`);
  }
}

/** Stable start order for several ready children: planning order, then group order, then task number. */
export function compareStartOrder(a: PlanItemRecord, b: PlanItemRecord): number {
  const queue = (a.planningQueueOrder ?? Number.POSITIVE_INFINITY) - (b.planningQueueOrder ?? Number.POSITIVE_INFINITY);
  if (queue !== 0 && !Number.isNaN(queue)) return queue;
  return comparePlanningGroupOrder(a, b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * The dependencies the "Chain tasks" shortcut sets for a planning group: every ready (unstarted,
 * not archived, not already waiting) task depends on the ready task before it in the group's order. Other tasks and
 * existing dependencies are left alone, and groups of fewer than two ready tasks change nothing.
 */
export function chainDependencies(groupItems: readonly PlanItemRecord[]): { itemId: string; dependsOn: string[] }[] {
  const ready = groupItems.filter((item) => item.type !== 'bug' && isChainable(item)).sort(comparePlanningGroupOrder);
  return ready.slice(1).map((item, index) => ({
    itemId: item.id,
    dependsOn: [...new Set([...parentsOf(item), ready[index]!.id])],
  }));
}

/** A ready task the Chain shortcut links: ready and not already waiting for its parents. */
export const isChainable = (item: PlanItemRecord): boolean => isReadyForDependencies(item) && !item.waiting;

/** A ready task: nothing has ever run for it and it is not archived. */
export function isReadyForDependencies(item: PlanItemRecord): boolean {
  return item.status === 'pending' && !item.workflowRunId && item.taskIds.length === 0 && !item.archived && !item.prConflict && !item.testingSetup;
}

/**
 * Whether a task or bug can be named as a parent: ready, or started and not merged yet. Archived,
 * merged, failed, stopped, PR-conflict and testing-setup items never are. The web picker applies the same rule.
 */
export function isEligibleParent(item: PlanItemRecord): boolean {
  if (item.archived || item.prConflict || item.testingSetup) return false;
  if (isReadyForDependencies(item) || item.status === 'developing' || item.status === 'blocked') return true;
  const merged = item.autoMerge?.state === 'merged' || item.pullRequest?.state === 'merged';
  return item.status === 'done' && !merged;
}

// ---- Early UI Planning ----

/** The one step a waiting task may run before its parents are merged. */
export const EARLY_STEP_ID = 'ui-planning';

/**
 * The workflow's early step: its first step when that is the read-only, manual-approval UI Planning
 * step (`ui-planning`). Null for any other workflow — a renamed or reordered step does not qualify.
 */
export function earlyStepOf(workflow: Pick<WorkflowRecord, 'steps'>): string | null {
  const first = workflow.steps[0];
  return first && first.id === EARLY_STEP_ID && first.requiresApproval && !first.canEditCode ? first.id : null;
}

/**
 * Whether a waiting task runs its UI Planning early: the setting is off, it has parents, the start
 * makes its own branch (an in-place start never runs early), the step is not left out, the project
 * has a repository, and `earlyStepId` (from the workflow the start would run) exists.
 */
export function wantsEarlyRun(input: {
  item: Pick<PlanItemRecord, 'uiPlanningWaitsForParent' | 'dependsOn' | 'testingSetup' | 'prConflict'>;
  options: DependentStartOptions;
  hasRepository: boolean;
  earlyStepId: string | null;
}): boolean {
  const { item, options, earlyStepId } = input;
  if (item.uiPlanningWaitsForParent === true || parentsOf(item).length === 0 || !input.hasRepository) return false;
  if (item.testingSetup || item.prConflict || options.createBranch === false || !earlyStepId) return false;
  return !(options.skippedStepIds ?? []).includes(earlyStepId);
}

/**
 * Why the "UI planning waits for parent" setting cannot change now; null when it can. It applies to a
 * task with parents that is ready, or waiting with no early run yet. `hasEarlyRun` is whether the
 * task's run is an early run.
 */
export function uiPlanningWaitsLockedReason(item: PlanItemRecord, hasEarlyRun: boolean): string | null {
  if (parentsOf(item).length === 0) return 'This task has no parent tasks, so the setting does not apply.';
  const merged = item.autoMerge?.state === 'merged' || item.pullRequest?.state === 'merged';
  if (item.archived || merged || item.prConflict || item.testingSetup) return 'This task is archived or finished, so the setting cannot change.';
  if (hasEarlyRun) return 'UI Planning has already started, so this can\'t change now.';
  if (!isReadyForDependencies(item)) return 'This task has already started, so the setting cannot change.';
  return null;
}

// ---- The satisfaction rule ----

export type ParentRunStatus = 'starting' | 'running' | 'held' | 'awaiting-approval' | 'needs-attention' | 'completing' | 'completed' | 'failed' | 'stopped';

/** What is known about one parent right now. Git facts are read by the service; this function only decides. */
export interface ParentFacts {
  parentId: string;
  /** `#<number>` or the task's title, for messages. */
  label: string;
  exists: boolean;
  archived: boolean;
  runStatus: ParentRunStatus | null;
  autoMerge: { enabled: boolean; state: string } | null;
  /** The parent's last commit is an ancestor of the checked-out branch. */
  lastCommitPresent: boolean;
  /** The parent's PR resulted in a merge commit that is in the checked-out branch. */
  mergeCommitPresent: boolean;
  /** Its run completed with nothing to merge (no commits beyond its base). */
  noCommits: boolean;
  /** The provider (or auto-merge) says its PR is merged. */
  prMerged: boolean;
  /** The branch the parent's work is meant to land in. */
  targetBranch: string | null;
  checkedOutBranch: string | null;
  /** The checked-out branch's sync reading: how far it is behind and why a pull did not happen. */
  sync: { status: string; deferredReason?: string } | null;
}

export type ParentVerdict = { satisfied: true } | { satisfied: false; reason: DependencyReason };

const BLOCKED_BY_STATUS: Partial<Record<ParentRunStatus, string>> = {
  failed: 'failed',
  stopped: 'was stopped',
  'needs-attention': 'needs input',
};

const unsatisfied = (facts: ParentFacts, text: string, blocked: boolean, action?: DependencyAction): ParentVerdict => ({
  satisfied: false,
  reason: { parentId: facts.parentId, text, blocked, ...(action ? { action } : {}) },
});

/**
 * Whether one parent is satisfied — its last commit, or its PR's merge commit (a squash or rebase
 * merge leaves a different commit), is in the checked-out branch — and, when it is not, the reason.
 * A parent that finished with nothing to merge is satisfied. A parent that is failed, stopped,
 * needs input, was deleted, or was archived unmerged blocks the child instead of just delaying it.
 */
export function evaluateParent(facts: ParentFacts): ParentVerdict {
  if (!facts.exists) return unsatisfied(facts, 'Blocked: a parent task was deleted', true, 'remove-dependency');
  const blockedWhy = facts.runStatus ? BLOCKED_BY_STATUS[facts.runStatus] : undefined;
  if (blockedWhy) return unsatisfied(facts, `Blocked: parent ${facts.label} ${blockedWhy}`, true, 'retry-parent');
  if (!facts.runStatus) {
    return facts.archived
      ? unsatisfied(facts, `Blocked: parent ${facts.label} was archived without being merged`, true, 'remove-dependency')
      : unsatisfied(facts, `Waiting for ${facts.label} to finish`, false);
  }
  if (facts.runStatus !== 'completed') return unsatisfied(facts, `Waiting for ${facts.label} to finish`, false);
  if (facts.lastCommitPresent || facts.mergeCommitPresent || facts.noCommits) return { satisfied: true };
  if (facts.archived && !facts.prMerged) {
    return unsatisfied(facts, `Blocked: parent ${facts.label} was archived without being merged`, true, 'remove-dependency');
  }
  if (facts.prMerged) {
    if (facts.targetBranch && facts.checkedOutBranch !== facts.targetBranch) {
      return unsatisfied(facts, `Different branch checked out than ${facts.targetBranch}`, false);
    }
    const branch = facts.checkedOutBranch ?? 'the branch';
    const blocker = facts.sync?.deferredReason ? ` (${facts.sync.deferredReason})` : '';
    return unsatisfied(facts, `Waiting for ${branch} to receive ${facts.label} (pull needed)${blocker}`, false, 'sync');
  }
  if (facts.autoMerge?.enabled) return unsatisfied(facts, `Waiting for ${facts.label} to be merged`, false);
  return unsatisfied(facts, `Parent ${facts.label} isn't set to auto-merge: merge it manually or turn auto-merge on`, false, 'toggle-auto-merge');
}

/** Reasons for every unsatisfied parent, blocked ones first (a blocked parent outranks a merely waiting one). */
export function unsatisfiedReasons(verdicts: readonly ParentVerdict[]): DependencyReason[] {
  const reasons = verdicts.flatMap((verdict) => (verdict.satisfied ? [] : [verdict.reason]));
  return [...reasons.filter((reason) => reason.blocked), ...reasons.filter((reason) => !reason.blocked)];
}

/** Whether the reasons differ in anything the person sees (so an unchanged evaluation writes nothing). */
export const sameReasons = (a: readonly DependencyReason[], b: readonly DependencyReason[]): boolean => JSON.stringify(a) === JSON.stringify(b);
