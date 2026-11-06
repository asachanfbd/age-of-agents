import * as React from 'react';
import { cn } from '@/lib/utils';

/** A round icon button ("…", expand, edit, copy, mail, phone). It needs an accessible name, since it has no text. */
export const IconButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { 'aria-label': string; tone?: 'track' | 'plain' | 'glass' }>(
  ({ className, tone = 'track', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-grid size-9 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
        tone === 'track' && 'bg-secondary text-secondary-foreground hover:bg-accent',
        tone === 'plain' && 'text-muted-foreground hover:bg-accent hover:text-foreground',
        tone === 'glass' && 'bg-current/20 text-current hover:bg-current/30',
        className,
      )}
      {...props}
    />
  ),
);
IconButton.displayName = 'IconButton';
