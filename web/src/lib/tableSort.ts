export type SortDirection = 'asc' | 'desc';
export interface SortState { key: string; direction: SortDirection }

/** Clicking a header cycles ascending, descending, then unsorted. */
export function nextSort(current: SortState | null, key: string): SortState | null {
  if (!current || current.key !== key) return { key, direction: 'asc' };
  return current.direction === 'asc' ? { key, direction: 'desc' } : null;
}

/** A stable sort on the chosen value; rows without a value (null, undefined) always come last. */
export function sortRows<T>(rows: readonly T[], sort: SortState | null, valueOf: (row: T, key: string) => string | number | null | undefined): T[] {
  if (!sort) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row, sort.key) }))
    .sort((a, b) => {
      const aEmpty = a.value === null || a.value === undefined;
      const bEmpty = b.value === null || b.value === undefined;
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
      const order = typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : String(a.value).localeCompare(String(b.value));
      return order * sign || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** How many rows to draw, and whether a "Show all N" pill is needed. */
export function visibleRows<T>(rows: readonly T[], limit: number | undefined, expanded: boolean): { rows: T[]; hidden: number } {
  if (limit === undefined || expanded || rows.length <= limit) return { rows: [...rows], hidden: 0 };
  const count = Math.max(0, limit);
  return { rows: rows.slice(0, count), hidden: rows.length - count };
}
