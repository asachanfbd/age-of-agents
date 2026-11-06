import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { serverApi } from '../lib/serverApi';
import { approveSummary, effectiveMeta, effectiveTitle, filterProposal, guidance, handoffView, toggledDecision } from '../lib/seoTasks';
import type { DecisionFilter, HandoffDto, ProposalDto, ProposalRowDto } from '../lib/seoTasks';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');
const COUNT_TONE = { empty: 'text-muted-foreground', short: 'text-warning-foreground', good: 'text-success-foreground', long: 'text-destructive' } as const;

function Counter({ field, text }: { field: 'title' | 'meta'; text: string }) {
  const g = guidance(field, text);
  return <span className={`text-xs ${COUNT_TONE[g.state]}`}>{g.text}</span>;
}

function Row({ row, onDecide, onEdit }: { row: ProposalRowDto; onDecide: (d: 'accepted' | 'rejected') => void; onEdit: (title: string, meta: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(effectiveTitle(row));
  const [meta, setMeta] = useState(effectiveMeta(row));
  return (
    <li className="list-none rounded border p-3" aria-label={`Proposal for ${row.url}`}>
      <div className="flex items-start justify-between gap-2"><span className="break-all font-medium">{row.url}</span><span className="text-xs text-muted-foreground">{row.decision}</span></div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div><div className="text-xs text-muted-foreground">Current title</div><div>{row.currentTitle || '—'}</div><div className="mt-1 text-xs text-muted-foreground">Current meta</div><div>{row.currentMeta || '—'}</div></div>
        <div>
          {editing ? <>
            <Input aria-label="New title" value={title} onChange={(e) => setTitle(e.target.value)} /><Counter field="title" text={title} />
            <textarea aria-label="New meta" className="mt-1 min-h-16 w-full rounded border bg-background p-2" value={meta} onChange={(e) => setMeta(e.target.value)} /><Counter field="meta" text={meta} />
          </> : <>
            <div className="text-xs text-muted-foreground">Proposed title</div><div>{effectiveTitle(row) || '—'}</div><Counter field="title" text={effectiveTitle(row)} />
            <div className="mt-1 text-xs text-muted-foreground">Proposed meta</div><div>{effectiveMeta(row) || '—'}</div><Counter field="meta" text={effectiveMeta(row)} />
          </>}
          {row.notes && <p className="m-0 mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{row.notes}</p>}
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant={row.decision === 'accepted' ? 'default' : 'outline'} onClick={() => onDecide(toggledDecision(row.decision, 'accepted') as 'accepted')}>Accept</Button>
        {editing ? <Button size="sm" variant="outline" onClick={() => { onEdit(title, meta); setEditing(false); }}>Done</Button> : <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>}
        <Button size="sm" variant={row.decision === 'rejected' ? 'destructive' : 'outline'} onClick={() => onDecide(toggledDecision(row.decision, 'rejected') as 'rejected')}>Reject</Button>
      </div>
    </li>
  );
}

/** Current vs proposed values per page, Accept / Edit / Reject per row, then Approve for handoff. */
export function ProposalReview({ projectId, taskId, readOnly, onChanged }: { projectId: string; taskId: string; readOnly: boolean; onChanged: () => void }) {
  const [data, setData] = useState<ProposalDto | null>(null);
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const [handoff, setHandoff] = useState<HandoffDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await serverApi.seoProposal(projectId, taskId)); setError(null); } catch (e) { setError(errorText(e)); }
  }, [projectId, taskId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void serverApi.seoTask(projectId, taskId).then((t) => setHandoff(t.handoff ?? null)).catch(() => undefined); }, [projectId, taskId, data?.approved]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); await load(); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  if (!data) return <p className="text-sm text-muted-foreground">{error ?? 'Loading the proposal…'}</p>;
  const summary = approveSummary(data.summary);
  const view = handoff ? handoffView(handoff) : null;
  return (
    <section aria-label="Proposal review" className="grid gap-3 text-sm">
      {data.error && <p role="alert" className="m-0 text-destructive">{data.error}</p>}
      {data.skipped > 0 && <p className="m-0 text-xs text-muted-foreground">{data.skipped} unusable row{data.skipped === 1 ? ' was' : 's were'} left out.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'pending', 'accepted', 'rejected'] as const).map((f) => <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>{f}</Button>)}
        {!data.approved && !readOnly && <Button size="sm" variant="outline" disabled={busy || data.summary.pending === 0} onClick={() => void act(() => serverApi.seoDecideAllPending(projectId, taskId, 'accepted'))}>Accept all pending</Button>}
      </div>
      <ul className="m-0 grid gap-2 p-0">
        {filterProposal(data.rows, filter).map((row) => (
          <Row key={`${row.id}:${row.decision}:${row.editedTitle}:${row.editedMeta}`} row={row}
            onDecide={(decision) => void act(() => serverApi.seoChangeProposalRow(projectId, taskId, row.id, { decision }))}
            onEdit={(title, meta) => void act(() => serverApi.seoChangeProposalRow(projectId, taskId, row.id, { title, meta }))} />
        ))}
      </ul>
      {!data.approved && <div className="flex items-center gap-3">
        <Button disabled={busy || readOnly || summary.disabled} onClick={() => void act(async () => { await serverApi.seoApproveProposal(projectId, taskId); })}>Approve for handoff</Button>
        <span className="text-xs text-muted-foreground">{summary.text}</span>
      </div>}
      {view && (
        <div role="status" className={`rounded border p-3 ${view.tone === 'bad' ? 'border-destructive' : ''}`}>
          <strong>{view.title}</strong><p className="m-0">{view.body}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {view.retry && <Button size="sm" disabled={busy} onClick={() => void act(() => serverApi.seoRetryHandoff(projectId, taskId))}>Retry</Button>}
            {view.fallback && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => serverApi.seoManualHandoff(projectId, taskId))}>Create a manual task with CSV</Button>}
            {(data.approved || view.fallback) && <a className="text-sm underline" href={serverApi.seoProposalCsvUrl(projectId, taskId)}>Download CSV</a>}
          </div>
        </div>
      )}
      {error && <p role="alert" className="m-0 text-destructive">{error}</p>}
    </section>
  );
}
