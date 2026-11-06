import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { crmApi } from '../../lib/crmApi';
import { itemContactLabel } from '../../lib/crmBoard';
import { blockActionsEnabled, blockStateLabel, canMarkDone, headingFor, isMessageType, itemAccent, itemBadges, pageDay, sessionLabel, slotActionsEnabled, slotStateLabel, toggleExpanded } from '../../lib/crmCalendar';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { CalendarItemDto, DayDto, SessionDto, SlotDto } from '../../lib/crmTypes';
import { IconButton } from '../design/Buttons';
import { CardPill, ItemCard } from '../design/Cards';
import { RelativeTime } from '../design/RelativeTime';
import { formatExactTime } from '../../lib/sessionTiming';
import { ExpandToday } from './ExpandToday';
import { MomDialog } from './MomDialog';
import { ReachoutPopup } from './ReachoutPopup';
import { ErrorNote } from './shared';
import { errorText, useLoad } from './crmHooks';
import type { CrmTabProps } from './types';

function ItemRow({ item, timezone, onOpen, onAct, onNotes, onDone, disabled }: { item: CalendarItemDto; timezone: string; onOpen: (id: number) => void; onAct: (item: CalendarItemDto) => void; onNotes: (item: CalendarItemDto) => void; onDone: (item: CalendarItemDto) => void; disabled: boolean }) {
  return (
    <ItemCard
      accent={itemAccent(item)}
      topLine={<>Due <RelativeTime at={item.dueAt} timeZone={timezone} /></>}
      title={item.title}
      openLabel={`Open ${itemContactLabel(item)}`}
      onOpen={() => onOpen(item.contactId)}
      subtitle={`${itemContactLabel(item)}${item.channelType ? ` (${item.channelType})` : ''}`}
      className="p-3"
    >
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {itemBadges(item).map((b) => <CardPill key={b}>{b}</CardPill>)}
        {isMessageType(item.type) && item.state === 'pending' && !item.integrated && <CardPill onClick={() => onAct(item)}>Pending reachout</CardPill>}
        {!isMessageType(item.type) && <CardPill onClick={() => onNotes(item)}>Notes</CardPill>}
        {canMarkDone(item) && <CardPill disabled={disabled} onClick={() => onDone(item)}>Mark done</CardPill>}
      </div>
    </ItemCard>
  );
}

function SessionRow({ session, day, timezone, readOnly, open, onToggle, onOpen, onAct, onNotes, onDone, onDecide }: {
  session: SessionDto; day: string; timezone: string; readOnly: boolean; open: boolean; onToggle: () => void;
  onOpen: (id: number) => void; onAct: (item: CalendarItemDto) => void; onNotes: (item: CalendarItemDto) => void; onDone: (item: CalendarItemDto) => void; onDecide: (day: string, key: string, body: { action: 'accept' | 'skip' | 'move'; start?: string }) => void;
}) {
  const enabled = blockActionsEnabled(readOnly, session);
  const [moveTo, setMoveTo] = useState('');
  return (
    <div className="rounded-2xl bg-muted p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" aria-expanded={open} className="text-left font-medium" onClick={onToggle}>
          {session.start ? `${formatExactTime(session.start, timezone, false)} ` : ''}{sessionLabel(session)} <span className="text-xs font-normal text-muted-foreground">{open ? 'Hide' : `Show ${session.count}`}</span>
        </button>
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={session.state === 'unplaced' ? 'warning' : session.state === 'accepted' ? 'success' : 'info'}>{blockStateLabel(session)}</Badge>
          <Button size="sm" variant="outline" disabled={!enabled.accept} title={disabledTitle(readOnly)} onClick={() => onDecide(day, session.key, { action: 'accept' })}>Accept</Button>
          <input aria-label="Move to" type="time" className="h-8 rounded-control border border-input bg-card px-3 text-xs" value={moveTo} disabled={!enabled.move} onChange={(e) => setMoveTo(e.target.value)} />
          <Button size="sm" variant="outline" disabled={!enabled.move || !moveTo} onClick={() => onDecide(day, session.key, { action: 'move', start: moveTo })}>Move</Button>
          <Button size="sm" variant="outline" disabled={!enabled.skip} onClick={() => onDecide(day, session.key, { action: 'skip' })}>Skip</Button>
        </span>
      </div>
      {open && <div className="mt-2 grid gap-1">{session.items.map((i) => <ItemRow key={i.id} item={i} timezone={timezone} onOpen={onOpen} onAct={onAct} onNotes={onNotes} onDone={onDone} disabled={crmControlsDisabled(readOnly)} />)}</div>}
    </div>
  );
}

function SlotRow({ slot, day, readOnly, onOverride }: { slot: SlotDto; day: string; readOnly: boolean; onOverride: (day: string, id: string, body: { start?: string | null; minutes?: number; skipped?: boolean }) => void }) {
  const enabled = slotActionsEnabled(readOnly);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-dashed border-input p-3 text-sm">
      <span>{slot.name} ({slot.minutes} min{slot.fixedStart ? ', fixed start' : ', anywhere in free time'})</span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge variant={slot.conflict || slot.state === 'no_room' ? 'warning' : 'secondary'}>{slotStateLabel(slot)}</Badge>
        <Button size="sm" variant="outline" disabled={!enabled} title={disabledTitle(readOnly)} onClick={() => onOverride(day, slot.id, { minutes: Math.max(5, slot.minutes - 15) })}>Shorter</Button>
        <Button size="sm" variant="outline" disabled={!enabled} onClick={() => onOverride(day, slot.id, { minutes: slot.minutes + 15 })}>Longer</Button>
        <Button size="sm" variant="outline" disabled={!enabled} onClick={() => onOverride(day, slot.id, { skipped: slot.state !== 'skipped' })}>{slot.state === 'skipped' ? 'Restore' : 'Skip today'}</Button>
      </span>
    </div>
  );
}

/** The first tab: Today, Tomorrow and Day after in three columns, paged by day. Overdue items lead Today. */
export function CalendarTab({ project, readOnly, onOpenContact, onChanged }: CrmTabProps) {
  const [from, setFrom] = useState<string | undefined>(undefined);
  const view = useLoad(async () => { if (!readOnly) await crmApi.tick(project.id).catch(() => undefined); return crmApi.calendar(project.id, from); }, [project.id, from, readOnly]);
  const settings = useLoad(() => crmApi.settings(project.id), [project.id]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [popup, setPopup] = useState<CalendarItemDto | null>(null);
  const [expand, setExpand] = useState(false);
  const [momFor, setMomFor] = useState<CalendarItemDto | null>(null);
  const [momMessage, setMomMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = crmControlsDisabled(readOnly);
  const cal = view.data;

  const act = async (work: () => Promise<unknown>) => { setError(null); try { await work(); view.reload(); onChanged(); } catch (e) { setError(errorText(e)); } };
  const markDone = (item: CalendarItemDto) => void act(() => crmApi.complete(project.id, item.id));
  const page = (delta: number) => { if (cal) setFrom(pageDay(cal.from, delta)); };

  const column = (d: DayDto) => (
    <section key={d.day} className="min-w-0 rounded-card bg-card p-4 shadow-soft" aria-label={headingFor(d.day, cal!.today)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold">{headingFor(d.day, cal!.today)} <span className="font-normal text-muted-foreground">{d.day}</span></h3>
        {d.day === cal?.today && <Button size="sm" variant="outline" onClick={() => setExpand(true)}>Expand Today</Button>}
      </div>
      {d.window && <p className="m-0 mb-2 text-xs text-muted-foreground">Working hours {formatExactTime(d.window.start, cal!.timezone, false)}-{formatExactTime(d.window.end, cal!.timezone, false)} · {d.freeMinutes} min free</p>}
      {!d.window && <p className="m-0 mb-2 text-xs text-muted-foreground">Not a working day</p>}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
        {d.overdue.map((i) => <ItemRow key={i.id} item={i} timezone={cal!.timezone} onOpen={onOpenContact} onAct={setPopup} onNotes={setMomFor} onDone={markDone} disabled={disabled} />)}
        {d.fixed.map((f) => <ItemRow key={f.item.id} item={f.item} timezone={cal!.timezone} onOpen={onOpenContact} onAct={setPopup} onNotes={setMomFor} onDone={markDone} disabled={disabled} />)}
        {d.slots.map((s) => <SlotRow key={s.id} slot={s} day={d.day} readOnly={readOnly} onOverride={(day, id, body) => void act(() => crmApi.overrideSlot(project.id, day, id, body))} />)}
        {d.sessions.map((s) => (
          <SessionRow key={s.key} session={s} day={d.day} timezone={cal!.timezone} readOnly={readOnly} open={open.has(`${d.day}:${s.key}`)}
            onToggle={() => setOpen((o) => toggleExpanded(o, `${d.day}:${s.key}`))} onOpen={onOpenContact} onAct={setPopup} onNotes={setMomFor} onDone={markDone}
            onDecide={(day, key, body) => void act(() => crmApi.decideBlock(project.id, day, key, body))} />
        ))}
        {d.moreSessions > 0 && <p className="m-0 text-xs text-muted-foreground">{d.moreSessions} more blocks are not shown.</p>}
        {d.overdue.length + d.fixed.length + d.slots.length + d.sessions.length === 0 && <p className="m-0 text-sm text-muted-foreground">Nothing fixed yet.</p>}
      </div>
    </section>
  );

  return (
    <div className="grid gap-4" aria-label="Calendar">
      <div className="flex items-center gap-2">
        <IconButton aria-label="Previous day" disabled={!cal} onClick={() => page(-1)}><ChevronLeft /></IconButton>
        <Button size="sm" variant="outline" disabled={!cal || cal.from === cal.today} onClick={() => setFrom(undefined)}>Today</Button>
        <IconButton aria-label="Next day" disabled={!cal} onClick={() => page(1)}><ChevronRight /></IconButton>
        {cal && <span className="text-sm text-muted-foreground">{cal.timezone}</span>}
      </div>
      <ErrorNote message={error ?? view.error} />
      {view.loading && !cal && <p className="m-0 text-sm text-muted-foreground">Loading the calendar…</p>}
      {cal && <div className="grid gap-4 min-[1100px]:grid-cols-3">{cal.days.map(column)}</div>}
      {momMessage && <p className="m-0 text-sm text-success-foreground" role="status">{momMessage}</p>}
      {momFor && <MomDialog projectId={project.id} item={momFor} contactLabel={itemContactLabel(momFor)} readOnly={readOnly} onSaved={setMomMessage} onError={setError} onClose={() => setMomFor(null)} />}
      {popup && settings.data && (
        <ReachoutPopup projectId={project.id} item={popup} retry={settings.data.cadence} timezone={settings.data.timezone} readOnly={readOnly} onClose={() => setPopup(null)} onDone={() => { setPopup(null); view.reload(); onChanged(); }} />
      )}
      {expand && <ExpandToday projectId={project.id} timezone={cal?.timezone ?? settings.data?.timezone} settings={settings.data} readOnly={disabled} onClose={() => { setExpand(false); view.reload(); }} onChanged={() => { view.reload(); onChanged(); }} />}
    </div>
  );
}
