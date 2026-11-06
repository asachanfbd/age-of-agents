import { randomUUID } from 'node:crypto';
import { planItemsDb, workflowRunsDb } from '../db/collections.ts';
import type {
  DependencyReason, DependentStartOptions, PlanItemQueueEntry, PlanItemRecord, PlanItemWaiting, ProjectRecord, ProjectSyncState, WorkflowRunRecord,
} from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import type { WorkerEvent } from '../worker/workerManager.ts';
import { createKeyedQueue, safeReason } from './autoMerge.ts';
import {
  DependencyConflictError, DependencyInvalidError, LONG_WAIT_MS, assertAcyclicAndShallow, chainDependencies, compareStartOrder, evaluateParent,
  isChainable, isEligibleParent, isReadyForDependencies, parentsOf, parseDependsOn, sameReasons, unsatisfiedReasons,
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
  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void;
  onProjectSync(listener: (projectId: string) => void): () => void;
  publish(event: WorkerEvent): void;
  now?: () => number;
  /** Calls `tick` every `ms` and returns a function that stops it; defaults to `setInterval`. */
  schedule?: (tick: () => void, ms: number) => () => void;
  evaluateEveryMs?: number;
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

  /** `requireEligibleParents` (a session's tool) re-checks every parent inside the exclusive section, so a start or merge that lands first is seen. */
  function setDependencies(projectId: string, itemId: string, raw: unknown, options: { requireEligibleParents?: boolean } = {}): Promise<PlanItemRecord> {
    const next = parseDependsOn(raw);
    if (!next) return Promise.reject(new DependencyInvalidError('dependsOn must be an array of distinct task ids.'));
    return exclusive(projectId, () => setDependenciesNow(projectId, itemId, next, options.requireEligibleParents === true));
  }

  async function setDependenciesNow(projectId: string, itemId: string, next: string[], requireEligibleParents: boolean): Promise<PlanItemRecord> {
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
    assertReady(item);
    assertAcyclicAndShallow(itemId, next, await projectParents(projectId));
    const updated = await write(itemId, { dependsOn: next });
    if (updated.waiting) void evaluateProject(projectId);
    return updated;
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

  /** Start on a dependent task: a run now when every parent is satisfied, else the task waits (staying in Planning) with these options. */
  function startWhenReady(projectId: string, itemId: string, options: DependentStartOptions): Promise<StartWhenReadyResult> {
    return exclusive(projectId, () => startWhenReadyNow(projectId, itemId, options));
  }

  async function startWhenReadyNow(projectId: string, itemId: string, options: DependentStartOptions): Promise<StartWhenReadyResult> {
    const item = await requireItem(projectId, itemId);
    const project = await requireRepository(projectId);
    assertReady(item);
    if (parentsOf(item).length === 0) throw new DependencyConflictError('This task has no dependencies: start it normally.');
    const results = await verdictsFor(project, item);
    if (results.every(({ verdict }) => verdict.satisfied)) {
      const result = await deps.startPlanItem(itemId, options);
      if (result.started) return result;
      // Released at the task limit: it joins the waiting list instead of waiting for its parents.
      return { started: false, entry: result.entry, item: item.waiting ? await write(itemId, { waiting: undefined }) : item };
    }
    const reasons = unsatisfiedReasons(results.map(({ verdict }) => verdict));
    const waiting = newWaiting(options, reasons, item.waiting);
    const updated = await write(itemId, { waiting });
    if (waiting.state === 'blocked' && item.waiting?.state !== 'blocked') await notifyBlocked(updated, reasons);
    return { started: false, item: updated };
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

  function cancelWaiting(projectId: string, itemId: string): Promise<PlanItemRecord> {
    return exclusive(projectId, async () => {
      const item = await requireItem(projectId, itemId);
      if (!item.waiting) throw new DependencyConflictError('This task is not waiting for its parents.');
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
      const item = await planItemsDb.get(listed.id);
      if (!item?.waiting || !isReadyForDependencies(readPlanItem(item))) continue;
      await evaluateItem(project, readPlanItem(item));
    }
  }

  async function evaluateItem(project: ProjectRecord, item: PlanItemRecord): Promise<void> {
    const waiting = item.waiting!;
    const results = await verdictsFor(project, item);
    if (results.every(({ verdict }) => verdict.satisfied)) { await startChild(item); return; }
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
      if (await projectsWaitingOn(event.run.projectId, event.run.planItemId)) await evaluateProject(event.run.projectId);
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

  return { setDependencies, chainGroup, startWhenReady, cancelWaiting, statusOf, evaluateProject, evaluateAll, start, idle };
}

function defaultSchedule(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export type DependencyService = ReturnType<typeof createDependencyService>;
