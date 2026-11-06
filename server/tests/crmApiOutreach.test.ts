import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';

let t: CrmApi;
let id: string;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });
beforeEach(async () => { t.reset(); id = await t.createCrm(); });

const DAY = 86_400_000, HOUR = 3_600_000;
const post = (suffix: string, body: unknown = {}) => t.send('POST', t.crm(id, suffix), body);
const put = (suffix: string, body: unknown = {}) => t.send('PUT', t.crm(id, suffix), body);
const get = (suffix: string) => t.api(t.crm(id, suffix));
const patchSettings = (body: unknown) => t.send('PATCH', t.crm(id, '/settings'), body);
const mk = async (handle = '@ann', type = 'instagram', extra: Record<string, unknown> = {}) => (await post('/contacts', { name: 'Ann', company: 'Fang', channels: [{ type, handle }], ...extra })).body;
const reach = async (c: { id: number; channels: Array<{ id: number }> }, extra: Record<string, unknown> = {}, i = 0) => (await post(`/contacts/${c.id}/reachouts`, { channelId: c.channels[i]!.id, ...extra }));
const items = async (cid: number, state?: string) => (await get(`/followups?contactId=${cid}${state ? `&state=${state}` : ''}&limit=200`)).body.rows as Array<{ id: number; state: string; step: number; type: string; dueAt: number; message: string | null; tries: number; retryAt: number | null; catchUp: boolean; channelId: number | null; platform: string | null; defaultPlatform: string | null }>;
const tick = () => post('/tick');
const stageOf = async (cid: number) => (await get(`/contacts/${cid}`)).body;
const smtp = () => patchSettings({ smtp: { host: 'smtp.test', port: 587, security: 'starttls', user: 'me', from: 'me@sales.test', password: 'pw-api-secret-123' } });

test('I047 a reachout is drafted from the channel template; reachouts on several channels can start the same or different days', async () => {
  await patchSettings({ templates: { 'instagram:0': 'Hi {name} at {company}, {pet}', 'linkedin:0': 'LinkedIn hello' } });
  const c = (await post('/contacts', { name: 'Ann', company: 'Fang', channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] })).body;
  const first = await reach(c, {}, 0);
  assert.deepEqual([first.status, first.body.message, first.body.unknownFields, first.body.state, first.body.type], [201, 'Hi Ann at Fang, {pet}', ['pet'], 'pending', 'dm']);
  const later = await reach(c, { dueAt: t.clock.now + 3 * DAY }, 1);
  assert.deepEqual([later.body.state, later.body.message, later.body.dueAt], ['planned', 'LinkedIn hello', t.clock.now + 3 * DAY]);
  assert.equal((await reach(c, {}, 0)).status, 409, 'one open chain per channel');
});

test('I048 a reachout on an invalid or do-not-contact channel or a lost contact is 409; a template key must name a step', async () => {
  const c = (await post('/contacts', { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }, { type: 'facebook', handle: 'f' }] })).body;
  await t.send('PATCH', t.crm(id, `/contacts/${c.id}/channels/${c.channels[0].id}`), { invalid: true });
  await t.send('PATCH', t.crm(id, `/contacts/${c.id}/channels/${c.channels[1].id}`), { dnc: true });
  assert.equal((await reach(c, {}, 0)).status, 409);
  assert.equal((await reach(c, {}, 1)).status, 409);
  assert.equal((await post(`/contacts/${c.id}/reachouts`, { channelId: 99999 })).status, 404);
  assert.equal((await post(`/contacts/${c.id}/reachouts`, { channelId: 'x' })).status, 400);
  await post(`/contacts/${c.id}/lost`, { reason: 'Other' });
  assert.equal((await reach(c, {}, 2)).status, 409);
  assert.equal((await patchSettings({ templates: { 'instagram:first': 'x' } })).status, 400);
});

test('I049 marking a reachout sent plans followup 1 per channel by cadence and moves the stage to Contacted; the count follows Settings', async () => {
  const c = (await post('/contacts', { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] })).body;
  for (const ch of c.channels) { const r = (await reach(c, {}, c.channels.indexOf(ch))).body; await post(`/followups/${r.id}/submit`, { choice: 'sent' }); }
  const planned = await items(c.id, 'planned');
  assert.deepEqual([planned.length, planned.map((p) => p.step), planned.map((p) => p.dueAt)], [2, [1, 1], [t.clock.now + 2 * DAY, t.clock.now + 2 * DAY]]);
  assert.equal((await stageOf(c.id)).stage, 'Contacted');
  await patchSettings({ cadence: { followups: 0 } });
  const d = await mk('@zero');
  const r = (await reach(d)).body;
  await post(`/followups/${r.id}/submit`, { choice: 'sent' });
  assert.equal((await items(d.id, 'planned')).length, 0);
});

test('I050 the owner can edit the message before sending; the sent message equals the edited text', async () => {
  await patchSettings({ templates: { 'instagram:0': 'template text' } });
  const c = await mk();
  const r = (await reach(c)).body;
  assert.equal((await put(`/followups/${r.id}/message`, { message: 'My edited text' })).body.message, 'My edited text');
  await post(`/followups/${r.id}/submit`, { choice: 'sent' });
  assert.equal((await get(`/followups/${r.id}`)).body.message, 'My edited text');
  assert.equal((await put(`/followups/${r.id}/message`, { message: 'late edit' })).status, 409);
  assert.equal((await put(`/followups/${r.id}/message`, { message: 5 })).status, 400);
});

test('I051 every followup type is accepted; an unknown type is 400', async () => {
  const c = await mk();
  for (const type of ['call', 'message', 'email', 'dm', 'online_meeting', 'in_person_meeting', 'appointment', 'other']) {
    const res = await post(`/contacts/${c.id}/followups`, { type, dueAt: t.clock.now + DAY });
    assert.deepEqual([res.status, res.body.type, res.body.durationMin > 0], [201, type, true], type);
  }
  assert.equal((await post(`/contacts/${c.id}/followups`, { type: 'carrier-pigeon', dueAt: t.clock.now })).status, 400);
  assert.equal((await post(`/contacts/${c.id}/followups`, { type: 'call' })).status, 400);
  assert.equal((await post(`/contacts/${c.id}/followups`, { type: 'call', dueAt: t.clock.now, durationMin: 0 })).status, 400);
});

test('I052 calls, meetings and appointments carry no message; message types draft from the template', async () => {
  await patchSettings({ templates: { 'instagram:1': 'Followup for {name}' } });
  const c = await mk();
  for (const type of ['call', 'online_meeting', 'in_person_meeting', 'appointment']) assert.equal((await post(`/contacts/${c.id}/followups`, { type, message: 'x', dueAt: t.clock.now })).status, 400, type);
  const r = (await reach(c)).body;
  await post(`/followups/${r.id}/submit`, { choice: 'sent' });
  assert.equal((await items(c.id, 'planned'))[0]!.message, 'Followup for Ann');
});

test('I053 creating a meeting or an appointment moves the stage to Meeting set; a call does not', async () => {
  const c = await mk(), d = await mk('@d'), e = await mk('@e');
  await post(`/contacts/${c.id}/followups`, { type: 'call', dueAt: t.clock.now });
  assert.equal((await stageOf(c.id)).stage, 'New');
  await post(`/contacts/${d.id}/followups`, { type: 'in_person_meeting', dueAt: t.clock.now + DAY });
  await post(`/contacts/${e.id}/followups`, { type: 'appointment', dueAt: t.clock.now + DAY });
  assert.deepEqual([(await stageOf(d.id)).stage, (await stageOf(e.id)).stage], ['Meeting set', 'Meeting set']);
});

test('I054 followups walk planned → pending → sent with timeline entries; an illegal transition (sent → approve) is 409', async () => {
  await smtp();
  const c = await mk('a@x.com', 'email');
  const r = (await reach(c)).body;
  assert.equal(r.state, 'pending');
  await post(`/followups/${r.id}/approve`, {});
  assert.equal((await get(`/followups/${r.id}`)).body.state, 'sent');
  assert.equal((await post(`/followups/${r.id}/approve`, {})).status, 409);
  assert.equal((await post(`/followups/${r.id}/reject`, {})).status, 409);
  const kinds = (await get(`/contacts/${c.id}/timeline?limit=100`)).body.rows.map((e: { kind: string }) => e.kind);
  for (const k of ['reachout_planned', 'reachout_approved', 'reachout_sent', 'followup_planned', 'stage_changed']) assert.ok(kinds.includes(k), k);
  const call = (await post(`/contacts/${c.id}/followups`, { type: 'call', dueAt: t.clock.now })).body;
  await post(`/followups/${call.id}/complete`, {});
  assert.equal((await post(`/followups/${call.id}/complete`, {})).status, 409);
  assert.ok((await get(`/contacts/${c.id}/timeline?limit=100`)).body.rows.some((e: { kind: string }) => e.kind === 'followup_done'));
});

test('I055 a reply on any channel cancels every pending chain; a reply after the chain ended is accepted', async () => {
  const c = (await post('/contacts', { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] })).body;
  await reach(c, {}, 0); await reach(c, {}, 1);
  const res = await post(`/contacts/${c.id}/responses`, { outcome: 'later', date: t.clock.now + 10 * DAY, channelId: c.channels[1].id });
  assert.equal(res.status, 200);
  assert.deepEqual((await items(c.id, 'pending')).length, 0);
  const d = await mk('@late');
  const r = (await reach(d)).body;
  await post(`/followups/${r.id}/submit`, { choice: 'sent' });
  for (let i = 0; i < 2; i++) { t.clock.now += (i ? 4 : 2) * DAY; await tick(); const p = (await items(d.id, 'pending'))[0]!; await post(`/followups/${p.id}/submit`, { choice: 'sent' }); }
  t.clock.now += 4 * DAY; await tick();
  assert.equal((await stageOf(d.id)).noResponse, true);
  const late = await post(`/contacts/${d.id}/responses`, { outcome: 'not_interested', reason: 'Other' });
  assert.deepEqual([late.status, late.body.contact.segment], [200, 'lost_prospect']);
});

test('I056 each of the six outcomes has its effect; an unknown outcome and Not interested without a reason are 400', async () => {
  const run = async (body: unknown, handle: string) => { const c = await mk(handle); return { c, res: await post(`/contacts/${c.id}/responses`, body) }; };
  assert.equal((await run({ outcome: 'interested', nextAction: { type: 'call', dueAt: t.clock.now + DAY } }, '@1')).res.body.contact.stage, 'Engaged');
  assert.equal((await run({ outcome: 'not_interested', reason: 'Wrong fit' }, '@2')).res.body.contact.segment, 'lost_prospect');
  assert.equal((await run({ outcome: 'later', date: t.clock.now + DAY }, '@3')).res.body.contact.callbackAt, t.clock.now + DAY);
  const w = await mk('@4');
  assert.equal((await post(`/contacts/${w.id}/responses`, { outcome: 'wrong_number', channelId: w.channels[0].id })).body.contact.channels[0].invalid, true);
  assert.equal((await run({ outcome: 'no_response_yet' }, '@5')).res.status, 200);
  assert.equal((await run({ outcome: 'became_customer' }, '@6')).res.body.contact.segment, 'customer');
  assert.equal((await run({ outcome: 'teleported' }, '@7')).res.status, 400);
  assert.equal((await run({ outcome: 'not_interested' }, '@8')).res.status, 400);
  assert.equal((await run({ outcome: 'interested' }, '@9')).res.status, 400);
  assert.equal((await run({ outcome: 'later', date: t.clock.now - DAY }, '@10')).res.status, 400);
});

test('I057 a wrong number on the last valid channel returns needsLostDecision and changes nothing until the owner answers', async () => {
  const c = await mk();
  const res = await post(`/contacts/${c.id}/responses`, { outcome: 'wrong_number', channelId: c.channels[0].id });
  assert.deepEqual([res.body.needsLostDecision, res.body.contact.segment], [true, 'prospect']);
  assert.equal((await post(`/contacts/${c.id}/lost`, { reason: 'Other' })).body.segment, 'lost_prospect');
});

test('I058 "became a customer" from the catch-up moves the contact to Customers and cancels chains', async () => {
  const c = await mk();
  await reach(c);
  await post(`/contacts/${c.id}/responses`, { outcome: 'became_customer' });
  assert.deepEqual([(await get('/customers')).body.total, (await items(c.id, 'pending')).length], [1, 0]);
});

test('I059 chain end flags No response; auto-lost moves to Lost; off moves nothing; resurface puts the contact in the catch-up on the date', async () => {
  const chain = async (c: { id: number; channels: Array<{ id: number }> }) => {
    const r = (await reach(c)).body; await post(`/followups/${r.id}/submit`, { choice: 'sent' });
    for (const gap of [2, 4]) { t.clock.now += gap * DAY; await tick(); await post(`/followups/${(await items(c.id, 'pending'))[0]!.id}/submit`, { choice: 'sent' }); }
    t.clock.now += 4 * DAY; await tick();
  };
  const a = await mk('@a'); await chain(a);
  const flagged = await stageOf(a.id);
  assert.deepEqual([flagged.segment, flagged.noResponse], ['prospect', true]);
  assert.equal(flagged.resurfaceAt, flagged.noResponseAt + 30 * DAY);
  await patchSettings({ cadence: { autoLost: true } });
  const b = await mk('@b'); await chain(b);
  assert.deepEqual([(await stageOf(b.id)).segment, (await stageOf(b.id)).lostReason], ['lost_prospect', 'No response']);
  assert.deepEqual((await get('/contacts?flag=noResponse')).body.rows.map((r: { id: number }) => r.id), [a.id]);
});

test('I060 ticks are idempotent and survive a restart: due items become pending, retries return after 2 hours, state is kept', async () => {
  const c = await mk();
  const r = (await reach(c, { dueAt: t.clock.now + HOUR })).body;
  assert.equal(r.state, 'planned');
  await tick(); assert.equal((await items(c.id, 'planned')).length, 1);
  t.clock.now += HOUR; await tick(); await tick();
  assert.deepEqual((await items(c.id)).map((i) => i.state), ['pending']);
  await post(`/followups/${r.id}/submit`, { choice: 'retry' });
  const { forgetCrm } = await import('../src/crm/runtime.ts');
  forgetCrm(id);
  const failed = (await items(c.id))[0]!;
  assert.deepEqual([failed.state, failed.retryAt], ['failed', t.clock.now + 2 * HOUR]);
  t.clock.now += 2 * HOUR; await tick();
  assert.equal((await items(c.id))[0]!.state, 'pending');
});

test('I061 the Prospects row shows Pending reachout for a non-integrated channel with the message and the pre-selected platform', async () => {
  await patchSettings({ templates: { 'linkedin:0': 'Hello {name}' } });
  const c = await mk('in/ann', 'linkedin');
  const r = (await reach(c)).body;
  const row = (await get('/contacts?flag=pending')).body.rows[0];
  assert.deepEqual([row.id, row.pendingReachout, row.awaitingApproval], [c.id, true, false]);
  assert.deepEqual([r.message, r.defaultPlatform, r.integrated], ['Hello Ann', 'LinkedIn', false]);
});

test('a pending call or meeting does not raise the Pending reachout flag; a pending message still does', async () => {
  const c = await mk('in/ann', 'linkedin');
  const call = (await post(`/contacts/${c.id}/followups`, { type: 'call', channelId: c.channels[0].id, dueAt: t.clock.now + HOUR })).body;
  t.clock.now += 2 * HOUR; await tick();
  assert.equal((await items(c.id, 'pending'))[0]!.id, call.id);
  assert.equal((await get('/contacts?flag=pending')).body.total, 0);
  assert.equal((await get('/contacts')).body.rows[0].pendingReachout, false);
  await reach(c);
  assert.deepEqual((await get('/contacts?flag=pending')).body.rows.map((r: { id: number }) => r.id), [c.id]);
});

test('I062 submitting "Sent message on <platform>" marks it sent now, records a changed platform, schedules the next followup, stage Contacted', async () => {
  const c = await mk();
  const r = (await reach(c)).body;
  t.clock.now += HOUR;
  const done = (await post(`/followups/${r.id}/submit`, { choice: 'sent', platform: 'WhatsApp' })).body;
  assert.deepEqual([done.state, done.sentAt, done.platform], ['sent', t.clock.now, 'WhatsApp']);
  const next = (await items(c.id, 'planned'))[0]!;
  assert.deepEqual([next.step, next.dueAt], [1, t.clock.now + 2 * DAY]);
  assert.equal((await stageOf(c.id)).stage, 'Contacted');
  const d = await mk('@d');
  const r2 = (await reach(d)).body;
  assert.equal((await post(`/followups/${r2.id}/submit`, { choice: 'sent' })).body.platform, 'Instagram');
  assert.equal((await post(`/followups/${(await reach(await mk('@e'))).body.id}/submit`, { choice: 'sent', platform: '' })).status, 400);
});

test('I063 "failed, I\'ll try again" returns after 2 hours; the third failure goes to the catch-up with change channel, keep trying and stop', async () => {
  const c = (await post('/contacts', { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] })).body;
  const r = (await reach(c)).body;
  for (let i = 1; i <= 3; i++) {
    const res = (await post(`/followups/${r.id}/submit`, { choice: 'retry' })).body;
    assert.deepEqual([res.tries, res.catchUp, res.retryAt], [i, i === 3, i === 3 ? null : t.clock.now + 2 * HOUR]);
    if (i < 3) { t.clock.now += 2 * HOUR; await tick(); }
  }
  assert.equal((await post(`/followups/${r.id}/catch-up`, { action: 'change_channel', channelId: c.channels[1].id })).body.channelType, 'linkedin');
  assert.equal((await post(`/followups/${r.id}/catch-up`, { action: 'stop' })).status, 409, 'no longer in the catch-up');
});

test('I064 "Stop the followups" cancels that channel\'s remaining followups with an entry and leaves other channels alone', async () => {
  const c = (await post('/contacts', { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] })).body;
  const a = (await reach(c, {}, 0)).body; await reach(c, {}, 1);
  await post(`/followups/${a.id}/submit`, { choice: 'stop' });
  assert.deepEqual((await items(c.id, 'pending')).map((i) => i.channelId), [c.channels[1].id]);
  assert.ok((await get(`/contacts/${c.id}/timeline?limit=100`)).body.rows.some((e: { text: string }) => /stopped/.test(e.text)));
});

test('I065 no choice or an unknown choice is 400; an unknown item 404; a resolved item 409; two simultaneous submits give one success and one 409', async () => {
  const c = await mk();
  const r = (await reach(c)).body;
  assert.equal((await post(`/followups/${r.id}/submit`, {})).status, 400);
  assert.equal((await post(`/followups/${r.id}/submit`, { choice: 'dance' })).status, 400);
  assert.equal((await post('/followups/99999/submit', { choice: 'sent' })).status, 404);
  const { crmCtx } = await import('../src/crm/runtime.ts');
  const ctx = await crmCtx((await t.projectsDb.get(id))!);
  let release!: () => void;
  const held = ctx.exclusive(() => new Promise<void>((res) => { release = res; }));
  const both = [post(`/followups/${r.id}/submit`, { choice: 'sent' }), post(`/followups/${r.id}/submit`, { choice: 'retry' })];
  await new Promise((res) => setTimeout(res, 100));
  release(); await held;
  assert.deepEqual((await Promise.all(both)).map((x) => x.status).sort(), [200, 409]);
  assert.equal((await post(`/followups/${r.id}/submit`, { choice: 'sent' })).status, 409);
});

test('I066 by default an email waits for approval; approve sends, reject cancels with an entry, edit-then-approve sends the edited text', async () => {
  await smtp();
  const c = await mk('a@x.com', 'email'), d = await mk('d@x.com', 'email'), e = await mk('e@x.com', 'email');
  const a = (await reach(c)).body, b = (await reach(d)).body, edited = (await reach(e, { message: 'draft' })).body;
  assert.deepEqual([a.state, t.transport.sent.length], ['pending', 0]);
  assert.equal((await get('/contacts?flag=approval')).body.total, 3);
  assert.equal((await post(`/followups/${a.id}/approve`, {})).body.followup.state, 'sent');
  assert.equal((await post(`/followups/${b.id}/reject`, {})).body.state, 'cancelled');
  const tooSoon = await post(`/followups/${edited.id}/approve`, { message: 'Edited before sending' });
  assert.deepEqual(tooSoon.body.delivery, { sent: false, delayed: 'waiting between sends' }, 'a second email inside 60 seconds waits');
  t.clock.now += 61_000; await tick();
  assert.deepEqual(t.transport.sent.map((s) => s.message.to), ['a@x.com', 'e@x.com']);
  assert.match(t.transport.sent[1]!.message.text, /^Edited before sending/);
  assert.equal((await post('/followups/99999/approve', {})).status, 404);
  assert.equal((await post(`/followups/${b.id}/approve`, {})).status, 409);
  assert.ok((await get(`/contacts/${d.id}/timeline`)).body.rows.some((x: { kind: string }) => x.kind === 'reachout_cancelled'));
});

test('I067 "send without approval" sends at once, does not release items already waiting, and non-integrated channels ignore it', async () => {
  await smtp();
  const waiting = await mk('w@x.com', 'email');
  const w = (await reach(waiting)).body;
  await patchSettings({ approval: { email: true, instagram: true } });
  const c = await mk('auto@x.com', 'email');
  const r = (await reach(c)).body;
  assert.deepEqual([r.state, t.transport.sent.map((s) => s.message.to)], ['sent', ['auto@x.com']]);
  assert.equal((await get(`/followups/${w.id}`)).body.state, 'pending', 'switching the setting does not release a waiting item');
  const ig = await mk('@ig');
  assert.equal((await reach(ig)).body.state, 'pending', 'manual channels always need the popup');
});

test('I077 an agent draft is stored as a draft, not the message; accept sets it; an edited accept stores the edited text', async () => {
  const c = await mk();
  const r = (await reach(c, { message: 'template' })).body;
  const d = (await post(`/followups/${r.id}/draft`, {})).body;
  assert.deepEqual([d.applied, d.followup.message, d.followup.draft], [false, 'template', 'Hello from the agent']);
  assert.equal((await post(`/followups/${r.id}/draft/accept`, { message: 'Hello, edited' })).body.message, 'Hello, edited');
  await post(`/followups/${r.id}/draft`, {});
  assert.equal((await t.send('DELETE', t.crm(id, `/followups/${r.id}/draft`))).body.draft, null);
  assert.equal((await post(`/followups/${r.id}/draft/accept`, {})).status, 409);
});

test('I078 "apply without review" for message drafts applies directly; for MOMs it applies to MOMs; one switch does not affect the other', async () => {
  const c = await mk();
  const r = (await reach(c, { message: 'template' })).body;
  await patchSettings({ agentAutoApply: { moms: true } });
  assert.equal((await post(`/followups/${r.id}/draft`, {})).body.applied, false);
  await patchSettings({ agentAutoApply: { messageDrafts: true, moms: false } });
  const auto = (await post(`/followups/${r.id}/draft`, {})).body;
  assert.deepEqual([auto.applied, auto.followup.message], [true, 'Hello from the agent']);
  assert.deepEqual((await get('/settings')).body.agentAutoApply, { messageDrafts: true, moms: false });
});

test('I079 an agent failure is returned in place and sending the template message still works', async () => {
  const c = await mk();
  const r = (await reach(c, { message: 'template' })).body;
  t.agent.reply = new Error('agent unavailable');
  const failed = await post(`/followups/${r.id}/draft`, {});
  assert.deepEqual([failed.status, failed.body.agentError, failed.body.followup.message], [200, 'agent unavailable', 'template']);
  assert.equal((await post(`/followups/${r.id}/submit`, { choice: 'sent' })).body.state, 'sent');
});

test('I080 a draft for an unknown item is 404; a draft for a do-not-contact contact is allowed but the message cannot be sent', async () => {
  assert.equal((await post('/followups/99999/draft', {})).status, 404);
  const c = await mk();
  const r = (await reach(c, { message: 'template' })).body;
  await put(`/contacts/${c.id}/dnc`, { dnc: true });
  assert.equal((await get(`/followups/${r.id}`)).body.state, 'cancelled');
  const call = (await post(`/contacts/${(await mk('@x')).id}/followups`, { type: 'call', dueAt: t.clock.now })).body;
  assert.equal((await post(`/followups/${call.id}/draft`, {})).status, 400);
});

test('"send without approval" with no email connection is refused before anything is created', async () => {
  await patchSettings({ approval: { email: true } });
  const c = await mk('a@x.com', 'email');
  const res = await reach(c);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /not set up/);
  assert.equal((await items(c.id)).length, 0);
  await patchSettings({ approval: { email: false } });
  assert.equal((await reach(c)).status, 201, 'with approval on, the item waits and nothing is refused');
});

test('changing the number of followups mid-chain drops open steps beyond it and extends a chain whose last step was sent', async () => {
  const a = await mk('@a'), b = await mk('@b');
  const ra = (await reach(a)).body; await post(`/followups/${ra.id}/submit`, { choice: 'sent' });
  assert.equal((await items(a.id, 'planned')).length, 1);
  await patchSettings({ cadence: { followups: 0 } });
  assert.equal((await items(a.id, 'planned')).length, 0, 'followup 1 is beyond 0');
  assert.ok((await get(`/contacts/${a.id}/timeline`)).body.rows.some((e: { text: string }) => /number of followups was lowered/.test(e.text)));
  const rb = (await reach(b)).body; await post(`/followups/${rb.id}/submit`, { choice: 'sent' });
  assert.equal((await items(b.id, 'planned')).length, 0);
  await patchSettings({ cadence: { followups: 2 } });
  const planned = await items(b.id, 'planned');
  assert.deepEqual([planned.length, planned[0]!.step, planned[0]!.dueAt], [1, 1, t.clock.now + 2 * DAY]);
  await patchSettings({ cadence: { followups: 3 } });
  assert.equal((await items(b.id, 'planned')).length, 1, 'a step already planned is not duplicated');
});

test('the followup list refuses a bad contactId or an unknown state with 400', async () => {
  for (const q of ['contactId=abc', 'contactId=-1', 'contactId=1.5', 'state=bogus']) assert.equal((await get(`/followups?${q}`)).status, 400, q);
  assert.equal((await get('/followups?state=pending&contactId=1')).status, 200);
  assert.equal((await get('/followups?contactId=')).status, 200);
});
