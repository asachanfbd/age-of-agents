import type { ProjectRecord } from '../domain/types.ts';
import { ownershipOf } from './ownership.ts';
import { hasBuildingType } from './registry.ts';
import './types/index.ts';

export const DEFAULT_TYPE_ID = 'software';

export type BuildingView<T extends ProjectRecord = ProjectRecord> = T & {
  typeId: string;
  typeVersion: number;
  ownerId: string;
  tenantId: string;
  typeUnavailable: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
};

/**
 * What a stored Project reads as. A record from before Building Types is a Software v1 Building owned by the local
 * user; one whose type is no longer registered keeps every field and is flagged read-only. Pure: the stored record is
 * not rewritten until its next save.
 */
export function normalizeProject<T extends ProjectRecord>(project: T): BuildingView<T> {
  const typeId = project.typeId ?? DEFAULT_TYPE_ID;
  const typeUnavailable = !hasBuildingType(typeId);
  const reason = typeUnavailable ? `The "${typeId}" Building type is no longer available.` : project.readOnlyReason ?? null;
  return {
    ...project,
    ...ownershipOf(project),
    typeId,
    typeVersion: project.typeVersion ?? 1,
    typeUnavailable,
    readOnly: reason !== null,
    readOnlyReason: reason,
  };
}

/** A change was attempted on a read-only Building (type unavailable, newer data, or a failed migration). */
export class BuildingReadOnlyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BuildingReadOnlyError';
  }
}

/** The one gate for work that would change a Building outside its own `/projects/:id` routes: starting Tasks, runs and planning sessions. */
export function assertWritable(project: ProjectRecord): void {
  const view = normalizeProject(project);
  if (view.readOnly) throw new BuildingReadOnlyError(view.readOnlyReason!);
}
