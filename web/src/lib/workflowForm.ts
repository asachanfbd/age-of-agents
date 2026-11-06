/**
 * Pure helpers behind CatalogModal's Workflows tab (web/src/ui/CatalogModal.tsx#WorkflowsTab) — kept
 * as standalone functions, not component-internal logic, same rationale as catalogForm.ts's own doc
 * comment: this repo has no component-rendering test infrastructure (no jsdom/testing-library) to
 * reach into CatalogModal.tsx itself, so the editor's shaping/validation logic lives here instead,
 * covered by plain `node:test` unit tests (web/tests/workflowForm.test.mjs).
 */

import { isValidCatalogId } from './catalogForm';
import type { CatalogAgent, CatalogSkill, QuickLookKind, UpdateWorkflowInput, WorkflowAgentConfig, WorkflowInput, WorkflowRecord, WorkflowStep } from './serverApi';

/** A step's agent-config block's form fields — `executorId` uses `''` for "no override (use the run's own executor)", never `undefined`, so it's a plain controlled input value. */
export interface AgentConfigFields {
  agentId: string;
  skillIds: string[];
  /** The subset of `skillIds` loaded in full every run ("Always load"); the rest load on demand. */
  preloadSkillIds: string[];
  executorId: string;
  instructions: string;
}

export function emptyAgentConfig(): AgentConfigFields {
  return { agentId: '', skillIds: [], preloadSkillIds: [], executorId: '', instructions: '' };
}

/** Prefills an AgentConfigFields from a WorkflowStep read from the server. */
export function agentConfigFromRecord(config: WorkflowAgentConfig): AgentConfigFields {
  return {
    agentId: config.agentId,
    skillIds: config.skillIds ?? [],
    preloadSkillIds: config.preloadSkillIds ?? [],
    executorId: config.executorId ?? '',
    instructions: config.instructions,
  };
}

/** One `steps` row's form fields. `isNew`/`idTouched` drive the same "typing the name suggests an id, until you edit it yourself" behaviour as `useSlugFollowingId` — id stays editable only while `isNew`. */
export interface StepFields extends AgentConfigFields {
  id: string;
  name: string;
  canEditCode: boolean;
  canRunCommands: boolean;
  requiresApproval: boolean;
  isNew: boolean;
  idTouched: boolean;
  loopBackEnabled: boolean;
  loopBackToStepId: string;
  /** Raw textbox value — validated/parsed to an integer 1-10 by `validateWorkflowForm`/`toWorkflowStep`. */
  loopBackMaxRounds: string;
  /** Only saved while `requiresApproval` is on — see WorkflowStep.requestChangesToStepId. */
  requestChangesEnabled: boolean;
  requestChangesToStepId: string;
  quickLook: QuickLookKind;
}

export function emptyStep(): StepFields {
  return {
    id: '',
    name: '',
    canEditCode: false,
    canRunCommands: false,
    requiresApproval: false,
    isNew: true,
    idTouched: false,
    loopBackEnabled: false,
    loopBackToStepId: '',
    loopBackMaxRounds: '3',
    requestChangesEnabled: false,
    requestChangesToStepId: '',
    quickLook: 'none',
    ...emptyAgentConfig(),
  };
}

/** Prefills a StepFields from a WorkflowStep read from the server — never editable-id (`isNew: false`). */
export function stepFromRecord(step: WorkflowStep): StepFields {
  return {
    ...agentConfigFromRecord(step),
    id: step.id,
    name: step.name,
    canEditCode: step.canEditCode,
    canRunCommands: step.canRunCommands === true,
    requiresApproval: step.requiresApproval,
    isNew: false,
    idTouched: true,
    loopBackEnabled: !!step.loopBack,
    loopBackToStepId: step.loopBack?.toStepId ?? '',
    loopBackMaxRounds: String(step.loopBack?.maxRounds ?? 3),
    requestChangesEnabled: !!step.requestChangesToStepId,
    requestChangesToStepId: step.requestChangesToStepId ?? '',
    quickLook: step.quickLook ?? 'none',
  };
}

/** The whole editor's field state, independent of whether it's about to create or patch a WorkflowRecord. */
export interface WorkflowFormFields {
  name: string;
  description: string;
  enabled: boolean;
  /** `''` means runs are named `feature/…` — see WorkflowRecord.branchType. */
  branchType: string;
  steps: StepFields[];
}

export function emptyWorkflowFields(): WorkflowFormFields {
  return { name: '', description: '', enabled: true, branchType: '', steps: [] };
}

export function workflowFieldsFromRecord(workflow: WorkflowRecord): WorkflowFormFields {
  return {
    name: workflow.name,
    description: workflow.description,
    enabled: workflow.enabled,
    branchType: workflow.branchType ?? '',
    steps: workflow.steps.map(stepFromRecord),
  };
}

// ---- Step list editing (add/remove/reorder) ----

export function addStep(steps: StepFields[]): StepFields[] {
  return [...steps, emptyStep()];
}

/**
 * Splices out the step at `index`. Any later step whose loop-back or Request changes target was the
 * removed step has that setting cleared client-side first — the target id is about to become
 * invalid, the same rule `validateWorkflowForm` would otherwise reject the whole form for.
 */
export function removeStep(steps: StepFields[], index: number): StepFields[] {
  const removedId = steps[index]?.id;
  return steps
    .filter((_, i) => i !== index)
    .map((step) => (step.loopBackEnabled && step.loopBackToStepId === removedId ? { ...step, loopBackEnabled: false, loopBackToStepId: '' } : step))
    .map((step) => (step.requestChangesEnabled && step.requestChangesToStepId === removedId ? { ...step, requestChangesEnabled: false, requestChangesToStepId: '' } : step));
}

/** Swaps the step at `index` with its neighbour `delta` positions away (`-1` up, `1` down); a no-op if that neighbour doesn't exist. */
export function moveStep(steps: StepFields[], index: number, delta: -1 | 1): StepFields[] {
  const target = index + delta;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** The steps a loop-back or Request changes target at `index` may name — strictly earlier steps only, per WorkflowStep.loopBack's doc comment. */
export function earlierSteps(steps: StepFields[], index: number): StepFields[] {
  return steps.slice(0, index);
}

// ---- Picker options (keeps a step's already-chosen agent/skill visible even if it's since been disabled) ----

export function agentOptionsFor(catalogAgents: CatalogAgent[], selectedId: string): CatalogAgent[] {
  const enabled = catalogAgents.filter((a) => a.enabled);
  if (!selectedId || enabled.some((a) => a.id === selectedId)) return enabled;
  const selected = catalogAgents.find((a) => a.id === selectedId);
  return selected ? [...enabled, selected] : enabled;
}

export function skillOptionsFor(catalogSkills: CatalogSkill[], selectedIds: string[]): CatalogSkill[] {
  const enabled = catalogSkills.filter((s) => s.enabled);
  const missing = selectedIds
    .filter((id) => !enabled.some((s) => s.id === id))
    .map((id) => catalogSkills.find((s) => s.id === id))
    .filter((s): s is CatalogSkill => s !== undefined);
  return [...enabled, ...missing];
}

// ---- Executor-override select's sentinel value (Radix Select rejects an empty-string item value) ----

export const DEFAULT_EXECUTOR_VALUE = '__task_worker__';
export function executorSelectValue(executorId: string): string {
  return executorId.trim() === '' ? DEFAULT_EXECUTOR_VALUE : executorId;
}
export function executorFieldValue(selectValue: string): string {
  return selectValue === DEFAULT_EXECUTOR_VALUE ? '' : selectValue;
}

// ---- Skill picker ----

/** Ticks or unticks a skill. Unticking also drops it from "Always load"; a re-ticked skill starts on demand. */
export function withSkillSelected<T extends AgentConfigFields>(fields: T, skillId: string, selected: boolean): T {
  if (selected) return fields.skillIds.includes(skillId) ? fields : { ...fields, skillIds: [...fields.skillIds, skillId] };
  return {
    ...fields,
    skillIds: fields.skillIds.filter((id) => id !== skillId),
    preloadSkillIds: fields.preloadSkillIds.filter((id) => id !== skillId),
  };
}

/** Turns "Always load" on or off for a ticked skill; a skill that isn't ticked is left alone. */
export function withSkillPreload<T extends AgentConfigFields>(fields: T, skillId: string, preload: boolean): T {
  if (!fields.skillIds.includes(skillId)) return fields;
  const others = fields.preloadSkillIds.filter((id) => id !== skillId);
  return { ...fields, preloadSkillIds: preload ? [...others, skillId] : others };
}

// ---- Building the server payload ----

export function toWorkflowAgentConfig(fields: AgentConfigFields): WorkflowAgentConfig {
  const config: WorkflowAgentConfig = { agentId: fields.agentId.trim(), instructions: fields.instructions.trim() };
  if (fields.skillIds.length > 0) {
    config.skillIds = fields.skillIds;
    const preload = fields.preloadSkillIds.filter((id) => fields.skillIds.includes(id));
    if (preload.length > 0) config.preloadSkillIds = preload;
  }
  if (fields.executorId.trim() !== '') config.executorId = fields.executorId.trim();
  return config;
}

export function toWorkflowStep(fields: StepFields): WorkflowStep {
  const step: WorkflowStep = {
    ...toWorkflowAgentConfig(fields),
    id: fields.id.trim(),
    name: fields.name.trim(),
    canEditCode: fields.canEditCode,
    canRunCommands: fields.canRunCommands,
    requiresApproval: fields.requiresApproval,
    quickLook: fields.quickLook,
  };
  if (fields.loopBackEnabled) {
    step.loopBack = { toStepId: fields.loopBackToStepId, maxRounds: Number.parseInt(fields.loopBackMaxRounds, 10) };
  }
  if (fields.requiresApproval && fields.requestChangesEnabled) step.requestChangesToStepId = fields.requestChangesToStepId;
  return step;
}

export function buildCreateWorkflowInput(id: string, fields: WorkflowFormFields): WorkflowInput {
  const input: WorkflowInput = {
    id: id.trim(),
    name: fields.name.trim(),
    description: fields.description.trim(),
    enabled: fields.enabled,
    steps: fields.steps.map(toWorkflowStep),
  };
  if (fields.branchType.trim() !== '') input.branchType = fields.branchType.trim();
  return input;
}

/** A WorkflowRecord's read shape always returns every field (unlike CatalogAgent/CatalogSkill's body/description), so the edit form starts genuinely pre-filled and this always sends everything back — no "leave blank to keep" carve-out needed. */
export function buildUpdateWorkflowPatch(fields: WorkflowFormFields): UpdateWorkflowInput {
  return {
    name: fields.name.trim(),
    description: fields.description.trim(),
    enabled: fields.enabled,
    branchType: fields.branchType.trim() || null,
    steps: fields.steps.map(toWorkflowStep),
  };
}

// ---- Validation (mirrors server/src/catalog/workflowService.ts's validateWorkflowInput, so a client mistake is caught before the round trip) ----

const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BRANCH_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isValidMaxRounds(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 && n <= 10;
}

function validateAgentConfig(fields: AgentConfigFields, label: string): string | null {
  if (fields.agentId.trim() === '') return `${label} needs an agent.`;
  if (fields.instructions.trim() === '') return `${label} needs instructions.`;
  return null;
}

/**
 * Returns the first validation failure as a user-facing message, or `null` when the form is ready to
 * save. `isNew`/`id` are only relevant for a create (an existing WorkflowRecord's id is fixed).
 */
export function validateWorkflowForm(fields: WorkflowFormFields, isNew: boolean, id: string): string | null {
  if (isNew && !isValidCatalogId(id)) return 'Id must start with a letter or digit, then only letters, digits, - or _.';
  if (fields.name.trim() === '') return 'Workflow name is required.';
  if (fields.description.trim() === '') return 'Description is required.';
  if (fields.branchType.trim() !== '' && !BRANCH_TYPE_PATTERN.test(fields.branchType.trim())) {
    return 'Branch type must be lowercase letters, digits or -, starting with a letter or digit.';
  }
  if (fields.steps.length === 0) return 'A workflow needs at least one step.';

  const seenIds = new Set<string>();
  for (const [index, step] of fields.steps.entries()) {
    const stepLabel = `Step ${index + 1}`;
    if (step.name.trim() === '') return `${stepLabel} needs a name.`;
    if (!STEP_ID_PATTERN.test(step.id.trim())) return `${stepLabel} needs an id (letters, digits, - or _, starting with a letter or digit).`;
    if (seenIds.has(step.id.trim())) return `Step id "${step.id.trim()}" is used more than once.`;
    seenIds.add(step.id.trim());

    const agentError = validateAgentConfig(step, stepLabel);
    if (agentError) return agentError;

    if (step.loopBackEnabled) {
      const earlierIds = earlierSteps(fields.steps, index).map((s) => s.id.trim());
      if (!earlierIds.includes(step.loopBackToStepId)) return `${stepLabel}'s loop-back must target an earlier step.`;
      if (!isValidMaxRounds(step.loopBackMaxRounds)) return `${stepLabel}'s loop-back rounds must be a whole number from 1 to 10.`;
    }

    if (step.requiresApproval && step.requestChangesEnabled) {
      const earlierIds = earlierSteps(fields.steps, index).map((s) => s.id.trim());
      if (!earlierIds.includes(step.requestChangesToStepId)) return `${stepLabel}: Request changes must go back to an earlier step.`;
    }
  }
  return null;
}
