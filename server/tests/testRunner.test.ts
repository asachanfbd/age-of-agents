import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import type { ProjectRecord, TaskRecord, TestRunRecord } from '../src/domain/types.ts';
import type { TestRunEvent, TestRunnerDeps } from '../src/testing/testRunner.ts';
import { createFakeHarness, JUNIT_FAIL, JUNIT_PASS, sampleConfig, waitUntil } from './helpers/testRunFakes.ts';
import { MAX_LOG_HEAD_CHARS, MAX_LOG_TAIL_CHARS } from '../src/testing/runLog.ts';

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let runnerModule: typeof import('../src/testing/testRunner.ts');
let collections: typeof import('../src/db/collections.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'test-runner-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  projectService = await import('../src/projects/projectService.ts');
  runnerModule = await import('../src/testing/testRunner.ts');
  collections = await import('../src/db/collections.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

let projectCount = 0;

async function writeConfig(root: string, config: unknown): Promise<void> {
  await mkdir(path.join(root, '.docs', 'testing'), { recursive: true });
  await writeFile(path.join(root, '.docs', 'testing', 'config.json'), JSON.stringify(config));
}

async function setup(overrides: Partial<TestRunnerDeps> = {}, config: unknown = sampleConfig()) {
  const project = await projectService.createProject({ name: `Runner Project ${(projectCount += 1)}`, position: null });
  const root = projectService.projectAbsolutePath(project);
  await writeConfig(root, config);
  const harness = createFakeHarness(overrides);
  const runner = runnerModule.createTestRunner(harness.deps);
  const events: TestRunEvent[] = [];
  runner.onTestEvent((event) => events.push(event));
  const settled = (runId: string) => waitUntil(() => events.some((e) => e.type === 'testRun' && e.run.id === runId && !runnerModule.isActive(e.run)
    && e.run.artifactDir === null && e.run.completedAt !== null && (e.run.status !== 'stopped' || e.run.durationMs !== null)));
  return { project, root, harness, runner, events, settled };
}

async function insertTask(project: ProjectRecord, patch: Partial<TaskRecord> = {}): Promise<TaskRecord> {
  const task = { id: `task-${Math.random().toString(36).slice(2)}`, projectId: project.id, status: 'developing', ...patch } as TaskRecord;
  await collections.tasksDb.insert(task);
  return task;
}

test('a result action runs in its working directory with the artifact env var, parses its report and cleans up', async () => {
  const { project, root, harness, runner, events, settled } = await setup();
  const queued = await runner.enqueueAction(project.id, 'unit', 'run');
  assert.equal(queued.trigger, 'manual');
  assert.equal(queued.taskId, null);
  assert.equal(queued.executionRoot, root);
  assert.equal(queued.suite.label, 'Unit tests');

  const child = await harness.nextProcess();
  assert.equal(child.command, 'npm test');
  assert.equal(child.cwd, path.join(root, 'packages/api'));
  assert.equal(child.artifactDir, harness.createdDirs[0]);
  child.write('running tests\n');
  child.write('warn\n', 'stderr');
  harness.writeArtifact(child, 'junit.xml', JUNIT_PASS);
  child.exit(0);
  await settled(queued.id);

  const run = await runner.getTestRun(queued.id);
  assert.equal(run.status, 'passed');
  assert.equal(run.exitCode, 0);
  assert.equal(run.branch, 'main');
  assert.equal(run.commit, 'abc123');
  assert.equal(run.cwd, path.join(root, 'packages/api'));
  assert.equal(run.output, 'running tests\nwarn\n');
  assert.deepEqual(run.result?.counts, { total: 2, passed: 2, failed: 0, errored: 0, skipped: 0 });
  // The record itself only carries the small summary; the full result and log are in the run's files.
  const record = await collections.testRunsDb.get(queued.id);
  assert.equal(record?.summary?.outcome, 'passed');
  assert.deepEqual(record?.summary?.counts, run.result?.counts);
  assert.equal(record && ('output' in record || 'result' in record), false);
  assert.ok(run.startedAt && run.completedAt && run.durationMs !== null);
  assert.equal(run.artifactDir, null);
  assert.deepEqual(harness.removedDirs, harness.createdDirs);

  const statuses = events.filter((e): e is Extract<TestRunEvent, { type: 'testRun' }> => e.type === 'testRun' && e.run.id === queued.id).map((e) => e.run.status);
  assert.deepEqual(statuses, ['queued', 'running', 'passed']);
  assert.deepEqual(events.filter((e) => e.type === 'testRunLog').map((e) => (e as { chunk: string }).chunk), ['running tests\n', 'warn\n']);
});

test('a failing report keeps both the nonzero exit code and the normalized failure', async () => {
  const { project, harness, runner, settled } = await setup();
  const queued = await runner.enqueueAction(project.id, 'unit', 'run');
  const child = await harness.nextProcess();
  harness.writeArtifact(child, 'junit.xml', JUNIT_FAIL);
  child.exit(1);
  await settled(queued.id);
  const run = await runner.getTestRun(queued.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 1);
  assert.equal(run.result?.outcome, 'failed');
  assert.equal(run.result?.cases.find((c) => c.name === 'divides')?.message, 'expected 2, got 3');
  assert.deepEqual(run.diagnostics, []);
});

test('a missing or malformed required artifact makes the run an error', async () => {
  const { project, harness, runner, settled } = await setup();
  const missing = await runner.enqueueAction(project.id, 'unit', 'run');
  (await harness.nextProcess()).exit(0);
  await settled(missing.id);
  const missingRun = await runner.getTestRun(missing.id);
  assert.equal(missingRun.status, 'error');
  assert.equal(missingRun.diagnostics[0]?.code, 'artifact-missing');
  assert.equal(missingRun.diagnostics[0]?.collectorId, 'cases');

  const malformed = await runner.enqueueAction(project.id, 'unit', 'run');
  const child = await harness.nextProcess();
  harness.writeArtifact(child, 'junit.xml', '<html>not junit</html>');
  child.exit(0);
  await settled(malformed.id);
  const malformedRun = await runner.getTestRun(malformed.id);
  assert.equal(malformedRun.status, 'error');
  assert.equal(malformedRun.diagnostics[0]?.code, 'artifact-malformed');
  assert.equal(harness.removedDirs.length, 2);
});

test('a passing report with a nonzero exit is failed with an exit-code-mismatch diagnostic', async () => {
  const { project, harness, runner, settled } = await setup();
  const queued = await runner.enqueueAction(project.id, 'unit', 'run');
  const child = await harness.nextProcess();
  harness.writeArtifact(child, 'junit.xml', JUNIT_PASS);
  child.exit(2);
  await settled(queued.id);
  const run = await runner.getTestRun(queued.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.result?.outcome, 'passed');
  assert.equal(run.diagnostics[0]?.code, 'exit-code-mismatch');
});

test('an action with no collectors is judged by its exit code and has no result', async () => {
  const { project, harness, runner, settled } = await setup();
  const ok = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(0);
  await settled(ok.id);
  assert.equal((await runner.getTestRun(ok.id)).status, 'passed');
  const bad = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(3);
  await settled(bad.id);
  const run = await runner.getTestRun(bad.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 3);
  assert.equal(run.result, null);
});

test('a spawn failure is an error run and the queue moves on', async () => {
  const { project, harness, runner, settled } = await setup();
  const first = await runner.enqueueAction(project.id, 'lint', 'check');
  const second = await runner.enqueueAction(project.id, 'unit', 'run');
  const child = await harness.nextProcess();
  child.fail(new Error('spawn sh ENOENT'));
  child.exit(-2); // Node may also emit close after error; it must not settle the run twice.
  await settled(first.id);
  const run = await runner.getTestRun(first.id);
  assert.equal(run.status, 'error');
  assert.equal(run.diagnostics[0]?.code, 'spawn-failed');
  assert.match(run.diagnostics[0]!.message, /ENOENT/);
  const next = await harness.nextProcess();
  assert.equal(next.command, 'npm test');
  next.exit(0);
  await settled(second.id);
});

test('a utility action records its log and status but never replaces the latest result', async () => {
  const { project, harness, runner, settled } = await setup();
  const result = await runner.enqueueAction(project.id, 'unit', 'run');
  const child = await harness.nextProcess();
  harness.writeArtifact(child, 'junit.xml', JUNIT_PASS);
  child.exit(0);
  await settled(result.id);

  const utility = await runner.enqueueAction(project.id, 'unit', 'snapshots');
  assert.equal(utility.action.purpose, 'utility');
  const utilityChild = await harness.nextProcess();
  utilityChild.write('updated 3 snapshots\n');
  utilityChild.exit(1);
  await settled(utility.id);
  const utilityRun = await runner.getTestRun(utility.id);
  assert.equal(utilityRun.status, 'failed');
  assert.equal(utilityRun.result, null);
  assert.equal(utilityRun.output, 'updated 3 snapshots\n');

  const overview = await runner.getOverview(project.id);
  const unit = overview.suites.find((s) => s.id === 'unit')!;
  assert.equal(unit.latestResult?.id, result.id);
  assert.equal(unit.actions.find((a) => a.id === 'run')?.latestResult?.id, result.id);
  const snapshots = unit.actions.find((a) => a.id === 'snapshots')!;
  assert.equal(snapshots.latestResult, null);
  assert.equal(snapshots.latestRun?.id, utility.id);
  assert.equal('output' in snapshots.latestRun!, false);
});

test('actions on one project run one at a time, in queue order', async () => {
  const { project, harness, runner, settled } = await setup();
  const a = await runner.enqueueAction(project.id, 'unit', 'run');
  const b = await runner.enqueueAction(project.id, 'lint', 'check');
  const first = await harness.nextProcess();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.processes.length, 1, 'the second action must wait for the first');
  assert.equal((await runner.getTestRun(b.id)).status, 'queued');

  const overview = await runner.getOverview(project.id);
  assert.deepEqual(overview.queue.map((r) => r.id), [a.id, b.id]);
  assert.equal(overview.suites.find((s) => s.id === 'lint')?.actions[0]?.activeRun?.id, b.id);

  harness.writeArtifact(first, 'junit.xml', JUNIT_PASS);
  first.exit(0);
  const second = await harness.nextProcess();
  assert.equal(second.command, 'npm run lint');
  second.exit(0);
  await settled(b.id);
  assert.equal((await runner.getTestRun(a.id)).status, 'passed');
});

test('Run all queues every enabled suite primary action in config order as one batch and continues after a failure', async () => {
  const { project, harness, runner, settled } = await setup();
  const batch = await runner.enqueueRunAll(project.id);
  assert.deepEqual(batch.runs.map((r) => `${r.suite.id}/${r.action.id}`), ['unit/run', 'lint/check', 'security/scan']);
  assert.ok(batch.runs.every((r) => r.batchId === batch.batchId));
  assert.deepEqual(batch.skipped, []);

  const unit = await harness.nextProcess();
  harness.writeArtifact(unit, 'junit.xml', JUNIT_FAIL);
  unit.exit(1);
  (await harness.nextProcess()).exit(1);
  const security = await harness.nextProcess();
  harness.writeArtifact(security, 'out/semgrep.sarif', JSON.stringify({ runs: [{ results: [{ ruleId: 'x', level: 'note', message: { text: 'minor' } }] }] }));
  security.exit(0);
  await settled(batch.runs[2]!.id);

  const statuses = await Promise.all(batch.runs.map(async (r) => (await runner.getTestRun(r.id)).status));
  assert.deepEqual(statuses, ['failed', 'failed', 'passed']);
  const page = await runner.listTestRuns(project.id, { status: 'failed' });
  assert.equal(page.total, 2);
});

test('duplicate queued/running copies of an action are refused, and Run all skips them', async () => {
  const { project, harness, runner, settled } = await setup();
  const first = await runner.enqueueAction(project.id, 'lint', 'check');
  await assert.rejects(runner.enqueueAction(project.id, 'lint', 'check'), runnerModule.TestRunAlreadyActiveError);
  // Concurrent requests must not both slip past the duplicate check.
  const results = await Promise.allSettled([runner.enqueueAction(project.id, 'unit', 'run'), runner.enqueueAction(project.id, 'unit', 'run')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);

  const unit = results.find((r) => r.status === 'fulfilled')!.value;
  const joined = await runner.enqueueAction(project.id, 'lint', 'check', { joinActive: true });
  assert.equal(joined.id, first.id, 'joinActive returns the active copy instead of refusing');

  const batch = await runner.enqueueRunAll(project.id);
  assert.deepEqual(batch.skipped, [{ suiteId: 'unit', actionId: 'run', runId: unit.id }, { suiteId: 'lint', actionId: 'check', runId: first.id }]);
  assert.deepEqual(batch.runs.map((r) => r.suite.id), ['security']);

  const lint = await harness.nextProcess();
  lint.exit(0);
  await settled(first.id);
  // Once finished, the same action can be queued again.
  const again = await runner.enqueueAction(project.id, 'lint', 'check');
  assert.equal(again.status, 'queued');
});

test('Run all refuses when nothing can be queued', async () => {
  const { project, runner } = await setup({}, { schemaVersion: 1, suites: [{ ...sampleConfig().suites[2], enabled: false }] });
  await assert.rejects(runner.enqueueRunAll(project.id), runnerModule.NoRunnableSuitesError);
});

test('an agent run executes in its Task worktree, records the branch and links the Task', async () => {
  const { project, root, harness, runner, settled } = await setup();
  const worktree = path.join(projectService.projectWorktreesRoot(project), 'task-wt');
  await writeConfig(worktree, sampleConfig());
  const task = await insertTask(project, { worktreePath: worktree });

  const manual = await runner.enqueueAction(project.id, 'lint', 'check');
  // Same action, different working tree: allowed alongside the manual copy.
  const agent = await runner.enqueueAction(project.id, 'lint', 'check', { taskId: task.id });
  assert.equal(agent.trigger, 'agent');
  assert.equal(agent.taskId, task.id);
  assert.equal(agent.executionRoot, worktree);

  const manualChild = await harness.nextProcess();
  assert.equal(manualChild.cwd, root);
  manualChild.exit(0);
  const agentChild = await harness.nextProcess();
  assert.equal(agentChild.cwd, worktree);
  agentChild.exit(0);
  await settled(agent.id);
  assert.equal((await runner.getTestRun(agent.id)).branch, 'task-branch');

  // The overview's active/primary view is the Project's own working tree.
  const noWorktree = await insertTask(project);
  const primary = await runner.enqueueAction(project.id, 'lint', 'check', { taskId: noWorktree.id });
  assert.equal(primary.executionRoot, root);
  (await harness.nextProcess()).exit(0);
  await settled(primary.id);
});

test('an agent run for an unknown Task or a Task of another project is refused', async () => {
  const { project, runner } = await setup();
  const other = await setup();
  const foreign = await insertTask(other.project);
  await assert.rejects(runner.enqueueAction(project.id, 'lint', 'check', { taskId: 'missing' }), runnerModule.TestRunTaskError);
  await assert.rejects(runner.enqueueAction(project.id, 'lint', 'check', { taskId: foreign.id }), runnerModule.TestRunTaskError);
});

test('enqueueing validates the config, suite and action', async () => {
  const { project, root, runner } = await setup();
  await assert.rejects(runner.enqueueAction(project.id, 'nope', 'run'), runnerModule.TestActionNotFoundError);
  await assert.rejects(runner.enqueueAction(project.id, 'unit', 'nope'), runnerModule.TestActionNotFoundError);
  await assert.rejects(runner.enqueueAction(project.id, 'e2e', 'run'), runnerModule.TestActionDisabledError);
  await rm(path.join(root, '.docs', 'testing'), { recursive: true });
  await assert.rejects(runner.enqueueAction(project.id, 'unit', 'run'), /no testing config/);
  await writeConfig(root, { schemaVersion: 9 });
  await assert.rejects(runner.enqueueAction(project.id, 'unit', 'run'), /invalid/);
  await assert.rejects(runner.enqueueAction('no-such-project', 'unit', 'run'), projectService.ProjectNotFoundError);
  const overview = await runner.getOverview(project.id);
  assert.equal(overview.config.state, 'invalid');
  assert.deepEqual(overview.suites, []);
});

test('config is re-read when a queued run starts; a vanished action errors instead of running', async () => {
  const { project, root, harness, runner, settled } = await setup();
  const blocker = await runner.enqueueAction(project.id, 'lint', 'check');
  const queued = await runner.enqueueAction(project.id, 'unit', 'run');
  const config = sampleConfig();
  config.suites[0]!.actions[0]!.label = 'Renamed unit tests';
  config.suites[0]!.actions[0]!.command = 'npm run test:new';
  await writeConfig(root, config);
  const lint = await harness.nextProcess();
  lint.exit(0);
  const unit = await harness.nextProcess();
  assert.equal(unit.command, 'npm run test:new');
  const running = await runner.getTestRun(queued.id);
  assert.equal(running.action.label, 'Renamed unit tests');
  harness.writeArtifact(unit, 'junit.xml', JUNIT_PASS);
  unit.exit(0);
  await settled(queued.id);
  await settled(blocker.id);

  const blocker2 = await runner.enqueueAction(project.id, 'lint', 'check');
  const doomed = await runner.enqueueAction(project.id, 'unit', 'run');
  config.suites.shift();
  await writeConfig(root, config);
  (await harness.nextProcess()).exit(0);
  await settled(blocker2.id);
  await settled(doomed.id);
  const run = await runner.getTestRun(doomed.id);
  assert.equal(run.status, 'error');
  assert.equal(run.diagnostics[0]?.code, 'config-unavailable');
  assert.equal(run.startedAt, null);
  // History stays readable from the snapshot even though the suite is gone from the config.
  assert.equal(run.suite.label, 'Unit tests');
  assert.equal(harness.processes.length, 3);
});

test('a working directory that escapes the execution root through a symlink is refused', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'test-runner-outside-'));
  const config = { schemaVersion: 1, suites: [{ id: 'x', label: 'X', kind: 'unit', primaryActionId: 'run', actions: [{ id: 'run', label: 'Run', command: 'true', workingDirectory: 'link' }] }] };
  const { project, root, harness, runner, settled } = await setup({}, config);
  await symlink(outside, path.join(root, 'link'));
  const queued = await runner.enqueueAction(project.id, 'x', 'run');
  await settled(queued.id);
  const run = await runner.getTestRun(queued.id);
  assert.equal(run.status, 'error');
  assert.equal(run.diagnostics[0]?.code, 'unsafe-working-directory');
  assert.equal(harness.processes.length, 0);
  await rm(outside, { recursive: true, force: true });
});

test('stopping a running run kills it, marks it stopped, cleans up and starts the next one', async () => {
  const { project, harness, runner, settled } = await setup();
  const running = await runner.enqueueAction(project.id, 'unit', 'run');
  const next = await runner.enqueueAction(project.id, 'lint', 'check');
  const child = await harness.nextProcess();
  child.write('partial output\n');

  await assert.rejects(runner.stopTestRun(next.id), runnerModule.TestRunNotRunningError);
  const stopped = await runner.stopTestRun(running.id);
  assert.equal(stopped.status, 'stopped');
  assert.ok(child.killed);
  await settled(running.id);
  const run = await runner.getTestRun(running.id);
  assert.equal(run.status, 'stopped');
  assert.equal(run.output, 'partial output\n');
  assert.equal(run.result, null);
  assert.deepEqual(harness.removedDirs, [harness.createdDirs[0]]);

  const lint = await harness.nextProcess();
  lint.exit(0);
  await settled(next.id);
  // Stopping a finished run is a no-op that returns it.
  assert.equal((await runner.stopTestRun(next.id)).status, 'passed');
  // A stopped run has no verdict, so it is never the latest result.
  const overview = await runner.getOverview(project.id);
  assert.equal(overview.suites[0]?.latestResult, null);
  assert.equal(overview.suites[0]?.actions[0]?.latestRun?.status, 'stopped');
});

test('a stop that lands while a run is still starting keeps it stopped and never spawns', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gated = true;
  const { project, harness, runner, settled } = await setup({
    async gitInfo() { if (gated) await gate; return { branch: null, commit: null }; },
  });
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  const next = await runner.enqueueAction(project.id, 'unit', 'snapshots');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopped = await runner.stopTestRun(queued.id);
  assert.equal(stopped.status, 'stopped');
  gated = false;
  release();
  // The queue only moves on once the stopped run is fully finalized.
  const child = await harness.nextProcess();
  assert.equal(child.command, 'npm test -- -u');
  const run = await runner.getTestRun(queued.id);
  assert.equal(run.status, 'stopped');
  assert.equal(run.startedAt, null);
  assert.equal(run.artifactDir, null);
  assert.deepEqual(harness.removedDirs, [harness.createdDirs[0]]);
  child.exit(0);
  await settled(next.id);
});

test('removing a queued run deletes it without running it; running runs cannot be removed', async () => {
  const { project, harness, runner, events, settled } = await setup();
  const running = await runner.enqueueAction(project.id, 'unit', 'run');
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  const child = await harness.nextProcess();
  await runner.removeQueuedRun(queued.id);
  assert.ok(events.some((e) => e.type === 'testRunRemoved' && e.runId === queued.id && e.projectId === project.id));
  await assert.rejects(runner.getTestRun(queued.id), runnerModule.TestRunNotFoundError);
  await assert.rejects(runner.removeQueuedRun(running.id), runnerModule.TestRunNotQueuedError);
  await assert.rejects(runner.removeQueuedRun('missing'), runnerModule.TestRunNotFoundError);
  harness.writeArtifact(child, 'junit.xml', JUNIT_PASS);
  child.exit(0);
  await settled(running.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.processes.length, 1);
});

test('restart recovery closes out orphaned queued/running runs as interrupted errors', async () => {
  const { project, harness, runner } = await setup();
  const base = (await runner.enqueueAction(project.id, 'lint', 'check'));
  const child = await harness.nextProcess();
  // Simulate a record left behind by a previous daemon process.
  const orphan: TestRunRecord = { ...base, id: 'orphan-running', status: 'running', artifactDir: '/fake-artifacts/orphan' };
  await collections.testRunsDb.insert(orphan);
  await collections.testRunsDb.insert({ ...base, id: 'orphan-queued', status: 'queued', artifactDir: null });
  child.exit(0);
  await waitUntil(async () => (await runner.getTestRun(base.id)).status === 'passed');

  const fresh = runnerModule.createTestRunner(harness.deps);
  // At least these two — recovery is daemon-wide, and earlier tests may have left queued runs behind.
  assert.ok(await fresh.recoverInterruptedRuns() >= 2);
  for (const id of ['orphan-running', 'orphan-queued']) {
    const run = await fresh.getTestRun(id);
    assert.equal(run.status, 'error');
    assert.equal(run.diagnostics.at(-1)?.code, 'interrupted');
    assert.ok(run.completedAt);
  }
  assert.ok(harness.removedDirs.includes('/fake-artifacts/orphan'));
  assert.equal(await fresh.recoverInterruptedRuns(), 0);
});

test('retention keeps only the newest finished runs per project and never prunes active ones', async () => {
  const { project, harness, runner, settled } = await setup({ retention: 2 });
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const run = await runner.enqueueAction(project.id, 'lint', 'check');
    ids.push(run.id);
    const child = await harness.nextProcess();
    child.write(`run ${i}\n`);
    child.exit(0);
    await settled(run.id);
  }
  // The pruned run's log file went with it (pruning follows the run's final event); kept runs keep theirs.
  await waitUntil(async () => (await runnerModule.defaultTestRunnerDeps.runFiles.readLog(ids[0]!)) === '');
  assert.equal(await runnerModule.defaultTestRunnerDeps.runFiles.readLog(ids[1]!), 'run 1\n');
  const active = await runner.enqueueAction(project.id, 'lint', 'check');
  const page = await runner.listTestRuns(project.id);
  assert.deepEqual(page.runs.map((r) => r.id), [active.id, ids[2], ids[1]]);
  (await harness.nextProcess()).exit(0);
  await settled(active.id);
  // Pruning runs after the run's final event, so the count settles slightly later.
  await waitUntil(async () => (await runner.listTestRuns(project.id)).total === 2);
});

test('history lists newest first with filters and pagination, without logs or cases', async () => {
  const { project, harness, runner, settled } = await setup();
  const unit = await runner.enqueueAction(project.id, 'unit', 'run');
  const child = await harness.nextProcess();
  harness.writeArtifact(child, 'junit.xml', JUNIT_PASS);
  child.exit(0);
  await settled(unit.id);
  const lint = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(0);
  await settled(lint.id);

  const all = await runner.listTestRuns(project.id);
  assert.deepEqual(all.runs.map((r) => r.id), [lint.id, unit.id]);
  assert.equal(all.limit, 25);
  assert.equal('output' in all.runs[0]!, false);
  assert.equal('result' in all.runs[1]!, false);
  assert.equal(all.runs[1]?.summary?.counts?.total, 2);
  assert.equal(all.runs[1]?.summary && 'cases' in all.runs[1].summary, false);
  assert.deepEqual((await runner.listTestRuns(project.id, { suiteId: 'unit' })).runs.map((r) => r.id), [unit.id]);
  assert.deepEqual((await runner.listTestRuns(project.id, { actionId: 'check' })).runs.map((r) => r.id), [lint.id]);
  const second = await runner.listTestRuns(project.id, { limit: 1, offset: 1 });
  assert.deepEqual(second.runs.map((r) => r.id), [unit.id]);
  assert.equal(second.total, 2);
});

test('an oversized log keeps its head and tail with a marker for what was left out, live and after the run', async () => {
  const { project, harness, runner, settled } = await setup();
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  const child = await harness.nextProcess();
  child.write('a'.repeat(MAX_LOG_HEAD_CHARS));
  child.write('b'.repeat(100_000));
  child.write('c'.repeat(MAX_LOG_TAIL_CHARS));
  const expected = `${'a'.repeat(MAX_LOG_HEAD_CHARS)}\n[agent-visual-os: 100000 characters of output omitted]\n${'c'.repeat(MAX_LOG_TAIL_CHARS)}`;

  const live = await runner.getTestRun(queued.id);
  assert.equal(live.outputTruncated, true);
  assert.ok(live.output === expected, 'live log is head + marker + tail');
  // Only the head is on disk until the run ends; the tail is held in memory.
  assert.equal((await runnerModule.defaultTestRunnerDeps.runFiles.readLog(queued.id)).length, MAX_LOG_HEAD_CHARS);

  child.exit(0);
  await settled(queued.id);
  const run = await runner.getTestRun(queued.id);
  assert.equal(run.outputTruncated, true);
  assert.ok(run.output === expected, 'stored log is head + marker + tail');
});

test('a failed manual run raises a testing Notification; an agent run does not', async () => {
  const { project, harness, runner, settled } = await setup();
  const manual = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(1);
  await settled(manual.id);
  const task = await insertTask(project);
  const agent = await runner.enqueueAction(project.id, 'lint', 'check', { taskId: task.id });
  (await harness.nextProcess()).exit(1);
  await settled(agent.id);
  const notifications = (await notificationService.listNotifications({ projectId: project.id })).filter((n) => n.kind === 'testing.failed');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.title, 'Lint: Lint failed');
  assert.equal(notifications[0]?.description, 'Exited with code 1');
});

test('a later manual run of the same project passing resolves the open testing.failed Notification', async () => {
  const { project, harness, runner, settled } = await setup();
  const failed = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(1);
  await settled(failed.id);
  assert.equal((await notificationService.listNotifications({ projectId: project.id, resolved: false })).filter((n) => n.kind === 'testing.failed').length, 1);

  const passed = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(0);
  await settled(passed.id);

  assert.equal((await notificationService.listNotifications({ projectId: project.id, resolved: false })).filter((n) => n.kind === 'testing.failed').length, 0);
});

test('an artifact cleanup failure is recorded as a diagnostic without hiding the result', async () => {
  const { project, harness, runner, settled } = await setup({ removeArtifactDir: async () => { throw new Error('EBUSY'); } });
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(0);
  await settled(queued.id);
  const run = await runner.getTestRun(queued.id);
  assert.equal(run.status, 'passed');
  assert.equal(run.diagnostics[0]?.code, 'artifact-cleanup-failed');
});

test('an unexpected internal failure still settles the run as an error and frees the queue', async () => {
  const { project, harness, runner, settled } = await setup({ createArtifactDir: async () => { throw new Error('disk full'); } });
  const first = await runner.enqueueAction(project.id, 'lint', 'check');
  await settled(first.id);
  const run = await runner.getTestRun(first.id);
  assert.equal(run.status, 'error');
  assert.equal(run.diagnostics[0]?.code, 'internal-error');
  assert.match(run.diagnostics[0]!.message, /disk full/);
  assert.equal(harness.processes.length, 0);
});

test('the default filesystem deps create a real artifact dir, read reports inside it only, and remove it', async () => {
  const harness = createFakeHarness();
  const outside = await mkdtemp(path.join(tmpdir(), 'test-runner-secret-'));
  await writeFile(path.join(outside, 'secret.xml'), '<testsuite/>');
  const { project, runner, settled } = await setup({
    spawnProcess: harness.deps.spawnProcess,
    createArtifactDir: runnerModule.defaultTestRunnerDeps.createArtifactDir,
    removeArtifactDir: runnerModule.defaultTestRunnerDeps.removeArtifactDir,
    readArtifact: runnerModule.defaultTestRunnerDeps.readArtifact,
  });

  const ok = await runner.enqueueAction(project.id, 'unit', 'run');
  const child = await harness.nextProcess();
  await writeFile(path.join(child.artifactDir, 'junit.xml'), JUNIT_PASS);
  child.exit(0);
  await settled(ok.id);
  assert.equal((await runner.getTestRun(ok.id)).status, 'passed');
  await assert.rejects(readdir(child.artifactDir), { code: 'ENOENT' });

  const escaping = await runner.enqueueAction(project.id, 'unit', 'run');
  const second = await harness.nextProcess();
  await symlink(path.join(outside, 'secret.xml'), path.join(second.artifactDir, 'junit.xml'));
  second.exit(0);
  await settled(escaping.id);
  const run = await runner.getTestRun(escaping.id);
  assert.equal(run.status, 'error');
  assert.equal(run.diagnostics[0]?.code, 'artifact-unsafe-path');
  await rm(outside, { recursive: true, force: true });
});

test('decideStatus maps report outcomes and exit codes', () => {
  const base = { purpose: 'result' as const, hasCollectors: true };
  const result = (outcome: 'passed' | 'failed' | 'error' | 'skipped') => ({ result: { outcome, metrics: [], findings: [], cases: [] }, complete: true });
  assert.equal(runnerModule.decideStatus({ ...base, exitCode: 0, collection: result('error') }).status, 'error');
  assert.equal(runnerModule.decideStatus({ ...base, exitCode: 0, collection: result('failed') }).status, 'failed');
  assert.equal(runnerModule.decideStatus({ ...base, exitCode: 0, collection: result('skipped') }).status, 'passed');
  assert.equal(runnerModule.decideStatus({ ...base, exitCode: 0, collection: { result: result('passed').result, complete: false } }).status, 'error');
  assert.equal(runnerModule.decideStatus({ ...base, exitCode: 1, collection: null }).status, 'failed');
  assert.equal(runnerModule.decideStatus({ purpose: 'utility', hasCollectors: false, exitCode: 0, collection: null }).status, 'passed');
});

test('latestResultRun ignores utility, stopped and active runs and prefers the newest', () => {
  const run = (id: string, patch: Partial<TestRunRecord>) => ({
    id, queuedAt: `2026-01-0${id}T00:00:00.000Z`, status: 'passed', suite: { id: 'unit' }, action: { id: 'run', purpose: 'result' }, ...patch,
  }) as TestRunRecord;
  const runs = [
    run('1', { status: 'failed' }),
    run('2', { status: 'passed', action: { id: 'other', purpose: 'result' } as TestRunRecord['action'] }),
    run('3', { status: 'stopped' }),
    run('4', { status: 'running' }),
    run('5', { action: { id: 'snap', purpose: 'utility' } as TestRunRecord['action'] }),
  ];
  assert.equal(runnerModule.latestResultRun(runs, 'unit')?.id, '2');
  assert.equal(runnerModule.latestResultRun(runs, 'unit', 'run')?.id, '1');
  assert.equal(runnerModule.latestResultRun(runs, 'lint'), null);
});

test('a running run appends its log to its own file as output arrives', async () => {
  const { project, harness, runner, settled } = await setup();
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  const child = await harness.nextProcess();
  child.write('first\n');
  child.write('second\n');
  await waitUntil(async () => (await runnerModule.defaultTestRunnerDeps.runFiles.readLog(queued.id)) === 'first\nsecond\n');
  child.exit(0);
  await settled(queued.id);
});

test('a log file that cannot be written is reported as a diagnostic without failing the run', async () => {
  const runFiles = { ...runnerModule.defaultTestRunnerDeps.runFiles, appendLog: async () => { throw new Error('ENOSPC: no space left'); } };
  const { project, harness, runner, settled } = await setup({ runFiles });
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  const child = await harness.nextProcess();
  child.write('lost\n');
  child.write('also lost\n');
  child.exit(0);
  await settled(queued.id);
  const run = await runner.getTestRun(queued.id);
  assert.equal(run.status, 'passed');
  assert.deepEqual(run.diagnostics.map((d) => d.code), ['log-write-failed']);
  assert.match(run.diagnostics[0]!.message, /ENOSPC/);
});

test('findings are counted by severity on the run record', () => {
  const summary = runnerModule.summarizeResult({
    outcome: 'failed', metrics: [], cases: [{ name: 'x', outcome: 'passed' }],
    findings: [{ severity: 'high', title: 'a' }, { severity: 'high', title: 'b' }, { severity: 'info', title: 'c' }],
  });
  assert.deepEqual(summary, { outcome: 'failed', metrics: [], findingCounts: { critical: 0, high: 2, medium: 0, low: 0, info: 1 } });
});

test('a failure while finalizing still records the verdict and never lets two runs overlap', async () => {
  let failures = 1;
  const runFiles = {
    ...runnerModule.defaultTestRunnerDeps.runFiles,
    async writeResult(...args: Parameters<TestRunnerDeps['runFiles']['writeResult']>) {
      if (failures-- > 0) throw new Error('ENOSPC: no space left');
      return runnerModule.defaultTestRunnerDeps.runFiles.writeResult(...args);
    },
  };
  const { project, harness, runner, settled } = await setup({ runFiles });
  const a = await runner.enqueueAction(project.id, 'unit', 'run');
  const b = await runner.enqueueAction(project.id, 'lint', 'check');
  const c = await runner.enqueueAction(project.id, 'unit', 'snapshots');
  const first = await harness.nextProcess();
  harness.writeArtifact(first, 'junit.xml', JUNIT_PASS);
  first.exit(0);
  await settled(a.id);

  const second = await harness.nextProcess();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.processes.length, 2, 'the third run must wait for the second');
  assert.equal((await runner.getTestRun(c.id)).status, 'queued');

  const aRun = await runner.getTestRun(a.id);
  assert.equal(aRun.status, 'passed', 'the verdict is kept even though the result file failed');
  assert.equal(aRun.diagnostics[0]?.code, 'internal-error');
  assert.match(aRun.diagnostics[0]!.message, /ENOSPC/);
  assert.equal(aRun.summary?.counts?.total, 2);

  second.exit(0);
  (await harness.nextProcess()).exit(0);
  await settled(c.id);
  assert.equal((await runner.getTestRun(b.id)).status, 'passed');
});

test('a command that exits but leaves a background process holding its output settles after a grace period', async () => {
  const { project, harness, runner, settled } = await setup({ closeGraceMs: 20 });
  const a = await runner.enqueueAction(project.id, 'lint', 'check');
  const b = await runner.enqueueAction(project.id, 'unit', 'snapshots');
  const child = await harness.nextProcess();
  child.write('started server in background\n');
  child.exitKeepingPipesOpen(0);
  await settled(a.id);
  const run = await runner.getTestRun(a.id);
  assert.equal(run.status, 'passed');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.diagnostics.map((d) => d.code), ['background-processes-stopped']);
  assert.ok(child.killed, 'whatever still held the pipes is stopped');
  assert.equal(run.output, 'started server in background\n');
  // Output arriving after the run settled is ignored rather than written after the log was closed.
  child.write('late\n');
  const next = await harness.nextProcess();
  next.exit(0);
  await settled(b.id);
  assert.equal((await runner.getTestRun(a.id)).output, 'started server in background\n');
});

test('Stop after the process ended keeps the verdict instead of overwriting it', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { project, harness, runner, settled } = await setup({ removeArtifactDir: async () => { await gate; } });
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  const child = await harness.nextProcess();
  child.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Finalize is paused on artifact cleanup; the run is still active but its process has ended.
  const returned = await runner.stopTestRun(queued.id);
  assert.equal(returned.status, 'running');
  assert.equal(child.killed, false);
  release();
  await settled(queued.id);
  assert.equal((await runner.getTestRun(queued.id)).status, 'passed');
});

test('killActiveProcesses signals only runs whose process is still going', async () => {
  const { project, harness, runner, settled } = await setup();
  const a = await runner.enqueueAction(project.id, 'lint', 'check');
  await runner.enqueueAction(project.id, 'unit', 'snapshots');
  const child = await harness.nextProcess();
  runner.killActiveProcesses();
  assert.ok(child.killed);
  await settled(a.id);
  const next = await harness.nextProcess();
  next.exit(0);
  runner.killActiveProcesses();
  assert.equal(next.killed, false, 'an exited process is not signalled');
});

test('agent worktree runs never become the latest result shown for the primary tree', async () => {
  const { project, harness, runner, settled } = await setup();
  const worktree = path.join(projectService.projectWorktreesRoot(project), 'task-latest');
  await writeConfig(worktree, sampleConfig());
  const task = await insertTask(project, { worktreePath: worktree });

  const manual = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(0);
  await settled(manual.id);
  const agent = await runner.enqueueAction(project.id, 'lint', 'check', { taskId: task.id });
  (await harness.nextProcess()).exit(1);
  await settled(agent.id);

  const overview = await runner.getOverview(project.id);
  const lint = overview.suites.find((s) => s.id === 'lint')!;
  assert.equal(lint.latestResult?.id, manual.id);
  assert.equal(lint.actions[0]?.latestResult?.id, manual.id);
  assert.equal(lint.actions[0]?.latestRun?.id, manual.id);
  // It is still in History.
  assert.ok((await runner.listTestRuns(project.id)).runs.some((r) => r.id === agent.id));

  // While it runs, an agent run is in the queue but isn't the primary tree's active run.
  const running = await runner.enqueueAction(project.id, 'lint', 'check', { taskId: task.id });
  const child = await harness.nextProcess();
  const busy = await runner.getOverview(project.id);
  assert.deepEqual(busy.queue.map((r) => r.id), [running.id]);
  assert.equal(busy.suites.find((s) => s.id === 'lint')?.actions[0]?.activeRun, null);
  child.exit(0);
  await settled(running.id);
});

test('discarding a project stops its running test, drops its queue and deletes every record and file', async () => {
  const { project, harness, runner, events, settled } = await setup();
  const done = await runner.enqueueAction(project.id, 'lint', 'check');
  const first = await harness.nextProcess();
  first.write('kept until discarded\n');
  first.exit(0);
  await settled(done.id);

  const running = await runner.enqueueAction(project.id, 'lint', 'check');
  const queued = await runner.enqueueAction(project.id, 'unit', 'snapshots');
  const child = await harness.nextProcess();
  child.write('in progress\n');

  await runner.discardProjectRuns(project.id);
  assert.ok(child.killed);
  assert.equal((await runner.listTestRuns(project.id)).total, 0);
  for (const id of [done.id, running.id, queued.id]) {
    assert.ok(events.some((e) => e.type === 'testRunRemoved' && e.runId === id));
    assert.equal(await runnerModule.defaultTestRunnerDeps.runFiles.readLog(id), '');
  }
  assert.deepEqual(harness.removedDirs.slice(-1), [harness.createdDirs.at(-1)]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.processes.length, 2, 'the dropped queue never starts');
  const notifications = await notificationService.listNotifications({ projectId: project.id });
  assert.deepEqual(notifications, []);
  // Nothing to discard is fine too.
  await runner.discardProjectRuns(project.id);
});

// ---- Passed-run completion notifications (task 12.001, part E) ----

/** Runs one action with the clock mocked, jumping `elapsedMs` between the process starting and exiting. */
async function runWithElapsed(
  ctx: Awaited<ReturnType<typeof setup>>,
  elapsedMs: number,
  exitCode: number,
  options: { taskId?: string; onQueued?: (runId: string) => void } = {},
): Promise<string> {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  try {
    const queued = await ctx.runner.enqueueAction(ctx.project.id, 'lint', 'check', options.taskId ? { taskId: options.taskId } : undefined);
    options.onQueued?.(queued.id);
    const child = await ctx.harness.nextProcess();
    mock.timers.tick(elapsedMs);
    child.exit(exitCode);
    await ctx.settled(queued.id);
    return queued.id;
  } finally {
    mock.timers.reset();
  }
}

const passedNotifications = async (projectId: string) =>
  (await notificationService.listNotifications({ projectId })).filter((n) => n.kind === 'testing.passed');

test('a manual run that passes after exactly 10s with its drawer closed raises an unread info testing.passed Notification for that run', async () => {
  const ctx = await setup();
  const runId = await runWithElapsed(ctx, 10_000, 0);
  const [n] = await passedNotifications(ctx.project.id);
  assert.equal(n?.severity, 'info');
  assert.equal(n?.readAt, null);
  assert.equal(n?.title, 'Lint: Lint passed');
  assert.deepEqual(n?.subject, { type: 'testRun', projectId: ctx.project.id, runId });
});

/** Runs `body` with every Notification insert held back by 50ms, standing in for slow disk I/O under load. */
async function withSlowNotificationInserts(body: () => Promise<void>): Promise<void> {
  const db = collections.notificationsDb;
  const insert = db.insert;
  db.insert = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return insert.apply(db, args);
  };
  try { await body(); } finally { db.insert = insert; }
}

test('a run\'s final event is only sent once its testing.passed Notification exists, however slow the write', async () => {
  const ctx = await setup();
  await withSlowNotificationInserts(async () => {
    const runId = await runWithElapsed(ctx, 10_000, 0);
    const notified = (await passedNotifications(ctx.project.id)).map((n) => (n.subject as { runId: string }).runId);
    assert.deepEqual(notified, [runId]);
  });
});

test('a run\'s final event is only sent once its testing.failed Notification exists, however slow the write', async () => {
  const ctx = await setup();
  await withSlowNotificationInserts(async () => {
    await runWithElapsed(ctx, 100, 1);
    const failed = (await notificationService.listNotifications({ projectId: ctx.project.id })).filter((n) => n.kind === 'testing.failed');
    assert.equal(failed.length, 1);
  });
});

test('a manual run that passes in 9.9s, an agent run that passes long, and a stopped run raise no completion', async () => {
  const ctx = await setup();
  await runWithElapsed(ctx, 9_900, 0);
  const task = await insertTask(ctx.project);
  await runWithElapsed(ctx, 60_000, 0, { taskId: task.id });
  assert.equal((await passedNotifications(ctx.project.id)).length, 0);
});

test('time spent queued does not count towards the 10s', async () => {
  const ctx = await setup();
  let firstId = '';
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  try {
    const first = await ctx.runner.enqueueAction(ctx.project.id, 'lint', 'check');
    firstId = first.id;
    const second = await ctx.runner.enqueueAction(ctx.project.id, 'unit', 'snapshots');
    const firstChild = await ctx.harness.nextProcess();
    mock.timers.tick(60_000);
    firstChild.exit(0);
    await ctx.settled(first.id);
    const secondChild = await ctx.harness.nextProcess();
    mock.timers.tick(9_000);
    secondChild.exit(0);
    await ctx.settled(second.id);
  } finally { mock.timers.reset(); }
  const notified = (await passedNotifications(ctx.project.id)).map((n) => (n.subject as { runId: string }).runId);
  assert.deepEqual(notified, [firstId], 'only the first, long-executing run notified');
});

test('a passing run whose drawer is open raises nothing; failures notify regardless of duration or watch', async () => {
  const runWatch = await import('../src/notifications/runWatch.ts');
  const owner = {};
  const ctx = await setup();
  await runWithElapsed(ctx, 30_000, 0, { onQueued: (id) => runWatch.watchRun(owner, 'test', id) });
  assert.equal((await passedNotifications(ctx.project.id)).length, 0);
  await runWithElapsed(ctx, 100, 1, { onQueued: (id) => runWatch.watchRun(owner, 'test', id) });
  runWatch.dropWatches(owner);
  assert.equal((await notificationService.listNotifications({ projectId: ctx.project.id })).filter((n) => n.kind === 'testing.failed').length, 1);
});

test('runs from different Projects share a global limit and the next waiting Project starts as slots free', async () => {
  const first = await setup({ maxConcurrentRuns: 2 });
  const others: ProjectRecord[] = [];
  for (let i = 0; i < 2; i += 1) {
    const project = await projectService.createProject({ name: `Runner Project ${(projectCount += 1)}`, position: null });
    await writeConfig(projectService.projectAbsolutePath(project), sampleConfig());
    others.push(project);
  }
  const { runner, harness, settled } = first;
  const a = await runner.enqueueAction(first.project.id, 'lint', 'check');
  const b = await runner.enqueueAction(others[0]!.id, 'lint', 'check');
  const c = await runner.enqueueAction(others[1]!.id, 'lint', 'check');

  const childA = await harness.nextProcess();
  const childB = await harness.nextProcess();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(harness.processes.length, 2, 'the third Project waits for a slot');
  assert.equal((await runner.getTestRun(c.id)).status, 'queued');

  childA.exit(0);
  await settled(a.id);
  const childC = await harness.nextProcess();
  assert.equal((await runner.getTestRun(c.id)).status, 'running');
  childB.exit(0);
  childC.exit(0);
  await settled(b.id);
  await settled(c.id);
});

test('a run that outlives the run timeout is stopped and settles as an error', async () => {
  const { project, harness, runner, settled } = await setup({ runTimeoutMs: 30 });
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  const child = await harness.nextProcess();
  await settled(queued.id);
  const run = await runner.getTestRun(queued.id);
  assert.ok(child.killed);
  assert.equal(run.status, 'error');
  assert.deepEqual(run.diagnostics.map((d) => d.code), ['timed-out']);
  assert.match(run.diagnostics[0]!.message, /30 ms/);
});

test('a run that finishes before the timeout is not affected by it', async () => {
  const { project, harness, runner, settled } = await setup({ runTimeoutMs: 60 });
  const queued = await runner.enqueueAction(project.id, 'lint', 'check');
  (await harness.nextProcess()).exit(0);
  await settled(queued.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const run = await runner.getTestRun(queued.id);
  assert.equal(run.status, 'passed');
  assert.deepEqual(run.diagnostics, []);
});

test('a timeout is described in whole minutes when it is one, otherwise in milliseconds', () => {
  assert.equal(runnerModule.describeTimeout(15 * 60_000), '15 minutes');
  assert.equal(runnerModule.describeTimeout(60_000), '1 minute');
  assert.equal(runnerModule.describeTimeout(90_000), '90000 ms');
  assert.equal(runnerModule.describeTimeout(30), '30 ms');
});
