import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const outreach = await import('../src/lib/crmOutreach.ts');
const calendar = await import('../src/lib/crmCalendar.ts');
const imp = await import('../src/lib/crmImport.ts');
const merge = await import('../src/lib/crmMerge.ts');
const notes = await import('../src/lib/crmNotes.ts');
const customers = await import('../src/lib/crmCustomers.ts');
const reports = await import('../src/lib/crmReports.ts');
const settings = await import('../src/lib/crmSettings.ts');
const workspace = await import('../src/lib/crmWorkspace.ts');
const themeRules = await import('../src/lib/themeRules.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

// ---- manual popup ----------------------------------------------------------------
test('C009 Submit is disabled until a radio is chosen; each radio maps to its request body', () => {
  assert.equal(outreach.submitEnabled(null), false);
  for (const c of ['sent', 'retry', 'stop']) assert.equal(outreach.submitEnabled(c), true);
  assert.equal(outreach.submitEnabled('sent', true), false, 'busy blocks a second click');
  assert.deepEqual(outreach.submitBody('sent', 'WhatsApp'), { choice: 'sent', platform: 'WhatsApp' });
  assert.deepEqual(outreach.submitBody('retry', 'WhatsApp'), { choice: 'retry' });
  assert.deepEqual(outreach.submitBody('stop', 'WhatsApp'), { choice: 'stop' });
  assert.deepEqual(outreach.MANUAL_OPTIONS.map((o) => o.label('LinkedIn')), ['Sent message on LinkedIn', "Message sending failed, I'll try again", 'Stop the followups']);
});

test('C010 the platform is pre-selected from the channel and changeable; the retry text follows the Settings values', () => {
  assert.deepEqual(['phone', 'email', 'instagram', 'facebook', 'linkedin', 'other', null].map(outreach.defaultPlatform), ['Phone', 'Email', 'Instagram', 'Facebook', 'LinkedIn', 'Other', 'Other']);
  assert.ok(outreach.PLATFORMS.includes('WhatsApp') && outreach.PLATFORMS.includes(outreach.defaultPlatform('linkedin')));
  assert.equal(outreach.retryNote(0, { retryHours: 2, retryTries: 3 }), 'Returns in 2 hours (try 1 of 3)');
  assert.equal(outreach.retryNote(1, { retryHours: 1, retryTries: 5 }), 'Returns in 1 hour (try 2 of 5)');
  assert.equal(outreach.retryNote(9, { retryHours: 2, retryTries: 3 }), 'Returns in 2 hours (try 3 of 3)');
});

test('C011 Copy copies the exact edited message; unknown template fields are listed and flagged, never blanked', () => {
  assert.equal(outreach.copyText('Hi Ann,\n  edited  '), 'Hi Ann,\n  edited  ');
  assert.equal(outreach.copyText(null), '');
  assert.equal(outreach.unknownFieldNote([]), null);
  assert.equal(outreach.unknownFieldNote(['pet']), 'Unknown field left in the message: {pet}');
  assert.equal(outreach.unknownFieldNote(['a', 'b']), 'Unknown fields left in the message: {a}, {b}');
});

// ---- calendar ---------------------------------------------------------------------
test('C012 headings are Today, Tomorrow, Day after; paging moves one day; there is no week or month control', () => {
  assert.deepEqual([...calendar.COLUMN_HEADINGS], ['Today', 'Tomorrow', 'Day after']);
  assert.deepEqual(['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-15'].map((d) => calendar.headingFor(d, '2026-03-16')), ['Today', 'Tomorrow', 'Day after', '2026-03-19', '2026-03-15']);
  assert.equal(calendar.pageDay('2026-03-16', 1), '2026-03-17');
  assert.equal(calendar.pageDay('2026-03-16', -1), '2026-03-15');
  assert.equal(calendar.pageDay('2026-12-31', 1), '2027-01-01');
  assert.equal(calendar.pageDay('2026-03-01', -1), '2026-02-28');
  const ui = src('ui/crm/CalendarTab.tsx');
  assert.ok(!/\b(week|month)\b/i.test(ui.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'no week or month control in the Calendar tab');
});

test('C013 a session row labels its count and minutes and expands and collapses; the overdue badge and "delayed by daily cap" show', () => {
  assert.equal(calendar.sessionLabel({ kind: 'messages', count: 40, minutes: 30 }), '40 messages · 30 min');
  assert.equal(calendar.sessionLabel({ kind: 'calls', count: 1, minutes: 30 }), '1 call · 30 min');
  let open = new Set();
  open = calendar.toggleExpanded(open, 'messages:0');
  assert.deepEqual([...open], ['messages:0']);
  assert.deepEqual([...calendar.toggleExpanded(open, 'messages:0')], []);
  assert.deepEqual(calendar.itemBadges({ overdue: true, delayReason: null, state: 'pending', catchUp: false }), ['Overdue']);
  assert.deepEqual(calendar.itemBadges({ overdue: false, delayReason: 'delayed by daily cap', state: 'approved', catchUp: false }), ['delayed by daily cap']);
  assert.deepEqual(calendar.itemBadges({ overdue: false, delayReason: null, state: 'failed', catchUp: true }), ['Used all tries']);
  assert.equal(calendar.DELAYED_CAP_LABEL, 'delayed by daily cap');
});

test('C014 suggested-block and slot actions are disabled in a read-only Building', () => {
  assert.deepEqual(calendar.blockActionsEnabled(true, { state: 'suggested' }), { accept: false, move: false, skip: false });
  assert.deepEqual(calendar.blockActionsEnabled(false, { state: 'suggested' }), { accept: true, move: true, skip: true });
  assert.equal(calendar.blockActionsEnabled(false, { state: 'accepted' }).accept, false);
  assert.equal(calendar.slotActionsEnabled(true), false);
  assert.equal(calendar.slotActionsEnabled(false), true);
});

test('U084 slot geometry: pixels and minutes convert, snap to 5 minutes, clamp to working hours and keep a minimum duration', () => {
  assert.equal(calendar.minutesToPx(30, 2), 60);
  assert.equal(calendar.pxToMinutes(60, 2), 30);
  assert.deepEqual([calendar.snap(7), calendar.snap(8), calendar.snap(12.4), calendar.snap(-3)], [5, 10, 10, -5]);
  const hours = { start: 540, end: 1020 };
  assert.deepEqual(calendar.moveSpan({ start: 600, end: 660 }, 40, 2, hours), { start: 620, end: 680 });
  assert.deepEqual(calendar.moveSpan({ start: 600, end: 660 }, -10_000, 2, hours), { start: 540, end: 600 });
  assert.deepEqual(calendar.moveSpan({ start: 600, end: 660 }, 10_000, 2, hours), { start: 960, end: 1020 });
  assert.deepEqual(calendar.resizeSpan({ start: 600, end: 660 }, 30, 2, hours), { start: 600, end: 675 });
  assert.deepEqual(calendar.resizeSpan({ start: 600, end: 660 }, -10_000, 2, hours), { start: 600, end: 605 });
  assert.deepEqual(calendar.resizeSpan({ start: 600, end: 660 }, 10_000, 2, hours), { start: 600, end: 1020 });
  const moved = calendar.moveSpan({ start: 610, end: 640 }, 17, 2, hours);
  assert.equal(moved.end - moved.start, 30, 'a move keeps the length');
  assert.equal(calendar.clock(545), '09:05');
});

test('C015 the Expand Today cards: group title, "n of N" across groups, per-group empty text, Skip moves on without a request, actions follow the popup and response lists', () => {
  const groups = [
    { id: 'sent_no_response', title: 'Sent, no response logged', emptyText: 'Nothing is waiting for a response.', cards: ['a', 'b'] },
    { id: 'overdue', title: 'Overdue followups', emptyText: 'No followups are overdue.', cards: [] },
    { id: 'awaiting_approval', title: 'Awaiting approval', emptyText: 'No messages are waiting for approval.', cards: ['c'] },
    { id: 'failed_retry', title: 'Failed, retry due', emptyText: 'No failed items need a retry.', cards: [] },
    { id: 'agenda', title: "Today's agenda", emptyText: 'Nothing is planned for today.', cards: ['d'] },
  ];
  const series = outreach.flattenSeries(groups);
  assert.deepEqual(series.map((c) => [c.group, c.progress]), [['sent_no_response', '1 of 4'], ['sent_no_response', '2 of 4'], ['awaiting_approval', '3 of 4'], ['agenda', '4 of 4']]);
  assert.deepEqual(outreach.emptyGroups(groups).map((g) => g.text), ['No followups are overdue.', 'No failed items need a retry.']);
  assert.equal(outreach.skipTo(0, 4), 1);
  assert.equal(outreach.skipTo(3, 4), null);
  assert.deepEqual(outreach.cardActions('sent_no_response', null), ['interested', 'not_interested', 'later', 'wrong_number', 'no_response_yet', 'became_customer']);
  assert.deepEqual(outreach.cardActions('awaiting_approval', null), ['approve', 'reject', 'edit']);
  assert.deepEqual(outreach.cardActions('failed_retry', { integrated: false, catchUp: true }), ['change_channel', 'keep_trying', 'stop']);
  assert.deepEqual(outreach.cardActions('failed_retry', { integrated: false, catchUp: false }), ['sent', 'retry', 'stop']);
  assert.deepEqual(outreach.cardActions('overdue', { integrated: false, catchUp: false }), ['sent', 'retry', 'stop']);
  assert.deepEqual(outreach.flattenSeries([]), []);
});

// ---- import -----------------------------------------------------------------------
test('C016 the client pre-check refuses over 15 MB or 50,000 rows with the server wording; the mapping is guessed; commit needs a preview', () => {
  assert.equal(imp.precheckFile(15 * 1_048_576), null);
  assert.equal(imp.precheckFile(15 * 1_048_576 + 1), 'The file is larger than the 15 MB limit.');
  assert.equal(imp.precheckFile(10, 50_000), null);
  assert.equal(imp.precheckFile(10, 50_001), 'The file has more than 50,000 rows.');
  assert.equal(imp.countRows('a,b\n1,2\n\n"x\ny",3\n'), 2);
  assert.equal(imp.countRows('a\n'), 0);
  assert.deepEqual(imp.guessMapping(['Full Name', 'Work Email', 'Mobile', 'Company', 'Job Title', 'Instagram', 'LinkedIn URL', 'Tags', 'Notes']),
    { channels: [{ column: 'Work Email', type: 'email' }, { column: 'Mobile', type: 'phone' }, { column: 'Instagram', type: 'instagram' }, { column: 'LinkedIn URL', type: 'linkedin' }], name: 'Full Name', company: 'Company', title: 'Job Title', tags: 'Tags' });
  const preview = { added: 2, existing: 1, duplicatesInFile: 0, rejected: 0 };
  const mapping = { channels: [{ column: 'Email', type: 'email' }] };
  const ok = { content: 'abc', mapping, previewed: true, preview };
  assert.equal(imp.commitBlocker(ok), null);
  assert.equal(imp.commitBlocker({ ...ok, content: '' }), 'Still reading the file. Try again in a moment.');
  assert.equal(imp.commitBlocker({ ...ok, mapping: { channels: [] } }), 'Map at least one column to a channel.');
  assert.equal(imp.commitBlocker({ ...ok, mapping: { channels: [] } }), imp.channelBlocker({ channels: [] }));
  assert.equal(imp.channelBlocker(mapping), null);
  assert.equal(imp.commitBlocker({ ...ok, previewed: false }), 'Preview the file first, then Import.');
  assert.equal(imp.commitBlocker({ ...ok, preview: null }), 'Preview the file first, then Import.');
  assert.match(imp.commitBlocker({ ...ok, preview: { added: 0, existing: 0, duplicatesInFile: 0, rejected: 4 } }), /found nothing to import/);
  assert.deepEqual(imp.countLines(preview, false), ['2 would be added', '1 already existing', '0 duplicates inside the file', '0 rejected']);
});

test('C017 add-by-hand needs a channel and a handle; the result message names the counts and Reopen offers', () => {
  assert.equal(imp.validateHandForm({ channel: 'instagram', handle: '@a' }), null);
  assert.match(imp.validateHandForm({ channel: 'instagram', handle: ' ' }), /Enter a handle/);
  assert.equal(imp.validateHandForm({ channel: 'fax', handle: 'x' }), 'Choose a channel type.');
  const r = { added: 3, existing: 2, duplicatesInFile: 1, rejected: 0, committed: true, reopenOffers: [{ contactId: 4, line: 2 }], rejectedRows: [], rejectedTruncated: false, batchId: 1 };
  assert.equal(imp.resultMessage(r), '3 added, 2 already existing, 1 duplicates inside the file, 0 rejected. 1 matched a lost contact: you can reopen it.');
});

// ---- paste a list -----------------------------------------------------------------
const phoneMap = { channels: [{ column: 'Column 2', type: 'phone' }], name: 'Column 1' };
const suggestion = (extra = {}) => ({
  separator: 'comma', hasHeader: false, rows: 2, agentUsed: true, mapping: phoneMap,
  columns: [{ name: 'Column 1', samples: ['Tarun Gera'], byAgent: true }, { name: 'Column 2', samples: ['+919910166500'], byAgent: false }], ...extra,
});

test('W02 paste blockers: empty text, no channel, not previewed (the list, not the file)', () => {
  assert.equal(imp.pasteBlocker({ text: ' \n', detectedText: null, mapping: phoneMap }), 'Paste at least one line.');
  assert.equal(imp.pasteBlocker({ text: 'a', detectedText: null, mapping: phoneMap }), 'Detect columns before you preview.');
  assert.equal(imp.pasteBlocker({ text: 'a', detectedText: 'a', mapping: { channels: [] } }), 'Map at least one column to a channel.');
  assert.equal(imp.pasteBlocker({ text: 'a', detectedText: 'a', mapping: phoneMap }), null);
  const preview = { added: 1, existing: 0, duplicatesInFile: 0, rejected: 0 };
  assert.equal(imp.commitBlocker({ content: 'a', mapping: phoneMap, previewed: false, preview: null }, 'list'), 'Preview the list first, then Import.');
  assert.equal(imp.commitBlocker({ content: 'a', mapping: phoneMap, previewed: false, preview: null }), 'Preview the file first, then Import.');
  assert.equal(imp.commitBlocker({ content: 'a', mapping: phoneMap, previewed: true, preview }, 'list'), null);
});

test('W03 text changed since detection blocks the preview', () => {
  assert.equal(imp.pasteBlocker({ text: 'a\nb', detectedText: 'a', mapping: phoneMap }), 'Detect columns again before you preview.');
});

test('W04 column badges: several roles on one column, Not mapped, and an owner edit removes the agent tag', () => {
  const m = { channels: [{ column: 'Column 1', type: 'email' }, { column: 'Column 2', type: 'other', label: 'Skype' }], name: 'Column 1', custom: { f1: 'Column 3' } };
  assert.deepEqual(imp.columnRoles(m, 'Column 1'), ['Email', 'Name']);
  assert.deepEqual(imp.columnRoles(m, 'Column 2'), ['Other (Skype)']);
  assert.deepEqual(imp.columnRoles(m, 'Column 3', [{ id: 'f1', name: 'City' }]), ['City']);
  assert.deepEqual(imp.columnRoles(m, 'Column 3'), ['f1']);
  assert.deepEqual(imp.columnRoles(m, 'Column 4'), ['Not mapped']);
  assert.deepEqual(imp.columnRoles({ channels: [{ column: 'C', type: 'other', label: '' }] }, 'C'), ['Other (other)']);
  const after = imp.withField(phoneMap, 'name', 'Column 2');
  assert.deepEqual(imp.changedColumns(phoneMap, after, ['Column 1', 'Column 2']), ['Column 1', 'Column 2']);
  assert.deepEqual(imp.changedColumns(phoneMap, phoneMap, ['Column 1']), []);
});

test('the mapping edits shared by both grids: channel (Other keeps its label), field, custom field', () => {
  assert.deepEqual(imp.withChannel({ channels: [] }, 'email', 'A'), { channels: [{ column: 'A', type: 'email' }] });
  assert.deepEqual(imp.withChannel({ channels: [{ column: 'A', type: 'email' }] }, 'email', ''), { channels: [] });
  const other = imp.withChannel({ channels: [] }, 'other', 'B');
  assert.deepEqual(other.channels, [{ column: 'B', type: 'other', label: 'other' }]);
  const labelled = imp.withOtherLabel({ channels: [...other.channels, { column: 'A', type: 'email' }] }, 'Skype');
  assert.deepEqual(labelled.channels, [{ column: 'B', type: 'other', label: 'Skype' }, { column: 'A', type: 'email' }]);
  assert.deepEqual(imp.withChannel(labelled, 'other', 'C').channels.at(-1), { column: 'C', type: 'other', label: 'Skype' });
  assert.deepEqual(imp.withField({ channels: [], name: 'A' }, 'name', ''), { channels: [] });
  assert.deepEqual(imp.withCustom({ channels: [] }, 'f1', 'A'), { channels: [], custom: { f1: 'A' } });
  assert.deepEqual(imp.withCustom({ channels: [], custom: { f1: 'A' } }, 'f1', ''), { channels: [], custom: {} });
});

test('W05 the suggestion note: rules only, agent used, agent failed', () => {
  assert.match(imp.suggestionNote({ agentUsed: false }), /column names and values/);
  assert.match(imp.suggestionNote({ agentUsed: true }), /The agent suggested/);
  assert.match(imp.suggestionNote({ agentUsed: false, agentError: 'The agent took too long' }), /^Suggested without the agent: The agent took too long/);
});

test('W06 the shape text is singular or plural', () => {
  assert.equal(imp.shapeText(1, 4), '1 column, 4 lines');
  assert.equal(imp.shapeText(3, 2), '3 columns, 2 lines');
  assert.equal(imp.shapeText(2, 1), '2 columns, 1 line');
});

test('W07 a new suggestion (also after a separator or header change) replaces the mapping and clears the preview', () => {
  const s = imp.applySuggestion('Tarun Gera, +919910166500', suggestion());
  assert.deepEqual([s.mapping, s.previewed, s.preview, s.agentColumns, s.detected.text], [phoneMap, false, null, ['Column 1'], 'Tarun Gera, +919910166500']);
  assert.deepEqual(imp.SEPARATOR_OPTIONS.map((o) => o.value), ['tab', 'comma', 'semicolon', 'pipe', 'none']);
});

test('W08 W09 the API posts to paste/suggest and sends the mapped paste body; the old channel-only paste check is gone', () => {
  const api = src('lib/crmApi.ts');
  assert.match(api, /suggestPaste: .*`\$\{base\(id\)\}\/import\/paste\/suggest`/);
  assert.match(api, /importPaste: \(id: string, body: \{ text: string; mapping: T\.MappingDto; separator: T\.SeparatorName; hasHeader: boolean; batchName\?: string; tags: string\[\]; commit: boolean \}\)/);
  assert.equal(imp.validatePaste, undefined);
  const tab = src('ui/crm/ImportTab.tsx');
  assert.doesNotMatch(tab, /validatePaste|paste\.channel/);
  assert.match(tab, /text: p\.detected\.text, mapping: p\.mapping, separator: p\.detected\.separator, hasHeader: p\.detected\.hasHeader, batchName: batchName \|\| undefined, tags: tagList\(\), commit: commitIt/);
});

test('C01–C08 paste mode renders the shared mapping grid pre-filled from the suggestion, with Other, guarded buttons and read-only disabling', () => {
  const tab = src('ui/crm/ImportTab.tsx');
  const pasteSection = tab.slice(tab.indexOf("{mode === 'paste'"), tab.indexOf("{mode === 'hand'"));
  // C01: the grid over the detected columns, pre-filled from the suggestion's mapping
  assert.match(tab, /setPaste\(applySuggestion\(text, await crmApi\.suggestPaste\(/);
  assert.match(pasteSection, /<MappingGrid columns=\{paste\.detected\.columns\.map\(\(c\) => c\.name\)\} mapping=\{paste\.mapping\}/);
  assert.match(tab, /function MappingGrid[\s\S]*<ColumnSelect/);
  assert.match(tab, /<MappingGrid columns=\{headers\}/, 'CSV uses the same grid');
  // C02: no channel-type select in paste mode; hand mode keeps its own
  assert.doesNotMatch(pasteSection, /Channel type/);
  assert.match(tab.slice(tab.indexOf("{mode === 'hand'")), /aria-label="Channel type"/);
  // C03: Other channel and its label
  assert.match(pasteSection, /withOther onChange=\{editPasteMapping\}/);
  assert.match(tab, /withOther \|\| o\.value !== 'other'/);
  assert.match(tab, /aria-label="Other channel label"/);
  // C04: suggest only from Detect (and the separator or header controls), never from the textarea
  const textarea = pasteSection.match(/<Textarea[^>]*>/)[0];
  assert.doesNotMatch(textarea, /detect|suggest/i);
  assert.match(pasteSection, /onClick=\{\(\) => void detect\(\)\}>Detect columns/);
  assert.equal((tab.match(/crmApi\.suggestPaste/g) ?? []).length, 1);
  // C05: read-only disables the textarea, Detect, Preview and Import
  assert.match(textarea, /disabled=\{disabled\}/);
  for (const label of ['Detect columns', 'Preview \\(saves nothing\\)']) assert.match(pasteSection, new RegExp(`disabled=\\{disabled \\|\\| busy\\}[^\\n]*>${label}`), label);
  assert.match(pasteSection, /disabled=\{disabled \|\| busy\} title=\{disabledTitle\(readOnly\)\} onClick=\{\(\) => void commitPaste\(\)\}>Import/);
  // C06: Preview guarded by pasteBlocker (which ends in channelBlocker), Import by commitBlocker; the Result card is shared
  assert.match(tab, /const pasteProblem = \(\) => pasteBlocker\(/);
  assert.match(src('lib/crmImport.ts'), /return channelBlocker\(state\.mapping\);/);
  assert.match(tab, /commitBlocker\(\{ content: pasteText, [^)]*\}, 'list'\)/);
  assert.equal((tab.match(/<Result result=/g) ?? []).length, 1);
  // C07: batch tags in paste mode, sent in the body
  assert.match(pasteSection, /aria-label="Batch tags"/);
  assert.match(pasteSection, /suggestionNote\(paste\.detected\)/);
});

// ---- merge ------------------------------------------------------------------------
test('C018 a suggestion card model; the segment choice defaults to customer; the undo refusal reads its reason; a dismissed pair disappears', () => {
  const s = { first: { id: 1, name: 'Ann', company: 'Fang' }, second: { id: 2, name: 'ann', company: null } };
  assert.equal(merge.suggestionTitle(s), 'Ann (Fang) and ann');
  assert.equal(merge.defaultSegmentChoice('prospect', 'customer'), 'second');
  assert.equal(merge.defaultSegmentChoice('customer', 'prospect'), 'first');
  assert.equal(merge.defaultSegmentChoice('lost_prospect', 'prospect'), 'second');
  assert.equal(merge.defaultSegmentChoice('prospect', 'prospect'), 'first');
  const other = { first: { id: 3, name: 'Bo', company: null }, second: { id: 4, name: 'bo', company: null } };
  assert.deepEqual(merge.without([s, other], s), [other]);
  assert.equal(merge.undoRefusal({ status: 409, message: 'Cannot undo: the email handle x now belongs to contact 9', details: { details: { reason: 'handle in use' }, reason: 'handle in use' } }), 'Cannot undo: the email handle x now belongs to contact 9 (handle in use)');
  assert.equal(merge.undoRefusal({ status: 409, message: 'That merge was already undone' }), 'That merge was already undone');
});

// ---- notes ------------------------------------------------------------------------
test('C019 the MOM list model: transcript labels, the draft badge, search params; attachment limits (20 MB, 10) shown and enforced client-side', () => {
  assert.deepEqual(['none', 'automatic', 'pasted'].map(notes.transcriptLabel), ['Transcript: none', 'Transcript: automatic', 'Transcript: pasted']);
  assert.equal(notes.badgeFor({ draft: { summary: 's', decisions: '', actionItems: [] } }), 'Draft');
  assert.equal(notes.badgeFor({ draft: null }), null);
  assert.deepEqual(notes.momListParams({ search: ' pricing ', contactId: 5, from: '2026-03-01', to: '', offset: 0, limit: 50 }), { search: 'pricing', contactId: 5, from: '2026-03-01', to: undefined, limit: 50, offset: 0 });
  assert.equal(notes.ATTACHMENT_MAX_BYTES, 20 * 1_048_576);
  assert.equal(notes.ATTACHMENTS_MAX, 10);
  assert.equal(notes.checkAttachment({ name: 'a.pdf', size: 20 * 1_048_576 }, 0), null);
  assert.match(notes.checkAttachment({ name: 'a.pdf', size: 20 * 1_048_576 + 1 }, 0), /larger than 20 MB/);
  assert.match(notes.checkAttachment({ name: 'a.pdf', size: 5 }, 10), /at most 10 attachments/);
  assert.equal(notes.checkAttachment({ name: 'a.pdf', size: 5 }, 9), null);
  assert.match(notes.checkAttachment({ name: 'a.pdf', size: 0 }, 0), /empty/);
});

test('C020 the agent draft banner offers Accept, Edit and Discard; a failure is shown in place and typed notes stay savable', () => {
  assert.deepEqual(notes.agentBanner({ draft: { summary: 's', decisions: '', actionItems: [] } }, null), { kind: 'draft', actions: ['accept', 'edit', 'discard'] });
  assert.deepEqual(notes.agentBanner({ draft: null }, 'agent unavailable'), { kind: 'error', message: 'agent unavailable' });
  assert.equal(notes.agentBanner({ draft: null }, null), null);
  assert.equal(notes.canSaveNotes(false), true);
  assert.equal(notes.canSaveNotes(true), false);
});

// ---- customers and lost -----------------------------------------------------------
test('C021 attached Building rows: ok, basics only, unavailable ("no longer exists"), read failed with Retry; one failure does not hide the others', () => {
  const rows = [
    { state: 'ok', name: 'Site', typeId: 'seo', status: 'idle', summary: 'Latest report: 2026-W11' },
    { state: 'ok', name: 'Scratch', typeId: 'notes', status: 'idle', summary: null },
    { state: 'unavailable' },
    { state: 'read_failed', reason: 'refused' },
  ].map(customers.attachedRowState);
  assert.deepEqual(rows.map((r) => r.state), ['ok', 'basics', 'unavailable', 'read_failed']);
  assert.equal(rows[0].line, 'Site · seo · idle · Latest report: 2026-W11');
  assert.equal(rows[1].line, 'Scratch · notes · idle');
  assert.equal(rows[2].line, 'This Building no longer exists');
  assert.deepEqual([rows[3].line, rows[3].retry], ['Could not read this Building: refused', true]);
  assert.deepEqual(rows.map((r) => r.retry), [false, false, false, true]);
});

test('C022 Lost has two sections and the Reopen labels read "Reopen (stage New)" and "Reopen as customer"', () => {
  assert.deepEqual(customers.LOST_SECTIONS.map((s) => s.title), ['Lost prospects', 'Lost customers']);
  assert.equal(customers.reopenLabel('lost_prospect'), 'Reopen (stage New)');
  assert.equal(customers.reopenLabel('lost_customer'), 'Reopen as customer');
});

// ---- reports ----------------------------------------------------------------------
test('C023 period labels, "no data", "No records before <date>", the comparison with a null previous period, the CSV file name', () => {
  assert.deepEqual(reports.PERIOD_OPTIONS.map((p) => p.value), ['day', 'week', 'month']);
  assert.equal(reports.metricText(null), 'no data');
  assert.equal(reports.metricText(0), '0');
  assert.equal(reports.metricText(12345), '12,345');
  assert.equal(reports.beforeFirstText({ hasRecords: true, beforeFirstRecord: true, firstRecordDay: '2026-03-16' }), 'No records before 2026-03-16.');
  assert.equal(reports.beforeFirstText({ hasRecords: true, beforeFirstRecord: false, firstRecordDay: '2026-03-16' }), null);
  assert.equal(reports.beforeFirstText({ hasRecords: false, beforeFirstRecord: false, firstRecordDay: null }), 'Nothing is recorded yet.');
  assert.deepEqual(reports.compare(5, 3), { current: '5', previous: '3', change: '+2' });
  assert.deepEqual(reports.compare(2, 2), { current: '2', previous: '2', change: 'no change' });
  assert.deepEqual(reports.compare(1, 4).change, '-3');
  assert.deepEqual(reports.compare(5, null), { current: '5', previous: 'no data', change: null });
  assert.deepEqual(reports.compare(null, null), { current: 'no data', previous: 'no data', change: null });
  assert.equal(reports.csvFileName('by-channel', '2026-W12'), 'crm-by-channel-2026-W12.csv');
  assert.equal(reports.periodHeading({ label: '2026-W12' }, { label: '2026-W11' }), '2026-W12 compared with 2026-W11');
  assert.equal(reports.METRIC_ROWS.length, 9);
});

// ---- settings ---------------------------------------------------------------------
test('C024 the SMTP form never pre-fills the password and shows only the saved flag; an empty submit keeps the saved password; the status text covers all three states', () => {
  const dto = { host: 'smtp.x', port: 587, security: 'starttls', user: 'me', from: 'me@x', status: { state: 'connected', reason: null, passwordSaved: true, configured: true } };
  const { form, passwordSaved } = settings.smtpFormFrom(dto);
  assert.deepEqual([form.password, passwordSaved, form.port], ['', true, '587']);
  assert.ok(!('password' in settings.smtpPayload(form).smtp), 'an empty password field is left out');
  assert.equal(settings.smtpPayload({ ...form, password: 'new-pw' }).smtp.password, 'new-pw');
  assert.equal(settings.smtpPayload(form, true).smtp.password, '', 'clearing is explicit');
  assert.equal(settings.smtpPayload({ ...form, port: '25', host: ' h ' }).smtp.host, 'h');
  assert.equal(settings.smtpStatusText({ state: 'not_connected', reason: null }), 'Not connected');
  assert.equal(settings.smtpStatusText({ state: 'connected', reason: null }), 'Connected');
  assert.equal(settings.smtpStatusText({ state: 'needs_attention', reason: 'The mail server refused the login' }), 'Needs attention: The mail server refused the login');
  assert.ok(!JSON.stringify(settings.smtpFormFrom(dto)).includes('secret'));
});

test('C025 the number-field helpers mirror the server ranges and show the error text', () => {
  assert.equal(settings.validateNumber('followups', 0), null);
  assert.equal(settings.validateNumber('followups', '10'), null);
  assert.equal(settings.validateNumber('followups', 11), 'Number of followups must be a whole number from 0 to 10.');
  for (const bad of ['', '2.5', 'abc', -1, NaN, Infinity, 2 ** 53]) assert.notEqual(settings.validateNumber('followups', bad), null, String(bad));
  assert.equal(settings.validateNumber('dailyCap', 0), 'Emails per day must be a whole number from 1 to 1,000,000.');
  assert.equal(settings.validateNumber('gapSeconds', 0), null);
  assert.equal(settings.validateNumber('port', 65_535), null);
  assert.notEqual(settings.validateNumber('port', 65_536), null);
  assert.equal(settings.validateNumber('retryTries', 1), null);
  assert.notEqual(settings.validateNumber('retryTries', 0), null);
  assert.equal(settings.validateNumber('onTimeMinutes', 0), null);
  assert.equal(settings.validateNumber('messagesPer30', 40), null);
});

test('C026 deleting a lost reason or custom field in use shows the 409 count message', () => {
  assert.equal(settings.inUseMessage('custom field', { status: 409, message: 'Clear those values first.', details: { inUse: 3 } }), 'This custom field is in use by 3 contacts. Clear those values first.');
  assert.equal(settings.inUseMessage('lost reason', { status: 409, message: 'It cannot be removed.', details: { inUse: 1 } }), 'This lost reason is in use by 1 contact. It cannot be removed.');
  assert.equal(settings.inUseMessage('lost reason', { status: 409, message: 'Nope' }), 'Nope');
});

test('C028 the CRM components use theme tokens only: no raw Tailwind palette class and no hex or rgb colour', () => {
  const dir = new URL('../src/ui/crm/', import.meta.url);
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => `ui/crm/${f}`), 'ui/CrmWorkspace.tsx'];
  assert.ok(files.length >= 13);
  for (const file of files) {
    assert.deepEqual(themeRules.rawColours(src(file)), [], `${file} has a raw colour`);
    assert.ok(!/color-scheme:\s*dark|prefers-color-scheme/.test(src(file)), `${file} forces a colour scheme`);
  }
});
