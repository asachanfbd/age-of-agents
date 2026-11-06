import type { TableSpec } from '../buildings/contract.ts';

/**
 * The Tasks panel's table. Manual and agent tasks are one JSON record each, read whole and replaced by `uid`, never
 * filtered in SQL. Scheduled fetches live in the scheduler (a job whose target is an SEO action), not here.
 */
export const TASK_TABLES: TableSpec[] = [
  {
    name: 'seo_tasks',
    columns: [{ name: 'uid', type: 'text' }, { name: 'source', type: 'text' }, { name: 'updatedAt', type: 'text' }, { name: 'data', type: 'text' }],
    sortable: ['updatedAt'], filterable: ['uid', 'source'], uniqueKey: ['uid'],
  },
];

export interface TaskRowStored { uid: string; source: string; updatedAt: string; data: string }
