import type { ExecutorProfile } from '../domain/types.ts';
import { ExecutorNotFoundError, isInteractiveCli } from './executorService.ts';

export interface FallbackExecutorDeps {
  /** The stored default agent's id, or null when none is stored. */
  current: () => Promise<string | null>;
  listExecutors: () => Promise<ExecutorProfile[]>;
}

/**
 * The agent a run uses when nothing chose one: the owner's selected default, else the first
 * configured interactive-CLI agent (no default stored, or the stored one is gone or not a CLI kind).
 * It never rechecks or reads quota, so a run start stays cheap and deterministic; the daemon's
 * existing rechecks (startup, agent edits, `GET /api/executors`, analytics) repair a stale default.
 */
export function createFallbackExecutor(deps: FallbackExecutorDeps): () => Promise<ExecutorProfile> {
  return async () => {
    const [id, executors] = await Promise.all([deps.current(), deps.listExecutors()]);
    const chosen = id ? executors.find((executor) => executor.id === id) : undefined;
    if (chosen && isInteractiveCli(chosen)) return chosen;
    const firstCli = executors.find(isInteractiveCli);
    if (!firstCli) throw new ExecutorNotFoundError();
    return firstCli;
  };
}
