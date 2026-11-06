import { useLayoutEffect, useRef } from 'react';

/** Grows a textarea to fit its content up to `maxPx`, re-measuring whenever `value` changes or the window resizes. */
export function useAutoResizeTextarea(value: unknown, maxPx = 240) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const resize = () => {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, maxPx)}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [value, maxPx]);
  return ref;
}
