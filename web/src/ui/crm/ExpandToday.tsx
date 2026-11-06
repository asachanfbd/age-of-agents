import { Badge } from '@/components/ui/badge';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { crmApi } from '../../lib/crmApi';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import { emptyGroups, flattenSeries, skipTo } from '../../lib/crmOutreach';
import type { CardGroupId } from '../../lib/crmOutreach';
import type { ExpandTodayDto, FollowupDto, SettingsDto } from '../../lib/crmTypes';
import { canMarkDone, isMessageType, itemAccent } from '../../lib/crmCalendar';
import { itemContactLabel } from '../../lib/crmBoard';
import type { Accent } from '../../lib/accent';
import { StageProgress } from '../design/Cards';
import { ModalButton, StageModal, StageModalHeading } from '../design/StageModal';
import { ReachoutPopup } from './ReachoutPopup';
import { ResponseForm } from './ResponseForm';
import { ErrorNote } from './shared';
import { errorText, useLoad } from './crmHooks';
import { formatExactTime } from '../../lib/sessionTiming';

const isFollowup = (card: unknown): card is FollowupDto => typeof card === 'object' && card !== null && 'contactId' in card && 'state' in card;

/** One-by-one cards: sent items with no response, overdue followups, approvals, failed retries, then today's agenda. Skip leaves an item for later. */
export function ExpandToday({ projectId, timezone, settings, readOnly, onClose, onChanged }: {
  projectId: string; timezone?: string; settings: SettingsDto | null; readOnly: boolean; onClose: () => void; onChanged: () => void;
}) {
  const series = useLoad(async () => { if (!readOnly) await crmApi.tick(projectId).catch(() => undefined); return crmApi.expandToday(projectId); }, [projectId, readOnly]);
  const [position, setPosition] = useState(0);
  const [popup, setPopup] = useState<FollowupDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disabled = crmControlsDisabled(readOnly);
  const data: ExpandTodayDto | null = series.data;
  const cards = useMemo(() => (data ? flattenSeries(data.groups as Array<{ id: CardGroupId; title: string; cards: unknown[] }>) : []), [data]);
  const empties = data ? emptyGroups(data.groups as Array<{ id: CardGroupId; title: string; emptyText: string; cards: unknown[] }>) : [];
  const current = cards[position] ?? null;

  const advance = (reload: boolean) => { if (reload) { onChanged(); series.reload(); } else { const next = skipTo(position, cards.length); setPosition(next ?? position); } };
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(null); try { await work(); advance(true); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };

  const body = () => {
    if (!current) return <p className="m-0 text-sm opacity-80">Nothing is left in today's series.</p>;
    const card = current.card;
    if (!isFollowup(card)) {
      const agenda = card as { entries?: Array<{ card: string; start?: number; end?: number; name?: string; count?: number; item?: FollowupDto; kind?: string; minutes?: number }>; freeMinutes?: number };
      return (
        <div className="grid gap-2 text-sm" aria-label="Today's agenda">
          <p className="m-0 opacity-80">{agenda.freeMinutes ?? 0} minutes of free time are allocated below.</p>
          {(agenda.entries ?? []).map((e, i) => (
            <div key={i} className="flex items-center justify-between rounded-2xl bg-current/15 p-3">
              <span>{e.card === 'fixed' ? `${e.item?.type.replace(/_/g, ' ')} · ${e.item ? itemContactLabel(e.item) : ''}` : e.card === 'slot' ? e.name : `${e.kind} session`}</span>
              <span className="text-xs opacity-80">{e.start ? formatExactTime(e.start, timezone, false) : 'no free time'}</span>
            </div>
          ))}
        </div>
      );
    }
    const item = card;
    const lostReasons = settings?.lostReasons ?? [];
    const canLog = current.group === 'sent_no_response' || current.group === 'overdue' || current.group === 'failed_retry';
    return (
      <div className="grid gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <strong>{item.title}</strong><span>· {itemContactLabel(item)}</span><Badge variant="secondary">{item.channelType ?? item.type}</Badge>
          {item.state === 'failed' && <Badge variant="soft-destructive">{item.catchUp ? 'Used all tries' : `Failed (try ${item.tries})`}</Badge>}
        </div>
        {isMessageType(item.type) && <p className="m-0 whitespace-pre-wrap rounded-2xl bg-card p-3 text-card-foreground">{item.message ?? 'No message'}</p>}
        {current.group === 'awaiting_approval' ? (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={disabled || busy} title={disabledTitle(readOnly)} onClick={() => void run(() => crmApi.approve(projectId, item.id))}>Approve and send</Button>
            <Button size="sm" variant="secondary" disabled={disabled || busy} onClick={() => void run(() => crmApi.reject(projectId, item.id))}>Reject</Button>
          </div>
        ) : current.group === 'overdue' && canMarkDone(item) ? (
          <div className="flex gap-2"><Button variant="secondary" size="sm" disabled={disabled || busy} title={disabledTitle(readOnly)} onClick={() => void run(() => crmApi.complete(projectId, item.id))}>Mark done</Button></div>
        ) : isMessageType(item.type) && (current.group === 'overdue' || current.group === 'failed_retry') && !item.integrated && item.state !== 'sent' ? (
          item.catchUp ? (
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={disabled || busy} onClick={() => void run(() => crmApi.catchUp(projectId, item.id, { action: 'keep_trying' }))}>Keep trying</Button>
              <Button size="sm" variant="secondary" disabled={disabled || busy} onClick={() => void run(() => crmApi.catchUp(projectId, item.id, { action: 'stop' }))}>Stop</Button>
            </div>
          ) : <Button variant="secondary" size="sm" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => setPopup(item)}>Open the reachout popup</Button>
        ) : null}
        {canLog && <div className="rounded-2xl bg-card p-3 text-card-foreground"><ResponseForm projectId={projectId} contactId={item.contactId} channels={item.channelId && item.channelType ? [{ id: item.channelId, type: item.channelType, label: '', handle: item.channelHandle ?? '', invalid: false, dnc: false }] : []} lostReasons={lostReasons} readOnly={readOnly} onLogged={() => advance(true)} /></div>}
      </div>
    );
  };

  const stages = data?.groups.filter((g) => g.cards.length > 0).map((g) => g.title) ?? [];
  const accent: Accent = current && isFollowup(current.card) ? itemAccent({ overdue: current.group === 'overdue', state: current.card.state, type: current.card.type }) : 'charcoal';
  return (
    <StageModal accent={accent} label="Expand Today" onClose={onClose} className="max-w-2xl">
      <StageModalHeading topLine={current ? current.progress : 'Nothing to work through'} title={current ? current.groupTitle : 'Today'} />
      {current && stages.length > 1 && <StageProgress stages={stages} current={current.groupTitle} />}
      <ErrorNote message={error ?? series.error} />
      {series.loading && !data && <p className="m-0 text-sm opacity-80">Loading today's series…</p>}
      {data && body()}
      {data && empties.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0 text-xs opacity-80" aria-label="Empty groups">
          {empties.map((g) => <li key={g.id}><strong>{g.title}:</strong> {g.text}</li>)}
        </ul>
      )}
      <div className="flex justify-between">
        <ModalButton disabled={cards.length === 0 || position + 1 >= cards.length} onClick={() => advance(false)}>Skip</ModalButton>
        <ModalButton solid onClick={onClose}>Close</ModalButton>
      </div>
      {popup && settings && <ReachoutPopup projectId={projectId} item={popup} retry={settings.cadence} timezone={timezone} readOnly={readOnly} onClose={() => setPopup(null)} onDone={() => { setPopup(null); advance(true); }} />}
    </StageModal>
  );
}
