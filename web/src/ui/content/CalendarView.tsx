import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '../design/Buttons';
import { monthGrid, monthOf, moreLabel, shiftMonth } from '../../lib/contentCalendar';
import type { DayCell } from '../../lib/contentCalendar';
import { formatLabel, STATUS_TONE } from '../../lib/contentView';
import { placedAt } from '../../lib/contentStats';
import { localTime } from '../../lib/contentZone';
import { cn } from '@/lib/utils';
import { useContentStore } from '../../store/contentStore';
import { ErrorNote } from '../crm/shared';
import { PlatformIcon } from './shared';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The month's weeks of day cells; a day with more than three posts ends in "+N more". */
export function MonthGrid({ weeks, timeZone, onOpen }: { weeks: DayCell[][]; timeZone: string; onOpen: (conceptId: string) => void }) {
  return (
    <div role="grid" aria-label="Month" className="grid gap-px overflow-hidden rounded-card border border-border bg-border">
      <div role="row" className="grid grid-cols-7 bg-card text-xs text-muted-foreground">{WEEKDAYS.map((d) => <div key={d} role="columnheader" className="p-1.5">{d}</div>)}</div>
      {weeks.map((week) => (
        <div role="row" key={week[0]!.day} className="grid grid-cols-7 gap-px">
          {week.map((cell) => (
            <div role="gridcell" key={cell.day} data-day={cell.day} className={cn('min-h-24 min-w-0 bg-card p-1.5', !cell.inMonth && 'opacity-50')}>
              <div className="mb-1 text-xs text-muted-foreground">{Number(cell.day.slice(8))}</div>
              <div className="grid gap-1">
                {cell.shown.map((p) => (
                  <button key={p.id} type="button" title={`${p.conceptTitle} (${formatLabel(p.format)} at ${localTime(Date.parse(placedAt(p)), timeZone)})`} onClick={() => onOpen(p.conceptId)}
                    className={cn('flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 text-left text-[11px]', STATUS_TONE[p.status])}>
                    <PlatformIcon platform={p.platform} className="size-3 shrink-0" /><span className="truncate">{p.conceptTitle}</span>
                  </button>
                ))}
                {cell.more > 0 && <span className="text-[11px] text-muted-foreground">{moreLabel(cell.more)}</span>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function CalendarView({ projectId, timeZone, version, onOpen }: { projectId: string; timeZone: string; version: number; onOpen: (conceptId: string) => void }) {
  const [month, setMonth] = useState(() => monthOf(Date.now(), timeZone));
  const view = useContentStore((s) => s.calendarByProject[projectId]);
  const loadCalendar = useContentStore((s) => s.loadCalendar);
  useEffect(() => { void loadCalendar(projectId, month); }, [projectId, month, version, loadCalendar]);
  const data = view?.month === month ? view.data : null;
  return (
    <section className="grid gap-3" aria-label="Calendar">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft /></IconButton>
        <h3 className="m-0 min-w-28 text-center text-base font-semibold">{month}</h3>
        <IconButton aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight /></IconButton>
        <Button variant="outline" size="sm" onClick={() => setMonth(monthOf(Date.now(), timeZone))}>Today</Button>
        <span className="text-xs text-muted-foreground">Days in {timeZone}</span>
      </div>
      <ErrorNote message={view?.error ?? null} />
      <MonthGrid weeks={monthGrid(month, data?.posts ?? [], timeZone)} timeZone={timeZone} onOpen={onOpen} />
    </section>
  );
}
