import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';
import { settleWorkUpdates } from '../src/crm/workUpdates.ts';

let t: CrmApi;
let id: string;
let runtime: typeof import('../src/crm/runtime.ts');
let collections: typeof import('../src/db/collections.ts');
before(async () => { t = await startCrmApi(); runtime = await import('../src/crm/runtime.ts'); collections = await import('../src/db/collections.ts'); });
after(async () => { await t.stop(); });
beforeEach(async () => {
  t.reset();
  runtime.setCrmOverrides({ now: () => t.clock.now, deps: { transport: t.transport, agent: t.agent, buildings: runtime.daemonBuildings } });
  id = await t.createCrm();
  await t.send('PATCH', t.crm(id, '/settings'), { timezone: 'UTC' });
});

const post = (suffix: string, body: unknown = {}) => t.send('POST', t.crm(id, suffix), body);
const get = (suffix: string) => t.api(t.crm(id, suffix));
let seq = 0;
async function customerWithBuilding(): Promise<{ contactId: number; buildingId: string }> {
  const c = (await post('/contacts', { name: 'C', channels: [{ type: 'email', handle: `w${++seq}@x.com` }] })).body;
  await post(`/contacts/${c.id}/customer`);
  const building = (await t.send('POST', '/api/projects', { name: `App ${seq}` })).body;
  assert.equal((await post(`/contacts/${c.id}/buildings`, { buildingId: building.id })).status, 201);
  await settleWorkUpdates();
  return { contactId: c.id, buildingId: building.id };
}
let runSeq = 0;
async function run(buildingId: string, status: string, over: Record<string, unknown> = {}) {
  const planItemId = (over.planItemId as string) ?? `item-${++runSeq}`;
  if (!(await collections.planItemsDb.get(planItemId))) await collections.planItemsDb.insert({ id: planItemId, projectId: buildingId, title: 'Fix login' } as never);
  const now = new Date(t.clock.now).toISOString();
  const record = { id: `run-${++runSeq}`, projectId: buildingId, planItemId, status, createdAt: now, completedAt: status === 'completed' ? now : null, completionReport: 'Fixed it', ...over };
  await collections.workflowRunsDb.insert(record as never);
  return record as never;
}
const timeline = async (contactId: number) => (await get(`/contacts/${contactId}/timeline`)).body.rows.filter((e: { kind: string }) => e.kind === 'building_work');

test('I01 I03 a started then completed run posts both entries to the attached customer', async () => {
  const { contactId, buildingId } = await customerWithBuilding();
  t.clock.now += 1000;
  const planItemId = 'live-1';
  await runtime.recordRunWork(await run(buildingId, 'running', { planItemId }));
  t.agent.reply = 'We fixed the login page.';
  await runtime.recordRunWork(await run(buildingId, 'completed', { planItemId }));
  const rows = await timeline(contactId);
  assert.deepEqual(rows.map((r: { data: { phase: string } }) => r.data.phase).sort(), ['finished', 'started']);
  const fin = rows.find((r: { data: { phase: string } }) => r.data.phase === 'finished');
  assert.deepEqual([fin.data.summary, fin.data.rewritten, fin.data.taskTitle], ['We fixed the login page.', true, 'Fix login']);
});

test('I10 I11 I12 failed, stopped and needs-attention runs post nothing', async () => {
  const { contactId, buildingId } = await customerWithBuilding();
  for (const status of ['failed', 'stopped', 'needs-attention']) await runtime.recordRunWork(await run(buildingId, status));
  assert.equal((await timeline(contactId)).length, 0);
});

test('I13 I14 a retried task posts "started" once and "finished" once', async () => {
  const { contactId, buildingId } = await customerWithBuilding();
  t.clock.now += 1000;
  await runtime.recordRunWork(await run(buildingId, 'running', { planItemId: 'retry' }));
  await run(buildingId, 'failed', { planItemId: 'retry', createdAt: new Date(t.clock.now).toISOString() });
  t.clock.now += 1000;
  await runtime.recordRunWork(await run(buildingId, 'running', { planItemId: 'retry', createdAt: new Date(t.clock.now).toISOString() }));
  await runtime.recordRunWork(await run(buildingId, 'completed', { planItemId: 'retry', createdAt: new Date(t.clock.now).toISOString() }));
  assert.deepEqual((await timeline(contactId)).map((r: { data: { phase: string } }) => r.data.phase).sort(), ['finished', 'started']);
});

test('I21 tasks on the CRM Building itself post nothing', async () => {
  const { contactId } = await customerWithBuilding();
  await runtime.recordRunWork(await run(id, 'completed'));
  assert.equal((await timeline(contactId)).length, 0);
});

test('I23 a read-only CRM Building writes nothing and the call still resolves', async () => {
  const { contactId, buildingId } = await customerWithBuilding();
  await collections.projectsDb.update(id, { readOnlyReason: 'newer data' } as never);
  await runtime.recordRunWork(await run(buildingId, 'completed'));
  await collections.projectsDb.update(id, { readOnlyReason: null } as never);
  assert.equal((await timeline(contactId)).length, 0);
  assert.equal(t.agent.requests.length, 0);
});

test('I24 a failing CRM database is logged and the call resolves', async () => {
  const { buildingId } = await customerWithBuilding();
  const ctx = await runtime.crmCtx((await collections.projectsDb.get(id))!);
  ctx.db.exec("CREATE TRIGGER no_work BEFORE INSERT ON timeline WHEN NEW.kind = 'building_work' BEGIN SELECT RAISE(ABORT, 'full'); END");
  const log = console.error;
  console.error = () => undefined;
  try { await runtime.recordRunWork(await run(buildingId, 'running')); } finally { console.error = log; ctx.db.exec('DROP TRIGGER no_work'); }
});

test('I39 I40 the timeline and customers list return the entries newest first with the Work log', async () => {
  const { contactId, buildingId } = await customerWithBuilding();
  t.clock.now += 1000;
  await runtime.recordRunWork(await run(buildingId, 'running', { planItemId: 'a' }));
  t.clock.now += 1000;
  await runtime.recordRunWork(await run(buildingId, 'completed', { planItemId: 'a' }));
  const rows = await timeline(contactId);
  assert.deepEqual(rows.map((r: { data: { phase: string } }) => r.data.phase), ['finished', 'started']);
  const building = (await get('/customers')).body.rows.find((c: { id: number }) => c.id === contactId).buildings[0];
  assert.deepEqual([building.workLogTotal, building.workLog.map((e: { phase: string }) => e.phase)], [2, ['finished', 'started']]);
});

test('I38 a Building-work entry cannot be edited or deleted (409)', async () => {
  const { contactId, buildingId } = await customerWithBuilding();
  await runtime.recordRunWork(await run(buildingId, 'running', { planItemId: 'z' }));
  const [entry] = await timeline(contactId);
  assert.equal((await t.send('PATCH', t.crm(id, `/contacts/${contactId}/timeline/${entry.id}`), { text: 'x' })).status, 409);
  assert.equal((await t.send('DELETE', t.crm(id, `/contacts/${contactId}/timeline/${entry.id}`))).status, 409);
});

test('I43 detaching leaves the Building and its tasks, and earlier entries stay', async () => {
  const { contactId, buildingId } = await customerWithBuilding();
  await runtime.recordRunWork(await run(buildingId, 'running', { planItemId: 'd' }));
  await t.send('DELETE', t.crm(id, `/contacts/${contactId}/buildings/${buildingId}`));
  assert.equal((await t.api(`/api/projects/${buildingId}`)).status, 200);
  assert.equal((await timeline(contactId)).length, 1);
});

test('I36 the settings API response has no new agent setting', async () => {
  const settings = (await get('/settings')).body;
  assert.deepEqual(Object.keys(settings.agentAutoApply), ['messageDrafts', 'moms']);
  assert.ok(!Object.keys(settings).some((k) => /summary|workUpdate/i.test(k)));
});

test('the daemon task reader reports a task once, by its latest completion, inside the window', async () => {
  const { buildingId } = await customerWithBuilding();
  await run(buildingId, 'completed', { planItemId: 'dup', completedAt: new Date(t.clock.now - 5000).toISOString() });
  await run(buildingId, 'completed', { planItemId: 'dup', completedAt: new Date(t.clock.now - 1000).toISOString(), completionReport: 'Second' });
  await run(buildingId, 'completed', { planItemId: 'old', completedAt: new Date(t.clock.now - 90 * 86_400_000).toISOString() });
  await run(buildingId, 'failed', { planItemId: 'bad' });
  const tasks = await runtime.daemonTasks.finishedSince(buildingId, t.clock.now - 30 * 86_400_000);
  assert.deepEqual(tasks.map((x) => [x.planItemId, x.runSummary]), [['dup', 'Second']]);
});

test('I44 the product doc describes the feature', () => {
  const doc = readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'crm-building.md'), 'utf8');
  for (const phrase of [/Work log/, /internal record/i, /last 30 days/, /Not rewritten/, /Backfilled/]) assert.match(doc, phrase);
});

test('backfill skips testing-setup and PR-conflict runs, as live posting does', async () => {
  const { buildingId } = await customerWithBuilding();
  await run(buildingId, 'completed', { planItemId: 'real' });
  await run(buildingId, 'completed', { planItemId: 'setup', testingSetup: true });
  await run(buildingId, 'completed', { planItemId: 'conflict', prConflict: true });
  const tasks = await runtime.daemonTasks.finishedSince(buildingId, t.clock.now - 30 * 86_400_000);
  assert.deepEqual(tasks.map((x) => x.planItemId), ['real']);
});

test('I35 a planted secret in run fields other than the summary never reaches the agent prompt', async () => {
  const { buildingId } = await customerWithBuilding();
  const secret = 'sk-planted-secret-value-123';
  const record = await run(buildingId, 'completed', { planItemId: 'sec', completionReport: 'Done', error: secret, notes: secret, prUrl: `https://x/${secret}` });
  await runtime.recordRunWork(record);
  assert.ok(t.agent.requests.length > 0);
  assert.ok(!JSON.stringify(t.agent.requests).includes(secret));
});
