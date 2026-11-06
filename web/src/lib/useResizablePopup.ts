import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { POPUP_VIEWPORT_MARGIN, resizedPopupSize, type Size } from './popupResize';
import { createPopupSizeMemory } from './popupSizeMemory';

interface DragStart {
  pointer: { x: number; y: number };
  size: Size;
  /** The last size this drag produced; only set once the pointer actually moves. */
  latest?: Size;
}

/** Wait for the window to settle before restoring, so a live window drag doesn't re-read storage every frame. */
const VIEWPORT_RESTORE_DEBOUNCE_MS = 200;

const viewportSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

/**
 * Drag-to-resize for a centred popup. Spread `handleProps` on a grip placed directly inside the popup and
 * `style` on the popup itself. Until the grip is dragged the popup keeps its own CSS size; after that it
 * takes the dragged size, capped by CSS at `maxPopupSize`'s rule so shrinking the window keeps it inside and
 * clear of the status footer.
 *
 * With `sizeMemoryKey`, a user drag is remembered for the current window size, and the popup restores it
 * on mount and whenever the window returns to that size (falling back to its CSS size otherwise).
 */
export function useResizablePopup(sizeMemoryKey?: string) {
  const memory = useMemo(() => (sizeMemoryKey ? createPopupSizeMemory(sizeMemoryKey) : null), [sizeMemoryKey]);
  const [size, setSize] = useState<Size | null>(() => memory?.restore(viewportSize()) ?? null);
  const drag = useRef<DragStart | null>(null);

  useEffect(() => {
    if (!memory) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWindowResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setSize(memory.restore(viewportSize())), VIEWPORT_RESTORE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onWindowResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onWindowResize);
    };
  }, [memory]);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const popup = event.currentTarget.parentElement;
    if (!popup || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = popup.getBoundingClientRect();
    drag.current = { pointer: { x: event.clientX, y: event.clientY }, size: { width: rect.width, height: rect.height } };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    const delta = { x: event.clientX - start.pointer.x, y: event.clientY - start.pointer.y };
    start.latest = resizedPopupSize(start.size, delta, viewportSize());
    setSize(start.latest);
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const dragged = drag.current?.latest;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    // Only a finished user drag is saved; restores go through setSize alone and never reach here.
    if (dragged) memory?.saveUserResize(viewportSize(), dragged);
  };

  const style: CSSProperties | undefined = size ? {
    width: size.width,
    height: size.height,
    maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN}px)`,
    maxHeight: 'var(--popup-max-height)',
    overflow: 'auto',
  } : undefined;

  return { style, handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}
