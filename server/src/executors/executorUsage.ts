import type { ExecutorProfile, TaskRecord } from '../domain/types.ts';

/** One executor's rolled-up usage across every Task it has ever run. */
export interface ExecutorUsageSummary {
  totalTokens: number;
  taskCount: number;
}

export type ExecutorWithUsage = ExecutorProfile & { usage: ExecutorUsageSummary };

/**
 * Aggregates each executor's total token usage + task count across every
 * persisted Task — the real data behind the footer's "most used" agent sort
 * (see web/src/lib/executorUsage.ts's sortExecutorsByUsage, which the client
 * applies to the array this returns). Pure and synchronous so it's directly
 * unit-testable without the file DB — see server/tests/executorUsage.test.ts.
 *
 * A Task predating the tokenUsage field (or one whose usage a turn never
 * reported — see extractTokenUsage) contributes 0 tokens but still counts
 * toward `taskCount`.
 */
export function summarizeExecutorUsage(executors: ExecutorProfile[], tasks: TaskRecord[]): ExecutorWithUsage[] {
  const totals = new Map<string, ExecutorUsageSummary>();
  for (const task of tasks) {
    const usage = task.tokenUsage;
    const totalTokens = usage
      ? usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
      : 0;
    const existing = totals.get(task.executorId) ?? { totalTokens: 0, taskCount: 0 };
    totals.set(task.executorId, { totalTokens: existing.totalTokens + totalTokens, taskCount: existing.taskCount + 1 });
  }
  return executors.map((executor) => ({ ...executor, usage: totals.get(executor.id) ?? { totalTokens: 0, taskCount: 0 } }));
}
