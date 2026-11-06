import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addChannel, createContact, getContact, listContacts, markCustomer, patchChannel, patchContact, removeChannel } from '../src/crm/contacts.ts';
import { tick } from '../src/crm/engine.ts';
import { createReachout, listFollowups, submitManual } from '../src/crm/followups.ts';
import { dismissPair, listSuggestions, mergeContacts, undoMerge } from '../src/crm/merge.ts';
import { interleave, isNameDuplicate, mergeCustom, pickSegment, suggestPairs, unionTags } from '../src/crm/mergeCompute.ts';
import { logResponse } from '../src/crm/responses.ts';
import { addComment, listTimeline } from '../src/crm/timeline.ts';
import { addCustomField } from '../src/crm/settingsService.ts';
import { harness } from './helpers/crmFakes.ts';

const mk = (h: ReturnType<typeof harness>, name: string | null, handle: string, extra: Record<string, unknown> = {}) => createContact(h.ctx, { name, channels: [{ type: 'instagram', handle }], ...extra });

test('U109 name key ignores case and accents, trims and collapses spaces; combining marks equal precomposed', () => {
  const dup = (a: string, b: string) => isNameDuplicate({ id: 1, name: a, company: null }, { id: 2, name: b, company: null });
  assert.ok(dup('José García', 'jose  garcia '));
  assert.ok(dup('José', 'José'));
  assert.ok(!dup('Jose', 'Joe'));
});

test('U110 the same company is required only when both have one', () => {
  const p = (n: string, c: string | null) => ({ id: Math.random(), name: n, company: c });
  assert.ok(isNameDuplicate(p('Li Wei', 'Fang Co'), p('Li Wei', null)));
  assert.ok(isNameDuplicate(p('Li Wei', 'Fang Co'), p('li wei', 'FANG CO')));
  assert.ok(!isNameDuplicate(p('Li Wei', 'Fang Co'), p('Li Wei', 'Other Co')));
});

test('U111 contacts with no name are never suggested; a pair is suggested once, A,B = B,A', () => {
  const a = { id: 2, name: 'Ann', company: null }, b = { id: 1, name: 'Ann', company: null };
  assert.equal(suggestPairs([{ id: 3, name: null, company: null }, { id: 4, name: '', company: null }], new Set()).length, 0);
  const pairs = suggestPairs([a, b], new Set());
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0]!.map((c) => c.id), [1, 2]);
});

test('U112 a dismissed pair is not suggested again, in either order, and stays dismissed after unrelated edits', () => {
  const h = harness();
  const a = mk(h, 'Ann Lee', '@a1'), b = mk(h, 'ann lee', '@a2');
  assert.equal(listSuggestions(h.ctx, 50, 0).total, 1);
  dismissPair(h.ctx, b.id, a.id);
  assert.equal(listSuggestions(h.ctx, 50, 0).total, 0);
  patchContact(h.ctx, a.id, { company: 'X' });
  assert.equal(listSuggestions(h.ctx, 50, 0).total, 0);
  assert.throws(() => dismissPair(h.ctx, a.id, 99999), /does not exist/);
});

test('U113 merge unions channels without a handle twice, unions tags and keeps flags per channel', () => {
  const h = harness();
  const a = mk(h, 'Ann', '@a', { tags: ['x', 'Y'] }), b = mk(h, 'Ann', '@b', { tags: ['y', 'z'] });
  patchChannel(h.ctx, b.id, b.channels[0]!.id, { invalid: true, dnc: true });
  const { contact } = mergeContacts(h.ctx, { firstId: a.id, secondId: b.id });
  assert.deepEqual(contact.channels.map((c) => [c.handle, c.invalid, c.dnc]), [['@a', false, false], ['@b', true, true]]);
  assert.deepEqual(unionTags(['x', 'Y'], ['y', 'z']), ['x', 'Y', 'z']);
  assert.deepEqual(contact.tags, ['x', 'Y', 'z']);
  assert.throws(() => getContact(h.ctx, b.id), /does not exist/);
});

test('U114 custom fields: the first-picked contact\'s value wins, the other is kept on the timeline, one-sided values stay', () => {
  const h = harness();
  const f1 = addCustomField(h.ctx, 'Region'), f2 = addCustomField(h.ctx, 'Size');
  const a = mk(h, 'Ann', '@a', { custom: { [f1.id]: 'EU' } }), b = mk(h, 'Ann', '@b', { custom: { [f1.id]: 'US', [f2.id]: 'Big' } });
  const { contact } = mergeContacts(h.ctx, { firstId: a.id, secondId: b.id });
  assert.deepEqual([contact.custom[f1.id], contact.custom[f2.id]], ['EU', 'Big']);
  assert.ok(listTimeline(h.ctx, a.id, 50, 0).rows.some((e) => e.kind === 'merge_value_kept' && e.data.value === 'US'));
  assert.deepEqual(mergeCustom({ a: 'x' }, { a: 'y', b: 'z' }), { value: { a: 'x', b: 'z' }, kept: [{ fieldId: 'a', value: 'y' }] });
});

test('U115 the merged timeline interleaves by time, stable at equal timestamps, with a "merged" entry', () => {
  const h = harness();
  const a = mk(h, 'Ann', '@a'); h.advance(1000);
  const b = mk(h, 'Ann', '@b'); h.advance(1000);
  addComment(h.ctx, b.id, 'from b'); h.advance(1000); addComment(h.ctx, a.id, 'from a'); h.advance(1000);
  mergeContacts(h.ctx, { firstId: a.id, secondId: b.id });
  const rows = listTimeline(h.ctx, a.id, 50, 0).rows.reverse();
  assert.deepEqual(rows.map((e) => e.kind), ['added', 'added', 'comment', 'comment', 'merged']);
  assert.deepEqual(rows.filter((e) => e.kind === 'comment').map((e) => e.text), ['from b', 'from a']);
  assert.deepEqual(interleave([{ id: 1, at: 5 }, { id: 3, at: 5 }], [{ id: 2, at: 5 }]).map((x) => x.id), [1, 3, 2]);
});

test('U116 segment conflicts: the owner\'s choice wins; a customer beats a prospect; an active contact beats a lost one', () => {
  assert.equal(pickSegment({ segment: 'prospect' }, { segment: 'customer' }), 'second');
  assert.equal(pickSegment({ segment: 'prospect' }, { segment: 'customer' }, 'first'), 'first');
  assert.equal(pickSegment({ segment: 'lost_prospect' }, { segment: 'prospect' }), 'second');
  assert.equal(pickSegment({ segment: 'customer' }, { segment: 'prospect' }), 'first');
  const h = harness();
  const a = mk(h, 'Ann', '@a'), b = mk(h, 'Ann', '@b');
  markCustomer(h.ctx, b.id);
  assert.equal(mergeContacts(h.ctx, { firstId: a.id, secondId: b.id }).contact.segment, 'customer');
  const c = mk(h, 'Bo', '@c'), d = mk(h, 'Bo', '@d');
  markCustomer(h.ctx, d.id);
  const keepProspect = mergeContacts(h.ctx, { firstId: c.id, secondId: d.id, keepSegmentOf: 'first' }).contact;
  assert.deepEqual([keepProspect.segment, keepProspect.stage], ['prospect', 'New']);
});

test('U117 merging a contact with itself, or with an already-merged contact, is refused', () => {
  const h = harness();
  const a = mk(h, 'Ann', '@a'), b = mk(h, 'Ann', '@b');
  assert.throws(() => mergeContacts(h.ctx, { firstId: a.id, secondId: a.id }), /different/);
  mergeContacts(h.ctx, { firstId: a.id, secondId: b.id });
  assert.throws(() => mergeContacts(h.ctx, { firstId: b.id, secondId: a.id }), /already merged/);
});

test('U118 after a merge, a reply logged on either side stops all chains and do-not-contact blocks sends', async () => {
  const h = harness();
  const a = mk(h, 'Ann', '@a'), b = createContact(h.ctx, { name: 'Ann', channels: [{ type: 'linkedin', handle: 'in/ann' }] });
  createReachout(h.ctx, a.id, { channelId: a.channels[0]!.id });
  const rb = createReachout(h.ctx, b.id, { channelId: b.channels[0]!.id }).followup;
  logResponse(h.ctx, b.id, { outcome: 'interested', nextAction: { type: 'other', dueAt: h.clock.now + 86_400_000 } });
  const merged = mergeContacts(h.ctx, { firstId: a.id, secondId: b.id }).contact;
  assert.deepEqual(listFollowups(h.ctx, { contactId: merged.id }).rows.filter((f) => f.state === 'pending').length, 0, 'the chain of the replying contact stays stopped');
  const c = mk(h, 'Cy', '@c'), d = mk(h, 'Cy', '@d');
  patchChannel(h.ctx, d.id, d.channels[0]!.id, { dnc: true });
  h.ctx.db.prepare('UPDATE contacts SET dnc = 1 WHERE id = ?').run(d.id);
  createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id });
  const m2 = mergeContacts(h.ctx, { firstId: c.id, secondId: d.id }).contact;
  assert.equal(m2.dnc, true);
  assert.equal(listFollowups(h.ctx, { contactId: m2.id }).rows.filter((f) => f.state === 'pending').length, 0);
  assert.throws(() => createReachout(h.ctx, m2.id, { channelId: m2.channels[0]!.id }), /do-not-contact/);
  void rb; void tick;
});

test('U119 undo restores both contacts, channels and their own entries; later entries stay (or go where the owner assigns)', () => {
  const h = harness();
  const a = mk(h, 'Ann', '@a'); h.advance(1000);
  const b = mk(h, 'Ann', '@b'); h.advance(1000);
  addComment(h.ctx, b.id, 'b note'); h.advance(1000);
  const { mergeId } = mergeContacts(h.ctx, { firstId: a.id, secondId: b.id }); h.advance(1000);
  addComment(h.ctx, a.id, 'after merge');
  const undone = undoMerge(h.ctx, mergeId, {});
  assert.deepEqual([undone.survivor.channels.map((c) => c.handle), undone.restored.channels.map((c) => c.handle)], [['@a'], ['@b']]);
  assert.deepEqual(listTimeline(h.ctx, b.id, 50, 0).rows.map((e) => e.kind).sort(), ['added', 'comment', 'unmerged']);
  assert.ok(listTimeline(h.ctx, a.id, 50, 0).rows.some((e) => e.text === 'after merge'));
  assert.ok(!listTimeline(h.ctx, b.id, 50, 0).rows.some((e) => e.text === 'after merge'));

  const x = mk(h, 'Xi', '@x'), y = mk(h, 'Xi', '@y');
  const m = mergeContacts(h.ctx, { firstId: x.id, secondId: y.id }).mergeId; h.advance(10);
  addComment(h.ctx, x.id, 'late');
  undoMerge(h.ctx, m, { assignLaterEntries: 'second' });
  assert.ok(listTimeline(h.ctx, y.id, 50, 0).rows.some((e) => e.text === 'late'));
});

test('U120 undo is blocked with a reason when a handle now belongs to another contact, when already undone, or after a newer merge', () => {
  const h = harness();
  const a = mk(h, 'Ann', '@a'), b = mk(h, 'Ann', '@b');
  const { mergeId } = mergeContacts(h.ctx, { firstId: a.id, secondId: b.id });
  removeChannel(h.ctx, a.id, getContact(h.ctx, a.id).channels.find((c) => c.handle === '@b')!.id);
  const other = mk(h, 'Other', '@b');
  assert.throws(() => undoMerge(h.ctx, mergeId, {}), (e: { status: number; details: { reason: string } }) => e.status === 409 && e.details.reason === 'handle in use');
  assert.equal(getContact(h.ctx, other.id).channels.length, 1);
  assert.equal(getContact(h.ctx, a.id).channels.length, 1);

  const c = mk(h, 'Cy', '@c'), d = mk(h, 'Cy', '@d'), e = mk(h, 'Cy', '@e');
  const first = mergeContacts(h.ctx, { firstId: c.id, secondId: d.id }).mergeId;
  mergeContacts(h.ctx, { firstId: c.id, secondId: e.id });
  assert.throws(() => undoMerge(h.ctx, first, {}), /newer merge/);
  const f = mk(h, 'Fy', '@f'), g = mk(h, 'Fy', '@g');
  const m = mergeContacts(h.ctx, { firstId: f.id, secondId: g.id }).mergeId;
  undoMerge(h.ctx, m, {});
  assert.throws(() => undoMerge(h.ctx, m, {}), /already undone/);
  assert.throws(() => undoMerge(h.ctx, 9999, {}), /does not exist/);
});

test('U109 suggestions page by name key and exclude contacts without names', () => {
  const h = harness();
  mk(h, 'Ann', '@1'); mk(h, 'ANN', '@2'); mk(h, null, '@3'); mk(h, null, '@4'); mk(h, 'Solo', '@5');
  const r = listSuggestions(h.ctx, 50, 0);
  assert.equal(r.total, 1);
  assert.equal(listContacts(h.ctx, {}).total, 5);
  void addChannel;
});
