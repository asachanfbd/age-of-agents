import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isBuildingReadOnly, readOnlyNotice } from '../lib/buildingTypes';
import { nextPager, pagerInfo, prevPager } from '../lib/buildingStorage';
import type { PagerState } from '../lib/buildingStorage';
import { INGEST_SIZES, aggregateTotals, ingestLabel, nextSort, sortIndicator } from '../lib/notesWorkspace';
import type { AggregateTotals, SortState } from '../lib/notesWorkspace';
import { serverApi } from '../lib/serverApi';
import { useStorageJob } from '../lib/useStorageJob';
import { useWorldStore } from '../store/worldStore';
import type { ProjectData } from '../types';
import { JobProgress } from './JobProgress';

const TABLE = 'metrics';
type Row = Record<string, string | number>;

/**
 * The Notes skeleton type's workspace. A developer skeleton that proves the Building Type contract (paged reads,
 * rollups, bulk ingest); not a product. All state is local; every list request goes through `dataQueryString`,
 * which always adds a limit.
 */
export function NotesWorkspace({ project }: { project: ProjectData }) {
  const readOnly = isBuildingReadOnly(project);
  const notice = readOnlyNotice(project);
  const type = useWorldStore((s) => s.buildingTypes.find((t) => t.id === project.typeId));
  const table = type?.tables.find((t) => t.name === TABLE);
  const sortable = table?.sortable ?? [];
  const columns = table?.columns.map((c) => c.name) ?? [];
  const slot = type?.slots[0];
  const defaultWorkflowName = useWorldStore((s) => s.catalogWorkflows.find((w) => w.id === slot?.defaultWorkflowId)?.name) ?? slot?.defaultWorkflowId;

  const [sort, setSort] = useState<SortState | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [pager, setPager] = useState<PagerState>({ history: [], nextCursor: null });
  const [rows, setRows] = useState<Row[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<AggregateTotals | null>(null);
  const [refresh, setRefresh] = useState(0);

  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const { job, error: jobError, start, cancel } = useStorageJob(project.id, reload);

  useEffect(() => {
    let stale = false;
    serverApi.buildingAggregate(project.id, 'daily', {})
      .then((r) => { if (!stale) setTotals(aggregateTotals(r.rows)); })
      .catch(() => { if (!stale) setTotals(null); });
    return () => { stale = true; };
  }, [project.id, refresh]);

  const requestKey = JSON.stringify([project.id, sort, search, cursor, refresh]);
  useEffect(() => {
    let stale = false;
    serverApi.listBuildingData(project.id, TABLE, { sort: sort?.column, dir: sort?.dir, search, cursor })
      .then((page) => {
        if (stale) return;
        setRows(page.rows);
        setPager((p) => ({ ...p, nextCursor: page.nextCursor }));
        setError(null);
      })
      .catch((e: unknown) => { if (!stale) setError(e instanceof Error ? e.message : 'Could not load rows'); })
      .finally(() => { if (!stale) setLoadedKey(requestKey); });
    return () => { stale = true; };
  }, [project.id, sort, search, cursor, refresh, requestKey]);

  function resetPaging() { setCursor(null); setPager({ history: [], nextCursor: null }); }
  function onSort(column: string) { setSort((s) => nextSort(s, column, sortable)); resetPaging(); }
  function onSearch(e: React.FormEvent) { e.preventDefault(); setSearch(searchInput); resetPaging(); }
  function goNext() { if (pager.nextCursor) { setPager(nextPager(pager, cursor, pager.nextCursor)); setCursor(pager.nextCursor); } }
  function goPrev() { const back = prevPager(pager); setPager(back.pager); setCursor(back.cursor); }

  const loading = loadedKey !== requestKey;
  const info = pagerInfo(pager, rows.length);
  const tiles: Array<[string, string]> = [
    ['Total clicks', totals ? totals.clicks.toLocaleString() : '-'],
    ['Total impressions', totals ? totals.impressions.toLocaleString() : '-'],
    ['Days with data', totals ? totals.rows.toLocaleString() : '-'],
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label="Notes workspace">
      <Alert className="mb-4">
        <AlertDescription>Developer skeleton: this Building Type only proves the data contract (paged tables, rollups, bulk ingest). It is not a finished product.</AlertDescription>
      </Alert>

      <div className="grid gap-3 sm:grid-cols-3" aria-label="Totals">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <section className="mt-6" aria-label="Synthetic data">
        <h3 className="text-base font-semibold tracking-tight">Add synthetic data</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">Fills the metrics table in the background so paging and totals can be tried at size.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {INGEST_SIZES.map((size) => (
            <Button key={size} type="button" variant="outline" size="sm" disabled={readOnly || job?.status === 'running'} title={readOnly ? notice ?? undefined : undefined}
              onClick={() => void start(() => serverApi.startSyntheticIngest(project.id, TABLE, size))}>
              {ingestLabel(size)}
            </Button>
          ))}
        </div>
        {job?.kind === 'ingest' && <JobProgress job={job} onCancel={() => void cancel()} />}
        {jobError && <p className="mt-2 text-sm text-destructive" role="alert">{jobError}</p>}
      </section>

      <section className="mt-6" aria-label="Metrics table">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">Metrics</h3>
          <form className="flex gap-2" onSubmit={onSearch} role="search">
            <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search page or query" aria-label="Search metrics" className="w-56" />
            <Button type="submit" variant="outline" size="sm">Search</Button>
          </form>
        </div>
        {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
        <div className="mt-3 overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                {columns.map((column) => {
                  const canSort = sortable.includes(column);
                  const dir = sortIndicator(sort, column);
                  return (
                    <th key={column} scope="col" className="px-3 py-2 font-medium" aria-sort={dir || undefined}>
                      {canSort ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:underline" onClick={() => onSort(column)}>
                          {column}{dir === 'ascending' && <ArrowUp className="size-3" aria-hidden="true" />}{dir === 'descending' && <ArrowDown className="size-3" aria-hidden="true" />}
                        </button>
                      ) : column}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t">
                  {columns.map((column) => <td key={column} className="px-3 py-1.5 tabular-nums">{row[column]}</td>)}
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={Math.max(columns.length, 1)} className="px-3 py-6 text-center italic text-muted-foreground">No rows yet. Add synthetic data above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground" aria-live="polite">{loading ? 'Loading...' : `${info.label} (page ${info.page})`}</span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!info.canPrev || loading} onClick={goPrev}>Previous</Button>
            <Button type="button" variant="outline" size="sm" disabled={!info.canNext || loading} onClick={goNext}>Next</Button>
          </div>
        </div>
      </section>

      <section className="mt-6" aria-label="Workflow slot">
        <h3 className="text-base font-semibold tracking-tight">Workflow</h3>
        {slot ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{slot.label}: runs the <span className="font-medium text-foreground">{defaultWorkflowName}</span> workflow by default.</p>
        ) : <p className="mt-0.5 text-sm italic text-muted-foreground">This type has no workflow slots.</p>}
      </section>
    </div>
  );
}
