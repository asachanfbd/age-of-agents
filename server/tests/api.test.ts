import { createQuietProject } from './helpers/quietProject.ts';
import assert from 'node:assert/strict';
import { PROJECT_PLOTS } from '../src/projects/townPlots.ts';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, mock, test } from 'node:test';

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
/** Items the create route handed to the (fake) background titler — no real CLI is spawned. */
const titleRequests: { id: string; title: string; description: string }[] = [];

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'api-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  // Isolated from the real repo's catalog/ (and never touches .claude/ either) — see catalogService.test.ts's fixture doc comment.
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  const { createDaemonServer } = await import('../src/server.ts');
  const { createPlanItemTitler } = await import('../src/projects/planItemTitler.ts');
  const planItemTitler = { ...createPlanItemTitler(), requestTitle: (item: (typeof titleRequests)[number]) => { titleRequests.push(item); }, requestSessionTitle: () => {} };
  server = createDaemonServer({ planItemTitler });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  // maxRetries: a docs-bootstrap Task can still be writing inside tempRoot from the last test or two
  // when this fires — retry past that race rather than let an ENOTEMPTY fail the whole file.
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  return { status: res.status, body };
}

test('GET /api/health reports ok', async () => {
  const res = await api('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('GET /api/catalog/agents returns the seeded builder template', async () => {
  const res = await api('/api/catalog/agents');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.some((t: { id: string }) => t.id === 'builder'));
});

test('GET /api/executors returns the configured executors, claude-cli and codex-cli alike', async () => {
  const res = await api('/api/executors');
  assert.equal(res.status, 200);
  const ids = res.body.map((e: { id: string }) => e.id);
  assert.ok(ids.includes('test-claude-cli'));
  assert.ok(ids.includes('test-codex-cli'));
});

test('GET /api/executors attaches a zero-usage summary before any Task has run', async () => {
  const res = await api('/api/executors');
  assert.equal(res.status, 200);
  const claude = res.body.find((e: { id: string }) => e.id === 'test-claude-cli');
  assert.deepEqual(claude.usage, { totalTokens: 0, taskCount: 0 });
});

test('starting a task with an unsupported executor is rejected, not silently accepted', async () => {
  const created = await createQuietProject('Codex Project');
  const res = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'do something', executorId: 'test-unsupported' }),
  });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /unsupported/);
});

test('starting a task with an unknown executorId 404s', async () => {
  const created = await createQuietProject('Bad Executor Project');
  const res = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'do something', executorId: 'does-not-exist' }),
  });
  assert.equal(res.status, 404);
});

test('POST /api/projects puts the \'Set up project documentation\' item on the board in the same response cycle', async () => {
  const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Setup On Board', position: null }) });
  assert.equal(created.status, 201);
  const plan = await api(`/api/projects/${created.body.id}/plan`);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.items.filter((item: { title: string }) => item.title === 'Set up project documentation').length, 1);
});

test('POST /api/projects still answers 201 with the project when starting the setup item fails, and the item stays on the board', async () => {
  const { workerManager } = await import('../src/worker/workerManager.ts');
  const failingStart = mock.method(workerManager, 'enqueuePlanItemExecution', async () => { throw new Error('start refused'); });
  try {
    const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Start Refused', position: null }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Start Refused');
    const plan = await api(`/api/projects/${created.body.id}/plan`);
    const [item] = plan.body.items.filter((entry: { title: string }) => entry.title === 'Set up project documentation');
    assert.ok(item, 'the not-started item is on the board for the owner to start again');
    assert.equal(item.status, 'pending');
  } finally {
    failingStart.mock.restore();
  }
});

test('POST /api/projects for a type with no repository creates no setup item', async () => {
  const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Plain CRM', typeId: 'crm', position: null }) });
  assert.equal(created.status, 201);
  const plan = await api(`/api/projects/${created.body.id}/plan`);
  assert.deepEqual(plan.body.items, []);
});

test('POST /api/projects creates a project and rejects a missing name', async () => {
  const missingName = await api('/api/projects', { method: 'POST', body: JSON.stringify({ position: [0, 0] }) });
  assert.equal(missingName.status, 400);

  const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'API Project', position: [1, 1] }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'API Project');
  assert.equal(created.body.status, 'idle');

  const projectRoot = path.join(tempRoot, 'projects', created.body.slug);
  const claudeHooks = JSON.parse(await readFile(path.join(projectRoot, '.claude', 'settings.local.json'), 'utf8'));
  const codexHooks = JSON.parse(await readFile(path.join(projectRoot, '.codex', 'hooks.json'), 'utf8'));
  assert.ok(claudeHooks.hooks.PermissionRequest);
  assert.ok(codexHooks.hooks.PermissionRequest);

  const list = await api('/api/projects');
  assert.ok(list.body.some((p: { id: string }) => p.id === created.body.id));
});

test('POST /api/cli-hooks rejects reports that do not carry the daemon token', async () => {
  const res = await api('/api/cli-hooks', {
    method: 'POST',
    body: JSON.stringify({ taskId: 'not-a-task', event: { hook_event_name: 'Stop' } }),
  });
  assert.equal(res.status, 401);
});

test('/api/agent-tasks rejects callers without the daemon token', async () => {
  for (const [method, path] of [['GET', ''], ['POST', ''], ['PATCH', '/item'], ['DELETE', '/item']] as const) {
    const res = await api(`/api/agent-tasks${path}?taskId=x`, { method, body: method === 'POST' || method === 'PATCH' ? JSON.stringify({ title: 'T', description: 'D' }) : undefined });
    assert.equal(res.status, 401, method);
  }
});

test('/api/agent-tasks validates its input, then 404s for an unknown planning session', async () => {
  const { CLI_HOOK_TOKEN } = await import('../src/terminal/projectCliHooks.ts');
  const headers = { authorization: `Bearer ${CLI_HOOK_TOKEN}` };
  const missingTaskId = await api('/api/agent-tasks', { headers });
  assert.equal(missingTaskId.status, 400);
  for (const body of [{ title: '  ', description: 'D' }, { title: 'T' }]) {
    const res = await api('/api/agent-tasks?taskId=x', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  for (const body of [{}, { title: ' ' }, { description: 3 }, { uiPlanningWaitsForParent: 'yes' }, { uiPlanningWaitsForParent: null }]) {
    const res = await api('/api/agent-tasks/item?taskId=x', { method: 'PATCH', headers, body: JSON.stringify(body) });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const requests = [
    api('/api/agent-tasks?taskId=no-such-task', { headers }),
    api('/api/agent-tasks?taskId=no-such-task', { method: 'POST', headers, body: JSON.stringify({ title: 'T', description: 'D' }) }),
    api('/api/agent-tasks/item?taskId=no-such-task', { method: 'PATCH', headers, body: JSON.stringify({ description: 'D' }) }),
    api('/api/agent-tasks/item?taskId=no-such-task', { method: 'DELETE', headers }),
  ];
  for (const res of await Promise.all(requests)) assert.equal(res.status, 404);
});

test('GET /api/projects/:id 404s for an unknown id', async () => {
  const res = await api('/api/projects/does-not-exist');
  assert.equal(res.status, 404);
  assert.ok(res.body.error);
});

async function createAt(name: string, position: [number, number] | null) {
  const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, position }) });
  return created.body.id as string;
}
const patchPosition = (id: string, position: unknown) => api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ position }) });

test('PATCH /api/projects/:id stores the exact free plot and accepts the project\'s own plot again', async () => {
  const id = await createAt('Plot Mover', null);
  const [x, z] = PROJECT_PLOTS[30]!;
  const moved = await patchPosition(id, [x + 0.0005, z]);
  assert.equal(moved.status, 200);
  assert.ok(Math.abs(moved.body.position[0] - x) < 1e-9 && moved.body.position[0] !== x + 0.0005, 'stored as the exact plot, not the sent value');
  assert.ok(Math.abs(moved.body.position[1] - z) < 1e-9);
  assert.equal((await patchPosition(id, [x, z])).status, 200);
});

test('PATCH /api/projects/:id answers 409 with an { error } body when another project holds the plot, and keeps the stored position', async () => {
  const holder = await createAt('Plot Holder', null);
  const mover = await createAt('Plot Loser', null);
  assert.equal((await patchPosition(holder, PROJECT_PLOTS[40]!)).status, 200);
  assert.equal((await patchPosition(mover, PROJECT_PLOTS[41]!)).status, 200);
  const taken = await patchPosition(mover, PROJECT_PLOTS[40]!);
  assert.equal(taken.status, 409);
  assert.deepEqual(Object.keys(taken.body), ['error']);
  assert.deepEqual((await api(`/api/projects/${mover}`)).body.position, PROJECT_PLOTS[41]!);
});

test('PATCH /api/projects/:id answers 400 for malformed, non-plot and city-centre positions', async () => {
  const id = await createAt('Plot Validator', null);
  for (const bad of ['0.78', [0.78], { x: 1, z: 1 }, null, ['4.38', '4.38'], [4.38, null], [4.38, 4.38, 0], [0, 0], [-0.78, -0.78], [1, 1], [PROJECT_PLOTS[0]![0] + 0.002, PROJECT_PLOTS[0]![1]], [1e309, 4.38], [1e308, 1e308], [-1e308, 0], [Number.MAX_SAFE_INTEGER, 0], [5e-324, 5e-324]]) {
    const res = await patchPosition(id, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(Object.keys(res.body), ['error']);
  }
});

test('PATCH /api/projects/:id keeps the missing-position 400, and an unknown id with a valid plot is 404', async () => {
  const id = await createAt('Plot Missing', null);
  const missing = await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({}) });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /name or position is required/);
  assert.equal((await patchPosition('no-such-project', PROJECT_PLOTS[5]!)).status, 404);
});

test('concurrent PATCHes to one plot: exactly one wins and no overlap is stored', async () => {
  const a = await createAt('Racer A', null);
  const b = await createAt('Racer B', null);
  const results = await Promise.all([patchPosition(a, PROJECT_PLOTS[60]!), patchPosition(b, PROJECT_PLOTS[60]!)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test('a legacy overlap does not block moving one of the overlapping projects to a free plot', async () => {
  const a = await createAt('Legacy A', PROJECT_PLOTS[70]!);
  const b = await createAt('Legacy B', PROJECT_PLOTS[70]!);
  assert.equal((await patchPosition(a, PROJECT_PLOTS[71]!)).status, 200);
  assert.equal((await patchPosition(b, PROJECT_PLOTS[70]!)).status, 200);
});

test('PATCH /api/projects/:id updates position, and GET .../blueprint self-heals a stub for a fresh project', async () => {
  const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Patchable', position: [0, 0] }) });
  const patched = await api(`/api/projects/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ position: PROJECT_PLOTS[90]! }) });
  assert.deepEqual(patched.body.position, PROJECT_PLOTS[90]);

  // Nothing writes blueprint.md at creation any more; the GET route self-heals it on demand.
  const blueprintRes = await fetch(`${baseUrl}/api/projects/${created.body.id}/blueprint`);
  assert.equal(blueprintRes.status, 200);
  const markdown = await blueprintRes.text();
  assert.match(markdown, /# Blueprint/);
  assert.match(markdown, /No Task has run yet\./);
});

test('DELETE /api/projects/:id removes it from later listings', async () => {
  const created = await createQuietProject('Deletable');
  const del = await api(`/api/projects/${created.body.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);

  const after = await api(`/api/projects/${created.body.id}`);
  assert.equal(after.status, 404);
});

test('starting a task 400s without a description and 404s for an unknown project', async () => {
  const created = await createQuietProject('Task Project');

  const missingDescription = await api(`/api/projects/${created.body.id}/tasks`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missingDescription.status, 400);

  const unknownProject = await api('/api/projects/does-not-exist/tasks', { method: 'POST', body: JSON.stringify({ description: 'x' }) });
  assert.equal(unknownProject.status, 404);
});

// ---- Catalog Templates/Skills wired into Task creation (server-daemon-architect Task 2) ----

test('POST /api/projects/:id/tasks accepts a valid templateId and skillIds, and rejects a non-array skillIds', async () => {
  const created = await createQuietProject('Skilled Task Project');
  await api('/api/catalog/skills', { method: 'POST', body: JSON.stringify({ id: 'api-skill', name: 'API Skill', description: 'A skill.' }) });

  const badShape = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'do something', skillIds: 'api-skill' }),
  });
  assert.equal(badShape.status, 400);

  const badElement = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'do something', skillIds: [123] }),
  });
  assert.equal(badElement.status, 400);

  const res = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'do something', templateId: 'builder', skillIds: ['api-skill'] }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.templateId, 'builder');
  assert.deepEqual(res.body.skillIds, ['api-skill']);
});

test('POST /api/projects/:id/tasks 422s for a disabled templateId or skillId, and 404s for an unknown one', async () => {
  const created = await createQuietProject('Invalid Catalog Refs Project');
  await api('/api/catalog/skills', { method: 'POST', body: JSON.stringify({ id: 'disabled-skill', name: 'Disabled Skill', description: 'x' }) });
  await api('/api/catalog/skills/disabled-skill/disable', { method: 'POST' });
  await api('/api/catalog/agents', { method: 'POST', body: JSON.stringify({ id: 'disabled-agent', name: 'Disabled Agent', description: 'x' }) });
  await api('/api/catalog/agents/disabled-agent/disable', { method: 'POST' });

  const unknownTemplate = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'x', templateId: 'does-not-exist' }),
  });
  assert.equal(unknownTemplate.status, 404);

  const disabledTemplate = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'x', templateId: 'disabled-agent' }),
  });
  assert.equal(disabledTemplate.status, 422);

  const unknownSkill = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'x', skillIds: ['does-not-exist'] }),
  });
  assert.equal(unknownSkill.status, 404);

  const disabledSkill = await api(`/api/projects/${created.body.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ description: 'x', skillIds: ['disabled-skill'] }),
  });
  assert.equal(disabledSkill.status, 422);
});

test('POST /api/projects/:id/tasks with no templateId/skillIds falls back to the default Template exactly as before', async () => {
  const created = await createQuietProject('Default Template Project');

  const res = await api(`/api/projects/${created.body.id}/tasks`, { method: 'POST', body: JSON.stringify({ description: 'do something' }) });
  assert.equal(res.status, 201);
  assert.equal(res.body.templateId, 'builder');
  assert.equal(res.body.skillIds, undefined);
});

// ---- Project plan: docs + Tasks breakdown (see server/src/projects/plan.ts, planItemService.ts) ----

test('GET /api/projects/:id/plan returns the five stub docs and an empty Tasks breakdown for a fresh project', async () => {
  const created = await createQuietProject('Planned Project');
  const res = await api(`/api/projects/${created.body.id}/plan`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.docs.length, 5);
  const specs = res.body.docs.find((d: { key: string }) => d.key === 'specifications');
  assert.equal(specs.title, 'Specifications');
  assert.match(specs.content, /Nothing recorded yet/);
});

test('GET /api/projects/:id/plan 404s for an unknown project', async () => {
  const res = await api('/api/projects/does-not-exist/plan');
  assert.equal(res.status, 404);
});

test('PUT /api/projects/:id/plan/docs/:key overwrites a doc, rejects an unknown key, and requires content', async () => {
  const created = await createQuietProject('Doc Edit Project');

  const updated = await api(`/api/projects/${created.body.id}/plan/docs/requirements`, {
    method: 'PUT',
    body: JSON.stringify({ content: '# Requirements\n\nShip auth first.\n' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.content, '# Requirements\n\nShip auth first.\n');

  const reread = await api(`/api/projects/${created.body.id}/plan`);
  const requirements = reread.body.docs.find((d: { key: string }) => d.key === 'requirements');
  assert.equal(requirements.content, '# Requirements\n\nShip auth first.\n');

  const badKey = await api(`/api/projects/${created.body.id}/plan/docs/not-a-real-doc`, { method: 'PUT', body: JSON.stringify({ content: 'x' }) });
  assert.equal(badKey.status, 400);

  const missingContent = await api(`/api/projects/${created.body.id}/plan/docs/requirements`, { method: 'PUT', body: JSON.stringify({}) });
  assert.equal(missingContent.status, 400);
});

test('plan-items CRUD: create, patch, and delete a Tasks-breakdown item over HTTP', async () => {
  const created = await createQuietProject('Breakdown Project');

  const empty = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: '  ', description: ' ' }) });
  assert.equal(empty.status, 400);

  const item = await api(`/api/projects/${created.body.id}/plan-items`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Add login form', description: 'Email + password.' }),
  });
  assert.equal(item.status, 201);
  assert.equal(item.body.status, 'pending');
  assert.equal(item.body.order, 0);
  assert.ok(!titleRequests.some((request) => request.id === item.body.id), 'an explicit title is kept, not regenerated');

  const patched = await api(`/api/plan-items/${item.body.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Add login form (v2)' }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.title, 'Add login form (v2)');
  assert.equal(patched.body.description, 'Email + password.', 'a field not named in the PATCH body is left alone');

  const patchUnknown = await api('/api/plan-items/does-not-exist', { method: 'PATCH', body: JSON.stringify({ title: 'x' }) });
  assert.equal(patchUnknown.status, 404);

  const listed = await api(`/api/projects/${created.body.id}/plan`);
  assert.equal(listed.body.items.length, 1);

  const deleted = await api(`/api/plan-items/${item.body.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  const listedAfter = await api(`/api/projects/${created.body.id}/plan`);
  assert.deepEqual(listedAfter.body.items, []);
});

test('plan items have no priority: one sent on create or PATCH is ignored, never stored', async () => {
  const created = await createQuietProject('Priority Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Urgent', description: '', priority: 'high' }) });
  assert.equal(item.status, 201);
  assert.equal('priority' in item.body, false);
  const patched = await api(`/api/plan-items/${item.body.id}`, { method: 'PATCH', body: JSON.stringify({ priority: 'low', title: 'Renamed' }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.title, 'Renamed');
  assert.equal('priority' in patched.body, false);
});

test('PUT /api/projects/:id/plan-items/order reorders the listed items and validates its body', async () => {
  const created = await createQuietProject('Reorder Project');
  const first = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'First', description: '' }) });
  const second = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Second', description: '' }) });

  const reordered = await api(`/api/projects/${created.body.id}/plan-items/order`, { method: 'PUT', body: JSON.stringify({ ids: [second.body.id, first.body.id] }) });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.body.map((item: { title: string }) => item.title), ['Second', 'First']);
  const listed = await api(`/api/projects/${created.body.id}/plan`);
  assert.deepEqual(listed.body.items.map((item: { title: string }) => item.title), ['Second', 'First']);

  for (const body of [{}, { ids: 'nope' }, { ids: [1] }, { ids: [first.body.id, first.body.id] }]) {
    const bad = await api(`/api/projects/${created.body.id}/plan-items/order`, { method: 'PUT', body: JSON.stringify(body) });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  const unknown = await api(`/api/projects/${created.body.id}/plan-items/order`, { method: 'PUT', body: JSON.stringify({ ids: ['does-not-exist'] }) });
  assert.equal(unknown.status, 404);
});

test('POST /api/projects/:id/plan-items with only a description saves a placeholder title and asks for a generated one', async () => {
  const created = await createQuietProject('Untitled Tasks Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, {
    method: 'POST',
    body: JSON.stringify({ description: '  Make the login form remember the email\nUse localStorage.  ' }),
  });
  assert.equal(item.status, 201);
  assert.equal(item.body.title, 'Make the login form remember the email');
  assert.equal(item.body.description, 'Make the login form remember the email\nUse localStorage.');
  assert.deepEqual(titleRequests.find((request) => request.id === item.body.id)?.description, item.body.description);
});

/** Links a WorkflowRun in `status` to a plan item — the "is its work really running?" signal the archive/complete guards use (a stored item status alone is not trusted). */
async function linkRun(planItemId: string, projectId: string, status: 'running' | 'completed'): Promise<void> {
  const { planItemsDb, workflowRunsDb } = await import('../src/db/collections.ts');
  const now = new Date().toISOString();
  const run = {
    id: `run-${planItemId}`, projectId, planItemId, workflowId: 'software-development', workflowSnapshot: { id: 'software-development', name: 'Flow', description: '', enabled: true, steps: [] },
    status, currentStepId: null, executorId: 'test-claude-cli', prUrl: null, completionReport: null,
    attentionReason: null, loopRoundAllowance: 0, createdAt: now, updatedAt: now, completedAt: null,
  };
  const existing = await workflowRunsDb.get(run.id);
  if (existing) await workflowRunsDb.update(run.id, { status });
  else await workflowRunsDb.insert(run as unknown as Parameters<typeof workflowRunsDb.insert>[0]);
  await planItemsDb.update(planItemId, { workflowRunId: run.id });
}

test('PATCH /api/plan-items/:id marks an idle item done, refuses a running one, and rejects any other status', async () => {
  const { planItemsDb } = await import('../src/db/collections.ts');
  const created = await createQuietProject('Complete Item Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Completable', description: '' }) });

  const badStatus = await api(`/api/plan-items/${item.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'developing' }) });
  assert.equal(badStatus.status, 400);

  const done = await api(`/api/plan-items/${item.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'done');
  const again = await api(`/api/plan-items/${item.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(again.status, 409, 'an item already done cannot be completed again');

  const other = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Stale', description: '' }) });
  await planItemsDb.update(other.body.id, { status: 'developing' });
  const stale = await api(`/api/plan-items/${other.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(stale.status, 200, 'a stale "developing" status with nothing live does not block completion');
});

test('the docs routes list, read, edit and create files and folders inside a project\'s .docs folder', async () => {
  const created = await createQuietProject('Docs Files Project');
  const id = created.body.id;

  const tree = await api(`/api/projects/${id}/docs/tree`);
  assert.equal(tree.status, 200);
  // No documentation files exist this early: they come from the docs-bootstrap Task (or a person).
  assert.deepEqual(tree.body.files, []);

  const folder = await api(`/api/projects/${id}/docs/entries`, { method: 'POST', body: JSON.stringify({ path: 'guides', type: 'folder' }) });
  assert.equal(folder.status, 201);
  const file = await api(`/api/projects/${id}/docs/entries`, { method: 'POST', body: JSON.stringify({ path: 'guides/setup', type: 'file' }) });
  assert.equal(file.status, 201);
  assert.equal(file.body.path, 'guides/setup.md');

  const duplicate = await api(`/api/projects/${id}/docs/entries`, { method: 'POST', body: JSON.stringify({ path: 'guides/setup', type: 'file' }) });
  assert.equal(duplicate.status, 409);
  const badType = await api(`/api/projects/${id}/docs/entries`, { method: 'POST', body: JSON.stringify({ path: 'x', type: 'symlink' }) });
  assert.equal(badType.status, 400);
  const badPath = await api(`/api/projects/${id}/docs/entries`, { method: 'POST', body: JSON.stringify({ path: '../oops', type: 'file' }) });
  assert.equal(badPath.status, 400);

  const saved = await api(`/api/projects/${id}/docs/file`, { method: 'PUT', body: JSON.stringify({ path: 'guides/setup.md', content: '# Setup\n' }) });
  assert.equal(saved.status, 200);
  const read = await api(`/api/projects/${id}/docs/file?path=${encodeURIComponent('guides/setup.md')}`);
  assert.deepEqual(read.body, { kind: 'text', content: '# Setup\n' });

  const missingPath = await api(`/api/projects/${id}/docs/file`);
  assert.equal(missingPath.status, 400);
  const escaped = await api(`/api/projects/${id}/docs/file?path=${encodeURIComponent('../package.json')}`);
  assert.equal(escaped.status, 400);
  const missingContent = await api(`/api/projects/${id}/docs/file`, { method: 'PUT', body: JSON.stringify({ path: 'guides/setup.md' }) });
  assert.equal(missingContent.status, 400);

  const after = await api(`/api/projects/${id}/docs/tree`);
  assert.ok(after.body.folders.includes('guides'));
  assert.ok(after.body.files.includes('guides/setup.md'));
});

test('DELETE /api/plan-items/:id deletes an item whatever its status, and 404s an unknown one', async () => {
  const { planItemsDb } = await import('../src/db/collections.ts');
  const created = await createQuietProject('Busy Breakdown Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Busy', description: '' }) });
  await planItemsDb.update(item.body.id, { status: 'blocked' });

  assert.equal((await api(`/api/plan-items/${item.body.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await planItemsDb.get(item.body.id)), undefined);
  assert.equal((await api(`/api/plan-items/${item.body.id}`, { method: 'DELETE' })).status, 404);
});

test('PATCH /api/plan-items/:id archives and restores an item, 400s a non-boolean, and 409s archiving a running one', async () => {
  const { planItemsDb } = await import('../src/db/collections.ts');
  const created = await createQuietProject('Archive Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Old', description: '' }) });
  const path_ = `/api/plan-items/${item.body.id}`;

  assert.equal((await api(path_, { method: 'PATCH', body: JSON.stringify({ archived: true }) })).body.archived, true);
  assert.equal((await api(path_, { method: 'PATCH', body: JSON.stringify({ archived: false }) })).body.archived, false);
  assert.equal((await api(path_, { method: 'PATCH', body: JSON.stringify({ archived: 'yes' }) })).status, 400);
  await planItemsDb.update(item.body.id, { status: 'developing' });
  await linkRun(item.body.id, created.body.id, 'running');
  const refused = await api(path_, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /^Task "Old" is still running/);

  // The stale-status bug: the run completed but the item was left 'developing' — not really running, so it archives.
  await linkRun(item.body.id, created.body.id, 'completed');
  assert.equal((await api(path_, { method: 'PATCH', body: JSON.stringify({ archived: true }) })).body.archived, true);
});

test('POST /api/plan-items/:id/execute 404s for an unknown item', async () => {
  const res = await api('/api/plan-items/does-not-exist/execute', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(res.status, 404);
});

test('starting a task at the Project\'s limit answers 202 with its place in line; completing an archived session answers 204', async () => {
  const { tasksDb, projectsDb } = await import('../src/db/collections.ts');
  const created = await createQuietProject('Limit Body Project');
  const projectId = created.body.id as string;
  const now = new Date().toISOString();
  const base = {
    projectId, templateId: 'builder', executorId: 'test-claude-cli', status: 'developing' as const, autonomy: 'auto' as const, manager: false,
    kind: 'execute' as const, planItemId: null, sessionId: 'sess', blockedQuestion: null, failureReason: null, runtimeStatus: 'starting' as const,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: null,
  };
  await tasksDb.insert({ ...base, id: 'api-limit-holder', description: 'Holds the only slot' });
  await projectsDb.update(projectId, { activeTaskIds: ['api-limit-holder'] });
  const item = await api(`/api/projects/${projectId}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Too many', description: '' }) });

  const refused = await api(`/api/plan-items/${item.body.id}/execute`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(refused.status, 202);
  assert.deepEqual([refused.body.started, refused.body.entry.planItemId, refused.body.entry.position], [false, item.body.id, 0]);
  await api(`/api/plan-item-queue/${refused.body.entry.id}`, { method: 'DELETE' });

  await tasksDb.insert({ ...base, id: 'api-done-plan', description: 'Plan', status: 'stopped', kind: 'plan', archived: true, planningSessionNumber: 43, runtimeStatus: undefined });
  const done = await api('/api/tasks/api-done-plan/planning-complete', { method: 'POST' });
  assert.equal(done.status, 204);
  await tasksDb.update('api-limit-holder', { status: 'stopped' });
  await projectsDb.update(projectId, { activeTaskIds: [] });
});

test('POST /api/plan-items/:id/execute validates executorId, workflowId and createBranch before starting anything', async () => {
  const created = await createQuietProject('Start Options Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Start me', description: '' }) });
  const disabled = await api('/api/catalog/workflows', {
    method: 'POST',
    body: JSON.stringify({
      id: 'retired-flow', name: 'Retired', description: 'Disabled.', enabled: false,
      steps: [{ id: 'build', name: 'Build', agentId: 'builder', canEditCode: true, requiresApproval: false, instructions: 'Build.' }],
    }),
  });
  assert.equal(disabled.status, 201);

  const start = (body: object) => api(`/api/plan-items/${item.body.id}/execute`, { method: 'POST', body: JSON.stringify(body) });
  for (const body of [
    { executorId: 'no-such-executor' }, { executorId: 7 },
    { workflowId: 'no-such-workflow' }, { workflowId: 'retired-flow' }, { workflowId: false },
    { createBranch: 'yes' }, { createBranch: 1 },
  ]) {
    const res = await start(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error, JSON.stringify(body));
  }
  // A repository-less Project has nothing to branch.
  const branchless = await start({ createBranch: true });
  assert.equal(branchless.status, 400);
  assert.match(branchless.body.error, /no linked repository/);
  assert.equal((await api(`/api/projects/${created.body.id}/plan`)).body.items[0].status, 'pending', 'nothing started');
});

test('POST /api/plan-items/:id/execute on a project with no repository queues while another run still works in the project folder', async () => {
  const { workflowRunsDb } = await import('../src/db/collections.ts');
  const created = await createQuietProject('Busy Folder Project');
  const item = await api(`/api/projects/${created.body.id}/plan-items`, { method: 'POST', body: JSON.stringify({ title: 'Wait your turn', description: '' }) });
  // An in-place run paused for approval between steps: no active Task, but it still owns the folder.
  const now = new Date().toISOString();
  await workflowRunsDb.insert({
    id: 'in-place-run', projectId: created.body.id, planItemId: 'some-other-item', workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'x', description: 'x', enabled: true, steps: [] },
    status: 'awaiting-approval', currentStepId: null, executorId: 'test-claude-cli',
    prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0,
    createdAt: now, updatedAt: now, completedAt: null,
  });

  const res = await api(`/api/plan-items/${item.body.id}/execute`, { method: 'POST', body: JSON.stringify({ createBranch: false }) });
  assert.equal(res.status, 202, 'the folder is the Project\'s only slot, so the start waits in line');
  assert.equal(res.body.started, false);
  assert.equal(res.body.entry.planItemId, item.body.id);
  await api(`/api/plan-item-queue/${res.body.entry.id}`, { method: 'DELETE' });
  await workflowRunsDb.delete('in-place-run');
});

test('POST /api/tasks/:taskId/followup requires an instruction and 404s for an unknown task', async () => {
  const missingInstruction = await api('/api/tasks/does-not-exist/followup', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missingInstruction.status, 400);

  const unknownTask = await api('/api/tasks/does-not-exist/followup', { method: 'POST', body: JSON.stringify({ instruction: 'go' }) });
  assert.equal(unknownTask.status, 404);
});

test('POST /api/tasks/:taskId/resume 404s for an unknown terminal task', async () => {
  const response = await api('/api/tasks/does-not-exist/resume', { method: 'POST' });
  assert.equal(response.status, 404);
});

test('completed planning sessions reject follow-up and resume routes until restored', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  const created = await createQuietProject('Archived Planning Resume Guard');
  const now = new Date().toISOString();
  await tasksDb.insert({
    id: 'api-archived-plan', projectId: created.body.id, templateId: 'builder', executorId: 'test-claude-cli',
    description: 'Plan it', status: 'stopped', autonomy: 'auto', manager: false, kind: 'plan', archived: true,
    planningSessionNumber: 42, planningCompletedAt: now, planItemId: null, sessionId: 'saved-session',
    blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: null,
  });
  const followUp = await api('/api/tasks/api-archived-plan/followup', { method: 'POST', body: JSON.stringify({ instruction: 'Continue' }) });
  const resume = await api('/api/tasks/api-archived-plan/resume', { method: 'POST' });
  assert.equal(followUp.status, 409);
  assert.equal(resume.status, 409);
  assert.match(followUp.body.error, /Restore this completed planning session/);
  assert.equal((await tasksDb.get('api-archived-plan'))?.archived, true);
});

test('PATCH /api/tasks/:taskId/title renames a session (400 when blank or too long), and DELETE /api/tasks/:taskId/session deletes it', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  assert.equal((await api('/api/tasks/does-not-exist/session', { method: 'DELETE' })).status, 404);

  const created = await createQuietProject('Deleted Session');
  const now = new Date().toISOString();
  await tasksDb.insert({
    id: 'fake-planning-session', projectId: created.body.id, templateId: 'builder', executorId: 'test-claude',
    description: 'Plan it', status: 'done', autonomy: 'auto', manager: false, kind: 'plan',
    planItemId: null, sessionId: null, blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: now,
  });
  const rename = (title: unknown) => api('/api/tasks/fake-planning-session/title', { method: 'PATCH', body: JSON.stringify({ title }) });
  assert.equal((await rename('   ')).status, 400);
  assert.equal((await rename(42)).status, 400);
  assert.equal((await rename('x'.repeat(81))).status, 400);
  assert.equal((await rename('  My planning session  ')).status, 204);
  assert.equal((await tasksDb.get('fake-planning-session'))?.title, 'My planning session');
  assert.equal((await api('/api/tasks/does-not-exist/title', { method: 'PATCH', body: JSON.stringify({ title: 'x' }) })).status, 404);

  assert.equal((await api('/api/tasks/fake-planning-session/session', { method: 'DELETE' })).status, 204);
  assert.equal(await tasksDb.get('fake-planning-session'), undefined);
});

test('the Planning queue reorder and manual-completion routes persist the unified lifecycle', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  const planItemService = await import('../src/projects/planItemService.ts');
  const created = await createQuietProject('Unified Planning API');
  const now = new Date().toISOString();
  await tasksDb.insert({
    id: 'api-planning-session', projectId: created.body.id, templateId: 'builder', executorId: 'test-claude-cli',
    description: 'Plan it', status: 'done', autonomy: 'auto', manager: false, kind: 'plan', planningSessionNumber: 11,
    planningQueueOrder: 50, planningCompletedAt: null, planningCreatedTaskCount: 0, planningAutoCompleteArmed: false,
    planItemId: null, sessionId: 'api-planning-session', blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: now,
  });
  const standalone = await planItemService.createPlanItem({ projectId: created.body.id, title: 'Standalone', description: '' });

  const reordered = await api(`/api/projects/${created.body.id}/planning-queue/order`, {
    method: 'PUT', body: JSON.stringify({ entries: [{ kind: 'session', id: 'api-planning-session' }, { kind: 'task', id: standalone.id }] }),
  });
  assert.equal(reordered.status, 204);
  assert.equal((await tasksDb.get('api-planning-session'))?.planningQueueOrder, 0);
  assert.equal((await planItemService.getPlanItem(standalone.id)).planningQueueOrder, 1);

  const stale = await api(`/api/projects/${created.body.id}/planning-queue/order`, {
    method: 'PUT', body: JSON.stringify({ entries: [{ kind: 'session', id: 'api-planning-session' }] }),
  });
  assert.equal(stale.status, 409);

  const completed = await api('/api/tasks/api-planning-session/planning-complete', { method: 'POST' });
  assert.equal(completed.status, 204);
  assert.equal((await tasksDb.get('api-planning-session'))?.archived, true);
  assert.ok((await tasksDb.get('api-planning-session'))?.planningCompletedAt);
  assert.equal((await planItemService.getPlanItem(standalone.id)).archived, undefined, 'completing planning does not archive tasks');
});

test('PUT /api/projects/:id/planning-queue/sessions/:sessionId/order saves a group\'s ready-task order and refuses anything outside it', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  const planItemService = await import('../src/projects/planItemService.ts');
  const created = await createQuietProject('Planning Group Order API');
  const projectId = created.body.id;
  const now = new Date().toISOString();
  const session = (id: string, planningSessionNumber: number, archived?: boolean) => tasksDb.insert({
    id, projectId, templateId: 'builder', executorId: 'test-claude-cli',
    description: 'Plan it', status: 'done', autonomy: 'auto', manager: false, kind: 'plan', planningSessionNumber,
    ...(archived ? { archived, planningCompletedAt: now } : {}),
    planItemId: null, sessionId: id, blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: now,
  });
  await session('api-group-session', 21);
  await session('api-other-session', 22);
  await session('api-completed-session', 23, true);
  const linked = (session: number, task: number) => planItemService.createPlanItem({ projectId, title: `${session}.00${task}: Task`, description: '', planningRef: { session, task } });
  const first = await linked(21, 1);
  const second = await linked(21, 2);
  const elsewhere = await linked(22, 1);
  const order = (sessionId: string, ids: unknown) => api(`/api/projects/${projectId}/planning-queue/sessions/${sessionId}/order`, { method: 'PUT', body: JSON.stringify({ ids }) });

  assert.equal((await order('api-group-session', [second.id, first.id])).status, 204);
  assert.equal((await planItemService.getPlanItem(second.id)).planningGroupOrder, 0);
  assert.equal((await planItemService.getPlanItem(first.id)).planningGroupOrder, 1);
  assert.equal((await planItemService.getPlanItem(first.id)).title, '21.001: Task', 'numbers and titles are unchanged');

  assert.equal((await order('api-group-session', 'nope')).status, 400);
  assert.equal((await order('api-group-session', [first.id, first.id])).status, 400);
  const foreign = await order('api-group-session', [first.id, second.id, elsewhere.id]);
  assert.equal(foreign.status, 409, 'a task from another group is refused');
  assert.equal(typeof foreign.body.error, 'string');
  assert.equal((await order('api-group-session', [first.id])).status, 409, 'a stale, incomplete group is refused');
  assert.equal((await order('api-group-session', [first.id, 'unknown-item'])).status, 404);
  assert.equal((await order('unknown-session', [first.id, second.id])).status, 404);
  assert.equal((await order('api-completed-session', [])).status, 409, 'a completed conversation has no group');
  assert.equal((await planItemService.getPlanItem(second.id)).planningGroupOrder, 0, 'a refused reorder changes nothing');
});

test('POST /api/tasks/:taskId/interim-commit 404s for an unknown task and 409s for a Task that is not ongoing', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  const unknownTask = await api('/api/tasks/does-not-exist/interim-commit', { method: 'POST' });
  assert.equal(unknownTask.status, 404);

  const created = await createQuietProject('Interim Commit Guard');
  const now = new Date().toISOString();
  await tasksDb.insert({
    id: 'fake-settled-task', projectId: created.body.id, templateId: 'builder', executorId: 'test-claude',
    description: 'Settled', status: 'done', autonomy: 'auto', manager: false, kind: 'execute',
    planItemId: null, sessionId: null, blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: now,
  });
  const settled = await api('/api/tasks/fake-settled-task/interim-commit', { method: 'POST' });
  assert.equal(settled.status, 409);
});

test('POST /api/tasks/:taskId/reopen-session 404s for an unknown task and 409s, by name, for a Task that is no workflow step', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  const unknownTask = await api('/api/tasks/does-not-exist/reopen-session', { method: 'POST' });
  assert.equal(unknownTask.status, 404);

  // No Project is needed (or created, which would schedule a docs-bootstrap Task): the step check comes first.
  const now = new Date().toISOString();
  await tasksDb.insert({
    id: 'fake-plain-task', projectId: 'no-project', templateId: 'builder', executorId: 'test-claude-cli',
    description: 'Settled', status: 'done', autonomy: 'auto', manager: false, kind: 'execute',
    planItemId: null, sessionId: 'plain-session', blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: now,
  });
  const plain = await api('/api/tasks/fake-plain-task/reopen-session', { method: 'POST' });
  assert.equal(plain.status, 409);
  assert.match(plain.body.error, /^This task is not a workflow step/);

  assert.equal((await api('/api/tasks/does-not-exist/reopen-session', { method: 'DELETE' })).status, 404);
  const notReopened = await api('/api/tasks/fake-plain-task/reopen-session', { method: 'DELETE' });
  assert.equal(notReopened.status, 409);
  assert.equal(notReopened.body.error, 'This task has no reopened session to stop');
});

test('generic Resume and Follow-up routes reject a settled workflow step even with a saved session and missing branch', async () => {
  const { tasksDb } = await import('../src/db/collections.ts');
  const now = new Date().toISOString();
  await tasksDb.insert({
    id: 'fake-completed-step', projectId: 'no-project', templateId: 'builder', executorId: 'test-claude-cli',
    description: 'Settled branch step', status: 'done', autonomy: 'auto', manager: false, kind: 'execute', executionMode: 'terminal',
    workflowRunId: 'completed-run', workflowStepId: 'build', branch: 'task/branch-gone', worktreePath: '/missing-worktree',
    planItemId: null, sessionId: 'step-session', blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: now,
  });
  const before = await tasksDb.all();
  for (const [route, body] of [['resume', undefined], ['followup', { instruction: 'Edit more' }]] as const) {
    const result = await api(`/api/tasks/fake-completed-step/${route}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /workflow step; reopen it from the run's Session view/);
  }
  assert.deepEqual(await tasksDb.all(), before, 'neither generic route creates a Task or CLI session');
});

test('reopen choice and resolution routes validate bodies and missing records without writes', async () => {
  const { workflowRunsDb } = await import('../src/db/collections.ts');
  const before = await workflowRunsDb.all();
  assert.deepEqual(await api('/api/tasks/no-task/reopen-session/options'), { status: 404, body: { error: 'This task no longer exists — it may have been deleted' } });
  const invalidMode = await api('/api/tasks/no-task/reopen-session', { method: 'POST', body: JSON.stringify({ mode: 'unsafe' }) });
  assert.equal(invalidMode.status, 400);
  assert.deepEqual(invalidMode.body, { error: 'mode must be permissions or read-only' });
  const invalidDecision = await api('/api/workflow-runs/no-run/reopen-changes', { method: 'POST', body: JSON.stringify({ decision: 'commit' }) });
  assert.deepEqual(invalidDecision, { status: 400, body: { error: 'decision must be commit-push or discard' } });
  const missing = await api('/api/workflow-runs/no-run/reopen-changes', { method: 'POST', body: JSON.stringify({ decision: 'discard' }) });
  assert.equal(missing.status, 404);
  assert.deepEqual(await workflowRunsDb.all(), before);
});

test('POST /api/projects/:id/chat requires a message, 404s for an unknown project, and rejects an unsupported executor', async () => {
  const created = await createQuietProject('Chat Project');

  const missingMessage = await api(`/api/projects/${created.body.id}/chat`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missingMessage.status, 400);

  const unknownProject = await api('/api/projects/does-not-exist/chat', { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
  assert.equal(unknownProject.status, 404);

  // Fails on executor validation before ever spawning a process — same pattern as the
  // "unsupported executor" test above for POST /tasks, kept subprocess-free. Planning runs only in
  // an interactive CLI, so a non-CLI-kind executor is refused with that specific message.
  const badExecutor = await api(`/api/projects/${created.body.id}/chat`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Draft the specs', executorId: 'test-unsupported' }),
  });
  assert.equal(badExecutor.status, 422, 'planning runs only in an interactive CLI');
  assert.match(badExecutor.body.error, /not an interactive CLI/);
});

test('blueprint edits persist as markdown and invalid content leaves the file intact', async () => {
  const created = await createQuietProject('Editable Blueprint');
  const endpoint = `/api/projects/${created.body.id}/blueprint`;
  const content = '# Updated blueprint\n\n- [x] Render documents\n';
  assert.equal((await api(endpoint, { method: 'PUT', body: JSON.stringify({ content }) })).status, 200);
  assert.equal(await (await fetch(`${baseUrl}${endpoint}`)).text(), content);
  assert.equal((await api(endpoint, { method: 'PUT', body: JSON.stringify({ content: 42 }) })).status, 400);
  assert.equal(await (await fetch(`${baseUrl}${endpoint}`)).text(), content);
});

test('GET .../blueprint self-heals a missing blueprint.md instead of 500ing', async () => {
  const created = await createQuietProject('Missing Blueprint Project');
  // Nothing writes blueprint.md at creation any more, so it's already "missing" here.

  const res = await fetch(`${baseUrl}/api/projects/${created.body.id}/blueprint`);
  assert.equal(res.status, 200);
  const markdown = await res.text();
  assert.match(markdown, /# Blueprint/);
  assert.match(markdown, /No Task has run yet\./);

  // The stub was actually written back to disk, not just returned once.
  const again = await fetch(`${baseUrl}/api/projects/${created.body.id}/blueprint`);
  assert.equal(await again.text(), markdown);
});

// ---- Documents tab: the real file tree of the project's known doc directories ----

test('GET /api/projects/:id/documents lists the (virtual) blueprint entry and an empty plan list for a fresh project', async () => {
  const created = await createQuietProject('Docs Project');
  const res = await api(`/api/projects/${created.body.id}/documents`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.blueprint, { name: 'blueprint.md', title: 'Blueprint' });
  // Nothing writes docs/plan/ at creation any more — an empty list, not five stub docs.
  assert.deepEqual(res.body.plan, []);
});

test('GET /api/projects/:id/documents 404s for an unknown project', async () => {
  const res = await api('/api/projects/does-not-exist/documents');
  assert.equal(res.status, 404);
});

test('GET /api/projects/:id/documents reflects an extra file dropped in the plan directory, read-only via .../documents/plan/:name', async () => {
  const created = await createQuietProject('Extra Doc Project');
  const projectDir = path.join(tempRoot, 'projects', created.body.slug);
  await mkdir(path.join(projectDir, '.docs', 'plan'), { recursive: true });
  await writeFile(path.join(projectDir, '.docs', 'plan', 'notes.md'), '# Notes\n\nHand-added.\n');

  const listed = await api(`/api/projects/${created.body.id}/documents`);
  const notes = listed.body.plan.find((d: { name: string }) => d.name === 'notes.md');
  assert.deepEqual(notes, { name: 'notes.md', title: 'notes.md', docKey: null });

  const rawRes = await fetch(`${baseUrl}/api/projects/${created.body.id}/documents/plan/notes.md`);
  assert.equal(rawRes.status, 200);
  assert.equal(await rawRes.text(), '# Notes\n\nHand-added.\n');
});

test('GET /api/projects/:id/documents/plan/:name 404s for a name that does not exist', async () => {
  const created = await createQuietProject('No Extra Doc Project');
  const res = await api(`/api/projects/${created.body.id}/documents/plan/does-not-exist.md`);
  assert.equal(res.status, 404);
});

test('GET /api/projects/:id/documents/plan/:name rejects a path-traversal attempt instead of reading outside the plan directory', async () => {
  const created = await createQuietProject('Traversal Doc Project');
  const projectDir = path.join(tempRoot, 'projects', created.body.slug);
  await writeFile(path.join(projectDir, 'secret.txt'), 'top secret');

  const dotdot = await api(`/api/projects/${created.body.id}/documents/plan/${encodeURIComponent('../secret.txt')}`);
  assert.equal(dotdot.status, 400);

  const absolute = await api(`/api/projects/${created.body.id}/documents/plan/${encodeURIComponent('/etc/passwd')}`);
  assert.equal(absolute.status, 400);
});

// ---- Code tab: read-only whole-project file-tree explorer ----

test('GET /api/projects/:id/code/tree lists the project files agent-visual-os itself scaffolded', async () => {
  const created = await createQuietProject('Code Tree Project');
  const res = await api(`/api/projects/${created.body.id}/code/tree`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.files));
  assert.ok(!res.body.files.some((file: string) => file.startsWith('.docs/milestones')));
  assert.ok(Array.isArray(res.body.folders));
  assert.ok(!res.body.folders.includes('.docs/milestones'));
});

test('POST /api/projects/:id/code/entries creates files and folders anywhere in the project, shown by the code tree', async () => {
  const created = await createQuietProject('Code Entries Project');
  const id = created.body.id;
  const projectDir = path.join(tempRoot, 'projects', created.body.slug);
  const post = (body: unknown) => api(`/api/projects/${id}/code/entries`, { method: 'POST', body: JSON.stringify(body) });

  const folder = await post({ path: 'scripts', type: 'folder' });
  assert.equal(folder.status, 201);
  assert.deepEqual(folder.body, { path: 'scripts', type: 'folder' });
  const empty = await post({ path: 'empty-dir', type: 'folder' });
  assert.equal(empty.status, 201);
  const file = await post({ path: 'scripts/run.sh', type: 'file' });
  assert.equal(file.status, 201);
  assert.deepEqual(file.body, { path: 'scripts/run.sh', type: 'file' });

  const read = await api(`/api/projects/${id}/code/file?path=${encodeURIComponent('scripts/run.sh')}`);
  assert.deepEqual(read.body, { path: 'scripts/run.sh', kind: 'text', content: '' });
  const tree = await api(`/api/projects/${id}/code/tree`);
  assert.ok(tree.body.files.includes('scripts/run.sh'));
  assert.ok(tree.body.folders.includes('scripts'));
  assert.ok(tree.body.folders.includes('empty-dir'), 'an empty folder is listed');

  const duplicate = await post({ path: 'scripts/run.sh', type: 'file' });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already exists/);
  assert.equal((await post({ path: 'x', type: 'symlink' })).status, 400);
  assert.equal((await post({ type: 'file' })).status, 400);
  assert.equal((await post({ path: '   ', type: 'file' })).status, 400);
  assert.equal((await post({ path: 42, type: 'file' })).status, 400);
  const traversal = await post({ path: '../oops', type: 'file' });
  assert.equal(traversal.status, 400);
  await assert.rejects(() => stat(path.join(projectDir, '..', 'oops')), { code: 'ENOENT' });
  const gitPath = await post({ path: '.git/hooks/pre-commit', type: 'file' });
  assert.equal(gitPath.status, 400);
  assert.match(gitPath.body.error, /\.git/);
  assert.equal((await post({ path: '.GIT/hooks/pre-commit', type: 'file' })).status, 400, '.git is matched case-insensitively');
});

test('POST /api/projects/:id/code/entries 404s for an unknown project', async () => {
  const res = await api('/api/projects/does-not-exist/code/entries', { method: 'POST', body: JSON.stringify({ path: 'a.ts', type: 'file' }) });
  assert.equal(res.status, 404);
});

test('GET /api/projects/:id/code/tree 404s for an unknown project', async () => {
  const res = await api('/api/projects/does-not-exist/code/tree');
  assert.equal(res.status, 404);
});

test('GET /api/projects/:id/code/file reads a text file, reports a binary one read-only, and 404s a missing one', async () => {
  const created = await createQuietProject('Code File Project');
  const projectDir = path.join(tempRoot, 'projects', created.body.slug);
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'src', 'index.ts'), 'export const x = 1;\n');
  await writeFile(path.join(projectDir, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));

  const text = await api(`/api/projects/${created.body.id}/code/file?path=${encodeURIComponent('src/index.ts')}`);
  assert.equal(text.status, 200);
  assert.deepEqual(text.body, { path: 'src/index.ts', kind: 'text', content: 'export const x = 1;\n' });

  const binary = await api(`/api/projects/${created.body.id}/code/file?path=${encodeURIComponent('src/logo.png')}`);
  assert.equal(binary.status, 200);
  assert.equal(binary.body.kind, 'binary');
  assert.equal(binary.body.content, undefined, 'no raw bytes are ever sent for a binary file');

  const missing = await api(`/api/projects/${created.body.id}/code/file?path=${encodeURIComponent('src/missing.ts')}`);
  assert.equal(missing.status, 404);

  const noPath = await api(`/api/projects/${created.body.id}/code/file`);
  assert.equal(noPath.status, 400);
});

test('GET /api/projects/:id/code/file rejects every shape of path-traversal attempt, 400/403 not a silent clamp', async () => {
  const created = await createQuietProject('Traversal Code Project');
  const projectDir = path.join(tempRoot, 'projects', created.body.slug);
  const secretDir = path.join(tempRoot, 'outside-secrets');
  await mkdir(secretDir, { recursive: true });
  await writeFile(path.join(secretDir, 'passwd'), 'root:x:0:0');

  const relative = await api(`/api/projects/${created.body.id}/code/file?path=${encodeURIComponent('../../outside-secrets/passwd')}`);
  assert.equal(relative.status, 400);

  const absolute = await api(`/api/projects/${created.body.id}/code/file?path=${encodeURIComponent(path.join(secretDir, 'passwd'))}`);
  assert.equal(absolute.status, 400);

  // A symlink inside the project pointing at a file outside it — must be rejected even though the
  // requested path string itself never contains "..".
  await symlink(path.join(secretDir, 'passwd'), path.join(projectDir, 'sneaky-link.txt'));
  const symlinked = await api(`/api/projects/${created.body.id}/code/file?path=${encodeURIComponent('sneaky-link.txt')}`);
  assert.equal(symlinked.status, 400);
});

// ---- Project Commands: user-defined shell commands, run from the project's root ----

async function waitForRunStatus(runId: string, timeoutMs = 5000): Promise<{ status: number; body: any }> {
  const start = Date.now();
  for (;;) {
    const res = await api(`/api/command-runs/${runId}`);
    if (res.body.status !== 'running') return res;
    if (Date.now() - start > timeoutMs) throw new Error('waitForRunStatus: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('commands CRUD: create, patch, list, and delete over HTTP', async () => {
  const created = await createQuietProject('Commands Project');

  const missingName = await api(`/api/projects/${created.body.id}/commands`, { method: 'POST', body: JSON.stringify({ command: 'echo hi' }) });
  assert.equal(missingName.status, 400);
  const missingCommand = await api(`/api/projects/${created.body.id}/commands`, { method: 'POST', body: JSON.stringify({ name: 'Echo' }) });
  assert.equal(missingCommand.status, 400);

  const command = await api(`/api/projects/${created.body.id}/commands`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Build', command: 'npm run build' }),
  });
  assert.equal(command.status, 201);
  assert.equal(command.body.highlighted, false);

  const patched = await api(`/api/commands/${command.body.id}`, { method: 'PATCH', body: JSON.stringify({ command: 'npm run build --prod' }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Build', 'a field not named in the PATCH body is left alone');
  assert.equal(patched.body.command, 'npm run build --prod');

  const listed = await api(`/api/projects/${created.body.id}/commands`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);

  const deleted = await api(`/api/commands/${command.body.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  const listedAfter = await api(`/api/projects/${created.body.id}/commands`);
  assert.deepEqual(listedAfter.body, []);
});

test('GET /api/projects/:id/commands 404s for an unknown project', async () => {
  const res = await api('/api/projects/does-not-exist/commands');
  assert.equal(res.status, 404);
});

test('POST /api/projects/:id/commands can highlight a command at creation, still capped at 3', async () => {
  const created = await createQuietProject('Highlight At Creation Project');

  const badType = await api(`/api/projects/${created.body.id}/commands`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Bad', command: 'echo bad', highlighted: 'yes' }),
  });
  assert.equal(badType.status, 400);

  for (const name of ['A', 'B', 'C']) {
    const res = await api(`/api/projects/${created.body.id}/commands`, {
      method: 'POST',
      body: JSON.stringify({ name, command: `echo ${name}`, highlighted: true }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.highlighted, true);
  }

  const overCap = await api(`/api/projects/${created.body.id}/commands`, {
    method: 'POST',
    body: JSON.stringify({ name: 'D', command: 'echo D', highlighted: true }),
  });
  assert.equal(overCap.status, 400);
});

test('PATCH /api/commands/:id enforces the 3-highlighted cap and 404s for an unknown id', async () => {
  const created = await createQuietProject('Highlight Project');
  const ids: string[] = [];
  for (const name of ['A', 'B', 'C', 'D']) {
    const res = await api(`/api/projects/${created.body.id}/commands`, { method: 'POST', body: JSON.stringify({ name, command: `echo ${name}` }) });
    ids.push(res.body.id);
  }
  for (const id of ids.slice(0, 3)) {
    const res = await api(`/api/commands/${id}`, { method: 'PATCH', body: JSON.stringify({ highlighted: true }) });
    assert.equal(res.status, 200);
  }
  const overCap = await api(`/api/commands/${ids[3]}`, { method: 'PATCH', body: JSON.stringify({ highlighted: true }) });
  assert.equal(overCap.status, 400);

  const unknown = await api('/api/commands/does-not-exist', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) });
  assert.equal(unknown.status, 404);
});

test('running a command over HTTP streams to success, and its history/stop/get-by-id round-trip', async () => {
  const created = await createQuietProject('Run Project');
  const command = await api(`/api/projects/${created.body.id}/commands`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Echo', command: 'echo run-over-http' }),
  });

  const run = await api(`/api/commands/${command.body.id}/run`, { method: 'POST' });
  assert.equal(run.status, 201);
  assert.equal(run.body.status, 'running');
  assert.equal(run.body.origin, 'saved');

  const settled = await waitForRunStatus(run.body.id);
  assert.equal(settled.status, 200);
  assert.equal(settled.body.status, 'success');
  assert.match(settled.body.output, /run-over-http/);

  const history = await api(`/api/projects/${created.body.id}/command-runs`);
  assert.equal(history.status, 200);
  assert.equal(history.body[0].id, run.body.id);

  const alreadySettledStop = await api(`/api/command-runs/${run.body.id}/stop`, { method: 'POST' });
  assert.equal(alreadySettledStop.status, 200);
  assert.equal(alreadySettledStop.body.status, 'success', 'stopping an already-finished run must not overwrite its real outcome');
});

test('running the same command twice concurrently is refused with 409', async () => {
  const created = await createQuietProject('Concurrent Run Project');
  const command = await api(`/api/projects/${created.body.id}/commands`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Sleep', command: 'sleep 1' }),
  });

  const first = await api(`/api/commands/${command.body.id}/run`, { method: 'POST' });
  assert.equal(first.status, 201);
  const second = await api(`/api/commands/${command.body.id}/run`, { method: 'POST' });
  assert.equal(second.status, 409);

  await waitForRunStatus(first.body.id);
});

test('stopping a running command settles it as stopped', async () => {
  const created = await createQuietProject('Stop Project');
  const command = await api(`/api/projects/${created.body.id}/commands`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Long sleep', command: 'sleep 30' }),
  });

  const run = await api(`/api/commands/${command.body.id}/run`, { method: 'POST' });
  const stopped = await api(`/api/command-runs/${run.body.id}/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'stopped');
});

test('GET /api/projects/:id/command-runs?status=running narrows to just the still-running runs, for the header/Manage to discover a background command left going', async () => {
  const created = await createQuietProject('Active Runs Project');
  const finished = await api(`/api/projects/${created.body.id}/commands`, { method: 'POST', body: JSON.stringify({ name: 'Echo', command: 'echo one' }) });
  const longRunning = await api(`/api/projects/${created.body.id}/commands`, { method: 'POST', body: JSON.stringify({ name: 'Dev server', command: 'sleep 30' }) });

  const done = await api(`/api/commands/${finished.body.id}/run`, { method: 'POST' });
  await waitForRunStatus(done.body.id);
  const stillGoing = await api(`/api/commands/${longRunning.body.id}/run`, { method: 'POST' });

  const active = await api(`/api/projects/${created.body.id}/command-runs?status=running`);
  assert.equal(active.status, 200);
  assert.deepEqual(active.body.map((r: { id: string }) => r.id), [stillGoing.body.id]);

  const invalid = await api(`/api/projects/${created.body.id}/command-runs?status=not-a-status`);
  assert.equal(invalid.status, 400);

  await api(`/api/command-runs/${stillGoing.body.id}/stop`, { method: 'POST' });
});

test('POST /api/commands/:id/run 404s for an unknown command; GET /api/command-runs/:id 404s for an unknown run', async () => {
  const missingCommand = await api('/api/commands/does-not-exist/run', { method: 'POST' });
  assert.equal(missingCommand.status, 404);
  const missingRun = await api('/api/command-runs/does-not-exist');
  assert.equal(missingRun.status, 404);
});

test('POST /api/projects/:id/commands/run-adhoc runs a one-off command with no saved ProjectCommand behind it', async () => {
  const created = await createQuietProject('Ad Hoc Project');

  const missingCommand = await api(`/api/projects/${created.body.id}/commands/run-adhoc`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missingCommand.status, 400);

  const run = await api(`/api/projects/${created.body.id}/commands/run-adhoc`, {
    method: 'POST',
    body: JSON.stringify({ command: 'echo run-adhoc-over-http' }),
  });
  assert.equal(run.status, 201);
  assert.equal(run.body.status, 'running');
  assert.equal(run.body.commandName, 'Custom command');
  assert.equal(run.body.origin, 'adhoc');

  const settled = await waitForRunStatus(run.body.id);
  assert.equal(settled.body.status, 'success');
  assert.match(settled.body.output, /run-adhoc-over-http/);

  // Never appears as a defined command, but its run still lands in History.
  const commands = await api(`/api/projects/${created.body.id}/commands`);
  assert.deepEqual(commands.body, []);
  const history = await api(`/api/projects/${created.body.id}/command-runs`);
  assert.equal(history.body[0].id, run.body.id);
});

test('POST /api/projects/:id/commands/run-adhoc 404s for an unknown project', async () => {
  const res = await api('/api/projects/does-not-exist/commands/run-adhoc', { method: 'POST', body: JSON.stringify({ command: 'echo hi' }) });
  assert.equal(res.status, 404);
});

// ---- Catalog: agents ----

test('POST /api/catalog/agents creates an agent, validating id/name/description', async () => {
  const missingId = await api('/api/catalog/agents', { method: 'POST', body: JSON.stringify({ name: 'X', description: 'Y' }) });
  assert.equal(missingId.status, 400);
  const missingName = await api('/api/catalog/agents', { method: 'POST', body: JSON.stringify({ id: 'http-agent', description: 'Y' }) });
  assert.equal(missingName.status, 400);
  const missingDescription = await api('/api/catalog/agents', { method: 'POST', body: JSON.stringify({ id: 'http-agent', name: 'X' }) });
  assert.equal(missingDescription.status, 400);

  const created = await api('/api/catalog/agents', {
    method: 'POST',
    body: JSON.stringify({ id: 'http-agent', name: 'HTTP Agent', description: 'Created over HTTP.', avatar: '🌐' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 'http-agent');
  assert.equal(created.body.avatar, '🌐');
  assert.equal(created.body.enabled, true);

  const duplicate = await api('/api/catalog/agents', { method: 'POST', body: JSON.stringify({ id: 'http-agent', name: 'X', description: 'Y' }) });
  assert.equal(duplicate.status, 409);
});

test('GET /api/catalog/agents/:id, PUT, enable/disable, and DELETE round-trip over HTTP', async () => {
  await api('/api/catalog/agents', { method: 'POST', body: JSON.stringify({ id: 'http-agent-2', name: 'HTTP Agent 2', description: 'Y' }) });

  const fetched = await api('/api/catalog/agents/http-agent-2');
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.name, 'HTTP Agent 2');

  const missing = await api('/api/catalog/agents/does-not-exist');
  assert.equal(missing.status, 404);

  const updated = await api('/api/catalog/agents/http-agent-2', { method: 'PUT', body: JSON.stringify({ name: 'Renamed', avatar: '✨' }) });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Renamed');
  assert.equal(updated.body.avatar, '✨');

  const badAutonomy = await api('/api/catalog/agents/http-agent-2', { method: 'PUT', body: JSON.stringify({ defaultAutonomy: 'yolo' }) });
  assert.equal(badAutonomy.status, 400);

  const disabled = await api('/api/catalog/agents/http-agent-2/disable', { method: 'POST' });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.enabled, false);

  const enabled = await api('/api/catalog/agents/http-agent-2/enable', { method: 'POST' });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);

  const deleted = await api('/api/catalog/agents/http-agent-2', { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal((await api('/api/catalog/agents/http-agent-2')).status, 404);
});

test('POST /api/catalog/agents/upload registers a raw .md file sent as base64', async () => {
  const content = '---\nname: whatever\ndescription: Uploaded over HTTP.\n---\n\n# Uploaded\n';
  const res = await api('/api/catalog/agents/upload', {
    method: 'POST',
    body: JSON.stringify({ id: 'http-uploaded', contentBase64: Buffer.from(content, 'utf-8').toString('base64') }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'http-uploaded');
  assert.equal(res.body.agentFile, 'agents/http-uploaded.md');

  const missingContent = await api('/api/catalog/agents/upload', { method: 'POST', body: JSON.stringify({ id: 'no-content' }) });
  assert.equal(missingContent.status, 400);
});

// ---- Catalog: skills ----

test('POST /api/catalog/skills creates a skill; GET/PUT/DELETE and enable/disable round-trip', async () => {
  const created = await api('/api/catalog/skills', {
    method: 'POST',
    body: JSON.stringify({ id: 'http-skill', name: 'HTTP Skill', description: 'A skill made over HTTP.', triggers: ['http'] }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.triggers, ['http']);

  const fetched = await api('/api/catalog/skills/http-skill');
  assert.equal(fetched.status, 200);

  const updated = await api('/api/catalog/skills/http-skill', { method: 'PUT', body: JSON.stringify({ description: 'Updated.' }) });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.description, 'Updated.');

  const disabled = await api('/api/catalog/skills/http-skill/disable', { method: 'POST' });
  assert.equal(disabled.body.enabled, false);
  const enabled = await api('/api/catalog/skills/http-skill/enable', { method: 'POST' });
  assert.equal(enabled.body.enabled, true);

  const deleted = await api('/api/catalog/skills/http-skill', { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal((await api('/api/catalog/skills/http-skill')).status, 404);
});

test('POST/DELETE /api/catalog/skills/:id/files adds and removes a support file sent as base64', async () => {
  await api('/api/catalog/skills', { method: 'POST', body: JSON.stringify({ id: 'files-skill', name: 'Files Skill', description: 'Has files.' }) });

  const added = await api(`/api/catalog/skills/files-skill/files`, {
    method: 'POST',
    body: JSON.stringify({ name: 'notes.txt', contentBase64: Buffer.from('hello').toString('base64') }),
  });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.supportFiles, ['notes.txt']);

  const removed = await api(`/api/catalog/skills/files-skill/files/notes.txt`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.supportFiles, []);
});

test('POST /api/catalog/skills/upload extracts an uploaded zip sent as base64', async () => {
  const zipBuffer = await readFile(path.join(import.meta.dirname, 'fixtures', 'zips', 'valid-skill.zip'));
  const res = await api('/api/catalog/skills/upload', {
    method: 'POST',
    body: JSON.stringify({ id: 'http-zipped', contentBase64: zipBuffer.toString('base64') }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'http-zipped');
  assert.deepEqual(res.body.supportFiles, ['notes.md']);
});

test('POST /api/catalog/skills/install validates the repo slug before ever spawning anything; GET .../install/:runId 404s for an unknown run', async () => {
  const missing = await api('/api/catalog/skills/install', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missing.status, 400);

  const invalid = await api('/api/catalog/skills/install', { method: 'POST', body: JSON.stringify({ repo: 'not-a-valid-slug' }) });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /owner\/repo/);

  const missingRun = await api('/api/catalog/skills/install/does-not-exist');
  assert.equal(missingRun.status, 404);
});

test('POST /api/notifications validates kind/subject/title/description, then GET list, read, unread, and read-all work over HTTP', async () => {
  const skillSubject = { type: 'skill', repo: 'owner/api-test-repo' };

  const badKind = await api('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'nope', subject: skillSubject, title: 'x', description: 'y' }),
  });
  assert.equal(badKind.status, 400);

  const badSubjectType = await api('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'skill.install_failed', subject: { type: 'nope' }, title: 'x', description: 'y' }),
  });
  assert.equal(badSubjectType.status, 400);

  const missingSubjectField = await api('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'skill.install_failed', subject: { type: 'skill' }, title: 'x', description: 'y' }),
  });
  assert.equal(missingSubjectField.status, 400);

  const taskSubjectMissingField = await api('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'task.failed', subject: { type: 'task', projectId: 'p1', conversationId: 'c1' }, title: 'x', description: 'y' }),
  });
  assert.equal(taskSubjectMissingField.status, 400, 'a task subject missing taskId is invalid');

  const missingTitle = await api('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'skill.install_failed', subject: skillSubject, description: 'y' }),
  });
  assert.equal(missingTitle.status, 400);

  const missingDescription = await api('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'skill.install_failed', subject: skillSubject, title: 'x' }),
  });
  assert.equal(missingDescription.status, 400);

  const missingSubject = await api('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'skill.install_failed', title: 'x', description: 'y' }),
  });
  assert.equal(missingSubject.status, 400);

  const created = await api('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'skill.install_failed', subject: skillSubject, title: 'Skill install failed', description: 'git clone failed' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.readAt, null);
  assert.equal(created.body.resolvedAt, null);
  assert.equal(created.body.projectId, null);
  assert.equal(created.body.severity, 'warning');

  const listed = await api('/api/notifications?severity=warning');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.some((n: { id: string }) => n.id === created.body.id));

  const badSeverityFilter = await api('/api/notifications?severity=nope');
  assert.equal(badSeverityFilter.status, 400);

  const resolvedFilter = await api('/api/notifications?resolved=false&projectId=none');
  assert.equal(resolvedFilter.status, 200);
  assert.ok(resolvedFilter.body.some((n: { id: string }) => n.id === created.body.id));

  const readRes = await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [created.body.id] }) });
  assert.equal(readRes.status, 204);
  const afterRead = (await api('/api/notifications?projectId=none')).body.find((n: { id: string }) => n.id === created.body.id);
  assert.ok(afterRead.readAt);

  const unreadRes = await api(`/api/notifications/${created.body.id}/unread`, { method: 'POST' });
  assert.equal(unreadRes.status, 204);
  const afterUnread = (await api('/api/notifications?projectId=none')).body.find((n: { id: string }) => n.id === created.body.id);
  assert.equal(afterUnread.readAt, null);

  const missingUnread = await api('/api/notifications/does-not-exist/unread', { method: 'POST' });
  assert.equal(missingUnread.status, 404);

  const readAllRes = await api('/api/notifications/read-all', { method: 'POST', body: JSON.stringify({ projectId: 'none' }) });
  assert.equal(readAllRes.status, 204);
  const afterReadAll = (await api('/api/notifications?projectId=none')).body.find((n: { id: string }) => n.id === created.body.id);
  assert.ok(afterReadAll.readAt);

  const missingReadBody = await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missingReadBody.status, 400);

  // Express's default (non-JSON) 404 for an unmatched route — checked with a raw fetch, not the
  // JSON-parsing `api()` helper above.
  const noLongerARoute = await fetch(`${baseUrl}/api/notifications/${created.body.id}/status`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) });
  assert.equal(noLongerARoute.status, 404, 'the old status route is gone');

  const noLongerAGetRoute = await fetch(`${baseUrl}/api/notifications/${created.body.id}`);
  assert.equal(noLongerAGetRoute.status, 404, 'GET /api/notifications/:id is gone — not part of the new route list');
});

test('POST /api/notifications/read with {subject} marks every notification matching that subject identity read', async () => {
  const subject = { type: 'project', projectId: `api-read-subject-${Date.now()}` };
  const first = await api('/api/notifications', { method: 'POST', body: JSON.stringify({ kind: 'git.out_of_sync', subject, title: 't1', description: 'd1' }) });
  assert.equal(first.status, 201);

  const res = await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ subject }) });
  assert.equal(res.status, 204);

  const after = (await api(`/api/notifications?projectId=${subject.projectId}`)).body[0];
  assert.ok(after.readAt);

  const badSubject = await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ subject: { type: 'nope' } }) });
  assert.equal(badSubject.status, 400);
});

// ---- Testing tab: the project testing contract (server/src/testing/) ----

test('GET /api/projects/:id/testing/config walks absent → valid → invalid as the file changes on disk', async () => {
  // Created through the service, not POST /api/projects, so no docs-bootstrap Task (and no real CLI) is started.
  const { createProject } = await import('../src/projects/projectService.ts');
  const created = await createProject({ name: 'Testing Contract Project', position: null });
  const configDir = path.join(tempRoot, 'projects', created.slug, '.docs', 'testing');
  const url = `/api/projects/${created.id}/testing/config`;

  const absent = await api(url);
  assert.equal(absent.status, 200);
  assert.deepEqual(absent.body, { state: 'absent', path: '.docs/testing/config.json' });

  await mkdir(configDir, { recursive: true });
  await cp(path.join(import.meta.dirname, 'fixtures', 'testing', 'config.json'), path.join(configDir, 'config.json'));
  const valid = await api(url);
  assert.equal(valid.status, 200);
  assert.equal(valid.body.state, 'valid');
  assert.deepEqual(valid.body.config.suites.map((suite: { id: string }) => suite.id), ['unit', 'integration', 'load', 'security', 'lighthouse']);

  await writeFile(path.join(configDir, 'config.json'), '{ "schemaVersion": 1,');
  const malformed = await api(url);
  assert.equal(malformed.status, 200);
  assert.equal(malformed.body.state, 'invalid');
  assert.equal(malformed.body.issues[0].code, 'malformed-json');

  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ schemaVersion: 3, suites: [] }));
  assert.equal((await api(url)).body.issues[0].code, 'unsupported-schema-version');

  const action = { id: 'run', label: 'Run', command: 'make test', workingDirectory: '../../elsewhere', collectors: [{ id: 'c', format: 'junit-xml', path: '/etc/passwd' }] };
  const suite = { id: 'unit', label: 'Unit', kind: 'unit', primaryActionId: 'run', actions: [action] };
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ schemaVersion: 1, suites: [suite, suite] }));
  const invalid = await api(url);
  assert.equal(invalid.body.state, 'invalid');
  const codes = invalid.body.issues.map((issue: { code: string; path: string }) => `${issue.code}@${issue.path}`);
  assert.ok(codes.includes('duplicate-id@suites[1].id'));
  assert.ok(codes.includes('unsafe-path@suites[0].actions[0].workingDirectory'));
  assert.ok(codes.includes('unsafe-path@suites[0].actions[0].collectors[0].path'));
});

test('GET /api/projects/:id/testing/config 404s for an unknown project', async () => {
  const res = await api('/api/projects/does-not-exist/testing/config');
  assert.equal(res.status, 404);
});

test('POST /api/projects/:id/tasks validates preloadSkillIds: 400 for a non-subset or malformed value, 201 for a subset or none', async () => {
  const created = await createQuietProject('Preload Task Project');
  await api('/api/catalog/skills', { method: 'POST', body: JSON.stringify({ id: 'preload-skill', name: 'Preload Skill', description: 'A skill.' }) });
  const post = (body: object) => api(`/api/projects/${created.body.id}/tasks`, { method: 'POST', body: JSON.stringify({ description: 'do something', ...body }) });

  const stray = await post({ skillIds: ['preload-skill'], preloadSkillIds: ['api-skill'] });
  assert.equal(stray.status, 400);
  assert.equal(stray.body.error, 'preloadSkillIds must be a subset of skillIds: "api-skill" is not an attached skill');
  for (const preloadSkillIds of ['preload-skill', [1], null]) {
    const bad = await post({ skillIds: ['preload-skill'], preloadSkillIds });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'preloadSkillIds must be an array of strings');
  }
  assert.equal((await post({ preloadSkillIds: ['preload-skill'] })).status, 400, 'a preload with no skillIds is not a subset');

  const absent = await post({ skillIds: ['preload-skill'] });
  assert.equal(absent.status, 201);
  assert.equal(absent.body.preloadSkillIds, undefined);
  const second = await createQuietProject('Preload Task Project 2');
  const ok = await api(`/api/projects/${second.body.id}/tasks`, { method: 'POST', body: JSON.stringify({ description: 'do something', skillIds: ['preload-skill'], preloadSkillIds: ['preload-skill'] }) });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.preloadSkillIds, ['preload-skill']);
});
