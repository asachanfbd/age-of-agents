import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  PLAN_DIR,
  PLAN_DOC_FILENAMES,
  PLAN_DOC_KEYS,
  PLAN_DISALLOWED_TOOLS,
  PLAN_INSTRUCTIONS,
  PLANNING_NOTES_PATH,
  InvalidPlanDocKeyError,
  buildPlanInstructions,
  readAllPlanDocs,
  readPlanDoc,
  requirePlanDocKey,
  writePlanDoc,
} from '../src/projects/plan.ts';
import { PLAN_TASK_TOOLS } from '../src/terminal/planTaskTool.ts';

let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'plan-test-'));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('readAllPlanDocs self-heals every doc when none exist yet, writing all five with readable stub content', async () => {
  const project = path.join(tempRoot, 'proj-1');

  const docs = await readAllPlanDocs(project);
  assert.equal(Object.keys(docs).length, PLAN_DOC_KEYS.length);
  for (const key of PLAN_DOC_KEYS) {
    assert.match(docs[key], /Nothing recorded yet/);
    assert.ok(await stat(path.join(project, PLAN_DIR, PLAN_DOC_FILENAMES[key])).catch(() => null), 'the self-heal actually wrote the file, not just returned it');
  }
});

test('readPlanDoc self-heals: a missing doc is stubbed in place rather than throwing', async () => {
  const project = path.join(tempRoot, 'proj-2-no-scaffold');
  const content = await readPlanDoc(project, 'specifications');
  assert.match(content, /Nothing recorded yet/);

  // The self-heal actually wrote the file — a second read sees the same content on disk.
  const onDisk = await readFile(path.join(project, PLAN_DIR, 'specifications.md'), 'utf-8');
  assert.equal(onDisk, content);
});

test('writePlanDoc overwrites a doc, and a later read sees the new content', async () => {
  const project = path.join(tempRoot, 'proj-3');
  await writePlanDoc(project, 'requirements', '# Requirements\n\nShip the login flow first.\n');

  const content = await readPlanDoc(project, 'requirements');
  assert.equal(content, '# Requirements\n\nShip the login flow first.\n');
});

test('requirePlanDocKey accepts every real key and rejects anything else', () => {
  for (const key of PLAN_DOC_KEYS) assert.equal(requirePlanDocKey(key), key);
  assert.throws(() => requirePlanDocKey('not-a-real-doc'), InvalidPlanDocKeyError);
});

test('PLAN_DISALLOWED_TOOLS denies the shell and file-editing tools — the enforcement half of PLAN_INSTRUCTIONS', () => {
  for (const tool of ['Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'NotebookEdit']) {
    assert.ok(PLAN_DISALLOWED_TOOLS.includes(tool), `${tool} must be denied`);
  }
  assert.ok(!PLAN_DISALLOWED_TOOLS.includes('Read'), 'a planning session still reads the codebase');
});

test('the planning prompt says the session is read-only and its only output is tasks', () => {
  assert.match(PLAN_INSTRUCTIONS, /read-only/);
  assert.match(PLAN_INSTRUCTIONS, /only output is the tasks/);
});

test('the planning prompt says a completed task can\'t be changed, so further work gets a new task', () => {
  assert.match(PLAN_INSTRUCTIONS, /status "done" has already been completed and can't be changed/);
  assert.match(PLAN_INSTRUCTIONS, /create a new task/);
});

test('the planning prompt carries only the session purpose and how to manage tasks', () => {
  assert.match(PLAN_INSTRUCTIONS, /PLANNING session/);
  assert.match(PLAN_INSTRUCTIONS, /research/i);
  assert.match(PLAN_INSTRUCTIONS, /questions/);
  assert.doesNotMatch(PLAN_INSTRUCTIONS, /milestone/i, 'milestone authoring is not part of a planning session');
  assert.ok(!PLAN_INSTRUCTIONS.includes(`${PLAN_DIR}${path.sep}`), 'plan docs are not part of a planning session');
  assert.doesNotMatch(PLAN_INSTRUCTIONS, /final JSON/, 'planning is CLI-only, so there is no structured result contract');
});

test('the planning prompt asks for a feature specification, not an implementation plan', () => {
  assert.match(PLAN_INSTRUCTIONS, /feature SPECIFICATION — not an implementation plan/);
  assert.match(PLAN_INSTRUCTIONS, /WHAT should happen and WHY/);
  for (const part of [/problem and the goal/, /user-visible behaviour and flows/, /rules and states/, /every decision made with the user/, /edge cases and error cases/, /in scope and what isn't/, /acceptance criteria/]) {
    assert.match(PLAN_INSTRUCTIONS, part);
  }
  assert.match(PLAN_INSTRUCTIONS, /Do NOT prescribe the implementation: no file paths, no function, component or module names, no data structures, no code snippets, and no step-by-step coding instructions/);
  assert.match(PLAN_INSTRUCTIONS, /Naming existing product concepts and user-facing features is fine/);
  assert.doesNotMatch(PLAN_INSTRUCTIONS, /files or areas involved/, 'the old wording asked for file paths');
});

test('the planning prompt asks for one task per feature, never split into implementation steps', () => {
  assert.match(PLAN_INSTRUCTIONS, /ONE TASK PER FEATURE/);
  assert.match(PLAN_INSTRUCTIONS, /backend, frontend, UI, tests and docs — goes into a single task/);
  assert.match(PLAN_INSTRUCTIONS, /Never split a feature into separate implementation steps/);
  assert.match(PLAN_INSTRUCTIONS, /genuinely different features/);
  assert.match(PLAN_INSTRUCTIONS, /in the order they should run/);
});

test('the planning prompt asks the user questions with a recommended option instead of guessing', () => {
  assert.match(PLAN_INSTRUCTIONS, /Ask as many questions as it takes to remove every ambiguity/);
  assert.match(PLAN_INSTRUCTIONS, /recommended option/);
  assert.match(PLAN_INSTRUCTIONS, /Don't guess what the user can simply answer/);
});

test('the planning prompt makes every task self-contained for a coding agent that never sees the conversation', () => {
  assert.match(PLAN_INSTRUCTIONS, /sees only that task's title and description, never this conversation/);
  assert.match(PLAN_INSTRUCTIONS, /self-contained/);
});

test('the planning prompt names every task-management tool the session is given', () => {
  for (const tool of Object.values(PLAN_TASK_TOOLS)) assert.ok(PLAN_INSTRUCTIONS.includes(`\`${tool}\``), tool);
});

test('buildPlanInstructions folds in the resolved Workflow\'s step list', () => {
  const workflow = {
    name: 'Software Development',
    steps: [
      { id: 'ui', name: 'UI Planning' } as never,
      { id: 'build', name: 'Development' } as never,
    ],
  };
  const instructions = buildPlanInstructions(workflow);
  assert.match(instructions, /PLANNING session/, 'still carries the base PLAN_INSTRUCTIONS');
  assert.match(instructions, /"Software Development" workflow/);
  assert.match(instructions, /UI Planning → Development/);
});

test('buildPlanInstructions is just PLAN_INSTRUCTIONS for a Workflow with no steps', () => {
  const instructions = buildPlanInstructions({ name: 'Empty', steps: [] });
  assert.equal(instructions, PLAN_INSTRUCTIONS);
});

test('every planning session is told to read the project\'s agent-authored planning notes first', () => {
  assert.equal(PLANNING_NOTES_PATH, path.join('.docs', 'planning-notes.md'));
  assert.ok(PLAN_INSTRUCTIONS.includes(`first read ${PLANNING_NOTES_PATH} if it exists`));
  const withWorkflow = buildPlanInstructions({ name: 'Flow', steps: [] });
  assert.ok(withWorkflow.includes(PLANNING_NOTES_PATH), 'the workflow-resolved planning prompt carries it too');
});
