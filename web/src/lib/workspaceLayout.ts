import type { SettingsSection } from './settingsSections';

/**
 * The single declaration of the Project Workspace's top-level tabs. Everything else — the tab bars of every shell,
 * whether a tab's panel is drawn inside the read-only fieldset, the icons and the panels — derives from it.
 * Read "Workspace layout rules" in .docs/blueprint.md before changing it.
 *
 * `selfGuarded`: the panel handles the read-only state itself, so it must NOT be drawn inside the read-only fieldset
 * (a fieldset grows to fill the popup; an empty one pushes the real panel half way down).
 */
export const WORKSPACE_TABS = ['tasks', 'documents', 'testing', 'code', 'pr', 'settings', 'archived'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const TAB_DECLARATIONS: Record<WorkspaceTab, { label: string; selfGuarded: boolean }> = {
  tasks: { label: 'Tasks', selfGuarded: false },
  documents: { label: 'Documents', selfGuarded: false },
  testing: { label: 'Testing', selfGuarded: false },
  code: { label: 'Code', selfGuarded: false },
  pr: { label: 'PR', selfGuarded: false },
  settings: { label: 'Settings', selfGuarded: true },
  archived: { label: 'Archived', selfGuarded: false },
};

/** Tab values that used to be top-level tabs and now live in Settings; old links and stored values still resolve. */
const MOVED_TO_SETTINGS: Record<string, SettingsSection> = { schedules: 'schedules', connections: 'connections', activity: 'activity' };

/** Maps any tab value (current, moved or unknown) to a current tab, plus the Settings section it names, if any. */
export function normalizeWorkspaceTab(value: string | undefined): { tab: WorkspaceTab; section?: SettingsSection } {
  if (value && Object.hasOwn(MOVED_TO_SETTINGS, value)) return { tab: 'settings', section: MOVED_TO_SETTINGS[value] };
  return { tab: (WORKSPACE_TABS as readonly string[]).includes(value ?? '') ? (value as WorkspaceTab) : 'tasks' };
}

/** Whether the tab's panel is drawn inside the read-only fieldset. */
export function isWrappedInReadOnly(tab: WorkspaceTab): boolean {
  return !TAB_DECLARATIONS[tab].selfGuarded;
}

export interface WorkspaceTabSpec {
  key: WorkspaceTab;
  label: string;
  /** Present only where the visible label isn't the whole accessible name. */
  ariaLabel?: string;
}

/** The Notes workspace's tabs: the platform's Tasks, the type's own Notes screen (stored under 'documents') and Settings. */
export function notesTabs(): WorkspaceTabSpec[] {
  return [
    { key: 'tasks', label: TAB_DECLARATIONS.tasks.label },
    { key: 'documents', label: 'Notes' },
    { key: 'settings', label: TAB_DECLARATIONS.settings.label },
  ];
}

/** The tab to show: the requested one when the shell offers it, else Tasks. */
export function tabOrTasks(tab: WorkspaceTab, offered: WorkspaceTabSpec[]): WorkspaceTab {
  return offered.some((spec) => spec.key === tab) ? tab : 'tasks';
}

/** How a tab's panel is placed under the tab bar: not at all without a panel, bare when self-guarded, else inside the read-only fieldset. An empty fieldset is never an outcome. */
export function panelPlacement(tab: WorkspaceTab, hasPanel: boolean): 'none' | 'bare' | 'read-only-fieldset' {
  if (!hasPanel) return 'none';
  return isWrappedInReadOnly(tab) ? 'read-only-fieldset' : 'bare';
}
