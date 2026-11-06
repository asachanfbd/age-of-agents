import { useEffect, useLayoutEffect, useRef } from 'react';

/** How close to the bottom of the scroll region counts as "still there" — a small tolerance for sub-pixel/rounding scroll positions, not a scroll region a reader could rest in deliberately. */
const BOTTOM_STICK_THRESHOLD_PX = 24;

/**
 * Sticks a scroll region to its latest content the way every other chat UI does: opening a
 * task/plan chat lands on the bottom, and it keeps following new activity — tool events, agent
 * messages, the final result — for as long as the reader stays at the bottom. The moment they
 * scroll up to reread something earlier, auto-follow stops; scrolling back to the bottom
 * themselves resumes it. `active` gates the scroll listener (e.g. until the task itself has
 * loaded and the region actually exists with content).
 */
export function useStickToBottom(active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_STICK_THRESHOLD_PX;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [active]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  return { containerRef };
}
