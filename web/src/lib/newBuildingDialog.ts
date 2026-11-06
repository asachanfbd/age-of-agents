import { SOFTWARE_LOOK, SOFTWARE_TYPE_ID } from './buildingTypes';
import type { ServerBuildingType } from './buildingTypes';

/** Shown until the daemon's list loads (or if it never does), so the dialog can always create a Software Building. */
export const BUILTIN_SOFTWARE_TYPE: ServerBuildingType = {
  id: SOFTWARE_TYPE_ID,
  name: 'Software',
  description: 'Build and ship code: tasks, planning, testing and pull requests.',
  category: 'Engineering',
  version: 1,
  repository: true,
  look: { ...SOFTWARE_LOOK },
  workspace: SOFTWARE_TYPE_ID,
  devOnly: false,
  hasStorage: false,
  slots: [],
  agents: [],
  tables: [],
  rollups: [],
};

/** The picker's types, or just the built-in Software entry when the daemon's list is empty or not loaded yet. */
export function withBuiltinFallback(types: ServerBuildingType[]): ServerBuildingType[] {
  return types.length ? types : [BUILTIN_SOFTWARE_TYPE];
}
