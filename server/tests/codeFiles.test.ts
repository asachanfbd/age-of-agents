import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createCodeEntry } from '../src/projects/codeFiles.ts';
import { PathTraversalError } from '../src/projects/fileTree.ts';
import { EntryExistsError, InvalidEntryPathError } from '../src/projects/projectEntries.ts';

let tempRoot: string;
let project: string;
let outside: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'code-files-test-'));
  project = path.join(tempRoot, 'proj');
  outside = path.join(tempRoot, 'outside');
  await mkdir(path.join(project, 'web', 'src'), { recursive: true });
  await mkdir(path.join(project, '.git', 'hooks'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(project, 'package.json'), '{}\n');
  await symlink(outside, path.join(project, 'escape'));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const isInvalid = (error: Error) => error instanceof InvalidEntryPathError || error instanceof PathTraversalError;

test('createCodeEntry creates an empty top-level file and keeps the name exactly as typed', async () => {
  assert.equal(await createCodeEntry(project, 'notes.txt', 'file'), 'notes.txt');
  assert.equal(await createCodeEntry(project, 'Makefile', 'file'), 'Makefile', 'no extension is added, unlike the docs folder');
  assert.equal((await stat(path.join(project, 'notes.txt'))).size, 0);
  assert.equal(await readFile(path.join(project, 'Makefile'), 'utf-8'), '');
});

test('createCodeEntry creates a nested file in an existing folder and missing parents for nested files and folders', async () => {
  assert.equal(await createCodeEntry(project, 'web/src/helpers.ts', 'file'), 'web/src/helpers.ts');
  assert.equal(await createCodeEntry(project, 'a/b/c.ts', 'file'), 'a/b/c.ts');
  assert.equal(await createCodeEntry(project, 'x/y', 'folder'), 'x/y');
  assert.ok((await stat(path.join(project, 'a', 'b', 'c.ts'))).isFile());
  assert.ok((await stat(path.join(project, 'x', 'y'))).isDirectory());
});

test('createCodeEntry creates an empty folder', async () => {
  assert.equal(await createCodeEntry(project, 'scripts', 'folder'), 'scripts');
  assert.deepEqual(await readdir(path.join(project, 'scripts')), []);
});

test('createCodeEntry normalizes surrounding whitespace and backslashes', async () => {
  assert.equal(await createCodeEntry(project, '  web\\src\\ util.ts ', 'file'), 'web/src/util.ts');
});

test('createCodeEntry allows folders the tree hides, such as node_modules', async () => {
  assert.equal(await createCodeEntry(project, 'node_modules/local/index.js', 'file'), 'node_modules/local/index.js');
});

test('createCodeEntry refuses an existing entry of either kind without touching it', async () => {
  await assert.rejects(() => createCodeEntry(project, 'package.json', 'file'), EntryExistsError);
  await assert.rejects(() => createCodeEntry(project, 'package.json', 'folder'), EntryExistsError);
  await assert.rejects(() => createCodeEntry(project, 'web', 'folder'), EntryExistsError);
  await assert.rejects(() => createCodeEntry(project, 'web/src', 'file'), EntryExistsError);
  assert.equal(await readFile(path.join(project, 'package.json'), 'utf-8'), '{}\n');
});

test('createCodeEntry rejects empty, dot, traversal and absolute paths', async () => {
  for (const bad of ['', '   ', '.', '..', 'a//b', './a', '../oops', 'a/../b', 'a/ ../b', 'a/.. /b', ' . /a', '/etc/x']) {
    await assert.rejects(() => createCodeEntry(project, bad, 'file'), isInvalid, JSON.stringify(bad));
  }
  await assert.rejects(() => stat(path.join(tempRoot, 'oops')), { code: 'ENOENT' });
});

test('createCodeEntry refuses anything inside a .git folder', async () => {
  for (const bad of ['.git', '.git/hooks/x', 'sub/.git/config', '.GIT/hooks/x', 'sub/.Git/config']) {
    await assert.rejects(() => createCodeEntry(project, bad, 'file'), /inside \.git/, bad);
  }
  await assert.rejects(() => stat(path.join(project, '.git', 'hooks', 'x')), { code: 'ENOENT' });
  assert.equal(await createCodeEntry(project, 'docs/gitnotes.git', 'file'), 'docs/gitnotes.git', 'only a whole .git segment is refused');
});

test('createCodeEntry refuses a path through a symlinked folder that points outside the project', async () => {
  await assert.rejects(() => createCodeEntry(project, 'escape', 'folder'), PathTraversalError);
  await assert.rejects(() => createCodeEntry(project, 'escape/leak.txt', 'file'), PathTraversalError);
  assert.deepEqual(await readdir(outside), []);
});
