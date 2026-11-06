export const REVIEWED_TASKS_STORAGE_KEY = 'agent-visual-os.reviewed-tasks';

/** Only the newest marks are kept, so the stored list can't grow without bound. */
export const MAX_REVIEWED_TASKS = 500;

export interface ReviewedTasksStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ReviewedTasksStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    // Some privacy modes expose localStorage but throw when it is accessed.
    return undefined;
  }
}

/**
 * The settled task ids this browser has already acknowledged, or none when nothing valid is stored
 * or storage is unavailable. Without this a page reload forgets every acknowledgement and each
 * project whose latest task is done shows "completed — awaiting review" again.
 */
export function readReviewedTaskIds(storage = browserStorage()): Record<string, true> {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(REVIEWED_TASKS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(stored)) return {};
    return Object.fromEntries(stored.filter((id) => typeof id === 'string').map((id) => [id, true as const]));
  } catch {
    return {};
  }
}

/** Remembers the acknowledgements for the next page load; a storage failure only loses persistence. */
export function writeReviewedTaskIds(reviewed: Record<string, true>, storage = browserStorage()): void {
  try {
    storage?.setItem(REVIEWED_TASKS_STORAGE_KEY, JSON.stringify(Object.keys(reviewed).slice(-MAX_REVIEWED_TASKS)));
  } catch {
    // Quota or privacy-mode failures: the in-memory marks still apply for this session.
  }
}
