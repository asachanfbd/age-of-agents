import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContact, getContact, markLost, patchChannel, setContactDnc } from '../src/crm/contacts.ts';
import { tick } from '../src/crm/engine.ts';
import { acceptMessageDraft, requestDraft } from '../src/crm/drafts.ts';
import { catchUpAction, createReachout, createTask, getFollowup, listFollowups, submitManual } from '../src/crm/followups.ts';
import { logResponse } from '../src/crm/responses.ts';
import { listTimeline } from '../src/crm/timeline.ts';
import { harness } from './helpers/crmFakes.ts';
import type { Harness } from './helpers/crmFakes.ts';

const DAY = 86_400_000, HOUR = 3_600_000;
const ig = (h: Harness, handle = '@ann', extra: Record<string, unknown> = {}) => createContact(h.ctx, { name: 'Ann', channels: [{ type: 'instagram', handle }, ...(extra.more as never[] ?? [])] });
const open = (h: Harness, contactId: number) => (listFollowups(h.ctx, { contactId, limit: 200 }).rows).filter((f) => ['planned', 'pending', 'approved', 'failed'].includes(f.state));
const kinds = (h: Harness, contactId: number) => listTimeline(h.ctx, contactId, 200, 0).rows.map((e) => e.kind);

/** Runs one manual chain to the end: reachout, followup 1, followup 2, all sent, no reply. */
async function runChain(h: Harness, contactId: number, channelId: number) {
  const first = createReachout(h.ctx, contactId, { channelId }).followup;
  submitManual(h.ctx, first.id, { choice: 'sent' });
  h.advance(2 * DAY); await tick(h.ctx);
  submitManual(h.ctx, open(h, contactId)[0]!.id, { choice: 'sent' });
  h.advance(4 * DAY); await tick(h.ctx);
  submitManual(h.ctx, open(h, contactId)[0]!.id, { choice: 'sent' });
}

test('U037 with 0 followups the contact is flagged No response after the first gap', async () => {
  const h = harness(); h.ctx.saveSettings({ ...h.ctx.settings(), cadence: { ...h.ctx.settings().cadence, followups: 0 } });
  const c = ig(h);
  const r = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id }).followup;
  submitManual(h.ctx, r.id, { choice: 'sent' });
  assert.equal(open(h, c.id).length, 0);
  h.advance(2 * DAY - 1); await tick(h.ctx);
  assert.equal(getContact(h.ctx, c.id).noResponse, false);
  h.advance(1); await tick(h.ctx);
  assert.equal(getContact(h.ctx, c.id).noResponse, true);
});

test('U039 after the last followup gets no response the contact stays a prospect flagged "No response"', async () => {
  const h = harness();
  const c = ig(h);
  await runChain(h, c.id, c.channels[0]!.id);
  h.advance(4 * DAY - 1); await tick(h.ctx);
  assert.equal(getContact(h.ctx, c.id).noResponse, false);
  h.advance(1); await tick(h.ctx);
  const after = getContact(h.ctx, c.id);
  assert.deepEqual([after.segment, after.noResponse], ['prospect', true]);
  assert.equal(after.resurfaceAt, after.noResponseAt! + 30 * DAY);
  assert.ok(kinds(h, c.id).includes('no_response'));
  await tick(h.ctx);
  assert.equal(kinds(h, c.id).filter((k) => k === 'no_response').length, 1, 'ticks are idempotent');
});

test('U040 auto-lost moves the contact to Lost with reason No response; off (default) moves nothing', async () => {
  const on = harness(); on.ctx.saveSettings({ ...on.ctx.settings(), cadence: { ...on.ctx.settings().cadence, autoLost: true } });
  const c = ig(on);
  await runChain(on, c.id, c.channels[0]!.id);
  on.advance(4 * DAY); await tick(on.ctx);
  const lost = getContact(on.ctx, c.id);
  assert.deepEqual([lost.segment, lost.lostReason], ['lost_prospect', 'No response']);
  assert.ok(lost.lostAt);
  const off = harness();
  const d = ig(off);
  await runChain(off, d.id, d.channels[0]!.id);
  off.advance(4 * DAY); await tick(off.ctx);
  assert.equal(getContact(off.ctx, d.id).segment, 'prospect');
});

test('U042 a reply logged after the chain ended is recorded, applies its outcome and clears the No response flag', async () => {
  const h = harness();
  const c = ig(h);
  await runChain(h, c.id, c.channels[0]!.id);
  h.advance(4 * DAY); await tick(h.ctx);
  assert.equal(getContact(h.ctx, c.id).noResponse, true);
  const r = logResponse(h.ctx, c.id, { outcome: 'interested', nextAction: { type: 'call', dueAt: h.clock.now + DAY } });
  assert.deepEqual([r.contact.noResponse, r.contact.stage], [false, 'Engaged']);
});

test('U046 contact-level do-not-contact cancels every pending followup; channel-level cancels only that channel\'s chain', () => {
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] });
  const [a, b] = c.channels;
  createReachout(h.ctx, c.id, { channelId: a!.id }); createReachout(h.ctx, c.id, { channelId: b!.id });
  patchChannel(h.ctx, c.id, a!.id, { dnc: true });
  assert.deepEqual(open(h, c.id).map((f) => f.channelId), [b!.id]);
  setContactDnc(h.ctx, c.id, true);
  assert.equal(open(h, c.id).length, 0);
  assert.throws(() => createReachout(h.ctx, c.id, { channelId: b!.id }), /do-not-contact/);
});

test('U047 a followup that falls due while the contact is do-not-contact is cancelled with a reason, not sent or delayed', async () => {
  const h = harness();
  const c = ig(h);
  const f = createTask(h.ctx, c.id, { type: 'message', dueAt: h.clock.now + DAY, channelId: c.channels[0]!.id, message: 'hi' });
  h.ctx.db.prepare('UPDATE contacts SET dnc = 1 WHERE id = ?').run(c.id);
  h.advance(DAY); await tick(h.ctx);
  assert.equal(getFollowup(h.ctx, f.id).state, 'cancelled');
  assert.match(listTimeline(h.ctx, c.id, 50, 0).rows.find((e) => e.kind === 'followup_cancelled')!.text, /do-not-contact/);
});

test('U048 clearing do-not-contact does not resurrect cancelled followups', () => {
  const h = harness();
  const c = ig(h);
  createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id });
  setContactDnc(h.ctx, c.id, true); setContactDnc(h.ctx, c.id, false);
  assert.equal(open(h, c.id).length, 0);
  assert.ok(kinds(h, c.id).filter((k) => k === 'dnc_changed').length >= 2);
});

test('U049 Interested stops every chain, sets stage Engaged and needs a next action', () => {
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] });
  for (const ch of c.channels) createReachout(h.ctx, c.id, { channelId: ch.id });
  assert.throws(() => logResponse(h.ctx, c.id, { outcome: 'interested' }), /next action/);
  assert.equal(open(h, c.id).length, 2, 'a refused response changes nothing');
  const r = logResponse(h.ctx, c.id, { outcome: 'interested', nextAction: { type: 'in_person_meeting', dueAt: h.clock.now + DAY } });
  assert.deepEqual(open(h, c.id).map((f) => f.type), ['in_person_meeting']);
  assert.equal(r.contact.stage, 'Meeting set');
  assert.ok(r.createdFollowupId);
});

test('U050 Not interested stops chains and moves to Lost with a listed reason; a missing or unknown reason is refused', () => {
  const h = harness();
  const c = ig(h);
  createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id });
  for (const reason of [undefined, 'Because']) assert.throws(() => logResponse(h.ctx, c.id, { outcome: 'not_interested', reason }), /reason/);
  const r = logResponse(h.ctx, c.id, { outcome: 'not_interested', reason: 'Wrong fit' });
  assert.deepEqual([r.contact.segment, r.contact.lostReason, open(h, c.id).length], ['lost_prospect', 'Wrong fit', 0]);
});

test('U051 Later stops chains and stores a call-back date; a past or unparsable date is refused', () => {
  const h = harness();
  const c = ig(h);
  createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id });
  for (const date of [h.clock.now - 1000, 'tomorrow-ish', undefined]) assert.throws(() => logResponse(h.ctx, c.id, { outcome: 'later', date }));
  const when = h.clock.now + 10 * DAY;
  const r = logResponse(h.ctx, c.id, { outcome: 'later', date: when });
  assert.equal(r.contact.callbackAt, when);
  assert.deepEqual(open(h, c.id).map((f) => [f.type, f.dueAt]), [['call', when]]);
});

test('U052 Wrong number marks that channel invalid and cancels its chain; the contact stays while another valid channel remains', () => {
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] });
  for (const ch of c.channels) createReachout(h.ctx, c.id, { channelId: ch.id });
  const r = logResponse(h.ctx, c.id, { outcome: 'wrong_number', channelId: c.channels[0]!.id });
  assert.equal(r.contact.channels[0]!.invalid, true);
  assert.deepEqual([r.contact.segment, r.needsLostDecision, open(h, c.id).length], ['prospect', undefined, 1]);
});

test('U053 Wrong number on the last valid channel asks whether to move to Lost and moves nothing', () => {
  const h = harness();
  const c = ig(h);
  const r = logResponse(h.ctx, c.id, { outcome: 'wrong_number', channelId: c.channels[0]!.id });
  assert.equal(r.needsLostDecision, true);
  assert.equal(r.contact.segment, 'prospect');
});

test('U054 No response yet leaves the chain unchanged', () => {
  const h = harness();
  const c = ig(h);
  createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id });
  logResponse(h.ctx, c.id, { outcome: 'no_response_yet' });
  assert.equal(open(h, c.id).length, 1);
  assert.equal(getContact(h.ctx, c.id).segment, 'prospect');
});

test('U055 Became a customer moves to Customers, cancels chains and stamps the date', () => {
  const h = harness();
  const c = ig(h);
  createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id });
  const r = logResponse(h.ctx, c.id, { outcome: 'became_customer' });
  assert.deepEqual([r.contact.segment, r.contact.customerAt, open(h, c.id).length], ['customer', h.clock.now, 0]);
});

test('U056 a reply logged on email cancels the pending Instagram and phone chains too', () => {
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@b.co' }, { type: 'instagram', handle: '@a' }, { type: 'phone', handle: '+49151234567' }] });
  for (const ch of c.channels) createReachout(h.ctx, c.id, { channelId: ch.id });
  assert.equal(open(h, c.id).length, 3);
  logResponse(h.ctx, c.id, { outcome: 'interested', channelId: c.channels[0]!.id, nextAction: { type: 'other', dueAt: h.clock.now + DAY } });
  assert.deepEqual(open(h, c.id).map((f) => f.type), ['other']);
});

test('U099 an agent result is a draft by default; the per-kind switches are independent', async () => {
  const h = harness();
  const c = ig(h);
  const r = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id, message: 'template' }).followup;
  const out = await requestDraft(h.ctx, r.id);
  assert.deepEqual([out.applied, out.followup.message, out.followup.draft], [false, 'template', 'Hello from the agent']);
  assert.equal(acceptMessageDraft(h.ctx, r.id, 'Edited').message, 'Edited');
  h.ctx.saveSettings({ ...h.ctx.settings(), agentAutoApply: { messageDrafts: false, moms: true } });
  assert.equal((await requestDraft(h.ctx, r.id)).applied, false);
  h.ctx.saveSettings({ ...h.ctx.settings(), agentAutoApply: { messageDrafts: true, moms: false } });
  const auto = await requestDraft(h.ctx, r.id);
  assert.deepEqual([auto.applied, auto.followup.message, auto.followup.draft], [true, 'Hello from the agent', null]);
});

test('U043/U044 retry returns after 2 h up to 3 tries; the third failure goes to the catch-up with its three actions', async () => {
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] });
  const f = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id }).followup;
  for (let i = 1; i <= 2; i++) {
    const r = submitManual(h.ctx, f.id, { choice: 'retry' });
    assert.deepEqual([r.state, r.tries, r.catchUp, r.retryAt], ['failed', i, false, h.clock.now + 2 * HOUR]);
    h.advance(2 * HOUR - 1); await tick(h.ctx);
    assert.equal(getFollowup(h.ctx, f.id).state, 'failed');
    h.advance(1); await tick(h.ctx);
    assert.equal(getFollowup(h.ctx, f.id).state, 'pending');
  }
  const third = submitManual(h.ctx, f.id, { choice: 'retry' });
  assert.deepEqual([third.state, third.catchUp, third.retryAt], ['failed', true, null]);
  h.advance(10 * HOUR); await tick(h.ctx);
  assert.equal(getFollowup(h.ctx, f.id).state, 'failed');
  assert.equal(catchUpAction(h.ctx, f.id, { action: 'change_channel', channelId: c.channels[1]!.id }).channelType, 'linkedin');
  for (let i = 0; i < 2; i++) { submitManual(h.ctx, f.id, { choice: 'retry' }); h.advance(2 * HOUR); await tick(h.ctx); }
  assert.equal(submitManual(h.ctx, f.id, { choice: 'retry' }).catchUp, true);
  assert.throws(() => catchUpAction(h.ctx, f.id, { action: 'bogus' }));
  assert.equal(catchUpAction(h.ctx, f.id, { action: 'keep_trying' }).state, 'pending');
});

test('lost contacts get no reachout and no automatic work', async () => {
  const h = harness();
  const c = ig(h);
  markLost(h.ctx, c.id, 'Other');
  assert.throws(() => createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id }), /lost/);
});

test('an approved email with no email connection waits visibly and once; the tick neither throws nor repeats the entry', async () => {
  const h = harness(); h.ctx.saveSettings({ ...h.ctx.settings(), approval: { email: true } });
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@x.com' }] });
  const r = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id, message: 'hi', dueAt: h.clock.now + HOUR }).followup;
  h.advance(HOUR);
  await tick(h.ctx); h.advance(1000); await tick(h.ctx);
  const row = getFollowup(h.ctx, r.id);
  assert.deepEqual([row.state, row.delayReason], ['approved', 'Email is not set up. Enter the mail server and from address in Settings.']);
  assert.equal(listTimeline(h.ctx, c.id, 50, 0).rows.filter((e) => e.kind === 'reachout_delayed').length, 1);
  assert.equal(h.transport.sent.length, 0);
});

test('an unexpected error while sending is logged and does not stop the tick', async () => {
  const h = harness(); h.ctx.saveSettings({ ...h.ctx.settings(), approval: { email: true }, smtp: { host: 'h', port: 25, security: 'none', user: 'u', from: 'me@x.com' } });
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@x.com' }] });
  createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id, message: 'hi' });
  const logged: unknown[][] = [];
  const real = console.error; console.error = (...a: unknown[]) => { logged.push(a); };
  const secrets = h.ctx.secrets; h.ctx.secrets = { ...secrets, get: async () => { throw new Error('disk gone'); } };
  try { await tick(h.ctx); } finally { console.error = real; h.ctx.secrets = secrets; }
  assert.match(String(logged[0]?.[0]), /could not send item/);
  assert.equal(h.transport.sent.length, 0);
});
