import { planItemsDb, workflowRunsDb } from '../db/collections.ts';
import type { PlanItemRecord, ProjectRecord, TaskPullRequestReading, WorkflowRunRecord } from '../domain/types.ts';
import type { WorkerEvent } from '../worker/workerManager.ts';
import type { BranchPullRequest } from './gitProvider.ts';
import { autoMergeIneligibleReason, readAutoMerge } from './autoMerge.ts';

export interface PullRequestStateDeps {
  getProject(projectId: string): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectRecord[]>;
  /** The newest pull request of each branch, keyed by branch. Throws when the provider can't be reached. */
  lookup(project: ProjectRecord, branches: string[]): Promise<Map<string, BranchPullRequest>>;
  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void;
  publish(event: WorkerEvent): void;
  /** Branches asked of the provider in one call. */
  batchSize?: number;
  /** The most branches one refresh of a project asks about; the rest wait for the next refresh. */
  budgetPerRefresh?: number;
  /** Pause between two calls of one refresh. */
  spacingMs?: number;
  refreshEveryMs?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_BUDGET_PER_REFRESH = 100;
const DEFAULT_SPACING_MS = 250;
const DEFAULT_REFRESH_EVERY_MS = 60_000;

/** The branch whose pull request a finished task owns, or null for a task that has none of its own to hold. */
export function ownBranchOf(project: Pick<ProjectRecord, 'repositoryUrl'>, item: PlanItemRecord, run: WorkflowRunRecord | undefined): string | null {
  if (item.archived || item.prConflict || item.testingSetup || !run || run.prConflict || run.status !== 'completed') return null;
  if (readAutoMerge(item.autoMerge)?.enabled) return null;
  if (autoMergeIneligibleReason(project, run)) return null;
  return run.branch ?? null;
}

/**
 * Reads, for each finished task without Auto-merge, the state of its own pull request from the Git
 * provider, so the Tasks board can keep the task in "PR not merged yet" while that pull request is open.
 * The last successful reading is stored on the task; a failed lookup changes nothing. Tasks with
 * Auto-merge on are driven by the auto-merge service and never read here. A merged pull request is
 * final and is not read again. Per refresh a project asks about a bounded number of branches in
 * batches, never-read tasks first and then the least recently asked, so none starves.
 */
export function createPullRequestStateService(deps: PullRequestStateDeps) {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const budget = deps.budgetPerRefresh ?? DEFAULT_BUDGET_PER_REFRESH;
  const spacingMs = deps.spacingMs ?? DEFAULT_SPACING_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  /** When each task was last asked about (success or not), for scheduling only. */
  const lastAsked = new Map<string, number>();
  const refreshes = new Map<string, { running: Promise<void>; rerun: boolean }>();

  async function candidates(project: ProjectRecord): Promise<{ item: PlanItemRecord; branch: string }[]> {
    const items = await planItemsDb.find((item) => item.projectId === project.id && !item.archived && !!item.workflowRunId && item.pullRequest?.state !== 'merged');
    const found: { item: PlanItemRecord; branch: string }[] = [];
    for (const item of items) {
      const run = await workflowRunsDb.get(item.workflowRunId!);
      const branch = ownBranchOf(project, item, run);
      if (branch) found.push({ item, branch });
    }
    // Never-read tasks first, then the one asked about longest ago.
    const rank = ({ item }: { item: PlanItemRecord }) => (item.pullRequest ? 1 : 0);
    return found.sort((a, b) => rank(a) - rank(b) || (lastAsked.get(a.item.id) ?? 0) - (lastAsked.get(b.item.id) ?? 0) || a.item.id.localeCompare(b.item.id));
  }

  async function store(itemId: string, startedAt: number, answer: BranchPullRequest): Promise<void> {
    const item = await planItemsDb.get(itemId);
    // Archived, deleted, or switched to Auto-merge while the provider was answering.
    if (!item || item.archived || readAutoMerge(item.autoMerge)?.enabled) return;
    if (item.pullRequest?.state === answer.state && item.pullRequest.prNumber === answer.number) return;
    const reading: TaskPullRequestReading = { state: answer.state, prNumber: answer.number, readAt: new Date(startedAt).toISOString() };
    const updated = await planItemsDb.update(itemId, { pullRequest: reading });
    if (updated) deps.publish({ type: 'planItem', planItem: updated });
  }

  async function refreshNow(projectId: string): Promise<void> {
    const project = await deps.getProject(projectId).catch(() => null);
    if (!project?.repositoryUrl) return;
    const chosen = (await candidates(project)).slice(0, budget);
    for (let start = 0; start < chosen.length; start += batchSize) {
      if (start > 0) await sleep(spacingMs);
      const batch = chosen.slice(start, start + batchSize);
      const startedAt = now();
      for (const { item } of batch) lastAsked.set(item.id, startedAt);
      let answers: Map<string, BranchPullRequest>;
      try { answers = await deps.lookup(project, [...new Set(batch.map((entry) => entry.branch))]); } catch { continue; }
      for (const { item, branch } of batch) {
        const answer = answers.get(branch);
        if (answer) await store(item.id, startedAt, answer);
      }
    }
  }

  /** Refreshes one project; a refresh asked for while one runs makes that one go round once more. */
  function refreshProject(projectId: string): Promise<void> {
    const current = refreshes.get(projectId);
    if (current) { current.rerun = true; return current.running; }
    const entry = { running: Promise.resolve(), rerun: false };
    refreshes.set(projectId, entry);
    entry.running = (async () => {
      try {
        do { entry.rerun = false; await refreshNow(projectId).catch(() => undefined); } while (entry.rerun);
      } finally { refreshes.delete(projectId); }
    })();
    return entry.running;
  }

  async function refreshAll(): Promise<void> {
    await Promise.all((await deps.listProjects()).filter((project) => project.repositoryUrl).map((project) => refreshProject(project.id)));
  }

  function onEvent(event: WorkerEvent): void {
    if (event.type === 'workflowRun' && event.run.status === 'completed' && !event.run.prConflict) void refreshProject(event.run.projectId);
  }

  /** Reads on the project's PR cadence and whenever a task's run completes. */
  function start(): () => void {
    const unsubscribe = deps.onWorkerEvent(onEvent);
    void refreshAll().catch(() => undefined);
    const timer = setInterval(() => { void refreshAll().catch(() => undefined); }, deps.refreshEveryMs ?? DEFAULT_REFRESH_EVERY_MS);
    timer.unref();
    return () => { unsubscribe(); clearInterval(timer); };
  }

  return { refreshProject, refreshAll, start };
}

export type PullRequestStateService = ReturnType<typeof createPullRequestStateService>;
