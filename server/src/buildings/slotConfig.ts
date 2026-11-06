import { getAgent } from '../catalog/catalogService.ts';
import { getWorkflow } from '../catalog/workflowService.ts';
import { buildingTypeConfigsDb } from '../db/collections.ts';
import type { SlotConfig, WorkflowRecord } from '../domain/types.ts';
import type { BuildingTypeDefinition, WorkflowSlot } from './contract.ts';
import { getBuildingType } from './registry.ts';
import './types/index.ts';

/** A bad type, slot, workflow, step or agent in a configuration request: always a 400/404 for the caller. */
export class SlotConfigError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SlotConfigError';
    this.status = status;
  }
}

export interface ResolvedStep {
  id: string;
  name: string;
  defaultAgentId: string;
  configuredAgentId: string | null;
  effectiveAgentId: string;
  /** The configured agent was deleted from the Catalog, so the step's own agent runs. */
  agentFellBack: boolean;
}

export interface ResolvedSlot {
  slot: WorkflowSlot;
  configuredWorkflowId: string | null;
  effectiveWorkflowId: string;
  /** The configured workflow no longer exists or is disabled, so the default runs. */
  fellBack: { configuredId: string; defaultId: string } | null;
  customised: boolean;
  workflow: { id: string; name: string; description: string } | null;
  steps: ResolvedStep[];
}

function requireType(typeId: string): BuildingTypeDefinition {
  const type = getBuildingType(typeId);
  if (!type) throw new SlotConfigError(`Unknown Building type "${typeId}"`, 404);
  return type;
}

function requireSlot(type: BuildingTypeDefinition, slotId: string): WorkflowSlot {
  const slot = type.slots.find((s) => s.id === slotId);
  if (!slot) throw new SlotConfigError(`"${type.name}" has no workflow slot "${slotId}"`, 404);
  return slot;
}

async function savedSlot(typeId: string, slotId: string): Promise<SlotConfig | undefined> {
  return (await buildingTypeConfigsDb.get(typeId))?.slots[slotId];
}

const usable = (w: WorkflowRecord | undefined): w is WorkflowRecord => w !== undefined && w.enabled;

async function resolveSlot(type: BuildingTypeDefinition, slot: WorkflowSlot): Promise<ResolvedSlot> {
  const saved = await savedSlot(type.id, slot.id);
  const configuredId = saved?.workflowId ?? null;
  const configured = configuredId ? await getWorkflow(configuredId) : undefined;
  const fellBack = configuredId && !usable(configured) ? { configuredId, defaultId: slot.defaultWorkflowId } : null;
  const workflow = configuredId && usable(configured) ? configured : await getWorkflow(slot.defaultWorkflowId);
  const effectiveWorkflowId = configuredId && usable(configured) ? configuredId : slot.defaultWorkflowId;

  const steps: ResolvedStep[] = [];
  for (const step of workflow?.steps ?? []) {
    const configuredAgentId = saved?.stepAgents[step.id] ?? null;
    const agentFellBack = configuredAgentId !== null && !(await getAgent(configuredAgentId));
    steps.push({
      id: step.id,
      name: step.name,
      defaultAgentId: step.agentId,
      configuredAgentId,
      effectiveAgentId: configuredAgentId && !agentFellBack ? configuredAgentId : step.agentId,
      agentFellBack,
    });
  }
  return {
    slot,
    configuredWorkflowId: configuredId,
    effectiveWorkflowId,
    fellBack,
    customised: configuredId !== null || Object.keys(saved?.stepAgents ?? {}).length > 0,
    workflow: workflow ? { id: workflow.id, name: workflow.name, description: workflow.description } : null,
    steps,
  };
}

export async function resolveTypeConfig(typeId: string): Promise<ResolvedSlot[]> {
  const type = requireType(typeId);
  return Promise.all(type.slots.map((slot) => resolveSlot(type, slot)));
}

export interface SlotChange {
  /** Omitted leaves the workflow as is; null returns to the default. Changing the workflow clears the slot's step agents. */
  workflowId?: string | null;
  /** Step id -> agent id; null returns that step to its own agent. */
  stepAgents?: Record<string, string | null>;
}

export async function setSlotConfig(typeId: string, slotId: string, change: SlotChange): Promise<ResolvedSlot[]> {
  const type = requireType(typeId);
  const slot = requireSlot(type, slotId);
  const current = (await savedSlot(typeId, slotId)) ?? { workflowId: null, stepAgents: {} };
  const next: SlotConfig = { workflowId: current.workflowId, stepAgents: { ...current.stepAgents } };

  if (change.workflowId !== undefined) {
    if (change.workflowId !== null && !usable(await getWorkflow(change.workflowId))) throw new SlotConfigError('workflowId must name an enabled Catalog workflow');
    if (change.workflowId !== next.workflowId) next.stepAgents = {};
    next.workflowId = change.workflowId;
  }
  if (change.stepAgents) {
    const workflowId = next.workflowId ?? slot.defaultWorkflowId;
    const stepIds = new Set((await getWorkflow(workflowId))?.steps.map((s) => s.id));
    for (const [stepId, agentId] of Object.entries(change.stepAgents)) {
      if (!stepIds.has(stepId)) throw new SlotConfigError(`"${stepId}" is not a step of the workflow for "${slot.label}"`);
      if (agentId === null) { delete next.stepAgents[stepId]; continue; }
      if (!(await getAgent(agentId))) throw new SlotConfigError(`agent "${agentId}" does not exist in the Catalog`);
      next.stepAgents[stepId] = agentId;
    }
  }
  await save(typeId, slotId, next);
  return resolveTypeConfig(typeId);
}

export async function resetSlotConfig(typeId: string, slotId: string): Promise<ResolvedSlot[]> {
  requireSlot(requireType(typeId), slotId);
  await save(typeId, slotId, null);
  return resolveTypeConfig(typeId);
}

async function save(typeId: string, slotId: string, value: SlotConfig | null): Promise<void> {
  const slots = { ...((await buildingTypeConfigsDb.get(typeId))?.slots ?? {}) };
  if (value) slots[slotId] = value; else delete slots[slotId];
  const record = { id: typeId, slots, updatedAt: new Date().toISOString() };
  if (await buildingTypeConfigsDb.get(typeId)) await buildingTypeConfigsDb.update(typeId, record);
  else await buildingTypeConfigsDb.insert(record);
}

/**
 * The workflow a run for this Building type uses when nothing more specific was asked for: its first slot's effective
 * workflow. Undefined when that workflow is not in the Catalog, so the caller falls back to the Catalog default.
 */
export async function primarySlotWorkflow(typeId: string): Promise<WorkflowRecord | undefined> {
  const slot = getBuildingType(typeId)?.slots[0];
  return slot ? slotWorkflow(typeId, slot.id) : undefined;
}

/** One slot's effective workflow, when the type has that slot and the workflow is in the Catalog and enabled. */
export async function slotWorkflow(typeId: string, slotId: string): Promise<WorkflowRecord | undefined> {
  const type = getBuildingType(typeId);
  const slot = type?.slots.find((candidate) => candidate.id === slotId);
  if (!type || !slot) return undefined;
  const resolved = await resolveSlot(type, slot);
  const workflow = await getWorkflow(resolved.effectiveWorkflowId);
  return usable(workflow) ? workflow : undefined;
}

/** A copy of the workflow with the per-step agent choices of the slot that runs it applied. Unchanged when nothing is configured. */
export async function withStepAgents(typeId: string, workflow: WorkflowRecord): Promise<WorkflowRecord> {
  const type = getBuildingType(typeId);
  if (!type) return workflow;
  for (const slot of type.slots) {
    const resolved = await resolveSlot(type, slot);
    if (resolved.effectiveWorkflowId !== workflow.id) continue;
    const overrides = new Map(resolved.steps.filter((s) => s.configuredAgentId && !s.agentFellBack).map((s) => [s.id, s.configuredAgentId!]));
    if (!overrides.size) return workflow;
    return { ...workflow, steps: workflow.steps.map((step) => (overrides.has(step.id) ? { ...step, agentId: overrides.get(step.id)! } : step)) };
  }
  return workflow;
}
