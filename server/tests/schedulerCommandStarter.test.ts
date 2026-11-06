import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { CommandRunRecord } from '../src/domain/types.ts';
import type { CommandEvent } from '../src/commands/commandRunner.ts';
import type { RunState } from '../src/scheduler/scheduler.ts';
import type { ScheduledJobRecord } from '../src/scheduler/types.ts';

/** The run starter's saved-command target: starting, mapping a command run's status, and which command runs it reports on. */

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let commandService: typeof import('../src/commands/commandService.ts');
let commandRunnerModule: typeof import('../src/commands/commandRunner.ts');
let starterModule: typeof import('../src/scheduler/runStarter.ts');
let schedulerModule: typeof import('../src/scheduler/scheduler.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'scheduler-command-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  projectService = await import('../src/projects/projectService.ts');
  commandService = await import('../src/commands/commandService.ts');
  commandRunnerModule = await import('../src/commands/commandRunner.ts');
  starterModule = await import('../src/scheduler/runStarter.ts');
  schedulerModule = await import('../src/scheduler/scheduler.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const noConnections = { callFromJob: async () => { throw new Error('unused'); }, callState: async () => null, onCallChanged: () => () => undefined };
const noManager = { executePlanItem: async () => { throw new Error('unused'); }, hasFreeSlot: async () => { throw new Error('a command job must not ask for a slot'); }, onWorkerEvent: () => () => undefined };

const jobFor = (commandId: string) => ({ id: 'job-1', target: { kind: 'command', commandId } }) as unknown as ScheduledJobRecord;
const run = (patch: Partial<CommandRunRecord> = {}): CommandRunRecord => ({
  id: 'r1', projectId: 'p', commandId: 'c', commandName: 'Build', commandText: 'make', origin: 'saved', location: { kind: 'main' },
  status: 'running', exitCode: null, output: '', startedAt: '2026-10-11T00:00:00.000Z', completedAt: null, ...patch,
});

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('SC01 a command run maps to the scheduler\'s run states, with the exit code or spawn error as the note', () => {
  const { commandRunStateOf } = starterModule;
  assert.deepEqual(commandRunStateOf(run({ status: 'success', exitCode: 0 })), { status: 'succeeded', note: null });
  assert.deepEqual(commandRunStateOf(run({ status: 'failed', exitCode: 2 })), { status: 'failed', note: 'Exited with code 2' });
  assert.deepEqual(commandRunStateOf(run({ status: 'failed', output: 'x\nFailed to start: spawn ENOENT' })), { status: 'failed', note: 'Failed to start: spawn ENOENT' });
  assert.deepEqual(commandRunStateOf(run({ status: 'failed' })), { status: 'failed', note: 'The command failed' });
  assert.deepEqual(commandRunStateOf(run({ status: 'stopped' })), { status: 'stopped', note: 'Stopped by a person' });
  assert.deepEqual(commandRunStateOf(run({ status: 'running' })), { status: 'running', note: null });
});

test('SC02 a command job starts the saved command as an automatic run, tracked as command:<run id>, and reports its states', async () => {
  const project = await projectService.createProject({ name: 'Command Starter', position: null });
  const ok = await commandService.createCommand({ projectId: project.id, name: 'Ok', command: 'true' });
  const bad = await commandService.createCommand({ projectId: project.id, name: 'Bad', command: 'exit 2' });
  const runner = commandRunnerModule.createCommandRunner();
  const starter = starterModule.createManagerRunStarter(noManager, noConnections, undefined, runner);
  const seen: [string, RunState | null][] = [];
  const unsubscribe = starter.subscribe({ runChanged: (runId, state) => { seen.push([runId, state]); }, slotFreed: () => undefined });

  const { runId } = await starter.start({ project, job: jobFor(ok.id) });
  assert.match(runId, /^command:[0-9a-f-]{36}$/);
  const record = await runner.getCommandRun(runId.slice('command:'.length));
  assert.equal(record.automatic, true);
  await waitUntil(() => seen.some(([id, state]) => id === runId && state?.status === 'succeeded'));
  assert.deepEqual(seen.filter(([id]) => id === runId).map(([, state]) => state?.status), ['running', 'succeeded']);
  assert.deepEqual(await starter.state(runId), { status: 'succeeded', note: null });

  const failing = await starter.start({ project, job: jobFor(bad.id) });
  await waitUntil(async () => (await starter.state(failing.runId))?.status === 'failed');
  assert.deepEqual(await starter.state(failing.runId), { status: 'failed', note: 'Exited with code 2' });
  unsubscribe();
});

test('SC03 a command run a person started is not reported, and nothing is reported after unsubscribing', async () => {
  const project = await projectService.createProject({ name: 'Command Manual', position: null });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Quick', command: 'true' });
  const runner = commandRunnerModule.createCommandRunner();
  const starter = starterModule.createManagerRunStarter(noManager, noConnections, undefined, runner);
  const seen: string[] = [];
  const unsubscribe = starter.subscribe({ runChanged: (runId) => { seen.push(runId); }, slotFreed: () => undefined });

  const manual = await runner.runCommand(command.id);
  await waitUntil(async () => (await runner.getCommandRun(manual.id)).status !== 'running');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, []);

  unsubscribe();
  const after = await runner.runCommand(command.id, { automatic: true });
  await waitUntil(async () => (await runner.getCommandRun(after.id)).status !== 'running');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, []);
});

test('SC04 a command that is already running is a skipped start; a deleted command is a plain failure', async () => {
  const project = await projectService.createProject({ name: 'Command Conflict', position: null });
  const slow = await commandService.createCommand({ projectId: project.id, name: 'Slow', command: 'sleep 30' });
  const runner = commandRunnerModule.createCommandRunner();
  const starter = starterModule.createManagerRunStarter(noManager, noConnections, undefined, runner);

  const first = await starter.start({ project, job: jobFor(slow.id) });
  await assert.rejects(starter.start({ project, job: jobFor(slow.id) }), (error: Error) => error instanceof schedulerModule.SkipStartError && /already running/.test(error.message));
  await runner.stopCommandRun(first.runId.slice('command:'.length));
  assert.equal((await starter.state(first.runId))?.status, 'stopped');

  await commandService.deleteCommand(slow.id);
  await assert.rejects(starter.start({ project, job: jobFor(slow.id) }), (error: Error) => !(error instanceof schedulerModule.SkipStartError) && error.message === 'This command no longer exists');
});

test('SC05 the state of a command run that is gone, or of any run when there is no runner, is null; a start without a runner fails', async () => {
  const project = await projectService.createProject({ name: 'Command Missing', position: null });
  const runner = commandRunnerModule.createCommandRunner();
  const withRunner = starterModule.createManagerRunStarter(noManager, noConnections, undefined, runner);
  const without = starterModule.createManagerRunStarter(noManager, noConnections);
  assert.equal(await withRunner.state('command:does-not-exist'), null);
  assert.equal(await without.state('command:anything'), null);
  await assert.rejects(without.start({ project, job: jobFor('c') }), /no runner for saved commands/);
});

test('SC06 a command run that fails with an unexpected error while its state is read is surfaced, not hidden as a missing run', async () => {
  const broken = { runCommand: async () => run(), getCommandRun: async () => { throw new Error('disk gone'); }, onCommandEvent: (_listener: (event: CommandEvent) => void) => () => undefined };
  const starter = starterModule.createManagerRunStarter(noManager, noConnections, undefined, broken as never);
  await assert.rejects(starter.state('command:r1'), /disk gone/);
});
