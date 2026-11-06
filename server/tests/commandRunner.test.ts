import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import type { CommandEvent } from '../src/commands/commandRunner.ts';

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let commandService: typeof import('../src/commands/commandService.ts');
let commandRunnerModule: typeof import('../src/commands/commandRunner.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'command-runner-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  projectService = await import('../src/projects/projectService.ts');
  commandService = await import('../src/commands/commandService.ts');
  commandRunnerModule = await import('../src/commands/commandRunner.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// Real processes settle asynchronously — poll rather than assume a fixed delay. See
// workerManager.test.ts's own waitUntil for why this is generous (concurrent test files under CPU
// contention), not just the individual command's own runtime.
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('runCommand runs a real shell command in the project root and records success + output', async () => {
  const project = await projectService.createProject({ name: 'Runner A', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Echo', command: 'echo hello-from-test' });
  const runner = commandRunnerModule.createCommandRunner();

  const events: CommandEvent[] = [];
  runner.onCommandEvent((event) => events.push(event));

  const started = await runner.runCommand(command.id);
  assert.equal(started.status, 'running');
  assert.equal(started.projectId, project.id);
  assert.equal(started.commandName, 'Echo');
  assert.equal(started.origin, 'saved');

  // Wait on the emitted event, not just the DB record: FileDatabase mutates its in-memory cache
  // (visible to a concurrent getCommandRun poll) before its update() promise — and so settle()'s
  // own emit() call, which runs after that await — actually resolves, since persisting to disk is
  // real (if brief) I/O. Polling getCommandRun alone can observe "success" a tick before the event
  // fires, which is a benign ordering detail for a real WS client but makes this assertion flaky.
  await waitUntil(async () => events.some((e) => e.type === 'commandRun' && e.run.id === started.id && e.run.status !== 'running'));
  const settled = await runner.getCommandRun(started.id);
  assert.equal(settled.status, 'success');
  assert.equal(settled.exitCode, 0);
  assert.match(settled.output, /hello-from-test/);
  assert.ok(settled.completedAt);

  assert.ok(events.some((e) => e.type === 'commandRun' && e.run.status === 'running'));
  assert.ok(events.some((e) => e.type === 'commandRunLog'));
  assert.ok(events.some((e) => e.type === 'commandRun' && e.run.status === 'success'));

  // A successful run isn't attention-needing — it must not raise a Notification.
  assert.deepEqual(await notificationService.listNotifications({ projectId: project.id }), []);
});

test('runCommand records a non-zero exit as failed, and raises a warning Notification', async () => {
  const project = await projectService.createProject({ name: 'Runner B', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Fail', command: 'exit 7' });
  const runner = commandRunnerModule.createCommandRunner();

  const started = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(started.id)).status !== 'running');
  const settled = await runner.getCommandRun(started.id);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.exitCode, 7);

  const notifications = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.severity, 'warning');
  assert.equal(notifications[0]?.kind, 'command.failed');
  assert.match(notifications[0]?.title ?? '', /Fail/);
});

test('a later run of the same command succeeding resolves its open command.failed Notification', async () => {
  const project = await projectService.createProject({ name: 'Runner Resolve', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Flaky', command: 'exit 1' });
  const runner = commandRunnerModule.createCommandRunner();

  const failed = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(failed.id)).status !== 'running');
  assert.equal((await notificationService.listNotifications({ projectId: project.id, resolved: false })).length, 1);

  await commandService.updateCommand(command.id, { command: 'exit 0' });
  const succeeded = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(succeeded.id)).status !== 'running');

  assert.equal((await notificationService.listNotifications({ projectId: project.id, resolved: false })).length, 0);
});

test('a later run of the same command also failing updates the existing command.failed Notification in place, not a second one', async () => {
  const project = await projectService.createProject({ name: 'Runner Dedupe', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Always fails', command: 'exit 3' });
  const runner = commandRunnerModule.createCommandRunner();

  const first = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(first.id)).status !== 'running');
  const second = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(second.id)).status !== 'running');

  const notifications = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(notifications.length, 1, 'deduped in place rather than a second Notification');
});

test('a command belonging to a different project failing does not affect another project\'s command.failed Notification', async () => {
  const projectA = await projectService.createProject({ name: 'Runner Isolated A', position: null });
  const projectB = await projectService.createProject({ name: 'Runner Isolated B', position: null });
  const commandA = await commandService.createCommand({ projectId: projectA.id, name: 'Fail A', command: 'exit 1' });
  const runner = commandRunnerModule.createCommandRunner();

  const run = await runner.runCommand(commandA.id);
  await waitUntil(async () => (await runner.getCommandRun(run.id)).status !== 'running');

  assert.equal((await notificationService.listNotifications({ projectId: projectA.id })).length, 1);
  assert.deepEqual(await notificationService.listNotifications({ projectId: projectB.id }), []);
});

test('runCommand refuses to start the same command twice concurrently', async () => {
  const project = await projectService.createProject({ name: 'Runner C', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Sleep', command: 'sleep 1' });
  const runner = commandRunnerModule.createCommandRunner();

  const started = await runner.runCommand(command.id);
  await assert.rejects(() => runner.runCommand(command.id), commandRunnerModule.CommandAlreadyRunningError);

  await waitUntil(async () => (await runner.getCommandRun(started.id)).status !== 'running');
});

test('stopCommandRun kills an in-flight run and settles it as stopped, not failed', async () => {
  const project = await projectService.createProject({ name: 'Runner D', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Long sleep', command: 'sleep 30' });
  const runner = commandRunnerModule.createCommandRunner();

  const started = await runner.runCommand(command.id);
  const stopped = await runner.stopCommandRun(started.id);
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.completedAt);

  // A command can be started again once its run has stopped — the runningProcesses slot must have
  // been freed, not left wedged by the kill.
  const restarted = await runner.runCommand(command.id);
  await runner.stopCommandRun(restarted.id);

  // A user-initiated stop isn't a failure — it must not raise a Notification either.
  assert.deepEqual(await notificationService.listNotifications({ projectId: project.id }), []);
});

test('stopCommandRun on an already-settled run is a harmless no-op', async () => {
  const project = await projectService.createProject({ name: 'Runner E', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Echo', command: 'echo done' });
  const runner = commandRunnerModule.createCommandRunner();

  const started = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(started.id)).status !== 'running');

  const result = await runner.stopCommandRun(started.id);
  assert.equal(result.status, 'success', 'stopping a run that already finished must not overwrite its real outcome');
});

test('stopCommandRun settles an orphaned running record (no live process) as stopped', async () => {
  const project = await projectService.createProject({ name: 'Runner Orphan Stop', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Dev', command: 'sleep 30' });
  const first = commandRunnerModule.createCommandRunner();
  const started = await first.runCommand(command.id);

  // A fresh runner shares the persisted record but has no process for it — as after a daemon restart.
  const restarted = commandRunnerModule.createCommandRunner();
  const events: CommandEvent[] = [];
  restarted.onCommandEvent((event) => events.push(event));
  const result = await restarted.stopCommandRun(started.id);

  assert.equal(result.status, 'stopped');
  assert.ok(result.completedAt);
  assert.ok(events.some((e) => e.type === 'commandRun' && e.run.id === started.id && e.run.status === 'stopped'));
  await first.stopCommandRun(started.id);
});

test('reconcileOrphanedRuns settles leftover running records and leaves live and settled ones alone', async () => {
  const project = await projectService.createProject({ name: 'Runner Reconcile', position: null });
  const orphanCommand = await commandService.createCommand({ projectId: project.id, name: 'Orphan', command: 'sleep 30' });
  const doneCommand = await commandService.createCommand({ projectId: project.id, name: 'Done', command: 'echo done' });
  const previousDaemon = commandRunnerModule.createCommandRunner();
  const orphan = await previousDaemon.runCommand(orphanCommand.id);
  const done = await previousDaemon.runCommand(doneCommand.id);
  await waitUntil(async () => (await previousDaemon.getCommandRun(done.id)).status !== 'running');

  const runner = commandRunnerModule.createCommandRunner();
  const live = await runner.runCommand((await commandService.createCommand({ projectId: project.id, name: 'Live', command: 'sleep 30' })).id);
  await runner.reconcileOrphanedRuns();

  assert.equal((await runner.getCommandRun(orphan.id)).status, 'stopped');
  assert.equal((await runner.getCommandRun(done.id)).status, 'success');
  assert.equal((await runner.getCommandRun(live.id)).status, 'running', 'a run this daemon really owns must not be touched');
  await runner.stopCommandRun(live.id);
  await previousDaemon.stopCommandRun(orphan.id);
});

test('killActiveProcesses signals every in-flight run so none outlives the daemon', async () => {
  const project = await projectService.createProject({ name: 'Runner Shutdown', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Dev', command: 'sleep 30' });
  const runner = commandRunnerModule.createCommandRunner();
  const started = await runner.runCommand(command.id);

  runner.killActiveProcesses();

  await waitUntil(async () => (await runner.getCommandRun(started.id)).status !== 'running');
});

test('listCommandRuns returns a project\'s runs, most-recent-first', async () => {
  const project = await projectService.createProject({ name: 'Runner F', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Echo', command: 'echo one' });
  const runner = commandRunnerModule.createCommandRunner();

  const first = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(first.id)).status !== 'running');
  const second = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(second.id)).status !== 'running');

  const history = await runner.listCommandRuns(project.id);
  assert.deepEqual(history.map((r) => r.id), [second.id, first.id]);
});

test('listCommandRuns(projectId, "running") narrows to just the runs still in flight, for the workspace to discover a background command left going', async () => {
  const project = await projectService.createProject({ name: 'Runner F2', position: null });
  const finished = await commandService.createCommand({ projectId: project.id, name: 'Echo', command: 'echo one' });
  const longRunning = await commandService.createCommand({ projectId: project.id, name: 'Dev server', command: 'sleep 30' });
  const runner = commandRunnerModule.createCommandRunner();

  const done = await runner.runCommand(finished.id);
  await waitUntil(async () => (await runner.getCommandRun(done.id)).status !== 'running');
  const stillGoing = await runner.runCommand(longRunning.id);

  const active = await runner.listCommandRuns(project.id, 'running');
  assert.deepEqual(active.map((r) => r.id), [stillGoing.id]);

  await runner.stopCommandRun(stillGoing.id);
});

test('getCommandRun throws CommandRunNotFoundError for an unknown id', async () => {
  const runner = commandRunnerModule.createCommandRunner();
  await assert.rejects(() => runner.getCommandRun('no-such-run'), commandRunnerModule.CommandRunNotFoundError);
});

test('runAdHocCommand runs an arbitrary, never-saved command in the project root and records success + output', async () => {
  const project = await projectService.createProject({ name: 'Runner G', position: null });
  const runner = commandRunnerModule.createCommandRunner();

  const started = await runner.runAdHocCommand(project.id, 'echo hello-from-adhoc');
  assert.equal(started.status, 'running');
  assert.equal(started.projectId, project.id);
  assert.equal(started.commandName, 'Custom command');
  assert.equal(started.commandText, 'echo hello-from-adhoc');
  assert.match(started.commandId, /^adhoc:/, 'a synthetic id, not a real ProjectCommandRecord id');
  assert.equal(started.origin, 'adhoc');

  await waitUntil(async () => (await runner.getCommandRun(started.id)).status !== 'running');
  const settled = await runner.getCommandRun(started.id);
  assert.equal(settled.status, 'success');
  assert.match(settled.output, /hello-from-adhoc/);

  // Never shows up as a defined command — there's no ProjectCommandRecord — but its run still
  // lands in the project's history, same as a real command's or a branch sync's run would.
  assert.deepEqual(await commandService.listCommands(project.id), []);
  const history = await runner.listCommandRuns(project.id);
  assert.deepEqual(history.map((r) => r.id), [started.id]);
});

test('runAdHocCommand lets several ad hoc runs (even the same command text) run concurrently, unlike a saved command', async () => {
  const project = await projectService.createProject({ name: 'Runner H', position: null });
  const runner = commandRunnerModule.createCommandRunner();

  const first = await runner.runAdHocCommand(project.id, 'sleep 1');
  const second = await runner.runAdHocCommand(project.id, 'sleep 1');
  assert.notEqual(first.id, second.id);
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'running');

  await waitUntil(async () => (await runner.getCommandRun(first.id)).status !== 'running');
  await waitUntil(async () => (await runner.getCommandRun(second.id)).status !== 'running');
});

test('runCommand records the main location by default, on the run and on both its start and settle events', async () => {
  const project = await projectService.createProject({ name: 'Runner Location', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Echo', command: 'echo here' });
  const runner = commandRunnerModule.createCommandRunner();
  const events: CommandEvent[] = [];
  runner.onCommandEvent((event) => events.push(event));

  const started = await runner.runCommand(command.id);
  assert.deepEqual(started.location, { kind: 'main' });
  await waitUntil(async () => events.some((e) => e.type === 'commandRun' && e.run.id === started.id && e.run.status !== 'running'));
  const runEvents = events.filter((e): e is Extract<CommandEvent, { type: 'commandRun' }> => e.type === 'commandRun');
  assert.ok(runEvents.length >= 2);
  for (const event of runEvents) assert.deepEqual(event.run.location, { kind: 'main' });
});

// ---- Completion notifications (task 12.001, part E) ----

type CompletionSetup = { project: Awaited<ReturnType<typeof projectService.createProject>>; runner: ReturnType<typeof commandRunnerModule.createCommandRunner> };

async function completionSetup(name: string): Promise<CompletionSetup> {
  const project = await projectService.createProject({ name, position: null });
  return { project, runner: commandRunnerModule.createCommandRunner() };
}

/** Runs `sleep 0.2`, jumping the mocked clock `elapsedMs` while it runs, and waits for the run to settle. */
async function runWithElapsed(runner: CompletionSetup['runner'], start: () => Promise<{ id: string }>, elapsedMs: number, beforeSettle?: (runId: string) => void) {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  try {
    const started = await start();
    beforeSettle?.(started.id);
    mock.timers.tick(elapsedMs);
    await waitUntil(async () => (await runner.getCommandRun(started.id)).status !== 'running');
    return started.id;
  } finally {
    mock.timers.reset();
  }
}

const completed = async (projectId: string) =>
  (await notificationService.listNotifications({ projectId })).filter((n) => n.kind === 'command.completed');

test('a saved command that succeeds after exactly 10s with nobody watching raises an unread info command.completed Notification', async () => {
  const { project, runner } = await completionSetup('Completion A');
  const command = await commandService.createCommand({ projectId: project.id, name: 'Build', command: 'sleep 0.2' });
  const runId = await runWithElapsed(runner, () => runner.runCommand(command.id), 10_000);
  const [n] = await completed(project.id);
  assert.equal(n?.severity, 'info');
  assert.equal(n?.readAt, null);
  assert.equal(n?.title, 'Command "Build" completed');
  assert.deepEqual(n?.subject, { type: 'command', projectId: project.id, commandId: command.id, runId });
});

test('a success just under 10s raises nothing', async () => {
  const { project, runner } = await completionSetup('Completion B');
  const command = await commandService.createCommand({ projectId: project.id, name: 'Quick', command: 'sleep 0.2' });
  await runWithElapsed(runner, () => runner.runCommand(command.id), 9_900);
  assert.equal((await completed(project.id)).length, 0);
});

test('a long one-off custom command raises a completion titled with its name', async () => {
  const { project, runner } = await completionSetup('Completion C');
  await runWithElapsed(runner, () => runner.runAdHocCommand(project.id, 'sleep 0.2'), 12_000);
  assert.equal((await completed(project.id))[0]?.title, 'Command "Custom command" completed');
});

test('a long success on a watched run raises nothing, a watch on another run does not suppress, and a released watch does not either', async () => {
  const runWatch = await import('../src/notifications/runWatch.ts');
  const owner = {};
  const { project, runner } = await completionSetup('Completion D');
  const command = await commandService.createCommand({ projectId: project.id, name: 'Watched', command: 'sleep 0.2' });
  await runWithElapsed(runner, () => runner.runCommand(command.id), 11_000, (id) => runWatch.watchRun(owner, 'command', id));
  assert.equal((await completed(project.id)).length, 0);
  runWatch.dropWatches(owner);

  await runWithElapsed(runner, () => runner.runCommand(command.id), 11_000, () => runWatch.watchRun(owner, 'command', 'some-other-run'));
  assert.equal((await completed(project.id)).length, 1);
  runWatch.dropWatches(owner);
});

test('a long stopped run and a failure under 10s never raise a completion; the failure still notifies', async () => {
  const { project, runner } = await completionSetup('Completion E');
  const command = await commandService.createCommand({ projectId: project.id, name: 'Stoppable', command: 'sleep 5' });
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  try {
    const started = await runner.runCommand(command.id);
    mock.timers.tick(20_000);
    await runner.stopCommandRun(started.id);
    await waitUntil(async () => (await runner.getCommandRun(started.id)).status === 'stopped');
  } finally { mock.timers.reset(); }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await completed(project.id)).length, 0);

  const failing = await commandService.createCommand({ projectId: project.id, name: 'Fails', command: 'exit 2' });
  await runWithElapsed(runner, () => runner.runCommand(failing.id), 1_000);
  assert.equal((await notificationService.listNotifications({ projectId: project.id })).filter((n) => n.kind === 'command.failed').length, 1);
  assert.equal((await completed(project.id)).length, 0);
});

test('a long success after an earlier failure resolves the failure and raises the completion', async () => {
  const { project, runner } = await completionSetup('Completion F');
  const command = await commandService.createCommand({ projectId: project.id, name: 'Flip', command: 'exit 1' });
  await runWithElapsed(runner, () => runner.runCommand(command.id), 1_000);
  await commandService.updateCommand(command.id, { command: 'sleep 0.2' });
  await runWithElapsed(runner, () => runner.runCommand(command.id), 10_000);
  const all = await notificationService.listNotifications({ projectId: project.id });
  assert.equal(all.find((n) => n.kind === 'command.failed')?.resolvedAt !== null, true);
  assert.equal(all.filter((n) => n.kind === 'command.completed').length, 1);
});

test('runCommand marks a run started with automatic: true as automatic, and leaves a manual run unmarked', async () => {
  const project = await projectService.createProject({ name: 'Runner Automatic', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Quick', command: 'true' });
  const runner = commandRunnerModule.createCommandRunner();

  const scheduled = await runner.runCommand(command.id, { automatic: true });
  await waitUntil(async () => (await runner.getCommandRun(scheduled.id)).status !== 'running');
  const manual = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(manual.id)).status !== 'running');

  assert.equal((await runner.getCommandRun(scheduled.id)).automatic, true);
  assert.equal((await runner.getCommandRun(manual.id)).automatic, undefined);
});
