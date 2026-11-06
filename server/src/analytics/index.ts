import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { planItemsDb, projectsDb, stepRunsDb, tasksDb, workflowRunsDb } from '../db/collections.ts';
import type { ExecutorProfile } from '../domain/types.ts';
import { claudeUsagePoller, getExecutorLimits } from '../executors/claudeUsage.ts';
import { codexUsagePoller } from '../executors/codexUsage.ts';
import type { ExecutorLimits } from '../executors/executorLimits.ts';
import { getExecutor, listExecutors } from '../executors/executorService.ts';
import type { UsagePoller } from '../executors/usagePoller.ts';
import { accountIdentity } from './accountIdentity.ts';
import { ActivityRecorder, type BackgroundTurnTracker, type CliSession, type RecordedEvent } from './activityRecorder.ts';
import { AnalyticsHistory, fileHistoryStorage, type HistoryStorage } from './analyticsHistory.ts';
import { AnalyticsService, type LegacyRound } from './analyticsService.ts';
import { readCliSessionUsage, type CliUsageReader } from './cliUsage.ts';
import { QuotaSampler } from './quotaSampler.ts';
import { defaultExecutor } from '../executors/defaultExecutorInstance.ts';

/** Looks each id up once, however many rounds share it. */
function oncePerId<T>(load: (id: string) => Promise<T>): (id: string) => Promise<T> {
  const loaded = new Map<string, Promise<T>>();
  return (id) => {
    let value = loaded.get(id);
    if (!value) { value = load(id); loaded.set(id, value); }
    return value;
  };
}

/** Step rounds as their own records describe them, for rounds that have no recorded activity. */
async function legacyRounds(executorId: string, since: number): Promise<LegacyRound[]> {
  const runOf = oncePerId((id) => workflowRunsDb.get(id));
  const projectName = oncePerId(async (id) => (await projectsDb.get(id))?.name ?? null);
  const planItemTitle = oncePerId(async (id) => (await planItemsDb.get(id))?.title ?? null);
  const rounds: LegacyRound[] = [];
  for (const stepRun of await stepRunsDb.all()) {
    if (!stepRun.taskId || Date.parse(stepRun.createdAt) < since) continue;
    const task = await tasksDb.get(stepRun.taskId);
    if (task?.executorId !== executorId) continue;
    const run = await runOf(stepRun.runId);
    if (!run) continue;
    rounds.push({
      stepRun,
      executorId,
      account: task.sessionExecutor ? accountIdentity(task.sessionExecutor) : null,
      projectId: run.projectId,
      projectName: await projectName(run.projectId),
      planItemId: run.planItemId,
      label: await planItemTitle(run.planItemId),
      workflowId: run.workflowId,
      workflowName: run.workflowSnapshot.name,
      stepName: run.workflowSnapshot.steps.find((step) => step.id === stepRun.stepId)?.name ?? stepRun.stepId,
    });
  }
  return rounds;
}

/** What differs between the daemon and a test: where history is kept, the clock, and the provider and CLI readers. */
export interface AnalyticsOptions {
  storage: HistoryStorage;
  now?: () => number;
  listExecutors?: () => Promise<ExecutorProfile[]>;
  pollers?: Partial<Record<ExecutorProfile['kind'], UsagePoller>>;
  readLimits?: (executor: ExecutorProfile) => Promise<ExecutorLimits | null>;
  readUsage?: CliUsageReader;
  /** Called after each scheduled sample, once new quota readings are stored. */
  onSampled?: () => Promise<void>;
}

/** History, recorder, sampler and service over the daemon's own records. */
export function createAnalytics(options: AnalyticsOptions) {
  const { now } = options;
  const executors = options.listExecutors ?? listExecutors;
  const history = new AnalyticsHistory({ storage: options.storage, now });
  const recorder = new ActivityRecorder({
    history,
    now,
    readUsage: options.readUsage ?? readCliSessionUsage,
    lookups: {
      executor: async (id) => (await executors()).find((executor) => executor.id === id) ?? getExecutor(id),
      projectName: async (id) => (await projectsDb.get(id))?.name ?? null,
      planItemTitle: async (id) => (await planItemsDb.get(id))?.title ?? null,
      workflowRun: (id) => workflowRunsDb.get(id),
    },
  });
  const sampler = new QuotaSampler({
    history,
    now,
    listExecutors: executors,
    pollers: options.pollers ?? { 'claude-cli': claudeUsagePoller, 'codex-cli': codexUsagePoller },
    readLimits: options.readLimits ?? getExecutorLimits,
    afterTick: async () => {
      await recorder.heartbeat();
      await history.pruneExpired();
      await options.onSampled?.();
    },
  });
  const service = new AnalyticsService({
    history,
    sampler,
    now,
    listExecutors: executors,
    legacyRounds,
    records: {
      projectExists: async (id) => Boolean(await projectsDb.get(id)),
      taskExists: async (id) => Boolean(await tasksDb.get(id)),
      planItemExists: async (id) => Boolean(await planItemsDb.get(id)),
      runExists: async (id) => Boolean(await workflowRunsDb.get(id)),
    },
  });
  return { history, recorder, sampler, service };
}

/** The daemon's analytics, kept with the rest of its runtime state. */
const analytics = createAnalytics({ storage: fileHistoryStorage(path.join(DATA_DIR, 'analytics')), onSampled: () => defaultExecutor.recheck() });
export const analyticsService = analytics.service;

let collecting = false;

/** Notes a Task's CLI session and assigns its reported usage to the Task's round, once collection has started. */
export function recordCliUsage(session: CliSession, turnEnded: boolean): void {
  if (collecting) void analytics.recorder.recordCliUsage(session, turnEnded).catch(() => undefined);
}

/** Records a headless turn as background work once collection has started; before that it only runs the turn. */
export const trackBackgroundTurn: BackgroundTurnTracker = (executor, context, run) => collecting ? analytics.recorder.trackBackground(executor, context, run) : run();

/**
 * Starts collecting in this daemon process: closes sessions the previous process left open, then
 * samples quota on a timer and records activity from `subscribe`'s events. Returns the function that
 * stops both. Call it before any interrupted Task is settled, so those Tasks' sessions end at their
 * last known time and not at this restart.
 */
export async function startAnalyticsCollection(subscribe: (listener: (event: RecordedEvent) => void) => () => void): Promise<() => void> {
  await analytics.recorder.recoverInterrupted();
  collecting = true;
  const unsubscribe = subscribe((event) => analytics.recorder.handle(event));
  const stopSampling = analytics.sampler.start();
  return () => { collecting = false; unsubscribe(); stopSampling(); };
}
