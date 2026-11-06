/**
 * The Remotion tab: Remotion Studio for the Building's shared Remotion project (see server/src/content/remotionStudio.ts), and
 * the pure rules the tab is drawn from.
 */

export type StudioState = 'stopped' | 'starting' | 'running' | 'failed';
export interface RemotionStudioDto {
  state: StudioState;
  /** `http://127.0.0.1:<port>` while running. */
  url: string | null;
  error: string | null;
  log: string[];
  waitingForSetup: boolean;
}
export type RemotionStudioEvent = { type: 'remotionStudio'; buildingId: string; studio: RemotionStudioDto };

/**
 * Whether Studio is shown inside the tab. Remotion 4.0.529 Studio sends no `X-Frame-Options` or `frame-ancestors` header and
 * serves its live reload from its own origin, so the iframe is used; `false` switches the tab to the new-tab fallback.
 */
export const STUDIO_EMBEDDABLE = true;
/** How often a visible Remotion tab tells the daemon it is open; the daemon stops Studio after 10 minutes without one. */
export const HEARTBEAT_MS = 60_000;
export const STUDIO_LOG_LINES = 200;
/** Below this window width the tab suggests a new browser tab. */
export const NARROW_WIDTH = 640;

export const STUDIO_TEXT = {
  title: 'Remotion Studio',
  shared: 'shared by every Concept in this Building',
  openNewTab: 'Open in a new browser tab',
  openDisabled: 'Available while Studio is running',
  narrow: 'Studio needs a wide window. Open it in a new browser tab for more room.',
  waiting: 'Waiting for Remotion setup to finish…',
  waitingDetail: "The video project's packages are still installing (listed in the status footer as Remotion setup). Studio starts by itself once it is done.",
  starting: 'Starting Remotion Studio…',
  stopped: 'Remotion Studio is not running.',
  stoppedDetail: 'It stops when you press Stop, and after 10 minutes with no Remotion tab open in this Building.',
  fallback: "Studio can't be shown inside this app",
  fallbackDetail: 'Its live reload does not work in an embedded frame here (the reason is recorded in the product doc).',
  readOnly: "This Building is read-only. You can view Studio here; prop changes you save in Studio still write to the project's files. Renders happen only in the Video tab.",
  readOnlyRefused: "Studio can't start: this Building is read-only and the Remotion project still needs its packages installed.",
} as const;

export type StudioPaneState = 'loading' | 'waiting' | 'starting' | 'running' | 'failed' | 'stopped' | 'fallback' | 'ro-refused' | 'ro-running';

/**
 * What the tab body shows. `needsInstall` is the Remotion project's install not being done yet (the Video tab's setup);
 * a read-only Building cannot install, so Studio that is not starting or running there is refused.
 */
export function studioPaneState(view: RemotionStudioDto | null, options: { readOnly: boolean; needsInstall: boolean; embeddable?: boolean }): StudioPaneState {
  if (!view) return 'loading';
  const live = view.state === 'starting' || view.state === 'running';
  if (options.readOnly && options.needsInstall && !live) return 'ro-refused';
  if (view.state === 'starting') return view.waitingForSetup ? 'waiting' : 'starting';
  if (view.state === 'running') {
    if (!(options.embeddable ?? STUDIO_EMBEDDABLE)) return 'fallback';
    return options.readOnly ? 'ro-running' : 'running';
  }
  return view.state;
}

/** Studio opened at this Concept's composition: its routes are `/<compositionId>`. */
export function compositionUrl(base: string | null, compositionId: string | null): string | null {
  if (!base || !compositionId) return null;
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(compositionId)}`;
}

export const isNarrow = (width: number): boolean => width < NARROW_WIDTH;

/** The state chip next to the tab's title. */
export function studioChip(view: RemotionStudioDto | null, pane: StudioPaneState): string {
  if (pane === 'ro-refused' || !view) return 'Not started';
  if (view.state === 'starting') return view.waitingForSetup ? 'Waiting for setup' : 'Starting';
  if (view.state === 'running') {
    try { return `Running · ${new URL(view.url ?? '').host}`; } catch { return 'Running'; }
  }
  if (view.state === 'failed') return 'Failed';
  return view.log.length || view.error ? 'Stopped' : 'Not started';
}

export interface StudioHeaderControls { showStop: boolean; openEnabled: boolean; openTitle: string | undefined }
export function studioHeaderControls(pane: StudioPaneState, url: string | null): StudioHeaderControls {
  const showStop = pane === 'starting' || pane === 'running' || pane === 'fallback' || pane === 'ro-running';
  return { showStop, openEnabled: !!url, openTitle: url ? undefined : STUDIO_TEXT.openDisabled };
}

export const studioLogTail = (log: string[]): string[] => (log.length > STUDIO_LOG_LINES ? log.slice(-STUDIO_LOG_LINES) : log);

export interface HeartbeatEnv {
  send(): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  hidden(): boolean;
  /** Calls `fn` whenever the page's visibility changes; returns the unsubscribe. */
  onVisibility(fn: () => void): () => void;
}

/**
 * Tells the daemon a Remotion tab is open: at once while the page is visible, then every `HEARTBEAT_MS`, and at once again
 * when the page becomes visible. Nothing is sent while hidden, so Studio stops after its idle time. Returns the stop function.
 */
export function startHeartbeat(env: HeartbeatEnv, every = HEARTBEAT_MS): () => void {
  const beat = () => { if (!env.hidden()) env.send(); };
  beat();
  const handle = env.setInterval(beat, every);
  const unsubscribe = env.onVisibility(beat);
  return () => { env.clearInterval(handle); unsubscribe(); };
}
