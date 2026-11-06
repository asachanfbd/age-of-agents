import type { TableSpec } from '../buildings/contract.ts';

/**
 * The Reports tab's tables. A saved report is one JSON document (`data`) that holds every number it shows, so it stays
 * readable after the search and analytics rows it came from are discarded; it is never part of the 12-month discard.
 * `seo_index_changes` is the log of indexing state changes, which the weekly "newly indexed / excluded" lists read.
 */
export const REPORT_TABLES: TableSpec[] = [
  {
    name: 'seo_reports',
    columns: [
      { name: 'uid', type: 'text' }, { name: 'name', type: 'text' }, { name: 'source', type: 'text' }, { name: 'savedAt', type: 'text' },
      { name: 'periodKey', type: 'text' }, { name: 'rangeFrom', type: 'text' }, { name: 'rangeTo', type: 'text' }, { name: 'hasSummary', type: 'integer' },
      { name: 'data', type: 'text' },
    ],
    sortable: ['savedAt'], filterable: ['uid', 'source', 'periodKey'], uniqueKey: ['uid'],
  },
  {
    name: 'seo_index_changes',
    columns: [{ name: 'url', type: 'text' }, { name: 'fromState', type: 'text' }, { name: 'toState', type: 'text' }, { name: 'at', type: 'text' }],
    sortable: ['at'], filterable: ['url', 'toState', 'at'],
  },
];
