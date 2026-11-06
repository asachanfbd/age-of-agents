import { ApiError } from './serverApi';
import { isBuildingReadOnly, type BuildingTypeState } from './buildingTypes';

export const PROJECT_NAME_MAX = 80;
export const READ_ONLY_NOTICE = "Read-only: this Building's type is unavailable, so it can't be renamed or deleted.";
export const NAME_HINT = 'The folder name stays the same.';

/** Save is offered for a changed, non-empty name while no save is under way. */
export function canSaveName(value: string, current: string, saving: boolean): boolean {
  const trimmed = value.trim();
  return !saving && trimmed !== '' && trimmed !== current;
}

/** Delete needs the project's full name typed exactly (case-sensitive, surrounding spaces ignored). */
export function canConfirmDelete(typed: string, name: string): boolean {
  return typed.trim() === name;
}

/** Why the General section's actions are disabled, or null when they are available. */
export function readOnlyReason(project: BuildingTypeState): string | null {
  return isBuildingReadOnly(project) ? READ_ONLY_NOTICE : null;
}

export type DeleteFailure = { mode: 'locked' | 'retry'; message: string };

/** A running task (409) leaves nothing to retry, so the dialog offers only Close; any other failure keeps Delete available. */
export function deleteFailureOf(error: unknown): DeleteFailure {
  const message = error instanceof Error ? error.message : 'Could not delete the project.';
  return { mode: error instanceof ApiError && error.status === 409 ? 'locked' : 'retry', message };
}
