import type { ReactNode } from 'react';

/**
 * The run view's floating top-right control cluster (the Summary ⇄ Session toggle, plus a step
 * session's Resume/Stop): a row of small buttons with a small gap, and an optional status line
 * (`below`) under them. Pinned to the nearest positioned ancestor, never inside a scroller.
 */
export function FloatingControls({ children, below }: { children: ReactNode; below?: ReactNode }) {
  return (
    <div className="absolute top-1.5 right-2 z-10 flex max-w-80 flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">{children}</div>
      {below}
    </div>
  );
}
