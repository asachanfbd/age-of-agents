/** Pure view logic for the Catalog's Building Types section: what a slot card shows once the person's unsaved edits are laid over the saved configuration. */
import type { CatalogAgent, WorkflowRecord } from './serverApi';
import { editStepAgent, editWorkflow } from './typeConfig';
import type { ConfigSlot, SlotEdit } from './typeConfig';

export interface StepView { id: string; name: string; defaultAgentId: string; agentId: string; customised: boolean }

/** Enabled items, plus the one currently chosen even if it has since been disabled, so a selection never silently vanishes. */
export function enabledOptions<T extends { id: string; enabled: boolean }>(items: T[], selectedId: string): T[] {
  const enabled = items.filter((i) => i.enabled);
  const selected = items.find((i) => i.id === selectedId);
  return selected && !selected.enabled ? [...enabled, selected] : enabled;
}

/** The workflow the slot would use if the edits were saved. */
export function draftWorkflowId(slot: ConfigSlot, edit: SlotEdit | undefined): string {
  if (edit?.workflowId === undefined) return slot.effectiveWorkflowId;
  return edit.workflowId ?? slot.slot.defaultWorkflowId;
}

/** The dropdown value maps back to an edit: the built-in workflow is "no choice" (null). */
export function workflowIdToEdit(slot: ConfigSlot, workflowId: string): string | null {
  return workflowId === slot.slot.defaultWorkflowId ? null : workflowId;
}

/** Picking the workflow the slot already uses drops the edit entirely, so the saved agent choices stay. */
export function pickWorkflow(edits: Record<string, SlotEdit>, slot: ConfigSlot, workflowId: string): Record<string, SlotEdit> {
  if (workflowId === slot.effectiveWorkflowId) {
    const { [slot.slot.id]: _dropped, ...rest } = edits;
    return rest;
  }
  return editWorkflow(edits, slot.slot.id, workflowIdToEdit(slot, workflowId));
}

/** A step's agent choice maps back to an edit: the step's own agent is "no choice" (null). */
export function agentIdToEdit(defaultAgentId: string, agentId: string): string | null {
  return agentId === defaultAgentId ? null : agentId;
}

export function pickStepAgent(edits: Record<string, SlotEdit>, slotId: string, step: { id: string; defaultAgentId: string }, agentId: string): Record<string, SlotEdit> {
  return editStepAgent(edits, slotId, step.id, agentIdToEdit(step.defaultAgentId, agentId));
}

/** The steps the card shows: the saved ones while the workflow is unchanged, otherwise the newly chosen workflow's own steps. */
export function draftSteps(slot: ConfigSlot, edit: SlotEdit | undefined, workflows: WorkflowRecord[]): StepView[] {
  const stepAgents = edit?.stepAgents ?? {};
  const workflowChanged = draftWorkflowId(slot, edit) !== slot.effectiveWorkflowId;
  const base = workflowChanged
    ? (workflows.find((w) => w.id === draftWorkflowId(slot, edit))?.steps ?? []).map((s) => ({ id: s.id, name: s.name, defaultAgentId: s.agentId, configured: null as string | null }))
    : slot.steps.map((s) => ({ id: s.id, name: s.name, defaultAgentId: s.defaultAgentId, configured: s.configuredAgentId }));
  return base.map((s) => {
    const agentId = s.id in stepAgents ? (stepAgents[s.id] ?? s.defaultAgentId) : (s.configured ?? s.defaultAgentId);
    return { id: s.id, name: s.name, defaultAgentId: s.defaultAgentId, agentId, customised: agentId !== s.defaultAgentId };
  });
}

/** Name and description of the workflow the card is showing. */
export function draftWorkflowInfo(slot: ConfigSlot, edit: SlotEdit | undefined, workflows: WorkflowRecord[]): { name: string; description: string } {
  const id = draftWorkflowId(slot, edit);
  const record = workflows.find((w) => w.id === id);
  if (record) return { name: record.name, description: record.description };
  if (slot.workflow && slot.workflow.id === id) return { name: slot.workflow.name, description: slot.workflow.description };
  return { name: id, description: '' };
}

export function agentNameOf(agents: CatalogAgent[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id;
}

export function workflowNameOf(workflows: WorkflowRecord[], id: string): string {
  return workflows.find((w) => w.id === id)?.name ?? id;
}

/** What goes over the wire for one edited slot: empty step maps are left out. */
export function slotPayload(edit: SlotEdit): SlotEdit {
  const payload: SlotEdit = {};
  if (edit.workflowId !== undefined) payload.workflowId = edit.workflowId;
  if (edit.stepAgents && Object.keys(edit.stepAgents).length > 0) payload.stepAgents = edit.stepAgents;
  return payload;
}

/** Edits left once the named slots have been saved. */
export function withoutSlots(edits: Record<string, SlotEdit>, slotIds: string[]): Record<string, SlotEdit> {
  return Object.fromEntries(Object.entries(edits).filter(([id]) => !slotIds.includes(id)));
}

export const NO_REPOSITORY_NOTE = 'This type has no Git repository, so commit, push and pull-request features are repository-only and do not apply to it.';

export const HOW_IT_WORKS = [
  'Workflows are the ordered steps a task goes through, such as plan, build and review.',
  'Agents are who does each step. Every step starts with the workflow\'s own agent; change it per step if you want a different one.',
  'These choices belong to the Building type, not to one Building: every Building of this type uses them.',
];
