import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { capsLine, crawlBarState, runProgress, snapshotLabel, warningText } from '../lib/seoInternalLinks';
import type { CrawlSettingsDto, OverviewDto } from '../lib/seoInternalLinks';
import { useSeoInternalLinksStore } from '../store/seoInternalLinksStore';
import type { ProjectData } from '../types';
import { SeoCompareView } from './SeoCompareView';
import { SeoCrawlLogView } from './SeoCrawlLogView';
import { SeoGraphView } from './SeoGraphView';
import { SeoMatrixView } from './SeoMatrixView';

type View = 'graph' | 'matrix' | 'compare' | 'log';
const VIEWS: Array<{ key: View; label: string }> = [{ key: 'graph', label: 'Graph' }, { key: 'matrix', label: 'Matrix' }, { key: 'compare', label: 'Compare' }, { key: 'log', label: 'Crawl log' }];
const POLL_MS = 1500;
const SETTING_FIELDS: Array<keyof CrawlSettingsDto> = ['pageCap', 'requestsPerSecond', 'timeoutSeconds', 'pageSizeMb'];

function SettingsForm({ projectId, overview, onClose }: { projectId: string; overview: OverviewDto; onClose: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(Object.fromEntries(SETTING_FIELDS.map((k) => [k, String(overview.settings[k])])));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const patch = Object.fromEntries(SETTING_FIELDS.map((k) => [k, Number(draft[k])]));
    const res = await useSeoInternalLinksStore.getState().saveSettings(projectId, patch);
    if (res.ok) onClose(); else setError(res.error);
  };
  return (
    <form className="grid gap-2 rounded-xl border bg-card p-3 text-sm" aria-label="Crawl settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {SETTING_FIELDS.map((k) => (
        <label key={k} className="flex items-center gap-2">
          <span className="w-48">{overview.ranges[k].label}</span>
          <Input aria-label={overview.ranges[k].label} className="w-28" inputMode="decimal" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          <span className="text-xs text-muted-foreground">{overview.ranges[k].min} to {overview.ranges[k].max}</span>
        </label>
      ))}
      <label className="flex items-center gap-2"><input type="checkbox" checked disabled aria-label="Respect robots.txt" /> Respect robots.txt (always on)</label>
      {error && <p className="m-0 text-destructive" role="alert">{error}</p>}
      <div className="flex gap-2"><Button type="submit" size="sm">Save</Button><Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button></div>
    </form>
  );
}

/** The Internal links tab: the crawl bar (start, progress, stop, resume, the rules in force), snapshot picker and the Graph, Matrix and Compare views. */
export function SeoInternalLinks({ project, selectedUrl, onSelectUrl, onOpenPages }: { project: ProjectData; selectedUrl: string | null; onSelectUrl: (url: string | null) => void; onOpenPages: (url: string) => void }) {
  const id = project.id;
  const overview = useSeoInternalLinksStore((s) => s.overviewByProject[id]);
  const graph = useSeoInternalLinksStore((s) => s.graphByProject[id]);
  const snapshotId = useSeoInternalLinksStore((s) => s.snapshotByProject[id]);
  const [view, setView] = useState<View>('graph');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { const res = await useSeoInternalLinksStore.getState().loadOverview(id); setError(res.ok ? null : res.error); }, [id]);
  useEffect(() => { void load(); }, [load]);
  const running = overview?.run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void useSeoInternalLinksStore.getState().pollRun(id); }, POLL_MS);
    return () => clearInterval(timer);
  }, [id, running]);

  const act = async (work: () => Promise<{ ok: boolean } & Partial<{ error: string }>>) => {
    if (busy) return;
    setBusy(true);
    const res = await work();
    setError(res.ok ? null : res.error ?? 'The request failed');
    setBusy(false);
  };

  if (!overview) return <div className="p-6 text-sm text-muted-foreground">{error ? <>{error} <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button></> : 'Loading internal links…'}</div>;
  const state = crawlBarState(overview);
  const run = overview.run;
  const store = useSeoInternalLinksStore.getState();
  const current = overview.snapshots.find((s) => s.id === snapshotId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-6" aria-label="Internal links">
      {error && <Alert><AlertDescription>{error} <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button></AlertDescription></Alert>}
      <div className="flex flex-wrap items-center gap-2" aria-label="Crawl">
        <Button size="sm" disabled={running || busy} onClick={() => void act(() => store.startCrawl(id, false))}>Crawl site</Button>
        {running && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => store.stopCrawl(id))}>Stop</Button>}
        {state === 'stopped' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => store.startCrawl(id, true))}>Resume</Button>}
        {run && (running || state === 'stopped' || state === 'failed') && <span className="text-sm" role="status">{runProgress(run)}</span>}
        {state === 'stopped' && <span className="rounded bg-warning/20 px-2 py-0.5 text-xs">Partial · stopped — the previous snapshot is kept</span>}
        {overview.snapshots.length > 0 && (
          <select aria-label="Snapshot" className="ml-auto h-9 rounded-md border bg-background px-2 text-sm" value={snapshotId ?? ''} onChange={(e) => void store.selectSnapshot(id, e.target.value)}>
            {overview.snapshots.map((s) => <option key={s.id} value={s.id}>{snapshotLabel(s)}</option>)}
          </select>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>Crawl settings</Button>
      </div>
      {state === 'failed' && run?.error && <Alert><AlertDescription>{run.error}{overview.snapshots.length > 0 ? ' The previous snapshot is kept.' : ''}</AlertDescription></Alert>}
      <p className="m-0 text-xs text-muted-foreground">{capsLine(overview.host, overview.settings)}</p>
      {editing && <SettingsForm projectId={id} overview={overview} onClose={() => setEditing(false)} />}
      {current?.seededFrom === 'home' && <Alert><AlertDescription>No sitemap was loaded, so this crawl started from the home page only. Fetch sitemaps in the Sitemaps tab and crawl again.</AlertDescription></Alert>}
      {current?.incomplete && <Alert><AlertDescription>This crawl may be incomplete: few links were found, and pages that build their links with JavaScript are not seen.</AlertDescription></Alert>}
      {current?.warning && <Alert><AlertDescription>{warningText(current.warning)} <Button size="sm" variant="outline" onClick={() => setView('log')}>Open the Crawl log</Button></AlertDescription></Alert>}
      {current?.status === 'partial' && <Alert><AlertDescription>This snapshot is partial: the crawl was {current.stopReason === 'failed' ? 'interrupted by a failure' : 'stopped'} before it finished.</AlertDescription></Alert>}
      {current?.capped && <Alert><AlertDescription>The page cap of {current.settings.pageCap.toLocaleString('en-US')} was reached; more pages exist than are shown.</AlertDescription></Alert>}
      {state === 'never' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
          <h3 className="m-0 text-base font-semibold">No crawl yet</h3>
          <p className="m-0 max-w-md text-sm text-muted-foreground">Crawl the site to see which pages link to which. The crawl starts from your sitemaps and follows links on {overview.host}.</p>
        </div>
      ) : !graph ? <p className="text-sm text-muted-foreground">Loading the graph…</p> : (
        <>
          <div className="flex gap-1" role="tablist" aria-label="Internal links views">
            {VIEWS.map((v) => <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)} className={`rounded-md px-3 py-1 text-sm ${view === v.key ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'}`}>{v.label}</button>)}
          </div>
          {view === 'graph' && <SeoGraphView projectId={id} graph={graph} selectedUrl={selectedUrl} onSelectUrl={onSelectUrl} onOpenPages={onOpenPages} />}
          {view === 'matrix' && <SeoMatrixView projectId={id} graph={graph} />}
          {view === 'log' && snapshotId && <SeoCrawlLogView key={snapshotId} projectId={id} snapshotId={snapshotId} />}
          {view === 'compare' && <SeoCompareView projectId={id} snapshots={overview.snapshots} />}
        </>
      )}
    </div>
  );
}
