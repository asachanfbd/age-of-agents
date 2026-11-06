import { clampPopupSize, type Size } from './popupResize.ts';

/** How many window sizes a popup remembers; saving past this evicts the least recently saved one. */
export const POPUP_SIZE_MEMORY_LIMIT = 8;

/** Saved popup sizes keyed by viewport (`"1920x1080"`), oldest save first. */
export type PopupSizeEntries = Record<string, Size>;

export interface PopupSizeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PopupSizeMemory {
  /** The size saved for this exact viewport, clamped to it, or null to keep the popup's default size. */
  restore(viewport: Size): Size | null;
  /** Records a size the user dragged the popup to while the window had this viewport. */
  saveUserResize(viewport: Size, size: Size): void;
}

export function viewportKey(viewport: Size): string {
  return `${Math.round(viewport.width)}x${Math.round(viewport.height)}`;
}

export function matchPopupSize(entries: PopupSizeEntries, viewport: Size): Size | null {
  const saved = entries[viewportKey(viewport)];
  return saved ? clampPopupSize(saved, viewport) : null;
}

/** Adds (or refreshes) the entry for `viewport` as the newest, dropping the oldest beyond `limit`. */
export function rememberPopupSize(
  entries: PopupSizeEntries, viewport: Size, size: Size, limit = POPUP_SIZE_MEMORY_LIMIT,
): PopupSizeEntries {
  const key = viewportKey(viewport);
  const kept = Object.entries(entries).filter(([entryKey]) => entryKey !== key);
  return Object.fromEntries([...kept, [key, size] as const].slice(-limit));
}

const isSize = (value: unknown): value is Size =>
  typeof value === 'object' && value !== null
  && Number.isFinite((value as Size).width) && Number.isFinite((value as Size).height);

/** Parses stored entries, discarding anything malformed rather than failing. */
export function parsePopupSizeEntries(raw: string | null): PopupSizeEntries {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, size]) => isSize(size))) as PopupSizeEntries;
  } catch {
    return {};
  }
}

function browserStorage(): PopupSizeStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    // Some privacy modes expose localStorage but throw when it is accessed.
    return undefined;
  }
}

/** Per-viewport popup sizes persisted under `storageKey`. Storage failures only lose persistence. */
export function createPopupSizeMemory(storageKey: string, storage = browserStorage()): PopupSizeMemory {
  const read = (): PopupSizeEntries => {
    try {
      return parsePopupSizeEntries(storage?.getItem(storageKey) ?? null);
    } catch {
      return {};
    }
  };

  return {
    restore: (viewport) => matchPopupSize(read(), viewport),
    saveUserResize: (viewport, size) => {
      try {
        storage?.setItem(storageKey, JSON.stringify(rememberPopupSize(read(), viewport, size)));
      } catch {
        // Quota or privacy-mode failures: the popup keeps its dragged size for this session.
      }
    },
  };
}
