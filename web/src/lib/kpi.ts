export type DeltaTone = 'positive' | 'negative' | 'neutral';
export interface Delta { tone: DeltaTone; text: string }

/** A change badge for a number against its previous period; no badge when there is no usable comparison. */
export function deltaBadge(current: number | null | undefined, previous: number | null | undefined, unit = ''): Delta | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const change = current - previous;
  if (change === 0) return { tone: 'neutral', text: 'no change' };
  return { tone: change > 0 ? 'positive' : 'negative', text: `${change > 0 ? '+' : '−'}${Math.abs(change).toLocaleString('en-US')}${unit}` };
}

/** A KPI value for display: thousands separators, "—" when there is nothing to show. */
export function formatKpi(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US');
}

export interface KpiItem { key: string; label: string; value: number | null | undefined; delta?: Delta | null }

/** The KPIs that have data: a missing value is left out, a real 0 is kept. */
export const presentKpis = (items: readonly KpiItem[]): KpiItem[] => items.filter((item) => item.value !== null && item.value !== undefined && Number.isFinite(item.value));
