let last: { x: number; y: number } | null = null;

/** Remembers where the pointer last went down, so a modal can grow out of the card that was clicked. Returns the unsubscribe. */
export function trackPointerOrigin(target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const onDown = (event: Event) => { const { clientX, clientY } = event as PointerEvent; last = { x: clientX, y: clientY }; };
  target.addEventListener('pointerdown', onDown, true);
  return () => target.removeEventListener('pointerdown', onDown, true);
}

/** The offset in pixels from the viewport's centre to the last pointer-down; null when there was none (a keyboard open), which uses the plain zoom. */
export function zoomOffset(viewport: { width: number; height: number }): { dx: number; dy: number } | null {
  return last ? { dx: Math.round(last.x - viewport.width / 2), dy: Math.round(last.y - viewport.height / 2) } : null;
}

export const resetPointerOrigin = (): void => { last = null; };
