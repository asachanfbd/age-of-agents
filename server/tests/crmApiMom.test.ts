import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MOM_ATTACHMENT_MAX_BYTES } from '../src/crm/limits.ts';
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
const mk = async (n = 1) => (await post('/contacts', { name: `P${n}`, channels: [{ type: 'email', handle: `p${n}@x.com` }] })).body;
const meeting = async (c: { id: number }, type = 'online_meeting') => (await post(`/contacts/${c.id}/followups`, { type, dueAt: t.clock.now + DAY })).body;
const upload = (momId: number, name: string, bytes: Buffer, kind = 'attachment') => fetch(`${t.baseUrl}${t.crm(id, `/moms/${momId}/files?kind=${kind}&name=${encodeURIComponent(name)}`)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => undefined) as any }));

test('I087 a MOM attaches to a followup, meeting or appointment; no target or two is 400; an unknown target 404; a second MOM on one target 409', async () => {
  const c = await mk();
  const m = await meeting(c), a = await meeting(c, 'appointment'), f = (await post(`/contacts/${c.id}/followups`, { type: 'call', dueAt: t.clock.now })).body;
  assert.equal((await post('/moms', { meetingId: m.id, notes: 'n' })).status, 201);
  assert.equal((await post('/moms', { appointmentId: a.id })).status, 201);
  assert.equal((await post('/moms', { followupId: f.id })).status, 201);
  assert.equal((await post('/moms', {})).status, 400);
  assert.equal((await post('/moms', { followupId: f.id, meetingId: m.id })).status, 400);
  assert.equal((await post('/moms', { followupId: 99999 })).status, 404);
  assert.equal((await post('/moms', { meetingId: m.id })).status, 409);
  assert.equal((await post('/moms', { appointmentId: f.id })).status, 400, 'a call is not an appointment');
});

test('I088 attachments go up as raw bytes: 20 MB accepted, 20 MB + 1 is 400, 10 accepted, the 11th 400; the response carries id, name and size only', async () => {
  const mom = (await post('/moms', { followupId: (await meeting(await mk())).id })).body;
  const big = await upload(mom.id, 'big.pdf', Buffer.alloc(MOM_ATTACHMENT_MAX_BYTES, 1));
  assert.deepEqual([big.status, Object.keys(big.body).sort(), big.body.size], [201, ['id', 'kind', 'name', 'size'], MOM_ATTACHMENT_MAX_BYTES]);
  assert.equal((await upload(mom.id, 'huge.pdf', Buffer.alloc(MOM_ATTACHMENT_MAX_BYTES + 1, 1))).status, 400);
  for (let i = 1; i < 10; i++) assert.equal((await upload(mom.id, `f${i}.txt`, Buffer.from('x'))).status, 201);
  assert.equal((await upload(mom.id, 'eleventh.txt', Buffer.from('x'))).status, 400);
  assert.equal((await upload(mom.id, '', Buffer.from('x'))).status, 400);
  assert.equal((await upload(99999, 'a.txt', Buffer.from('x'))).status, 404);
  assert.equal((await t.api(t.crm(id, `/moms/${mom.id}/files?kind=video&name=a.txt`), { method: 'POST', body: 'x', headers: { 'content-type': 'application/octet-stream' } })).status, 400);
});

test('I089 audio is saved as a file; a pasted transcript sets "pasted"; a mocked transcription sets "automatic"; a failed one leaves "none" and typed notes still build the MOM', async () => {
  const mom = (await post('/moms', { followupId: (await meeting(await mk())).id, notes: 'typed notes' })).body;
  assert.equal(mom.transcriptStatus, 'none');
  assert.equal((await upload(mom.id, 'voice.m4a', Buffer.from('audio'), 'audio')).status, 201);
  t.agent.reply = new Error('no transcription tool');
  const failed = (await post(`/moms/${mom.id}/transcribe`)).body;
  assert.deepEqual([failed.agentError, failed.mom.transcriptStatus], ['no transcription tool', 'none']);
  assert.equal((await post(`/moms/${mom.id}/analyse`)).body.mom.notes, 'typed notes');
  t.agent.reply = 'what was said';
  const auto = (await post(`/moms/${mom.id}/transcribe`)).body.mom;
  assert.deepEqual([auto.transcriptStatus, auto.transcript], ['automatic', 'what was said']);
  const pasted = (await t.send('PATCH', t.crm(id, `/moms/${mom.id}`), { transcript: 'my pasted text' })).body;
  assert.equal(pasted.transcriptStatus, 'pasted');
  assert.equal((await post(`/moms/${(await post('/moms', { followupId: (await meeting(await mk(2))).id })).body.id}/transcribe`)).status, 409, 'no audio yet');
  const dl = await t.api(t.crm(id, `/moms/${mom.id}/files/${mom.files?.[0]?.id ?? 1}`));
  assert.equal(dl.status, 200);
  assert.equal(dl.text, 'audio');
});

test('I090 analysis is a draft unless "apply without review" is on for MOMs; a failure shows in place and typed notes still save', async () => {
  const mom = (await post('/moms', { followupId: (await meeting(await mk())).id, notes: 'discussed pricing' })).body;
  t.agent.reply = '## Summary\nPricing talk\n## Decisions\nSend quote\n## Action items\n- Send quote\n- Book follow-up';
  const draft = (await post(`/moms/${mom.id}/analyse`)).body;
  assert.deepEqual([draft.applied, draft.mom.summary, draft.mom.draft.actionItems], [false, '', ['Send quote', 'Book follow-up']]);
  assert.match(t.agent.requests[0]!.prompt, /discussed pricing/);
  const accepted = (await post(`/moms/${mom.id}/draft/accept`, { summary: 'Pricing talk (edited)' })).body;
  assert.deepEqual([accepted.summary, accepted.decisions, accepted.actionItems.length, accepted.draft], ['Pricing talk (edited)', 'Send quote', 2, null]);
  await t.send('PATCH', t.crm(id, '/settings'), { agentAutoApply: { moms: true } });
  assert.equal((await post(`/moms/${mom.id}/analyse`)).body.applied, true);
  t.agent.reply = new Error('agent crashed');
  const failed = (await post(`/moms/${mom.id}/analyse`)).body;
  assert.equal(failed.agentError, 'agent crashed');
  assert.equal((await t.send('PATCH', t.crm(id, `/moms/${mom.id}`), { notes: 'saved anyway' })).body.notes, 'saved anyway');
  assert.equal((await post(`/moms/${mom.id}/draft/accept`)).status, 409);
});

test('I091 an action item becomes a followup in one click; a repeat click returns the same one; an unknown item is 404', async () => {
  const c = await mk();
  const mom = (await post('/moms', { followupId: (await meeting(c)).id, actionItems: [{ title: 'Send contract', type: 'email', dueAt: t.clock.now + 2 * DAY }] })).body;
  const one = (await post(`/moms/${mom.id}/action-items/0/followup`)).body, two = (await post(`/moms/${mom.id}/action-items/0/followup`)).body;
  assert.deepEqual([one.created, two.created, two.followupId], [true, false, one.followupId]);
  assert.equal((await get(`/followups/${one.followupId}`)).body.title, 'Send contract');
  assert.equal((await get(`/followups?contactId=${c.id}&limit=50`)).body.rows.filter((f: { title: string }) => f.title === 'Send contract').length, 1);
  assert.equal((await post(`/moms/${mom.id}/action-items/4/followup`)).status, 404);
  assert.equal((await post('/moms/9999/action-items/0/followup')).status, 404);
});

test('I092 a MOM appears on the contact timeline; attendees must be existing contacts', async () => {
  const c = await mk(1), other = await mk(2);
  const m = await meeting(c);
  assert.equal((await post('/moms', { meetingId: m.id, attendees: [9999] })).status, 404);
  const mom = (await post('/moms', { meetingId: m.id, attendees: [other.id] })).body;
  assert.deepEqual(mom.attendees, [other.id]);
  assert.ok((await get(`/contacts/${c.id}/timeline`)).body.rows.some((e: { kind: string; data: { momId: number } }) => e.kind === 'mom' && e.data.momId === mom.id));
  assert.equal((await post('/moms', { meetingId: (await meeting(c)).id, attendees: 'everyone' })).status, 400);
});

test('I093 MOMs are listed across contacts, paged and searchable by text, contact and date; from after to is 400; no match is an empty page', async () => {
  const a = await mk(1), b = await mk(2);
  await post('/moms', { meetingId: (await meeting(a)).id, notes: 'Pricing for the Berlin office' });
  t.clock.now += 3 * DAY;
  await post('/moms', { meetingId: (await meeting(b)).id, notes: 'Renewal discussion' });
  assert.equal((await get('/moms')).body.total, 2);
  assert.deepEqual((await get('/moms?search=BERLIN')).body.rows.map((m: { contactId: number }) => m.contactId), [a.id]);
  assert.equal((await get(`/moms?contactId=${b.id}`)).body.total, 1);
  assert.equal((await get('/moms?from=2026-03-18&to=2026-03-19')).body.total, 1);
  assert.equal((await get('/moms?from=2026-03-19&to=2026-03-18')).status, 400);
  assert.equal((await get('/moms?from=junk')).status, 400);
  const none = await get('/moms?search=zzz');
  assert.deepEqual([none.status, none.body.rows], [200, []]);
  assert.equal((await get('/moms?limit=1')).body.hasMore, true);
  assert.equal((await get('/moms?search=100%25')).body.total, 0, '% is literal');
});

test('I094 an attachment or audio file downloads as its bytes; a path-like name or a bad id never leaves the Building folder', async () => {
  const mom = (await post('/moms', { followupId: (await meeting(await mk())).id })).body;
  const up = await upload(mom.id, '../../../etc/passwd', Buffer.from('secret-bytes'));
  assert.equal(up.body.name, 'passwd');
  const dl = await t.api(t.crm(id, `/moms/${mom.id}/files/${up.body.id}`));
  assert.deepEqual([dl.status, dl.text], [200, 'secret-bytes']);
  assert.match(dl.headers.get('content-disposition')!, /filename\*=UTF-8''passwd/);
  for (const bad of ['abc', '99999', '..%2F..%2Fetc%2Fpasswd', '-1']) assert.ok([404].includes((await t.api(t.crm(id, `/moms/${mom.id}/files/${bad}`))).status), bad);
  assert.equal((await t.api(t.crm(id, `/moms/${mom.id + 1}/files/${up.body.id}`))).status, 404);
  assert.equal((await t.send('DELETE', t.crm(id, `/moms/${mom.id}/files/${up.body.id}`))).status, 204);
  assert.equal((await t.api(t.crm(id, `/moms/${mom.id}/files/${up.body.id}`))).status, 404);
});
