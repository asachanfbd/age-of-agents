import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';

let t: CrmApi;
let id: string;
before(async () => { t = await startCrmApi(); });
after(async () => { await t.stop(); });
beforeEach(async () => { t.reset(); id = await t.createCrm(); });

const post = (suffix: string, body: unknown) => t.send('POST', t.crm(id, suffix), body);
const get = (suffix: string) => t.api(t.crm(id, suffix));
const mk = async (name: string | null, handle: string, extra: Record<string, unknown> = {}, type = 'instagram') => (await post('/contacts', { name, channels: [{ type, handle }], ...extra })).body;
const tl = async (cid: number) => (await get(`/contacts/${cid}/timeline?limit=200`)).body.rows as Array<{ kind: string; text: string; at: number }>;

test('I041 manual merge: channels, tags, custom fields, an interleaved timeline, a "merged" entry and the owner\'s segment choice; unknown ids 404; the same id twice 400', async () => {
  const field = (await post('/settings/custom-fields', { name: 'Region' })).body;
  const a = await mk('Ann', '@a', { tags: ['x'], custom: { [field.id]: 'EU' } });
  t.clock.now += 1000;
  const b = await mk('Ann', '@b', { tags: ['y'], custom: { [field.id]: 'US' } });
  await post(`/contacts/${b.id}/customer`, {});
  const res = await post('/merge', { firstId: a.id, secondId: b.id, keepSegmentOf: 'first' });
  assert.equal(res.status, 201);
  const m = res.body.contact;
  assert.deepEqual([m.channels.length, m.tags, m.custom[field.id], m.segment], [2, ['x', 'y'], 'EU', 'prospect']);
  const kinds = (await tl(a.id)).map((e) => e.kind);
  assert.ok(kinds.includes('merged') && kinds.includes('merge_value_kept') && kinds.filter((k) => k === 'added').length === 2);
  assert.equal((await post('/merge', { firstId: 9999, secondId: a.id })).status, 404);
  assert.equal((await post('/merge', { firstId: a.id, secondId: a.id })).status, 400);
  assert.equal((await post('/merge', { firstId: 'x', secondId: a.id })).status, 400);
  assert.equal((await get(`/contacts/${b.id}`)).status, 404);
});

test('I042 merging an already-merged contact is 409; a concurrent change to the other contact is serialised at the write queue', async () => {
  const a = await mk('Ann', '@a'), b = await mk('Ann', '@b'), c = await mk('Ann', '@c');
  await post('/merge', { firstId: a.id, secondId: b.id });
  assert.equal((await post('/merge', { firstId: c.id, secondId: b.id })).status, 409, 'b was already merged into a');
  const { crmCtx } = await import('../src/crm/runtime.ts');
  const ctx = await crmCtx((await t.projectsDb.get(id))!);
  let release!: () => void;
  const held = ctx.exclusive(() => new Promise<void>((r) => { release = r; }));
  const edit = t.send('PATCH', t.crm(id, `/contacts/${c.id}`), { company: 'Edited first' });
  await new Promise((r) => setTimeout(r, 50));
  const merge = post('/merge', { firstId: a.id, secondId: c.id });
  let settled = 0;
  void merge.then(() => settled++); void edit.then(() => settled++);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(settled, 0);
  release(); await held;
  const [m, e] = await Promise.all([merge, edit]);
  assert.deepEqual([m.status, e.status], [201, 200]);
  assert.equal(m.body.contact.company, 'Edited first', 'the merge ran after the edit and saw it');
});

test('I043 suggestions are paged; accept merges, dismiss is permanent; a stale pair is 409/404; dismissing an unknown contact is 404', async () => {
  const a = await mk('Ann Lee', '@a1'), b = await mk('ann lee', '@a2'), c = await mk('Bo Li', '@b1'), d = await mk('BO LI', '@b2');
  await mk('Solo', '@s');
  const s = (await get('/merge/suggestions?limit=1')).body;
  assert.deepEqual([s.rows.length, s.total, s.hasMore], [1, 2, true]);
  assert.equal((await post('/merge/suggestions/dismiss', { firstId: d.id, secondId: c.id })).status, 200);
  assert.equal((await get('/merge/suggestions')).body.total, 1);
  assert.equal((await post('/merge', { firstId: a.id, secondId: b.id })).status, 201);
  assert.equal((await get('/merge/suggestions')).body.total, 0);
  assert.equal((await post('/merge', { firstId: a.id, secondId: b.id })).status, 409, 'a stale pair');
  assert.equal((await post('/merge/suggestions/dismiss', { firstId: 9999, secondId: a.id })).status, 404);
  assert.equal((await post('/merge/suggestions/dismiss', { firstId: a.id, secondId: a.id })).status, 400);
});

test('I044 undo merge restores both contacts, their channels and their own entries; later entries stay or are assigned; a second undo is 409', async () => {
  const a = await mk('Ann', '@a'); t.clock.now += 1000;
  const b = await mk('Ann', '@b'); t.clock.now += 1000;
  await post(`/contacts/${b.id}/timeline/comments`, { text: 'b own' }); t.clock.now += 1000;
  const merged = (await post('/merge', { firstId: a.id, secondId: b.id })).body; t.clock.now += 1000;
  await post(`/contacts/${a.id}/timeline/comments`, { text: 'after' });
  const undone = await post(`/merge/${merged.mergeId}/undo`, {});
  assert.equal(undone.status, 200);
  assert.deepEqual([undone.body.survivor.channels.length, undone.body.restored.channels.length], [1, 1]);
  assert.ok((await tl(b.id)).some((e) => e.text === 'b own'));
  assert.ok((await tl(a.id)).some((e) => e.text === 'after'));
  assert.equal((await post(`/merge/${merged.mergeId}/undo`, {})).status, 409);
  assert.equal((await get(`/contacts/${b.id}`)).status, 200);
  assert.equal((await post('/merge/9999/undo', {})).status, 404);
  assert.equal((await post(`/merge/${merged.mergeId}/undo`, { assignLaterEntries: 'nobody' })).status, 400);
  const x = await mk('Xi', '@x'), y = await mk('Xi', '@y');
  const m2 = (await post('/merge', { firstId: x.id, secondId: y.id })).body;
  await post(`/contacts/${x.id}/timeline/comments`, { text: 'late' });
  t.clock.now += 5; await post(`/contacts/${x.id}/timeline/comments`, { text: 'later' });
  await post(`/merge/${m2.mergeId}/undo`, { assignLaterEntries: 'second' });
  assert.deepEqual((await tl(y.id)).filter((e) => e.kind === 'comment').map((e) => e.text).sort(), ['late', 'later']);
  assert.equal((await get(`/contacts/${x.id}/merges`)).body.length, 1);
});

test('I045 undo is blocked 409 with a reason when a restored handle belongs to a different contact, and nothing changes', async () => {
  const a = await mk('Ann', '@a'), b = await mk('Ann', '@b');
  const merged = (await post('/merge', { firstId: a.id, secondId: b.id })).body;
  const handleB = merged.contact.channels.find((c: { handle: string }) => c.handle === '@b');
  await t.send('DELETE', t.crm(id, `/contacts/${a.id}/channels/${handleB.id}`));
  const other = await mk('Other', '@b');
  const res = await post(`/merge/${merged.mergeId}/undo`, {});
  assert.deepEqual([res.status, res.body.details.reason, res.body.details.ownerId], [409, 'handle in use', other.id]);
  assert.match(res.body.error, /now belongs to contact/);
  assert.equal((await get(`/contacts/${b.id}`)).status, 404, 'b stays merged');
  assert.equal((await get(`/contacts/${other.id}`)).body.channels.length, 1);
});

test('I046 after merging contacts with pending chains, a logged reply stops all of them and do-not-contact blocks sends', async () => {
  const a = await mk('Ann', '@a'); const b = await mk('Ann', 'in/ann', {}, 'linkedin');
  await post(`/contacts/${a.id}/reachouts`, { channelId: a.channels[0].id });
  await post(`/contacts/${b.id}/reachouts`, { channelId: b.channels[0].id });
  const m = (await post('/merge', { firstId: a.id, secondId: b.id })).body.contact;
  assert.equal((await get(`/followups?contactId=${a.id}&state=pending`)).body.total, 2);
  const r = await post(`/contacts/${a.id}/responses`, { outcome: 'interested', nextAction: { type: 'call', dueAt: t.clock.now + 86_400_000 } });
  assert.equal(r.status, 200);
  assert.equal((await get(`/followups?contactId=${a.id}&state=pending`)).body.total, 0);
  await t.send('PUT', t.crm(id, `/contacts/${a.id}/dnc`), { dnc: true });
  assert.equal((await post(`/contacts/${a.id}/reachouts`, { channelId: m.channels[0].id })).status, 409);
});
