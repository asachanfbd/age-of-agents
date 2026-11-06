import type { BuildingTypeDefinition } from './contract.ts';
import { declaredJobsProblem } from '../scheduler/declarations.ts';
import { validateStorageSpec } from './schema.ts';

const types = new Map<string, BuildingTypeDefinition>();

const TYPE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Throws naming the offending field when a definition does not satisfy the contract. */
export function assertValidDefinition(def: BuildingTypeDefinition): void {
  const fail = (field: string, why: string): never => {
    throw new Error(`Building type "${def?.id ?? '?'}": ${field} ${why}`);
  };
  if (typeof def?.id !== 'string' || !TYPE_ID.test(def.id)) fail('id', 'must be lowercase kebab-case');
  if (!def.name?.trim()) fail('name', 'is required');
  if (!def.description?.trim()) fail('description', 'is required');
  if (!Number.isInteger(def.version) || def.version < 1) fail('version', 'must be a positive integer');
  if (typeof def.validateCreate !== 'function') fail('validateCreate', 'is required');
  if (!def.look?.color) fail('look', 'is required');
  if (!def.workspace) fail('workspace', 'is required');
  if (!Array.isArray(def.slots)) fail('slots', 'must be an array');
  const slotIds = new Set<string>();
  for (const slot of def.slots) {
    if (slotIds.has(slot.id)) fail('slots', `has a duplicate slot id "${slot.id}"`);
    slotIds.add(slot.id);
    if (!slot.defaultWorkflowId) fail('slots', `slot "${slot.id}" needs a defaultWorkflowId`);
  }
  for (const key of ['agents', 'scheduledJobs', 'capabilities', 'events'] as const) {
    if (!Array.isArray(def[key])) fail(key, 'must be an array (empty is fine)');
  }
  const capabilityIds = new Set<string>();
  for (const capability of def.capabilities) {
    if (typeof capability?.id !== 'string' || !capability.id) fail('capabilities', 'has a capability without an id');
    if (capabilityIds.has(capability.id)) fail('capabilities', `has a duplicate capability id "${capability.id}"`);
    capabilityIds.add(capability.id);
    if (capability.mode !== 'read' && capability.mode !== 'write') fail('capabilities', `capability "${capability.id}" needs a mode of "read" or "write"`);
    if (!Array.isArray(capability.inputs) || !Array.isArray(capability.outputs)) fail('capabilities', `capability "${capability.id}" must declare its inputs and outputs`);
  }
  const eventIds = new Set<string>();
  for (const event of def.events) {
    if (typeof event?.id !== 'string' || !event.id) fail('events', 'has an event without an id');
    if (eventIds.has(event.id)) fail('events', `has a duplicate event id "${event.id}"`);
    eventIds.add(event.id);
  }
  const jobsProblem = declaredJobsProblem(def.scheduledJobs, def.slots);
  if (jobsProblem) fail('scheduledJobs', jobsProblem);
  if (def.storage) {
    try { validateStorageSpec(def.storage); } catch (error) { fail('storage', (error as Error).message); }
    const migrationVersions = def.storage.migrations.map((m) => m.toVersion);
    if (migrationVersions.some((v, i) => v !== i + 2)) fail('storage.migrations', 'must step 2, 3, ... with no gaps');
    if (def.version !== 1 + migrationVersions.length) fail('version', 'must equal 1 + the number of storage migrations');
  }
}

export function registerBuildingType(def: BuildingTypeDefinition): void {
  assertValidDefinition(def);
  if (types.has(def.id)) throw new Error(`Building type "${def.id}" is already registered`);
  types.set(def.id, def);
}

export function getBuildingType(id: string): BuildingTypeDefinition | undefined {
  return types.get(id);
}

export function hasBuildingType(id: string): boolean {
  return types.has(id);
}

/** Registration order, which puts Software first. */
export function listBuildingTypes(): BuildingTypeDefinition[] {
  return [...types.values()];
}

/** Test seam: drops a registered type (e.g. to simulate one no longer being registered). */
export function unregisterBuildingType(id: string): void {
  types.delete(id);
}

export function devTypesEnabled(): boolean {
  return process.env.AGENT_VISUAL_OS_DEV_TYPES === '1';
}
