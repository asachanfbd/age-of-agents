import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatKpi, presentKpis } from '../../lib/kpi';
import type { Delta, KpiItem } from '../../lib/kpi';
import { IconButton } from './Buttons';
import { Ellipsis, ArrowUpRight } from 'lucide-react';

/** The large page title, set over two lines ("Deal / Pipeline") by passing `lines`, with the page's actions to its right. */
export function PageHeader({ lines, actions, children, size = 'lg', titleAs: Title = 'h2' }: {
  lines: readonly [string] | readonly [string, string]; actions?: ReactNode; children?: ReactNode;
  /** `md` is a single smaller line for dense popups. */
  size?: 'lg' | 'md';
  /** The element or component that renders the title, e.g. a dialog's title. */
  titleAs?: React.ElementType<{ className?: string; children?: ReactNode }>;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="grid gap-4">
        <Title className={cn('m-0 font-semibold tracking-tight', size === 'lg' ? 'text-4xl leading-[1.05]' : 'truncate text-2xl leading-tight')}>
          {lines.map((line) => <span key={line} className="block">{line}</span>)}
        </Title>
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

const DELTA_TONE: Record<Delta['tone'], 'success' | 'soft-destructive' | 'secondary'> = { positive: 'success', negative: 'soft-destructive', neutral: 'secondary' };

export function DeltaBadge({ delta }: { delta: Delta }) {
  return <Badge variant={DELTA_TONE[delta.tone]}>{delta.text}</Badge>;
}

/** One KPI: a round light-grey icon chip, a large tabular number, a small grey label and an optional delta badge. */
export function KpiStat({ icon, value, label, delta }: { icon: ReactNode; value: number | string; label: string; delta?: Delta | null }) {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground [&_svg]:size-5">{icon}</span>
      <div className="grid">
        <span className="flex items-center gap-2">
          <b className="text-3xl font-semibold leading-none tabular-nums">{typeof value === 'number' ? formatKpi(value) : value}</b>
          {delta && <DeltaBadge delta={delta} />}
        </span>
        <small className="text-sm text-muted-foreground">{label}</small>
      </div>
    </div>
  );
}

/** A row of KPIs; an item without data is left out rather than shown as 0. */
export function KpiRow({ items, icons, className }: { items: readonly KpiItem[]; icons: Record<string, ReactNode>; className?: string }) {
  const shown = presentKpis(items);
  if (shown.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-x-8 gap-y-3', className)} aria-label="Key figures">
      {shown.map((item) => <KpiStat key={item.key} icon={icons[item.key]} value={item.value as number} label={item.label} delta={item.delta} />)}
    </div>
  );
}

/** A card's title on the left; on the right an optional control (a segmented switch) and the round "…" and "↗" buttons. */
export function CardHeading({ title, control, onMore, onExpand, moreLabel = 'More options', expandLabel = 'Expand' }: { title: ReactNode; control?: ReactNode; onMore?: () => void; onExpand?: () => void; moreLabel?: string; expandLabel?: string }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="m-0 text-lg font-semibold">{title}</h3>
      <div className="flex items-center gap-2">
        {control}
        {onMore && <IconButton aria-label={moreLabel} onClick={onMore}><Ellipsis /></IconButton>}
        {onExpand && <IconButton aria-label={expandLabel} onClick={onExpand}><ArrowUpRight /></IconButton>}
      </div>
    </div>
  );
}

/** A white content card with a titled header: the building block of every tab's sections. `actions` sit on the right of the title. */
export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-card bg-card p-6 text-card-foreground shadow-soft', className)}>
      <CardHeading title={title} control={actions} />
      {children}
    </section>
  );
}
