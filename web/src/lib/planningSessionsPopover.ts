import type { LiveTerminalSession, LiveTerminalSessionKind } from './serverApi';

/**
 * The status footer's sessions popover: every live terminal session (a PTY, i.e. pseudo-terminal) across all
 * projects, grouped by project, one row per session. The server lists them with the same registry the app
 * update's blocker counts, so the number of rows always equals `blocking.terminalSessions`.
 */

export const SESSION_KIND_LABELS: Record<LiveTerminalSessionKind, string> = {
  planning: 'Planning',
  'bug-report': 'Bug report',
  task: 'Task',
  agent: 'Agent',
  'content-studio': 'Content Studio',
};

/** Heading of a session whose project no longer exists (its record could not be resolved). */
export const UNKNOWN_PROJECT_NAME = 'Unknown project';

export interface TerminalSessionEntry {
  id: string;
  projectId: string | null;
  name: string;
  kindLabel: string;
  accessibleName: string;
}

export interface TerminalSessionGroup {
  projectId: string | null;
  projectName: string;
  sessions: TerminalSessionEntry[];
}

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Projects A–Z with sessions by kind, then name; sessions of an unlisted project come last under one heading. */
export function buildTerminalSessionGroups(projects: { id: string; name: string }[], sessions: LiveTerminalSession[]): TerminalSessionGroup[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const byProject = new Map<string | null, TerminalSessionEntry[]>();
  for (const session of sessions) {
    const projectId = session.projectId !== null && names.has(session.projectId) ? session.projectId : null;
    const kindLabel = SESSION_KIND_LABELS[session.kind];
    const projectName = projectId === null ? UNKNOWN_PROJECT_NAME : names.get(projectId)!;
    const entry = { id: session.id, projectId, name: session.title, kindLabel, accessibleName: `Open ${kindLabel.toLowerCase()} session ${session.title}, ${projectName}` };
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), entry]);
  }
  const sorted = (entries: TerminalSessionEntry[]) =>
    [...entries].sort((a, b) => compareText(a.kindLabel, b.kindLabel) || compareText(a.name, b.name) || a.id.localeCompare(b.id));
  const known = projects
    .filter((project) => byProject.has(project.id))
    .sort((a, b) => compareText(a.name, b.name) || a.id.localeCompare(b.id))
    .map((project) => ({ projectId: project.id, projectName: project.name, sessions: sorted(byProject.get(project.id)!) }));
  const unknown = byProject.get(null);
  return unknown ? [...known, { projectId: null, projectName: UNKNOWN_PROJECT_NAME, sessions: sorted(unknown) }] : known;
}

export const countTerminalSessionRows = (groups: TerminalSessionGroup[]): number =>
  groups.reduce((total, group) => total + group.sessions.length, 0);

// ---- Opening and closing ----

/** Hover opens after this delay… */
export const OPEN_DELAY_MS = 200;
/** …and closes this long after the pointer has left both the count and the popover. */
export const CLOSE_DELAY_MS = 250;

/**
 * - `closed`;
 * - `hover`: opened by the pointer resting on the count; closes when it leaves both;
 * - `focus`: opened by keyboard focus; closes when focus leaves both;
 * - `pinned`: opened by a click or tap; stays until a second click, Esc, an outside click or a row.
 */
export type PopoverMode = 'closed' | 'hover' | 'focus' | 'pinned';

export interface PopoverState {
  mode: PopoverMode;
  /** Skip the next focus-open: set by a pointer press (its click decides) and by Esc returning focus to the count. */
  ignoreNextFocus: boolean;
}

export type PopoverEvent =
  | 'pointerEnter' | 'pointerLeave' | 'hoverOpen' | 'hoverClose'
  | 'pointerDown' | 'focus' | 'keyboardOpen' | 'click'
  | 'escape' | 'outside' | 'focusLeave' | 'select';

export interface PopoverTransition {
  state: PopoverState;
  /** A timer to start (replacing any pending one), or 'cancel' to clear it; absent leaves it alone. */
  timer?: { event: 'hoverOpen' | 'hoverClose'; delayMs: number } | 'cancel';
  /** Move focus back to the count (after Esc). */
  returnFocus?: boolean;
}

export const CLOSED_POPOVER: PopoverState = { mode: 'closed', ignoreNextFocus: false };

/** The popover's open/close rules, as a pure step from one state and event to the next. */
export function popoverTransition(state: PopoverState, event: PopoverEvent): PopoverTransition {
  const to = (mode: PopoverMode, ignoreNextFocus = state.ignoreNextFocus): PopoverState => ({ mode, ignoreNextFocus });
  switch (event) {
    case 'pointerEnter':
      return state.mode === 'closed' ? { state, timer: { event: 'hoverOpen', delayMs: OPEN_DELAY_MS } } : { state, timer: 'cancel' };
    case 'pointerLeave':
      return state.mode === 'hover' ? { state, timer: { event: 'hoverClose', delayMs: CLOSE_DELAY_MS } } : { state, timer: 'cancel' };
    case 'hoverOpen':
      return { state: state.mode === 'closed' ? to('hover') : state };
    case 'hoverClose':
      return { state: state.mode === 'hover' ? to('closed') : state };
    case 'pointerDown':
      return { state: to(state.mode, true) };
    case 'focus':
      if (state.ignoreNextFocus) return { state: to(state.mode, false) };
      return { state: state.mode === 'closed' ? to('focus') : state, timer: 'cancel' };
    case 'keyboardOpen':
      return { state: state.mode === 'closed' ? to('focus', false) : state, timer: 'cancel' };
    case 'click':
      return { state: to(state.mode === 'pinned' ? 'closed' : 'pinned', false), timer: 'cancel' };
    case 'escape':
      return { state: to('closed', true), timer: 'cancel', returnFocus: true };
    case 'focusLeave':
      return { state: state.mode === 'focus' ? to('closed') : state };
    case 'outside':
    case 'select':
      return { state: to('closed', false), timer: 'cancel' };
  }
}

/**
 * Which row a navigation key moves to, or null when the key doesn't move. `current` is the focused row's
 * index, or null on the count itself (where ArrowDown/ArrowUp jump to the first/last row).
 */
export function rowNavigationTarget(key: string, current: number | null, rowCount: number): number | null {
  if (rowCount === 0) return null;
  const last = rowCount - 1;
  if (current === null) return key === 'ArrowDown' ? 0 : key === 'ArrowUp' ? last : null;
  switch (key) {
    case 'ArrowDown': return Math.min(current + 1, last);
    case 'ArrowUp': return Math.max(current - 1, 0);
    case 'Home': return 0;
    case 'End': return last;
    default: return null;
  }
}
