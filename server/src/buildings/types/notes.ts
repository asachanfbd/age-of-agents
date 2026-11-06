import type { BuildingTypeDefinition, StorageSpec, ValidationResult } from '../contract.ts';

const MAX_NAME = 80;

function validateCreate(input: unknown): ValidationResult {
  const { name } = (input ?? {}) as { name?: unknown };
  if (typeof name !== 'string' || !name.trim()) return { ok: false, field: 'name', error: 'name is required' };
  if (name.trim().length > MAX_NAME) return { ok: false, field: 'name', error: `name must be at most ${MAX_NAME} characters` };
  return { ok: true, value: { name: name.trim() } };
}

export const NOTES_STORAGE: StorageSpec = {
  tables: [
    {
      name: 'notes',
      columns: [{ name: 'title', type: 'text' }, { name: 'body', type: 'text' }, { name: 'createdAt', type: 'text' }],
      sortable: ['createdAt', 'title'],
      filterable: ['title'],
      searchable: ['title', 'body'],
    },
    {
      // Synthetic search-analytics rows: the stand-in for a large per-day, per-page, per-query metrics table.
      name: 'metrics',
      columns: [
        { name: 'day', type: 'text' },
        { name: 'page', type: 'text' },
        { name: 'query', type: 'text' },
        { name: 'clicks', type: 'integer' },
        { name: 'impressions', type: 'integer' },
      ],
      sortable: ['day', 'clicks', 'impressions', 'page'],
      filterable: ['day', 'page', 'query', 'clicks', 'impressions'],
      searchable: ['page', 'query'],
      indexes: [['page', 'day']],
    },
  ],
  rollups: [
    { name: 'daily', table: 'metrics', groupBy: ['day'], measures: ['clicks', 'impressions'] },
    { name: 'day_page', table: 'metrics', groupBy: ['day', 'page'], measures: ['clicks', 'impressions'] },
  ],
  retention: { table: 'metrics', timeColumn: 'day', months: 12, mode: 'discard' },
  migrations: [],
};

/** The skeleton type: proves the contract end to end and gives the bulk layer something to test and benchmark. Not a product. */
export const notesType: BuildingTypeDefinition = {
  id: 'notes',
  name: 'Notes',
  description: 'Developer skeleton type: a few notes plus a synthetic large table used to test and benchmark the bulk data layer.',
  category: 'Developer',
  version: 1,
  look: { model: 'generic', color: '#e0a030' },
  workspace: 'notes',
  repository: false,
  devOnly: true,
  validateCreate,
  storage: NOTES_STORAGE,
  slots: [
    { id: 'review', label: 'Review the notes', usedWhen: 'A Task is started on the notes in this Building.', defaultWorkflowId: 'notes-review' },
  ],
  agents: [{ id: 'reviewer', label: 'Reviewer', defaultAgentId: 'manager' }],
  scheduledJobs: [],
  capabilities: [],
  events: [],
};
