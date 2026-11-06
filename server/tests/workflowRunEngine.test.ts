import assert from 'node:assert/strict';
import { settledExecute } from './helpers/startRun.ts';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import type { WorkflowRunRecord } from '../src/domain/types.ts';
import { installDocsRetroFixture } from './fixtures/docsRetroFixture.ts';
import { fakeTerminalHost, autoAdvanceTerminalSteps } from './helpers/terminalStepFakes.ts';

/**
 * Integration coverage for the workflow run engine (task 3.012): a Catalog Workflow's steps driven
 * end-to-end through the interactive-CLI path — a scripted fake TerminalSessionHost that, once a
 * step's session "starts," calls back into `complete_step`/`skip_step` (the real MCP relay's
 * handlers, `workerManager.completeStep`/`skipStep`) exactly as a live step session's MCP tool call
 * would — see `autoAdvanceTerminalSteps`. Every test here uses a repository-less Project (no git
 * worktree/PR machinery), which exercises the "no repository" branch of the Complete stage
 * organically; `gitProjects.test.ts` covers the real-git worktree/branch/stacking/PR paths. The
 * Complete stage's own headless summarizer turn is a separate, internal "run one throwaway turn"
 * primitive (worker/workflowSummarizer.ts) that still runs through `runClaudeTurn` regardless of any
 * Task's own executor kind — see `fakeSummarizerTurn`.
 */

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-run-engine-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  await installDocsRetroFixture(process.env.AGENT_VISUAL_OS_CATALOG_DIR);

  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workflowService = await import('../src/catalog/workflowService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  notificationService = await import('../src/notifications/notificationService.ts');

  // A 6-step Workflow exercising every mechanism the run engine has: a skippable approval gate, a
  // plain read-only step, an editable step, a loop back to it, a second approval gate, and a final
  // editable step. Overrides the fixture catalog's own minimal seeded "software-development" (see
  // fixtures/catalog/workflows/) — still the Catalog default, so `executePlanItem` picks it up with
  // no per-Project override.
  await workflowService.updateWorkflow('software-development', {
    name: 'Test Software Development',
    description: 'Test workflow mirroring the seeded default.',
    steps: [
      { id: 'ui', name: 'UI Planning', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Plan the UI, or skip if none.' },
      { id: 'plan', name: 'Test Case Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'List test cases.' },
      { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Implement the task.' },
      { id: 'review', name: 'Code Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Review the diff.', loopBack: { toStepId: 'build', maxRounds: 2 } },
      { id: 'signoff', name: 'Human Code Review', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Write a review brief.' },
      { id: 'docs', name: 'Docs & Retro', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Update docs and retro.' },
    ],
  });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** The Complete stage's headless "write the PR body/completion report" turn — see workflowSummarizer.ts. Never a step's own turn any more (every step now runs via the interactive CLI), so this is the only thing `runClaudeTurn` is still called for in this file. */
async function fakeSummarizerTurn(): Promise<ClaudeTurnResult> {
  return {
    sessionId: 'summary-session',
    status: 'done',
    message: 'ok',
    extra: { tldr: 'Done.', requirement: 'req', whatWasDeveloped: 'dev', reviewHighlights: 'No issues raised', docsUpdated: 'None', retroUpdates: 'None' },
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

async function createProjectWithItem(name: string) {
  const project = await projectService.createProject({ name, position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Do the thing', description: 'A test task.' });
  return { project, item };
}

test('a full run: skip the UI step, pass linearly, pass its review on the first try, approve sign-off, and complete with no repository', async () => {
  const { project, item } = await createProjectWithItem('Full Run');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'No UI in this task.' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'Listed test cases.' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'Implemented it.' }),
    review: (id) => managerRef.current!.completeStep(id, { summary: 'Looks good.', verdict: 'pass' }),
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'Ready for review.' }),
    docs: (id) => managerRef.current!.completeStep(id, { summary: 'Updated README and retro.md.' }),
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;

  const firstTask = await settledExecute(manager2)(item.id);
  assert.ok(firstTask.workflowRunId);
  const runId = firstTask.workflowRunId!;

  await waitUntil(async () => (await manager2.getWorkflowRunDetail(runId)).run.status === 'awaiting-approval');
  const paused = await manager2.getWorkflowRunDetail(runId);
  assert.equal(paused.run.currentStepId, 'signoff', 'the UI step was skipped, so the first pause is at the second approval gate');
  const uiStepRuns = paused.steps.find((s) => s.step.id === 'ui')!.rounds;
  assert.equal(uiStepRuns[0]?.status, 'skipped');
  assert.equal(uiStepRuns[0]?.skippedReason, 'No UI in this task.');

  await manager2.approveWorkflowRun(runId);
  // Wait on the PlanItem, not the run: `completeWorkflowRun` writes the run's own 'completed'
  // status before syncing the PlanItem from it, so the PlanItem's status is the truly last write.
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');

  const finalDetail = await manager2.getWorkflowRunDetail(runId);
  assert.equal(finalDetail.run.status, 'completed');
  assert.equal(finalDetail.run.prUrl, null, 'no repository means no PR');
  assert.match(finalDetail.run.completionReport ?? '', /dev/);
  assert.equal((await manager2.listWorkflowRunsForProject(project.id)).length, 1);
});

test('a run with house-style step summaries: every step is briefed in the style, and a failed summarizer still yields a structured, per-step completion report', async () => {
  const { item } = await createProjectWithItem('House Style Run');
  const reviewSummary = [
    '**TL;DR:** Pass. The export works and is tested.',
    '',
    '### What I checked',
    '',
    '| File | Change | Verdict |',
    '| --- | --- | --- |',
    '| `export.ts` | CSV builder | OK |',
    '',
    '> Large exports are not paginated yet.',
  ].join('\n');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'No UI in this task.' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: '**TL;DR:** 3 unit cases.\n\n- [ ] builds a header row\n- [ ] escapes commas\n- [ ] empty data' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: '**TL;DR:** Added CSV export.\n\n### What changed\n\n1. Export button\n2. CSV builder' }),
    review: (id) => managerRef.current!.completeStep(id, { summary: reviewSummary, verdict: 'pass' }),
    signoff: (id) => managerRef.current!.completeStep(id, { summary: '**TL;DR:** Ready.\n\n### Where to focus\n\n- [ ] Try a 10k-row export' }),
    docs: (id) => managerRef.current!.completeStep(id, { summary: 'Updated README.' }),
  });
  const failingSummarizer = async (): Promise<ClaudeTurnResult> => { throw new Error('summarizer unavailable'); };
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: failingSummarizer, terminalSessions: host });
  managerRef.current = manager;

  const runId = (await settledExecute(manager)(item.id)).workflowRunId!;
  await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === 'awaiting-approval');
  await manager.approveWorkflowRun(runId);
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');

  const { SUMMARY_HOUSE_STYLE } = await import('../src/worker/summaryStyle.ts');
  assert.equal(starts.length, 6);
  for (const start of starts) assert.ok(start.prompt.includes(SUMMARY_HOUSE_STYLE), 'every step prompt carries the house style');
  const promptFor = (stepName: string) => starts.find((s) => s.prompt.includes(`# Your step: ${stepName}\n`))!.prompt;
  assert.match(promptFor('Code Review'), /## Reviewing/);
  assert.match(promptFor('Human Code Review'), /## Brief for the human reviewer/);
  assert.doesNotMatch(promptFor('Development'), /## Reviewing|## Brief for the human reviewer/);

  const report = (await manager.getWorkflowRunDetail(runId)).run.completionReport ?? '';
  assert.match(report, /^\*\*TL;DR:\*\* The run finished\./);
  for (const step of ['UI Planning', 'Test Case Planning', 'Development', 'Code Review', 'Human Code Review', 'Docs & Retro']) {
    assert.match(report, new RegExp(`^### ${step}$`, 'm'), `a heading for ${step}`);
  }
  assert.match(report, /### UI Planning\n\nSkipped: No UI in this task\./);
  assert.match(report, /#### What I checked\n\n\| File \| Change \| Verdict \|\n\| --- \| --- \| --- \|/, 'the review table survives, nested under its step');
  assert.match(report, /^> Large exports are not paginated yet\.$/m, 'the blockquote survives');
  assert.match(report, /^- \[ \] escapes commas$/m, 'the task list survives');
  assert.match(report, /## Review highlights\nSee the \*\*Code Review\*\* step summary above\./);
});

test('a hook fired by the final step\'s session after its run completed never pulls the PlanItem back out of done', async () => {
  const { item } = await createProjectWithItem('Late Hook After Completion');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'No UI.' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'Cases.' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'Built.' }),
    review: (id) => managerRef.current!.completeStep(id, { summary: 'Fine.', verdict: 'pass' }),
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'Brief.' }),
    docs: (id) => managerRef.current!.completeStep(id, { summary: 'Docs.' }),
  });
  // The docs step's PTY exit lags behind the daemon's kill signal (as with a real CLI), so its Task is
  // still 'developing' when the run completes and its CLI's own Stop hook arrives.
  let docsTaskId: string | undefined;
  const realStop = host.stop.bind(host);
  host.stop = (taskId) => (taskId === docsTaskId ? true : realStop(taskId));
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager;
  const originalStart = host.start.bind(host);
  host.start = (input) => {
    void manager.getTask(input.taskId).then((task) => { if (task.workflowStepId === 'docs') docsTaskId = task.id; });
    originalStart(input);
  };

  const firstTask = await settledExecute(manager)(item.id);
  await waitUntil(async () => (await manager.getWorkflowRunDetail(firstTask.workflowRunId!)).run.status === 'awaiting-approval');
  await manager.approveWorkflowRun(firstTask.workflowRunId!);
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');
  assert.ok(docsTaskId);
  assert.equal((await manager.getTask(docsTaskId!)).status, 'developing', 'precondition: the docs session has not exited yet');

  await manager.handleTerminalHook(docsTaskId!, { hook_event_name: 'Stop' });
  await manager.handleTerminalHook(docsTaskId!, { hook_event_name: 'PostToolUse' });

  assert.equal((await planItemService.getPlanItem(item.id)).status, 'done');
  assert.equal((await manager.getWorkflowRunDetail(firstTask.workflowRunId!)).run.status, 'completed');
});

test('the first step\'s prompt carries the item\'s specification (its description) as input, and a run is only its configured steps', async () => {
  const { item } = await createProjectWithItem('First Step Spec');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {});
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager;
  const task = await settledExecute(manager)(item.id);
  await waitUntil(async () => starts.length > 0);
  assert.match(starts[0]!.prompt, /# Task: Do the thing\n\nA test task\./);
  assert.match(starts[0]!.prompt, /# Your step: UI Planning/);
  const detail = await manager.getWorkflowRunDetail(task.workflowRunId!);
  assert.deepEqual(Object.keys(detail).sort(), ['run', 'stepNotes', 'steps']);
  assert.equal(detail.steps[0]!.step.id, 'ui');
  assert.ok(!('requirementSource' in detail.run));
  assert.ok(!('requirementAnalysis' in detail.run.workflowSnapshot));
  await manager.stopWorkflowRun(task.workflowRunId!);
});

test('a stored run from before the Requirement Analysis stage was removed still loads', async () => {
  const { workflowRunsDb } = await import('../src/db/collections.ts');
  const { project, item } = await createProjectWithItem('Legacy Run');
  const now = new Date().toISOString();
  const legacyRun = {
    id: 'legacy-run', projectId: project.id, planItemId: item.id, workflowId: 'software-development',
    workflowSnapshot: {
      id: 'software-development', name: 'Old', description: 'x', enabled: true,
      requirementAnalysis: { agentId: 'builder', instructions: 'Plan.' },
      steps: [{ id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build.' }],
    },
    requirementSource: { kind: 'manual' }, status: 'stopped', currentStepId: 'build', executorId: 'test-claude-cli',
    prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0,
    createdAt: now, updatedAt: now, completedAt: null,
  };
  await workflowRunsDb.insert(legacyRun as unknown as WorkflowRunRecord);
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: fakeTerminalHost().host });
  const detail = await manager.getWorkflowRunDetail('legacy-run');
  assert.equal(detail.run.status, 'stopped');
  assert.deepEqual(detail.steps.map((s) => s.step.id), ['build']);
  assert.ok((await manager.listWorkflowRunsForProject(project.id)).some((r) => r.id === 'legacy-run'));
  await workflowRunsDb.delete('legacy-run');
});

test('a read-only step gets PLAN_DISALLOWED_TOOLS; a code-editing step gets none', async () => {
  const { item } = await createProjectWithItem('Permissions');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'built' }),
    review: (id) => managerRef.current!.completeStep(id, { summary: 'ok', verdict: 'pass' }),
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;

  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');

  // Read-only steps: ui (skipped), plan and review never edit code.
  const planStart = starts[1]; // index 0 = ui, 1 = plan
  assert.ok(planStart?.disallowedTools?.includes('Edit'));
  assert.ok(planStart?.disallowedTools?.includes('Write'));
  assert.ok(planStart?.disallowedTools?.includes('Bash'));

  const buildStart = starts[2];
  assert.equal(buildStart?.disallowedTools, undefined, 'a code-editing step has no tool restriction');

  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('only a code-editing step gets the testing tools and instructions, and only it may run tests', async () => {
  const { item } = await createProjectWithItem('Testing Tools');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const testingAccess: Record<string, boolean> = {};
  const probe = async (stepId: string, taskId: string) => {
    testingAccess[stepId] = await managerRef.current!.requireTestingSession(taskId).then(() => true, (error) => {
      assert.ok(error instanceof workerManagerModule.TaskNotTestingSessionError);
      return false;
    });
  };
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: async (id) => { await probe('plan', id); await managerRef.current!.completeStep(id, { summary: 'planned' }); },
    build: async (id) => { await probe('build', id); await managerRef.current!.completeStep(id, { summary: 'built' }); },
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;
  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => 'build' in testingAccess && starts.length >= 4);

  const [, planStart, buildStart] = starts;
  assert.deepEqual(planStart?.mcpServers?.map((server) => server.name), ['agent_visual_os_step']);
  assert.doesNotMatch(planStart?.systemPrompt ?? '', /list_test_actions/);
  assert.deepEqual(buildStart?.mcpServers?.map((server) => server.name), ['agent_visual_os_step', 'agent_visual_os_tests']);
  assert.equal(buildStart?.mcpServers?.[1]?.env.AGENT_VISUAL_OS_TASK_ID, buildStart?.taskId);
  assert.match(buildStart?.systemPrompt ?? '', /list_test_actions/);
  assert.deepEqual(testingAccess, { plan: false, build: true }, 'a read-only step is refused; the Development step is allowed while it runs');
  await waitUntil(async () => (await manager2.getTask(buildStart!.taskId)).status !== 'developing');
  await assert.rejects(manager2.requireTestingSession(buildStart!.taskId), workerManagerModule.TaskNotTestingSessionError, 'once its step completed, the Task is stale');
  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('every step Task carries an MCP server scoped to itself, distinct from a planning session\'s', async () => {
  const { item } = await createProjectWithItem('MCP Server');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;
  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => starts.length >= 1);
  const step = starts[0]?.mcpServers?.[0];
  assert.equal(step?.name, 'agent_visual_os_step');
  assert.equal(step?.env.AGENT_VISUAL_OS_TASK_ID, starts[0]?.taskId);
  assert.ok(step?.tools.includes('complete_step'));
  assert.ok(step?.tools.includes('diff_summary'));
  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('a loop-origin verdict "issues" re-runs the target and everything after it in order, then the loop step again, until it passes', async () => {
  const { item } = await createProjectWithItem('Loop Then Pass');
  let reviewCalls = 0;
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'built again' }),
    review: (id) => {
      reviewCalls += 1;
      return managerRef.current!.completeStep(id, { summary: reviewCalls === 1 ? 'found an issue' : 'now clean', verdict: reviewCalls === 1 ? 'issues' : 'pass' });
    },
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;

  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');

  const detail = await manager2.getWorkflowRunDetail(task.workflowRunId!);
  const buildRounds = detail.steps.find((s) => s.step.id === 'build')!.rounds;
  const reviewRounds = detail.steps.find((s) => s.step.id === 'review')!.rounds;
  assert.equal(buildRounds.length, 2, 'Development re-ran once after the review found an issue');
  assert.equal(reviewRounds.length, 2);
  assert.equal(reviewRounds[0]?.verdict, 'issues');
  assert.equal(reviewRounds[1]?.verdict, 'pass');
  assert.equal(detail.run.currentStepId, 'signoff');

  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('when a loop\'s sessions can\'t be continued, the fresh briefing carries the review\'s findings: Development sees the review that sent it back, and the next review sees its own earlier findings', async () => {
  const { item } = await createProjectWithItem('Loop Carries Review');
  let reviewCalls = 0;
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'built' }),
    review: (id) => {
      reviewCalls += 1;
      return managerRef.current!.completeStep(id, reviewCalls === 1
        ? { summary: 'Stale deep link re-opens the campaign.', verdict: 'issues' }
        : { summary: 'now clean', verdict: 'pass' });
    },
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  host.sessionExists = () => false;
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager;

  const task = await settledExecute(manager)(item.id);
  await waitUntil(async () => (await manager.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');

  const promptsFor = (stepName: string) => starts.filter((s) => s.prompt.includes(`# Your step: ${stepName}`)).map((s) => s.prompt);
  const [firstBuild, secondBuild] = promptsFor('Development');
  const [firstReview, secondReview] = promptsFor('Code Review');

  assert.doesNotMatch(firstBuild ?? '', /## Code Review/, 'no review has run yet, so the first round has none to show');
  assert.match(secondBuild ?? '', /Implement the task\.\n\nCode Review round 1 found issues\. Fix every point it raised/);
  const reviewSection = (secondBuild ?? '').slice((secondBuild ?? '').indexOf('## Code Review'));
  assert.match(reviewSection, /Summary: Stale deep link re-opens the campaign\.\nVerdict: issues/, 'the round-2 Development prompt carries the review findings');
  assert.ok((secondBuild ?? '').indexOf('## Development') < (secondBuild ?? '').indexOf('## Code Review'), 'stages stay in workflow order');

  assert.doesNotMatch(firstReview ?? '', /## Code Review/, 'a review never shows its own in-progress round');
  assert.match(secondReview ?? '', /## Code Review\n\nSummary: Stale deep link re-opens the campaign\./, 'the next review can check each earlier finding was fixed');

  const signoffPrompt = promptsFor('Human Code Review')[0] ?? '';
  assert.equal(signoffPrompt.split('## Code Review').length - 1, 1, 'a step after the loop lists the review stage once');

  await manager.stopWorkflowRun(task.workflowRunId!);
});

test('a loop that keeps finding issues past maxRounds pauses "needs-attention"; a human can request another round or force it to continue', async () => {
  const { project, item } = await createProjectWithItem('Loop Exhausted');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'attempt' }),
    review: (id) => managerRef.current!.completeStep(id, { summary: 'still broken', verdict: 'issues' }),
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;

  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'needs-attention');

  const detail = await manager2.getWorkflowRunDetail(task.workflowRunId!);
  assert.match(detail.run.attentionReason ?? '', /still found issues after 2 round\(s\)/);
  assert.equal(detail.steps.find((s) => s.step.id === 'review')!.rounds.length, 2, 'stops exactly at maxRounds, not beyond');

  const notifications = await notificationService.listNotifications({ projectId: project.id, resolved: false });
  assert.equal(notifications.filter((n) => n.kind === 'workflow.needs_attention').length, 1);

  // Human override: one more round — still fails, since the scripted review always says "issues".
  await manager2.decideWorkflowRunLoop(task.workflowRunId!, 'another-round', 'Please look closer.');
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'needs-attention');
  assert.equal((await manager2.getWorkflowRunDetail(task.workflowRunId!)).steps.find((s) => s.step.id === 'review')!.rounds.length, 3);
  assert.equal(
    (await notificationService.listNotifications({ projectId: project.id, resolved: false })).filter((n) => n.kind === 'workflow.needs_attention' || n.kind === 'workflow.awaiting_approval').length,
    1,
    'the earlier attention notification was resolved, and exactly one new one is open',
  );

  // Human override: continue anyway (treat as if it had passed).
  await manager2.decideWorkflowRunLoop(task.workflowRunId!, 'continue');
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');
  assert.equal((await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.currentStepId, 'signoff');
  const openAfterContinue = (await notificationService.listNotifications({ projectId: project.id, resolved: false }))
    .filter((n) => n.kind === 'workflow.needs_attention' || n.kind === 'workflow.awaiting_approval');
  assert.equal(openAfterContinue.length, 1, 'the needs-attention notification resolved, replaced by the new approval-gate one');
  assert.match(openAfterContinue[0]?.title ?? '', /needs approval/);

  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('starting a run mirrors its first step\'s first round onto the run record: zero prior ms, round-started-at the round\'s own createdAt (task 5.003\'s live timer)', async () => {
  const { item } = await createProjectWithItem('Round Timing First Round');
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: terminal.host });
  const task = await settledExecute(manager)(item.id);

  const detail = await manager.getWorkflowRunDetail(task.workflowRunId!);
  const uiRounds = detail.steps.find((s) => s.step.id === 'ui')!.rounds;
  assert.equal(uiRounds.length, 1);
  assert.equal(detail.run.currentStepId, 'ui');
  assert.equal(detail.run.currentStepPriorRoundsMs, 0, 'the very first round of a run carries nothing forward');
  assert.equal(detail.run.currentStepRoundStartedAt, uiRounds[0]!.createdAt);

  await manager.stopWorkflowRun(task.workflowRunId!);
});

test('a loop-origin step\'s later rounds, and a manual retry after it, carry every earlier round\'s ms forward — not just the one right before (task 5.003\'s live timer)', async () => {
  const { item } = await createProjectWithItem('Round Timing Loop And Retry');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'attempt' }),
    review: (id) => managerRef.current!.completeStep(id, { summary: 'still broken', verdict: 'issues' }),
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager;

  const task = await settledExecute(manager)(item.id);
  await waitUntil(async () => (await manager.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'needs-attention');

  let detail = await manager.getWorkflowRunDetail(task.workflowRunId!);
  let reviewRounds = detail.steps.find((s) => s.step.id === 'review')!.rounds;
  assert.equal(reviewRounds.length, 2, 'maxRounds (2) exhausted, paused on Code Review\'s own second round');
  const review1Ms = new Date(reviewRounds[0]!.completedAt!).getTime() - new Date(reviewRounds[0]!.createdAt).getTime();
  assert.equal(detail.run.currentStepId, 'review');
  assert.equal(detail.run.currentStepPriorRoundsMs, review1Ms, 'Code Review\'s second round carries its own first round\'s ms forward');
  assert.equal(detail.run.currentStepRoundStartedAt, reviewRounds[1]!.createdAt);

  const review2Ms = new Date(reviewRounds[1]!.completedAt!).getTime() - new Date(reviewRounds[1]!.createdAt).getTime();
  await manager.retryWorkflowStep(task.workflowRunId!);
  await waitUntil(async () => (await manager.getWorkflowRunDetail(task.workflowRunId!)).steps.find((s) => s.step.id === 'review')!.rounds.length === 3);

  detail = await manager.getWorkflowRunDetail(task.workflowRunId!);
  reviewRounds = detail.steps.find((s) => s.step.id === 'review')!.rounds;
  assert.equal(
    detail.run.currentStepPriorRoundsMs,
    review1Ms + review2Ms,
    'a manual retry carries every earlier round\'s ms forward, not just the one immediately before it',
  );
  assert.equal(detail.run.currentStepRoundStartedAt, reviewRounds[2]!.createdAt);

  // The fields persist through getWorkflowRunDetail (stored on the run record itself, reload-safe)
  // and are left exactly as they were by stopping mid-step.
  await manager.stopWorkflowRun(task.workflowRunId!);
  const stopped = (await manager.getWorkflowRunDetail(task.workflowRunId!)).run;
  assert.equal(stopped.currentStepPriorRoundsMs, review1Ms + review2Ms);
  assert.equal(stopped.currentStepRoundStartedAt, reviewRounds[2]!.createdAt);
});

test('request-changes resumes the same step for a new round with the comment attached, instead of moving on', async () => {
  const { item } = await createProjectWithItem('Request Changes');
  let signoffCalls = 0;
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'built' }),
    review: (id) => managerRef.current!.completeStep(id, { summary: 'ok', verdict: 'pass' }),
    signoff: (id) => { signoffCalls += 1; return managerRef.current!.completeStep(id, { summary: `brief round ${signoffCalls}` }); },
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;

  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');

  await manager2.requestChangesWorkflowRun(task.workflowRunId!, 'Please clarify the risk section.');
  await waitUntil(async () => signoffCalls === 2);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');

  const detail = await manager2.getWorkflowRunDetail(task.workflowRunId!);
  const signoffRounds = detail.steps.find((s) => s.step.id === 'signoff')!.rounds;
  assert.equal(signoffRounds.length, 2);
  assert.equal(signoffRounds[0]?.status, 'changes-requested');
  assert.equal(signoffRounds[0]?.approval?.decision, 'changes-requested');
  assert.equal(signoffRounds[0]?.approval?.comment, 'Please clarify the risk section.');
  assert.equal(signoffRounds[1]?.status, 'done');

  // The second round's prompt carries the human's comment.
  const secondSignoffStart = starts.at(-1);
  assert.match(secondSignoffStart?.prompt ?? '', /Please clarify the risk section\./);

  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('approve advances exactly like completing continues (start next step), never re-evaluating a loop', async () => {
  const { item } = await createProjectWithItem('Approve Not Loop');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.completeStep(id, { summary: 'a mockup' }),
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;
  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');
  assert.equal((await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.currentStepId, 'ui');

  await manager2.approveWorkflowRun(task.workflowRunId!, 'looks fine');
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.currentStepId === 'plan' || (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'needs-attention');
  // plan has no scripted action, so its Task stays 'developing' — confirms approve started the very next step, not the loop's target.
  const detail = await manager2.getWorkflowRunDetail(task.workflowRunId!);
  assert.equal(detail.run.currentStepId, 'plan');
  const uiRounds = detail.steps.find((s) => s.step.id === 'ui')!.rounds;
  assert.equal(uiRounds[0]?.approval?.decision, 'approved');
  assert.equal(uiRounds[0]?.approval?.comment, 'looks fine');

  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('approve/request-changes/loop/retry-step refuse when the run is not in the right status', async () => {
  const { item } = await createProjectWithItem('Wrong Status Actions');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {});
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;
  const task = await settledExecute(manager2)(item.id); // "ui" Task starts and stays 'running' (no scripted action)
  const runId = task.workflowRunId!;

  await assert.rejects(() => manager2.approveWorkflowRun(runId), workerManagerModule.WorkflowRunNotActionableError);
  await assert.rejects(() => manager2.requestChangesWorkflowRun(runId, 'x'), workerManagerModule.WorkflowRunNotActionableError);
  await assert.rejects(() => manager2.decideWorkflowRunLoop(runId, 'continue'), workerManagerModule.WorkflowRunNotActionableError);
  await assert.rejects(() => manager2.retryWorkflowStep(runId), workerManagerModule.WorkflowRunNotActionableError);
  await assert.rejects(() => manager2.approveWorkflowRun('does-not-exist'), workerManagerModule.WorkflowRunNotFoundError);

  await manager2.stopWorkflowRun(runId);
});

test('a step whose session ends without calling complete_step/skip_step marks that round failed and the run needs-attention', async () => {
  const { item } = await createProjectWithItem('Incomplete Step');
  const terminal = fakeTerminalHost();
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: terminal.host });
  const task = await settledExecute(manager2)(item.id);
  // The session's process ends cleanly, but the model never called complete_step/skip_step —
  // however that happens in practice (a plain exit, a Stop hook race, …), it must count the same.
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'needs-attention');

  const detail = await manager2.getWorkflowRunDetail(task.workflowRunId!);
  assert.match(detail.run.attentionReason ?? '', /ended without completing/);
  const uiRounds = detail.steps.find((s) => s.step.id === 'ui')!.rounds;
  assert.equal(uiRounds[0]?.status, 'failed');

  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('retry-step re-runs the current step after it needed attention', async () => {
  const { item } = await createProjectWithItem('Retry Step');
  let attempts = 0;
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id, exit) => {
      attempts += 1;
      if (attempts === 1) { exit(); return; } // first attempt: never calls complete_step/skip_step
      return managerRef.current!.skipStep(id, { reason: 'skip on retry' });
    },
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;
  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'needs-attention');

  await manager2.retryWorkflowStep(task.workflowRunId!);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.currentStepId === 'plan');

  const detail = await manager2.getWorkflowRunDetail(task.workflowRunId!);
  const uiRounds = detail.steps.find((s) => s.step.id === 'ui')!.rounds;
  assert.equal(uiRounds.length, 2);
  assert.equal(uiRounds[0]?.status, 'failed');
  assert.equal(uiRounds[1]?.status, 'skipped');

  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('stopping a run kills its live step process, marks it stopped (item blocked, not completed), and frees the executor slot for a fresh run', async () => {
  const { project, item } = await createProjectWithItem('Stop Run');
  const terminal = fakeTerminalHost();
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: terminal.host });
  const task = await settledExecute(manager2)(item.id);
  const runId = task.workflowRunId!;

  const stopped = await manager2.stopWorkflowRun(runId);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.completedAt, null, 'halted, not completed');
  assert.deepEqual(terminal.stops, [task.id]);
  assert.equal((await planItemService.getPlanItem(item.id)).status, 'blocked');
  // The kill signal only asks the process to exit — the daemon settles the Task once it actually does.
  terminal.starts[0]?.onExit(0);
  await waitUntil(async () => (await manager2.getTask(task.id)).status === 'stopped', 1000);
  assert.deepEqual((await projectService.getProject(project.id)).activeTaskIds, []);

  await assert.rejects(() => manager2.stopWorkflowRun(runId), workerManagerModule.WorkflowRunNotActionableError, 'an already-stopped run cannot be stopped again');

  // A second execution of the same PlanItem is free to start (the executor slot was released).
  const terminal2 = fakeTerminalHost();
  const secondManager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: terminal2.host });
  const second = await settledExecute(secondManager)(item.id);
  assert.notEqual(second.workflowRunId, runId);
  await secondManager.stopWorkflowRun(second.workflowRunId!);
  terminal2.starts[0]?.onExit(0);
});

test('a daemon restart reports an orphaned in-flight step as needs-attention instead of relaunching it', async () => {
  const { project, item } = await createProjectWithItem('Restart Recovery');
  const terminal = fakeTerminalHost();
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: terminal.host });
  const task = await settledExecute(manager2)(item.id);
  const runId = task.workflowRunId!;
  assert.equal((await manager2.getTask(task.id)).status, 'developing');

  // Simulate the daemon having restarted mid-session: a fresh manager instance runs recovery. Its
  // terminal host must never be asked to start a new session for this Task — a workflow step Task is
  // reported needs-attention on restart, never relaunched (task 3.012's restart-recovery spec).
  const neverStart = {
    start: () => { throw new Error('must never relaunch an orphaned workflow step Task'); },
    attach: () => () => undefined,
    write() {}, resize() {}, stop: () => true, has: () => true, isAttached: () => false, count: () => 0,
  };
  const recoveryManager = workerManagerModule.createWorkerManager({ runClaudeTurn: async () => { throw new Error('never called during recovery'); }, terminalSessions: neverStart });
  await recoveryManager.resumeInterruptedTasks();

  assert.equal((await recoveryManager.getTask(task.id)).status, 'failed');
  const detail = await recoveryManager.getWorkflowRunDetail(runId);
  assert.equal(detail.run.status, 'needs-attention');
  assert.match(detail.run.attentionReason ?? '', /daemon restarted/);
  const projectAfter = await projectService.getProject(project.id);
  assert.deepEqual(projectAfter.activeTaskIds, []);

  await recoveryManager.stopWorkflowRun(runId);
});

test('diff_summary/diff_file report "no branch of its own" for a repository-less Project, and the MCP relay refuses a foreign/settled task id', async () => {
  const { item } = await createProjectWithItem('No Repo Diff');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {});
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;
  const task = await settledExecute(manager2)(item.id);

  const activeTaskId = (await manager2.listTasksForProject(task.projectId)).find((t) => t.status === 'developing')!.id;
  assert.match(await manager2.stepDiffSummary(activeTaskId), /no branch of its own/);
  assert.equal(await manager2.stepDiffFile(activeTaskId, 'foo.ts'), '');

  await assert.rejects(() => manager2.completeStep('not-a-real-task-id', { summary: 'x' }), workerManagerModule.TaskNotWorkflowStepError);
  await assert.rejects(() => manager2.stepDiffSummary('not-a-real-task-id'), workerManagerModule.TaskNotWorkflowStepError);

  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('completeStep requires a verdict for a loop-origin step, and rejects an unresolvable step Task', async () => {
  const { item } = await createProjectWithItem('Verdict Required');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'built' }),
    // Both calls happen from inside the one action driving this exact step's own Task, so there is
    // no question of which Task id the check applies to (unlike reaching in from outside mid-flight,
    // which would race the very next step already having started).
    review: async (id) => {
      await assert.rejects(() => managerRef.current!.completeStep(id, { summary: 'no verdict given' }), /needs verdict/);
      await managerRef.current!.completeStep(id, { summary: 'fine', verdict: 'pass' });
    },
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager2;
  const task = await settledExecute(manager2)(item.id);
  await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');
  assert.equal((await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.currentStepId, 'signoff');
  await manager2.stopWorkflowRun(task.workflowRunId!);
});

test('reportProgress updates the running round\'s StepRun (and its board-card summary) on both a read-only and a code-editing step, replacing rather than merging on a second call', async () => {
  const { item } = await createProjectWithItem('Report Progress');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  let runId = '';
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: async (id) => {
      // A read-only step (UI Planning) can report too (AC1).
      await managerRef.current!.reportProgress(id, { checklist: [{ text: 'Sketch the screen', state: 'in-progress' }], currentActivity: 'Sketching' });
      await managerRef.current!.skipStep(id, { reason: 'No UI.' });
    },
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: async (id) => {
      await managerRef.current!.reportProgress(id, {
        checklist: [
          { text: 'Add the field', state: 'done', short: 'adding field' },
          { text: 'Write tests', state: 'in-progress', short: '  writing   unit tests now ' },
          { text: 'Nice-to-have', state: 'skipped', note: 'descoped' },
        ],
        currentActivity: 'Writing tests',
        estimate: '~10 min left',
      });
      const afterFirst = (await managerRef.current!.getWorkflowRunDetail(runId)).run;
      assert.deepEqual(afterFirst.currentStepProgress, { done: 1, total: 3, estimate: '~10 min left', currentLabel: 'writing unit' }, 'total includes the skipped item; done does not; the first in-progress item\'s label is trimmed to 2 words (IS01, IS05)');
      const buildRound = (await managerRef.current!.getWorkflowRunDetail(runId)).steps.find((s) => s.step.id === 'build')!.rounds[0]!;
      assert.deepEqual(buildRound.progress?.checklist.map((item) => item.short), ['adding field', 'writing unit', null], 'stored trimmed; absent is stored null (IS03)');

      // IS04: a 10,000-character label is accepted and trimmed, never refused.
      await managerRef.current!.reportProgress(id, { checklist: [{ text: 'Write tests', state: 'in-progress', short: 'y'.repeat(10_000) }] });
      const longLabel = (await managerRef.current!.getWorkflowRunDetail(runId)).run.currentStepProgress?.currentLabel;
      assert.equal(longLabel?.length, 24);

      // A second call fully replaces the first — no accumulation, no history.
      await managerRef.current!.reportProgress(id, { currentActivity: 'Running the suite' });
      await managerRef.current!.completeStep(id, { summary: 'built' });
    },
    review: (id) => managerRef.current!.completeStep(id, { summary: 'ok', verdict: 'pass' }),
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager;

  const task = await settledExecute(manager)(item.id);
  runId = task.workflowRunId!;
  await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === 'awaiting-approval');

  const detail = await manager.getWorkflowRunDetail(runId);
  const uiRound = detail.steps.find((s) => s.step.id === 'ui')!.rounds[0]!;
  assert.deepEqual(uiRound.progress, { checklist: [{ text: 'Sketch the screen', state: 'in-progress', note: null, short: null }], currentActivity: 'Sketching', estimate: null, estimatedAt: null });

  const buildRound = detail.steps.find((s) => s.step.id === 'build')!.rounds[0]!;
  assert.deepEqual(buildRound.progress?.checklist, [], 'the second call replaced the checklist with none, not merged with the first');
  assert.equal(buildRound.progress?.currentActivity, 'Running the suite');
  assert.equal(buildRound.progress?.estimate, null, 'an omitted estimate on a later call clears the earlier one');

  const run = (await manager.getWorkflowRunDetail(runId)).run;
  assert.equal(run.currentStepProgress, null, 'cleared once the round that reported it is no longer current (Development completed and the run moved on)');

  await manager.stopWorkflowRun(runId);
});

test('reportProgress fires a stepRun WorkerEvent, is refused once its own round settles, a new round starts with no inherited progress, and other Tasks/Projects are refused too', async () => {
  const { project, item } = await createProjectWithItem('Report Progress Auth');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  let runId = '';
  let buildCalls = 0;
  let reviewCalls = 0;
  const events: unknown[] = [];
  const { host } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned' }),
    build: async (id) => {
      buildCalls += 1;
      if (buildCalls === 1) {
        const before = events.length;
        await managerRef.current!.reportProgress(id, { currentActivity: 'round 1 work' });
        assert.ok(events.length > before, 'a valid call fires a stepRun event, the same way completeStep/skipStep do');
        await managerRef.current!.completeStep(id, { summary: 'built' });
        // This round has now settled ('done') — refused from here on, even though its Task id once worked.
        await assert.rejects(() => managerRef.current!.reportProgress(id, { currentActivity: 'too late' }), workerManagerModule.TaskNotWorkflowStepError, 'a settled round\'s own (now-stale) task id is refused');
        return;
      }
      // Round 2 (after review sent it back) never inherits round 1's progress.
      const detail = await managerRef.current!.getWorkflowRunDetail(runId);
      const round2 = detail.steps.find((s) => s.step.id === 'build')!.rounds.at(-1)!;
      assert.equal(round2.progress, undefined, 'a new round never inherits an earlier round\'s progress');
      await managerRef.current!.reportProgress(id, { currentActivity: 'round 2 work' });
      await managerRef.current!.completeStep(id, { summary: 'built again' });
    },
    review: (id) => {
      reviewCalls += 1;
      return managerRef.current!.completeStep(id, { summary: reviewCalls === 1 ? 'issues' : 'clean', verdict: reviewCalls === 1 ? 'issues' : 'pass' });
    },
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  manager.onWorkerEvent((event) => { if (event.type === 'stepRun') events.push(event); });
  managerRef.current = manager;

  const task = await settledExecute(manager)(item.id);
  runId = task.workflowRunId!;
  await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === 'awaiting-approval');
  assert.equal(buildCalls, 2, 'the review\'s one "issues" verdict sent Development back for a second round');

  await assert.rejects(() => manager.reportProgress('not-a-real-task-id', { currentActivity: 'x' }), workerManagerModule.TaskNotWorkflowStepError);

  const { tasksDb, planItemsDb } = await import('../src/db/collections.ts');
  const planTaskNow = new Date().toISOString();
  await tasksDb.insert({
    id: 'a-planning-task', projectId: project.id, templateId: 'builder', executorId: 'test-claude-cli', executionMode: 'terminal',
    description: 'Planning', status: 'developing', autonomy: 'auto', manager: false, kind: 'plan', planItemId: null,
    sessionId: 's', blockedQuestion: null, failureReason: null, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: planTaskNow, updatedAt: planTaskNow, completedAt: null,
  } as never);
  await assert.rejects(() => manager.reportProgress('a-planning-task', { currentActivity: 'x' }), workerManagerModule.TaskNotWorkflowStepError, 'a planning session has no step to report on');

  const otherItem = await planItemService.createPlanItem({ projectId: project.id, title: 'Plain task', description: 'x' });
  await tasksDb.insert({
    id: 'a-plain-execute-task', projectId: project.id, templateId: 'builder', executorId: 'test-claude-cli', executionMode: 'terminal',
    description: 'Plain', status: 'developing', autonomy: 'auto', manager: false, kind: 'execute', planItemId: otherItem.id,
    sessionId: 's', blockedQuestion: null, failureReason: null, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: planTaskNow, updatedAt: planTaskNow, completedAt: null,
  } as never);
  await planItemsDb.update(otherItem.id, { taskIds: ['a-plain-execute-task'], status: 'developing' });
  await assert.rejects(() => manager.reportProgress('a-plain-execute-task', { currentActivity: 'x' }), workerManagerModule.TaskNotWorkflowStepError, 'a plain execute Task outside any WorkflowRun has no step to report on');

  // No separate "another Project's Task" case: report_progress (like complete_step/skip_step) takes
  // only a taskId, routed through one shared, project-less `tasksDb` — there is no caller-supplied
  // project context it could get wrong. Authorization is already entirely intrinsic to the taskId's
  // own Task/run/step (and, above, that Task's own Project's active set), so a foreign taskId from
  // another Project is just one more case of "an id this session doesn't own," already covered by the
  // unknown-id/planning/plain-task assertions above.

  await manager.stopWorkflowRun(runId);
});

test('reportProgress refuses a reopened-for-inspection round: reopening never gets its own taskId, so the same settled Task id a reopened session would share is refused, before and after reopening', async () => {
  const { item } = await createProjectWithItem('Report Progress Inspect');
  const { manager, terminal } = managerWithFakeGit();
  const task = await settledExecute(manager)(item.id);
  const runId = task.workflowRunId!;
  await manager.stopWorkflowRun(runId);
  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');

  // A reopened inspect session gets no step MCP tools at all (see reopenStepSession's own doc
  // comment), so there is no separate taskId it could ever call report_progress with — it shares the
  // same settled Task id, which this guard already refuses on status alone.
  await assert.rejects(() => manager.reportProgress(task.id, { currentActivity: 'x' }), workerManagerModule.TaskNotWorkflowStepError);
  await manager.reopenStepSession(task.id);
  await assert.rejects(() => manager.reportProgress(task.id, { currentActivity: 'x' }), workerManagerModule.TaskNotWorkflowStepError, 'reopening for inspection does not change the Task\'s own settled status');
});

test('reportProgress is refused once a Task\'s status still reads \'developing\' but it has already been dropped from its Project\'s active set (the same race requireTestingSession guards against)', async () => {
  const { project, item } = await createProjectWithItem('Report Progress Race');
  const { manager, terminal } = managerWithFakeGit();
  const task = await settledExecute(manager)(item.id);

  const { projectsDb } = await import('../src/db/collections.ts');
  await projectsDb.update(project.id, { activeTaskIds: [], activeTaskId: null });
  await assert.rejects(() => manager.reportProgress(task.id, { currentActivity: 'x' }), workerManagerModule.TaskNotWorkflowStepError);

  await manager.stopWorkflowRun(task.workflowRunId!);
  terminal.starts[0]!.onExit(0);
});

test('a Workflow with no steps cannot be started (createWorkflow refuses an empty steps array)', async () => {
  await assert.rejects(
    () => workflowService.createWorkflow({
      id: 'empty-flow',
      name: 'Empty',
      description: 'x',
      steps: [],
    }),
    workflowService.InvalidWorkflowError,
  );
});

test('planning gaps flagged via complete_step are stored on their StepRun and folded, in step order, into the Docs & Retro prompt', async () => {
  const { item } = await createProjectWithItem('Planning Gaps');
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {
    ui: (id) => managerRef.current!.skipStep(id, { reason: 'No UI.' }),
    plan: (id) => managerRef.current!.completeStep(id, { summary: 'planned', planningGap: '  Empty-file behaviour was never specified.  ' }),
    build: (id) => managerRef.current!.completeStep(id, { summary: 'built', planningGap: '   ' }),
    review: (id) => managerRef.current!.completeStep(id, { summary: 'ok', verdict: 'pass', planningGap: 'Error copy was not decided.' }),
    signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
  });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  managerRef.current = manager;

  const task = await settledExecute(manager)(item.id);
  const runId = task.workflowRunId!;
  await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === 'awaiting-approval');

  const detail = await manager.getWorkflowRunDetail(runId);
  const roundOf = (stepId: string) => detail.steps.find((s) => s.step.id === stepId)!.rounds[0];
  assert.equal(roundOf('plan')?.planningGap, 'Empty-file behaviour was never specified.', 'the gap is trimmed and persisted');
  assert.equal(roundOf('build')?.planningGap, null, 'a whitespace-only gap is stored as none');
  assert.equal(roundOf('review')?.planningGap, 'Error copy was not decided.');

  const buildPrompt = starts.find((s) => s.prompt.includes('# Your step: Development'))?.prompt ?? '';
  assert.match(buildPrompt, /- Test Case Planning \(round 1\): Empty-file behaviour was never specified\./, 'later steps see gaps raised so far');
  assert.doesNotMatch(buildPrompt, /Error copy was not decided/, 'a gap from a step that has not run yet cannot appear');

  await manager.approveWorkflowRun(runId);
  await waitUntil(async () => starts.some((s) => s.prompt.includes('# Your step: Docs & Retro')));
  const retroPrompt = starts.find((s) => s.prompt.includes('# Your step: Docs & Retro'))!.prompt;
  const gapsSection = retroPrompt.slice(retroPrompt.indexOf('# Planning gaps raised this run'));
  assert.ok(gapsSection.indexOf('Test Case Planning (round 1)') < gapsSection.indexOf('Code Review (round 1)'), 'gaps are listed in step order');
  assert.doesNotMatch(gapsSection, /Development \(round 1\)/, 'a step that flagged no gap is not listed');

  await manager.stopWorkflowRun(runId);
});

// ---- Task details panel actions: stop → resume, mark complete, delete ----

/** A manager whose git writes are recorded instead of run — see WorkerManagerDeps.commitAndPush/removeWorktree. */
function managerWithFakeGit() {
  const terminal = fakeTerminalHost();
  const commits: { cwd: string; branch: string; message: string }[] = [];
  const removedWorktrees: string[] = [];
  const manager = workerManagerModule.createWorkerManager({
    runClaudeTurn: fakeSummarizerTurn,
    terminalSessions: terminal.host,
    commitAndPush: async (cwd, branch, message) => { commits.push({ cwd, branch, message }); return true; },
    removeWorktree: async (_cwd, worktreePath) => { removedWorktrees.push(worktreePath); },
  });
  return { manager, terminal, commits, removedWorktrees };
}

/** Gives a started (repository-less) run a repository and a branch — plus a worktree when `worktreePath` is set — so its git writes have somewhere to go. */
async function giveRunARepository(projectId: string, runId: string, worktreePath?: string): Promise<void> {
  const { projectsDb, workflowRunsDb } = await import('../src/db/collections.ts');
  await projectsDb.update(projectId, { repositoryUrl: 'https://github.com/test/repo' });
  await workflowRunsDb.update(runId, { branch: 'task/panel', ...(worktreePath ? { worktreePath } : {}) });
}

test('resume continues a stopped run in the stopped step\'s own CLI session with a "continue" message', async () => {
  const { item } = await createProjectWithItem('Resume Run');
  const { manager, terminal } = managerWithFakeGit();
  const task = await settledExecute(manager)(item.id);
  const runId = task.workflowRunId!;
  const sessionId = (await manager.getTask(task.id)).sessionId;
  assert.ok(sessionId);

  await assert.rejects(() => manager.resumeWorkflowRun(runId), workerManagerModule.WorkflowRunNotActionableError, 'a running run is not resumable');
  await manager.stopWorkflowRun(runId);
  await assert.rejects(() => manager.resumeWorkflowRun(runId), workerManagerModule.TaskNotFollowableError, 'refused until the stopped session has exited');
  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');
  assert.equal((await manager.getTask(task.id)).sessionId, sessionId, 'the stopped Task keeps its session id');

  const resumed = await manager.resumeWorkflowRun(runId);
  assert.equal(resumed.status, 'running');
  const start = terminal.starts[1]!;
  assert.equal(start.resume, true);
  assert.equal(start.sessionId, sessionId, 'the same CLI conversation is resumed');
  assert.equal(start.prompt, 'Continue.');
  assert.equal((await planItemService.getPlanItem(item.id)).status, 'developing');
  const rounds = (await manager.getWorkflowRunDetail(runId)).steps.find((s) => s.step.id === resumed.currentStepId)!.rounds;
  assert.deepEqual(rounds.map((r) => r.status), ['stopped', 'running']);

  await manager.stopWorkflowRun(runId);
  terminal.starts[1]!.onExit(0);
});

test('resume refuses a stopped run that is no longer its item\'s latest', async () => {
  const { item } = await createProjectWithItem('Resume Stale Run');
  const { manager, terminal } = managerWithFakeGit();
  const first = await settledExecute(manager)(item.id);
  await manager.stopWorkflowRun(first.workflowRunId!);
  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(first.id)).status === 'stopped');
  const second = await settledExecute(manager)(item.id);
  await manager.stopWorkflowRun(second.workflowRunId!);
  terminal.starts[1]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(second.id)).status === 'stopped');

  await assert.rejects(() => manager.resumeWorkflowRun(first.workflowRunId!), workerManagerModule.WorkflowRunNotActionableError);
});

test('mark complete stops a running session, commits in the run\'s worktree, completes the run and runs no further step', async () => {
  const { project, item } = await createProjectWithItem('Complete In Worktree');
  const { manager, terminal, commits, removedWorktrees } = managerWithFakeGit();
  const task = await settledExecute(manager)(item.id);
  const runId = task.workflowRunId!;
  const worktreePath = path.join(tempRoot, 'worktrees', 'panel');
  await giveRunARepository(project.id, runId, worktreePath);

  const completed = await manager.completePlanItem(item.id);
  assert.equal(completed.status, 'done');
  assert.deepEqual(terminal.stops, [task.id]);
  assert.deepEqual(commits, [{ cwd: worktreePath, branch: 'task/panel', message: 'Complete: Do the thing' }]);
  assert.deepEqual(removedWorktrees, [worktreePath]);
  const run = (await manager.getWorkflowRunDetail(runId)).run;
  assert.equal(run.status, 'completed');
  assert.ok(run.completedAt);
  assert.equal(run.prUrl, null, 'no PR: the Complete stage is not run');
  assert.match(run.completionReport ?? '', /Marked complete by hand/);

  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');
  assert.equal(terminal.starts.length, 1, 'no remaining step was started');
  await assert.rejects(() => manager.completePlanItem(item.id), planItemService.PlanItemCompletedError);
});

test('mark complete on a stopped in-place run commits in the project folder', async () => {
  const { project, item } = await createProjectWithItem('Complete In Place');
  const { manager, terminal, commits, removedWorktrees } = managerWithFakeGit();
  const task = await settledExecute(manager)(item.id);
  await manager.stopWorkflowRun(task.workflowRunId!);
  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');
  await giveRunARepository(project.id, task.workflowRunId!);

  assert.equal((await manager.completePlanItem(item.id)).status, 'done');
  assert.deepEqual(terminal.stops, [task.id], 'nothing left to stop');
  assert.deepEqual(commits.map((c) => c.cwd), [projectService.projectAbsolutePath(project)]);
  assert.deepEqual(removedWorktrees, []);
});

test('mark complete on a repository-less run just completes it, without any commit', async () => {
  const { item } = await createProjectWithItem('Complete No Repo');
  const { manager, terminal, commits } = managerWithFakeGit();
  const task = await settledExecute(manager)(item.id);
  assert.equal((await manager.completePlanItem(item.id)).status, 'done');
  assert.deepEqual(commits, []);
  terminal.starts[0]!.onExit(0);
});

test('mark complete on an item that never ran just sets it done', async () => {
  const { item } = await createProjectWithItem('Complete Never Ran');
  const { manager, commits } = managerWithFakeGit();
  assert.equal((await manager.completePlanItem(item.id)).status, 'done');
  assert.deepEqual(commits, []);
});

test('delete stops a running item\'s session, removes its worktree, and deletes it', async () => {
  const { project, item } = await createProjectWithItem('Delete Running');
  const { manager, terminal, removedWorktrees } = managerWithFakeGit();
  const events: string[] = [];
  manager.onWorkerEvent((event) => { if (event.type === 'planItemDeleted') events.push(event.id); });
  const task = await settledExecute(manager)(item.id);
  const worktreePath = path.join(tempRoot, 'worktrees', 'delete');
  await giveRunARepository(project.id, task.workflowRunId!, worktreePath);

  await manager.deletePlanItem(item.id);
  assert.deepEqual(terminal.stops, [task.id]);
  assert.deepEqual(removedWorktrees, [worktreePath]);
  assert.deepEqual(events, [item.id]);
  await assert.rejects(() => planItemService.getPlanItem(item.id), planItemService.PlanItemNotFoundError);
  assert.equal((await manager.getWorkflowRunDetail(task.workflowRunId!)).run.status, 'stopped');

  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(task.id)).status === 'stopped');
  await assert.rejects(() => manager.deletePlanItem(item.id), planItemService.PlanItemNotFoundError);
});

test('delete of an item without a worktree stops nothing and removes no worktree', async () => {
  const { item } = await createProjectWithItem('Delete Idle');
  const { manager, terminal, removedWorktrees } = managerWithFakeGit();
  await manager.deletePlanItem(item.id);
  assert.deepEqual(terminal.stops, []);
  assert.deepEqual(removedWorktrees, []);
});

test('delete also stops a live Task of the item that runs outside any WorkflowRun', async () => {
  const { project, item } = await createProjectWithItem('Delete Legacy Task');
  const { tasksDb, planItemsDb } = await import('../src/db/collections.ts');
  const { manager, terminal } = managerWithFakeGit();
  const now = new Date().toISOString();
  await tasksDb.insert({
    id: 'legacy-live-task', projectId: project.id, templateId: 'builder', executorId: 'test-claude-cli', executionMode: 'terminal',
    description: 'Legacy', status: 'developing', autonomy: 'auto', manager: false, kind: 'execute', planItemId: item.id,
    sessionId: 's', blockedQuestion: null, failureReason: null, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: null,
  });
  await planItemsDb.update(item.id, { taskIds: ['legacy-live-task'], status: 'developing' });
  terminal.live.add('legacy-live-task');

  await manager.deletePlanItem(item.id);
  assert.deepEqual(terminal.stops, ['legacy-live-task']);
  await assert.rejects(() => planItemService.getPlanItem(item.id), planItemService.PlanItemNotFoundError);
});

test('a read-only step with canRunCommands keeps the shell and gets the testing tools, but no edit tools and no commit', async () => {
  const original = (await workflowService.getWorkflow('software-development'))!;
  await workflowService.updateWorkflow('software-development', {
    steps: original.steps.map((s) => (s.id === 'plan' ? { ...s, canRunCommands: true } : s)),
  });
  try {
    const { item } = await createProjectWithItem('Command Step');
    const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
    const testingAccess: Record<string, boolean> = {};
    const { host, starts } = autoAdvanceTerminalSteps(managerRef, {
      ui: (id) => managerRef.current!.skipStep(id, { reason: 'skip' }),
      plan: async (id) => {
        testingAccess.plan = await managerRef.current!.requireTestingSession(id).then(() => true, () => false);
        await managerRef.current!.completeStep(id, { summary: 'install failed: no network' });
      },
      build: (id) => managerRef.current!.completeStep(id, { summary: 'built' }),
      review: (id) => managerRef.current!.completeStep(id, { summary: 'ok', verdict: 'pass' }),
      signoff: (id) => managerRef.current!.completeStep(id, { summary: 'ready' }),
    });
    const manager2 = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
    managerRef.current = manager2;
    const task = await settledExecute(manager2)(item.id);
    await waitUntil(async () => (await manager2.getWorkflowRunDetail(task.workflowRunId!)).run.status === 'awaiting-approval');

    const planStart = starts[1];
    assert.deepEqual(planStart?.disallowedTools, ['Edit', 'Write', 'NotebookEdit']);
    assert.equal(planStart?.readOnly, true);
    assert.equal(planStart?.canRunCommands, true);
    assert.deepEqual(planStart?.mcpServers?.map((server) => server.name), ['agent_visual_os_step', 'agent_visual_os_tests']);
    assert.match(planStart?.systemPrompt ?? '', /list_test_actions/);
    assert.match(planStart?.prompt ?? '', /MAY run commands/);
    assert.match(planStart?.prompt ?? '', /not committed/);
    assert.equal(testingAccess.plan, true);
    const planTask = await manager2.getTask(planStart!.taskId);
    assert.equal(planTask.sessionSetup?.canRunCommands, true);
    assert.equal(await workerManagerModule.stepCanEditCode(planTask), false, 'a command-only step is not a write step');
    assert.equal(starts[0]?.canRunCommands, undefined, 'a plain read-only step is unchanged');
    assert.ok(starts[0]?.disallowedTools?.includes('Bash'));
    await manager2.stopWorkflowRun(task.workflowRunId!);
  } finally {
    await workflowService.updateWorkflow('software-development', { steps: original.steps });
  }
});

test('a command-only step is never committed or pushed, whether it completes or is skipped; the next write step still commits', async () => {
  const original = (await workflowService.getWorkflow('software-development'))!;
  await workflowService.updateWorkflow('software-development', {
    steps: original.steps.map((s) => (s.id === 'plan' ? { ...s, canRunCommands: true } : s)),
  });
  try {
    for (const finish of ['complete', 'skip'] as const) {
      const { project, item } = await createProjectWithItem(`Command No Commit ${finish}`);
      const { manager, terminal, commits } = managerWithFakeGit();
      const task = await settledExecute(manager)(item.id);
      const runId = task.workflowRunId!;
      const worktree = path.join(tempRoot, 'worktrees', `cmd-${finish}`);
      await mkdir(worktree, { recursive: true });
      for (const args of [['init', '-b', 'task/panel'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['commit', '--allow-empty', '-m', 'base']]) execFileSync('git', args, { cwd: worktree });
      await giveRunARepository(project.id, runId, worktree);

      await manager.skipStep(terminal.starts[0]!.taskId, { reason: 'skip' });
      terminal.starts[0]!.onExit(0);
      await waitUntil(async () => terminal.starts.length >= 2);
      const planTaskId = terminal.starts[1]!.taskId;
      if (finish === 'complete') await manager.completeStep(planTaskId, { summary: 'install failed: no network' });
      else await manager.skipStep(planTaskId, { reason: 'nothing to run' });
      terminal.starts[1]!.onExit(0);
      await waitUntil(async () => terminal.starts.length >= 3);
      assert.deepEqual(commits, [], 'no per-step commit or push for a command-only step');
      assert.notEqual((await manager.getWorkflowRunDetail(runId)).run.status, 'failed');
      assert.notEqual((await manager.getWorkflowRunDetail(runId)).run.status, 'needs-attention');

      await manager.completeStep(terminal.starts[2]!.taskId, { summary: 'built' });
      terminal.starts[2]!.onExit(0);
      await waitUntil(async () => commits.length >= 1);
      assert.equal(commits.length, 1, 'the write step after it commits as usual');
      await manager.stopWorkflowRun(runId);
    }
  } finally {
    await workflowService.updateWorkflow('software-development', { steps: original.steps });
  }
});

test('the run snapshot keeps canRunCommands when the workflow is edited afterwards', async () => {
  const original = (await workflowService.getWorkflow('software-development'))!;
  await workflowService.updateWorkflow('software-development', {
    steps: original.steps.map((s) => (s.id === 'plan' ? { ...s, canRunCommands: true } : s)),
  });
  try {
    const { item } = await createProjectWithItem('Snapshot Command');
    const { manager } = managerWithFakeGit();
    const task = await settledExecute(manager)(item.id);
    await workflowService.updateWorkflow('software-development', { steps: original.steps });
    const snapshot = (await manager.getWorkflowRunDetail(task.workflowRunId!)).run.workflowSnapshot;
    assert.equal(snapshot.steps.find((s) => s.id === 'plan')?.canRunCommands, true);
    await manager.stopWorkflowRun(task.workflowRunId!);
  } finally {
    await workflowService.updateWorkflow('software-development', { steps: original.steps });
  }
});
