import type { ExecutorLimits } from './executorLimits.ts';
import type { ExecutorProfile } from '../domain/types.ts';
import { listExecutors as listExecutorsDefault } from './executorService.ts';
import { getExecutorLimits as getExecutorLimitsDefault } from './claudeUsage.ts';

/**
 * Shared by every headless "one throwaway turn, pick whichever configured executor has used the
 * least of its rate limit" flow — projects/planItemTitler.ts's task-naming turn and
 * worker/workflowSummarizer.ts's PR-body/completion-report turn — so the selection logic (and its
 * tests) live in one place instead of being copied between them.
 */
export const HEADLESS_KINDS: ExecutorProfile['kind'][] = ['claude-cli', 'codex-cli'];

export function isCodex(executor: ExecutorProfile): boolean {
  return executor.kind === 'codex-cli';
}

/** How much of its rate limit an executor has used, as [5-hour %, 7-day %]. A missing reading counts as 0 — no evidence it is busy. */
function usageScore(limits: ExecutorLimits | null): [number, number] {
  return [limits?.fiveHour?.usedPercentage ?? 0, limits?.sevenDay?.usedPercentage ?? 0];
}

export interface LeastUsedExecutorDeps {
  listExecutors: typeof listExecutorsDefault;
  getExecutorLimits: typeof getExecutorLimitsDefault;
}

export const DEFAULT_LEAST_USED_EXECUTOR_DEPS: LeastUsedExecutorDeps = {
  listExecutors: listExecutorsDefault,
  getExecutorLimits: getExecutorLimitsDefault,
};

/**
 * The claude/codex executor with the most rate limit left: lowest 5-hour usage, then lowest 7-day
 * usage, ties kept in executors.json order. Fully consumed executors are skipped; null when none is
 * left.
 */
export async function selectLeastUsedExecutor(deps: LeastUsedExecutorDeps = DEFAULT_LEAST_USED_EXECUTOR_DEPS): Promise<ExecutorProfile | null> {
  const executors = (await deps.listExecutors()).filter((executor) => HEADLESS_KINDS.includes(executor.kind));
  const scored = await Promise.all(executors.map(async (executor) => ({ executor, score: usageScore(await deps.getExecutorLimits(executor)) })));
  const available = scored.filter(({ score }) => score[0] < 100 && score[1] < 100);
  available.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1]);
  return available[0]?.executor ?? null;
}
