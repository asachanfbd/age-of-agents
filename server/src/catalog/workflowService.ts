import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { CATALOG_WORKFLOWS_DIR } from '../config.ts';
import { QUICK_LOOK_KINDS } from '../domain/types.ts';
import type { ProjectRecord, QuickLookKind, WorkflowAgentConfig, WorkflowRecord, WorkflowStep } from '../domain/types.ts';
import { assertValidId, resolveWithinCatalogDir } from './paths.ts';
import { listAgents, listSkills } from './catalogService.ts';
import { listExecutors } from '../executors/executorService.ts';
import { projectsDb } from '../db/collections.ts';
import { named, namedAtStart } from '../domain/displayName.ts';
import { preloadSkillsProblem } from './skillPreload.ts';

/**
 * The Workflow Catalog (task 3.012): `catalog/workflows/<id>.json`, one file per WorkflowRecord —
 * format-compatible with nothing external (unlike agents/skills, there's no upstream "workflow
 * markdown" convention to mirror), but the same "hand-editable, read fresh every call" policy as the
 * rest of the Catalog (see catalogService.ts's doc comment). No sidecar index: a Workflow's
 * game-only fields (enabled, steps, etc.) already live directly in its own JSON.
 */

export class WorkflowNotFoundError extends Error {
  constructor() {
    super('This workflow is not in the Catalog — it may have been deleted');
    this.name = 'WorkflowNotFoundError';
  }
}

export class WorkflowAlreadyExistsError extends Error {
  constructor(existing: Pick<WorkflowRecord, 'name'>) {
    super(`${namedAtStart('workflow', existing.name)} already uses this id in the Catalog — choose a different id`);
    this.name = 'WorkflowAlreadyExistsError';
  }
}

export class InvalidWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkflowError';
  }
}

export class NoWorkflowAvailableError extends Error {
  constructor() {
    super('Catalog has no enabled workflow — create or enable one in catalog/workflows');
    this.name = 'NoWorkflowAvailableError';
  }
}

/** `catalog/workflows/software-development.json` — the seeded default (see the same file). Falls back to the first enabled workflow when this one is missing or disabled — see `getDefaultWorkflow`. */
export const DEFAULT_WORKFLOW_ID = 'software-development';

async function workflowFilePath(id: string): Promise<string> {
  assertValidId('workflow', id);
  return resolveWithinCatalogDir(CATALOG_WORKFLOWS_DIR, `${id}.json`, 'workflow id');
}

async function discoverWorkflowIds(): Promise<string[]> {
  try {
    const entries = await readdir(CATALOG_WORKFLOWS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readWorkflowFile(id: string): Promise<WorkflowRecord | undefined> {
  try {
    const raw = await readFile(await workflowFilePath(id), 'utf-8');
    return withoutLegacyWorkflowFields(JSON.parse(raw) as WorkflowRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Drops fields an older Workflow file may still carry — `requirementAnalysis`, the removed
 * hard-coded planning stage (requirement analysis now always happens in the planning session, whose
 * output is the item's description) — so it loads, and is rewritten clean on its next save.
 */
function withoutLegacyWorkflowFields(workflow: WorkflowRecord): WorkflowRecord {
  const { requirementAnalysis: _legacy, ...rest } = workflow as WorkflowRecord & { requirementAnalysis?: unknown };
  return rest;
}

async function writeWorkflowFile(workflow: WorkflowRecord): Promise<void> {
  await mkdir(CATALOG_WORKFLOWS_DIR, { recursive: true });
  await writeFile(await workflowFilePath(workflow.id), `${JSON.stringify(workflow, null, 2)}\n`, 'utf-8');
}

/** Every Workflow in the Catalog, in file-listing (alphabetical id) order — mirrors listAgents/listSkills. */
export async function listWorkflows(): Promise<WorkflowRecord[]> {
  const ids = await discoverWorkflowIds();
  const workflows = await Promise.all(ids.map((id) => readWorkflowFile(id)));
  return workflows.filter((w): w is WorkflowRecord => w !== undefined);
}

export async function getWorkflow(id: string): Promise<WorkflowRecord | undefined> {
  return readWorkflowFile(id);
}

async function requireWorkflow(id: string): Promise<WorkflowRecord> {
  const workflow = await getWorkflow(id);
  if (!workflow) throw new WorkflowNotFoundError();
  return workflow;
}

/**
 * The Workflow a new WorkflowRun uses when a Project has no explicit `workflowId` (or that
 * Workflow no longer exists/is disabled): `DEFAULT_WORKFLOW_ID` if it exists and is enabled,
 * otherwise the first enabled Workflow in listing order, otherwise undefined (an empty/disabled-only
 * Catalog — callers throw `NoWorkflowAvailableError`).
 */
export async function getDefaultWorkflow(): Promise<WorkflowRecord | undefined> {
  const workflows = await listWorkflows();
  const seeded = workflows.find((w) => w.id === DEFAULT_WORKFLOW_ID && w.enabled);
  if (seeded) return seeded;
  return workflows.find((w) => w.enabled);
}

/** The Workflow a Project's Tasks actually run through — its own `workflowId` when set and still valid/enabled, otherwise the Catalog default. Throws `NoWorkflowAvailableError` if neither resolves. */
export async function resolveWorkflowForProject(project: Pick<ProjectRecord, 'workflowId'>): Promise<WorkflowRecord> {
  if (project.workflowId) {
    const chosen = await getWorkflow(project.workflowId);
    if (chosen && chosen.enabled) return chosen;
  }
  const fallback = await getDefaultWorkflow();
  if (!fallback) throw new NoWorkflowAvailableError();
  return fallback;
}

/** A run-time, independent copy of a WorkflowRecord — used to freeze a WorkflowRunRecord.workflowSnapshot so a later Catalog edit never changes an in-flight run. */
export function snapshotWorkflow(workflow: WorkflowRecord): WorkflowRecord {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowRecord;
}

export interface WorkflowInput {
  id: string;
  name: string;
  description: string;
  enabled?: boolean;
  branchType?: string | null;
  steps: WorkflowStep[];
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (!value || !value.trim()) throw new InvalidWorkflowError(`${field} is required`);
  return value.trim();
}

interface ValidationCatalog {
  agentIds: Set<string>;
  skillIds: Set<string>;
  executorIds: Set<string>;
}

async function loadValidationCatalog(): Promise<ValidationCatalog> {
  const [agents, skills, executors] = await Promise.all([listAgents(), listSkills(), listExecutors()]);
  return {
    agentIds: new Set(agents.map((a) => a.id)),
    skillIds: new Set(skills.map((s) => s.id)),
    executorIds: new Set(executors.map((e) => e.id)),
  };
}

function validateAgentConfig(config: WorkflowAgentConfig, label: string, catalog: ValidationCatalog): void {
  if (!config || typeof config !== 'object') throw new InvalidWorkflowError(`${label} is required`);
  if (!catalog.agentIds.has(config.agentId)) throw new InvalidWorkflowError(`${label}: its agent is not in the Catalog`);
  if ((config.skillIds ?? []).some((skillId) => !catalog.skillIds.has(skillId))) {
    throw new InvalidWorkflowError(`${label}: one of its skills is not in the Catalog`);
  }
  const preloadProblem = preloadSkillsProblem(config.skillIds, config.preloadSkillIds);
  if (preloadProblem) throw new InvalidWorkflowError(`${label}: ${preloadProblem}`);
  if (config.executorId && !catalog.executorIds.has(config.executorId)) {
    throw new InvalidWorkflowError(`${label}: its executor is not configured`);
  }
  requireNonEmpty(config.instructions, `${label} instructions`);
}

/** A set `requestChangesToStepId` belongs on an approval step and names an earlier step; absent or null means unset. */
function validateRequestChangesTarget(step: WorkflowStep, index: number, steps: WorkflowStep[], label: string): void {
  const target = step.requestChangesToStepId;
  if (target === undefined || target === null) return;
  if (!step.requiresApproval) throw new InvalidWorkflowError(`${label}: only a step that requires approval can send Request changes back to an earlier step`);
  const targetIndex = typeof target === 'string' ? steps.findIndex((s) => s.id === target) : -1;
  if (targetIndex === -1 || targetIndex >= index) {
    throw new InvalidWorkflowError(`${label}: Request changes must go back to an earlier step`);
  }
}

/** A set `quickLook` is one of QUICK_LOOK_KINDS; absent or null means none. */
function validateQuickLook(step: WorkflowStep, label: string): void {
  const value = step.quickLook;
  if (value === undefined || value === null) return;
  if (!QUICK_LOOK_KINDS.includes(value as QuickLookKind)) {
    throw new InvalidWorkflowError(`${label}: quickLook must be one of ${QUICK_LOOK_KINDS.join(', ')}`);
  }
}

const BRANCH_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** A set `branchType` is a lowercase slug, safe as a git branch name's first segment; absent, null or blank means the default. */
function validateBranchType(branchType: unknown): void {
  if (branchType === undefined || branchType === null || branchType === '') return;
  if (typeof branchType !== 'string' || !BRANCH_TYPE_PATTERN.test(branchType)) {
    throw new InvalidWorkflowError('branchType must be lowercase letters, digits or -, starting with a letter or digit');
  }
}

/** A valid branch type, unique step ids, valid slugs, every referenced agent/skill/executor id resolves, every loopBack targets an earlier step with a sane round budget, every Request changes target is an earlier step, and every Quick look is a known kind. Throws InvalidWorkflowError (mapped to 400) on the first problem found. */
async function validateWorkflowInput(input: WorkflowInput): Promise<void> {
  assertValidId('workflow', input.id);
  requireNonEmpty(input.name, 'name');
  requireNonEmpty(input.description, 'description');
  validateBranchType(input.branchType);
  if (!Array.isArray(input.steps)) throw new InvalidWorkflowError('steps must be an array');
  if (input.steps.length === 0) throw new InvalidWorkflowError('steps must include at least one step');

  const catalog = await loadValidationCatalog();

  const seenIds = new Set<string>();
  input.steps.forEach((step, index) => {
    requireNonEmpty(step.name, `step ${index + 1} name`);
    const label = named('step', step.name);
    assertValidId(label, step.id);
    if (seenIds.has(step.id)) throw new InvalidWorkflowError(`${namedAtStart('step', step.name)} has the same id as an earlier step`);
    seenIds.add(step.id);
    if (typeof step.canEditCode !== 'boolean') throw new InvalidWorkflowError(`${label}: canEditCode must be a boolean`);
    if (step.canRunCommands !== undefined && typeof step.canRunCommands !== 'boolean') throw new InvalidWorkflowError(`${label}: canRunCommands must be a boolean`);
    if (typeof step.requiresApproval !== 'boolean') throw new InvalidWorkflowError(`${label}: requiresApproval must be a boolean`);
    validateAgentConfig(step, label, catalog);
    if (step.loopBack) {
      const targetIndex = input.steps.findIndex((s) => s.id === step.loopBack!.toStepId);
      if (targetIndex === -1 || targetIndex >= index) {
        throw new InvalidWorkflowError(`${label}: its loop must go back to an earlier step`);
      }
      if (!Number.isInteger(step.loopBack.maxRounds) || step.loopBack.maxRounds < 1 || step.loopBack.maxRounds > 10) {
        throw new InvalidWorkflowError(`${label}: its loop's maximum rounds must be an integer between 1 and 10`);
      }
    }
    validateRequestChangesTarget(step, index, input.steps, label);
    validateQuickLook(step, label);
  });
}

export async function createWorkflow(input: WorkflowInput): Promise<WorkflowRecord> {
  const existing = await getWorkflow(input.id);
  if (existing) throw new WorkflowAlreadyExistsError(existing);
  await validateWorkflowInput(input);
  const workflow: WorkflowRecord = {
    id: input.id,
    name: input.name.trim(),
    description: input.description.trim(),
    enabled: input.enabled ?? true,
    ...(input.branchType ? { branchType: input.branchType } : {}),
    steps: input.steps,
  };
  await writeWorkflowFile(workflow);
  return workflow;
}

export type UpdateWorkflowInput = Partial<Omit<WorkflowInput, 'id'>>;

export async function updateWorkflow(id: string, patch: UpdateWorkflowInput): Promise<WorkflowRecord> {
  const existing = await requireWorkflow(id);
  const next: WorkflowRecord = {
    ...existing,
    name: patch.name !== undefined ? requireNonEmpty(patch.name, 'name') : existing.name,
    description: patch.description !== undefined ? requireNonEmpty(patch.description, 'description') : existing.description,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    steps: patch.steps ?? existing.steps,
  };
  if (patch.branchType !== undefined) {
    if (patch.branchType) next.branchType = patch.branchType;
    else delete next.branchType;
  }
  await validateWorkflowInput(next);
  await writeWorkflowFile(next);
  return next;
}

/** Deletes a Workflow and resets every Project that had selected it back to the Catalog default (`workflowId` → null) — see ProjectRecord.workflowId's doc comment. */
export async function deleteWorkflow(id: string): Promise<void> {
  await requireWorkflow(id);
  const filePath = await workflowFilePath(id);
  await rm(filePath, { force: true });
  const referencing = await projectsDb.find((p) => p.workflowId === id);
  await Promise.all(referencing.map((p) => projectsDb.update(p.id, { workflowId: null })));
}

export { InvalidIdError, CatalogPathTraversalError } from './paths.ts';
