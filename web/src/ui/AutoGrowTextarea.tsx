import * as React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { autoGrowSize, AUTO_GROW_MAX_LINES } from '../lib/autoGrowTextarea';

type AutoGrowTextareaProps = Omit<React.ComponentProps<'textarea'>, 'rows' | 'value'> & {
  value: string;
  /** Lines shown at rest; the textarea grows from here up to 5 lines, then scrolls. */
  minLines?: number;
};

function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

function fit(element: HTMLTextAreaElement, minLines: number) {
  element.style.height = 'auto';
  element.style.overflowY = 'hidden';
  const style = getComputedStyle(element);
  const fontSize = pixels(style.fontSize);
  const lineHeight = pixels(style.lineHeight) || fontSize * 1.5;
  const padding = pixels(style.paddingTop) + pixels(style.paddingBottom);
  const border = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
  const { lines, scrolls } = autoGrowSize({ contentHeight: element.scrollHeight - padding, lineHeight, minLines, maxLines: AUTO_GROW_MAX_LINES });
  element.style.height = `${lines * lineHeight + padding + border}px`;
  element.style.overflowY = scrolls ? 'auto' : 'hidden';
}

/** A textarea sized to its text: `minLines` at rest, growing to 5 lines, then scrolling inside itself. */
export const AutoGrowTextarea = React.forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  ({ value, minLines = 1, className, ...props }, forwardedRef) => {
    const ownRef = React.useRef<HTMLTextAreaElement | null>(null);
    const setRef = React.useCallback((element: HTMLTextAreaElement | null) => {
      ownRef.current = element;
      if (typeof forwardedRef === 'function') forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    }, [forwardedRef]);

    React.useLayoutEffect(() => {
      if (ownRef.current) fit(ownRef.current, minLines);
    }, [value, minLines]);

    // Wrapping changes with the width, so refit when the box is resized sideways.
    React.useEffect(() => {
      const element = ownRef.current;
      if (!element || typeof ResizeObserver === 'undefined') return;
      let width = element.clientWidth;
      const observer = new ResizeObserver(() => {
        if (element.clientWidth === width) return;
        width = element.clientWidth;
        fit(element, minLines);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }, [minLines]);

    return <Textarea ref={setRef} rows={1} value={value} className={`min-h-0 resize-none [field-sizing:fixed] ${className ?? ''}`} {...props} />;
  },
);
AutoGrowTextarea.displayName = 'AutoGrowTextarea';
