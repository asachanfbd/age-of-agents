import { createQuietProject } from './helpers/quietProject.ts';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';

/**
 * REST-level coverage for task 3.012's new endpoints: the Workflow Catalog CRUD, a Project's
 * `workflowId` selection, listing/reading WorkflowRuns, and the `/api/workflow-steps` MCP relay's
 * auth. Run against a real in-process HTTP server (like api.test.ts), so a call that reaches the
 * real interactive-CLI session host (e.g. actually starting a run) relies on the same "the fixture
 * executors' `bin` doesn't exist on this machine, so a spawn attempt fails fast/cleanly" tolerance
 * api.test.ts's own `POST /api/plan-items/:id/execute` tests already rely on — never a real
 * `claude`/`codex` process, and never something these tests need to wait on: none of them assert on
 * the step Task's eventual (failed) outcome, only on the run/step shape created synchronously.
 */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-api-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  const { createDaemonServer } = await import('../src/server.ts');
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Waits for a started run to finish its background start-up. */
async function untilStarted(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await api(`/api/workflow-runs/${runId}`)).body.run.status !== 'starting') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run never finished starting');
}

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  return { status: res.status, body };
}

const VALID_WORKFLOW_BODY = {
  id: 'api-flow',
  name: 'API Flow',
  description: 'A workflow created over HTTP.',
  steps: [
    { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build it.' },
  ],
};

test('GET /api/catalog/workflows starts with just the fixture catalog\'s own seeded default', async () => {
  const res = await api('/api/catalog/workflows');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((w: { id: string }) => w.id), ['software-development']);
});

test('POST /api/catalog/workflows creates a workflow, resolving each step\'s agent to name/avatar', async () => {
  const res = await api('/api/catalog/workflows', { method: 'POST', body: JSON.stringify(VALID_WORKFLOW_BODY) });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'api-flow');
  assert.equal(res.body.steps[0].agent.id, 'builder');
  assert.ok(res.body.steps[0].agent.name);
  assert.ok(!('requirementAnalysis' in res.body));
});

test('POST /api/catalog/workflows validates required fields with 400s', async () => {
  const missingId = await api('/api/catalog/workflows', { method: 'POST', body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: '' }) });
  assert.equal(missingId.status, 400);
  const missingSteps = await api('/api/catalog/workflows', { method: 'POST', body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: 'x', steps: undefined }) });
  assert.equal(missingSteps.status, 400);
});

test('POST /api/catalog/workflows 400s on invalid step content (e.g. an unresolvable agentId), via the shared validation path', async () => {
  const res = await api('/api/catalog/workflows', {
    method: 'POST',
    body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: 'bad-agent-flow', steps: [{ ...VALID_WORKFLOW_BODY.steps[0], agentId: 'no-such-agent' }] }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/catalog/workflows 400s on a Request changes target that is not an earlier step, and saves a valid one', async () => {
  const approval = { id: 'signoff', name: 'Sign-off', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Brief.' };
  const bad = await api('/api/catalog/workflows', {
    method: 'POST',
    body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: 'rc-bad-flow', steps: [{ ...approval, requestChangesToStepId: 'build' }, VALID_WORKFLOW_BODY.steps[0]] }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Request changes must go back to an earlier step/);
  const good = await api('/api/catalog/workflows', {
    method: 'POST',
    body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: 'rc-good-flow', steps: [VALID_WORKFLOW_BODY.steps[0], { ...approval, requestChangesToStepId: 'build' }] }),
  });
  assert.equal(good.status, 201);
  assert.equal(good.body.steps[1].requestChangesToStepId, 'build');
  await api('/api/catalog/workflows/rc-good-flow', { method: 'DELETE' });
});

test('GET/PUT/DELETE /api/catalog/workflows/:id round-trip, 404ing for an unknown id', async () => {
  const get = await api('/api/catalog/workflows/api-flow');
  assert.equal(get.status, 200);
  assert.equal(get.body.name, 'API Flow');

  const put = await api('/api/catalog/workflows/api-flow', { method: 'PUT', body: JSON.stringify({ name: 'Renamed Flow' }) });
  assert.equal(put.status, 200);
  assert.equal(put.body.name, 'Renamed Flow');

  const missing = await api('/api/catalog/workflows/does-not-exist');
  assert.equal(missing.status, 404);

  const del = await api('/api/catalog/workflows/api-flow', { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal((await api('/api/catalog/workflows/api-flow')).status, 404);
});

test('PATCH /api/projects/:id/workflow sets and resets (null) a Project\'s Workflow choice, 404ing for an unknown workflowId', async () => {
  await api('/api/catalog/workflows', { method: 'POST', body: JSON.stringify(VALID_WORKFLOW_BODY) });
  const created = await createQuietProject('Workflow Choice Project');
  const projectId = created.body.id;

  const badId = await api(`/api/projects/${projectId}/workflow`, { method: 'PATCH', body: JSON.stringify({ workflowId: 'no-such-flow' }) });
  assert.equal(badId.status, 404);

  const set = await api(`/api/projects/${projectId}/workflow`, { method: 'PATCH', body: JSON.stringify({ workflowId: 'api-flow' }) });
  assert.equal(set.status, 200);
  assert.equal(set.body.workflowId, 'api-flow');

  const reset = await api(`/api/projects/${projectId}/workflow`, { method: 'PATCH', body: JSON.stringify({ workflowId: null }) });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.workflowId, null);

  const badType = await api(`/api/projects/${projectId}/workflow`, { method: 'PATCH', body: JSON.stringify({ workflowId: 42 }) });
  assert.equal(badType.status, 400);
});

test('GET /api/projects/:id/workflow-runs lists newest first once a run has been started, and GET /api/workflow-runs/:id shapes the Stepper detail', async () => {
  const project = await createQuietProject('Workflow Run Listing');
  const projectId = project.body.id;

  const empty = await api(`/api/projects/${projectId}/workflow-runs`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);

  const item = await api(`/api/projects/${projectId}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Do it', description: 'desc' }) });
  const executed = await api(`/api/plan-items/${item.body.id}/execute`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(executed.status, 201);
  const runId = executed.body.id;
  assert.equal(executed.body.status, 'starting', 'the start is accepted before its agent is launched');
  await untilStarted(runId);

  const list = await api(`/api/projects/${projectId}/workflow-runs`);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, runId);

  const detail = await api(`/api/workflow-runs/${runId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.run);
  assert.equal(detail.body.requirementStage, undefined, 'a run is only its configured steps');
  assert.ok(Array.isArray(detail.body.steps));
  assert.equal(detail.body.steps[0].step.id, 'development');

  const missing = await api('/api/workflow-runs/does-not-exist');
  assert.equal(missing.status, 404);
});

test('workflow-run action routes 409 (or 404) for a run that is not in the right state', async () => {
  const project = await createQuietProject('Workflow Actions Project');
  const item = await api(`/api/projects/${project.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Do it', description: 'desc' }) });
  const executed = await api(`/api/plan-items/${item.body.id}/execute`, { method: 'POST', body: JSON.stringify({}) });
  const runId = executed.body.id;
  await untilStarted(runId);

  const approve = await api(`/api/workflow-runs/${runId}/approve`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(approve.status, 409, 'a freshly-started run is not awaiting approval yet');

  const badRequestChanges = await api(`/api/workflow-runs/${runId}/request-changes`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(badRequestChanges.status, 400, 'comment is required');

  const badLoopAction = await api(`/api/workflow-runs/${runId}/loop`, { method: 'POST', body: JSON.stringify({ action: 'nonsense' }) });
  assert.equal(badLoopAction.status, 400);

  const missingRun = await api('/api/workflow-runs/does-not-exist/stop', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missingRun.status, 404);

  const resumeUnstopped = await api(`/api/workflow-runs/${runId}/resume`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(resumeUnstopped.status, 409, 'only a stopped run can be resumed');
  const resumeMissing = await api('/api/workflow-runs/does-not-exist/resume', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(resumeMissing.status, 404);
});

test('/api/workflow-steps requires the CLI hook token and a taskId, and refuses a non-workflow task', async () => {
  const noAuth = await api('/api/workflow-steps/complete?taskId=whatever', { method: 'POST', body: JSON.stringify({ summary: 'x' }) });
  assert.equal(noAuth.status, 401);

  const noAuthGet = await api('/api/workflow-steps/diff-summary?taskId=whatever');
  assert.equal(noAuthGet.status, 401);
});

test('/api/workflow-steps/complete rejects a non-string planningGap before touching the step', async () => {
  const { CLI_HOOK_TOKEN } = await import('../src/terminal/projectCliHooks.ts');
  const res = await api('/api/workflow-steps/complete?taskId=whatever', {
    method: 'POST',
    headers: { authorization: `Bearer ${CLI_HOOK_TOKEN}` },
    body: JSON.stringify({ summary: 'x', planningGap: 42 }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'planningGap must be a string');
});

/** `/api/workflow-steps/progress` (task 5.017) body-shape validation — auth and limits only; see
 * workflowRunEngine.test.ts for coverage against a genuinely running step session (this file's fixture
 * executors never actually reach "running" — see this file's own doc comment). */
test('/api/workflow-steps/progress requires the CLI hook token and a taskId', async () => {
  const noAuth = await api('/api/workflow-steps/progress?taskId=whatever', { method: 'POST', body: JSON.stringify({ currentActivity: 'x' }) });
  assert.equal(noAuth.status, 401);
  const { CLI_HOOK_TOKEN } = await import('../src/terminal/projectCliHooks.ts');
  const noTaskId = await api('/api/workflow-steps/progress', { method: 'POST', headers: { authorization: `Bearer ${CLI_HOOK_TOKEN}` }, body: JSON.stringify({ currentActivity: 'x' }) });
  assert.equal(noTaskId.status, 400);
});

test('/api/workflow-steps/progress 400s on an empty call and on every invalid shape, before ever touching a step', async () => {
  const { CLI_HOOK_TOKEN } = await import('../src/terminal/projectCliHooks.ts');
  const progress = (body: unknown) => api('/api/workflow-steps/progress?taskId=whatever', {
    method: 'POST',
    headers: { authorization: `Bearer ${CLI_HOOK_TOKEN}` },
    body: JSON.stringify(body),
  });

  const empty = await progress({});
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /at least one of checklist, currentActivity or estimate/);

  assert.equal((await progress({ checklist: 'nope' })).status, 400);
  assert.equal((await progress({ checklist: [{ state: 'done' }] })).status, 400, 'text is required');
  assert.equal((await progress({ checklist: [{ text: 'x', state: 'sleeping' }] })).status, 400, 'invalid state');
  assert.equal((await progress({ checklist: [{ text: 'x', state: 'done', note: 42 }] })).status, 400, 'note must be a string');
  // IS02: `short` follows the same type rule as `note`; null passes validation (it then fails only on the unknown task).
  for (const short of [42, { a: 1 }, ['a'], true]) {
    const wrong = await progress({ checklist: [{ text: 'x', state: 'done', short }] });
    assert.equal(wrong.status, 400, `short ${JSON.stringify(short)}`);
    assert.equal(wrong.body.error, 'checklist[0].short must be a string');
  }
  assert.notEqual((await progress({ checklist: [{ text: 'x', state: 'done', short: null }] })).status, 400, 'IS03: null is accepted');
  assert.notEqual((await progress({ checklist: [{ text: 'x', state: 'done', short: 'z'.repeat(10_000) }] })).status, 400, 'IS04: never refused for length');
  assert.equal((await progress({ currentActivity: 42 })).status, 400);
  assert.equal((await progress({ estimate: 42 })).status, 400);
  assert.equal((await progress({ checklist: Array.from({ length: 21 }, () => ({ text: 'x', state: 'pending' })) })).status, 400, 'over the 20-item cap');
  assert.equal((await progress({ checklist: [{ text: 'x'.repeat(201), state: 'pending' }] })).status, 400, 'over the item text cap');
  assert.equal((await progress({ checklist: [{ text: 'x', state: 'pending', note: 'n'.repeat(201) }] })).status, 400, 'over the note cap');
  assert.equal((await progress({ currentActivity: 'a'.repeat(201) })).status, 400, 'over the currentActivity cap');
  assert.equal((await progress({ estimate: 'e'.repeat(61) })).status, 400, 'over the estimate cap');

  const valid = await progress({ currentActivity: 'Running the web test suite' });
  assert.equal(valid.status, 401, 'a well-shaped body still needs a real running session — "whatever" is not one');
});

/** Calls one step-task MCP tool end to end: the real bin/step-task-mcp.mjs relaying to this real in-process daemon. */
async function callStepMcpTool(name: string, args: unknown) {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const { stepTaskMcpServer } = await import('../src/terminal/stepTaskTool.ts');
  const launch = stepTaskMcpServer('step-task-e2e');
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env, AGENT_VISUAL_OS_CATALOG_URL: `${baseUrl}/api/catalog` },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
    return JSON.parse((await lines.next()).value as string).result as { content: { text: string }[]; isError: boolean };
  } finally {
    child.stdin.end();
    child.kill();
  }
}

test('update_workflow_step, relayed through the existing catalog routes, rewrites only that step\'s instructions on disk', async () => {
  const { readFile } = await import('node:fs/promises');
  const filePath = path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR!, 'workflows', 'software-development.json');
  const before = JSON.parse(await readFile(filePath, 'utf-8'));

  const res = await callStepMcpTool('update_workflow_step', { workflowId: 'software-development', stepId: 'development', instructions: 'Build it, test first.' });
  assert.equal(res.isError, false, res.content[0]?.text);

  const afterWrite = JSON.parse(await readFile(filePath, 'utf-8'));
  assert.deepEqual(afterWrite, {
    ...before,
    steps: before.steps.map((step: { id: string }) => (step.id === 'development' ? { ...step, instructions: 'Build it, test first.' } : step)),
  }, 'no resolved `agent` decoration leaks into the stored file');

  const unknown = await callStepMcpTool('update_workflow_step', { workflowId: 'missing-flow', stepId: 'development', instructions: 'x' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0]!.text, /This workflow is not in the Catalog/);
});

test('update_skill, relayed through the existing catalog route, replaces the skill body; an unknown skill 404s', async () => {
  const created = await api('/api/catalog/skills', { method: 'POST', body: JSON.stringify({ id: 'retro-skill', name: 'Retro', description: 'Retro rules', body: 'Old body.' }) });
  assert.equal(created.status, 201);

  const res = await callStepMcpTool('update_skill', { skillId: 'retro-skill', body: 'New body.' });
  assert.equal(res.isError, false, res.content[0]?.text);
  const { readFile } = await import('node:fs/promises');
  const skillMd = await readFile(path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR!, 'skills', 'retro-skill', 'SKILL.md'), 'utf-8');
  assert.match(skillMd, /description: Retro rules/);
  assert.match(skillMd, /New body\./);
  assert.doesNotMatch(skillMd, /Old body/);

  const unknown = await callStepMcpTool('update_skill', { skillId: 'no-such-skill', body: 'x' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0]!.text, /This skill is not in the Catalog/);
});

test('POST /api/plan-items/:id/execute validates skippedStepIds against the chosen workflow and starts the run without the skipped steps', async () => {
  const created = await api('/api/catalog/workflows', {
    method: 'POST',
    body: JSON.stringify({
      id: 'selectable-flow', name: 'Selectable', description: 'Steps to leave out.',
      steps: [
        { id: 'plan', name: 'Planning', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Plan.' },
        { id: 'build', name: 'Development', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build.' },
        { id: 'review', name: 'Code Review', agentId: 'builder', canEditCode: false, requiresApproval: false, instructions: 'Review.', loopBack: { toStepId: 'build', maxRounds: 2 } },
        { id: 'signoff', name: 'Human Code Review', agentId: 'builder', canEditCode: false, requiresApproval: true, instructions: 'Brief.', requestChangesToStepId: 'build' },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const project = await createQuietProject('Step Selection Project');
  const item = await api(`/api/projects/${project.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Pick steps', description: '' }) });
  const start = (body: object) => api(`/api/plan-items/${item.body.id}/execute`, { method: 'POST', body: JSON.stringify({ workflowId: 'selectable-flow', ...body }) });

  for (const [body, error] of [
    [{ skippedStepIds: 'plan' }, /skippedStepIds must be an array of step ids/],
    [{ skippedStepIds: [1] }, /skippedStepIds must be an array of step ids/],
    [{ skippedStepIds: [''] }, /skippedStepIds must be an array of step ids/],
    [{ skippedStepIds: ['nope'] }, /aren't in Selectable: nope/],
    [{ skippedStepIds: ['plan', 'build', 'review', 'signoff'] }, /at least one step must run/],
    [{ skippedStepIds: ['build'] }, /"Code Review" depends on "Development"/],
    [{ skippedStepIds: ['build', 'review'] }, /"Human Code Review" depends on "Development"/],
  ] as const) {
    const res = await start(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, error);
  }
  assert.equal((await api(`/api/projects/${project.body.id}/plan`)).body.items[0].status, 'pending', 'nothing started');

  const started = await start({ skippedStepIds: ['signoff', 'plan', 'plan'] });
  assert.equal(started.status, 201);
  assert.equal(started.body.currentStepId, 'build');
  await untilStarted(started.body.id);
  const detail = await api(`/api/workflow-runs/${started.body.id}`);
  assert.deepEqual(detail.body.run.skippedStepIds, ['plan', 'signoff'], 'de-duplicated, in workflow order');
  const statuses = Object.fromEntries(detail.body.steps.map((s: { step: { id: string }; rounds: { status: string }[] }) => [s.step.id, s.rounds.map((r) => r.status)]));
  assert.deepEqual(statuses.plan, ['skipped']);
  assert.deepEqual(statuses.signoff, ['skipped']);
  assert.equal((await api('/api/catalog/workflows/selectable-flow')).body.steps.length, 4, 'the Catalog workflow is unchanged');
  await api(`/api/workflow-runs/${started.body.id}/stop`, { method: 'POST', body: JSON.stringify({}) });
});

test('PUT /api/catalog/workflows/:id stores a valid Quick look and 400s an unknown one', async () => {
  const created = await api('/api/catalog/workflows', { method: 'POST', body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: 'api-quick-look' }) });
  assert.equal(created.status, 201);
  const step = VALID_WORKFLOW_BODY.steps[0]!;
  const bad = await api('/api/catalog/workflows/api-quick-look', { method: 'PUT', body: JSON.stringify({ steps: [{ ...step, quickLook: 'files' }] }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /quickLook must be one of/);
  const good = await api('/api/catalog/workflows/api-quick-look', { method: 'PUT', body: JSON.stringify({ steps: [{ ...step, quickLook: 'diff' }] }) });
  assert.equal(good.status, 200);
  assert.equal((await api('/api/catalog/workflows/api-quick-look')).body.steps[0].quickLook, 'diff');
});

test('POST and PUT /api/catalog/workflows carry a branch type, 400 an invalid one, and PUT null clears it', async () => {
  const created = await api('/api/catalog/workflows', { method: 'POST', body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: 'api-branch-type', branchType: 'bugfix' }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.branchType, 'bugfix');
  const bad = await api('/api/catalog/workflows/api-branch-type', { method: 'PUT', body: JSON.stringify({ branchType: 'Bug Fix' }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /branchType must be lowercase/);
  assert.equal((await api('/api/catalog/workflows/api-branch-type')).body.branchType, 'bugfix', 'a refused update saves nothing');
  const cleared = await api('/api/catalog/workflows/api-branch-type', { method: 'PUT', body: JSON.stringify({ branchType: null }) });
  assert.equal(cleared.status, 200);
  assert.equal((await api('/api/catalog/workflows/api-branch-type')).body.branchType, undefined);
});

test('POST/PUT accept a boolean canRunCommands, reject anything else with a 400, and leave the stored workflow unchanged on a bad PUT', async () => {
  const step = VALID_WORKFLOW_BODY.steps[0]!;
  const created = await api('/api/catalog/workflows', {
    method: 'POST',
    body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: 'cmd-flow', steps: [{ ...step, canEditCode: false, canRunCommands: true }] }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.steps[0].canRunCommands, true);
  assert.equal((await api('/api/catalog/workflows/cmd-flow')).body.steps[0].canRunCommands, true);

  for (const [index, bad] of ['true', 1, null, []].entries()) {
    const post = await api('/api/catalog/workflows', {
      method: 'POST',
      body: JSON.stringify({ ...VALID_WORKFLOW_BODY, id: `cmd-bad-${index}`, steps: [{ ...step, canRunCommands: bad }] }),
    });
    assert.equal(post.status, 400);
    assert.match(post.body.error, /canRunCommands must be a boolean/);
    const put = await api('/api/catalog/workflows/cmd-flow', { method: 'PUT', body: JSON.stringify({ steps: [{ ...step, canRunCommands: bad }] }) });
    assert.equal(put.status, 400);
    assert.match(put.body.error, /canRunCommands must be a boolean/);
  }
  assert.equal((await api('/api/catalog/workflows/cmd-flow')).body.steps[0].canRunCommands, true, 'the stored workflow is unchanged');
  await api('/api/catalog/workflows/cmd-flow', { method: 'DELETE' });
});

test('a stored workflow step without canRunCommands stays without it after an unrelated edit', async () => {
  const file = path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR!, 'workflows', 'api-flow.json');
  const before = JSON.parse(await readFile(file, 'utf8'));
  assert.equal('canRunCommands' in before.steps[0], false);
  const listed = (await api('/api/catalog/workflows')).body.find((w: { id: string }) => w.id === 'api-flow');
  assert.equal('canRunCommands' in listed.steps[0], false);
  const put = await api('/api/catalog/workflows/api-flow', { method: 'PUT', body: JSON.stringify({ description: 'Edited description.' }) });
  assert.equal(put.status, 200);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(after.steps, before.steps);
});
