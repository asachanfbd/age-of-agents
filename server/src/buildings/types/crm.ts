import { CRM_TABS } from '../../crm/limits.ts';
import type { BuildingTypeDefinition, ValidationResult } from '../contract.ts';

const MAX_NAME = 80;

function validateCreate(input: unknown): ValidationResult {
  const { name } = (input ?? {}) as { name?: unknown };
  if (typeof name !== 'string' || !name.trim()) return { ok: false, field: 'name', error: 'name is required' };
  if (name.trim().length > MAX_NAME) return { ok: false, field: 'name', error: `name must be at most ${MAX_NAME} characters` };
  return { ok: true, value: { name: name.trim() } };
}

export { CRM_TABS };

/**
 * One sales pipeline for one owner. Its data lives in its own SQLite file in the Building's folder (`crm.sqlite`),
 * opened by `crm/runtime.ts`, so it is deleted with the Building. It declares no bulk `storage`: contacts need updates
 * and multi-step transactions the insert-only bulk layer does not offer.
 */
export const crmType: BuildingTypeDefinition = {
  id: 'crm',
  name: 'CRM',
  description: 'Manage company sales: contacts across many channels, outreach and followups, a daily calendar, meeting notes, customers and reports.',
  category: 'Sales',
  version: 1,
  look: { model: 'generic', color: '#d9534f' },
  workspace: 'crm',
  repository: false,
  validateCreate,
  async onDeleting(buildingId) {
    const { forgetCrm } = await import('../../crm/runtime.ts');
    forgetCrm(buildingId);
  },
  slots: [],
  agents: [],
  scheduledJobs: [],
  capabilities: [],
  events: [],
};
