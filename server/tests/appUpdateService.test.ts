import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import type { TaskRecord } from '../src/domain/types.ts';

// Cases 34-48 and 57-59 from task 7.001's test plan: the stateful service's checkNow/notification
// sync, apply/hold/cancel/auto-fire machinery, and restart recovery. Mode is pinned to 'prod'
// (NODE_ENV=production) for this whole file so `apply()` is ever reachable — the dev-mode-specific
// 400 (case 48's dev-mode row, case 61) is covered in its own file instead, since IS_PROD_MODE is
// fixed once per process at config.ts's module load and this file needs 'prod' throughout.

let root: string;
let appDir: string;
let seedDir: string;
let appUpdateService: typeof import('../src/appUpdate/appUpdateService.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');
let collections: typeof import('../src/db/collections.ts');

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'app-update-service-'));
  appDir = path.join(root, 'app');
  seedDir = path.join(root, 'seed');
  process.env.AGENT_VISUAL_OS_APP_ROOT = appDir;
  process.env.AGENT_VISUAL_OS_RUN_DIR = path.join(root, 'run-unused'); // overridden per-test via options.runDir instead
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.NODE_ENV = 'production';
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
  notificationService = await import('../src/notifications/notificationService.ts');
  collections = await import('../src/db/collections.ts');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function resyncApp(): Promise<void> {
  await git(appDir, ['merge', '--ff-only', 'origin/main']);
}

async function pushServerChange(label: string): Promise<void> {
  await writeFile(path.join(seedDir, 'server-file.txt'), label);
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', `server change: ${label}`]);
  await git(seedDir, ['push', 'origin', 'main']);
}

async function pushWebOnlyChange(label: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(seedDir, 'web', 'src'), { recursive: true });
  await writeFile(path.join(seedDir, 'web', 'src', 'App.tsx'), label);
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', `web change: ${label}`]);
  await git(seedDir, ['push', 'origin', 'main']);
}

function fakeSessions(): { has(): boolean; count(): number } {
  return { has: () => false, count: () => 0 };
}

let seq = 0;
function fakeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  seq += 1;
  return {
    id: `svc-task-${seq}`, projectId: `svc-project-${seq}`,
    templateId: 'builder', executorId: 'test-claude-cli', description: 'Task', autonomy: 'auto', manager: false,
    kind: 'execute', status: 'developing', runtimeStatus: 'starting', planItemId: null, sessionId: null,
    blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

/** A running CommandRun — one of the three things that block an update (a stored Task row never does; only a live process counts). */
async function insertBlocker() {
  seq += 1;
  return collections.commandRunsDb.insert({
    id: `svc-cmd-run-${seq}`, projectId: `svc-project-${seq}`, commandId: 'svc-cmd', commandName: 'Build', commandText: 'npm run build',
    origin: 'saved', status: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), completedAt: null,
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---- 34: manual check-now is immediate, independent of any recurring tick (none is ever started in this file) ----

test('34: checkNow re-fetches immediately and reflects a git-state change made just before the call', async () => {
  const service = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir: path.join(root, 'run-34') });
  const upToDate = await service.checkNow();
  assert.equal(upToDate.availability, 'up-to-date');

  await pushServerChange('34');
  const behind = await service.checkNow();
  assert.equal(behind.availability, 'available');
  assert.equal(behind.behindBy, 1);
  await resyncApp();
  await service.checkNow(); // resolves the Notification this test's own "available" tick raised
});

// ---- 40 (run first, before anything else has a chance to leave an open notification): a failed check, even the very first ever, raises nothing ----

test('40: a failed check never raises a Notification, even as the very first check ever', async () => {
  await git(appDir, ['remote', 'set-url', 'origin', path.join(root, 'nonexistent.git')]);
  try {
    const service = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir: path.join(root, 'run-40') });
    const status = await service.checkNow();
    assert.ok(status.checkError);
    assert.equal(status.lastSuccessfulCheckAt, null);
    const notifications = await notificationService.listNotifications({ projectId: 'none', resolved: false });
    assert.deepEqual(notifications.filter((n) => n.kind === 'app.update_available'), []);
  } finally {
    await git(appDir, ['remote', 'set-url', 'origin', path.join(root, 'origin.git')]);
  }
});

// ---- 35-39: the notification lifecycle ----

test('35-39: raises once on first transition, never duplicates while still behind, updates text in place as behindBy grows, resolves on catch-up, and raises fresh after a dismissed one plus a newer head', async () => {
  const service = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir: path.join(root, 'run-35') });

  // 35: first transition to behind raises exactly one.
  await pushServerChange('a');
  await service.checkNow();
  const afterFirst = await notificationService.listNotifications({ projectId: 'none', resolved: false });
  const open = afterFirst.filter((n) => n.kind === 'app.update_available');
  assert.equal(open.length, 1);
  const firstId = open[0]!.id;

  // 36: polling again with no further change never duplicates.
  await service.checkNow();
  const afterSecondTick = (await notificationService.listNotifications({ projectId: 'none', resolved: false }))
    .filter((n) => n.kind === 'app.update_available');
  assert.equal(afterSecondTick.length, 1);
  assert.equal(afterSecondTick[0]!.id, firstId);

  // 37: behindBy growing further updates the same Notification's text in place.
  await pushServerChange('b');
  await service.checkNow();
  const afterGrowth = (await notificationService.listNotifications({ projectId: 'none', resolved: false }))
    .filter((n) => n.kind === 'app.update_available');
  assert.equal(afterGrowth.length, 1);
  assert.equal(afterGrowth[0]!.id, firstId);
  assert.match(afterGrowth[0]!.title, /2 commit/);

  // 38: catching up (an external fast-forward, not through apply()) resolves it.
  await resyncApp();
  await service.checkNow();
  const resolved = await notificationService.getNotification(firstId);
  assert.ok(resolved.resolvedAt);

  // 39: a dismissed (resolved) Notification plus a newer remote head afterward raises a fresh one.
  await pushServerChange('c');
  await service.checkNow();
  const afterFresh = (await notificationService.listNotifications({ projectId: 'none', resolved: false }))
    .filter((n) => n.kind === 'app.update_available');
  assert.equal(afterFresh.length, 1);
  assert.notEqual(afterFresh[0]!.id, firstId, 'a fresh Notification, not the resolved one reopened');

  await resyncApp();
  await service.checkNow(); // leaves things resolved/clean for later tests
});

// ---- 41-48: apply / hold / cancel / auto-fire ----

test('41: apply on a web-only change starts immediately, leaving a live blocking CommandRun completely untouched throughout', async () => {
  await pushWebOnlyChange('41');
  const blocker = await insertBlocker();

  const calls: string[] = [];
  const service = appUpdateService.createAppUpdateService({
    sessions: fakeSessions(),
    runDir: path.join(root, 'run-41'),
    webOnlySteps: {
      pull: async () => { calls.push('pull'); return { ok: true, output: '' }; },
      installWeb: async () => { calls.push('installWeb'); return { ok: true, output: '' }; },
      buildWeb: async () => { calls.push('buildWeb'); return { ok: true, output: '' }; },
    },
    startServerUpdate: () => { throw new Error('must never be called on the web-only path'); },
  });
  try {
    await service.checkNow();
    const before = await collections.commandRunsDb.get(blocker.id);

    const applied = service.apply();
    assert.equal(applied.phase, 'updating');

    await waitUntil(async () => (await service.getStatus()).phase === 'updated');
    // No web manifest/lockfile changed in pushWebOnlyChange, so installWeb is correctly skipped —
    // see case 49 in appUpdateRunners.test.ts for the dedicated installWebDeps-gating coverage.
    assert.deepEqual(calls, ['pull', 'buildWeb']);

    const after = await collections.commandRunsDb.get(blocker.id);
    assert.deepEqual(after, before, 'the blocking CommandRun is left completely untouched by a web-only apply');
  } finally {
    await collections.commandRunsDb.delete(blocker.id);
    await resyncApp();
    await service.checkNow();
  }
});

test('42: apply on a server change holds rather than starting, and does not block a brand-new Task from starting', async () => {
  await pushServerChange('42');
  const blocker = await insertBlocker();

  const startCalls: Array<{ previousCommit: string; newCommit: string }> = [];
  const service = appUpdateService.createAppUpdateService({
    sessions: fakeSessions(),
    runDir: path.join(root, 'run-42'),
    heldWatcherIntervalMs: 5000, // long enough to never fire during this test
    startServerUpdate: (context) => startCalls.push(context),
  });
  await service.checkNow();

  const applied = service.apply();
  assert.equal(applied.phase, 'held');
  assert.equal(startCalls.length, 0, 'not started yet — just held');

  const newTask = await collections.tasksDb.insert(fakeTask());
  assert.ok(await collections.tasksDb.get(newTask.id), 'nothing blocks new work from starting while held');

  service.cancel();
  await collections.commandRunsDb.delete(blocker.id);
  await collections.tasksDb.delete(newTask.id);
  await resyncApp();
  await service.checkNow();
});

test('43: blocking counts in the status change live as fakes settle one kind at a time', async () => {
  await pushServerChange('43');
  const command = await insertBlocker();
  const testRun = await collections.testRunsDb.insert({
    id: 'svc-test-run-43', projectId: 'svc-project-43', batchId: null,
    suite: { id: 'unit', label: 'Unit', kind: 'unit' }, action: { id: 'unit:test', label: 'test', purpose: 'result', command: 'npm test', workingDirectory: '.', collectors: [] },
    trigger: 'manual', taskId: null, executionRoot: '/tmp', cwd: null, branch: null, commit: null,
    status: 'running', exitCode: null, queuedAt: new Date().toISOString(), startedAt: null, completedAt: null, durationMs: null,
    outputTruncated: false, summary: null, diagnostics: [], artifactDir: null,
  });

  const service = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir: path.join(root, 'run-43'), heldWatcherIntervalMs: 5000 });
  await service.checkNow();
  service.apply();

  let status = await service.getStatus();
  assert.equal(status.blocking.commands, 1);
  assert.equal(status.blocking.testRuns, 1);

  await collections.commandRunsDb.delete(command.id);
  status = await service.getStatus();
  assert.equal(status.blocking.commands, 0);
  assert.equal(status.blocking.testRuns, 1, 'still blocked by the TestRun');

  await collections.testRunsDb.delete(testRun.id);
  status = await service.getStatus();
  assert.equal(status.blocking.testRuns, 0);

  service.cancel();
  await resyncApp();
  await service.checkNow();
});

test('44: a held update auto-starts the instant the last blocking count reaches zero, with no further client request', async () => {
  await pushServerChange('44');
  const blocker = await insertBlocker();

  const startCalls: Array<{ previousCommit: string; newCommit: string }> = [];
  const service = appUpdateService.createAppUpdateService({
    sessions: fakeSessions(),
    runDir: path.join(root, 'run-44'),
    heldWatcherIntervalMs: 20,
    startServerUpdate: (context) => startCalls.push(context),
  });
  const beforeApply = await service.checkNow();
  service.apply();

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(startCalls.length, 0, 'still blocked — must not have fired yet');
  assert.equal((await service.getStatus()).phase, 'held');

  await collections.commandRunsDb.delete(blocker.id);
  await waitUntil(() => startCalls.length === 1);
  assert.equal((await service.getStatus()).phase, 'updating');
  assert.equal(startCalls[0]!.previousCommit, beforeApply.currentCommit);

  await resyncApp();
});

test('45: cancel while held returns to available(N); the auto-fire never happens afterward even past the watcher interval', async () => {
  await pushServerChange('45');
  const blocker = await insertBlocker();

  const startCalls: unknown[] = [];
  const service = appUpdateService.createAppUpdateService({
    sessions: fakeSessions(),
    runDir: path.join(root, 'run-45'),
    heldWatcherIntervalMs: 20,
    startServerUpdate: (context) => startCalls.push(context),
  });
  await service.checkNow();
  service.apply();
  assert.equal((await service.getStatus()).phase, 'held');

  const cancelled = service.cancel();
  assert.equal(cancelled.phase, 'idle');
  assert.equal(cancelled.availability, 'available');

  await collections.commandRunsDb.delete(blocker.id);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(startCalls.length, 0, 'cancel must have cleared the watcher for good');
  assert.equal((await service.getStatus()).phase, 'idle');

  await resyncApp();
  await service.checkNow();
});

test('46: cancel when nothing is held is a no-op returning the unchanged status (not 409)', async () => {
  const service = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir: path.join(root, 'run-46') });
  const before = await service.checkNow();
  const result = service.cancel();
  assert.deepEqual(result, before);
});

test('47: apply while another is held/updating throws AppUpdateAlreadyInProgressError, leaving state untouched', async () => {
  await pushServerChange('47');
  const blocker = await insertBlocker();
  const service = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir: path.join(root, 'run-47'), heldWatcherIntervalMs: 5000 });
  await service.checkNow();
  service.apply();
  const heldStatus = await service.getStatus();

  assert.throws(() => service.apply(), appUpdateService.AppUpdateAlreadyInProgressError);
  const afterAttempt = await service.getStatus();
  assert.equal(afterAttempt.phase, heldStatus.phase);
  assert.equal(afterAttempt.availability, heldStatus.availability);

  service.cancel();
  await collections.commandRunsDb.delete(blocker.id);
  await resyncApp();
  await service.checkNow();
});

test('48: apply when not updatable throws AppUpdateNotApplicableError with a reason-specific message for up-to-date / dirty / ahead / diverged', async () => {
  const service = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir: path.join(root, 'run-48') });

  try {
    await service.checkNow();
    assert.throws(() => service.apply(), appUpdateService.AppUpdateNotApplicableError);

    await writeFile(path.join(seedDir, 'dirty.txt'), 'remote');
    await git(seedDir, ['add', '.']);
    await git(seedDir, ['commit', '-m', '48 adds dirty.txt']);
    await git(seedDir, ['push', 'origin', 'main']);
    await writeFile(path.join(appDir, 'dirty.txt'), 'uncommitted');
    await service.checkNow();
    assert.throws(() => service.apply(), (error: unknown) => error instanceof appUpdateService.AppUpdateNotApplicableError && /uncommitted/.test((error as Error).message));
    await rm(path.join(appDir, 'dirty.txt'));
    await git(appDir, ['merge', '--ff-only', 'origin/main']);

    await writeFile(path.join(appDir, 'ahead-only.txt'), 'local');
    await git(appDir, ['add', '.']);
    await git(appDir, ['commit', '-m', 'ahead only']);
    await service.checkNow();
    assert.throws(() => service.apply(), (error: unknown) => error instanceof appUpdateService.AppUpdateNotApplicableError && /ahead/.test((error as Error).message));

    await pushServerChange('48-diverged');
    await service.checkNow();
    assert.throws(() => service.apply(), (error: unknown) => error instanceof appUpdateService.AppUpdateNotApplicableError && /diverged/.test((error as Error).message));
  } finally {
    await rm(path.join(appDir, 'dirty.txt'), { force: true });
    await git(appDir, ['reset', '--hard', 'origin/main']);
    await service.checkNow();
  }
});

test('Code Review round 1, issue 2: phase "updated" reverts to "idle" on its own after terminalPhaseDisplayMs, restoring "Check now" and discovering a later update — never stuck forever', async () => {
  await pushWebOnlyChange('settle-updated');
  let clock = 1_000_000;
  const service = appUpdateService.createAppUpdateService({
    sessions: fakeSessions(),
    runDir: path.join(root, 'run-settle-updated'),
    now: () => clock,
    terminalPhaseDisplayMs: 1000,
    webOnlySteps: {
      // A real fast-forward (cheap, local) so this test's git-state assertions below mean something;
      // install/build stay fake per the spec's "never shell out to real npm/vite in a test" rule.
      pull: async () => { await resyncApp(); return { ok: true, output: '' }; },
      installWeb: async () => ({ ok: true, output: '' }),
      buildWeb: async () => ({ ok: true, output: '' }),
    },
    startServerUpdate: () => { throw new Error('must never be called on the web-only path'); },
  });
  await service.checkNow();

  const applied = service.apply();
  assert.equal(applied.phase, 'updating');
  await waitUntil(async () => (await service.getStatus()).phase === 'updated');

  // Immediately after: still 'updated', with "Check now" reachable (not an empty action set — the
  // web side's own appUpdateActions table was fixed alongside this).
  const justUpdated = await service.getStatus();
  assert.equal(justUpdated.phase, 'updated');
  assert.ok(justUpdated.updatedToCommit);

  // Before terminalPhaseDisplayMs has elapsed: a read must not revert it early.
  clock += 500;
  assert.equal((await service.getStatus()).phase, 'updated', 'must not revert before its display window elapses');

  // Past terminalPhaseDisplayMs: the very next read reverts it — this is the regression itself
  // (previously `phase` was carried forward by computeAppUpdateStatus forever, with no code path
  // ever setting it back).
  clock += 600;
  const settled = await service.getStatus();
  assert.equal(settled.phase, 'idle');
  assert.equal(settled.updatedToCommit, null);
  assert.equal(settled.failureMessage, null);
  assert.equal(settled.failureLogPath, null);
  assert.equal(settled.availability, 'up-to-date', 'the web-only pull already landed, so there is nothing left to apply');
  assert.equal(settled.canApply, false, 'canApply is false here because availability is up-to-date, not because phase is stuck');

  // And a LATER update is still discoverable without a process restart — the whole point.
  await pushWebOnlyChange('settle-updated-again');
  const rediscovered = await service.checkNow();
  assert.equal(rediscovered.phase, 'idle');
  assert.equal(rediscovered.availability, 'available');

  await resyncApp();
  await service.checkNow();
});

test('Code Review round 1, issue 2 (failure branch): phase "failed" also reverts to "idle" on its own, and canApply/applyBlockedReason are re-derived at every terminal-phase transition (issue 4)', async () => {
  await pushWebOnlyChange('settle-failed');
  let clock = 2_000_000;
  const service = appUpdateService.createAppUpdateService({
    sessions: fakeSessions(),
    runDir: path.join(root, 'run-settle-failed'),
    now: () => clock,
    terminalPhaseDisplayMs: 1000,
    webOnlySteps: {
      // Kept as a no-op fake here (unlike the success test above): the real path's pull still lands
      // even when the build after it fails (the spec only requires recovery on the server path, not
      // a git rollback for a web-only build failure), but that's a separate, already-accepted
      // characteristic this test isn't about — a no-op pull keeps `availability` unambiguously
      // 'available' throughout, so the assertions below are purely about `phase` settling.
      pull: async () => ({ ok: true, output: '' }),
      installWeb: async () => ({ ok: true, output: '' }),
      buildWeb: async () => ({ ok: false, output: 'build exploded' }),
    },
    startServerUpdate: () => { throw new Error('must never be called on the web-only path'); },
  });
  await service.checkNow();
  service.apply();
  await waitUntil(async () => (await service.getStatus()).phase === 'failed');

  const justFailed = await service.getStatus();
  assert.equal(justFailed.phase, 'failed');
  assert.equal(justFailed.canApply, true, 'canApply is correctly re-derived (issue 4) — availability is still "available", so Retry works immediately');

  clock += 1100;
  const settled = await service.getStatus();
  assert.equal(settled.phase, 'idle');
  assert.equal(settled.failureMessage, null);
  assert.equal(settled.failureLogPath, null);
  assert.equal(settled.availability, 'available', 'the failed pull never advanced HEAD, so the same update is still there to retry');

  await resyncApp();
  await service.checkNow();
});

// ---- 57-59: restart recovery ----

test('57: a held update does not survive a simulated daemon restart — a fresh instance has no hold and runs a normal checkNow instead', async () => {
  await pushServerChange('57');
  const blocker = await insertBlocker();
  const runDir = path.join(root, 'run-57');
  const serviceA = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir, heldWatcherIntervalMs: 5000 });
  await serviceA.checkNow();
  serviceA.apply();
  assert.equal((await serviceA.getStatus()).phase, 'held');

  const serviceB = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir });
  await serviceB.initialize();
  assert.equal((await serviceB.getStatus()).phase, 'idle', 'a fresh instance never inherits a hold from another instance');

  serviceA.cancel();
  await collections.commandRunsDb.delete(blocker.id);
  await resyncApp();
});

test('58: a leftover success result file is reported once ("Updated to <sha>"), then consumed', async () => {
  const runDir = path.join(root, 'run-58');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'app-update-result.json'), JSON.stringify({ ok: true, updatedToCommit: 'abc1234', finishedAt: new Date().toISOString() }));

  const serviceA = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir });
  await serviceA.initialize();
  const statusA = await serviceA.getStatus();
  assert.equal(statusA.phase, 'updated');
  assert.equal(statusA.updatedToCommit, 'abc1234');
  assert.equal(statusA.failureLogPath, 'app-update.log');

  const { access } = await import('node:fs/promises');
  await assert.rejects(access(path.join(runDir, 'app-update-result.json')), 'the result file must be deleted once consumed');

  const serviceB = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir });
  await serviceB.initialize();
  const statusB = await serviceB.getStatus();
  assert.notEqual(statusB.phase, 'updated', 'the consumed result file must not be re-reported');
});

test('59: a leftover failure result file is reported once (phase failed, failureMessage/failureLogPath set), then consumed', async () => {
  const runDir = path.join(root, 'run-59');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'app-update-result.json'), JSON.stringify({ ok: false, failureMessage: 'npm ci failed', finishedAt: new Date().toISOString() }));

  const serviceA = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir });
  await serviceA.initialize();
  const statusA = await serviceA.getStatus();
  assert.equal(statusA.phase, 'failed');
  assert.equal(statusA.failureMessage, 'npm ci failed');
  assert.equal(statusA.failureLogPath, 'app-update.log');

  const serviceB = appUpdateService.createAppUpdateService({ sessions: fakeSessions(), runDir });
  await serviceB.initialize();
  const statusB = await serviceB.getStatus();
  assert.notEqual(statusB.phase, 'failed', 'the consumed result file must not be re-reported');
});
