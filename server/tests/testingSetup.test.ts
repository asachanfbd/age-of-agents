import assert from 'node:assert/strict';
import { settledEnqueue, settledExecute, settledSetup } from './helpers/startRun.ts';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { TestRunRecord } from '../src/domain/types.ts';
import type { TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import type { TestingConfigState } from '../src/testing/types.ts';
import { autoAdvanceTerminalSteps, type StepAction } from './helpers/terminalStepFakes.ts';
import { referencedContents } from './helpers/stepOutputRefs.ts';

/**
 * Task 2.005: the approval-gated testing setup. Unit coverage for testing/setup.ts's pure pieces,
 * then the whole flow driven through the real workflow engine with a scripted fake terminal host
 * (no real `claude`/`codex` process) on repository-less Projects. testingSetupGit.test.ts covers the
 * real-git zero-write checks; testingSetupApi.test.ts the REST routes.
 */

let tempRoot: string;
let setup: typeof import('../src/testing/setup.ts');
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let collections: typeof import('../src/db/collections.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');
let testingConfig: typeof import('../src/testing/config.ts');
let defaultExecutorStore: typeof import('../src/executors/defaultExecutorInstance.ts')['defaultExecutorStore'];

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'testing-setup-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  setup = await import('../src/testing/setup.ts');
  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  collections = await import('../src/db/collections.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
  testingConfig = await import('../src/testing/config.ts');
  ({ defaultExecutorStore } = await import('../src/executors/defaultExecutorInstance.ts'));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ---- Fixtures ----

const VALID_CONFIG = {
  schemaVersion: 1,
  suites: [
    {
      id: 'unit',
      label: 'Unit',
      kind: 'unit',
      primaryActionId: 'run',
      actions: [
        { id: 'run', label: 'Run unit tests', command: 'npm test', collectors: [{ id: 'cases', format: 'junit-xml', path: 'junit.xml' }] },
        { id: 'snapshots', label: 'Update snapshots', purpose: 'utility', command: 'npm test -- -u' },
      ],
    },
    {
      id: 'e2e',
      label: 'Browser',
      kind: 'e2e',
      enabled: false,
      primaryActionId: 'run',
      actions: [{ id: 'run', label: 'Run e2e', command: 'npx playwright test', collectors: [{ id: 'cases', format: 'junit-xml', path: 'e2e.xml' }] }],
    },
  ],
};

const PROPOSAL = [{ name: 'Testing setup proposal', format: 'markdown' as const, content: '# Proposal\n\nAdd a junit reporter to vitest and write config.json.' }];
const ZERO_FINDINGS = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

/** A valid config state as the loader produces it (defaults such as `enabled: true` filled in). */
function validState(config: unknown = VALID_CONFIG): TestingConfigState {
  const parsed = testingConfig.validateTestingConfig(config);
  if (!parsed.ok) throw new Error(`fixture config is invalid: ${JSON.stringify(parsed.issues)}`);
  return { state: 'valid', path: '.docs/testing/config.json', config: parsed.config };
}

function testRun(overrides: Partial<TestRunRecord> = {}): TestRunRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId: 'p',
    batchId: null,
    suite: { id: 'unit', label: 'Unit', kind: 'unit' },
    action: { id: 'run', label: 'Run unit tests', purpose: 'result', command: 'npm test', workingDirectory: '.', collectors: [] },
    trigger: 'agent',
    taskId: 't',
    executionRoot: '/x',
    cwd: '/x',
    branch: null,
    commit: null,
    status: 'passed',
    exitCode: 0,
    queuedAt: now,
    startedAt: now,
    completedAt: now,
    durationMs: 10,
    outputTruncated: false,
    summary: { outcome: 'passed', counts: { total: 3, passed: 3 }, metrics: [], findingCounts: ZERO_FINDINGS },
    diagnostics: [],
    artifactDir: null,
    ...overrides,
  };
}

async function writeConfig(dir: string, config: unknown): Promise<void> {
  await mkdir(path.join(dir, '.docs', 'testing'), { recursive: true });
  await writeFile(path.join(dir, '.docs', 'testing', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Manager = ReturnType<typeof import('../src/worker/workerManager.ts').createWorkerManager>;

/** A manager whose step sessions run `actions[stepId]` (mutable, so a test can script each phase) and record every spawn. */
function scriptedManager(actions: Record<string, StepAction> = {}) {
  const ref: { current?: Manager } = {};
  const { host, starts } = autoAdvanceTerminalSteps(ref, actions);
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: host, listExecutors: async () => [] });
  ref.current = manager;
  return { manager, starts, actions };
}

async function newProject(name: string) {
  return projectService.createProject({ name, position: null });
}

async function runDetail(manager: Manager, runId: string) {
  return manager.getWorkflowRunDetail(runId);
}

async function waitForStatus(manager: Manager, runId: string, status: string): Promise<void> {
  await waitUntil(async () => (await runDetail(manager, runId)).run.status === status);
}

function startsForStep(manager: Manager, starts: TerminalSessionStart[], stepId: string) {
  return Promise.all(starts.map(async (start) => ({ start, task: await manager.getTask(start.taskId) })))
    .then((all) => all.filter(({ task }) => task.workflowStepId === stepId).map(({ start }) => start));
}

function assertReadOnly(start: TerminalSessionStart | undefined, label: string) {
  assert.ok(start, `${label}: session started`);
  assert.equal(start.readOnly, true, `${label}: readOnly`);
  assert.ok(start.disallowedTools?.includes('Write') && start.disallowedTools.includes('Edit') && start.disallowedTools.includes('Bash'), `${label}: write tools denied`);
  assert.ok(!start.mcpServers?.some((server) => server.name === 'agent_visual_os_tests'), `${label}: no test tools`);
}

function assertWritable(start: TerminalSessionStart | undefined, label: string) {
  assert.ok(start, `${label}: session started`);
  assert.equal(start.readOnly, false, `${label}: not readOnly`);
  assert.equal(start.disallowedTools, undefined, `${label}: no denied tools`);
  assert.ok(start.mcpServers?.some((server) => server.name === 'agent_visual_os_tests'), `${label}: has test tools`);
}

/** Starts a setup and waits for its first proposal round to be awaiting approval. */
async function setupAtGate(name: string, executorId?: string) {
  const project = await newProject(name);
  const { manager, starts, actions } = scriptedManager({
    proposal: (taskId) => manager.completeStep(taskId, { summary: 'Proposed a vitest setup.', outputs: PROPOSAL }),
  });
  const result = await settledSetup(manager)(project.id, { executorId });
  const runId = result.run!.id;
  await waitForStatus(manager, runId, 'awaiting-approval');
  await waitUntil(async () => (await planItemService.getPlanItem(result.planItem.id)).status === 'blocked');
  return { project, manager, starts, actions, runId, planItemId: result.planItem.id };
}

// ---- testing/setup.ts: the workflow and its invariants ----

test('the built-in setup workflow gates writes: a read-only proposal step that needs approval, then a write-capable step', () => {
  const workflow = setup.testingSetupWorkflow();
  assert.equal(workflow.id, setup.TESTING_SETUP_WORKFLOW_ID);
  const [proposal, implementation] = workflow.steps;
  assert.equal(proposal?.id, setup.SETUP_PROPOSAL_STEP_ID);
  assert.equal(proposal?.canEditCode, false);
  assert.equal(proposal?.requiresApproval, true);
  assert.equal(implementation?.id, setup.SETUP_IMPLEMENTATION_STEP_ID);
  assert.equal(implementation?.canEditCode, true);
  assert.deepEqual(implementation?.loopBack, { toStepId: setup.SETUP_PROPOSAL_STEP_ID, maxRounds: setup.SETUP_MAX_REPROPOSALS });
  assert.doesNotThrow(() => setup.assertSetupWorkflowSafe(workflow));
  assert.notEqual(setup.testingSetupWorkflow(), workflow, 'each call is a fresh copy, so nothing can mutate the built-in');
});

test('assertSetupWorkflowSafe refuses a workflow with no gate, or a write-capable step before or at the gate', () => {
  const step = (id: string, canEditCode: boolean, requiresApproval: boolean) => ({ id, name: id, agentId: 'a', instructions: 'x', canEditCode, requiresApproval });
  assert.throws(() => setup.assertSetupWorkflowSafe({ steps: [step('a', false, false), step('b', true, false)] }), /no approval step/);
  assert.throws(() => setup.assertSetupWorkflowSafe({ steps: [step('a', true, false), step('b', false, true)] }), /step "a" can edit code/);
  assert.throws(() => setup.assertSetupWorkflowSafe({ steps: [step('a', true, true)] }), /step "a" can edit code/);
});

test('the proposal instructions demand every consequence section and forbid changes; the implementation instructions carry the approval rules', () => {
  const [proposal, implementation] = setup.testingSetupWorkflow().steps;
  for (const section of ['Detected', 'Proposed suites', 'Exact changes', 'Validation', 'Benefits', 'Consequences', 'Not automated']) {
    assert.match(proposal!.instructions, new RegExp(section));
  }
  for (const cost of ['install size', 'runtime', 'browsers/containers/services', 'credentials or environment variables', 'security or performance']) {
    assert.ok(proposal!.instructions.includes(cost), cost);
  }
  assert.match(proposal!.instructions, /must not write or delete files, install packages/);
  assert.match(proposal!.instructions, /add a test foundation .* or record that no tests are configured/);
  assert.match(proposal!.instructions, /Do not pick one yourself/);
  assert.match(implementation!.instructions, /nothing beyond it/);
  assert.match(implementation!.instructions, /Never weaken, skip, delete or rewrite existing tests/);
  assert.match(implementation!.instructions, /materially different change .* verdict "issues"/);
  assert.match(implementation!.instructions, /run_test_action or run_all_tests/);
});

test('setupModeFor and SETUP_TITLES follow the config state', () => {
  assert.equal(setup.setupModeFor({ state: 'absent', path: 'p' }), 'setup');
  assert.equal(setup.setupModeFor(validState()), 'reconfigure');
  assert.equal(setup.setupModeFor({ state: 'invalid', path: 'p', issues: [] }), 'repair');
  assert.deepEqual(setup.SETUP_TITLES, { setup: 'Set up testing', reconfigure: 'Reconfigure testing', repair: 'Repair testing' });
});

test('setupPlanItemDescription describes the config state it started from', () => {
  assert.match(setup.setupPlanItemDescription({ state: 'absent', path: 'p' }), /There is no \.docs\/testing\/config\.json yet/);
  const reconfigure = setup.setupPlanItemDescription(validState());
  assert.match(reconfigure, /stays in use until the approved change is merged/);
  assert.match(reconfigure, /- unit \(unit\): primary action "run"; actions run → `npm test`, snapshots → `npm test -- -u`/);
  assert.match(reconfigure, /- e2e \(e2e, disabled\)/);
  const repair = setup.setupPlanItemDescription({
    state: 'invalid',
    path: 'p',
    issues: [
      { code: 'missing-primary-action', path: 'suites[0].primaryActionId', message: 'names no action' },
      { code: 'malformed-json', path: '', message: 'bad json' },
    ],
  });
  assert.match(repair, /- suites\[0\]\.primaryActionId \[missing-primary-action\]: names no action/);
  assert.match(repair, /- \(document\) \[malformed-json\]: bad json/);
  for (const text of [reconfigure, repair]) assert.match(text, /Nothing may change in the project until the person approves/);
});

// ---- testing/setup.ts: evidence ----

test('evaluateSetupEvidence refuses an absent or invalid config', () => {
  const absent = setup.evaluateSetupEvidence({ state: 'absent', path: '.docs/testing/config.json' }, []);
  assert.equal(absent.ok, false);
  assert.deepEqual(absent.problems, ['No testing config at .docs/testing/config.json.']);
  const invalid = setup.evaluateSetupEvidence({ state: 'invalid', path: 'c', issues: [{ code: 'unsafe-path', path: 'suites[0].actions[0].collectors[0].path', message: 'escapes' }, { code: 'malformed-json', path: '', message: 'bad' }] }, []);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.config.state, 'invalid');
  assert.match(invalid.problems[0]!, /suites\[0\]\.actions\[0\]\.collectors\[0\]\.path: escapes; \(document\): bad/);
});

test('evaluateSetupEvidence requires a settled, result-producing agent run of every enabled primary action', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const check = (runs: TestRunRecord[]) => setup.evaluateSetupEvidence(validState(), runs, now);

  const none = check([]);
  assert.equal(none.ok, false);
  assert.deepEqual(none.actions.map((a) => `${a.suiteId}/${a.actionId}`), ['unit/run'], 'the disabled e2e suite is not required');
  assert.deepEqual(none.problems, ['unit/run was never run through the test tools.']);
  assert.equal(none.checkedAt, now.toISOString());

  assert.match(check([testRun({ status: 'running', summary: null })]).problems[0]!, /still running/);
  assert.match(check([testRun({ status: 'queued', summary: null })]).problems[0]!, /still queued/);
  assert.match(check([testRun({ status: 'error', summary: null, diagnostics: [{ code: 'artifact-missing', message: 'no junit.xml' }] })]).problems[0]!, /ended error: no junit\.xml/);
  assert.match(check([testRun({ status: 'stopped', summary: null })]).problems[0]!, /ended stopped\./);
  assert.match(check([testRun({ summary: null })]).problems[0]!, /produced no normalized result/);
  assert.match(check([testRun({ action: { ...testRun().action, id: 'snapshots', purpose: 'utility' } })]).problems[0]!, /never run/, 'a utility action is not the primary action');

  const passed = check([testRun({ id: 'r1' })]);
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.actions[0], { suiteId: 'unit', actionId: 'run', runId: 'r1', status: 'passed', counts: { total: 3, passed: 3 }, problem: null });
  assert.deepEqual(passed.config, { state: 'valid', suiteCount: 2, issues: [] });

  const failingTests = check([testRun({ status: 'failed', summary: { outcome: 'failed', counts: { total: 3, passed: 2, failed: 1 }, metrics: [], findingCounts: ZERO_FINDINGS } })]);
  assert.equal(failingTests.ok, true, 'a parsed result with failing tests still proves the action produces results');
  assert.deepEqual(failingTests.actions[0]?.counts, { total: 3, passed: 2, failed: 1 });

  const older = testRun({ id: 'old', queuedAt: '2026-09-28T09:00:00Z', status: 'error', summary: null });
  const newer = testRun({ id: 'new', queuedAt: '2026-09-28T09:30:00Z' });
  assert.equal(check([older, newer]).actions[0]?.runId, 'new', 'the latest run decides');
  assert.equal(check([newer, { ...older, queuedAt: '2026-09-28T09:45:00Z' }]).ok, false);
});

test('evaluateSetupEvidence accepts a valid config with no suites: the "record that none are configured" choice', () => {
  const evidence = setup.evaluateSetupEvidence(validState({ schemaVersion: 1, suites: [] }), []);
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.actions, []);
  assert.equal(evidence.config.suiteCount, 0);
});

// ---- Starting, finding and deduping ----

test('start with no config creates one "Set up testing" Open Task and runs it through the setup workflow, not the Project default', async () => {
  const project = await newProject('Setup Absent');
  const { manager } = scriptedManager();
  const events: string[] = [];
  manager.onWorkerEvent((event) => events.push(event.type));
  const result = await settledSetup(manager)(project.id);

  assert.equal(result.existing, false);
  assert.equal(result.planItem.title, 'Set up testing');
  assert.deepEqual(result.planItem.testingSetup, { mode: 'setup' });
  assert.equal(result.planItem.status, 'developing');
  assert.equal(result.queueEntry, null);
  assert.equal(result.run?.workflowId, setup.TESTING_SETUP_WORKFLOW_ID);
  assert.deepEqual(result.run?.testingSetup, { mode: 'setup', evidence: null });
  assert.equal(result.run?.currentStepId, setup.SETUP_PROPOSAL_STEP_ID);
  assert.deepEqual(result.run?.workflowSnapshot.steps.map((s) => s.id), [setup.SETUP_PROPOSAL_STEP_ID, setup.SETUP_IMPLEMENTATION_STEP_ID]);
  for (const type of ['planItem', 'workflowRun', 'stepRun', 'task']) assert.ok(events.includes(type), `emits ${type}`);
  assert.ok(events.every((type) => ['planItem', 'workflowRun', 'stepRun', 'task', 'project', 'log', 'planItemQueue'].includes(type)), 'only ordinary events');

  const found = await manager.getTestingSetup(project.id);
  assert.equal(found?.active, true);
  assert.equal(found?.planItem.id, result.planItem.id);
  assert.equal(found?.run?.id, result.run?.id);
  await manager.stopWorkflowRun(result.run!.id);
});

test('a second start while one is active returns it, and two simultaneous starts create exactly one', async () => {
  const project = await newProject('Setup Dedupe');
  const { manager } = scriptedManager();
  const [a, b] = await Promise.all([settledSetup(manager)(project.id), settledSetup(manager)(project.id)]);
  assert.equal(a.planItem.id, b.planItem.id);
  assert.deepEqual([a.existing, b.existing].sort(), [false, true]);
  const again = await settledSetup(manager)(project.id);
  assert.equal(again.existing, true);
  assert.equal(again.run?.id, a.run?.id);
  assert.equal((await planItemService.listPlanItems(project.id)).filter((item) => item.testingSetup).length, 1);
  assert.equal((await manager.listWorkflowRunsForProject(project.id)).length, 1);
  await manager.stopWorkflowRun(a.run!.id);
});

test('an active setup in one Project does not block another Project', async () => {
  const [p1, p2] = [await newProject('Setup Scope A'), await newProject('Setup Scope B')];
  const { manager } = scriptedManager();
  const first = await settledSetup(manager)(p1.id);
  const second = await settledSetup(manager)(p2.id);
  assert.equal(second.existing, false);
  assert.notEqual(first.planItem.id, second.planItem.id);
  await manager.stopWorkflowRun(first.run!.id);
  await manager.stopWorkflowRun(second.run!.id);
});

test('a needs-attention setup is still the active one, so a click returns it instead of stacking a second', async () => {
  const project = await newProject('Setup Attention Dedupe');
  const { manager } = scriptedManager({ proposal: (_taskId, exit) => exit() });
  const first = await settledSetup(manager)(project.id);
  await waitForStatus(manager, first.run!.id, 'needs-attention');
  const again = await settledSetup(manager)(project.id);
  assert.equal(again.existing, true);
  assert.equal(again.planItem.id, first.planItem.id);
  await manager.stopWorkflowRun(first.run!.id);
});

test('an unknown executor or project is refused and leaves no Open Task behind', async () => {
  const project = await newProject('Setup Bad Executor');
  const { manager } = scriptedManager();
  await assert.rejects(settledSetup(manager)(project.id, { executorId: 'nope' }), (error: Error) => error.name === 'ExecutorNotFoundError');
  assert.deepEqual(await planItemService.listPlanItems(project.id), []);
  await assert.rejects(settledSetup(manager)('no-such-project'), (error: Error) => error.name === 'ProjectNotFoundError');
  await assert.rejects(manager.getTestingSetup('no-such-project'), (error: Error) => error.name === 'ProjectNotFoundError');
  assert.equal(await manager.getTestingSetup(project.id), null);
});

test('a start that fails after creating its item removes the item again', async () => {
  const project = await newProject('Setup Unsupported Executor');
  const { manager } = scriptedManager();
  await assert.rejects(settledSetup(manager)(project.id, { executorId: 'test-unsupported' }), (error: Error) => error.name === 'ExecutorNotSupportedError');
  assert.deepEqual(await planItemService.listPlanItems(project.id), []);
});

test('reconfigure: a valid config gives "Reconfigure testing" whose task text lists the current suites, and the config is untouched through the proposal', async () => {
  const project = await newProject('Setup Reconfigure');
  const dir = projectService.projectAbsolutePath(project);
  await writeConfig(dir, VALID_CONFIG);
  const before = await readFile(path.join(dir, '.docs/testing/config.json'), 'utf8');
  const { manager, starts } = scriptedManager({ proposal: (taskId) => manager.completeStep(taskId, { summary: 's', outputs: PROPOSAL }) });
  const result = await settledSetup(manager)(project.id);
  assert.equal(result.planItem.title, 'Reconfigure testing');
  assert.deepEqual(result.planItem.testingSetup, { mode: 'reconfigure' });
  assert.equal(result.run?.testingSetup?.mode, 'reconfigure');
  assert.match(starts[0]!.prompt, /unit \(unit\): primary action "run"/);
  await waitForStatus(manager, result.run!.id, 'awaiting-approval');
  assert.equal(await readFile(path.join(dir, '.docs/testing/config.json'), 'utf8'), before);
  await manager.stopWorkflowRun(result.run!.id);
  assert.equal(await readFile(path.join(dir, '.docs/testing/config.json'), 'utf8'), before, 'rejected: the existing config is unchanged');
});

test('repair: an invalid config gives "Repair testing" and the proposal prompt carries its issues', async () => {
  const project = await newProject('Setup Repair');
  await writeConfig(projectService.projectAbsolutePath(project), { schemaVersion: 1, suites: [{ id: 'unit', label: 'Unit', kind: 'unit', primaryActionId: 'missing', actions: [{ id: 'run', label: 'Run', command: 'npm test' }] }] });
  const { manager, starts } = scriptedManager();
  const result = await settledSetup(manager)(project.id);
  assert.equal(result.planItem.title, 'Repair testing');
  assert.deepEqual(result.planItem.testingSetup, { mode: 'repair' });
  assert.match(starts[0]!.prompt, /suites\[0\]\.primaryActionId \[missing-primary-action\]/);
  await manager.stopWorkflowRun(result.run!.id);
});

// ---- Bug 19.001.001: a run with no agent choice uses the owner's selected default ----

const AGENT_A = 'test-claude-cli';
const AGENT_B = 'test-claude-cli-alt';

/** Runs `fn` with `executorId` stored as the owner's default coding agent, clearing it afterwards. */
async function withStoredDefault<T>(executorId: string, fn: () => Promise<T>): Promise<T> {
  await defaultExecutorStore.set({ executorId, label: executorId });
  try {
    return await fn();
  } finally {
    await defaultExecutorStore.clear();
  }
}

const SETUP_MODES: { mode: string; prepare: (dir: string) => Promise<void> }[] = [
  { mode: 'setup', prepare: async () => {} },
  { mode: 'reconfigure', prepare: (dir) => writeConfig(dir, VALID_CONFIG) },
  { mode: 'repair', prepare: (dir) => writeConfig(dir, { schemaVersion: 1, suites: 'broken' }) },
];

for (const { mode, prepare } of SETUP_MODES) {
  test(`${mode}: with no agent chosen, testing setup starts on the selected default agent, not the first configured one`, async () => {
    const project = await newProject(`Setup Default ${mode}`);
    await prepare(projectService.projectAbsolutePath(project));
    const { manager, starts } = scriptedManager();
    await withStoredDefault(AGENT_B, async () => {
      const result = await settledSetup(manager)(project.id);
      assert.equal(result.planItem.testingSetup?.mode, mode);
      assert.equal(result.run?.executorId, AGENT_B);
      assert.equal((await manager.getTask(starts[0]!.taskId)).executorId, AGENT_B, 'its step task runs on the default too');
      await manager.stopWorkflowRun(result.run!.id);
    });
  });
}

test('an explicit agent in the testing-setup request still wins over the selected default', async () => {
  const project = await newProject('Setup Explicit Agent');
  const { manager } = scriptedManager();
  await withStoredDefault(AGENT_B, async () => {
    const result = await settledSetup(manager)(project.id, { executorId: AGENT_A });
    assert.equal(result.run?.executorId, AGENT_A);
    await manager.stopWorkflowRun(result.run!.id);
  });
});

test('a stored default that was removed falls back to the first configured CLI agent without failing the start', async () => {
  const project = await newProject('Setup Removed Default');
  const { manager } = scriptedManager();
  await withStoredDefault('agent-that-was-removed', async () => {
    const result = await settledSetup(manager)(project.id);
    assert.equal(result.run?.executorId, AGENT_A);
    await manager.stopWorkflowRun(result.run!.id);
  });
});

test('with no default stored, testing setup starts on the first configured CLI agent', async () => {
  const project = await newProject('Setup No Default');
  const { manager } = scriptedManager();
  const result = await settledSetup(manager)(project.id);
  assert.equal(result.run?.executorId, AGENT_A);
  await manager.stopWorkflowRun(result.run!.id);
});

test('a later step whose run agent was removed falls back to the selected default agent', async () => {
  const { manager, starts, runId } = await setupAtGate('Setup Step Fallback');
  assert.equal((await manager.getWorkflowRun(runId))?.executorId, AGENT_A);
  await collections.workflowRunsDb.update(runId, { executorId: 'agent-that-was-removed' });
  await withStoredDefault(AGENT_B, async () => {
    await manager.approveTestingSetup(runId, 1);
    await waitUntil(async () => (await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID)).length === 1);
    const [implementation] = await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID);
    assert.equal((await manager.getTask(implementation!.taskId)).executorId, AGENT_B);
    await manager.stopWorkflowRun(runId);
  });
});

test('a queued testing setup uses the default in force when it actually starts', async () => {
  const project = await newProject('Setup Queued Default');
  const { manager, starts, actions } = scriptedManager();
  const busy = await planItemService.createPlanItem({ projectId: project.id, title: 'Busy work', description: 'x' });
  await settledExecute(manager)(busy.id);
  const result = await settledSetup(manager)(project.id);
  assert.ok(result.queueEntry, 'the setup queued behind the busy item');
  assert.equal(result.queueEntry.executorId ?? undefined, undefined, 'the queue entry pins no agent');

  await withStoredDefault(AGENT_B, async () => {
    actions.development = (taskId) => manager.completeStep(taskId, { summary: 'done' });
    const busyTask = (await manager.listTasksForProject(project.id)).find((t) => t.planItemId === busy.id)!;
    await manager.completeStep(busyTask.id, { summary: 'done' });
    await waitUntil(async () => (await startsForStep(manager, starts, setup.SETUP_PROPOSAL_STEP_ID)).length === 1);
    const runId = (await planItemService.getPlanItem(result.planItem.id)).workflowRunId!;
    assert.equal((await manager.getWorkflowRun(runId))?.executorId, AGENT_B);
    await manager.stopWorkflowRun(runId);
  });
});

// ---- Read-only discovery, for both executor families ----

for (const executorId of ['test-claude-cli', 'test-codex-cli']) {
  test(`${executorId}: discovery is read-only with no test tools even though the agent defaults to Auto, and only an explicit approval unlocks writes`, async () => {
    const { manager, starts, actions, runId } = await setupAtGate(`Setup Gate ${executorId}`, executorId);
    const [proposalStart] = await startsForStep(manager, starts, setup.SETUP_PROPOSAL_STEP_ID);
    assertReadOnly(proposalStart, 'proposal');
    assert.equal(proposalStart!.kind, executorId === 'test-codex-cli' ? 'codex-cli' : 'claude-cli');
    assert.equal(proposalStart!.autonomy, 'auto', 'the executor keeps its normal autonomy; the session is still read-only');
    assert.match(proposalStart!.prompt, /This step is READ-ONLY/);
    assert.doesNotMatch(proposalStart!.prompt, /Call `skip_step` with a `reason`/, 'the prompt never offers a skip the server would refuse');

    // Feedback: a second round, still read-only, carrying the comment.
    await manager.requestChangesWorkflowRun(runId, "Don't add Playwright yet.");
    await waitForStatus(manager, runId, 'awaiting-approval');
    const proposalStarts = await startsForStep(manager, starts, setup.SETUP_PROPOSAL_STEP_ID);
    assert.equal(proposalStarts.length, 2);
    assertReadOnly(proposalStarts[1], 'proposal round 2');
    assert.match(proposalStarts[1]!.prompt, /The human reviewer requested changes: Don't add Playwright yet\./);

    actions.implementation = () => undefined; // leave the implementation session running
    await manager.approveTestingSetup(runId, 2, 'Looks right.');
    await waitUntil(async () => (await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID)).length === 1);
    const [implementationStart] = await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID);
    assertWritable(implementationStart, 'implementation');
    assert.doesNotMatch(implementationStart!.prompt, /Add a junit reporter to vitest/, 'the proposal is referenced, not pasted');
    assert.deepEqual(referencedContents(implementationStart!.prompt), [PROPOSAL[0]!.content, PROPOSAL[0]!.content], 'both proposal rounds are referenced by path');
    assert.match(implementationStart!.prompt, /Decision \(round 2\): APPROVED by the person — Looks right\./);
    assert.match(implementationStart!.prompt, /Decision \(round 1\): changes requested by the person — Don't add Playwright yet\./);
    await manager.stopWorkflowRun(runId);
  });
}

test('the test tools are refused during discovery and allowed once the approved implementation runs', async () => {
  const project = await newProject('Setup Test Tools');
  const access: Record<string, boolean> = {};
  const probe = (key: string, taskId: string) => manager.requireTestingSession(taskId).then(() => { access[key] = true; }, () => { access[key] = false; });
  const { manager } = scriptedManager({
    proposal: async (taskId) => { await probe('proposal', taskId); await manager.completeStep(taskId, { summary: 's', outputs: PROPOSAL }); },
    implementation: (taskId) => probe('implementation', taskId),
  });
  const { run } = await settledSetup(manager)(project.id);
  await waitForStatus(manager, run!.id, 'awaiting-approval');
  await manager.approveTestingSetup(run!.id, 1);
  await waitUntil(async () => 'implementation' in access);
  assert.deepEqual(access, { proposal: false, implementation: true });
  await manager.stopWorkflowRun(run!.id);
});

test('reportProgress succeeds on a testing-setup run\'s steps (task 5.017 applies to every workflow, testing setups included)', async () => {
  const project = await newProject('Setup Report Progress');
  let reported = false;
  const { manager } = scriptedManager({
    proposal: async (taskId) => {
      await manager.reportProgress(taskId, { checklist: [{ text: 'Survey the existing test commands', state: 'done' }] });
      await manager.completeStep(taskId, { summary: 's', outputs: PROPOSAL });
    },
    implementation: async (taskId) => {
      await manager.reportProgress(taskId, { currentActivity: 'Adding a junit reporter' });
      reported = true;
    },
  });
  const { run } = await settledSetup(manager)(project.id);
  await waitForStatus(manager, run!.id, 'awaiting-approval');
  await manager.approveTestingSetup(run!.id, 1);
  await waitUntil(() => Promise.resolve(reported));
  await manager.stopWorkflowRun(run!.id);
});

// ---- The proposal gate ----

test('reaching the gate blocks the Open Task for input and raises an attention notification', async () => {
  const { project, manager, runId, planItemId } = await setupAtGate('Setup Gate Blocks');
  const detail = await runDetail(manager, runId);
  assert.equal(detail.run.currentStepId, setup.SETUP_PROPOSAL_STEP_ID);
  const [round] = detail.steps[0]!.rounds;
  assert.equal(round?.status, 'done');
  assert.deepEqual(round?.outputs, PROPOSAL);
  assert.equal((await planItemService.getPlanItem(planItemId)).status, 'blocked');
  const notifications = await notificationService.listNotifications({ projectId: project.id });
  assert.ok(notifications.some((n) => n.kind === 'workflow.awaiting_approval' && n.resolvedAt === null));
  await manager.stopWorkflowRun(runId);
});

test('a proposal step can neither complete without a proposal nor be skipped', async () => {
  const project = await newProject('Setup Empty Proposal');
  const outcomes: string[] = [];
  const { manager } = scriptedManager({
    proposal: async (taskId) => {
      for (const attempt of [
        () => manager.completeStep(taskId, { summary: 'nothing' }),
        () => manager.completeStep(taskId, { summary: 'blank', outputs: [{ name: 'x', format: 'markdown', content: '   ' }] }),
        () => manager.skipStep(taskId, { reason: 'no tests here' }),
      ]) {
        await attempt().then(() => outcomes.push('ok'), (error: Error) => outcomes.push(error.name));
      }
    },
  });
  const { run } = await settledSetup(manager)(project.id);
  await waitUntil(async () => outcomes.length === 3);
  assert.deepEqual(outcomes, ['TestingSetupStepRefusedError', 'TestingSetupStepRefusedError', 'TestingSetupStepRefusedError']);
  assert.equal((await runDetail(manager, run!.id)).run.status, 'running', 'still discovering: nothing to approve');
  await manager.stopWorkflowRun(run!.id);
});

test('only the testing-setup approval unlocks it: the generic approve, a stale round and a non-setup run are refused', async () => {
  const { manager, runId, starts } = await setupAtGate('Setup Approve Guard');
  await assert.rejects(manager.approveWorkflowRun(runId), (error: Error) => error.name === 'TestingSetupApprovalError');
  await assert.rejects(manager.approveTestingSetup(runId, 2), /Proposal round 2 is not the one awaiting approval \(round 1 is\)/);
  assert.equal((await runDetail(manager, runId)).run.status, 'awaiting-approval');
  assert.equal((await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID)).length, 0, 'no write-capable session started');

  // Round 1 is stale once feedback produced round 2.
  await manager.requestChangesWorkflowRun(runId, 'Smaller, please.');
  await waitForStatus(manager, runId, 'awaiting-approval');
  await assert.rejects(manager.approveTestingSetup(runId, 1), /Proposal round 1 is not the one awaiting approval \(round 2 is\)/);
  await manager.stopWorkflowRun(runId);
  await assert.rejects(manager.approveTestingSetup(runId, 2), (error: Error) => error.name === 'WorkflowRunNotActionableError');

  const project = await newProject('Setup Approve Non-Setup');
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Ordinary', description: 'x' });
  const task = await settledExecute(manager)(item.id);
  await collections.workflowRunsDb.update(task.workflowRunId!, { status: 'awaiting-approval' });
  await assert.rejects(manager.approveTestingSetup(task.workflowRunId!, 1), /is not a testing setup/);
  await manager.stopWorkflowRun(task.workflowRunId!);
});

test('two simultaneous approvals start exactly one implementation session', async () => {
  const { manager, runId, starts, actions } = await setupAtGate('Setup Double Approve');
  actions.implementation = () => undefined;
  const results = await Promise.allSettled([manager.approveTestingSetup(runId, 1), manager.approveTestingSetup(runId, 1)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID)).length, 1);
  await manager.stopWorkflowRun(runId);
});

test('three rounds of feedback stay read-only and keep every proposal and comment in history', async () => {
  const { manager, runId, starts } = await setupAtGate('Setup Feedback Cycles');
  for (const comment of ['one', 'two', 'three']) {
    await manager.requestChangesWorkflowRun(runId, comment);
    await waitForStatus(manager, runId, 'awaiting-approval');
  }
  const proposalStarts = await startsForStep(manager, starts, setup.SETUP_PROPOSAL_STEP_ID);
  assert.equal(proposalStarts.length, 4);
  proposalStarts.forEach((start, index) => assertReadOnly(start, `round ${index + 1}`));
  const rounds = (await runDetail(manager, runId)).steps[0]!.rounds;
  assert.deepEqual(rounds.map((r) => r.round), [1, 2, 3, 4]);
  assert.deepEqual(rounds.map((r) => r.approval?.comment ?? null), ['one', 'two', 'three', null]);
  assert.ok(rounds.every((r) => r.outputs[0]?.content === PROPOSAL[0]!.content));
  assert.equal((await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID)).length, 0);
  await manager.stopWorkflowRun(runId);
});

// ---- Reject ----

test('reject at the gate stops the run and the Open Task, resolves the notification, and frees the queue for the next item', async () => {
  const { project, manager, runId, planItemId } = await setupAtGate('Setup Reject');
  const notificationId = (await notificationService.listNotifications({ projectId: project.id })).find((n) => n.kind === 'workflow.awaiting_approval')?.id;
  const other = await planItemService.createPlanItem({ projectId: project.id, title: 'Next in line', description: 'x' });
  const queued = await settledEnqueue(manager)(other.id);
  assert.equal(queued.started, false, 'the setup holds the executor while it is awaiting approval');

  await manager.stopWorkflowRun(runId);
  assert.equal((await runDetail(manager, runId)).run.status, 'stopped');
  assert.equal((await planItemService.getPlanItem(planItemId)).status, 'stopped');
  const notification = (await notificationService.listNotifications({ projectId: project.id })).find((n) => n.id === notificationId);
  assert.ok(notification?.resolvedAt);
  await waitUntil(async () => (await planItemService.getPlanItem(other.id)).status === 'developing');
  assert.equal(await manager.getTestingSetup(project.id), null, 'a rejected setup leaves nothing behind');

  await assert.rejects(manager.stopWorkflowRun(runId), (error: Error) => error.name === 'WorkflowRunNotActionableError');
  const otherRun = (await planItemService.getPlanItem(other.id)).workflowRunId!;
  await manager.stopWorkflowRun(otherRun);
});

test('reject while discovery is still running kills its session; a later click starts a fresh setup', async () => {
  const project = await newProject('Setup Reject Running');
  const { manager, starts } = scriptedManager();
  const first = await settledSetup(manager)(project.id);
  await manager.stopWorkflowRun(first.run!.id);
  const detail = await runDetail(manager, first.run!.id);
  assert.equal(detail.steps[0]!.rounds[0]?.status, 'stopped');
  assert.equal(starts.length, 1);
  const second = await settledSetup(manager)(project.id);
  assert.equal(second.existing, false);
  assert.notEqual(second.planItem.id, first.planItem.id);
  await manager.stopWorkflowRun(second.run!.id);
});

// ---- Implementation, evidence and completion ----

test('an approved setup completes only with a valid config and a result for every primary action from its own test-tool runs', async () => {
  const { project, manager, runId, planItemId, actions } = await setupAtGate('Setup Validate');
  const dir = projectService.projectAbsolutePath(project);
  const attempts: string[] = [];
  actions.implementation = async (taskId) => {
    const report = () => manager.completeStep(taskId, { summary: 'Configured vitest.', verdict: 'pass' }).then(() => 'ok', (error: Error) => error.message);
    attempts.push(await report()); // no config yet
    await writeConfig(dir, VALID_CONFIG);
    attempts.push(await report()); // config, no runs
    // A manual run and another Task's run don't count; nor does a stale error.
    await collections.testRunsDb.insert(testRun({ projectId: project.id, trigger: 'manual', taskId: null }));
    await collections.testRunsDb.insert(testRun({ projectId: project.id, taskId: 'someone-else' }));
    await collections.testRunsDb.insert(testRun({ projectId: project.id, taskId, status: 'error', summary: null, diagnostics: [{ code: 'artifact-missing', message: 'no junit.xml' }] }));
    attempts.push(await report());
    await collections.testRunsDb.insert(testRun({ projectId: project.id, taskId, id: 'good-run', queuedAt: new Date(Date.now() + 1000).toISOString() }));
    attempts.push(await report());
  };
  await manager.approveTestingSetup(runId, 1);
  await waitUntil(async () => (await planItemService.getPlanItem(planItemId)).status === 'done');
  await waitUntil(async () => attempts.length === 4);

  assert.match(attempts[0]!, /No testing config at/);
  assert.match(attempts[1]!, /unit\/run was never run through the test tools/);
  assert.match(attempts[2]!, /unit\/run ended error: no junit\.xml/);
  assert.equal(attempts[3], 'ok');
  const { run } = await runDetail(manager, runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.testingSetup?.evidence?.ok, true);
  assert.deepEqual(run.testingSetup?.evidence?.actions.map((a) => [a.suiteId, a.actionId, a.runId, a.status]), [['unit', 'run', 'good-run', 'passed']]);
  const found = await manager.getTestingSetup(project.id);
  assert.equal(found?.active, false, 'a completed setup is shown, but no longer blocks a new one');
  const next = await settledSetup(manager)(project.id);
  assert.equal(next.existing, false);
  assert.equal(next.planItem.title, 'Reconfigure testing');
  await manager.stopWorkflowRun(next.run!.id);
});

test('a failed evidence check is saved on the run for the UI', async () => {
  const { manager, runId, actions } = await setupAtGate('Setup Evidence Saved');
  let refused = false;
  actions.implementation = (taskId) => manager.completeStep(taskId, { summary: 'x', verdict: 'pass' }).catch(() => { refused = true; });
  await manager.approveTestingSetup(runId, 1);
  await waitUntil(async () => refused);
  const evidence = (await runDetail(manager, runId)).run.testingSetup?.evidence;
  assert.equal(evidence?.ok, false);
  assert.equal(evidence?.config.state, 'absent');
  await manager.stopWorkflowRun(runId);
});

test('a materially different change sends the setup back to a read-only proposal that needs its own approval', async () => {
  const { manager, runId, starts, actions } = await setupAtGate('Setup Re-gate');
  let implementationRuns = 0;
  actions.implementation = async (taskId) => {
    implementationRuns += 1;
    if (implementationRuns === 1) await manager.completeStep(taskId, { summary: 'The API suite needs Postgres, which v1 did not cover.', verdict: 'issues' });
  };
  await manager.approveTestingSetup(runId, 1);
  await waitForStatus(manager, runId, 'awaiting-approval');
  const detail = await runDetail(manager, runId);
  assert.equal(detail.run.currentStepId, setup.SETUP_PROPOSAL_STEP_ID);
  const proposalRounds = detail.steps[0]!.rounds;
  assert.equal(proposalRounds.length, 2);
  assert.equal(proposalRounds[0]?.approval?.decision, 'approved', 'the earlier approval stays in history');
  assert.equal(proposalRounds[1]?.approval, null);
  const proposalStarts = await startsForStep(manager, starts, setup.SETUP_PROPOSAL_STEP_ID);
  assertReadOnly(proposalStarts[1], 'the re-proposal');
  assert.match(proposalStarts[1]!.prompt, /needs Postgres/);

  await assert.rejects(manager.approveTestingSetup(runId, 1), /round 2 is/);
  await manager.approveTestingSetup(runId, 2);
  await waitUntil(async () => (await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID)).length === 2);
  assertWritable((await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID))[1], 'implementation after re-approval');
  await manager.stopWorkflowRun(runId);
});

test('a setup cannot "continue anyway" past its implementation loop; it needs another round, a retry, or a stop', async () => {
  const { manager, runId, actions } = await setupAtGate('Setup Loop Continue');
  await collections.workflowRunsDb.update(runId, { status: 'needs-attention', currentStepId: setup.SETUP_IMPLEMENTATION_STEP_ID });
  actions.implementation = () => undefined;
  await assert.rejects(manager.decideWorkflowRunLoop(runId, 'continue'), (error: Error) => error.name === 'TestingSetupApprovalError');
  assert.equal((await runDetail(manager, runId)).run.status, 'needs-attention');
  await manager.stopWorkflowRun(runId);
});

test('an implementation session that ends without completing needs attention; retrying it keeps the approval and stays write-capable', async () => {
  const { manager, runId, starts, actions } = await setupAtGate('Setup Retry');
  actions.implementation = (_taskId, exit) => exit();
  await manager.approveTestingSetup(runId, 1);
  await waitForStatus(manager, runId, 'needs-attention');
  assert.match((await runDetail(manager, runId)).run.attentionReason ?? '', /Setup & Validation step ended without completing/);
  actions.implementation = () => undefined;
  await manager.retryWorkflowStep(runId);
  const implementationStarts = await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID);
  assert.equal(implementationStarts.length, 2);
  assertWritable(implementationStarts[1], 'retried implementation');
  await manager.stopWorkflowRun(runId);
});

test('retrying a failed proposal step stays read-only', async () => {
  const project = await newProject('Setup Retry Proposal');
  const { manager, starts, actions } = scriptedManager({ proposal: (_taskId, exit) => exit() });
  const { run } = await settledSetup(manager)(project.id);
  await waitForStatus(manager, run!.id, 'needs-attention');
  actions.proposal = () => undefined;
  await manager.retryWorkflowStep(run!.id);
  assert.equal(starts.length, 2);
  assertReadOnly(starts[1], 'retried proposal');
  await manager.stopWorkflowRun(run!.id);
});

test('a proposal step whose snapshot carries canRunCommands still runs read-only with no shell, no test tools and no command access', async () => {
  const project = await newProject('Setup Command Option');
  const { manager, starts, actions } = scriptedManager({ proposal: (_taskId, exit) => exit() });
  const { run } = await settledSetup(manager)(project.id);
  await waitForStatus(manager, run!.id, 'needs-attention');
  const current = (await collections.workflowRunsDb.get(run!.id))!;
  await collections.workflowRunsDb.update(run!.id, {
    workflowSnapshot: { ...current.workflowSnapshot, steps: current.workflowSnapshot.steps.map((step) => (step.id === setup.SETUP_PROPOSAL_STEP_ID ? { ...step, canRunCommands: true } : step)) },
  });
  actions.proposal = () => undefined;
  await manager.retryWorkflowStep(run!.id);
  assertReadOnly(starts[1], 'proposal with the option');
  assert.ok(!starts[1]!.canRunCommands, 'no command access');
  await manager.stopWorkflowRun(run!.id);
});

test('a setup Task whose proposal approval is missing fails closed: no write access', async () => {
  const { manager, runId, actions, starts } = await setupAtGate('Setup Fail Closed');
  actions.implementation = () => undefined;
  await manager.approveTestingSetup(runId, 1);
  const [implementationStart] = await startsForStep(manager, starts, setup.SETUP_IMPLEMENTATION_STEP_ID);
  // With its approval record removed, the same Task can no longer run tests.
  const proposalRound = (await runDetail(manager, runId)).steps[0]!.rounds[0]!;
  await collections.stepRunsDb.update(proposalRound.id, { approval: null });
  await assert.rejects(manager.requireTestingSession(implementationStart!.taskId), (error: Error) => error.name === 'TaskNotTestingSessionError');
  await manager.stopWorkflowRun(runId);
});

// ---- Queueing ----

test('a setup started while another Open Task holds the executor queues as an ordinary item, then starts read-only once it is done', async () => {
  const project = await newProject('Setup Queued');
  const { manager, starts, actions } = scriptedManager();
  const busy = await planItemService.createPlanItem({ projectId: project.id, title: 'Busy work', description: 'x' });
  await settledExecute(manager)(busy.id);

  const result = await settledSetup(manager)(project.id);
  assert.equal(result.run, null);
  assert.ok(result.queueEntry);
  assert.equal(result.planItem.status, 'pending');
  assert.equal(starts.length, 1, 'no setup session started');
  const clicked = await settledSetup(manager)(project.id);
  assert.equal(clicked.existing, true);
  assert.equal(clicked.queueEntry?.id, result.queueEntry.id);
  const found = await manager.getTestingSetup(project.id);
  assert.equal(found?.queueEntry?.id, result.queueEntry.id);

  // The busy item finishes; the queue advances to the setup.
  actions.development = (taskId) => manager.completeStep(taskId, { summary: 'done' });
  const busyTask = (await manager.listTasksForProject(project.id)).find((t) => t.planItemId === busy.id)!;
  await manager.completeStep(busyTask.id, { summary: 'done' });
  await waitUntil(async () => (await startsForStep(manager, starts, setup.SETUP_PROPOSAL_STEP_ID)).length === 1);
  const setupStart = (await startsForStep(manager, starts, setup.SETUP_PROPOSAL_STEP_ID))[0];
  assertReadOnly(setupStart, 'queued setup, once started');
  const runId = (await planItemService.getPlanItem(result.planItem.id)).workflowRunId!;
  await manager.stopWorkflowRun(runId);
});

test('a pending setup that lost its queue entry is re-queued by the next click', async () => {
  const project = await newProject('Setup Requeue');
  const { manager } = scriptedManager();
  const busy = await planItemService.createPlanItem({ projectId: project.id, title: 'Busy', description: 'x' });
  const busyTask = await settledExecute(manager)(busy.id);
  const result = await settledSetup(manager)(project.id);
  await manager.removeQueuedPlanItemExecution(result.queueEntry!.id);
  const again = await settledSetup(manager)(project.id);
  assert.equal(again.existing, true);
  assert.ok(again.queueEntry);
  assert.notEqual(again.queueEntry.id, result.queueEntry!.id);
  await manager.stopWorkflowRun(busyTask.workflowRunId!);
});

// ---- Forgery ----

test('an ordinary Open Task never runs the setup workflow, and only the daemon can mark an item as a setup', async () => {
  const project = await newProject('Setup Forgery');
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Ordinary', description: 'x' });
  assert.equal(item.testingSetup, undefined);
  const { manager } = scriptedManager();
  const task = await settledExecute(manager)(item.id);
  const { run } = await runDetail(manager, task.workflowRunId!);
  assert.equal(run.workflowId, 'software-development');
  assert.equal(run.testingSetup, undefined);
  await manager.stopWorkflowRun(run.id);
});
