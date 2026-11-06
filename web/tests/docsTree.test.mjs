import assert from 'node:assert/strict';
import { test } from 'node:test';

const { pickInitialFile, entryParentFolder, joinEntryPath, ancestorFolders, isMarkdown, createAndReveal } = await import('../src/lib/docsTree.ts');

test('pickInitialFile prefers the first named file that exists, ignoring case', () => {
  const files = ['architecture/overview.md', 'readme.md', 'blueprint.md'];
  assert.equal(pickInitialFile(files, ['README.md', 'blueprint.md']), 'readme.md');
  assert.equal(pickInitialFile(files, ['missing.md', 'Blueprint.MD']), 'blueprint.md');
});

test('pickInitialFile falls back to the alphabetically first file, or null when there are none', () => {
  assert.equal(pickInitialFile(['b.md', 'a/z.md', 'a.md']), 'a.md');
  assert.equal(pickInitialFile([]), null);
  assert.equal(pickInitialFile([], ['README.md']), null);
});

test('entryParentFolder uses the last opened folder, then the selected file\'s folder, then the root', () => {
  assert.equal(entryParentFolder('plan/notes.md', 'guides'), 'guides');
  assert.equal(entryParentFolder('plan/deep/notes.md', null), 'plan/deep');
  assert.equal(entryParentFolder('README.md', null), '');
  assert.equal(entryParentFolder(null, null), '');
});

test('joinEntryPath joins a parent and a name, trimming spaces and stray slashes', () => {
  assert.equal(joinEntryPath('plan', 'todo.md'), 'plan/todo.md');
  assert.equal(joinEntryPath('', '  todo.md '), 'todo.md');
  assert.equal(joinEntryPath('plan', '/sub/page/'), 'plan/sub/page');
});

test('ancestorFolders lists every folder above a path, outermost first', () => {
  assert.deepEqual(ancestorFolders('a/b/c.md'), ['a', 'a/b']);
  assert.deepEqual(ancestorFolders('top.md'), []);
});

test('isMarkdown recognises .md and .markdown, case-insensitively, and nothing else', () => {
  assert.equal(isMarkdown('a/README.MD'), true);
  assert.equal(isMarkdown('notes.markdown'), true);
  assert.equal(isMarkdown('data.json'), false);
  assert.equal(isMarkdown('md'), false);
});

// ---- createAndReveal: the create flow shared by the Documents and Code tabs ----

function createSpies({ created, failure } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      create: async (path, kind) => {
        calls.push(['create', path, kind]);
        if (failure) throw new Error(failure);
        return { path: created ?? path };
      },
      refresh: async () => { calls.push(['refresh']); },
      openFile: (path) => { calls.push(['open', path]); },
    },
  };
}

test('createAndReveal creates a file, refreshes the tree, then opens the path the server actually created', async () => {
  const { calls, deps } = createSpies({ created: 'web/src/helpers.ts' });
  assert.deepEqual(await createAndReveal('file', ' web/src/helpers.ts', deps), { path: 'web/src/helpers.ts' });
  assert.deepEqual(calls, [['create', ' web/src/helpers.ts', 'file'], ['refresh'], ['open', 'web/src/helpers.ts']]);
});

test('createAndReveal creates a folder and refreshes without opening anything', async () => {
  const { calls, deps } = createSpies();
  assert.deepEqual(await createAndReveal('folder', 'scripts', deps), { path: 'scripts' });
  assert.deepEqual(calls, [['create', 'scripts', 'folder'], ['refresh']]);
});

test('createAndReveal returns the failure message for the inline form and does not refresh', async () => {
  const { calls, deps } = createSpies({ failure: '"package.json" already exists' });
  assert.deepEqual(await createAndReveal('file', 'package.json', deps), { error: '"package.json" already exists' });
  assert.deepEqual(calls, [['create', 'package.json', 'file']]);
});
