export const THEME_PREFERENCE_STORAGE_KEY = 'agent-visual-os.theme';

export const THEME_PREFERENCES = ['light', 'dark', 'system', 'daytime'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type SceneTheme = 'light' | 'dark' | 'daytime';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'daytime';

let currentPreference: ThemePreference | undefined;
const listeners = new Set<() => void>();

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCES.includes(value as ThemePreference);
}

/** Reads once from local storage, then keeps a small synchronous cache for the render loop. */
export function getThemePreference(): ThemePreference {
  if (currentPreference) return currentPreference;
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFERENCE;
  const stored = window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
  currentPreference = isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE;
  return currentPreference;
}

export function setThemePreference(preference: ThemePreference): void {
  currentPreference = preference;
  if (typeof window !== 'undefined') window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
  listeners.forEach((listener) => listener());
}

export function subscribeThemePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Converts the user-facing choice into the scene condition it represents. */
export function resolveSceneTheme(preference: ThemePreference, prefersDark = false): SceneTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}
