import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chainEnd, followupDue, hasNextStep, resurfaceAt, retryOutcome } from '../src/crm/cadence.ts';
import { canSendEmail } from '../src/crm/emailCaps.ts';
import { CrmConflictError, CrmInputError } from '../src/crm/errors.ts';
import { buildSessions } from '../src/crm/sessions.ts';
import { applySettingsPatch, defaultSettings, validateCustomFieldName, validateDailySlots, validateLostReasons, validateWorkingHours, MESSAGE_TYPES } from '../src/crm/settings.ts';
import { autoStage, isLost } from '../src/crm/stage.ts';
import { renderTemplate, withFooter } from '../src/crm/templates.ts';
import { addLocalDays, dayBounds, freeIntervals, isIsoDay, localDay, parseClock, zonedMs } from '../src/crm/zoned.ts';
import { CUSTOM_FIELDS_MAX, CUSTOM_VALUE_MAX } from '../src/crm/limits.ts';

const S = (tz = 'UTC') => defaultSettings(tz);
const DAY = 86_400_000;
const patch = (p: unknown, base = S()) => applySettingsPatch(base, p);
const refuses = (p: unknown) => assert.throws(() => patch(p), CrmInputError);

// ---- stage -----------------------------------------------------------------
test('U030 automatic stage moves: reachout sent → Contacted, interested → Engaged, meeting → Meeting set', () => {
  assert.equal(autoStage('New', 'reachout_sent'), 'Contacted');
  assert.equal(autoStage('Contacted', 'response_interested'), 'Engaged');
  assert.equal(autoStage('Engaged', 'meeting_created'), 'Meeting set');
});
test('U031 automatic moves never go backwards', () => {
  assert.equal(autoStage('Engaged', 'reachout_sent'), 'Engaged');
  assert.equal(autoStage('Meeting set', 'response_interested'), 'Meeting set');
  assert.equal(autoStage('Proposal', 'meeting_created'), 'Proposal');
});
test('U032 Proposal is only reachable by hand; manual change may go backwards', async () => {
  const { harness } = await import('./helpers/crmFakes.ts');
  const { createContact, setStage } = await import('../src/crm/contacts.ts');
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@b.co' }] });
  assert.equal(setStage(h.ctx, c.id, 'Proposal').stage, 'Proposal');
  assert.equal(setStage(h.ctx, c.id, 'New').stage, 'New');
  for (const t of ['reachout_sent', 'response_interested', 'meeting_created'] as const) assert.notEqual(autoStage('New', t), 'Proposal');
});
test('U033 a lost contact has no stage; reopening a prospect gives New unless a stage is picked', async () => {
  const { harness } = await import('./helpers/crmFakes.ts');
  const { createContact, markLost, reopen } = await import('../src/crm/contacts.ts');
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@b.co' }] });
  const lost = markLost(h.ctx, c.id, 'Not interested');
  assert.deepEqual([lost.segment, lost.stage, isLost(lost.segment)], ['lost_prospect', null, true]);
  assert.equal(reopen(h.ctx, c.id).stage, 'New');
  markLost(h.ctx, c.id, 'Other');
  assert.equal(reopen(h.ctx, c.id, 'Engaged').stage, 'Engaged');
});

// ---- cadence ---------------------------------------------------------------
test('U034 followup 1 is due 2 days after the reachout; followup 2 is due 4 days after followup 1 was sent', () => {
  const s = S();
  const sent = Date.parse('2026-03-16T10:00:00Z');
  const f1 = followupDue(sent, 1, s);
  assert.equal(f1, sent + 2 * DAY);
  const f1Sent = f1 + 3 * 3_600_000;
  assert.equal(followupDue(f1Sent, 2, s), f1Sent + 4 * DAY);
});
test('U035 gaps are editable (0, 1, 365 days) and keep the local wall time across a DST change', () => {
  const s = patch({ cadence: { gapDays: [0, 365] }, timezone: 'Europe/Berlin' });
  const sent = zonedMs('2026-03-28', 10 * 60, 'Europe/Berlin');
  assert.equal(followupDue(sent, 1, s), sent);
  const one = patch({ cadence: { gapDays: [1, 1] }, timezone: 'Europe/Berlin' });
  assert.equal(followupDue(sent, 1, one), zonedMs('2026-03-29', 10 * 60, 'Europe/Berlin'));
  assert.equal(addLocalDays(sent, 1, 'Europe/Berlin') - sent, 23 * 3_600_000);
  assert.equal(followupDue(sent, 2, s), zonedMs('2027-03-28', 10 * 60, 'Europe/Berlin'));
});
test('U036 number of followups: 0, 2, 10 accepted; 11, -1, 2.5, "3", null, NaN refused', () => {
  for (const ok of [0, 2, 10]) assert.equal(patch({ cadence: { followups: ok } }).cadence.followups, ok);
  for (const bad of [11, -1, 2.5, '3', null, NaN]) refuses({ cadence: { followups: bad } });
  assert.equal(S().cadence.followups, 2);
});
test('U037 with 0 followups the chain ends after the first gap following the reachout', () => {
  const s = patch({ cadence: { followups: 0 } });
  const sent = Date.parse('2026-03-16T10:00:00Z');
  assert.equal(hasNextStep(0, s), false);
  assert.equal(chainEnd(sent, s), sent + 2 * DAY);
});
test('U038 lowering the count drops steps beyond it; raising it adds steps after the last sent one', () => {
  assert.equal(hasNextStep(2, patch({ cadence: { followups: 2 } })), false);
  assert.equal(hasNextStep(2, patch({ cadence: { followups: 3 } })), true);
  assert.equal(hasNextStep(1, patch({ cadence: { followups: 1 } })), false);
});
test('U039 the chain ends after the last followup is sent plus the last gap', () => {
  const s = S();
  const sent = Date.parse('2026-03-20T10:00:00Z');
  assert.equal(chainEnd(sent, s), sent + 4 * DAY);
});
test('U041 resurface is chain end + 30 days; 0 turns it off; edited values compute', () => {
  const end = Date.parse('2026-04-01T00:00:00Z');
  assert.equal(resurfaceAt(end, S()), end + 30 * DAY);
  assert.equal(resurfaceAt(end, patch({ cadence: { resurfaceDays: 0 } })), null);
  assert.equal(resurfaceAt(end, patch({ cadence: { resurfaceDays: 1 } })), end + DAY);
  assert.equal(resurfaceAt(end, patch({ cadence: { resurfaceDays: 3650 } })), end + 3650 * DAY);
});
test('U043 a failed manual item returns after the retry delay (2 h default, editable)', () => {
  const at = 1_000_000;
  assert.deepEqual(retryOutcome(1, at, S()), { to: 'retry', at: at + 2 * 3_600_000 });
  assert.deepEqual(retryOutcome(1, at, patch({ cadence: { retryHours: 5 } })), { to: 'retry', at: at + 5 * 3_600_000 });
});
test('U044 tries 1 and 2 return to the list; the 3rd failure goes to the catch-up', () => {
  assert.equal(retryOutcome(2, 0, S()).to, 'retry');
  assert.equal(retryOutcome(3, 0, S()).to, 'catch_up');
});
test('U045 tries are editable: 1 goes to the catch-up after the first failure; 0, -1, 1.5 are refused', () => {
  assert.equal(retryOutcome(1, 0, patch({ cadence: { retryTries: 1 } })).to, 'catch_up');
  for (const bad of [0, -1, 1.5]) refuses({ cadence: { retryTries: bad } });
});

// ---- settings validation ----------------------------------------------------
test('U027 custom field names are unique ignoring case and spaces; a blank name is invalid', () => {
  const existing = [{ id: 'a', name: 'Region' }];
  assert.throws(() => validateCustomFieldName(' region ', existing), CrmConflictError);
  assert.throws(() => validateCustomFieldName('   ', existing), CrmInputError);
  assert.equal(validateCustomFieldName('Size', existing), 'Size');
  assert.equal(validateCustomFieldName('REGION', existing, 'a'), 'REGION');
});
test('U028 limits: 20 custom fields, 500-character values (named constants)', () => {
  assert.equal(CUSTOM_FIELDS_MAX, 20);
  assert.equal(CUSTOM_VALUE_MAX, 500);
});
test('U066 email cap and gap are editable; 0, -1, 1.5 and non-numbers are refused', () => {
  assert.equal(patch({ email: { dailyCap: 1 } }).email.dailyCap, 1);
  assert.equal(patch({ email: { gapSeconds: 0 } }).email.gapSeconds, 0);
  for (const bad of [0, -1, 1.5, '50']) refuses({ email: { dailyCap: bad } });
  refuses({ email: { gapSeconds: -1 } });
});
test('U070 an invalid timezone name is refused; an empty one falls back to the system default', () => {
  refuses({ timezone: 'Mars/Olympus' });
  assert.ok(patch({ timezone: '' }).timezone.length > 0);
  assert.equal(patch({ timezone: 'Asia/Kolkata' }).timezone, 'Asia/Kolkata');
});
test('U071 working hours: a closed day is accepted, end before start is refused, 24:00 and 9:5 are refused, 00:00-23:59 accepted', () => {
  const day = (open: boolean, start: string, end: string) => ({ open, start, end });
  const week = (d: ReturnType<typeof day>) => Array.from({ length: 7 }, () => d);
  assert.doesNotThrow(() => validateWorkingHours(week(day(true, '00:00', '23:59'))));
  assert.doesNotThrow(() => validateWorkingHours(week(day(false, '09:00', '08:00'))));
  for (const [s, e] of [['10:00', '09:00'], ['09:00', '24:00'], ['9:5', '17:00']]) assert.throws(() => validateWorkingHours(week(day(true, s!, e!))), CrmInputError);
  assert.throws(() => validateWorkingHours([]), CrmInputError);
  assert.equal(parseClock('24:00'), null);
});
test('U075 session sizes are editable: 1 accepted; 0, -1, 1.5, "40" refused', () => {
  assert.equal(patch({ sessions: { messagesPer30: 1 } }).sessions.messagesPer30, 1);
  for (const bad of [0, -1, 1.5, '40']) refuses({ sessions: { messagesPer30: bad } });
});
test('U079 duration defaults and per-type edits; 0 and negative refused', () => {
  const d = S().durations;
  assert.deepEqual([d.online_meeting, d.in_person_meeting, d.appointment, d.call, d.message], [30, 60, 60, 2, 1]);
  assert.equal(patch({ durations: { call: 5 } }).durations.call, 5);
  for (const bad of [0, -3]) refuses({ durations: { call: bad } });
  refuses({ durations: { teleport: 5 } });
});
test('U080 daily slot defaults are Reachouts 60 and Finding new prospects 60, placed anywhere', () => {
  assert.deepEqual(S().dailySlots.map((x) => [x.name, x.minutes, x.start]), [['Reachouts', 60, null], ['Finding new prospects', 60, null]]);
  const fixed = validateDailySlots([{ name: 'Calls', minutes: 30, start: '10:00' }]);
  assert.equal(fixed[0]!.start, '10:00');
});
test('U083 slot names are unique ignoring case; duration 0, negative or over 24 h is refused', () => {
  assert.throws(() => validateDailySlots([{ name: 'A', minutes: 5 }, { name: 'a', minutes: 5 }]), CrmInputError);
  for (const minutes of [0, -5, 1441]) assert.throws(() => validateDailySlots([{ name: 'A', minutes }]), CrmInputError);
  assert.doesNotThrow(() => validateDailySlots([{ name: 'A', minutes: 1440 }]));
});
test('U106 the on-time window is editable: 0 accepted; -1 and 1.5 refused', () => {
  assert.equal(patch({ onTimeMinutes: 0 }).onTimeMinutes, 0);
  for (const bad of [-1, 1.5]) refuses({ onTimeMinutes: bad });
  assert.equal(S().onTimeMinutes, 30);
});
test('U129 SMTP port 1 and 65535 accepted; 0, 65536, "25", 1.5 refused; security modes and from address checked', () => {
  for (const ok of [1, 65535]) assert.equal(patch({ smtp: { port: ok } }).smtp.port, ok);
  for (const bad of [0, 65536, '25', 1.5]) refuses({ smtp: { port: bad } });
  refuses({ smtp: { security: 'magic' } });
  for (const mode of ['starttls', 'ssl', 'none']) assert.equal(patch({ smtp: { security: mode } }).smtp.security, mode);
  refuses({ smtp: { from: 'not-an-email' } });
  assert.equal(patch({ smtp: { from: 'me@x.com' } }).smtp.from, 'me@x.com');
});
test('U130 lost reasons: names unique ignoring case and non-empty', () => {
  assert.throws(() => validateLostReasons(['A', 'a']), CrmInputError);
  assert.throws(() => validateLostReasons(['A', ' ']), CrmInputError);
  assert.throws(() => validateLostReasons([]), CrmInputError);
  assert.deepEqual(S().lostReasons, ['Not interested', 'No response', 'Wrong fit', 'Bought elsewhere', 'Do not contact', 'Other']);
});
test('U132 every number field refuses NaN, Infinity, null and values wider than a safe integer', () => {
  const targets = [(v: unknown) => ({ cadence: { followups: v } }), (v: unknown) => ({ cadence: { retryHours: v } }), (v: unknown) => ({ email: { dailyCap: v } }), (v: unknown) => ({ onTimeMinutes: v }), (v: unknown) => ({ smtp: { port: v } }), (v: unknown) => ({ sessions: { callsPer30: v } })];
  for (const t of targets) for (const bad of [NaN, Infinity, -Infinity, null, 2 ** 53, 2 ** 53 + 2]) refuses(t(bad));
  refuses({ unknownSetting: 1 });
});

// ---- templates ---------------------------------------------------------------
test('U057 name, company, title and custom fields are substituted; names match ignoring case', () => {
  const r = renderTemplate('Hi {Name} from {COMPANY}, {title} — {region}', { name: 'Ann', company: 'Fang', title: 'CTO', custom: { Region: 'EU' } });
  assert.equal(r.text, 'Hi Ann from Fang, CTO — EU');
});
test('U058 an unknown field stays visible and is reported, never blanked', () => {
  const r = renderTemplate('Hello {pet_name}', { name: 'A' });
  assert.equal(r.text, 'Hello {pet_name}');
  assert.deepEqual(r.unknownFields, ['pet_name']);
});
test('U059 a known field with no value renders empty and is reported; a missing name never prints undefined or null', () => {
  const r = renderTemplate('Hi {name}|{company}', { name: null, company: undefined });
  assert.equal(r.text, 'Hi |');
  assert.deepEqual(r.emptyFields, ['name', 'company']);
  assert.ok(!/undefined|null/.test(r.text));
});
test('U060 a missing template for a step is "no template", not a crash', async () => {
  const { templateFor } = await import('../src/crm/templates.ts');
  assert.equal(templateFor(S(), 'email', 3), null);
  assert.equal(templateFor(patch({ templates: { 'email:3': 'x' } }), 'email', 3), 'x');
});
test('U061 brace edge cases: unmatched, empty, doubled, and a value containing a field name is not re-expanded', () => {
  assert.equal(renderTemplate('a { b', {}).text, 'a { b');
  assert.equal(renderTemplate('{}', {}).text, '{}');
  assert.equal(renderTemplate('{{name}}', { name: 'X' }).text, '{X}');
  assert.equal(renderTemplate('{name}', { name: '{company}', company: 'C' }).text, '{company}');
});
test('U062 the opt-out footer is appended once; editing it changes later messages only; an empty footer appends nothing', () => {
  const footer = 'Reply STOP to opt out.';
  const once = withFooter('Hello', footer);
  assert.equal(once, `Hello\n\n${footer}`);
  assert.equal(withFooter('Hello', ''), 'Hello');
  assert.equal(withFooter('Hello', 'New footer'), 'Hello\n\nNew footer');
  assert.equal(once, `Hello\n\n${footer}`);
});
test('U063 the footer is not appended twice when the message already carries it', () => {
  const footer = 'Reply STOP to opt out.';
  assert.equal(withFooter(withFooter('Hello', footer), footer), withFooter('Hello', footer));
});

// ---- email caps ---------------------------------------------------------------
test('U064 the 51st email of the day is held; it can go the next day', () => {
  const s = S();
  const at = (h: number, m = 0) => Date.parse(`2026-03-16T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const sent = Array.from({ length: 50 }, (_, i) => at(0, i));
  assert.deepEqual(canSendEmail(at(12), sent, s), { ok: false, reason: 'daily cap' });
  assert.deepEqual(canSendEmail(at(12), sent.slice(1), s), { ok: true });
  assert.deepEqual(canSendEmail(Date.parse('2026-03-17T00:00:00Z'), sent, s), { ok: true });
});
test('U065 two sends must be 60 s apart: 59 s refused, 60 s allowed', () => {
  const s = S();
  assert.equal(canSendEmail(59_000, [0], s).ok, false);
  assert.deepEqual(canSendEmail(60_000, [0], s), { ok: true });
});
test('U067 a 23- or 25-hour day counts as one cap day; 23:59:59 and 00:00:00 land on different days', () => {
  const s = patch({ email: { dailyCap: 2 }, timezone: 'Europe/Berlin' });
  for (const day of ['2026-03-29', '2026-10-25']) {
    const { start, end } = dayBounds(day, 'Europe/Berlin');
    assert.equal(canSendEmail(end - 1000, [start, start + 100_000], s).ok, false, day);
    assert.equal(canSendEmail(end, [start, start + 100_000], s).ok, true, day);
  }
});

// ---- calendar time -----------------------------------------------------------
test('U068 "today" is the calendar date in the Building timezone', () => {
  const t = Date.parse('2026-03-14T23:30:00Z');
  assert.equal(localDay(t, 'Europe/Berlin'), '2026-03-15');
  assert.equal(localDay(t, 'America/Los_Angeles'), '2026-03-14');
});
test('U072 free time = working hours minus fixed items; overlaps merge; clipped at the ends; outside items take none', () => {
  const w = { start: 9 * 60, end: 17 * 60 };
  const free = freeIntervals(w, [{ start: 600, end: 660 }, { start: 630, end: 720 }, { start: 1000, end: 1100 }, { start: 0, end: 5 }]);
  assert.deepEqual(free, [{ start: 540, end: 600 }, { start: 720, end: 1000 }]);
  assert.deepEqual(freeIntervals(w, []), [w]);
  assert.deepEqual(freeIntervals(w, [{ start: 0, end: 2000 }]), []);
});
test('U086 an item due 00:00 local is today; 23:59:59 the day before is not', () => {
  const { start } = dayBounds('2026-03-16', 'Europe/Berlin');
  assert.equal(localDay(start, 'Europe/Berlin'), '2026-03-16');
  assert.equal(localDay(start - 1000, 'Europe/Berlin'), '2026-03-15');
});
test('U133 impossible and extreme dates are not ISO days; the earliest and latest valid ones are', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '0000-01-01', 'abc', 20260101, null]) assert.equal(isIsoDay(bad), false);
  assert.equal(isIsoDay('0001-01-01'), true);
  assert.equal(isIsoDay('9999-12-31'), true);
  assert.equal(isIsoDay('2028-02-29'), true);
});

// ---- sessions -----------------------------------------------------------------
const msgs = (n: number, type: 'message' | 'call' = 'message') => Array.from({ length: n }, (_, i) => ({ id: i + 1, type, dueAt: i }));
test('U073 due messages group into blocks of 40: 0, 1, 40, 41, 80, 81', () => {
  const sizes = (n: number) => buildSessions(msgs(n), S()).map((x) => x.items.length);
  assert.deepEqual([sizes(0), sizes(1), sizes(40), sizes(41), sizes(80), sizes(81)], [[], [1], [40], [40, 1], [40, 40], [40, 40, 1]]);
});
test('U074 calls group in blocks of 15; messages and calls never share a block', () => {
  assert.deepEqual(buildSessions(msgs(15, 'call'), S()).map((x) => x.items.length), [15]);
  assert.deepEqual(buildSessions(msgs(16, 'call'), S()).map((x) => x.items.length), [15, 1]);
  const mixed = buildSessions([...msgs(3), { id: 99, type: 'call' as const, dueAt: 0 }], S());
  assert.deepEqual(mixed.map((x) => [x.kind, x.items.length]), [['messages', 3], ['calls', 1]]);
  assert.ok(MESSAGE_TYPES.includes('dm'));
});
test('U076 a block lists its items in due order; the count is preserved', () => {
  const s = buildSessions([{ id: 2, type: 'message' as const, dueAt: 5 }, { id: 1, type: 'message' as const, dueAt: 1 }], S());
  assert.deepEqual(s[0]!.items.map((i) => i.id), [1, 2]);
  assert.equal(s[0]!.minutes, 30);
});
