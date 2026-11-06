import assert from 'node:assert/strict';
import { settledExecute } from './helpers/startRun.ts';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import type { TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import { autoAdvanceTerminalSteps } from './helpers/terminalStepFakes.ts';

/**
 * `reopenStepSession` (POST /api/tasks/:taskId/reopen-session): reopening a settled workflow step's
 * CLI session must leave the run's status and round settled, keep its launch setup, and use the
 * task branch's working copy when one can be restored.
 */

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let collections: typeof import('../src/db/collections.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'reopen-step-session-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workflowService = await import('../src/catalog/workflowService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  collections = await import('../src/db/collections.ts');

  await workflowService.updateWorkflow('software-development', {
    name: 'Reopen Test Workflow',
    description: 'A read-only gated step, then an editable one.',
    steps: [
      { id: 'plan', name: 'Planning', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Plan it.' },
      { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build it.' },
    ],
  });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fakeSummarizerTurn(): Promise<ClaudeTurnResult> {
  return {
    sessionId: 'summary-session', status: 'done', message: 'ok',
    extra: { tldr: 'Done.', requirement: 'r', whatWasDeveloped: 'd', reviewHighlights: 'n', docsUpdated: 'n', retroUpdates: 'n' },
    raw: { type: 'result' },
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A manager whose steps complete on their own. `live` stands in for the real host's `has` (a session
 * is live from its start until it is stopped, like a real PTY), and inspect sessions (the ones
 * launched with `reportHooks: false`) are kept apart in `inspectStarts`, so the step harness never
 * treats them as a step's own session.
 */
async function setup(name: string, executorId?: string, options: { holdLaterPlan?: boolean; delayInspectExit?: boolean } = {}) {
  const project = await projectService.createProject({ name, position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: `${name} item`, description: 'A test task.' });
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  let planCalls = 0;
  const { host, starts: normalStarts } = autoAdvanceTerminalSteps(managerRef, {
    plan: (id) => (++planCalls > 1 && options.holdLaterPlan ? undefined : managerRef.current!.completeStep(id, { summary: 'Planned.' })),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'Built.' }),
  });
  const live = new Set<string>();
  const stops: string[] = [];
  const inspectStarts: TerminalSessionStart[] = [];
  const liveInspect = new Map<string, TerminalSessionStart>();
  const delayedInspectExits = new Map<string, () => void>();
  const realStop = host.stop.bind(host);
  const realStart = host.start.bind(host);
  host.start = (input) => {
    live.add(input.taskId);
    if (input.reportHooks !== false) { realStart(input); return; }
    inspectStarts.push(input);
    liveInspect.set(input.taskId, input);
  };
  host.has = (taskId) => live.has(taskId);
  const exitInspect = (taskId: string, code: number) => {
    live.delete(taskId);
    const inspect = liveInspect.get(taskId)!;
    liveInspect.delete(taskId);
    inspect.onExit(code);
    return inspect.onExit;
  };
  host.stop = (taskId) => {
    stops.push(taskId);
    const inspect = liveInspect.get(taskId);
    if (!inspect) { live.delete(taskId); return realStop(taskId); }
    if (options.delayInspectExit) {
      delayedInspectExits.set(taskId, () => { live.delete(taskId); liveInspect.delete(taskId); inspect.onExit(0); });
      return true;
    }
    live.delete(taskId);
    liveInspect.delete(taskId);
    inspect.onExit(0);
    return true;
  };
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager;
  const first = await settledExecute(manager)(item.id, executorId ? { executorId } : undefined);
  const runId = first.workflowRunId!;
  await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === 'awaiting-approval');
  const planTaskId = (await manager.getWorkflowRunDetail(runId)).steps.find((s) => s.step.id === 'plan')!.rounds[0]!.taskId!;
  await waitUntil(async () => (await manager.getTask(planTaskId)).status === 'done');
  return { project, item, manager, runId, planTaskId, inspectStarts, normalStarts, stops, host, exitInspect, releaseInspectExit: (taskId: string) => delayedInspectExits.get(taskId)?.() };
}

/** Everything reopening must leave untouched: the run, its StepRuns and its Tasks. */
async function runSnapshot(runId: string) {
  return JSON.stringify({
    run: await collections.workflowRunsDb.get(runId),
    stepRuns: await collections.stepRunsDb.find((s) => s.runId === runId),
    tasks: await collections.tasksDb.find((t) => t.workflowRunId === runId),
  });
}

function lastStart(starts: TerminalSessionStart[]): TerminalSessionStart {
  return starts.at(-1)!;
}

test('reopening a completed run\'s step resumes its CLI session for inspection without changing the run', async () => {
  const { project, item, manager, runId, planTaskId, inspectStarts } = await setup('Reopen Completed');
  await manager.approveWorkflowRun(runId);
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');
  // The last step's own session exit settles its Task a moment after the run completes.
  await waitUntil(async () => (await collections.tasksDb.find((t) => t.workflowRunId === runId)).every((t) => t.status === 'done'));
  const before = await runSnapshot(runId);
  const planTask = await manager.getTask(planTaskId);

  assert.deepEqual(await manager.reopenStepSession(planTaskId), { location: 'project', mode: 'read-only' });

  const start = lastStart(inspectStarts);
  assert.equal(start.resume, true);
  assert.equal(start.sessionId, planTask.sessionId);
  assert.equal(start.prompt, '', 'no message is injected into the conversation');
  assert.equal(start.cwd, projectService.projectAbsolutePath(project));
  assert.equal(start.reportHooks, false, 'its CLI hooks must never reach the daemon');
  assert.equal(start.endWhenDetached, true, 'the process ends once nobody is watching it');
  assert.deepEqual(start.mcpServers?.[0]?.tools, ['diff_summary', 'diff_file'], 'only read helpers are offered');
  assert.equal(start.readOnly, true, 'the step\'s own permissions still apply');
  assert.deepEqual(start.readOnlyDirs, [path.join(tempRoot, 'data', 'step-outputs', project.id, runId)], 'it may still read the run\'s saved outputs');

  // Even a forged step-tool call from this session is refused, and its exit settles nothing.
  await assert.rejects(() => manager.completeStep(planTaskId, { summary: 'again' }), workerManagerModule.TaskNotWorkflowStepError);
  await assert.rejects(() => manager.skipStep(planTaskId, { reason: 'again' }), workerManagerModule.TaskNotWorkflowStepError);
  start.onExit(0, undefined, planTask.sessionId ?? undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await runSnapshot(runId), before);
  assert.equal((await manager.listTasksForProject(project.id)).length, 2, 'no new Task is created');
});

test('reopening uses the run worktree while it exists; in-place runs use the project folder', async () => {
  const { project, manager, runId, planTaskId, inspectStarts, host } = await setup('Reopen Worktree');
  const worktree = path.join(tempRoot, 'kept-worktree');
  await mkdir(worktree, { recursive: true });
  await collections.tasksDb.update(planTaskId, { worktreePath: worktree });
  await collections.workflowRunsDb.update(runId, { worktreePath: worktree });
  assert.deepEqual(await manager.reopenStepSession(planTaskId), { location: 'worktree', mode: 'read-only' });
  assert.equal(lastStart(inspectStarts).cwd, worktree);
  host.stop(planTaskId); // the viewer left

  await collections.workflowRunsDb.update(runId, { worktreePath: undefined });
  assert.deepEqual(await manager.reopenStepSession(planTaskId), { location: 'project', mode: 'read-only' });
  assert.equal(lastStart(inspectStarts).cwd, projectService.projectAbsolutePath(project));
});

test('reopening a session that is already open starts nothing new', async () => {
  const { manager, planTaskId, inspectStarts } = await setup('Reopen Live');
  await manager.reopenStepSession(planTaskId);
  await assert.rejects(() => manager.reopenStepSession(planTaskId), /live CLI process/);
  assert.equal(inspectStarts.length, 1);
});

test('unfinished run statuses reopen directly while a completed read-only step needs no choice', async () => {
  const { manager, runId, planTaskId } = await setup('Reopen Status Choices');
  for (const status of ['running', 'awaiting-approval', 'stopped', 'needs-attention', 'failed'] as const) {
    await collections.workflowRunsDb.update(runId, { status });
    assert.deepEqual(await manager.stepReopenOptions(planTaskId), { choiceRequired: false, permissionsAvailable: true }, status);
  }
  await collections.workflowRunsDb.update(runId, { status: 'completed' });
  assert.deepEqual(await manager.stepReopenOptions(planTaskId), { choiceRequired: false, permissionsAvailable: true });
});

test('stopping a reopened session ends only that session, leaves the run alone, and lets it be reopened', async () => {
  const { item, manager, runId, planTaskId, inspectStarts, stops } = await setup('Reopen Then Stop');
  await assert.rejects(() => manager.closeStepSession(planTaskId), (error: Error) => {
    assert.ok(error instanceof workerManagerModule.StepInspectSessionError);
    assert.equal(error.message, `Task "${item.title}" has no reopened session to stop`);
    return true;
  });
  await manager.reopenStepSession(planTaskId);
  const before = await runSnapshot(runId);
  stops.length = 0;
  await manager.closeStepSession(planTaskId);
  assert.deepEqual(stops, [planTaskId]);
  assert.equal(await runSnapshot(runId), before);
  await assert.rejects(() => manager.closeStepSession(planTaskId), workerManagerModule.StepInspectSessionError, 'its exit forgot it');
  await manager.reopenStepSession(planTaskId);
  assert.equal(inspectStarts.length, 2);
  await assert.rejects(() => manager.closeStepSession('does-not-exist'), workerManagerModule.TaskNotFoundError);
});

test('a run resuming the same step session closes an inspect session on it first', async () => {
  const { manager, runId, planTaskId, stops } = await setup('Reopen Then Request Changes');
  await manager.reopenStepSession(planTaskId);
  stops.length = 0;
  await manager.requestChangesWorkflowRun(runId, 'Tighten the plan.');
  assert.ok(stops.includes(planTaskId), 'the inspect session was stopped before the new round resumed it');
});

test('a settled earlier round cannot reopen or generically resume while a later round owns its CLI conversation', async () => {
  const { manager, runId, planTaskId, inspectStarts, normalStarts } = await setup('Live Later Round', undefined, { holdLaterPlan: true });
  await manager.requestChangesWorkflowRun(runId, 'Try another plan.');
  await waitUntil(async () => normalStarts.length === 2);
  assert.equal(normalStarts[1]?.sessionId, normalStarts[0]?.sessionId);
  await assert.rejects(() => manager.reopenStepSession(planTaskId), /live CLI process on this conversation/);
  await assert.rejects(() => manager.resumeTerminalTask(planTaskId), workerManagerModule.StepInspectSessionError);
  assert.equal(inspectStarts.length, 0);
});

test('two settled rounds sharing one session cannot each open a CLI process', async () => {
  const { manager, runId, planTaskId, inspectStarts, host } = await setup('Settled Shared Session');
  await manager.requestChangesWorkflowRun(runId, 'Try another plan.');
  await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === 'awaiting-approval');
  const planRounds = (await manager.getWorkflowRunDetail(runId)).steps.find((step) => step.step.id === 'plan')!.rounds;
  const laterTaskId = planRounds.at(-1)!.taskId!;
  await waitUntil(async () => (await manager.getTask(laterTaskId)).status === 'done');
  await manager.reopenStepSession(planTaskId);
  await assert.rejects(() => manager.reopenStepSession(laterTaskId), /live CLI process on this conversation/);
  await assert.rejects(() => manager.resumeTerminalTask(planTaskId), workerManagerModule.StepInspectSessionError);
  assert.equal(inspectStarts.length, 1);
  host.stop(planTaskId);
});

test('a later round waits for the reopened process exit after sending its stop signal', async () => {
  const { manager, runId, planTaskId, stops, normalStarts, host, releaseInspectExit } = await setup('Delayed Inspect Exit', undefined, { delayInspectExit: true });
  await manager.reopenStepSession(planTaskId);
  stops.length = 0;
  const continuation = manager.requestChangesWorkflowRun(runId, 'Revise after inspection.');
  await waitUntil(async () => stops.includes(planTaskId));
  assert.equal(host.has(planTaskId), true, 'the first process is still live after Stop');
  assert.equal(normalStarts.length, 1, 'no second process starts on the conversation while the kill is pending');
  releaseInspectExit(planTaskId);
  await continuation;
  await waitUntil(async () => normalStarts.length === 2);
  assert.equal(normalStarts[1]?.sessionId, normalStarts[0]?.sessionId);
});

test('reopening explains by name why it cannot, and never mentions ids', async () => {
  const { project, item, manager, planTaskId } = await setup('Reopen Errors');
  const task = await manager.getTask(planTaskId);

  await collections.tasksDb.update(planTaskId, { sessionId: null });
  await assert.rejects(() => manager.reopenStepSession(planTaskId), (error: Error) => {
    assert.ok(error instanceof workerManagerModule.TerminalSessionNotResumableError);
    assert.match(error.message, new RegExp(item.title));
    assert.ok(!error.message.includes(planTaskId));
    return true;
  });
  await collections.tasksDb.update(planTaskId, { sessionId: task.sessionId });

  await collections.tasksDb.update(planTaskId, { status: 'developing' });
  await assert.rejects(() => manager.reopenStepSession(planTaskId), /is still running/);
  await collections.tasksDb.update(planTaskId, { status: 'done' });

  await collections.tasksDb.update(planTaskId, { executorId: 'test-unsupported', sessionExecutor: undefined });
  await assert.rejects(() => manager.reopenStepSession(planTaskId), workerManagerModule.ExecutorNotSupportedError);
  await collections.tasksDb.update(planTaskId, { executorId: 'no-such-executor' });
  await assert.rejects(() => manager.reopenStepSession(planTaskId), /executor/i);
  await collections.tasksDb.update(planTaskId, { executorId: task.executorId, sessionExecutor: task.sessionExecutor });

  await collections.tasksDb.update(planTaskId, { workflowRunId: undefined });
  await assert.rejects(() => manager.reopenStepSession(planTaskId), /is not a workflow step/);
  await collections.tasksDb.update(planTaskId, { workflowRunId: task.workflowRunId });

  await rm(projectService.projectAbsolutePath(project), { recursive: true, force: true });
  await assert.rejects(() => manager.reopenStepSession(planTaskId), (error: Error) => {
    assert.ok(error instanceof workerManagerModule.StepInspectSessionError);
    assert.match(error.message, new RegExp(`project "${project.name}"`));
    assert.ok(!error.message.includes(project.id));
    return true;
  });

  await assert.rejects(() => manager.reopenStepSession('does-not-exist'), workerManagerModule.TaskNotFoundError);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function completedEditableRun(name: string, executorId?: string) {
  const fixture = await setup(name, executorId);
  await fixture.manager.approveWorkflowRun(fixture.runId);
  await waitUntil(async () => (await collections.workflowRunsDb.get(fixture.runId))?.status === 'completed');
  const detail = await fixture.manager.getWorkflowRunDetail(fixture.runId);
  const buildTaskId = detail.steps.find((s) => s.step.id === 'build')!.rounds[0]!.taskId!;
  await waitUntil(async () => (await collections.tasksDb.get(buildTaskId))?.status === 'done');
  if (executorId === 'test-codex-cli') await collections.tasksDb.update(buildTaskId, { sessionId: `codex-${buildTaskId}` });
  const root = projectService.projectAbsolutePath(fixture.project);
  const remote = path.join(tempRoot, `${name.replaceAll(' ', '-')}-remote.git`);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'commit', '--allow-empty', '-m', 'base');
  await mkdir(remote, { recursive: true });
  git(remote, 'init', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  const branch = `task/reopen-${fixture.runId.slice(0, 8)}`;
  git(root, 'branch', branch);
  git(root, 'push', 'origin', branch);
  const worktreePath = path.join(tempRoot, `reopened-${fixture.runId}`);
  await collections.workflowRunsDb.update(fixture.runId, { branch, baseBranch: 'main', worktreePath });
  await collections.tasksDb.update(buildTaskId, { branch, worktreePath });
  return { ...fixture, buildTaskId, root, remote, branch, worktreePath };
}

test('completed workflow steps cannot bypass reopen policy through generic Resume or Follow-up', async () => {
  for (const missingBranch of [false, true]) {
    const { manager, runId, buildTaskId, root, branch, worktreePath, inspectStarts, host } = await completedEditableRun(`Generic Step Guard ${missingBranch}`);
    if (missingBranch) {
      git(root, 'branch', '-D', branch);
      git(root, 'push', 'origin', '--delete', branch);
    }
    const before = (await collections.tasksDb.find((task) => task.workflowRunId === runId)).length;
    await assert.rejects(() => manager.resumeTerminalTask(buildTaskId), /workflow step; reopen it from the run's Session view/);
    await assert.rejects(() => manager.followUpTask(buildTaskId, 'Edit more'), /workflow step; reopen it from the run's Session view/);
    assert.equal((await collections.tasksDb.find((task) => task.workflowRunId === runId)).length, before);
    assert.equal(inspectStarts.length, 0, 'generic endpoints launch no CLI');
    assert.equal((await import('node:fs')).existsSync(worktreePath), false);
    assert.equal(git(root, 'branch', '--show-current'), 'main');
    const mode = missingBranch ? 'read-only' : 'permissions';
    const opened = await manager.reopenStepSession(buildTaskId, mode);
    assert.equal(opened.mode, mode);
    assert.equal(opened.location, missingBranch ? 'project' : 'recreated-worktree');
    assert.equal(inspectStarts.length, 1, 'only the step reopen endpoint launches its CLI');
    host.stop(buildTaskId);
  }
});

test('completed editable steps ask first, restore their branch, and retain dirty edits until discard', async () => {
  const { manager, runId, buildTaskId, root, branch, worktreePath, inspectStarts, host } = await completedEditableRun('Restore Writable');
  assert.deepEqual(await manager.stepReopenOptions(buildTaskId), { choiceRequired: true, permissionsAvailable: true });
  await assert.rejects(() => manager.reopenStepSession(buildTaskId), /needs a choice/);
  assert.deepEqual(await manager.reopenStepSession(buildTaskId, 'permissions'), { location: 'recreated-worktree', mode: 'permissions' });
  const start = lastStart(inspectStarts);
  assert.equal(start.cwd, worktreePath);
  assert.equal(start.readOnly, false);
  assert.match(start.systemPrompt, /# Builder/);
  assert.deepEqual(start.mcpServers?.map((server) => server.name), ['agent_visual_os_step', 'agent_visual_os_tests']);
  assert.equal(git(worktreePath, 'branch', '--show-current'), branch);
  assert.notEqual(worktreePath, root);
  await assert.rejects(() => manager.completeStep(buildTaskId, { summary: 'forged' }), workerManagerModule.TaskNotWorkflowStepError);
  await assert.rejects(() => manager.skipStep(buildTaskId, { reason: 'forged' }), workerManagerModule.TaskNotWorkflowStepError);
  await writeFile(path.join(worktreePath, 'later.txt'), 'later edit');
  host.stop(buildTaskId);
  await waitUntil(async () => Boolean((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges));
  assert.equal((await collections.workflowRunsDb.get(runId))?.status, 'completed');
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges?.state, 'pending');
  assert.equal(await manager.stepReopenOptions(buildTaskId).then(() => false, () => true), true);
  const states: string[] = [];
  const off = manager.onWorkerEvent((event) => { if (event.type === 'workflowRun') states.push(event.run.pendingInspectChanges?.state ?? 'resolved'); });
  await manager.resolveStepInspectChanges(runId, 'discard');
  off();
  assert.deepEqual(states, ['discarding', 'resolved']);
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, null);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  await assert.rejects(() => manager.resolveStepInspectChanges(runId, 'discard'), /no reopened changes/);
});

test('completed writable edits can be committed and pushed, then the recreated copy is removed', async () => {
  const { manager, runId, buildTaskId, root, branch, remote, worktreePath, host } = await completedEditableRun('Commit Writable');
  await manager.reopenStepSession(buildTaskId, 'permissions');
  await writeFile(path.join(worktreePath, 'later.txt'), 'saved edit');
  host.stop(buildTaskId);
  await waitUntil(async () => Boolean((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges));
  const states: string[] = [];
  const off = manager.onWorkerEvent((event) => { if (event.type === 'workflowRun') states.push(event.run.pendingInspectChanges?.state ?? 'resolved'); });
  await manager.resolveStepInspectChanges(runId, 'commit-push');
  off();
  assert.deepEqual(states, ['committing', 'resolved']);
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, null);
  assert.equal(git(root, 'show', `${branch}:later.txt`), 'saved edit');
  assert.equal(git(remote, 'show', `${branch}:later.txt`), 'saved edit');
  assert.equal((await collections.workflowRunsDb.get(runId))?.status, 'completed');
  assert.equal((await import('node:fs')).existsSync(worktreePath), false);
});

test('a missing task branch permits only project-folder read-only reopening', async () => {
  const { manager, runId, buildTaskId, root, branch, worktreePath, inspectStarts, host } = await completedEditableRun('Missing Branch');
  git(root, 'branch', '-D', branch);
  git(root, 'push', 'origin', '--delete', branch);
  const options = await manager.stepReopenOptions(buildTaskId);
  assert.equal(options.choiceRequired, true);
  assert.equal(options.permissionsAvailable, false);
  assert.match(options.reason ?? '', /Branch .* gone locally and on the remote/);
  await assert.rejects(() => manager.reopenStepSession(buildTaskId, 'permissions'), /Branch .* gone/);
  const opened = await manager.reopenStepSession(buildTaskId, 'read-only');
  assert.equal(opened.location, 'project');
  assert.equal(opened.mode, 'read-only');
  assert.match(opened.reason ?? '', /Branch .* gone/);
  const start = lastStart(inspectStarts);
  assert.equal(start.cwd, root);
  assert.equal(start.readOnly, true);
  assert.deepEqual(start.mcpServers?.[0]?.tools, ['diff_summary', 'diff_file']);
  assert.equal(start.mcpServers?.some((server) => server.name === 'agent_visual_os_tests'), false);
  host.stop(buildTaskId);
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, undefined);
  assert.equal((await import('node:fs')).existsSync(worktreePath), false);
});

test('failed branch restoration leaves no inspect process or half-created working copy', async () => {
  const { manager, buildTaskId, root, branch, worktreePath, inspectStarts } = await completedEditableRun('Restore Failure');
  const occupied = path.join(tempRoot, 'occupied-branch-worktree');
  git(root, 'worktree', 'add', occupied, branch);
  await assert.rejects(() => manager.reopenStepSession(buildTaskId, 'permissions'), /Git operation failed/);
  assert.equal(inspectStarts.length, 0);
  assert.equal((await import('node:fs')).existsSync(worktreePath), false);
});

test('an unavailable remote is a retryable lookup error rather than a false missing-branch claim', async () => {
  const { manager, buildTaskId, root, branch, inspectStarts } = await completedEditableRun('Remote Lookup Failure');
  git(root, 'branch', '-D', branch);
  git(root, 'remote', 'set-url', 'origin', path.join(tempRoot, 'unreachable-remote.git'));
  await assert.rejects(() => manager.stepReopenOptions(buildTaskId), /Git operation failed/);
  assert.equal(inspectStarts.length, 0);
});

test('two completed-run reopen requests start only one process', async () => {
  const { manager, buildTaskId, inspectStarts, host } = await completedEditableRun('Double Reopen');
  const results = await Promise.allSettled([
    manager.reopenStepSession(buildTaskId, 'permissions'),
    manager.reopenStepSession(buildTaskId, 'permissions'),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(inspectStarts.length, 1);
  host.stop(buildTaskId);
});

test('a remote-only branch is restored for a completed read-only choice and its clean copy is removed on exit', async () => {
  const { manager, runId, buildTaskId, root, branch, worktreePath, inspectStarts, host } = await completedEditableRun('Remote Only');
  git(root, 'branch', '-D', branch);
  assert.deepEqual(await manager.stepReopenOptions(buildTaskId), { choiceRequired: true, permissionsAvailable: true });
  assert.deepEqual(await manager.reopenStepSession(buildTaskId, 'read-only'), { location: 'recreated-worktree', mode: 'read-only' });
  const start = lastStart(inspectStarts);
  assert.equal(start.readOnly, true);
  assert.ok(start.disallowedTools?.includes('Bash'));
  assert.deepEqual(start.mcpServers?.[0]?.tools, ['diff_summary', 'diff_file']);
  assert.equal(start.mcpServers?.some((server) => server.name === 'agent_visual_os_tests'), false);
  assert.equal(git(worktreePath, 'branch', '--show-current'), branch);
  await assert.rejects(() => manager.requireTestingSession(buildTaskId), workerManagerModule.TaskNotTestingSessionError);
  host.stop(buildTaskId);
  await waitUntil(async () => !(await import('node:fs')).existsSync(worktreePath));
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, undefined);
});

test('a clean writable reopened session removes only its recreated copy', async () => {
  const { manager, runId, buildTaskId, worktreePath, host } = await completedEditableRun('Clean Writable');
  await manager.reopenStepSession(buildTaskId, 'permissions');
  assert.equal((await manager.requireTestingSession(buildTaskId)).id, buildTaskId);
  assert.match(await manager.stepDiffSummary(buildTaskId), /Files:/);
  host.stop(buildTaskId);
  await waitUntil(async () => !(await import('node:fs')).existsSync(worktreePath));
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, undefined);
  assert.equal((await collections.workflowRunsDb.get(runId))?.status, 'completed');
});

test('a nonzero exit records one durable decision even if the exit callback repeats', async () => {
  const { manager, runId, buildTaskId, worktreePath, exitInspect } = await completedEditableRun('Nonzero Inspect Exit');
  await manager.reopenStepSession(buildTaskId, 'permissions');
  await writeFile(path.join(worktreePath, 'failure-edit.txt'), 'keep this edit');
  const exit = exitInspect(buildTaskId, 1);
  await waitUntil(async () => Boolean((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges));
  const first = (await collections.workflowRunsDb.get(runId))!.pendingInspectChanges;
  exit(1);
  assert.deepEqual((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, first);
  assert.equal((await import('node:fs')).existsSync(worktreePath), true);
  await manager.resolveStepInspectChanges(runId, 'discard');
});

test('a completed in-place run resumes in the project folder and keeps its folder on exit', async () => {
  const { manager, runId, buildTaskId, root, inspectStarts, host } = await completedEditableRun('Completed In Place');
  await collections.workflowRunsDb.update(runId, { branch: undefined, worktreePath: undefined });
  await collections.tasksDb.update(buildTaskId, { branch: undefined, worktreePath: undefined });
  assert.deepEqual(await manager.stepReopenOptions(buildTaskId), { choiceRequired: true, permissionsAvailable: true });
  assert.deepEqual(await manager.reopenStepSession(buildTaskId, 'permissions'), { location: 'project', mode: 'permissions' });
  assert.equal(lastStart(inspectStarts).cwd, root);
  await writeFile(path.join(root, 'in-place.txt'), 'keep in project');
  host.stop(buildTaskId);
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, undefined);
  assert.equal((await import('node:fs')).existsSync(root), true);
});

test('a pending decision survives a manager restart and a push failure keeps it retryable', async () => {
  const { manager, runId, buildTaskId, root, remote, worktreePath, host } = await completedEditableRun('Retry Push');
  await manager.reopenStepSession(buildTaskId, 'permissions');
  await writeFile(path.join(worktreePath, 'retry.txt'), 'retry me');
  host.stop(buildTaskId);
  await waitUntil(async () => Boolean((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges));
  const restarted = workerManagerModule.createWorkerManager({ terminalSessions: host, runClaudeTurn: fakeSummarizerTurn });
  assert.equal((await restarted.getWorkflowRunDetail(runId)).run.pendingInspectChanges?.hasChanges, true);
  git(root, 'remote', 'set-url', 'origin', path.join(tempRoot, 'missing-remote.git'));
  await assert.rejects(() => restarted.resolveStepInspectChanges(runId, 'commit-push'), /Git operation failed/);
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges?.state, 'pending');
  assert.equal((await import('node:fs')).existsSync(worktreePath), true);
  git(root, 'remote', 'set-url', 'origin', remote);
  await restarted.resolveStepInspectChanges(runId, 'commit-push');
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, null);
  assert.equal((await import('node:fs')).existsSync(worktreePath), false);
});

test('a stale decision never removes a working copy switched to another branch', async () => {
  const { manager, runId, buildTaskId, worktreePath, host } = await completedEditableRun('Stale Branch Decision');
  await manager.reopenStepSession(buildTaskId, 'permissions');
  await writeFile(path.join(worktreePath, 'stale.txt'), 'keep this');
  host.stop(buildTaskId);
  await waitUntil(async () => Boolean((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges));
  git(worktreePath, 'switch', '-c', 'other-work');
  await assert.rejects(() => manager.resolveStepInspectChanges(runId, 'discard'), /no longer on task branch/);
  assert.equal((await import('node:fs')).existsSync(worktreePath), true);
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges?.state, 'pending');
});

test('a cleanup failure keeps the recreated copy and exposes a retry action', async () => {
  const { runId, buildTaskId, worktreePath, host } = await completedEditableRun('Retry Cleanup');
  const failing = workerManagerModule.createWorkerManager({ terminalSessions: host, runClaudeTurn: fakeSummarizerTurn, removeWorktree: async () => { throw new Error('busy worktree'); } });
  await failing.reopenStepSession(buildTaskId, 'read-only');
  host.stop(buildTaskId);
  await waitUntil(async () => Boolean((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges));
  const pending = (await collections.workflowRunsDb.get(runId))!.pendingInspectChanges!;
  assert.equal(pending.hasChanges, false);
  assert.match(pending.error ?? '', /busy worktree/);
  assert.equal((await import('node:fs')).existsSync(worktreePath), true);
  const restarted = workerManagerModule.createWorkerManager({ terminalSessions: host, runClaudeTurn: fakeSummarizerTurn });
  await assert.rejects(() => restarted.resolveStepInspectChanges(runId, 'commit-push'), /no edits to commit/);
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges?.state, 'pending');
  await restarted.resolveStepInspectChanges(runId, 'discard');
  assert.equal((await import('node:fs')).existsSync(worktreePath), false);
});

test('Codex step reopening keeps sandbox, developer instructions and MCP overrides on its resume command', async () => {
  const { manager, buildTaskId, inspectStarts, host } = await completedEditableRun('Codex Reopen', 'test-codex-cli');
  const { interactiveCliArgs } = await import('../src/terminal/terminalSessionManager.ts');
  await manager.reopenStepSession(buildTaskId, 'read-only');
  const safe = lastStart(inspectStarts);
  const safeArgs = interactiveCliArgs(safe);
  assert.equal(safeArgs[0], 'resume');
  assert.ok(safeArgs.includes('read-only'));
  assert.ok(safeArgs.includes('never'));
  assert.ok(safeArgs.some((arg) => arg.includes('developer_instructions=')));
  assert.ok(safeArgs.some((arg) => arg.includes('mcp_servers.agent_visual_os_step')));
  assert.equal(safeArgs.some((arg) => arg.includes('mcp_servers.agent_visual_os_tests')), false);
  host.stop(buildTaskId);
  await waitUntil(async () => !(await import('node:fs')).existsSync(safe.cwd));
  await waitUntil(async () => { try { await manager.stepReopenOptions(buildTaskId); return true; } catch { return false; } });
  await manager.reopenStepSession(buildTaskId, 'permissions');
  const writable = lastStart(inspectStarts);
  const writableArgs = interactiveCliArgs(writable);
  assert.equal(writableArgs[0], 'resume');
  assert.ok(writableArgs.includes('tui.resume_cwd="current"'));
  assert.ok(writableArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(writableArgs.some((arg) => arg.includes('mcp_servers.agent_visual_os_tests')));
  host.stop(buildTaskId);
});

test('a settled round in an unfinished run keeps its writable worktree and tools', async () => {
  const { manager, runId, buildTaskId, root, branch, worktreePath, inspectStarts, host } = await completedEditableRun('Unfinished Worktree');
  git(root, 'worktree', 'add', worktreePath, branch);
  await collections.workflowRunsDb.update(runId, { status: 'needs-attention' });
  assert.deepEqual(await manager.stepReopenOptions(buildTaskId), { choiceRequired: false, permissionsAvailable: true });
  assert.deepEqual(await manager.reopenStepSession(buildTaskId), { location: 'worktree', mode: 'permissions' });
  const start = lastStart(inspectStarts);
  assert.equal(start.readOnly, false);
  assert.deepEqual(start.mcpServers?.map((server) => server.name), ['agent_visual_os_step', 'agent_visual_os_tests']);
  assert.equal((await manager.requireTestingSession(buildTaskId)).id, buildTaskId);
  assert.match(await manager.stepDiffSummary(buildTaskId), /Files:/);
  assert.equal(await manager.stepDiffFile(buildTaskId, 'none.txt'), '(no changes to this file)');
  await assert.rejects(() => manager.completeStep(buildTaskId, { summary: 'forged' }), workerManagerModule.TaskNotWorkflowStepError);
  host.stop(buildTaskId);
  assert.equal((await collections.workflowRunsDb.get(runId))?.status, 'needs-attention');
  assert.equal((await import('node:fs')).existsSync(worktreePath), true);
});

test('an unfinished run restores a missing worktree and keeps it for subsequent rounds', async () => {
  const { manager, runId, buildTaskId, worktreePath, host } = await completedEditableRun('Unfinished Restore');
  await collections.workflowRunsDb.update(runId, { status: 'failed' });
  assert.deepEqual(await manager.reopenStepSession(buildTaskId), { location: 'recreated-worktree', mode: 'permissions' });
  host.stop(buildTaskId);
  assert.equal((await import('node:fs')).existsSync(worktreePath), true);
  assert.equal((await collections.workflowRunsDb.get(runId))?.pendingInspectChanges, undefined);
});

test('dirty-copy detection includes staged, modified, deleted and untracked files but ignores ignored files', async () => {
  const root = await mkdtemp(path.join(tempRoot, 'dirty-status-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  await writeFile(path.join(root, '.gitignore'), '*.log\n');
  await writeFile(path.join(root, 'modified.txt'), 'before');
  await writeFile(path.join(root, 'deleted.txt'), 'before');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'base');
  await writeFile(path.join(root, 'ignored.log'), 'ignored');
  const { workingTreeChanges } = await import('../src/projects/git.ts');
  assert.deepEqual(await workingTreeChanges(root), []);
  await writeFile(path.join(root, 'modified.txt'), 'after');
  await rm(path.join(root, 'deleted.txt'));
  await writeFile(path.join(root, 'staged.txt'), 'staged');
  git(root, 'add', 'staged.txt');
  await writeFile(path.join(root, 'untracked.txt'), 'untracked');
  const changes = await workingTreeChanges(root);
  for (const file of ['modified.txt', 'deleted.txt', 'staged.txt', 'untracked.txt']) assert.ok(changes.some((line) => line.includes(file)), file);
  assert.equal(changes.some((line) => line.includes('ignored.log')), false);
});

async function withCommandPlanStep<T>(run: () => Promise<T>): Promise<T> {
  const original = (await workflowService.getWorkflow('software-development'))!;
  await workflowService.updateWorkflow('software-development', {
    steps: original.steps.map((s) => (s.id === 'plan' ? { ...s, canRunCommands: true } : s)),
  });
  try { return await run(); } finally { await workflowService.updateWorkflow('software-development', { steps: original.steps }); }
}

test('a settled command-only step offers the choice; read-only denies the shell and tests, with permissions allows the shell and tests but no edits', async () => {
  await withCommandPlanStep(async () => {
    const { manager, runId, planTaskId, inspectStarts, host } = await setup('Reopen Command Step');
    await manager.approveWorkflowRun(runId);
    await waitUntil(async () => (await collections.workflowRunsDb.get(runId))?.status === 'completed');
    await waitUntil(async () => (await collections.tasksDb.find((t) => t.workflowRunId === runId)).every((t) => t.status === 'done'));
    assert.equal((await manager.getTask(planTaskId)).sessionSetup?.canRunCommands, true);
    assert.deepEqual(await manager.stepReopenOptions(planTaskId), { choiceRequired: true, permissionsAvailable: true });

    assert.equal((await manager.reopenStepSession(planTaskId, 'read-only')).mode, 'read-only');
    const readOnly = lastStart(inspectStarts);
    assert.ok(readOnly.disallowedTools?.includes('Bash'));
    assert.ok(readOnly.disallowedTools?.includes('Edit'));
    assert.equal(readOnly.canRunCommands, false);
    assert.equal(readOnly.mcpServers?.some((server) => server.name === 'agent_visual_os_tests'), false);
    assert.match(readOnly.systemPrompt, /read-only/);
    host.stop(planTaskId);

    assert.equal((await manager.reopenStepSession(planTaskId, 'permissions')).mode, 'permissions');
    const withPermissions = lastStart(inspectStarts);
    assert.deepEqual(withPermissions.disallowedTools, ['Edit', 'Write', 'NotebookEdit']);
    assert.equal(withPermissions.readOnly, true);
    assert.equal(withPermissions.canRunCommands, true);
    assert.deepEqual(withPermissions.mcpServers?.map((server) => server.name), ['agent_visual_os_step', 'agent_visual_os_tests']);
    assert.deepEqual(withPermissions.mcpServers?.[0]?.tools, ['diff_summary', 'diff_file']);
    host.stop(planTaskId);
  });
});

test('a stored session setup without canRunCommands stays read-only and offers no choice, even when the step now has the option', async () => {
  await withCommandPlanStep(async () => {
    const { manager, runId, planTaskId, inspectStarts } = await setup('Reopen Legacy Setup');
    await manager.approveWorkflowRun(runId);
    await waitUntil(async () => (await collections.workflowRunsDb.get(runId))?.status === 'completed');
    const task = await manager.getTask(planTaskId);
    const { canRunCommands: _dropped, ...legacy } = task.sessionSetup!;
    await collections.tasksDb.update(planTaskId, { sessionSetup: { ...legacy, readOnly: true, disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'NotebookEdit'] } });
    assert.deepEqual(await manager.stepReopenOptions(planTaskId), { choiceRequired: false, permissionsAvailable: true });
    assert.equal((await manager.reopenStepSession(planTaskId)).mode, 'read-only');
    assert.ok(lastStart(inspectStarts).disallowedTools?.includes('Bash'));
  });
});
