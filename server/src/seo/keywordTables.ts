import type { TableSpec } from '../buildings/contract.ts';

/**
 * The Keywords tab's own tables. Search Console queries are not copied here: a keyword has a row only once the person,
 * an import, research or a clustering run has done something to it. All of them are read whole and replaced by key, never filtered.
 */
export const KEYWORD_TABLES: TableSpec[] = [
  {
    name: 'seo_keywords',
    columns: [
      { name: 'key', type: 'text' }, { name: 'display', type: 'text' },
      // Comma-separated sources other than Search Console.
      { name: 'sources', type: 'text' }, { name: 'status', type: 'text' }, { name: 'pinned', type: 'integer' },
      // '' when the keyword is in no cluster.
      { name: 'clusterId', type: 'text' }, { name: 'targetPage', type: 'text' }, { name: 'createdAt', type: 'text' },
    ],
    sortable: ['key'], filterable: ['key', 'clusterId'], uniqueKey: ['key'],
  },
  {
    name: 'seo_clusters',
    columns: [{ name: 'uid', type: 'text' }, { name: 'name', type: 'text' }, { name: 'nameKey', type: 'text' }, { name: 'pinned', type: 'integer' }, { name: 'createdAt', type: 'text' }],
    sortable: ['name'], filterable: ['uid', 'nameKey'], uniqueKey: ['uid'],
  },
  {
    // The last volume Google Ads reported for a keyword. `kind` is exact or range; low equals high for exact.
    name: 'seo_keyword_volumes',
    columns: [{ name: 'key', type: 'text' }, { name: 'kind', type: 'text' }, { name: 'low', type: 'integer' }, { name: 'high', type: 'integer' }, { name: 'fetchedAt', type: 'text' }],
    sortable: ['key'], filterable: ['key'], uniqueKey: ['key'],
  },
  {
    // Keyword ideas from a research run, waiting for the person (pending), accepted or rejected.
    name: 'seo_keyword_proposals',
    columns: [
      { name: 'uid', type: 'text' }, { name: 'key', type: 'text' }, { name: 'display', type: 'text' }, { name: 'origin', type: 'text' },
      { name: 'reason', type: 'text' }, { name: 'status', type: 'text' },
      { name: 'volKind', type: 'text' }, { name: 'volLow', type: 'integer' }, { name: 'volHigh', type: 'integer' }, { name: 'volFetchedAt', type: 'text' },
      { name: 'runId', type: 'text' }, { name: 'createdAt', type: 'text' },
    ],
    sortable: ['createdAt'], filterable: ['uid', 'key', 'status', 'runId'], uniqueKey: ['uid'],
  },
  {
    // Moves a clustering run would make for pinned keywords; applied only when the person agrees.
    name: 'seo_cluster_suggestions',
    columns: [
      { name: 'uid', type: 'text' }, { name: 'runId', type: 'text' }, { name: 'key', type: 'text' }, { name: 'display', type: 'text' },
      { name: 'fromClusterId', type: 'text' }, { name: 'toName', type: 'text' }, { name: 'status', type: 'text' }, { name: 'createdAt', type: 'text' },
    ],
    sortable: ['createdAt'], filterable: ['uid', 'key', 'status'], uniqueKey: ['uid'],
  },
  {
    // `data` is the run's progress and messages as JSON.
    name: 'seo_keyword_runs',
    columns: [
      { name: 'uid', type: 'text' }, { name: 'kind', type: 'text' }, { name: 'status', type: 'text' }, { name: 'data', type: 'text' },
      { name: 'startedAt', type: 'text' }, { name: 'finishedAt', type: 'text' },
    ],
    sortable: ['startedAt'], filterable: ['uid', 'kind', 'status'], uniqueKey: ['uid'],
  },
];

export interface KeywordRow { key: string; display: string; sources: string; status: string; pinned: number; clusterId: string; targetPage: string; createdAt: string }
export interface ClusterRow { uid: string; name: string; nameKey: string; pinned: number; createdAt: string }
export interface VolumeRow { key: string; kind: string; low: number; high: number; fetchedAt: string }
export interface ProposalRow { uid: string; key: string; display: string; origin: string; reason: string; status: string; volKind: string; volLow: number; volHigh: number; volFetchedAt: string; runId: string; createdAt: string }
export interface SuggestionRow { uid: string; runId: string; key: string; display: string; fromClusterId: string; toName: string; status: string; createdAt: string }
export interface RunRow { uid: string; kind: string; status: string; data: string; startedAt: string; finishedAt: string }

export type KeywordTableName = 'seo_keywords' | 'seo_clusters' | 'seo_keyword_volumes' | 'seo_keyword_proposals' | 'seo_cluster_suggestions' | 'seo_keyword_runs';

const specOf = (table: KeywordTableName): TableSpec => KEYWORD_TABLES.find((t) => t.name === table)!;

export const columnsOf = (table: KeywordTableName): string[] => specOf(table).columns.map((c) => c.name);

/** An object as the array the store inserts, in the table's column order. */
export const rowArray = (table: KeywordTableName, row: object): Array<string | number> => columnsOf(table).map((c) => (row as Record<string, string | number>)[c]!);
