import { createQuietProject } from './helpers/quietProject.ts';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';

let t: CrmApi;
let id: string;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });
beforeEach(async () => { t.reset(); id = await t.createCrm(); await t.send('PATCH', t.crm(id, '/settings'), { timezone: 'UTC' }); });

const DAY = 86_400_000;
const post = (suffix: string, body: unknown = {}) => t.send('POST', t.crm(id, suffix), body);
const get = (suffix: string) => t.api(t.crm(id, suffix));
const customer = async (n = 1) => { const c = (await post('/contacts', { name: `C${n}`, channels: [{ type: 'email', handle: `c${n}@x.com` }] })).body; await post(`/contacts/${c.id}/customer`); return c; };

test('I095 customers are listed paged; attaching a Building: unknown 404, already attached 409, the CRM Building itself 400, a prospect 409', async () => {
  const c = await customer(1);
  const prospect = (await post('/contacts', { channels: [{ type: 'email', handle: 'p@x.com' }] })).body;
  assert.equal((await post(`/contacts/${c.id}/buildings`, { buildingId: 'b-seo' })).status, 201);
  assert.equal((await post(`/contacts/${c.id}/buildings`, { buildingId: 'b-seo' })).status, 409);
  assert.equal((await post(`/contacts/${c.id}/buildings`, { buildingId: 'nope' })).status, 404);
  assert.equal((await post(`/contacts/${c.id}/buildings`, { buildingId: id })).status, 400);
  assert.equal((await post(`/contacts/${c.id}/buildings`, {})).status, 400);
  assert.equal((await post(`/contacts/${prospect.id}/buildings`, { buildingId: 'b-sw' })).status, 409);
  await post(`/contacts/${c.id}/buildings`, { buildingId: 'b-sw' });
  const list = (await get('/customers')).body;
  assert.deepEqual([list.total, list.rows[0].buildings.map((b: { buildingId: string }) => b.buildingId).sort()], [1, ['b-seo', 'b-sw']]);
  for (let i = 2; i < 5; i++) await customer(i);
  const p = (await get('/customers?limit=2&offset=2')).body;
  assert.deepEqual([p.rows.length, p.total, p.hasMore], [2, 4, false]);
  const options = (await get('/buildings')).body.buildings.map((b: { id: string }) => b.id);
  assert.ok(options.includes('b-seo') && !options.includes(id));
});

test('I096 an attached Building shows name, type and status, plus a short summary where the type offers a read capability, else the basics', async () => {
  const runtime = await import('../src/crm/runtime.ts');
  runtime.setCrmOverrides({ now: () => t.clock.now, deps: { transport: t.transport, agent: t.agent, buildings: runtime.daemonBuildings } });
  const seo = (await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' })).body;
  const sw = (await createQuietProject('App')).body;
  const notes = (await t.send('POST', '/api/projects', { typeId: 'notes', name: 'Scratch' })).body;
  const c = await customer();
  for (const b of [seo, sw, notes]) assert.equal((await post(`/contacts/${c.id}/buildings`, { buildingId: b.id })).status, 201);
  const peeks = Object.fromEntries((await get('/customers')).body.rows[0].buildings.map((b: { buildingId: string; peek: unknown }) => [b.buildingId, b.peek]));
  assert.deepEqual([peeks[seo.id].state, peeks[seo.id].typeId, peeks[seo.id].name, peeks[seo.id].summary], ['ok', 'seo', 'example.com', 'No report saved yet']);
  assert.deepEqual([peeks[sw.id].typeId, peeks[sw.id].summary], ['software', '0 open tasks']);
  assert.deepEqual([peeks[notes.id].state, peeks[notes.id].summary], ['ok', null]);
  assert.ok(typeof peeks[sw.id].status === 'string');
});

test('I097 a removed Building reads as unavailable (not empty); a refused or failing read marks that Building only and the list still answers 200', async () => {
  const runtime = await import('../src/crm/runtime.ts');
  runtime.setCrmOverrides({ now: () => t.clock.now, deps: { transport: t.transport, agent: t.agent, buildings: runtime.daemonBuildings } });
  const gone = (await t.send('POST', '/api/projects', { typeId: 'notes', name: 'Gone' })).body;
  const c = await customer();
  await post(`/contacts/${c.id}/buildings`, { buildingId: gone.id });
  await t.send('DELETE', `/api/projects/${gone.id}`);
  const rows = (await get('/customers')).body.rows[0].buildings;
  assert.deepEqual(rows.map((b: { peek: { state: string } }) => b.peek.state), ['unavailable']);
  t.overrides();
  await post(`/contacts/${c.id}/buildings`, { buildingId: 'b-seo' });
  await post(`/contacts/${c.id}/buildings`, { buildingId: 'b-sw' });
  t.buildings.peeks.set('b-seo', new Error('read refused by the Building'));
  const res = await get('/customers');
  assert.equal(res.status, 200);
  const states = Object.fromEntries(res.body.rows[0].buildings.map((b: { buildingId: string; peek: { state: string; reason?: string } }) => [b.buildingId, b.peek]));
  assert.deepEqual([states['b-seo'].state, states['b-seo'].reason, states['b-sw'].state], ['read_failed', 'read refused by the Building', 'ok']);
});

test('I098 detaching removes the link and writes attach and detach entries; detaching an unattached Building is 404', async () => {
  const c = await customer();
  await post(`/contacts/${c.id}/buildings`, { buildingId: 'b-seo' });
  assert.equal((await t.send('DELETE', t.crm(id, `/contacts/${c.id}/buildings/b-sw`))).status, 404);
  const res = await t.send('DELETE', t.crm(id, `/contacts/${c.id}/buildings/b-seo`));
  assert.deepEqual([res.status, res.body.buildings], [200, []]);
  const kinds = (await get(`/contacts/${c.id}/timeline`)).body.rows.map((e: { kind: string }) => e.kind);
  assert.deepEqual(kinds.slice(0, 2), ['building_detached', 'building_attached']);
});

test('I099 the Lost tab has two sections, each with reason, date and Reopen, paged', async () => {
  const lostCustomer = await customer(1);
  await post(`/contacts/${lostCustomer.id}/lost`, { reason: 'Bought elsewhere' });
  for (let i = 0; i < 3; i++) { const p = (await post('/contacts', { channels: [{ type: 'email', handle: `l${i}@x.com` }] })).body; t.clock.now += 1000; await post(`/contacts/${p.id}/lost`, { reason: 'No response' }); }
  const lost = (await get('/lost?limit=2')).body;
  assert.deepEqual([lost.prospects.total, lost.prospects.rows.length, lost.prospects.hasMore, lost.customers.total], [3, 2, true, 1]);
  assert.deepEqual([lost.customers.rows[0].lostReason, lost.customers.rows[0].lostAt > 0, lost.customers.rows[0].segment], ['Bought elsewhere', true, 'lost_customer']);
  assert.equal((await post(`/contacts/${lost.customers.rows[0].id}/reopen`)).body.segment, 'customer');
  assert.equal((await get('/lost')).body.customers.total, 0);
  assert.equal(DAY, 86_400_000);
});

test('I100 reports: day, week and month with the previous period and timezone; an invalid period or date is 400', async () => {
  const get2 = async (q: string) => (await get(`/reports?${q}`)).body;
  await post('/contacts', { channels: [{ type: 'email', handle: 'a@x.com' }] });
  const day = await get2('period=day'), week = await get2('period=week'), month = await get2('period=month');
  assert.deepEqual([day.period.label, week.period.label, month.period.label], ['2026-03-16', '2026-W12', '2026-03']);
  assert.deepEqual([day.previous.label, week.previous.label, month.previous.label], ['2026-03-15', '2026-W11', '2026-02']);
  assert.deepEqual([week.period.startDay, week.period.endDay], ['2026-03-16', '2026-03-23']);
  for (const q of ['period=year', 'period=day&date=2026-02-30', 'period=day&date=junk']) assert.equal((await get(`/reports?${q}`)).status, 400, q);
  t.clock.now = Date.parse('2026-03-16T12:00:00Z');
  await t.send('PATCH', t.crm(id, '/settings'), { timezone: 'Pacific/Auckland' });
  assert.equal((await get2('period=day')).period.label, '2026-03-17', 'the Building timezone decides today');
});

test('I101 metrics follow the definitions: prospects added, reachouts sent, followups sent, on time vs delayed with the delay, lost prospects, lost customers, new customers', async () => {
  const mk = async (n: number, type = 'instagram') => (await post('/contacts', { name: `P${n}`, channels: [{ type, handle: `h${n}` }] })).body;
  const a = await mk(1);
  const r = (await post(`/contacts/${a.id}/reachouts`, { channelId: a.channels[0].id })).body;
  await post(`/followups/${r.id}/submit`, { choice: 'sent' });
  t.clock.now += 2 * DAY + 10 * 60_000; await post('/tick');
  const f1 = (await t.api(t.crm(id, `/followups?contactId=${a.id}&state=pending`))).body.rows[0];
  t.clock.now += 45 * 60_000;
  await post(`/followups/${f1.id}/submit`, { choice: 'sent' });
  const b = await mk(2), c = await customer(3), d = await customer(4);
  await post(`/contacts/${b.id}/lost`, { reason: 'Other' });
  await post(`/contacts/${d.id}/lost`, { reason: 'Other' });
  const m = (await get('/reports?period=week&date=2026-03-18')).body.period.metrics;
  assert.deepEqual([m.prospectsAdded, m.reachoutsSent, m.followupsSent, m.onTime, m.delayed, m.maxDelayMinutes, m.lostProspects, m.lostCustomers, m.newCustomers], [4, 1, 1, 0, 1, 55, 1, 1, 2]);
  assert.ok(c.id);
});

test('I102 no data is null, not 0; a period before the first record says so; counts stay stable after a contact changes segment', async () => {
  const empty = (await get('/reports?period=day')).body;
  assert.deepEqual([empty.hasRecords, empty.period.metrics.prospectsAdded, empty.period.metrics.lostCustomers], [false, null, null]);
  const c = (await post('/contacts', { channels: [{ type: 'email', handle: 'a@x.com' }] })).body;
  const before = (await get('/reports?period=day')).body.period.metrics;
  assert.deepEqual([before.prospectsAdded, before.reachoutsSent], [1, null]);
  const old = (await get('/reports?period=day&date=2026-03-01')).body;
  assert.deepEqual([old.beforeFirstRecord, old.firstRecordDay, old.period.metrics.prospectsAdded], [true, '2026-03-16', null]);
  t.clock.now += DAY;
  await post(`/contacts/${c.id}/lost`, { reason: 'Other' });
  const after = (await get('/reports?period=day&date=2026-03-16')).body.period.metrics;
  assert.equal(JSON.stringify(after), JSON.stringify(before));
});

test('I103 breakdowns by channel and by batch/source; CSV export of each table is text/csv with formula cells prefixed by an apostrophe', async () => {
  const ig = (await post('/contacts', { channels: [{ type: 'instagram', handle: '@a' }] })).body;
  const r = (await post(`/contacts/${ig.id}/reachouts`, { channelId: ig.channels[0].id })).body;
  await post(`/followups/${r.id}/submit`, { choice: 'sent' });
  await post('/import/paste', { text: 'x@y.com', channel: 'email', batchName: '=SUM(1+1)' });
  const rep = (await get('/reports?period=day')).body;
  assert.deepEqual(rep.byChannel.map((x: { label: string; reachoutsSent: number }) => [x.label, x.reachoutsSent]), [['instagram', 1]]);
  assert.deepEqual(rep.bySource.map((x: { label: string; added: number }) => [x.label, x.added]).sort(), [['=SUM(1+1)', 1], ['added by hand', 1]]);
  for (const table of ['summary', 'by-channel', 'by-source']) {
    const res = await t.api(t.crm(id, `/reports/export?period=day&table=${table}`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/csv/);
    assert.match(res.headers.get('content-disposition')!, /crm-.*-2026-03-16\.csv/);
  }
  assert.match((await t.api(t.crm(id, '/reports/export?period=day&table=by-source'))).text, /'=SUM\(1\+1\)/);
  assert.equal((await t.api(t.crm(id, '/reports/export?period=day&table=nope'))).status, 400);
  assert.equal((await t.api(t.crm(id, '/reports/export?period=day'))).status, 400);
});
