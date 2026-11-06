import assert from 'node:assert/strict';
import { settledExecute } from './helpers/startRun.ts';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import type { TerminalSessionHost, TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import type { StepOutputFiles } from '../src/worker/stepOutputFiles.ts';
import { installDocsRetroFixture } from './fixtures/docsRetroFixture.ts';
import { outputRefs, referencedContents } from './helpers/stepOutputRefs.ts';
import { autoAdvanceTerminalSteps, fakeTerminalHost, type StepAction } from './helpers/terminalStepFakes.ts';

/**
 * Engine coverage for task 5.020: earlier steps' outputs reach later steps as references to files
 * saved in the daemon's data directory (not pasted), in full briefings and in later rounds'
 * messages; the files go with their task and Project; a write failure falls back to pasting.
 */

let tempRoot: string;
let outputsRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let stepOutputFilesModule: typeof import('../src/worker/stepOutputFiles.ts');

type Manager = ReturnType<typeof import('../src/worker/workerManager.ts')['createWorkerManager']>;

/** A user-made workflow's own step ids (not the built-in Software Development ones). */
const STEPS = [
  { id: 'ui', name: 'UI Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Plan the UI.' },
  { id: 'plan', name: 'Test Case Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'List test cases.' },
  { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Implement the task.' },
  { id: 'review', name: 'Code Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Review the diff.', loopBack: { toStepId: 'build', maxRounds: 3 } },
  { id: 'signoff', name: 'Human Code Review', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Write a review brief.', requestChangesToStepId: 'build' },
  { id: 'docs', name: 'Docs & Retro', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Update docs and retro.' },
];

const MOCKUPS = [
  { name: 'Settings screen', format: 'html' as const, content: '<html><body><div id="mock-marker">Settings</div></body></html>' },
  { name: 'Home screen', format: 'html' as const, content: '<html><body><div id="mock-marker">Home</div></body></html>' },
];
const CASES = (round: number) => [{ name: 'Test cases', format: 'markdown' as const, content: `# Cases v${round}\n\n- case-marker-${round}` }];
const NOTES = (round: number) => [{ name: 'Build notes', format: 'markdown' as const, content: `notes-marker round ${round}` }];

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'step-output-prompts-test-'));
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
  stepOutputFilesModule = await import('../src/worker/stepOutputFiles.ts');
  outputsRoot = path.join(tempRoot, 'data', 'step-outputs');
  assert.equal(stepOutputFilesModule.STEP_OUTPUTS_DIR, outputsRoot);

  await workflowService.updateWorkflow('software-development', { name: 'Outputs By Path', description: 'Test workflow.', steps: STEPS });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fakeSummarizerTurn(): Promise<ClaudeTurnResult> {
  return {
    sessionId: 'summary-session', status: 'done', message: 'ok',
    extra: { tldr: 'Done.', requirement: 'req', whatWasDeveloped: 'dev', reviewHighlights: 'None', docsUpdated: 'None', retroUpdates: 'None' },
    raw: { type: 'result' },
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function counted(action: (id: string, call: number) => unknown): StepAction {
  let calls = 0;
  return (id) => action(id, ++calls);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

interface Harness {
  manager: Manager;
  starts: TerminalSessionStart[];
  runId: string;
  itemId: string;
  projectId: string;
  startsFor(stepId: string): Promise<TerminalSessionStart[]>;
  rounds(stepId: string): Promise<import('../src/domain/types.ts').StepRunRecord[]>;
  waitForStatus(status: string): Promise<void>;
}

interface RunOptions {
  stepOutputFiles?: StepOutputFiles;
  sessionExists?: () => boolean;
  host?: (host: TerminalSessionHost) => TerminalSessionHost;
  projectId?: string;
}

/** Starts a run whose UI Planning saves two mockups, Test Case Planning a Markdown list, and Development notes each round. */
async function startRun(name: string, actions: (ref: { current?: Manager }) => Record<string, StepAction> = () => ({}), opts: RunOptions = {}): Promise<Harness> {
  const projectId = opts.projectId ?? (await projectService.createProject({ name, position: null })).id;
  const item = await planItemService.createPlanItem({ projectId, title: `Do ${name}`, description: 'A test task.' });
  const ref: { current?: Manager } = {};
  const { host: autoHost, starts } = autoAdvanceTerminalSteps(ref, {
    ui: (id) => ref.current!.completeStep(id, { summary: 'Two mockups.', outputs: MOCKUPS }),
    plan: counted((id, call) => ref.current!.completeStep(id, { summary: `Cases planned round ${call}.`, outputs: CASES(call) })),
    build: counted((id, call) => ref.current!.completeStep(id, { summary: `built round ${call}`, outputs: NOTES(call) })),
    review: counted((id, call) => ref.current!.completeStep(id, { summary: `clean round ${call}`, verdict: 'pass' })),
    signoff: (id) => ref.current!.completeStep(id, { summary: 'Brief.' }),
    docs: (id) => ref.current!.completeStep(id, { summary: 'Docs.' }),
    ...actions(ref),
  });
  autoHost.sessionExists = () => opts.sessionExists?.() ?? true;
  const host = opts.host ? opts.host(autoHost) : autoHost;
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host, stepOutputFiles: opts.stepOutputFiles });
  ref.current = manager;
  const first = await settledExecute(manager)(item.id, {});
  const runId = first.workflowRunId!;
  const stepOf = async (start: TerminalSessionStart) => (await manager.getTask(start.taskId)).workflowStepId;
  return {
    manager, starts, runId, itemId: item.id, projectId,
    async startsFor(stepId) {
      const matched: TerminalSessionStart[] = [];
      for (const start of starts) if (await stepOf(start) === stepId) matched.push(start);
      return matched;
    },
    async rounds(stepId) {
      return (await manager.getWorkflowRunDetail(runId)).steps.find((s) => s.step.id === stepId)!.rounds;
    },
    async waitForStatus(status) {
      await waitUntil(async () => (await manager.getWorkflowRunDetail(runId)).run.status === status);
    },
  };
}

const runDir = (h: Harness) => path.join(outputsRoot, h.projectId, h.runId);

test('UI Planning\'s mockups reach every later step by absolute path, never pasted, and the files hold them exactly', async () => {
  const h = await startRun('Mockups By Path');
  await h.waitForStatus('awaiting-approval');
  await h.manager.approveWorkflowRun(h.runId);
  await h.waitForStatus('completed');

  const expectedPaths = [
    path.join(runDir(h), 'ui', 'round-1', 'settings-screen.html'),
    path.join(runDir(h), 'ui', 'round-1', 'home-screen.html'),
  ];
  for (const stepId of ['plan', 'build', 'review', 'signoff', 'docs']) {
    const [start] = await h.startsFor(stepId);
    assert.doesNotMatch(start!.prompt, /mock-marker/, `${stepId} has no pasted HTML`);
    const mockupRefs = outputRefs(start!.prompt).filter((ref) => ref.format === 'html');
    assert.deepEqual(mockupRefs.map((ref) => [ref.name, ref.path]), [['Settings screen', expectedPaths[0]], ['Home screen', expectedPaths[1]]], stepId);
    assert.ok(mockupRefs.every((ref) => ref.size === '~1 line'));
    assert.match(start!.prompt, /Summary: Two mockups\./, `${stepId} keeps the summary inline`);
  }
  for (const [index, file] of expectedPaths.entries()) assert.equal(await readFile(file, 'utf-8'), MOCKUPS[index]!.content);
});

test('a Markdown output reaches Development by path with its summary inline; every session may read the run\'s folder', async () => {
  const h = await startRun('Markdown By Path');
  await h.waitForStatus('awaiting-approval');
  const [build] = await h.startsFor('build');
  assert.match(build!.prompt, /Summary: Cases planned round 1\.\nOutput: Test cases \(markdown, ~3 lines\)\nAbsolute path: /);
  assert.doesNotMatch(build!.prompt, /case-marker-1/);
  assert.deepEqual(referencedContents(build!.prompt).at(-1), CASES(1)[0]!.content);

  for (const start of h.starts) assert.deepEqual(start.readOnlyDirs, [runDir(h)], 'code-editing and read-only steps alike get the read grant');
  await h.manager.stopWorkflowRun(h.runId);
});

test('output files live in the daemon\'s data directory, never inside the project folder or its worktree', async () => {
  const h = await startRun('Outside The Repo');
  await h.waitForStatus('awaiting-approval');
  const project = await projectService.getProject(h.projectId);
  const projectDir = projectService.projectAbsolutePath(project);
  const run = (await h.manager.getWorkflowRunDetail(h.runId)).run;
  const [signoff] = await h.startsFor('signoff');
  const refs = outputRefs(signoff!.prompt);
  assert.ok(refs.length >= 4);
  for (const ref of refs) {
    assert.ok(path.isAbsolute(ref.path));
    assert.ok(ref.path.startsWith(`${outputsRoot}${path.sep}`), ref.path);
    assert.ok(!ref.path.startsWith(projectDir), 'not in the project folder');
    if (run.worktreePath) assert.ok(!ref.path.startsWith(run.worktreePath), 'not in the worktree');
  }
  await h.manager.stopWorkflowRun(h.runId);
});

test('a review loop saves each Development round separately, and the resumed review round gets the new round\'s notes by path', async () => {
  const h = await startRun('Loop Rounds', (ref) => ({
    review: counted((id, call) => ref.current!.completeStep(id, call === 1 ? { summary: 'Fix it.', verdict: 'issues' } : { summary: 'clean', verdict: 'pass' })),
  }));
  await h.waitForStatus('awaiting-approval');
  const round1 = path.join(runDir(h), 'build', 'round-1', 'build-notes.md');
  const round2 = path.join(runDir(h), 'build', 'round-2', 'build-notes.md');

  const [, review2] = await h.startsFor('review');
  assert.equal(review2!.resume, true);
  assert.match(review2!.prompt, /^Development has addressed your previous review/);
  assert.deepEqual(outputRefs(review2!.prompt).map((ref) => ref.path), [round2]);
  assert.doesNotMatch(review2!.prompt, /notes-marker/);

  const [, build2] = await h.startsFor('build');
  assert.match(build2!.prompt, /^Code Review round 1 found issues/);
  assert.doesNotMatch(build2!.prompt, /Absolute path:|notes-marker/, 'the review-fix message carries only the review');

  const [signoff] = await h.startsFor('signoff');
  const buildRefs = outputRefs(signoff!.prompt).filter((ref) => ref.name === 'Build notes').map((ref) => ref.path);
  assert.deepEqual(buildRefs, [round1, round2]);
  assert.equal(await readFile(round1, 'utf-8'), NOTES(1)[0]!.content);
  assert.equal(await readFile(round2, 'utf-8'), NOTES(2)[0]!.content);
  await h.manager.stopWorkflowRun(h.runId);
});

test('Request changes: the re-run messages and a fresh fallback briefing reference outputs by path', async () => {
  const h = await startRun('Request Changes Paths', () => ({}), { sessionExists: () => false });
  await h.waitForStatus('awaiting-approval');
  await h.manager.requestChangesWorkflowRun(h.runId, 'Use the new wording.');
  await waitUntil(async () => (await h.rounds('signoff')).length === 2);
  await h.waitForStatus('awaiting-approval');

  const [, build2] = await h.startsFor('build');
  assert.equal(build2!.resume, false, 'no saved session: a fresh briefing');
  assert.match(build2!.prompt, /# Your step: Development\n\nImplement the task\.\n\nThe human reviewer requested changes: Use the new wording\./);
  assert.doesNotMatch(build2!.prompt, /mock-marker|case-marker|notes-marker/);
  assert.deepEqual(outputRefs(build2!.prompt).map((ref) => ref.name), ['Settings screen', 'Home screen', 'Test cases']);

  const [, signoff2] = await h.startsFor('signoff');
  assert.match(signoff2!.prompt, /these steps have new results: Development, Code Review\./);
  assert.doesNotMatch(signoff2!.prompt, /notes-marker/);
  assert.ok(outputRefs(signoff2!.prompt).some((ref) => ref.path.endsWith(path.join('build', 'round-2', 'build-notes.md'))));
  await h.manager.stopWorkflowRun(h.runId);
});

test('an unwritable outputs folder falls back to pasting: the next step still starts and an error is logged', async () => {
  const blocked = path.join(tempRoot, 'not-a-folder');
  await writeFile(blocked, 'a file where the outputs folder should be');
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    const h = await startRun('Write Fails', (ref) => ({ plan: () => undefined, build: () => undefined, ui: (id) => ref.current!.completeStep(id, { summary: 'Two mockups.', outputs: MOCKUPS }) }), {
      stepOutputFiles: stepOutputFilesModule.createStepOutputFiles(blocked),
    });
    await waitUntil(async () => (await h.startsFor('plan')).length === 1);
    const [plan] = await h.startsFor('plan');
    assert.equal((await h.manager.getTask(plan!.taskId)).status, 'developing', 'the step started');
    assert.match(plan!.prompt, /--- Output: Settings screen \(html\) ---\n<html><body><div id="mock-marker">Settings/);
    assert.deepEqual(outputRefs(plan!.prompt), []);
    assert.ok(errors.some((line) => line.includes(`run ${h.runId}, step ui, round 1`)), errors.join('\n'));
    await h.manager.stopWorkflowRun(h.runId);
  } finally {
    console.error = original;
  }
});

test('one output failing to save is pasted while the other stays a reference', async () => {
  const real = stepOutputFilesModule.createStepOutputFiles(outputsRoot);
  const partial: StepOutputFiles = {
    ...real,
    async ensureRound(round) {
      const paths = await real.ensureRound(round);
      return paths.map((p, index) => (round.outputs[index]?.name === 'Home screen' ? null : p));
    },
  };
  const h = await startRun('Partial Failure', () => ({ plan: () => undefined }), { stepOutputFiles: partial });
  await waitUntil(async () => (await h.startsFor('plan')).length === 1);
  const [plan] = await h.startsFor('plan');
  assert.deepEqual(outputRefs(plan!.prompt).map((ref) => ref.name), ['Settings screen']);
  assert.match(plan!.prompt, /--- Output: Home screen \(html\) ---\n<html><body><div id="mock-marker">Home/);
  await h.manager.stopWorkflowRun(h.runId);
});

test('deleting a task removes its run\'s outputs folder; another run\'s folder in the same project survives, and the run view never needed the files', async () => {
  const h = await startRun('Delete Task', () => ({ build: () => undefined }));
  await waitUntil(async () => (await h.startsFor('build')).length === 1);
  await h.manager.stopWorkflowRun(h.runId);
  assert.ok(await exists(runDir(h)));

  // The run view reads outputs from the step runs, not the files.
  await rm(path.join(runDir(h), 'ui'), { recursive: true, force: true });
  assert.deepEqual((await h.rounds('ui'))[0]!.outputs, MOCKUPS);

  const otherDir = path.join(outputsRoot, h.projectId, 'other-run');
  await stepOutputFilesModule.createStepOutputFiles(outputsRoot).ensureRound({ projectId: h.projectId, runId: 'other-run', stepId: 'ui', round: 1, outputs: MOCKUPS });

  await h.manager.deletePlanItem(h.itemId);
  assert.equal(await exists(runDir(h)), false, 'the deleted task\'s folder is gone');
  assert.ok(await exists(otherDir), 'another run\'s folder survives');
});

test('a failure deleting the folder is logged and never blocks deleting the task', async () => {
  const real = stepOutputFilesModule.createStepOutputFiles(outputsRoot);
  const failing: StepOutputFiles = { ...real, removeRun: () => Promise.reject(new Error('EBUSY: disk busy')) };
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    const h = await startRun('Delete Fails', () => ({ plan: () => undefined }), { stepOutputFiles: failing });
    await waitUntil(async () => (await h.startsFor('plan')).length === 1);
    await h.manager.stopWorkflowRun(h.runId);
    await h.manager.deletePlanItem(h.itemId);
    await assert.rejects(planItemService.getPlanItem(h.itemId));
    assert.ok(errors.some((line) => line.includes(`saved step outputs of run ${h.runId}`)), errors.join('\n'));
  } finally {
    console.error = original;
  }
});

test('deleting a Project removes its whole outputs folder; other projects\' folders survive', async () => {
  const h = await startRun('Delete Project', () => ({ plan: () => undefined }));
  await waitUntil(async () => (await h.startsFor('plan')).length === 1);
  await h.manager.stopWorkflowRun(h.runId);
  await waitUntil(async () => !(await projectService.getProject(h.projectId)).activeTaskId);
  const otherDir = path.join(outputsRoot, 'some-other-project');
  await stepOutputFilesModule.createStepOutputFiles(outputsRoot).ensureRound({ projectId: 'some-other-project', runId: 'r', stepId: 'ui', round: 1, outputs: MOCKUPS });
  assert.ok(await exists(path.join(outputsRoot, h.projectId)));

  await projectService.deleteProject(h.projectId);
  assert.equal(await exists(path.join(outputsRoot, h.projectId)), false);
  assert.ok(await exists(otherDir));
});

test('a run whose first step fails to launch leaves no outputs folder behind', async () => {
  const project = await projectService.createProject({ name: 'Rolled Back', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Never starts', description: 'x' });
  const host: TerminalSessionHost = {
    start() { throw new Error('spawn failed'); },
    attach: () => () => undefined, write() {}, resize() {}, stop: () => true, has: () => false, isAttached: () => false, count: () => 0,
  };
  const removed: string[] = [];
  const real = stepOutputFilesModule.createStepOutputFiles(outputsRoot);
  const manager = workerManagerModule.createWorkerManager({
    runClaudeTurn: fakeSummarizerTurn, terminalSessions: host,
    stepOutputFiles: { ...real, removeRun: async (projectId, runId) => { removed.push(runId); await real.removeRun(projectId, runId); } },
  });
  await assert.rejects(settledExecute(manager)(item.id, {}));
  assert.equal(removed.length, 1, 'the rolled-back run\'s folder is removed');
  assert.equal(await exists(path.join(outputsRoot, project.id, removed[0]!)), false);
});

test('a freeform task gets no read grant', async () => {
  const project = await projectService.createProject({ name: 'No Grant', position: null });
  const { host, starts } = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  const task = await manager.startTask({ projectId: project.id, description: 'Freeform work.', executorId: 'test-claude-cli' });
  await waitUntil(async () => starts.length >= 1);
  assert.equal(starts[0]!.readOnlyDirs, undefined);
  await manager.stopTask(task.id);
});
