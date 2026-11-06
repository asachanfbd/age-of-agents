import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { TaskRecord, WorkflowRunRecord, WorkflowStep } from '../src/domain/types.ts';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import type { TerminalSessionHost, TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import type { JobHistoryEntry } from '../src/scheduler/types.ts';
import { fakeClock } from './helpers/schedulerFakes.ts';

/**
 * Scheduled jobs through the real worker manager: the run starter, the approval gate, and how a run's states reach
 * the job's history. CLI sessions are fake hosts that run a scripted action per workflow step; no CLI is started.
 */

/** These runs never call a capability, so the starter's connections are inert. */
const noConnections = { callFromJob: async () => { throw new Error('no capability calls in this test'); }, callState: async () => null, onCallChanged: () => () => undefined };

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let schedulerModule: typeof import('../src/scheduler/scheduler.ts');
let runStarterModule: typeof import('../src/scheduler/runStarter.ts');
let collections: typeof import('../src/db/collections.ts');
let notifications: typeof import('../src/notifications/notificationService.ts');

type Manager = ReturnType<typeof workerManagerModule.createWorkerManager>;

const TYPE_ID = 'sched-runs';
const step = (id: string, patch: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), agentId: 'manager', canEditCode: false, requiresApproval: false, instructions: `Do the ${id} step.`, ...patch,
});

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'scheduler-runs-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  schedulerModule = await import('../src/scheduler/scheduler.ts');
  runStarterModule = await import('../src/scheduler/runStarter.ts');
  collections = await import('../src/db/collections.ts');
  notifications = await import('../src/notifications/notificationService.ts');
  const { createWorkflow } = await import('../src/catalog/workflowService.ts');
  await createWorkflow({ id: 'three-steps', name: 'Three steps', description: 'Draft, check, publish.', steps: [step('draft'), step('check'), step('publish')] });
  await createWorkflow({ id: 'one-step', name: 'One step', description: 'A single step.', steps: [step('only')] });
  await createWorkflow({ id: 'own-approval', name: 'Own approval', description: 'A workflow with its own approval step.', steps: [step('prepare', { requiresApproval: true }), step('finish')] });
  await createWorkflow({ id: 'ends-in-approval', name: 'Ends in approval', description: 'The last step is an approval step.', steps: [step('draft'), step('review'), step('publish', { requiresApproval: true })] });
  await createWorkflow({ id: 'switched-off', name: 'Switched off', description: 'Disabled.', enabled: false, steps: [step('only')] });
  const { registerBuildingType } = await import('../src/buildings/registry.ts');
  const slot = (id: string, defaultWorkflowId: string) => ({ id, label: id, usedWhen: 'x', defaultWorkflowId });
  registerBuildingType({
    id: TYPE_ID, name: 'Scheduled runs', description: 'A type for scheduler run tests.', category: 'Test', version: 1,
    look: { model: 'generic', color: '#fff' }, workspace: 'notes', repository: false,
    validateCreate: () => ({ ok: true, value: { name: 'x' } }),
    slots: [slot('three', 'three-steps'), slot('one', 'one-step'), slot('gated', 'own-approval'), slot('signed-off', 'ends-in-approval'), slot('off', 'switched-off'), slot('missing', 'no-such-workflow')],
    agents: [], scheduledJobs: [], capabilities: [], events: [],
  });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function summarizerTurn(): Promise<ClaudeTurnResult> {
  return { sessionId: 's', status: 'done', message: 'ok', extra: { tldr: 'Done.', requirement: 'r', whatWasDeveloped: 'd', reviewHighlights: 'none', docsUpdated: 'none', retroUpdates: 'none' }, raw: { type: 'result' } };
}

async function waitUntil(check: () => Promise<boolean>, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 15_000) throw new Error(`waitUntil: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** What a step's fake CLI session does: `complete` reports the step done; `exit(code)` ends the session without that. */
type StepScript = (session: { taskId: string; manager: Manager; exit: (code: number) => void }) => unknown;

let buildingCount = 0;

async function world(t: TestContext, script: Record<string, StepScript> = {}) {
  const clock = fakeClock('2026-10-11T05:50:00.000Z');
  const starts: TerminalSessionStart[] = [];
  const ref: { manager?: Manager } = {};
  const complete: StepScript = ({ taskId, manager }) => manager.completeStep(taskId, { summary: 'Done.' });
  const host: TerminalSessionHost = {
    start(input) {
      starts.push(input);
      void (async () => {
        const task = await ref.manager!.getTask(input.taskId).catch(() => null);
        if (!task?.workflowStepId) return;
        await (script[task.workflowStepId] ?? complete)({ taskId: input.taskId, manager: ref.manager!, exit: (code) => input.onExit(code, undefined, input.sessionId ?? undefined) });
      })();
    },
    attach: () => () => undefined,
    write() {},
    resize() {},
    stop(taskId) {
      const start = [...starts].reverse().find((s) => s.taskId === taskId);
      if (start) start.onExit(0, undefined, start.sessionId ?? undefined);
      return true;
    },
    has: () => true,
    isAttached: () => false,
    count: () => 0,
  };
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: summarizerTurn, terminalSessions: host });
  ref.manager = manager;
  const scheduler = schedulerModule.createScheduler({
    starter: runStarterModule.createManagerRunStarter(manager, noConnections), now: clock.now, setTimer: clock.setTimer, hostTimezone: 'UTC',
  });
  buildingCount += 1;
  const project = await projectService.createProject({ name: `Scheduled ${buildingCount}`, position: null, typeId: TYPE_ID });
  await scheduler.start();
  t.after(() => scheduler.stop());
  const history = async (jobId: string): Promise<JobHistoryEntry[]> => (await scheduler.listHistory(project.id, jobId, {})).entries;
  return {
    clock, manager, scheduler, project, starts, history,
    job: (patch: Record<string, unknown> = {}) => scheduler.createJob(project.id, {
      name: 'Weekly review', trigger: { kind: 'cron', cron: '0 9 * * *' }, target: { kind: 'slot', slotId: 'three', description: 'Review the week.' }, ...patch,
    }),
    /** Waits until the job's newest entry has this outcome, then returns it. */
    async entry(jobId: string, outcome: string): Promise<JobHistoryEntry> {
      await waitUntil(async () => (await history(jobId))[0]?.outcome === outcome, `the newest entry to be ${outcome}`);
      return (await history(jobId))[0]!;
    },
    run: async (runId: string): Promise<WorkflowRunRecord> => (await manager.getWorkflowRunDetail(runId)).run,
    stepTasks: async (runId: string): Promise<TaskRecord[]> => (await collections.tasksDb.find((task) => task.workflowRunId === runId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    projectNotifications: async () => (await notifications.listNotifications({ projectId: project.id })).map((n) => [n.kind, n.resolvedAt === null]),
  };
}

test('IE02 a scheduled run is an ordinary run of the Building: in its workflow runs and plan, with the same notifications as a manual run', async (t) => {
  const w = await world(t);
  const job = await w.job({ target: { kind: 'slot', slotId: 'one', description: 'Review the week.' } });
  const { entry: started, status } = await w.scheduler.runNow(w.project.id, job.id);
  assert.equal(status, 'started');
  const done = await w.entry(job.id, 'succeeded');
  assert.equal(done.runId, started.runId);

  const runs = await w.manager.listWorkflowRunsForProject(w.project.id);
  assert.deepEqual(runs.map((run) => [run.id, run.workflowId, run.status]), [[started.runId, 'one-step', 'completed']]);
  const items = await planItemService.listPlanItems(w.project.id);
  assert.deepEqual(items.map((item) => [item.title, item.description, item.status, item.workflowRunId, item.scheduledJobId]), [['Weekly review', 'Review the week.', 'done', started.runId, job.id]]);
  const scheduledNotifications = await w.projectNotifications();

  await waitUntil(async () => (await projectService.getProject(w.project.id)).status === 'idle', 'the Building to be idle');
  const manual = await planItemService.createPlanItem({ projectId: w.project.id, title: 'By hand', description: 'Review the week.' });
  await w.manager.executePlanItem(manual.id, { workflowId: 'one-step' });
  await waitUntil(async () => (await planItemService.getPlanItem(manual.id)).status === 'done', 'the manual run to finish');
  assert.deepEqual(await w.projectNotifications(), scheduledNotifications, 'a manual run of the same workflow raises nothing more');
});

test('IE02 a scheduled run\'s item never holds the Planning queue: a stopped one does not make a manual start wait', async (t) => {
  const w = await world(t);
  const job = await w.job({ needsApproval: true, target: { kind: 'slot', slotId: 'one', description: 'x' } });
  const { entry } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'awaiting-approval');
  await w.manager.stopWorkflowRun(entry.runId!);
  await w.entry(job.id, 'stopped');
  const manual = await planItemService.createPlanItem({ projectId: w.project.id, title: 'By hand', description: 'x' });
  const result = await w.manager.enqueuePlanItemExecution(manual.id, { workflowId: 'one-step' });
  assert.equal(result.started, true, 'an unfinished manual item would have held the queue; a scheduled one does not');
});

test('IE11 a failed run that still owns the Building\'s folder makes the next scheduled start wait as Queued', async (t) => {
  const w = await world(t, { only: ({ exit }) => exit(1) });
  const job = await w.job({ overlap: 'parallel', target: { kind: 'slot', slotId: 'one', description: 'Fails.' } });
  const { entry: first } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'failed');
  await waitUntil(async () => (await projectService.getProject(w.project.id)).status === 'idle', 'the Building to be idle');
  const second = await w.scheduler.runNow(w.project.id, job.id);
  assert.deepEqual([second.status, second.entry.note], ['queued', 'Waiting for a free slot in this Building']);
  // Stopping the failed run settles it and frees the folder; the queued start then goes ahead.
  await w.manager.stopWorkflowRun(first.runId!);
  await waitUntil(async () => (await w.history(job.id))[0]!.runId !== null, 'the queued start to begin');
});

test('IE03 a single-prompt job starts a Task for the Building with that prompt and agent', async (t) => {
  const w = await world(t);
  const job = await w.job({ name: 'Summarise', target: { kind: 'prompt', agentId: 'builder', prompt: 'Summarise what changed this week.' } });
  const { entry } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'succeeded');
  const [task] = await w.stepTasks(entry.runId!);
  assert.deepEqual([task!.projectId, task!.templateId, task!.workflowStepId], [w.project.id, 'builder', 'prompt']);
  assert.ok((await w.manager.listTasksForProject(w.project.id)).some((listed) => listed.id === task!.id));
  assert.match(w.starts[0]!.prompt, /Summarise what changed this week\./);
  const run = await w.run(entry.runId!);
  assert.deepEqual([run.workflowId, run.workflowSnapshot.steps.map((s) => [s.id, s.agentId, s.requiresApproval])], ['scheduled-prompt', [['prompt', 'builder', false]]]);
  assert.deepEqual((await planItemService.listPlanItems(w.project.id)).map((item) => [item.title, item.description]), [['Summarise', 'Summarise what changed this week.']]);
});

test('IE03 a prompt job with no agent uses the Catalog\'s default agent; one whose agent is gone fails with the reason', async (t) => {
  const w = await world(t);
  const job = await w.job({ target: { kind: 'prompt', prompt: 'Go.' } });
  const { entry } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'succeeded');
  const { getDefaultAgent } = await import('../src/catalog/catalogService.ts');
  assert.equal((await w.stepTasks(entry.runId!))[0]!.templateId, (await getDefaultAgent()).id);

  await waitUntil(async () => (await projectService.getProject(w.project.id)).status === 'idle', 'the Building to be idle');
  await collections.scheduledJobsDb.update(job.id, { target: { kind: 'prompt', agentId: 'retired', prompt: 'Go.' } });
  await assert.rejects(w.scheduler.runNow(w.project.id, job.id), { status: 409, message: 'Agent "retired" is no longer in the Catalog' });
  const [failed] = await w.history(job.id);
  assert.deepEqual([failed!.outcome, failed!.note, failed!.runId], ['failed', 'Agent "retired" is no longer in the Catalog', null]);
  // The job can still be switched off, although its agent is gone.
  assert.equal((await w.scheduler.updateJob(w.project.id, job.id, { enabled: false })).enabled, false);
});

test('IE11 a manually started task holding the Building\'s slot makes a scheduled start wait as Queued, then start', async (t) => {
  const w = await world(t);
  const job = await w.job({ target: { kind: 'slot', slotId: 'one', description: 'x' } });
  const now = new Date().toISOString();
  // A Task that is live without a CLI process: it holds the Building's one slot (see .docs/testing.md).
  await collections.tasksDb.insert({
    id: 'manual-task', projectId: w.project.id, templateId: 'builder', executorId: 'test-claude-cli', executionMode: 'terminal', description: 'By hand',
    status: 'developing', autonomy: 'autonomous', manager: false, kind: 'execute', planItemId: null, sessionId: null, runtimeStatus: 'starting',
    runtimeWaitingReason: null, runtimeStatusChangedAt: now, blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, createdAt: now, updatedAt: now, completedAt: null,
  } as unknown as TaskRecord);
  await collections.projectsDb.update(w.project.id, { activeTaskIds: ['manual-task'], activeTaskId: 'manual-task' });
  const { status, entry } = await w.scheduler.runNow(w.project.id, job.id);
  assert.deepEqual([status, entry.outcome, entry.note], ['queued', 'queued', 'Waiting for a free slot in this Building']);
  assert.deepEqual(await planItemService.listPlanItems(w.project.id), [], 'a start that cannot fit leaves no task behind');
  await collections.tasksDb.delete('manual-task');
  await collections.projectsDb.update(w.project.id, { activeTaskIds: [], activeTaskId: null });
  await w.scheduler.tick();
  const done = await w.entry(job.id, 'succeeded');
  assert.equal(done.id, entry.id);
});

test('IE16 an agent that hits its usage limit mid-run fails the run as it does today, and the history entry names the limit', async (t) => {
  const w = await world(t, {
    only: async ({ taskId, manager, exit }) => {
      await manager.handleTerminalHook(taskId, { hook_event_name: 'StopFailure', error: 'You have hit your usage limit' });
      exit(1);
    },
  });
  const job = await w.job({ target: { kind: 'slot', slotId: 'one', description: 'x' } });
  const { entry: started } = await w.scheduler.runNow(w.project.id, job.id);
  const failed = await w.entry(job.id, 'failed');
  assert.match(failed.note!, /Only step ended without completing/);
  assert.match(failed.note!, /You have hit your usage limit/);
  assert.equal((await w.run(started.runId!)).status, 'needs-attention', 'the run itself ends as any failed step does');
  await waitUntil(async () => (await w.scheduler.getSchedules(w.project.id)).jobs[0]!.consecutiveFailures === 1, 'the failure to be counted');
  assert.ok((await w.projectNotifications()).some(([kind, open]) => kind === 'schedule.run_failed' && open));
});

test('IE17 needs approval on a three-step workflow: the run waits before the last step, raises the approval notification, and approve finishes it', async (t) => {
  const w = await world(t);
  const job = await w.job({ needsApproval: true });
  const { entry: started } = await w.scheduler.runNow(w.project.id, job.id);
  const waiting = await w.entry(job.id, 'awaiting-approval');
  assert.deepEqual([waiting.note, waiting.finishedAt], ['Waiting for approval', null]);
  const paused = await w.run(started.runId!);
  assert.deepEqual([paused.status, paused.currentStepId], ['awaiting-approval', 'check']);
  assert.deepEqual(paused.workflowSnapshot.steps.map((s) => [s.id, s.requiresApproval]), [['draft', false], ['check', true], ['publish', false]]);
  assert.deepEqual((await w.stepTasks(started.runId!)).map((task) => task.workflowStepId), ['draft', 'check'], 'the last step has not started');
  assert.ok((await w.projectNotifications()).some(([kind, open]) => kind === 'workflow.awaiting_approval' && open));
  assert.deepEqual((await w.scheduler.getSchedules(w.project.id)).jobs[0]!.activeRun, { entryId: waiting.id, runId: started.runId, outcome: 'awaiting-approval' });
  const { getWorkflow } = await import('../src/catalog/workflowService.ts');
  assert.deepEqual((await getWorkflow('three-steps'))!.steps.map((s) => s.requiresApproval), [false, false, false], 'the Catalog workflow is unchanged');

  await w.manager.approveWorkflowRun(started.runId!);
  const done = await w.entry(job.id, 'succeeded');
  assert.equal(done.id, waiting.id);
  assert.deepEqual((await w.stepTasks(started.runId!)).map((task) => task.workflowStepId), ['draft', 'check', 'publish']);
  assert.ok((await w.projectNotifications()).every(([kind, open]) => kind !== 'workflow.awaiting_approval' || !open));
});

test('IE18 at the gate, request changes sends the run back and the gate applies again; stop ends the run as stopped, not failed', async (t) => {
  const w = await world(t);
  const job = await w.job({ needsApproval: true, failureThreshold: 1 });
  const { entry: started } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'awaiting-approval');
  await w.manager.requestChangesWorkflowRun(started.runId!, 'Tighten the summary.');
  await waitUntil(async () => (await w.stepTasks(started.runId!)).length === 3, 'the step to run again');
  await waitUntil(async () => (await w.run(started.runId!)).status === 'awaiting-approval', 'the gate to apply again');
  assert.deepEqual((await w.stepTasks(started.runId!)).map((task) => task.workflowStepId), ['draft', 'check', 'check']);
  assert.equal((await w.entry(job.id, 'awaiting-approval')).runId, started.runId);

  await w.manager.stopWorkflowRun(started.runId!);
  const stopped = await w.entry(job.id, 'stopped');
  assert.notEqual(stopped.finishedAt, null);
  const view = (await w.scheduler.getSchedules(w.project.id)).jobs[0]!;
  assert.deepEqual([view.consecutiveFailures, view.enabled, view.activeRun], [0, true, null]);
});

test('IE19 needs approval on a single prompt: it waits after the agent\'s turn, and approve completes it', async (t) => {
  const w = await world(t);
  const job = await w.job({ needsApproval: true, target: { kind: 'prompt', prompt: 'Draft the post.' } });
  const { entry: started } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'awaiting-approval');
  const paused = await w.run(started.runId!);
  assert.deepEqual([paused.status, paused.currentStepId, paused.workflowSnapshot.steps.map((s) => s.requiresApproval)], ['awaiting-approval', 'prompt', [true]]);
  assert.equal((await w.stepTasks(started.runId!)).length, 1, 'the agent had its turn');
  await w.manager.approveWorkflowRun(started.runId!);
  await w.entry(job.id, 'succeeded');
  assert.equal((await w.run(started.runId!)).status, 'completed');
});

test('IE19 a one-step workflow slot waits after its step', async (t) => {
  const w = await world(t);
  const job = await w.job({ needsApproval: true, target: { kind: 'slot', slotId: 'one', description: 'x' } });
  const { entry } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'awaiting-approval');
  assert.deepEqual((await w.run(entry.runId!)).workflowSnapshot.steps.map((s) => s.requiresApproval), [true]);
});

test('IE20 with needs approval off, the workflow\'s own approval steps still pause the run', async (t) => {
  const w = await world(t);
  const job = await w.job({ target: { kind: 'slot', slotId: 'gated', description: 'x' } });
  const { entry } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'awaiting-approval');
  assert.deepEqual([(await w.run(entry.runId!)).currentStepId, (await w.run(entry.runId!)).workflowSnapshot.steps.map((s) => s.requiresApproval)], ['prepare', [true, false]]);
  await w.manager.approveWorkflowRun(entry.runId!);
  await w.entry(job.id, 'succeeded');
});

test('IE20 needs approval on a workflow that already pauses before its last step adds no second pause', async (t) => {
  const w = await world(t);
  const job = await w.job({ needsApproval: true, target: { kind: 'slot', slotId: 'gated', description: 'x' } });
  const { entry } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'awaiting-approval');
  await w.manager.approveWorkflowRun(entry.runId!);
  await w.entry(job.id, 'succeeded');
});

test('IE17 needs approval on a workflow whose last step is itself an approval step still pauses before that step runs', async (t) => {
  const w = await world(t);
  const job = await w.job({ needsApproval: true, target: { kind: 'slot', slotId: 'signed-off', description: 'x' } });
  const { entry } = await w.scheduler.runNow(w.project.id, job.id);
  await w.entry(job.id, 'awaiting-approval');
  const paused = await w.run(entry.runId!);
  assert.deepEqual([paused.currentStepId, paused.workflowSnapshot.steps.map((s) => s.requiresApproval)], ['review', [false, true, true]]);
  assert.deepEqual((await w.stepTasks(entry.runId!)).map((task) => task.workflowStepId), ['draft', 'review'], 'nothing was published before the person was asked');

  // Approving lets the last step run; its own approval then pauses the run after it, as the workflow says.
  await w.manager.approveWorkflowRun(entry.runId!);
  await waitUntil(async () => (await w.run(entry.runId!)).currentStepId === 'publish' && (await w.run(entry.runId!)).status === 'awaiting-approval', 'the workflow\'s own approval');
  assert.deepEqual((await w.stepTasks(entry.runId!)).map((task) => task.workflowStepId), ['draft', 'review', 'publish']);
  await w.manager.approveWorkflowRun(entry.runId!);
  await w.entry(job.id, 'succeeded');
});

test('run states reach the scheduler in the order their events were emitted', async () => {
  // A run that failed (its state needs a database read) and was retried at once (its state needs none).
  await collections.stepRunsDb.insert({ id: 'order-round', runId: 'order-run', stepId: 'only', round: 1, status: 'failed' } as Parameters<typeof collections.stepRunsDb.insert>[0]);
  let emit!: (event: unknown) => void;
  const manager = { onWorkerEvent: (listener: (event: unknown) => void) => { emit = listener; return () => undefined; } };
  const starter = runStarterModule.createManagerRunStarter(manager as unknown as Manager, noConnections);
  const seen: [string, string | null][] = [];
  starter.subscribe({ runChanged: (runId, state) => { seen.push([runId, state?.status ?? null]); }, slotFreed: () => undefined });
  const run = { id: 'order-run', projectId: 'p', currentStepId: 'only', attentionReason: 'Only step ended without completing.' };
  emit({ type: 'workflowRun', run: { ...run, status: 'needs-attention' } });
  emit({ type: 'workflowRun', run: { ...run, status: 'running' } });
  emit({ type: 'workflowRunDeleted', runId: 'order-run', projectId: 'p' });
  await waitUntil(async () => seen.length === 3, 'three states');
  assert.deepEqual(seen, [['order-run', 'failed'], ['order-run', 'running'], ['order-run', null]]);
});

test('IE25 a slot whose workflow is missing or disabled fails the start with the reason and creates no task', async (t) => {
  const w = await world(t);
  for (const [slotId, reason] of [['off', 'The workflow for "off" is missing or disabled in the Catalog'], ['missing', 'The workflow for "missing" is missing or disabled in the Catalog']] as const) {
    const job = await w.job({ name: slotId, target: { kind: 'slot', slotId, description: 'x' } });
    await assert.rejects(w.scheduler.runNow(w.project.id, job.id), { status: 409, message: reason });
    const [entry] = await w.history(job.id);
    assert.deepEqual([entry!.outcome, entry!.note, entry!.runId], ['failed', reason, null]);
  }
  assert.deepEqual(await planItemService.listPlanItems(w.project.id), []);
  assert.deepEqual(await w.manager.listWorkflowRunsForProject(w.project.id), []);
});

test('a run\'s state as the scheduler reads it', async () => {
  const { runStateOf } = runStarterModule;
  const base = { id: 'state-run', projectId: 'p', currentStepId: 'only', attentionReason: null } as WorkflowRunRecord;
  assert.deepEqual(await runStateOf({ ...base, status: 'starting' }), { status: 'running', note: null });
  assert.deepEqual(await runStateOf({ ...base, status: 'completing' }), { status: 'running', note: null });
  assert.deepEqual(await runStateOf({ ...base, status: 'completed' }), { status: 'succeeded', note: null });
  assert.deepEqual(await runStateOf({ ...base, status: 'stopped' }), { status: 'stopped', note: 'Stopped by a person' });
  assert.deepEqual(await runStateOf({ ...base, status: 'failed' }), { status: 'failed', note: 'The run failed' });
  assert.deepEqual(await runStateOf({ ...base, status: 'failed', startup: { reuseBranch: false, steps: [{ id: 'worktree', name: 'Creating worktree', state: 'failed', reason: 'disk full' }] } }), { status: 'failed', note: 'disk full' });
  // A step asking a question leaves its round running: the run is still going.
  assert.deepEqual(await runStateOf({ ...base, status: 'needs-attention', attentionReason: 'Which file?' }), { status: 'running', note: 'Which file?' });
  const round = { id: 'state-round', runId: 'state-run', stepId: 'only', round: 1, status: 'stopped' } as Parameters<typeof collections.stepRunsDb.insert>[0];
  await collections.stepRunsDb.insert(round);
  assert.deepEqual(await runStateOf({ ...base, status: 'needs-attention', attentionReason: 'Daemon restarted.' }), { status: 'stopped', note: 'Daemon restarted.' });
  await collections.stepRunsDb.insert({ ...round, id: 'state-round-2', round: 2, status: 'failed' });
  assert.deepEqual(await runStateOf({ ...base, status: 'needs-attention', attentionReason: 'Step failed.' }), { status: 'failed', note: 'Step failed.' });
});
