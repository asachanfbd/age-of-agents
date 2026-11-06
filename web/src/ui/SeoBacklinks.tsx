import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { serverApi } from '../lib/serverApi';
import {
  canCreateTask, DEFAULT_CONTROLS, drRangeError, extrasView, formatCell, isListView, listParams, nextDeleteState, pairView, PAGE_SIZE, PERIODS, STATUS_LABEL, summaryTiles, VIEWS,
} from '../lib/seoBacklinks';
import type { BacklinkDto, BacklinkView, Controls, DeleteState, LinkStatus } from '../lib/seoBacklinks';
import { useSeoBacklinksStore } from '../store/seoBacklinksStore';
import type { ProjectData } from '../types';
import { SeoBacklinkImport } from './SeoBacklinkImport';
import { RelatedTasks } from './SeoRelatedTasks';
import { NewTaskDialog } from './SeoTaskDialogs';
import { prefill } from '../lib/seoTasks';

const TONE = { good: 'text-success-foreground', bad: 'text-destructive', neutral: 'text-muted-foreground' } as const;
const SORTS: Array<{ key: string; label: string; numeric?: boolean }> = [
  { key: 'source', label: 'Source' }, { key: 'target', label: 'Target' }, { key: 'anchor', label: 'Anchor' }, { key: 'type', label: 'Type' }, { key: 'firstSeen', label: 'First seen' },
  { key: 'lastSeen', label: 'Last seen' }, { key: 'status', label: 'Status' }, { key: 'dr', label: 'DR', numeric: true }, { key: 'ur', label: 'UR', numeric: true }, { key: 'traffic', label: 'Traffic', numeric: true },
];
/** The Tasks panel exists, so the tracking-task shortcut is shown. */
const HAS_TASKS_PANEL = true;

function Detail({ projectId, link, controls, readOnly, onClose }: { projectId: string; link: BacklinkDto; controls: Controls; readOnly: boolean; onClose: () => void }) {
  const [note, setNote] = useState(link.note);
  const [state, setState] = useState<DeleteState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const store = useSeoBacklinksStore.getState();
  const saveNote = async () => { const res = await store.saveNote(projectId, link.uid, note); if (!res.ok) setError(res.error); };
  const remove = async () => {
    const next = nextDeleteState(state, 'confirm');
    setState(next.state);
    if (!next.deleted) return;
    const res = await store.deleteLink(projectId, link.uid, controls);
    if (!res.ok) setError(res.error); else onClose();
  };
  const status = STATUS_LABEL[link.status];
  return (
    <aside className="w-96 shrink-0 overflow-y-auto border-l bg-card p-4 text-sm" aria-label="Backlink detail">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 break-all text-sm font-semibold">{link.sourceUrl}</h4>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <dl className="mt-3 grid gap-1">
        <div><dt className="inline text-muted-foreground">Target: </dt><dd className="inline break-all">{link.targetUrl}{link.otherHost && <span className="ml-1 rounded bg-muted px-1 text-xs">Other host</span>}</dd></div>
        <div><dt className="inline text-muted-foreground">Anchor: </dt><dd className="inline">{link.anchor || '—'}</dd></div>
        <div><dt className="inline text-muted-foreground">Status: </dt><dd className={`inline ${TONE[status.tone]}`}>{status.label}{link.lostAt ? ` on ${link.lostAt}` : ''}</dd></div>
        <div><dt className="inline text-muted-foreground">Seen: </dt><dd className="inline">{link.firstSeen} to {link.lastSeen}</dd></div>
        <div><dt className="inline text-muted-foreground">Source DR / UR: </dt><dd className="inline">{pairView(link.sourceDr, link.sourceUr)}</dd></div>
        <div><dt className="inline text-muted-foreground">Page DR / UR: </dt><dd className="inline">{pairView(link.pageDr, link.pageUr)}</dd></div>
        <div><dt className="inline text-muted-foreground">Traffic (source / page): </dt><dd className="inline">{pairView(link.sourceTraffic, link.pageTraffic)}</dd></div>
        {Object.entries(link.extras).map(([k, v]) => <div key={k}><dt className="inline text-muted-foreground">{k}: </dt><dd className="inline break-all">{v}</dd></div>)}
      </dl>
      <label className="mt-4 grid gap-1 text-xs font-semibold uppercase text-muted-foreground">Note
        <textarea aria-label="Note" className="min-h-20 rounded border bg-background p-2 text-sm font-normal normal-case text-foreground" maxLength={2000} disabled={readOnly} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={readOnly || note === link.note} onClick={() => void saveNote()}>Save note</Button>
        {canCreateTask(HAS_TASKS_PANEL) && <Button size="sm" variant="outline" disabled={readOnly} onClick={() => setCreating(true)}>Create tracking task</Button>}
        {state === 'idle'
          ? <Button size="sm" variant="outline" disabled={readOnly} onClick={() => setState(nextDeleteState(state, 'delete').state)}>Delete link</Button>
          : <>
            <Button size="sm" variant="destructive" onClick={() => void remove()}>Confirm delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setState(nextDeleteState(state, 'cancel').state)}>Keep</Button>
          </>}
      </div>
      {error && <p className="mt-2 text-destructive">{error}</p>}
      <RelatedTasks projectId={projectId} type="backlink" itemRef={link.uid} draft={prefill.backlink(link)} readOnly={readOnly} />
      {creating && <NewTaskDialog projectId={projectId} initial={prefill.backlink(link)} onClose={() => setCreating(false)} onSaved={() => undefined} />}
    </aside>
  );
}

/** The Backlinks tab: summary strip, five views, filters, a sortable table and a detail panel; links come in through the CSV import wizard. */
export function SeoBacklinks({ project }: { project: ProjectData }) {
  const id = project.id;
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [importing, setImporting] = useState(false);
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useSeoBacklinksStore((s) => s.listByProject[id]);
  const overview = useSeoBacklinksStore((s) => s.overviewByProject[id]);
  const domains = useSeoBacklinksStore((s) => s.domainsByProject[id]);
  const targets = useSeoBacklinksStore((s) => s.targetsByProject[id]);
  const readOnly = project.readOnly === true;
  const rangeError = drRangeError(controls.drMin, controls.drMax);
  const set = (patch: Partial<Controls>) => setControls((c) => ({ ...c, ...patch }));

  useEffect(() => {
    if (rangeError) return;
    let current = true;
    const store = useSeoBacklinksStore.getState();
    void Promise.all([store.loadList(id, controls), store.loadOverview(id, controls.period)]).then((results) => {
      const failed = results.find((r) => !r.ok);
      if (current) setError(failed && !failed.ok ? failed.error : null);
    });
    return () => { current = false; };
  }, [id, controls, rangeError]);
  useEffect(() => { void useSeoBacklinksStore.getState().loadRollups(id); void useSeoBacklinksStore.getState().loadImports(id); }, [id]);

  const open = list?.links.find((l) => l.uid === openUid) ?? null;
  const sortBy = (key: string) => set({ sort: key, dir: controls.sort === key && controls.dir === 'desc' ? 'asc' : 'desc' });
  const empty = overview && !overview.hasImports;

  return (
    <div className="flex min-h-0 flex-1" aria-label="Backlinks">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-6">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {overview && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Backlink summary">
            {summaryTiles(overview.summary).map((t) => (
              <div key={t.label} className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{t.label}</div><div className="text-xl font-semibold tabular-nums">{t.value}</div>{t.note && <div className="text-xs text-muted-foreground">{t.note}</div>}</div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {VIEWS.map((v) => <Button key={v.key} size="sm" variant={controls.view === v.key ? 'default' : 'outline'} aria-pressed={controls.view === v.key} onClick={() => set({ view: v.key as BacklinkView })}>{v.label}</Button>)}
          <select aria-label="Period" className="h-8 rounded border bg-background px-2 text-sm" value={controls.period} onChange={(e) => set({ period: Number(e.target.value) })}>
            {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
          </select>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" asChild><a href={serverApi.seoBacklinksExportUrl(id, listParams(controls))} download>Export CSV</a></Button>
            <Button size="sm" disabled={readOnly} onClick={() => setImporting(true)}>Import CSV</Button>
          </div>
        </div>

        {isListView(controls.view) && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input aria-label="Search backlinks" className="h-8 w-56" placeholder="Search source, anchor, target" value={controls.search} onChange={(e) => set({ search: e.target.value })} />
            <select aria-label="Status" className="h-8 rounded border bg-background px-2" value={controls.status} onChange={(e) => set({ status: e.target.value as LinkStatus | '' })}>
              <option value="">Any status</option><option value="live">Live</option><option value="new">New</option><option value="lost">Lost</option>
            </select>
            <select aria-label="Link type" className="h-8 rounded border bg-background px-2" value={controls.type} onChange={(e) => set({ type: e.target.value })}>
              <option value="">Any type</option><option value="follow">Follow</option><option value="nofollow">Nofollow</option><option value="sponsored">Sponsored</option><option value="ugc">UGC</option>
            </select>
            <Input aria-label="Lowest DR" className="h-8 w-20" inputMode="decimal" placeholder="DR min" value={controls.drMin} onChange={(e) => set({ drMin: e.target.value })} />
            <Input aria-label="Highest DR" className="h-8 w-20" inputMode="decimal" placeholder="DR max" value={controls.drMax} onChange={(e) => set({ drMax: e.target.value })} />
            <Input aria-label="Domain" className="h-8 w-40" placeholder="Domain" value={controls.domain} onChange={(e) => set({ domain: e.target.value.trim() })} />
            <Input aria-label="Target page" className="h-8 w-48" placeholder="Target page URL" value={controls.target} onChange={(e) => set({ target: e.target.value.trim() })} />
            {rangeError && <span className="text-destructive">{rangeError}</span>}
          </div>
        )}

        {empty && <p className="m-0 text-sm text-muted-foreground">No backlinks yet. Import a CSV export from Ahrefs, Semrush, Moz or Search Console to start.</p>}

        {isListView(controls.view) && list && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Backlinks table">
                <thead><tr className="text-left text-muted-foreground">
                  {SORTS.map((h) => <th key={h.key} className={`px-2 py-1 ${h.numeric ? 'text-right' : ''}`}><button type="button" className="font-medium" onClick={() => sortBy(h.key)}>{h.label}{controls.sort === h.key ? (controls.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>)}
                  <th className="px-2 py-1">Extras</th>
                </tr></thead>
                <tbody>{list.links.map((l) => {
                  const status = STATUS_LABEL[l.status];
                  const extras = extrasView(l.extras);
                  return (
                    <tr key={l.uid} className={`cursor-pointer border-t hover:bg-muted/50 ${openUid === l.uid ? 'bg-muted' : ''}`} onClick={() => setOpenUid(l.uid)}>
                      <td className="max-w-64 break-all px-2 py-1.5">{l.sourceUrl}</td>
                      <td className="max-w-56 break-all px-2">{l.targetUrl}{l.otherHost && <span className="ml-1 rounded bg-muted px-1 text-xs">Other host</span>}</td>
                      <td className="px-2">{l.anchor || '—'}</td><td className="px-2">{l.linkType ?? '—'}</td><td className="px-2">{l.firstSeen}</td><td className="px-2">{l.lastSeen}</td>
                      <td className={`px-2 ${TONE[status.tone]}`}>{status.label}</td>
                      <td className="px-2 text-right tabular-nums">{formatCell(l.sourceDr)}</td><td className="px-2 text-right tabular-nums">{formatCell(l.sourceUr)}</td><td className="px-2 text-right tabular-nums">{formatCell(l.sourceTraffic)}</td>
                      <td className="px-2 text-xs text-muted-foreground" title={extras.title}>{extras.text}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Showing {list.links.length} of {list.total}</span>
              {list.links.length < list.total && <Button size="sm" variant="outline" onClick={() => void useSeoBacklinksStore.getState().loadList(id, controls, list.links.length)}>Show {Math.min(PAGE_SIZE, list.total - list.links.length)} more</Button>}
            </div>
          </>
        )}

        {controls.view === 'domains' && (
          <table className="w-full text-sm" aria-label="Referring domains">
            <thead><tr className="text-left text-muted-foreground"><th className="px-2 py-1">Domain</th><th className="px-2 text-right">Links</th><th className="px-2 text-right">Best DR</th><th className="px-2 text-right">Total traffic</th></tr></thead>
            <tbody>{(domains ?? []).map((d) => (
              <tr key={d.domain} className="cursor-pointer border-t hover:bg-muted/50" onClick={() => set({ view: 'all', domain: d.domain })}>
                <td className="px-2 py-1.5">{d.domain}</td><td className="px-2 text-right tabular-nums">{d.links}</td><td className="px-2 text-right tabular-nums">{formatCell(d.bestDr)}</td><td className="px-2 text-right tabular-nums">{formatCell(d.totalTraffic)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}

        {controls.view === 'targets' && (
          <table className="w-full text-sm" aria-label="Target pages">
            <thead><tr className="text-left text-muted-foreground"><th className="px-2 py-1">Target page</th><th className="px-2 text-right">Links</th><th className="px-2 text-right">Domains</th><th className="px-2 text-right">Best DR</th></tr></thead>
            <tbody>{(targets ?? []).map((t) => (
              <tr key={t.target} className="cursor-pointer border-t hover:bg-muted/50" onClick={() => set({ view: 'all', target: t.target })}>
                <td className="break-all px-2 py-1.5">{t.target}{t.otherHost && <span className="ml-1 rounded bg-muted px-1 text-xs">Other host</span>}</td><td className="px-2 text-right tabular-nums">{t.links}</td><td className="px-2 text-right tabular-nums">{t.domains}</td><td className="px-2 text-right tabular-nums">{formatCell(t.bestDr)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {open && isListView(controls.view) && <Detail key={open.uid} projectId={id} link={open} controls={controls} readOnly={readOnly} onClose={() => setOpenUid(null)} />}
      {importing && <SeoBacklinkImport projectId={id} controls={controls} onClose={() => setImporting(false)} />}
    </div>
  );
}
