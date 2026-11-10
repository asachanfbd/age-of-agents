import { workerManager } from '../worker/workerManager.ts';
import { autoMerge } from './autoMergeInstance.ts';
import { createDependencyService } from './dependencyService.ts';
import { realDependencyGit } from './dependencyGit.ts';
import { getPlanItem } from './planItemService.ts';
import { getProject } from './projectService.ts';
import { gitSyncPoller } from './gitSyncPoller.ts';

/** The daemon's own dependent-task service, over the real worker manager, git and sync poller. */
export const dependencies = createDependencyService({
  getProject,
  git: realDependencyGit,
  syncOf: (projectId) => gitSyncPoller.get(projectId),
  startPlanItem: (planItemId, options) => workerManager.enqueuePlanItemExecution(planItemId, options),
  enableAutoMerge: (projectId, planItemId) => autoMerge.setEnabled(projectId, planItemId, true),
  early: {
    earlyStepFor: (planItemId, options) => workerManager.earlyStepForStart(planItemId, options),
    startEarlyRun: (planItemId, options) => workerManager.enqueuePlanItemExecution(planItemId, { ...options, early: true }),
    queuedStartOf: async (planItemId) => (await workerManager.listPlanItemQueue((await getPlanItem(planItemId)).projectId)).find((entry) => entry.planItemId === planItemId) ?? null,
    removeQueuedStart: (entryId) => workerManager.removeQueuedPlanItemExecution(entryId),
    releaseHeldRun: (runId) => workerManager.releaseHeldRun(runId),
    discardEarlyRun: (runId) => workerManager.discardEarlyRun(runId),
  },
  onWorkerEvent: workerManager.onWorkerEvent,
  onProjectSync: (listener) => gitSyncPoller.onSyncEvent((event) => listener(event.sync.projectId)),
  publish: workerManager.publishEvent,
});
