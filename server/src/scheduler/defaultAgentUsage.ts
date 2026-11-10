import type { ExecutorProfile } from '../domain/types.ts';
import type { ExecutorLimits } from '../executors/executorLimits.ts';

/** The usage the scheduler gates on: the limits of the agent a run with no agent choice would start on. */
export async function defaultAgentUsage(
  resolve: () => Promise<ExecutorProfile>,
  readLimits: (executor: ExecutorProfile) => Promise<ExecutorLimits | null>,
): Promise<ExecutorLimits | null> {
  return readLimits(await resolve());
}
