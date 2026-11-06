import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { internalCell } from '../lib/seoInternalLinks';
import { METRIC_COLUMNS, banners, crawlLabel, deltaView, DEFAULT_CONTROLS, drillState, indexingLabel, internalBlock, metricCell, nextSort, PAGE_SIZE, trendSeries } from '../lib/seoPages';
import type { MetricKey, PageFilter, PagesControls, PageRowDto } from '../lib/seoPages';
import { RelatedTasks } from './SeoRelatedTasks';
import { prefill } from '../lib/seoTasks';
import { useSeoStore } from '../store/seoStore';
import type { ProjectData } from '../types';

const TONE = { good: 'text-success-foreground', bad: 'text-destructive', neutral: 'text-muted-foreground' } as const;
const FILTERS: Array<{ key: PageFilter; label: string }> = [
  { key: 'all', label: 'All pages' }, { key: 'no-clicks', label: 'Impressions, no clicks' }, { key: 'no-impressions', label: 'No impressions' }, { key: 'changed', label: 'Changed most' },
];
const RANGES = [{ days: 7, label: 'Last 7 days' }, { days: 28, label: 'Last 28 days' }, { days: 90, label: 'Last 90 days' }] as const;

function Cell({ column, row, connected, compare }: { column: (typeof METRIC_COLUMNS)[number]; row: PageRowDto; connected: { gsc: boolean; ga4: boolean }; compare: boolean }) {
  const cell = metricCell(column, row.current[column.key], connected);
  const delta = compare && cell.kind === 'value' ? deltaView(column.key, row.delta[column.key]) : null;
  return (
    <td className="px-2 py-1.5 text-right tabular-nums" title={cell.kind === 'no-data' ? 'no data' : undefined}>
      <span className={cell.kind === 'value' ? '' : 'text-muted-foreground'}>{cell.text}</span>
      {delta && <div className={`text-xs ${TONE[delta.tone]}`}>{delta.text}</div>}
    </td>
  );
}

function Drilldown({ project, controls, onClose, onOpenInternalLinks }: { project: ProjectData; controls: PagesControls; onClose: () => void; onOpenInternalLinks: (url: string | null) => void }) {
  const detail = useSeoStore((s) => s.pageDetailByProject[project.id]);
  if (!detail) return <aside className="w-96 shrink-0 border-l p-4 text-sm text-muted-foreground" aria-label="Page detail">Loading…</aside>;
  const state = drillState(detail);
  const crawl = crawlLabel(detail.crawl);
  const internal = internalBlock(detail.crawl);
  const clicks = trendSeries(detail, 'clicks');
  const max = Math.max(1, ...clicks.map((p) => p.value ?? 0));
  return (
    <aside className="w-96 shrink-0 overflow-y-auto border-l bg-card p-4 text-sm" aria-label="Page detail">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 break-all text-sm font-semibold">{detail.path}</h4>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <RelatedTasks projectId={project.id} type="page" itemRef={detail.url} draft={prefill.page(detail.url)} readOnly={project.readOnly === true} />
      {state === 'gsc-not-connected' && <p className="text-muted-foreground">Connect Search Console to see this page's queries and trend.</p>}
      {state === 'no-data' && <p className="text-muted-foreground">No Search Console data for this range yet.</p>}
      {state === 'no-impressions' && <p className="text-muted-foreground">This page had no impressions in this range.</p>}
      <div className="mt-3 flex h-16 items-end gap-px" role="img" aria-label="Clicks per day">
        {clicks.map((p) => <div key={p.day} title={`${p.day}: ${p.value ?? 'no data'}`} className={`w-full ${p.value === null ? 'bg-muted' : p.period === 'current' ? 'bg-primary' : 'bg-primary/40'}`} style={{ height: `${p.value === null ? 100 : Math.max(2, (p.value / max) * 100)}%` }} />)}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Clicks per day. Grey bars are days with no data.{controls.compare ? ' Lighter bars are the previous period.' : ''}</p>
      <h5 className="mb-1 mt-4 text-xs font-semibold uppercase text-muted-foreground">Queries</h5>
      {state === 'ready' && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-muted-foreground"><th>Query</th><th className="text-right">Clicks</th><th className="text-right">Impr.</th><th className="text-right">Pos.</th></tr></thead>
          <tbody>{detail.queries.rows.map((q) => <tr key={q.query}><td className="break-all py-0.5 pr-2">{q.query}</td><td className="text-right tabular-nums">{q.clicks}</td><td className="text-right tabular-nums">{q.impressions}</td><td className="text-right tabular-nums">{q.position === null ? '—' : q.position.toFixed(1)}</td></tr>)}</tbody>
        </table>
      )}
      {detail.queries.showingFirst !== null && <p className="text-xs text-muted-foreground">Showing the first {detail.queries.showingFirst} of {detail.queries.total} queries. Google leaves out rare, anonymised queries, so these may not add up to the page total.</p>}
      <h5 className="mb-1 mt-4 text-xs font-semibold uppercase text-muted-foreground">Internal links</h5>
      {internal.kind === 'no-crawl' && (
        <div className="grid gap-2"><p className="m-0 text-muted-foreground">No crawl yet, so internal links are not known.</p><Button size="sm" variant="outline" onClick={() => onOpenInternalLinks(null)}>Go to Internal links</Button></div>
      )}
      {internal.kind === 'not-seen' && <p className="m-0 text-muted-foreground">The latest crawl did not reach this page.</p>}
      {internal.kind === 'seen' && (
        <>
          <dl className="m-0 grid gap-1">{internal.facts.map(([k, v]) => <div key={k}><dt className="inline text-muted-foreground">{k}: </dt><dd className="inline break-all">{v}</dd></div>)}</dl>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onOpenInternalLinks(detail.url)}>View in graph</Button>
            <Button size="sm" variant="outline" onClick={() => onOpenInternalLinks(detail.url)}>Show who links here</Button>
          </div>
        </>
      )}
      <h5 className="mb-1 mt-4 text-xs font-semibold uppercase text-muted-foreground">Page</h5>
      <dl className="m-0 grid gap-1">
        <div><dt className="inline text-muted-foreground">Title: </dt><dd className="inline">{crawl.title}</dd></div>
        <div><dt className="inline text-muted-foreground">Description: </dt><dd className="inline">{crawl.description}</dd></div>
        <div><dt className="inline text-muted-foreground">Sitemaps: </dt><dd className="inline">{detail.sitemaps.length ? detail.sitemaps.map((s) => new URL(s.url).pathname).join(', ') : 'Not in any sitemap'}</dd></div>
        <div><dt className="inline text-muted-foreground">Indexing: </dt><dd className="inline">{indexingLabel(detail.indexing)}</dd></div>
      </dl>
    </aside>
  );
}

/** The Pages tab: every page with its Search Console and Analytics numbers for a range, compared with the range before. */
export function SeoPages({ project, onOpenInternalLinks }: { project: ProjectData; onOpenInternalLinks: (url: string | null) => void }) {
  const id = project.id;
  const data = useSeoStore((s) => s.pagesByProject[id]);
  const [controls, setControls] = useState<PagesControls>(DEFAULT_CONTROLS);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [prefixText, setPrefixText] = useState('');

  const load = useCallback(async (next: PagesControls) => {
    const result = await useSeoStore.getState().loadPages(id, next, next.days === 28 || next.days === 'custom' ? null : useSeoStore.getState().pagesByProject[id]?.range.to ?? null);
    setError(result.ok ? null : result.error);
  }, [id]);
  useEffect(() => { void load(controls); }, [controls, load]);
  useEffect(() => { void useSeoStore.getState().loadPageDetail(id, selected, controls.compare, data?.range ?? null); }, [id, selected, controls.compare, data?.range]);
  useEffect(() => {
    const timer = setTimeout(() => setControls((c) => (c.search === searchText && c.prefix === prefixText ? c : { ...c, search: searchText, prefix: prefixText, offset: 0 })), 300);
    return () => clearTimeout(timer);
  }, [searchText, prefixText]);

  const connected = useMemo(() => ({ gsc: data?.gsc.connected ?? true, ga4: data?.ga4.connected ?? true }), [data]);
  const update = (patch: Partial<PagesControls>) => setControls((c) => ({ ...c, ...patch, offset: patch.offset ?? 0 }));
  if (!data) return <div className="p-6 text-sm text-muted-foreground">{error ?? 'Loading pages…'}</div>;

  return (
    <div className="flex min-h-0 flex-1" aria-label="SEO pages">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-6">
        {error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}
        {data.crawlPartial && <Alert><AlertDescription>The newest crawl is partial, so Inbound and Outbound counts may be incomplete.</AlertDescription></Alert>}
        {banners(data).map((b) => <Alert key={b}><AlertDescription>{b}</AlertDescription></Alert>)}
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Date range" className="h-9 rounded-md border bg-background px-2 text-sm" value={String(controls.days)} onChange={(e) => update({ days: Number(e.target.value) })}>
            {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </select>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={controls.compare} onChange={(e) => update({ compare: e.target.checked })} /> Compare to previous period</label>
          <Input aria-label="Search pages" className="w-48" placeholder="Search pages" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          <Input aria-label="Path prefix" className="w-40" placeholder="Path prefix, e.g. /blog" value={prefixText} onChange={(e) => setPrefixText(e.target.value)} />
          <select aria-label="Filter" className="h-9 rounded-md border bg-background px-2 text-sm" value={controls.filter} onChange={(e) => update({ filter: e.target.value as PageFilter })}>
            {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <p className="m-0 text-xs text-muted-foreground">{data.range.from} to {data.range.to}{data.previousRange ? ` · compared with ${data.previousRange.from} to ${data.previousRange.to}` : ''} · {data.total.toLocaleString('en-US')} pages{data.capped ? ' (list cut at the safety limit)' : ''}</p>
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-2 py-2"><button type="button" onClick={() => update(nextSort(controls, 'path'))}>Page{controls.sort === 'path' ? (controls.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>
                {METRIC_COLUMNS.map((c) => (
                  <th key={c.key} className="px-2 py-2 text-right" aria-sort={controls.sort === c.key ? (controls.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => update(nextSort(controls, c.key as MetricKey))}>{c.label}{controls.sort === c.key ? (controls.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                  </th>
                ))}
                <th className="px-2 py-2 text-right">Inbound</th>
                <th className="px-2 py-2 text-right">Outbound</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.url} className={`cursor-pointer border-b last:border-0 hover:bg-muted/50 ${selected === row.url ? 'bg-muted' : ''}`} onClick={() => setSelected(row.url)}>
                  <td className="max-w-xs break-all px-2 py-1.5">{row.path}</td>
                  {METRIC_COLUMNS.map((c) => <Cell key={c.key} column={c} row={row} connected={connected} compare={controls.compare} />)}
                  <td className="px-2 py-1.5 text-right tabular-nums">{internalCell(row.internal?.inbound)}{row.internal?.orphan && <span className="ml-1 rounded bg-warning/20 px-1 text-xs" title="In a sitemap, nothing links to it">orphan</span>}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{internalCell(row.internal?.outbound)}</td>
                </tr>
              ))}
              {!data.rows.length && <tr><td className="p-4 text-center text-muted-foreground" colSpan={METRIC_COLUMNS.length + 3}>No pages match.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={controls.offset === 0} onClick={() => update({ offset: Math.max(0, controls.offset - PAGE_SIZE) })}>Previous</Button>
          <Button size="sm" variant="outline" disabled={controls.offset + PAGE_SIZE >= data.total} onClick={() => update({ offset: controls.offset + PAGE_SIZE })}>Next</Button>
        </div>
      </div>
      {selected && <Drilldown project={project} controls={controls} onClose={() => setSelected(null)} onOpenInternalLinks={onOpenInternalLinks} />}
    </div>
  );
}
