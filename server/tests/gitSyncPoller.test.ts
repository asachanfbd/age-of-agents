import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { before, after, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import type { GitSyncEvent } from '../src/projects/gitSyncPoller.ts';
import type { CommandRunRecord, TaskRecord, WorkflowRunRecord } from '../src/domain/types.ts';

let root: string;
let service: typeof import('../src/projects/projectService.ts');
let poller: typeof import('../src/projects/gitSyncPoller.ts');
let commands: typeof import('../src/commands/commandRunner.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');
let collections: typeof import('../src/db/collections.ts');
let httpServer: HttpServer;
let baseUrl: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'git-sync-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  // Rewrite only this test process's GitHub URLs to a local bare remote — same trick as gitProjects.test.ts.
  process.env.GIT_CONFIG_COUNT = '3';
  process.env.GIT_CONFIG_KEY_0 = `url.${root}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test/';
  process.env.GIT_CONFIG_KEY_1 = 'user.name'; process.env.GIT_CONFIG_VALUE_1 = 'Test';
  process.env.GIT_CONFIG_KEY_2 = 'user.email'; process.env.GIT_CONFIG_VALUE_2 = 'test@example.com';
  await git(root, ['init', '--bare', '--initial-branch=main', 'repo']);
  await git(root, ['clone', path.join(root, 'repo'), 'seed']);
  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'v1');
  await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'initial']);
  await git(seed, ['push', 'origin', 'main']);
  service = await import('../src/projects/projectService.ts');
  poller = await import('../src/projects/gitSyncPoller.ts');
  commands = await import('../src/commands/commandRunner.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
  collections = await import('../src/db/collections.ts');

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

test('a freshly cloned Project is synced with its remote branch', async () => {
  const project = await service.createProject({ name: 'Sync A', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const sync = await poller.computeProjectSync(project);
  assert.equal(sync.projectId, project.id);
  assert.equal(sync.branch, 'main');
  assert.equal(sync.status, 'synced');
  assert.equal(sync.aheadBy, 0);
  assert.equal(sync.behindBy, 0);
});

test('a push straight to the bare remote (simulating another machine) is picked up as behind', async () => {
  const project = await service.createProject({ name: 'Sync B', position: null, repositoryUrl: 'https://github.com/test/repo' });

  // Someone else pushes to origin/main without this checkout knowing — the exact scenario the
  // poller exists to catch (nothing else here watches the remote).
  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'v2 from elsewhere');
  await git(seed, ['commit', '-am', 'someone else\'s change']);
  await git(seed, ['push', 'origin', 'main']);

  const sync = await poller.computeProjectSync(project);
  assert.equal(sync.status, 'behind');
  assert.equal(sync.behindBy, 1);
  assert.equal(sync.aheadBy, 0);

  // Reset the shared remote back to what the other tests in this file expect.
  await git(seed, ['reset', '--hard', 'HEAD~1']);
  await git(seed, ['push', '--force', 'origin', 'main']);
});

test('an unpushed local commit is ahead, not behind', async () => {
  const project = await service.createProject({ name: 'Sync C', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  await writeFile(path.join(cwd, 'local-only.txt'), 'not pushed yet');
  await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'local work']);

  const sync = await poller.computeProjectSync(project);
  assert.equal(sync.status, 'ahead');
  assert.equal(sync.aheadBy, 1);
  assert.equal(sync.behindBy, 0);
});

test('diverged: both sides have commits the other lacks', async () => {
  const project = await service.createProject({ name: 'Sync D', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  await writeFile(path.join(cwd, 'local-only.txt'), 'local change');
  await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'local work']);

  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'remote change');
  await git(seed, ['commit', '-am', 'remote work']);
  await git(seed, ['push', 'origin', 'main']);

  const sync = await poller.computeProjectSync(project);
  assert.equal(sync.status, 'diverged');
  assert.equal(sync.aheadBy, 1);
  assert.equal(sync.behindBy, 1);

  await git(seed, ['reset', '--hard', 'HEAD~1']);
  await git(seed, ['push', '--force', 'origin', 'main']);
});

test('a branch that was never pushed reports no-remote', async () => {
  const project = await service.createProject({ name: 'Sync E', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await service.checkoutProjectBranch(project.id, 'never-pushed', true);

  const sync = await poller.computeProjectSync(project);
  assert.equal(sync.branch, 'never-pushed');
  assert.equal(sync.status, 'no-remote');
});

test('a Project with no "origin" remote collapses to unknown rather than throwing', async () => {
  const project = await service.createProject({ name: 'Sync F', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  await git(cwd, ['remote', 'remove', 'origin']);

  const sync = await poller.computeProjectSync(project);
  assert.equal(sync.status, 'unknown');
  assert.equal(sync.branch, 'main', 'the branch itself was still readable even though fetch failed');
});

test('createGitSyncPoller: skips repository-less Projects, caches readings, and broadcasts each refresh', async () => {
  const withRepo = await service.createProject({ name: 'Sync G', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const withoutRepo = await service.createProject({ name: 'Sync H (no repo)', position: null });

  const freshPoller = poller.createGitSyncPoller();
  const events: GitSyncEvent[] = [];
  const unsubscribe = freshPoller.onSyncEvent((event) => events.push(event));

  assert.equal(freshPoller.get(withRepo.id), null, 'nothing cached before the first refresh');
  await freshPoller.refreshAll([withRepo, withoutRepo]);

  assert.equal(freshPoller.get(withRepo.id)?.status, 'synced');
  assert.equal(freshPoller.get(withoutRepo.id), null, 'a repository-less Project has nothing to compare and is never recorded');
  assert.equal(events.length, 1, 'only the git-backed Project produces an event');
  assert.equal(events[0]!.sync.projectId, withRepo.id);

  unsubscribe();
  await freshPoller.refreshOne(withRepo);
  assert.equal(events.length, 1, 'unsubscribed listeners stop receiving events');
});

test('refreshOne raises a warning Notification on going "behind", refreshes it in place rather than duplicating while it stays that way, resolves it once back in sync, and survives a poller restart', async () => {
  const project = await service.createProject({ name: 'Sync Transition', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const freshPoller = poller.createGitSyncPoller();

  // First tick: still synced — nothing to notify about.
  await freshPoller.refreshOne(project);
  assert.equal(freshPoller.get(project.id)?.status, 'synced');
  assert.deepEqual(await notificationService.listNotifications({ projectId: project.id }), []);

  // Someone else pushes to origin/main without this checkout knowing.
  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'v2 from the transition test');
  await git(seed, ['commit', '-am', "someone else's change"]);
  await git(seed, ['push', 'origin', 'main']);

  // Second tick: goes "behind" — exactly one Notification.
  await freshPoller.refreshOne(project);
  assert.equal(freshPoller.get(project.id)?.status, 'behind');
  const afterFirstBehindTick = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(afterFirstBehindTick.length, 1);
  assert.equal(afterFirstBehindTick[0]?.severity, 'warning');
  assert.equal(afterFirstBehindTick[0]?.kind, 'git.out_of_sync');
  assert.equal(afterFirstBehindTick[0]?.projectId, project.id);
  const firstNotificationId = afterFirstBehindTick[0]?.id;

  // Third tick: still "behind" by the same count — must not raise a second Notification.
  await freshPoller.refreshOne(project);
  assert.equal(freshPoller.get(project.id)?.status, 'behind');
  const afterSecondBehindTick = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(afterSecondBehindTick.length, 1, 'staying behind across ticks must not spam a Notification every poll');
  assert.equal(afterSecondBehindTick[0]?.id, firstNotificationId, 'the same Notification is kept, not replaced with a new record');

  // A regression check: an entirely new poller instance (an empty in-memory `states` Map, exactly
  // what a daemon restart — e.g. `npm run dev`'s `node --watch` reacting to a file save — produces)
  // must still recognize the already-open Notification and not duplicate it, since the dedup check
  // has to be against the persisted Notification, never the poller's own ephemeral memory.
  const restartedPoller = poller.createGitSyncPoller();
  await restartedPoller.refreshOne(project);
  const afterRestart = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(afterRestart.length, 1, 'a fresh poller instance (simulating a process restart) must not duplicate an already-open Notification');
  assert.equal(afterRestart[0]?.id, firstNotificationId);

  // Someone pushes again — now behind by 2, not 1. The existing open Notification is refreshed in
  // place with the new count rather than a second one being opened.
  await writeFile(path.join(seed, 'README.md'), 'v3 from the transition test');
  await git(seed, ['commit', '-am', 'a second unrelated change']);
  await git(seed, ['push', 'origin', 'main']);
  await restartedPoller.refreshOne(project);
  const afterSecondPush = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(afterSecondPush.length, 1);
  assert.equal(afterSecondPush[0]?.id, firstNotificationId);
  assert.match(afterSecondPush[0]?.description ?? '', /2 commit\(s\) behind/);

  // Catching back up (a real fetch/merge, not the notification-only test path) resolves the open
  // Notification automatically — the condition that raised it no longer holds.
  const cwd = service.projectAbsolutePath(project);
  await git(cwd, ['fetch', 'origin']);
  await git(cwd, ['merge', '--ff-only', 'origin/main']);
  await restartedPoller.refreshOne(project);
  assert.equal(restartedPoller.get(project.id)?.status, 'synced');
  const afterCatchUp = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(afterCatchUp.length, 1);
  assert.ok(afterCatchUp[0]?.resolvedAt);

  await git(seed, ['reset', '--hard', 'HEAD~2']);
  await git(seed, ['push', '--force', 'origin', 'main']);
});

test('two different Projects out of sync at once get two independent Notifications, each resolved independently', async () => {
  const projectA = await service.createProject({ name: 'Sync Two A', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const projectB = await service.createProject({ name: 'Sync Two B', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const freshPoller = poller.createGitSyncPoller();

  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'v-two-projects');
  await git(seed, ['commit', '-am', 'a change both checkouts are behind on']);
  await git(seed, ['push', 'origin', 'main']);

  await freshPoller.refreshOne(projectA);
  await freshPoller.refreshOne(projectB);

  const notifA = (await notificationService.listNotifications({ projectId: projectA.id, resolved: false }))[0];
  const notifB = (await notificationService.listNotifications({ projectId: projectB.id, resolved: false }))[0];
  assert.ok(notifA);
  assert.ok(notifB);
  assert.notEqual(notifA!.id, notifB!.id);

  const cwdA = service.projectAbsolutePath(projectA);
  await git(cwdA, ['fetch', 'origin']);
  await git(cwdA, ['merge', '--ff-only', 'origin/main']);
  await freshPoller.refreshOne(projectA);
  await freshPoller.refreshOne(projectB);

  assert.ok((await notificationService.getNotification(notifA!.id)).resolvedAt, "A's Notification resolves once it catches up");
  assert.equal((await notificationService.getNotification(notifB!.id)).resolvedAt, null, "B's Notification stays open independently");

  await git(seed, ['reset', '--hard', 'HEAD~1']);
  await git(seed, ['push', '--force', 'origin', 'main']);
});

test('startGitSyncPolling refreshes immediately and again on each interval, and its disposer stops further ticks', async () => {
  let refreshCount = 0;
  const fakePoller = { refreshAll: async () => { refreshCount += 1; } } as unknown as import('../src/projects/gitSyncPoller.ts').GitSyncPoller;

  const stop = poller.startGitSyncPolling(fakePoller, 10);
  await waitUntil(() => refreshCount >= 1);
  await waitUntil(() => refreshCount >= 3, 2000);
  stop();
  const countAtStop = refreshCount;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(refreshCount, countAtStop, 'no further ticks fire after the disposer runs');
});

test('runProjectSync fetches and fast-forwards a behind branch up to its remote, tracked as a real CommandRun', async () => {
  const project = await service.createProject({ name: 'Sync I', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  const runner = commands.createCommandRunner();

  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'pulled from elsewhere');
  await git(seed, ['commit', '-am', 'someone else\'s change']);
  await git(seed, ['push', 'origin', 'main']);

  const started = await runner.runProjectSync(project.id);
  assert.equal(started.status, 'running');
  assert.equal(started.projectId, project.id);
  assert.match(started.commandText, /git fetch origin && git merge --ff-only origin\/main/);

  const settled = await waitForSettled(runner, started.id);
  assert.equal(settled.status, 'success');
  assert.equal(settled.exitCode, 0);
  assert.equal(await git(cwd, ['show', 'HEAD:README.md']), 'pulled from elsewhere');

  // Not a persisted ProjectCommandRecord (so it can't clutter Settings → Commands' own list), but
  // it's still a real run — it does show up in that Project's Command Run History like any other.
  assert.ok((await runner.listCommandRuns(project.id)).some((r) => r.id === settled.id));

  // The poller's cache is refreshed the moment the run settles (fire-and-forget, so may lag the
  // settle event itself by one more git call) rather than waiting for its next scheduled tick.
  await waitUntil(() => poller.gitSyncPoller.get(project.id)?.status === 'synced');

  await git(seed, ['reset', '--hard', 'HEAD~1']);
  await git(seed, ['push', '--force', 'origin', 'main']);
});

test('runProjectSync on an already-synced branch settles success as a harmless no-op', async () => {
  const project = await service.createProject({ name: 'Sync J', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const runner = commands.createCommandRunner();
  const started = await runner.runProjectSync(project.id);
  const settled = await waitForSettled(runner, started.id);
  assert.equal(settled.status, 'success');
});

test('runProjectSync surfaces a diverged branch as a failed CommandRun (real git output, not a thrown error), leaving local work untouched', async () => {
  const project = await service.createProject({ name: 'Sync K', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  const runner = commands.createCommandRunner();
  await writeFile(path.join(cwd, 'local-only.txt'), 'my own unpushed work');
  await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'local work']);

  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'someone else\'s work');
  await git(seed, ['commit', '-am', 'remote work']);
  await git(seed, ['push', 'origin', 'main']);

  const started = await runner.runProjectSync(project.id);
  const settled = await waitForSettled(runner, started.id);
  assert.equal(settled.status, 'failed');
  assert.notEqual(settled.exitCode, 0);
  assert.equal(await git(cwd, ['show', 'HEAD:local-only.txt']), 'my own unpushed work', 'the failed fast-forward must not touch the local commit');

  await git(seed, ['reset', '--hard', 'HEAD~1']);
  await git(seed, ['push', '--force', 'origin', 'main']);
});

test('runProjectSync surfaces a branch with nothing pushed as a failed CommandRun, without raising a duplicate command.failed Notification (git.out_of_sync already covers it)', async () => {
  const project = await service.createProject({ name: 'Sync N', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await service.checkoutProjectBranch(project.id, 'never-pushed-either', true);
  const runner = commands.createCommandRunner();

  const started = await runner.runProjectSync(project.id);
  const settled = await waitForSettled(runner, started.id);
  assert.equal(settled.status, 'failed');
  assert.deepEqual((await notificationService.listNotifications({ projectId: project.id })).filter((n) => n.kind === 'command.failed'), []);
});

test('runProjectSync refuses a second concurrent sync on the same Project (same guard as any real command)', async () => {
  const project = await service.createProject({ name: 'Sync S', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const runner = commands.createCommandRunner();

  const first = await runner.runProjectSync(project.id);
  await assert.rejects(() => runner.runProjectSync(project.id), commands.CommandAlreadyRunningError);
  await waitForSettled(runner, first.id);
});

test('I16: runProjectSync is never blocked by a stale activeTaskId that is not a real, live Task', async () => {
  const project = await service.createProject({ name: 'Sync M', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await service.patchProject(project.id, { activeTaskId: 'running' });
  const runner = commands.createCommandRunner();

  const started = await runner.runProjectSync(project.id);
  await waitForSettled(runner, started.id);
});

test('runProjectSync refuses a Project with no linked repository', async () => {
  const project = await service.createProject({ name: 'Sync O (no repo)', position: null });
  const runner = commands.createCommandRunner();

  await assert.rejects(() => runner.runProjectSync(project.id), /no linked repository/);
});

test('GET /api/projects/:id carries sync: null until the poller has checked, and the list route does too', async () => {
  const project = await service.createProject({ name: 'Sync P', position: null, repositoryUrl: 'https://github.com/test/repo' });

  const { body } = await api(`/api/projects/${project.id}`);
  assert.equal(body.sync, null);

  const list = await api('/api/projects');
  assert.equal(list.body.find((p: { id: string }) => p.id === project.id).sync, null);
});

test('POST /api/projects/:id/sync (the sync icon\'s click action) starts a real CommandRun, and the fresh reading is visible on GET once it settles', async () => {
  const project = await service.createProject({ name: 'Sync Q', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);

  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'pushed via the sync icon test');
  await git(seed, ['commit', '-am', 'someone else\'s change']);
  await git(seed, ['push', 'origin', 'main']);

  const started = await api(`/api/projects/${project.id}/sync`, { method: 'POST' });
  assert.equal(started.status, 201);
  assert.equal(started.body.status, 'running');

  await waitUntil(async () => (await api(`/api/command-runs/${started.body.id}`)).body.status !== 'running');
  const settled = await api(`/api/command-runs/${started.body.id}`);
  assert.equal(settled.body.status, 'success');
  assert.equal(await git(cwd, ['show', 'HEAD:README.md']), 'pushed via the sync icon test');

  await waitUntil(async () => (await api(`/api/projects/${project.id}`)).body.sync?.status === 'synced');

  await git(seed, ['reset', '--hard', 'HEAD~1']);
  await git(seed, ['push', '--force', 'origin', 'main']);
});

test('I16: POST /api/projects/:id/sync is never blocked by a stale activeTaskId that is not a real, live Task', async () => {
  const project = await service.createProject({ name: 'Sync R', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await service.patchProject(project.id, { activeTaskId: 'running' });

  const { status, body } = await api(`/api/projects/${project.id}/sync`, { method: 'POST' });
  assert.equal(status, 201);
  assert.equal(body.status, 'running');
});

function zeroTokenUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };
}

/** A minimal, directly-inserted TaskRecord — see .docs/testing.md's "API tests never start a real Task": `runtimeStatus: 'starting'` makes `isLiveTask` treat it as really running without a registered CLI session. */
function fakeTask(overrides: Partial<TaskRecord> & { id: string; projectId: string }): TaskRecord {
  const now = new Date().toISOString();
  return {
    templateId: 'builder', executorId: 'test-claude-cli', description: 'Task', autonomy: 'auto', manager: false,
    kind: 'execute', status: 'developing', runtimeStatus: 'starting', planItemId: null, sessionId: null,
    blockedQuestion: null, failureReason: null, tokenUsage: zeroTokenUsage(), createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

function fakeRun(overrides: Partial<WorkflowRunRecord> & { id: string; projectId: string }): WorkflowRunRecord {
  const now = new Date().toISOString();
  return {
    planItemId: 'some-item', workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'x', description: 'x', enabled: true, steps: [] },
    status: 'running', currentStepId: null, executorId: 'test-claude-cli',
    prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0,
    createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

test('I9: runProjectSync succeeds with only planning session(s) active, running, waiting for an answer, or idle', async () => {
  for (const status of ['developing', 'blocked'] as const) {
    const project = await service.createProject({ name: `Sync Plan ${status}`, position: null, repositoryUrl: 'https://github.com/test/repo' });
    const task = await collections.tasksDb.insert(fakeTask({ id: `sync-plan-${status}`, projectId: project.id, kind: 'plan', status }));
    await service.patchProject(project.id, { activeTaskIds: [task.id] });
    const runner = commands.createCommandRunner();
    const started = await runner.runProjectSync(project.id);
    await waitForSettled(runner, started.id);
  }
  // Idle: the planning session has settled and is no longer in the active set.
  const idleProject = await service.createProject({ name: 'Sync Plan idle', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await collections.tasksDb.insert(fakeTask({ id: 'sync-plan-idle', projectId: idleProject.id, kind: 'plan', status: 'done', runtimeStatus: undefined }));
  const idleRunner = commands.createCommandRunner();
  const idleStarted = await idleRunner.runProjectSync(idleProject.id);
  await waitForSettled(idleRunner, idleStarted.id);
});

test('I10: runProjectSync succeeds with only worktree-isolated Tasks/WorkflowRuns active', async () => {
  const taskProject = await service.createProject({ name: 'Sync Worktree Task', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const worktreeTask = await collections.tasksDb.insert(fakeTask({ id: 'sync-worktree-task', projectId: taskProject.id, worktreePath: '/tmp/sync-wt-task' }));
  await service.patchProject(taskProject.id, { activeTaskIds: [worktreeTask.id] });
  const taskRunner = commands.createCommandRunner();
  const taskStarted = await taskRunner.runProjectSync(taskProject.id);
  await waitForSettled(taskRunner, taskStarted.id);

  const runProject = await service.createProject({ name: 'Sync Worktree Run', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await collections.workflowRunsDb.insert(fakeRun({ id: 'sync-worktree-run', projectId: runProject.id, status: 'awaiting-approval', worktreePath: '/tmp/sync-wt-run' }));
  const runRunner = commands.createCommandRunner();
  const runStarted = await runRunner.runProjectSync(runProject.id);
  await waitForSettled(runRunner, runStarted.id);
});

test('I11: runProjectSync is refused with a coding Task in the project folder, regardless of start order relative to a planning session', async () => {
  const { ProjectFolderBusyError } = await import('../src/worker/projectFolderGuard.ts');

  const before_ = await service.createProject({ name: 'Sync Folder Then Plan', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const folderFirst = await collections.tasksDb.insert(fakeTask({ id: 'sync-order-folder-first', projectId: before_.id }));
  const planAfter = await collections.tasksDb.insert(fakeTask({ id: 'sync-order-plan-after', projectId: before_.id, kind: 'plan' }));
  await service.patchProject(before_.id, { activeTaskIds: [folderFirst.id, planAfter.id] });
  await assert.rejects(() => commands.createCommandRunner().runProjectSync(before_.id), ProjectFolderBusyError);

  const after_ = await service.createProject({ name: 'Sync Plan Then Folder', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const planFirst = await collections.tasksDb.insert(fakeTask({ id: 'sync-order-plan-first', projectId: after_.id, kind: 'plan' }));
  const folderAfter = await collections.tasksDb.insert(fakeTask({ id: 'sync-order-folder-after', projectId: after_.id }));
  await service.patchProject(after_.id, { activeTaskIds: [planFirst.id, folderAfter.id] });
  await assert.rejects(() => commands.createCommandRunner().runProjectSync(after_.id), ProjectFolderBusyError);
});

test('I12: runProjectSync is refused with an in-place WorkflowRun awaiting approval between steps', async () => {
  const project = await service.createProject({ name: 'Sync In-place Awaiting', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await collections.workflowRunsDb.insert(fakeRun({ id: 'sync-in-place-awaiting', projectId: project.id, status: 'awaiting-approval' }));
  const { ProjectFolderBusyError } = await import('../src/worker/projectFolderGuard.ts');
  await assert.rejects(() => commands.createCommandRunner().runProjectSync(project.id), ProjectFolderBusyError);
});

test('I17: creating a branch is still allowed while a coding Task runs in the project folder', async () => {
  const project = await service.createProject({ name: 'Branch Create During Folder Work', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const folderTask = await collections.tasksDb.insert(fakeTask({ id: 'branch-create-folder-task', projectId: project.id }));
  await service.patchProject(project.id, { activeTaskIds: [folderTask.id] });

  const { status, body } = await api(`/api/projects/${project.id}/branches`, { method: 'POST', body: JSON.stringify({ branch: 'carried-over', create: true }) });
  assert.equal(status, 200);
  assert.equal(body.current, 'carried-over');
});

test('I18: both the branch-switch and sync routes 409 with a message naming work in the project folder, while a coding Task runs there', async () => {
  const project = await service.createProject({ name: 'HTTP Folder Busy', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const folderTask = await collections.tasksDb.insert(fakeTask({ id: 'http-folder-busy-task', projectId: project.id }));
  await service.patchProject(project.id, { activeTaskIds: [folderTask.id] });

  const branchRes = await api(`/api/projects/${project.id}/branches`, { method: 'POST', body: JSON.stringify({ branch: 'main' }) });
  assert.equal(branchRes.status, 409);
  assert.match(branchRes.body.error, /folder/);

  const syncRes = await api(`/api/projects/${project.id}/sync`, { method: 'POST' });
  assert.equal(syncRes.status, 409);
  assert.match(syncRes.body.error, /folder/);
});

test('I19: both the branch-switch and sync routes succeed while only a planning session is active', async () => {
  const project = await service.createProject({ name: 'HTTP Plan Only', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const planTask = await collections.tasksDb.insert(fakeTask({ id: 'http-plan-only-task', projectId: project.id, kind: 'plan' }));
  await service.patchProject(project.id, { activeTaskIds: [planTask.id] });

  const branchRes = await api(`/api/projects/${project.id}/branches`, { method: 'POST', body: JSON.stringify({ branch: 'main' }) });
  assert.equal(branchRes.status, 200);

  const syncRes = await api(`/api/projects/${project.id}/sync`, { method: 'POST' });
  assert.equal(syncRes.status, 201);
  await waitUntil(async () => (await api(`/api/command-runs/${syncRes.body.id}`)).body.status !== 'running');
});

/** Polls a CommandRun until it leaves 'running' — real subprocesses settle asynchronously. */
async function waitForSettled(runner: ReturnType<typeof commands.createCommandRunner>, runId: string): Promise<CommandRunRecord> {
  let run = await runner.getCommandRun(runId);
  await waitUntil(async () => {
    run = await runner.getCommandRun(runId);
    return run.status !== 'running';
  });
  return run;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
