import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const { buildFileTree, flattenFiles } = await import('../src/lib/fileTree.ts');

test('buildFileTree builds a single-level tree of files, sorted alphabetically', () => {
  const tree = buildFileTree(['b.md', 'a.md', 'c.md']);
  assert.deepEqual(tree.map((n) => n.name), ['a.md', 'b.md', 'c.md']);
  assert.ok(tree.every((n) => n.type === 'file'));
});

test('buildFileTree nests directories from slash-separated paths', () => {
  const tree = buildFileTree(['src/index.ts', 'src/lib/util.ts', 'README.md']);
  assert.equal(tree.length, 2);
  const [src, readme] = tree;
  assert.equal(src.name, 'src'); assert.equal(src.type, 'dir');
  assert.equal(readme.name, 'README.md'); assert.equal(readme.type, 'file');

  assert.equal(src.children.length, 2);
  const [lib, index] = src.children;
  assert.equal(lib.name, 'lib'); assert.equal(lib.type, 'dir');
  assert.equal(lib.path, 'src/lib');
  assert.equal(index.name, 'index.ts'); assert.equal(index.path, 'src/index.ts');
  assert.equal(lib.children[0].path, 'src/lib/util.ts');
});

test('buildFileTree sorts directories before files at every level, alphabetically within each', () => {
  const tree = buildFileTree(['zebra.txt', 'apple.txt', 'zdir/x.txt', 'adir/x.txt']);
  assert.deepEqual(tree.map((n) => n.name), ['adir', 'zdir', 'apple.txt', 'zebra.txt']);
});

test('buildFileTree shares one directory node for every file under it, regardless of input order', () => {
  const tree = buildFileTree(['src/b.ts', 'src/a.ts']);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, 2);
});

test('buildFileTree drops empty/blank path segments rather than producing an empty-named node', () => {
  const tree = buildFileTree(['', 'src//index.ts', '/leading-slash.md']);
  const flat = flattenFiles(tree);
  assert.deepEqual(flat.map((n) => n.path).sort(), ['leading-slash.md', 'src/index.ts']);
});

test('buildFileTree de-duplicates an exact repeated path instead of listing it twice', () => {
  const tree = buildFileTree(['a.md', 'a.md']);
  assert.equal(flattenFiles(tree).length, 1);
});

test('buildFileTree returns an empty tree for an empty input', () => {
  assert.deepEqual(buildFileTree([]), []);
});

test('flattenFiles collects every file depth-first, skipping directory nodes themselves', () => {
  const tree = buildFileTree(['src/lib/a.ts', 'src/b.ts', 'c.ts']);
  const paths = flattenFiles(tree).map((n) => n.path).sort();
  assert.deepEqual(paths, ['c.ts', 'src/b.ts', 'src/lib/a.ts']);
});

test('buildFileTree includes listed folders even when they hold no files, sorted like any directory', () => {
  const tree = buildFileTree(['README.md'], ['empty', 'plan/archive']);
  assert.deepEqual(tree.map((n) => [n.name, n.type]), [['empty', 'dir'], ['plan', 'dir'], ['README.md', 'file']]);
  const plan = tree.find((n) => n.name === 'plan');
  assert.deepEqual(plan.children.map((n) => [n.path, n.type, n.children]), [['plan/archive', 'dir', []]]);
});

test('buildFileTree does not duplicate a folder that files already imply', () => {
  const tree = buildFileTree(['plan/notes.md'], ['plan']);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].children.map((n) => n.path), ['plan/notes.md']);
});
