import type { KpiItem } from './kpi';
import type { CrmTab } from './crmWorkspace';
import type { ExpandTodayDto, ReportDto } from './crmTypes';

/** What the workspace has counted from existing endpoints; null means that count could not be read. */
export interface CrmCounts {
  prospects: number | null; pendingReachouts: number | null; awaitingApproval: number | null; overdueFollowups: number | null;
  customers: number | null; sentToday: number | null; lostProspects: number | null; lostCustomers: number | null;
}
export const noCounts = (): CrmCounts => ({ prospects: null, pendingReachouts: null, awaitingApproval: null, overdueFollowups: null, customers: null, sentToday: null, lostProspects: null, lostCustomers: null });

const item = (key: keyof CrmCounts, label: string, counts: CrmCounts): KpiItem => ({ key, label, value: counts[key] });

/** The KPI row of each tab. A tab with nothing countable (Merge, Notes, Settings, Reports) has an empty row. */
export function kpisForTab(tab: CrmTab, counts: CrmCounts): KpiItem[] {
  switch (tab) {
    case 'calendar': return [item('overdueFollowups', 'Overdue followups', counts), item('pendingReachouts', 'Pending reachouts', counts), item('awaitingApproval', 'Awaiting approval', counts), item('sentToday', 'Sent today', counts)];
    case 'prospects': return [item('prospects', 'Prospects', counts), item('pendingReachouts', 'Pending reachouts', counts), item('awaitingApproval', 'Awaiting approval', counts)];
    case 'customers': return [item('customers', 'Customers', counts)];
    case 'lost': return [item('lostProspects', 'Lost prospects', counts), item('lostCustomers', 'Lost customers', counts)];
    case 'import': return [item('prospects', 'Prospects', counts), item('customers', 'Customers', counts)];
    default: return [];
  }
}

/** Overdue and awaiting-approval followups out of the "Expand Today" groups; null when the group is not in the answer. */
export function expandCounts(dto: Pick<ExpandTodayDto, 'groups'>): { overdue: number | null; awaiting: number | null } {
  const size = (id: string) => dto.groups.find((g) => g.id === id)?.cards.length ?? null;
  return { overdue: size('overdue'), awaiting: size('awaiting_approval') };
}

/** Reachouts plus followups sent in the day report; null when neither has any recorded events (never shown as 0). */
export function sentTodayFrom(report: Pick<ReportDto, 'period'>): number | null {
  const { reachoutsSent, followupsSent } = report.period.metrics;
  return reachoutsSent === null && followupsSent === null ? null : (reachoutsSent ?? 0) + (followupsSent ?? 0);
}
