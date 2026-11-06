import type { ScheduledJobDeclaration, WorkflowSlot } from '../buildings/contract.ts';
import { validateJob } from './jobValidation.ts';
import type { JobValidation } from './jobValidation.ts';

/**
 * A type's declared job as the settings of the job a Building gets from it. A declared job is a cron job on one of the
 * type's own workflow slots (the first, unless it names one), off unless the declaration turns it on.
 */
export function declaredJobSettings(declaration: ScheduledJobDeclaration, slots: readonly WorkflowSlot[]): JobValidation {
  return validateJob({
    name: declaration.name ?? declaration.description,
    enabled: declaration.enabled ?? false,
    trigger: { kind: 'cron', cron: declaration.cron },
    target: { kind: 'slot', slotId: declaration.slotId ?? slots[0]?.id, description: declaration.task ?? declaration.description },
    overlap: declaration.overlap,
    missedPolicy: declaration.missedPolicy,
    maxRunsPerDay: declaration.maxRunsPerDay,
    needsApproval: declaration.needsApproval,
    failureThreshold: declaration.failureThreshold,
  }, { slotIds: slots.map((slot) => slot.id), agentIds: [] });
}

/** Why a type's declared jobs are not valid, or null when they are: each needs a unique id and settings that pass job validation. */
export function declaredJobsProblem(declarations: readonly ScheduledJobDeclaration[], slots: readonly WorkflowSlot[]): string | null {
  const ids = new Set<string>();
  for (const declaration of declarations) {
    if (typeof declaration?.id !== 'string' || !declaration.id) return 'has a job without an id';
    if (ids.has(declaration.id)) return `has a duplicate job id "${declaration.id}"`;
    ids.add(declaration.id);
    const settings = declaredJobSettings(declaration, slots);
    if (!settings.ok) return `job "${declaration.id}" is not valid: ${settings.error}`;
  }
  return null;
}
