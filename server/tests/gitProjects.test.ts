import assert from 'node:assert/strict';
import { settledExecute } from './helpers/startRun.ts';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { git, commitAndPush, validateRepository } from '../src/projects/git.ts';
import type { TerminalSessionHost, TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import type { TaskRecord, WorkflowRunRecord } from '../src/domain/types.ts';
import { installDocsRetroFixture } from './fixtures/docsRetroFixture.ts';
let root: string;
let service: typeof import('../src/projects/projectService.ts');
let worker: typeof import('../src/worker/workerManager.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'git-projects-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures/executors.json');
  // Isolated from the real repo's catalog/ (and never touches .claude/ either) — see catalogService.test.ts's fixture doc comment.
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(root, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  await installDocsRetroFixture(process.env.AGENT_VISUAL_OS_CATALOG_DIR);
  // Rewrite only this test process's GitHub URLs to a local bare remote.
  process.env.GIT_CONFIG_COUNT = '3';
  process.env.GIT_CONFIG_KEY_0 = `url.${root}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test/';
  process.env.GIT_CONFIG_KEY_1 = 'user.name'; process.env.GIT_CONFIG_VALUE_1 = 'Test';
  process.env.GIT_CONFIG_KEY_2 = 'user.email'; process.env.GIT_CONFIG_VALUE_2 = 'test@example.com';
  await git(root, ['init', '--bare', '--initial-branch=main', 'repo']);
  await git(root, ['clone', path.join(root, 'repo'), 'seed']);
  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'README.md'), 'existing code');
  await mkdir(path.join(seed, '.docs'));
  await writeFile(path.join(seed, '.docs/blueprint.md'), 'existing blueprint');
  await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'initial']);
  await git(seed, ['push', 'origin', 'main']);
  await git(seed, ['branch', 'feature']); await git(seed, ['push', 'origin', 'feature']);
  service = await import('../src/projects/projectService.ts');
  worker = await import('../src/worker/workerManager.ts');
  planItemService = await import('../src/projects/planItemService.ts');
});
after(async () => {
  // maxRetries: a settled Task's own best-effort worktree cleanup (cleanupWorktree) can still be
  // removing a git worktree directory here — a settle* helper updates the Task's status before it
  // runs (see workerManager.ts's settleStopped/settleFailed/settleDone), so a test's own
  // `waitForSettled` can resolve, and the test function return, while that cleanup is still in
  // flight — same race api.test.ts's own `after()` already retries past for its deferred
  // docs-bootstrap Task.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('rejects non-GitHub URLs and shell/option payloads', () => {
  for (const url of ['--upload-pack=evil', 'file:///tmp/repo', 'https://github.com/a/b;touch x', 'https://evil.com/a/b', 'git@github.com:owner/repo;touch x']) assert.throws(() => validateRepository(url));
  assert.equal(validateRepository('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git');
});
test('accepts SSH URLs aliased to a non-github.com host via ~/.ssh/config', () => {
  assert.equal(validateRepository('git@github.com-work:owner/repo.git'), 'git@github.com-work:owner/repo.git');
  assert.equal(validateRepository('git@ssh.github.com:owner/repo.git'), 'git@ssh.github.com:owner/repo.git');
});
test('imports code with custom name, preserves blueprint, checks out remote and new branches', async () => {
  const project = await service.createProject({ name: 'Custom building', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  assert.equal(await readFile(path.join(cwd, 'README.md'), 'utf8'), 'existing code');
  assert.equal(await readFile(path.join(cwd, '.docs/blueprint.md'), 'utf8'), 'existing blueprint');
  assert.equal(project.name, 'Custom building');
  assert.equal((await service.checkoutProjectBranch(project.id, 'feature')).current, 'feature');
  assert.equal((await service.checkoutProjectBranch(project.id, 'task/new', true)).current, 'task/new');
  await writeFile(path.join(cwd, 'README.md'), 'changed');
  await assert.rejects(() => service.checkoutProjectBranch(project.id, 'main'), /local changes/);
  assert.equal(await commitAndPush(cwd, 'task/new', 'task result'), true);
  assert.equal(await git(path.join(root, 'repo'), ['show', 'task/new:README.md']), 'changed');
  assert.equal(await commitAndPush(cwd, 'task/new', 'no changes'), false);
  await assert.rejects(() => commitAndPush(cwd, 'main', 'wrong branch'), /Checkout changed/);
  // A stale activeTaskId — no real Task behind it — must never block a switch (I16/U15): the new
  // folder-busy rule discards it the same way the daemon's own folder-free check already does.
  await service.patchProject(project.id, { activeTaskId: 'running' });
  assert.equal((await service.checkoutProjectBranch(project.id, 'main')).current, 'main');
});
test('creating a branch carries uncommitted work over, even while a Task is active, and reports the move to onBranchCreated', async () => {
  const project = await service.createProject({ name: 'Forgot To Branch', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  await writeFile(path.join(cwd, 'README.md'), 'work started on main by mistake');
  await service.patchProject(project.id, { activeTaskId: 'running' });
  const moves: [string, string][] = [];

  const result = await service.checkoutProjectBranch(project.id, 'fix/moved-work', true, async (from, to) => { moves.push([from, to]); });

  assert.equal(result.current, 'fix/moved-work');
  assert.deepEqual(moves, [['main', 'fix/moved-work']]);
  assert.equal(await readFile(path.join(cwd, 'README.md'), 'utf8'), 'work started on main by mistake');
  assert.equal(await commitAndPush(cwd, 'fix/moved-work', 'moved work'), true);
  assert.equal(await git(path.join(root, 'repo'), ['show', 'fix/moved-work:README.md']), 'work started on main by mistake');
  assert.equal(await git(path.join(root, 'repo'), ['show', 'main:README.md']), 'existing code');
  await assert.rejects(() => service.checkoutProjectBranch(project.id, 'fix/moved-work', true), /Git operation failed/);
  assert.deepEqual(moves, [['main', 'fix/moved-work']], 'a failed create must not retarget anything');
});
test('projectBranches fetches from origin first, so a branch someone else pushed after cloning still shows up; checking it out creates a local tracking branch for a remote-only branch', async () => {
  const project = await service.createProject({ name: 'Fetch Before List', position: null, repositoryUrl: 'https://github.com/test/repo' });

  // Simulate a teammate pushing a brand-new branch to the remote from a separate clone — this
  // Project's own local clone has no local or remote-tracking ref for it yet.
  const otherClone = path.join(root, 'other-clone-for-fetch-test');
  await git(root, ['clone', path.join(root, 'repo'), 'other-clone-for-fetch-test']);
  await git(otherClone, ['switch', '-c', 'teammates-branch']);
  await writeFile(path.join(otherClone, 'teammate.txt'), 'from teammate');
  await git(otherClone, ['add', '.']);
  await git(otherClone, ['commit', '-m', 'teammate change']);
  await git(otherClone, ['push', 'origin', 'teammates-branch']);

  const { branches } = await service.projectBranches(project.id);
  assert.ok(branches.includes('teammates-branch'), 'projectBranches must fetch before listing, or a branch pushed after cloning would never show up');

  const checkedOut = await service.checkoutProjectBranch(project.id, 'teammates-branch');
  assert.equal(checkedOut.current, 'teammates-branch');
  const cwd = service.projectAbsolutePath(project);
  assert.equal(await readFile(path.join(cwd, 'teammate.txt'), 'utf8'), 'from teammate', 'switching to a remote-only branch must actually check its content out, not just rename HEAD');
  // A real local tracking branch was created, not a detached HEAD.
  assert.equal(await git(cwd, ['symbolic-ref', '--short', 'HEAD']), 'teammates-branch');
  assert.equal(await git(cwd, ['rev-parse', '--abbrev-ref', 'teammates-branch@{upstream}']), 'origin/teammates-branch');
});

/**
 * A minimal fake TerminalSessionHost: `start` just records the call so a test can inspect it
 * (`cwd`, `prompt`, etc. — see TerminalSessionStart) and later trigger `onExit` by hand, exactly
 * like `tests/workerManager.test.ts`'s own `fakeTerminalHost`. Every Task in this file now runs
 * through the interactive-CLI path (no more headless `claude -p`/`codex exec` executor kind — see
 * docs/architecture.md), so a real git worktree/commit/branch-drift scenario is driven by starting a
 * terminal session and then simulating its process exiting, rather than resolving a structured turn.
 */
function fakeTerminalHost(): { host: TerminalSessionHost; starts: TerminalSessionStart[] } {
  const starts: TerminalSessionStart[] = [];
  const host: TerminalSessionHost = {
    start(input) { starts.push(input); },
    attach: () => () => undefined,
    write() {},
    resize() {},
    stop: () => true,
    has: () => true,
    isAttached: () => false,
    count: () => 0,
  };
  return { host, starts };
}

const ZERO_TOKEN_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };

/** A minimal, directly-inserted TaskRecord — see .docs/testing.md's "API tests never start a real Task": `runtimeStatus: 'starting'` makes `isLiveTask` treat it as really running without a registered CLI session, with no real `claude`/`codex` process involved. */
function fakeTask(overrides: Partial<TaskRecord> & { id: string; projectId: string }): TaskRecord {
  const now = new Date().toISOString();
  return {
    templateId: 'builder', executorId: 'test-claude-cli', description: 'Task', autonomy: 'auto', manager: false,
    kind: 'execute', status: 'developing', runtimeStatus: 'starting', planItemId: null, sessionId: null,
    blockedQuestion: null, failureReason: null, tokenUsage: ZERO_TOKEN_USAGE, createdAt: now, updatedAt: now, completedAt: null,
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

test('I1: checkoutProjectBranch succeeds with only planning session(s) active, running, waiting for an answer, or idle', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  for (const status of ['developing', 'blocked'] as const) {
    const project = await service.createProject({ name: `Branch Plan ${status}`, position: null, repositoryUrl: 'https://github.com/test/repo' });
    const planTask = await tasksDb.insert(fakeTask({ id: `branch-plan-${status}`, projectId: project.id, kind: 'plan', status }));
    await service.patchProject(project.id, { activeTaskIds: [planTask.id] });
    assert.equal((await service.checkoutProjectBranch(project.id, 'feature')).current, 'feature');
  }
  // Idle: the planning session has settled and is no longer in the active set.
  const idleProject = await service.createProject({ name: 'Branch Plan idle', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await tasksDb.insert(fakeTask({ id: 'branch-plan-idle', projectId: idleProject.id, kind: 'plan', status: 'done', runtimeStatus: undefined }));
  assert.equal((await service.checkoutProjectBranch(idleProject.id, 'feature')).current, 'feature');
});

test('I2: checkoutProjectBranch succeeds with only worktree-isolated Tasks/WorkflowRuns active', async () => {
  const { tasksDb, workflowRunsDb } = await import('../src/db/collections.ts');
  const taskProject = await service.createProject({ name: 'Branch Worktree Task', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const worktreeTask = await tasksDb.insert(fakeTask({ id: 'branch-worktree-task', projectId: taskProject.id, worktreePath: '/tmp/branch-wt-task' }));
  await service.patchProject(taskProject.id, { activeTaskIds: [worktreeTask.id] });
  assert.equal((await service.checkoutProjectBranch(taskProject.id, 'feature')).current, 'feature');

  const runProject = await service.createProject({ name: 'Branch Worktree Run', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await workflowRunsDb.insert(fakeRun({ id: 'branch-worktree-run', projectId: runProject.id, status: 'awaiting-approval', worktreePath: '/tmp/branch-wt-run' }));
  assert.equal((await service.checkoutProjectBranch(runProject.id, 'feature')).current, 'feature');
});

test('I3: checkoutProjectBranch is refused with a coding Task in the project folder, regardless of start order relative to a planning session', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');

  const folderThenPlan = await service.createProject({ name: 'Branch Folder Then Plan', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const folderFirst = await tasksDb.insert(fakeTask({ id: 'branch-order-folder-first', projectId: folderThenPlan.id }));
  const planAfter = await tasksDb.insert(fakeTask({ id: 'branch-order-plan-after', projectId: folderThenPlan.id, kind: 'plan' }));
  await service.patchProject(folderThenPlan.id, { activeTaskIds: [folderFirst.id, planAfter.id] });
  await assert.rejects(() => service.checkoutProjectBranch(folderThenPlan.id, 'feature'), worker.ProjectFolderBusyError);

  const planThenFolder = await service.createProject({ name: 'Branch Plan Then Folder', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const planFirst = await tasksDb.insert(fakeTask({ id: 'branch-order-plan-first', projectId: planThenFolder.id, kind: 'plan' }));
  const folderAfter = await tasksDb.insert(fakeTask({ id: 'branch-order-folder-after', projectId: planThenFolder.id }));
  await service.patchProject(planThenFolder.id, { activeTaskIds: [planFirst.id, folderAfter.id] });
  await assert.rejects(() => service.checkoutProjectBranch(planThenFolder.id, 'feature'), worker.ProjectFolderBusyError);
});

test('I4: checkoutProjectBranch is refused with an in-place WorkflowRun awaiting approval between steps', async () => {
  const { workflowRunsDb } = await import('../src/db/collections.ts');
  const project = await service.createProject({ name: 'Branch In-place Awaiting', position: null, repositoryUrl: 'https://github.com/test/repo' });
  await workflowRunsDb.insert(fakeRun({ id: 'branch-in-place-awaiting', projectId: project.id, status: 'awaiting-approval' }));
  await assert.rejects(() => service.checkoutProjectBranch(project.id, 'feature'), worker.ProjectFolderBusyError);
});

test('I6: checkoutProjectBranch on a Project with no linked repository still errors', async () => {
  const project = await service.createProject({ name: 'Branch No Repo', position: null });
  await assert.rejects(() => service.checkoutProjectBranch(project.id, 'main'), /no linked repository/);
});

test('I7: createBranch:true still succeeds and carries uncommitted work over even while real folder work is active', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  const project = await service.createProject({ name: 'Branch Create Real Folder Work', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  const folderTask = await tasksDb.insert(fakeTask({ id: 'branch-create-real-folder-task', projectId: project.id }));
  await service.patchProject(project.id, { activeTaskIds: [folderTask.id] });
  await writeFile(path.join(cwd, 'README.md'), 'real folder work in progress');

  const result = await service.checkoutProjectBranch(project.id, 'carried-over-real', true);
  assert.equal(result.current, 'carried-over-real');
  assert.equal(await readFile(path.join(cwd, 'README.md'), 'utf8'), 'real folder work in progress');
});

test('I8: switching to the branch a worktree-isolated Task has already checked out surfaces git\'s own refusal, not the folder-busy guard', async () => {
  const project = await service.createProject({ name: 'Branch Collides With Worktree', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  const taskA = await manager.startTask({ projectId: project.id, description: 'Task A' });
  const taskB = await manager.startTask({ projectId: project.id, description: 'Task B' });
  assert.ok(taskB.worktreePath, 'the second concurrent Task must get its own worktree');

  // Settle Task A so the folder itself is free — this must be purely a git branch collision now,
  // never the folder-busy guard (Task B isn't in the project's own folder at all).
  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, taskA.id);

  await assert.rejects(() => service.checkoutProjectBranch(project.id, taskB.branch!), /already used by worktree/i);

  terminal.starts[1]?.onExit(0);
  await waitForSettled(manager, taskB.id);
});

test('I20: checkoutProjectBranch, runProjectSync and executePlanItem(createBranch:false) all agree about the same project state', async () => {
  const commands = await import('../src/commands/commandRunner.ts');
  const { tasksDb } = await import('../src/db/collections.ts');
  const project = await service.createProject({ name: 'Rule Consistency', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  const runner = commands.createCommandRunner({ sessions: terminal.host });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Consistency check', description: '' });

  const folderTask = await manager.startTask({ projectId: project.id, description: 'Folder work' });
  assert.equal(folderTask.worktreePath, undefined);

  // All three refuse while this Task is really running in the project's own folder.
  await assert.rejects(() => settledExecute(manager)(item.id, { createBranch: false }), worker.ProjectFolderBusyError);
  await assert.rejects(() => service.checkoutProjectBranch(project.id, 'feature', false, undefined, terminal.host), worker.ProjectFolderBusyError);
  await assert.rejects(() => runner.runProjectSync(project.id), worker.ProjectFolderBusyError);
  assert.equal((await planItemService.getPlanItem(item.id)).status, 'pending', 'the refused start left it untouched');

  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, folderTask.id);

  // Flip the Project's only other live Task into a worktree Task (simulating it moving out of the
  // folder) — now all three must agree the folder is free.
  const worktreeOnlyTask = await manager.startTask({ projectId: project.id, description: 'Will be worktree-only' });
  await tasksDb.update(worktreeOnlyTask.id, { worktreePath: '/tmp/consistency-worktree' });

  assert.equal((await service.checkoutProjectBranch(project.id, 'feature', false, undefined, terminal.host)).current, 'feature');
  const syncRun = await runner.runProjectSync(project.id);
  await waitUntil(async () => (await runner.getCommandRun(syncRun.id)).status !== 'running');
  const resumed = await settledExecute(manager)(item.id, { createBranch: false });
  assert.equal(resumed.worktreePath, undefined, 'createBranch:false always runs in the project folder itself');

  terminal.starts[1]?.onExit(0);
  terminal.starts[2]?.onExit(0);
  await waitForSettled(manager, worktreeOnlyTask.id);
  await waitForSettled(manager, resumed.id);
});

test('startDocsBootstrapTask puts the setup item on the board and starts it through the normal path, cloned or blank alike', async () => {
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ runClaudeTurn: async () => { throw new Error('unused: every Task now runs via the interactive CLI'); }, terminalSessions: terminal.host });
  const deps = { createPlanItem: planItemService.createPlanItem, enqueuePlanItemExecution: manager.enqueuePlanItemExecution };

  const project = await service.createProject({ name: 'Freshly Cloned', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const item = await service.startDocsBootstrapTask(project, deps);
  const listed = await planItemService.listPlanItems(project.id);
  assert.ok(listed.some((entry) => entry.id === item.id && entry.title === 'Set up project documentation'), 'visible on the board at once');
  const started = await planItemService.getPlanItem(item.id);
  assert.ok(started.workflowRunId, 'started through the workflow engine like a user-started task');
  const run = await manager.getWorkflowRun(started.workflowRunId!);
  assert.equal(run.workflowSnapshot.id, 'project-docs-setup', 'the fixed documentation workflow runs, not the Project\'s own');
  assert.deepEqual(run.workflowSnapshot.steps.map((step) => [step.agentId, step.skillIds, step.preloadSkillIds]), [['documentation-n-retro-agent', ['maintain-project-context'], ['maintain-project-context']]]);
  await manager.whenStartupSettled(started.workflowRunId!);
  assert.match(terminal.starts[0]?.prompt ?? '', /bootstrap run.*migrate run/s);
  const [task] = (await manager.listTasksForProject(project.id)).filter((entry) => entry.planItemId === item.id);
  assert.ok(task);
  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, task!.id);
  assert.equal((await manager.getTask(task!.id)).status, 'done', 'the item follows the real Task through to done');

  const blank = await service.createProject({ name: 'Brand New, No Repository', position: null });
  const blankItem = await service.startDocsBootstrapTask(blank, deps);
  const blankRun = (await planItemService.getPlanItem(blankItem.id)).workflowRunId;
  assert.ok(blankRun, 'a blank Project gets the same setup item');
  await manager.whenStartupSettled(blankRun!);
  terminal.starts[1]?.onExit(0);
});

test('bug 19.001.001: the "Set up project documentation" task runs on the owner\'s selected default agent, not the first configured one', async () => {
  const { defaultExecutorStore } = await import('../src/executors/defaultExecutorInstance.ts');
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ runClaudeTurn: async () => { throw new Error('unused'); }, terminalSessions: terminal.host });
  const project = await service.createProject({ name: 'Docs On Default', position: null });
  await defaultExecutorStore.set({ executorId: 'test-claude-cli-alt', label: 'Alt' });
  try {
    const item = await service.startDocsBootstrapTask(project, { createPlanItem: planItemService.createPlanItem, enqueuePlanItemExecution: manager.enqueuePlanItemExecution });
    const runId = (await planItemService.getPlanItem(item.id)).workflowRunId!;
    await manager.whenStartupSettled(runId);
    assert.equal((await manager.getWorkflowRun(runId)).executorId, 'test-claude-cli-alt');
    const [task] = (await manager.listTasksForProject(project.id)).filter((entry) => entry.planItemId === item.id);
    assert.equal(task?.executorId, 'test-claude-cli-alt');
    await manager.stopWorkflowRun(runId);
  } finally {
    await defaultExecutorStore.clear();
  }
});

test('startDocsBootstrapTask leaves the item on the board when the start fails', async () => {
  const project = await service.createProject({ name: 'Start Fails', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const failing = await service.startDocsBootstrapTask(project, {
    createPlanItem: planItemService.createPlanItem,
    enqueuePlanItemExecution: async () => { throw new Error('boom'); },
  }).catch((error: Error) => error);
  assert.match(String(failing), /boom/);
  const items = await planItemService.listPlanItems(project.id);
  assert.equal(items.filter((entry) => entry.title === 'Set up project documentation').length, 1, 'the not-started item stays for a retry');
});

test('startDocsBootstrapTask queues the setup item at the task limit, keeps its fixed workflow, and starts it when the slot frees', async () => {
  const project = await service.createProject({ name: 'Setup Waits', position: null });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ runClaudeTurn: async () => { throw new Error('unused'); }, terminalSessions: terminal.host });
  const holder = await manager.startTask({ projectId: project.id, description: 'Holds the only slot' });

  const item = await service.startDocsBootstrapTask(project, { createPlanItem: planItemService.createPlanItem, enqueuePlanItemExecution: manager.enqueuePlanItemExecution });
  const queue = await manager.listPlanItemQueue(project.id);
  assert.deepEqual(queue.map((entry) => entry.planItemId), [item.id], 'waiting, not refused');
  assert.equal(queue[0]?.workflow?.id, 'project-docs-setup');

  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, holder.id);
  await waitUntil(async () => Boolean((await planItemService.getPlanItem(item.id)).workflowRunId));
  const run = await manager.getWorkflowRun((await planItemService.getPlanItem(item.id)).workflowRunId!);
  assert.equal(run.workflowSnapshot.id, 'project-docs-setup');
  assert.deepEqual(await manager.listPlanItemQueue(project.id), []);
  await manager.whenStartupSettled(run.id);
  terminal.starts[1]?.onExit(0);
});

test('failed clone removes destination and does not register project', async () => {
  await assert.rejects(() => service.createProject({ name: 'Missing remote', position: null, repositoryUrl: 'https://github.com/test/missing' }));
  assert.ok(!(await service.listProjects()).some(p => p.name === 'Missing remote'));
  await assert.rejects(() => access(path.join(root, 'projects/missing-remote')));
});
test('a bare interactive-CLI Task commits and pushes before pausing; a rejected push fails its follow-up and preserves the earlier commit', async () => {
  const project = await service.createProject({ name: 'Worker repo', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  let count = 0;
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Make a change' });
  // Simulate the CLI having edited a file during its (fake) session, then exiting cleanly.
  await writeFile(path.join(cwd, 'result.txt'), `result ${++count}`);
  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, task.id);
  assert.equal((await manager.getTask(task.id)).status, 'stopped', 'a plain CLI exit only pauses a bare Task — see runTerminalTask\'s onExit handler');
  assert.equal(task.branch, 'main');
  assert.equal(await git(path.join(root, 'repo'), ['show', 'main:result.txt']), 'result 1');

  await git(cwd, ['remote', 'set-url', '--push', 'origin', path.join(root, 'missing')]);
  const failed = await manager.followUpTask(task.id, 'Another change');
  await writeFile(path.join(cwd, 'result.txt'), `result ${++count}`);
  terminal.starts[1]?.onExit(0);
  await waitForSettled(manager, failed.id);
  assert.equal((await manager.getTask(failed.id)).status, 'failed');
  assert.match((await manager.getTask(failed.id)).failureReason!, /Git operation failed/);
  assert.equal(await git(cwd, ['show', 'HEAD:result.txt']), 'result 2');
});

/** Generic poll: retries `check` until it returns true or `timeoutMs` elapses. */
async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Waits until a Task reaches a settled status. Includes 'stopped' alongside 'done'/'failed': a bare
 * interactive-CLI Task's own plain exit pauses it 'stopped' rather than settling it 'done' (see
 * runTerminalTask) — every concurrency test below treats that pause the same as any other
 * settling, since none of them exercise the explicit "mark completed" action.
 */
async function waitForSettled(manager: ReturnType<typeof import('../src/worker/workerManager.ts')['createWorkerManager']>, taskId: string): Promise<void> {
  await waitUntil(async () => {
    const status = (await manager.getTask(taskId)).status;
    return status === 'done' || status === 'failed' || status === 'stopped';
  });
}

/** Waits until a path no longer exists — settling a Task's status happens (requireTaskUpdate) a step before its best-effort worktree cleanup (cleanupWorktree) finishes, so polling status alone can observe 'failed'/'done'/'stopped' a tick before the directory is actually gone. */
async function waitForRemoved(targetPath: string): Promise<void> {
  await waitUntil(async () => {
    try { await access(targetPath); return false; } catch { return true; }
  });
}

test("a Project's first concurrent Task uses its own directory directly; a second gets its own isolated git worktree and branch, and neither corrupts the other's files", async () => {
  const project = await service.createProject({ name: 'Concurrent Worktrees', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const mainCwd = service.projectAbsolutePath(project);
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });

  // startTask fully awaits its terminal session's registration before returning (the project popup
  // must never race a still-being-created session), so both starts are already recorded here.
  const taskA = await manager.startTask({ projectId: project.id, description: 'Task A' });
  const taskB = await manager.startTask({ projectId: project.id, description: 'Task B' });

  assert.equal(taskA.worktreePath, undefined, "the Project's first concurrent Task must use its own directory directly — no worktree overhead for the common case");
  assert.equal(taskA.branch, 'main');
  assert.ok(taskB.worktreePath, 'a second concurrent Task on the same Project must get its own isolated worktree');
  assert.equal(taskB.branch, `task/${taskB.id}`);
  assert.notEqual(taskB.worktreePath, mainCwd);
  assert.equal(terminal.starts[0]?.cwd, mainCwd, "Task A's session must run in the Project's own directory");
  assert.equal(terminal.starts[1]?.cwd, taskB.worktreePath, "Task B's session must run in its own worktree, not the Project's shared directory");

  // The worktree really exists on disk, checked out on its own branch, while the Project's own
  // directory stays exactly where it was — untouched by the concurrent worktree Task.
  await access(taskB.worktreePath!);
  assert.equal(await git(taskB.worktreePath!, ['symbolic-ref', '--short', 'HEAD']), `task/${taskB.id}`);
  assert.equal(await git(mainCwd, ['symbolic-ref', '--short', 'HEAD']), 'main');

  // Each Task's own files land only in its own working directory — no cross-contamination.
  await writeFile(path.join(mainCwd, 'from-a.txt'), 'a');
  await writeFile(path.join(taskB.worktreePath!, 'from-b.txt'), 'b');
  await assert.rejects(() => access(path.join(mainCwd, 'from-b.txt')));
  await assert.rejects(() => access(path.join(taskB.worktreePath!, 'from-a.txt')));

  terminal.starts[0]?.onExit(0);
  terminal.starts[1]?.onExit(0);
  await waitForSettled(manager, taskA.id);
  await waitForSettled(manager, taskB.id);

  assert.equal((await manager.getTask(taskA.id)).status, 'stopped');
  assert.equal((await manager.getTask(taskB.id)).status, 'stopped');

  // Each committed and pushed on its own branch — commitAndPush ran against the right cwd for each.
  assert.equal(await git(path.join(root, 'repo'), ['show', 'main:from-a.txt']), 'a');
  assert.equal(await git(path.join(root, 'repo'), ['show', `task/${taskB.id}:from-b.txt`]), 'b');

  // Cleanup policy: the worktree directory is removed once its Task settles, but the branch itself
  // stays pushed and available for a human to review/merge later (never auto-merged).
  await waitForRemoved(taskB.worktreePath!);
  const worktreeList = await git(mainCwd, ['worktree', 'list']);
  assert.ok(!worktreeList.includes(taskB.worktreePath!), 'git itself must no longer track the removed worktree');
  await assert.doesNotReject(() => git(mainCwd, ['rev-parse', '--verify', `task/${taskB.id}`]), "the branch must survive even though the worktree directory was removed");
});

test('interimCommitTask commits and pushes an ongoing Task\'s work without settling it, and refuses once the Task has settled', async () => {
  const project = await service.createProject({ name: 'Interim Commits', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const cwd = service.projectAbsolutePath(project);
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  const task = await manager.startTask({ projectId: project.id, description: 'Interim work' });

  await writeFile(path.join(cwd, 'interim.txt'), 'partial');
  const first = await manager.interimCommitTask(task.id);
  assert.equal(first.committed, true);
  assert.match(first.message, /^Interim Commit \d{4}-\d{2}-\d{2}T/);
  assert.equal(await git(path.join(root, 'repo'), ['show', `${task.branch}:interim.txt`]), 'partial');
  assert.equal(await git(path.join(root, 'repo'), ['log', '-1', '--format=%s', task.branch!]), first.message);
  assert.equal((await manager.getTask(task.id)).status, 'developing', 'an interim commit must leave the Task running');

  assert.equal((await manager.interimCommitTask(task.id)).committed, false, 'nothing new to commit still pushes, but reports no commit');

  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, task.id);
  await assert.rejects(() => manager.interimCommitTask(task.id), worker.TaskNotInterimCommittableError);
});

test('a git-backed Project runs 6 Tasks at once and refuses the 7th with a limit error that lists what is using the slots', async () => {
  const project = await service.createProject({ name: 'Capped Project', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });

  const started = [];
  for (let i = 0; i < 6; i++) started.push(await manager.startTask({ projectId: project.id, description: `Task ${i}` }));

  const refusal = await manager.startTask({ projectId: project.id, description: 'One more' }).then(() => null, (error: unknown) => error);
  assert.ok(refusal instanceof worker.TaskLimitReachedError);
  assert.ok(refusal instanceof worker.TaskConflictError, 'the limit error is still a TaskConflictError for existing catch sites');
  assert.equal(refusal.code, 'task_limit_reached');
  assert.match(refusal.message, /Capped Project is running its maximum of 6 tasks/);
  assert.doesNotMatch(refusal.message, /docs\/|architecture|\.md/, 'no documentation path reaches the person');
  assert.doesNotMatch(refusal.message, new RegExp(project.id));
  assert.deepEqual({ ...refusal.details, occupants: undefined }, { projectName: 'Capped Project', limit: 6, inUse: 6, hasRepository: true, occupants: undefined });
  const occupants = refusal.details.occupants as { taskId: string; title: string; state: string }[];
  assert.deepEqual(occupants.map((o) => o.taskId).sort(), started.map((t) => t.id).sort());
  assert.ok(occupants.every((o) => o.state === 'running' && o.title.startsWith('Task ')));
  assert.equal(started[0]!.worktreePath, undefined, 'the first Task never gets a worktree');
  assert.ok(started.slice(1).every((t) => t.worktreePath), 'every Task after the first must get its own worktree');
  assert.equal(new Set(started.slice(1).map((t) => t.worktreePath)).size, 5, 'every worktree Task must get a distinct path');
  assert.equal(terminal.starts.length, 6, 'the refused start never launches a session');

  for (const start of terminal.starts) start.onExit(0);
  for (const task of started) await waitForSettled(manager, task.id);
});

test('a Project without a repository is limited to one Task, and its limit error explains why', async () => {
  const project = await service.createProject({ name: 'No Repo', position: null });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  const first = await manager.startTask({ projectId: project.id, description: 'Only one' });

  const refusal = await manager.startTask({ projectId: project.id, description: 'Second' }).then(() => null, (error: unknown) => error);
  assert.ok(refusal instanceof worker.TaskLimitReachedError);
  assert.match(refusal.message, /No Repo can run only one task at a time because it has no linked repository/);
  assert.deepEqual([refusal.details.limit, refusal.details.inUse, refusal.details.hasRepository], [1, 1, false]);

  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, first.id);
});

test('a worktree Task that fails to start still has its own worktree directory cleaned up, and its branch is left behind (never auto-merged) for a human to review', async () => {
  const project = await service.createProject({ name: 'Failed Worktree Cleanup', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const mainCwd = service.projectAbsolutePath(project);
  const starts: TerminalSessionStart[] = [];
  // The second Task's session fails to even start (e.g. a real spawn failure) — runTerminalTask's
  // own try/catch around terminalSessions.start settles that straight to 'failed', same as a real
  // ENOENT would, without ever registering a session for it.
  const host: TerminalSessionHost = {
    start(input) {
      if (!input.prompt.includes('Keep first busy')) throw new Error('spawn claude ENOENT');
      starts.push(input);
    },
    attach: () => () => undefined,
    write() {},
    resize() {},
    stop: () => true,
    has: () => true,
    isAttached: () => false,
    count: () => 0,
  };
  const manager = worker.createWorkerManager({ terminalSessions: host });

  const first = await manager.startTask({ projectId: project.id, description: 'Keep first busy' });
  const second = await manager.startTask({ projectId: project.id, description: 'This one fails' });
  assert.ok(second.worktreePath);

  await waitForSettled(manager, second.id);
  assert.equal((await manager.getTask(second.id)).status, 'failed');
  await waitForRemoved(second.worktreePath!); // best-effort cleanup runs after the status write settles
  // git worktree add -b already created the branch locally even though nothing was ever pushed;
  // cleanup only removes the checked-out directory, never the branch.
  await assert.doesNotReject(() => git(mainCwd, ['rev-parse', '--verify', `task/${second.id}`]), 'the branch must survive a failed Task\'s worktree cleanup');

  starts[0]?.onExit(0);
  await waitForSettled(manager, first.id);
});

test("a worktree Task's branch-drift check and commit/push run against its OWN cwd, independent of the Project's main directory or a sibling Task's worktree", async () => {
  const project = await service.createProject({ name: 'Per-Task Branch Drift', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const mainCwd = service.projectAbsolutePath(project);
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });

  const taskA = await manager.startTask({ projectId: project.id, description: 'Task A' });
  const taskB = await manager.startTask({ projectId: project.id, description: 'Task B' });

  // Switch the *main* directory's checked-out branch out from under Task A while Task B (an
  // unrelated worktree) is still in flight — this must fail Task A, which owns the main directory,
  // without touching Task B at all. Both Tasks' sessions already started against the branch each
  // had checked out at start time, so this drift can only be caught later, by commitAndPush's own
  // check when Task A's session exits and the daemon tries to commit its (non-existent) work.
  await git(mainCwd, ['checkout', 'feature']);
  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, taskA.id);
  assert.equal((await manager.getTask(taskA.id)).status, 'failed');
  assert.match((await manager.getTask(taskA.id)).failureReason ?? '', /checked-out branch no longer matches|Checkout changed during task/);

  // Task B's own worktree branch never moved, so its session must still settle normally, proving its
  // commit/push ran against its own cwd, not the (now-drifted) main directory.
  terminal.starts[1]?.onExit(0);
  await waitForSettled(manager, taskB.id);
  assert.equal((await manager.getTask(taskB.id)).status, 'stopped');
});

test('starting a plan item with createBranch:true runs it in a new worktree on its own feature/ branch; createBranch:false runs it in the project folder on the checked-out branch', async () => {
  const project = await service.createProject({ name: 'Start Options', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const mainCwd = service.projectAbsolutePath(project);
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  const branched = await planItemService.createPlanItem({ projectId: project.id, title: 'On a branch', description: '' });
  const inPlace = await planItemService.createPlanItem({ projectId: project.id, title: 'In place', description: '' });
  const refused = await planItemService.createPlanItem({ projectId: project.id, title: 'Refused', description: '' });

  const branchTask = await settledExecute(manager)(branched.id, { createBranch: true });
  assert.ok(branchTask.worktreePath);
  assert.equal(branchTask.branch, 'feature/on-a-branch');
  assert.equal(terminal.starts[0]?.cwd, branchTask.worktreePath);
  assert.equal(await git(branchTask.worktreePath!, ['symbolic-ref', '--short', 'HEAD']), 'feature/on-a-branch');
  const branchRun = (await manager.getWorkflowRunDetail(branchTask.workflowRunId!)).run;
  assert.equal(branchRun.baseBranch, 'main');

  // A worktree run leaves the project folder free, so an in-place run can still start beside it.
  const inPlaceTask = await settledExecute(manager)(inPlace.id, { createBranch: false });
  assert.equal(inPlaceTask.worktreePath, undefined);
  assert.equal(inPlaceTask.branch, 'main');
  assert.equal(terminal.starts[1]?.cwd, mainCwd);
  const inPlaceRun = (await manager.getWorkflowRunDetail(inPlaceTask.workflowRunId!)).run;
  assert.equal(inPlaceRun.worktreePath, undefined);
  assert.equal(inPlaceRun.baseBranch, undefined, 'no branch of its own, so nothing to diff against');
  assert.equal(await git(mainCwd, ['symbolic-ref', '--short', 'HEAD']), 'main');

  // Only one thing works in the project folder at a time.
  await assert.rejects(() => settledExecute(manager)(refused.id, { createBranch: false }), worker.ProjectFolderBusyError);
  assert.equal((await planItemService.getPlanItem(refused.id)).status, 'pending', 'still New');

  await manager.stopWorkflowRun(branchTask.workflowRunId!);
  await manager.stopWorkflowRun(inPlaceTask.workflowRunId!);
  terminal.starts[0]?.onExit(0);
  terminal.starts[1]?.onExit(0);
  await waitForSettled(manager, branchTask.id);
  await waitForSettled(manager, inPlaceTask.id);
  await access(branchTask.worktreePath!); // a stopped run keeps its worktree, so it can be resumed
  // Deleting the item is what removes it (the branch stays).
  await manager.deletePlanItem(branched.id);
  await waitForRemoved(branchTask.worktreePath!);
  assert.ok(await git(mainCwd, ['branch', '--list', 'feature/on-a-branch']));
});

test('a workflow with a fixed branch type names its runs\' branches with that type, numbered or by a slug of the title', async () => {
  const workflowService = await import('../src/catalog/workflowService.ts');
  const collections = await import('../src/db/collections.ts');
  await workflowService.createWorkflow({
    id: 'typed-branches', name: 'Typed Branches', description: 'Fixed branch type.', branchType: 'bugfix',
    steps: [{ id: 'fix', name: 'Fix', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Fix it.' }],
  });
  const project = await service.createProject({ name: 'Typed Branches', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  const numbered = await planItemService.createPlanItem({ projectId: project.id, title: 'Login Fails After Reset', description: '' });
  await collections.planItemsDb.update(numbered.id, { planningRef: { session: 5, task: 9 } });
  const manual = await planItemService.createPlanItem({ projectId: project.id, title: 'Typed by hand', description: '' });

  const numberedTask = await settledExecute(manager)(numbered.id, { workflowId: 'typed-branches', createBranch: true });
  assert.equal(numberedTask.branch, 'bugfix/5-009-login-fails-after-reset');
  assert.equal(await git(numberedTask.worktreePath!, ['symbolic-ref', '--short', 'HEAD']), 'bugfix/5-009-login-fails-after-reset');
  const manualTask = await settledExecute(manager)(manual.id, { workflowId: 'typed-branches', createBranch: true });
  assert.equal(manualTask.branch, 'bugfix/typed-by-hand');
  assert.equal((await manager.getWorkflowRunDetail(manualTask.workflowRunId!)).run.branch, 'bugfix/typed-by-hand');

  for (const task of [numberedTask, manualTask]) {
    await manager.stopWorkflowRun(task.workflowRunId!);
    terminal.starts.find((start) => start.taskId === task.id)?.onExit(0);
    await waitForSettled(manager, task.id);
  }
});

test('two different tasks that would otherwise name their branch the same get -2, -3, ... appended — a task never silently reuses a different task\'s branch', async () => {
  const project = await service.createProject({ name: 'Branch Name Clashes', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  // Same title, no planning number and no agent to call — both fall back to the identical slug "same-title".
  const first = await planItemService.createPlanItem({ projectId: project.id, title: 'Same title', description: '' });
  const second = await planItemService.createPlanItem({ projectId: project.id, title: 'Same title', description: '' });
  const third = await planItemService.createPlanItem({ projectId: project.id, title: 'Same title', description: '' });

  const firstTask = await settledExecute(manager)(first.id, { createBranch: true });
  const secondTask = await settledExecute(manager)(second.id, { createBranch: true });
  const thirdTask = await settledExecute(manager)(third.id, { createBranch: true });
  assert.equal(firstTask.branch, 'feature/same-title');
  assert.equal(secondTask.branch, 'feature/same-title-2');
  assert.equal(thirdTask.branch, 'feature/same-title-3');

  for (const task of [firstTask, secondTask, thirdTask]) {
    await manager.stopWorkflowRun(task.workflowRunId!);
    terminal.starts.find((start) => start.taskId === task.id)?.onExit(0);
    await waitForSettled(manager, task.id);
  }
});

test('an in-place (createBranch:false) run commits and pushes its work onto the checked-out branch and opens no PR', async () => {
  const project = await service.createProject({ name: 'In Place Complete', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const mainCwd = service.projectAbsolutePath(project);
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host, listExecutors: async () => [] });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Write a note', description: '' });

  const task = await settledExecute(manager)(item.id, { createBranch: false });
  await writeFile(path.join(mainCwd, 'in-place.txt'), 'note');
  await manager.completeStep(task.id, { summary: 'Wrote the note.' });
  await waitUntil(async () => (await manager.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'completed');

  const run = (await manager.getWorkflowRunDetail(task.workflowRunId!)).run;
  assert.equal(run.prUrl, null);
  assert.doesNotMatch(run.completionReport ?? '', /Pull request/, 'no PR attempted');
  assert.equal(await git(path.join(root, 'repo'), ['show', 'main:in-place.txt']), 'note');
  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, task.id);
});

test('resuming a stopped worktree run recreates its worktree if it went missing, and re-executing a stopped item replaces its worktree', async () => {
  const project = await service.createProject({ name: 'Resume Worktree', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const mainCwd = service.projectAbsolutePath(project);
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Resumable', description: '' });

  const task = await settledExecute(manager)(item.id, { createBranch: true });
  const runId = task.workflowRunId!;
  await manager.stopWorkflowRun(runId);
  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, task.id);
  // An older daemon removed a stopped run's worktree; resuming must bring it back on the same branch.
  await git(mainCwd, ['worktree', 'remove', '--force', task.worktreePath!]);

  await manager.resumeWorkflowRun(runId);
  assert.equal(terminal.starts[1]?.cwd, task.worktreePath);
  assert.equal(await git(task.worktreePath!, ['symbolic-ref', '--short', 'HEAD']), task.branch);

  await manager.stopWorkflowRun(runId);
  terminal.starts[1]?.onExit(0);
  await waitUntil(async () => (await manager.listTasksForProject(project.id)).every((t) => t.status === 'stopped'));
  const rerun = await settledExecute(manager)(item.id, { createBranch: true });
  assert.notEqual(rerun.workflowRunId, runId);
  assert.equal(rerun.worktreePath, task.worktreePath, 'the same path, freed by removing the stopped run\'s worktree');
  assert.equal(rerun.branch, task.branch, 'AC 5: re-running reuses the item\'s existing branch name rather than generating a new one');
  await manager.deletePlanItem(item.id);
  terminal.starts[2]?.onExit(0);
  await waitForRemoved(task.worktreePath!);
});

test('stale ids in a Project\'s active-task set (settled or legacy Tasks) never hold a concurrency slot or the project folder', async () => {
  const project = await service.createProject({ name: 'Stale Active Set', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const { tasksDb } = await import('../src/db/collections.ts');
  const now = new Date().toISOString();
  const statuses = ['stopped', 'done', 'failed', 'stopped'] as const;
  const staleIds = statuses.map((_, i) => `stale-${i}-${project.id}`);
  for (const [i, id] of staleIds.entries()) {
    await tasksDb.insert({
      id, projectId: project.id, templateId: 'builder', skillIds: [], executorId: 'test-claude-cli', executionMode: 'terminal',
      description: `Legacy ${i}`, status: statuses[i]!, autonomy: 'auto', manager: false, kind: 'execute',
      planItemId: null, sessionId: `sess-${i}`, blockedQuestion: null, failureReason: null,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0 },
      createdAt: now, updatedAt: now, completedAt: null,
    } as never);
  }
  // A legacy record whose active-task set was never reconciled when its Tasks settled.
  await service.patchProject(project.id, { activeTaskIds: staleIds, activeTaskId: staleIds.at(-1)! });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });

  const task = await manager.startTask({ projectId: project.id, description: 'Fresh work' });
  assert.equal(task.worktreePath, undefined, 'with nothing actually running, the new Task works in the project folder');
  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, task.id);
});

test('marking a paused worktree Task complete settles it done even though its worktree is already gone (no commit, no spawn ENOENT)', async () => {
  const project = await service.createProject({ name: 'Complete Without Worktree', position: null, repositoryUrl: 'https://github.com/test/repo' });
  const terminal = fakeTerminalHost();
  const manager = worker.createWorkerManager({ terminalSessions: terminal.host });
  const first = await manager.startTask({ projectId: project.id, description: 'First' });
  const second = await manager.startTask({ projectId: project.id, description: 'Second' });
  assert.ok(second.worktreePath);

  terminal.starts[1]?.onExit(0, undefined, 'sess-second');
  await waitForSettled(manager, second.id);
  await waitForRemoved(second.worktreePath!);
  assert.equal((await manager.getTask(second.id)).status, 'stopped');

  const completed = await manager.completeTerminalTask(second.id);
  assert.equal(completed.status, 'done');

  terminal.starts[0]?.onExit(0);
  await waitForSettled(manager, first.id);
});
