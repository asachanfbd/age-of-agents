export const VIEW_MODE_STORAGE_KEY = 'agent-visual-os.view-mode';

/** 'world' is the 3D village; 'cards' is the lightweight project list that keeps three.js unloaded. */
export const VIEW_MODES = ['world', 'cards'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const DEFAULT_VIEW_MODE: ViewMode = 'world';

export interface ViewModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && VIEW_MODES.includes(value as ViewMode);
}

function browserStorage(): ViewModeStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    // Some privacy modes expose localStorage but throw when it is accessed.
    return undefined;
  }
}

/** The persisted choice, or the default when nothing valid is stored or storage is unavailable. */
export function readViewMode(storage = browserStorage()): ViewMode {
  try {
    const stored = storage?.getItem(VIEW_MODE_STORAGE_KEY);
    return isViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

/** Remembers the choice for the next page load; a storage failure only loses persistence. */
export function writeViewMode(mode: ViewMode, storage = browserStorage()): void {
  try {
    storage?.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Quota or privacy-mode failures: the in-memory choice still applies for this session.
  }
}
