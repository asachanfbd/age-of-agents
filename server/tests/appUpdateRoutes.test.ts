import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { before, after, test } from 'node:test';
import { git } from '../src/projects/git.ts';

// Cases 30-33 and 60: the four HTTP routes (GET /api/app-update, POST check/apply/cancel), exercised
// against a real throwaway git fixture — the daemon's own checkout — confirming the response shape
// and the {error}/400/409 convention this router uses everywhere else.
//
// This file runs in dev mode (NODE_ENV left at whatever `before()` sets, not 'production') so
// POST /apply's error path can be exercised over real HTTP without ever letting a real detached
// updater spawn — a 'prod'-mode 409 (held/updating) is already covered without that risk by
// appUpdateService.test.ts's direct, fake-injected service construction (cases 42/44/45/47); routing
// it through this file's singleton-backed router would mean either actually spawning
// bin/run-app-update.mjs or leaving a real 2s watcher running past this test's lifetime, which the
// test-isolation rule in server/README.md rules out.

let root: string;
let appDir: string;
let seedDir: string;
let httpServer: HttpServer;
let baseUrl: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'app-update-routes-'));
  appDir = path.join(root, 'app');
  seedDir = path.join(root, 'seed');
  process.env.AGENT_VISUAL_OS_APP_ROOT = appDir;
  process.env.AGENT_VISUAL_OS_RUN_DIR = path.join(root, 'run');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.NODE_ENV = 'test';
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

  const { createDaemonServer } = await import('../src/server.ts');
  httpServer = createDaemonServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await rm(root, { recursive: true, force: true });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

test('31: GET on fresh history with nothing to compare reports up-to-date, behindBy 0', async () => {
  const checked = await api('/api/app-update/check', { method: 'POST' });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.availability, 'up-to-date');
  assert.equal(checked.body.behindBy, 0);

  const got = await api('/api/app-update');
  assert.equal(got.status, 200);
  assert.equal(got.body.availability, 'up-to-date');
});

test('30: GET returns branch/behindBy/lastSuccessfulCheckAt/classification/blocking for a fixture genuinely behind', async () => {
  await writeFile(path.join(seedDir, 'server-file.txt'), '30');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'server change 30']);
  await git(seedDir, ['push', 'origin', 'main']);

  await api('/api/app-update/check', { method: 'POST' });
  const { status, body } = await api('/api/app-update');
  assert.equal(status, 200);
  assert.equal(body.branch, 'main');
  assert.equal(body.behindBy, 1);
  assert.ok(body.lastSuccessfulCheckAt);
  assert.equal(body.classification, 'server');
  assert.deepEqual(Object.keys(body.blocking).sort(), ['commands', 'terminalSessions', 'testRuns'].sort());

  await git(appDir, ['fetch', 'origin']);
  await git(appDir, ['merge', '--ff-only', 'origin/main']);
  await api('/api/app-update/check', { method: 'POST' });
});

test('32: GET with local changes that overlap the update reports cant-auto-update with the blocking files, and canApply false; unrelated changes leave it available', async () => {
  await writeFile(path.join(seedDir, 'overlap.txt'), 'remote');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'adds overlap.txt']);
  await git(seedDir, ['push', 'origin', 'main']);
  await writeFile(path.join(appDir, 'unrelated.txt'), 'uncommitted');
  try {
    await api('/api/app-update/check', { method: 'POST' });
    const unrelated = (await api('/api/app-update')).body;
    assert.equal(unrelated.availability, 'available');
    assert.deepEqual(unrelated.blockingFiles, []);
    assert.equal(unrelated.blockingFilesTotal, 0);

    await writeFile(path.join(appDir, 'overlap.txt'), 'mine');
    await api('/api/app-update/check', { method: 'POST' });
    const { body } = await api('/api/app-update');
    assert.equal(body.availability, 'cant-auto-update');
    assert.match(body.cantUpdateReason ?? '', /uncommitted/);
    assert.equal(body.canApply, false);
    assert.deepEqual(body.blockingFiles, [{ path: 'overlap.txt', kind: 'untracked' }]);
    assert.equal(body.blockingFilesTotal, 1);
  } finally {
    await rm(path.join(appDir, 'unrelated.txt'), { force: true });
    await rm(path.join(appDir, 'overlap.txt'), { force: true });
    await git(appDir, ['fetch', 'origin']);
    await git(appDir, ['merge', '--ff-only', 'origin/main']);
    await api('/api/app-update/check', { method: 'POST' });
  }
});

test('33: GET against a detached HEAD / no origin reports could-not-check, never available', async () => {
  await git(appDir, ['checkout', '--detach', 'HEAD']);
  try {
    await api('/api/app-update/check', { method: 'POST' });
    const { body } = await api('/api/app-update');
    assert.equal(body.availability, 'could-not-check');
    assert.ok(body.checkError);
  } finally {
    await git(appDir, ['checkout', 'main']);
    await api('/api/app-update/check', { method: 'POST' });
  }
});

test('60/61: every app-update route uses the {error} convention; apply in dev mode is 400 with that shape; cancel is always 200', async () => {
  const applied = await api('/api/app-update/apply', { method: 'POST' });
  assert.equal(applied.status, 400);
  assert.equal(typeof applied.body.error, 'string');
  assert.match(applied.body.error, /production-style install/);

  const cancelled = await api('/api/app-update/cancel', { method: 'POST' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.phase, 'idle');

  // app-update has no :id-shaped route, so there's no 404 case among these four — the 400/409
  // convention for THIS resource is covered here (400) and at the service level
  // (appUpdateService.test.ts, cases 42/44/45/47, 409); the existing 404 convention is already
  // covered extensively elsewhere in this test suite (e.g. ProjectNotFoundError).
});
