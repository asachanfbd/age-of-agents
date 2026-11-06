import type { StepProgressSummary, StepRunProgress } from '../domain/types.ts';

/**
 * A checklist item's `short` label is what the 3D village's task tooltip shows as the step's
 * "what it's doing" summary, so it is trimmed to fit there rather than refused: at most two words
 * and 24 characters (counted by code point, so an emoji is never split).
 */
export const SHORT_LABEL_MAX_WORDS = 2;
export const SHORT_LABEL_MAX_CHARS = 24;

/** The stored form of an agent's `short` label: whitespace collapsed, cut to the limits above; null when nothing is left. */
export function trimShortLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const words = raw.trim().split(/\s+/).filter(Boolean).slice(0, SHORT_LABEL_MAX_WORDS);
  if (words.length === 0) return null;
  const chars = [...words.join(' ')];
  return chars.length <= SHORT_LABEL_MAX_CHARS ? chars.join('') : `${chars.slice(0, SHORT_LABEL_MAX_CHARS - 1).join('')}…`;
}

/**
 * The board card's and village tooltip's view of a round's progress: counts (`total` includes
 * skipped items, `done` does not), the agent's own estimate text, and the `short` label of the first
 * in-progress item (null when none is in progress or it has no label, as for progress stored before
 * labels existed).
 */
export function summarizeProgress(progress: StepRunProgress): StepProgressSummary {
  return {
    total: progress.checklist.length,
    done: progress.checklist.filter((item) => item.state === 'done').length,
    estimate: progress.estimate,
    currentLabel: progress.checklist.find((item) => item.state === 'in-progress')?.short ?? null,
  };
}
