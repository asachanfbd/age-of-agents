import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as web from '../../web/src/lib/contentLimits.ts';
import { ContentInputError } from '../src/content/errors.ts';
import * as limits from '../src/content/platformLimits.ts';
import { parseDraftText } from '../src/content/studioDrafts.ts';

/** The platform text limits `save_draft` enforces (content/platformLimits.ts) and their web copy. */

const refused = (fn: () => unknown, ...parts: (string | RegExp)[]) => assert.throws(fn, (e: unknown) => {
  assert.ok(e instanceof ContentInputError);
  assert.equal(e.status, 400);
  assert.equal(e.field, 'text');
  for (const part of parts) assert.match(e.message, typeof part === 'string' ? new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : part);
  return true;
});
const thread = (...tweets: string[]) => tweets.join('\n---\n');

/** Shared with the web test (W10/W11), so both copies split threads and count hashtags the same way. */
const CASES = JSON.parse(readFileSync(new URL('../../web/tests/fixtures/contentTextCases.json', import.meta.url), 'utf8')) as {
  threads: [string, string[]][]; hashtags: [string, number][]; emoji: { text: string; count: number };
};
const THREAD_CASES = CASES.threads;
const HASHTAG_CASES = CASES.hashtags;

test('U01 the limits table', () => {
  assert.deepEqual(limits.PLATFORM_LIMITS, {
    linkedin: { max: 3000 }, x: { max: 280, maxTweets: 25 }, facebook: { max: 63206 }, instagram: { max: 2200, maxHashtags: 30 }, blog: { min: 300, max: 50000 },
  });
});

test('U02 the web copy of the limits, rule texts and counting rules matches the server copy', () => {
  assert.deepEqual(web.PLATFORM_LIMITS, limits.PLATFORM_LIMITS);
  assert.deepEqual(web.PLATFORM_RULE_TEXT, limits.PLATFORM_RULE_TEXT);
  assert.equal(web.THREAD_SEPARATOR, limits.THREAD_SEPARATOR);
  for (const [text] of THREAD_CASES) assert.deepEqual(web.splitThread(text), limits.splitThread(text), JSON.stringify(text));
  for (const [text] of HASHTAG_CASES) assert.equal(web.countHashtags(text), limits.countHashtags(text), text);
  assert.equal(web.formatCount(63206), limits.formatCount(63206));
});

test('U03/U04 LinkedIn: 3,000 accepted, 3,001 refused naming the limit and the count', () => {
  assert.equal(parseDraftText('a'.repeat(3000), 'linkedin').length, 3000);
  refused(() => parseDraftText('a'.repeat(3001), 'linkedin'), '3,000', '3,001');
});

test('U05/U06 Facebook: 63,206 accepted (above the general 50,000), 63,207 refused', () => {
  assert.equal(parseDraftText('a'.repeat(63206), 'facebook').length, 63206);
  refused(() => parseDraftText('a'.repeat(63207), 'facebook'), '63,206', '63,207');
});

test('U07/U08 Instagram: 2,200 characters accepted, 2,201 refused', () => {
  assert.equal(parseDraftText('a'.repeat(2200), 'instagram').length, 2200);
  refused(() => parseDraftText('a'.repeat(2201), 'instagram'), '2,200', '2,201');
});

test('U09/U10 Instagram: 30 hashtags accepted, 31 refused naming 30 hashtags', () => {
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `#t${i}`).join(' ');
  assert.equal(parseDraftText(tags(30), 'instagram'), tags(30));
  refused(() => parseDraftText(tags(31), 'instagram'), '30 hashtags', '31 hashtags');
});

test('U11 hashtag spellings', () => {
  for (const [text, n] of HASHTAG_CASES) assert.equal(limits.countHashtags(text), n, text);
});

test('U12/U13 X single tweet: 280 accepted, 281 refused naming 280', () => {
  assert.equal(parseDraftText('a'.repeat(280), 'x').length, 280);
  refused(() => parseDraftText('a'.repeat(281), 'x'), '280', '281', /The tweet/);
});

test('U14/U15 thread separators and empty segments', () => {
  for (const [text, tweets] of THREAD_CASES) assert.deepEqual(limits.splitThread(text), tweets, JSON.stringify(text));
});

test('U16/U17 X: 25 tweets of 280 accepted, 26 refused naming 25', () => {
  const t25 = thread(...Array.from({ length: 25 }, () => 'a'.repeat(280)));
  assert.equal(parseDraftText(t25, 'x'), t25, 'stored as the raw trimmed text');
  refused(() => parseDraftText(thread(...Array.from({ length: 26 }, () => 'b')), 'x'), '25 tweets', '26 tweets');
});

test('U18 a thread whose tweet 3 has 281 is refused naming the tweet and 280', () => {
  refused(() => parseDraftText(thread('a', 'b', 'c'.repeat(281), 'd'), 'x'), 'Tweet 3 of 4', '281', '280');
});

test('U19/U20 one tweet after dropping empties is a single tweet; only separators is empty', () => {
  refused(() => parseDraftText(`---\n${'a'.repeat(281)}\n---`, 'x'), /The tweet is 281/);
  refused(() => parseDraftText('---\n---', 'x'), /must not be empty/);
});

test('U21 blog length: 300 and 50,000 accepted, 299 and 50,001 refused', () => {
  const article = (n: number) => `# T\n${'a'.repeat(n - 4)}`;
  assert.equal([...parseDraftText(article(300), 'blog')].length, 300);
  assert.equal([...parseDraftText(article(50000), 'blog')].length, 50000);
  refused(() => parseDraftText(article(299), 'blog'), '300', '299');
  refused(() => parseDraftText(article(50001), 'blog'), '50,000', '50,001');
});

test('U22 blog title: "# Title" first line, after trimming leading blank lines', () => {
  const body = `\n${'a'.repeat(400)}`;
  assert.ok(parseDraftText(`# Title${body}`, 'blog').startsWith('# Title'));
  assert.ok(parseDraftText(`\n\n  # Title${body}`, 'blog').startsWith('# Title'));
  for (const bad of ['#Title', '## Title', 'Title', '# ']) refused(() => parseDraftText(`${bad}${body}`, 'blog'), /"# " followed by the title/);
});

test('U23 code points: 🏘️ counts 2, and 3,000 astral emoji fit LinkedIn', () => {
  assert.equal(limits.platformDraftProblem('linkedin', CASES.emoji.text), null);
  assert.equal([...CASES.emoji.text].length, CASES.emoji.count);
  assert.equal(web.charCount(CASES.emoji.text), CASES.emoji.count);
  const emoji = '😀'.repeat(3000);
  assert.equal(emoji.length, 6000);
  assert.equal(parseDraftText(emoji, 'linkedin'), emoji);
  refused(() => parseDraftText(`${emoji}😀`, 'linkedin'), '3,001');
});

test('U24 the text is trimmed before counting and stored trimmed', () => {
  assert.equal(parseDraftText(`  \n${'a'.repeat(3000)}\n  `, 'linkedin'), 'a'.repeat(3000));
});

test('U25 type checks are unchanged for a platform', () => {
  for (const bad of [3, null, ['x'], { text: 'x' }, '  \n ']) refused(() => parseDraftText(bad, 'linkedin'));
});

test('U26 the script keeps the general 1 to 50,000 rule and no platform rule', () => {
  assert.equal(parseDraftText('a'.repeat(50000)).length, 50000);
  assert.equal(parseDraftText('#'.repeat(1) + 'a'.repeat(4000)).length, 4001, 'no LinkedIn or blog rule');
  refused(() => parseDraftText('a'.repeat(50001)), /at most 50000/);
});

test('U27 the refusal is a 400 ContentInputError on field text with the limit and the actual count', () => {
  try { parseDraftText('a'.repeat(2201), 'instagram'); assert.fail('expected a refusal'); } catch (e) {
    assert.ok(e instanceof ContentInputError);
    assert.deepEqual([e.status, e.field], [400, 'text']);
    assert.match(e.message, /2,201 characters; the limit is 2,200 characters/);
  }
});

test('U28 the rule text of each platform comes from the shared table', () => {
  assert.deepEqual(Object.keys(limits.PLATFORM_RULE_TEXT).sort(), ['blog', 'facebook', 'instagram', 'linkedin', 'x']);
  assert.match(limits.PLATFORM_RULE_TEXT.linkedin, /3,000/);
  assert.match(limits.PLATFORM_RULE_TEXT.facebook, /63,206/);
  assert.match(limits.PLATFORM_RULE_TEXT.x, /280.*25 tweets.*---/);
  assert.match(limits.PLATFORM_RULE_TEXT.instagram, /2,200.*30 hashtags/);
  assert.match(limits.PLATFORM_RULE_TEXT.blog, /# title, 300 to 50,000/);
});
