import type { TableSpec } from '../buildings/contract.ts';

/** Metrics are stored as numbers, and `NO_METRIC` stands for "the file did not give one" so it can never be read as 0. */
export const NO_METRIC = -1;

/**
 * The Backlinks tab's tables. Imports are the only source of links today; a paid provider would write the same rows.
 * Each table is read whole and replaced by key, never filtered in SQL.
 */
export const BACKLINK_TABLES: TableSpec[] = [
  {
    name: 'seo_backlinks',
    columns: [
      { name: 'uid', type: 'text' }, { name: 'key', type: 'text' }, { name: 'sourceUrl', type: 'text' }, { name: 'sourceHost', type: 'text' },
      { name: 'targetUrl', type: 'text' }, { name: 'anchor', type: 'text' }, { name: 'linkType', type: 'text' },
      { name: 'firstSeen', type: 'text' }, { name: 'lastSeen', type: 'text' },
      { name: 'sourceDr', type: 'real' }, { name: 'sourceUr', type: 'real' }, { name: 'sourceTraffic', type: 'integer' },
      { name: 'pageDr', type: 'real' }, { name: 'pageUr', type: 'real' }, { name: 'pageTraffic', type: 'integer' },
      { name: 'otherHost', type: 'integer' },
      // The columns the file had that no field uses, as a JSON object.
      { name: 'extras', type: 'text' }, { name: 'note', type: 'text' }, { name: 'firstBatch', type: 'integer' }, { name: 'lostAt', type: 'text' },
    ],
    sortable: ['uid'], filterable: ['uid'], uniqueKey: ['uid'],
  },
  {
    // One row per import. `mode` is full or partial; the counts are what the import did.
    name: 'seo_backlink_batches',
    columns: [
      { name: 'seq', type: 'integer' }, { name: 'uid', type: 'text' }, { name: 'fileName', type: 'text' }, { name: 'mode', type: 'text' }, { name: 'importedAt', type: 'text' },
      // Not `rows`: the group query names its row count that.
      { name: 'fileRows', type: 'integer' }, { name: 'added', type: 'integer' }, { name: 'updated', type: 'integer' }, { name: 'unchanged', type: 'integer' },
      { name: 'lost', type: 'integer' }, { name: 'returned', type: 'integer' }, { name: 'skipped', type: 'integer' },
    ],
    sortable: ['seq'], filterable: ['seq', 'uid'], uniqueKey: ['uid'],
  },
  {
    // A column mapping the person asked to remember; `mapping` is JSON.
    name: 'seo_backlink_mappings',
    columns: [{ name: 'name', type: 'text' }, { name: 'mapping', type: 'text' }],
    sortable: ['name'], filterable: ['name'], uniqueKey: ['name'],
  },
];

export interface BatchRow { seq: number; uid: string; fileName: string; mode: string; importedAt: string; fileRows: number; added: number; updated: number; unchanged: number; lost: number; returned: number; skipped: number }
