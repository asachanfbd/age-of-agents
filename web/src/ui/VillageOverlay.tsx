import { useWorkspaceTotals } from '../lib/useYardModel';
import type { WorkspaceTotals } from '../lib/villageYard';

/** The totals strip's cells, in the order a task moves through the yard: pending, the work zone, the PR queue, then commands and planning. */
export const TOTALS_CELLS: { key: keyof WorkspaceTotals; label: string; dot: string }[] = [
  { key: 'pending', label: 'Pending', dot: 'yard-dot--pending' },
  { key: 'inProgress', label: 'In progress', dot: 'yard-dot--running' },
  { key: 'needsYou', label: 'Needs you', dot: 'yard-dot--needs-you' },
  { key: 'waitingToMerge', label: 'Waiting to merge', dot: 'yard-dot--merge' },
  { key: 'stopped', label: 'Stopped / failed', dot: 'yard-dot--stopped' },
  { key: 'commands', label: 'Commands', dot: 'yard-dot--command' },
  { key: 'planning', label: 'Planning', dot: 'yard-dot--planning' },
];

/**
 * The 3D village's overlay: exact workspace totals across every Project (never capped like the
 * yards are). Part of the lazy-loaded 3D view, so the cards view never
 * shows or loads it.
 */
export function VillageOverlay() {
  const totals = useWorkspaceTotals();
  return (
    <div className="pointer-events-none absolute left-6 top-24 z-10 flex flex-wrap gap-2 max-sm:left-3 max-sm:right-3" role="status" aria-label="Workspace totals">
      {TOTALS_CELLS.map((cell) => (
        <div key={cell.key} className="flex items-center gap-1.5 rounded-lg border border-border bg-background/90 px-2.5 py-1.5 text-xs shadow-sm">
          <span aria-hidden="true" className={`size-2 rounded-full ${cell.dot}`} />
          <span className="text-muted-foreground">{cell.label}</span>
          <span className="font-semibold tabular-nums text-foreground">{totals[cell.key]}</span>
        </div>
      ))}
    </div>
  );
}
