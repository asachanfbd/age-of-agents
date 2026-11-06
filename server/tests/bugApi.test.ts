import { createQuietProject } from './helpers/quietProject.ts';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { PlanItemRecord, TaskRecord } from '../src/domain/types.ts';

/**
 * The bug tracker's routes: statuses and `{ error }` bodies. No CLI is ever started here — a running
 * session is a TaskRecord inserted straight into the database, as api.test.ts does. What the tools
 * do once allowed is covered against a fake terminal in bugTracker.test.ts.
 */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let token: string;
const titled: string[] = [];
let collections: typeof import('../src/db/collections.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'bug-api-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  const { createDaemonServer } = await import('../src/server.ts');
  const { createPlanItemTitler } = await import('../src/projects/planItemTitler.ts');
  token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
  collections = await import('../src/db/collections.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  // No real CLI names anything: the background titler is replaced.
  server = createDaemonServer({ planItemTitler: { ...createPlanItemTitler(), requestTitle: (item: { id: string }) => { titled.push(item.id); }, requestSessionTitle: () => {} } });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(pathname: string, init: RequestInit & { auth?: string | null } = {}) {
  const { auth, ...rest } = init;
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: `Bearer ${auth ?? token}` }), ...rest.headers },
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body };
}

const send = (method: string, pathname: string, body?: unknown, init: { auth?: string | null } = {}) =>
  api(pathname, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...init });

/** A refusal: the status, and an `{ error }` body with a message. */
function assertRefused(res: { status: number; body: any }, status: number, what?: string | RegExp) {
  assert.equal(res.status, status, typeof what === 'string' ? what : undefined);
  assert.equal(typeof res.body?.error, 'string');
  assert.ok(res.body.error.length > 0);
  if (what instanceof RegExp) assert.match(res.body.error, what);
}

let counter = 0;

async function newProject(): Promise<string> {
  return (await createQuietProject(`Bug API ${++counter}`)).body.id;
}

/** Inserts a Task as the daemon would hold it mid-run, and puts a developing one in its Project's active set. */
async function insertTask(projectId: string, patch: Partial<TaskRecord>): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const id = `task-${++counter}`;
  const task = await collections.tasksDb.insert({
    id, projectId, templateId: 'builder', executorId: 'test-claude-cli', executionMode: 'terminal', description: 'A session',
    status: 'developing', autonomy: 'auto', manager: false, kind: 'execute', planItemId: null, sessionId: id,
    blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: null, ...patch,
  });
  if (task.status === 'developing') {
    const project = (await collections.projectsDb.get(projectId))!;
    await collections.projectsDb.update(projectId, { activeTaskIds: [...project.activeTaskIds, task.id] });
  }
  return task;
}

const reportSession = (projectId: string, planningSessionNumber: number, patch: Partial<TaskRecord> = {}) =>
  insertTask(projectId, { kind: 'plan', planningPurpose: 'bug-report', planningSessionNumber, planningCreatedTaskCount: 0, ...patch });

async function startedTask(projectId: string, title: string): Promise<PlanItemRecord> {
  const item = await planItemService.createPlanItem({ projectId, title, description: '' });
  return (await collections.planItemsDb.update(item.id, { status: 'done' }))!;
}

const bugsOf = async (projectId: string) => (await planItemService.listPlanItems(projectId)).filter((item) => item.type === 'bug');
const REPORT = { title: 'Crash on save', infoStatus: 'needs-more-info' };

// ---- Types and creation paths ----

test('I1 I4 the task routes create a task whatever type the body names, and never change a type', async () => {
  const projectId = await newProject();
  const created = await send('POST', `/api/projects/${projectId}/plan-items`, { title: 'Looks like a bug', description: 'x', type: 'bug', bug: { severity: 'high' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.type, 'task');
  assert.equal('bug' in created.body, false);

  const patched = await send('PATCH', `/api/plan-items/${created.body.id}`, { title: 'Renamed', type: 'bug' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.type, 'task');
  assert.equal((await planItemService.getPlanItem(created.body.id)).type, 'task');

  const session = await reportSession(projectId, 1);
  const bug = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body;
  assert.equal((await send('PATCH', `/api/plan-items/${bug.id}`, { title: 'B.001: Still a bug', type: 'task' })).body.type, 'bug');
  const plan = await send('GET', `/api/projects/${projectId}/plan`);
  assert.deepEqual(plan.body.items.map((item: PlanItemRecord) => item.type), ['task', 'bug']);
});

// ---- Report session lifecycle ----

test('I8 I14 POST /plan-and-bugs with no agent creates a not-started session; a blank or over-long description is 400', async () => {
  const projectId = await newProject();
  const created = await send('POST', `/api/projects/${projectId}/plan-and-bugs`, { description: '  The note vanished  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.kind, 'plan');
  assert.equal(created.body.planningPurpose, 'plan-and-bugs');
  assert.equal(created.body.cliNotStarted, true);
  assert.equal(created.body.status, 'stopped');
  assert.equal(created.body.planningSessionNumber, 1);
  assert.equal(created.body.description, 'The note vanished');

  assertRefused(await send('POST', `/api/projects/${projectId}/plan-and-bugs`, { description: '   ' }), 400, /description is required/);
  assertRefused(await send('POST', `/api/projects/${projectId}/plan-and-bugs`, {}), 400, /description is required/);
  assertRefused(await send('POST', `/api/projects/${projectId}/plan-and-bugs`, { description: 'd'.repeat(20_001) }), 400, /at most 20,000/);
  assert.equal((await send('POST', `/api/projects/${projectId}/plan-and-bugs`, { description: 'd'.repeat(20_000) })).status, 201);
  assertRefused(await send('POST', '/api/projects/no-such-project/plan-and-bugs', { description: 'x' }), 404);
  assert.equal((await send('GET', `/api/projects/${projectId}/tasks`)).body.length, 2, 'only the two accepted sessions exist');
});

test('I9 I11 a not-started description is editable until the CLI starts; a refused agent leaves the session not started', async () => {
  const projectId = await newProject();
  const session = (await send('POST', `/api/projects/${projectId}/plan-and-bugs`, { description: 'First' })).body;

  const edited = await send('PATCH', `/api/tasks/${session.id}/description`, { description: ' Second ' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.description, 'Second');
  assert.equal((await send('GET', `/api/tasks/${session.id}`)).body.description, 'Second', 'it persists');
  assertRefused(await send('PATCH', `/api/tasks/${session.id}/description`, { description: 'd'.repeat(20_001) }), 400);
  assertRefused(await send('PATCH', `/api/tasks/${session.id}/description`, { description: '' }), 400);
  assertRefused(await send('PATCH', '/api/tasks/no-such-task/description', { description: 'x' }), 404);

  assertRefused(await send('POST', `/api/tasks/${session.id}/start-session`, {}), 400, /executorId is required/);
  assertRefused(await send('POST', `/api/tasks/${session.id}/start-session`, { executorId: 'no-such-agent' }), 404);
  assertRefused(await send('POST', `/api/tasks/${session.id}/start-session`, { executorId: 'test-unsupported' }), 422);
  const still = (await send('GET', `/api/tasks/${session.id}`)).body;
  assert.equal(still.cliNotStarted, true);
  assert.equal(still.status, 'stopped');

  // A session whose CLI has started refuses both.
  const running = await reportSession(projectId, 9);
  assertRefused(await send('PATCH', `/api/tasks/${running.id}/description`, { description: 'Too late' }), 409, /already started/);
  assertRefused(await send('POST', `/api/tasks/${running.id}/start-session`, { executorId: 'test-claude-cli' }), 409, /already started/);
});

// ---- Report session tools ----

test('I18 I19 I20 a report is validated before anything is created: 400 with a reason, and each field passes at its limit', async () => {
  const projectId = await newProject();
  const introducer = await startedTask(projectId, '4.002: Add login');
  const session = await reportSession(projectId, 1);
  const create = (body: unknown) => send('POST', `/api/agent-bugs?taskId=${session.id}`, body);

  assertRefused(await create({ infoStatus: 'enough' }), 400, /title is required/);
  assertRefused(await create({ ...REPORT, title: '   ' }), 400, /title is required/);
  assertRefused(await create({ ...REPORT, title: 't'.repeat(201) }), 400, /title must be at most 200/);
  assertRefused(await create({ ...REPORT, summary: 's'.repeat(20_001) }), 400, /description must be at most 20,000/);
  assertRefused(await create({ ...REPORT, suspectedLocation: 'l'.repeat(501) }), 400, /suspectedLocation must be at most 500/);
  assertRefused(await create({ ...REPORT, introducedByTaskId: introducer.id, commit: 'c'.repeat(65) }), 400, /commit must be at most 64/);
  assertRefused(await create({ ...REPORT, severity: 'High' }), 400, /severity must be one of/);
  assertRefused(await create({ ...REPORT, infoStatus: 'needs_more_info' }), 400, /infoStatus must be one of/);
  assertRefused(await create({ title: 'No info status' }), 400, /infoStatus must be one of/);
  assertRefused(await create({ ...REPORT, title: 42 }), 400, /title must be text/);
  assert.deepEqual(await bugsOf(projectId), [], 'nothing was created');

  assert.equal((await create({ ...REPORT, title: 't'.repeat(200) })).status, 201);
  assert.equal((await create({ ...REPORT, suspectedLocation: 'l'.repeat(500) })).status, 201);
  assert.equal((await create({ ...REPORT, introducedByTaskId: introducer.id, commit: 'c'.repeat(64) })).status, 201);
  // The composed description is what has the limit: a summary that fits with the other four sections.
  const overhead = (await bugsOf(projectId))[0]!.description.length - 'Unknown'.length;
  assert.equal((await create({ ...REPORT, summary: 's'.repeat(20_000 - overhead) })).status, 201);
  assertRefused(await create({ ...REPORT, summary: 's'.repeat(20_000 - overhead + 1) }), 400);
  assert.equal((await bugsOf(projectId)).length, 4);
});

test('I21 I23 I24 who may call the report tools, and which introducing task they may name', async () => {
  const projectId = await newProject();
  const otherProjectId = await newProject();
  const foreign = await startedTask(otherProjectId, '9.001: Foreign');
  const neverStarted = await planItemService.createPlanItem({ projectId, title: '4.009: Not started', description: '' });
  const session = await reportSession(projectId, 1);

  assertRefused(await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT, { auth: null }), 401);
  assertRefused(await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT, { auth: 'wrong-token' }), 401);
  assertRefused(await send('GET', `/api/agent-bugs?taskId=${session.id}`, undefined, { auth: null }), 401);
  assertRefused(await send('POST', '/api/agent-bugs', REPORT), 400, /taskId is required/);
  assertRefused(await send('GET', '/api/agent-bugs'), 400, /taskId is required/);

  const planning = await insertTask(projectId, { kind: 'plan', planningSessionNumber: 2 });
  const coding = await insertTask(projectId, { kind: 'execute' });
  const finished = await reportSession(projectId, 3, { status: 'stopped' });
  for (const caller of [planning, coding, finished]) {
    assertRefused(await send('POST', `/api/agent-bugs?taskId=${caller.id}`, REPORT), 409, /Only a running bug report session/);
    assertRefused(await send('GET', `/api/agent-bugs?taskId=${caller.id}`), 409);
  }
  assertRefused(await send('POST', '/api/agent-bugs?taskId=no-such-task', REPORT), 404);

  const create = (introducedByTaskId: string) => send('POST', `/api/agent-bugs?taskId=${session.id}`, { ...REPORT, introducedByTaskId });
  assertRefused(await create('no-such-task'), 404);
  assertRefused(await create(foreign.id), 404, 'another Project\'s task');
  assertRefused(await create(neverStarted.id), 400, /has not started yet/);
  assert.deepEqual(await bugsOf(projectId), []);

  const listed = await send('GET', `/api/agent-bugs?taskId=${session.id}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((item: PlanItemRecord) => item.id), [neverStarted.id]);
  assert.equal(JSON.stringify(listed.body).includes(foreign.id), false);
  assert.equal(JSON.stringify(listed.body).includes('Foreign'), false);
});

test('I26 I27 I28 I29 I30 updating and deleting: 200 and 204 for the session\'s own ready bug, 400, 404 and 409 otherwise', async () => {
  const projectId = await newProject();
  const session = await reportSession(projectId, 1);
  const otherSession = await reportSession(projectId, 2);
  const mine = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;
  const theirs = (await send('POST', `/api/agent-bugs?taskId=${otherSession.id}`, REPORT)).body as PlanItemRecord;
  const ordinary = await planItemService.createPlanItem({ projectId, title: 'Ordinary', description: '' });
  const patch = (id: string, body: unknown, caller = session.id) => send('PATCH', `/api/agent-bugs/${id}?taskId=${caller}`, body);
  const remove = (id: string, caller = session.id) => send('DELETE', `/api/agent-bugs/${id}?taskId=${caller}`);

  const updated = await patch(mine.id, { severity: 'low', title: 'Crash on second save' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.bug.severity, 'low');
  assert.equal(updated.body.title, 'B.001: Crash on second save');

  assertRefused(await patch(mine.id, {}), 400, /at least one field/);
  assertRefused(await patch(mine.id, { title: 't'.repeat(201) }), 400);
  assertRefused(await patch(mine.id, { infoStatus: 'maybe' }), 400);
  for (const id of [theirs.id, 'no-such-item']) {
    assertRefused(await patch(id, { severity: 'low' }), 404);
    assertRefused(await remove(id), 404);
  }
  assertRefused(await patch(ordinary.id, { severity: 'low' }), 409, /not a bug/);
  assertRefused(await remove(ordinary.id), 409, /not a bug/);
  assertRefused(await patch(mine.id, { severity: 'low' }, 'no-such-task'), 404);
  assertRefused(await remove(mine.id, session.id.replace('task-', 'missing-')), 404);
  assertRefused(await send('PATCH', `/api/agent-bugs/${mine.id}?taskId=${session.id}`, { severity: 'low' }, { auth: null }), 401);

  await collections.planItemsDb.update(theirs.id, { status: 'developing' });
  assertRefused(await patch(theirs.id, { severity: 'low' }, otherSession.id), 409, /already started/);
  assertRefused(await remove(theirs.id, otherSession.id), 409, /already started/);

  const removed = await remove(mine.id);
  assert.equal(removed.status, 204);
  assert.equal(removed.body, undefined);
  assert.deepEqual((await bugsOf(projectId)).map((bug) => bug.id), [theirs.id]);
});

test('I35 a planning session\'s update_task and delete_task refuse a bug with 409', async () => {
  const projectId = await newProject();
  const session = await reportSession(projectId, 1);
  const planning = await insertTask(projectId, { kind: 'plan', planningSessionNumber: 2 });
  const bug = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;

  const listed = await send('GET', `/api/agent-tasks?taskId=${planning.id}`);
  assert.ok(listed.body.some((item: PlanItemRecord) => item.id === bug.id && item.type === 'bug'));
  assertRefused(await send('PATCH', `/api/agent-tasks/${bug.id}?taskId=${planning.id}`, { title: 'Hijacked' }), 409, /is a bug, not a planning task/);
  assertRefused(await send('DELETE', `/api/agent-tasks/${bug.id}?taskId=${planning.id}`), 409);
  assertRefused(await send('POST', `/api/agent-tasks?taskId=${session.id}`, { title: 'T', description: '' }), 409, 'a report session has no planning task tools');
  assert.equal((await planItemService.getPlanItem(bug.id)).title, 'B.001: Crash on save');
});

// ---- The Info flag ----

test('I37 PATCH /plan-items/:id infoStatus: 200 on a ready bug, 400 for a bad value or a task, 409 once started', async () => {
  const projectId = await newProject();
  const session = await reportSession(projectId, 1);
  const bug = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;
  const task = await planItemService.createPlanItem({ projectId, title: 'Ordinary', description: '' });

  const flipped = await send('PATCH', `/api/plan-items/${bug.id}`, { infoStatus: 'enough' });
  assert.equal(flipped.status, 200);
  assert.equal(flipped.body.bug.infoStatus, 'enough');
  assertRefused(await send('PATCH', `/api/plan-items/${bug.id}`, { infoStatus: 'Enough info' }), 400, /infoStatus must be one of/);
  assertRefused(await send('PATCH', `/api/plan-items/${task.id}`, { infoStatus: 'enough' }), 400, /only a bug/);
  await collections.planItemsDb.update(bug.id, { status: 'developing' });
  assertRefused(await send('PATCH', `/api/plan-items/${bug.id}`, { infoStatus: 'needs-more-info' }), 409, /already started/);
  assert.equal((await planItemService.getPlanItem(bug.id)).bug!.infoStatus, 'enough');

  // A refused Info status change saves nothing else sent with it.
  const startedBefore = await planItemService.getPlanItem(bug.id);
  assertRefused(await send('PATCH', `/api/plan-items/${bug.id}`, { title: 'Renamed', description: 'Rewritten', infoStatus: 'needs-more-info' }), 409);
  assert.deepEqual(await planItemService.getPlanItem(bug.id), startedBefore);
  const taskBefore = await planItemService.getPlanItem(task.id);
  assertRefused(await send('PATCH', `/api/plan-items/${task.id}`, { title: 'Renamed', infoStatus: 'enough' }), 400);
  assert.deepEqual(await planItemService.getPlanItem(task.id), taskBefore);
  assertRefused(await send('PATCH', `/api/plan-items/${task.id}`, { title: 'Renamed', infoStatus: 'nonsense' }), 400);
  assert.deepEqual(await planItemService.getPlanItem(task.id), taskBefore);

  // An allowed one saves both.
  const ready = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;
  const both = await send('PATCH', `/api/plan-items/${ready.id}`, { title: 'B.002: Renamed', infoStatus: 'enough' });
  assert.equal(both.status, 200);
  assert.equal(both.body.title, 'B.002: Renamed');
  assert.equal(both.body.bug.infoStatus, 'enough');
});

// ---- Reorder routes ----

test('I53 I54 I55 I56 PUT /planning-queue/bugs/:introducerId/order: 204, 400 malformed, 404 unknown, 409 conflicting', async () => {
  const projectId = await newProject();
  const otherProjectId = await newProject();
  const introducer = await startedTask(projectId, '4.002: Add login');
  const foreignIntroducer = await startedTask(otherProjectId, '9.001: Foreign');
  const session = await reportSession(projectId, 1);
  const foreignSession = await reportSession(otherProjectId, 1);
  const file = async (caller: TaskRecord, introducedByTaskId?: string) => (await send('POST', `/api/agent-bugs?taskId=${caller.id}`, { ...REPORT, introducedByTaskId })).body as PlanItemRecord;
  const [a, b] = [await file(session, introducer.id), await file(session, introducer.id)];
  const standalone = await file(session);
  const foreignBug = await file(foreignSession, foreignIntroducer.id);
  const order = (introducerId: string, ids: unknown) => send('PUT', `/api/projects/${projectId}/planning-queue/bugs/${introducerId}/order`, { ids });
  const stored = async () => Promise.all([a, b].map(async (bug) => (await planItemService.getPlanItem(bug.id)).bug!.groupOrder));

  const saved = await order(introducer.id, [b.id, a.id]);
  assert.equal(saved.status, 204);
  assert.deepEqual(await stored(), [1, 0]);

  assertRefused(await order(introducer.id, 'nope'), 400, /ids must be an array/);
  assertRefused(await order(introducer.id, [a.id, 7]), 400);
  assertRefused(await order(introducer.id, [a.id, a.id]), 400);
  assertRefused(await order('no-such-task', [a.id, b.id]), 404);
  assertRefused(await order(foreignIntroducer.id, [foreignBug.id]), 404, 'another Project\'s introducing task');
  assertRefused(await order(introducer.id, [a.id, b.id, 'no-such-bug']), 404);
  assertRefused(await order(introducer.id, [a.id, b.id, foreignBug.id]), 404, 'another Project\'s bug');
  assertRefused(await order(introducer.id, [a.id, b.id, standalone.id]), 409);
  assertRefused(await order(introducer.id, [a.id]), 409);
  assertRefused(await send('PUT', `/api/projects/no-such-project/planning-queue/bugs/${introducer.id}/order`, { ids: [] }), 404);
  assert.deepEqual(await stored(), [1, 0], 'the order is unchanged after every refusal');
});

test('I59 I60 PUT /planning-queue/order with reference entries: 204, 400 for an unknown kind, 404 and 409 otherwise', async () => {
  const projectId = await newProject();
  const introducer = await startedTask(projectId, '4.002: Add login');
  const session = await reportSession(projectId, 1);
  const bug = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, { ...REPORT, introducedByTaskId: introducer.id })).body as PlanItemRecord;
  const standalone = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;
  const order = (entries: unknown) => send('PUT', `/api/projects/${projectId}/planning-queue/order`, { entries });
  const full = [{ kind: 'task', id: standalone.id }, { kind: 'reference', id: introducer.id }, { kind: 'session', id: session.id }];

  assert.equal((await order(full)).status, 204);
  assert.equal((await planItemService.getPlanItem(standalone.id)).planningQueueOrder, 0);
  assert.equal((await planItemService.getPlanItem(bug.id)).planningQueueOrder, 1);

  assertRefused(await order([...full, { kind: 'bug', id: bug.id }]), 400, /entries must contain/);
  assertRefused(await order('nope'), 400);
  assertRefused(await order([{ kind: 'reference' }]), 400);
  assertRefused(await order([...full.slice(0, 1), { kind: 'reference', id: 'no-such-task' }, full[2]]), 404);
  assertRefused(await order([full[0], full[2]]), 409, 'a top-level reference left out');
  assertRefused(await order([...full, { kind: 'reference', id: introducer.id }]), 409, 'the same reference twice');
  assert.equal((await planItemService.getPlanItem(bug.id)).planningQueueOrder, 1);
});

// ---- Agent-found bugs ----

const AGENT_BUG = { title: 'Flaky date test', suiteId: 'server', actionId: 'tests', caseId: 'formats dates', description: 'AssertionError: expected 1 got 2' };

test('I65 I70 POST /agent-testing/bugs: 201 for a new bug, then 200 flagged existing for the same test case', async () => {
  const projectId = await newProject();
  const task = await insertTask(projectId, {});
  const file = (body: unknown = AGENT_BUG, caller = task.id) => send('POST', `/api/agent-testing/bugs?taskId=${caller}`, body);

  const created = await file();
  assert.equal(created.status, 201);
  assert.equal(created.body.existing, false);
  assert.equal(created.body.bug.type, 'bug');
  assert.equal(created.body.bug.bug.infoStatus, 'needs-more-info');
  assert.equal(created.body.bug.bug.introducedBy, null);

  const again = await file();
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.bug.id, created.body.bug.id);
  assert.equal((await bugsOf(projectId)).length, 1);
});

test('I68 I69 an agent bug missing a field or over a limit is 400, and nothing is created or truncated', async () => {
  const projectId = await newProject();
  const task = await insertTask(projectId, {});
  const file = (body: unknown) => send('POST', `/api/agent-testing/bugs?taskId=${task.id}`, body);

  for (const field of Object.keys(AGENT_BUG)) {
    assertRefused(await file({ ...AGENT_BUG, [field]: undefined }), 400, new RegExp(`${field} is required`));
    assertRefused(await file({ ...AGENT_BUG, [field]: '  ' }), 400, new RegExp(`${field} is required`));
  }
  assertRefused(await file({ ...AGENT_BUG, title: 't'.repeat(201) }), 400, /title must be at most 200/);
  assertRefused(await file({ ...AGENT_BUG, description: 'd'.repeat(18_001) }), 400, /description must be at most 18,000/);
  assertRefused(await file({ ...AGENT_BUG, caseId: 'c'.repeat(501) }), 400, /caseId must be at most 500/);
  assertRefused(await file(undefined), 400);
  assert.deepEqual(await bugsOf(projectId), []);
});

test('an agent bug at its advertised limits is accepted: the longest description with the longest test ids still composes within 20,000', async () => {
  const projectId = await newProject();
  const task = await insertTask(projectId, {});
  const longest = { title: 't'.repeat(200), suiteId: 's'.repeat(200), actionId: 'a'.repeat(200), caseId: 'c'.repeat(500), description: 'd'.repeat(18_000) };
  const created = await send('POST', `/api/agent-testing/bugs?taskId=${task.id}`, longest);
  assert.equal(created.status, 201);
  assert.ok(created.body.bug.description.length <= 20_000);
  assert.ok(created.body.bug.description.includes('d'.repeat(18_000)), 'nothing was cut');
  assertRefused(await send('POST', `/api/agent-testing/bugs?taskId=${task.id}`, { ...longest, caseId: 'other', description: 'd'.repeat(18_001) }), 400, /at most 18,000/);
  assert.equal((await bugsOf(projectId)).length, 1);
});

test('I66 I67 I75 only a developing, active coding session may file, and the tool has no read, update or delete route', async () => {
  const projectId = await newProject();
  const file = (caller: string, init: { auth?: string | null } = {}) => send('POST', `/api/agent-testing/bugs?taskId=${caller}`, AGENT_BUG, init);
  const coding = await insertTask(projectId, {});

  assertRefused(await file(coding.id, { auth: null }), 401);
  assertRefused(await file(coding.id, { auth: 'wrong-token' }), 401);
  assertRefused(await send('POST', '/api/agent-testing/bugs', AGENT_BUG), 400, /taskId is required/);
  assertRefused(await file('no-such-task'), 404);
  assertRefused(await file((await insertTask(projectId, { kind: 'plan', planningSessionNumber: 1 })).id), 409, /Only a running coding session/);
  assertRefused(await file((await reportSession(projectId, 2)).id), 409);
  for (const status of ['done', 'stopped', 'failed', 'blocked'] as const) assertRefused(await file((await insertTask(projectId, { status })).id), 409, status);
  const inactive = await insertTask(projectId, {});
  await collections.projectsDb.update(projectId, { activeTaskIds: [coding.id] });
  assertRefused(await file(inactive.id), 409, 'developing but not in activeTaskIds');
  assert.deepEqual(await bugsOf(projectId), []);

  const bug = (await file(coding.id)).body.bug as PlanItemRecord;
  for (const [method, pathname] of [['GET', '/api/agent-testing/bugs'], ['GET', `/api/agent-testing/bugs/${bug.id}`], ['PATCH', `/api/agent-testing/bugs/${bug.id}`], ['DELETE', `/api/agent-testing/bugs/${bug.id}`]] as const) {
    assert.equal((await send(method, `${pathname}?taskId=${coding.id}`, method === 'PATCH' ? { title: 'x' } : undefined)).status, 404, `${method} ${pathname}`);
  }
  assert.equal((await planItemService.getPlanItem(bug.id)).title, 'B.001: Flaky date test');
});

test('I47 starting a bug while the Project is at its task limit waits in line and the bug stays ready', async () => {
  const projectId = await newProject();
  const session = await reportSession(projectId, 1);
  const bug = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;
  // A coding Task still launching holds the Project's only slot.
  await insertTask(projectId, { runtimeStatus: 'starting' });

  const queued = await send('POST', `/api/plan-items/${bug.id}/execute`, { executorId: 'test-claude-cli' });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.entry.planItemId, bug.id);
  const still = await planItemService.getPlanItem(bug.id);
  assert.equal(still.status, 'pending');
  assert.equal(still.workflowRunId ?? null, null);
});

// ---- Tasks filed by a report session ----

test('the task routes: create is 201 and unstarted, a blank title asks the titler, and every bad body is 400 and creates nothing', async () => {
  const projectId = await newProject();
  const session = await reportSession(projectId, 1);
  const create = (body: unknown, caller = session.id) => send('POST', `/api/agent-bugs/tasks?taskId=${caller}`, body);

  const bug = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;
  const created = await create({ title: 'Add diagnostics', description: 'Full brief', relatedBugId: bug.id, priority: 'high' });
  assert.equal(created.status, 201);
  assert.equal(created.body.type, 'task');
  assert.equal(created.body.status, 'pending');
  assert.equal(created.body.title, 'Add diagnostics');
  assert.equal(created.body.relatedBug.planItemId, bug.id);
  assert.equal('priority' in created.body, false);
  assert.equal(titled.includes(created.body.id), false, 'a task with a title is not renamed');
  const serialized = JSON.stringify(created.body);
  assert.equal(serialized.includes(tempRoot), false, 'no data or repository path in the response');

  const untitled = await create({ description: 'Show timings for each step\nmore' });
  assert.equal(untitled.status, 201);
  assert.equal(untitled.body.title, 'Show timings for each step');
  assert.deepEqual(titled.filter((id) => id === untitled.body.id), [untitled.body.id]);

  const count = (await planItemService.listPlanItems(projectId)).length;
  assertRefused(await create({ title: 'No brief' }), 400, /description is required/);
  assertRefused(await create({ title: 5, description: 'x' }), 400, /title must be text/);
  assertRefused(await create({ title: 't'.repeat(201), description: 'x' }), 400);
  assertRefused(await create({ title: 't', description: 'd'.repeat(20_001) }), 400);
  assertRefused(await create({ title: 't', description: 'x', relatedBugId: ' ' }), 400, /relatedBugId/);
  assertRefused(await create({ title: 't', description: 'x', relatedBugId: 'no-such-bug' }), 400, /bug filed in this session/);
  assertRefused(await create(undefined), 400);
  assert.equal((await planItemService.listPlanItems(projectId)).length, count);

  const ok = (await create({ title: 't'.repeat(200), description: 'd'.repeat(20_000) }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.description.length, 20_000);
});

test('the task routes refuse a missing or wrong token, a missing taskId, an unknown or non-running session and a planning or coding session', async () => {
  const projectId = await newProject();
  const body = { title: 'T', description: 'D' };
  assertRefused(await send('POST', '/api/agent-bugs/tasks?taskId=x', body, { auth: null }), 401);
  assertRefused(await send('POST', '/api/agent-bugs/tasks', body), 400, /taskId is required/);
  assertRefused(await send('POST', '/api/agent-bugs/tasks?taskId=no-such-task', body), 404);
  for (const other of [
    await insertTask(projectId, { kind: 'plan', planningSessionNumber: 3 }),
    await insertTask(projectId, {}),
    await reportSession(projectId, 4, { status: 'stopped' }),
  ]) {
    assertRefused(await send('POST', `/api/agent-bugs/tasks?taskId=${other.id}`, body), 409, /bug report session/);
    assertRefused(await send('PATCH', `/api/agent-bugs/tasks/x?taskId=${other.id}`, { title: 'x' }), 409);
    assertRefused(await send('DELETE', `/api/agent-bugs/tasks/x?taskId=${other.id}`), 409);
  }
});

test('updating and deleting tasks: 200 and 204 for an own ready task; 400, 404 and 409 otherwise, and a started task is locked', async () => {
  const projectId = await newProject();
  const session = await reportSession(projectId, 1);
  const otherSession = await reportSession(projectId, 2);
  const mine = (await send('POST', `/api/agent-bugs/tasks?taskId=${session.id}`, { title: 'Mine', description: 'D' })).body as PlanItemRecord;
  const theirs = (await send('POST', `/api/agent-bugs/tasks?taskId=${otherSession.id}`, { title: 'Theirs', description: 'D' })).body as PlanItemRecord;
  const bug = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;
  const manual = await planItemService.createPlanItem({ projectId, title: 'Manual', description: '' });
  const patch = (id: string, body: unknown, caller = session.id) => send('PATCH', `/api/agent-bugs/tasks/${id}?taskId=${caller}`, body);
  const remove = (id: string, caller = session.id) => send('DELETE', `/api/agent-bugs/tasks/${id}?taskId=${caller}`);

  const linked = await patch(mine.id, { title: 'Renamed', relatedBugId: bug.id });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.title, 'Renamed');
  assert.equal(linked.body.relatedBug.planItemId, bug.id);
  const cleared = await patch(mine.id, { relatedBugId: null });
  assert.equal(cleared.status, 200);
  assert.equal('relatedBug' in cleared.body, false);

  assertRefused(await patch(mine.id, {}), 400, /at least one field/);
  assertRefused(await patch(mine.id, { description: '  ' }), 400);
  assertRefused(await patch(mine.id, { relatedBugId: 'no-such-bug' }), 400);
  for (const id of [theirs.id, manual.id, 'no-such-item']) {
    assertRefused(await patch(id, { title: 'x' }), 404);
    assertRefused(await remove(id), 404);
  }
  assertRefused(await patch(bug.id, { title: 'x' }), 409, /not a task/);
  assertRefused(await remove(bug.id), 409, /not a task/);
  assertRefused(await send('PATCH', `/api/agent-bugs/${mine.id}?taskId=${session.id}`, { severity: 'low' }), 409, /not a bug/);
  assertRefused(await send('DELETE', `/api/agent-bugs/${mine.id}?taskId=${session.id}`), 409, /not a bug/);

  await collections.planItemsDb.update(theirs.id, { status: 'developing' });
  assertRefused(await patch(theirs.id, { title: 'x' }, otherSession.id), 409, /already started/);
  assertRefused(await remove(theirs.id, otherSession.id), 409, /already started/);

  const removed = await remove(mine.id);
  assert.equal(removed.status, 204);
  assert.equal((await planItemService.listPlanItems(projectId)).some((item) => item.id === mine.id), false);
});

// ---- Reporting a regression (statuses only: a successful reopen starts a CLI, which is covered against a fake terminal in bugRegression.test.ts) ----

/** A bug in the given state, filed through a report session so it carries real attributes. */
async function bugWithStatus(projectId: string, status: PlanItemRecord['status']): Promise<PlanItemRecord> {
  const session = await reportSession(projectId, 1);
  const bug = (await send('POST', `/api/agent-bugs?taskId=${session.id}`, REPORT)).body as PlanItemRecord;
  return (await collections.planItemsDb.update(bug.id, { status }))!;
}

test('I02 I03 I05 I06 I08 I09 POST /plan-items/:id/regression: 400 for a bad reason, 404 unknown, 409 for a task or a bug that is not completed; nothing is recorded', async () => {
  const projectId = await newProject();
  const bug = await bugWithStatus(projectId, 'done');
  const route = `/api/plan-items/${bug.id}/regression`;
  assertRefused(await send('POST', route, { reason: '' }), 400, /reason is required/);
  assertRefused(await send('POST', route, { reason: '   ' }), 400);
  assertRefused(await send('POST', route, { reason: 'x'.repeat(20_001) }), 400, /at most 20,000 characters/);
  assertRefused(await send('POST', route, { reason: 7 }), 400, /must be text/);
  assertRefused(await send('POST', route, {}), 400);
  assertRefused(await send('POST', route, 'reason'), 400);
  assertRefused(await send('POST', '/api/plan-items/no-such-item/regression', { reason: 'Again.' }), 404);

  const task = await startedTask(projectId, '4.001: A task');
  assertRefused(await send('POST', `/api/plan-items/${task.id}/regression`, { reason: 'Again.' }), 409, /is a task, not a bug/);

  for (const status of ['pending', 'developing', 'blocked', 'failed', 'stopped'] as const) {
    const open = await bugWithStatus(projectId, status);
    assertRefused(await send('POST', `/api/plan-items/${open.id}/regression`, { reason: 'Again.' }), 409, /is not completed/);
    const unchanged = await planItemService.getPlanItem(open.id);
    assert.equal(unchanged.status, status);
    assert.deepEqual(unchanged.bug!.regressions, []);
  }
  assert.deepEqual((await planItemService.getPlanItem(bug.id)).bug!.regressions, []);
});

test('I24 a bug reads with an empty regressions list wherever the plan is returned, including a record stored without one', async () => {
  const projectId = await newProject();
  const bug = await bugWithStatus(projectId, 'done');
  const stored = await collections.planItemsDb.get(bug.id);
  const { regressions: _dropped, ...legacy } = stored!.bug!;
  await collections.planItemsDb.update(bug.id, { bug: legacy as never });
  const plan = await send('GET', `/api/projects/${projectId}/plan`);
  assert.deepEqual(plan.body.items.find((item: PlanItemRecord) => item.id === bug.id).bug.regressions, []);
});

test('I27 I28 I29 POST /agent-bugs/:id/reopen: 401 without the token, 400 without taskId, 409 for any caller that is not a running report session, 404 for another Project\'s bug, 409 for a task or a bug that is not completed', async () => {
  const projectId = await newProject();
  const otherProjectId = await newProject();
  const bug = await bugWithStatus(projectId, 'done');
  const session = await reportSession(projectId, 2);
  const reopen = (itemId: string, taskId: string | undefined, body: unknown = { reason: 'Again.' }, init: { auth?: string | null } = {}) =>
    send('POST', `/api/agent-bugs/${itemId}/reopen${taskId ? `?taskId=${taskId}` : ''}`, body, init);

  assertRefused(await reopen(bug.id, session.id, undefined, { auth: null }), 401);
  assertRefused(await reopen(bug.id, session.id, undefined, { auth: 'wrong-token' }), 401);
  assertRefused(await reopen(bug.id, undefined), 400, /taskId is required/);

  const planning = await insertTask(projectId, { kind: 'plan', planningSessionNumber: 3 });
  const coding = await insertTask(projectId, { kind: 'execute' });
  const finished = await reportSession(projectId, 4, { status: 'stopped' });
  for (const caller of [planning, coding, finished]) assertRefused(await reopen(bug.id, caller.id), 409, /Only a running bug report session/);
  assertRefused(await reopen(bug.id, 'no-such-task'), 404);

  assertRefused(await reopen(bug.id, session.id, { reason: '  ' }), 400);
  assertRefused(await reopen(bug.id, session.id, { reason: 'x'.repeat(20_001) }), 400);
  assertRefused(await reopen('no-such-bug', session.id), 404);
  assertRefused(await reopen((await bugWithStatus(otherProjectId, 'done')).id, session.id), 404, 'another Project\'s bug');
  assertRefused(await reopen((await startedTask(projectId, '5.001: A task')).id, session.id), 409, /is a task, not a bug/);
  assertRefused(await reopen((await bugWithStatus(projectId, 'developing')).id, session.id), 409, /is not completed/);
  assert.deepEqual((await planItemService.getPlanItem(bug.id)).bug!.regressions, []);
});
