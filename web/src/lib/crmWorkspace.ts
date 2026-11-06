/** Pure view-model for the CRM Building's workspace: the tab list, the contact panel state and the read-only rule. */

export const CRM_TABS = [
  { key: 'calendar', label: 'Calendar', title: ['Followup', 'Calendar'] },
  { key: 'prospects', label: 'Prospects', title: ['Prospect', 'Pipeline'] },
  { key: 'customers', label: 'Customers', title: ['Customer', 'Directory'] },
  { key: 'lost', label: 'Lost', title: ['Lost', 'Contacts'] },
  { key: 'import', label: 'Import', title: ['Import', 'Contacts'] },
  { key: 'merge', label: 'Merge', title: ['Merge', 'Duplicates'] },
  { key: 'notes', label: 'Notes (MOM)', title: ['Meeting', 'Notes'] },
  { key: 'reports', label: 'Reports', title: ['Outreach', 'Reports'] },
  { key: 'settings', label: 'Settings', title: ['CRM', 'Settings'] },
] as const satisfies ReadonlyArray<{ key: string; label: string; title: readonly [string, string] }>;
export type CrmTab = (typeof CRM_TABS)[number]['key'];
export const DEFAULT_CRM_TAB: CrmTab = 'calendar';

/** The contact opens in place of the tab area that listed it (with a back button), never as a tab of its own. */
export interface WorkspaceState { tab: CrmTab; contactId: number | null }
export const initialWorkspace = (): WorkspaceState => ({ tab: DEFAULT_CRM_TAB, contactId: null });
export const openContact = (s: WorkspaceState, contactId: number): WorkspaceState => ({ ...s, contactId });
export const closeContact = (s: WorkspaceState): WorkspaceState => ({ ...s, contactId: null });
/** Switching tabs closes the contact: it belongs to the list it was opened from. */
export const selectTab = (s: WorkspaceState, tab: CrmTab): WorkspaceState => ({ tab, contactId: tab === s.tab ? s.contactId : null });

/** Every control that changes data is disabled in a read-only Building; history stays readable. */
export const crmControlsDisabled = (readOnly: boolean): boolean => readOnly;
export const READ_ONLY_TITLE = 'This Building is read-only';
export const disabledTitle = (readOnly: boolean, fallback = ''): string => (readOnly ? READ_ONLY_TITLE : fallback);
