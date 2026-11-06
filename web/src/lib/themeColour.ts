/** A token's current value ("#1d1b17"), for canvas libraries (xterm, sigma) that cannot read `var(--x)`. Empty when the token is missing. */
export function readToken(name: string, root: Element = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

/** Calls `onChange` whenever the app switches between light and dark (the `.dark` class on `<html>`); returns the unsubscribe. */
export function onThemeChange(onChange: () => void, root: Element = document.documentElement): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** A token with an alpha suffix ("#8b949e" + 0.4 -> "#8b949e66"); only six-digit hex values take one. */
export function withAlpha(hex: string, alpha: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${byte}` : hex;
}
