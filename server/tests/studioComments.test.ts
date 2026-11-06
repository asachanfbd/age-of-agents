import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContentInputError } from '../src/content/errors.ts';
import { COMMENT_MAX_CHARS, DRAFT_MAX_CHARS } from '../src/content/limits.ts';
import { commentMessage, parseLineComment, splitDraftLines } from '../src/content/studioComments.ts';

/** The pure helpers behind a line comment (content/studioComments.ts): numbering, validation and the typed message. */

const body = (patch: Record<string, unknown> = {}) => ({ line: 7, lineText: 'Hook line', comment: 'Make it shorter', ...patch });
const refusedOn = (field: string, input: unknown) => assert.throws(() => parseLineComment(input), (e: unknown) => e instanceof ContentInputError && e.field === field, JSON.stringify(input));

test('SU1 LF, CRLF and lone CR number lines identically, 1-based, blank lines counted', () => {
  const expected = ['one', '', 'three'];
  for (const text of ['one\n\nthree', 'one\r\n\r\nthree', 'one\r\rthree']) assert.deepEqual(splitDraftLines(text), expected);
  assert.equal(splitDraftLines('one\n\nthree')[3 - 1], 'three');
});

test('SU2 a draft with no newline is one line', () => {
  assert.deepEqual(splitDraftLines('only line'), ['only line']);
});

test('SU3 a valid comment is returned trimmed with its line and text', () => {
  assert.deepEqual(parseLineComment(body({ comment: '  fix  ' })), { line: 7, lineText: 'Hook line', comment: 'fix' });
});

test('SU4 an empty or whitespace-only comment is refused on the comment field', () => {
  for (const comment of ['', '   ', '\n\t ']) refusedOn('comment', body({ comment }));
});

test('SU5 the comment may be 2,000 code points; 2,001 is refused naming the limit', () => {
  assert.equal(parseLineComment(body({ comment: 'a'.repeat(2000) })).comment.length, 2000);
  assert.throws(() => parseLineComment(body({ comment: 'a'.repeat(2001) })), (e: unknown) => e instanceof ContentInputError && e.field === 'comment' && /2,000/.test(e.message));
});

test('SU6 the limit counts code points after trim', () => {
  assert.equal([...parseLineComment(body({ comment: '😀'.repeat(2000) })).comment].length, 2000);
  refusedOn('comment', body({ comment: '😀'.repeat(2001) }));
  assert.equal(parseLineComment(body({ comment: `   ${'a'.repeat(2000)}   ` })).comment.length, 2000);
});

test('SU7 a comment that is not a string is refused on the comment field', () => {
  for (const comment of [5, null, ['a'], { a: 1 }, undefined]) refusedOn('comment', body({ comment }));
});

test('SU8 line must be a positive safe integer number', () => {
  for (const line of [0, -1, 1.5, '7', null, undefined, 2 ** 53, Infinity]) refusedOn('line', body({ line }));
});

test('SU9 lineText must be a non-blank string', () => {
  for (const lineText of [5, null, undefined]) refusedOn('lineText', body({ lineText }));
  for (const lineText of ['', '   ']) refusedOn('lineText', body({ lineText }));
});

test('SU10 a lineText longer than a draft is refused', () => {
  refusedOn('lineText', body({ lineText: 'a'.repeat(DRAFT_MAX_CHARS + 1) }));
});

const DRAFT = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'].join('\n');

test('SU11 the message for a middle line follows the confirmed format with script wording', () => {
  assert.equal(
    commentMessage(DRAFT, { line: 7, lineText: 'L7', comment: 'Shorter' }, true),
    'Comment on line 7 of the current draft. Line: "L7". Nearby lines: 5: "L5"; 6: "L6"; 8: "L8"; 9: "L9". Comment: Shorter. Update the script to address this and save the new draft.',
  );
  assert.match(commentMessage(DRAFT, { line: 7, lineText: 'L7', comment: 'x' }, false), /Update the text to address this/);
});

test('SU12 edges: the first and last line show one side only; a one-line draft has no nearby lines', () => {
  assert.match(commentMessage(DRAFT, { line: 1, lineText: 'L1', comment: 'x' }, true), /Nearby lines: 2: "L2"; 3: "L3"\. Comment/);
  assert.match(commentMessage(DRAFT, { line: 10, lineText: 'L10', comment: 'x' }, true), /Nearby lines: 8: "L8"; 9: "L9"\. Comment/);
  assert.doesNotMatch(commentMessage('Solo', { line: 1, lineText: 'Solo', comment: 'x' }, true), /Nearby/);
});

test('SU13 blank neighbour lines are skipped', () => {
  const message = commentMessage('A\n\nB\n\nC\n\nD', { line: 5, lineText: 'C', comment: 'x' }, true);
  assert.match(message, /Nearby lines: 1: "A"; 3: "B"; 7: "D"\./);
});

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const BUDGET = 500;

test('SU14 long lines are cut in UTF-8 bytes on a code point boundary: the commented line to 240, a nearby line to 120', () => {
  const message = commentMessage(`${'é'.repeat(250)}\n${'w'.repeat(5000)}`, { line: 2, lineText: 'w'.repeat(5000), comment: 'x' }, true);
  assert.ok(message.includes(`Line: "${'w'.repeat(237)}…".`), 'the line keeps 237 bytes plus the 3-byte ellipsis');
  assert.ok(message.includes(`1: "${'é'.repeat(58)}…"`), 'a 2-byte character is never split');
  assert.ok(bytes(message) <= BUDGET);
});

test('SU14a a line that already fits is not cut and gets no ellipsis', () => {
  const line = 'w'.repeat(240);
  assert.ok(commentMessage(line, { line: 1, lineText: line, comment: 'x' }, true).includes(`Line: "${line}".`));
});

test('SU14b Devanagari and emoji lines stay within the budget and are never split mid-character', () => {
  for (const unit of ['न', '👋']) {
    const line = unit.repeat(400);
    const draft = [line, line, line, line, line].join('\n');
    const message = commentMessage(draft, { line: 3, lineText: line, comment: 'isn\'t it repeated?' }, true);
    assert.ok(bytes(message) <= BUDGET, `${unit}: ${bytes(message)} bytes`);
    assert.doesNotMatch(message, /\uFFFD/);
    assert.ok(message.includes('Comment: isn\'t it repeated?.'));
    assert.match(message, /^Comment on line 3 of the current draft\. /);
  }
});

test('SU14c nearby lines that do not fit are dropped, nearest kept first, and the rest shown in draft order', () => {
  const long = 'n'.repeat(150);
  const draft = [`A${long}`, `B${long}`, 'Target line', `D${long}`, `E${long}`].join('\n');
  const message = commentMessage(draft, { line: 3, lineText: 'Target line', comment: 'x' }, true);
  assert.ok(bytes(message) <= BUDGET);
  assert.match(message, /Nearby lines: 2: "Bn+…"; 4: "Dn+…"\. Comment/, 'the two nearest lines fit, the two farther ones are dropped');
});

test('SU14d a comment past the budget is kept whole and the nearby lines are dropped', () => {
  const comment = `Please ${'rewrite this more naturally '.repeat(60)}`.trim();
  const message = commentMessage(DRAFT, { line: 7, lineText: 'L7', comment }, true);
  assert.ok(message.includes(`Comment: ${comment}.`));
  assert.doesNotMatch(message, /Nearby/);
  assert.match(message, /Update the script to address this and save the new draft\.$/);
});

test('SU14e the owner\'s case: a long Hinglish line 5 with long neighbours fits the budget with the comment and line number', () => {
  const lineOf = (n: number, length: number) => `${n}. Dosto, aaj hum baat karenge ki kaise ek chhota sa habit aapki puri life badal sakta hai `.padEnd(length, 'aur yeh sach hai ').slice(0, length);
  const lines = [lineOf(1, 170), lineOf(2, 170), lineOf(3, 170), lineOf(4, 170), lineOf(5, 134), lineOf(6, 170), lineOf(7, 170), lineOf(8, 170)];
  const message = commentMessage(lines.join('\n'), { line: 5, lineText: lines[4]!, comment: "isn't it repeated?" }, true);
  assert.ok(bytes(message) <= BUDGET, `${bytes(message)} bytes`);
  assert.ok(message.startsWith('Comment on line 5 of the current draft. '));
  assert.ok(message.includes(`Line: "${lines[4]}".`), 'a 134-character line is kept whole');
  assert.ok(message.includes("Comment: isn't it repeated?."));
});

test('SU15 line breaks in the comment become single spaces', () => {
  const message = commentMessage('A', { line: 1, lineText: 'A', comment: 'one\r\ntwo\nthree\rfour' }, true);
  assert.match(message, /Comment: one two three four\./);
  assert.doesNotMatch(message, /[\r\n]/);
});

test('SU16 escape sequences and control characters are stripped; a tab becomes a space', () => {
  const nasty = 'a\x1b[201~b\x03c\x04d\x7fe\x9bf\tg';
  const message = commentMessage(`${nasty}\n${nasty}`, { line: 2, lineText: nasty, comment: nasty }, true);
  assert.doesNotMatch(message, /[\x00-\x1f\x7f-\x9f]/);
  assert.ok(message.includes('Line: "abcdef g"'));
  assert.ok(message.includes('1: "abcdef g"'));
  assert.ok(message.includes('Comment: abcdef g.'));
});

test('SU17 double quotes in the line text are kept as typed', () => {
  assert.ok(commentMessage('Say "hi"', { line: 1, lineText: 'Say "hi"', comment: 'x' }, true).includes('Line: "Say "hi"".'));
});

test('SU18 COMMENT_MAX_CHARS is 2,000', () => {
  assert.equal(COMMENT_MAX_CHARS, 2000);
});
