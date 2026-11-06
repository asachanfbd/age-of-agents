import { READ_ONLY_TITLE } from './contentView';

/** Mirrors the daemon's COMMENT_MAX_CHARS (server/src/content/limits.ts): code points after trim. */
export const COMMENT_MAX_CHARS = 2_000;
export const NO_SESSION_TITLE = 'Comments go to the live agent session. Press Resume to comment.';
const CLEARED_HINT = 'New draft saved. Sent comments were cleared because line numbers may have changed.';

export interface DraftLine { n: number; text: string; commentable: boolean }

/** The draft's lines, numbered from 1 with blank lines counted; CRLF and a lone CR break lines the same way the daemon does. */
export const draftLines = (text: string): DraftLine[] =>
  text.replace(/\r\n?/g, '\n').split('\n').map((line, i) => ({ n: i + 1, text: line, commentable: !!line.trim() }));

const count = (text: string): number => [...text.trim()].length;
const format = (n: number): string => n.toLocaleString('en-US');

/** `empty` disables Send without a message; a string is shown under the box. */
export function commentProblem(text: string): 'empty' | string | null {
  if (!text.trim()) return 'empty';
  return count(text) > COMMENT_MAX_CHARS ? `Keep the comment to ${format(COMMENT_MAX_CHARS)} characters.` : null;
}

export const commentCounter = (text: string): { text: string; over: boolean } =>
  ({ text: `${format(count(text))} / ${format(COMMENT_MAX_CHARS)}`, over: count(text) > COMMENT_MAX_CHARS });

/** An open comment box. `anchor` is the line's text when it was opened, to warn when a new draft changes that line. */
export interface CommentBox { text: string; status: 'idle' | 'sending'; anchor: string; error: string | null }
export interface SentNote { comment: string; at: string }

export interface CommentsState {
  /** The `savedAt` of the draft the line numbers belong to. */
  draftAt: string | null;
  boxes: Record<number, CommentBox>;
  sent: Record<number, SentNote[]>;
  /** A newer draft cleared sent notes. */
  cleared: boolean;
}

export type CommentsAction =
  | { type: 'open'; line: number; lineText: string }
  | { type: 'edit'; line: number; text: string }
  | { type: 'cancel'; line: number }
  | { type: 'sending'; line: number }
  | { type: 'failed'; line: number; error: string }
  /** `draftAt` is the draft the comment was written against. */
  | { type: 'sent'; line: number; comment: string; at: string; draftAt: string | null }
  | { type: 'draftChanged'; savedAt: string | null };

export const initialComments = (draftAt: string | null): CommentsState => ({ draftAt, boxes: {}, sent: {}, cleared: false });

const withoutKey = <T>(record: Record<number, T>, key: number): Record<number, T> => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

const patchBox = (state: CommentsState, line: number, patch: Partial<CommentBox>): CommentsState => {
  const box = state.boxes[line];
  return box ? { ...state, boxes: { ...state.boxes, [line]: { ...box, ...patch } } } : state;
};

export function commentsReducer(state: CommentsState, action: CommentsAction): CommentsState {
  switch (action.type) {
    case 'open':
      if (state.boxes[action.line]) return state;
      return { ...state, boxes: { ...state.boxes, [action.line]: { text: '', status: 'idle', anchor: action.lineText, error: null } } };
    case 'edit': return patchBox(state, action.line, { text: action.text, error: null });
    case 'cancel': return { ...state, boxes: withoutKey(state.boxes, action.line) };
    case 'sending': return patchBox(state, action.line, { status: 'sending', error: null });
    case 'failed': return patchBox(state, action.line, { status: 'idle', error: action.error });
    case 'sent': {
      const boxes = withoutKey(state.boxes, action.line);
      // A note for an older draft would sit on a line that may now hold other text.
      if (action.draftAt !== state.draftAt) return { ...state, boxes };
      const notes = [...(state.sent[action.line] ?? []), { comment: action.comment.trim(), at: action.at }];
      return { ...state, boxes, sent: { ...state.sent, [action.line]: notes }, cleared: false };
    }
    case 'draftChanged':
      if (action.savedAt === state.draftAt) return state;
      return { draftAt: action.savedAt, boxes: state.boxes, sent: {}, cleared: Object.keys(state.sent).length > 0 };
  }
}

/** Why an open box's line needs a look after a new draft: its new text, or that it is gone (which blocks Send). */
export function lineWarning(box: CommentBox, lines: DraftLine[], line: number): { text: string; blocksSend: boolean } | null {
  const current = lines[line - 1];
  if (!current || !current.commentable) return { text: `Line ${line} is no longer in the draft.`, blocksSend: true };
  return current.text === box.anchor ? null : { text: current.text, blocksSend: false };
}

/** The status line under the Result heading. */
export function sentHint(state: CommentsState): string | null {
  const n = Object.values(state.sent).reduce((sum, notes) => sum + notes.length, 0);
  if (n === 1) return '1 comment sent to the agent. It clears when the agent saves a new draft.';
  if (n > 1) return `${n} comments sent to the agent. They clear when the agent saves a new draft.`;
  return state.cleared ? CLEARED_HINT : null;
}

/** Whether comments are offered: hidden once finalized, else the reason they are disabled (read-only first), or null. */
export function commentBlock({ finalized, readOnly, live }: { finalized: boolean; readOnly: boolean; live: boolean }): 'hidden' | string | null {
  if (finalized) return 'hidden';
  if (readOnly) return READ_ONLY_TITLE;
  return live ? null : NO_SESSION_TITLE;
}
