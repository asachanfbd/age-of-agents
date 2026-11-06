import { useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { zoomOffset } from '../../lib/pointerOrigin';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ACCENT_FILL } from '../../lib/accent';
import type { Accent } from '../../lib/accent';

/** A dialog filled with a stage colour. It opens by growing out of the clicked card (a plain zoom when opened from the keyboard) and stays open until `onClose`; `label` names it for screen readers. */
export function StageModal({ accent, label, onClose, className, children }: { accent: Accent; label: string; onClose: () => void; className?: string; children: ReactNode }) {
  const [offset] = useState(() => zoomOffset({ width: window.innerWidth, height: window.innerHeight }));
  const style = offset ? ({ '--zoom-dx': `${offset.dx}px`, '--zoom-dy': `${offset.dy}px` } as CSSProperties) : undefined;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-label={label} style={style} className={cn('stage-modal-zoom max-h-[85vh] max-w-xl gap-4 overflow-y-auto transition-colors duration-300', ACCENT_FILL[accent], className)}>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The modal's head: a muted top line, a large title and a subtitle. */
export function StageModalHeading({ topLine, title, description }: { topLine?: ReactNode; title: ReactNode; description?: ReactNode }) {
  return (
    <div className="grid gap-1">
      {topLine && <span className="text-sm opacity-75">{topLine}</span>}
      <DialogTitle className="text-2xl font-semibold leading-tight">{title}</DialogTitle>
      {description && <DialogDescription className="text-current opacity-80">{description}</DialogDescription>}
    </div>
  );
}

/** A translucent inner panel of label/value stats. */
export function StatPanel({ stats }: { stats: ReadonlyArray<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="m-0 grid gap-3 rounded-2xl bg-current/15 p-4" style={{ gridTemplateColumns: `repeat(${Math.max(1, stats.length)}, minmax(0, 1fr))` }}>
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0"><dt className="text-xs opacity-75">{stat.label}</dt><dd className="m-0 truncate font-semibold tabular-nums">{stat.value}</dd></div>
      ))}
    </dl>
  );
}

/** The modal's pill buttons: an outline pill (secondary) or a solid light pill (the main action). */
export function ModalButton({ solid = false, className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { solid?: boolean }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-control px-5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        solid ? 'bg-card text-card-foreground hover:bg-card/90' : 'border border-current/50 bg-transparent hover:bg-current/15',
        className,
      )}
      {...props}
    />
  );
}
