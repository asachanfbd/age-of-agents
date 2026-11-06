import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { changedFileDiff, listChangedFiles, mergeBase, parseNameStatus, parseNumstat } from '../src/projects/branchDiff.ts';

let tempRoot: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'branch-diff-test-'));
  repo = path.join(tempRoot, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  await writeFile(path.join(repo, 'a.ts'), 'one\ntwo\n');
  await writeFile(path.join(repo, 'old.ts'), 'gone\n');
  await writeFile(path.join(repo, 'r1.ts'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
  await writeFile(path.join(repo, 'logo.png'), Buffer.from([0, 1, 2, 3]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'task/x');
  await writeFile(path.join(repo, 'a.ts'), 'one\nTWO\nthree\n');
  await unlink(path.join(repo, 'old.ts'));
  git(repo, 'mv', 'r1.ts', 'r2.ts');
  await writeFile(path.join(repo, 'new file.ts'), 'hello\n');
  await writeFile(path.join(repo, 'logo.png'), Buffer.from([0, 9, 9, 9]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'task work');
  // A commit on main after branching must not show up as a change on the branch.
  git(repo, 'checkout', '-q', 'main');
  await writeFile(path.join(repo, 'main-only.ts'), 'later\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'main moves on');
  git(repo, 'checkout', '-q', 'task/x');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('parseNameStatus maps statuses, keeps both paths of a rename and treats copies as added and type changes as modified', () => {
  const out = ['A', 'new.ts', 'M', 'a.ts', 'D', 'old.ts', 'R087', 'r1.ts', 'r2.ts', 'C100', 'src.ts', 'copy.ts', 'T', 'link', 'M', 'with\ttab.ts', ''].join('\0');
  assert.deepEqual(parseNameStatus(out), [
    { status: 'added', path: 'new.ts' },
    { status: 'modified', path: 'a.ts' },
    { status: 'deleted', path: 'old.ts' },
    { status: 'renamed', path: 'r2.ts', oldPath: 'r1.ts' },
    { status: 'added', path: 'copy.ts' },
    { status: 'modified', path: 'link' },
    { status: 'modified', path: 'with\ttab.ts' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('parseNumstat reads counts, marks "-\t-" as binary with null counts, and keys a rename by its new path', () => {
  const out = ['3\t1\ta.ts', '-\t-\tlogo.png', '2\t0\t', 'r1.ts', 'r2.ts', '1\t0\tsp ace.ts', ''].join('\0');
  const counts = parseNumstat(out);
  assert.deepEqual(counts.get('a.ts'), { additions: 3, deletions: 1, binary: false });
  assert.deepEqual(counts.get('logo.png'), { additions: null, deletions: null, binary: true });
  assert.deepEqual(counts.get('r2.ts'), { additions: 2, deletions: 0, binary: false });
  assert.deepEqual(counts.get('sp ace.ts'), { additions: 1, deletions: 0, binary: false });
  assert.equal(counts.has('r1.ts'), false);
});

test('listChangedFiles between two refs lists the branch\'s committed changes since its merge base, sorted by path', async () => {
  const from = await mergeBase(repo, 'main', 'task/x');
  const files = await listChangedFiles(repo, { from, to: 'task/x' });
  assert.deepEqual(files, [
    { path: 'a.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
    { path: 'logo.png', status: 'modified', additions: null, deletions: null, binary: true },
    { path: 'new file.ts', status: 'added', additions: 1, deletions: 0, binary: false },
    { path: 'old.ts', status: 'deleted', additions: 0, deletions: 1, binary: false },
    { path: 'r2.ts', oldPath: 'r1.ts', status: 'renamed', additions: 0, deletions: 0, binary: false },
  ]);
  assert.ok(!files.some((file) => file.path === 'main-only.ts'), 'a later commit on the base is not a change on the branch');
});

test('listChangedFiles against the working tree adds uncommitted edits and untracked files, skipping ignored ones', async () => {
  await writeFile(path.join(repo, '.gitignore'), 'ignored.log\n');
  await writeFile(path.join(repo, 'ignored.log'), 'noise\n');
  await writeFile(path.join(repo, 'untracked.ts'), 'a\nb\n');
  await writeFile(path.join(repo, 'blob.bin'), Buffer.from([0, 0, 1]));
  await writeFile(path.join(repo, 'a.ts'), 'one\nTWO\nthree\nfour\n');
  try {
    const files = await listChangedFiles(repo, { from: 'HEAD', to: 'working-tree' });
    assert.deepEqual(files, [
      { path: '.gitignore', status: 'added', additions: 1, deletions: 0, binary: false, untracked: true },
      { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, binary: false },
      { path: 'blob.bin', status: 'added', additions: null, deletions: null, binary: true, untracked: true },
      { path: 'untracked.ts', status: 'added', additions: 2, deletions: 0, binary: false, untracked: true },
    ]);
  } finally {
    for (const file of ['.gitignore', 'ignored.log', 'untracked.ts', 'blob.bin']) await rm(path.join(repo, file), { force: true });
    git(repo, 'checkout', '-q', '--', 'a.ts');
  }
});

test('changedFileDiff gives one file\'s unified diff, a rename across both paths, and an untracked file as a new-file diff', async () => {
  const from = await mergeBase(repo, 'main', 'task/x');
  const range = { from, to: 'task/x' };
  const files = await listChangedFiles(repo, range);
  const modified = await changedFileDiff(repo, range, files.find((file) => file.path === 'a.ts')!);
  assert.match(modified, /^diff --git a\/a\.ts b\/a\.ts/);
  assert.match(modified, /^-two$/m);
  assert.match(modified, /^\+TWO$/m);
  assert.doesNotMatch(modified, /old\.ts/, 'only the requested file is diffed');

  const renamed = await changedFileDiff(repo, range, files.find((file) => file.path === 'r2.ts')!);
  assert.match(renamed, /rename from r1\.ts/);
  assert.match(renamed, /rename to r2\.ts/);

  await writeFile(path.join(repo, 'fresh.ts'), 'x\ny');
  try {
    const untracked = await changedFileDiff(repo, { from: 'HEAD', to: 'working-tree' }, { path: 'fresh.ts', status: 'added', additions: 2, deletions: 0, binary: false, untracked: true });
    assert.equal(untracked, 'diff --git a/fresh.ts b/fresh.ts\nnew file\n--- /dev/null\n+++ b/fresh.ts\n@@ -0,0 +1,2 @@\n+x\n+y');
  } finally {
    await rm(path.join(repo, 'fresh.ts'));
  }
});

test('a path that looks like a git option is passed after "--" and cannot make git write a file', async () => {
  const before = await readdir(tempRoot);
  const diff = await changedFileDiff(repo, { from: 'HEAD', to: 'working-tree' }, { path: `--output=${path.join(tempRoot, 'pwned')}`, status: 'modified', additions: 0, deletions: 0, binary: false });
  assert.equal(diff, '');
  assert.deepEqual(await readdir(tempRoot), before);
});
