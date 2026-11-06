import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  activityKindLabel, capacityTile, dateInputValue, daySummary, daySwitcher, decreaseText, formatDateTime, formatDayTitle, parseDateInput, QUOTA_WINDOWS,
  readingRows, shiftDay, WINDOW_LABEL,
} from '../../lib/agentAnalytics';
import { formatCompactDuration } from '../../lib/sessionTiming';
import type { ActivityView, AgentDayView, CurrentCapacity, QuotaWindowKey } from '../../lib/serverApi';
import { CapacityChart } from './CapacityChart';

const SERIES_COLOR: Record<QuotaWindowKey, string> = { fiveHour: 'var(--analytics-5h)', sevenDay: 'var(--analytics-7d)' };
const TABLE = 'w-full border-collapse text-xs tabular-nums [&_td]:border-b [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1 [&_th]:sticky [&_th]:top-0 [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold';

function CapacityTile({ window, current }: { window: QuotaWindowKey; current: CurrentCapacity }) {
  const tile = capacityTile(current);
  return (
    <div className="rounded-lg border border-border p-3" data-capacity-state={tile.state}>
      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{WINDOW_LABEL[window]} window</p>
      <p className={`my-1 font-semibold ${tile.meter === null ? 'text-base italic text-muted-foreground' : 'text-xl'}`}>{tile.headline}</p>
      {tile.meter !== null && (
        <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
          <i className="block h-full rounded-full" style={{ width: `${tile.meter}%`, background: SERIES_COLOR[window] }} />
        </div>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">{tile.detail}</p>
    </div>
  );
}

function Legend({ hidden, onToggle }: { hidden: Record<QuotaWindowKey, boolean>; onToggle: (window: QuotaWindowKey) => void }) {
  const swatch = 'mr-1.5 inline-block h-2.5 w-3.5 rounded-[2px] align-[-1px]';
  return (
    <div className="my-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground" aria-label="Legend">
      {QUOTA_WINDOWS.map((window) => (
        <Button key={window} type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" aria-pressed={!hidden[window]} onClick={() => onToggle(window)}>
          <i aria-hidden="true" className="inline-block w-5 border-t-2" style={{ borderColor: SERIES_COLOR[window], borderTopStyle: window === 'sevenDay' ? 'dashed' : 'solid' }} />
          {WINDOW_LABEL[window]} remaining{hidden[window] ? ' (hidden)' : ''}
        </Button>
      ))}
      {(['coding', 'planning', 'background'] as const).map((kind) => (
        <span key={kind}>
          <i aria-hidden="true" data-texture={kind === 'coding' ? 'solid' : kind === 'planning' ? 'striped' : 'dotted'} className={`analytics-band-part ${swatch}`} style={{ ['--band-color' as string]: `var(--analytics-${kind})` }} />
          {activityKindLabel(kind)}
        </span>
      ))}
      <span><i aria-hidden="true" className={`${swatch} border border-dashed border-muted-foreground`} />Waiting for a person</span>
      <span><i aria-hidden="true" className={`analytics-hatch ${swatch}`} />Gap: no trustworthy reading</span>
      <span>‹ › continues outside this day</span>
    </div>
  );
}

/** Today's capacity, the day switcher, the chart with its activity lanes, and the same values as tables. */
export function CapacityPanel({ view, onSelectDay, onOpenTarget }: { view: AgentDayView; onSelectDay: (dayStart: number) => void; onOpenTarget: (activity: ActivityView) => void }) {
  const [hidden, setHidden] = useState<Record<QuotaWindowKey, boolean>>({ fiveHour: false, sevenDay: false });
  const dayStart = view.range.from;
  const switcher = daySwitcher(dayStart, view.now, view.earliestAt);
  const rows = readingRows(view.series);
  const noReadings = QUOTA_WINDOWS.every((window) => view.series[window].points.length === 0);

  return (
    <div>
      <div className="mb-3.5 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
        {QUOTA_WINDOWS.map((window) => <CapacityTile key={window} window={window} current={view.current[window]} />)}
      </div>

      <div role="group" aria-label="Day shown" className="mb-2 flex flex-wrap items-center gap-1.5">
        <Button type="button" size="icon-sm" variant="outline" aria-label="Previous day" disabled={!switcher.canPrevious} onClick={() => onSelectDay(shiftDay(dayStart, -1))}><ChevronLeft /></Button>
        <span aria-live="polite" className="min-w-[150px] text-center text-sm font-semibold">{formatDayTitle(dayStart)}</span>
        <Button type="button" size="icon-sm" variant="outline" aria-label="Next day" disabled={!switcher.canNext} onClick={() => onSelectDay(shiftDay(dayStart, 1))}><ChevronRight /></Button>
        <label className="sr-only" htmlFor="analytics-date">Jump to date</label>
        <input
          id="analytics-date"
          type="date"
          className="h-8 rounded-md border border-border bg-card px-2 text-sm"
          value={dateInputValue(dayStart)}
          min={dateInputValue(switcher.oldestDay)}
          max={dateInputValue(switcher.today)}
          onChange={(event) => {
            const day = parseDateInput(event.target.value, switcher.oldestDay, switcher.today);
            if (day !== null) onSelectDay(day);
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={switcher.isToday} onClick={() => onSelectDay(switcher.today)}>Today</Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{daySummary(view)}</p>

      {noReadings && (
        <p className="mb-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          No readings on this day. History starts when collection began ({formatDateTime(view.earliestAt)}); earlier quota is not reconstructed.
        </p>
      )}
      <CapacityChart view={view} hidden={hidden} onOpenTarget={onOpenTarget} />
      <Legend hidden={hidden} onToggle={(window) => setHidden((current) => ({ ...current, [window]: !current[window] }))} />
      <p className="my-1.5 text-xs text-muted-foreground">
        A quota decrease is what the whole provider account lost between two readings. It is an observed estimate, never a token count, and work done in the same account outside this app can be part of it.
      </p>

      <Tabs defaultValue="readings" className="mt-3">
        <TabsList>
          <TabsTrigger value="readings">Readings</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="readings">
          <div className="max-h-[300px] overflow-auto rounded-lg border border-border">
            <table className={TABLE}>
              <caption className="sr-only">Readings, resets and gaps on {formatDayTitle(dayStart)}, in time order</caption>
              <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">5h</th><th scope="col">7d</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.kind}-${row.event}-${row.at}`}>
                    <td>{formatDateTime(row.at)}</td><td>{row.event}</td><td>{row.fiveHour}</td><td>{row.sevenDay}</td>
                  </tr>
                ))}
                {view.unattributed.map((drop) => (
                  <tr key={`unattributed-${drop.window}-${drop.from}`}>
                    <td>{formatDateTime(drop.to)}</td>
                    <td>Unattributed activity</td>
                    <td colSpan={2}>{WINDOW_LABEL[drop.window]} fell {decreaseText({ available: true, points: drop.points, from: drop.from, to: drop.to, sharedWith: 0 })} with no tracked session working</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={4} className="italic text-muted-foreground">No readings on this day.</td></tr>}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="activity">
          <div className="max-h-[300px] overflow-auto rounded-lg border border-border">
            <table className={TABLE}>
              <caption className="sr-only">Tracked activity on {formatDayTitle(dayStart)}</caption>
              <thead>
                <tr><th scope="col">Started</th><th scope="col">Ended</th><th scope="col">Project</th><th scope="col">Task</th><th scope="col">Kind</th><th scope="col">Step / round</th><th scope="col">Agent</th><th scope="col">Active</th><th scope="col">5h decrease</th><th scope="col">7d decrease</th><th scope="col"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {view.activities.map((activity) => (
                  <tr key={activity.id}>
                    <td>{formatDateTime(activity.startedAt)}</td>
                    <td>{activity.endedAt === null ? 'Still running' : `${formatDateTime(activity.endedAt)}${activity.approximate ? ' (approx.)' : ''}`}</td>
                    <td>{activity.projectName ?? 'Unknown project'}</td>
                    <td>{activity.label}</td>
                    <td>{activityKindLabel(activity.kind)}</td>
                    <td>{activity.workflow ? `${activity.workflow.stepName}${activity.workflow.round === null ? '' : ` · round ${activity.workflow.round}`}` : '—'}</td>
                    <td>{activity.agentLabel}</td>
                    <td>{formatCompactDuration(activity.activeMs, { seconds: true })}{activity.endedAt === null ? ' so far' : ''}</td>
                    <td>{decreaseText(activity.decrease.fiveHour)}</td>
                    <td>{decreaseText(activity.decrease.sevenDay)}</td>
                    <td>{activity.target && <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onOpenTarget(activity)}>Open task</Button>}</td>
                  </tr>
                ))}
                {view.activities.length === 0 && <tr><td colSpan={11} className="italic text-muted-foreground">No tracked activity on this day.</td></tr>}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
