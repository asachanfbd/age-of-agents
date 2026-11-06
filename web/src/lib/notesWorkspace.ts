/** Pure view-models for the Notes skeleton workspace: sort toggling, aggregate totals and the ingest sizes on offer. */

export const INGEST_SIZES = [10_000, 100_000, 1_000_000] as const;
export const JOB_POLL_MS = 500;

export interface SortState { column: string; dir: 'asc' | 'desc' }

/** A click on a header: only sortable columns react; the same column flips direction, a new one starts ascending. */
export function nextSort(current: SortState | null, column: string, sortable: string[]): SortState | null {
  if (!sortable.includes(column)) return current;
  if (current?.column === column) return { column, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { column, dir: 'asc' };
}

export function sortIndicator(current: SortState | null, column: string): '' | 'ascending' | 'descending' {
  if (current?.column !== column) return '';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

export interface AggregateTotals { clicks: number; impressions: number; rows: number }

/** Sums the daily rollup rows; `rows` counts rollup rows (days), not source rows. */
export function aggregateTotals(rows: Array<Record<string, string | number>>): AggregateTotals {
  let clicks = 0;
  let impressions = 0;
  for (const row of rows) {
    clicks += Number(row.clicks) || 0;
    impressions += Number(row.impressions) || 0;
  }
  return { clicks, impressions, rows: rows.length };
}

export function ingestLabel(rows: number): string {
  return `Add ${rows.toLocaleString()} rows`;
}
