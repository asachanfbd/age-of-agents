import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PathTraversalError, NotAFileError } from '../src/projects/fileTree.ts';
import { EntryExistsError, InvalidEntryPathError } from '../src/projects/projectEntries.ts';
import {
  createDocsEntry,
  listDocsTree,
  readDocsFile,
  writeDocsFile,
} from '../src/projects/docsFiles.ts';

let tempRoot: string;
let project: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'docs-files-test-'));
  project = path.join(tempRoot, 'proj');
  await mkdir(path.join(project, '.docs', 'plan'), { recursive: true });
  await mkdir(path.join(project, '.docs', 'empty-folder'), { recursive: true });
  await writeFile(path.join(project, '.docs', 'blueprint.md'), '# Blueprint\n');
  await writeFile(path.join(project, '.docs', 'plan', 'notes.md'), '# Notes\n');
  await writeFile(path.join(project, 'secret.txt'), 'outside the docs folder');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('listDocsTree lists every file and folder under .docs, including empty folders, sorted and POSIX-relative', async () => {
  const tree = await listDocsTree(project);
  assert.deepEqual(tree.files, ['blueprint.md', 'plan/notes.md']);
  assert.deepEqual(tree.folders, ['empty-folder', 'plan']);
});

test('listDocsTree returns an empty tree for a project with no .docs folder', async () => {
  assert.deepEqual(await listDocsTree(path.join(tempRoot, 'no-docs-here')), { files: [], folders: [] });
});

test('readDocsFile reads a docs file and refuses anything outside .docs', async () => {
  assert.deepEqual(await readDocsFile(project, 'plan/notes.md'), { kind: 'text', content: '# Notes\n' });
  await assert.rejects(() => readDocsFile(project, '../secret.txt'), PathTraversalError);
  await assert.rejects(() => readDocsFile(project, 'plan'), NotAFileError);
});

test('readDocsFile refuses a symlink inside .docs that points outside it', async () => {
  await symlink(path.join(project, 'secret.txt'), path.join(project, '.docs', 'leak.md'));
  await assert.rejects(() => readDocsFile(project, 'leak.md'), PathTraversalError);
});

test('writeDocsFile overwrites an existing file', async () => {
  await writeDocsFile(project, 'blueprint.md', '# Updated\n');
  assert.equal(await readFile(path.join(project, '.docs', 'blueprint.md'), 'utf-8'), '# Updated\n');
});

test('writeDocsFile never creates a file, and refuses a folder or an escaping path', async () => {
  await assert.rejects(() => writeDocsFile(project, 'missing.md', 'x'), { code: 'ENOENT' });
  await assert.rejects(() => writeDocsFile(project, 'plan', 'x'), NotAFileError);
  await assert.rejects(() => writeDocsFile(project, '../secret.txt', 'x'), PathTraversalError);
  assert.equal(await readFile(path.join(project, 'secret.txt'), 'utf-8'), 'outside the docs folder');
});

test('createDocsEntry creates an empty file, adding .md when the name has no extension', async () => {
  assert.equal(await createDocsEntry(project, 'guides', 'file'), 'guides.md');
  assert.equal(await createDocsEntry(project, 'plan/todo.txt', 'file'), 'plan/todo.txt');
  assert.equal(await readFile(path.join(project, '.docs', 'guides.md'), 'utf-8'), '');
});

test('createDocsEntry creates missing parent folders for a nested file and for a folder', async () => {
  assert.equal(await createDocsEntry(project, 'deep/er/page.md', 'file'), 'deep/er/page.md');
  assert.equal(await createDocsEntry(project, 'milestones/archive', 'folder'), 'milestones/archive');
  const tree = await listDocsTree(project);
  assert.ok(tree.files.includes('deep/er/page.md'));
  assert.ok(tree.folders.includes('milestones/archive'));
});

test('createDocsEntry refuses an existing file or folder without touching it', async () => {
  await assert.rejects(() => createDocsEntry(project, 'blueprint.md', 'file'), EntryExistsError);
  await assert.rejects(() => createDocsEntry(project, 'plan', 'folder'), EntryExistsError);
  assert.equal(await readFile(path.join(project, '.docs', 'blueprint.md'), 'utf-8'), '# Updated\n');
});

test('createDocsEntry rejects empty, dot and traversal segments', async () => {
  for (const bad of ['', '   ', 'a//b.md', './a.md', '../escape.md', 'a/../b.md', 'a/ /b.md']) {
    await assert.rejects(() => createDocsEntry(project, bad, 'file'), (error: Error) => error instanceof InvalidEntryPathError || error instanceof PathTraversalError, JSON.stringify(bad));
  }
});
