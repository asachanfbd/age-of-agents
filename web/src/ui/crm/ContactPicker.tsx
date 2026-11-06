import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { crmApi } from '../../lib/crmApi';
import { contactLabel } from '../../lib/crmMerge';
import type { ContactDto } from '../../lib/crmTypes';
import { errorText } from './crmHooks';

/** Finds a contact by name, company or handle (server search, 8 results) and reports the chosen one. */
export function ContactPicker({ projectId, label, value, disabled, onPick }: { projectId: string; label: string; value: ContactDto | null; disabled: boolean; onPick: (c: ContactDto | null) => void }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<ContactDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const term = text.trim();
    if (!term) return;
    let current = true;
    const timer = setTimeout(() => {
      crmApi.contacts(projectId, { search: term, limit: 8 }).then((p) => { if (current) { setResults(p.rows); setError(null); } }, (e) => { if (current) setError(errorText(e)); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [text, projectId]);
  return (
    <div className="grid gap-1 text-sm">
      <span>{label}</span>
      {value ? (
        <span className="flex items-center gap-2"><strong>{contactLabel(value)}</strong><button type="button" className="text-xs underline disabled:opacity-50" disabled={disabled} onClick={() => { onPick(null); setText(''); setResults([]); }}>Change</button></span>
      ) : (
        <>
          <Input aria-label={label} className="h-8 w-64" placeholder="Search name, company or handle" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} />
          {error && <span className="text-xs text-destructive">{error}</span>}
          {text.trim() && results.length > 0 && (
            <ul className="m-0 grid list-none gap-0.5 rounded-2xl border bg-card p-1">
              {results.map((c) => <li key={c.id}><button type="button" className="w-full rounded px-1 py-0.5 text-left hover:bg-muted" onClick={() => onPick(c)}>{contactLabel(c)}</button></li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
