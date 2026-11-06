import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import {
  NotAFileError,
  PathTraversalError,
  listProjectTree,
  readFileSafely,
  resolveSafePath,
} from '../src/projects/fileTree.ts';

let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'file-tree-test-'));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---- resolveSafePath: the path-traversal guard every route in this module goes through ----

test('resolveSafePath resolves an ordinary relative path inside the root', async () => {
  const root = path.join(tempRoot, 'ordinary');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'readme.md'), 'hi');
  const resolved = await resolveSafePath(root, 'readme.md');
  assert.equal(resolved, path.join(root, 'readme.md'));
});

test('resolveSafePath resolves a nested relative path inside the root', async () => {
  const root = path.join(tempRoot, 'nested');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.ts'), 'x');
  const resolved = await resolveSafePath(root, 'src/index.ts');
  assert.equal(resolved, path.join(root, 'src', 'index.ts'));
});

test('resolveSafePath rejects a "../" escape', async () => {
  const root = path.join(tempRoot, 'escape-relative');
  await mkdir(root, { recursive: true });
  await assert.rejects(() => resolveSafePath(root, '../../etc/passwd'), PathTraversalError);
});

test('resolveSafePath rejects a "../" escape that stays nested at first', async () => {
  const root = path.join(tempRoot, 'escape-relative-nested');
  await mkdir(root, { recursive: true });
  await assert.rejects(() => resolveSafePath(root, 'src/../../outside.txt'), PathTraversalError);
});

test('resolveSafePath rejects an absolute path outside the root', async () => {
  const root = path.join(tempRoot, 'escape-absolute');
  await mkdir(root, { recursive: true });
  await assert.rejects(() => resolveSafePath(root, '/etc/passwd'), PathTraversalError);
});

test('resolveSafePath rejects an absolute path even when it looks close to the root', async () => {
  const root = path.join(tempRoot, 'escape-absolute-lookalike');
  await mkdir(root, { recursive: true });
  // A sibling directory whose name merely starts with the same prefix as root — must not pass a
  // naive startsWith(root) check the way a proper path.relative comparison correctly rejects it.
  const lookalike = `${root}-evil`;
  await mkdir(lookalike, { recursive: true });
  await writeFile(path.join(lookalike, 'secret.txt'), 'nope');
  await assert.rejects(() => resolveSafePath(root, path.join(lookalike, 'secret.txt')), PathTraversalError);
});

test('resolveSafePath rejects a symlink that escapes the root', async () => {
  const root = path.join(tempRoot, 'symlink-root');
  const outside = path.join(tempRoot, 'symlink-outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'top secret');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

  await assert.rejects(() => resolveSafePath(root, 'link.txt'), PathTraversalError);
});

test('resolveSafePath lets a missing (not-yet-created) path through so the caller 404s instead of masking it as a traversal', async () => {
  const root = path.join(tempRoot, 'missing-file');
  await mkdir(root, { recursive: true });
  const resolved = await resolveSafePath(root, 'does-not-exist.txt');
  assert.equal(resolved, path.join(root, 'does-not-exist.txt'));
});

test('resolveSafePath rejects a not-yet-created path under a symlinked folder that escapes the root', async () => {
  const root = path.join(tempRoot, 'missing-under-link');
  const outside = path.join(tempRoot, 'missing-under-link-outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(root, 'linked'));
  await assert.rejects(() => resolveSafePath(root, 'linked/new/file.txt'), PathTraversalError);
});

test('resolveSafePath accepts a path under a root that does not exist yet', async () => {
  const root = path.join(tempRoot, 'not-created-root', '.docs');
  assert.equal(await resolveSafePath(root, 'a/b.md'), path.join(root, 'a', 'b.md'));
});

test('resolveSafePath rejects a non-string/empty path', async () => {
  const root = path.join(tempRoot, 'bad-input');
  await mkdir(root, { recursive: true });
  await assert.rejects(() => resolveSafePath(root, ''), PathTraversalError);
  await assert.rejects(() => resolveSafePath(root, '   '), PathTraversalError);
});

// ---- readFileSafely ----

test('readFileSafely reads a small text file', async () => {
  const root = path.join(tempRoot, 'read-text');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
  const result = await readFileSafely(root, 'a.ts');
  assert.deepEqual(result, { kind: 'text', content: 'export const a = 1;\n' });
});

test('readFileSafely reports a binary file rather than returning raw bytes', async () => {
  const root = path.join(tempRoot, 'read-binary');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  const result = await readFileSafely(root, 'image.png');
  assert.deepEqual(result, { kind: 'binary' });
});

test('readFileSafely reports a too-large file without reading its content', async () => {
  const root = path.join(tempRoot, 'read-too-large');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'big.txt'), 'x'.repeat(1_000_001));
  const result = await readFileSafely(root, 'big.txt');
  assert.equal(result.kind, 'too-large');
});

test('readFileSafely throws ENOENT for a missing file (caller maps this to 404)', async () => {
  const root = path.join(tempRoot, 'read-missing');
  await mkdir(root, { recursive: true });
  await assert.rejects(() => readFileSafely(root, 'nope.txt'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('readFileSafely rejects a directory with NotAFileError', async () => {
  const root = path.join(tempRoot, 'read-dir');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await assert.rejects(() => readFileSafely(root, 'src'), NotAFileError);
});

test('readFileSafely rejects a traversal attempt', async () => {
  const root = path.join(tempRoot, 'read-traversal');
  await mkdir(root, { recursive: true });
  await assert.rejects(() => readFileSafely(root, '../../etc/passwd'), PathTraversalError);
});

// ---- listProjectTree ----

test('listProjectTree walks a plain (non-git) project, excluding noise directories from files and folders', async () => {
  const root = path.join(tempRoot, 'walk-plain');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.ts'), 'x');
  await writeFile(path.join(root, 'README.md'), 'hi');
  await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'x');
  await writeFile(path.join(root, '.git', 'HEAD'), 'x');
  await mkdir(path.join(root, 'scripts', 'empty'), { recursive: true });

  const tree = await listProjectTree(root);
  assert.deepEqual(tree.files, ['README.md', 'src/index.ts']);
  assert.deepEqual(tree.folders, ['scripts', 'scripts/empty', 'src'], 'empty folders are listed; .git and node_modules are not');
});

test('listProjectTree never follows a symlinked directory while walking a non-git project', async () => {
  const root = path.join(tempRoot, 'walk-symlink');
  const outside = path.join(tempRoot, 'walk-symlink-outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'nope');
  await symlink(outside, path.join(root, 'linked-dir'));
  await writeFile(path.join(root, 'real.txt'), 'x');

  assert.deepEqual(await listProjectTree(root), { files: ['real.txt'], folders: [] });
});

test('listProjectTree uses git ls-files (respecting .gitignore) for a project that is its own git repo, and still lists empty folders', async () => {
  const root = path.join(tempRoot, 'walk-git');
  await mkdir(root, { recursive: true });
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'user.name'; process.env.GIT_CONFIG_VALUE_0 = 'Test';
  process.env.GIT_CONFIG_KEY_1 = 'user.email'; process.env.GIT_CONFIG_VALUE_1 = 'test@example.com';
  await git(root, ['init', '--initial-branch=main']);
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\nbuild-output/\n');
  await mkdir(path.join(root, 'empty', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'build-output', 'inner'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'x');
  await writeFile(path.join(root, 'tracked.ts'), 'x');
  await writeFile(path.join(root, 'ignored.txt'), 'x');
  await writeFile(path.join(root, 'untracked.md'), 'x');
  await git(root, ['add', 'tracked.ts', '.gitignore']);
  await git(root, ['commit', '-m', 'initial']);

  const { files, folders } = await listProjectTree(root);
  assert.deepEqual(files, ['.gitignore', 'src/a.ts', 'tracked.ts', 'untracked.md']);
  assert.ok(!files.includes('ignored.txt'), 'a gitignored file is excluded');
  assert.deepEqual(folders, ['empty', 'empty/nested', 'src'], 'empty folders show up; .git and gitignored folders do not');
  delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0;
  delete process.env.GIT_CONFIG_KEY_1; delete process.env.GIT_CONFIG_VALUE_1;
});

test('listProjectTree falls back to a plain walk for a project merely nested inside another repo (not its own)', async () => {
  // This whole test suite runs inside agent-visual-os's own git repo — tempRoot (under the OS's
  // temp dir) is not, so `root` here is a fair stand-in for "created without a repositoryUrl,
  // living under something else's .git" (e.g. this daemon's own gitignored projects/ directory).
  // The real regression this guards: naively trusting any `git ls-files` success would silently
  // answer for the wrong (outer) repo instead of falling back — see isOwnGitRepo's doc comment.
  const outerRoot = path.join(tempRoot, 'outer-repo');
  const nested = path.join(outerRoot, 'projects', 'inner');
  await mkdir(nested, { recursive: true });
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'user.name'; process.env.GIT_CONFIG_VALUE_0 = 'Test';
  process.env.GIT_CONFIG_KEY_1 = 'user.email'; process.env.GIT_CONFIG_VALUE_1 = 'test@example.com';
  await git(outerRoot, ['init', '--initial-branch=main']);
  await writeFile(path.join(outerRoot, '.gitignore'), 'projects/\n');
  await writeFile(path.join(nested, 'file.ts'), 'x');

  const { files } = await listProjectTree(nested);
  assert.deepEqual(files, ['file.ts'], 'falls back to a plain walk instead of asking the outer repo (which would ignore it entirely)');
  delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0;
  delete process.env.GIT_CONFIG_KEY_1; delete process.env.GIT_CONFIG_VALUE_1;
});
