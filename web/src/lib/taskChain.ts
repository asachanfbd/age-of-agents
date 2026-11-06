import type { TaskData } from '../types';

/**
 * The key that links Tasks into one continued session — the same rule the daemon uses when a
 * follow-up creates a new linked Task (see server/src/worker/workerManager.ts's followUpTask): a
 * Task's own conversationId if it has one, falling back to its sessionId, then its own id.
 */
export function chainKey(task: TaskData): string {
  return task.conversationId ?? task.sessionId ?? task.id;
}

/**
 * Groups Tasks of one `kind` into their conversation chains — every Task ever linked to another
 * by a follow-up lands in the same chain, so a chain reads as one continuous session even though
 * each follow-up is its own Task record. `taskIds` is expected most-recent-first (as
 * `taskIdsByProject`/`loadProjectTasks` provide), so each returned chain is too: chain[0] is the
 * most recently created Task in that session, chain[chain.length - 1] the one that started it. A
 * Task with no follow-ups is its own single-item chain.
 */
export function groupTaskChains(
  taskIds: string[],
  tasksById: Record<string, TaskData>,
  kind: TaskData['kind'],
): TaskData[][] {
  const chains = new Map<string, TaskData[]>();
  for (const id of taskIds) {
    const task = tasksById[id];
    if (!task || task.kind !== kind) continue;
    const key = chainKey(task);
    chains.set(key, [...(chains.get(key) ?? []), task]);
  }
  return [...chains.values()];
}

/** The chain (most-recent-first) containing `taskId`, or undefined if it isn't in any of `chains`. */
export function chainFor(taskId: string, chains: TaskData[][]): TaskData[] | undefined {
  return chains.find((chain) => chain.some((t) => t.id === taskId));
}

/**
 * Ids (oldest-first) of every other Task in `taskId`'s chain — what `TaskDetailsView` renders via
 * `PastSessionTurns` above its own thread, so a followed-up Task shows the whole session's history
 * instead of just the latest link in isolation.
 */
export function chainHistoryIds(chain: TaskData[] | undefined): string[] {
  if (!chain) return [];
  return chain.slice(1).map((t) => t.id).reverse();
}
