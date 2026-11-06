import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createStepOutputFiles, outputFileNames, outputSlug } from '../src/worker/stepOutputFiles.ts';

let tempRoot: string;
let root: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'step-output-files-test-'));
  root = path.join(tempRoot, 'step-outputs');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** Captures console.error calls while `fn` runs. */
async function capturingErrors<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original;
  }
}

const round = (overrides: Partial<Parameters<ReturnType<typeof createStepOutputFiles>['ensureRound']>[0]> = {}) => ({
  projectId: 'p1', runId: 'r1', stepId: 'ui-planning', round: 1,
  outputs: [{ name: 'Settings Screen', format: 'html' as const, content: '<p>settings</p>' }],
  ...overrides,
});

test('an output lands at <root>/<project>/<run>/<step>/round-<n>/<slug>.<ext>, as an absolute path', async () => {
  const files = createStepOutputFiles(root);
  const [file] = await files.ensureRound(round());
  assert.equal(file, path.join(root, 'p1', 'r1', 'ui-planning', 'round-1', 'settings-screen.html'));
  assert.ok(path.isAbsolute(file!));
  assert.equal(files.runDir('p1', 'r1'), path.join(root, 'p1', 'r1'));
});

test('html outputs get .html and markdown outputs get .md', () => {
  assert.deepEqual(outputFileNames([{ name: 'A', format: 'html' }, { name: 'B', format: 'markdown' }]), ['a.html', 'b.md']);
});

test('names become safe slugs: case, spaces, punctuation and accents', () => {
  assert.equal(outputSlug('Settings Screen!'), 'settings-screen');
  assert.equal(outputSlug('  Café — Menu (v2)  '), 'cafe-menu-v2');
  assert.equal(outputSlug('x'.repeat(200)).length, 80);
});

test('path-like names never escape the round folder', async () => {
  const files = createStepOutputFiles(root);
  const outputs = ['../../etc/x', 'a/b', 'C:\\x', 'nul\0byte', '..'].map((name) => ({ name, format: 'markdown' as const, content: name }));
  const paths = await files.ensureRound(round({ round: 2, outputs }));
  const roundDir = path.join(root, 'p1', 'r1', 'ui-planning', 'round-2');
  for (const file of paths) assert.equal(path.dirname(file!), roundDir);
  assert.deepEqual(paths.map((file) => path.basename(file!)), ['etc-x.md', 'a-b.md', 'c-x.md', 'nul-byte.md', 'output-5.md']);
});

test('an empty or all-symbol name falls back to output-<n>', () => {
  assert.deepEqual(outputFileNames([{ name: '', format: 'html' }, { name: '!!!', format: 'html' }]), ['output-1.html', 'output-2.html']);
});

test('names that slug the same get distinct files, each holding its own content', async () => {
  const files = createStepOutputFiles(root);
  const outputs = [
    { name: 'Settings', format: 'html' as const, content: 'one' },
    { name: 'settings!', format: 'html' as const, content: 'two' },
    { name: 'SETTINGS', format: 'html' as const, content: 'three' },
  ];
  const paths = await files.ensureRound(round({ round: 3, outputs }));
  assert.deepEqual(paths.map((file) => path.basename(file!)), ['settings.html', 'settings-2.html', 'settings-3.html']);
  assert.deepEqual(await Promise.all(paths.map((file) => readFile(file!, 'utf-8'))), ['one', 'two', 'three']);
});

test('an id that is not a plain id is refused: nothing is written and each output gets no path', async () => {
  const files = createStepOutputFiles(root);
  for (const bad of [{ runId: '../r' }, { projectId: 'a/b' }, { stepId: '..' }, { round: 0 }]) {
    const { result, errors } = await capturingErrors(() => files.ensureRound(round(bad)));
    assert.deepEqual(result, [null], JSON.stringify(bad));
    assert.equal(errors.length, 1);
  }
  assert.throws(() => files.runDir('p1', '../x'), /Invalid run id/);
});

test('a file is written once: building the round again reuses it without rewriting', async () => {
  const files = createStepOutputFiles(root);
  const [first] = await files.ensureRound(round({ round: 4 }));
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(first!, old, old);
  const [second] = await files.ensureRound(round({ round: 4 }));
  assert.equal(second, first);
  assert.equal((await stat(second!)).mtime.getTime(), old.getTime(), 'not rewritten');
});

test('the file holds the output byte for byte, including UTF-8 and large content', async () => {
  const files = createStepOutputFiles(root);
  const content = `# Ünïcödé ✓ 日本語\n${'<div class="row">line</div>\n'.repeat(20_000)}`;
  const [file] = await files.ensureRound(round({ round: 5, outputs: [{ name: 'Big', format: 'markdown', content }] }));
  assert.ok((await readFile(file!)).equals(Buffer.from(content, 'utf-8')));
});

test('a written file is read-only', async () => {
  const files = createStepOutputFiles(root);
  const [file] = await files.ensureRound(round({ round: 6 }));
  assert.equal((await stat(file!)).mode & 0o777, 0o444);
});

test('removeRun deletes one run\'s folder, removeProject the whole project; missing folders are a no-op', async () => {
  const files = createStepOutputFiles(root);
  await files.ensureRound(round({ projectId: 'del', runId: 'run-a' }));
  await files.ensureRound(round({ projectId: 'del', runId: 'run-b' }));
  await files.ensureRound(round({ projectId: 'keep', runId: 'run-c' }));

  await files.removeRun('del', 'run-a');
  assert.deepEqual(await readdir(path.join(root, 'del')), ['run-b'], 'read-only files do not block deletion');
  await files.removeRun('del', 'run-a');
  await files.removeProject('del');
  await files.removeProject('del');
  await assert.rejects(stat(path.join(root, 'del')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.join(root, 'keep')), ['run-c']);
  await files.removeProject('never-existed');
});

test('a write failure gives that output no path, logs once with the run, step and output name, and never throws', async () => {
  const blocked = path.join(tempRoot, 'blocked-root');
  await writeFile(blocked, 'a file where the folder should be');
  const { result, errors } = await capturingErrors(() => createStepOutputFiles(blocked).ensureRound(round()));
  assert.deepEqual(result, [null]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /run r1, step ui-planning, round 1/);

  // One output failing (its file name is already a folder) leaves the other written.
  const files = createStepOutputFiles(root);
  const roundDir = path.join(root, 'p1', 'r1', 'ui-planning', 'round-7');
  await files.ensureRound(round({ round: 7, outputs: [{ name: 'Seed', format: 'markdown', content: '' }] }));
  await rm(path.join(roundDir, 'seed.md'));
  await mkdir(path.join(roundDir, 'broken.html'));
  const partial = await capturingErrors(() => files.ensureRound(round({
    round: 7,
    outputs: [{ name: 'Broken', format: 'html', content: 'x' }, { name: 'Fine', format: 'html', content: 'y' }],
  })));
  assert.deepEqual(partial.result, [null, path.join(roundDir, 'fine.html')]);
  assert.equal(partial.errors.length, 1);
  assert.match(partial.errors[0]!, /output "Broken" of run r1, step ui-planning, round 7/);
});

test('a round with no outputs writes nothing', async () => {
  const files = createStepOutputFiles(path.join(tempRoot, 'empty-root'));
  assert.deepEqual(await files.ensureRound(round({ outputs: [] })), []);
  await assert.rejects(stat(path.join(tempRoot, 'empty-root')), { code: 'ENOENT' });
});

test('a write that fails partway leaves no partial file: the next build writes the full output instead of reusing a truncated one', async () => {
  const content = 'complete content '.repeat(1000);
  let failing = true;
  const flakyWrite = (async (file: Parameters<typeof writeFile>[0], data: string, options: Parameters<typeof writeFile>[2]) => {
    if (!failing) return writeFile(file, data, options);
    await writeFile(file, data.slice(0, 10), options);
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  }) as typeof writeFile;
  const files = createStepOutputFiles(root, { writeFile: flakyWrite });
  const input = round({ round: 8, outputs: [{ name: 'Big', format: 'markdown', content }] });

  const first = await capturingErrors(() => files.ensureRound(input));
  assert.deepEqual(first.result, [null], 'this prompt pastes it inline');
  const roundDir = path.join(root, 'p1', 'r1', 'ui-planning', 'round-8');
  assert.deepEqual(await readdir(roundDir), [], 'neither the final file nor the temp file is left behind');

  failing = false;
  const [file] = await files.ensureRound(input);
  assert.equal(await readFile(file!, 'utf-8'), content);
  assert.deepEqual(await readdir(roundDir), ['big.md']);
});
