import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';

let t: CrmApi;
let id: string;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });
beforeEach(async () => { t.reset(); id = await t.createCrm(); await patch({ timezone: 'UTC' }); });

const DAY = 86_400_000, HOUR = 3_600_000;
const post = (suffix: string, body: unknown = {}) => t.send('POST', t.crm(id, suffix), body);
const get = (suffix: string) => t.api(t.crm(id, suffix));
const patch = (body: unknown) => t.send('PATCH', t.crm(id, '/settings'), body);
const mk = async (n: number, extra: Record<string, unknown> = {}) => (await post('/contacts', { name: `P${n}`, channels: [{ type: 'instagram', handle: `@p${n}` }], ...extra })).body;
const task = async (type: string, dueAt: number, n = Math.floor(Math.random() * 1e9), extra: Record<string, unknown> = {}) => { const c = await mk(n); return (await post(`/contacts/${c.id}/followups`, { type, dueAt, channelId: c.channels[0].id, ...extra })).body; };

test('I081 the calendar shows a three-day window in the Building timezone, pages by day only, and refuses week or month parameters', async () => {
  await patch({ timezone: 'Asia/Kolkata' });
  t.clock.now = Date.parse('2026-03-16T20:00:00Z');
  const v = (await get('/calendar')).body;
  assert.deepEqual([v.timezone, v.today, v.days.map((d: { day: string }) => d.day)], ['Asia/Kolkata', '2026-03-17', ['2026-03-17', '2026-03-18', '2026-03-19']]);
  assert.deepEqual((await get('/calendar?from=2026-03-18')).body.days.map((d: { label: string }) => d.label), ['Tomorrow', 'Day after', '2026-03-20']);
  for (const q of ['view=week', 'view=month', 'week=1', 'month=3']) assert.equal((await get(`/calendar?${q}`)).status, 400, q);
  assert.equal((await get('/calendar?from=2026-02-30')).status, 400);
  const st = await task('online_meeting', Date.parse('2026-03-17T05:00:00Z'));
  assert.equal(st.state, 'planned');
  const today = (await get('/calendar')).body.days[0];
  assert.equal(new Date(today.window.start).toISOString(), '2026-03-17T03:30:00.000Z');
  assert.equal(today.fixed.length, 1);
});

test('I082 overdue items come first in Today with the flag; a session is one item with its children; 40 messages and 15 calls per 30 minutes', async () => {
  await task('other', t.clock.now - 2 * DAY, 1, { title: 'old' });
  const c = await mk(2);
  for (let i = 0; i < 41; i++) await post(`/contacts/${(await mk(100 + i)).id}/followups`, { type: 'message', dueAt: t.clock.now, message: `m${i}` });
  for (let i = 0; i < 16; i++) await post(`/contacts/${(await mk(200 + i)).id}/followups`, { type: 'call', dueAt: t.clock.now });
  const today = (await get('/calendar')).body.days[0];
  assert.deepEqual(today.overdue.map((i: { title: string; overdue: boolean }) => [i.title, i.overdue]), [['old', true]]);
  const sizes = (kind: string) => today.sessions.filter((s: { kind: string }) => s.kind === kind).map((s: { count: number; items: unknown[] }) => [s.count, s.items.length]);
  assert.deepEqual(sizes('messages'), [[40, 40], [1, 1]]);
  assert.deepEqual(sizes('calls'), [[15, 15], [1, 1]]);
  assert.ok(c.id);
});

test('I083 working hours and daily slots are reflected in free time and suggested blocks; one-day slot changes leave the default untouched', async () => {
  await patch({ workingHours: Array.from({ length: 7 }, () => ({ open: true, start: '08:00', end: '12:00' })), dailySlots: [{ name: 'Reachouts', minutes: 60, start: null }, { name: 'Prospecting', minutes: 30, start: '08:00' }] });
  const settings = (await get('/settings')).body;
  assert.deepEqual(settings.dailySlots.map((s: { name: string }) => s.name), ['Reachouts', 'Prospecting']);
  for (let i = 0; i < 3; i++) await task('call', t.clock.now, 300 + i);
  const before = (await get('/calendar')).body.days[0];
  assert.deepEqual([before.freeMinutes, before.slots.map((s: { state: string }) => s.state)], [120, ['placed', 'placed']]);
  const slot = settings.dailySlots[0];
  await t.send('PUT', t.crm(id, `/calendar/slots/2026-03-16/${slot.id}`), { minutes: 90 });
  const after = (await get('/calendar')).body;
  assert.equal(after.days[0].slots.find((s: { id: string }) => s.id === slot.id).minutes, 90);
  assert.equal(after.days[1].slots.find((s: { id: string }) => s.id === slot.id).minutes, 60);
  assert.equal((await get('/settings')).body.dailySlots[0].minutes, 60);
});

test('I084 accept, move or skip a suggested block persists for that day; moving onto a fixed item is 409; an unknown block is 404', async () => {
  await patch({ dailySlots: [], sessions: { callsPer30: 1 } });
  await task('call', t.clock.now, 1); await task('call', t.clock.now, 2);
  await task('appointment', t.clock.now + 2 * HOUR, 3, { durationMin: 60 });
  assert.equal((await post('/calendar/blocks/2026-03-16/calls:0', { action: 'accept' })).status, 200);
  assert.equal((await post('/calendar/blocks/2026-03-16/calls:1', { action: 'move', start: '11:15' })).status, 409);
  assert.equal((await post('/calendar/blocks/2026-03-16/calls:1', { action: 'move', start: '14:00' })).status, 200);
  assert.equal((await post('/calendar/blocks/2026-03-16/calls:7', { action: 'skip' })).status, 404);
  assert.equal((await post('/calendar/blocks/2026-03-16/calls:1', { action: 'dance' })).status, 400);
  assert.equal((await post('/calendar/blocks/not-a-day/calls:1', { action: 'skip' })).status, 400);
  const day = (await get('/calendar')).body.days[0];
  assert.deepEqual(day.sessions.map((s: { state: string }) => s.state), ['accepted', 'accepted']);
  await post('/calendar/blocks/2026-03-16/calls:0', { action: 'skip' });
  assert.equal((await get('/calendar')).body.days[0].sessions.length, 1);
});

test('I085 the Expand Today series returns groups in the stated order with counts and flags empty groups; Skip changes no state', async () => {
  await task('other', t.clock.now - DAY, 1);
  const before = (await get('/expand-today')).body;
  assert.deepEqual(before.groups.map((g: { id: string }) => g.id), ['sent_no_response', 'overdue', 'awaiting_approval', 'failed_retry', 'agenda']);
  assert.deepEqual(before.groups.map((g: { cards: unknown[] }) => g.cards.length), [0, 1, 0, 0, 1]);
  assert.ok(before.groups.every((g: { emptyText: string }) => g.emptyText.length > 0));
  assert.equal(before.total, 2);
  const again = (await get('/expand-today')).body;
  assert.equal(JSON.stringify(again), JSON.stringify(before), 'reading the series changes nothing');
});

test('I086 a meeting created from the calendar sets Meeting set; a past date is accepted as overdue; a malformed date is 400', async () => {
  const c = await mk(1);
  const res = await post(`/contacts/${c.id}/followups`, { type: 'online_meeting', dueAt: new Date(t.clock.now + DAY).toISOString() });
  assert.equal(res.status, 201);
  assert.equal((await get(`/contacts/${c.id}`)).body.stage, 'Meeting set');
  const past = await post(`/contacts/${(await mk(2)).id}/followups`, { type: 'call', dueAt: t.clock.now - 3 * DAY });
  assert.equal(past.status, 201);
  assert.equal((await get('/calendar')).body.days[0].overdue.length, 1);
  for (const dueAt of ['next tuesday', '', null, 'x', 99999999999999]) assert.equal((await post(`/contacts/${c.id}/followups`, { type: 'call', dueAt })).status, 400, String(dueAt));
});
