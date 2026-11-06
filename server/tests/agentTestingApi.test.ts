import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ProjectRecord, TaskRecord, TestRunRecord } from '../src/domain/types.ts';
import type { TestRunEvent, TestRunner } from '../src/testing/testRunner.ts';
import { createFakeHarness, JUNIT_FAIL, JUNIT_PASS, sampleConfig, waitUntil } from './helpers/testRunFakes.ts';
import type { FakeHarness, FakeProcess } from './helpers/testRunFakes.ts';

/**
 * The coding-session testing tools' daemon side (`/api/agent-testing`, testing/agentTesting.ts):
 * who may call it, what it answers, and that an agent run is the same Test Run a manual one is.
 * Every test process is a FakeProcess (tests/helpers/testRunFakes.ts) and no Task is ever started:
 * Task records are written straight to the database, so no agent CLI can launch.
 */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let harness: FakeHarness;
let runner: TestRunner;
let token: string;
let projectService: typeof import('../src/projects/projectService.ts');
let collections: typeof import('../src/db/collections.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-testing-api-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  projectService = await import('../src/projects/projectService.ts');
  collections = await import('../src/db/collections.ts');
  token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
  const { createDaemonServer } = await import('../src/server.ts');
  const { createTestRunner } = await import('../src/testing/testRunner.ts');
  harness = createFakeHarness();
  runner = createTestRunner(harness.deps);
  server = createDaemonServer({ testRunner: runner });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

async function api(pathname: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** Calls an agent-testing route as the session of `taskId`, with the daemon's CLI hook token. */
function agent(method: 'GET' | 'POST', route: string, taskId: string, body?: unknown, auth = `Bearer ${token}`) {
  const join = route.includes('?') ? '&' : '?';
  return api(`/api/agent-testing${route}${join}taskId=${encodeURIComponent(taskId)}`, {
    method,
    headers: { authorization: auth },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
}

async function writeConfig(root: string, config: unknown) {
  await mkdir(path.join(root, '.docs', 'testing'), { recursive: true });
  await writeFile(path.join(root, '.docs', 'testing', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

let count = 0;
async function createProject(config: unknown = sampleConfig()) {
  // Created through the service, not POST /api/projects, so no docs-bootstrap Task (and no real CLI) starts.
  const project = await projectService.createProject({ name: `Agent Testing ${(count += 1)}`, position: null });
  if (config !== null) await writeConfig(projectService.projectAbsolutePath(project), config);
  return project;
}

/**
 * Writes a Task record directly (no session starts) and, when `active`, lists it among its
 * Project's active Tasks. `worktree` gives it its own working tree with the same testing config.
 */
async function addTask(project: ProjectRecord, options: { kind?: TaskRecord['kind']; status?: TaskRecord['status']; active?: boolean; worktree?: boolean } = {}) {
  const id = `task-${(count += 1)}`;
  let worktreePath: string | null = null;
  if (options.worktree) {
    worktreePath = path.join(projectService.projectWorktreesRoot(project), id);
    await writeConfig(worktreePath, sampleConfig());
  }
  const task = { id, projectId: project.id, kind: options.kind ?? 'execute', status: options.status ?? 'developing', worktreePath } as TaskRecord;
  await collections.tasksDb.insert(task);
  if (options.active ?? true) {
    await projectService.patchProjectWith(project.id, (p) => ({ activeTaskIds: [...(p.activeTaskIds ?? []), id] }));
  }
  return task;
}

/** Answers the next spawned fake test process: optional output, a report and an exit code. */
async function finishNext(options: { exit: number; report?: string; output?: string }): Promise<FakeProcess> {
  const child = await harness.nextProcess();
  if (options.output) child.write(options.output);
  if (options.report) harness.writeArtifact(child, 'junit.xml', options.report);
  child.exit(options.exit);
  return child;
}

test('every route needs the CLI hook token and a task id, and spawns nothing without them', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const spawned = harness.processes.length;
  for (const [method, route] of [['GET', '/actions'], ['POST', '/runs'], ['POST', '/run-all'], ['GET', '/runs/any']] as const) {
    assert.equal((await agent(method, route, task.id, { suiteId: 'lint', actionId: 'check' }, '')).status, 401, `${route} without a token`);
    assert.equal((await agent(method, route, task.id, { suiteId: 'lint', actionId: 'check' }, 'Bearer wrong')).status, 401, `${route} with a wrong token`);
  }
  const noTask = await api('/api/agent-testing/actions', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(noTask.status, 400);
  assert.equal((await agent('POST', '/runs', 'no-such-task', { suiteId: 'lint', actionId: 'check' })).status, 404);
  assert.equal(harness.processes.length, spawned);
});

test('a planning session, a stale Task or a Task no longer active is refused on every route and runs nothing', async () => {
  const project = await createProject();
  const manual = await runner.enqueueAction(project.id, 'lint', 'check');
  await finishNext({ exit: 0 });
  await waitUntil(async () => (await collections.testRunsDb.get(manual.id))?.status === 'passed');

  const refused = [
    await addTask(project, { kind: 'plan' }),
    await addTask(project, { status: 'stopped' }),
    await addTask(project, { status: 'done' }),
    await addTask(project, { status: 'failed' }),
    await addTask(project, { active: false }),
  ];
  const spawned = harness.processes.length;
  const runsBefore = (await collections.testRunsDb.find((r) => r.projectId === project.id)).length;
  for (const task of refused) {
    for (const [method, route] of [['GET', '/actions'], ['POST', '/runs'], ['POST', '/run-all'], ['GET', `/runs/${manual.id}`]] as const) {
      const res = await agent(method, route, task.id, { suiteId: 'lint', actionId: 'check' });
      assert.equal(res.status, 409, `${task.kind}/${task.status} on ${route}`);
      assert.match(res.body.error, /not an active coding session/);
    }
  }
  assert.equal(harness.processes.length, spawned, 'nothing was spawned');
  assert.equal((await collections.testRunsDb.find((r) => r.projectId === project.id)).length, runsBefore, 'no run record was written');

  // The planning session keeps its own task-management tools.
  const tasks = await api(`/api/agent-tasks?taskId=${refused[0]!.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(tasks.status, 200);
});

test('list_test_actions describes the registered suites from the Task working tree, without commands', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const res = await agent('GET', '/actions', task.id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.config, { state: 'valid', path: '.docs/testing/config.json' });
  assert.equal(res.body.diagnostic, undefined);
  assert.deepEqual(res.body.suites.map((s: { id: string }) => s.id), ['unit', 'lint', 'e2e', 'security']);
  assert.deepEqual(res.body.suites[0], {
    id: 'unit', label: 'Unit tests', kind: 'unit', enabled: true, primaryActionId: 'run',
    actions: [
      { id: 'run', label: 'Run unit tests', purpose: 'result', enabled: true },
      { id: 'snapshots', label: 'Update snapshots', purpose: 'utility', enabled: true },
    ],
  });
  assert.equal(res.body.suites[2].enabled, false, 'a disabled suite is listed as disabled');
  assert.doesNotMatch(JSON.stringify(res.body), /npm test|playwright|semgrep --sarif/, 'no command text');
});

test('list_test_actions explains an absent, invalid or unparseable config instead of failing', async () => {
  const absent = await addTask(await createProject(null));
  const none = await agent('GET', '/actions', absent.id);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.config, { state: 'absent', path: '.docs/testing/config.json' });
  assert.deepEqual(none.body.suites, []);
  assert.match(none.body.diagnostic, /No testing config at \.docs\/testing\/config\.json/);

  const invalid = await addTask(await createProject({ schemaVersion: 1, suites: [{ id: 'unit', label: 'U', kind: 'unit', primaryActionId: 'x', actions: [] }] }));
  const bad = await agent('GET', '/actions', invalid.id);
  assert.equal(bad.body.config.state, 'invalid');
  assert.ok(bad.body.config.issues.length > 0);
  assert.ok(bad.body.config.issues.every((issue: { path: string; message: string }) => typeof issue.message === 'string'));
  assert.deepEqual(bad.body.suites, []);
  assert.match(bad.body.diagnostic, /invalid/);

  const unparseable = await addTask(await createProject('{ not json'));
  const broken = await agent('GET', '/actions', unparseable.id);
  assert.equal(broken.body.config.state, 'invalid');
  assert.match(JSON.stringify(broken.body.config.issues), /JSON/i);

  const spawned = harness.processes.length;
  for (const task of [absent, invalid, unparseable]) {
    const run = await agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run' });
    assert.equal(run.status, 409);
    assert.match(run.body.error, /testing config/);
    assert.equal((await agent('POST', '/run-all', task.id, {})).status, 409);
  }
  assert.equal(harness.processes.length, spawned);
});

test('run_test_action runs the action as an agent run and answers with a compact passing report', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const pending = agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run' });
  const child = await finishNext({ exit: 0, report: JUNIT_PASS, output: 'all good\n' });
  const res = await pending;

  assert.equal(res.status, 201);
  assert.equal(child.command, 'npm test');
  assert.equal(child.cwd, path.join(projectService.projectAbsolutePath(project), 'packages', 'api'));
  assert.equal(res.body.status, 'passed');
  assert.equal(res.body.settled, true);
  assert.deepEqual(res.body.suite, { id: 'unit', label: 'Unit tests' });
  assert.deepEqual(res.body.action, { id: 'run', label: 'Run unit tests', purpose: 'result' });
  assert.equal(res.body.trigger, 'agent');
  assert.equal(res.body.taskId, task.id);
  assert.equal(res.body.branch, 'main');
  assert.equal(res.body.commit, 'abc123');
  assert.equal(res.body.result.outcome, 'passed');
  assert.deepEqual(res.body.result.counts, { total: 2, passed: 2, failed: 0, errored: 0, skipped: 0 });
  assert.deepEqual(res.body.failures, []);
  assert.equal(res.body.outputTail, 'all good');

  const record = await collections.testRunsDb.get(res.body.runId);
  assert.equal(record?.trigger, 'agent');
  assert.equal(record?.taskId, task.id);
});

test('a failed action reports its failing tests and output tail, capped', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const cases = Array.from({ length: 30 }, (_, i) => `<testcase classname="math" name="case ${i}"><failure message="${'x'.repeat(800)}">stack</failure></testcase>`).join('');
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const pending = agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run' });
  await finishNext({ exit: 1, report: `<testsuite name="unit">${cases}</testsuite>`, output: `${lines}\n` });
  const res = await pending;

  assert.equal(res.body.status, 'failed');
  assert.equal(res.body.result.counts.failed, 30);
  assert.equal(res.body.failures.length, 20);
  assert.equal(res.body.failuresOmitted, 10);
  assert.equal(res.body.failures[0].name, 'case 0');
  assert.equal(res.body.failures[0].group, 'math');
  assert.ok(res.body.failures[0].message.length < 600, 'each failure message is truncated');
  assert.equal(res.body.outputTail.split('\n').length, 60);
  assert.ok(res.body.outputTail.endsWith('line 199'), 'the tail keeps the last lines');
  assert.equal(res.body.outputTruncated, true);

  const small = agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run' });
  await finishNext({ exit: 1, report: JUNIT_FAIL });
  const one = (await small).body;
  assert.deepEqual(one.failures, [{ name: 'divides', group: 'math', outcome: 'failed', message: 'expected 2, got 3' }]);
  assert.equal(one.failuresOmitted, 0);
});

test('a missing report or a process that fails to start settles as error with diagnostics', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const missing = agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run' });
  await finishNext({ exit: 0 });
  const res = await missing;
  assert.equal(res.body.status, 'error');
  assert.ok(res.body.diagnostics.length > 0);
  assert.ok(res.body.diagnostics.some((d: { collectorId?: string; message: string }) => /junit\.xml|cases/.test(d.message)));

  const broken = agent('POST', '/runs', task.id, { suiteId: 'lint', actionId: 'check' });
  (await harness.nextProcess()).fail(new Error('spawn sh ENOENT'));
  const failed = await broken;
  assert.equal(failed.body.status, 'error');
  assert.deepEqual(failed.body.diagnostics, [{ code: 'spawn-failed', message: 'Failed to start: spawn sh ENOENT' }]);
});

test('huge output stays bounded in the reply, keeping the end of the log', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const pending = agent('POST', '/runs', task.id, { suiteId: 'lint', actionId: 'check' });
  const child = await harness.nextProcess();
  const chunk = `${'noise '.repeat(1000)}\n`;
  for (let i = 0; i < 300; i += 1) child.write(chunk);
  child.write('FINAL LINE\n');
  child.exit(1);
  const res = await pending;
  assert.equal(res.body.status, 'failed');
  assert.ok(res.body.outputTail.length <= 6_000);
  assert.ok(res.body.outputTail.endsWith('FINAL LINE'));
  assert.equal(res.body.outputTruncated, true);
  assert.ok(JSON.stringify(res.body).length < 10_000);
});

test('unknown or disabled actions and bad input are refused without spawning', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const spawned = harness.processes.length;
  assert.equal((await agent('POST', '/runs', task.id, { suiteId: 'nope', actionId: 'run' })).status, 404);
  assert.equal((await agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'nope' })).status, 404);
  const disabled = await agent('POST', '/runs', task.id, { suiteId: 'e2e', actionId: 'run' });
  assert.equal(disabled.status, 409);
  assert.match(disabled.body.error, /disabled/);
  const missing = await agent('POST', '/runs', task.id, { suiteId: 'unit' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /list_test_actions/);
  assert.equal((await agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run', waitSeconds: 'soon' })).status, 400);
  assert.equal((await agent('GET', '/runs/x?waitSeconds=abc', task.id)).status, 400);
  assert.equal((await agent('POST', '/run-all', task.id, { waitSeconds: {} })).status, 400);
  assert.equal(harness.processes.length, spawned);
});

test('a utility action runs and reports no result totals', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const pending = agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'snapshots' });
  await finishNext({ exit: 0 });
  const res = await pending;
  assert.equal(res.body.status, 'passed');
  assert.equal(res.body.action.purpose, 'utility');
  assert.equal(res.body.result, null);
});

test('a long run answers "not settled yet" with its id, and get_test_run waits for the final result', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const started = await agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run', waitSeconds: 0 });
  assert.equal(started.status, 201);
  assert.equal(started.body.settled, false);
  assert.ok(['queued', 'running'].includes(started.body.status));
  assert.equal(started.body.result, null);

  const child = await harness.nextProcess();
  child.write('partial output\n');
  await waitUntil(async () => (await collections.testRunsDb.get(started.body.runId))?.status === 'running');
  const running = await agent('GET', `/runs/${started.body.runId}?waitSeconds=0`, task.id);
  assert.equal(running.body.status, 'running');
  assert.equal(running.body.settled, false);
  assert.equal(running.body.outputTail, 'partial output');

  // The same action again while it runs joins that run rather than spawning a second process.
  const joined = await agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run', waitSeconds: 0 });
  assert.equal(joined.body.runId, started.body.runId);

  const waiting = agent('GET', `/runs/${started.body.runId}?waitSeconds=5`, task.id);
  harness.writeArtifact(child, 'junit.xml', JUNIT_FAIL);
  child.exit(1);
  const final = await waiting;
  assert.equal(final.status, 200);
  assert.equal(final.body.status, 'failed');
  assert.equal(final.body.settled, true);
  assert.equal(final.body.failures[0].name, 'divides');
  assert.equal(harness.processes.filter((p) => p === child).length, 1);
});

test('the wait is bounded: a run that never finishes is reported unsettled when the wait ends', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const startedAt = Date.now();
  const pending = agent('POST', '/runs', task.id, { suiteId: 'lint', actionId: 'check', waitSeconds: 0.2 });
  const child = await harness.nextProcess();
  const res = await pending;
  assert.equal(res.body.settled, false);
  assert.ok(Date.now() - startedAt < 3_000);
  child.exit(0);
  await waitUntil(async () => (await collections.testRunsDb.get(res.body.runId))?.status === 'passed');
});

test('get_test_run reads any run of the Task Project, but another Project run is not found', async () => {
  const project = await createProject();
  const other = await createProject();
  const task = await addTask(project);
  const manual = await runner.enqueueAction(project.id, 'lint', 'check');
  const foreign = await runner.enqueueAction(other.id, 'lint', 'check');
  await finishNext({ exit: 0 });
  await finishNext({ exit: 0 });
  await waitUntil(async () => (await collections.testRunsDb.get(foreign.id))?.status === 'passed');

  const own = await agent('GET', `/runs/${manual.id}`, task.id);
  assert.equal(own.status, 200);
  assert.equal(own.body.trigger, 'manual');
  const denied = await agent('GET', `/runs/${foreign.id}`, task.id);
  assert.equal(denied.status, 404);
  assert.equal((await agent('GET', '/runs/no-such-run', task.id)).status, 404);
});

test('run_all_tests runs every enabled suite as one batch and reports each run compactly', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const pending = agent('POST', '/run-all', task.id, {});
  await finishNext({ exit: 1, report: JUNIT_FAIL, output: 'unit failed\n' });
  await finishNext({ exit: 0, output: 'lint ok\n' });
  const security = await harness.nextProcess();
  harness.writeArtifact(security, 'out/semgrep.sarif', JSON.stringify({ runs: [{ results: [{ ruleId: 'x', level: 'error', message: { text: 'SQL injection' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 4 } } }] }] }] }));
  security.exit(0);
  const res = await pending;

  assert.equal(res.status, 201);
  assert.equal(res.body.settled, true);
  assert.deepEqual(res.body.joined, []);
  assert.deepEqual(res.body.runs.map((r: { suite: { id: string }; status: string }) => [r.suite.id, r.status]), [['unit', 'failed'], ['lint', 'passed'], ['security', 'failed']]);
  assert.ok(res.body.runs.every((r: { trigger: string; taskId: string }) => r.trigger === 'agent' && r.taskId === task.id));
  const batchIds = new Set((await Promise.all(res.body.runs.map((r: { runId: string }) => collections.testRunsDb.get(r.runId)))).map((r) => (r as TestRunRecord).batchId));
  assert.equal(batchIds.size, 1);
  assert.equal(res.body.runs[0].outputTail, 'unit failed', 'a failing run keeps its tail');
  assert.equal(res.body.runs[1].outputTail, '', 'a passing run in a batch leaves its output out');
  assert.equal(res.body.runs[2].findings[0].title, 'SQL injection');
  assert.equal(res.body.runs[2].findings[0].location, 'src/db.ts:4');
});

test('run_all_tests joins a suite already running for the Task and can return before the batch settles', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const lint = await agent('POST', '/runs', task.id, { suiteId: 'lint', actionId: 'check', waitSeconds: 0 });
  const res = await agent('POST', '/run-all', task.id, { waitSeconds: 0 });
  assert.equal(res.body.settled, false);
  assert.deepEqual(res.body.joined, [{ suiteId: 'lint', actionId: 'check', runId: lint.body.runId }]);
  assert.deepEqual(res.body.runs.map((r: { suite: { id: string } }) => r.suite.id), ['unit', 'security', 'lint']);
  await finishNext({ exit: 0 });
  await finishNext({ exit: 0, report: JUNIT_PASS });
  const security = await harness.nextProcess();
  harness.writeArtifact(security, 'out/semgrep.sarif', '{"runs":[]}');
  security.exit(0);
  for (const run of res.body.runs) {
    const settled = await agent('GET', `/runs/${run.runId}?waitSeconds=5`, task.id);
    assert.equal(settled.body.status, 'passed');
  }
});

test('an agent run in a Task worktree runs there, records its branch, and stays out of the latest results', async () => {
  const project = await createProject();
  const task = await addTask(project, { worktree: true });
  const pending = agent('POST', '/runs', task.id, { suiteId: 'lint', actionId: 'check' });
  const child = await finishNext({ exit: 0 });
  const res = await pending;
  assert.equal(child.cwd, task.worktreePath);
  assert.equal(res.body.cwd, task.worktreePath);
  assert.equal(res.body.branch, 'task-branch');
  const record = await collections.testRunsDb.get(res.body.runId);
  assert.equal(record?.executionRoot, task.worktreePath);

  const overview = await api(`/api/projects/${project.id}/testing`);
  const lintAction = overview.body.suites[1].actions[0];
  assert.equal(lintAction.latestRun, null, 'a worktree run describes the Task tree, not the primary one');
  const history = await api(`/api/projects/${project.id}/test-runs`);
  assert.equal(history.body.runs[0].id, res.body.runId, 'it still appears in History');
  assert.equal(history.body.runs[0].trigger, 'agent');
});

/** The run's record, stripped of what legitimately differs between two runs of the same action. */
function comparable(run: TestRunRecord) {
  const { id: _id, queuedAt: _q, startedAt: _s, completedAt: _c, durationMs: _d, trigger: _t, taskId: _task, ...rest } = run;
  return rest;
}

test('an agent run is the same Test Run as a manual one: record, result, events, spawn and latest results', async () => {
  const project = await createProject();
  const task = await addTask(project);
  const events: TestRunEvent[] = [];
  const unsubscribe = runner.onTestEvent((event) => events.push(event));
  const notificationsBefore = (await collections.notificationsDb.find((n) => n.projectId === project.id)).length;

  const manual = await api(`/api/projects/${project.id}/test-runs`, { method: 'POST', body: JSON.stringify({ suiteId: 'unit', actionId: 'run' }) });
  const manualChild = await finishNext({ exit: 1, report: JUNIT_FAIL, output: '1 failing\n' });
  await waitUntil(async () => (await collections.testRunsDb.get(manual.body.id))?.status === 'failed');

  const agentRun = agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run' });
  const agentChild = await finishNext({ exit: 1, report: JUNIT_FAIL, output: '1 failing\n' });
  const reply = (await agentRun).body;
  unsubscribe();

  const manualRecord = (await collections.testRunsDb.get(manual.body.id))!;
  const agentRecord = (await collections.testRunsDb.get(reply.runId))!;
  assert.equal(manualRecord.trigger, 'manual');
  assert.equal(agentRecord.trigger, 'agent');
  assert.equal(agentRecord.taskId, task.id);
  assert.deepEqual(comparable(agentRecord), comparable(manualRecord));

  const manualDetail = await api(`/api/test-runs/${manual.body.id}`);
  const agentDetail = await api(`/api/test-runs/${reply.runId}`);
  assert.deepEqual(agentDetail.body.result, manualDetail.body.result);
  assert.equal(agentDetail.body.output, manualDetail.body.output);

  assert.equal(agentChild.command, manualChild.command);
  assert.equal(agentChild.cwd, manualChild.cwd);
  assert.deepEqual(Object.keys(agentChild.env).sort(), Object.keys(manualChild.env).sort());

  const sequence = (runId: string) => events
    .filter((e) => (e.type === 'testRun' ? e.run.id : e.runId) === runId)
    .map((e) => (e.type === 'testRun' ? `${e.type}:${e.run.status}` : e.type));
  assert.deepEqual(sequence(reply.runId), sequence(manual.body.id));
  assert.deepEqual(sequence(reply.runId).filter((s) => s.startsWith('testRun:')), ['testRun:queued', 'testRun:running', 'testRun:failed']);
  assert.ok(sequence(reply.runId).includes('testRunLog'));

  const overview = await api(`/api/projects/${project.id}/testing`);
  assert.equal(overview.body.suites[0].latestResult.id, reply.runId, "an agent run on the Project's own tree updates the latest result");
  assert.equal(overview.body.suites[0].actions[0].latestRun.id, reply.runId);

  const notifications = await collections.notificationsDb.find((n) => n.projectId === project.id);
  assert.equal(notifications.length, notificationsBefore + 1, 'only the manual failure raised a notification');
});

test('a call that waits records its run on the task as awaited; a no-wait call does not', async () => {
  const project = await createProject();
  const task = await addTask(project);

  const noWait = agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run', waitSeconds: 0 });
  await finishNext({ exit: 0, report: JUNIT_PASS });
  const first = await noWait;
  assert.equal(first.status, 201);
  await waitUntil(async () => (await collections.testRunsDb.get(first.body.runId))?.status === 'passed');
  assert.equal((await collections.tasksDb.get(task.id))?.awaitedTestRunIds, undefined, 'not waiting, so nothing awaited');

  const waiting = agent('POST', '/runs', task.id, { suiteId: 'unit', actionId: 'run' });
  await finishNext({ exit: 0, report: JUNIT_PASS });
  const second = await waiting;
  assert.deepEqual((await collections.tasksDb.get(task.id))?.awaitedTestRunIds, [second.body.runId]);
});
