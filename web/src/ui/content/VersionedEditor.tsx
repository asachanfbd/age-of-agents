import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { controlsDisabled, editDoc, isDirty, markConflict, openDoc, overwriteVersion, READ_ONLY_TITLE, savedDoc, shouldReloadDoc, staleVersionOf } from '../../lib/contentView';
import type { DocState } from '../../lib/contentView';
import { errorText } from '../crm/crmHooks';
import { ErrorNote } from '../crm/shared';
import { RelativeTime } from '../design/RelativeTime';

export interface DocLoaded { content: string; version: string; changedAt: string | null }

/**
 * A Markdown document an agent may also edit on disk. A save with a stale version is refused by the daemon; the
 * banner then offers Reload (take the agent's text) or Overwrite (send mine against the version now on disk).
 */
export function VersionedEditor({ label, max, readOnly, load, save, onSaved, reloadKey }: {
  label: string; max: number; readOnly: boolean; load: () => Promise<DocLoaded>; save: (text: string, version: string) => Promise<DocLoaded>; onSaved?: () => void;
  /** A change means the document was written elsewhere (a retro applied): reload it unless it has unsaved edits, which then meet the stale-version banner on save. */
  reloadKey?: number;
}) {
  const [doc, setDoc] = useState<DocState | null>(null);
  const [changedAt, setChangedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    try { const d = await load(); setDoc(openDoc(d.version, d.content)); setChangedAt(d.changedAt); setError(null); } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void open(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  useEffect(() => { if (reloadKey && shouldReloadDoc(doc)) void open(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);
  if (!doc) return <ErrorNote message={error} />;
  const disabled = controlsDisabled(readOnly);
  const send = async (version: string) => {
    try { const d = await save(doc.text, version); setDoc(savedDoc(doc, d.version)); setChangedAt(d.changedAt); setError(null); onSaved?.(); }
    catch (e) {
      const current = staleVersionOf(e);
      if (current) setDoc(markConflict(doc, current)); else setError(errorText(e));
    }
  };
  return (
    <div className="grid gap-2">
      <Textarea aria-label={label} rows={14} value={doc.text} disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} className="font-mono text-sm" onChange={(e) => setDoc(editDoc(doc, e.target.value))} />
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{[...doc.text].length} of {max.toLocaleString('en-US')} characters (max {max.toLocaleString('en-US')})</span>
        {changedAt && <span>Last changed <RelativeTime at={changedAt} /></span>}
      </div>
      {doc.conflictVersion && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 bg-warning/20 p-2.5 text-sm">
          <span>Changed by an agent since you opened it</span>
          <Button size="sm" variant="outline" onClick={() => void open()}>Reload</Button>
          <Button size="sm" onClick={() => void send(overwriteVersion(doc))}>Overwrite</Button>
        </div>
      )}
      <ErrorNote message={error} />
      <div><Button disabled={disabled || !isDirty(doc) || [...doc.text].length > max} onClick={() => void send(doc.version)}>Save</Button></div>
    </div>
  );
}
