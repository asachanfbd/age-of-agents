/**
 * Which finished-run notifications the browser is already showing. A browser window that has a
 * command's log popup or a test run's detail drawer open registers that run here over `/ws`; the
 * daemon then skips the "completed" notification for it, since the person is watching the result.
 * Watches belong to the socket that registered them and vanish with it, so a closed or crashed
 * window never suppresses a later run.
 */

export type WatchedRunKind = 'command' | 'test';

/** Longest run id a watch message may carry; real ids are UUIDs. */
export const MAX_WATCH_RUN_ID_LENGTH = 128;

const watchesByOwner = new Map<object, Set<string>>();

const keyOf = (kind: WatchedRunKind, runId: string) => `${kind}:${runId}`;

export function watchRun(owner: object, kind: WatchedRunKind, runId: string): void {
  const keys = watchesByOwner.get(owner) ?? new Set<string>();
  keys.add(keyOf(kind, runId));
  watchesByOwner.set(owner, keys);
}

export function unwatchRun(owner: object, kind: WatchedRunKind, runId: string): void {
  watchesByOwner.get(owner)?.delete(keyOf(kind, runId));
}

/** Drops every watch an owner registered — call when its socket closes. */
export function dropWatches(owner: object): void {
  watchesByOwner.delete(owner);
}

export function isRunWatched(kind: WatchedRunKind, runId: string): boolean {
  const key = keyOf(kind, runId);
  for (const keys of watchesByOwner.values()) if (keys.has(key)) return true;
  return false;
}

/** A run must have been executing at least this long for its success to be worth a notification. */
export const COMPLETION_NOTIFY_MIN_MS = 10_000;

/** Whether a run that executed from `startedAt` to `endedAt` ran long enough; an unparsable or reversed span never qualifies. */
export function ranLongEnough(startedAt: string | null, endedAt: number): boolean {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return false;
  return endedAt - started >= COMPLETION_NOTIFY_MIN_MS;
}

/** Parses a `/ws` watch message: `{type:'watchRun'|'unwatchRun', kind, runId}`; null for anything malformed. */
export function parseWatchMessage(message: unknown): { action: 'watch' | 'unwatch'; kind: WatchedRunKind; runId: string } | null {
  if (!message || typeof message !== 'object') return null;
  const { type, kind, runId } = message as Record<string, unknown>;
  if (type !== 'watchRun' && type !== 'unwatchRun') return null;
  if (kind !== 'command' && kind !== 'test') return null;
  if (typeof runId !== 'string' || !runId || runId.length > MAX_WATCH_RUN_ID_LENGTH) return null;
  return { action: type === 'watchRun' ? 'watch' : 'unwatch', kind, runId };
}
