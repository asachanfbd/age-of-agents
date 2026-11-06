import type { PlanItemRecord } from '../domain/types.ts';

/** The longest note a person may leave for a step, counted in characters (code points) of the trimmed text. */
export const MAX_STEP_NOTE_LENGTH = 4000;

/** A step id is a kebab-case slug; checked before any run exists to say which workflow's steps are valid. */
const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_STEP_ID_LENGTH = 100;

export class StepNoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepNoteValidationError';
  }
}

export const codePointLength = (text: string): number => Array.from(text).length;

export function assertStepId(stepId: unknown): asserts stepId is string {
  if (typeof stepId !== 'string' || stepId.length > MAX_STEP_ID_LENGTH || !STEP_ID_PATTERN.test(stepId)) {
    throw new StepNoteValidationError('the step id must be a lowercase kebab-case slug');
  }
}

/** The note to store: trimmed, or null when it is empty (which clears the step's note). */
export function parseStepNote(note: unknown): string | null {
  if (note === null) return null;
  if (typeof note !== 'string') throw new StepNoteValidationError('note must be text, or null to clear it');
  const trimmed = note.trim();
  const over = codePointLength(trimmed) - MAX_STEP_NOTE_LENGTH;
  if (over > 0) throw new StepNoteValidationError(`note is limited to ${MAX_STEP_NOTE_LENGTH} characters; it is ${over} over`);
  return trimmed || null;
}

/** `notes` with `stepId` set to `note`, or removed when `note` is null. */
export function withStepNote(notes: PlanItemRecord['stepNotes'], stepId: string, note: string | null): Record<string, string> {
  const { [stepId]: _replaced, ...others } = notes ?? {};
  return note === null ? others : { ...others, [stepId]: note };
}

/** `notes` without the step ids the chosen workflow doesn't have. */
export function keepStepNotesFor(notes: PlanItemRecord['stepNotes'], stepIds: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(notes ?? {}).filter(([stepId]) => stepIds.includes(stepId)));
}

/** `text` followed by the note, as-is, after one blank line; `text` itself when there is no note. */
export function appendStepNote(text: string, note: string | null | undefined): string {
  const trimmed = note?.trim();
  return trimmed ? `${text}\n\n${trimmed}` : text;
}
