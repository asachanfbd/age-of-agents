import type { WorkflowRecord, WorkflowStep } from '../domain/types.ts';

/** The fixed reason a step unchecked in the Start task dialog is recorded with. */
export const SKIPPED_AT_START_REASON = 'Skipped when the task was started';

export class InvalidStepSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStepSelectionError';
  }
}

/**
 * The earlier step `step` depends on, or null: a looping review's loop target, or an approval
 * step's Request changes target. Only an earlier step counts, matching how the run engine treats a
 * target that isn't earlier (see workerManager.ts's `requestChangesTarget`). The web's
 * `stepParentId` (web/src/lib/stepSelection.ts) applies the same rule.
 */
export function stepParentId(steps: WorkflowStep[], step: WorkflowStep): string | null {
  const parentId = step.loopBack?.toStepId ?? (step.requiresApproval ? step.requestChangesToStepId : null);
  if (!parentId) return null;
  const parentIndex = steps.findIndex((s) => s.id === parentId);
  return parentIndex >= 0 && parentIndex < steps.indexOf(step) ? parentId : null;
}

/**
 * Checks the steps a Start task request leaves out against `workflow`, returning them de-duplicated
 * in workflow order. Refuses an unknown step id, a selection that skips every step, and a dependent
 * step left to run without the parent it depends on.
 */
export function resolveSkippedStepIds(workflow: WorkflowRecord, skippedStepIds: readonly string[] | undefined): string[] {
  if (!skippedStepIds?.length) return [];
  const requested = new Set(skippedStepIds);
  const unknown = [...requested].filter((id) => !workflow.steps.some((step) => step.id === id));
  if (unknown.length) throw new InvalidStepSelectionError(`skippedStepIds names steps that aren't in ${workflow.name}: ${unknown.join(', ')}`);
  if (workflow.steps.every((step) => requested.has(step.id))) throw new InvalidStepSelectionError('at least one step must run');
  for (const step of workflow.steps) {
    const parentId = stepParentId(workflow.steps, step);
    if (parentId && requested.has(parentId) && !requested.has(step.id)) {
      const parent = workflow.steps.find((s) => s.id === parentId)!;
      throw new InvalidStepSelectionError(`"${step.name}" depends on "${parent.name}", so it must be skipped too`);
    }
  }
  return workflow.steps.filter((step) => requested.has(step.id)).map((step) => step.id);
}
