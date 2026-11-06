import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import { appendStepNote, assertStepId, keepStepNotesFor, MAX_STEP_NOTE_LENGTH, parseStepNote, StepNoteValidationError, withStepNote } from '../src/projects/stepNotes.ts';
import { buildStepPrompt } from '../src/worker/workflowPrompt.ts';
import { settledExecute } from './helpers/startRun.ts';
import type { TerminalSessionHost } from '../src/terminal/terminalSessionManager.ts';
import { autoAdvanceTerminalSteps, type StepAction } from './helpers/terminalStepFakes.ts';

const baseInput = {
  taskTitle: 'T', taskDescription: 'D', stepName: 'Dev', instructions: 'Do it.', canEditCode: true, requiresVerdict: false, history: [],
};

test('buildStepPrompt ends with the note, verbatim, after one blank line', () => {
  const note = '# Your step: X\n\r\n  indented\n# How to finish';
  const prompt = buildStepPrompt({ ...baseInput, stepNote: note });
  assert.ok(prompt.endsWith(`\n\n${note}`));
  assert.equal(prompt.slice(0, prompt.length - note.length - 2), buildStepPrompt(baseInput));
});

test('buildStepPrompt is unchanged without a usable note', () => {
  const plain = buildStepPrompt(baseInput);
  for (const stepNote of [undefined, null, '', '  \n ']) assert.equal(buildStepPrompt({ ...baseInput, stepNote }), plain);
});

test('the note stays last when history, gaps and branch are present', () => {
  const prompt = buildStepPrompt({
    ...baseInput, stepNote: 'last', branch: 'b', baseBranch: 'main',
    history: [{ stageName: 'S', rounds: [{ round: 1, summary: 's', outputs: [] }] }],
    planningGaps: [{ stageName: 'S', round: 1, note: 'gap' }],
  });
  assert.ok(prompt.endsWith('\n\nlast'));
});

test('appendStepNote appends to a resume message and ignores empty notes', () => {
  assert.equal(appendStepNote('continue', ' hello '), 'continue\n\nhello');
  assert.equal(appendStepNote('continue', null), 'continue');
  assert.equal(appendStepNote('continue', '  '), 'continue');
});

test('parseStepNote trims, clears on empty or null, and keeps inner newlines', () => {
  assert.equal(parseStepNote('  a\r\nb  '), 'a\r\nb');
  assert.equal(parseStepNote('   '), null);
  assert.equal(parseStepNote(''), null);
  assert.equal(parseStepNote(null), null);
});

test('parseStepNote counts the trimmed text in code points against the limit', () => {
  assert.equal(parseStepNote('x'.repeat(MAX_STEP_NOTE_LENGTH))?.length, MAX_STEP_NOTE_LENGTH);
  assert.equal(parseStepNote(` ${'x'.repeat(MAX_STEP_NOTE_LENGTH)} `)?.length, MAX_STEP_NOTE_LENGTH);
  assert.throws(() => parseStepNote('x'.repeat(MAX_STEP_NOTE_LENGTH + 1)), /4000 characters; it is 1 over/);
  assert.ok(parseStepNote('😀'.repeat(MAX_STEP_NOTE_LENGTH)));
  assert.throws(() => parseStepNote('😀'.repeat(MAX_STEP_NOTE_LENGTH + 1)), StepNoteValidationError);
});

test('parseStepNote refuses a non-text note', () => {
  for (const bad of [1, {}, [], true, undefined]) assert.throws(() => parseStepNote(bad), StepNoteValidationError);
});

test('assertStepId accepts slugs and refuses anything else', () => {
  assertStepId('ui-planning');
  for (const bad of ['', 'Dev', '../x', '__proto__', 'a'.repeat(101), 5, undefined, '-a']) assert.throws(() => assertStepId(bad), StepNoteValidationError);
});

test('withStepNote sets, replaces and removes one step without touching the others', () => {
  assert.deepEqual(withStepNote(undefined, 'a', 'x'), { a: 'x' });
  assert.deepEqual(withStepNote({ a: 'x', b: 'y' }, 'a', 'z'), { a: 'z', b: 'y' });
  assert.deepEqual(withStepNote({ a: 'x', b: 'y' }, 'a', null), { b: 'y' });
});

test('keepStepNotesFor drops notes for steps outside the list', () => {
  assert.deepEqual(keepStepNotesFor({ a: '1', b: '2' }, ['b']), { b: '2' });
  assert.deepEqual(keepStepNotesFor(undefined, ['b']), {});
});

// ---- Engine: a note set on an idle task reaches the step's prompt once, then is cleared ----

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'step-notes-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workflowService = await import('../src/catalog/workflowService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  await workflowService.updateWorkflow('software-development', {
    name: 'Notes Flow', description: 'Test workflow.',
    steps: [
      { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Implement.' },
      { id: 'docs', name: 'Docs', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Document.' },
    ],
  });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fakeSummarizerTurn(): Promise<ClaudeTurnResult> {
  return { sessionId: 's', status: 'done', message: 'ok', extra: { tldr: 'Done.', requirement: 'r', whatWasDeveloped: 'd', reviewHighlights: 'None', docsUpdated: 'None', retroUpdates: 'None' }, raw: { type: 'result' } };
}

type Manager = ReturnType<typeof workerManagerModule.createWorkerManager>;

async function setup(name: string, opts: { actions?: Record<string, StepAction>; wrap?: (host: TerminalSessionHost, ref: { current?: Manager }, itemId: () => string) => TerminalSessionHost } = {}) {
  const project = await projectService.createProject({ name, position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: name, description: 'A test task.' });
  const ref: { current?: Manager } = {};
  const { host: autoHost, starts } = autoAdvanceTerminalSteps(ref, opts.actions ?? {
    build: (id) => ref.current!.completeStep(id, { summary: 'built' }),
    docs: (id) => ref.current!.completeStep(id, { summary: 'docs' }),
  });
  autoHost.sessionExists = () => true;
  const host = opts.wrap ? opts.wrap(autoHost, ref, () => item.id) : autoHost;
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host });
  ref.current = manager;
  return { manager, item, starts };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 1000 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('an idle task\'s note is stored trimmed, replaced, cleared and validated', async () => {
  const { manager, item } = await setup('Idle Notes');
  assert.deepEqual((await manager.setStepNote(item.id, 'build', '  first  ')).stepNotes, { build: 'first' });
  assert.deepEqual((await manager.setStepNote(item.id, 'docs', 'other')).stepNotes, { build: 'first', docs: 'other' });
  assert.deepEqual((await manager.setStepNote(item.id, 'build', 'second')).stepNotes, { build: 'second', docs: 'other' });
  assert.deepEqual((await manager.setStepNote(item.id, 'build', '  ')).stepNotes, { docs: 'other' });
  await assert.rejects(manager.setStepNote(item.id, 'Bad Id', 'x'), StepNoteValidationError);
  await assert.rejects(manager.setStepNote(item.id, 'docs', 'x'.repeat(MAX_STEP_NOTE_LENGTH + 1)), StepNoteValidationError);
  assert.deepEqual((await planItemService.getPlanItem(item.id)).stepNotes, { docs: 'other' }, 'a refused note leaves the stored one');
  await assert.rejects(manager.setStepNote('missing', 'build', 'x'), planItemService.PlanItemNotFoundError);
});

test('starting a task appends the step\'s note to that step only, drops unknown steps and clears what was sent', async () => {
  const { manager, item, starts } = await setup('Start Notes');
  await manager.setStepNote(item.id, 'build', 'Please use tabs.');
  await manager.setStepNote(item.id, 'not-in-workflow', 'lost');
  const run = await settledExecute(manager)(item.id, {});
  await waitFor(async () => (await manager.getWorkflowRunDetail(run.workflowRunId!)).run.status === 'completed');

  const prompts = new Map<string, string>();
  for (const start of starts) prompts.set((await manager.getTask(start.taskId)).workflowStepId!, start.prompt);
  assert.ok(prompts.get('build')!.endsWith('\n\nPlease use tabs.'));
  assert.ok(!prompts.get('docs')!.includes('Please use tabs.'));
  const detail = await manager.getWorkflowRunDetail(run.workflowRunId!);
  assert.deepEqual(detail.stepNotes, {});
  await assert.rejects(manager.setStepNote(item.id, 'not-in-workflow', 'x'), /not a step of this task's workflow/);
});

test('a note saved for a finished step is kept for the next round', async () => {
  const { manager, item } = await setup('Later Notes');
  const run = await settledExecute(manager)(item.id, {});
  await waitFor(async () => (await manager.getWorkflowRunDetail(run.workflowRunId!)).run.status === 'completed');
  const updated = await manager.setStepNote(item.id, 'build', 'Next time, add tests.');
  assert.deepEqual(updated.stepNotes, { build: 'Next time, add tests.' });
  assert.deepEqual((await manager.getWorkflowRunDetail(run.workflowRunId!)).stepNotes, { build: 'Next time, add tests.' });
});

test('a launch that fails keeps the note for the next attempt', async () => {
  const { manager, item } = await setup('Failed Launch', {
    wrap: (host) => ({ ...host, start(input) { if (input.prompt.includes('# Your step: Docs')) throw new Error('boom'); host.start(input); } }),
  });
  await manager.setStepNote(item.id, 'docs', 'Keep me.');
  const run = await settledExecute(manager)(item.id, {});
  await waitFor(async () => (await manager.getWorkflowRunDetail(run.workflowRunId!)).run.status !== 'running');
  const detail = await manager.getWorkflowRunDetail(run.workflowRunId!);
  assert.notEqual(detail.run.status, 'completed');
  assert.deepEqual(detail.stepNotes, { docs: 'Keep me.' });
});

test('a note edited after the prompt was built is not cleared, and concurrent writes do not overwrite each other', async () => {
  const { manager, item } = await setup('Edit Race', {
    wrap: (host, ref, itemId) => ({
      ...host,
      start(input) {
        if (input.prompt.includes('# Your step: Development')) {
          void ref.current!.setStepNote(itemId(), 'build', 'edited meanwhile');
          void ref.current!.setStepNote(itemId(), 'docs', 'for docs');
        }
        host.start(input);
      },
    }),
  });
  await manager.setStepNote(item.id, 'build', 'original');
  const run = await settledExecute(manager)(item.id, {});
  await waitFor(async () => (await manager.getWorkflowRunDetail(run.workflowRunId!)).run.status === 'completed');
  const { stepNotes } = await manager.getWorkflowRunDetail(run.workflowRunId!);
  assert.equal(stepNotes!.build, 'edited meanwhile');
});

test('a running step\'s note is only stored: the live session is not messaged', async () => {
  const written: string[] = [];
  const { manager, item, starts } = await setup('Running Note', {
    actions: {},
    wrap: (host) => ({ ...host, write: (...args: Parameters<TerminalSessionHost['write']>) => { written.push(String(args[1])); } }),
  });
  const run = await settledExecute(manager)(item.id, {});
  await manager.setStepNote(item.id, 'build', 'later');
  assert.equal(starts.length, 1);
  assert.deepEqual(written, []);
  assert.deepEqual((await manager.getWorkflowRunDetail(run.workflowRunId!)).stepNotes, { build: 'later' });
  await manager.stopWorkflowRun(run.workflowRunId!);
});

test('resuming a stopped run appends the note to the continue message and clears it', async () => {
  const { manager, item, starts } = await setup('Resume Note', { actions: {} });
  const run = await settledExecute(manager)(item.id, {});
  await manager.stopWorkflowRun(run.workflowRunId!);
  await manager.setStepNote(item.id, 'build', 'Mind the tests.');
  await manager.resumeWorkflowRun(run.workflowRunId!);
  assert.equal(starts.length, 2);
  assert.match(starts[1]!.prompt, /Continue\.\n\nMind the tests\.$/);
  assert.deepEqual((await manager.getWorkflowRunDetail(run.workflowRunId!)).stepNotes, {});
  await manager.stopWorkflowRun(run.workflowRunId!);
});

test('retrying a step gives its retry message the note', async () => {
  const { manager, item, starts } = await setup('Retry Note', { actions: { build: (_id, exit) => exit() } });
  const run = await settledExecute(manager)(item.id, {});
  await waitFor(async () => (await manager.getWorkflowRunDetail(run.workflowRunId!)).run.status === 'needs-attention');
  await manager.setStepNote(item.id, 'build', 'Try again, carefully.');
  await manager.retryWorkflowStep(run.workflowRunId!);
  assert.match(starts.at(-1)!.prompt, /^Your previous attempt at this step was interrupted or failed before it finished\. Continue\.\n\nTry again, carefully\.$/);
  await manager.stopWorkflowRun(run.workflowRunId!);
});

test('notes are written to the data store', async () => {
  const { manager, item } = await setup('Persisted Note');
  await manager.setStepNote(item.id, 'build', 'persist-marker-xyz');
  const { readdir, readFile } = await import('node:fs/promises');
  const dataDir = path.join(tempRoot, 'data');
  const contents: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.json')) contents.push(await readFile(full, 'utf-8'));
    }
  };
  await walk(dataDir);
  assert.ok(contents.some((text) => text.includes('persist-marker-xyz')));
});
