export interface Box { left: number; width: number }

/** Where the sliding pill sits inside its tab list: the active tab's offset from the list's left edge and its width; null when no tab is measurable. */
export function indicatorBox(list: Box | null, active: Box | null): { x: number; width: number } | null {
  if (!list || !active || active.width <= 0) return null;
  return { x: active.left - list.left, width: active.width };
}
