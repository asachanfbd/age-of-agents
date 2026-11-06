export const SOUND_MUTED_STORAGE_KEY = 'agent-visual-os.sounds-muted';

export interface SoundPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): SoundPreferenceStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    // Some privacy modes expose localStorage but throw when it is accessed.
    return undefined;
  }
}

/** Sounds are on unless the user has explicitly muted them. */
export function readSoundsMuted(storage = browserStorage()): boolean {
  try {
    return storage?.getItem(SOUND_MUTED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remembers the choice for the next page load; a storage failure only loses persistence. */
export function writeSoundsMuted(muted: boolean, storage = browserStorage()): void {
  try {
    storage?.setItem(SOUND_MUTED_STORAGE_KEY, String(muted));
  } catch {
    // Quota or privacy-mode failures: the in-memory choice still applies for this session.
  }
}

let currentMuted: boolean | undefined;
const listeners = new Set<() => void>();

/** Reads storage once, then serves a cached value — shaped for `useSyncExternalStore`. */
export function getSoundsMuted(): boolean {
  currentMuted ??= readSoundsMuted();
  return currentMuted;
}

export function setSoundsMuted(muted: boolean): void {
  currentMuted = muted;
  writeSoundsMuted(muted);
  listeners.forEach((listener) => listener());
}

export function subscribeSoundsMuted(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
