import { DEFAULT_TIMEZONE } from '../../content/limits.ts';
import { parseName, parseTimezone } from '../../content/validate.ts';
import { ContentInputError } from '../../content/errors.ts';
import type { BuildingTypeDefinition, ValidationResult } from '../contract.ts';

function validateCreate(input: unknown): ValidationResult {
  const { name, timezone } = (input ?? {}) as { name?: unknown; timezone?: unknown };
  try {
    return { ok: true, value: { name: parseName(name), timezone: timezone === undefined ? DEFAULT_TIMEZONE : parseTimezone(timezone) } };
  } catch (e) {
    const error = e as ContentInputError;
    return { ok: false, field: error.field ?? 'name', error: error.message };
  }
}

/**
 * Plans and produces social content for one business. Its records live in its own SQLite file in the Building's folder
 * (`content.sqlite`, opened by `content/runtime.ts`); its documents live as plain files in `knowledge/` and
 * `concepts/<id>/` so agents can read and edit them. Deleting the Building removes the folder.
 */
export const contentStudioType: BuildingTypeDefinition = {
  id: 'content-studio',
  name: 'Content Studio',
  description: 'Plan and produce content for one business: concepts with posts for LinkedIn, Instagram, X, Facebook and a blog, a calendar, business knowledge and a writing style.',
  category: 'Marketing',
  version: 1,
  look: { model: 'generic', color: '#8e6bbf' },
  workspace: 'content-studio',
  repository: false,
  validateCreate,
  async onCreated(buildingId, input) {
    const [{ getProject }, runtime, knowledge] = await Promise.all([import('../../projects/projectService.ts'), import('../../content/runtime.ts'), import('../../content/knowledge.ts')]);
    const project = await getProject(buildingId);
    runtime.seedTimezone(buildingId, input.timezone as string);
    await knowledge.bootstrapKnowledge(runtime.contentCtx(project));
  },
  async onDeleting(buildingId) {
    const [{ forgetContent }, { studioSessions }, { remotionStudios }, { insights }] = await Promise.all([import('../../content/runtime.ts'), import('../../content/studioSessions.ts'), import('../../content/remotionStudio.ts'), import('../../content/insights.ts')]);
    insights.forget(buildingId);
    remotionStudios.forget(buildingId);
    await studioSessions.removeForBuilding(buildingId);
    forgetContent(buildingId);
  },
  slots: [],
  agents: [],
  scheduledJobs: [],
  capabilities: [],
  events: [],
};
