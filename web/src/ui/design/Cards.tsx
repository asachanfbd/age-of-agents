import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ACCENT_FILL, accentVar } from '../../lib/accent';
import type { Accent } from '../../lib/accent';
import { avatarOverflow, initials } from '../../lib/people';
import { clampScore, ringDashOffset } from '../../lib/score';

/** Overlapping initials circles, bottom-right on an item card; "+N" for the rest. */
export function AvatarStack({ names, max = 3, className }: { names: readonly string[]; max?: number; className?: string }) {
  const { shown, more } = avatarOverflow(names, max);
  if (shown.length === 0 && more === 0) return null;
  return (
    <span className={cn('inline-flex items-center', className)}>
      {shown.map((name, index) => (
        <span key={`${name}-${index}`} title={name} className="-ml-2 grid size-7 place-items-center rounded-full bg-current/25 text-[11px] font-semibold ring-2 ring-[var(--fill)] first:ml-0">{initials(name)}</span>
      ))}
      {more > 0 && <span className="-ml-2 grid size-7 place-items-center rounded-full bg-current/25 text-[11px] font-semibold ring-2 ring-[var(--fill)]">+{more}</span>}
    </span>
  );
}

export interface ItemCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  accent: Accent;
  /** A small muted line above the title ("Closes Oct 22"). */
  topLine?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** The large figure or key value. */
  value?: ReactNode;
  avatars?: readonly string[];
  /** The round "…" control, top right. */
  menu?: ReactNode;
  /** Makes the title a button that opens the card; its hit area is the whole card. */
  onOpen?: () => void;
  openLabel?: string;
  lifted?: boolean;
  children?: ReactNode;
}

/** A card fully filled with its stage colour: white text on dark fills, dark text on yellow. */
export function ItemCard({ accent, topLine, title, subtitle, value, avatars, menu, onOpen, openLabel, lifted = false, children, className, style, ...rest }: ItemCardProps) {
  return (
    <div
      className={cn('relative grid grid-cols-[minmax(0,1fr)] gap-1 rounded-item p-4 transition-shadow', ACCENT_FILL[accent], lifted && 'shadow-lift', className)}
      style={{ ['--fill' as string]: accentVar(accent), ...style }}
      {...rest}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs opacity-75">{topLine}</span>
        {menu && <span className="relative z-10 -mr-1 -mt-1">{menu}</span>}
      </div>
      <div className="min-w-0">
        {onOpen
          ? <button type="button" onClick={onOpen} aria-label={openLabel} className="m-0 w-full truncate bg-transparent p-0 text-left text-base font-semibold text-current outline-none after:absolute after:inset-0 after:rounded-item focus-visible:after:ring-[3px] focus-visible:after:ring-ring">{title}</button>
          : <div className="truncate text-base font-semibold">{title}</div>}
        {subtitle && <div className="truncate text-sm opacity-75">{subtitle}</div>}
      </div>
      {value !== undefined && <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>}
      {children}
      {avatars && avatars.length > 0 && <div className="mt-1 flex justify-end"><AvatarStack names={avatars} /></div>}
    </div>
  );
}

/** A segmented progress bar with the stage labels underneath; the current stage is bold. Meant for a stage-coloured surface. */
export function StageProgress({ stages, current, className }: { stages: readonly string[]; current: string | null; className?: string }) {
  const index = current === null ? -1 : stages.indexOf(current);
  return (
    <div className={className}>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }} role="list" aria-label="Stage progress">
        {stages.map((stage, i) => (
          <i key={stage} role="listitem" aria-label={stage} aria-current={i === index ? 'step' : undefined} className={cn('h-2 rounded-full', i <= index ? 'bg-current' : 'bg-current opacity-30')} />
        ))}
      </div>
      <div className="mt-1.5 grid text-xs" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
        {stages.map((stage, i) => <span key={stage} className={cn('truncate', i === index ? 'font-bold' : 'opacity-80')}>{stage}</span>)}
      </div>
    </div>
  );
}

/** A coloured bar with its number. */
export function ScoreBar({ value, accent = 'green', label }: { value: number; accent?: Accent; label: string }) {
  const score = clampScore(value);
  return (
    <div className="flex items-center gap-2">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
        <i className="block h-full rounded-full" style={{ width: `${score}%`, background: accentVar(accent) }} />
      </div>
      <b className="text-sm tabular-nums">{score}</b>
    </div>
  );
}

const RING_RADIUS = 44;

/** An avatar inside a circular score ring. */
export function ScoreRing({ value, accent = 'green', label, children }: { value: number; accent?: Accent; label: string; children: ReactNode }) {
  const score = clampScore(value);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} className="relative grid size-24 place-items-center">
      <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={RING_RADIUS} fill="none" strokeWidth="6" className="stroke-secondary" />
        <circle cx="50" cy="50" r={RING_RADIUS} fill="none" strokeWidth="6" strokeLinecap="round" stroke={accentVar(accent)} strokeDasharray={2 * Math.PI * RING_RADIUS} strokeDashoffset={ringDashOffset(score, RING_RADIUS)} />
      </svg>
      <span className="grid size-[4.5rem] place-items-center overflow-hidden rounded-full bg-secondary text-lg font-semibold">{children}</span>
    </div>
  );
}

/** A small translucent pill for a status or action on a filled card; it takes the card's text colour. */
export function CardPill({ className, onClick, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> | (React.HTMLAttributes<HTMLSpanElement> & { onClick?: undefined })) {
  const classes = cn('relative z-10 rounded-full bg-current/20 px-2.5 py-0.5 text-[11px] font-medium', onClick && 'hover:bg-current/30 focus-visible:ring-[3px] focus-visible:ring-ring', className);
  return onClick
    ? <button type="button" className={classes} onClick={onClick} {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    : <span className={classes} {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>{children}</span>;
}
