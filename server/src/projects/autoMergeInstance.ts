import { getExecutor } from '../executors/executorService.ts';
import { readExecutorLimits } from '../executors/executorLimits.ts';
import { workerManager } from '../worker/workerManager.ts';
import { createAutoMergeService } from './autoMergeService.ts';
import { mergePullRequest, readPullRequest } from './pullRequestActions.ts';
import { getProject } from './projectService.ts';

const LIMIT_REACHED_PERCENT = 100;

/** Why the coding agent cannot take a run now: removed from the configuration, or its usage limit is used up. */
async function executorUnavailableReason(executorId: string): Promise<string | null> {
  const executor = await getExecutor(executorId);
  if (!executor) return `The coding agent "${executorId}" is no longer configured.`;
  const limits = await readExecutorLimits(executor);
  const reached = [limits?.fiveHour, limits?.sevenDay].some((window) => window && window.usedPercentage >= LIMIT_REACHED_PERCENT);
  return reached ? `The usage limit of "${executor.label}" is reached.` : null;
}

/** The daemon's own auto-merge service, over the real worker manager and provider calls. */
export const autoMerge = createAutoMergeService({
  getProject,
  readPullRequest,
  mergePullRequest: (project, reading) => mergePullRequest(project, reading),
  startConflictRun: workerManager.startConflictRun,
  activeConflictRun: workerManager.activeConflictRun,
  latestConflictRun: workerManager.latestConflictRun,
  executorUnavailableReason,
  onWorkerEvent: workerManager.onWorkerEvent,
  publish: workerManager.publishEvent,
});
