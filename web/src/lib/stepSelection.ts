import type { WorkflowStep } from './serverApi';

type SelectableStep = Pick<WorkflowStep, 'id' | 'name' | 'requiresApproval' | 'loopBack' | 'requestChangesToStepId'>;

/** Which of a workflow's steps the Start task dialog will run, and a note on each row a toggle changed as a side effect. */
export interface StepSelection {
  /** Checked step ids. */
  selected: string[];
  /** Step id → why a toggle of another row changed it ("Unchecked with Development"). */
  notes: Record<string, string>;
}

/**
 * The earlier step `step` depends on, or null: a looping review's loop target, or an approval
 * step's Request changes target. Only an earlier step counts, matching the daemon's
 * `stepParentId` (server/src/worker/stepSelection.ts), which enforces the same rules on start.
 */
export function stepParentId(steps: SelectableStep[], step: SelectableStep): string | null {
  const parentId = step.loopBack?.toStepId ?? (step.requiresApproval ? step.requestChangesToStepId : null);
  if (!parentId) return null;
  const parentIndex = steps.findIndex((s) => s.id === parentId);
  return parentIndex >= 0 && parentIndex < steps.indexOf(step) ? parentId : null;
}

/** Every step that depends on `stepId`, directly or through another dependent, in workflow order. */
export function stepDependents(steps: SelectableStep[], stepId: string): string[] {
  const dependents = new Set([stepId]);
  for (const step of steps) {
    const parentId = stepParentId(steps, step);
    if (parentId && dependents.has(parentId)) dependents.add(step.id);
  }
  dependents.delete(stepId);
  return [...dependents];
}

/** Every step checked, with no notes — how the dialog opens and what a workflow change resets to. */
export function initialStepSelection(steps: SelectableStep[]): StepSelection {
  return { selected: steps.map((step) => step.id), notes: {} };
}

/**
 * Toggles one step. Unchecking it also unchecks every step that depends on it; checking it also
 * checks every step it depends on, so a checked step never has an unchecked parent. Each row this
 * changes on the side gets a note; the toggled row's own note is cleared.
 */
export function toggleStepSelection(steps: SelectableStep[], selection: StepSelection, stepId: string): StepSelection {
  const step = steps.find((s) => s.id === stepId);
  if (!step) return selection;
  const selected = new Set(selection.selected);
  const notes = { ...selection.notes };
  delete notes[stepId];
  if (selected.has(stepId)) {
    selected.delete(stepId);
    for (const dependentId of stepDependents(steps, stepId)) {
      if (selected.delete(dependentId)) notes[dependentId] = `Unchecked with ${step.name}`;
    }
  } else {
    selected.add(stepId);
    for (let parentId = stepParentId(steps, step); parentId; parentId = stepParentId(steps, steps.find((s) => s.id === parentId)!)) {
      if (!selected.has(parentId)) {
        selected.add(parentId);
        notes[parentId] = `Checked for ${step.name}`;
      }
    }
  }
  return { selected: steps.filter((s) => selected.has(s.id)).map((s) => s.id), notes };
}

/** The unchecked steps, in workflow order — what the Start request sends as `skippedStepIds`. */
export function skippedStepIds(steps: SelectableStep[], selection: StepSelection): string[] {
  return steps.filter((step) => !selection.selected.includes(step.id)).map((step) => step.id);
}

/** A row's compact tag: "Approval", "Approval · changes → Development" or "Loops to Development"; null for a plain step. */
export function stepTag(step: SelectableStep, steps: SelectableStep[]): string | null {
  const parentName = (id: string | null) => steps.find((s) => s.id === id)?.name;
  if (step.loopBack) {
    const target = parentName(stepParentId(steps, step));
    if (target) return `Loops to ${target}`;
  }
  if (!step.requiresApproval) return null;
  const target = parentName(stepParentId(steps, step));
  return target ? `Approval · changes → ${target}` : 'Approval';
}

/** The Steps label's counter, e.g. "5 of 6". */
export function stepSelectionCount(steps: SelectableStep[], selection: StepSelection): string {
  return `${selection.selected.length} of ${steps.length}`;
}
