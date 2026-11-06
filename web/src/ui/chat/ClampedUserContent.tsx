import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MarkdownDocument } from '../MarkdownDocument';

/**
 * A user turn's content, rendered as markdown and clamped to 3 lines by default. Whether it's
 * actually clamped is measured after layout (comparing the clamped box's scroll height to its
 * visible height) rather than guessed from character/line count, so the toggle only appears when
 * there's really more to show. Replaces the old `UserMessage`.
 */
export function ClampedUserContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (expanded) return; // keep showing the toggle once expanded, rather than re-measuring an unclamped box
    const el = textRef.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [content, expanded]);

  return (
    <>
      <div ref={textRef} className={expanded ? '' : 'line-clamp-3'}>
        <MarkdownDocument content={content} />
      </div>
      {overflowing && (
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  );
}
