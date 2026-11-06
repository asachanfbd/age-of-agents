import { sampleThemedCelestial } from '../scene/celestial';
import { getThemePreference, resolveSceneTheme, subscribeThemePreference, systemPrefersDark } from './themePreference';

/** Above this, `sampleThemedCelestial`'s smoothed night value reads as "night" for UI purposes —
 * matches the point the 3D scene's own moon/stars start taking over from the sun (celestial.ts). */
const NIGHT_THRESHOLD = 0.5;

/** Resolves the current theme preference to a plain light/dark boolean for Tailwind's `.dark`
 * class. For 'daytime' this reuses the exact astronomical sun-altitude calculation the 3D scene
 * runs (`sampleThemedCelestial`), so the UI chrome and the scene always agree on day vs. night —
 * see resolveSceneTheme in themePreference.ts for the preference -> scene-theme step this builds on. */
export function isDarkTheme(now = new Date()): boolean {
  const sceneTheme = resolveSceneTheme(getThemePreference(), systemPrefersDark());
  if (sceneTheme === 'dark') return true;
  if (sceneTheme === 'light') return false;
  return sampleThemedCelestial(now, sceneTheme).night >= NIGHT_THRESHOLD;
}

function applyDarkClass(root: HTMLElement): void {
  root.classList.toggle('dark', isDarkTheme());
}

/** Keeps shadcn/Tailwind's `.dark` class on `root` live: reacts to theme-preference changes,
 * system-scheme flips (for the 'system' preference), and — for 'daytime' — the astronomical
 * day/night transition as real time passes. Returns an unsubscribe function. */
export function initThemeClassSync(root: HTMLElement = document.documentElement): () => void {
  applyDarkClass(root);

  const unsubscribePreference = subscribeThemePreference(() => applyDarkClass(root));

  const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
  const onMediaChange = () => applyDarkClass(root);
  media?.addEventListener('change', onMediaChange);

  // 'daytime' drifts continuously with the sun, not just on preference/system changes.
  const pollId = window.setInterval(() => applyDarkClass(root), 60_000);

  return () => {
    unsubscribePreference();
    media?.removeEventListener('change', onMediaChange);
    window.clearInterval(pollId);
  };
}
