import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { git } from '../src/projects/git.ts';

// Case 48's dev-mode row, and case 61: dev mode must never suppress detection, only block apply —
// kept in its own file/process since IS_PROD_MODE is fixed once per process at config.ts's module
// load, and appUpdateService.test.ts needs 'prod' mode throughout for the rest of the apply/hold
// machinery.

let root: string;
let appDir: string;
let seedDir: string;
let appUpdateService: typeof import('../src/appUpdate/appUpdateService.ts');

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'app-update-dev-'));
  appDir = path.join(root, 'app');
  seedDir = path.join(root, 'seed');
  process.env.AGENT_VISUAL_OS_APP_ROOT = appDir;
  process.env.AGENT_VISUAL_OS_RUN_DIR = path.join(root, 'run');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.NODE_ENV = 'test'; // explicitly NOT 'production' — this file is the dev-mode case.
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'user.name'; process.env.GIT_CONFIG_VALUE_0 = 'Test';
  process.env.GIT_CONFIG_KEY_1 = 'user.email'; process.env.GIT_CONFIG_VALUE_1 = 'test@example.com';

  await git(root, ['init', '--bare', '--initial-branch=main', 'origin.git']);
  await git(root, ['clone', path.join(root, 'origin.git'), 'app']);
  await writeFile(path.join(appDir, 'README.md'), 'v1');
  await git(appDir, ['add', '.']);
  await git(appDir, ['commit', '-m', 'initial']);
  await git(appDir, ['push', 'origin', 'main']);
  await git(root, ['clone', path.join(root, 'origin.git'), 'seed']);

  appUpdateService = await import('../src/appUpdate/appUpdateService.ts');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('22/48/61: dev mode still detects an available update normally, but apply() throws the dev-mode-specific error and triggers no side effect', async () => {
  await writeFile(path.join(seedDir, 'README.md'), 'v2');
  await git(seedDir, ['commit', '-am', 'remote change']);
  await git(seedDir, ['push', 'origin', 'main']);

  const pullCalls: string[] = [];
  const startCalls: unknown[] = [];
  const service = appUpdateService.createAppUpdateService({
    sessions: { has: () => false, count: () => 0 },
    runDir: path.join(root, 'run'),
    webOnlySteps: {
      pull: async () => { pullCalls.push('pull'); return { ok: true, output: '' }; },
      installWeb: async () => ({ ok: true, output: '' }),
      buildWeb: async () => ({ ok: true, output: '' }),
    },
    startServerUpdate: (context) => startCalls.push(context),
  });

  const status = await service.checkNow();
  assert.equal(status.mode, 'dev');
  assert.equal(status.availability, 'available', 'detection is never suppressed by dev mode');
  assert.equal(status.behindBy, 1);
  assert.equal(status.canApply, false);
  assert.match(status.applyBlockedReason ?? '', /production-style install/);

  assert.throws(
    () => service.apply(),
    (error: unknown) => error instanceof appUpdateService.AppUpdateNotApplicableError && /production-style install/.test((error as Error).message),
  );

  assert.equal(pullCalls.length, 0, 'no web-only step was ever invoked');
  assert.equal(startCalls.length, 0, 'the server-path updater was never spawned');
  assert.equal((await service.getStatus()).phase, 'idle', 'apply() throwing must never change phase');
});
