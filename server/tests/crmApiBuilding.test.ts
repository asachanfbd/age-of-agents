import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CRM_TABS } from '../src/crm/limits.ts';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';

let t: CrmApi;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });

const exists = (p: string) => access(p).then(() => true, () => false);

test('I001 a CRM Building can be created; the Type is listed and the tabs are in the stated order', async () => {
  const types = await t.api('/api/building-types');
  const crm = types.body.find((x: { id: string }) => x.id === 'crm');
  assert.deepEqual([crm.name, crm.devOnly, crm.repository, crm.category], ['CRM', false, false, 'Sales']);
  const id = await t.createCrm();
  const project = (await t.api(`/api/projects/${id}`)).body;
  assert.deepEqual([project.typeId, project.readOnly], ['crm', false]);
  assert.deepEqual([...CRM_TABS], ['Calendar', 'Prospects', 'Customers', 'Lost', 'Import', 'Merge', 'Notes (MOM)', 'Reports', 'Settings']);
  const bad = await t.send('POST', '/api/projects', { typeId: 'crm', name: '  ' });
  assert.deepEqual([bad.status, bad.body.field], [400, 'name']);
});

test('I002 deleting a CRM Building removes its database, files and secrets; a second delete is 404', async () => {
  const id = await t.createCrm('To delete');
  await t.send('PATCH', t.crm(id, '/settings'), { smtp: { host: 'h', from: 'a@b.co', user: 'u', password: 'pw-delete-me' } });
  const c = (await t.send('POST', t.crm(id, '/contacts'), { channels: [{ type: 'email', handle: 'a@b.co' }] })).body;
  assert.ok(c.id);
  const dir = path.join(t.dataDir, 'buildings', id);
  assert.ok(await exists(path.join(dir, 'crm.sqlite')));
  assert.ok(await exists(path.join(dir, 'secrets.json')));
  assert.equal((await t.send('DELETE', `/api/projects/${id}`)).status, 204);
  assert.equal(await exists(dir), false);
  assert.equal((await t.send('DELETE', `/api/projects/${id}`)).status, 404);
  assert.equal((await t.api(t.crm(id, '/contacts'))).status, 404);
});

test('I003 every CRM route on an unknown Building is 404, and on a Building of another Type is 404', async () => {
  const seo = await t.send('POST', '/api/projects', { typeId: 'seo', siteUrl: 'https://example.com' });
  const routes: Array<[string, string]> = [['GET', '/contacts'], ['GET', '/calendar'], ['GET', '/settings'], ['GET', '/reports'], ['GET', '/customers'], ['GET', '/lost'], ['POST', '/import/paste'], ['GET', '/moms']];
  for (const target of ['no-such-building', seo.body.id]) for (const [method, suffix] of routes) {
    const res = await t.send(method, t.crm(target, suffix), method === 'POST' ? {} : undefined);
    assert.equal(res.status, 404, `${method} ${suffix} on ${target}`);
    assert.equal(typeof res.body.error, 'string');
  }
});

test('I004 each CRM Building has its own database file; two Buildings never see each other\'s contacts', async () => {
  const a = await t.createCrm('A'), b = await t.createCrm('B');
  await t.send('POST', t.crm(a, '/contacts'), { name: 'Only in A', channels: [{ type: 'email', handle: 'same@x.com' }] });
  assert.equal((await t.api(t.crm(b, '/contacts'))).body.total, 0);
  assert.equal((await t.send('POST', t.crm(b, '/contacts'), { channels: [{ type: 'email', handle: 'same@x.com' }] })).status, 201);
  assert.ok(await exists(path.join(t.dataDir, 'buildings', a, 'crm.sqlite')));
  assert.ok(await exists(path.join(t.dataDir, 'buildings', b, 'crm.sqlite')));
});

test('I005 a contact written before a custom field existed reads the field as empty through the API', async () => {
  const id = await t.createCrm();
  const c = (await t.send('POST', t.crm(id, '/contacts'), { channels: [{ type: 'email', handle: 'old@x.com' }] })).body;
  const field = (await t.send('POST', t.crm(id, '/settings/custom-fields'), { name: 'Region' })).body;
  const read = (await t.api(t.crm(id, `/contacts/${c.id}`))).body;
  assert.equal(read.custom[field.id], '');
  const list = (await t.api(t.crm(id, '/contacts'))).body;
  assert.equal(list.rows[0].custom[field.id], '');
});

test('I006 a read-only Building answers 409 on every write route, writes nothing, and every read route still answers 200', async () => {
  const id = await t.createCrm('Frozen');
  const c = (await t.send('POST', t.crm(id, '/contacts'), { name: 'Ann', channels: [{ type: 'email', handle: 'ann@x.com' }] })).body;
  await t.projectsDb.update(id, { readOnlyReason: 'Migration failed for the test' });
  const writes: Array<[string, string, unknown?]> = [
    ['POST', '/contacts', { channels: [{ type: 'email', handle: 'n@x.com' }] }], ['PATCH', `/contacts/${c.id}`, { name: 'x' }], ['POST', `/contacts/${c.id}/channels`, { type: 'email', handle: 'm@x.com' }],
    ['PUT', `/contacts/${c.id}/dnc`, { dnc: true }], ['PUT', `/contacts/${c.id}/stage`, { stage: 'Contacted' }], ['POST', `/contacts/${c.id}/lost`, { reason: 'Other' }], ['POST', `/contacts/${c.id}/customer`],
    ['POST', `/contacts/${c.id}/timeline/comments`, { text: 'x' }], ['POST', `/contacts/${c.id}/reachouts`, { channelId: 1 }], ['POST', `/contacts/${c.id}/followups`, { type: 'call', dueAt: T() }],
    ['POST', `/contacts/${c.id}/responses`, { outcome: 'no_response_yet' }], ['POST', '/tick', {}], ['POST', '/import/csv/commit', {}], ['POST', '/import/paste', { text: 'a@b.co', channel: 'email' }],
    ['POST', '/merge', { firstId: 1, secondId: 2 }], ['POST', '/merge/1/undo', {}], ['POST', '/merge/suggestions/dismiss', { firstId: 1, secondId: 2 }], ['POST', '/moms', { followupId: 1 }],
    ['PATCH', '/settings', { onTimeMinutes: 5 }], ['POST', '/settings/custom-fields', { name: 'F' }], ['POST', '/settings/smtp/test', { to: 'a@b.co' }], ['POST', '/calendar/blocks/2026-03-16/calls:0', { action: 'skip' }],
    ['PUT', '/calendar/slots/2026-03-16/reachouts', { skipped: true }], ['POST', '/followups/1/submit', { choice: 'sent' }], ['POST', '/followups/1/approve', {}], ['POST', `/contacts/${c.id}/buildings`, { buildingId: 'x' }],
  ];
  for (const [method, suffix, body] of writes) {
    const res = await t.send(method, t.crm(id, suffix), body ?? {});
    assert.equal(res.status, 409, `${method} ${suffix}: ${res.text}`);
    assert.equal(res.body.error, 'Migration failed for the test');
  }
  for (const suffix of ['/contacts', `/contacts/${c.id}`, `/contacts/${c.id}/timeline`, '/calendar', '/expand-today', '/customers', '/lost', '/settings', '/reports', '/moms', '/batches', '/followups', '/merge/suggestions']) {
    assert.equal((await t.api(t.crm(id, suffix))).status, 200, suffix);
  }
  assert.equal((await t.api(t.crm(id, '/contacts'))).body.total, 1);
  assert.equal((await t.api(t.crm(id, `/contacts/${c.id}/timeline`))).body.total, 1, 'nothing was written');
});
const T = () => Date.parse('2026-03-17T09:00:00Z');

test('I007 body-validation failures are 400 { error }, unknown ids 404, conflicts 409; malformed and non-object bodies are 400', async () => {
  const id = await t.createCrm();
  const bad = await t.send('POST', t.crm(id, '/contacts'), { channels: [] });
  assert.deepEqual([bad.status, typeof bad.body.error], [400, 'string']);
  assert.equal((await t.api(t.crm(id, '/contacts/999'))).status, 404);
  assert.equal((await t.api(t.crm(id, '/contacts/abc'))).status, 404);
  const malformed = await t.api(t.crm(id, '/contacts'), { method: 'POST', body: '{nope' });
  assert.equal(malformed.status, 400);
  assert.equal(typeof malformed.body.error, 'string');
  for (const body of ['[1,2]', '"text"', '5']) assert.equal((await t.api(t.crm(id, '/contacts'), { method: 'POST', body })).status, 400, body);
  await t.send('POST', t.crm(id, '/contacts'), { channels: [{ type: 'email', handle: 'dup@x.com' }] });
  assert.equal((await t.send('POST', t.crm(id, '/contacts'), { channels: [{ type: 'email', handle: 'DUP@x.com' }] })).status, 409);
});
