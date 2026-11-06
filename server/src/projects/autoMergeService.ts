import { planItemsDb, workflowRunsDb } from '../db/collections.ts';
import type { AutoMergeRecord, AutoMergeState, PlanItemRecord, ProjectRecord, WorkflowRunRecord } from '../domain/types.ts';
import type { WorkerEvent } from '../worker/workerManager.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import {
  AUTO_MERGE_NOTIFICATION_KINDS, autoMergeConflictTitle, autoMergeMergedDescription, autoMergeIneligibleReason, conflictExecutorFor, createKeyedQueue, decideAutoMerge,
  isProviderUnreachable, newAutoMerge, notificationKindFor, pullRequestNumberOf, readAutoMerge, safeReason,
} from './autoMerge.ts';
import { PlanItemNotFoundError } from './planItemService.ts';
import { PullRequestNotFoundError } from './pullRequestMerge.ts';
import type { PullRequestMergeResult, PullRequestReading } from './pullRequestMerge.ts';

/** The task cannot have Auto-merge (no linked repository, or a run without its own branch). */
export class AutoMergeUnavailableError extends Error {
  constructor(reason: string) { super(reason); this.name = 'AutoMergeUnavailableError'; }
}

/** Retry was asked for a task whose auto-merge is not in a state that can be retried. */
export class AutoMergeNotRetryableError extends Error {
  constructor() { super('Only a failed auto-merge, or one waiting for an agent, can be retried.'); this.name = 'AutoMergeNotRetryableError'; }
}

export interface AutoMergeDeps {
  getProject(projectId: string): Promise<ProjectRecord>;
  readPullRequest(project: ProjectRecord, number: number): Promise<PullRequestReading>;
  mergePullRequest(project: ProjectRecord, reading: PullRequestReading): Promise<PullRequestMergeResult>;
  startConflictRun(
    projectId: string,
    reading: PullRequestReading,
    executorId: string,
    autoMerge: { planItemId: string; title: string },
  ): Promise<{ run: WorkflowRunRecord; existing: boolean }>;
  activeConflictRun(projectId: string, number: number): Promise<WorkflowRunRecord | null>;
  latestConflictRun(projectId: string, number: number): Promise<WorkflowRunRecord | null>;
  /** Why this coding agent cannot take a run right now (removed, usage limit reached), or null. */
  executorUnavailableReason(executorId: string): Promise<string | null>;
  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void;
  publish(event: WorkerEvent): void;
  /** How long to wait between looks at a running conflict run. */
  runPollMs?: number;
  /** The longest one look waits for a conflict run before it lets the project's other merges go ahead; the next look waits again. */
  maxRunWaitMs?: number;
  /** How often every pending auto-merge is evaluated again. */
  evaluateEveryMs?: number;
}

const DEFAULT_RUN_POLL_MS = 2_000;
const DEFAULT_EVALUATE_EVERY_MS = 60_000;
const DEFAULT_MAX_RUN_WAIT_MS = 6 * 60 * 60_000;
const MERGED_ELSEWHERE_NOTE = 'Merged outside auto-merge; what became of the remote branch is not known.';
const AGENT_START_FAILURES = new Set(['ExecutorNotFoundError', 'ExecutorNotSupportedError']);

/** `automatic` (a poll or an event) leaves a failed or unmergeable task alone; the person's own action (turning on, Retry) does not. */
interface EvaluateOptions { automatic: boolean }

/** A failed or unmergeable task waits for the person; only their own action looks at it again. */
const leftForThePerson = (state: AutoMergeState, options: EvaluateOptions): boolean => options.automatic && (state === 'failed' || state === 'cannot-merge');

const message = (error: unknown): string => safeReason(error instanceof Error ? error.message : String(error));

/**
 * Merges a task's own pull request after its workflow has finished, when its Auto-merge toggle is
 * on — the PR tab's merge flow, run by the daemon. A clean PR is merged; a conflicting one goes to
 * a conflict-resolution run with the task's own coding agent; anything else that blocks a merge is
 * reported and waited out, never overridden. One project's merges run one at a time (so each PR is
 * read against the base as the previous merge left it), and every look at a task is idempotent.
 * State is persisted on the task, so a restart resumes from it.
 */
export function createAutoMergeService(deps: AutoMergeDeps) {
  const queue = createKeyedQueue();
  const inFlight = new Set<Promise<void>>();
  const runPollMs = deps.runPollMs ?? DEFAULT_RUN_POLL_MS;
  const maxRunWaitMs = deps.maxRunWaitMs ?? DEFAULT_MAX_RUN_WAIT_MS;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function record(itemId: string): Promise<{ item: PlanItemRecord; autoMerge: AutoMergeRecord } | null> {
    const item = await planItemsDb.get(itemId);
    const autoMerge = item ? readAutoMerge(item.autoMerge) : null;
    return item && autoMerge ? { item, autoMerge } : null;
  }

  async function latestRun(item: PlanItemRecord): Promise<WorkflowRunRecord | null> {
    return item.workflowRunId ? (await workflowRunsDb.get(item.workflowRunId)) ?? null : null;
  }

  /** Persists a new state, announces it and keeps the task's notification in step: a state that raises none resolves the earlier one. */
  async function setState(itemId: string, state: AutoMergeState, patch: Partial<AutoMergeRecord> = {}, conflictFailed = false): Promise<PlanItemRecord | null> {
    const current = await record(itemId);
    if (!current) return null;
    // A task switched off meanwhile stays off: only the toggle itself cancels.
    if (!current.autoMerge.enabled) return null;
    const next: AutoMergeRecord = { ...current.autoMerge, reasons: [], ...patch, state, updatedAt: current.autoMerge.updatedAt };
    // Looking again at an unchanged state writes, announces and raises nothing.
    if (JSON.stringify(next) === JSON.stringify(current.autoMerge)) return current.item;
    next.updatedAt = new Date().toISOString();
    const updated = await planItemsDb.update(itemId, { autoMerge: next });
    if (!updated) return null;
    deps.publish({ type: 'planItem', planItem: updated });
    const subject = { type: 'autoMerge' as const, projectId: updated.projectId, planItemId: itemId };
    const kind = notificationKindFor(state, conflictFailed);
    await resolveNotifications(subject, AUTO_MERGE_NOTIFICATION_KINDS.filter((candidate) => candidate !== kind));
    if (state === 'merged') {
      await raiseNotification({ kind: 'automerge.merged', subject, title: `Auto-merge: ${updated.title}`, description: autoMergeMergedDescription(next) });
    }
    if (kind) {
      await raiseNotification({ kind, subject, title: `Auto-merge: ${updated.title}`, description: next.reasons.join('; ') || 'Auto-merge needs your attention.' });
    }
    return updated;
  }

  /**
   * The running conflict-resolution run is waited out inside the project's turn, so no other merge of
   * the project starts before it ends. Returns false when the wait hit its bound with the run still
   * going: the turn is released and the next look waits again.
   */
  async function waitForConflictRun(itemId: string, projectId: string, number: number): Promise<boolean> {
    const deadline = Date.now() + maxRunWaitMs;
    for (;;) {
      const current = await record(itemId);
      if (!current?.autoMerge.enabled || !(await deps.activeConflictRun(projectId, number))) return true;
      if (Date.now() >= deadline) return false;
      await sleep(runPollMs);
    }
  }

  async function failedRead(itemId: string, error: unknown): Promise<void> {
    if (error instanceof PullRequestNotFoundError) { await setState(itemId, 'cannot-merge', { reasons: [error.message] }); return; }
    await setState(itemId, 'provider', { reasons: [message(error)] });
  }

  async function startResolution(itemId: string, item: PlanItemRecord, run: WorkflowRunRecord, reading: PullRequestReading): Promise<boolean> {
    const executorId = conflictExecutorFor(run);
    if (!executorId) { await setState(itemId, 'agent', { reasons: ['No coding agent is assigned to this task.'] }); return false; }
    const unavailable = await deps.executorUnavailableReason(executorId);
    if (unavailable) { await setState(itemId, 'agent', { reasons: [unavailable] }); return false; }
    try {
      const started = await deps.startConflictRun(item.projectId, reading, executorId, { planItemId: itemId, title: autoMergeConflictTitle(item.title) });
      await setState(itemId, 'resolving', { runId: started.run.id });
    } catch (error) {
      const agentProblem = error instanceof Error && (AGENT_START_FAILURES.has(error.name) || /limit/i.test(error.message));
      await setState(itemId, agentProblem ? 'agent' : 'failed', { reasons: [message(error)] });
      return false;
    }
    return true;
  }

  async function merge(itemId: string, project: ProjectRecord, reading: PullRequestReading, warnings: string[]): Promise<void> {
    await setState(itemId, 'merging', { warnings });
    try {
      const result = await deps.mergePullRequest(project, reading);
      await setState(itemId, 'merged', { mergedAt: new Date().toISOString(), branchWarning: result.branchWarning, branchNote: result.branchNote });
    } catch (error) {
      // The person may have merged it by hand between the read and the merge call.
      const again = await deps.readPullRequest(project, reading.number).catch(() => null);
      if (again?.state === 'merged') { await setState(itemId, 'merged', { mergedAt: new Date().toISOString(), branchNote: MERGED_ELSEWHERE_NOTE }); return; }
      await setState(itemId, isProviderUnreachable(message(error)) ? 'provider' : 'failed', { reasons: [message(error)] });
    }
  }

  /** Records the task's own PR number, unless the task was switched off meanwhile. */
  async function markPullRequest(itemId: string, number: number): Promise<void> {
    const current = await record(itemId);
    if (!current?.autoMerge.enabled || current.autoMerge.prNumber === number) return;
    const marked = await planItemsDb.update(itemId, { autoMerge: { ...current.autoMerge, prNumber: number } });
    if (marked) deps.publish({ type: 'planItem', planItem: marked });
  }

  /** One look at a task. Returns true when it should be looked at again at once (a conflict run it waited for has ended). */
  async function step(itemId: string, options: EvaluateOptions): Promise<boolean> {
    const current = await record(itemId);
    if (!current?.autoMerge.enabled || current.item.archived) return false;
    const { item, autoMerge } = current;
    if (autoMerge.state === 'merged') return false;
    // A failed or unmergeable task waits for the person, but is still noticed when its PR gets merged elsewhere.
    const dormant = leftForThePerson(autoMerge.state, options);

    const run = await latestRun(item);
    if (!run || run.status !== 'completed' || run.prConflict) { if (!dormant) await setState(itemId, 'waiting'); return false; }
    const project = await deps.getProject(item.projectId).catch(() => null);
    if (!project) return false;
    const ineligible = autoMergeIneligibleReason(project, run);
    if (ineligible) { if (!dormant) await setState(itemId, 'no-pr', { reasons: [ineligible] }); return false; }
    const number = pullRequestNumberOf(run.prUrl);
    if (number === null) {
      if (dormant) return false;
      const raised = /Could not be created automatically: ([\s\S]*)$/.exec(run.completionReport ?? '')?.[1]?.trim();
      await setState(itemId, 'no-pr', { reasons: [safeReason(raised || 'The Complete step did not raise a pull request.')] });
      return false;
    }

    let reading: PullRequestReading;
    try { reading = await deps.readPullRequest(project, number); } catch (error) {
      // A task waiting for the person only watches for a merge elsewhere: a failed read changes nothing.
      if (!dormant) await failedRead(itemId, error);
      return false;
    }
    // The task may have been switched off, archived or deleted while the provider was answering.
    const fresh = await record(itemId);
    if (!fresh?.autoMerge.enabled || fresh.item.archived) return false;
    await markPullRequest(itemId, number);
    if (dormant || leftForThePerson(fresh.autoMerge.state, options)) {
      if (reading.state === 'merged') await setState(itemId, 'merged', { prNumber: number, mergedAt: new Date().toISOString(), branchNote: MERGED_ELSEWHERE_NOTE });
      return false;
    }

    const decision = decideAutoMerge(reading);
    switch (decision.action) {
      case 'merged':
        await setState(itemId, 'merged', { prNumber: number, warnings: [], mergedAt: new Date().toISOString(), branchNote: MERGED_ELSEWHERE_NOTE });
        return false;
      case 'cannot-merge':
        await setState(itemId, 'cannot-merge', { prNumber: number, reasons: [decision.reason] });
        return false;
      case 'blocked':
        await setState(itemId, 'blocked', { prNumber: number, reasons: decision.reasons, warnings: decision.warnings });
        return false;
      case 'merge':
        await merge(itemId, project, reading, decision.warnings);
        return false;
      case 'resolve': {
        const active = await deps.activeConflictRun(item.projectId, number);
        if (active) {
          await setState(itemId, 'resolving', { prNumber: number, runId: active.id, warnings: decision.warnings });
        } else {
          const latest = await deps.latestConflictRun(item.projectId, number);
          const waitedOn = fresh.autoMerge.state === 'resolving' && latest !== null && latest.id === fresh.autoMerge.runId;
          if (waitedOn && (latest.status === 'failed' || latest.status === 'stopped')) {
            const detail = latest.prConflict?.detail ?? latest.attentionReason ?? 'The conflict-resolution run was stopped.';
            await setState(itemId, 'failed', { prNumber: number, runId: latest.id, reasons: [safeReason(detail)] }, true);
            return false;
          }
          if (!(await startResolution(itemId, item, run, reading))) return false;
        }
        return waitForConflictRun(itemId, item.projectId, number);
      }
    }
  }

  async function evaluateNow(itemId: string, options: EvaluateOptions): Promise<void> {
    while (await step(itemId, options)) { /* A conflict run ended; look at the pull request again. */ }
  }

  function evaluate(itemId: string, options: EvaluateOptions = { automatic: true }): Promise<void> {
    const job = (async () => {
      const item = await planItemsDb.get(itemId);
      if (!item) return;
      await queue.enqueue(item.projectId, itemId, () => evaluateNow(itemId, options));
    })();
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
    return job;
  }

  async function pending(): Promise<string[]> {
    const items = await planItemsDb.find((item) => readAutoMerge(item.autoMerge)?.enabled === true && !item.archived);
    return items.filter((item) => readAutoMerge(item.autoMerge)!.state !== 'merged').map((item) => item.id);
  }

  async function evaluatePending(): Promise<void> {
    await Promise.all((await pending()).map((id) => evaluate(id, { automatic: true })));
  }

  async function requireItem(projectId: string, itemId: string): Promise<PlanItemRecord> {
    const item = await planItemsDb.get(itemId);
    if (!item || item.projectId !== projectId) throw new PlanItemNotFoundError();
    return item;
  }

  /**
   * The toggle. Turning it off is always allowed; turning it on needs a task that can have a pull request.
   * `atStart` is the Start task dialog's choice, saved just after the start was accepted: the run exists
   * but its branch is only filled in during start-up, so the run is not consulted (the start route has
   * already checked the requested options).
   */
  async function setEnabled(projectId: string, itemId: string, enabled: boolean, options: { atStart?: boolean } = {}): Promise<PlanItemRecord> {
    const item = await requireItem(projectId, itemId);
    const existing = readAutoMerge(item.autoMerge);
    if (existing?.enabled === enabled || (!existing && !enabled)) return item;
    if (enabled) {
      const reason = autoMergeIneligibleReason(await deps.getProject(projectId), options.atStart ? null : await latestRun(item));
      if (reason) throw new AutoMergeUnavailableError(reason);
      const fresh = existing?.state === 'merged' ? { ...existing, enabled: true } : newAutoMerge(true, new Date().toISOString());
      const updated = await planItemsDb.update(itemId, { autoMerge: fresh });
      deps.publish({ type: 'planItem', planItem: updated! });
      void evaluate(itemId, { automatic: false });
      return updated!;
    }
    const updated = await planItemsDb.update(itemId, { autoMerge: { ...existing!, enabled: false, updatedAt: new Date().toISOString() } });
    deps.publish({ type: 'planItem', planItem: updated! });
    await resolveNotifications({ type: 'autoMerge', projectId, planItemId: itemId }, AUTO_MERGE_NOTIFICATION_KINDS);
    return updated!;
  }

  async function retry(projectId: string, itemId: string): Promise<PlanItemRecord> {
    const item = await requireItem(projectId, itemId);
    const current = readAutoMerge(item.autoMerge);
    if (!current?.enabled || (current.state !== 'failed' && current.state !== 'agent')) throw new AutoMergeNotRetryableError();
    const updated = await setState(itemId, 'waiting', { prNumber: current.prNumber });
    void evaluate(itemId, { automatic: false });
    return updated ?? item;
  }

  /** A pull request was merged some other way (the PR tab): the task that owns it goes straight to Merged. */
  async function pullRequestMerged(projectId: string, number: number): Promise<void> {
    const enabled = await planItemsDb.find((item) => item.projectId === projectId && readAutoMerge(item.autoMerge)?.enabled === true);
    const owners: PlanItemRecord[] = [];
    for (const item of enabled) {
      // The stored number is only there after a first look; the run's PR link names it before that.
      const run = await latestRun(item);
      if (readAutoMerge(item.autoMerge)?.prNumber === number || pullRequestNumberOf(run?.prUrl) === number) owners.push(item);
    }
    await Promise.all(owners.map((item) => evaluate(item.id, { automatic: false })));
  }

  function onEvent(event: WorkerEvent): void {
    if (event.type === 'planItemDeleted') {
      void resolveNotifications({ type: 'autoMerge', projectId: event.projectId, planItemId: event.id }, AUTO_MERGE_NOTIFICATION_KINDS).catch(() => undefined);
    } else if (event.type === 'planItem' && event.planItem.archived && readAutoMerge(event.planItem.autoMerge)?.enabled) {
      void resolveNotifications({ type: 'autoMerge', projectId: event.planItem.projectId, planItemId: event.planItem.id }, AUTO_MERGE_NOTIFICATION_KINDS).catch(() => undefined);
    } else if (event.type === 'workflowRun') {
      const { run } = event;
      const settled = run.status === 'completed' || run.status === 'failed' || run.status === 'stopped';
      const itemId = run.prConflict ? run.prConflict.autoMergeItemId : run.status === 'completed' ? run.planItemId : undefined;
      if (itemId && (settled || !run.prConflict)) void evaluate(itemId).catch(() => undefined);
    }
  }

  /** Resumes every pending auto-merge from its persisted state, then keeps looking at them. */
  function start(): () => void {
    const unsubscribe = deps.onWorkerEvent(onEvent);
    void evaluatePending().catch(() => undefined);
    const timer = setInterval(() => { void evaluatePending().catch(() => undefined); }, deps.evaluateEveryMs ?? DEFAULT_EVALUATE_EVERY_MS);
    timer.unref();
    return () => { unsubscribe(); clearInterval(timer); };
  }

  /** Waits for the evaluations started so far (tests). */
  async function idle(): Promise<void> {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  }

  return { setEnabled, retry, evaluate, evaluatePending, pullRequestMerged, start, idle };
}

export type AutoMergeService = ReturnType<typeof createAutoMergeService>;
