import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { WorkflowRecord, WorkflowStep } from '../src/domain/types.ts';

/**
 * Task 38.003: the shipped Software Development workflow's UI Planning, Test Case Planning and
 * Development instructions. UI Planning's summary must carry a changes list, an Owner decisions
 * section and its differences from the spec; Test Case Planning is told where its inputs live;
 * Development treats owner decisions as binding. None of them may forbid asking the owner.
 */

const CATALOG = path.resolve(import.meta.dirname, '..', '..', 'catalog');
const WORKFLOW_FILE = path.join(CATALOG, 'workflows', 'software-development.json');

let workflow: WorkflowRecord;
let tempRoot: string;
const step = (id: string): WorkflowStep => workflow.steps.find((s) => s.id === id)!;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

before(async () => {
  workflow = JSON.parse(await readFile(WORKFLOW_FILE, 'utf8')) as WorkflowRecord;
  tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-instructions-test-'));
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  await cp(CATALOG, process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Text that a previous retro wrote into the live Catalog and the owner chose to ship (decision D1). */
const PLANNING_NOTES_PARAGRAPH = "If a decision you make in this step adds a file, contract or table write the brief did not cover (for example a new request field the website must send), read the project's `.docs/planning-notes.md` and apply its rules to the added scope, such as cache-busting, site-testing or deploy rules. List the added files and the rules you applied in your summary, so Development and Code Review check them too.";
const UI_INLINE_OUTPUTS = 'You never write files in this step. Each mockup IS a string you pass in complete_step\'s outputs[].content (format "html"); a read-only step can always do this. A summary without outputs is an incomplete step, so check outputs is filled before calling complete_step.';
const UI_SUMMARY_CONTRACT = "Later steps may not be able to open your HTML files (they are saved outside the task's worktree), so your summary is the contract: quote in full every binding detail of each mockup, meaning all visible wording for every state, control types, sizes and breakpoints, and each open decision with your recommendation.";
const DEV_DEPENDENCIES = "Before writing or changing tests, make sure each package you touch has its dependencies installed (for Node, check that `node_modules/.bin` exists; if it doesn't, run `npm ci --include=dev`, since the shell may have `NODE_ENV=production`). Run every test you added or changed and confirm it passes against the real output. If a test can't run in this environment, say so in your summary, list those cases as unverified, and don't count them as passing.";

test('WF01 WF02 UI Planning lists every change to the existing UI and keeps the rest as it is today', () => {
  const text = step('ui-planning').instructions;
  assert.match(text, /Compare your mockups with the existing product/);
  assert.match(text, /under a "Changes to existing UI" heading, every change to existing wording, labels, states or behaviour, each with its reason/);
  assert.match(text, /Anything the task specification does not call for keeps today's text and behaviour/);
});

test('WF03 UI Planning records an Owner decisions section', () => {
  assert.match(step('ui-planning').instructions, /an "Owner decisions" section to your summary that lists every decision the owner took during the UI review: each answer they gave and each change they requested/);
});

test('WF04 UI Planning states its differences from the spec, and the spec wins', () => {
  const text = step('ui-planning').instructions;
  assert.match(text, /differs from the planning session's task specification anywhere, list each difference under a "Differences from the specification" heading/);
  assert.match(text, /The planning specification wins in that case/);
});

test('WF05 UI Planning keeps its existing paragraphs', () => {
  const text = step('ui-planning').instructions;
  assert.ok(text.startsWith('Classify the design tier with the `ui-design` skill first, and read only the reference files it names. Plan the UI for this task.'));
  assert.match(text, /If the task has no UI surface at all, call skip_step with a short reason instead of producing mockups\./);
  assert.match(text, /never rely on the `hidden` attribute/);
  assert.match(text, /On a revision round, list in your summary every change from the previous round's mockups/);
  assert.match(text, /Before designing a revision round, read every earlier round's reviewer decision/);
});

test('WF06 UI Planning carries the live Catalog passages word for word', () => {
  const text = step('ui-planning').instructions;
  for (const passage of [UI_INLINE_OUTPUTS, UI_SUMMARY_CONTRACT, PLANNING_NOTES_PARAGRAPH]) assert.ok(text.includes(passage), passage.slice(0, 60));
});

test('WF07 WF08 WF09 WF10 Test Case Planning is told its sources of truth and where each input lives', () => {
  const text = step('test-case-planning').instructions;
  assert.match(text, /Your sources of truth are the task specification, the UI Planning summary \(its "Changes to existing UI" list and its "Owner decisions" section\) and the project docs/);
  assert.match(text, /Owner decisions in the UI Planning summary are the owner's own decisions from the UI review, so follow them/);
  assert.match(text, /Where the UI Planning design differs from the task specification, the specification wins, unless an Owner decision in the UI Planning summary says otherwise\./);
  assert.match(text, /The specification already states the testing expectations[^:]+, the finalised contracts and schemas[^:]+ and the environment and baseline: look for each in the specification's own sections and acceptance criteria, and for the baseline also in `\.docs\/testing\.md`'s known gaps/);
});

test('WF11 Test Case Planning keeps its ability to ask, planningGap, and its numbered checklist', () => {
  const text = step('test-case-planning').instructions;
  assert.match(text, /ask the person in this session/);
  assert.match(text, /planningGap/);
  assert.match(text, /Before listing cases, check the baseline for every acceptance criterion/);
  assert.match(text, /Open the final approved UI Planning mockups themselves[\s\S]*ask the person in this session which one stands/);
  for (let n = 1; n <= 7; n += 1) assert.ok(text.includes(`(${n}) `), `item (${n})`);
  assert.equal(sha256(text.slice(text.indexOf('Before completing: (1)'), text.indexOf('\n\n', text.indexOf('Before completing: (1)')))),
    sha256('Before completing: (1) Count the case ids in your tables and state those totals; never estimate them. (2) For every input field, name cases for values of the right type that are out of range: a number wider than its storage, the earliest and latest date, text over the length limit, and alternative spellings the parser accepts. (3) Say which behaviours the project\'s test environment cannot prove (real simultaneity, row locks, a service that is stubbed) and name the manual check for each. (4) If the choices you had to assume shape a contract another repository consumes, or a database schema, ask the person directly in this session before completing. Ask about all such choices in one batch, not only the ones you judge most important; listing them in planningGap alone lets Development build on unconfirmed assumptions. When you ask the person to accept defaults, put each default\'s text in the question itself. An answer like \'accept the rest\' covers only the defaults you showed. (5) For every case that expects a refusal, name the stated limit or rule that refuses the input. If the spec fixes no such limit, or leaves the input\'s form open (a date or a duration, which unit), settle that first or drop the case. (6) When a case says a response or log "is searched for" a private value, say the search is for the value itself, including inside any URL or key the response carries, not for a field name. List every response field derived from a storage key or internal id. (7) For each race case, when the test environment cannot run two writers at once, name the point in the code where the test forces the competing write.'),
    'the numbered before-completing list is unchanged');
});

test('WF12 Test Case Planning carries the live planning-notes paragraph word for word', () => {
  assert.ok(step('test-case-planning').instructions.includes(PLANNING_NOTES_PARAGRAPH));
});

test('WF13 WF14 Development treats owner decisions as binding and keeps its existing paragraphs', () => {
  const text = step('development').instructions;
  assert.match(text, /Owner decisions listed in the UI Planning summary are binding/);
  assert.match(text, /Where the UI Planning design differs from the task specification, follow the specification, unless an Owner decision in the UI Planning summary says otherwise/);
  assert.ok(text.includes(DEV_DEPENDENCIES));
  assert.ok(text.startsWith('Implement the task, including the tests planned in Test Case Planning.'));
  assert.match(text, /Before calling complete_step, check your actual test changes against the Test Case Planning step's own list of named cases, one by one/);
  assert.match(text, /When you rewrite an existing spec or doc section, change only what the task supersedes/);
});

test('WF15 no edited step forbids asking the owner or tells it to guess', () => {
  for (const id of ['ui-planning', 'test-case-planning', 'development']) {
    const text = step(id).instructions;
    for (const banned of [/(do not|don't|never|without) ask/i, /stop asking/i, /guess/i]) assert.doesNotMatch(text, banned, `${id}: ${banned.source}`);
  }
});

test('WF16 Docs & Retro instructions are unchanged', () => {
  assert.equal(sha256(step('docs-and-retro').instructions), '54f84108e286e6f17da6bc97738aee21954cd77ef40a1f69d5caaec5be0f6f93');
});

test('WF16b Code Review runs commands read-only and verifies the change itself', () => {
  const review = step('code-review');
  assert.equal(review.canRunCommands, true);
  assert.equal(review.canEditCode, false);
  const text = review.instructions;
  assert.match(text, /registered test suites yourself/);
  assert.match(text, /agent_visual_os_tests/);
  assert.match(text, /\.docs\/testing\.md/);
  assert.match(text, /lint, type-check or build/);
  assert.match(text, /node_modules\/\.bin/);
  assert.match(text, /npm ci --include=dev/);
  assert.match(text, /NODE_ENV=production/);
  assert.match(text, /compare them with the counts the Development step claimed/);
  assert.match(text, /missing from the diff is an item in an "issues" verdict/);
  assert.match(text, /exercise the named Test Case Planning cases/);
  assert.match(text, /Do not use commands to edit source files/);
  assert.match(text, /not committed by this step/);
  assert.match(text, /unverified rather than passing/);
  assert.match(text, /git log/);
  assert.match(text, /git show/);
  assert.match(text, /diff_summary/);
  assert.match(text, /verdict "pass"/);
  assert.doesNotMatch(text, /may have no shell/);
  assert.doesNotMatch(text, /did not run the tests/);
  assert.equal(review.canUseBrowser, true);
  assert.match(text, /verify the changed UI in the browser/);
  assert.match(text, /approved UI Planning mockups/);
  assert.match(text, /"Owner decisions" and "Changes to existing UI"/);
  assert.match(text, /issues" verdict, naming the screen, the state and what differs/);
  assert.match(text, /report the browser checks as unverified/);
});

test('WF16d only Code Review in the shipped workflows has the browser', async () => {
  const bugFix = JSON.parse(await readFile(new URL('../../catalog/workflows/bug-fix.json', import.meta.url), 'utf8')) as WorkflowRecord;
  const withBrowser = [...workflow.steps, ...bugFix.steps].filter((s) => s.canUseBrowser).map((s) => s.id);
  assert.deepEqual(withBrowser, ['code-review']);
});

test('WF16c Bugfix Review runs commands read-only and verifies the fix itself', async () => {
  const bugFix = JSON.parse(await readFile(new URL('../../catalog/workflows/bug-fix.json', import.meta.url), 'utf8')) as WorkflowRecord;
  const byId = (id: string) => bugFix.steps.find((s) => s.id === id)!;
  const review = byId('bugfix-review');
  assert.equal(review.canRunCommands, true);
  assert.equal(review.canEditCode, false);
  assert.match(review.instructions, /registered test suites yourself/);
  assert.match(review.instructions, /Do not use commands to edit source files/);
  assert.doesNotMatch(review.instructions, /no shell/);
  assert.equal(byId('rca-review').canRunCommands, false);
});

test('WF17 every step field except instructions is unchanged', () => {
  const structure = workflow.steps.map(({ instructions: _instructions, ...rest }) => rest);
  assert.deepEqual(structure, [
    { agentId: 'software-engineer', id: 'ui-planning', skillIds: ['ui-design'], preloadSkillIds: ['ui-design'], name: 'UI Planning', canEditCode: false, canRunCommands: false, requiresApproval: true, requiredOutputFormat: 'html', quickLook: 'none' },
    { agentId: 'software-engineer', id: 'test-case-planning', name: 'Test Case Planning', canEditCode: false, canRunCommands: true, requiresApproval: false, quickLook: 'none' },
    { agentId: 'software-engineer', id: 'development', name: 'Development', canEditCode: true, canRunCommands: false, requiresApproval: false, quickLook: 'code' },
    { agentId: 'software-engineer', id: 'code-review', name: 'Code Review', canEditCode: false, canRunCommands: true, canUseBrowser: true, requiresApproval: false, quickLook: 'diff', loopBack: { toStepId: 'development', maxRounds: 3 } },
    { agentId: 'documentation-n-retro-agent', skillIds: ['maintain-project-context'], preloadSkillIds: ['maintain-project-context'], id: 'docs-and-retro', name: 'Docs & Retro', canEditCode: true, canRunCommands: false, requiresApproval: false, quickLook: 'documents' },
  ]);
  assert.equal(workflow.id, 'software-development');
  assert.equal(workflow.enabled, true);
});

test('WF18 the file is valid JSON and every step has instructions', async () => {
  const parsed = JSON.parse(await readFile(WORKFLOW_FILE, 'utf8')) as WorkflowRecord;
  for (const s of parsed.steps) assert.ok(s.instructions.trim().length > 0, s.id);
});

test('IT01 the shipped workflow validates and round-trips through the Catalog service', async () => {
  const { getWorkflow, updateWorkflow } = await import('../src/catalog/workflowService.ts');
  const saved = await updateWorkflow('software-development', { name: workflow.name, description: workflow.description, steps: workflow.steps });
  assert.deepEqual(saved.steps, workflow.steps);
  assert.deepEqual((await getWorkflow('software-development'))?.steps, workflow.steps, 'the stored file reads back unchanged');
});

test('IT05 step prompts built from the shipped workflow carry the new instructions', async () => {
  const { buildStepPrompt } = await import('../src/worker/workflowPrompt.ts');
  const prompt = (id: string) => buildStepPrompt({
    taskTitle: 'Add CSV export', taskDescription: 'Spec', stepName: step(id).name, instructions: step(id).instructions,
    canEditCode: step(id).canEditCode, requiresVerdict: false, history: [],
  });
  assert.match(prompt('test-case-planning'), /Your sources of truth are the task specification, the UI Planning summary/);
  assert.match(prompt('development'), /Owner decisions listed in the UI Planning summary are binding/);
});

test('B036 UI Planning requires an HTML mockup and no longer hedges about writing files', () => {
  const ui = step('ui-planning');
  assert.equal(ui.requiredOutputFormat, 'html');
  assert.ok(!ui.instructions.includes('If this step cannot write files'));
  assert.ok(ui.instructions.includes('You never write files in this step.'));
  for (const other of workflow.steps.filter((s) => s.id !== 'ui-planning')) assert.equal(other.requiredOutputFormat, undefined, other.id);
});
