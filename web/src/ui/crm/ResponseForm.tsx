import { NativeSelect } from '@/components/ui/native-select';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { crmApi } from '../../lib/crmApi';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import { localDateTimeInputValue, RESPONSE_OPTIONS } from '../../lib/crmOutreach';
import type { ChannelDto, ContactDto, FollowupType, Outcome } from '../../lib/crmTypes';
import { ErrorNote } from './shared';
import { errorText } from './crmHooks';

const NEXT_TYPES: Array<{ value: FollowupType; label: string }> = [
  { value: 'call', label: 'Call' }, { value: 'message', label: 'Message' }, { value: 'email', label: 'Email' }, { value: 'dm', label: 'DM' },
  { value: 'online_meeting', label: 'Online meeting' }, { value: 'in_person_meeting', label: 'In-person meeting' }, { value: 'appointment', label: 'Appointment' }, { value: 'other', label: 'Other' },
];
const inOneDay = () => localDateTimeInputValue(Date.now() + 86_400_000);

/** Logs how a contact responded (also used from the Expand Today cards). A refused response changes nothing. */
export function ResponseForm({ projectId, contactId, channels, lostReasons, readOnly, onLogged }: {
  projectId: string; contactId: number; channels: ChannelDto[]; lostReasons: string[]; readOnly: boolean; onLogged: (contact: ContactDto) => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [reason, setReason] = useState(lostReasons[0] ?? '');
  const [date, setDate] = useState(inOneDay());
  const [nextType, setNextType] = useState<FollowupType>('call');
  const [channelId, setChannelId] = useState<number | null>(channels[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askLost, setAskLost] = useState(false);
  const disabled = crmControlsDisabled(readOnly);

  const body = (): Record<string, unknown> => {
    switch (outcome) {
      case 'interested': return { outcome, nextAction: { type: nextType, dueAt: new Date(date).toISOString() } };
      case 'not_interested': return { outcome, reason };
      case 'later': return { outcome, date: new Date(date).toISOString() };
      case 'wrong_number': return { outcome, channelId };
      default: return { outcome };
    }
  };
  const submit = async () => {
    if (!outcome) return;
    setBusy(true); setError(null);
    try {
      const r = await crmApi.logResponse(projectId, contactId, body());
      if (r.needsLostDecision) setAskLost(true); else onLogged(r.contact);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const moveToLost = async () => {
    setBusy(true);
    try { onLogged(await crmApi.markLost(projectId, contactId, lostReasons.includes('Other') ? 'Other' : lostReasons[0]!)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  if (askLost) {
    return (
      <div className="grid gap-2 text-sm" aria-label="No valid channel left">
        <p className="m-0">No valid channel is left for this contact. Move them to Lost?</p>
        <div className="flex gap-2">
          <Button size="sm" disabled={disabled || busy} title={disabledTitle(readOnly)} onClick={() => void moveToLost()}>Move to Lost</Button>
          <Button size="sm" variant="outline" onClick={() => { setAskLost(false); onLogged({ id: contactId } as ContactDto); }}>Keep as prospect</Button>
        </div>
        <ErrorNote message={error} />
      </div>
    );
  }
  return (
    <div className="grid gap-2 text-sm" aria-label="Log a response">
      <ErrorNote message={error} />
      <fieldset className="grid gap-1" disabled={disabled}>
        <legend className="sr-only">Response</legend>
        {RESPONSE_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-center gap-2"><input type="radio" name={`response-${contactId}`} checked={outcome === o.value} onChange={() => setOutcome(o.value)} />{o.label}</label>
        ))}
      </fieldset>
      {outcome === 'interested' && (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label="Next action"  value={nextType} onChange={(e) => setNextType(e.target.value as FollowupType)}>{NEXT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</NativeSelect>
          <Input aria-label="When" type="datetime-local" className="h-8 w-52" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      )}
      {outcome === 'not_interested' && (
        <NativeSelect aria-label="Lost reason"  value={reason} onChange={(e) => setReason(e.target.value)}>{lostReasons.map((r) => <option key={r} value={r}>{r}</option>)}</NativeSelect>
      )}
      {outcome === 'later' && <Input aria-label="Call back on" type="datetime-local" className="h-8 w-52" value={date} onChange={(e) => setDate(e.target.value)} />}
      {outcome === 'wrong_number' && (
        <NativeSelect aria-label="Which channel"  value={channelId ?? ''} onChange={(e) => setChannelId(Number(e.target.value))}>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.type}: {c.handle}</option>)}
        </NativeSelect>
      )}
      <div><Button size="sm" disabled={disabled || busy || outcome === null} title={disabledTitle(readOnly)} onClick={() => void submit()}>Log response</Button></div>
    </div>
  );
}
