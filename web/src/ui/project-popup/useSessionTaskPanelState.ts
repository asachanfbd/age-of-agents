import { useCallback, useMemo, useRef, useState } from 'react';
import { toggleExpanded } from '../../lib/planningTaskPanel';

/**
 * Which rows are expanded and how far the list is scrolled. The session view owns both, so they
 * outlast the panel being unmounted while the viewport is too narrow for it.
 */
export interface SessionTaskPanelState {
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  readScrollTop: () => number;
  saveScrollTop: (scrollTop: number) => void;
}

/** Rows start collapsed; the state lasts as long as the session view calling this stays mounted. */
export function useSessionTaskPanelState(): SessionTaskPanelState {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const scrollTop = useRef(0);
  const onToggle = useCallback((id: string) => setExpanded((current) => toggleExpanded(current, id)), []);
  // Stable, so the panel restores its scroll offset only when it mounts.
  const readScrollTop = useCallback(() => scrollTop.current, []);
  const saveScrollTop = useCallback((next: number) => { scrollTop.current = next; }, []);
  return useMemo(() => ({ expanded, onToggle, readScrollTop, saveScrollTop }), [expanded, onToggle, readScrollTop, saveScrollTop]);
}
