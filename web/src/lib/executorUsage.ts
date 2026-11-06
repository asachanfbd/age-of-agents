import type { ExecutorProfile } from './serverApi';

/**
 * Sorts executors for the footer's agent-limits strip, most-used (by total
 * tokens consumed, server-aggregated in GET /api/executors — see
 * server/src/executors/executorUsage.ts) on the left, least-used on the
 * right — docs/roadmap.md's footer-improvements bundle, item 6. Ties
 * (including every executor still at 0 usage) keep a stable order by label
 * so the strip doesn't reshuffle on every reload before any Task has run.
 */
export function sortExecutorsByUsage(executors: ExecutorProfile[]): ExecutorProfile[] {
  return executors
    .slice()
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens || a.label.localeCompare(b.label));
}
