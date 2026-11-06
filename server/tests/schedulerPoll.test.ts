import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiReading, canonicalJson, comparePoll, filesBaseline, parseJsonPath } from '../src/scheduler/pollDetection.ts';
import type { FileEntry, PollComparison } from '../src/scheduler/pollDetection.ts';
import type { DetectMode, PollBaseline } from '../src/scheduler/types.ts';

/** A fake folder: path to [modified time, content]. Its entries carry a content hash, as the real source's `hash` mode does. */
type Tree = Record<string, [number, string]>;
const entries = (tree: Tree): FileEntry[] => Object.entries(tree).map(([path, [mtimeMs, content]]) => ({ path, mtimeMs, size: content.length, hash: `h:${content}` }));
const snapshot = (tree: Tree, detect: DetectMode) => filesBaseline(entries(tree), detect);
const diff = (before: Tree, after: Tree, detect: DetectMode): PollComparison => comparePoll(snapshot(before, detect), snapshot(after, detect));
const summaryOf = (comparison: PollComparison): string => (comparison.changed ? comparison.summary : '');
const api = (body: unknown, jsonField: string | null = null, status = 200) => apiReading({ status, body: typeof body === 'string' ? body : JSON.stringify(body) }, jsonField);
const baselineOf = (reading: ReturnType<typeof api>): PollBaseline => {
  assert.equal(reading.ok, true, JSON.stringify(reading));
  return (reading as { baseline: PollBaseline }).baseline;
};
const apiDiff = (before: unknown, after: unknown, jsonField: string | null = null) => comparePoll(baselineOf(api(before, jsonField)), baselineOf(api(after, jsonField)), jsonField ?? undefined);

const NOTES: Tree = { 'a.md': [100, 'alpha'], 'b.md': [100, 'beta'] };

test('UP01 the first snapshot of a folder is a baseline: comparing it with itself reports no change', () => {
  for (const detect of ['mtime', 'hash'] as const) assert.deepEqual(diff(NOTES, NOTES, detect), { changed: false });
});

test('UP02 mtime mode: one modified file is a change whose summary names the file', () => {
  assert.deepEqual(diff(NOTES, { ...NOTES, 'a.md': [200, 'alpha'] }, 'mtime'), { changed: true, summary: '1 modified: a.md' });
});

test('UP03 a file added, removed or renamed is a change in both modes, with counts', () => {
  for (const detect of ['mtime', 'hash'] as const) {
    assert.equal(summaryOf(diff(NOTES, { ...NOTES, 'c.md': [100, 'gamma'] }, detect)), '1 added: c.md');
    assert.equal(summaryOf(diff(NOTES, { 'a.md': NOTES['a.md']! }, detect)), '1 removed: b.md');
    assert.equal(summaryOf(diff(NOTES, { 'a.md': NOTES['a.md']!, 'renamed.md': NOTES['b.md']! }, detect)), '1 added: renamed.md; 1 removed: b.md');
  }
});

test('UP04 hash mode: a new modified time with the same content is no change', () => {
  assert.deepEqual(diff(NOTES, { ...NOTES, 'a.md': [999, 'alpha'] }, 'hash'), { changed: false });
});

test('UP05 hash mode: new content with the same time and size is a change', () => {
  assert.deepEqual(diff(NOTES, { ...NOTES, 'a.md': [100, 'ALPHA'] }, 'hash'), { changed: true, summary: '1 modified: a.md' });
});

test('UP06 mtime mode: new content with the same time and size is not seen (the documented limit)', () => {
  assert.deepEqual(diff(NOTES, { ...NOTES, 'a.md': [100, 'ALPHA'] }, 'mtime'), { changed: false });
  assert.equal(diff(NOTES, { ...NOTES, 'a.md': [100, 'longer alpha'] }, 'mtime').changed, true, 'a size change is seen');
});

test('UP07 a single watched file, in both modes', () => {
  for (const detect of ['mtime', 'hash'] as const) {
    assert.deepEqual(diff({ 'notes.md': [1, 'one'] }, { 'notes.md': [1, 'one'] }, detect), { changed: false });
    assert.equal(summaryOf(diff({ 'notes.md': [1, 'one'] }, { 'notes.md': [2, 'two'] }, detect)), '1 modified: notes.md');
  }
});

test('UP08 nested folders are covered, and the reading order does not matter', () => {
  const tree: Tree = { 'a.md': [1, 'a'], 'deep/b.md': [1, 'b'], 'deep/er/c.md': [1, 'c'] };
  const reversed = filesBaseline([...entries(tree)].reverse(), 'hash');
  assert.deepEqual(JSON.stringify(reversed), JSON.stringify(snapshot(tree, 'hash')));
  assert.equal(summaryOf(diff(tree, { ...tree, 'deep/er/c.md': [1, 'changed'] }, 'hash')), '1 modified: deep/er/c.md');
});

test('UP09 an empty folder gaining its first file is a change', () => {
  assert.equal(summaryOf(diff({}, { 'first.md': [1, 'x'] }, 'mtime')), '1 added: first.md');
});

test('UP10 5,000 changed files give a bounded summary: a few names and a count', () => {
  const before: Tree = {};
  const after: Tree = {};
  for (let i = 0; i < 5000; i += 1) { before[`f${String(i).padStart(4, '0')}.md`] = [1, 'x']; after[`f${String(i).padStart(4, '0')}.md`] = [2, 'x']; }
  const summary = summaryOf(diff(before, after, 'mtime'));
  assert.equal(summary, '5000 modified: f0000.md, f0001.md, f0002.md and 4997 more');
  assert.ok(summary.length < 200);
});

test('UP12 a whole API response: same body no change, different body a change, and only a hash is kept', () => {
  const first = baselineOf(api('{"secret":"token-123","n":1}'));
  assert.equal(first.kind === 'value' && first.display, null);
  assert.doesNotMatch(JSON.stringify(first), /token-123/);
  assert.deepEqual(apiDiff('{"n":1}', '{"n":1}'), { changed: false });
  assert.deepEqual(apiDiff('{"n":1}', '{"n":2}'), { changed: true, summary: 'The response changed' });
  assert.equal(apiDiff('{"n":1}', '{ "n": 1 }').changed, true, 'the whole response is compared on its raw body');
});

test('UP13 a selected field changing 49 to 59 is a change that says so; other fields changing is not', () => {
  const before = { plans: [{ price: 49, seats: 1 }], updated: 'mon' };
  assert.deepEqual(apiDiff(before, { plans: [{ price: 59, seats: 1 }], updated: 'mon' }, 'plans[0].price'), { changed: true, summary: 'plans[0].price 49 to 59' });
  assert.deepEqual(apiDiff(before, { plans: [{ price: 49, seats: 9 }], updated: 'tue' }, 'plans[0].price'), { changed: false });
  assert.deepEqual(parseJsonPath('plans[0].price'), ['plans', 0, 'price']);
  assert.deepEqual(parseJsonPath('grid[1][2].x'), ['grid', 1, 2, 'x']);
});

test('UP14 a selected field with reordered keys or different whitespace is no change', () => {
  assert.deepEqual(apiDiff('{"plan":{"a":1,"b":[1,2]}}', '{ "plan": { "b": [1, 2], "a": 1 } }', 'plan'), { changed: false });
  assert.equal(canonicalJson({ b: 1, a: { d: null, c: [true] } }), '{"a":{"c":[true],"d":null},"b":1}');
});

test('UP15 a selected field missing from the response is a failed check that names the field', () => {
  for (const [body, field] of [[{ plans: [] }, 'plans[0].price'], [{ plans: { price: 1 } }, 'plans[0]'], [{ a: 1 }, 'a.b'], [[1, 2], 'length'], [{}, 'toString']] as const) {
    assert.deepEqual(api(body, field), { ok: false, error: `The response has no field "${field}"` });
  }
});

test('UP16 field types: 59 to "59" is a change, a deep-equal value is not, and null is a value', () => {
  assert.equal(apiDiff({ price: 59 }, { price: '59' }, 'price').changed, true);
  assert.deepEqual(apiDiff({ v: { a: [1, { b: 2 }] } }, { v: { a: [1, { b: 2 }] } }, 'v'), { changed: false });
  assert.equal(apiDiff({ v: [1, 2] }, { v: [2, 1] }, 'v').changed, true, 'array order is part of the value');
  assert.equal(api({ v: null }, 'v').ok, true);
  assert.deepEqual(apiDiff({ v: null }, { v: 0 }, 'v'), { changed: true, summary: 'v null to 0' });
});

test('UP17 a selected field on a body that is not JSON is a failed check', () => {
  assert.deepEqual(api('<html>down</html>', 'price'), { ok: false, error: 'The response is not JSON, so the selected field cannot be read' });
  assert.equal(api('<html>fine</html>').ok, true, 'without a field any body is compared whole');
});

test('UP18 a 503 or 404 is a failed check that gives the status', () => {
  for (const status of [503, 404, 301, 199]) assert.deepEqual(api('{}', null, status), { ok: false, error: `The address answered ${status}` });
  assert.equal(api('{}', null, 204).ok, true);
});

test('UP19 a very long changed value is shortened in the summary', () => {
  const comparison = apiDiff({ v: 'a'.repeat(500) }, { v: 'b'.repeat(500) }, 'v');
  assert.equal(comparison.changed, true);
  assert.ok(summaryOf(comparison).length < 200, summaryOf(comparison));
  assert.match(summaryOf(comparison), /…/);
  assert.equal(apiDiff({ v: `${'a'.repeat(100)}1` }, { v: `${'a'.repeat(100)}2` }, 'v').changed, true, 'values that differ only past the shortened part still differ');
});

test('a baseline of one kind compared with another is a change', () => {
  assert.equal(comparePoll(snapshot(NOTES, 'hash'), baselineOf(api('x'))).changed, true);
});
