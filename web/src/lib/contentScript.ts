/** The Script tab's footer: word count, estimated length and the speaking speed (37.006). Pure. */

export const SPEAKING_WPM_MIN = 20;
export const SPEAKING_WPM_MAX = 400;
export const SPEAKING_WPM_DEFAULT = 150;

/** `detected` is the average of the recordings the video agent measured (37.007); `manual` stays authoritative until cleared. */
export type SpeakingSpeedSource = 'default' | 'manual' | 'detected';
export interface SpeakingSpeedDto { speakingWpm: number; source: SpeakingSpeedSource; sampleCount: number }

export const DEFAULT_SPEAKING_SPEED: SpeakingSpeedDto = { speakingWpm: SPEAKING_WPM_DEFAULT, source: 'default', sampleCount: 0 };
export const SPEED_INPUT_ERROR = `Use a whole number from ${SPEAKING_WPM_MIN} to ${SPEAKING_WPM_MAX}. Nothing was saved.`;
export const SPEED_SETTING_ERROR = `Speaking speed must be a whole number from ${SPEAKING_WPM_MIN} to ${SPEAKING_WPM_MAX}.`;
export const NO_LENGTH = '—';

/** Words split on Unicode whitespace; a zero-width space or joiner is not whitespace, so it never splits a word. */
export const countWords = (text: string): number => text.split(/\s+/u).filter(Boolean).length;

/** "~m:ss" at the given speed, rounded to the nearest second with a floor of one second; minutes are not capped. */
export function formatLength(words: number | null, wpm: number): string {
  if (!words) return NO_LENGTH;
  const seconds = Math.max(1, Math.round((words / wpm) * 60));
  return `~${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const wordsLabel = (words: number): string => `${words.toLocaleString('en-US')} ${words === 1 ? 'word' : 'words'}`;

export interface ScriptStats { words: number; length: string }

/** The shown text's stats: the current draft, or the finalized text once the script is finalized; null text is no draft. */
export function scriptStats(text: string | null, wpm: number): ScriptStats {
  const words = text === null ? 0 : countWords(text);
  return { words, length: formatLength(text === null ? null : words, wpm) };
}

function parseWpm(text: string): number | null {
  const t = text.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return n >= SPEAKING_WPM_MIN && n <= SPEAKING_WPM_MAX ? n : null;
}

/** The footer's typed speed: ASCII digits only, 20 to 400. */
export function parseSpeedInput(text: string): { ok: true; wpm: number } | { ok: false; error: string } {
  const wpm = parseWpm(text);
  return wpm === null ? { ok: false, error: SPEED_INPUT_ERROR } : { ok: true, wpm };
}

/** The Settings form's speed field; null when it may be saved. */
export const speakingSpeedError = (text: string): string | null => (parseWpm(text) === null ? SPEED_SETTING_ERROR : null);

/** The Script stats belong to the Concept's script only; a post's text or article (under `posts[].needs`) is never one. */
export const isScriptAsset = (assets: ReadonlyArray<{ id: string; kind: string }> | undefined, assetId: string): boolean =>
  assets?.find((a) => a.id === assetId)?.kind === 'script';

const recordings = (n: number): string => `${n} ${n === 1 ? 'recording' : 'recordings'}`;
export function footerSourceLabel({ source, sampleCount }: Pick<SpeakingSpeedDto, 'source' | 'sampleCount'>): string {
  if (source === 'manual') return 'set by you';
  if (source === 'detected') return sampleCount === 1 ? 'from 1 recording' : `average of ${recordings(sampleCount)}`;
  return 'default';
}
export const settingsSourceLabel = (source: SpeakingSpeedSource): string => (source === 'manual' ? 'Set by you' : source === 'detected' ? 'Detected' : 'Default');

/** "Use detected speed" only makes sense while the owner's value hides existing recordings. */
export const canUseDetected = (speed: Pick<SpeakingSpeedDto, 'source' | 'sampleCount'>): boolean => speed.source === 'manual' && speed.sampleCount > 0;

export interface SpeakingRateSampleDto {
  id: string; mediaId: string; conceptId: string; mediaName: string; wordsPerMinute: number; words: number; durationSeconds: number; createdAt: string;
}
/** A list that is long enough to need its own scroll. */
export const SAMPLE_LIST_SCROLL_FROM = 12;

export interface SampleRow { id: string; name: string; wpm: string; detail: string }
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
/** One row of the Settings list: the name stays whole (the view truncates it and shows the full name as a tooltip). */
export const sampleRow = (s: SpeakingRateSampleDto): SampleRow => ({
  id: s.id, name: s.mediaName, wpm: `${Math.round(s.wordsPerMinute)} wpm`, detail: `${s.words.toLocaleString('en-US')} words · ${clock(s.durationSeconds)}`,
});

/** Sends the speed only when it changed, so saving other settings never turns "default" into "set by you". */
export function speedPatch(text: string, loaded: SpeakingSpeedDto): { speakingWpm?: number } {
  const wpm = parseWpm(text);
  return wpm === null || wpm === loaded.speakingWpm ? {} : { speakingWpm: wpm };
}

// ---- the footer's speed field -------------------------------------------------------------------------------------

/**
 * The inline field: Enter or blur commits, Esc puts the saved value back. A commit while a save is in flight sends nothing,
 * so Enter followed by the blur it causes saves once.
 */
export interface SpeedFieldState { text: string; error: string | null; saving: boolean }
export type SpeedFieldEvent =
  | { type: 'edit'; text: string }
  | { type: 'commit'; saved: number }
  | { type: 'revert'; saved: number }
  | { type: 'saved'; saved: number }
  | { type: 'failed'; error: string };
export interface SpeedFieldStep { state: SpeedFieldState; save: number | null }

export const initialSpeedField = (saved: number): SpeedFieldState => ({ text: String(saved), error: null, saving: false });

export function speedFieldStep(state: SpeedFieldState, event: SpeedFieldEvent): SpeedFieldStep {
  const keep = (next: SpeedFieldState): SpeedFieldStep => ({ state: next, save: null });
  switch (event.type) {
    case 'edit': return keep({ ...state, text: event.text, error: null });
    case 'revert': return keep(initialSpeedField(event.saved));
    case 'saved': return keep(initialSpeedField(event.saved));
    case 'failed': return keep({ ...state, saving: false, error: `${event.error} · not saved` });
    case 'commit': {
      if (state.saving) return keep(state);
      const parsed = parseSpeedInput(state.text);
      if (!parsed.ok) return keep({ ...state, error: parsed.error });
      if (parsed.wpm === event.saved) return keep(initialSpeedField(event.saved));
      return { state: { ...state, error: null, saving: true }, save: parsed.wpm };
    }
  }
}
