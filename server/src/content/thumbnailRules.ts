import { ContentInputError } from './errors.ts';
import { NO_COMPLETE_SET_REASON, parseCompositionIds, parseStillFileName, RENDER_RUNNING_REASON, stillCallTimeoutMessage, stillFileName, stillTimeoutMessage } from './imageRules.ts';
import type { ImageCallState, ImageSize } from './imageRules.ts';
import { THUMBNAILS_PER_CALL_MAX } from './limits.ts';

/**
 * The Thumbnail tab's pure rules: the default canvas, the `render_thumbnails` input, output file names, the Finalize rule and the
 * owner's choice of the final thumbnail. Sizes and alt text follow the Images tab's rules (`imageRules.ts`).
 */

/** 16:9, the video thumbnail size of YouTube, LinkedIn, X and Facebook. */
export const THUMBNAIL_SIZE: ImageSize = { width: 1280, height: 720 };

const STEM = 'thumb';
const TOOL = 'render_thumbnails';

/** 1 to 5 distinct ids, in render order. */
export const parseThumbnailIds = (value: unknown): string[] => parseCompositionIds(value, THUMBNAILS_PER_CALL_MAX);

/** `thumb-01.png` … `thumb-05.png`. */
export const thumbnailFileName = (index: number): string => stillFileName(STEM, index);
export const parseThumbnailFileName = (name: string): number | null => parseStillFileName(STEM, THUMBNAILS_PER_CALL_MAX, name);

export const thumbnailTimeoutMessage = (index: number, compositionId: string, ms: number): string => stillTimeoutMessage('thumbnail', index, compositionId, ms);
export const thumbnailCallTimeoutMessage = (index: number, compositionId: string, ms: number): string => stillCallTimeoutMessage(TOOL, 'thumbnail', index, compositionId, ms);

export const NO_THUMBNAIL_REASON = 'Finalize needs a rendered thumbnail. Ask the agent to render one.';

/** Why the round cannot be finalized, or null: only a finished newest call with at least one thumbnail passes. */
export function finalizeThumbnailBlocker(state: ImageCallState, count: number): string | null {
  if (state === 'queued' || state === 'running') return RENDER_RUNNING_REASON;
  if (state === 'failed' || state === 'stopped') return NO_COMPLETE_SET_REASON;
  return state === 'none' || count === 0 ? NO_THUMBNAIL_REASON : null;
}

/**
 * The thumbnail the owner picked from the newest call's `count` thumbnails, as its file name. It may be left out only when the call
 * made exactly one. The name is matched as given (never trimmed or joined as a path).
 */
export function parseChosenThumbnail(value: unknown, count: number): string {
  if (value === undefined && count === 1) return thumbnailFileName(1);
  if (value === undefined) throw new ContentInputError(`Choose the final thumbnail: file must name one of the ${count} thumbnails of the last render`, 'file');
  const index = typeof value === 'string' ? parseThumbnailFileName(value) : null;
  if (index === null || index > count) {
    throw new ContentInputError(`file must be one of the last render's thumbnails (${Array.from({ length: count }, (_, i) => thumbnailFileName(i + 1)).join(', ')})`, 'file');
  }
  return value as string;
}
