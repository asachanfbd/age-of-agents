/**
 * Building Types as the browser sees them (served by `GET /api/building-types`; the types themselves are coded on the
 * daemon, see docs/architecture.md#building-types). Pure helpers for the create flow, the read-only states, the 3D look
 * and the workspace to open, so the components stay thin and these rules are testable without a DOM.
 */

import type { CapabilityInfo, EventInfo } from './connections';

export interface ServerBuildingType {
  id: string;
  name: string;
  description: string;
  category: string;
  version: number;
  /** True when the type keeps a Git repository: only those get commit, push and pull-request features. */
  repository: boolean;
  look: { model: 'software' | 'generic'; color: string };
  workspace: string;
  devOnly: boolean;
  hasStorage: boolean;
  slots: Array<{ id: string; label: string; usedWhen: string; defaultWorkflowId: string }>;
  agents: Array<{ id: string; label: string; defaultAgentId: string }>;
  capabilities?: CapabilityInfo[];
  events?: EventInfo[];
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }>; sortable: string[]; filterable: string[]; searchable: string[] }>;
  rollups: Array<{ name: string; table: string; groupBy: string[]; measures: string[] }>;
}

/** What a Building reports about its type, as attached by the daemon to every project read. */
export interface BuildingTypeState {
  typeId?: string;
  typeUnavailable?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string | null;
}

export const SOFTWARE_TYPE_ID = 'software';
export const CONTENT_STUDIO_TYPE_ID = 'content-studio';
export const ALL_CATEGORIES = 'All';

/** Software's building exactly as it was before types existed: its body colour is the scene's own constant. */
export const SOFTWARE_LOOK = { model: 'software', color: '#7295ad' } as const;
export const GENERIC_LOOK_COLOR = '#8a94a6';

export function selectableTypes(types: ServerBuildingType[], devTypesEnabled: boolean): ServerBuildingType[] {
  return types.filter((t) => !t.devOnly || devTypesEnabled);
}

/** Software is the default whenever it is offered, otherwise the first type. */
export function defaultTypeId(types: ServerBuildingType[]): string | null {
  return types.find((t) => t.id === SOFTWARE_TYPE_ID)?.id ?? types[0]?.id ?? null;
}

export function typeCategories(types: ServerBuildingType[]): string[] {
  return [ALL_CATEGORIES, ...[...new Set(types.map((t) => t.category))].sort()];
}

/** Search (name and description, case-insensitive) and category combine as AND. */
export function filterTypes(types: ServerBuildingType[], query: string, category: string = ALL_CATEGORIES): ServerBuildingType[] {
  const needle = query.trim().toLowerCase();
  return types.filter((t) =>
    (category === ALL_CATEGORIES || t.category === category)
    && (!needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle)));
}

export function typeResultsLabel(shown: number, total: number): string {
  if (shown === 0) return 'No Building types match. Clear the search or pick another category.';
  return shown === total ? `${total} Building type${total === 1 ? '' : 's'}` : `${shown} of ${total} Building types`;
}

export interface CreateError { field: string | null; message: string }

/** Maps a failed create to the field it names (shown beside that input) or, with none, a dialog-level message. */
export function createErrorFor(error: unknown): CreateError {
  const details = (error as { details?: { field?: string; error?: string } } | null)?.details;
  const message = details?.error ?? (error instanceof Error ? error.message : 'Could not create the Building');
  return { field: typeof details?.field === 'string' ? details.field : null, message };
}

export type BuildingBadge = 'Type unavailable' | 'Migration failed' | 'Read-only' | null;

export function isBuildingReadOnly(building: BuildingTypeState): boolean {
  return building.readOnly === true || building.typeUnavailable === true;
}

export function buildingBadge(building: BuildingTypeState): BuildingBadge {
  if (building.typeUnavailable) return 'Type unavailable';
  if (!isBuildingReadOnly(building)) return null;
  return /^Migration .* failed/.test(building.readOnlyReason ?? '') ? 'Migration failed' : 'Read-only';
}

export function readOnlyNotice(building: BuildingTypeState): string | null {
  if (!isBuildingReadOnly(building)) return null;
  return building.readOnlyReason ?? 'This Building is read-only.';
}

export type WorkspaceKind = 'software' | 'notes' | 'seo' | 'crm' | 'content-studio' | 'unavailable';

/** Which workspace a Building click opens. A type the web does not know, or that the daemon no longer registers, opens the read-only shell. */
export function workspaceFor(building: BuildingTypeState): WorkspaceKind {
  if (building.typeUnavailable) return 'unavailable';
  const typeId = building.typeId ?? SOFTWARE_TYPE_ID;
  if (typeId === SOFTWARE_TYPE_ID) return 'software';
  if (typeId === 'notes') return 'notes';
  if (typeId === 'seo') return 'seo';
  if (typeId === 'crm') return 'crm';
  return typeId === CONTENT_STUDIO_TYPE_ID ? 'content-studio' : 'unavailable';
}

export interface BuildingLook { model: 'software' | 'generic'; color: string }

/** The 3D look for a Building: Software unchanged, any other type a generic building tinted with its type's colour. */
export function lookFor(building: BuildingTypeState, types: ServerBuildingType[]): BuildingLook {
  const typeId = building.typeId ?? SOFTWARE_TYPE_ID;
  if (typeId === SOFTWARE_TYPE_ID && !building.typeUnavailable) return { ...SOFTWARE_LOOK };
  const color = building.typeUnavailable ? undefined : types.find((t) => t.id === typeId)?.look.color;
  return { model: 'generic', color: color ?? GENERIC_LOOK_COLOR };
}

/** The fixed last row of a workflow's step list: the Complete stage commits, pushes and raises a PR only for a Building with a repository. */
export function completeStageLabel(hasRepository: boolean): string {
  return hasRepository ? 'Complete: commit, push, raise PR' : 'Complete: write the completion report';
}
