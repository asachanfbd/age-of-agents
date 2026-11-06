import type { BuildingTypeDefinition, CapabilityDeclaration, StorageSpec, ValidationResult } from '../contract.ts';
import { KEY_NUMBER_KEYS } from '../../seo/reportBuild.ts';
import { SeoInputError } from '../../seo/errors.ts';
import { siteHost, normalizeSiteUrl } from '../../seo/siteUrl.ts';
import { seoLifecycle } from '../../seo/lifecycle.ts';
import { BACKLINK_TABLES } from '../../seo/backlinkTables.ts';
import { KEYWORD_TABLES } from '../../seo/keywordTables.ts';
import { SCHEDULE_ACTION_LIST } from '../../seo/scheduleActionList.ts';
import { TASK_TABLES } from '../../seo/taskTables.ts';
import { REPORT_TABLES } from '../../seo/reportTables.ts';

const MAX_NAME = 80;

function validateCreate(input: unknown): ValidationResult {
  const { name, siteUrl } = (input ?? {}) as { name?: unknown; siteUrl?: unknown };
  let normalized: string;
  try { normalized = normalizeSiteUrl(siteUrl); } catch (error) {
    if (error instanceof SeoInputError) return { ok: false, field: 'siteUrl', error: error.message };
    throw error;
  }
  const chosen = typeof name === 'string' && name.trim() ? name.trim() : siteHost(normalized);
  if (chosen.length > MAX_NAME) return { ok: false, field: 'name', error: `name must be at most ${MAX_NAME} characters` };
  return { ok: true, value: { name: chosen, siteUrl: normalized } };
}

/**
 * Every raw row carries its `property` (the GSC/GA4 property it was fetched for), so changing property never merges
 * two properties' totals, and `week`/`month` keys so the roll-ups can group by them. Position is stored as
 * position x impressions so roll-ups, which only add, can still give an impression-weighted average.
 */
export const SEO_STORAGE: StorageSpec = {
  tables: [
    {
      name: 'gsc_rows',
      columns: [
        { name: 'property', type: 'text' }, { name: 'day', type: 'text' }, { name: 'week', type: 'text' }, { name: 'month', type: 'text' },
        { name: 'page', type: 'text' }, { name: 'query', type: 'text' },
        { name: 'clicks', type: 'integer' }, { name: 'impressions', type: 'integer' }, { name: 'positionImpressions', type: 'real' },
      ],
      // Only `day` is indexed besides the unique key (property, day, page, query), which already serves property + day lookups.
      // Indexes on page, query or the metrics are random-insert B-trees: with them a day's insert time grew about 10x by
      // 1.6M rows. Rankings (top pages, top queries) and per-page history come from the roll-ups instead.
      sortable: ['day'],
      filterable: ['property', 'day', 'week', 'month', 'page', 'query', 'clicks', 'impressions'],
      searchable: ['page', 'query'],
      uniqueKey: ['property', 'day', 'page', 'query'],
    },
    {
      name: 'ga4_rows',
      columns: [
        { name: 'property', type: 'text' }, { name: 'day', type: 'text' }, { name: 'week', type: 'text' }, { name: 'month', type: 'text' },
        { name: 'page', type: 'text' }, { name: 'sessions', type: 'integer' }, { name: 'keyEvents', type: 'integer' },
      ],
      sortable: ['day', 'sessions', 'keyEvents', 'page'],
      filterable: ['property', 'day', 'week', 'month', 'page', 'sessions', 'keyEvents'],
      searchable: ['page'],
      uniqueKey: ['property', 'day', 'page'],
    },
    {
      // One row per (dataset, property, day) that was fetched, even when it had no rows: separates "zero" from "never fetched".
      name: 'fetch_ledger',
      columns: [
        { name: 'dataset', type: 'text' }, { name: 'property', type: 'text' }, { name: 'day', type: 'text' },
        { name: 'final', type: 'integer' }, { name: 'fetchedAt', type: 'text' }, { name: 'rowCount', type: 'integer' },
      ],
      sortable: ['day'],
      filterable: ['dataset', 'property', 'day', 'final'],
      uniqueKey: ['dataset', 'property', 'day'],
    },
    {
      // Every sitemap found (submitted in Search Console, listed in robots.txt, at the default address, or a child of an index).
      // `data` is the record as JSON (see `seo/sitemapStore.ts`): it is read whole and replaced whole, never filtered on.
      name: 'seo_sitemaps',
      columns: [{ name: 'url', type: 'text' }, { name: 'data', type: 'text' }],
      sortable: ['url'], filterable: ['url'], uniqueKey: ['url'],
    },
    {
      // The page addresses each sitemap lists, normalised. `lastmod` is the sitemap's own value ('' when absent) and `firstSeen` the day we first read the URL.
      name: 'seo_sitemap_urls',
      columns: [{ name: 'sitemap', type: 'text' }, { name: 'url', type: 'text' }, { name: 'lastmod', type: 'text' }, { name: 'firstSeen', type: 'text' }],
      sortable: ['url'], filterable: ['sitemap', 'url'], searchable: ['url'], uniqueKey: ['sitemap', 'url'], onConflict: 'ignore',
    },
    {
      // The last URL inspection per page. `pending` = 1 while a requested inspection is waiting for quota.
      name: 'seo_inspections',
      columns: [
        { name: 'url', type: 'text' }, { name: 'state', type: 'text' }, { name: 'reason', type: 'text' }, { name: 'raw', type: 'text' },
        { name: 'inspectedAt', type: 'text' }, { name: 'pending', type: 'integer' }, { name: 'error', type: 'text' },
      ],
      sortable: ['url'], filterable: ['url', 'state', 'pending'], uniqueKey: ['url'],
    },
    {
      // How many URL inspections were used on one quota day (Pacific time). Written before the Google call so a crash never undercounts.
      name: 'seo_inspection_quota',
      columns: [{ name: 'day', type: 'text' }, { name: 'used', type: 'integer' }],
      sortable: ['day'], filterable: ['day'], uniqueKey: ['day'],
    },
    {
      // One row per URL per IndexNow submission. `batch` ties the rows of one request together.
      name: 'seo_indexnow_log',
      columns: [
        { name: 'at', type: 'text' }, { name: 'batch', type: 'text' }, { name: 'url', type: 'text' }, { name: 'endpoint', type: 'text' },
        { name: 'httpStatus', type: 'integer' }, { name: 'result', type: 'text' }, { name: 'message', type: 'text' },
      ],
      sortable: ['at'], filterable: ['batch', 'url', 'result'],
    },
    ...KEYWORD_TABLES,
    ...BACKLINK_TABLES,
    ...TASK_TABLES,
    ...REPORT_TABLES,
  ],
  rollups: [
    { name: 'gsc_daily', table: 'gsc_rows', groupBy: ['property', 'day'], measures: ['clicks', 'impressions', 'positionImpressions'] },
    { name: 'gsc_weekly', table: 'gsc_rows', groupBy: ['property', 'week'], measures: ['clicks', 'impressions', 'positionImpressions'] },
    { name: 'gsc_monthly', table: 'gsc_rows', groupBy: ['property', 'month'], measures: ['clicks', 'impressions', 'positionImpressions'] },
    { name: 'gsc_page_day', table: 'gsc_rows', groupBy: ['property', 'page', 'day'], measures: ['clicks', 'impressions', 'positionImpressions'] },
    { name: 'gsc_page_month', table: 'gsc_rows', groupBy: ['property', 'month', 'page'], measures: ['clicks', 'impressions', 'positionImpressions'] },
    { name: 'gsc_query_month', table: 'gsc_rows', groupBy: ['property', 'month', 'query'], measures: ['clicks', 'impressions', 'positionImpressions'] },
    { name: 'ga4_daily', table: 'ga4_rows', groupBy: ['property', 'day'], measures: ['sessions', 'keyEvents'] },
    { name: 'ga4_weekly', table: 'ga4_rows', groupBy: ['property', 'week'], measures: ['sessions', 'keyEvents'] },
    { name: 'ga4_monthly', table: 'ga4_rows', groupBy: ['property', 'month'], measures: ['sessions', 'keyEvents'] },
  ],
  // The window is a per-Building setting (default 12 months); `retentionPlan` passes the Building's own value.
  retention: { table: 'gsc_rows', alsoTables: ['ga4_rows', 'fetch_ledger'], timeColumn: 'day', months: 12, mode: 'discard' },
  // Versions 2 to 5 add the Keywords, Backlinks, Tasks and Reports tables; opening the database creates any table that is missing, so the steps have no SQL of their own.
  migrations: [{ toVersion: 2, sql: [] }, { toVersion: 3, sql: [] }, { toVersion: 4, sql: [] }, { toVersion: 5, sql: [] }],
};

/** The newest saved report, for a linked Building to read: Markdown plus the key numbers (metrics with no data are left out). */
const getLatestReport: CapabilityDeclaration = {
  id: 'get-latest-report',
  description: 'Read the newest saved SEO report as Markdown, with its key numbers.',
  mode: 'read',
  inputs: [],
  outputs: [
    { name: 'found', type: 'boolean', description: 'False when no report has been saved yet; the other outputs are then empty.' },
    { name: 'markdown', type: 'string', description: 'The report as Markdown.' },
    { name: 'period', type: 'string', description: 'The period and the one it is compared with.' },
    { name: 'savedAt', type: 'string', description: 'When the report was saved.' },
    { name: 'keyNumbers', type: 'object', description: 'The report\'s headline numbers by metric; a metric with no data is left out.', fields: KEY_NUMBER_KEYS.map((name) => ({ name, type: 'number' as const })) },
  ],
  async handle({ buildingId }) {
    const { latestReportOutputs } = await import('../../seo/reports.ts');
    return { outputs: await latestReportOutputs(buildingId) };
  },
};

export const SEO_TABS = ['Keywords', 'Sitemaps', 'Pages', 'Reports', 'Backlinks', 'Internal links', 'Tasks', 'Settings'] as const;

export const seoType: BuildingTypeDefinition = {
  id: 'seo',
  name: 'SEO',
  description: 'Manage the SEO of one website from one place: Search Console and Analytics data, keywords, pages, sitemaps, backlinks and tasks.',
  category: 'Marketing',
  version: 5,
  look: { model: 'generic', color: '#2fb89a' },
  workspace: 'seo',
  repository: false,
  validateCreate,
  onCreated: (buildingId, input) => seoLifecycle.created(buildingId, input),
  onDeleting: (buildingId) => seoLifecycle.deleting(buildingId),
  retentionPlan: (buildingId) => seoLifecycle.retentionPlan(buildingId),
  storage: SEO_STORAGE,
  slots: [
    { id: 'seo-task', label: 'Work an SEO task', usedWhen: 'A Task is started on this site\'s SEO work.', defaultWorkflowId: 'seo-task' },
    { id: 'seo-keyword-research', label: 'Keyword research', usedWhen: 'An agent task researches new keywords from the Tasks panel.', defaultWorkflowId: 'seo-keyword-research' },
    { id: 'seo-keyword-clustering', label: 'Keyword clustering', usedWhen: 'An agent task groups keywords into clusters from the Tasks panel.', defaultWorkflowId: 'seo-keyword-clustering' },
    { id: 'seo-title-meta', label: 'Title and meta proposals', usedWhen: 'An agent task proposes titles and meta descriptions for chosen pages; it ends at approval.', defaultWorkflowId: 'seo-title-meta' },
    { id: 'seo-content', label: 'Content brief proposals', usedWhen: 'An agent task proposes content briefs for chosen pages; it ends at approval.', defaultWorkflowId: 'seo-content' },
    { id: 'seo-audit', label: 'Site audit', usedWhen: 'An agent task audits the site from crawl data; it ends at approval.', defaultWorkflowId: 'seo-audit' },
  ],
  agents: [{ id: 'seo-analyst', label: 'SEO analyst', defaultAgentId: 'manager' }],
  scheduledJobs: [],
  scheduledActions: [...SCHEDULE_ACTION_LIST],
  capabilities: [getLatestReport],
  events: [{
    id: 'report-published', description: 'A scheduled SEO report was saved.',
    payload: [{ name: 'reportId', type: 'string' }, { name: 'period', type: 'string' }, { name: 'source', type: 'enum', values: ['scheduled', 'manual'] }],
  }],
};
