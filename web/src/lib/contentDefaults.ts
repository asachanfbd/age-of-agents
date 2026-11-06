import { FORMATS_BY_PLATFORM, PLATFORMS, isFormatOf, isPlatform } from './contentRules';
import type { Platform } from './contentRules';
import type { NewPostInput } from './contentTypes';
import { localTextToInstant } from './contentZone';

export const TITLE_MAX = 200;
export const BRIEF_MAX = 5_000;
export const DEFAULTS_KEY = 'content-studio.new-concept.defaults';

export interface PlatformChoice { on: boolean; formats: string[] }
export type ChoiceMap = Record<Platform, PlatformChoice>;
export interface NewConceptForm { title: string; brief: string; choices: ChoiceMap; /** The one date applied to every ticked platform. */ allAt: string; /** `datetime-local` text per platform. */ at: Record<Platform, string> }

export const emptyChoices = (): ChoiceMap => ({ linkedin: { on: false, formats: [] }, instagram: { on: false, formats: [] }, x: { on: false, formats: [] }, facebook: { on: false, formats: [] }, blog: { on: false, formats: [] } });
export const emptyDates = (): Record<Platform, string> => ({ linkedin: '', instagram: '', x: '', facebook: '', blog: '' });
export const newConceptForm = (choices: ChoiceMap = emptyChoices()): NewConceptForm => ({ title: '', brief: '', choices, allAt: '', at: emptyDates() });

/** What was stored, cleaned: unknown platforms and formats are dropped and anything malformed reads as nothing ticked. */
export function sanitizeChoices(raw: unknown): ChoiceMap {
  const out = emptyChoices();
  if (!raw || typeof raw !== 'object') return out;
  for (const [platform, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPlatform(platform) || !value || typeof value !== 'object') continue;
    const { on, formats } = value as { on?: unknown; formats?: unknown };
    out[platform] = { on: on === true, formats: Array.isArray(formats) ? formats.filter((f) => isFormatOf(platform, f)) : [] };
  }
  return out;
}

interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void }
const browserStore = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** Each platform's last choices, remembered per browser as a convenience; unavailable or corrupt storage reads as none. */
export function loadChoices(store: Store | null = browserStore()): ChoiceMap {
  try { return sanitizeChoices(JSON.parse(store?.getItem(DEFAULTS_KEY) ?? 'null')); } catch { return emptyChoices(); }
}
export function saveChoices(choices: ChoiceMap, store: Store | null = browserStore()): void {
  try { store?.setItem(DEFAULTS_KEY, JSON.stringify(choices)); } catch { /* the remembered choices are optional */ }
}

export function togglePlatform(c: ChoiceMap, platform: Platform): ChoiceMap {
  const now = !c[platform].on;
  const formats = now && !c[platform].formats.length && FORMATS_BY_PLATFORM[platform].length === 1 ? [...FORMATS_BY_PLATFORM[platform]] : c[platform].formats;
  return { ...c, [platform]: { on: now, formats } };
}
export function toggleFormat(c: ChoiceMap, platform: Platform, format: string): ChoiceMap {
  const has = c[platform].formats.includes(format);
  const formats = has ? c[platform].formats.filter((f) => f !== format) : [...c[platform].formats, format];
  return { ...c, [platform]: { on: formats.length ? true : c[platform].on, formats } };
}
export const clearChoices = (): ChoiceMap => emptyChoices();

/** Every ticked format of a ticked platform is one post. */
export const postsToCreate = (c: ChoiceMap): Array<{ platform: Platform; format: string }> =>
  PLATFORMS.flatMap((platform) => (c[platform].on ? c[platform].formats.map((format) => ({ platform, format })) : []));
export const willCreateLabel = (c: ChoiceMap): string => { const n = postsToCreate(c).length; return `Will create ${n} post${n === 1 ? '' : 's'}`; };

/** Copies the one date into every ticked platform's own field; each stays editable. An empty source changes nothing. */
export function applyDateToAll(form: NewConceptForm): NewConceptForm {
  if (!form.allAt) return form;
  const at = { ...form.at };
  for (const platform of PLATFORMS) if (form.choices[platform].on) at[platform] = form.allAt;
  return { ...form, at };
}

export interface NewConceptCheck { errors: string[]; title: string; posts: NewPostInput[] }
/** Checks the dialog before any request: title and brief limits, and a date for every post. Zero posts is allowed. */
export function checkNewConcept(form: NewConceptForm, timezone: string): NewConceptCheck {
  const errors: string[] = [];
  const title = form.title.trim();
  if (!title) errors.push('Give the concept a title');
  if ([...title].length > TITLE_MAX) errors.push(`The title can be at most ${TITLE_MAX} characters`);
  if ([...form.brief].length > BRIEF_MAX) errors.push(`The brief can be at most ${BRIEF_MAX} characters`);
  const posts: NewPostInput[] = [];
  for (const { platform, format } of postsToCreate(form.choices)) {
    const scheduledAt = form.at[platform] ? localTextToInstant(form.at[platform], timezone) : null;
    if (!scheduledAt) { errors.push(`Pick a date and time for ${platform}`); continue; }
    posts.push({ platform, format, scheduledAt });
  }
  return { errors: [...new Set(errors)], title, posts };
}
