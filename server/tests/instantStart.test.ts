import assert from 'node:assert/strict';
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import type { TerminalSessionHost, TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import type { ProjectRecord, WorkflowRunRecord } from '../src/domain/types.ts';
import { installDocsRetroFixture } from './fixtures/docsRetroFixture.ts';

/**
 * Task 11.001: a start is accepted after only the fast local checks, and the slow setup runs as the
 * run's visible start-up steps. Real git against a local bare remote; the slow seams (worktree
 * creation, hook install, agent launch) are held open with gates so each
 * ordering is forced rather than raced.
 */

type Manager = ReturnType<typeof import('../src/worker/workerManager.ts')['createWorkerManager']>;
type Deps = NonNullable<Parameters<typeof import('../src/worker/workerManager.ts')['createWorkerManager']>[0]>;

let root: string;
let service: typeof import('../src/projects/projectService.ts');
let worker: typeof import('../src/worker/workerManager.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let collections: typeof import('../src/db/collections.ts');
let gitModule: typeof import('../src/projects/git.ts');
let hooksModule: typeof import('../src/terminal/projectCliHooks.ts');

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'instant-start-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures/executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(root, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  await installDocsRetroFixture(process.env.AGENT_VISUAL_OS_CATALOG_DIR);
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
  service = await import('../src/projects/projectService.ts');
  worker = await import('../src/worker/workerManager.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  collections = await import('../src/db/collections.ts');
  gitModule = await import('../src/projects/git.ts');
  hooksModule = await import('../src/terminal/projectCliHooks.ts');
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ---- helpers ----

/** A promise a test holds open, then releases (or rejects) at the moment it wants a seam to finish. */
function gate<T = void>() {
  let release!: (value: T) => void;
  let fail!: (error: Error) => void;
  const opened = new Promise<T>((resolve, reject) => { release = resolve; fail = reject; });
  let reachedResolve!: () => void;
  const reached = new Promise<void>((resolve) => { reachedResolve = resolve; });
  return { opened, release, fail, reached, markReached: () => reachedResolve() };
}

/** `live: false` reports every session as already closed, so finished runs never hold a concurrency slot in a test that starts many. */
function fakeTerminalHost(live = false): { host: TerminalSessionHost; starts: TerminalSessionStart[]; stops: string[]; failNextStart: (message: string) => void } {
  const starts: TerminalSessionStart[] = [];
  const stops: string[] = [];
  let failure: string | undefined;
  const host: TerminalSessionHost = {
    start(input) {
      if (failure) { const message = failure; failure = undefined; throw new Error(message); }
      starts.push(input);
    },
    attach: () => () => undefined,
    write() {},
    resize() {},
    stop(taskId) { stops.push(taskId); return true; },
    has: (taskId) => live && starts.some((start) => start.taskId === taskId) && !stops.includes(taskId),
    isAttached: () => false,
    count: () => 0,
  };
  return { host, starts, stops, failNextStart: (message) => { failure = message; } };
}

async function repoProject(name: string): Promise<ProjectRecord> {
  return service.createProject({ name, position: null, repositoryUrl: 'https://github.com/test/repo' });
}

async function item(project: ProjectRecord, title: string, planningRef?: { session: number; task: number }) {
  return planItemService.createPlanItem({ projectId: project.id, title, description: '', ...(planningRef ? { planningRef } : {}) });
}

const runOf = async (runId: string): Promise<WorkflowRunRecord> => (await collections.workflowRunsDb.get(runId))!;
const exists = (target: string) => access(target).then(() => true, () => false);
const branchExists = async (project: ProjectRecord, branch: string) => Boolean(await git(service.projectAbsolutePath(project), ['branch', '--list', branch]));
const stepStates = (run: WorkflowRunRecord) => run.startup!.steps.map((step) => `${step.id}:${step.state}`);

function manager(terminal: ReturnType<typeof fakeTerminalHost>, deps: Deps = {}): Manager {
  return worker.createWorkerManager({ terminalSessions: terminal.host, ...deps });
}

// ---- acceptance, naming and the step list ----

test('I01 a start returns after only the fast checks: slow worktree creation does not delay it, and the run reads "starting" with named steps', async () => {
  const project = await repoProject('Instant Accept');
  const terminal = fakeTerminalHost();
  const worktreeGate = gate();
  const m = manager(terminal, {
    addWorktreeForBranch: async (...args) => { worktreeGate.markReached(); await worktreeGate.opened; return gitModule.addWorktreeForBranch(...args); },
  });
  const accepted = await item(project, 'Slow setup');

  const run = await m.executePlanItem(accepted.id, {});
  assert.equal(run.status, 'starting');
  await worktreeGate.reached;
  const mid = await runOf(run.id);
  assert.deepEqual(stepStates(mid), ['name:done', 'worktree:running', 'hooks:pending', 'launch:pending']);
  assert.equal(mid.startup!.steps[1]!.name, 'Creating worktree');
  assert.equal(terminal.starts.length, 0, 'no agent yet');
  assert.equal((await planItemService.getPlanItem(accepted.id)).status, 'developing', 'already out of Planning');

  worktreeGate.release();
  await m.whenStartupSettled(run.id);
  const started = await runOf(run.id);
  assert.equal(started.status, 'running');
  assert.deepEqual(stepStates(started), ['name:done', 'worktree:done', 'hooks:done', 'launch:done']);
  assert.equal(started.currentStepId, started.workflowSnapshot.steps[0]!.id);
  assert.equal(terminal.starts[0]!.cwd, started.worktreePath);
  assert.ok(await exists(path.join(started.worktreePath!, '.claude')) || await exists(path.join(started.worktreePath!, '.codex')), 'CLI hook files are installed (I70)');
  await m.stopWorkflowRun(run.id);
});

test('I02/I03/I04/I05/I06 the branch is named from the task alone: <type>/<ref>-<slug>, the Workflow type wins, no ref gives <type>/<slug>, and clashes get -2, -3 — no model is ever called', async () => {
  const workflowService = await import('../src/catalog/workflowService.ts');
  await workflowService.createWorkflow({
    id: 'bugfix-typed', name: 'Bugfix Typed', description: 'Fixed type.', branchType: 'bugfix',
    steps: [{ id: 'fix', name: 'Fix', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Fix.' }],
  });
  const project = await repoProject('Naming');
  const terminal = fakeTerminalHost();
  const m = manager(terminal, {
    runClaudeTurn: async () => { throw new Error('a start must not run a model turn'); },
    runCodexTurn: async () => { throw new Error('a start must not run a model turn'); },
  });
  const numbered = await item(project, '5.004: Add thing', { session: 5, task: 4 });
  const typed = await item(project, 'Typed one');
  const manual = await item(project, 'Same title');
  const clash1 = await item(project, 'Same title');
  const clash2 = await item(project, 'Same title');
  const branches: string[] = [];
  for (const [planItem, workflowId] of [[numbered, undefined], [typed, 'bugfix-typed'], [manual, undefined], [clash1, undefined], [clash2, undefined]] as const) {
    const run = await m.executePlanItem(planItem.id, { workflowId });
    await m.whenStartupSettled(run.id);
    branches.push((await runOf(run.id)).branch!);
  }
  assert.deepEqual(branches, ['feature/5-004-add-thing', 'bugfix/typed-one', 'feature/same-title', 'feature/same-title-2', 'feature/same-title-3']);
});

// ---- pre-accept refusals ----

test('I09/I11/I15/I17 a refusal before acceptance leaves the item exactly where it was: no run, no worktree', async () => {
  const project = await repoProject('Refusals');
  const plain = await service.createProject({ name: 'Refusals Plain', position: null });
  const terminal = fakeTerminalHost();
  const m = manager(terminal);
  const planItem = await item(project, 'Refuse me');
  const before = await planItemService.getPlanItem(planItem.id);

  await assert.rejects(m.executePlanItem(planItem.id, { workflowId: 'no-such-workflow' }), (error: Error) => error.name === 'WorkflowNotFoundError');
  const plainItem = await item(plain, 'No repo');
  await assert.rejects(m.executePlanItem(plainItem.id, { createBranch: true }), (error: Error) => error.name === 'BranchRequiresRepositoryError');

  assert.deepEqual(await planItemService.getPlanItem(planItem.id), before);
  assert.deepEqual(await collections.workflowRunsDb.find((run) => run.projectId === project.id), []);
  assert.equal(await exists(service.projectWorktreePath(project, `run-${planItem.id}`)), false);
});

// ---- concurrency ----

test('I20/I60 the slot is claimed at acceptance: with the cap (6) held by starts still setting up, a seventh is refused; a launched run is counted once', async () => {
  const project = await repoProject('Cap Six');
  const terminal = fakeTerminalHost(true);
  const hooksGate = gate();
  let held = 0;
  const m = manager(terminal, { ensureCliHooks: async () => { held += 1; await hooksGate.opened; } });
  const items = await Promise.all(['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'].map((title) => item(project, title)));
  const runs = [];
  for (const planItem of items.slice(0, 6)) runs.push(await m.executePlanItem(planItem.id, {}));
  assert.deepEqual(runs.map((run) => run.status), Array(6).fill('starting'));
  await assert.rejects(m.executePlanItem(items[6]!.id, {}), (error: Error) => error.name === 'TaskConflictError');
  assert.equal((await planItemService.getPlanItem(items[6]!.id)).status, 'pending', 'the refused item keeps its place');

  hooksGate.release();
  await Promise.all(runs.map((run) => m.whenStartupSettled(run.id)));
  assert.equal(held, 6);
  assert.equal((await Promise.all(runs.map((run) => runOf(run.id)))).every((run) => run.status === 'running'), true);
  await assert.rejects(m.executePlanItem(items[6]!.id, {}), (error: Error) => error.name === 'TaskConflictError', 'six launched runs still fill the cap');

  await m.stopWorkflowRun(runs[0]!.id);
  const accepted = await m.executePlanItem(items[6]!.id, {});
  assert.equal(accepted.status, 'starting', 'a stopped run frees its slot');
  await m.whenStartupSettled(accepted.id);
  for (const run of [...runs.slice(1), accepted]) await m.stopWorkflowRun(run.id);
});

test('I62/I63 a repository-less project and createBranch:false show only the launch step and reach running', async () => {
  const plain = await service.createProject({ name: 'Launch Only Plain', position: null });
  const repo = await repoProject('Launch Only In Place');
  const terminal = fakeTerminalHost();
  const m = manager(terminal);
  for (const [project, options] of [[plain, {}], [repo, { createBranch: false }]] as const) {
    const run = await m.executePlanItem((await item(project, 'In place')).id, options);
    assert.deepEqual(run.startup!.steps.map((step) => step.id), ['launch']);
    assert.equal(run.worktreePath, undefined);
    await m.whenStartupSettled(run.id);
    const settled = await runOf(run.id);
    assert.equal(settled.status, 'running');
    assert.deepEqual(stepStates(settled), ['launch:done']);
    await m.stopWorkflowRun(run.id);
  }
});

test('I24/I66 each step transition is broadcast, and a read of the run mid-setup shows the same step list', async () => {
  const project = await repoProject('Events And Reload');
  const terminal = fakeTerminalHost();
  const worktreeGate = gate();
  const m = manager(terminal, { addWorktreeForBranch: async (...args) => { worktreeGate.markReached(); await worktreeGate.opened; return gitModule.addWorktreeForBranch(...args); } });
  const seen: string[] = [];
  m.onWorkerEvent((event) => { if (event.type === 'workflowRun') seen.push(`${event.run.status}:${event.run.startup?.steps.map((step) => step.state[0]).join('')}`); });
  const run = await m.executePlanItem((await item(project, 'Watched')).id, {});
  await worktreeGate.reached;
  const detail = await m.getWorkflowRunDetail(run.id);
  assert.deepEqual(stepStates(detail.run), ['name:done', 'worktree:running', 'hooks:pending', 'launch:pending']);
  assert.ok(seen.includes('starting:drpp'), 'the worktree step was announced as running');
  worktreeGate.release();
  await m.whenStartupSettled(run.id);
  assert.equal(seen.at(-1), 'running:dddd');
  assert.ok(seen.filter((entry) => entry.startsWith('starting')).length >= 4, 'one event per step transition');
  await m.stopWorkflowRun(run.id);
});

test('I49 stopping a run that is already stopped is refused as not actionable; a failed start can be stopped, and then resumes from its first step', async () => {
  const project = await repoProject('Stop Twice');
  const terminal = fakeTerminalHost();
  let fail = true;
  const m = manager(terminal, { ensureCliHooks: async () => { if (fail) throw new Error('flaky hooks'); } });
  const run = await m.executePlanItem((await item(project, 'Twice')).id, {});
  await m.whenStartupSettled(run.id);
  assert.equal((await runOf(run.id)).status, 'failed');
  assert.equal((await m.stopWorkflowRun(run.id)).status, 'stopped');
  await assert.rejects(m.stopWorkflowRun(run.id));
  fail = false;
  assert.equal((await m.resumeWorkflowRun(run.id)).status, 'starting');
  await m.whenStartupSettled(run.id);
  assert.equal((await runOf(run.id)).status, 'running');
  await m.stopWorkflowRun(run.id);
});

test('marking a task complete while it is still starting cancels the start-up and completes it without committing', async () => {
  const project = await repoProject('Complete While Starting');
  const terminal = fakeTerminalHost();
  const hooksGate = gate();
  const m = manager(terminal, { ensureCliHooks: async () => { hooksGate.markReached(); await hooksGate.opened; } });
  const planItem = await item(project, 'Done early');
  const run = await m.executePlanItem(planItem.id, {});
  await hooksGate.reached;
  const completing = m.completePlanItem(planItem.id);
  hooksGate.release();
  assert.equal((await completing).status, 'done');
  assert.equal((await runOf(run.id)).status, 'completed');
  assert.equal(terminal.starts.length, 0);
  assert.equal(await exists(service.projectWorktreePath(project, `run-${planItem.id}`)), false);
});

test('U38 the headless branch-naming machinery is gone from the code and the docs', async () => {
  const { readdir, readFile: read } = await import('node:fs/promises');
  const serverRoot = path.join(import.meta.dirname, '..');
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|md)$/.test(entry.name) && entry.name !== 'instantStart.test.ts') files.push(full);
    }
  };
  await walk(path.join(serverRoot, 'src'));
  await walk(path.join(serverRoot, 'tests'));
  for (const file of [path.join(serverRoot, '..', 'docs', 'architecture.md'), path.join(serverRoot, '..', 'docs', 'agent-analytics.md')]) files.push(file);
  for (const file of files) {
    assert.doesNotMatch(await read(file, 'utf8'), /branchNamer|generateBranchNameParts|BRANCH_NAMER_TIMEOUT|'Branch naming'|branch-naming session/, file);
  }
  assert.equal(await exists(path.join(serverRoot, 'src', 'worker', 'branchNamer.ts')), false);
});

test('I21/I22/I23 two starts on one Project do not wait for each other: both are accepted while the first is stuck in its worktree step, and both end with valid worktrees', async () => {
  const project = await repoProject('Two Starts');
  const terminal = fakeTerminalHost();
  const worktreeGate = gate();
  let first = true;
  const m = manager(terminal, {
    addWorktreeForBranch: async (...args) => {
      if (first) { first = false; worktreeGate.markReached(); await worktreeGate.opened; }
      return gitModule.addWorktreeForBranch(...args);
    },
  });
  const a = await item(project, 'Alpha');
  const b = await item(project, 'Beta');
  const runA = await m.executePlanItem(a.id, {});
  await worktreeGate.reached;
  const runB = await m.executePlanItem(b.id, {});
  assert.equal(runB.status, 'starting', 'the second was accepted while the first was still setting up');
  worktreeGate.release();
  await Promise.all([m.whenStartupSettled(runA.id), m.whenStartupSettled(runB.id)]);
  const [doneA, doneB] = await Promise.all([runOf(runA.id), runOf(runB.id)]);
  assert.deepEqual([doneA.status, doneB.status], ['running', 'running']);
  assert.notEqual(doneA.worktreePath, doneB.worktreePath);
  await git(service.projectAbsolutePath(project), ['fsck']);
  await m.stopWorkflowRun(runA.id);
  await m.stopWorkflowRun(runB.id);
});

test('a starting run holds one slot, so a second start in a repository Project runs beside it', async () => {
  const project = await repoProject('Queue Behind Starting');
  const terminal = fakeTerminalHost();
  const worktreeGate = gate();
  const m = manager(terminal, { addWorktreeForBranch: async (...args) => { worktreeGate.markReached(); await worktreeGate.opened; return gitModule.addWorktreeForBranch(...args); } });
  const first = await item(project, 'Holder');
  const second = await item(project, 'Queued');
  const run = await m.executePlanItem(first.id, {});
  await worktreeGate.reached;
  const queued = await m.enqueuePlanItemExecution(second.id, {});
  assert.equal(queued.started, true);
  worktreeGate.release();
  await m.whenStartupSettled(run.id);
  await m.stopWorkflowRun(run.id);
  if (queued.started) await m.stopWorkflowRun(queued.run.id);
});

// ---- the base branch ----

test('I26 every run branches from the Project\'s own branch, even when the previous task of its planning session is unmerged', async () => {
  const project = await repoProject('Base branch');
  const m = manager(fakeTerminalHost());
  const first = await item(project, 'First task', { session: 9, task: 1 });
  const firstRun = await m.executePlanItem(first.id, {});
  await m.whenStartupSettled(firstRun.id);
  const second = await item(project, 'Second task', { session: 9, task: 2 });
  const secondRun = await m.executePlanItem(second.id, {});
  await m.whenStartupSettled(secondRun.id);
  const settled = await runOf(secondRun.id);
  assert.equal(settled.status, 'running');
  assert.equal(settled.baseBranch, 'main');
  assert.notEqual(settled.baseBranch, (await runOf(firstRun.id)).branch);
  assert.equal('stackedOnRunId' in settled, false);
});

test('I34 a task with dependencies and one without both start from the Project\'s own branch', async () => {
  const project = await repoProject('Base branch dependent');
  const m = manager(fakeTerminalHost());
  const first = await item(project, 'Base', { session: 11, task: 1 });
  await m.whenStartupSettled((await m.executePlanItem(first.id, {})).id);
  const dependent = await item(project, 'Dependent', { session: 11, task: 2 });
  await collections.planItemsDb.update(dependent.id, { dependsOn: [first.id] });
  const plain = await item(project, 'Plain', { session: 12, task: 2 });
  for (const planItem of [dependent, plain]) {
    const run = await m.executePlanItem(planItem.id, {});
    await m.whenStartupSettled(run.id);
    assert.equal((await runOf(run.id)).baseBranch, 'main');
  }
});

test('I35 a start-up retried after the branch step keeps the base it persisted instead of reading the Project\'s branch again', async () => {
  const project = await repoProject('Persisted base');
  const projectDir = service.projectAbsolutePath(project);
  await git(projectDir, ['branch', 'persisted-base', 'main']);
  const wt = path.join(root, 'persisted-base-wt');
  await git(projectDir, ['worktree', 'add', wt, 'persisted-base']);
  await writeFile(path.join(wt, 'only-on-persisted-base.txt'), 'x');
  await git(wt, ['add', '.']); await git(wt, ['commit', '-m', 'persisted base commit']);
  await git(projectDir, ['worktree', 'remove', '--force', wt]);
  let failHooks = true;
  const m = manager(fakeTerminalHost(), { ensureCliHooks: async () => { if (failHooks) throw new Error('hooks boom'); } });
  const planItem = await item(project, 'Resumed start-up');
  const run = await m.executePlanItem(planItem.id, {});
  await m.whenStartupSettled(run.id);
  assert.equal((await runOf(run.id)).status, 'failed');
  assert.equal((await runOf(run.id)).baseBranch, 'main', 'the branch step persisted the base');

  await collections.workflowRunsDb.update(run.id, { baseBranch: 'persisted-base' });
  failHooks = false;
  await m.retryWorkflowStep(run.id);
  await m.whenStartupSettled(run.id);
  const retried = await runOf(run.id);
  assert.equal(retried.status, 'running');
  assert.equal(retried.baseBranch, 'persisted-base');
  assert.ok(await exists(path.join(retried.worktreePath!, 'only-on-persisted-base.txt')), 'the worktree was created from the persisted base');
  await m.stopWorkflowRun(run.id);
});

test('I36 a run saved before this change with a leftover stack step finishes starting without it', async () => {
  const project = await repoProject('Legacy startup');
  const m = manager(fakeTerminalHost());
  const run = await m.executePlanItem((await item(project, 'Legacy')).id, {});
  await m.whenStartupSettled(run.id);
  await m.stopWorkflowRun(run.id);
  const stopped = await runOf(run.id);
  const legacySteps = [{ id: 'stack', name: "Checking previous task's branch", state: 'pending' }, ...stopped.startup!.steps.map((step) => ({ ...step, state: 'pending' }))];
  await collections.workflowRunsDb.update(run.id, { startup: { ...stopped.startup!, steps: legacySteps } as unknown as typeof stopped.startup });
  await m.resumeWorkflowRun(run.id);
  await m.whenStartupSettled(run.id);
  const resumed = await runOf(run.id);
  assert.equal(resumed.status, 'running');
  assert.deepEqual(stepStates(resumed), ['name:done', 'worktree:done', 'hooks:done', 'launch:done']);
  await m.stopWorkflowRun(run.id);
});

// ---- failures ----

for (const failing of ['worktree', 'hooks', 'launch'] as const) {
  test(`I33/I34/I35/I36/I37/I39 a failure at the ${failing} step ends the run Failed with that step and reason, cleans up its worktree and branch, frees the slot, and notifies`, async () => {
    const project = await repoProject(`Failure ${failing}`);
    const terminal = fakeTerminalHost();
    const m = manager(terminal, {
      ...(failing === 'worktree' ? { addWorktreeForBranch: async () => { throw new Error(`worktree boom in ${service.projectAbsolutePath(project)}`); } } : {}),
      ...(failing === 'hooks' ? { ensureCliHooks: async () => { throw new Error('hooks boom'); } } : {}),
    });
    if (failing === 'launch') terminal.failNextStart('launch boom');
    const planItem = await item(project, `Fails at ${failing}`);
    const run = await m.executePlanItem(planItem.id, {});
    await m.whenStartupSettled(run.id);

    const failed = await runOf(run.id);
    assert.equal(failed.status, 'failed');
    const step = failed.startup!.steps.find((s) => s.state === 'failed')!;
    assert.equal(step.id, failing);
    assert.match(step.reason!, new RegExp(`${failing} boom`));
    assert.ok(!step.reason!.includes(root), 'no absolute path in a reason');
    assert.equal(await exists(service.projectWorktreePath(project, `run-${planItem.id}`)), false, 'no partial worktree');
    assert.equal(await branchExists(project, 'feature/fails-at-' + failing), false, 'no partial branch');
    assert.equal(failed.branch, undefined);
    assert.deepEqual((await collections.tasksDb.find((task) => task.workflowRunId === run.id)), [], 'no first-step Task left behind');
    const projectAfter = await service.getProject(project.id);
    assert.deepEqual(projectAfter.activeTaskIds ?? [], []);
    assert.equal(projectAfter.taskCount, 0);
    assert.equal((await planItemService.getPlanItem(planItem.id)).status, 'failed', 'not silently back in Planning');
    const raised = await collections.notificationsDb.find((n) => n.subject.type === 'project' && n.subject.projectId === project.id);
    assert.ok(raised.some((n) => /failed to start/i.test(n.title)));

    // The slot is free again and Retry sets the same run up from its first step.
    const other = await item(project, `Other ${failing}`);
    const otherRun = await m.executePlanItem(other.id, {});
    assert.equal(otherRun.status, 'starting');
    await m.whenStartupSettled(otherRun.id);
    await m.stopWorkflowRun(otherRun.id);
    const retried = await m.retryWorkflowStep(run.id);
    assert.equal(retried.status, 'starting');
    await m.whenStartupSettled(run.id);
    const afterRetry = await runOf(run.id);
    if (failing === 'worktree' || failing === 'hooks') assert.equal(afterRetry.status, 'failed', 'still failing the same way');
    else assert.equal(afterRetry.status, 'running');
  });
}

test('I40 a cleanup that itself fails keeps the original reason and still ends the run Failed', async () => {
  const project = await repoProject('Cleanup Fails');
  const terminal = fakeTerminalHost();
  const m = manager(terminal, {
    ensureCliHooks: async () => { throw new Error('hooks first'); },
    removeWorktree: async () => { throw new Error('cannot remove'); },
  });
  const run = await m.executePlanItem((await item(project, 'Stubborn')).id, {});
  await m.whenStartupSettled(run.id);
  const failed = await runOf(run.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.startup!.steps.find((s) => s.state === 'failed')!.reason, 'hooks first');
});

// ---- stop during starting ----

for (const gated of ['worktree', 'hooks'] as const) {
  test(`I43/I44/I48 Stop while the ${gated} step is in flight stops the run at once; the step that resolves afterwards never flips it back to running and leaves nothing behind`, async () => {
    const project = await repoProject(`Stop at ${gated}`);
    const terminal = fakeTerminalHost();
    const stepGate = gate();
    const m = manager(terminal, {
      ...(gated === 'worktree' ? { addWorktreeForBranch: async (...args: Parameters<typeof gitModule.addWorktreeForBranch>) => { stepGate.markReached(); await stepGate.opened; return gitModule.addWorktreeForBranch(...args); } } : {}),
      ...(gated === 'hooks' ? { ensureCliHooks: async (target: string) => { stepGate.markReached(); await stepGate.opened; return hooksModule.ensureProjectCliHooks(target); } } : {}),
    });
    const planItem = await item(project, `Stop ${gated}`);
    const run = await m.executePlanItem(planItem.id, {});
    await stepGate.reached;

    const stopped = await m.stopWorkflowRun(run.id);
    assert.equal(stopped.status, 'stopped');
    assert.equal((await planItemService.getPlanItem(planItem.id)).status, 'blocked');
    stepGate.release();
    await m.whenStartupSettled(run.id);

    const final = await runOf(run.id);
    assert.equal(final.status, 'stopped');
    assert.equal(terminal.starts.length, 0, 'the agent was never launched');
    assert.equal(await exists(service.projectWorktreePath(project, `run-${planItem.id}`)), false);
    assert.equal(await branchExists(project, `feature/stop-${gated}`), false);
    assert.deepEqual(stepStates(final).filter((s) => !s.endsWith(':pending')), [], 'ready to run again from its first step');
    assert.deepEqual(await collections.tasksDb.find((task) => task.workflowRunId === run.id), []);

    // Resume sets it up fresh, and the slot was never held by the stopped attempt.
    const resumed = await m.resumeWorkflowRun(run.id);
    assert.equal(resumed.status, 'starting');
    await m.whenStartupSettled(run.id);
    assert.equal((await runOf(run.id)).status, 'running');
    await m.stopWorkflowRun(run.id);
  });
}

test('I41 Stop while the worktree is being created returns at once and the start-up ends without a worktree', async () => {
  const project = await repoProject('Stop At Worktree');
  const creating = gate();
  const m = manager(fakeTerminalHost(), { addWorktreeForBranch: async (...args) => { creating.markReached(); await creating.opened; return gitModule.addWorktreeForBranch(...args); } });
  const next = await item(project, 'Next');
  const run = await m.executePlanItem(next.id, {});
  await creating.reached;
  await m.stopWorkflowRun(run.id);
  creating.release();
  await m.whenStartupSettled(run.id);
  assert.equal((await runOf(run.id)).status, 'stopped');
  assert.equal(await exists(service.projectWorktreePath(project, `run-${next.id}`)), false);
});

test('I46 Stop after the agent launched behaves as stopping a running run: its worktree is kept so it can be resumed', async () => {
  const project = await repoProject('Stop After Launch');
  const terminal = fakeTerminalHost();
  const m = manager(terminal);
  const run = await m.executePlanItem((await item(project, 'Launched')).id, {});
  await m.whenStartupSettled(run.id);
  await m.stopWorkflowRun(run.id);
  const stopped = await runOf(run.id);
  assert.equal(stopped.status, 'stopped');
  assert.ok(await exists(stopped.worktreePath!));
  assert.equal(terminal.stops.length, 1);
});

// ---- restart recovery ----

test('I50/I51/I52 a run found "starting" after a restart needs attention with its partial setup removed; other runs are untouched; Retry sets it up again', async () => {
  const project = await repoProject('Restart Recovery');
  const terminal = fakeTerminalHost();
  const planItem = await item(project, 'Interrupted');
  const stuckGate = gate();
  const dying = manager(terminal, { ensureCliHooks: async () => { stuckGate.markReached(); await stuckGate.opened; } });
  const run = await dying.executePlanItem(planItem.id, {});
  await stuckGate.reached;
  const partial = await runOf(run.id);
  assert.ok(await exists(partial.worktreePath!), 'the worktree was created before the daemon died');

  const restarted = manager(fakeTerminalHost());
  await restarted.resumeInterruptedTasks();
  const recovered = await runOf(run.id);
  assert.equal(recovered.status, 'needs-attention');
  assert.match(recovered.attentionReason!, /daemon restarted while this task was starting/);
  assert.equal(recovered.startup!.steps.find((s) => s.state === 'failed')!.id, 'hooks');
  assert.equal(await exists(partial.worktreePath!), false, 'the partial worktree is cleaned, never reused');
  assert.equal(await branchExists(project, partial.branch ?? 'feature/interrupted'), false);

  const retried = await restarted.retryWorkflowStep(run.id);
  assert.equal(retried.status, 'starting');
  await restarted.whenStartupSettled(run.id);
  assert.equal((await runOf(run.id)).status, 'running');
  await restarted.stopWorkflowRun(run.id);
  stuckGate.release();
  await dying.whenStartupSettled(run.id);
});

test('I53 a run record from before the Starting phase has no start-up field and reads as it did', async () => {
  const project = await repoProject('Legacy Run');
  const terminal = fakeTerminalHost();
  const m = manager(terminal);
  const run = await m.executePlanItem((await item(project, 'Legacy')).id, {});
  await m.whenStartupSettled(run.id);
  const stored = await runOf(run.id);
  const { startup: _startup, ...legacy } = stored;
  await collections.workflowRunsDb.delete(stored.id);
  await collections.workflowRunsDb.insert(legacy as WorkflowRunRecord);
  const reread = await m.getWorkflowRun(run.id);
  assert.equal(reread.status, 'running');
  await m.stopWorkflowRun(run.id);
});

test('I56 a notification for a failed start is resolved when its Retry begins', async () => {
  const project = await repoProject('Notification Resolved');
  const terminal = fakeTerminalHost();
  let fail = true;
  const m = manager(terminal, { ensureCliHooks: async () => { if (fail) throw new Error('hooks flake'); } });
  const run = await m.executePlanItem((await item(project, 'Flaky')).id, {});
  await m.whenStartupSettled(run.id);
  const open = () => collections.notificationsDb.find((n) => n.subject.type === 'project' && n.subject.projectId === project.id && !n.resolvedAt);
  assert.equal((await open()).length, 1);
  fail = false;
  await m.retryWorkflowStep(run.id);
  await m.whenStartupSettled(run.id);
  assert.equal((await open()).length, 0);
  assert.equal((await readFile(path.join((await runOf(run.id)).worktreePath!, 'README.md'), 'utf8')), 'existing code');
  await m.stopWorkflowRun(run.id);
});

// ---- the pull request base ----
/** Puts a `gh` on PATH that logs its arguments, answers `pr view` with nothing and `pr create` with a URL. */
async function installFakeGh(): Promise<{ calls: () => Promise<string[]>; restore: () => void }> {
  const bin = path.join(root, 'fake-gh-bin');
  const log = path.join(root, 'fake-gh.log');
  await mkdir(bin, { recursive: true });
  await writeFile(log, '');
  await writeFile(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${log}'\ncase "$2" in view) exit 1;; create) echo https://github.com/test/repo/pull/1;; esac\n`, { mode: 0o755 });
  const original = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${original}`;
  return { calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean), restore: () => { process.env.PATH = original; } };
}
/** Approves a running run at its end, which runs the Complete stage (commit, push, pull request). */
async function finish(runId: string, m: Manager): Promise<void> {
  await collections.workflowRunsDb.update(runId, { status: 'awaiting-approval', currentStepId: null });
  await m.approveWorkflowRun(runId);
}

const completionManager = (terminal: ReturnType<typeof fakeTerminalHost>) => manager(terminal, { runClaudeTurn: async () => { throw new Error('no model in tests'); } });
test('I80 a finished task opens its pull request against the Project\'s own branch, never the previous task\'s branch', async () => {
  const fakeGh = await installFakeGh();
  try {
    const project = await repoProject('PR base');
    const m = completionManager(fakeTerminalHost());
    const first = await item(project, 'PR first', { session: 20, task: 1 });
    await m.whenStartupSettled((await m.executePlanItem(first.id, {})).id);
    const second = await item(project, 'PR second', { session: 20, task: 2 });
    const run = await m.executePlanItem(second.id, {});
    await m.whenStartupSettled(run.id);
    await finish(run.id, m);
    const create = (await fakeGh.calls()).find((line) => line.startsWith('pr create'));
    assert.match(create ?? '', /--base main --head /);
    assert.equal((await runOf(run.id)).prUrl, 'https://github.com/test/repo/pull/1');
  } finally {
    fakeGh.restore();
  }
});

test('I81 a run saved before stacking was removed still opens its pull request against its stored base branch', async () => {
  const fakeGh = await installFakeGh();
  try {
    const project = await repoProject('PR legacy base');
    const m = completionManager(fakeTerminalHost());
    const planItem = await item(project, 'PR legacy');
    const run = await m.executePlanItem(planItem.id, {});
    await m.whenStartupSettled(run.id);
    await collections.workflowRunsDb.update(run.id, { baseBranch: 'feature/old-parent', stackedOnRunId: 'gone' } as Partial<WorkflowRunRecord>);
    await finish(run.id, m);
    assert.match((await fakeGh.calls()).find((line) => line.startsWith('pr create')) ?? '', /--base feature\/old-parent --head /);
  } finally {
    fakeGh.restore();
  }
});
