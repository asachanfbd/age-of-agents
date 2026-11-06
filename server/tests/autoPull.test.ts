import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { before, after, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import type { AutoPullDeps } from '../src/projects/autoPull.ts';
import type { ProjectRecord, TaskRecord, WorkflowRunRecord } from '../src/domain/types.ts';

let root: string;
let service: typeof import('../src/projects/projectService.ts');
let gitLib: typeof import('../src/projects/git.ts');
let pollerLib: typeof import('../src/projects/gitSyncPoller.ts');
let autoPull: typeof import('../src/projects/autoPull.ts');
let commands: typeof import('../src/commands/commandRunner.ts');
let guard: typeof import('../src/worker/projectFolderGuard.ts');
let notifications: typeof import('../src/notifications/notificationService.ts');
let collections: typeof import('../src/db/collections.ts');
let httpServer: HttpServer;
let baseUrl: string;
let remoteCount = 0;

const NO_SESSIONS = { has: () => false };
const CLOCK = () => new Date('2030-01-02T03:04:05.000Z');

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'auto-pull-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.GIT_CONFIG_COUNT = '3';
  process.env.GIT_CONFIG_KEY_0 = `url.${root}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test/';
  process.env.GIT_CONFIG_KEY_1 = 'user.name'; process.env.GIT_CONFIG_VALUE_1 = 'Test';
  process.env.GIT_CONFIG_KEY_2 = 'user.email'; process.env.GIT_CONFIG_VALUE_2 = 'test@example.com';
  service = await import('../src/projects/projectService.ts');
  gitLib = await import('../src/projects/git.ts');
  pollerLib = await import('../src/projects/gitSyncPoller.ts');
  autoPull = await import('../src/projects/autoPull.ts');
  commands = await import('../src/commands/commandRunner.ts');
  guard = await import('../src/worker/projectFolderGuard.ts');
  notifications = await import('../src/notifications/notificationService.ts');
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

/** A Project cloned from its own local bare remote, plus a second clone that stands in for another machine. */
async function setup(name: string) {
  const id = `r${remoteCount++}`;
  await git(root, ['init', '--bare', '--initial-branch=main', id]);
  const other = path.join(root, `other-${id}`);
  await git(root, ['clone', path.join(root, id), other]);
  await writeFile(path.join(other, 'README.md'), 'v1');
  await git(other, ['add', '.']); await git(other, ['commit', '-m', 'initial']); await git(other, ['push', 'origin', 'main']);
  const project = await service.createProject({ name, position: null, repositoryUrl: `https://github.com/test/${id}` });
  const cwd = service.projectAbsolutePath(project);
  let commits = 0;
  return {
    project, cwd, other,
    async pushRemote(file = 'README.md', content = `remote ${++commits}`): Promise<void> {
      await writeFile(path.join(other, file), content);
      await git(other, ['add', '.']); await git(other, ['commit', '-m', `remote ${file}`]); await git(other, ['push', 'origin', 'main']);
    },
    async commitLocal(file = 'local.txt'): Promise<void> {
      await writeFile(path.join(cwd, file), 'local'); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'local work']);
    },
    fresh: () => service.getProject(project.id),
  };
}

function harness(overrides: Partial<AutoPullDeps> = {}) {
  const runner = commands.createCommandRunner();
  const puller = autoPull.createAutoPuller({
    isFolderBusy: (project) => guard.isProjectFolderBusy(project, NO_SESSIONS),
    runPull: (project, branch) => runner.runAutoPull(project, branch),
    now: CLOCK,
    ...overrides,
  });
  const poller = pollerLib.createGitSyncPoller();
  poller.setAutoPuller(puller);
  return { runner, puller, poller };
}

function zeroTokenUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };
}

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

const NO_BLOCKING = { files: [], total: 0, fallbackReason: null };
const overlap = (...paths: string[]) => ({ files: paths.map((p) => ({ path: p, kind: 'modified' as const })), total: paths.length, fallbackReason: null });

const blockers = (overrides: Partial<import('../src/projects/autoPull.ts').AutoPullBlockers> = {}) =>
  ({ disabled: false, detachedHead: false, operation: null, folderBusy: false, blockingChanges: NO_BLOCKING, ...overrides });

// ---- decideAutoPull: the pure decision ----

test('decideAutoPull pulls only a behind branch with nothing in the way', () => {
  assert.deepEqual(autoPull.decideAutoPull('behind', blockers()), { action: 'pull' });
  for (const status of ['ahead', 'synced', 'no-remote', 'unknown'] as const) {
    assert.deepEqual(autoPull.decideAutoPull(status, blockers()), { action: 'defer', reason: null }, status);
  }
});

test('decideAutoPull explains each blocker in plain words', () => {
  const reason = (status: 'behind' | 'diverged', b = {}) => (autoPull.decideAutoPull(status, blockers(b)) as { reason: string }).reason;
  assert.equal(reason('diverged'), 'not pulled: your branch has diverged from origin');
  assert.equal(reason('behind', { disabled: true }), 'auto-pull is off for this project');
  assert.equal(reason('behind', { folderBusy: true }), 'not pulled: a task is running in the main folder');
  assert.equal(reason('behind', { blockingChanges: overlap('a.json') }), 'not pulled: you have uncommitted changes to files the update also changes: a.json');
  assert.equal(reason('behind', { detachedHead: true }), 'not pulled: no branch is checked out');
  assert.equal(reason('behind', { operation: 'merge' }), 'not pulled: a merge is in progress');
  assert.equal(reason('behind', { operation: 'rebase' }), 'not pulled: a rebase is in progress');
  assert.equal(reason('behind', { operation: 'cherry-pick' }), 'not pulled: a cherry-pick is in progress');
  assert.equal(reason('behind', { operation: 'revert' }), 'not pulled: a revert is in progress');
});

test('decideAutoPull reports one reason in a fixed priority order when several blockers apply', () => {
  const all = blockers({ disabled: true, detachedHead: true, operation: 'merge', folderBusy: true, blockingChanges: overlap('a') });
  assert.equal((autoPull.decideAutoPull('behind', all) as { reason: string }).reason, 'auto-pull is off for this project');
  assert.equal((autoPull.decideAutoPull('behind', { ...all, disabled: false }) as { reason: string }).reason, 'not pulled: no branch is checked out');
  assert.equal((autoPull.decideAutoPull('behind', { ...all, disabled: false, detachedHead: false }) as { reason: string }).reason, 'not pulled: a merge is in progress');
  assert.equal((autoPull.decideAutoPull('behind', { ...all, disabled: false, detachedHead: false, operation: null }) as { reason: string }).reason, 'not pulled: a task is running in the main folder');
});

test('the setting reads as on when absent (a record written before it existed)', () => {
  assert.equal(autoPull.isAutoPullEnabled({}), true);
  assert.equal(autoPull.isAutoPullEnabled({ autoPullEnabled: true }), true);
  assert.equal(autoPull.isAutoPullEnabled({ autoPullEnabled: false }), false);
});

// ---- git probes against real repositories ----

test('detectGitOperationInProgress finds each unfinished operation and clears when it is gone', async () => {
  const s = await setup('Probe Operation');
  assert.equal(await gitLib.detectGitOperationInProgress(s.cwd), null);
  const gitDir = await git(s.cwd, ['rev-parse', '--absolute-git-dir']);
  const markers: [string, string][] = [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase']];
  for (const [marker, operation] of markers) {
    const target = path.join(gitDir, marker);
    if (marker.startsWith('rebase')) await mkdir(target); else await writeFile(target, 'x');
    assert.equal(await gitLib.detectGitOperationInProgress(s.cwd), operation, marker);
    await rm(target, { recursive: true });
  }
  assert.equal(await gitLib.detectGitOperationInProgress(s.cwd), null);
});

test('the project lock: a pull claim excludes lock holders and makes a lock request wait instead of fail', async () => {
  const id = 'lock-test';
  const release = gitLib.claimProjectPull(id);
  assert.ok(release);
  assert.equal(gitLib.claimProjectPull(id), null, 'one pull per Project');
  let entered = false;
  const waiting = gitLib.withProjectLock(id, async () => { entered = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, false, 'a task start waits for the pull');
  release();
  await waiting;
  assert.equal(entered, true);

  let heldRelease!: () => void;
  const held = gitLib.withProjectLock(id, () => new Promise<void>((resolve) => { heldRelease = resolve; }));
  assert.equal(gitLib.claimProjectPull(id), null, 'a pull never starts while a task start or stop holds the lock');
  heldRelease();
  await held;
  gitLib.claimProjectPull(id)!();
});

// ---- the whole flow: poller + auto-puller + real git ----

test('a behind branch with a clean tree and a free folder is fast-forwarded by the next refresh, as an automatic run, with no notification', async () => {
  const s = await setup('Pull Happy');
  const { poller, runner } = harness();
  await s.pushRemote(); await s.pushRemote('b.txt', 'b');
  const remoteSha = await git(s.other, ['rev-parse', 'HEAD']);

  await poller.refreshOne(await s.fresh());

  assert.equal(await git(s.cwd, ['rev-parse', 'HEAD']), remoteSha);
  assert.equal((await git(s.cwd, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ').length, 2, 'a fast-forward, not a merge commit');
  const sync = poller.get(s.project.id)!;
  assert.equal(sync.status, 'synced');
  assert.deepEqual(sync.lastAutoPull, { commits: 2, at: '2030-01-02T03:04:05.000Z' });
  assert.equal(sync.deferredReason, undefined);

  const [run] = await runner.listCommandRuns(s.project.id);
  assert.equal(run!.automatic, true);
  assert.equal(run!.origin, 'sync');
  assert.equal(run!.status, 'success');
  assert.match(run!.commandText, /^git fetch origin && git merge --ff-only origin\/main$/);
  assert.match(run!.output, /Fast-forward|Updating/);
  const open = (await notifications.listNotifications({ resolved: false, projectId: s.project.id }));
  assert.deepEqual(open, [], 'no out-of-sync or success notification remains');

  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.lastAutoPull?.commits, 2, 'the tooltip data stays while the branch stays in sync');
});

test('a manual sync is not marked automatic', async () => {
  const s = await setup('Pull Manual');
  const runner = commands.createCommandRunner();
  await s.pushRemote();
  const started = await runner.runProjectSync(s.project.id);
  await new Promise<void>((resolve) => { const off = runner.onCommandEvent((e) => { if (e.type === 'commandRun' && e.run.id === started.id && e.run.status !== 'running') { off(); resolve(); } }); });
  assert.equal((await runner.getCommandRun(started.id)).automatic, undefined);
});

test('ahead, synced and diverged branches are never pulled; diverged says why and leaves local history alone', async () => {
  const s = await setup('Pull Not Behind');
  const { poller, runner } = harness();
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
  await s.commitLocal();
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'ahead');
  const local = await git(s.cwd, ['rev-parse', 'HEAD']);
  await s.pushRemote();
  await poller.refreshOne(await s.fresh());
  const sync = poller.get(s.project.id)!;
  assert.equal(sync.status, 'diverged');
  assert.equal(sync.deferredReason, 'not pulled: your branch has diverged from origin');
  assert.equal(await git(s.cwd, ['rev-parse', 'HEAD']), local);
  assert.deepEqual(await runner.listCommandRuns(s.project.id), []);
  const [note] = await notifications.listNotifications({ resolved: false, projectId: s.project.id });
  assert.match(note!.description, /Not pulled: your branch has diverged from origin\./);
});

test('uncommitted tracked changes defer the pull with a reason; once clean the next evaluation pulls', async () => {
  const s = await setup('Pull Dirty');
  const { poller } = harness();
  await s.pushRemote('README.md', 'remote edit');
  await writeFile(path.join(s.cwd, 'README.md'), 'my edit');
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'behind');
  assert.equal(poller.get(s.project.id)!.deferredReason, 'not pulled: you have uncommitted changes to files the update also changes: README.md');
  assert.deepEqual(poller.get(s.project.id)!.blockingFiles, [{ path: 'README.md', kind: 'modified' }]);
  const [note] = await notifications.listNotifications({ resolved: false, projectId: s.project.id });
  assert.match(note!.description, /Not pulled: you have uncommitted changes to files the update also changes: README\.md\./);

  await git(s.cwd, ['checkout', '--', 'README.md']);
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
  assert.equal(await readFile(path.join(s.cwd, 'README.md'), 'utf-8'), 'remote edit');
  assert.deepEqual(await notifications.listNotifications({ resolved: false, projectId: s.project.id }), []);
});

test('an untracked file that does not collide survives the pull', async () => {
  const s = await setup('Pull Untracked Ok');
  const { poller } = harness();
  await writeFile(path.join(s.cwd, 'scratch.txt'), 'mine');
  await s.pushRemote('new.txt', 'n');
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
  assert.equal(await readFile(path.join(s.cwd, 'scratch.txt'), 'utf-8'), 'mine');
});

test('race: an untracked file appears after the overlap check, so git refuses: failure names the file, notified once, file kept, no retry until the remote moves', async () => {
  const s = await setup('Pull Collision');
  let pulls = 0;
  const runner = commands.createCommandRunner();
  const { poller } = harness({ runPull: (p, b) => { pulls++; return runner.runAutoPull(p, b); }, incomingPaths: async () => ['unrelated.txt'] });
  await writeFile(path.join(s.cwd, 'clash.txt'), 'local untracked');
  await s.pushRemote('clash.txt', 'from remote');

  await poller.refreshOne(await s.fresh());
  assert.equal(pulls, 1);
  assert.equal(await readFile(path.join(s.cwd, 'clash.txt'), 'utf-8'), 'local untracked');
  assert.equal(poller.get(s.project.id)!.status, 'behind');
  assert.match(poller.get(s.project.id)!.deferredReason!, /^not pulled: .*clash\.txt/);
  const failures = (await notifications.listNotifications({ resolved: false, projectId: s.project.id })).filter((n) => n.kind === 'git.auto_pull_failed');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.description, /clash\.txt|overwritten/);

  await poller.refreshOne(await s.fresh());
  await poller.refreshOne(await s.fresh());
  assert.equal(pulls, 1, 'no retry every minute for the same failure');
  assert.match(poller.get(s.project.id)!.deferredReason!, /the last automatic pull failed/);

  await s.pushRemote('another.txt', 'a');
  await poller.refreshOne(await s.fresh());
  assert.equal(pulls, 2, 'the remote moved: retry');
  const again = (await notifications.listNotifications({ resolved: false, projectId: s.project.id })).filter((n) => n.kind === 'git.auto_pull_failed');
  assert.equal(again.length, 1, 'an unchanged reason is not notified again');
  assert.equal(again[0]!.readAt, failures[0]!.readAt);

  await rm(path.join(s.cwd, 'clash.txt'));
  await s.pushRemote('third.txt', 't');
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
  assert.deepEqual(await notifications.listNotifications({ resolved: false, projectId: s.project.id }), [], 'success resolves the failure notification');
});

test('a manual sync (the icon) still works after a failed automatic pull', async () => {
  const s = await setup('Pull Failure Then Manual');
  const { poller, runner } = harness({ incomingPaths: async () => [] });
  await writeFile(path.join(s.cwd, 'clash.txt'), 'local');
  await s.pushRemote('clash.txt', 'remote');
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'behind');
  await rm(path.join(s.cwd, 'clash.txt'));
  const started = await runner.runProjectSync(s.project.id);
  await new Promise<void>((resolve) => { const off = runner.onCommandEvent((e) => { if (e.type === 'commandRun' && e.run.id === started.id && e.run.status !== 'running') { off(); resolve(); } }); });
  assert.equal((await runner.getCommandRun(started.id)).status, 'success');
});

test('each unfinished git operation defers the pull and it happens once the operation is cleared', async () => {
  const s = await setup('Pull Operation');
  const { poller } = harness();
  await s.pushRemote();
  const gitDir = await git(s.cwd, ['rev-parse', '--absolute-git-dir']);
  for (const [marker, word] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
    await writeFile(path.join(gitDir, marker), 'x');
    await poller.refreshOne(await s.fresh());
    assert.equal(poller.get(s.project.id)!.deferredReason, `not pulled: a ${word} is in progress`);
    await rm(path.join(gitDir, marker));
  }
  await mkdir(path.join(gitDir, 'rebase-merge'));
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.deferredReason, 'not pulled: a rebase is in progress');
  await rm(path.join(gitDir, 'rebase-merge'), { recursive: true });
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
});

test('a detached HEAD is never pulled', async () => {
  const s = await setup('Pull Detached');
  const { poller, runner } = harness();
  await git(s.cwd, ['checkout', '--detach']);
  await s.pushRemote();
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'unknown');
  assert.deepEqual(await runner.listCommandRuns(s.project.id), []);
});

test('the stash, other branches and the checked-out branch are untouched by a pull', async () => {
  const s = await setup('Pull Untouched');
  const { poller } = harness();
  await git(s.cwd, ['branch', 'feature']);
  const feature = await git(s.cwd, ['rev-parse', 'feature']);
  await writeFile(path.join(s.cwd, 'README.md'), 'stash me');
  await git(s.cwd, ['stash', 'push', '-m', 'keep']);
  const stashBefore = await git(s.cwd, ['stash', 'list']);
  await s.pushRemote('x.txt', 'x');
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
  assert.equal(await git(s.cwd, ['stash', 'list']), stashBefore);
  assert.equal(await git(s.cwd, ['rev-parse', 'feature']), feature);
  assert.equal(await git(s.cwd, ['symbolic-ref', '--short', 'HEAD']), 'main');
});

test('a failing hook is reported as a failure with the hook output', async () => {
  const s = await setup('Pull Hook');
  const { poller } = harness();
  // A fast-forward only runs post-merge, whose exit status git ignores; a ref-transaction hook is what can really refuse the update.
  const hook = path.join(s.cwd, '.git', 'hooks', 'reference-transaction');
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\nif [ "$1" = prepared ] && grep -q refs/heads/main; then echo hook exploded >&2; exit 1; fi\n', { mode: 0o755 });
  await s.pushRemote();
  await poller.refreshOne(await s.fresh());
  const failure = (await notifications.listNotifications({ resolved: false, projectId: s.project.id })).find((n) => n.kind === 'git.auto_pull_failed');
  assert.match(failure!.description, /hook exploded/);
  assert.equal(poller.get(s.project.id)!.status, 'behind');
});

// ---- the folder guard: what blocks and what does not ----

test('an in-place task blocks the pull; when the folder is released the reevaluation pulls without waiting for the poll', async () => {
  const s = await setup('Pull Busy Task');
  const { poller } = harness({ isFolderBusy: (project) => guard.isProjectFolderBusy(project, NO_SESSIONS) });
  const task = await collections.tasksDb.insert(fakeTask({ id: 'ap-busy-task', projectId: s.project.id }));
  await service.patchProject(s.project.id, { activeTaskIds: [task.id] });
  await s.pushRemote();
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.deferredReason, 'not pulled: a task is running in the main folder');

  await poller.reevaluate(s.project.id);
  assert.equal(poller.get(s.project.id)!.status, 'behind', 'still busy');

  await collections.tasksDb.update(task.id, { status: 'done' });
  await poller.reevaluate(s.project.id);
  assert.equal(poller.get(s.project.id)!.status, 'synced');
});

test('an unsettled in-place workflow run (even awaiting approval) blocks; a run or task in its own worktree does not', async () => {
  const blocked = await setup('Pull Busy Run');
  const { poller } = harness();
  await collections.workflowRunsDb.insert(fakeRun({ id: 'ap-run-inplace', projectId: blocked.project.id, status: 'awaiting-approval' }));
  await blocked.pushRemote();
  await poller.refreshOne(await blocked.fresh());
  assert.equal(poller.get(blocked.project.id)!.deferredReason, 'not pulled: a task is running in the main folder');
  await collections.workflowRunsDb.update('ap-run-inplace', { status: 'completed' as WorkflowRunRecord['status'] });
  await poller.reevaluate(blocked.project.id);
  assert.equal(poller.get(blocked.project.id)!.status, 'synced');

  const free = await setup('Pull Worktree Task');
  const task = await collections.tasksDb.insert(fakeTask({ id: 'ap-wt-task', projectId: free.project.id, worktreePath: '/tmp/ap-wt' }));
  await service.patchProject(free.project.id, { activeTaskIds: [task.id] });
  await collections.workflowRunsDb.insert(fakeRun({ id: 'ap-run-wt', projectId: free.project.id, status: 'running', worktreePath: '/tmp/ap-wt-run' }));
  const plan = await collections.tasksDb.insert(fakeTask({ id: 'ap-plan', projectId: free.project.id, kind: 'plan' }));
  await service.patchProject(free.project.id, { activeTaskIds: [task.id, plan.id] });
  await free.pushRemote();
  await poller.refreshOne(await free.fresh());
  assert.equal(poller.get(free.project.id)!.status, 'synced', 'worktree work and planning sessions never block');
});

test('turning the setting off restores manual-only syncing and says so; turning it on pulls', async () => {
  const s = await setup('Pull Setting');
  const { poller, runner } = harness();
  await service.setProjectAutoPull(s.project.id, false);
  await s.pushRemote();
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.deferredReason, 'auto-pull is off for this project');
  assert.deepEqual(await runner.listCommandRuns(s.project.id), []);
  await service.setProjectAutoPull(s.project.id, true);
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
});

test('a Project without a repository is never evaluated', async () => {
  const project = await service.createProject({ name: 'Pull No Repo', position: null });
  const { poller } = harness();
  await poller.refreshOne(project);
  assert.equal(poller.get(project.id), null);
});

// ---- races, serialization and parallelism ----

test('a task start that holds the Project lock makes the pull wait out; the pull never starts after a claim', async () => {
  const s = await setup('Pull Race Lock');
  let pulls = 0;
  const runner = commands.createCommandRunner();
  const { poller } = harness({ runPull: (p, b) => { pulls++; return runner.runAutoPull(p, b); }, incomingPaths: async () => ['unrelated.txt'] });
  await s.pushRemote();
  let release!: () => void;
  const holding = gitLib.withProjectLock(s.project.id, () => new Promise<void>((resolve) => { release = resolve; }));
  await poller.refreshOne(await s.fresh());
  assert.equal(pulls, 0);
  assert.equal(poller.get(s.project.id)!.deferredReason, 'not pulled: another git action is running on this project');
  release();
  await holding;
  await poller.refreshOne(await s.fresh());
  assert.equal(pulls, 1);
});

test('a task starting while a pull runs waits for it and then proceeds', async () => {
  const s = await setup('Pull Race Start');
  let startPull!: () => void;
  const gate = new Promise<void>((resolve) => { startPull = resolve; });
  const runner = commands.createCommandRunner();
  const { poller } = harness({ runPull: async (p, b) => { await gate; return runner.runAutoPull(p, b); } });
  await s.pushRemote();
  const refreshing = poller.refreshOne(await s.fresh());
  while (!gitLib.isProjectLocked(s.project.id)) await new Promise((resolve) => setTimeout(resolve, 10));
  const order: string[] = [];
  const taskStart = gitLib.withProjectLock(s.project.id, async () => { order.push(`task start sees ${await git(s.cwd, ['rev-parse', 'HEAD'])}`); });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, [], 'waiting for the pull');
  startPull();
  await Promise.all([refreshing, taskStart]);
  assert.equal(order[0], `task start sees ${await git(s.other, ['rev-parse', 'HEAD'])}`);
});

test('pulls for different Projects overlap; pulls for one Project never do', async () => {
  const a = await setup('Pull Parallel A'); const b = await setup('Pull Parallel B');
  let running = 0; let peak = 0;
  const runner = commands.createCommandRunner();
  const { poller } = harness({ runPull: async (p, branch) => {
    running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 150));
    try { return await runner.runAutoPull(p, branch); } finally { running--; }
  } });
  await a.pushRemote(); await b.pushRemote();
  await Promise.all([poller.refreshOne(await a.fresh()), poller.refreshOne(await b.fresh())]);
  assert.equal(peak, 2, 'different Projects pulled in parallel');

  running = 0; peak = 0;
  await a.pushRemote();
  const aProject = await a.fresh();
  await Promise.all([poller.refreshOne(aProject), poller.refreshOne(aProject), poller.refreshOne(aProject)]);
  assert.equal(peak, 1, 'one Project is serialized');
});

// ---- API ----

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

test('PATCH /api/projects/:id/auto-pull sets the flag, GET reads it, an old record reads on, bad values are refused', async () => {
  const s = await setup('Api Setting');
  assert.equal((await api(`/api/projects/${s.project.id}`)).body.autoPullEnabled, true, 'absent reads as on');
  const off = await api(`/api/projects/${s.project.id}/auto-pull`, { method: 'PATCH', body: JSON.stringify({ autoPullEnabled: false }) });
  assert.equal(off.status, 200);
  assert.equal(off.body.autoPullEnabled, false);
  assert.equal((await api(`/api/projects/${s.project.id}`)).body.autoPullEnabled, false);
  assert.equal((await service.getProject(s.project.id)).autoPullEnabled, false, 'persisted');
  for (const value of [null, 'false', 0, undefined]) {
    const bad = await api(`/api/projects/${s.project.id}/auto-pull`, { method: 'PATCH', body: JSON.stringify({ autoPullEnabled: value }) });
    assert.equal(bad.status, 400, String(value));
  }
  const noRepo = await service.createProject({ name: 'Api No Repo', position: null });
  assert.equal((await api(`/api/projects/${noRepo.id}/auto-pull`, { method: 'PATCH', body: JSON.stringify({ autoPullEnabled: true }) })).status, 400);
  await api(`/api/projects/${s.project.id}/auto-pull`, { method: 'PATCH', body: JSON.stringify({ autoPullEnabled: true }) });
});

// ---- the overlap rule ----

test('unrelated dirty tracked and untracked files do not stop the pull and are left untouched', async () => {
  const s = await setup('Pull Unrelated Dirty');
  const { poller } = harness();
  await s.pushRemote('other.json', '{"remote":1}');
  await writeFile(path.join(s.cwd, 'README.md'), 'my edit');
  await writeFile(path.join(s.cwd, 'generated.json'), 'mine');
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
  assert.equal(poller.get(s.project.id)!.deferredReason, undefined);
  assert.equal(await readFile(path.join(s.cwd, 'other.json'), 'utf-8'), '{"remote":1}');
  assert.equal(await readFile(path.join(s.cwd, 'README.md'), 'utf-8'), 'my edit');
  assert.equal(await readFile(path.join(s.cwd, 'generated.json'), 'utf-8'), 'mine');
});

test('an untracked file the pull would add defers and is named, with no failure notification and no pull attempted', async () => {
  const s = await setup('Pull Untracked Add');
  let pulls = 0;
  const runner = commands.createCommandRunner();
  const { poller } = harness({ runPull: (p, b) => { pulls++; return runner.runAutoPull(p, b); } });
  await writeFile(path.join(s.cwd, 'clash.txt'), 'mine');
  await s.pushRemote('clash.txt', 'remote');
  await poller.refreshOne(await s.fresh());
  assert.equal(pulls, 0);
  const sync = poller.get(s.project.id)!;
  assert.equal(sync.deferredReason, 'not pulled: you have uncommitted changes to files the update also changes: clash.txt');
  assert.deepEqual(sync.blockingFiles, [{ path: 'clash.txt', kind: 'untracked' }]);
  assert.equal(sync.blockingFilesTotal, 1);
  assert.equal(await readFile(path.join(s.cwd, 'clash.txt'), 'utf-8'), 'mine');
  const failures = (await notifications.listNotifications({ resolved: false, projectId: s.project.id })).filter((n) => n.kind === 'git.auto_pull_failed');
  assert.deepEqual(failures, []);

  await rm(path.join(s.cwd, 'clash.txt'));
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced', 'once resolved, the next cycle pulls');
  assert.equal(poller.get(s.project.id)!.blockingFiles, undefined);
});

test('eight overlapping files are summarised as the first three and "5 more", with all eight counted', async () => {
  const s = await setup('Pull Many Overlaps');
  const { poller } = harness();
  const names = Array.from({ length: 8 }, (_, i) => `f${i}.json`);
  for (const n of names) await writeFile(path.join(s.cwd, n), 'mine');
  await git(s.cwd, ['add', '.']); await git(s.cwd, ['commit', '-m', 'files']); await git(s.cwd, ['push', 'origin', 'main']);
  await git(s.other, ['pull', '--quiet', 'origin', 'main']);
  for (const n of names) await s.pushRemote(n, 'remote');
  for (const n of names) await writeFile(path.join(s.cwd, n), 'edited');
  await poller.refreshOne(await s.fresh());
  const sync = poller.get(s.project.id)!;
  assert.equal(sync.deferredReason, 'not pulled: you have uncommitted changes to files the update also changes: f0.json, f1.json, f2.json and 5 more');
  assert.equal(sync.blockingFilesTotal, 8);
  assert.equal(sync.blockingFiles!.length, 8);
});

test('when the incoming paths cannot be read, a tracked change defers with the reason and a clean tree still pulls', async () => {
  const s = await setup('Pull Fallback');
  const { poller } = harness({ incomingPaths: async () => { throw new Error('diff failed'); } });
  await s.pushRemote('other.txt', 'o');
  await writeFile(path.join(s.cwd, 'README.md'), 'mine');
  await poller.refreshOne(await s.fresh());
  assert.match(poller.get(s.project.id)!.deferredReason!, /^not pulled: you have uncommitted changes to tracked files, and could not tell which files the update changes \(.*diff failed\)/);
  await git(s.cwd, ['checkout', '--', 'README.md']);
  await poller.refreshOne(await s.fresh());
  assert.equal(poller.get(s.project.id)!.status, 'synced');
});

test('a busy folder is reported before an overlap', async () => {
  const s = await setup('Pull Busy Before Overlap');
  const { poller } = harness({ isFolderBusy: async () => true });
  await s.pushRemote('README.md', 'remote');
  await writeFile(path.join(s.cwd, 'README.md'), 'mine');
  await poller.refreshOne(await s.fresh());
  const sync = poller.get(s.project.id)!;
  assert.equal(sync.deferredReason, 'not pulled: a task is running in the main folder');
  assert.equal(sync.blockingFiles, undefined);
});

test('race at the pull: an overlapping edit made after the check makes the run fail, naming the file, with one notification and nothing applied', async () => {
  const s = await setup('Pull Race');
  const runner = commands.createCommandRunner();
  const { poller } = harness({
    runPull: async (p, b) => { await writeFile(path.join(s.cwd, 'README.md'), 'late edit'); return runner.runAutoPull(p, b); },
  });
  await s.pushRemote('README.md', 'remote');
  const head = await git(s.cwd, ['rev-parse', 'HEAD']);
  await poller.refreshOne(await s.fresh());
  await poller.refreshOne(await s.fresh());
  assert.equal(await git(s.cwd, ['rev-parse', 'HEAD']), head);
  assert.equal(await readFile(path.join(s.cwd, 'README.md'), 'utf-8'), 'late edit');
  assert.match(poller.get(s.project.id)!.deferredReason!, /^not pulled: /);
  const failures = (await notifications.listNotifications({ resolved: false, projectId: s.project.id })).filter((n) => n.kind === 'git.auto_pull_failed');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.description, /README\.md/);
});

test('a manual sync succeeds with unrelated dirty files and git refuses it on an overlap, leaving the file alone', async () => {
  const s = await setup('Manual Sync Overlap');
  const { runner } = harness();
  const finish = async () => {
    const started = await runner.runProjectSync(s.project.id);
    await new Promise<void>((resolve) => { const off = runner.onCommandEvent((e) => { if (e.type === 'commandRun' && e.run.id === started.id && e.run.status !== 'running') { off(); resolve(); } }); });
    return runner.getCommandRun(started.id);
  };
  await s.pushRemote('other.txt', 'o');
  await writeFile(path.join(s.cwd, 'README.md'), 'mine');
  assert.equal((await finish()).status, 'success');
  await s.pushRemote('README.md', 'remote');
  const refused = await finish();
  assert.equal(refused.status, 'failed');
  assert.match(refused.output, /README\.md/);
  assert.equal(await readFile(path.join(s.cwd, 'README.md'), 'utf-8'), 'mine');
});

test('diverged, detached and busy wording is unchanged with unrelated dirty files, and the fallback text carries no checkout path', async () => {
  const s = await setup('Pull Wording Dirty');
  const { poller } = harness({ incomingPaths: async () => { throw new Error('diff failed'); } });
  await s.pushRemote('other.txt', 'o');
  await writeFile(path.join(s.cwd, 'README.md'), 'mine');
  await poller.refreshOne(await s.fresh());
  assert.equal(JSON.stringify(poller.get(s.project.id)).includes(s.cwd), false, 'no absolute checkout path in the reading');
  await git(s.cwd, ['checkout', '--', 'README.md']);

  const d = await setup('Pull Diverged Dirty');
  const h = harness();
  await d.commitLocal();
  await d.pushRemote('other.txt', 'o');
  await writeFile(path.join(d.cwd, 'scratch.json'), 'x');
  await h.poller.refreshOne(await d.fresh());
  assert.equal(h.poller.get(d.project.id)!.deferredReason, 'not pulled: your branch has diverged from origin');
});
