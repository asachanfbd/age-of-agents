import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addToSide, matrixCellTitle, MAX_MATRIX_SIDE, pagesInSection, sectionsOf, visibleNodes, NO_FILTERS } from '../lib/seoInternalLinks';
import type { GraphDto, SideKind } from '../lib/seoInternalLinks';
import { useSeoInternalLinksStore } from '../store/seoInternalLinksStore';

function Picker({ graph, kind, urls, onChange }: { graph: GraphDto; kind: SideKind; urls: string[]; onChange: (urls: string[], message: string | null) => void }) {
  const [search, setSearch] = useState('');
  const pathOf = (url: string) => graph.nodes.find((n) => n.url === url)?.path ?? url;
  const matches = useMemo(() => (search.trim() ? [...visibleNodes(graph, { ...NO_FILTERS, search })].slice(0, 8).map((i) => graph.nodes[i]!) : []), [graph, search]);
  const add = (additions: string[]) => { const next = addToSide(urls, additions); onChange(next.urls, next.message); };
  return (
    <fieldset className="m-0 grid min-w-0 flex-1 gap-1 rounded-lg border p-2">
      <legend className="px-1 text-xs font-semibold uppercase text-muted-foreground">{kind === 'rows' ? 'Source pages (rows)' : 'Target pages (columns)'}</legend>
      <div className="flex flex-wrap gap-2">
        <select aria-label={`${kind} section`} className="h-8 rounded-md border bg-background px-2 text-sm" value="" onChange={(e) => { if (e.target.value) add(pagesInSection(graph, e.target.value)); }}>
          <option value="">Add a section…</option>{sectionsOf(graph).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Input aria-label={`${kind} search`} className="h-8 w-48" placeholder="Search to add a page" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {matches.length > 0 && <ul className="m-0 grid list-none gap-0.5 p-0 text-xs">{matches.map((n) => <li key={n.url}><button type="button" className="rounded px-1 hover:bg-muted" onClick={() => { add([n.url]); setSearch(''); }}>+ {n.path}</button></li>)}</ul>}
      <div className="flex flex-wrap gap-1">
        {urls.map((u) => <button key={u} type="button" className="rounded-full bg-muted px-2 py-0.5 text-xs" aria-label={`Remove ${pathOf(u)}`} onClick={() => onChange(urls.filter((x) => x !== u), null)}>{pathOf(u)} ×</button>)}
      </div>
      <p className="m-0 text-xs text-muted-foreground">{urls.length} of {MAX_MATRIX_SIDE}</p>
    </fieldset>
  );
}

/** The classic matrix: source rows by target columns for chosen pages (30 at most per side), with hover detail and a CSV export. */
export function SeoMatrixView({ projectId, graph }: { projectId: string; graph: GraphDto }) {
  const matrix = useSeoInternalLinksStore((s) => s.matrixByProject[projectId]);
  const [rows, setRows] = useState<string[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  useEffect(() => { void useSeoInternalLinksStore.getState().loadMatrix(projectId, rows, cols); }, [projectId, rows, cols, graph]);
  const empty = !rows.length || !cols.length;
  const exportCsv = async () => {
    const res = await useSeoInternalLinksStore.getState().exportMatrix(projectId, rows, cols, 'subset');
    if (!res.ok) { setMessage(res.error); return; }
    const url = URL.createObjectURL(new Blob([res.csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url; link.download = res.filename; link.click();
    URL.revokeObjectURL(url);
    setMessage(`Saved ${res.filename}`);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2 lg:flex-row">
        <Picker graph={graph} kind="rows" urls={rows} onChange={(u, m) => { setRows(u); setMessage(m); }} />
        <Picker graph={graph} kind="cols" urls={cols} onChange={(u, m) => { setCols(u); setMessage(m); }} />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={empty} onClick={() => void exportCsv()}>Export CSV</Button>
        {message && <span className="text-xs text-muted-foreground" role="status">{message}</span>}
      </div>
      {empty ? <p className="text-sm text-muted-foreground">Choose a section or search for pages, for both rows and columns.</p> : !matrix ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="text-xs">
            <thead><tr><th className="p-1 text-left">from ↓ / to →</th>{matrix.cols.map((c) => <th key={c.url} className="max-w-32 break-all p-1 text-left align-bottom font-medium" title={c.url}>{c.path}</th>)}<th className="p-1">Total</th></tr></thead>
            <tbody>
              {matrix.rows.map((r, ri) => (
                <tr key={r.url} className="border-t">
                  <th className="max-w-48 break-all p-1 text-left font-medium" title={r.url}>{r.path}</th>
                  {matrix.cols.map((c, ci) => {
                    const cell = matrix.cells[ri]![ci]!;
                    const same = r.url === c.url;
                    const title = matrixCellTitle(r.path, c.path, cell);
                    return (
                      <td key={c.url} title={title} onClick={() => setPinned(cell ? title : null)} className={`cursor-default p-1 text-center tabular-nums ${same ? 'bg-muted/60 text-muted-foreground' : cell ? 'bg-primary/10 font-medium' : 'text-muted-foreground'}`}>
                        {same ? '·' : cell ? cell.count : '—'}
                      </td>
                    );
                  })}
                  <td className="p-1 text-center font-medium tabular-nums">{matrix.rowTotals[ri]}</td>
                </tr>
              ))}
              <tr className="border-t"><th className="p-1 text-left">Total</th>{matrix.colTotals.map((t, i) => <td key={matrix.cols[i]!.url} className="p-1 text-center font-medium tabular-nums">{t}</td>)}<td /></tr>
            </tbody>
          </table>
        </div>
      )}
      {pinned && <p className="m-0 text-xs" role="status">{pinned}</p>}
    </div>
  );
}
