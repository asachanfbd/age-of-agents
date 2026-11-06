export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): DraftStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    // Some privacy modes expose localStorage but throw when it is accessed.
    return undefined;
  }
}

/**
 * Builds a per-project draft store under its own storage key prefix, so unrelated per-project
 * drafts (e.g. a task description and a planning prompt) never collide even for the same project,
 * and persistence failures never block the composer that owns the draft.
 */
export function createDraftStore(prefix: string) {
  function storageKey(projectId: string): string {
    return `${prefix}${encodeURIComponent(projectId)}`;
  }

  function read(projectId: string, storage = browserStorage()): string {
    try {
      return storage?.getItem(storageKey(projectId)) ?? '';
    } catch {
      return '';
    }
  }

  function save(projectId: string, draft: string, storage = browserStorage()): void {
    try {
      if (draft) storage?.setItem(storageKey(projectId), draft);
      else storage?.removeItem(storageKey(projectId));
    } catch {
      // Draft persistence is a convenience; a storage failure must not block the composer.
    }
  }

  function clear(projectId: string, storage = browserStorage()): void {
    try {
      storage?.removeItem(storageKey(projectId));
    } catch {
      // See save: keep the composer usable when storage is unavailable.
    }
  }

  return { storageKey, read, save, clear };
}
