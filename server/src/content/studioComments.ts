import { ContentInputError } from './errors.ts';
import { COMMENT_MAX_CHARS, DRAFT_MAX_CHARS } from './limits.ts';
import { terminalSafe } from './typeIntoSession.ts';
import { charCount } from './validate.ts';

/** A comment the owner left on one line of the current draft. */
export interface LineComment { line: number; lineText: string; comment: string }

/** Up to this many non-empty lines on each side of the commented line are candidates for the message. */
const CONTEXT_LINES = 2;
/**
 * Size limits in UTF-8 bytes, so a line in Devanagari (3 bytes a character) is bounded like one in Latin script. The
 * message stays well under one 1,024-byte terminal read; only the comment, which is never cut, can take it past that.
 */
const MESSAGE_BUDGET_BYTES = 500;
const LINE_MAX_BYTES = 240;
const CONTEXT_LINE_MAX_BYTES = 120;
const ELLIPSIS = '…';

/** The draft's lines, 1-based by index + 1. CRLF and a lone CR count as one line break, the same as in the web. */
export const splitDraftLines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

const isBlank = (line: string): boolean => !line.trim();

/** Validates the web's body; the comment is returned trimmed. */
export function parseLineComment(body: unknown): LineComment {
  const { line, lineText, comment } = (body ?? {}) as Record<string, unknown>;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) throw new ContentInputError('line must be a positive whole number', 'line');
  if (typeof lineText !== 'string') throw new ContentInputError('lineText must be a string', 'lineText');
  if (isBlank(lineText)) throw new ContentInputError('A blank line takes no comment', 'lineText');
  if (charCount(lineText) > DRAFT_MAX_CHARS) throw new ContentInputError(`lineText must be at most ${DRAFT_MAX_CHARS} characters`, 'lineText');
  if (typeof comment !== 'string') throw new ContentInputError('comment must be a string', 'comment');
  const trimmed = comment.trim();
  if (!terminalSafe(trimmed).trim()) throw new ContentInputError('Write a comment before sending it', 'comment');
  if (charCount(trimmed) > COMMENT_MAX_CHARS) throw new ContentInputError(`Keep the comment to ${COMMENT_MAX_CHARS.toLocaleString('en-US')} characters`, 'comment');
  return { line, lineText, comment: trimmed };
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Cuts `text` to at most `max` UTF-8 bytes, ellipsis included, on a code point boundary. */
function cutToBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let kept = '';
  let used = bytes(ELLIPSIS);
  for (const point of text) {
    used += bytes(point);
    if (used > max) break;
    kept += point;
  }
  return `${kept}${ELLIPSIS}`;
}

interface NearbyLine { n: number; text: string }

/** The non-empty lines on each side of `line`, nearest first (the line before wins a tie), as `N: "text"`. */
function nearbyByDistance(lines: string[], line: number): NearbyLine[] {
  const numbered = lines.map((text, i) => ({ n: i + 1, text })).filter((l) => l.n !== line && !isBlank(l.text));
  const before = numbered.filter((l) => l.n < line).slice(-CONTEXT_LINES);
  const after = numbered.filter((l) => l.n > line).slice(0, CONTEXT_LINES);
  return [...before, ...after]
    .sort((a, b) => Math.abs(a.n - line) - Math.abs(b.n - line) || a.n - b.n)
    .map((l) => ({ n: l.n, text: `${l.n}: "${cutToBytes(terminalSafe(l.text), CONTEXT_LINE_MAX_BYTES)}"` }));
}

/**
 * The single line typed into the session: the line (cut to a byte limit), as many of its neighbours as fit the budget
 * (nearest first, shown in draft order), the comment in full, then what to do.
 */
export function commentMessage(draft: string, input: LineComment, isScript: boolean): string {
  const build = (nearby: NearbyLine[]): string => [
    `Comment on line ${input.line} of the current draft.`,
    `Line: "${cutToBytes(terminalSafe(input.lineText), LINE_MAX_BYTES)}".`,
    ...(nearby.length ? [`Nearby lines: ${nearby.map((l) => l.text).join('; ')}.`] : []),
    `Comment: ${terminalSafe(input.comment)}.`,
    `Update the ${isScript ? 'script' : 'text'} to address this and save the new draft.`,
  ].join(' ');
  let kept: NearbyLine[] = [];
  for (const candidate of nearbyByDistance(splitDraftLines(draft), input.line)) {
    const next = [...kept, candidate].sort((a, b) => a.n - b.n);
    if (bytes(build(next)) <= MESSAGE_BUDGET_BYTES) kept = next;
  }
  return build(kept);
}
