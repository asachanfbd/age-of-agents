import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode } from 'react';
import {
  FOOTER_POPOVER_CLOSE_DELAY_MS,
  FOOTER_POPOVER_OPEN_DELAY_MS,
} from '../lib/footerPopoverState';
import { nextRowIndex } from '../lib/footerPullRequests';
import type { ListKey } from '../lib/footerPullRequests';
import { isolateScroll } from '../lib/scrollIsolation';
import type { FooterPopoverAction, FooterPopoverState } from '../lib/footerPopoverState';

const PANEL_WIDTH_PX = 320;
const VIEWPORT_MARGIN_PX = 8;

/**
 * One footer count that opens a small list above it: on hover (after a short delay), on keyboard focus,
 * or pinned by a click. `children` renders only while open, so its live data and timers cost nothing
 * otherwise. The panel renders inside the footer (position: fixed, so the footer's sideways scrolling
 * can't clip it): it stacks above every popup, and modal popups already ignore clicks inside the footer.
 */
export function FooterCountPopover({ id, label, state, dispatch, trigger, children }: {
  id: string;
  /** The count in words ("3 projects working"): names the trigger and the panel. */
  label: string;
  state: FooterPopoverState | null;
  dispatch: Dispatch<FooterPopoverAction>;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const open = state?.id === id;
  const rootRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>(0);
  const restoringFocus = useRef(false);
  const [left, setLeft] = useState(VIEWPORT_MARGIN_PX);
  const detachScroll = useRef<(() => void) | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const focusRowsOnOpen = useRef(false);
  // Keeps the list scrollable under an open modal popup (see `isolateScroll`).
  const setPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    detachScroll.current?.();
    detachScroll.current = node ? isolateScroll(node) : null;
  }, []);

  const schedule = (action: FooterPopoverAction, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => dispatch(action), delay);
  };
  const cancel = () => window.clearTimeout(timer.current);
  const close = () => dispatch({ type: 'close' });
  useEffect(() => cancel, []);

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const width = Math.min(PANEL_WIDTH_PX, window.innerWidth - 2 * VIEWPORT_MARGIN_PX);
    const anchor = rootRef.current.getBoundingClientRect().left;
    setLeft(Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor, window.innerWidth - width - VIEWPORT_MARGIN_PX)));
  }, [open]);

  const rows = () => Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  const focusRow = (key: ListKey) => {
    const list = rows();
    list[nextRowIndex(list.indexOf(document.activeElement as HTMLButtonElement), list.length, key)]?.focus();
  };
  // A keyboard open moves focus into the list so its rows are reachable without a mouse.
  useEffect(() => {
    if (!open || !focusRowsOnOpen.current) return;
    focusRowsOnOpen.current = false;
    focusRow('Home');
  });

  // Esc closes this popover only — captured on window so a modal popup beneath never sees it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dispatch({ type: 'close' });
      // Returning focus to the trigger must not count as a focus that reopens the popover.
      restoringFocus.current = true;
      rootRef.current?.querySelector('button')?.focus();
      restoringFocus.current = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) dispatch({ type: 'close' });
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, dispatch]);

  return (
    <span
      ref={rootRef}
      className="relative flex items-center"
      onMouseEnter={() => schedule({ type: 'preview', id }, FOOTER_POPOVER_OPEN_DELAY_MS)}
      onMouseLeave={() => schedule({ type: 'unpreview', id }, FOOTER_POPOVER_CLOSE_DELAY_MS)}
      onFocus={() => { if (!restoringFocus.current) dispatch({ type: 'preview', id }); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) dispatch({ type: 'unpreview', id }); }}
    >
      <button
        type="button"
        className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={`${label}, opens a list`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(event) => {
          cancel();
          if (event.detail === 0 && !state?.pinned) focusRowsOnOpen.current = true;
          dispatch({ type: 'toggle', id });
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          if (open) focusRow('Home');
          else { focusRowsOnOpen.current = true; dispatch({ type: 'toggle', id }); }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={setPanel}
          role="group"
          aria-label={label}
          style={{ left, width: Math.min(PANEL_WIDTH_PX, window.innerWidth - 2 * VIEWPORT_MARGIN_PX) }}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            focusRow(event.key as ListKey);
          }}
          className="fixed bottom-[calc(var(--status-footer-height)+6px)] flex max-h-[min(24rem,calc(100vh-var(--status-footer-height)-16px))] flex-col glass overflow-hidden rounded-xl text-[12px] text-popover-foreground"
        >
          <div className="overflow-y-auto overscroll-contain px-1 pb-1">{children(close)}</div>
        </div>
      )}
    </span>
  );
}
