import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ChatAvatar } from './ChatAvatar';
import { formatClockTime } from './formatClockTime';

/**
 * One speaker turn — an avatar plus a labeled, timestamped bubble. Replaces the inline
 * `.chat-bubble`/`.chat-bubble--{agent|user}` markup that used to live directly in
 * `TranscriptSegmentList`. User turns right-align with a tinted bubble; agent turns left-align in
 * a plain card, matching assistant-ui's convention of not backgrounding the assistant's own prose.
 */
export function ChatBubble({
  role,
  author,
  at,
  children,
}: {
  role: 'user' | 'agent';
  author: string;
  at: string;
  children: ReactNode;
}) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex items-start gap-2.5', isUser && 'flex-row-reverse')}>
      <ChatAvatar role={role} />
      <div className={cn('flex min-w-0 max-w-[85%] flex-col gap-1', isUser && 'items-end')}>
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-medium text-foreground">{author}</span>
          <time className="text-muted-foreground" dateTime={at} title={at}>{formatClockTime(at, { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        <div
          className={cn(
            'min-w-0 rounded-2xl px-4 py-3 text-sm',
            isUser ? 'bg-primary/10' : 'border border-border bg-card',
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
