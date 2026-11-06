import { planItemsDb, projectsDb } from '../db/collections.ts';
import type { BugAttributes, BugInfoStatus, BugIntroducedBy, BugRegressionReporter, BugTaskRef, PlanItemRecord, TaskRecord, WorkflowRunRecord } from '../domain/types.ts';
import {
  BugIntroducerNotStartedError, BugStartedError, BugValidationError, ReportedItemKindError, ReportedTaskStartedError, agentBugSections, bugGroupId, bugNumber, bugTitle,
  buildBugDescription, hasStarted, isBug, isOpenBug, isReadyBug, linkedSessionNumber, readBugAttributes, sameTestRef, splitNumberedTitle, taskRefOf,
  type AgentBugDraft, type BugReportDraft, type BugReportPatch, type ReportedTaskDraft, type ReportedTaskPatch,
} from '../projects/bugs.ts';
import { DependencyConflictError, DependencyInvalidError, isEligibleParent, parseDependsOn } from '../projects/dependencies.ts';
import { withProjectLock } from '../projects/git.ts';
import { filesBugs, isPlanAndBugsSession } from '../projects/sessionKinds.ts';
import { provisionalTitle } from '../projects/planItemTitler.ts';
import {
  PlanItemNotFoundError, createPlanItem, createPlanningPlanItem, deletePlanItem as deletePlanItemRecord, getPlanItem, listPlanItems, planningTaskTitle, readPlanItem, updatePlanItem,
} from '../projects/planItemService.ts';

/** A bug tool was called by something other than a running plan-and-bugs or bug report session. */
export class TaskNotBugReportSessionError extends Error {
  constructor() {
    super('Only a running bug report session can file or change bugs and tasks this way');
    this.name = 'TaskNotBugReportSessionError';
  }
}

/** The bug-filing tool was called by a session that may not file bugs: one that cannot edit code, or is no longer running. */
export class TaskNotBugFilingSessionError extends Error {
  constructor() {
    super('Only a running coding session that may edit code can file a bug for an unrelated failing test');
    this.name = 'TaskNotBugFilingSessionError';
  }
}

/** A bug group's order was saved against a set of bugs that is no longer the group's. */
export class BugGroupConflictError extends Error {
  constructor() {
    super('These bugs changed while you were reordering them. Reload and try again');
    this.name = 'BugGroupConflictError';
  }
}

/** What the bug tracker needs from the worker manager, which owns sessions, locks and events. */
export interface BugTrackerContext {
  emitPlanItem: (planItem: PlanItemRecord) => void;
  emitPlanItemDeleted: (id: string, projectId: string) => void;
  requireTask: (id: string) => Promise<TaskRecord>;
  /** Runs `fn` after every earlier task or bug change of this Project's sessions, so numbers and dedupe checks never race. */
  withPlanningLock: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  /** Counts one more item created by this session and arms its automatic completion. */
  recordSessionCreation: (session: TaskRecord) => Promise<void>;
  /** The latest-state completion check for a session; call while holding the planning lock. */
  autoCompleteSession: (projectId: string, session: number | undefined) => Promise<void>;
  /** Reopens a completed bug as round 2 and starts it at once — see the worker manager's `reopenBug`. */
  reopenBug: (bugId: string, input: { reason: unknown; reporter: BugRegressionReporter }) => Promise<{ item: PlanItemRecord; run: WorkflowRunRecord; workflowNote: string | null }>;
}

/** What a filed bug starts with, before its number and position are decided. */
type NewBug = Omit<BugAttributes, 'groupOrder' | 'regressions'> & { title: string };

/**
 * Filing, changing and ordering bugs. A bug is a PlanItem of type 'bug', so once filed it is listed,
 * started, archived and deleted like any task; this module covers only what is specific to bugs.
 */
export function createBugTracker(ctx: BugTrackerContext) {
  /** Only a running plan-and-bugs or bug report session may use the report tools, and only in its own Project. */
  async function requireReportSession(taskId: string): Promise<TaskRecord> {
    const task = await ctx.requireTask(taskId);
    if (!filesBugs(task) || task.status !== 'developing') throw new TaskNotBugReportSessionError();
    return task;
  }

  /** The named introducing task: one of this Project's, and one that has started. */
  async function requireIntroducer(projectId: string, id: string): Promise<PlanItemRecord> {
    const item = await planItemsDb.get(id);
    if (!item || item.projectId !== projectId) throw new PlanItemNotFoundError();
    if (!hasStarted(item)) throw new BugIntroducerNotStartedError(item);
    return readPlanItem(item);
  }

  async function introducedByOf(projectId: string, taskId: string | null, commit: string | null): Promise<{ introducer: PlanItemRecord | null; introducedBy: BugIntroducedBy | null }> {
    if (!taskId) return { introducer: null, introducedBy: null };
    const introducer = await requireIntroducer(projectId, taskId);
    return { introducer, introducedBy: { ...taskRefOf(introducer), commit } };
  }

  /** Hands out the next number under a numbered introducing task, else the Project's next `B.` number. Never reuses one. */
  async function nextBugNumber(projectId: string, introducer: PlanItemRecord | null): Promise<string> {
    const introducerNumber = introducer ? splitNumberedTitle(introducer.title).number : null;
    if (introducer && introducerNumber) {
      const sequence = (introducer.bugSequence ?? 0) + 1;
      await planItemsDb.update(introducer.id, { bugSequence: sequence });
      return bugNumber(introducerNumber, sequence);
    }
    const sequence = ((await projectsDb.get(projectId))?.bugSequence ?? 0) + 1;
    await projectsDb.update(projectId, { bugSequence: sequence });
    return bugNumber(null, sequence);
  }

  /** The top-level Planning slot a group already holds, so a bug joining it does not move the group. */
  async function groupQueueOrder(projectId: string, groupId: string | null): Promise<number | undefined> {
    if (!groupId) return undefined;
    const orders = (await listPlanItems(projectId))
      .filter((item) => isReadyBug(item) && bugGroupId(item) === groupId)
      .map((item) => item.planningQueueOrder)
      .filter((order): order is number => order !== undefined);
    return orders.length ? Math.min(...orders) : undefined;
  }

  /** Creates the bug and announces it. Call while holding the planning lock. */
  async function fileBug(projectId: string, introducer: PlanItemRecord | null, { title, ...attributes }: NewBug): Promise<PlanItemRecord> {
    // Refuse an over-long report before a number is spent on it.
    const description = buildBugDescription(attributes);
    const number = await nextBugNumber(projectId, introducer);
    const bug = await createPlanItem({
      projectId,
      title: bugTitle(number, title),
      description,
      bug: { ...attributes, groupOrder: null, regressions: [] },
      planningQueueOrder: await groupQueueOrder(projectId, introducer?.id ?? null),
    });
    ctx.emitPlanItem(bug);
    return bug;
  }

  /** A bug this session filed that still waits in Planning; anything else is unknown to it (404) or already started (409). */
  async function requireOwnReadyBug(session: TaskRecord, itemId: string): Promise<PlanItemRecord> {
    const stored = await planItemsDb.get(itemId);
    const item = stored ? readPlanItem(stored) : undefined;
    if (item && item.projectId === session.projectId && !isBug(item)) throw new ReportedItemKindError(item, 'bug');
    const own = item && item.projectId === session.projectId && isBug(item) && item.bug!.reportSessionNumber === session.planningSessionNumber;
    if (!item || !own || !session.planningSessionNumber) throw new PlanItemNotFoundError();
    if (item.status !== 'pending') throw new BugStartedError(item);
    return item;
  }

  /** A task this session filed that has not started; anything else is unknown to it (404), a bug (409) or already started (409). */
  async function requireOwnReadyTask(session: TaskRecord, itemId: string): Promise<PlanItemRecord> {
    const stored = await planItemsDb.get(itemId);
    const item = stored ? readPlanItem(stored) : undefined;
    if (!item || item.projectId !== session.projectId || !session.planningSessionNumber) throw new PlanItemNotFoundError();
    if (isBug(item)) throw new ReportedItemKindError(item, 'task');
    if (linkedSessionNumber(item) !== session.planningSessionNumber) throw new PlanItemNotFoundError();
    if (hasStarted(item)) throw new ReportedTaskStartedError(item);
    return item;
  }

  /** The bug this session filed, as a link target for a task. Any status: a started bug can still have a related task. */
  async function requireOwnBug(session: TaskRecord, bugId: string): Promise<BugTaskRef> {
    const stored = await planItemsDb.get(bugId);
    const item = stored ? readPlanItem(stored) : undefined;
    const own = item && item.projectId === session.projectId && isBug(item) && item.bug!.reportSessionNumber === session.planningSessionNumber;
    if (!item || !own || !session.planningSessionNumber) throw new BugValidationError('relatedBugId must be the id of a bug filed in this session');
    return taskRefOf(item);
  }

  /** Every task and bug of the session's Project, for finding the one that introduced a defect. */
  async function listReportTasks(taskId: string): Promise<PlanItemRecord[]> {
    return listPlanItems((await requireReportSession(taskId)).projectId);
  }

  async function createReportedBug(taskId: string, draft: BugReportDraft): Promise<PlanItemRecord> {
    const session = await requireReportSession(taskId);
    return ctx.withPlanningLock(session.projectId, async () => {
      const { introducedByTaskId, commit, ...report } = draft;
      const { introducer, introducedBy } = await introducedByOf(session.projectId, introducedByTaskId, commit);
      const bug = await fileBug(session.projectId, introducer, {
        ...report,
        introducedBy,
        foundWhileWorkingOn: null,
        reportSessionNumber: session.planningSessionNumber ?? null,
        testRef: null,
      });
      await ctx.recordSessionCreation(session);
      return bug;
    });
  }

  /** The bug's attributes after `patch`. A new introducing task regroups the bug; its number never changes. */
  async function patchedAttributes(item: PlanItemRecord, patch: BugReportPatch): Promise<BugAttributes> {
    const current = item.bug!;
    const { title: _title, introducedByTaskId, commit, ...fields } = patch;
    const next: BugAttributes = { ...current, ...fields };
    if (introducedByTaskId !== undefined) {
      const regrouped = introducedByTaskId !== (current.introducedBy?.planItemId ?? null);
      // A commit belongs to the task it was found in: a different introducing task starts with the sent commit or none.
      const keptCommit = regrouped ? null : current.introducedBy?.commit ?? null;
      next.introducedBy = (await introducedByOf(item.projectId, introducedByTaskId, commit !== undefined ? commit : keptCommit)).introducedBy;
      if (regrouped) next.groupOrder = null;
    } else if (commit !== undefined && next.introducedBy) {
      next.introducedBy = { ...next.introducedBy, commit };
    }
    return next;
  }

  async function updateReportedBug(taskId: string, itemId: string, patch: BugReportPatch): Promise<PlanItemRecord> {
    const session = await requireReportSession(taskId);
    return ctx.withPlanningLock(session.projectId, async () => {
      const item = await requireOwnReadyBug(session, itemId);
      const bug = await patchedAttributes(item, patch);
      const groupId = bug.introducedBy?.planItemId ?? null;
      const number = splitNumberedTitle(item.title).number;
      const updated = await updatePlanItem(item.id, {
        ...(patch.title !== undefined ? { title: number ? bugTitle(number, patch.title) : patch.title } : {}),
        description: buildBugDescription(bug),
        bug,
        // A regrouped bug joins its new group's top-level slot.
        ...(groupId !== bugGroupId(item) ? { planningQueueOrder: (await groupQueueOrder(item.projectId, groupId)) ?? item.planningQueueOrder } : {}),
      });
      ctx.emitPlanItem(updated);
      return updated;
    });
  }

  async function deleteReportedBug(taskId: string, itemId: string): Promise<void> {
    const session = await requireReportSession(taskId);
    await ctx.withPlanningLock(session.projectId, async () => {
      const item = await requireOwnReadyBug(session, itemId);
      await deletePlanItemRecord(item.id);
      ctx.emitPlanItemDeleted(item.id, item.projectId);
      await ctx.autoCompleteSession(item.projectId, session.planningSessionNumber);
    });
  }

  /**
   * Creates a task, unstarted; never starts it. A plan-and-bugs session's task is numbered `<session>.<NNN>`
   * and joins the session's planning group; a bug report session's task has a plain title, as on the Tasks board.
   */
  async function createReportedTask(taskId: string, draft: ReportedTaskDraft): Promise<PlanItemRecord> {
    const session = await requireReportSession(taskId);
    return ctx.withPlanningLock(session.projectId, async () => {
      const relatedBug = draft.relatedBugId ? await requireOwnBug(session, draft.relatedBugId) : undefined;
      const title = draft.title || provisionalTitle(draft.description);
      const task = isPlanAndBugsSession(session) && session.planningSessionNumber
        ? await createPlanningPlanItem({ projectId: session.projectId, session: session.planningSessionNumber, planningTaskId: session.id, title, description: draft.description, relatedBug })
        : await createPlanItem({ projectId: session.projectId, title, description: draft.description, reportSessionNumber: session.planningSessionNumber, relatedBug });
      ctx.emitPlanItem(task);
      await ctx.recordSessionCreation(session);
      return task;
    });
  }

  async function updateReportedTask(taskId: string, itemId: string, patch: ReportedTaskPatch): Promise<PlanItemRecord> {
    const session = await requireReportSession(taskId);
    return ctx.withPlanningLock(session.projectId, async () => {
      const item = await requireOwnReadyTask(session, itemId);
      const relatedBug = patch.relatedBugId ? await requireOwnBug(session, patch.relatedBugId) : undefined;
      const updated = await updatePlanItem(item.id, {
        ...(patch.title !== undefined ? { title: item.planningRef ? planningTaskTitle(item.planningRef, patch.title) : patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.relatedBugId !== undefined ? { relatedBug } : {}),
      });
      ctx.emitPlanItem(updated);
      return updated;
    });
  }

  async function deleteReportedTask(taskId: string, itemId: string): Promise<void> {
    const session = await requireReportSession(taskId);
    await ctx.withPlanningLock(session.projectId, async () => {
      const item = await requireOwnReadyTask(session, itemId);
      await deletePlanItemRecord(item.id);
      ctx.emitPlanItemDeleted(item.id, item.projectId);
      await ctx.autoCompleteSession(item.projectId, session.planningSessionNumber);
    });
  }

  /**
   * Checks a plan-and-bugs session's `set_dependencies` call and returns what to store: the item must be
   * one the session filed that has not started, and every parent a task or bug of the Project that is
   * ready or started but not merged. Linking (repository, cycles, depth) is the dependency service's.
   */
  async function checkedDependencies(taskId: string, itemId: string, raw: unknown): Promise<{ projectId: string; dependsOn: string[] }> {
    const session = await ctx.requireTask(taskId);
    if (!isPlanAndBugsSession(session) || session.status !== 'developing') throw new TaskNotBugReportSessionError();
    const dependsOn = parseDependsOn(raw);
    if (!dependsOn) throw new DependencyInvalidError('dependsOn must be an array of at most 20 distinct item ids.');
    const stored = await planItemsDb.get(itemId);
    const item = stored ? readPlanItem(stored) : undefined;
    if (!item || item.projectId !== session.projectId || !session.planningSessionNumber || linkedSessionNumber(item) !== session.planningSessionNumber) throw new PlanItemNotFoundError();
    if (hasStarted(item)) throw isBug(item) ? new BugStartedError(item) : new ReportedTaskStartedError(item);
    for (const parentId of dependsOn) {
      const parent = await planItemsDb.get(parentId);
      if (!parent || parent.projectId !== session.projectId) throw new PlanItemNotFoundError();
      if (parentId !== itemId && !isEligibleParent(readPlanItem(parent))) throw new DependencyConflictError(`${parent.title} cannot be a parent: it is archived, merged, failed or stopped.`);
    }
    return { projectId: session.projectId, dependsOn };
  }

  /**
   * Files a bug for a failing test a coding session judges unrelated to its task — or returns the
   * open bug that already stands for that test case, so repeated runs do not flood the board.
   * `task` must already be authorised (workerManager.ts's `requireBugFilingSession`).
   */
  async function fileAgentBug(task: TaskRecord, draft: AgentBugDraft): Promise<{ bug: PlanItemRecord; existing: boolean }> {
    return ctx.withPlanningLock(task.projectId, async () => {
      const open = (await listPlanItems(task.projectId)).find((item) => isOpenBug(item) && sameTestRef(item.bug!.testRef, draft.testRef));
      if (open) return { bug: open, existing: true };
      const workedOn = task.planItemId ? await planItemsDb.get(task.planItemId) : undefined;
      const bug = await fileBug(task.projectId, null, {
        title: draft.title,
        severity: null,
        infoStatus: 'needs-more-info',
        introducedBy: null,
        suspectedLocation: null,
        foundWhileWorkingOn: workedOn ? taskRefOf(workedOn) : null,
        reportSessionNumber: null,
        testRef: draft.testRef,
        ...agentBugSections(draft),
      });
      return { bug, existing: false };
    });
  }

  /**
   * A report session's regression report: reopens a completed bug of its own Project as round 2 and
   * starts it at once. Another Project's bug is unknown (404); a task or a bug that is not completed is a conflict (409).
   */
  async function reopenCompletedBug(taskId: string, bugId: string, reason: unknown): Promise<{ item: PlanItemRecord; run: WorkflowRunRecord; workflowNote: string | null }> {
    const session = await requireReportSession(taskId);
    const item = await planItemsDb.get(bugId);
    if (!item || item.projectId !== session.projectId) throw new PlanItemNotFoundError();
    return ctx.reopenBug(bugId, { reason, reporter: { kind: 'report-session', sessionNumber: session.planningSessionNumber ?? 0 } });
  }

  /** The person's own flip of the advisory flag, allowed only while the bug has not started. */
  async function setBugInfoStatus(itemId: string, infoStatus: BugInfoStatus): Promise<PlanItemRecord> {
    const { projectId } = await getPlanItem(itemId);
    // Read and written under the planning lock, so a report session's concurrent update is never overwritten.
    return ctx.withPlanningLock(projectId, async () => {
      const item = await getPlanItem(itemId);
      if (!isBug(item)) throw new BugValidationError('only a bug has an info status');
      if (item.status !== 'pending') throw new BugStartedError(item);
      const updated = await updatePlanItem(itemId, { bug: { ...item.bug!, infoStatus } });
      ctx.emitPlanItem(updated);
      return updated;
    });
  }

  /**
   * Saves the order of the ready bugs grouped under one introducing task. `ids` must be exactly that
   * group's current ready bugs: a bug elsewhere (another group, standalone, started), an ordinary
   * task or a stale set is a conflict, and nothing changes. The group is named by its introducing
   * task's id, which stays valid after that task is deleted for as long as a bug still names it.
   */
  async function reorderBugGroup(projectId: string, introducerId: string, ids: string[]): Promise<void> {
    // The planning lock too: a bug filed or changed by a session mid-reorder would slip past the stale-set check.
    await withProjectLock(projectId, () => ctx.withPlanningLock(projectId, async () => {
      const items = await listPlanItems(projectId);
      const known = items.some((item) => item.id === introducerId || bugGroupId(item) === introducerId);
      if (!known) throw new PlanItemNotFoundError();
      const ready = new Set(items.filter((item) => isReadyBug(item) && bugGroupId(item) === introducerId).map((item) => item.id));
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const id of ids) {
        if (!byId.has(id)) throw new PlanItemNotFoundError();
        if (!ready.has(id)) throw new BugGroupConflictError();
      }
      if (ids.length !== ready.size) throw new BugGroupConflictError();
      const now = new Date().toISOString();
      const updated = await planItemsDb.updateMany(ids.map((id, groupOrder) => ({
        id, patch: { bug: { ...readBugAttributes(byId.get(id)!.bug), groupOrder }, updatedAt: now },
      })));
      for (const planItem of updated) ctx.emitPlanItem(planItem);
    }));
  }

  return { checkedDependencies, listReportTasks, createReportedBug, updateReportedBug, deleteReportedBug, createReportedTask, updateReportedTask, deleteReportedTask, fileAgentBug, reopenCompletedBug, setBugInfoStatus, reorderBugGroup };
}
