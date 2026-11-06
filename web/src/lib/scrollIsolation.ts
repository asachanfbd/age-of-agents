const SCROLL_EVENTS = ['wheel', 'touchmove'] as const;
const stopPropagation = (event: Event) => event.stopPropagation();

/**
 * Lets a footer list scroll under an open modal. A modal popup locks page scrolling with a
 * document-level wheel/touch listener that cancels scrolling anywhere outside it; stopping the native
 * events at the list keeps them from reaching it (React's synthetic stopPropagation can't), so the
 * list scrolls and nothing behind it moves. Returns the function that detaches the listeners.
 */
export function isolateScroll(node: HTMLElement): () => void {
  for (const type of SCROLL_EVENTS) node.addEventListener(type, stopPropagation, { passive: true });
  return () => { for (const type of SCROLL_EVENTS) node.removeEventListener(type, stopPropagation); };
}
