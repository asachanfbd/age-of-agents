import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { serverApi } from '../lib/serverApi';
import { AGENT_SLOTS, agentRequestError, draftError, draftRequest, EMPTY_DRAFT, LINK_TYPE_LABEL, parsePages, PRIORITIES, TASK_KINDS } from '../lib/seoTasks';
import type { AgentSlotKey, NewTaskDraft } from '../lib/seoTasks';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');

/** The New task form; `initial` carries a quick action's prefill. */
export function NewTaskDialog({ projectId, initial, onClose, onSaved }: { projectId: string; initial?: NewTaskDraft; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<NewTaskDraft>(initial ?? EMPTY_DRAFT);
  const [evidenceText, setEvidenceText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<NewTaskDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const addEvidence = () => { const v = evidenceText.trim(); if (v && !draft.evidence.includes(v)) set({ evidence: [...draft.evidence, v] }); setEvidenceText(''); };
  const save = async () => {
    const problem = draftError(draft);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try { await serverApi.seoCreateTask(projectId, draftRequest(draft)); onSaved(); onClose(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-label="New task">
        <DialogHeader><DialogTitle>New task</DialogTitle></DialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="grid gap-1">Title<Input aria-label="Title" value={draft.title} maxLength={500} onChange={(e) => set({ title: e.target.value })} /></label>
          <div className="grid grid-cols-3 gap-2">
            <label className="grid gap-1">Kind
              <select aria-label="Kind" className="h-9 rounded border bg-background px-2" value={draft.kind} onChange={(e) => set({ kind: e.target.value })}>{TASK_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select>
            </label>
            <label className="grid gap-1">Priority
              <select aria-label="Priority" className="h-9 rounded border bg-background px-2" value={draft.priority} onChange={(e) => set({ priority: e.target.value })}><option value="">None</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
            </label>
            <label className="grid gap-1">Due<Input aria-label="Due date" type="date" value={draft.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></label>
          </div>
          <label className="grid gap-1">Notes<textarea aria-label="Notes" className="min-h-20 rounded border bg-background p-2" maxLength={20000} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
          <div className="grid gap-1">Evidence links
            <div className="flex gap-2"><Input aria-label="Evidence link" value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} placeholder="https://" /><Button type="button" variant="outline" size="sm" onClick={addEvidence}>Add</Button></div>
            <ul className="m-0 flex flex-wrap gap-1 p-0">{draft.evidence.map((e) => <li key={e} className="list-none rounded bg-muted px-2 py-0.5 text-xs">{e} <button type="button" aria-label={`Remove ${e}`} onClick={() => set({ evidence: draft.evidence.filter((x) => x !== e) })}>×</button></li>)}</ul>
          </div>
          {draft.link && <p className="m-0 text-muted-foreground">Linked {LINK_TYPE_LABEL[draft.link.type].toLowerCase()}: <span className="break-all">{draft.link.ref}</span> <button type="button" className="underline" onClick={() => set({ link: null })}>Unlink</button></p>}
          {error && <p role="alert" className="m-0 text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>Create task</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Run agent task launcher: five slots; the page slots need 1 to 100 pages. */
export function AgentTaskDialog({ projectId, hasCrawl, onClose, onStarted }: { projectId: string; hasCrawl: boolean; onClose: () => void; onStarted: () => void }) {
  const [slot, setSlot] = useState<AgentSlotKey>('title-meta');
  const [pagesText, setPagesText] = useState('');
  const [competitors, setCompetitors] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pages = parsePages(pagesText);
  const def = AGENT_SLOTS.find((s) => s.key === slot)!;
  const blocked = agentRequestError(slot, pages, hasCrawl);
  const start = async () => {
    setBusy(true);
    try {
      await serverApi.seoStartAgentTask(projectId, { slot, ...(def.needsPages || (slot === 'audit' && pages.length) ? { pages } : {}), ...(slot === 'research' ? { competitors: parsePages(competitors) } : {}) });
      onStarted(); onClose();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-label="Run agent task">
        <DialogHeader><DialogTitle>Run agent task</DialogTitle></DialogHeader>
        <div className="grid gap-3 text-sm">
          <div role="radiogroup" aria-label="Task type" className="grid gap-1">
            {AGENT_SLOTS.map((s) => <label key={s.key} className="flex items-center gap-2"><input type="radio" name="slot" checked={slot === s.key} onChange={() => setSlot(s.key)} />{s.label}</label>)}
          </div>
          {(def.needsPages || slot === 'audit') && (
            <label className="grid gap-1">{def.needsPages ? 'Pages (one address per line)' : 'Pages (optional; default is the pages with problems)'}
              <textarea aria-label="Pages" className="min-h-24 rounded border bg-background p-2" value={pagesText} onChange={(e) => setPagesText(e.target.value)} />
              <span className="text-xs text-muted-foreground">{pages.length} of 100 pages</span>
            </label>
          )}
          {slot === 'research' && <label className="grid gap-1">Competitor domains (optional)<Input aria-label="Competitors" value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder="rival.com, other.com" /></label>}
          <p className="m-0 text-xs text-muted-foreground">The run appears on the global Tasks board with this Building's name. Proposals stop at approval; the website is never edited.</p>
          {(blocked || error) && <p role="alert" className="m-0 text-destructive">{error ?? blocked}</p>}
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || blocked !== null} onClick={() => void start()}>Start</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
