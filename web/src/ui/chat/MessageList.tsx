import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useStickToBottom } from './useStickToBottom';

/**
 * The scrollable conversation region — replaces `.chat-thread`/`.chat-thread--full`. Deliberately a
 * plain `overflow-y-auto` div rather than shadcn's Radix-based `ScrollArea`: that component wraps
 * content in its own viewport element, which would require re-deriving the scrollTop/scrollHeight
 * math `useStickToBottom` depends on. `active` gates the auto-stick listener (pass `false` until
 * there's actually a task/thread loaded).
 */
export function MessageList({ active, className, children }: { active: boolean; className?: string; children: ReactNode }) {
  const { containerRef } = useStickToBottom(active);
  return (
    <div
      ref={containerRef}
      role="log"
      aria-label="Task conversation"
      className={cn('flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4', className)}
    >
      {children}
    </div>
  );
}
