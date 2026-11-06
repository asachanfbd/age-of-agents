import { NativeSelect } from '@/components/ui/native-select';
import { Section } from '../design/Header';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { crmApi } from '../../lib/crmApi';
import { defaultSegmentChoice, key, suggestionTitle, undoRefusal, without } from '../../lib/crmMerge';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { ContactDto, SuggestionDto } from '../../lib/crmTypes';
import { ContactPicker } from './ContactPicker';
import { ErrorNote } from './shared';
import { errorText, useLoad } from './crmHooks';
import type { CrmTabProps } from './types';

/** Suggested duplicates (same name, and same company when both have one) and a manual merge of two contacts. */
export function MergeTab({ project, readOnly, onChanged }: CrmTabProps) {
  const suggestions = useLoad(() => crmApi.suggestions(project.id, 50, 0), [project.id]);
  const [gone, setGone] = useState<SuggestionDto[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastMerge, setLastMerge] = useState<number | null>(null);
  const [manual, setManual] = useState<{ first: ContactDto | null; second: ContactDto | null; keep: '' | 'first' | 'second' }>({ first: null, second: null, keep: '' });
  const [acceptKeep, setAcceptKeep] = useState<'' | 'first' | 'second'>('');
  const disabled = crmControlsDisabled(readOnly);

  const rows = gone.reduce((left, g) => without(left, g), suggestions.data?.rows ?? []);
  const run = async (work: () => Promise<void>) => { setError(null); setMessage(null); try { await work(); onChanged(); } catch (e) { setError(errorText(e)); } };
  const accept = (s: SuggestionDto) => run(async () => {
    const r = await crmApi.merge(project.id, { firstId: s.first.id, secondId: s.second.id, ...(acceptKeep ? { keepSegmentOf: acceptKeep } : {}) });
    setGone((g) => [...g, s]); setLastMerge(r.mergeId); setMessage(`Merged ${suggestionTitle(s)}.`);
  });
  const dismiss = (s: SuggestionDto) => run(async () => { await crmApi.dismissSuggestion(project.id, s.first.id, s.second.id); setGone((g) => [...g, s]); });
  const undo = () => run(async () => {
    if (lastMerge === null) return;
    try { await crmApi.undoMerge(project.id, lastMerge); setMessage('The merge was undone.'); setLastMerge(null); suggestions.reload(); setGone([]); }
    catch (e) { throw new Error(undoRefusal({ message: errorText(e), details: (e as { details?: Record<string, unknown> }).details })); }
  });
  const mergeManual = () => run(async () => {
    if (!manual.first || !manual.second) return;
    const [firstId, secondId] = [manual.first.id, manual.second.id];
    const r = await crmApi.merge(project.id, { firstId, secondId, ...(manual.keep ? { keepSegmentOf: manual.keep } : {}) });
    setLastMerge(r.mergeId); setMessage(`Merged contact ${secondId} into contact ${firstId}.`); setManual({ first: null, second: null, keep: '' }); suggestions.reload();
  });

  return (
    <div className="grid gap-4" aria-label="Merge">
      <ErrorNote message={error ?? suggestions.error} />
      {message && <p className="m-0 text-sm text-success-foreground" role="status">{message}</p>}
      {lastMerge !== null && <div><Button size="sm" variant="outline" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void undo()}>Undo the last merge</Button></div>}
      <Section title={`Suggested duplicates${suggestions.data ? ` (${suggestions.data.total})` : ''}`}>
        <label className="mb-2 flex items-center gap-2 text-sm">When accepting, keep the segment and stage of
          <NativeSelect aria-label="Keep segment when accepting"  value={acceptKeep} disabled={disabled} onChange={(e) => setAcceptKeep(e.target.value as '' | 'first' | 'second')}>
            <option value="">the customer (default)</option><option value="first">the first contact</option><option value="second">the second contact</option>
          </NativeSelect>
        </label>
        {rows.length === 0 && !suggestions.loading && <p className="m-0 text-sm text-muted-foreground">No duplicate names found.</p>}
        <ul className="m-0 grid list-none gap-2 p-0 text-sm">
          {rows.map((s) => (
            <li key={key(s)} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-2">
              <span>{suggestionTitle(s)}</span>
              <span className="flex gap-1">
                <Button size="sm" disabled={disabled} onClick={() => void accept(s)}>Accept</Button>
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => void dismiss(s)}>Dismiss</Button>
              </span>
            </li>
          ))}
        </ul>
        {suggestions.data?.capped && <p className="m-0 mt-2 text-xs text-muted-foreground">Showing the first suggestions only. Merge some and reload to see more.</p>}
      </Section>
      <Section title="Merge two contacts">
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <ContactPicker projectId={project.id} label="First contact (its values win)" value={manual.first} disabled={disabled} onPick={(c) => setManual({ ...manual, first: c })} />
          <ContactPicker projectId={project.id} label="Second contact" value={manual.second} disabled={disabled} onPick={(c) => setManual({ ...manual, second: c })} />
          <label className="grid gap-1">Keep the segment and stage of
            <NativeSelect aria-label="Keep segment of"  value={manual.keep} disabled={disabled} onChange={(e) => setManual({ ...manual, keep: e.target.value as '' | 'first' | 'second' })}>
              <option value="">the customer (default)</option><option value="first">the first contact</option><option value="second">the second contact</option>
            </NativeSelect>
          </label>
          <Button size="sm" disabled={disabled || !manual.first || !manual.second || manual.first.id === manual.second.id} title={disabledTitle(readOnly)} onClick={() => void mergeManual()}>Merge</Button>
        </div>
        <p className="m-0 mt-2 text-xs text-muted-foreground">Default: {defaultSegmentChoice('prospect', 'customer') === 'second' ? 'a customer beats a prospect' : ''}; an active contact beats a lost one.</p>
      </Section>
    </div>
  );
}
