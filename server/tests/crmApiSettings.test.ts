import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { CUSTOM_FIELDS_MAX } from '../src/crm/limits.ts';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';

let t: CrmApi;
let id: string;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });
beforeEach(async () => { t.reset(); id = await t.createCrm(); });

const get = (suffix: string) => t.api(t.crm(id, suffix));
const patch = (body: unknown) => t.send('PATCH', t.crm(id, '/settings'), body);
const post = (suffix: string, body: unknown = {}) => t.send('POST', t.crm(id, suffix), body);

test('I104 a fresh Building returns every default: cadence, retry, resurface, caps, sessions, durations, slots, reasons, on-time window, auto-lost off, approval on, agents off', async () => {
  const s = (await get('/settings')).body;
  assert.deepEqual(s.cadence, { gapDays: [2, 4], followups: 2, retryHours: 2, retryTries: 3, autoLost: false, resurfaceDays: 30 });
  assert.deepEqual(s.email, { dailyCap: 50, gapSeconds: 60 });
  assert.deepEqual(s.sessions, { messagesPer30: 40, callsPer30: 15 });
  assert.deepEqual([s.durations.online_meeting, s.durations.in_person_meeting, s.durations.appointment, s.durations.call, s.durations.message], [30, 60, 60, 2, 1]);
  assert.deepEqual(s.dailySlots.map((x: { name: string; minutes: number; start: null }) => [x.name, x.minutes, x.start]), [['Reachouts', 60, null], ['Finding new prospects', 60, null]]);
  assert.deepEqual(s.lostReasons, ['Not interested', 'No response', 'Wrong fit', 'Bought elsewhere', 'Do not contact', 'Other']);
  assert.deepEqual([s.onTimeMinutes, s.approval.email ?? false, s.agentAutoApply, s.customFields, s.countryCode], [30, false, { messageDrafts: false, moms: false }, [], null]);
  assert.equal(s.workingHours.length, 7);
  assert.deepEqual([s.workingHours[0].open, s.workingHours[1].open, s.workingHours[1].start, s.workingHours[1].end], [false, true, '09:00', '17:00']);
  assert.match(s.emailFooter, /unsubscribe/);
  assert.deepEqual([s.smtp.status.state, s.smtp.status.passwordSaved, s.smtp.port, s.smtp.security], ['not_connected', false, 587, 'starttls']);
});

test('I105 PATCH validates each field with 400, keeps the rest on a partial change, and a read-only Building answers 409', async () => {
  const bad: unknown[] = [
    { cadence: { followups: 11 } }, { cadence: { gapDays: [1] } }, { cadence: { gapDays: [-1, 2] } }, { cadence: { retryTries: 0 } }, { email: { dailyCap: 0 } }, { sessions: { callsPer30: 1.5 } },
    { timezone: 'Nowhere/City' }, { countryCode: '9999' }, { workingHours: [] }, { dailySlots: [{ name: '', minutes: 5 }] }, { lostReasons: [] }, { templates: { bogus: 'x' } },
    { durations: { call: 0 } }, { smtp: { port: 70000 } }, { onTimeMinutes: -1 }, { mystery: 1 }, { approval: { email: 'yes' } }, { emailFooter: 5 },
  ];
  for (const body of bad) assert.equal((await patch(body)).status, 400, JSON.stringify(body));
  assert.equal((await t.send('PATCH', t.crm(id, '/settings'), [1])).status, 400);
  await patch({ cadence: { followups: 5 }, countryCode: '+49', timezone: 'Europe/Berlin' });
  await patch({ cadence: { resurfaceDays: 0 } });
  const s = (await get('/settings')).body;
  assert.deepEqual([s.cadence.followups, s.cadence.resurfaceDays, s.cadence.retryTries, s.countryCode, s.timezone], [5, 0, 3, '49', 'Europe/Berlin']);
  await t.projectsDb.update(id, { readOnlyReason: 'Frozen for the test' });
  assert.equal((await patch({ onTimeMinutes: 5 })).status, 409);
  assert.equal((await get('/settings')).body.onTimeMinutes, 30);
});

test('I106 custom fields: create, rename, delete; a duplicate name ignoring case is 409, the 21st is 400, deleting a field in use is blocked 409 with the count', async () => {
  const a = (await post('/settings/custom-fields', { name: 'Region' })).body;
  assert.equal((await post('/settings/custom-fields', { name: ' region ' })).status, 409);
  assert.equal((await post('/settings/custom-fields', { name: '  ' })).status, 400);
  assert.equal((await t.send('PATCH', t.crm(id, `/settings/custom-fields/${a.id}`), { name: 'Area' })).body.name, 'Area');
  assert.equal((await t.send('PATCH', t.crm(id, '/settings/custom-fields/nope'), { name: 'X' })).status, 404);
  for (let i = 1; i < CUSTOM_FIELDS_MAX; i++) assert.equal((await post('/settings/custom-fields', { name: `Field ${i}` })).status, 201);
  assert.equal((await post('/settings/custom-fields', { name: 'One too many' })).status, 400);
  const c = (await post('/contacts', { channels: [{ type: 'email', handle: 'a@x.com' }], custom: { [a.id]: 'EU' } })).body;
  const blocked = await t.send('DELETE', t.crm(id, `/settings/custom-fields/${a.id}`));
  assert.deepEqual([blocked.status, blocked.body.details.inUse], [409, 1]);
  await t.send('PATCH', t.crm(id, `/contacts/${c.id}`), { custom: { [a.id]: '' } });
  assert.equal((await t.send('DELETE', t.crm(id, `/settings/custom-fields/${a.id}`))).status, 204);
  assert.equal((await t.send('DELETE', t.crm(id, `/settings/custom-fields/${a.id}`))).status, 404);
});

test('I107 lost reasons: deleting one in use is 409 with the count; a rename updates existing contacts; the default list is present on a fresh Building', async () => {
  const c = (await post('/contacts', { channels: [{ type: 'email', handle: 'a@x.com' }] })).body;
  await post(`/contacts/${c.id}/lost`, { reason: 'Wrong fit' });
  const reasons = (await get('/settings')).body.lostReasons as string[];
  assert.equal(reasons.length, 6);
  const blocked = await patch({ lostReasons: reasons.filter((r) => r !== 'Wrong fit') });
  assert.deepEqual([blocked.status, blocked.body.details.inUse, /1 lost contact/.test(blocked.body.error)], [409, 1, true]);
  assert.equal((await patch({ lostReasons: reasons.filter((r) => r !== 'Other') })).status, 200);
  const renamed = await t.send('PUT', t.crm(id, '/settings/lost-reasons/Wrong%20fit'), { name: 'Poor fit' });
  assert.deepEqual([renamed.status, renamed.body.lostReasons.includes('Poor fit')], [200, true]);
  assert.equal((await get(`/contacts/${c.id}`)).body.lostReason, 'Poor fit');
  assert.equal((await t.send('PUT', t.crm(id, '/settings/lost-reasons/Missing'), { name: 'X' })).status, 404);
  assert.equal((await t.send('PUT', t.crm(id, '/settings/lost-reasons/Poor%20fit'), { name: 'not interested' })).status, 400);
  assert.equal((await post(`/contacts/${(await post('/contacts', { channels: [{ type: 'email', handle: 'b@x.com' }] })).body.id}/lost`, { reason: 'Wrong fit' })).status, 400, 'the old name is gone');
});

test('I108 templates are saved per channel and step; an unknown field is accepted and reported when used', async () => {
  const res = await patch({ templates: { 'email:0': 'Hi {name}, {nope}', 'instagram:2': 'Third touch' } });
  assert.deepEqual([res.status, res.body.templates['email:0'], res.body.templates['instagram:2']], [200, 'Hi {name}, {nope}', 'Third touch']);
  const c = (await post('/contacts', { name: 'Ann', channels: [{ type: 'email', handle: 'a@x.com' }] })).body;
  const r = (await post(`/contacts/${c.id}/reachouts`, { channelId: c.channels[0].id })).body;
  assert.deepEqual([r.message, r.unknownFields], ['Hi Ann, {nope}', ['nope']]);
  assert.equal((await patch({ templates: { 'email:0': 5 } })).status, 400);
  assert.equal((await patch({ templates: { 'email:0': 'x'.repeat(20_001) } })).status, 400);
  assert.equal((await patch({ templates: { 'email:x': 'x' } })).status, 400);
});
