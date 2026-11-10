import { randomUUID } from 'node:crypto';
import { planItemsDb } from '../db/collections.ts';
import type { BugAttributes, BugTaskRef, PlanItemRecord, PlanningRef } from '../domain/types.ts';
import { namedAtStart } from '../domain/displayName.ts';
import { withPlanItemType } from './bugs.ts';

export class PlanItemNotFoundError extends Error {
  constructor() {
    super('This task no longer exists — it may have been deleted');
    this.name = 'PlanItemNotFoundError';
  }
}

type NamedItem = Pick<PlanItemRecord, 'title'>;

export class PlanItemHasActiveTaskError extends Error {
  constructor(item: NamedItem, action: 'archiving' | 'deleting' | 'editing' = 'deleting') {
    super(`${namedAtStart('task', item.title)} is still running — stop or wait for it before ${action} it`);
    this.name = 'PlanItemHasActiveTaskError';
  }
}

export class PlanItemCompletedError extends Error {
  constructor(item: NamedItem) {
    super(`${namedAtStart('task', item.title)} is already completed — it only shows under Completed, so create a new task for further work instead of editing it`);
    this.name = 'PlanItemCompletedError';
  }
}

export class PlanItemNotCompletableError extends Error {
  constructor(item: NamedItem) {
    super(`${namedAtStart('task', item.title)} is still running — stop or wait for it before marking it complete`);
    this.name = 'PlanItemNotCompletableError';
  }
}

/**
 * The item as callers see it. Drops fields a stored item may still carry from an older schema —
 * `priority` (removed along with the Tasks tab's priority swimlanes) — which the file keeps until the
 * item is next rewritten. Gives every item its `type` ('task' when the record has none) and a bug
 * its readable attributes.
 */
export function readPlanItem(item: PlanItemRecord): PlanItemRecord {
  const { priority: _priority, ...rest } = item as PlanItemRecord & { priority?: unknown };
  return withPlanItemType(rest);
}

/** Every PlanItem for a Project, in display order (see `order`). */
export async function listPlanItems(projectId: string): Promise<PlanItemRecord[]> {
  const items = await planItemsDb.find((item) => item.projectId === projectId);
  return items.map(readPlanItem).sort((a, b) => a.order - b.order);
}

export async function getPlanItem(id: string): Promise<PlanItemRecord> {
  const item = await planItemsDb.get(id);
  if (!item) throw new PlanItemNotFoundError();
  return readPlanItem(item);
}

type GroupOrdered = Pick<PlanItemRecord, 'planningGroupOrder' | 'planningRef'>;

/** A planning group's ready-task order: saved positions first, then unpositioned tasks oldest first, so new tasks join the end. */
export function comparePlanningGroupOrder(a: GroupOrdered, b: GroupOrdered): number {
  const rank = (item: GroupOrdered) => item.planningGroupOrder ?? Number.POSITIVE_INFINITY;
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  return (a.planningRef?.task ?? 0) - (b.planningRef?.task ?? 0);
}

export async function createPlanItem(input: {
  projectId: string;
  title: string;
  description: string;
  planningRef?: PlanningRef;
  planningTaskId?: string;
  /** Only the daemon's own testing-setup start passes this — see PlanItemRecord.testingSetup. */
  testingSetup?: PlanItemRecord['testingSetup'];
  /** Only the daemon's own conflict-resolution start passes this — see PlanItemRecord.prConflict. */
  prConflict?: PlanItemRecord['prConflict'];
  /** Only the scheduler's own run start passes this — see PlanItemRecord.scheduledJobId. */
  scheduledJobId?: string;
  /** Only the bug tracker passes this (worker/bugTracker.ts); every other path creates a 'task'. */
  bug?: BugAttributes;
  /** Only a bug report session's task passes these (worker/bugTracker.ts): the bug it was filed alongside and the filing session. */
  relatedBug?: BugTaskRef;
  reportSessionNumber?: number;
  /** A bug joining a group that already has a top-level slot takes that slot. */
  planningQueueOrder?: number;
}): Promise<PlanItemRecord> {
  const existing = await listPlanItems(input.projectId);
  const order = existing.length === 0 ? 0 : Math.max(...existing.map((i) => i.order)) + 1;
  const now = new Date().toISOString();
  const item: PlanItemRecord = {
    id: randomUUID(),
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    status: 'pending',
    type: input.bug ? 'bug' : 'task',
    ...(input.bug ? { bug: input.bug } : {}),
    ...(input.relatedBug ? { relatedBug: input.relatedBug } : {}),
    ...(input.reportSessionNumber ? { reportSessionNumber: input.reportSessionNumber } : {}),
    order,
    ...(!input.planningRef ? { planningQueueOrder: input.planningQueueOrder ?? -Date.now() } : {}),
    taskIds: [],
    milestoneId: null,
    planningTaskId: input.planningTaskId ?? null,
    workflowRunId: null,
    ...(input.planningRef ? { planningRef: input.planningRef } : {}),
    ...(input.testingSetup ? { testingSetup: input.testingSetup } : {}),
    ...(input.prConflict ? { prConflict: input.prConflict } : {}),
    ...(input.scheduledJobId ? { scheduledJobId: input.scheduledJobId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return planItemsDb.insert(item);
}

export async function updatePlanItem(
  id: string,
  patch: Partial<Pick<PlanItemRecord, 'title' | 'description' | 'order' | 'planningQueueOrder' | 'status' | 'taskIds' | 'executorId' | 'workflowRunId' | 'planningTaskId' | 'archived' | 'bug' | 'relatedBug' | 'dependsOn' | 'waiting' | 'stepNotes' | 'uiPlanningWaitsForParent'>>,
): Promise<PlanItemRecord> {
  const updated = await planItemsDb.update(id, { ...patch, updatedAt: new Date().toISOString() });
  if (!updated) throw new PlanItemNotFoundError();
  return readPlanItem(updated);
}

/**
 * Puts `ids` (items of this Project) in the given sequence — the Tasks board after a card is dragged
 * within its column. They take over the order slots they already hold between them, so every item
 * not listed keeps its place relative to the rest. Returns the Project's full list in its new order.
 */
export async function reorderPlanItems(projectId: string, ids: string[]): Promise<PlanItemRecord[]> {
  const items = await listPlanItems(projectId);
  const byId = new Map(items.map((item) => [item.id, item]));
  const moved = ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new PlanItemNotFoundError();
    return item;
  });
  const slots = moved.map((item) => item.order).sort((a, b) => a - b);
  const now = new Date().toISOString();
  await Promise.all(
    moved.map((item, index) => (item.order !== slots[index] ? planItemsDb.update(item.id, { order: slots[index]!, updatedAt: now }) : undefined)),
  );
  return listPlanItems(projectId);
}

/**
 * Marks an item with no WorkflowRun done by hand (a run-backed item completes through
 * workerManager.ts's `completePlanItem`, which stops and commits its run first — and which also
 * refuses an item whose session is really still running, PlanItemNotCompletableError: only the
 * worker manager knows which sessions are live). Refuses an item already done (PlanItemCompletedError).
 */
export async function completePlanItem(id: string): Promise<PlanItemRecord> {
  const item = await getPlanItem(id);
  if (item.status === 'done') throw new PlanItemCompletedError(item);
  return updatePlanItem(id, { status: 'done' });
}

/** Archives (hides from every board column) or restores an item. Refusing one that's still running is workerManager.ts's `archivePlanItem` — it knows which sessions are live. */
export async function archivePlanItem(id: string, archived: boolean): Promise<PlanItemRecord> {
  await getPlanItem(id);
  return updatePlanItem(id, { archived });
}

/** Removes the record only — stopping its sessions and removing its worktree first is workerManager.ts's `deletePlanItem`. */
export async function deletePlanItem(id: string): Promise<void> {
  await getPlanItem(id);
  await planItemsDb.delete(id);
}

/** A sequence prefix a title may already carry: a planning number ("3.002: "), a bug number ("3.002.001: ", "B.004: ") or the earlier "P.3 T2: " format — also stripped by projects/branchName.ts before a title becomes a branch name. */
export const PLANNING_PREFIX = /^\s*(?:\d+(?:\.\d+)+|B\.\d+|P\.\d+\s+T\d+):\s*/;

/** "3.002: Title" — the planning session's number and the task's place in it (three digits, zero-padded), so a session's tasks read in execution order. Replaces any prefix the title already carries. */
export function planningTaskTitle(ref: PlanningRef, title: string): string {
  return `${ref.session}.${String(ref.task).padStart(3, '0')}: ${title.replace(PLANNING_PREFIX, '')}`;
}

/**
 * Adds the next task of planning session `session`: numbered one past the highest task number that
 * session already has in this Project. Callers must serialize calls per Project, or two concurrent
 * ones could pick the same number.
 */
export async function createPlanningPlanItem(input: { projectId: string; session: number; title: string; description: string; planningTaskId?: string; relatedBug?: BugTaskRef }): Promise<PlanItemRecord> {
  const numbers = (await listPlanItems(input.projectId))
    .filter((item) => item.planningRef?.session === input.session)
    .map((item) => item.planningRef!.task);
  const planningRef: PlanningRef = { session: input.session, task: Math.max(0, ...numbers) + 1 };
  return createPlanItem({ projectId: input.projectId, title: planningTaskTitle(planningRef, input.title), description: input.description, planningRef, planningTaskId: input.planningTaskId, relatedBug: input.relatedBug });
}

/** The item, if it belongs to this Project — the only items a planning session may edit or delete (refusing one still running is workerManager.ts's job, see `requireIdlePlanningItem`). */
async function requireProjectItem(projectId: string, id: string): Promise<PlanItemRecord> {
  const item = await planItemsDb.get(id);
  if (!item || item.projectId !== projectId) throw new PlanItemNotFoundError();
  return item;
}

/**
 * A planning session's edit of one of its Project's tasks. A numbered item keeps its "<session>.<task>"
 * prefix whatever title it's given. A completed item is refused (PlanItemCompletedError): it stays
 * done and listed under Completed, so reworking it into new work would hide that work from the open list.
 */
export async function editPlanningPlanItem(projectId: string, id: string, patch: { title?: string; description?: string; uiPlanningWaitsForParent?: boolean }): Promise<PlanItemRecord> {
  const item = await requireProjectItem(projectId, id);
  if (item.status === 'done') throw new PlanItemCompletedError(item);
  const changes: Partial<Pick<PlanItemRecord, 'title' | 'description' | 'uiPlanningWaitsForParent'>> = {};
  if (patch.title !== undefined) changes.title = item.planningRef ? planningTaskTitle(item.planningRef, patch.title) : patch.title;
  if (patch.description !== undefined) changes.description = patch.description;
  if (patch.uiPlanningWaitsForParent !== undefined) changes.uiPlanningWaitsForParent = patch.uiPlanningWaitsForParent;
  return updatePlanItem(id, changes);
}

/** A planning session's delete of one of its Project's tasks. */
export async function deletePlanningPlanItem(projectId: string, id: string): Promise<void> {
  await requireProjectItem(projectId, id);
  await planItemsDb.delete(id);
}
