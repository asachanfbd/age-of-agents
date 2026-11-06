import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createContact, getContact, markLost } from '../src/crm/contacts.ts';
import { createReachout } from '../src/crm/followups.ts';
import { mergeContacts } from '../src/crm/merge.ts';
import { listTimeline } from '../src/crm/timeline.ts';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';
import { harness } from './helpers/crmFakes.ts';

let t: CrmApi;
let id: string;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });
beforeEach(async () => { t.reset(); id = await t.createCrm(); });

const post = (suffix: string, body: unknown) => t.send('POST', t.crm(id, suffix), body);
const get = (suffix: string) => t.api(t.crm(id, suffix));
const add = async (handle: string, extra: Record<string, unknown> = {}, type = 'email') => (await post('/contacts', { channels: [{ type, handle }], ...extra })).body;

test('I008 the list defaults to 50 rows, caps at 200, reports total and hasMore, and page 2 repeats nothing', async () => {
  for (let i = 0; i < 53; i++) await add(`p${i}@x.com`, { name: `P${i}` });
  const first = (await get('/contacts')).body;
  assert.deepEqual([first.rows.length, first.total, first.hasMore, first.limit], [50, 53, true, 50]);
  const second = (await get('/contacts?offset=50')).body;
  assert.deepEqual([second.rows.length, second.hasMore], [3, false]);
  assert.equal(new Set([...first.rows, ...second.rows].map((r: { id: number }) => r.id)).size, 53);
  assert.equal((await get('/contacts?limit=500')).body.limit, 200);
  for (const bad of ['limit=0', 'limit=-1', 'limit=1.5', 'limit=abc', 'offset=-1']) assert.equal((await get(`/contacts?${bad}`)).status, 400, bad);
});

test('I009 filters combine with AND; an unknown filter value is 400', async () => {
  const a = await add('a@x.com', { name: 'A', tags: ['hot'] });
  await add('@b', { name: 'B', tags: ['hot'] }, 'instagram');
  await add('c@x.com', { name: 'C' });
  await post(`/contacts/${a.id}/lost`, { reason: 'Other' });
  assert.equal((await get('/contacts?channel=email')).body.total, 2);
  assert.equal((await get('/contacts?channel=email&segment=prospect')).body.total, 1);
  assert.equal((await get('/contacts?channel=email&segment=lost_prospect&tag=hot')).body.total, 1);
  assert.equal((await get('/contacts?segment=lost')).body.total, 1);
  assert.equal((await get('/contacts?stage=New&tag=hot')).body.total, 1);
  for (const bad of ['segment=nope', 'stage=Nope', 'channel=fax', 'flag=x', 'batch=abc']) assert.equal((await get(`/contacts?${bad}`)).status, 400, bad);
});

test('I010 search matches name, company and normalised handles; % and _ are literal', async () => {
  await add('maria.rossi@x.it', { name: 'Maria Rossi', company: 'Acme Spa' });
  await add('100%@x.com', { name: 'Percent' });
  await add('a_b@x.com', { name: 'Under' });
  await add('axb@x.com', { name: 'Other' });
  assert.equal((await get('/contacts?search=Maria.Rossi@X.IT')).body.total, 1);
  assert.equal((await get('/contacts?search=acme')).body.total, 1);
  assert.equal((await get('/contacts?search=ROSSI')).body.total, 1);
  assert.equal((await get('/contacts?search=%25')).body.total, 1);
  assert.equal((await get('/contacts?search=a_b')).body.total, 1);
});

test('I011 search and filters return the same total on every page; no match is an empty page, not an error', async () => {
  for (let i = 0; i < 7; i++) await add(`n${i}@x.com`, { name: `Needle ${i}` });
  await add('hay@x.com', { name: 'Hay' });
  const p1 = (await get('/contacts?search=needle&limit=3')).body, p3 = (await get('/contacts?search=needle&limit=3&offset=6')).body;
  assert.deepEqual([p1.total, p3.total, p3.rows.length], [7, 7, 1]);
  const none = await get('/contacts?search=zzzz');
  assert.deepEqual([none.status, none.body.rows, none.body.total], [200, [], 0]);
});

test('I012 GET one returns channels, tags, custom fields, segment, stage and flags; unknown id 404', async () => {
  const c = await add('a@x.com', { name: 'Ann', company: 'Co', title: 'CTO', tags: ['x'] });
  const read = (await get(`/contacts/${c.id}`)).body;
  assert.deepEqual([read.name, read.company, read.title, read.tags, read.segment, read.stage, read.dnc, read.noResponse, read.channels.length], ['Ann', 'Co', 'CTO', ['x'], 'prospect', 'New', false, false, 1]);
  assert.equal((await get('/contacts/99999')).status, 404);
});

test('I013 add by hand needs a channel; source "added by hand", stage New, a timeline "added" entry, no storage paths', async () => {
  assert.equal((await post('/contacts', { name: 'No channel' })).status, 400);
  const c = await add('a@x.com');
  assert.deepEqual([c.source, c.stage, c.batchId], ['added by hand', 'New', null]);
  const tl = (await get(`/contacts/${c.id}/timeline`)).body.rows;
  assert.deepEqual(tl.map((e: { kind: string }) => e.kind), ['added']);
  assert.ok(!JSON.stringify(c).includes('crm.sqlite'));
});

test('I014 a handle owned by another contact is 409 naming the owner; on a lost contact it offers Reopen', async () => {
  const c = await add('a@x.com');
  const dup = await post('/contacts', { channels: [{ type: 'email', handle: ' A@X.com ' }] });
  assert.deepEqual([dup.status, dup.body.details.ownerId, dup.body.details.offerReopen], [409, c.id, false]);
  await post(`/contacts/${c.id}/lost`, { reason: 'Other' });
  const lost = await post('/contacts', { channels: [{ type: 'email', handle: 'a@x.com' }] });
  assert.deepEqual([lost.status, lost.body.details.offerReopen], [409, true]);
});

test('I015 PATCH name, company, title, tags and custom fields; bad custom ids and 501-character values are 400; tags dedupe ignoring case', async () => {
  const field = (await post('/settings/custom-fields', { name: 'Region' })).body;
  const c = await add('a@x.com');
  const patched = (await t.send('PATCH', t.crm(id, `/contacts/${c.id}`), { name: 'Ann', company: 'Co', title: 'CEO', tags: ['A', 'a', 'b'], custom: { [field.id]: 'EU' } })).body;
  assert.deepEqual([patched.name, patched.tags, patched.custom[field.id]], ['Ann', ['A', 'b'], 'EU']);
  assert.equal((await t.send('PATCH', t.crm(id, `/contacts/${c.id}`), { custom: { nope: 'x' } })).status, 400);
  assert.equal((await t.send('PATCH', t.crm(id, `/contacts/${c.id}`), { custom: { [field.id]: 'x'.repeat(501) } })).status, 400);
  assert.equal((await t.send('PATCH', t.crm(id, `/contacts/${c.id}`), { custom: { [field.id]: 'x'.repeat(500) } })).status, 200);
  assert.equal((await t.send('PATCH', t.crm(id, '/contacts/9999'), { name: 'x' })).status, 404);
});

test('I016 add channel: owned handle 409, bad shape 400; remove, mark invalid and do-not-contact appear on the timeline', async () => {
  const c = await add('a@x.com');
  const other = await add('@o', {}, 'instagram');
  assert.equal((await post(`/contacts/${c.id}/channels`, { type: 'instagram', handle: '@O' })).status, 409);
  assert.equal((await post(`/contacts/${c.id}/channels`, { type: 'email', handle: 'nope' })).status, 400);
  assert.equal((await post(`/contacts/${c.id}/channels`, { type: 'fax', handle: '1' })).status, 400);
  const added = (await post(`/contacts/${c.id}/channels`, { type: 'phone', handle: '+49 151 234567' })).body;
  const phone = added.channels.find((x: { type: string }) => x.type === 'phone');
  await t.send('PATCH', t.crm(id, `/contacts/${c.id}/channels/${phone.id}`), { invalid: true, dnc: true });
  assert.equal((await t.send('DELETE', t.crm(id, `/contacts/${c.id}/channels/${phone.id}`))).status, 200);
  assert.equal((await t.send('DELETE', t.crm(id, `/contacts/${c.id}/channels/${phone.id}`))).status, 404);
  const kinds = (await get(`/contacts/${c.id}/timeline`)).body.rows.map((e: { kind: string }) => e.kind);
  assert.deepEqual(kinds, ['channel_changed', 'dnc_changed', 'channel_changed', 'channel_changed', 'added']);
  assert.equal(other.channels.length, 1);
});

test('I017 do-not-contact on a contact cancels its followups and blocks sends; on one channel it cancels only that chain', async () => {
  const c = (await post('/contacts', { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] })).body;
  for (const ch of c.channels) await post(`/contacts/${c.id}/reachouts`, { channelId: ch.id });
  await t.send('PATCH', t.crm(id, `/contacts/${c.id}/channels/${c.channels[0].id}`), { dnc: true });
  const open = async () => (await get(`/followups?contactId=${c.id}&state=pending`)).body.total;
  assert.equal(await open(), 1);
  assert.equal((await t.send('PUT', t.crm(id, `/contacts/${c.id}/dnc`), { dnc: true })).status, 200);
  assert.equal(await open(), 0);
  assert.equal((await post(`/contacts/${c.id}/reachouts`, { channelId: c.channels[1].id })).status, 409);
  assert.equal((await t.send('PUT', t.crm(id, `/contacts/${c.id}/dnc`), { dnc: 'yes' })).status, 400);
  assert.ok((await get(`/contacts/${c.id}/timeline`)).body.rows.some((e: { kind: string }) => e.kind === 'dnc_changed'));
});

test('I018 mark lost with a listed reason stores reason and date; an unknown reason is 400; a customer becomes a lost customer', async () => {
  const c = await add('a@x.com');
  assert.equal((await post(`/contacts/${c.id}/lost`, { reason: 'Because' })).status, 400);
  const lost = (await post(`/contacts/${c.id}/lost`, { reason: 'Wrong fit' })).body;
  assert.deepEqual([lost.segment, lost.lostReason, lost.lostAt, lost.stage], ['lost_prospect', 'Wrong fit', t.clock.now, null]);
  assert.equal((await post(`/contacts/${c.id}/lost`, { reason: 'Other' })).status, 409);
  const d = await add('d@x.com');
  await post(`/contacts/${d.id}/customer`, {});
  assert.equal((await post(`/contacts/${d.id}/lost`, { reason: 'Other' })).body.segment, 'lost_customer');
});

test('I019 reopen: a lost prospect becomes a prospect (stage New or the picked one), a lost customer a customer; a non-lost contact is 409', async () => {
  const c = await add('a@x.com'), d = await add('d@x.com');
  assert.equal((await post(`/contacts/${c.id}/reopen`, {})).status, 409);
  await post(`/contacts/${c.id}/lost`, { reason: 'Other' });
  assert.deepEqual([(await post(`/contacts/${c.id}/reopen`, {})).body.stage, (await post(`/contacts/${c.id}/lost`, { reason: 'Other' })).status], ['New', 200]);
  assert.equal((await post(`/contacts/${c.id}/reopen`, { stage: 'Proposal' })).body.stage, 'Proposal');
  await post(`/contacts/${c.id}/lost`, { reason: 'Other' });
  assert.equal((await post(`/contacts/${c.id}/reopen`, { stage: 'Bogus' })).status, 400);
  await post(`/contacts/${d.id}/customer`, {}); await post(`/contacts/${d.id}/lost`, { reason: 'Other' });
  assert.equal((await post(`/contacts/${d.id}/reopen`, {})).body.segment, 'customer');
});

test('I020 mark as customer: prospects only (lost 409), cancels open chains, stamps the date, shows in Customers and on the timeline', async () => {
  const c = await add('@a', {}, 'instagram');
  await post(`/contacts/${c.id}/reachouts`, { channelId: c.channels[0].id });
  const done = (await post(`/contacts/${c.id}/customer`, {})).body;
  assert.deepEqual([done.segment, done.customerAt, done.stage], ['customer', t.clock.now, null]);
  assert.equal((await get(`/followups?contactId=${c.id}&state=pending`)).body.total, 0);
  assert.equal((await get('/customers')).body.total, 1);
  assert.equal((await post(`/contacts/${c.id}/customer`, {})).status, 409);
  const l = await add('l@x.com'); await post(`/contacts/${l.id}/lost`, { reason: 'Other' });
  assert.equal((await post(`/contacts/${l.id}/customer`, {})).status, 409);
});

test('I021 moving between segments writes a timeline entry; a lost contact appears only in the Lost lists with reason and date', async () => {
  const c = await add('a@x.com');
  await post(`/contacts/${c.id}/lost`, { reason: 'No response' });
  const entry = (await get(`/contacts/${c.id}/timeline`)).body.rows[0];
  assert.deepEqual([entry.kind, entry.data.to, entry.data.reason], ['segment_moved', 'lost_prospect', 'No response']);
  assert.equal((await get('/contacts?segment=prospect')).body.total, 0);
  const lost = (await get('/lost')).body;
  assert.deepEqual([lost.prospects.total, lost.customers.total, lost.prospects.rows[0].lostReason, lost.prospects.rows[0].lostAt], [1, 0, 'No response', t.clock.now]);
});

test('I039 the timeline is newest first and paged, and holds each kind of entry', async () => {
  const c = (await post('/contacts', { channels: [{ type: 'instagram', handle: '@a' }, { type: 'linkedin', handle: 'in/a' }] })).body;
  const r = (await post(`/contacts/${c.id}/reachouts`, { channelId: c.channels[0].id })).body;
  t.clock.now += 1000;
  await post(`/followups/${r.id}/submit`, { choice: 'sent' });
  await post(`/contacts/${c.id}/responses`, { outcome: 'no_response_yet' });
  await post(`/contacts/${c.id}/timeline/comments`, { text: 'note' });
  await t.send('PUT', t.crm(id, `/contacts/${c.id}/dnc`), { dnc: true });
  const kinds = (await get(`/contacts/${c.id}/timeline?limit=100`)).body.rows.map((e: { kind: string }) => e.kind);
  for (const k of ['added', 'reachout_planned', 'reachout_sent', 'stage_changed', 'followup_planned', 'response_logged', 'comment', 'dnc_changed', 'followup_cancelled']) assert.ok(kinds.includes(k), k);
  const page = (await get(`/contacts/${c.id}/timeline?limit=2&offset=1`)).body;
  assert.deepEqual([page.rows.length, page.total, page.hasMore], [2, kinds.length, true]);
  const times = (await get(`/contacts/${c.id}/timeline?limit=100`)).body.rows.map((e: { at: number }) => e.at);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('I040 comments: 5,000 characters ok, 5,001 is 400; only comments can be edited or deleted; edits and deletions get their own entries', async () => {
  const c = await add('a@x.com');
  assert.equal((await post(`/contacts/${c.id}/timeline/comments`, { text: 'x'.repeat(5000) })).status, 201);
  assert.equal((await post(`/contacts/${c.id}/timeline/comments`, { text: 'x'.repeat(5001) })).status, 400);
  const e = (await post(`/contacts/${c.id}/timeline/comments`, { text: 'hello' })).body;
  assert.equal((await t.send('PATCH', t.crm(id, `/contacts/${c.id}/timeline/${e.id}`), { text: 'bye' })).body.text, 'bye');
  const added = (await get(`/contacts/${c.id}/timeline?limit=200`)).body.rows.find((x: { kind: string }) => x.kind === 'added');
  assert.equal((await t.send('PATCH', t.crm(id, `/contacts/${c.id}/timeline/${added.id}`), { text: 'x' })).status, 409);
  assert.equal((await t.send('DELETE', t.crm(id, `/contacts/${c.id}/timeline/${added.id}`))).status, 409);
  assert.equal((await t.send('DELETE', t.crm(id, `/contacts/${c.id}/timeline/99999`))).status, 404);
  assert.equal((await t.send('DELETE', t.crm(id, `/contacts/${c.id}/timeline/${e.id}`))).status, 204);
  const kinds = (await get(`/contacts/${c.id}/timeline?limit=200`)).body.rows.map((x: { kind: string }) => x.kind);
  assert.deepEqual(kinds.slice(0, 2), ['comment_deleted', 'comment_edited']);
  assert.equal((await t.send('PUT', t.crm(id, `/contacts/${c.id}/timeline/${e.id}`), {})).status, 404, 'no other verbs exist');
});

test('I110 an import commit and a manual edit on one contact serialise through the Building\'s write queue', async () => {
  const c = await add('a@x.com', { name: 'Before' });
  const { crmCtx } = await import('../src/crm/runtime.ts');
  const ctx = await crmCtx((await t.projectsDb.get(id))!);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const held = ctx.exclusive(() => gate);
  const csv = Buffer.from('email,name\nnew@x.com,New One\n').toString('base64');
  let importDone = false, patchDone = false;
  const imp = post('/import/csv/commit', { fileName: 'f.csv', contentBase64: csv, mapping: { channels: [{ column: 'email', type: 'email' }], name: 'name' } }).then((r) => { importDone = true; return r; });
  const pat = t.send('PATCH', t.crm(id, `/contacts/${c.id}`), { name: 'After' }).then((r) => { patchDone = true; return r; });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual([importDone, patchDone], [false, false], 'both writes wait at the gate');
  release(); await held;
  const [i, p] = await Promise.all([imp, pat]);
  assert.deepEqual([i.status, p.status, i.body.added], [201, 200, 1]);
  assert.equal((await get(`/contacts/${c.id}`)).body.name, 'After');
  assert.equal((await get('/contacts')).body.total, 2);
});

test('I111 a failure between the steps of a merge or a segment move leaves the earlier state, never a half-applied one', () => {
  const h = harness();
  const a = createContact(h.ctx, { name: 'Ann', channels: [{ type: 'instagram', handle: '@a' }] });
  const b = createContact(h.ctx, { name: 'Ann', channels: [{ type: 'instagram', handle: '@b' }] });
  createReachout(h.ctx, a.id, { channelId: a.channels[0]!.id });
  h.ctx.db.exec("CREATE TRIGGER boom_merged BEFORE INSERT ON timeline WHEN NEW.kind = 'merged' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => mergeContacts(h.ctx, { firstId: a.id, secondId: b.id }), /injected failure/);
  assert.deepEqual([getContact(h.ctx, a.id).channels.length, getContact(h.ctx, b.id).channels.length], [1, 1]);
  assert.ok(!listTimeline(h.ctx, a.id, 50, 0).rows.some((e) => e.kind === 'merged'));
  assert.equal((h.ctx.db.prepare('SELECT COUNT(*) AS n FROM merges').get() as { n: number }).n, 0);
  h.ctx.db.exec("CREATE TRIGGER boom_seg BEFORE INSERT ON timeline WHEN NEW.kind = 'segment_moved' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => markLost(h.ctx, a.id, 'Other'), /injected failure/);
  const after = getContact(h.ctx, a.id);
  assert.deepEqual([after.segment, after.lostReason], ['prospect', null]);
  assert.equal((h.ctx.db.prepare("SELECT COUNT(*) AS n FROM followups WHERE contactId = ? AND state = 'pending'").get(a.id) as { n: number }).n, 1, 'the chain was not cancelled');
});
