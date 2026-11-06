import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fromLabel, LOG_CHIPS, logExportText, logShowingText, logSummaryText } from '../lib/seoInternalLinks';
import type { CrawlLogRowDto, LogFilter } from '../lib/seoInternalLinks';
import { useSeoInternalLinksStore } from '../store/seoInternalLinksStore';

function RowDetail({ projectId, row, onClose }: { projectId: string; row: CrawlLogRowDto; onClose: () => void }) {
  const detail = useSeoInternalLinksStore((s) => s.crawlLogPageByProject[projectId]);
  const ready = detail?.row.url === row.url ? detail : null;
  return (
    <section className="grid gap-2 rounded-xl border bg-card p-3 text-sm" aria-label="Request detail">
      <div className="flex items-start gap-2">
        <h3 className="m-0 min-w-0 flex-1 break-all text-sm font-semibold">{row.url}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {!ready ? <p className="m-0 text-muted-foreground">Loading…</p> : (
        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <h4 className="m-0 mb-1 text-xs font-semibold uppercase text-muted-foreground">Links found on this page ({ready.linksFound.total.toLocaleString('en-US')})</h4>
            {!ready.stored && <p className="m-0 mb-1 text-xs text-muted-foreground">The full link list is not stored for this page{ready.linksFound.total ? '; only part of it is shown' : ''}.</p>}
            {ready.stored && ready.linksFound.total === 0 && <p className="m-0 text-muted-foreground">No links found on this page.</p>}
            {ready.linksFound.total > 0 && (
              <table className="w-full text-xs">
                <thead><tr className="text-left"><th>Target</th><th>Anchor</th><th>Location</th><th>Nofollow</th></tr></thead>
                <tbody>
                  {ready.linksFound.links.map((l, i) => (
                    <tr key={`${l.url}-${i}`} className="border-t align-top">
                      <td className="break-all">{l.url}{!l.crawled && <span className="ml-1 rounded bg-muted px-1">not crawled</span>}</td>
                      <td>{l.anchor || '(no anchor)'}</td><td>{l.location}</td><td>{l.nofollow ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <h4 className="m-0 mb-1 text-xs font-semibold uppercase text-muted-foreground">Crawled pages that link here ({ready.linkedFrom.total.toLocaleString('en-US')})</h4>
            {!ready.linkedFrom.complete && <p className="m-0 mb-1 text-xs text-muted-foreground">The stored link lists are incomplete for this crawl, so some pages that link here may be missing.</p>}
            {ready.linkedFrom.total === 0 ? <p className="m-0 text-muted-foreground">No crawled page links to this address.</p> : <ul className="m-0 list-none p-0 text-xs">{ready.linkedFrom.pages.map((u) => <li key={u} className="break-all">{u}</li>)}</ul>}
          </div>
        </div>
      )}
    </section>
  );
}

const SEARCH_DEBOUNCE_MS = 250;

/** The crawl log (remounted per snapshot, so filters and selection start fresh): every address the crawler requested for the chosen snapshot, in request order, with filters, search, CSV export and a per-row link detail. */
export function SeoCrawlLogView({ projectId, snapshotId }: { projectId: string; snapshotId: string }) {
  const log = useSeoInternalLinksStore((s) => s.crawlLogByProject[projectId]);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => { const res = await useSeoInternalLinksStore.getState().loadCrawlLog(projectId, filter, query); setError(res.ok ? null : res.error); };
  useEffect(() => { void load(); }, [projectId, snapshotId, filter, query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const t = setTimeout(() => setQuery(search), SEARCH_DEBOUNCE_MS); return () => clearTimeout(t); }, [search]);
  const row = log?.rows.find((r) => r.url === selected);
  if (selected && log && !row) setSelected(null);
  const shownUrl = row?.url ?? null;
  useEffect(() => { void useSeoInternalLinksStore.getState().loadCrawlLogPage(projectId, shownUrl); }, [projectId, shownUrl]);

  const exportCsv = async () => {
    const res = await useSeoInternalLinksStore.getState().exportCrawlLog(projectId, filter, query);
    if (!res.ok) { setMessage(res.error); return; }
    const url = URL.createObjectURL(new Blob([res.csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url; link.download = res.filename; link.click();
    URL.revokeObjectURL(url);
    setMessage(logExportText(log?.matched ?? 0, res.filename));
  };

  if (!log) return <p className="text-sm text-muted-foreground">{error ? <>{error} <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button></> : 'Loading…'}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p className="m-0 text-sm" role="status">{logSummaryText(log.summary)}</p>
      <div className="flex flex-wrap items-center gap-2">
        {LOG_CHIPS.map((c) => (
          <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)} className={`rounded-full border px-3 py-1 text-xs ${filter === c.key ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'}`}>
            {c.label} <span className="tabular-nums">{log.counts[c.key].toLocaleString('en-US')}</span>
          </button>
        ))}
        <Input aria-label="Search address" className="h-8 w-56" placeholder="Search address" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button size="sm" variant="outline" onClick={() => void exportCsv()}>Export CSV</Button>
        {message && <span className="text-xs text-muted-foreground" role="status">{message}</span>}
      </div>
      {error && <p className="m-0 text-sm text-destructive" role="alert">{error}</p>}
      {log.rows.length === 0 ? <p className="text-sm text-muted-foreground">No requests match these filters.</p> : (
        <>
          <p className="m-0 text-xs text-muted-foreground">{logShowingText(log)}</p>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-xs">
              <thead><tr className="text-left"><th className="p-1">#</th><th className="p-1">Address</th><th className="p-1">Status</th><th className="p-1">Content type</th><th className="p-1">Redirect target</th><th className="p-1">Error</th><th className="p-1">Internal</th><th className="p-1">External</th></tr></thead>
              <tbody>
                {log.rows.map((r) => (
                  <tr key={r.n} className={`cursor-pointer border-t align-top hover:bg-muted/50 ${r.url === selected ? 'bg-muted' : ''}`} aria-selected={r.url === selected} onClick={() => setSelected(r.url)}>
                    <td className="p-1 tabular-nums">{r.n}</td>
                    <td className="max-w-80 break-all p-1">{r.url}<div className="text-muted-foreground">from {fromLabel(r.from)}</div></td>
                    <td className="p-1 tabular-nums">{r.status ?? '—'}</td>
                    <td className="p-1">{r.contentType ?? '—'}</td>
                    <td className="max-w-64 break-all p-1">{r.redirectTo ?? ''}{r.selfRedirect && <span className="ml-1 rounded bg-warning/20 px-1">to itself</span>}</td>
                    <td className="p-1">{r.error && <span className="rounded bg-destructive/15 px-1">{r.error}</span>}</td>
                    <td className={`p-1 tabular-nums ${r.zeroLinks ? 'bg-warning/20' : ''}`}>{r.internalLinks.toLocaleString('en-US')}</td>
                    <td className={`p-1 tabular-nums ${r.zeroLinks ? 'bg-warning/20' : ''}`}>{r.externalLinks.toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {row && <RowDetail projectId={projectId} row={row} onClose={() => setSelected(null)} />}
    </div>
  );
}
