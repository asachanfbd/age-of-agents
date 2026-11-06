import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { serverApi } from '../lib/serverApi';
import {
  bulkBar, cannibalisationText, capMessage, clusterRowView, clustersParams, countText, DEFAULT_KEYWORD_CONTROLS, emptyMessage, exportFileName, expandKey, importSummary, keepExpanded, keywordDrillState,
  keywordRowView, keywordsParams, nextClusterSort, runOutcome, runView, shouldLoadMore, suggestionsBanner, toggleSelected, trendBars, volumeCell, windowRange,
} from '../lib/seoKeywords';
import type { ClusterRowDto, ClusterSort, KeywordControls, KeywordFilter, KeywordRowDto } from '../lib/seoKeywords';
import { RelatedTasks } from './SeoRelatedTasks';
import { prefill } from '../lib/seoTasks';
import { useSeoKeywordsStore } from '../store/seoKeywordsStore';
import type { ProjectData } from '../types';
import { SeoKeywordResearch } from './SeoKeywordResearch';

const TONE = { good: 'text-success-foreground', bad: 'text-destructive', neutral: 'text-muted-foreground' } as const;
const RANGES = [{ days: 7, label: 'Last 7 days' }, { days: 28, label: 'Last 28 days' }, { days: 90, label: 'Last 90 days' }] as const;
const FILTERS: Array<{ key: KeywordFilter; label: string }> = [
  { key: 'all', label: 'All keywords' }, { key: 'tracking', label: 'Tracking' }, { key: 'target', label: 'Target' }, { key: 'ignored', label: 'Ignored' },
  { key: 'pinned', label: 'Placed by hand' }, { key: 'cannibalised', label: 'Cannibalised' }, { key: 'no-cluster', label: 'No cluster' },
];
const HEADERS: Array<{ key: ClusterSort; label: string; numeric: boolean }> = [
  { key: 'keywords', label: 'Keywords', numeric: true }, { key: 'clicks', label: 'Clicks', numeric: true }, { key: 'impressions', label: 'Impressions', numeric: true }, { key: 'ctr', label: 'CTR', numeric: true },
  { key: 'position', label: 'Avg. position', numeric: true }, { key: 'change', label: 'Change', numeric: true }, { key: 'pages', label: 'Pages', numeric: true }, { key: 'volume', label: 'Volume', numeric: true },
];
const ROW_HEIGHT = 40;
const VIEWPORT = 360;
const COLUMN_COUNT = 11;

const Cols = () => (
  <colgroup>
    <col className="w-16" /><col /><col className="w-20" /><col className="w-20" /><col className="w-24" /><col className="w-16" /><col className="w-20" /><col className="w-28" /><col className="w-36" /><col className="w-16" /><col className="w-36" />
  </colgroup>
);

function Change({ view }: { view: ReturnType<typeof keywordRowView>['change'] }) {
  return view ? <span className={TONE[view.tone]}>{view.text}</span> : <span className="text-muted-foreground">—</span>;
}

function KeywordRows({ rows, total, adsConnected, readOnly, selected, onToggle, onOpen, onMore, onStatus, openKey }: {
  rows: KeywordRowDto[]; total: number; adsConnected: boolean; readOnly: boolean; selected: ReadonlySet<string>; openKey: string | null;
  onToggle: (key: string) => void; onOpen: (key: string) => void; onMore: () => void; onStatus: (key: string, status: string) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const pending = useRef(false);
  const windowed = windowRange({ count: rows.length, rowHeight: ROW_HEIGHT, scrollTop, viewport: VIEWPORT, overscan: 5 });
  useEffect(() => { pending.current = false; }, [rows.length]);
  useEffect(() => {
    if (shouldLoadMore({ loaded: rows.length, total, windowEnd: windowed.end, pending: pending.current, threshold: 10 })) { pending.current = true; onMore(); }
  }, [rows.length, total, windowed.end, onMore]);
  return (
    <div className="overflow-y-auto" style={{ maxHeight: VIEWPORT }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} aria-label="Keywords in this cluster">
      <table className="w-full table-fixed text-sm">
        <Cols />
        <tbody>
          {windowed.padTop > 0 && <tr style={{ height: windowed.padTop }} aria-hidden />}
          {rows.slice(windowed.start, windowed.end).map((row) => {
            const v = keywordRowView(row, adsConnected);
            return (
              <tr key={row.key} style={{ height: ROW_HEIGHT }} className={`border-t hover:bg-muted/40 ${openKey === row.key ? 'bg-muted' : ''}`}>
                <td className="px-2"><input type="checkbox" aria-label={`Select ${row.keyword}`} disabled={readOnly} checked={selected.has(row.key)} onChange={() => onToggle(row.key)} /></td>
                <td className="truncate px-2">
                  <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onOpen(row.key)}>{v.keyword}</button>
                  {v.pinBadge && <span className="ml-1 text-xs" title="Placed by hand; a clustering run will not move it" aria-label="Placed by hand">📌</span>}
                  {v.cannibalised && <span className="ml-1 rounded bg-warning/20 px-1 text-xs" title="Several pages compete for this keyword">Cannibalised</span>}
                </td>
                <td className="px-2 text-right tabular-nums">{v.clicks}</td>
                <td className="px-2 text-right tabular-nums">{v.impressions}</td>
                <td className="px-2 text-right tabular-nums">{v.ctr}</td>
                <td className="px-2 text-right tabular-nums">{v.position}</td>
                <td className="px-2 text-right text-xs"><Change view={v.change} /></td>
                <td className="px-2 text-right">
                  <select aria-label={`Status of ${row.keyword}`} disabled={readOnly} className="h-7 rounded border bg-background px-1 text-xs" value={row.status} onChange={(e) => onStatus(row.key, e.target.value)}>
                    <option value="tracking">Tracking</option><option value="target">Target</option><option value="ignored">Ignored</option>
                  </select>
                </td>
                <td className="truncate px-2 text-xs text-muted-foreground" title={row.targetPage ?? undefined}>{v.target}</td>
                <td className="px-2 text-right tabular-nums">{v.pages}</td>
                <td className="truncate px-2 text-right text-xs" title={v.volume.title}>{v.volume.text}</td>
              </tr>
            );
          })}
          {windowed.padBottom > 0 && <tr style={{ height: windowed.padBottom }} aria-hidden />}
        </tbody>
      </table>
      {rows.length < total && <p className="m-0 p-2 text-xs text-muted-foreground">Showing {countText(rows.length)} of {countText(total)}; scroll for more.</p>}
    </div>
  );
}

function Drilldown({ project, readOnly, controls, onClose, onChanged }: { project: ProjectData; readOnly: boolean; controls: KeywordControls; onClose: () => void; onChanged: () => void }) {
  const detail = useSeoKeywordsStore((s) => s.detailByProject[project.id]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!detail) return <aside className="w-96 shrink-0 border-l p-4 text-sm text-muted-foreground" aria-label="Keyword detail">Loading…</aside>;
  const state = keywordDrillState(detail);
  const bars = trendBars(detail.trend);
  const row = keywordRowView(detail, detail.ads.connected);
  const update = async (body: { status?: string; targetPage?: string | null }) => {
    const result = await useSeoKeywordsStore.getState().updateKeyword(project.id, { key: detail.key, ...body });
    setError(result.ok ? null : result.error);
    if (result.ok) { onChanged(); void useSeoKeywordsStore.getState().loadDetail(project.id, detail.key, controls, detail.range); }
  };
  return (
    <aside className="w-96 shrink-0 overflow-y-auto border-l bg-card p-4 text-sm" aria-label="Keyword detail">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 break-all text-sm font-semibold">{detail.keyword}</h4>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <p className="m-0 mt-1 text-xs text-muted-foreground">{detail.clusterName ? `In cluster “${detail.clusterName}”${row.pinBadge ? ' (placed by hand)' : ''}` : 'Not in a cluster'} · Volume {volumeCell(detail.volume, detail.ads.connected).text}</p>
      <RelatedTasks projectId={project.id} type="keyword" itemRef={detail.key} draft={prefill.keyword(detail.key)} readOnly={project.readOnly === true} />
      {error && <Alert className="mt-2"><AlertDescription>{error}</AlertDescription></Alert>}
      {detail.cannibalisation.flagged && dismissed !== detail.key && (
        <Alert className="mt-3" role="alert">
          <AlertDescription>
            <strong>Cannibalisation.</strong> {cannibalisationText(detail.cannibalisation)}
            <button type="button" className="ml-2 underline" onClick={() => setDismissed(detail.key)}>Dismiss</button>
          </AlertDescription>
        </Alert>
      )}
      {state === 'gsc-not-connected' && <p className="text-muted-foreground">Connect Search Console to see which pages receive impressions for this keyword.</p>}
      {state === 'no-data' && <p className="text-muted-foreground">No Search Console data for this range yet.</p>}
      {state === 'no-pages' && <p className="text-muted-foreground">No page received impressions for this keyword in this range.</p>}
      <div className="mt-3 flex h-16 items-end gap-px" role="img" aria-label="Clicks per day">
        {bars.map((b) => <div key={b.day} title={`${b.day}: ${b.tone === 'gap' ? 'no data' : ''}`} className={`w-full ${b.tone === 'gap' ? 'bg-muted' : b.tone === 'current' ? 'bg-primary' : 'bg-primary/40'}`} style={{ height: `${b.height}%` }} />)}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Clicks per day. Grey bars are days with no data.{controls.compare ? ' Lighter bars are the previous period.' : ''}</p>
      <h5 className="mb-1 mt-4 text-xs font-semibold uppercase text-muted-foreground">Pages</h5>
      {state === 'ready' && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-muted-foreground"><th>Page</th><th className="text-right">Clicks</th><th className="text-right">Impr.</th><th className="text-right">Pos.</th></tr></thead>
          <tbody>
            {detail.pageList.map((p) => (
              <tr key={p.url}>
                <td className="break-all py-0.5 pr-2">{p.path}{p.isTarget && <span className="ml-1 rounded bg-primary/15 px-1">Intended target</span>}</td>
                <td className="text-right tabular-nums">{p.clicks}</td><td className="text-right tabular-nums">{p.impressions}</td><td className="text-right tabular-nums">{p.position === null ? '—' : p.position.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail.pagesTotal > detail.pageList.length && <p className="text-xs text-muted-foreground">Showing the first {detail.pageList.length} of {detail.pagesTotal} pages.</p>}
      <h5 className="mb-1 mt-4 text-xs font-semibold uppercase text-muted-foreground">Keyword</h5>
      <div className="grid gap-2">
        <label className="flex items-center gap-2">Status
          <select aria-label="Keyword status" disabled={readOnly} className="h-8 rounded-md border bg-background px-1 text-sm" value={detail.status} onChange={(e) => void update({ status: e.target.value })}>
            <option value="tracking">Tracking</option><option value="target">Target</option><option value="ignored">Ignored</option>
          </select>
        </label>
        <label className="flex items-center gap-2">Target page
          <select aria-label="Target page" disabled={readOnly} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-1 text-sm" value={detail.targetPage ?? ''} onChange={(e) => void update({ targetPage: e.target.value || null })}>
            <option value="">None</option>
            {detail.targetPage && !detail.pageList.some((p) => p.url === detail.targetPage) && <option value={detail.targetPage}>{new URL(detail.targetPage).pathname}</option>}
            {detail.pageList.map((p) => <option key={p.url} value={p.url}>{p.path}</option>)}
          </select>
        </label>
      </div>
    </aside>
  );
}

function ClusterTools({ project, readOnly, cluster, clusters, selectedKeys, onChanged }: { project: ProjectData; readOnly: boolean; cluster: ClusterRowDto; clusters: ClusterRowDto[]; selectedKeys: string[]; onChanged: () => void }) {
  const [name, setName] = useState(cluster.name);
  const [splitName, setSplitName] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: Parameters<ReturnType<typeof useSeoKeywordsStore.getState>['clusterAction']>[1]) => {
    const result = await useSeoKeywordsStore.getState().clusterAction(project.id, action);
    setError(result.ok ? null : result.error);
    if (result.ok) onChanged();
  };
  if (cluster.id === null) return null;
  if (readOnly) return <p className="m-0 border-t bg-muted/30 p-2 text-xs text-muted-foreground">This Building is read-only, so clusters cannot be changed.</p>;
  const id = cluster.id;
  return (
    <div className="flex flex-wrap items-end gap-2 border-t bg-muted/30 p-2 text-xs" aria-label={`Tools for ${cluster.name}`}>
      <Input aria-label="Cluster name" className="h-8 w-44" value={name} onChange={(e) => setName(e.target.value)} />
      <Button size="sm" variant="outline" disabled={!name.trim() || name === cluster.name} onClick={() => void run({ type: 'rename', clusterId: id, name })}>Rename</Button>
      <select aria-label="Merge into" className="h-8 rounded-md border bg-background px-1" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
        <option value="">Merge into…</option>
        {clusters.filter((c) => c.id !== null && c.id !== id).map((c) => <option key={c.id} value={c.id!}>{c.name}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={!mergeInto} onClick={() => void run({ type: 'merge', sourceIds: [id], targetId: mergeInto })}>Merge</Button>
      <Input aria-label="New cluster from selection" className="h-8 w-44" placeholder="Name for split-off cluster" value={splitName} onChange={(e) => setSplitName(e.target.value)} />
      <Button size="sm" variant="outline" disabled={!splitName.trim() || !selectedKeys.length} onClick={() => void run({ type: 'split', clusterId: id, keys: selectedKeys, name: splitName })}>Split selected</Button>
      {confirmDelete
        ? <><Button size="sm" variant="destructive" onClick={() => void run({ type: 'delete', clusterId: id })}>Confirm delete</Button><Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button></>
        : <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>Delete cluster</Button>}
      {error && <span role="alert" className="basis-full text-destructive">{error}</span>}
    </div>
  );
}

/** The Keywords tab: clusters with combined numbers, each expanding to its keywords, with drill-down, clustering, research, import and export. */
export function SeoKeywords({ project }: { project: ProjectData }) {
  const id = project.id;
  const store = useSeoKeywordsStore;
  const data = useSeoKeywordsStore((s) => s.clustersByProject[id]);
  const loadedKeywords = useSeoKeywordsStore((s) => s.keywordsByProject[id]);
  const clusterRun = useSeoKeywordsStore((s) => s.runsByProject[id]?.cluster ?? null);
  const suggestions = useSeoKeywordsStore((s) => s.suggestionsByProject[id]) ?? [];
  const [controls, setControls] = useState<KeywordControls>(DEFAULT_KEYWORD_CONTROLS);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showResearch, setShowResearch] = useState(false);
  const [adding, setAdding] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [newName, setNewName] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const rangeEnd = controls.days === 28 || controls.days === 'custom' ? null : data?.range.to ?? null;
  const view = runView(clusterRun);
  const readOnly = project.readOnly === true;
  const adsConnected = data?.ads.connected ?? false;

  const reload = useCallback(async () => {
    const state = store.getState();
    const result = await state.loadClusters(id, controls, rangeEnd, offset);
    setError(result.ok ? null : result.error);
    await Promise.all([...expanded].map((key) => state.loadClusterKeywords(id, controls, rangeEnd, key === 'unclustered' ? null : key, 0)));
    void state.loadSuggestions(id);
  }, [id, store, controls, rangeEnd, offset, expanded]);
  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);

  useEffect(() => { void store.getState().loadClusters(id, controls, rangeEnd, offset).then((r) => setError(r.ok ? null : r.error)); }, [id, store, controls, rangeEnd, offset]);
  useEffect(() => { void store.getState().loadRun(id, 'cluster'); void store.getState().loadSuggestions(id); }, [id, store]);
  const range = data?.range ?? null;
  useEffect(() => { void store.getState().loadDetail(id, openKey, controls, range); }, [id, store, openKey, controls, range]);
  useEffect(() => {
    for (const key of expanded) if (!loadedKeywords?.[key]) void store.getState().loadClusterKeywords(id, controls, rangeEnd, key === 'unclustered' ? null : key, 0);
  }, [id, store, expanded, loadedKeywords, controls, rangeEnd]);
  useEffect(() => {
    const timer = setTimeout(() => setControls((c) => (c.search === searchText ? c : { ...c, search: searchText })), 300);
    return () => clearTimeout(timer);
  }, [searchText]);
  useEffect(() => { if (data) setExpanded((e) => keepExpanded(e, data.rows)); }, [data]);
  useEffect(() => {
    if (!view?.active) return;
    const timer = setInterval(() => { void store.getState().loadRun(id, 'cluster'); }, 1500);
    return () => clearInterval(timer);
  }, [id, store, view?.active]);
  const finishedRun = clusterRun && !view?.active ? clusterRun.id : null;
  useEffect(() => { if (finishedRun) void reloadRef.current(); }, [finishedRun]);

  const update = (patch: Partial<KeywordControls>) => { setControls((c) => ({ ...c, ...patch })); setOffset(0); };
  const guard = async (work: Promise<{ ok: boolean } & Partial<{ error: string }>>) => {
    const result = await work;
    setError(result.ok ? null : result.error ?? 'The request failed');
    return result.ok;
  };
  const toggleExpand = (key: string) => setExpanded((e) => { const next = new Set(e); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const bar = bulkBar(selected);
  const clusters = useMemo(() => data?.rows ?? [], [data]);
  const searching = controls.search !== '' || controls.filter !== 'all';

  const move = async () => {
    const target = moveTo === 'unclustered' ? null : moveTo;
    if (moveTo === '' ) return;
    const ok = await guard(store.getState().moveKeywords(id, [...selected], target));
    if (ok) { setSelected(new Set()); await reload(); } else await reload();
  };
  const createAndMove = async () => {
    const created = await guard(store.getState().clusterAction(id, { type: 'create', name: newName }));
    if (!created) return;
    setNewName('');
    const state = store.getState();
    await state.loadClusters(id, controls, rangeEnd, offset);
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    let text: string;
    try { text = await file.text(); } catch { setError('That file could not be read.'); return; }
    const result = await store.getState().importCsv(id, text);
    if (result.ok) { setInfo(importSummary(result.result)); setError(null); await reload(); } else setError(result.error);
    if (fileInput.current) fileInput.current.value = '';
  };
  const addTyped = async () => {
    const lines = adding.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const result = await store.getState().addKeywords(id, lines);
    if (result.ok) { setInfo(importSummary(result.result)); setAdding(''); setError(null); await reload(); } else setError(result.error);
  };

  if (!data) return <div className="p-6 text-sm text-muted-foreground">{error ?? 'Loading keywords…'}</div>;
  const empty = emptyMessage(data, searching);
  const cap = capMessage(clusterRun);
  const suggestionText = suggestionsBanner(suggestions.length);
  const exportParams = clustersParams(controls, rangeEnd, 0);
  exportParams.delete('limit'); exportParams.delete('offset');
  const keywordExport = keywordsParams(controls, rangeEnd, '', 0);
  keywordExport.delete('limit'); keywordExport.delete('offset'); keywordExport.delete('cluster');

  return (
    <div className="flex min-h-0 flex-1" aria-label="SEO keywords">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-6">
        {readOnly && <Alert><AlertDescription>This Building is read-only{project.readOnlyReason ? `: ${project.readOnlyReason}` : ''}. You can look at keywords but not change them.</AlertDescription></Alert>}
        {error && <Alert role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {info && <Alert><AlertDescription>{info}</AlertDescription></Alert>}
        {!data.gsc.connected && <Alert><AlertDescription>Connect Search Console to see clicks, impressions, CTR and position.</AlertDescription></Alert>}
        {data.gsc.connected && data.gsc.coverage.current.state === 'partial' && <Alert><AlertDescription>Search Console has data for {data.gsc.coverage.current.covered} of {data.gsc.coverage.current.total} days in this range; totals cover only those days.</AlertDescription></Alert>}
        {data.gsc.connected && data.gsc.coverage.current.state === 'none' && <Alert><AlertDescription>Search Console has no data for this range yet.</AlertDescription></Alert>}
        {data.capped && <Alert><AlertDescription>The keyword list was cut at the safety limit.</AlertDescription></Alert>}
        {data.skippedQueries > 0 && <Alert><AlertDescription>{data.skippedQueries} Search Console {data.skippedQueries === 1 ? 'query was' : 'queries were'} left out because {data.skippedQueries === 1 ? 'it is' : 'they are'} empty or longer than 500 characters.</AlertDescription></Alert>}

        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Date range" className="h-9 rounded-md border bg-background px-2 text-sm" value={String(controls.days)} onChange={(e) => update({ days: Number(e.target.value) })}>
            {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </select>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={controls.compare} onChange={(e) => update({ compare: e.target.checked })} /> Compare to previous period</label>
          <Input aria-label="Search keywords and clusters" className="w-52" placeholder="Search keywords and clusters" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          <select aria-label="Filter" className="h-9 rounded-md border bg-background px-2 text-sm" value={controls.filter} onChange={(e) => update({ filter: e.target.value as KeywordFilter })}>
            {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <Button size="sm" disabled={readOnly || view?.active} onClick={() => void guard(store.getState().startRun(id, 'cluster'))}>Cluster keywords</Button>
          <Button size="sm" variant="outline" onClick={() => setShowResearch((v) => !v)} aria-expanded={showResearch}>Research keywords</Button>
          <Button size="sm" variant="outline" disabled={readOnly} onClick={() => fileInput.current?.click()}>Import CSV</Button>
          <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" aria-label="Import keywords from a CSV file" onChange={(e) => void importFile(e.target.files?.[0])} />
          <a className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted" href={serverApi.seoKeywordsExportUrl(id, keywordExport)} download={exportFileName(data.range)}>Export CSV</a>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">Add keywords (one per line)
            <textarea aria-label="Add keywords" className="h-9 w-64 rounded-md border bg-background p-1.5 text-sm" value={adding} onChange={(e) => setAdding(e.target.value)} />
          </label>
          <Button size="sm" variant="outline" disabled={readOnly || !adding.trim()} onClick={() => void addTyped()}>Add</Button>
          <Input aria-label="New cluster name" className="h-8 w-44" placeholder="New cluster name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button size="sm" variant="outline" disabled={readOnly || !newName.trim()} onClick={() => void createAndMove()}>Create cluster</Button>
        </div>

        {view && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm" role="status" aria-label="Clustering run">
            <span>Clustering: <strong>{view.label}</strong>{view.progress ? ` · ${view.progress}` : ''}</span>
            {view.active && <Button size="sm" variant="outline" disabled={readOnly} onClick={() => void guard(store.getState().stopRun(id, 'cluster'))}>Stop</Button>}
            {!view.active && runOutcome(clusterRun) && <span className="text-muted-foreground">{runOutcome(clusterRun)}</span>}
          </div>
        )}
        {cap && <Alert><AlertDescription>{cap}</AlertDescription></Alert>}
        {suggestionText && (
          <Alert aria-label="Suggested changes">
            <AlertDescription>
              <p className="m-0">{suggestionText}</p>
              <ul className="m-0 mt-1 list-none p-0">
                {suggestions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 py-0.5 text-sm">
                    <span><strong>{s.keyword}</strong>: {s.fromCluster ?? 'Unclustered'} → {s.toName}</span>
                    <Button size="sm" variant="outline" disabled={readOnly} onClick={() => void guard(store.getState().handleSuggestion(id, s.id, 'apply')).then(() => reload())}>Apply</Button>
                    <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => void guard(store.getState().handleSuggestion(id, s.id, 'dismiss'))}>Dismiss</Button>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {showResearch && <SeoKeywordResearch projectId={id} readOnly={readOnly} clusters={clusters} adsConnected={adsConnected} onChanged={() => void reload()} />}

        {bar.visible && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-sm" role="toolbar" aria-label="Selected keywords">
            <span>{bar.label}</span>
            <select aria-label="Move to cluster" className="h-8 rounded-md border bg-background px-1 text-sm" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="">Move to cluster…</option>
              <option value="unclustered">Unclustered</option>
              {clusters.filter((c) => c.id !== null).map((c) => <option key={c.id} value={c.id!}>{c.name}</option>)}
            </select>
            <Button size="sm" disabled={readOnly || !moveTo} onClick={() => void move()}>Move</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        <p className="m-0 text-xs text-muted-foreground">
          {data.range.from} to {data.range.to}{data.previousRange ? ` · compared with ${data.previousRange.from} to ${data.previousRange.to}` : ''} · {countText(data.totals.keywords)} keywords in {countText(data.totals.clusters)} clusters{data.totals.unclustered ? `, ${countText(data.totals.unclustered)} unclustered` : ''}
        </p>
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full table-fixed text-sm">
            <Cols />
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-2 py-2" />
                <th className="px-2 py-2" aria-sort={controls.sort === 'name' ? (controls.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => update(nextClusterSort(controls, 'name'))}>Cluster{controls.sort === 'name' ? (controls.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                </th>
                {HEADERS.slice(0, 6).map((h) => (
                  <th key={h.key} className="px-2 py-2 text-right" aria-sort={controls.sort === h.key ? (controls.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => update(nextClusterSort(controls, h.key))}>{h.label}{controls.sort === h.key ? (controls.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                  </th>
                ))}
                <th className="px-2 py-2">Best keyword</th>
                {HEADERS.slice(6).map((h) => (
                  <th key={h.key} className="px-2 py-2 text-right" aria-sort={controls.sort === h.key ? (controls.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => update(nextClusterSort(controls, h.key))}>{h.label}{controls.sort === h.key ? (controls.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                  </th>
                ))}
              </tr>
            </thead>
            {clusters.map((row) => {
              const key = expandKey(row.id);
              const open = expanded.has(key);
              const v = clusterRowView(row, adsConnected);
              const loaded = loadedKeywords?.[key];
              return (
                <tbody key={key} className="border-b last:border-0">
                  <tr className="hover:bg-muted/40" style={{ height: ROW_HEIGHT }}>
                    <td className="px-2">
                      <button type="button" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${row.name}`} onClick={() => toggleExpand(key)}>{open ? '▾' : '▸'}</button>
                    </td>
                    <td className="truncate px-2 font-medium">{v.name}{v.pinBadge && <span className="ml-1 text-xs" title="Named by hand; a clustering run will not rename it" aria-label="Named by hand">📌</span>}{row.cannibalised > 0 && <span className="ml-1 rounded bg-warning/20 px-1 text-xs font-normal">{row.cannibalised} cannibalised</span>}</td>
                    <td className="px-2 text-right tabular-nums">{v.keywords}</td>
                    <td className="px-2 text-right tabular-nums">{v.clicks}</td>
                    <td className="px-2 text-right tabular-nums">{v.impressions}</td>
                    <td className="px-2 text-right tabular-nums">{v.ctr}</td>
                    <td className="px-2 text-right tabular-nums">{v.position}</td>
                    <td className="px-2 text-right text-xs"><Change view={v.change} /></td>
                    <td className="truncate px-2 text-xs" title={v.best}>{v.best}</td>
                    <td className="px-2 text-right tabular-nums">{v.pages}</td>
                    <td className="truncate px-2 text-right text-xs" title={v.volume.title}>{v.volume.text}</td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={COLUMN_COUNT} className="p-0">
                        <ClusterTools project={project} readOnly={readOnly} cluster={row} clusters={clusters} selectedKeys={[...selected]} onChanged={() => void reload()} />
                        {!loaded && <p className="m-0 p-3 text-xs text-muted-foreground">Loading keywords…</p>}
                        {loaded && !loaded.rows.length && <p className="m-0 p-3 text-xs text-muted-foreground">No keywords in this cluster{searching ? ' match your search' : ''}.</p>}
                        {loaded && loaded.rows.length > 0 && (
                          <KeywordRows rows={loaded.rows} total={loaded.total} adsConnected={adsConnected} readOnly={readOnly} selected={selected} openKey={openKey}
                            onToggle={(k) => setSelected((s) => toggleSelected(s, k))} onOpen={setOpenKey}
                            onMore={() => void store.getState().loadClusterKeywords(id, controls, rangeEnd, row.id, loaded.rows.length)}
                            onStatus={(k, status) => void guard(store.getState().updateKeyword(id, { key: k, status })).then(() => reload())} />
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
            {!clusters.length && <tbody><tr><td className="p-4 text-center text-muted-foreground" colSpan={COLUMN_COUNT}>{empty ?? 'Nothing matches.'}</td></tr></tbody>}
          </table>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.limit))}>Previous</Button>
          <Button size="sm" variant="outline" disabled={offset + data.limit >= data.total} onClick={() => setOffset(offset + data.limit)}>Next</Button>
          <span className="text-xs text-muted-foreground">{data.total} cluster{data.total === 1 ? '' : 's'}. {data.cannibalisationRule}</span>
        </div>
      </div>
      {openKey && <Drilldown project={project} readOnly={readOnly} controls={controls} onClose={() => setOpenKey(null)} onChanged={() => void reload()} />}
    </div>
  );
}
