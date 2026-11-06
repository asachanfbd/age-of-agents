import type { ConceptTab } from './contentRules';

/**
 * The Content Studio Building's tabs. Every panel guards its own read-only state through its `readOnly` prop (it keeps
 * history, lists and downloads readable), so none is drawn inside the read-only fieldset.
 * Read "Workspace layout rules" in .docs/blueprint.md before changing it.
 */
export const CONTENT_TABS = [
  { key: 'content', label: 'Content', selfGuarded: true },
  { key: 'knowledge', label: 'Knowledge', selfGuarded: true },
  { key: 'style', label: 'Writing style', selfGuarded: true },
  { key: 'targets', label: 'Targets', selfGuarded: true },
  { key: 'insights', label: 'Insights', selfGuarded: true },
  { key: 'settings', label: 'Settings', selfGuarded: true },
] as const satisfies ReadonlyArray<{ key: string; label: string; selfGuarded: boolean }>;
export type ContentTab = (typeof CONTENT_TABS)[number]['key'];
export const DEFAULT_CONTENT_TAB: ContentTab = 'content';

export type ContentView = 'list' | 'calendar';
/** The Concept opens in place of the Content tab's list (with a back button), never as a tab of its own; `importing` puts the import session's view there instead. */
export interface ContentState { tab: ContentTab; view: ContentView; conceptId: string | null; conceptTab: ConceptTab; importing: boolean }
export const initialContentState = (): ContentState => ({ tab: DEFAULT_CONTENT_TAB, view: 'list', conceptId: null, conceptTab: 'overview', importing: false });
export const openConcept = (s: ContentState, conceptId: string): ContentState => ({ ...s, conceptId, conceptTab: 'overview', importing: false });
export const openImport = (s: ContentState): ContentState => ({ ...s, importing: true });
export const closeImport = (s: ContentState): ContentState => ({ ...s, importing: false });
export const closeConcept = (s: ContentState): ContentState => ({ ...s, conceptId: null });
export const setView = (s: ContentState, view: ContentView): ContentState => ({ ...s, view });
export const selectConceptTab = (s: ContentState, conceptTab: ConceptTab): ContentState => ({ ...s, conceptTab });
/** Leaving the Content tab closes the open Concept; the List/Calendar choice is not remembered either. */
export const selectTab = (s: ContentState, tab: ContentTab): ContentState => (tab === s.tab ? s : { ...initialContentState(), tab });

