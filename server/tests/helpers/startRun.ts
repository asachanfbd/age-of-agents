import type { TaskRecord, WorkflowRunRecord } from '../../src/domain/types.ts';
import type { createWorkerManager } from '../../src/worker/workerManager.ts';

type Manager = ReturnType<typeof createWorkerManager>;

// Imports only types from src: loading a src module here would run before a test file sets its data directory.

/** Waits for a started run's background start-up, then returns its first step's Task (the old synchronous contract). A start-up that failed throws its reason, as a rejected start used to. */
async function settleStart(manager: Manager, run: WorkflowRunRecord): Promise<TaskRecord> {
  await manager.whenStartupSettled(run.id);
  const settled = await manager.getWorkflowRun(run.id);
  if (settled?.status === 'failed' && settled.startup) {
    throw new Error(settled.startup.steps.find((step) => step.state === 'failed')?.reason ?? 'The start failed');
  }
  const tasks = (await manager.listTasksForProject(run.projectId)).filter((task) => task.workflowRunId === run.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return tasks[0]!;
}

/** `executePlanItem` for a test that wants the run fully started: resolves to the first step's Task. */
export function settledExecute(manager: Manager) {
  return async (...args: Parameters<Manager['executePlanItem']>): Promise<TaskRecord> =>
    settleStart(manager, await manager.executePlanItem(...args));
}

/** `enqueuePlanItemExecution`, with a started run settled and reported as its first Task like `settledExecute`. */
export function settledEnqueue(manager: Manager) {
  return async (...args: Parameters<Manager['enqueuePlanItemExecution']>) => {
    const result = await manager.enqueuePlanItemExecution(...args);
    if (!result.started) return result;
    return { started: true as const, task: await settleStart(manager, result.run) };
  };
}

/** `startTestingSetup`, with a started run's background start-up settled and the run re-read. */
export function settledSetup(manager: Manager) {
  return async (...args: Parameters<Manager['startTestingSetup']>) => {
    const result = await manager.startTestingSetup(...args);
    if (!result.run) return result;
    await manager.whenStartupSettled(result.run.id);
    return { ...result, run: await manager.getWorkflowRun(result.run.id) };
  };
}
