import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendar, decideBlock, expandToday, overrideSlot, parseFrom } from '../src/crm/calendar.ts';
import { createContact } from '../src/crm/contacts.ts';
import { tick } from '../src/crm/engine.ts';
import { createReachout, createTask, submitManual } from '../src/crm/followups.ts';
import { logResponse } from '../src/crm/responses.ts';
import { defaultSettings } from '../src/crm/settings.ts';
import type { CrmSettings } from '../src/crm/settings.ts';
import { addDays } from '../src/crm/zoned.ts';
import { harness, T0 } from './helpers/crmFakes.ts';
import type { Harness } from './helpers/crmFakes.ts';

const DAY = 86_400_000, MIN = 60_000, HOUR = 3_600_000;
const withSettings = (h: Harness, p: Partial<CrmSettings>) => h.ctx.saveSettings({ ...h.ctx.settings(), ...p });
const person = (h: Harness, n: number) => createContact(h.ctx, { name: `P${n}`, channels: [{ type: 'instagram', handle: `@p${n}` }] });
const addTasks = (h: Harness, n: number, type: 'call' | 'message', dueAt = T0) => Array.from({ length: n }, (_, i) => { const c = person(h, Math.round(Math.random() * 1e9) + i); return createTask(h.ctx, c.id, { type, dueAt, channelId: c.channels[0]!.id }); });

test('U069 the window is Today, Tomorrow, Day after; paging moves exactly one day across month and year ends', () => {
  const h = harness();
  const v = calendar(h.ctx, {});
  assert.deepEqual(v.days.map((d) => [d.day, d.label]), [['2026-03-16', 'Today'], ['2026-03-17', 'Tomorrow'], ['2026-03-18', 'Day after']]);
  assert.deepEqual(calendar(h.ctx, { from: '2026-03-17' }).days.map((d) => d.day), ['2026-03-17', '2026-03-18', '2026-03-19']);
  assert.deepEqual(calendar(h.ctx, { from: '2026-12-30' }).days.map((d) => d.day), ['2026-12-30', '2026-12-31', '2027-01-01']);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.throws(() => parseFrom(h.ctx, { view: 'week' }), /by day only/);
  assert.throws(() => parseFrom(h.ctx, { from: '2026-02-30' }), /date/);
});

test('U077 suggested blocks fill free time: none when there is no free time, the right number when there is, never over a fixed item', () => {
  const h = harness();
  withSettings(h, { dailySlots: [], sessions: { messagesPer30: 40, callsPer30: 1 } });
  withSettings(h, { workingHours: defaultSettings('UTC').workingHours.map((d) => ({ ...d, end: '16:30' })) });
  addTasks(h, 20, 'call');
  createTask(h.ctx, person(h, 1).id, { type: 'online_meeting', dueAt: T0 + HOUR, durationMin: 60 });
  const today = calendar(h.ctx, {}).days[0]!;
  const placed = today.sessions.filter((s) => s.state === 'suggested');
  assert.equal(today.sessions.length, 20);
  assert.equal(placed.length, 13, '7h30 minus the 1 h meeting leaves 6h30 = 13 blocks');
  const fixed = today.fixed[0]!;
  for (const s of placed) assert.ok(s.end! <= fixed.start || s.start! >= fixed.end, 'no overlap with the meeting');
  assert.equal(today.sessions.filter((s) => s.state === 'unplaced').length, 7);
  const closed = harness();
  withSettings(closed, { workingHours: defaultSettings('UTC').workingHours.map((d) => ({ ...d, open: false })), dailySlots: [] });
  addTasks(closed, 3, 'call');
  assert.ok(calendar(closed.ctx, {}).days[0]!.sessions.every((s) => s.state === 'unplaced'));
});

test('U078 accept books a block, skip removes it for that day only, move needs a gap and refuses a fixed item', () => {
  const h = harness();
  withSettings(h, { dailySlots: [], sessions: { messagesPer30: 40, callsPer30: 1 } });
  addTasks(h, 2, 'call');
  addTasks(h, 1, 'call', T0 + DAY);
  createTask(h.ctx, person(h, 1).id, { type: 'appointment', dueAt: T0 + 3 * HOUR, durationMin: 60 });
  let day = calendar(h.ctx, {}).days[0]!;
  assert.equal(day.sessions[0]!.state, 'suggested');
  decideBlock(h.ctx, '2026-03-16', 'calls:0', { action: 'accept' });
  day = calendar(h.ctx, {}).days[0]!;
  assert.equal(day.sessions.find((s) => s.key === 'calls:0')!.state, 'accepted');
  assert.throws(() => decideBlock(h.ctx, '2026-03-16', 'calls:1', { action: 'move', start: '12:15' }), /taken/);
  decideBlock(h.ctx, '2026-03-16', 'calls:1', { action: 'move', start: '15:00' });
  const moved = calendar(h.ctx, {}).days[0]!.sessions.find((s) => s.key === 'calls:1')!;
  assert.deepEqual([moved.state, new Date(moved.start!).toISOString()], ['accepted', '2026-03-16T15:00:00.000Z']);
  assert.throws(() => decideBlock(h.ctx, '2026-03-16', 'calls:1', { action: 'move', start: '18:00' }), /outside working hours/);
  decideBlock(h.ctx, '2026-03-16', 'calls:0', { action: 'skip' });
  const after = calendar(h.ctx, {}).days;
  assert.ok(!after[0]!.sessions.some((s) => s.key === 'calls:0'));
  assert.equal(after[1]!.sessions.length, 1, 'tomorrow is untouched');
  assert.throws(() => decideBlock(h.ctx, '2026-03-16', 'calls:9', { action: 'skip' }), /does not exist/);
});

test('U081 resizing, moving or skipping a slot for one day leaves the default untouched', () => {
  const h = harness();
  overrideSlot(h.ctx, '2026-03-16', 'reachouts', { minutes: 30, start: '13:00' });
  overrideSlot(h.ctx, '2026-03-16', 'finding', { skipped: true });
  const [today, tomorrow] = calendar(h.ctx, {}).days;
  const slot = (d: typeof today, id: string) => d!.slots.find((s) => s.id === id)!;
  assert.deepEqual([slot(today, 'reachouts').minutes, slot(today, 'reachouts').fixedStart, slot(today, 'finding').state], [30, true, 'skipped']);
  assert.deepEqual([slot(tomorrow, 'reachouts').minutes, slot(tomorrow, 'reachouts').fixedStart, slot(tomorrow, 'finding').state], [60, false, 'placed']);
  assert.deepEqual(h.ctx.settings().dailySlots.map((s) => [s.minutes, s.start]), [[60, null], [60, null]]);
  for (const bad of [{ minutes: 0 }, { minutes: 1.5 }, { start: '25:00' }, { skipped: 'yes' }]) assert.throws(() => overrideSlot(h.ctx, '2026-03-16', 'reachouts', bad));
  assert.throws(() => overrideSlot(h.ctx, '2026-03-16', 'nope', {}), /does not exist/);
});

test('U082 an "anywhere" slot longer than the free time is flagged "no room"; a fixed-start slot over a meeting shows a conflict', () => {
  const h = harness();
  withSettings(h, { dailySlots: [{ id: 's1', name: 'Long', minutes: 600, start: null }, { id: 's2', name: 'Fixed', minutes: 60, start: '10:00' }] });
  createTask(h.ctx, person(h, 1).id, { type: 'appointment', dueAt: T0 + HOUR, durationMin: 60 });
  const slots = calendar(h.ctx, {}).days[0]!.slots;
  assert.equal(slots.find((s) => s.id === 's1')!.state, 'no_room');
  assert.equal(slots.find((s) => s.id === 's2')!.conflict, true);
});

test('U085 overdue items come first in Today, oldest due first, marked overdue', () => {
  const h = harness();
  const [a, b, c] = [person(h, 1), person(h, 2), person(h, 3)];
  const mkTask = (cn: typeof a, dueAt: number) => createTask(h.ctx, cn.id, { type: 'other', dueAt, title: `t${dueAt - T0}` });
  mkTask(a, T0 - DAY); mkTask(b, T0 - 3 * DAY); mkTask(c, T0 + HOUR);
  const today = calendar(h.ctx, {}).days[0]!;
  assert.deepEqual(today.overdue.map((i) => i.dueAt - T0), [-3 * DAY, -DAY]);
  assert.ok(today.overdue.every((i) => i.overdue));
  assert.equal(calendar(h.ctx, {}).days[1]!.overdue.length, 0);
});

test('U087 Expand Today groups appear in the stated order', async () => {
  const h = harness();
  const r = expandToday(h.ctx);
  assert.deepEqual(r.groups.map((g) => g.id), ['sent_no_response', 'overdue', 'awaiting_approval', 'failed_retry', 'agenda']);
  assert.deepEqual(r.groups.map((g) => g.cards.length), [0, 0, 0, 0, 1], 'only the agenda (the two default daily slots) has a card');
});

test('U088 sent-no-response: older than the first check window and within 30 days; a logged reply excludes it', async () => {
  const h = harness();
  const mk = (n: number) => { const c = person(h, n); const f = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id }).followup; submitManual(h.ctx, f.id, { choice: 'sent' }); return c; };
  const young = mk(1);
  h.advance(DAY);
  assert.equal(expandToday(h.ctx).groups[0]!.cards.length, 0, 'inside the first check window');
  h.advance(DAY);
  assert.equal(expandToday(h.ctx).groups[0]!.cards.length, 1);
  logResponse(h.ctx, young.id, { outcome: 'no_response_yet' });
  assert.equal(expandToday(h.ctx).groups[0]!.cards.length, 0, 'checked today');
  h.advance(DAY);
  assert.equal(expandToday(h.ctx).groups[0]!.cards.length, 1, 'back tomorrow');
  logResponse(h.ctx, young.id, { outcome: 'interested', nextAction: { type: 'other', dueAt: h.clock.now + DAY } });
  assert.equal(expandToday(h.ctx).groups[0]!.cards.length, 0);
  const old = harness();
  const c = person(old, 1);
  const f = createReachout(old.ctx, c.id, { channelId: c.channels[0]!.id }).followup;
  submitManual(old.ctx, f.id, { choice: 'sent' });
  old.advance(30 * DAY); assert.equal(expandToday(old.ctx).groups[0]!.cards.length, 1, 'exactly 30 days is included');
  old.advance(1); assert.equal(expandToday(old.ctx).groups[0]!.cards.length, 0, 'older than 30 days is not');
});

test('U089 failed items whose retry is in the future are excluded; items that used all tries are included', async () => {
  const h = harness();
  const c = person(h, 1);
  const f = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id }).followup;
  submitManual(h.ctx, f.id, { choice: 'retry' });
  const failed = () => expandToday(h.ctx).groups.find((g) => g.id === 'failed_retry')!.cards.length;
  assert.equal(failed(), 0);
  h.advance(2 * HOUR); await tick(h.ctx);
  for (let i = 0; i < 2; i++) { submitManual(h.ctx, f.id, { choice: 'retry' }); h.advance(2 * HOUR); await tick(h.ctx); }
  assert.equal(failed(), 1, 'the third failure used all tries and sits in the catch-up');
});

test('U090/U091 each group has its own empty text; the total counts every card across groups', () => {
  const h = harness();
  const empty = expandToday(h.ctx);
  assert.deepEqual(empty.groups.map((g) => g.emptyText), ['Nothing is waiting for a response.', 'No followups are overdue.', 'No messages are waiting for approval.', 'No failed items need a retry.', 'Nothing is planned for today.']);
  const c = person(h, 1);
  createTask(h.ctx, c.id, { type: 'other', dueAt: T0 - DAY });
  createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id });
  const r = expandToday(h.ctx);
  assert.equal(r.total, r.groups.reduce((n, g) => n + g.cards.length, 0));
  assert.ok(r.total >= 2);
});

test('U092 the agenda card lists today\'s fixed items, slots and sessions in time order', () => {
  const h = harness();
  withSettings(h, { dailySlots: [{ id: 'x', name: 'Slot', minutes: 30, start: '15:00' }] });
  createTask(h.ctx, person(h, 1).id, { type: 'online_meeting', dueAt: T0 + HOUR, durationMin: 30 });
  addTasks(h, 2, 'call');
  const agenda = expandToday(h.ctx).groups[4]!.cards[0] as { entries: Array<{ card: string }>; freeMinutes: number };
  assert.deepEqual(agenda.entries.map((e) => e.card), ['session', 'fixed', 'slot']);
  assert.ok(agenda.freeMinutes > 0);
});

test('I083 (engine part) item ids stay unique across days and a past date is accepted as overdue', () => {
  const h = harness();
  const c = person(h, 1);
  const t = createTask(h.ctx, c.id, { type: 'call', dueAt: T0 - 5 * DAY });
  assert.equal(calendar(h.ctx, {}).days[0]!.overdue[0]!.id, t.id);
  assert.throws(() => createTask(h.ctx, c.id, { type: 'call', dueAt: 'soon' }), /dueAt/);
  assert.throws(() => createTask(h.ctx, c.id, { type: 'call', message: 'x', dueAt: T0 }), /no message/);
  assert.equal(MIN, 60_000);
});

test('a failed item waiting for its 2-hour retry is not flagged overdue in Today', async () => {
  const { submitManual: submit } = await import('../src/crm/followups.ts');
  const h = harness();
  const c = person(h, 1);
  const f = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id, dueAt: T0 - 3 * DAY }).followup;
  assert.equal(calendar(h.ctx, {}).days[0]!.overdue.length, 1, 'a pending item from days ago is overdue');
  submit(h.ctx, f.id, { choice: 'retry' });
  const today = calendar(h.ctx, {}).days[0]!;
  assert.deepEqual([today.overdue.length, today.sessions.flatMap((s) => s.items).filter((i) => i.id === f.id).map((i) => i.overdue)], [0, [false]]);
});
