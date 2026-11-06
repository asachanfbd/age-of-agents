import { useSyncExternalStore } from 'react';
import { showsTaskPanel } from './planningTaskPanel';

function subscribe(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/** Whether the viewport is wide enough for the planning session's task panel, live across resizes. */
export function useWideViewport(): boolean {
  return useSyncExternalStore(subscribe, () => showsTaskPanel(window.innerWidth));
}
