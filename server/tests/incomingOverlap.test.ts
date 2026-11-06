import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import { checkBlockingChanges, describeFiles, findBlockingChanges, parseOverwriteRefusal, overwriteRefusalMessage } from '../src/projects/incomingOverlap.ts';
import { pullFastForward, rollbackToCommit } from '../src/appUpdate/updateGitSteps.ts';

// Real temporary repositories with a local bare "origin"; nothing touches a real remote or this app's checkout.

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'incoming-overlap-'));
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'user.name'; process.env.GIT_CONFIG_VALUE_0 = 'Test';
  process.env.GIT_CONFIG_KEY_1 = 'user.email'; process.env.GIT_CONFIG_VALUE_1 = 'test@example.com';
});

after(async () => { await rm(root, { recursive: true, force: true }); });

/** `app` (the checkout under test) and `seed` (another clone that pushes the incoming commits), both starting from the same files. */
async function makeRepo(files: Record<string, string> = { 'README.md': 'v1', 'data.json': '{}', 'other.json': '{}' }) {
  const id = `repo${counter++}`;
  const origin = path.join(root, `${id}.git`);
  const app = path.join(root, `${id}-app`);
  const seed = path.join(root, `${id}-seed`);
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['clone', origin, seed]);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(seed, name)), { recursive: true });
    await writeFile(path.join(seed, name), content);
  }
  await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'initial']); await git(seed, ['push', 'origin', 'main']);
  await git(root, ['clone', origin, app]);
  return {
    app, seed,
    /** Commits `changes` (null deletes) in the seed clone, pushes, and fetches into the app. */
    async incoming(changes: Record<string, string | null>) {
      for (const [name, content] of Object.entries(changes)) {
        if (content === null) { await git(seed, ['rm', '-q', name]); continue; }
        await mkdir(path.dirname(path.join(seed, name)), { recursive: true });
        await writeFile(path.join(seed, name), content);
      }
      await git(seed, ['add', '-A']); await git(seed, ['commit', '-m', 'incoming']); await git(seed, ['push', 'origin', 'main']);
      await git(app, ['fetch', '--quiet', 'origin']);
    },
    check: (options = {}) => checkBlockingChanges(app, 'refs/remotes/origin/main', options),
  };
}

test('describeFiles: nothing hidden at the limit, "and N more" past it, never "and 0 more"', () => {
  const paths = ['a', 'b', 'c', 'd'];
  assert.equal(describeFiles([], 0, 3), '');
  assert.equal(describeFiles(paths.slice(0, 3), 3, 3), 'a, b, c');
  assert.equal(describeFiles(paths, 4, 3), 'a, b, c and 1 more');
  assert.equal(describeFiles(paths.slice(0, 3), 50, 3), 'a, b, c and 47 more');
});

test('unrelated dirty tracked file and unrelated untracked file do not block', async () => {
  const r = await makeRepo();
  await r.incoming({ 'README.md': 'v2' });
  await writeFile(path.join(r.app, 'data.json'), '{"edited":true}');
  await writeFile(path.join(r.app, 'scratch.json'), '{}');
  const { blocking, incoming } = await r.check();
  assert.deepEqual(incoming, ['README.md']);
  assert.deepEqual(blocking, { files: [], total: 0, fallbackReason: null });
});

test('an overlapping unstaged edit, staged edit and deletion each block with their kind, sorted by path', async () => {
  const r = await makeRepo();
  await r.incoming({ 'README.md': 'v2', 'data.json': '{"a":1}', 'other.json': '{"b":1}' });
  await writeFile(path.join(r.app, 'README.md'), 'mine');
  await writeFile(path.join(r.app, 'data.json'), 'mine');
  await git(r.app, ['add', 'data.json']);
  await rm(path.join(r.app, 'other.json'));
  const { blocking } = await r.check();
  assert.deepEqual(blocking.files, [
    { path: 'README.md', kind: 'modified' },
    { path: 'data.json', kind: 'modified' },
    { path: 'other.json', kind: 'deleted' },
  ]);
  assert.equal(blocking.total, 3);
});

test('identical local and incoming content still blocks', async () => {
  const r = await makeRepo();
  await r.incoming({ 'README.md': 'same' });
  await writeFile(path.join(r.app, 'README.md'), 'same');
  assert.equal((await r.check()).blocking.total, 1);
});

test('incoming deletes a locally modified file: blocks', async () => {
  const r = await makeRepo();
  await r.incoming({ 'data.json': null });
  await writeFile(path.join(r.app, 'data.json'), 'mine');
  assert.deepEqual((await r.check()).blocking.files, [{ path: 'data.json', kind: 'modified' }]);
});

test('incoming rename: a local edit of the old path blocks; an untracked file at the new path blocks', async () => {
  const r = await makeRepo();
  await git(r.seed, ['mv', 'data.json', 'moved.json']);
  await r.incoming({});
  await writeFile(path.join(r.app, 'data.json'), 'mine');
  await writeFile(path.join(r.app, 'moved.json'), 'untracked');
  const { blocking } = await r.check();
  assert.deepEqual(blocking.files, [{ path: 'data.json', kind: 'modified' }, { path: 'moved.json', kind: 'untracked' }]);
});

test('a local git mv of a file the update changes blocks (both sides of the rename)', async () => {
  const r = await makeRepo();
  await r.incoming({ 'data.json': '{"a":1}' });
  await git(r.app, ['mv', 'data.json', 'renamed.json']);
  const { blocking } = await r.check();
  assert.deepEqual(blocking.files.map((f) => f.path), ['data.json']);
});

test('untracked: only a path the update adds blocks, including file/folder clashes', async () => {
  const r = await makeRepo();
  await r.incoming({ 'new.json': '{}', 'dir/inner.json': '{}', 'file/inside.txt': 'x' });
  await writeFile(path.join(r.app, 'new.json'), 'mine');
  await writeFile(path.join(r.app, 'file'), 'a file where the update adds a folder');
  await mkdir(path.join(r.app, 'dir'), { recursive: true });
  await writeFile(path.join(r.app, 'dir', 'unrelated.json'), 'mine');
  await writeFile(path.join(r.app, 'unrelated.json'), 'mine');
  const { blocking } = await r.check();
  assert.deepEqual(blocking.files, [{ path: 'file', kind: 'untracked' }, { path: 'new.json', kind: 'untracked' }]);
});

test('an ignored file at an incoming-added path does not block and the merge succeeds', async () => {
  const r = await makeRepo();
  await writeFile(path.join(r.app, '.git', 'info', 'exclude'), 'ignored.json\n');
  await r.incoming({ 'ignored.json': '{}' });
  await writeFile(path.join(r.app, 'ignored.json'), 'mine');
  assert.equal((await r.check()).blocking.total, 0);
  assert.equal((await pullFastForward(r.app)).ok, true);
});

test('a mode change blocks only on an overlapping file', async () => {
  const r = await makeRepo();
  await r.incoming({ 'data.json': '{"a":1}' });
  await chmod(path.join(r.app, 'data.json'), 0o755);
  await chmod(path.join(r.app, 'other.json'), 0o755);
  assert.deepEqual((await r.check()).blocking.files, [{ path: 'data.json', kind: 'modified' }]);
});

test('a binary file overlap is handled by path', async () => {
  const r = await makeRepo({ 'README.md': 'v1', 'blob.bin': 'a\0b' });
  await r.incoming({ 'blob.bin': 'c\0d' });
  await writeFile(path.join(r.app, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual((await r.check()).blocking.files, [{ path: 'blob.bin', kind: 'modified' }]);
});

test('paths with spaces and unicode are listed unquoted', async () => {
  const r = await makeRepo({ 'README.md': 'v1', 'my file é.json': '{}' });
  await r.incoming({ 'my file é.json': '{"a":1}' });
  await writeFile(path.join(r.app, 'my file é.json'), 'mine');
  assert.deepEqual((await r.check()).blocking.files, [{ path: 'my file é.json', kind: 'modified' }]);
});

test('case, surrounding whitespace and unicode normalisation do not hide an overlap', async () => {
  const r = await makeRepo();
  await writeFile(path.join(r.app, 'Notes.md'), 'x');
  await writeFile(path.join(r.app, 'cafe\u0301.json'), 'x');
  const blocked = async (incomingPaths: string[]) => (await findBlockingChanges(r.app, incomingPaths)).files.map((f) => f.path);
  assert.deepEqual(await blocked(['NOTES.MD']), ['Notes.md']);
  assert.deepEqual(await blocked([' notes.md ']), ['Notes.md']);
  // git may report the name precomposed (macOS) or as written; either is the same file.
  assert.deepEqual((await blocked(['caf\u00e9.json'])).map((p) => p.normalize('NFC')), ['caf\u00e9.json']);
});

test('an empty incoming set never blocks, whatever is dirty', async () => {
  const r = await makeRepo();
  await writeFile(path.join(r.app, 'README.md'), 'mine');
  await writeFile(path.join(r.app, 'new.json'), 'mine');
  assert.deepEqual(await findBlockingChanges(r.app, []), { files: [], total: 0, fallbackReason: null });
});

test('long lists are capped at the limit with the exact total', async () => {
  const names = Array.from({ length: 15 }, (_, i) => `f${String(i).padStart(2, '0')}.json`);
  const r = await makeRepo(Object.fromEntries(names.map((n) => [n, '1'])));
  await r.incoming(Object.fromEntries(names.map((n) => [n, '2'])));
  for (const n of names) await writeFile(path.join(r.app, n), 'mine');
  const { blocking } = await r.check({ limit: 10 });
  assert.equal(blocking.total, 15);
  assert.deepEqual(blocking.files.map((f) => f.path), names.slice(0, 10));
});

test('thousands of local and incoming paths are handled and unrelated ones do not block', async () => {
  const r = await makeRepo();
  for (let i = 0; i < 3000; i++) await writeFile(path.join(r.app, `junk${i}.txt`), 'x');
  const incoming = Array.from({ length: 50_000 }, (_, i) => `gen/file${i}.txt`).concat(['junk7.txt']);
  const result = await findBlockingChanges(r.app, incoming);
  assert.deepEqual(result.files, [{ path: 'junk7.txt', kind: 'untracked' }]);
  assert.equal(result.total, 1);
});

test('when the incoming paths cannot be read, any tracked change blocks and the reason says why; untracked files and a clean tree do not', async () => {
  const r = await makeRepo();
  const failing = { incomingPaths: async () => { throw new Error('boom'); } };
  await writeFile(path.join(r.app, 'untracked.json'), 'x');
  const clean = await r.check(failing);
  assert.equal(clean.incoming, null);
  assert.equal(clean.blocking.total, 0);
  await writeFile(path.join(r.app, 'data.json'), 'mine');
  const dirty = await r.check(failing);
  assert.deepEqual(dirty.blocking.files, [{ path: 'data.json', kind: 'modified' }]);
  assert.match(dirty.blocking.fallbackReason ?? '', /could not tell which files the update changes \(boom\)/);
});

test('git refusal text captured from real git is parsed into file lists', async () => {
  const r = await makeRepo();
  await r.incoming({ 'data.json': '{"a":1}', 'new.json': '{}' });
  await writeFile(path.join(r.app, 'data.json'), 'mine');
  const tracked = await pullFastForward(r.app);
  assert.equal(tracked.ok, false);
  assert.match(tracked.output, /data\.json/);
  await git(r.app, ['checkout', '--', 'data.json']);
  await writeFile(path.join(r.app, 'new.json'), 'mine');
  let message = '';
  try { await git(r.app, ['merge', '--ff-only', 'origin/main']); } catch (error) { message = (error as Error).message; }
  assert.deepEqual(parseOverwriteRefusal(message), ['new.json']);
  assert.match(overwriteRefusalMessage(message) ?? '', /^local changes would be overwritten by the update: new\.json\. Nothing was changed$/);
  assert.deepEqual(parseOverwriteRefusal('error: x would be overwritten by merge:\n\t"caf\\303\\251 \\"q\\".json"\n\tplain.json'), ['café "q".json', 'plain.json']);
  assert.deepEqual(parseOverwriteRefusal('fatal: something else'), []);
  assert.equal(overwriteRefusalMessage('fatal: something else'), null);
});

test('pullFastForward with unrelated dirty and untracked files advances HEAD and leaves them byte-identical', async () => {
  const r = await makeRepo();
  await r.incoming({ 'README.md': 'v2' });
  await writeFile(path.join(r.app, 'data.json'), '{"mine":1}');
  await writeFile(path.join(r.app, 'scratch.json'), 'scratch');
  const before = await git(r.app, ['rev-parse', 'HEAD']);
  assert.equal((await pullFastForward(r.app)).ok, true);
  assert.notEqual(await git(r.app, ['rev-parse', 'HEAD']), before);
  assert.equal(await readFile(path.join(r.app, 'data.json'), 'utf8'), '{"mine":1}');
  assert.equal(await readFile(path.join(r.app, 'scratch.json'), 'utf8'), 'scratch');
  assert.equal(await readFile(path.join(r.app, 'README.md'), 'utf8'), 'v2');
});

test('race: an overlapping edit appears after the check and before the pull: refused, files named, nothing changed', async () => {
  const r = await makeRepo();
  await r.incoming({ 'data.json': '{"a":1}' });
  assert.equal((await r.check()).blocking.total, 0);
  await writeFile(path.join(r.app, 'data.json'), 'late edit');
  const before = await git(r.app, ['rev-parse', 'HEAD']);
  const result = await pullFastForward(r.app);
  assert.equal(result.ok, false);
  assert.match(result.output, /local changes would be overwritten by the update: data\.json/);
  assert.equal(await git(r.app, ['rev-parse', 'HEAD']), before);
  assert.equal(await readFile(path.join(r.app, 'data.json'), 'utf8'), 'late edit');
  assert.equal((await r.check()).blocking.total, 1, 'the next check reports the blocker');
});

test('race: an untracked file appears at a path the update adds', async () => {
  const r = await makeRepo();
  await r.incoming({ 'new.json': '{}' });
  await writeFile(path.join(r.app, 'new.json'), 'late');
  const result = await pullFastForward(r.app);
  assert.equal(result.ok, false);
  assert.match(result.output, /new\.json/);
  assert.equal(await readFile(path.join(r.app, 'new.json'), 'utf8'), 'late');
});

test('rollbackToCommit returns to the previous commit and keeps unrelated tracked and untracked changes', async () => {
  const r = await makeRepo();
  const previous = await git(r.app, ['rev-parse', 'HEAD']);
  await r.incoming({ 'README.md': 'v2' });
  assert.equal((await pullFastForward(r.app)).ok, true);
  await writeFile(path.join(r.app, 'data.json'), '{"mine":1}');
  await writeFile(path.join(r.app, 'scratch.json'), 'scratch');
  const result = await rollbackToCommit(r.app, previous);
  assert.equal(result.ok, true);
  assert.equal(await git(r.app, ['rev-parse', 'HEAD']), previous);
  assert.equal(await git(r.app, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(await readFile(path.join(r.app, 'README.md'), 'utf8'), 'v1');
  assert.equal(await readFile(path.join(r.app, 'data.json'), 'utf8'), '{"mine":1}');
  assert.equal(await readFile(path.join(r.app, 'scratch.json'), 'utf8'), 'scratch');
});

test('rollbackToCommit refuses, and keeps the edit, when a file the update changed was edited after the pull', async () => {
  const r = await makeRepo();
  const previous = await git(r.app, ['rev-parse', 'HEAD']);
  await r.incoming({ 'README.md': 'v2' });
  await pullFastForward(r.app);
  const updated = await git(r.app, ['rev-parse', 'HEAD']);
  await writeFile(path.join(r.app, 'README.md'), 'edited after the update');
  const result = await rollbackToCommit(r.app, previous);
  assert.equal(result.ok, false);
  assert.equal(await git(r.app, ['rev-parse', 'HEAD']), updated);
  assert.equal(await readFile(path.join(r.app, 'README.md'), 'utf8'), 'edited after the update');
});

test('no update or sync code path can discard local changes', async () => {
  const sources = ['bin/run-app-update.mjs', 'src/appUpdate/updateGitSteps.ts', 'src/appUpdate/serverUpdateRunner.ts', 'src/appUpdate/webOnlyUpdateRunner.ts', 'src/appUpdate/realWebOnlySteps.ts', 'src/projects/autoPull.ts', 'src/projects/incomingOverlap.ts'];
  for (const file of sources) {
    const code = (await readFile(path.join(import.meta.dirname, '..', file), 'utf8')).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    assert.doesNotMatch(code, /reset['",\s]+'?--hard|checkout['",\s]+'?-f|['"]clean['"]|['"]stash['"]/, file);
  }
});
