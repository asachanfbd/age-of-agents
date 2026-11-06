import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  decreaseText, durationCell, formatDateTime, highUsageNotes, medianCell, METRIC_LABEL, onlyHighUsage, sortRounds, tokenCell,
  type RoundSortKey,
} from '../../lib/agentAnalytics';
import type { AgentStepsView, StepRoundRow } from '../../lib/serverApi';

const SORT_OPTIONS: { key: RoundSortKey; label: string }[] = [
  { key: 'startedAt', label: 'Start time' },
  { key: 'activeDuration', label: METRIC_LABEL.activeDuration },
  { key: 'tokens', label: METRIC_LABEL.tokens },
  { key: 'fiveHourDecrease', label: METRIC_LABEL.fiveHourDecrease },
  { key: 'sevenDayDecrease', label: METRIC_LABEL.sevenDayDecrease },
];
const STATUS_LABEL: Record<StepRoundRow['status'], string> = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };
const CELL = 'border-b border-border px-2.5 py-1.5 align-top';
const MEDIAN = 'block text-[11px] text-muted-foreground';

/**
 * WorkflowRun step rounds this agent ran, each beside the median of the earlier rounds of the same
 * step, Workflow and agent. Sortable by any metric and filterable to "High usage" rounds, so the
 * costly steps are easy to find.
 */
export function StepComparisonPanel({ view, onOpenTarget }: { view: AgentStepsView; onOpenTarget: (row: StepRoundRow) => void }) {
  const [sortKey, setSortKey] = useState<RoundSortKey>('startedAt');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [highOnly, setHighOnly] = useState(false);
  const rows = sortRounds(highOnly ? onlyHighUsage(view.rows) : view.rows, sortKey, direction);

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-1.5">
          Sort by
          <select className="h-8 rounded-md border border-border bg-card px-2" value={sortKey} onChange={(event) => setSortKey(event.target.value as RoundSortKey)}>
            {SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
        <Button type="button" size="sm" variant="outline" onClick={() => setDirection((current) => current === 'asc' ? 'desc' : 'asc')}>
          {direction === 'desc' ? 'Highest first' : 'Lowest first'}
        </Button>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={highOnly} onChange={(event) => setHighOnly(event.target.checked)} />
          High usage only
        </label>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        A round is compared with earlier completed rounds of the same step, in the same Workflow, on this agent. “High usage” needs five such rounds and a value at least twice their median. Tokens are exact CLI figures; quota decreases are observed account-wide estimates.
      </p>
      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-xs tabular-nums">
          <caption className="sr-only">Workflow step rounds with their active duration, tokens and observed quota decrease, each beside its median</caption>
          <thead>
            <tr className="[&_th]:sticky [&_th]:top-0 [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold">
              <th scope="col">Step round</th>
              <th scope="col">{METRIC_LABEL.activeDuration}</th>
              <th scope="col">{METRIC_LABEL.tokens}</th>
              <th scope="col">{METRIC_LABEL.fiveHourDecrease}</th>
              <th scope="col">{METRIC_LABEL.sevenDayDecrease}</th>
              <th scope="col">Marker</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tokens = tokenCell(row.tokens);
              return (
                <tr key={row.id}>
                  <th scope="row" className={`${CELL} text-left font-normal`}>
                    <span className="font-semibold">{row.stepName}</span>{row.round !== null && ` · round ${row.round}`} · {STATUS_LABEL[row.status]}
                    <span className={MEDIAN}>{row.projectName ?? 'Unknown project'} · {row.label} · {row.workflowName}</span>
                    <span className={MEDIAN}>{formatDateTime(row.startedAt)}</span>
                    {row.target && <Button type="button" size="sm" variant="outline" className="mt-1 h-6 px-2 text-xs" onClick={() => onOpenTarget(row)}>Open task</Button>}
                  </th>
                  <td className={CELL}>{durationCell(row.duration)}<span className={MEDIAN}>{medianCell('activeDuration', row.comparison.activeDuration)}</span></td>
                  <td className={CELL}>
                    <span className={row.tokens ? '' : 'italic text-muted-foreground'}>{tokens.text}</span>
                    {tokens.detail && <span className={MEDIAN}>{tokens.detail}</span>}
                    <span className={MEDIAN}>{medianCell('tokens', row.comparison.tokens)}</span>
                  </td>
                  <td className={CELL}>{decreaseText(row.decrease.fiveHour)}<span className={MEDIAN}>{medianCell('fiveHourDecrease', row.comparison.fiveHourDecrease)}</span></td>
                  <td className={CELL}>{decreaseText(row.decrease.sevenDay)}<span className={MEDIAN}>{medianCell('sevenDayDecrease', row.comparison.sevenDayDecrease)}</span></td>
                  <td className={CELL}>
                    {row.highUsage.length > 0 && <Badge variant="destructive">High usage</Badge>}
                    {highUsageNotes(row).map((note) => <span key={note} className={MEDIAN}>{note}</span>)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} className={`${CELL} italic text-muted-foreground`}>{highOnly ? 'No round is marked High usage.' : 'No workflow step rounds recorded for this agent yet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
