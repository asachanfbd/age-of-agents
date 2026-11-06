import { ContentInputError } from './errors.ts';
import { ALT_TEXT_LINE_MAX, ALT_TEXT_LINES_MAX, IMAGE_SIZE_MAX, IMAGE_SIZE_MIN, IMAGES_PER_CALL_MAX } from './limits.ts';
import { imageRange } from './rules.ts';
import type { ImageRange, Platform } from './rules.ts';
import { charCount } from './validate.ts';

/**
 * The Images tab's pure rules: the default canvas per platform and format (duplicated in web `lib/contentImages.ts` and pinned by
 * the shared fixture `web/tests/fixtures/contentImageCases.json`), the `render_images` input, alt text, output file names and
 * the Finalize count rule.
 */

export interface ImageSize { width: number; height: number }

/** The default canvas of each image or carousel post, from the platforms' own guidance (checked for task 32.006). */
export const IMAGE_SIZES: Partial<Record<Platform, Partial<Record<string, ImageSize>>>> = {
  instagram: { image: { width: 1080, height: 1350 }, carousel: { width: 1080, height: 1350 } },
  linkedin: { image: { width: 1200, height: 1200 }, carousel: { width: 1080, height: 1350 } },
  x: { image: { width: 1600, height: 900 } },
  facebook: { image: { width: 1200, height: 1200 }, carousel: { width: 1080, height: 1080 } },
};

export const defaultImageSize = (platform: Platform, format: string): ImageSize | null => IMAGE_SIZES[platform]?.[format] ?? null;

/** Short platform names for sentences ("an X image post"). */
const SHORT_NAMES: Record<Platform, string> = { linkedin: 'LinkedIn', instagram: 'Instagram', x: 'X', facebook: 'Facebook', blog: 'Blog' };
const article = (platform: Platform): string => (platform === 'instagram' || platform === 'x' ? 'an' : 'a');

const sizeField = (value: unknown, field: 'width' | 'height', fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < IMAGE_SIZE_MIN || value > IMAGE_SIZE_MAX) {
    throw new ContentInputError(`${field} must be a whole number of pixels from 320 to 4,000`, field);
  }
  return value;
};

/** Width and height of a `render_images` call; each one left out falls back to the post's default on its own. */
export const parseImageSize = (body: { width?: unknown; height?: unknown }, fallback: ImageSize): ImageSize =>
  ({ width: sizeField(body.width, 'width', fallback.width), height: sizeField(body.height, 'height', fallback.height) });

/** 1 to `max` (20 for images) distinct non-empty ids, in render order. Whether each is the session's own is checked against its still files. */
export function parseCompositionIds(value: unknown, max: number = IMAGES_PER_CALL_MAX): string[] {
  const fail = (message: string) => new ContentInputError(message, 'compositionIds');
  if (!Array.isArray(value)) throw fail('compositionIds must be a list of still composition ids');
  if (value.length < 1 || value.length > max) throw fail(`compositionIds must hold 1 to ${max} ids; it has ${value.length}`);
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !id) throw fail('Every composition id must be a non-empty string');
    if (seen.has(id)) throw fail(`"${id}" is listed twice`);
    seen.add(id);
  }
  return value as string[];
}

/** Each id must be one of the session's own still compositions (case-sensitive); `owner` names them in the refusal. */
export function requireOwnIds(ids: string[], own: readonly string[], owner = "this post's still compositions"): void {
  const stranger = ids.find((id) => !own.includes(id));
  if (stranger !== undefined) {
    throw new ContentInputError(`"${stranger}" is not one of ${owner}${own.length ? ` (${own.join(', ')})` : '; none exist yet'}`, 'compositionIds');
  }
}

/** Alt text: one line per image, trimmed, at most 20 lines of at most 1,000 characters each. Stored trimmed, one line per image. */
export function parseAltText(value: unknown): string {
  if (typeof value !== 'string') throw new ContentInputError('text must be a string', 'text');
  const lines = value.trim().split(/\r?\n/).map((l) => l.trim());
  if (!lines.join('')) throw new ContentInputError('text must not be empty', 'text');
  if (lines.length > ALT_TEXT_LINES_MAX) throw new ContentInputError(`The alt text has ${lines.length} lines; at most ${ALT_TEXT_LINES_MAX} (one per image).`, 'text');
  lines.forEach((line, i) => {
    const n = charCount(line);
    if (n > ALT_TEXT_LINE_MAX) throw new ContentInputError(`Line ${i + 1} of the alt text is ${n.toLocaleString('en-US')} characters; the limit is 1,000 characters. Shorten it and save again.`, 'text');
  });
  return lines.join('\n');
}

/** `<stem>-01.png`, `<stem>-02.png` …: zero-padded, so the names sort in render order. */
export const stillFileName = (stem: string, index: number): string => `${stem}-${String(index).padStart(2, '0')}.png`;

/** The 1-based index (1 to `max`) of a rendered still's file name, or null for any other name (so a route never joins a client path). */
export function parseStillFileName(stem: string, max: number, name: string): number | null {
  const m = new RegExp(`^${stem}-(\\d{2})\\.png$`).exec(name);
  const index = m ? Number(m[1]) : 0;
  return index >= 1 && index <= max ? index : null;
}

/** `image-01.png` … `image-20.png`. */
export const imageFileName = (index: number): string => stillFileName('image', index);
export const parseImageFileName = (name: string): number | null => parseStillFileName('image', IMAGES_PER_CALL_MAX, name);

/** "60 seconds", "5 minutes"; a test's short limit reads in ms. */
const durationText = (ms: number): string => (ms > 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minutes` : ms >= 1_000 ? `${Math.round(ms / 1_000)} seconds` : `${ms} ms`);
/** "image 2 (<id>) timed out after 60 seconds"; `noun` names what one still is. */
export const stillTimeoutMessage = (noun: string, index: number, compositionId: string, ms: number): string => `${noun} ${index} (${compositionId}) timed out after ${durationText(ms)}`;
export const stillCallTimeoutMessage = (tool: string, noun: string, index: number, compositionId: string, ms: number): string =>
  `the ${tool} call ran over ${durationText(ms)} while rendering ${noun} ${index} (${compositionId})`;
export const imageTimeoutMessage = (index: number, compositionId: string, ms: number): string => stillTimeoutMessage('image', index, compositionId, ms);
export const callTimeoutMessage = (index: number, compositionId: string, ms: number): string => stillCallTimeoutMessage('render_images', 'image', index, compositionId, ms);

const countText = (range: ImageRange): string => (range.min === range.max ? `${range.min} ${range.min === 1 ? 'image' : 'images'}` : `${range.min} to ${range.max} images`);

/** The state of a round's newest `render_images` call, as Finalize sees it. */
export type ImageCallState = 'none' | 'queued' | 'running' | 'failed' | 'stopped' | 'done';

export const RENDER_RUNNING_REASON = 'Finalize is available once the render finishes.';
export const NO_COMPLETE_SET_REASON = 'The last render did not finish, so there is no complete set. Render again to finalize.';

/** Why the round cannot be finalized, or null. Only a finished newest call whose image count fits the post's format passes. */
export function finalizeImagesBlocker(platform: Platform, format: string, state: ImageCallState, count: number): string | null {
  const range = imageRange(platform, format);
  if (!range) return 'This post takes no images.';
  if (state === 'queued' || state === 'running') return RENDER_RUNNING_REASON;
  if (state === 'failed' || state === 'stopped') return NO_COMPLETE_SET_REASON;
  if (state === 'none' || count === 0) return `Finalize needs a rendered set: ${countText(range)} for ${article(platform)} ${SHORT_NAMES[platform]} ${format}.`;
  if (count < range.min || count > range.max) {
    const lead = `${article(platform)} ${SHORT_NAMES[platform]} ${format} post takes ${countText(range)}`;
    return `${lead[0]!.toUpperCase()}${lead.slice(1)}; this round has ${count}.`;
  }
  return null;
}
