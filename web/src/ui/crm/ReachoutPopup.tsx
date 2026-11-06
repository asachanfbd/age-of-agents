import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { crmApi } from '../../lib/crmApi';
import { itemAccent } from '../../lib/crmCalendar';
import { itemContactLabel } from '../../lib/crmBoard';
import { ModalButton, StageModal, StageModalHeading, StatPanel } from '../design/StageModal';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import { copyText, defaultPlatform, MANUAL_OPTIONS, PLATFORMS, retryNote, submitBody, submitEnabled, unknownFieldNote } from '../../lib/crmOutreach';
import type { ManualChoice } from '../../lib/crmOutreach';
import type { FollowupDto } from '../../lib/crmTypes';
import { ErrorNote } from './shared';
import { errorText } from './crmHooks';
import { RelativeTime } from '../design/RelativeTime';

/** The manual flow for a channel the app cannot send: the message, Copy, three choices and Submit (disabled until one is picked). */
export function ReachoutPopup({ projectId, item, retry, timezone, readOnly, onClose, onDone }: {
  projectId: string; item: FollowupDto; retry: { retryHours: number; retryTries: number }; timezone?: string; readOnly: boolean; onClose: () => void; onDone: () => void;
}) {
  const [message, setMessage] = useState(item.message ?? '');
  const [choice, setChoice] = useState<ManualChoice | null>(null);
  const [platform, setPlatform] = useState(defaultPlatform(item.channelType));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<string | null>(item.draft);
  const [agentError, setAgentError] = useState<string | null>(null);
  const disabled = crmControlsDisabled(readOnly);
  const unknown = unknownFieldNote(item.unknownFields);

  const copy = async () => { try { await navigator.clipboard.writeText(copyText(message)); setCopied(true); } catch { setError('Could not copy. Select the text and copy it by hand.'); } };
  const askAgent = async () => {
    setBusy(true); setAgentError(null);
    try {
      const r = await crmApi.requestDraft(projectId, item.id);
      if (r.agentError) setAgentError(r.agentError);
      else if (r.applied) setMessage(r.followup.message ?? '');
      else setDraft(r.followup.draft);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const acceptDraftText = async () => {
    setBusy(true);
    try { const f = await crmApi.acceptDraft(projectId, item.id); setMessage(f.message ?? ''); setDraft(null); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!choice) return;
    setBusy(true); setError(null);
    try {
      if (message !== (item.message ?? '') && choice !== 'stop') await crmApi.editMessage(projectId, item.id, message);
      await crmApi.submitManual(projectId, item.id, submitBody(choice, platform));
      onDone();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <StageModal accent={itemAccent({ overdue: false, state: item.state, type: item.type })} label="Pending reachout" onClose={onClose}>
      <StageModalHeading
        topLine={<>Due <RelativeTime at={item.dueAt} timeZone={timezone} /></>}
        title={<>{item.title} · {itemContactLabel(item)}</>}
        description={`Send this message yourself on ${item.channelType ?? 'the channel'} (${item.channelHandle ?? 'no handle'}), then say what happened.`}
      />
      <StatPanel stats={[{ label: 'Channel', value: item.channelType ?? item.type }, { label: 'Try', value: item.tries + 1 }, { label: 'Step', value: item.step }]} />
      <ErrorNote message={error} />
      <Textarea aria-label="Message" className="min-h-32 text-foreground" value={message} disabled={disabled} onChange={(e) => { setMessage(e.target.value); setCopied(false); }} />
      {unknown && <p className="m-0 text-sm font-medium">{unknown}</p>}
      {draft !== null && (
        <div className="grid gap-2 rounded-2xl bg-card p-3 text-sm text-card-foreground" role="status" aria-label="Agent draft">
          <p className="m-0 whitespace-pre-wrap">{draft}</p>
          <span className="flex gap-2">
            <Button variant="secondary" type="button" size="sm" disabled={disabled || busy} onClick={() => void acceptDraftText()}>Use this draft</Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => { void crmApi.discardDraft(projectId, item.id).catch(() => undefined); setDraft(null); }}>Discard</Button>
          </span>
        </div>
      )}
      {agentError && <p className="m-0 text-sm font-medium" role="alert">The agent could not draft a message: {agentError}. You can still send the message above.</p>}
      <div className="flex items-center gap-2">
        <ModalButton onClick={() => void copy()}>Copy</ModalButton>
        <ModalButton disabled={disabled || busy} title={disabledTitle(readOnly)} onClick={() => void askAgent()}>Ask an agent to draft</ModalButton>
        {copied && <span className="text-xs opacity-80" role="status">Copied</span>}
      </div>
      <fieldset className="grid gap-2 text-sm" disabled={disabled}>
        <legend className="sr-only">What happened</legend>
        {MANUAL_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-center gap-2">
            <input type="radio" name="manual-choice" value={o.value} checked={choice === o.value} onChange={() => setChoice(o.value)} />
            <span>{o.label(platform)}</span>
            {o.value === 'sent' && (
              <NativeSelect aria-label="Platform" className="ml-2 h-8 text-foreground" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
              </NativeSelect>
            )}
            {o.value === 'retry' && <span className="text-xs opacity-80">{retryNote(item.tries, retry)}</span>}
          </label>
        ))}
      </fieldset>
      <div className="flex justify-between gap-2">
        <ModalButton onClick={onClose}>Cancel</ModalButton>
        <ModalButton solid disabled={!submitEnabled(choice, busy) || disabled} title={disabledTitle(readOnly)} onClick={() => void submit()}>Submit</ModalButton>
      </div>
    </StageModal>
  );
}
