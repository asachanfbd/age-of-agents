import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ContentCtx } from '../src/content/context.ts';
import { openContentDb, readMeta, writeMeta } from '../src/content/db.ts';
import { scriptDraftProblem } from '../src/content/scriptDraftRules.ts';
import { parseSpeakingWpm, saveSpeakingWpm, speakingSpeed, SPEAKING_WPM_KEY } from '../src/content/speakingSpeed.ts';
import { parseDraftText } from '../src/content/studioDrafts.ts';
import { studioSystemPrompt } from '../src/content/studioInstructions.ts';
import { SCRIPT_ONLY_RULE, STUDIO_TABS } from '../src/content/studioTabs.ts';

/** 37.006: the speaking speed setting, the script-only draft guard and the script job's rule. Pure; in-memory db. */

const memoryCtx = () => ({ db: openContentDb(':memory:') }) as unknown as ContentCtx;

test('SU01 no meta row reads as the default speed', () => {
  assert.deepEqual(speakingSpeed(memoryCtx()), { speakingWpm: 150, source: 'default', sampleCount: 0 });
});

test('SU02 a whole number from 20 to 400 parses', () => {
  for (const n of [20, 150, 400]) assert.equal(parseSpeakingWpm(n), n);
});

test('SU03/SU04/SU05/SU06 anything else is a 400 naming speakingWpm (no null reset)', () => {
  const bad: unknown[] = [19, 401, 0, -1, 150.5, 20.0001, 9007199254740993, 1e308, Infinity, NaN, '150', null, true, [], {}, undefined];
  for (const value of bad) {
    assert.throws(() => parseSpeakingWpm(value), (e: any) => e.status === 400 && e.field === 'speakingWpm' && /whole number from 20 to 400/.test(e.message), String(value));
  }
});

test('SU07 saving 180 and then 150 writes the row each time and both read back as manual', () => {
  const ctx = memoryCtx();
  saveSpeakingWpm(ctx, 180);
  assert.equal(readMeta(ctx.db, SPEAKING_WPM_KEY), '180');
  assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 180, source: 'manual', sampleCount: 0 });
  saveSpeakingWpm(ctx, 150);
  assert.equal(readMeta(ctx.db, SPEAKING_WPM_KEY), '150');
  assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 150, source: 'manual', sampleCount: 0 });
});

test('SU08 a corrupt meta row reads as the default', () => {
  for (const raw of ['abc', '999', '19', '150.5', '', ' 150', '1e2']) {
    const ctx = memoryCtx();
    writeMeta(ctx.db, SPEAKING_WPM_KEY, raw);
    assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 150, source: 'default', sampleCount: 0 }, raw);
  }
});

const ACCEPTED: [string, string][] = [
  ['plain paragraphs', 'You reply three hours later.\n\nThey already bought next door.'],
  ['Hindi/Hinglish', 'दोस्तों, aaj hum baat karenge WhatsApp replies ki.\n\nअसली समस्या यही है, आपका प्रोडक्ट नहीं।'],
  ['a colon mid-sentence', 'Note: call us at 5:30 and we will pick up.'],
  ['an inline aside', 'Save these replies (and yes, it works) in two minutes.'],
  ['a direction that starts a spoken line', '[pause] and then we go'],
  ['a hashtag without a space', '#hashtag is how people find you.'],
  ['seven hashes then a space', '####### not a heading'],
  ['a 41-code-point line ending in a colon', `${'a'.repeat(40)}:`],
  ['a hook that starts with Here is', "Here's why your sales dropped."],
  ['an emoji-only line', 'Great work.\n🔥🔥\nSee you tomorrow.'],
  ['a URL', 'Visit https://example.com/offer today.'],
  ['inline code', 'Type `hello` to start.'],
  ['blank lines between paragraphs', 'One.\n\n\n\nTwo.'],
  ['Here is the script after spoken lines (SU16)', 'Line one.\nLine two.\nLine three.\nHere is the script I promised you.'],
];

test('SU09/SU16 the guard accepts spoken text, colons and brackets inside sentences, and Hindi/Hinglish', () => {
  for (const [name, text] of ACCEPTED) assert.equal(scriptDraftProblem(text), null, name);
});

const REFUSED: [string, string, number, RegExp][] = [
  ['SU10 a heading on line 1', '# Title\nSpoken.', 1, /^Remove the heading on line 1 and save only the spoken script$/],
  ['SU11 a level-6 heading on line 3', 'One.\nTwo.\n###### H\nFour.', 3, /heading on line 3/],
  ['SU12 a code fence', 'One.\n```\ncode\n```', 2, /code fence on line 2/],
  ['SU12 a fence with a language', '```js\nx', 1, /code fence on line 1/],
  ['SU12 a tilde fence', 'One.\n~~~', 2, /code fence on line 2/],
  ['SU13 Hook:', 'Hook:\nSpoken.', 1, /label "Hook:" on line 1/],
  ['SU13 CTA:', 'Spoken.\nCTA:', 2, /label "CTA:" on line 2/],
  ['SU13 Scene 1:', 'Scene 1:\nSpoken.', 1, /label "Scene 1:"/],
  ['SU13 padded Intro:', 'Spoken.\n  Intro:  \nMore.', 2, /label "Intro:" on line 2/],
  ['SU13 Hindi label', 'हुक:\nबोलिए।', 1, /label "हुक:"/],
  ['SU13 exactly 40 code points', `${'a'.repeat(39)}:\nSpoken.`, 1, /label/],
  ['SU14 [pause]', 'One.\n[pause]\nTwo.', 2, /bracketed direction on line 2/],
  ['SU14 (show screen)', '(show screen)\nOne.', 1, /bracketed direction on line 1/],
  ['SU14 padded', 'One.\n  [pause]  ', 2, /bracketed direction on line 2/],
  ['SU14 two groups', '[pause] (smile)\nOne.', 1, /bracketed direction on line 1/],
  ['SU15 Here is the script:', 'Here is the script:\nOne.', 1, /preface on line 1/],
  ["SU15 Here's your draft", "Here's your draft\n\nOne.", 1, /preface on line 1/],
  ['SU15 curly apostrophe, lower case', 'here’s the final version\nOne.', 1, /preface on line 1/],
  ['SU15 HERE IS:', 'HERE IS:\nOne.', 1, /preface on line 1/],
  ['SU17 CRLF', 'Hook:\r\nBody', 1, /label "Hook:" on line 1/],
  ['SU18 leading blank lines', '\n\n# Title\nOne.', 1, /heading on line 1/],
  ['SU19 the first problem only', 'One.\n# Two\nThree.\nHook:', 2, /heading on line 2/],
];

test('SU10-SU19 the guard refuses headings, fences, labels, bracketed directions and prefaces, naming the first line', () => {
  for (const [name, text, line, message] of REFUSED) {
    const problem = scriptDraftProblem(text);
    assert.ok(problem, name);
    assert.match(problem, message, name);
    assert.match(problem, new RegExp(`on line ${line} `), name);
  }
  assert.doesNotMatch(scriptDraftProblem('One.\n# Two\nThree.\nHook:')!, /line 4/);
});

test('SU20 every rule names the line and the fix', () => {
  for (const [name, text] of REFUSED) assert.match(scriptDraftProblem(text)!, /^Remove the .+ on line \d+ and save only the spoken script$/, name);
});

test('parseDraftText applies the guard only to a script, after the empty and length checks', () => {
  assert.throws(() => parseDraftText('# Title\nSpoken.', null, 'script'), (e: any) => e.status === 400 && e.field === 'text' && /heading on line 1/.test(e.message));
  assert.throws(() => parseDraftText('   ', null, 'script'), /must not be empty/);
  assert.throws(() => parseDraftText(`# ${'a'.repeat(60_000)}`, null, 'script'), /at most/);
  assert.equal(parseDraftText('  Hook:\nBody  ', null, 'post-text'), 'Hook:\nBody');
  assert.equal(parseDraftText('# Title\nBody'), '# Title\nBody', 'no kind: no guard');
  assert.equal(parseDraftText('  Spoken words.  ', null, 'script'), 'Spoken words.');
});

const concept = { title: 'T', brief: '', posts: [] };
const scriptPrompt = () => studioSystemPrompt({ tab: STUDIO_TABS.script!, concept, buildingDir: '/b', skillText: null });

test('SU21 the script prompt carries every script-only rule and sends notes to the chat', () => {
  const prompt = scriptPrompt();
  for (const part of ['only the spoken script, as plain paragraphs', 'no lines starting with #', '"Hook:", "Intro:", "Scene 1" or "CTA:"', '[pause] or (show screen)', 'timestamps', 'word-count or duration notes', 'notes to the owner', '"Here is the script"', 'markdown emphasis, bullets or code fences', 'emoji, unless they are spoken', 'goes in the chat, never in the draft']) {
    assert.ok(prompt.includes(part), part);
  }
});

test('SU22 the script job still covers length, hook and call to action', () => {
  assert.match(scriptPrompt(), /If the length, the hook or the call to action is unclear, make a sensible choice and note it in the chat/);
});

test('SU23 no other tab carries the script-only rule', () => {
  for (const [key, tab] of Object.entries(STUDIO_TABS)) {
    if (key === 'script') continue;
    assert.equal(tab.job.includes(SCRIPT_ONLY_RULE), false, key);
    assert.equal(tab.job.includes('only the spoken script'), false, key);
  }
});

test('SU24 Claude and Codex get the same text: one prompt builder with no executor input', () => {
  assert.equal(scriptPrompt(), scriptPrompt());
  assert.ok(scriptPrompt().includes(SCRIPT_ONLY_RULE));
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'content', 'studioInstructions.ts'), 'utf8');
  assert.match(source, /both CLIs receive exactly this text/);
  assert.doesNotMatch(source, /codex/i);
});

test('SU25 the product doc covers the speed setting, the footer, the script rules, the refusals and the limit', () => {
  const doc = readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'content-studio-building.md'), 'utf8');
  for (const part of ['Speaking speed (words per minute)', '20 to 400', 'default 150', 'speakingWpm', 'Script stats', 'only the spoken script', 'save only the spoken script', 'Speaking speed: a whole number']) assert.ok(doc.includes(part), part);
});
