import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { diffChanged, insightsViewModel, lineDiff } from '../../lib/contentResults';
import type { DiffLine } from '../../lib/contentResults';
import type { InsightsDto, InsightsVersionDto } from '../../lib/contentTypes';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { useContentInsightsStore } from '../../store/contentInsightsStore';
import { ErrorNote } from '../crm/shared';

const TRIGGER_WORDS = { stats: 'stats changed', targets: 'targets changed', manual: 'refreshed by hand' } as const;

export function DiffView({ lines }: { lines: DiffLine[] }) {
  if (!diffChanged(lines)) return <p className="m-0 text-sm text-muted-foreground">No changes</p>;
  return (
    <pre className="m-0 max-h-72 overflow-auto rounded-lg border border-border bg-muted/40 p-2 text-xs" aria-label="Changes">
      {lines.map((l, i) => <div key={i} data-kind={l.kind} className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', l.kind === 'added' && 'bg-success/15', l.kind === 'removed' && 'bg-destructive/15')}><span aria-hidden className="mr-2 select-none">{l.mark}</span>{l.text}</div>)}
    </pre>
  );
}

/** Newest first; each version can show a diff to the one before it. */
export function InsightsHistoryList({ versions, timeZone, openId, onToggle }: { versions: InsightsVersionDto[]; timeZone: string; openId: number | null; onToggle: (id: number) => void }) {
  if (!versions.length) return <p className="m-0 text-sm text-muted-foreground">No versions yet.</p>;
  return (
    <ul className="m-0 grid list-none gap-2 p-0 text-sm" aria-label="Insights versions">
      {versions.map((v, i) => (
        <li key={v.id} className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3">
            <span>{new Date(v.at).toLocaleString('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span className="text-xs text-muted-foreground">{v.postCount} {v.postCount === 1 ? 'post' : 'posts'} · {TRIGGER_WORDS[v.trigger]}</span>
            <Button size="sm" variant="outline" aria-expanded={openId === v.id} onClick={() => onToggle(v.id)}>{openId === v.id ? 'Hide changes' : 'Show changes'}</Button>
          </div>
          {openId === v.id && <DiffView lines={lineDiff(versions[i + 1]?.markdown ?? null, v.markdown)} />}
        </li>
      ))}
    </ul>
  );
}

/** The Insights tab body: status, the owner notes on top, then the generated document (read-only). */
export function InsightsPanel({ dto, readOnly, timeZone, notes, notesDirty, conflict, error, versions, openVersion, now, onNotes, onSaveNotes, onReload, onOverwrite, onRefresh, onStop, onToggleVersion }: {
  dto: InsightsDto; readOnly: boolean; timeZone: string; notes: string; notesDirty: boolean; conflict: boolean; error: string | null; versions: InsightsVersionDto[]; openVersion: number | null; now?: number;
  onNotes: (text: string) => void; onSaveNotes: () => void; onReload: () => void; onOverwrite: () => void; onRefresh: () => void; onStop: () => void; onToggleVersion: (id: number) => void;
}) {
  const vm = insightsViewModel(dto, readOnly, timeZone, now);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm text-muted-foreground" role="status">{vm.statusText}</p>
        {vm.running
          ? <Button variant="outline" onClick={onStop}>Stop</Button>
          : <Button disabled={!vm.canRefresh} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={onRefresh}>Refresh insights</Button>}
      </div>
      {vm.failure && <p role="alert" className="m-0 rounded-lg border border-warning/50 bg-warning/20 p-2.5 text-sm">{vm.failure}. The previous document is kept.</p>}
      <ErrorNote message={error} />
      <section className="grid gap-2" aria-label="Owner notes">
        <h3 className="m-0 text-base font-semibold">Owner notes</h3>
        <p className="m-0 text-xs text-muted-foreground">Your own notes. They stay across refreshes and agents read them with the insights.</p>
        <Textarea aria-label="Owner notes" rows={5} value={notes} disabled={!vm.canEditNotes} title={readOnly ? READ_ONLY_TITLE : undefined} onChange={(e) => onNotes(e.target.value)} />
        {conflict && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 bg-warning/20 p-2.5 text-sm">
            <span>Changed since you opened it</span>
            <Button size="sm" variant="outline" onClick={onReload}>Reload</Button>
            <Button size="sm" onClick={onOverwrite}>Overwrite</Button>
          </div>
        )}
        {vm.canEditNotes && <div><Button size="sm" disabled={!notesDirty} onClick={onSaveNotes}>Save notes</Button></div>}
      </section>
      <section className="grid gap-2" aria-label="Insights document">
        <h3 className="m-0 text-base font-semibold">What works</h3>
        {vm.empty
          ? <p className="m-0 text-sm text-muted-foreground">No insights yet. They are written once published posts have stats, or when you press Refresh insights.</p>
          : <pre className="m-0 whitespace-pre-wrap rounded-lg border border-border bg-card p-3 text-sm [overflow-wrap:anywhere]" aria-label="Generated insights">{dto.markdown}</pre>}
      </section>
      <section className="grid gap-2" aria-label="Versions">
        <h3 className="m-0 text-base font-semibold">Versions</h3>
        <InsightsHistoryList versions={versions} timeZone={timeZone} openId={openVersion} onToggle={onToggleVersion} />
      </section>
    </div>
  );
}

const POLL_MS = 3_000;

/** The Insights tab. Guards its own read-only state; while a refresh runs it polls until the document is ready. */
export function InsightsTab({ projectId, readOnly, timeZone }: { projectId: string; readOnly: boolean; timeZone: string }) {
  const dto = useContentInsightsStore((s) => s.insightsByProject[projectId]);
  const versions = useContentInsightsStore((s) => s.insightsHistoryByProject[projectId]) ?? [];
  const conflict = useContentInsightsStore((s) => s.notesConflictByProject[projectId]);
  const { loadInsights, loadInsightsHistory, refreshInsights, stopInsights, saveNotes, clearNotesConflict } = useContentInsightsStore.getState();
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const state = dto?.state;
  useEffect(() => { void loadInsights(projectId).then((r) => setError(r.ok ? null : r.error)); void loadInsightsHistory(projectId); }, [projectId, loadInsights, loadInsightsHistory]);
  useEffect(() => {
    if (state !== 'running') return undefined;
    const timer = setInterval(() => { void loadInsights(projectId); }, POLL_MS);
    return () => { clearInterval(timer); void loadInsightsHistory(projectId); };
  }, [state, projectId, loadInsights, loadInsightsHistory]);
  if (!dto) return <ErrorNote message={error} />;
  const text = notes ?? dto.notes;
  const save = async (version: string) => { const r = await saveNotes(projectId, text, version); setError(r.ok ? null : r.status === 409 ? null : r.error); if (r.ok) setNotes(null); };
  return (
    <InsightsPanel
      dto={dto} readOnly={readOnly} timeZone={timeZone} notes={text} notesDirty={notes !== null && notes !== dto.notes} conflict={conflict !== undefined} error={error} versions={versions} openVersion={openVersion}
      onNotes={setNotes} onSaveNotes={() => void save(dto.notesVersion)} onReload={() => { clearNotesConflict(projectId); setNotes(null); void loadInsights(projectId); }} onOverwrite={() => void save(conflict ?? dto.notesVersion)}
      onRefresh={() => void refreshInsights(projectId).then((r) => setError(r.ok ? null : r.error))} onStop={() => void stopInsights(projectId).then((r) => setError(r.ok ? null : r.error))}
      onToggleVersion={(id) => setOpenVersion((cur) => (cur === id ? null : id))}
    />
  );
}
