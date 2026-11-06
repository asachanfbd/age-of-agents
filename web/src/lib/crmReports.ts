import type { BarGroup, BarSeries } from './chartData';
import { sortByTotal } from './chartData';
import type { BreakdownRowDto, MetricsDto, PeriodDto, ReportDto } from './crmTypes';

export const PERIOD_OPTIONS = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] as const;
export const NO_DATA = 'no data';

/** A metric with no recorded events reads "no data", never 0. */
export const metricText = (v: number | null): string => (v === null ? NO_DATA : v.toLocaleString('en-US'));

export const beforeFirstText = (r: Pick<ReportDto, 'beforeFirstRecord' | 'firstRecordDay' | 'hasRecords'>): string | null => {
  if (!r.hasRecords) return 'Nothing is recorded yet.';
  return r.beforeFirstRecord && r.firstRecordDay ? `No records before ${r.firstRecordDay}.` : null;
};

export interface Comparison { current: string; previous: string; change: string | null }
/** Current against the previous period; a null on either side means there is no change to state. */
export function compare(current: number | null, previous: number | null): Comparison {
  const change = current === null || previous === null ? null : current === previous ? 'no change' : `${current > previous ? '+' : ''}${(current - previous).toLocaleString('en-US')}`;
  return { current: metricText(current), previous: metricText(previous), change };
}

export const METRIC_ROWS: Array<{ key: keyof MetricsDto; label: string }> = [
  { key: 'prospectsAdded', label: 'Prospects added' }, { key: 'reachoutsSent', label: 'Reachouts sent' }, { key: 'followupsSent', label: 'Followups sent' },
  { key: 'onTime', label: 'Followups on time' }, { key: 'delayed', label: 'Followups delayed' }, { key: 'maxDelayMinutes', label: 'Longest delay (minutes)' },
  { key: 'lostProspects', label: 'Lost prospects' }, { key: 'lostCustomers', label: 'Lost customers' }, { key: 'newCustomers', label: 'New customers' },
];

export const periodHeading = (cur: PeriodDto, prev: PeriodDto): string => `${cur.label} compared with ${prev.label}`;
export const csvFileName = (table: string, period: string): string => `crm-${table}-${period}.csv`;
export const EXPORT_TABLES = [{ value: 'summary', label: 'Summary' }, { value: 'by-channel', label: 'By channel' }, { value: 'by-source', label: 'By batch or source' }] as const;

/** The metrics the period chart compares, current period against the previous one. */
export const CHART_METRICS: Array<{ key: keyof MetricsDto; label: string }> = [
  { key: 'prospectsAdded', label: 'Prospects added' }, { key: 'reachoutsSent', label: 'Reachouts sent' }, { key: 'followupsSent', label: 'Followups sent' },
  { key: 'newCustomers', label: 'New customers' }, { key: 'lostProspects', label: 'Lost prospects' },
];

export const periodSeries = (r: Pick<ReportDto, 'period' | 'previous'>): BarSeries[] => [
  { key: 'current', label: r.period.label, accent: 'green' },
  { key: 'previous', label: r.previous.label, accent: 'yellow', dashed: true },
];

/** One group per metric with the current and previous values; a metric with no events keeps its null. */
export const periodGroups = (r: Pick<ReportDto, 'period' | 'previous'>): BarGroup[] =>
  CHART_METRICS.map(({ key, label }) => ({ label, values: [r.period.metrics[key], r.previous.metrics[key]] }));

export const BREAKDOWN_SERIES: BarSeries[] = [
  { key: 'added', label: 'Added', accent: 'green' }, { key: 'reachoutsSent', label: 'Reachouts sent', accent: 'yellow' }, { key: 'followupsSent', label: 'Followups sent', accent: 'orange' },
];

/** The by-channel and by-source rows as bar groups, busiest first. */
export const breakdownGroups = (rows: readonly BreakdownRowDto[]): BarGroup[] =>
  sortByTotal(rows.map((row) => ({ label: row.label, values: [row.added, row.reachoutsSent, row.followupsSent] })));
