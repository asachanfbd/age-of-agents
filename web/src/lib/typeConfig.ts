/** View-model for the Catalog's Building Types section: per type, which workflow fills each slot and which agent runs each step. */

export interface ConfigStep { id: string; name: string; defaultAgentId: string; configuredAgentId: string | null; effectiveAgentId: string; agentFellBack: boolean }
export interface ConfigSlot {
  slot: { id: string; label: string; usedWhen: string; defaultWorkflowId: string };
  configuredWorkflowId: string | null;
  effectiveWorkflowId: string;
  fellBack: { configuredId: string; defaultId: string } | null;
  customised: boolean;
  workflow: { id: string; name: string; description: string } | null;
  steps: ConfigStep[];
}

/** The person's unsaved choices for one slot: undefined fields are unchanged. */
export interface SlotEdit { workflowId?: string | null; stepAgents?: Record<string, string | null> }

export function slotBadge(slot: ConfigSlot): 'Default' | 'Customised' {
  return slot.customised ? 'Customised' : 'Default';
}

export function fallbackNotice(slot: ConfigSlot, workflowName: (id: string) => string): string | null {
  if (!slot.fellBack) return null;
  return `The workflow chosen for this slot (${slot.fellBack.configuredId}) is no longer in the Catalog, so ${workflowName(slot.fellBack.defaultId)} is used instead.`;
}

export function stepAgentNotice(step: ConfigStep): string | null {
  return step.agentFellBack ? `The agent chosen for this step is no longer in the Catalog, so ${step.defaultAgentId} runs it.` : null;
}

/** Picking a different workflow drops the slot's step assignments; the screen says so before it happens. */
export function workflowChangeWarning(slot: ConfigSlot, nextWorkflowId: string | null): string | null {
  const next = nextWorkflowId ?? slot.slot.defaultWorkflowId;
  const hasAssignments = slot.steps.some((s) => s.configuredAgentId !== null);
  return next !== slot.effectiveWorkflowId && hasAssignments ? 'Changing the workflow clears the agents you chose for its steps.' : null;
}

export function isDirty(edits: Record<string, SlotEdit>): boolean {
  return Object.values(edits).some((e) => e.workflowId !== undefined || Object.keys(e.stepAgents ?? {}).length > 0);
}

/** Only the slots with a change are sent. */
export function changedSlots(edits: Record<string, SlotEdit>): Array<[string, SlotEdit]> {
  return Object.entries(edits).filter(([, e]) => e.workflowId !== undefined || Object.keys(e.stepAgents ?? {}).length > 0);
}

/** Setting every step to one agent ("Set all steps to…"). */
export function allStepsTo(slot: ConfigSlot, agentId: string | null): Record<string, string | null> {
  return Object.fromEntries(slot.steps.map((s) => [s.id, agentId === s.defaultAgentId ? null : agentId]));
}

export function editWorkflow(edits: Record<string, SlotEdit>, slotId: string, workflowId: string | null): Record<string, SlotEdit> {
  return { ...edits, [slotId]: { workflowId, stepAgents: {} } };
}

export function editStepAgent(edits: Record<string, SlotEdit>, slotId: string, stepId: string, agentId: string | null): Record<string, SlotEdit> {
  const current = edits[slotId] ?? {};
  return { ...edits, [slotId]: { ...current, stepAgents: { ...current.stepAgents, [stepId]: agentId } } };
}

export const APPLIES_TO_NEW_RUNS = 'Changes apply to new runs of every Building of this type. Runs already in progress keep the workflow they started with.';
