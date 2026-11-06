import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { nextSort, sortRows, visibleRows } from '../../lib/tableSort';
import type { SortState } from '../../lib/tableSort';
import type { Accent } from '../../lib/accent';
import { ACCENT_SOLID } from '../../lib/accent';

export interface Column<T> {
  key: string;
  header: string;
  /** Makes the header a sort button; the value to sort on. */
  sortValue?: (row: T) => string | number | null | undefined;
  render: (row: T) => ReactNode;
  className?: string;
}

/** A coloured dot plus a word. */
export function StatusDot({ accent, label }: { accent: Accent; label: string }) {
  return <span className="inline-flex items-center gap-2"><span aria-hidden className={cn('size-2 rounded-full', ACCENT_SOLID[accent])} />{label}</span>;
}

/** A cell with a main line and a muted second line. */
export function TwoLine({ main, sub }: { main: ReactNode; sub?: ReactNode }) {
  return <div className="grid"><span className="font-medium">{main}</span>{sub && <span className="text-sm text-muted-foreground">{sub}</span>}</div>;
}

/**
 * A roomy table with no grid lines. Sortable headers carry `aria-sort`; `rowLimit` shows a
 * "Show all N" pill for the rest; `onRowClick` and `rowMenu` (the "…" cell) are optional.
 */
export function DataTable<T>({ columns, rows, rowKey, label, summary, rowLimit, onRowClick, rowMenu, empty }: {
  columns: readonly Column<T>[]; rows: readonly T[]; rowKey: (row: T) => string | number; label: string; summary?: ReactNode; rowLimit?: number;
  onRowClick?: (row: T) => void; rowMenu?: (row: T) => ReactNode; empty?: ReactNode;
}) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => sortRows(rows, sort, (row, key) => columns.find((c) => c.key === key)?.sortValue?.(row)), [rows, sort, columns]);
  const { rows: shown, hidden } = visibleRows(sorted, rowLimit, expanded);
  return (
    <div className="grid gap-3">
      {summary && <p className="m-0 text-sm text-muted-foreground">{summary}</p>}
      <div className="overflow-x-auto">
        <table aria-label={label} className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key ? sort : null;
                return (
                  <th key={column.key} scope="col" aria-sort={active ? (active.direction === 'asc' ? 'ascending' : 'descending') : column.sortValue ? 'none' : undefined} className="px-3 py-2 text-left text-sm font-normal text-muted-foreground">
                    {column.sortValue
                      ? <button type="button" onClick={() => setSort((s) => nextSort(s, column.key))} className="inline-flex items-center gap-1 rounded-control bg-transparent p-0 text-inherit outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">{column.header}{active?.direction === 'asc' ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}</button>
                      : column.header}
                  </th>
                );
              })}
              {rowMenu && <th scope="col" className="w-12"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={cn('border-t border-border', onRowClick && 'cursor-pointer hover:bg-muted/60')}>
                {columns.map((column) => <td key={column.key} className={cn('px-3 py-3.5 align-middle', column.className)}>{column.render(row)}</td>)}
                {rowMenu && <td className="px-3 py-2 text-right" onClick={(event) => event.stopPropagation()}>{rowMenu(row)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && empty}
      </div>
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="mx-auto inline-flex items-center gap-1.5 rounded-control border border-input bg-transparent px-4 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
          Show all {rows.length} <ChevronDown className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
