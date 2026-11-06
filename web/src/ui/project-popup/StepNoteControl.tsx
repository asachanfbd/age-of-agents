import { useState } from 'react';
import { StickyNote } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { serverApi } from '../../lib/serverApi';
import {
  canSaveStepNote, stepNoteButtonLabel, stepNoteCounter, stepNoteHint, stepNoteSavedLabel, stepNoteTiming, stepNoteWarning,
} from '../../lib/stepNote';
import type { StepRunStatus } from '../../lib/serverApi';

/**
 * A step's note: a button that opens a small text area. The note is appended to the end of the step's
 * input when it starts; for a step that has already started or finished, the warning says it only
 * takes effect on the next round.
 */
export function StepNoteControl({ planItemId, stepId, latestStatus, saved, onSaved }: {
  planItemId: string;
  stepId: string;
  latestStatus: StepRunStatus | undefined;
  saved: string | undefined;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timing = stepNoteTiming(latestStatus);
  const warning = stepNoteWarning(timing);
  const hint = stepNoteHint(timing);
  const counter = stepNoteCounter(draft);

  const openEditor = () => { setDraft(saved ?? ''); setError(null); setOpen(true); };
  const save = async () => {
    setSaving(true); setError(null);
    try {
      await serverApi.setStepNote(planItemId, stepId, draft.trim());
      onSaved();
      setOpen(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="shrink-0 space-y-2 border-b px-4 py-2 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={open ? () => setOpen(false) : openEditor}>
          <StickyNote aria-hidden="true" /> {stepNoteButtonLabel(Boolean(saved))}
        </Button>
        {saved && !open && <p className="text-xs text-muted-foreground">{stepNoteSavedLabel(timing)}</p>}
      </div>
      {open && (
        <div className="space-y-2">
          {warning && <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">{warning}</p>}
          <Textarea aria-label="Note for this step" rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <p className={`text-xs ${counter.tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
            {counter.label}{hint ? ` · ${hint}` : ''}
          </p>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={!canSaveStepNote(draft, saved, saving)} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft('')}>Clear</Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
