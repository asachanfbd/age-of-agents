import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { workLogLabel, workLogRows, workTimelineView, WORK_BADGES, WORK_LOG_EMPTY } from '../../lib/crmWork';
import type { WorkRow } from '../../lib/crmWork';
import type { AttachedBuildingDto, TimelineEntryDto } from '../../lib/crmTypes';

export function WorkBadges({ badges }: { badges: string[] }) {
  return <>{badges.map((b) => <Badge key={b} variant={b === WORK_BADGES.backfilled ? 'secondary' : 'warning'}>{b}</Badge>)}</>;
}

function WorkLogRow({ r }: { r: WorkRow }) {
  return (
    <li className="grid gap-0.5 rounded-xl bg-background p-2">
      <span className="flex flex-wrap items-center gap-1"><span className="break-words font-medium">{r.heading}</span><WorkBadges badges={r.badges} /></span>
      {r.summary && <span className="break-words text-muted-foreground">{r.summary}</span>}
      <span className="text-xs text-muted-foreground">{r.when}</span>
    </li>
  );
}

/** One attached Building's work updates. The toggle stays enabled on a read-only CRM Building: reading is always allowed. */
export function WorkLog({ building, timeZone, initiallyOpen = false }: { building: AttachedBuildingDto; timeZone?: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const rows = workLogRows(building, timeZone);
  return (
    <div className="grid gap-1 basis-full">
      <button type="button" className="w-fit rounded-control bg-transparent p-0 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{workLogLabel(building)}</button>
      {open && (rows.length === 0
        ? <p className="m-0 text-xs text-muted-foreground">{WORK_LOG_EMPTY}</p>
        : <ol className="m-0 grid list-none gap-1 p-0 text-xs">{rows.map((r) => <WorkLogRow key={r.id} r={r} />)}</ol>)}
    </div>
  );
}

/** A Building-work timeline entry: what happened, on which Building, the summary and any badges. */
export function WorkEntryBody({ entry }: { entry: TimelineEntryDto }) {
  const v = workTimelineView(entry);
  return (
    <div className="grid gap-1">
      <span className="flex flex-wrap items-center gap-1"><span className="break-words font-medium">{v.heading}</span><WorkBadges badges={v.badges} /></span>
      {v.buildingName && <span className="break-words">{v.buildingName}</span>}
      {v.summary && <span className="break-words">{v.summary}</span>}
    </div>
  );
}
