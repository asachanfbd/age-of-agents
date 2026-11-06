import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContact, listContacts } from '../src/crm/contacts.ts';
import { summaryFor } from '../src/crm/customers.ts';
import { savePassword } from '../src/crm/email.ts';
import { parseLimit, parseOffset } from '../src/crm/paging.ts';
import { redactSecrets, rememberSecret } from '../src/redaction.ts';
import { TIMELINE_KINDS, addComment, deleteComment, editComment, listTimeline } from '../src/crm/timeline.ts';
import { COMMENT_MAX } from '../src/crm/limits.ts';
import { harness } from './helpers/crmFakes.ts';

test('U121 timeline entries come newest first with an id tie-break, and the kinds are a closed list', () => {
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@b.co' }] });
  addComment(h.ctx, c.id, 'one'); addComment(h.ctx, c.id, 'two');
  const rows = listTimeline(h.ctx, c.id, 50, 0).rows;
  assert.deepEqual(rows.map((r) => r.text), ['two', 'one', 'Added (added by hand)']);
  assert.ok(rows[0]!.id > rows[1]!.id);
  for (const kind of ['added', 'imported_again', 'stage_changed', 'reachout_sent', 'followup_failed', 'response_logged', 'comment', 'mom', 'merged', 'unmerged', 'segment_moved', 'building_attached', 'dnc_changed', 'followup_delayed']) assert.ok((TIMELINE_KINDS as readonly string[]).includes(kind), kind);
  assert.equal(new Set(TIMELINE_KINDS).size, TIMELINE_KINDS.length);
});

test('U122 a comment of 5,000 characters is accepted, 5,001 refused, empty and whitespace refused; characters are counted by code point', () => {
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@b.co' }] });
  assert.equal(COMMENT_MAX, 5000);
  assert.equal(addComment(h.ctx, c.id, 'x'.repeat(5000)).text.length, 5000);
  assert.throws(() => addComment(h.ctx, c.id, 'x'.repeat(5001)), /5000/);
  for (const bad of ['', '   \n', undefined, 5]) assert.throws(() => addComment(h.ctx, c.id, bad), /empty/);
  assert.doesNotThrow(() => addComment(h.ctx, c.id, '😀'.repeat(5000)));
  assert.throws(() => addComment(h.ctx, c.id, '😀'.repeat(5001)));
});

test('U123 editing and deleting a comment add their own entries and never rewrite other entries', () => {
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@b.co' }] });
  const e = addComment(h.ctx, c.id, 'first');
  const before = listTimeline(h.ctx, c.id, 50, 0).rows.filter((r) => r.id !== e.id).map((r) => JSON.stringify(r));
  const edited = editComment(h.ctx, c.id, e.id, 'second');
  assert.deepEqual([edited.text, edited.editedAt !== null], ['second', true]);
  deleteComment(h.ctx, c.id, e.id);
  const rows = listTimeline(h.ctx, c.id, 50, 0).rows;
  assert.deepEqual(rows.slice(0, 2).map((r) => r.kind), ['comment_deleted', 'comment_edited']);
  assert.deepEqual(rows.filter((r) => before.includes(JSON.stringify(r))).length, before.length);
  assert.equal(rows.find((r) => r.id === e.id)!.deleted, true);
  assert.throws(() => editComment(h.ctx, c.id, e.id, 'x'), /deleted/);
  assert.throws(() => editComment(h.ctx, c.id, rows.at(-1)!.id, 'x'), /Only comments/);
});

test('U124 attached Building summaries: SEO latest report and Software open tasks become a short line; others get the basics only', () => {
  assert.equal(summaryFor('seo', { latestReport: { savedAt: null, name: '2026-W11' } }), 'Latest report: 2026-W11');
  assert.equal(summaryFor('software', { openTasks: 3 }), '3 open tasks');
  assert.equal(summaryFor('software', { openTasks: 1 }), '1 open task');
  assert.equal(summaryFor('notes', {}), null);
});

test('U125 an SEO Building with no report is null and an open-task count of 0 is 0', () => {
  assert.equal(summaryFor('seo', { latestReport: null }), null);
  assert.equal(summaryFor('software', { openTasks: 0 }), '0 open tasks');
  assert.equal(summaryFor('software', { openTasks: null }), null);
});

test('U126 limit defaults to 50, clamps to 200, refuses 0, -1, 1.5 and text; an offset past the end gives an empty page', () => {
  assert.equal(parseLimit(undefined), 50);
  for (const big of [201, 10_000, '500']) assert.equal(parseLimit(big), 200);
  for (const bad of [0, -1, 1.5, 'abc', NaN]) assert.throws(() => parseLimit(bad), /limit/);
  assert.equal(parseOffset(undefined), 0);
  for (const bad of [-1, 1.5, 'x']) assert.throws(() => parseOffset(bad), /offset/);
  const h = harness();
  createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@b.co' }] });
  const past = listContacts(h.ctx, { offset: '100' });
  assert.deepEqual([past.rows.length, past.total, past.hasMore], [0, 1, false]);
});

test('U127 equal sort keys never skip or repeat a row across pages', () => {
  const h = harness();
  for (let i = 0; i < 23; i++) createContact(h.ctx, { name: 'Same', channels: [{ type: 'email', handle: `p${i}@b.co` }] });
  const seen: number[] = [];
  for (let offset = 0; offset < 23; offset += 5) seen.push(...listContacts(h.ctx, { limit: '5', offset: String(offset) }).rows.map((r) => r.id));
  assert.equal(seen.length, 23);
  assert.equal(new Set(seen).size, 23);
});

test('U128 the redaction helper masks an SMTP password wherever it appears', async () => {
  const h = harness();
  await savePassword(h.ctx, 'hunter2-s3cret!');
  rememberSecret(h.secrets.get('crm.smtp.password')!);
  const text = 'login failed for hunter2-s3cret! at smtp://u:hunter2-s3cret!@host?x=hunter2-s3cret!';
  const out = redactSecrets(text);
  assert.ok(!out.includes('hunter2-s3cret!'));
  assert.ok(!redactSecrets(JSON.stringify({ e: text })).includes('hunter2-s3cret!'));
});

test('U029 a contact stored before a custom field existed reads it as "", never undefined, null or "undefined"', async () => {
  const { addCustomField } = await import('../src/crm/settingsService.ts');
  const { getContact } = await import('../src/crm/contacts.ts');
  const h = harness();
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'old@x.com' }] });
  const field = addCustomField(h.ctx, 'Region');
  const read = getContact(h.ctx, c.id);
  assert.equal(read.custom[field.id], '');
  assert.ok(!JSON.stringify(read).includes('undefined') && !JSON.stringify(read.custom).includes('null'));
});
