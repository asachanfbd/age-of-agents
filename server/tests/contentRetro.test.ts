import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { createRetroAgent, NO_AGENT_REASON } from '../src/content/retroAgent.ts';
import {
  applyChanges, changeProblem, chooseChanges, occurrences, parseRetroAnswer, RetroAnswerError, retroInstructions, retroLabel, retroPrompt, retroSkipped, sectionRange,
} from '../src/content/retroRules.ts';
import type { StyleChange } from '../src/content/retroRules.ts';
import { rememberSecret } from '../src/redaction.ts';

/** The writing-style retro's pure rules (content/retroRules.ts) and its agent (content/retroAgent.ts) with fake turns. */

const STYLE = '# Writing style\n\n## General\n\nBe plain.\nNo jargon.\n\n## LinkedIn\n\n## Instagram\n\nUse emoji sparingly.\n\n## X\n\n## Facebook\n\n## Blog\n\nLong form.\n\n## Video script\n\nHook first.\n';
const answer = (changes: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ summary: 'Tighter hooks', changes, ...extra });
const add = (section: string, text = 'New rule.', reason = 'The owner added it') => ({ section, action: 'add', text, reason });
const replace = (section: string, find: string, text = 'Swapped.') => ({ section, action: 'replace', find, text, reason: 'Edited' });
const remove = (section: string, find: string) => ({ section, action: 'remove', find, reason: 'Cut' });
const refused = (raw: string, pattern: RegExp, style = STYLE) => assert.throws(() => parseRetroAnswer(raw, style), (e: unknown) => e instanceof RetroAnswerError && pattern.test(e.message));
const change = (id: number, c: Record<string, unknown>) => ({ id, ...c }) as StyleChange;
/** The document outside a section's body, which a change to that section must leave byte-identical. */
const outside = (content: string, section: string) => { const r = sectionRange(content, section)!; return [content.slice(0, r.start), content.slice(r.end)]; };
const applied = (content: string, changes: StyleChange[]) => { const r = applyChanges(content, changes); assert.ok('content' in r, JSON.stringify(r)); return r.content; };

test('SU01 a valid answer with add, replace and remove parses, with ids 0..2', () => {
  const parsed = parseRetroAnswer(answer([add('LinkedIn'), replace('General', 'Be plain.'), remove('Video script', 'Hook first.')]), STYLE);
  assert.equal(parsed.summary, 'Tighter hooks');
  assert.deepEqual(parsed.changes.map((c) => [c.id, c.section, c.action]), [[0, 'LinkedIn', 'add'], [1, 'General', 'replace'], [2, 'Video script', 'remove']]);
  assert.equal('find' in parsed.changes[0]!, false);
  assert.equal('text' in parsed.changes[2]!, false);
});

test('SU02/SU03 an empty change list parses, and whitespace around the JSON is accepted', () => {
  assert.deepEqual(parseRetroAnswer(answer([]), STYLE).changes, []);
  assert.equal(parseRetroAnswer(`\n  ${answer([])}  \n`, STYLE).summary, 'Tighter hooks');
});

test('SU04-SU07 a fenced, wrapped, partial or non-object answer fails', () => {
  refused('```json\n' + answer([]) + '\n```', /code fence/);
  refused(`Here you go: ${answer([])}`, /nothing around it/);
  refused(`${answer([])}\nThanks!`, /nothing around it/);
  refused(answer([]).slice(0, 20), /nothing around it/);
  for (const raw of ['[]', 'null', '"text"', '5']) refused(raw, /not a JSON object/);
});

test('SU08/SU09 an extra field at the top or inside a change fails', () => {
  refused(answer([], { notes: 'x' }), /unexpected field "notes"/);
  refused(answer([{ ...add('General'), confidence: 1 }]), /change 1: unexpected field "confidence"/);
  refused(answer(['add']), /change 1: it is not an object/);
});

test('SU10/SU11 summary must be non-empty text and changes a list', () => {
  refused(JSON.stringify({ changes: [] }), /summary/);
  refused(answer([], { summary: 3 }), /summary/);
  refused(answer([], { summary: '  ' }), /summary/);
  refused(JSON.stringify({ summary: 's', changes: {} }), /changes must be a list/);
  refused(JSON.stringify({ summary: 's' }), /changes must be a list/);
});

test('SU12 ten changes pass and eleven fail', () => {
  const ten = Array.from({ length: 10 }, (_, i) => add('General', `Rule ${i}.`));
  assert.equal(parseRetroAnswer(answer(ten), STYLE).changes.length, 10);
  refused(answer([...ten, add('General')]), /more than 10 changes/);
});

test('SU13/SU14 section and action names are a closed, case-sensitive set', () => {
  for (const section of ['linkedin', 'Video Script', 'Twitter']) refused(answer([add(section)]), /section must be one of/);
  for (const action of ['Add', 'ADD', 'insert']) refused(answer([{ ...add('General'), action }]), /action must be add, replace or remove/);
});

test('SU15/SU16/SU22/SU24 find and text are required or forbidden by action', () => {
  refused(answer([{ section: 'General', action: 'replace', text: 'x', reason: 'r' }]), /find is required for replace/);
  refused(answer([{ section: 'General', action: 'remove', reason: 'r' }]), /find is required for remove/);
  refused(answer([{ ...add('General'), find: 'Be plain.' }]), /find is not used by add/);
  refused(answer([{ ...remove('General', 'Be plain.'), text: 'x' }]), /text is not used by remove/);
  refused(answer([{ section: 'General', action: 'add', reason: 'r' }]), /text is required for add/);
  refused(answer([add('General', '')]), /text is required for add/);
  refused(answer([{ ...replace('General', 'Be plain.'), text: 5 }]), /text is required for replace/);
  refused(answer([replace('General', '')]), /find is required for replace/);
});

test('SU17/SU18/SU20 find must occur exactly once, case-sensitively, overlapping matches counted', () => {
  refused(answer([replace('General', 'Missing text')]), /must occur exactly once in General but occurs 0 times/);
  refused(answer([replace('General', 'be plain.')]), /occurs 0 times/);
  const twice = STYLE.replace('No jargon.', 'Be plain.');
  refused(answer([remove('General', 'Be plain.')]), /occurs 2 times/, twice);
  assert.equal(occurrences('aaa', 'aa'), 2);
  refused(answer([remove('General', 'aa')]), /occurs 2 times/, STYLE.replace('No jargon.', 'aaa'));
});

test('SU19 a find that also appears in another section passes: the count is per section', () => {
  const both = STYLE.replace('Long form.', 'Be plain.');
  assert.equal(parseRetroAnswer(answer([replace('General', 'Be plain.')]), both).changes.length, 1);
});

test('SU21 text of 2,000 characters (also emoji) passes, 2,001 fails', () => {
  assert.equal(parseRetroAnswer(answer([add('General', 'a'.repeat(2000))]), STYLE).changes.length, 1);
  assert.equal(parseRetroAnswer(answer([add('General', '😀'.repeat(2000))]), STYLE).changes.length, 1);
  refused(answer([add('General', 'a'.repeat(2001))]), /at most 2,000 characters/);
});

test('SU23 reason must be non-empty text', () => {
  for (const reason of [undefined, '', '  ', 7]) refused(answer([{ section: 'General', action: 'add', text: 'x', reason }]), /reason must be non-empty text/);
});

test('SU25 a change for a section whose heading is gone fails', () => {
  refused(answer([add('Facebook')]), /Facebook section is missing/, STYLE.replace('## Facebook\n\n', ''));
});

test('SA10 and the heading rule: a find never matches a heading, and text never adds one', () => {
  refused(answer([replace('LinkedIn', '## LinkedIn')]), /occurs 0 times/);
  refused(answer([add('LinkedIn', 'Intro\n## Hacked')]), /must not contain a line starting with "## "/);
  assert.equal(parseRetroAnswer(answer([add('LinkedIn', 'Intro\n### Sub heading')]), STYLE).changes.length, 1);
});

test('sectionRange finds the body between headings, and null for a missing heading', () => {
  const r = sectionRange(STYLE, 'General')!;
  assert.equal(STYLE.slice(r.start, r.end), '\nBe plain.\nNo jargon.\n\n');
  const last = sectionRange(STYLE, 'Video script')!;
  assert.equal(STYLE.slice(last.start, last.end), '\nHook first.\n');
  assert.equal(sectionRange(STYLE, 'Nope'), null);
  assert.deepEqual(sectionRange('## General', 'General'), { start: 10, end: 10 });
});

test('SA01 add appends after the section\'s last line and leaves every other byte alone', () => {
  const next = applied(STYLE, [change(0, add('General', 'Short sentences.'))]);
  assert.ok(next.includes('## General\n\nBe plain.\nNo jargon.\nShort sentences.\n\n## LinkedIn'));
  assert.deepEqual(outside(next, 'General'), outside(STYLE, 'General'));
});

test('SA02/SA03 add to an empty section becomes its body; add to the last section ends the file cleanly', () => {
  assert.ok(applied(STYLE, [change(0, add('LinkedIn', 'Open with a question.'))]).includes('## LinkedIn\n\nOpen with a question.\n\n## Instagram'));
  assert.ok(applied(STYLE, [change(0, add('Video script', 'End with a call to action.'))]).endsWith('## Video script\n\nHook first.\nEnd with a call to action.\n'));
  const emptyLast = '## General\n\n## Video script\n';
  assert.equal(applied(emptyLast, [change(0, add('Video script', 'Hook.'))]), '## General\n\n## Video script\n\nHook.\n');
});

test('SA04/SA05 replace swaps the one occurrence; remove drops inline text, or a whole line with its newline', () => {
  assert.ok(applied(STYLE, [change(0, replace('General', 'Be plain.', 'Be clear.'))]).includes('\nBe clear.\nNo jargon.\n'));
  assert.ok(applied(STYLE, [change(0, remove('General', ' jargon'))]).includes('\nBe plain.\nNo.\n'));
  assert.ok(applied(STYLE, [change(0, remove('General', 'No jargon.'))]).includes('## General\n\nBe plain.\n\n## LinkedIn'));
  assert.ok(applied(STYLE, [change(0, remove('Video script', 'Hook first.'))]).endsWith('## Video script\n\n'));
});

test('SA06 changes apply in order; one whose find an earlier change removed is listed as failed', () => {
  const r = applyChanges(STYLE, [change(0, replace('General', 'Be plain.', 'Be clear.')), change(1, remove('General', 'Be plain.'))]);
  assert.ok('failed' in r);
  assert.deepEqual(r.failed.map((f) => [f.id, f.section, f.action]), [[1, 'General', 'remove']]);
  assert.equal(applied(STYLE, [change(0, add('General', 'One.')), change(1, add('General', 'Two.'))]).includes('No jargon.\nOne.\nTwo.\n'), true);
});

test('SA07/SA08 a stale find (now absent or twice) fails with its id, section, action and reason, and nothing applies', () => {
  const gone = applyChanges(STYLE.replace('Be plain.', 'Be simple.'), [change(0, add('Blog', 'x')), change(1, replace('General', 'Be plain.'))]);
  assert.ok('failed' in gone);
  assert.deepEqual(gone.failed, [{ id: 1, section: 'General', action: 'replace', reason: '"Be plain." must occur exactly once in General but occurs 0 times' }]);
  const twice = applyChanges(STYLE.replace('No jargon.', 'Be plain.'), [change(0, remove('General', 'Be plain.'))]);
  assert.ok('failed' in twice && /2 times/.test(twice.failed[0]!.reason));
  const missing = applyChanges(STYLE.replace('## Blog\n', ''), [change(0, add('Blog', 'x'))]);
  assert.ok('failed' in missing && /Blog section is missing/.test(missing.failed[0]!.reason));
});

test('SA09 a result over 50,000 characters refuses every change', () => {
  const big = STYLE.replace('Long form.', 'x'.repeat(50_000 - STYLE.length + 'Long form.'.length - 10));
  const r = applyChanges(big, [change(0, add('General', 'a'.repeat(30))), change(1, add('Blog', 'b'))]);
  assert.ok('failed' in r);
  assert.deepEqual(r.failed.map((f) => f.id), [0, 1]);
  assert.match(r.failed[0]!.reason, /over 50,000 characters/);
});

test('long find texts are shortened in the reason', () => {
  const r = applyChanges(STYLE, [change(0, replace('General', 'z'.repeat(100)))]);
  assert.ok('failed' in r && r.failed[0]!.reason.includes(`${'z'.repeat(60)}…`));
});

test('SK01-SK05 the skip rule: no drafts, or one draft exactly equal to the finalized text', () => {
  assert.equal(retroSkipped(['Final'], 'Final'), true);
  assert.equal(retroSkipped(['Draft'], 'Final'), false);
  assert.equal(retroSkipped(['Draft', 'Final'], 'Final'), false);
  assert.equal(retroSkipped([], 'Final'), true);
  assert.equal(retroSkipped(['Final  '], 'Final'), false);
});

test('SP01/SP02 the prompt holds every draft in order with its round, the finalized text, the label and the style', () => {
  const prompt = retroPrompt({ label: retroLabel('script', null, null), drafts: [{ round: 1, text: 'first' }, { round: 1, text: 'second' }, { round: 2, text: 'third' }], finalized: 'FINAL TEXT', style: STYLE });
  assert.ok(prompt.indexOf('### Draft 1 (round 1)\n\nfirst') < prompt.indexOf('### Draft 2 (round 1)\n\nsecond'));
  assert.ok(prompt.indexOf('second') < prompt.indexOf('### Draft 3 (round 2)\n\nthird'));
  assert.ok(prompt.includes('The text the owner finalized\n\nFINAL TEXT'));
  assert.ok(prompt.includes('Hook first.'));
  assert.ok(prompt.startsWith('What was written: Video script'));
  assert.equal(retroLabel('post-text', 'linkedin', 'text'), 'LinkedIn · text');
  assert.equal(retroLabel('article', 'blog', 'article'), 'Blog · article');
  assert.equal(retroLabel('post-text', null, null), 'Video script');
});

test('SP03 a remembered secret never reaches the prompt or the instructions', () => {
  const secret = 'sk-retro-SECRET-4242';
  rememberSecret(secret);
  const prompt = retroPrompt({ label: 'X', drafts: [{ round: 1, text: `key ${secret}` }], finalized: secret, style: secret });
  assert.equal(prompt.includes(secret), false);
  assert.equal(retroInstructions(`skill ${secret}`).includes(secret), false);
});

test('SP04 the skill text is in the instructions when given, and the instructions still build without it', () => {
  assert.ok(retroInstructions('SKILL-BODY').includes('## Writing skill'));
  assert.ok(retroInstructions('SKILL-BODY').includes('SKILL-BODY'));
  const without = retroInstructions(null);
  assert.equal(without.includes('## Writing skill'), false);
  for (const part of ['"summary"', '"Video script"', 'at most 10 changes', 'no code fence', 'Do not use any tools']) assert.ok(without.includes(part), part);
});

test('changeProblem accepts an edited change that follows the agent\'s rules', () => {
  assert.equal(changeProblem({ section: 'General', action: 'replace', find: 'a', text: 'b', reason: 'r' }), null);
  assert.equal(changeProblem({ section: 'General', action: 'remove', find: 'a', reason: 'r' }), null);
});

const PROPOSED: StyleChange[] = [change(0, add('General', 'One.')), change(1, replace('General', 'Be plain.', 'Be clear.')), change(2, remove('Video script', 'Hook first.'))];
const badInput = (body: Record<string, unknown>, field: string) => assert.throws(() => chooseChanges(PROPOSED, body), (e: any) => e.status === 400 && e.field === field);

test('chooseChanges: all by default, minus exclusions, with edits; exclusion wins and duplicates count once', () => {
  assert.deepEqual(chooseChanges(PROPOSED, {}), PROPOSED);
  assert.deepEqual(chooseChanges(PROPOSED, { exclude: [0, 0, 2] }).map((c) => c.id), [1]);
  const edited = chooseChanges(PROPOSED, { changes: [{ id: 1, text: 'Mine.' }, { id: 0, text: 'Two.' }, { id: 0, text: 'Three.' }] });
  assert.deepEqual(edited.map((c) => c.text), ['Three.', 'Mine.', undefined]);
  assert.equal(edited[1]!.find, 'Be plain.');
  assert.deepEqual(chooseChanges(PROPOSED, { exclude: [1], changes: [{ id: 1, text: '' }] }).map((c) => c.id), [0, 2]);
  assert.equal(chooseChanges(PROPOSED, { changes: [{ id: 2, find: 'Hook' }] })[2]!.find, 'Hook');
});

test('chooseChanges refuses bad ids, bad edits and excluding everything with 400 and the field', () => {
  for (const exclude of ['0', [-1], [1.5], ['1'], [2 ** 53], [3], null]) badInput({ exclude }, 'exclude');
  badInput({ exclude: [0, 1, 2] }, 'exclude');
  for (const changes of [{}, [5], [{ id: 9, text: 'x' }], [{ id: 0, section: 'Blog' }], [{ id: 0, text: 3 }], [{ text: 'x' }]]) badInput({ changes }, 'changes');
  badInput({ changes: [{ id: 0, text: 'a'.repeat(2001) }] }, 'changes');
  badInput({ changes: [{ id: 1, find: '' }] }, 'changes');
  badInput({ changes: [{ id: 0, find: 'Be plain.' }] }, 'changes');
});

type Turn = { executor: unknown; options: any; context: any };
const fakeTurns = (result: { status: string; message: string; extra?: Record<string, unknown> } | null, seen: Turn[] = []) => ({
  selectExecutor: async () => (result ? { id: 'exec' } : null),
  runTurn: async (executor: unknown, options: any, context: any) => { seen.push({ executor, options, context }); await access(options.cwd); return result!; },
});

test('SG01 no usable executor: the agent says no agent is available', async () => {
  await assert.rejects(createRetroAgent(fakeTurns(null)).run({ buildingId: 'b', prompt: 'p', instructions: 'i' }), new RegExp(NO_AGENT_REASON.slice(0, 20)));
  assert.match(NO_AGENT_REASON, /^No agent is available/);
});

test('SG02 a turn that is not done, or has no text, fails with the agent\'s message', async () => {
  await assert.rejects(createRetroAgent(fakeTurns({ status: 'blocked', message: 'quota hit' })).run({ buildingId: 'b', prompt: 'p', instructions: 'i' }), /did not answer: quota hit/);
  await assert.rejects(createRetroAgent(fakeTurns({ status: 'done', message: 'ok', extra: {} })).run({ buildingId: 'b', prompt: 'p', instructions: 'i' }), /did not answer/);
});

test('SG03 the turn has every tool disallowed, a JSON schema, a retro purpose and a throwaway folder that is removed', async () => {
  const seen: Turn[] = [];
  const text = await createRetroAgent(fakeTurns({ status: 'done', message: 'ok', extra: { text: '{"summary":"s","changes":[]}' } }, seen)).run({ buildingId: 'b1', prompt: 'PROMPT', instructions: 'INSTR' });
  assert.equal(text, '{"summary":"s","changes":[]}');
  const { options, context } = seen[0]!;
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']) assert.ok(options.disallowedTools.includes(tool), tool);
  assert.deepEqual(options.jsonSchema.required, ['status', 'message', 'text']);
  assert.equal(options.prompt, 'PROMPT');
  assert.equal(options.appendSystemPrompt, 'INSTR');
  assert.deepEqual(context, { purpose: 'Content Studio writing-style retro', projectId: 'b1' });
  assert.match(options.cwd, /agent-visual-os-retro-/);
  await assert.rejects(access(options.cwd));
  options.onProcess({ kill() {} });
});
