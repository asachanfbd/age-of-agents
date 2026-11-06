import type { StepRunStatus } from './serverApi';

/** The longest note the server accepts, counted in characters (code points) of the trimmed text. */
export const MAX_STEP_NOTE_LENGTH = 4000;

export type StepNoteTiming = 'upcoming' | 'started' | 'completed' | 'retry';

export const codePointLength = (text: string): number => Array.from(text).length;

/** When a note on a step with this latest round status takes effect: at the step's start, or only on a later round. */
export function stepNoteTiming(status: StepRunStatus | undefined): StepNoteTiming {
  switch (status) {
    case 'running':
    case 'awaiting-approval':
    case 'changes-requested':
      return 'started';
    case 'done':
      return 'completed';
    case 'failed':
    case 'stopped':
      return 'retry';
    default:
      return 'upcoming';
  }
}

const HINT = "Appended to the end of this step's input when it starts.";

const WARNINGS: Record<Exclude<StepNoteTiming, 'upcoming'>, string> = {
  started: 'This step has already started. The note is only used the next time it runs (a retry or another round).',
  completed: 'This step is already completed. The note is only passed on the next round.',
  retry: 'This step has already run. The note is only used when it runs again (a retry or the next round).',
};

/** The line under the text area: the start hint for a step yet to run, nothing for one already started (its warning shows instead). */
export const stepNoteHint = (timing: StepNoteTiming): string | null => (timing === 'upcoming' ? HINT : null);

/** The amber warning for a step that has already run, or null for one yet to start. */
export const stepNoteWarning = (timing: StepNoteTiming): string | null => (timing === 'upcoming' ? null : WARNINGS[timing]);

/** The status line shown once a note is saved. */
export const stepNoteSavedLabel = (timing: StepNoteTiming): string =>
  timing === 'upcoming' ? 'Note saved: sent when this step starts.' : 'Note saved: sent on the next round.';

export const stepNoteButtonLabel = (hasNote: boolean): string => (hasNote ? 'Edit note' : 'Add note');

/** The counter under the text area; names the overage once the draft is too long. */
export function stepNoteCounter(draft: string): { label: string; tooLong: boolean } {
  const length = codePointLength(draft.trim());
  const over = length - MAX_STEP_NOTE_LENGTH;
  return over > 0
    ? { label: `${length} / ${MAX_STEP_NOTE_LENGTH} — ${over} over the limit`, tooLong: true }
    : { label: `${length} / ${MAX_STEP_NOTE_LENGTH}`, tooLong: false };
}

/** Save is allowed when the draft fits, differs from what is stored, and nothing is being saved. An empty draft over a stored note clears it. */
export function canSaveStepNote(draft: string, saved: string | undefined, saving: boolean): boolean {
  return !saving && !stepNoteCounter(draft).tooLong && draft.trim() !== (saved ?? '');
}
