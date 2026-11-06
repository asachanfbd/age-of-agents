import type { BulkStore } from '../buildings/bulkClient.ts';
import { addDays } from './dates.ts';

export type Dataset = 'gsc' | 'ga4';

/** The days already fetched for a dataset and property, and whether each was final when fetched. */
export async function readLedger(store: BulkStore, dataset: Dataset, property: string, from: string): Promise<Map<string, boolean>> {
  const days = new Map<string, boolean>();
  let cursor: string | undefined;
  do {
    const page = await store.list('fetch_ledger', {
      sort: 'day', limit: 200, cursor,
      filters: [{ col: 'dataset', op: 'eq', value: dataset }, { col: 'property', op: 'eq', value: property }, { col: 'day', op: 'gte', value: from }],
    });
    for (const row of page.rows) days.set(String(row.day), row.final === 1);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return days;
}

/** Days from `from` to `to` that still need fetching: never fetched, or fetched while Google still called them incomplete. Oldest first, so a restart resumes where the last committed day ended. */
export function pendingDays(from: string, to: string, ledger: Map<string, boolean>): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) if (ledger.get(day) !== true) out.push(day);
  return out;
}
