import { randomUUID } from 'node:crypto';
import { planItemsDb, workflowRunsDb } from '../db/collections.ts';
import type {
  DependencyReason, DependentStartOptions, PlanItemQueueEntry, PlanItemRecord, PlanItemWaiting, ProjectRecord, ProjectSyncState, WorkflowRunRecord,
} from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import type { WorkerEvent } from '../worker/workerManager.ts';
import { createKeyedQueue, safeReason } from './autoMerge.ts';
import {
  DependencyConflictError, DependencyInvalidError, EARLY_STEP_ID, LONG_WAIT_MS, assertAcyclicAndShallow, chainDependencies, compareStartOrder, evaluateParent,
  isChainable, isEligibleParent, isReadyForDependencies, parentsOf, parseDependsOn, parseUiPlanningWaits, sameReasons, uiPlanningWaitsLockedReason,
  unsatisfiedReasons, wantsEarlyRun,
} from './dependencies.ts';
import type { ParentFacts, ParentVerdict } from './dependencies.ts';
import type { DependencyGit } from './dependencyGit.ts';
import { PlanItemNotFoundError, readPlanItem } from './planItemService.ts';

const DEFAULT_EVALUATE_EVERY_MS = 30_000;
const DEPENDENCY_NOTIFICATION_KINDS = ['dependency.started', 'dependency.blocked', 'dependency.long_wait'] as const;
const NUMBERED_TITLE = /^\s*(\d+(?:\.\d+)+|B\.\d+|P\.\d+\s+T\d+):/;

/** How a parent is named in messages: its planning number when its title carries one, else its title. */
export function taskLabel(item: Pick<PlanItemRecord, 'title'>): string {
  const number = NUMBERED_TITLE.exec(item.title)?.[1];
  return number ? `#${number.replace(/\s+/g, ' ')}` : `"${item.title}"`;
}

export interface DependencyDeps {
  getProject(projectId: string): Promise<ProjectRecord>;
  git: DependencyGit;
  /** The project's latest reading of the checked-out branch against its remote, if any. */
  syncOf(projectId: string): ProjectSyncState | null;
  /** Starts the task as a normal parallel run, or puts it on the Project's waiting list when the Project is at its task limit. Rejects exactly as a person's Start would. */
  startPlanItem(planItemId: string, options: DependentStartOptions): Promise<StartPlanItemResult>;
  /** Turns a task's Auto-merge on (the one-click toggle and the chain shortcut). */
  enableAutoMerge(projectId: string, planItemId: string): Promise<PlanItemRecord>;
  /** Early UI Planning runs; without them a waiting task never runs anything before its parents are merged. */
  early?: EarlyRunDeps;
  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void;
  onProjectSync(listener: (projectId: string) => void): () => void;
  publish(event: WorkerEvent): void;
  now?: () => number;
  /** Calls `tick` every `ms` and returns a function that stops it; defaults to `setInterval`. */
  schedule?: (tick: () => void, ms: number) => () => void;
  evaluateEveryMs?: number;
}

/** What the service asks of the workflow engine for a waiting task's early UI Planning run (see WorkflowRunRecord.early). */
export interface EarlyRunDeps {
  /** The early step (UI Planning) the workflow this start would run begins with; null when it has none. */
  earlyStepFor(planItemId: string, options: DependentStartOptions): Promise<string | null>;
  /** Starts a waiting task's early run (only its UI Planning step), or queues it when the Project is at its task limit. */
  startEarlyRun(planItemId: string, options: DependentStartOptions): Promise<StartPlanItemResult>;
  /** The task's not-yet-started entry in the Project's waiting list, if any. */
  queuedStartOf(planItemId: string): Promise<PlanItemQueueEntry | null>;
  removeQueuedStart(entryId: string): Promise<void>;
  /** Lets a held early run continue now that its parents are merged; false when it is not held (any more). */
  releaseHeldRun(runId: string): Promise<boolean>;
  /** Stops and deletes a task's early run with its worktree and branch, so the task is ready again. */
  discardEarlyRun(runId: string): Promise<void>;
}

/** The result of Start on a dependent task: a run now, or the task waiting for its parents. */
export type StartWhenReadyResult =
  | { started: true; run: WorkflowRunRecord }
  | { started: false; item: PlanItemRecord }
  | { started: false; item: PlanItemRecord; entry: PlanItemQueueEntry };

export type StartPlanItemResult = { started: true; run: WorkflowRunRecord } | { started: false; entry: PlanItemQueueEntry };

export interface ParentStatus {
  id: string;
  label: string;
  title: string;
  satisfied: boolean;
  reason: DependencyReason | null;
}

/** Without an engine to run them, no task runs early. */
const NO_EARLY_RUNS: EarlyRunDeps = {
  earlyStepFor: async () => null,
  startEarlyRun: async () => { throw new Error('Early runs are not available.'); },
  queuedStartOf: async () => null,
  removeQueuedStart: async () => undefined,
  releaseHeldRun: async () => false,
  discardEarlyRun: async () => undefined,
};

const message = (error: unknown): string => safeReason(error instanceof Error ? error.message : String(error));

/**
 * Tasks that depend on other tasks: stores the dependencies, and starts a waiting task by itself
 * once every parent's work is in the project's checked-out branch (see `evaluateParent`). Every
 * look at a project is idempotent and serialized, so a task never starts twice; whatever it
 * decides is persisted on the task, so a restart resumes from it.
 */
export function createDependencyService(deps: DependencyDeps) {
  const queue = createKeyedQueue();
  const inFlight = new Set<Promise<void>>();
  const now = deps.now ?? Date.now;
  const engine: EarlyRunDeps = deps.early ?? NO_EARLY_RUNS;
  /** The last reason each task's early start was refused, so a repeating refusal is logged once. */
  const earlyStartFailures = new Map<string, string>();

  async function requireItem(projectId: string, itemId: string): Promise<PlanItemRecord> {
    const item = await planItemsDb.get(itemId);
    if (!item || item.projectId !== projectId) throw new PlanItemNotFoundError();
    return readPlanItem(item);
  }

  async function requireRepository(projectId: string): Promise<ProjectRecord> {
    const project = await deps.getProject(projectId);
    if (!project.repositoryUrl) throw new DependencyConflictError('Dependencies need a linked repository: this project has none.');
    return project;
  }

  function assertReady(item: PlanItemRecord): void {
    if (!isReadyForDependencies(item)) throw new DependencyConflictError('Dependencies can only be changed on a ready task that has not started.');
  }

  /** The task's run when it is an early run of a task still waiting for its parents; null otherwise. */
  async function earlyRunOf(item: PlanItemRecord): Promise<WorkflowRunRecord | null> {
    if (!item.waiting || !item.workflowRunId) return null;
    const run = await workflowRunsDb.get(item.workflowRunId);
    return run?.early ? run : null;
  }

  async function write(itemId: string, patch: Partial<PlanItemRecord>): Promise<PlanItemRecord> {
    const updated = await planItemsDb.update(itemId, { ...patch, updatedAt: new Date(now()).toISOString() });
    if (!updated) throw new PlanItemNotFoundError();
    deps.publish({ type: 'planItem', planItem: updated });
    return updated;
  }

  async function projectParents(projectId: string): Promise<Map<string, string[]>> {
    const items = await planItemsDb.find((item) => item.projectId === projectId);
    return new Map(items.map((item) => [item.id, parentsOf(item)]));
  }

  // ---- Reading a parent ----

  async function readFacts(project: ProjectRecord, parentId: string, checkedOut: string | null, sync: ProjectSyncState | null): Promise<ParentFacts> {
    const parent = await planItemsDb.get(parentId);
    const base = { parentId, label: parent ? taskLabel(parent) : 'a deleted task', checkedOutBranch: checkedOut };
    const empty = { runStatus: null, autoMerge: null, lastCommitPresent: false, mergeCommitPresent: false, noCommits: false, prMerged: false, targetBranch: null, sync: null };
    if (!parent || parent.projectId !== project.id) return { ...base, exists: false, archived: false, ...empty };
    const run = parent.workflowRunId ? (await workflowRunsDb.get(parent.workflowRunId)) ?? null : null;
    const facts: ParentFacts = {
      ...base, ...empty, exists: true, archived: parent.archived === true, runStatus: run?.status ?? null,
      autoMerge: parent.autoMerge ? { enabled: parent.autoMerge.enabled, state: parent.autoMerge.state } : null,
      targetBranch: run?.baseBranch ?? null,
      sync: sync && sync.branch === checkedOut ? { status: sync.status, ...(sync.deferredReason ? { deferredReason: sync.deferredReason } : {}) } : null,
    };
    if (!run || run.status !== 'completed') return facts;
    // A run in the project's own folder committed straight to the checked-out branch: nothing to merge.
    if (!run.branch || !run.baseBranch) return { ...facts, noCommits: true };
    return { ...facts, ...(await readMergeFacts(project, run, run.branch, run.baseBranch, checkedOut, parent)) };
  }

  async function readMergeFacts(
    project: ProjectRecord, run: WorkflowRunRecord, branch: string, base: string, checkedOut: string | null, parent: PlanItemRecord,
  ): Promise<Pick<ParentFacts, 'lastCommitPresent' | 'mergeCommitPresent' | 'noCommits' | 'prMerged'>> {
    const head = await deps.git.branchHead(project, branch);
    const lastCommitPresent = Boolean(head && checkedOut && await deps.git.isAncestor(project, head, checkedOut));
    if (lastCommitPresent) return { lastCommitPresent, mergeCommitPresent: false, noCommits: false, prMerged: true };
    const pr = await deps.git.pullRequest(project, branch);
    const prMerged = parent.autoMerge?.state === 'merged' || pr?.state === 'merged';
    const mergeCommitPresent = Boolean(pr?.mergeCommit && checkedOut && await deps.git.isAncestor(project, pr.mergeCommit, checkedOut));
    // Nothing was raised for the run and its branch adds nothing to its base: it finished with no changes.
    const noCommits = !prMerged && !run.prUrl && !pr && head !== null && (await deps.git.commitsAhead(project, branch, base)) === 0;
    return { lastCommitPresent, mergeCommitPresent, noCommits, prMerged };
  }

  async function verdictsFor(project: ProjectRecord, item: PlanItemRecord): Promise<{ facts: ParentFacts; verdict: ParentVerdict }[]> {
    const checkedOut = await deps.git.checkedOutBranch(project);
    const sync = deps.syncOf(project.id);
    return Promise.all(parentsOf(item).map(async (parentId) => {
      const facts = await readFacts(project, parentId, checkedOut, sync);
      return { facts, verdict: evaluateParent(facts) };
    }));
  }

  /** Each parent with whether it is satisfied now and, if not, why: what the details panel and the Start dialog show. */
  async function statusOf(projectId: string, itemId: string): Promise<ParentStatus[]> {
    const item = await requireItem(projectId, itemId);
    const project = await deps.getProject(projectId);
    if (!project.repositoryUrl) return [];
    const results = await verdictsFor(project, item);
    return Promise.all(results.map(async ({ facts, verdict }) => {
      const parent = await planItemsDb.get(facts.parentId);
      return { id: facts.parentId, label: facts.label, title: parent?.title ?? '', satisfied: verdict.satisfied, reason: verdict.satisfied ? null : verdict.reason };
    }));
  }

  // ---- Defining dependencies ----

  /**
   * `requireEligibleParents` (a session's tool) re-checks every parent inside the exclusive section, so a start or merge that lands first is seen.
   * `uiPlanningWaitsForParent` (a session's tool) is saved in the same write, and checked against the new parents before anything is saved.
   */
  function setDependencies(
    projectId: string, itemId: string, raw: unknown, options: { requireEligibleParents?: boolean; uiPlanningWaitsForParent?: unknown } = {},
  ): Promise<PlanItemRecord> {
    const next = parseDependsOn(raw);
    if (!next) return Promise.reject(new DependencyInvalidError('dependsOn must be an array of distinct task ids.'));
    const waits = options.uiPlanningWaitsForParent === undefined ? undefined : parseUiPlanningWaits(options.uiPlanningWaitsForParent);
    if (waits === null) return Promise.reject(new DependencyInvalidError('uiPlanningWaitsForParent must be true or false.'));
    return exclusive(projectId, () => setDependenciesNow(projectId, itemId, next, options.requireEligibleParents === true, waits));
  }

  async function setDependenciesNow(projectId: string, itemId: string, next: string[], requireEligibleParents: boolean, waits?: boolean): Promise<PlanItemRecord> {
    const item = await requireItem(projectId, itemId);
    if (next.includes(itemId)) throw new DependencyConflictError('A task cannot depend on itself.');
    for (const parentId of next) {
      const parent = await planItemsDb.get(parentId);
      if (!parent || parent.projectId !== projectId) throw new PlanItemNotFoundError();
      if (requireEligibleParents && !isEligibleParent(readPlanItem(parent))) {
        throw new DependencyConflictError(`${parent.title} cannot be a parent: it is archived, merged, failed or stopped.`);
      }
    }
    await requireRepository(projectId);
    // A waiting task's early UI Planning does not freeze its parents: from the change on it behaves like a normal waiting task.
    const earlyRun = await earlyRunOf(item);
    if (!earlyRun) assertReady(item);
    assertAcyclicAndShallow(itemId, next, await projectParents(projectId));
    if (waits !== undefined) {
      const locked = uiPlanningWaitsLockedReason({ ...item, dependsOn: next }, Boolean(earlyRun));
      if (locked) throw new DependencyConflictError(locked);
    }
    const updated = await write(itemId, { dependsOn: next, ...(waits === undefined ? {} : { uiPlanningWaitsForParent: waits }) });
    if (updated.waiting) void evaluateProject(projectId);
    return updated;
  }

  /**
   * `PUT …/ui-planning-waits`: saves the "UI planning waits for parent" setting while it can still
   * change (`uiPlanningWaitsLockedReason`). On a waiting task the change applies at once: turning it
   * off starts UI Planning (or queues it), turning it on takes a queued UI Planning out of the line.
   */
  function setUiPlanningWaits(projectId: string, itemId: string, raw: unknown): Promise<PlanItemRecord> {
    const value = parseUiPlanningWaits(raw);
    if (value === null) return Promise.reject(new DependencyInvalidError('uiPlanningWaitsForParent must be true or false.'));
    return exclusive(projectId, async () => {
      const item = await requireItem(projectId, itemId);
      const locked = uiPlanningWaitsLockedReason(item, Boolean(await earlyRunOf(item)));
      if (locked) throw new DependencyConflictError(locked);
      if (item.uiPlanningWaitsForParent === value) return item;
      const updated = readPlanItem(await write(itemId, { uiPlanningWaitsForParent: value }));
      const project = await deps.getProject(projectId);
      if (updated.waiting && project.repositoryUrl) await evaluateItem(project, updated);
      return requireItem(projectId, itemId);
    });
  }

  /** The "Chain tasks" shortcut: each ready task of a planning group waits for the one before it; optionally all of them get Auto-merge. */
  function chainGroup(projectId: string, session: number, autoMerge: boolean): Promise<PlanItemRecord[]> {
    return exclusive(projectId, () => chainGroupNow(projectId, session, autoMerge));
  }

  async function chainGroupNow(projectId: string, session: number, autoMerge: boolean): Promise<PlanItemRecord[]> {
    await requireRepository(projectId);
    const group = (await planItemsDb.find((item) => item.projectId === projectId && item.planningRef?.session === session)).map(readPlanItem);
    const links = chainDependencies(group);
    const parentsById = await projectParents(projectId);
    for (const { itemId, dependsOn } of links) {
      assertAcyclicAndShallow(itemId, dependsOn, parentsById);
      parentsById.set(itemId, dependsOn);
    }
    // Auto-merge first: if a task cannot have it, nothing has been saved yet.
    if (autoMerge) for (const item of group.filter(isChainable)) await deps.enableAutoMerge(projectId, item.id);
    for (const { itemId, dependsOn } of links) await write(itemId, { dependsOn });
    void evaluateProject(projectId);
    const updated = await planItemsDb.find((item) => group.some((member) => member.id === item.id));
    return updated.map(readPlanItem);
  }

  // ---- Starting, waiting, cancelling ----

  /**
   * Start on a dependent task: a run now when every parent is satisfied, else the task waits with these options
   * (and runs its UI Planning early unless the setting says to wait). `uiPlanningWaitsForParent`, when given, is
   * saved only once the start is accepted.
   */
  function startWhenReady(projectId: string, itemId: string, options: DependentStartOptions, uiPlanningWaitsForParent?: boolean): Promise<StartWhenReadyResult> {
    return exclusive(projectId, () => startWhenReadyNow(projectId, itemId, options, uiPlanningWaitsForParent));
  }

  async function startWhenReadyNow(projectId: string, itemId: string, options: DependentStartOptions, uiPlanningWaitsForParent?: boolean): Promise<StartWhenReadyResult> {
    const item = await requireItem(projectId, itemId);
    const project = await requireRepository(projectId);
    assertReady(item);
    if (parentsOf(item).length === 0) throw new DependencyConflictError('This task has no dependencies: start it normally.');
    const setting = uiPlanningWaitsForParent === undefined ? {} : { uiPlanningWaitsForParent };
    const results = await verdictsFor(project, item);
    if (results.every(({ verdict }) => verdict.satisfied)) {
      const result = await deps.startPlanItem(itemId, options);
      const saved = Object.keys(setting).length ? await write(itemId, setting) : item;
      if (result.started) return result;
      // Released at the task limit: it joins the waiting list instead of waiting for its parents.
      return { started: false, entry: result.entry, item: saved.waiting ? await write(itemId, { waiting: undefined }) : saved };
    }
    const reasons = unsatisfiedReasons(results.map(({ verdict }) => verdict));
    const waiting = newWaiting(options, reasons, item.waiting);
    const updated = readPlanItem(await write(itemId, { waiting, ...setting }));
    if (waiting.state === 'blocked' && item.waiting?.state !== 'blocked') await notifyBlocked(updated, reasons);
    await reconcileEarlyRun(project, updated);
    return { started: false, item: await requireItem(projectId, itemId) };
  }

  function newWaiting(options: DependentStartOptions, reasons: DependencyReason[], previous?: PlanItemWaiting): PlanItemWaiting {
    const stamp = new Date(now()).toISOString();
    return {
      options, reasons, state: reasons.some((reason) => reason.blocked) ? 'blocked' : 'waiting',
      since: previous?.since ?? stamp, longWaitNotified: previous?.longWaitNotified ?? false,
      ...manualWait(reasons, previous?.manualWaitSince, stamp), updatedAt: stamp,
    };
  }

  /** A reason the person must act on (merge it, pull) starts the long-wait clock; it stops once none is left. */
  const manualWait = (reasons: DependencyReason[], since: string | undefined, stamp: string): { manualWaitSince?: string } => {
    const manual = reasons.some((reason) => !reason.blocked && (reason.action === 'toggle-auto-merge' || reason.action === 'sync'));
    return manual ? { manualWaitSince: since ?? stamp } : {};
  };

  /** Runs `action` in the project's evaluation order, so it never overlaps an evaluation that could start the task. */
  function exclusive<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    let outcome: { value: T } | { error: unknown } | undefined;
    const job = queue.enqueue(projectId, randomUUID(), async () => {
      try { outcome = { value: await action() }; } catch (error) { outcome = { error }; }
    });
    return job.then(() => {
      if (outcome && 'error' in outcome) throw outcome.error;
      return (outcome as { value: T }).value;
    });
  }

  /** Back to plain ready: a queued UI Planning leaves the line and an early run is discarded with its worktree and branch. */
  function cancelWaiting(projectId: string, itemId: string): Promise<PlanItemRecord> {
    return exclusive(projectId, async () => {
      const item = await requireItem(projectId, itemId);
      if (!item.waiting) throw new DependencyConflictError('This task is not waiting for its parents.');
      const earlyRun = await earlyRunOf(item);
      if (earlyRun) await engine.discardEarlyRun(earlyRun.id);
      const queued = await engine.queuedStartOf(itemId);
      if (queued?.early) await engine.removeQueuedStart(queued.id);
      const updated = await write(itemId, { waiting: undefined });
      await resolveNotifications(subjectOf(updated), [...DEPENDENCY_NOTIFICATION_KINDS]);
      return updated;
    });
  }

  const subjectOf = (item: Pick<PlanItemRecord, 'projectId' | 'id'>) => ({ type: 'autoMerge' as const, projectId: item.projectId, planItemId: item.id });

  // ---- Evaluation ----

  function evaluateProject(projectId: string): Promise<void> {
    return track(queue.enqueue(projectId, 'evaluate', () => evaluateNow(projectId)));
  }

  /** Remembers a running evaluation so `idle` can wait for it. */
  function track(job: Promise<void>): Promise<void> {
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
    return job;
  }

  async function waitingItems(projectId: string): Promise<PlanItemRecord[]> {
    return (await planItemsDb.find((item) => item.projectId === projectId && item.waiting !== undefined)).map(readPlanItem).sort(compareStartOrder);
  }

  async function evaluateNow(projectId: string): Promise<void> {
    const project = await deps.getProject(projectId).catch(() => null);
    if (!project?.repositoryUrl) return;
    for (const listed of await waitingItems(projectId)) {
      // Re-read: an earlier child's start or the person's cancel may have changed this one.
      const stored = await planItemsDb.get(listed.id);
      const item = stored ? readPlanItem(stored) : null;
      if (!item?.waiting || (!isReadyForDependencies(item) && !(await earlyRunOf(item)))) continue;
      await evaluateItem(project, item);
    }
  }

  async function evaluateItem(project: ProjectRecord, item: PlanItemRecord): Promise<void> {
    const waiting = item.waiting!;
    const earlyRun = await earlyRunOf(item);
    const results = await verdictsFor(project, item);
    if (results.every(({ verdict }) => verdict.satisfied)) {
      if (!earlyRun) { await startChild(item); return; }
      // UI Planning is still running or waits for approval: the task continues once it is held.
      if (earlyRun.status === 'held' && !earlyRun.early?.pendingRevision) await releaseChild(item, earlyRun);
      return;
    }
    await updateReasons(item, waiting, results);
    if (!earlyRun) await reconcileEarlyRun(project, (await requireItem(item.projectId, item.id)));
  }

  async function updateReasons(item: PlanItemRecord, waiting: PlanItemWaiting, results: { verdict: ParentVerdict }[]): Promise<void> {
    const reasons = unsatisfiedReasons(results.map(({ verdict }) => verdict));
    const next = newWaiting(waiting.options, reasons, waiting);
    if (next.state === 'blocked' && waiting.state !== 'blocked') await notifyBlocked(item, reasons);
    if (next.state !== 'blocked' && waiting.state === 'blocked') await resolveNotifications(subjectOf(item), ['dependency.blocked']);
    const longWait = !next.longWaitNotified && next.manualWaitSince !== undefined && now() - Date.parse(next.manualWaitSince) >= LONG_WAIT_MS;
    if (longWait) { next.longWaitNotified = true; await notifyLongWait(item); }
    if (sameReasons(waiting.reasons, next.reasons) && waiting.state === next.state && waiting.longWaitNotified === next.longWaitNotified
      && waiting.manualWaitSince === next.manualWaitSince) return;
    await write(item.id, { waiting: next });
  }

  /**
   * Brings a waiting task without an early run in line with its setting: starts (or queues) its UI
   * Planning when it should run early, and takes a queued early start out of the line when it should
   * not (the setting was turned on). Idempotent: an existing queue entry is never doubled.
   */
  async function reconcileEarlyRun(project: ProjectRecord, item: PlanItemRecord): Promise<void> {
    if (!item.waiting) return;
    const options = item.waiting.options;
    const hasRepository = Boolean(project.repositoryUrl);
    // The early step is always EARLY_STEP_ID when a workflow has one, so the cheap checks run before the workflow is resolved.
    const wanted = wantsEarlyRun({ item, options, hasRepository, earlyStepId: EARLY_STEP_ID })
      && wantsEarlyRun({ item, options, hasRepository, earlyStepId: await engine.earlyStepFor(item.id, options).catch(() => null) });
    const queued = await engine.queuedStartOf(item.id);
    if (!wanted) {
      if (queued?.early) await engine.removeQueuedStart(queued.id);
      return;
    }
    if (queued || item.workflowRunId) return;
    try {
      await engine.startEarlyRun(item.id, options);
      earlyStartFailures.delete(item.id);
    } catch (error) {
      // Stays waiting without an early run; the next evaluation tries again. Logged only when the reason changes, not every tick.
      const reason = message(error);
      if (earlyStartFailures.get(item.id) === reason) return;
      earlyStartFailures.set(item.id, reason);
      console.error(`Could not start the early UI Planning of task ${item.id}: ${reason}`);
    }
  }

  /** Parents merged after UI Planning was approved: the held run goes on to its next step, through the slot line. */
  async function releaseChild(item: PlanItemRecord, run: WorkflowRunRecord): Promise<void> {
    try {
      if (!(await engine.releaseHeldRun(run.id))) return;
    } catch (error) {
      const reasons: DependencyReason[] = [{ text: `Could not continue yet: ${message(error)}`, blocked: false }];
      if (!sameReasons(item.waiting!.reasons, reasons)) await write(item.id, { waiting: { ...item.waiting!, reasons, state: 'waiting', updatedAt: new Date(now()).toISOString() } });
      return;
    }
    await notifyStarted(item);
  }

  async function startChild(item: PlanItemRecord): Promise<void> {
    try {
      const result = await deps.startPlanItem(item.id, item.waiting!.options);
      if (!result.started) await write(item.id, { waiting: undefined });
    } catch (error) {
      // Stays waiting; the next evaluation tries again.
      const reasons: DependencyReason[] = [{ text: `Could not start yet: ${message(error)}`, blocked: false }];
      // The long-wait clock belongs to the parents, not to a rejected start, so it keeps its previous value.
      const { manualWaitSince: _reset, ...fresh } = newWaiting(item.waiting!.options, reasons, item.waiting);
      const next: PlanItemWaiting = { ...fresh, ...(item.waiting!.manualWaitSince ? { manualWaitSince: item.waiting!.manualWaitSince } : {}) };
      if (!sameReasons(item.waiting!.reasons, reasons) || item.waiting!.state !== next.state) await write(item.id, { waiting: next });
      return;
    }
    await notifyStarted(item);
  }

  async function notifyStarted(item: PlanItemRecord): Promise<void> {
    await resolveNotifications(subjectOf(item), [...DEPENDENCY_NOTIFICATION_KINDS]);
    await raiseNotification({
      kind: 'dependency.started', subject: subjectOf(item), title: item.title,
      description: 'All parent tasks are merged, so this task started by itself.',
    });
  }

  const notifyBlocked = (item: PlanItemRecord, reasons: DependencyReason[]) => raiseNotification({
    kind: 'dependency.blocked', subject: subjectOf(item), title: item.title,
    description: reasons.filter((reason) => reason.blocked).map((reason) => reason.text).join('. ') || 'A parent task is blocked.',
  });

  const notifyLongWait = (item: PlanItemRecord) => raiseNotification({
    kind: 'dependency.long_wait', subject: subjectOf(item), title: item.title,
    description: 'This task has been waiting a long time for a parent task to be merged. Merge it, pull the branch, or turn on auto-merge.',
  });

  // ---- Triggers ----

  async function projectsWaitingOn(projectId: string, parentId: string): Promise<boolean> {
    return (await planItemsDb.find((item) => item.projectId === projectId && item.waiting !== undefined && parentsOf(item).includes(parentId))).length > 0;
  }

  async function onEvent(event: WorkerEvent): Promise<void> {
    if (event.type === 'workflowRun') {
      // An early run changing state (held after approval, say) is the waiting task's own news.
      if (event.run.early || await projectsWaitingOn(event.run.projectId, event.run.planItemId)) await evaluateProject(event.run.projectId);
    } else if (event.type === 'planItem') {
      if (await projectsWaitingOn(event.planItem.projectId, event.planItem.id)) await evaluateProject(event.planItem.projectId);
    } else if (event.type === 'planItemDeleted') {
      if (await projectsWaitingOn(event.projectId, event.id)) await evaluateProject(event.projectId);
      await resolveNotifications({ type: 'autoMerge', projectId: event.projectId, planItemId: event.id }, [...DEPENDENCY_NOTIFICATION_KINDS]);
    }
  }

  function evaluateAll(): Promise<void> {
    return track(evaluateEveryWaitingProject());
  }

  async function evaluateEveryWaitingProject(): Promise<void> {
    const projectIds = new Set((await planItemsDb.find((item) => item.waiting !== undefined)).map((item) => item.projectId));
    await Promise.all([...projectIds].map((id) => evaluateProject(id)));
  }

  /** Resumes every waiting task from its persisted state, then looks at them on events and every 30 seconds. */
  function start(): () => void {
    const unsubscribers = [
      deps.onWorkerEvent((event) => { void track(onEvent(event)).catch(() => undefined); }),
      deps.onProjectSync((projectId) => { void evaluateProject(projectId).catch(() => undefined); }),
    ];
    void evaluateAll().catch(() => undefined);
    const tick = () => { void evaluateAll().catch(() => undefined); };
    const stopTimer = (deps.schedule ?? defaultSchedule)(tick, deps.evaluateEveryMs ?? DEFAULT_EVALUATE_EVERY_MS);
    return () => { unsubscribers.forEach((off) => off()); stopTimer(); };
  }

  /** Waits for the evaluations started so far (tests). */
  async function idle(): Promise<void> {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  }

  return { setDependencies, setUiPlanningWaits, chainGroup, startWhenReady, cancelWaiting, statusOf, evaluateProject, evaluateAll, start, idle };
}

function defaultSchedule(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export type DependencyService = ReturnType<typeof createDependencyService>;
