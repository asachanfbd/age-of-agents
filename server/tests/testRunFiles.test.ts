import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRunFiles } from '../src/testing/runFiles.ts';

let dir: string;

before(async () => {
  dir = path.join(await mkdtemp(path.join(tmpdir(), 'run-files-test-')), 'test-runs');
});

after(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

test('logs append in order and results round-trip, each in its own file', async () => {
  const files = createRunFiles(dir);
  assert.equal(await files.readLog('run-1'), '');
  assert.equal(await files.readResult('run-1'), null);
  await files.appendLog('run-1', 'one\n');
  await files.appendLog('run-1', 'two\n');
  const result = { outcome: 'passed' as const, metrics: [], findings: [], cases: [{ name: 'a', outcome: 'passed' as const }] };
  await files.writeResult('run-1', result);
  assert.equal(await files.readLog('run-1'), 'one\ntwo\n');
  assert.deepEqual(await files.readResult('run-1'), result);
  assert.deepEqual((await readdir(dir)).sort(), ['run-1.log', 'run-1.result.json']);

  await files.remove('run-1');
  await files.remove('run-1'); // Removing again is a no-op.
  assert.deepEqual(await readdir(dir), []);
});

test('an id that could name a path is refused', async () => {
  const files = createRunFiles(dir);
  for (const id of ['../escape', 'a/b', '', 'x.y']) {
    await assert.rejects(files.readLog(id), /Invalid test run id/);
  }
});

test('a read error other than a missing file is not hidden', async () => {
  const files = createRunFiles(dir);
  await files.appendLog('dir-run', 'x');
  // A directory where the result file should be makes readFile fail with EISDIR.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dir, 'dir-run.result.json'));
  await assert.rejects(files.readResult('dir-run'), { code: 'EISDIR' });
});
