import { useEffect, useState } from 'react';
import { crmApi } from '../../lib/crmApi';
import { expandCounts, noCounts, sentTodayFrom } from '../../lib/crmKpis';
import type { CrmCounts } from '../../lib/crmKpis';

const settled = <T,>(request: Promise<T>): Promise<T | null> => request.catch(() => null);

/** The workspace's KPI numbers, counted from the existing list endpoints (one row each) and reloaded whenever `refreshKey` changes. A count that cannot be read stays null. */
export function useCrmCounts(projectId: string, refreshKey: string): CrmCounts {
  const [counts, setCounts] = useState<CrmCounts>(noCounts);
  useEffect(() => {
    let current = true;
    const prospects = { segment: 'prospect', limit: 1 };
    void Promise.all([
      settled(crmApi.contacts(projectId, prospects)),
      settled(crmApi.contacts(projectId, { ...prospects, flag: 'pending' })),
      settled(crmApi.customers(projectId, { limit: 1 })),
      settled(crmApi.lost(projectId, { limit: 1 })),
      settled(crmApi.expandToday(projectId)),
      settled(crmApi.report(projectId, { period: 'day' })),
    ]).then(([all, pending, customers, lost, today, day]) => {
      if (!current) return;
      const expand = today ? expandCounts(today) : { overdue: null, awaiting: null };
      setCounts({
        prospects: all?.total ?? null, pendingReachouts: pending?.total ?? null, awaitingApproval: expand.awaiting, overdueFollowups: expand.overdue,
        customers: customers?.total ?? null, sentToday: day ? sentTodayFrom(day) : null, lostProspects: lost?.prospects.total ?? null, lostCustomers: lost?.customers.total ?? null,
      });
    });
    return () => { current = false; };
  }, [projectId, refreshKey]);
  return counts;
}
