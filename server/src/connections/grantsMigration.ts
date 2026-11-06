import type { BuildingTypeDefinition } from '../buildings/contract.ts';
import { findCapability } from './rules.ts';
import type { BuildingLinkRecord } from './types.ts';

/**
 * Capabilities a later release switches on for links that already exist, by the `grantsVersion` that introduced them.
 * A link records the version it has been brought to, so a capability a person unchecks afterwards is never switched on again.
 * A capability added later is on for new links by default; whether it is added here is that task's decision.
 */
export const GRANT_MIGRATIONS: ReadonlyArray<{ version: number; capabilityIds: readonly string[] }> = [
  { version: 1, capabilityIds: ['get-task-details', 'list-completed-tasks'] },
];

export const CURRENT_GRANTS_VERSION = GRANT_MIGRATIONS[GRANT_MIGRATIONS.length - 1]!.version;

/**
 * The link brought up to date, or null when it already is. Adds only capabilities the target's type still offers;
 * every other grant, and each grant's pre-approval, stays as the person set it.
 */
export function migrateLinkGrants(link: BuildingLinkRecord, target: BuildingTypeDefinition | undefined): BuildingLinkRecord | null {
  const from = link.grantsVersion ?? 0;
  if (from >= CURRENT_GRANTS_VERSION) return null;
  const owned = new Set(link.capabilities.map((grant) => grant.capabilityId));
  const added = GRANT_MIGRATIONS.filter((step) => step.version > from)
    .flatMap((step) => step.capabilityIds)
    .filter((id) => !owned.has(id) && findCapability(target, id))
    .map((capabilityId) => ({ capabilityId, preApproved: false }));
  return { ...link, capabilities: [...link.capabilities, ...added], grantsVersion: CURRENT_GRANTS_VERSION };
}
