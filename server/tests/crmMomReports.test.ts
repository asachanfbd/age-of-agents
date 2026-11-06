import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContact, markCustomer, markLost } from '../src/crm/contacts.ts';
import { tick } from '../src/crm/engine.ts';
import { completeItem, createReachout, createTask, submitManual } from '../src/crm/followups.ts';
import { MOM_ATTACHMENTS_MAX, MOM_ATTACHMENT_MAX_BYTES } from '../src/crm/limits.ts';
import { acceptDraft, actionItemToFollowup, addFile, analyse, createMom, getMom, listMoms, patchMom, safeFileName, transcribe } from '../src/crm/mom.ts';
import { parseMomOutput } from '../src/crm/momParse.ts';
import { PERIODS, isoWeek, parsePeriod, previousWindow, windowFor } from '../src/crm/reportPeriod.ts';
import { buildReport, reportCsv } from '../src/crm/reports.ts';
import { zonedMs } from '../src/crm/zoned.ts';
import { harness } from './helpers/crmFakes.ts';
import type { Harness } from './helpers/crmFakes.ts';

const DAY = 86_400_000, MIN = 60_000;
const setup = (h: Harness, type: 'online_meeting' | 'call' | 'appointment' = 'online_meeting') => {
  const c = createContact(h.ctx, { name: 'Ann', channels: [{ type: 'email', handle: `a${Math.random()}@b.co` }] });
  return { c, f: createTask(h.ctx, c.id, { type, dueAt: h.clock.now + DAY }) };
};

// ---- MOM -------------------------------------------------------------------------
test('U093 a MOM names exactly one target: none or two are refused; a meeting id must be a meeting', () => {
  const h = harness();
  const { f } = setup(h);
  assert.throws(() => createMom(h.ctx, {}), /exactly one/);
  assert.throws(() => createMom(h.ctx, { followupId: f.id, meetingId: f.id }), /exactly one/);
  assert.throws(() => createMom(h.ctx, { appointmentId: f.id }), /not a appointment|not an? appointment/);
  assert.equal(createMom(h.ctx, { meetingId: f.id, notes: 'n' }).targetId, f.id);
  assert.throws(() => createMom(h.ctx, { followupId: f.id }), /already has a MOM/);
  assert.throws(() => createMom(h.ctx, { followupId: 9999 }), /does not exist/);
});

test('U094 attachments: 20 MB accepted, 20 MB + 1 refused; 10 accepted, the 11th refused', async () => {
  const h = harness();
  const { f } = setup(h);
  const mom = createMom(h.ctx, { followupId: f.id });
  assert.equal(MOM_ATTACHMENT_MAX_BYTES, 20 * 1_048_576);
  const big = await addFile(h.ctx, mom.id, 'attachment', 'big.pdf', Buffer.alloc(MOM_ATTACHMENT_MAX_BYTES));
  assert.equal(big.size, MOM_ATTACHMENT_MAX_BYTES);
  await assert.rejects(addFile(h.ctx, mom.id, 'attachment', 'huge.pdf', Buffer.alloc(MOM_ATTACHMENT_MAX_BYTES + 1)), /at most 20 MB/);
  for (let i = 1; i < MOM_ATTACHMENTS_MAX; i++) await addFile(h.ctx, mom.id, 'attachment', `f${i}.txt`, Buffer.from('x'));
  await assert.rejects(addFile(h.ctx, mom.id, 'attachment', 'eleventh.txt', Buffer.from('x')), /at most 10/);
  await addFile(h.ctx, mom.id, 'audio', 'a.m4a', Buffer.from('x'));
  assert.equal(getMom(h.ctx, mom.id).files.length, 11, 'audio notes are not attachments');
  await assert.rejects(addFile(h.ctx, mom.id, 'attachment', 'e.txt', Buffer.alloc(0)), /empty/);
});

test('U095 file names are sanitised: folders, absolute paths, control characters and over-long names', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('/abs/path/file.pdf'), 'file.pdf');
  assert.equal(safeFileName('C:\\dir\\file.pdf'), 'file.pdf');
  assert.equal(safeFileName('a\u0000b.txt'), 'ab.txt');
  assert.equal(safeFileName('x'.repeat(500)).length, 120);
  assert.equal(safeFileName('.hidden'), 'hidden');
  for (const bad of ['', '   ', undefined, '/', '..']) assert.throws(() => safeFileName(bad), /needs a name/);
});

test('U096 transcript status derives: none, automatic (agent), pasted; pasting after automatic shows pasted', async () => {
  const h = harness();
  const { f } = setup(h);
  const mom = createMom(h.ctx, { followupId: f.id });
  assert.equal(mom.transcriptStatus, 'none');
  await assert.rejects(Promise.resolve().then(() => transcribe(h.ctx, mom.id)), /audio note first/);
  await addFile(h.ctx, mom.id, 'audio', 'a.m4a', Buffer.from('audio'));
  h.agent.reply = 'spoken words';
  const auto = await transcribe(h.ctx, mom.id);
  assert.deepEqual([auto.mom.transcriptStatus, auto.mom.transcript], ['automatic', 'spoken words']);
  assert.match(h.agent.requests[0]!.prompt, /Transcribe the audio file at .* with any tool available/);
  assert.equal(patchMom(h.ctx, mom.id, { transcript: 'pasted text' }).transcriptStatus, 'pasted');
  h.agent.reply = new Error('no tool');
  const failed = await transcribe(h.ctx, mom.id);
  assert.deepEqual([failed.agentError, failed.mom.transcriptStatus], ['no tool', 'pasted']);
});

test('U097 an action item becomes a followup in one click; a second click returns the same one', () => {
  const h = harness();
  const { c, f } = setup(h);
  const mom = createMom(h.ctx, { followupId: f.id, actionItems: [{ title: 'Send proposal', dueAt: h.clock.now + 3 * DAY, type: 'call' }] });
  const once = actionItemToFollowup(h.ctx, mom.id, 0);
  const twice = actionItemToFollowup(h.ctx, mom.id, 0);
  assert.deepEqual([once.created, twice.created, twice.followupId], [true, false, once.followupId]);
  const rows = h.ctx.db.prepare("SELECT type, title, contactId FROM followups WHERE title = 'Send proposal'").all();
  assert.deepEqual(rows, [{ type: 'call', title: 'Send proposal', contactId: c.id }]);
  assert.throws(() => actionItemToFollowup(h.ctx, mom.id, 5), /does not exist/);
});

test('U098 the agent output parser: well-formed, missing sections, garbage', () => {
  const ok = parseMomOutput('## Summary\nWe met.\n\n## Decisions\nGo ahead.\n\n## Action items\n- Send quote\n2. Book call\n');
  assert.deepEqual(ok, { summary: 'We met.', decisions: 'Go ahead.', actionItems: ['Send quote', 'Book call'] });
  assert.deepEqual(parseMomOutput('Summary:\nOnly this'), { summary: 'Only this', decisions: '', actionItems: [] });
  assert.deepEqual(parseMomOutput('random words with no headings'), { summary: 'random words with no headings', decisions: '', actionItems: [] });
  assert.deepEqual(parseMomOutput(''), { summary: '', decisions: '', actionItems: [] });
});

test('I090 (engine part) analysis is a draft unless "apply without review" is on for MOMs; failure is shown in place', async () => {
  const h = harness();
  const { f } = setup(h);
  const mom = createMom(h.ctx, { followupId: f.id, notes: 'typed' });
  h.agent.reply = '## Summary\nS\n## Decisions\nD\n## Action items\n- A';
  const draft = await analyse(h.ctx, mom.id);
  assert.deepEqual([draft.applied, draft.mom.summary, draft.mom.draft?.summary], [false, '', 'S']);
  assert.equal(acceptDraft(h.ctx, mom.id, { summary: 'S edited' }).summary, 'S edited');
  assert.equal(getMom(h.ctx, mom.id).actionItems[0]!.title, 'A');
  h.ctx.saveSettings({ ...h.ctx.settings(), agentAutoApply: { messageDrafts: false, moms: true } });
  const auto = await analyse(h.ctx, mom.id);
  assert.deepEqual([auto.applied, auto.mom.draft, auto.mom.summary], [true, null, 'S']);
  h.agent.reply = new Error('agent down');
  const failed = await analyse(h.ctx, mom.id);
  assert.equal(failed.agentError, 'agent down');
  assert.equal(patchMom(h.ctx, mom.id, { notes: 'still saves' }).notes, 'still saves');
  assert.equal(listMoms(h.ctx, { search: 'STILL' }).total, 1);
});

// ---- reports ---------------------------------------------------------------------
test('U100 day, ISO week (Monday start) and month bounds in the Building timezone; 2026 has week 53', () => {
  assert.deepEqual(PERIODS, ['day', 'week', 'month']);
  const w = windowFor('week', '2026-03-18', 'UTC');
  assert.deepEqual([w.startDay, w.endDay, w.label], ['2026-03-16', '2026-03-23', '2026-W12']);
  assert.deepEqual([windowFor('month', '2026-02-10', 'UTC').startDay, windowFor('month', '2026-02-10', 'UTC').endDay], ['2026-02-01', '2026-03-01']);
  assert.deepEqual(isoWeek('2027-01-01'), { year: 2026, week: 53 });
  assert.equal(windowFor('week', '2027-01-01', 'UTC').label, '2026-W53');
  assert.equal(windowFor('day', '2026-03-16', 'Asia/Kolkata').start, Date.parse('2026-03-15T18:30:00Z'));
});

test('U101 previous period: January → December of the year before; week 1 → the last week of the year before; day → yesterday', () => {
  assert.equal(previousWindow(windowFor('month', '2026-01-15', 'UTC'), 'UTC').label, '2025-12');
  assert.equal(previousWindow(windowFor('week', '2026-01-01', 'UTC'), 'UTC').label, '2025-W52');
  assert.equal(previousWindow(windowFor('day', '2026-03-01', 'UTC'), 'UTC').label, '2026-02-28');
  assert.throws(() => parsePeriod('year', undefined, '2026-03-16', 'UTC'), /period/);
  assert.throws(() => parsePeriod('day', '2026-02-30', '2026-03-16', 'UTC'), /date/);
});

test('U102 a DST-change day is 23 or 25 hours and still one day; 23:59:59 at a month end counts in the right month', () => {
  const d = windowFor('day', '2026-03-29', 'Europe/Berlin');
  assert.equal((d.end - d.start) / 3_600_000, 23);
  const o = windowFor('day', '2026-10-25', 'Europe/Berlin');
  assert.equal((o.end - o.start) / 3_600_000, 25);
  const feb = windowFor('month', '2026-02-10', 'Europe/Berlin');
  const edge = zonedMs('2026-02-28', 23 * 60 + 59, 'Europe/Berlin') + 59_000;
  assert.ok(edge >= feb.start && edge < feb.end);
  assert.ok(edge + 1000 >= feb.end);
});

const reachoutSent = (h: Harness, n: number) => {
  const c = createContact(h.ctx, { name: `P${n}`, channels: [{ type: n % 2 ? 'instagram' : 'linkedin', handle: `h${n}` }], tags: [] });
  const f = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id }).followup;
  submitManual(h.ctx, f.id, { choice: 'sent' });
  return c;
};

test('U103/U104 a period before the first record says so; a metric with no recorded event is null, never 0', () => {
  const h = harness();
  reachoutSent(h, 1);
  const now = buildReport(h.ctx, { period: 'day' });
  assert.deepEqual([now.beforeFirstRecord, now.firstRecordDay, now.hasRecords], [false, '2026-03-16', true]);
  assert.deepEqual([now.period.metrics.prospectsAdded, now.period.metrics.reachoutsSent, now.period.metrics.followupsSent, now.period.metrics.lostProspects], [1, 1, null, null]);
  const before = buildReport(h.ctx, { period: 'day', date: '2026-03-10' });
  assert.deepEqual([before.beforeFirstRecord, before.period.metrics.prospectsAdded], [true, null]);
  const none = buildReport(harness().ctx, { period: 'week' });
  assert.deepEqual([none.hasRecords, none.beforeFirstRecord, none.firstRecordDay, none.period.metrics.reachoutsSent], [false, false, null, null]);
});

test('U105 on time = completed within 30 minutes of due: 30:00 on time, 30:01 delayed, early on time; the delay is recorded', async () => {
  const h = harness();
  const cases: Array<[string, number]> = [['early', -5 * MIN], ['edge', 30 * MIN], ['late', 30 * MIN + 1000], ['later', 95 * MIN]];
  for (const [i, [, offset]] of cases.entries()) {
    const c = createContact(h.ctx, { name: `P${i}`, channels: [{ type: 'instagram', handle: `x${i}` }] });
    const t = createTask(h.ctx, c.id, { type: 'call', dueAt: h.clock.now + 60 * MIN });
    h.clock.now += 60 * MIN + offset;
    completeItem(h.ctx, t.id);
    h.clock.now -= 60 * MIN + offset;
  }
  const m = buildReport(h.ctx, { period: 'day' }).period.metrics;
  assert.deepEqual([m.onTime, m.delayed, m.maxDelayMinutes], [2, 2, 95]);
  assert.deepEqual(buildReport(h.ctx, { period: 'day', date: '2026-03-15' }).period.metrics.onTime, null);
});

test('U107 counts come from stored events: a contact that later becomes lost or a customer does not change earlier periods', () => {
  const h = harness();
  const c = reachoutSent(h, 1), d = reachoutSent(h, 2);
  const before = JSON.stringify(buildReport(h.ctx, { period: 'day' }).period.metrics);
  h.advance(2 * DAY);
  markLost(h.ctx, c.id, 'Other'); markCustomer(h.ctx, d.id);
  assert.equal(JSON.stringify(buildReport(h.ctx, { period: 'day', date: '2026-03-16' }).period.metrics), before);
  const later = buildReport(h.ctx, { period: 'day' }).period.metrics;
  assert.deepEqual([later.lostProspects, later.newCustomers, later.prospectsAdded], [1, 1, null]);
  const week = buildReport(h.ctx, { period: 'week', date: '2026-03-18' });
  assert.deepEqual([week.period.metrics.prospectsAdded, week.period.metrics.reachoutsSent], [2, 2]);
});

test('U108 breakdowns by channel and by source sum back to the total; a row with no data is null', async () => {
  const h = harness();
  for (let i = 1; i <= 5; i++) reachoutSent(h, i);
  const r = buildReport(h.ctx, { period: 'day' });
  assert.deepEqual(r.byChannel.map((b) => [b.label, b.reachoutsSent, b.followupsSent]), [['instagram', 3, null], ['linkedin', 2, null]]);
  assert.equal(r.byChannel.reduce((n, b) => n + (b.reachoutsSent ?? 0), 0), r.period.metrics.reachoutsSent);
  assert.equal(r.bySource.reduce((n, b) => n + (b.added ?? 0), 0), r.period.metrics.prospectsAdded);
  assert.equal(r.bySource[0]!.label, 'added by hand');
  h.advance(2 * DAY); await tick(h.ctx);
  assert.deepEqual(buildReport(h.ctx, { period: 'day' }).byChannel, [], 'a day with nothing sent has no channel rows');
});

test('I103 (engine part) CSV export covers each table; "no data" is written for null and formula cells get an apostrophe', () => {
  const h = harness();
  const c = createContact(h.ctx, { name: '=HYPERLINK("x")', channels: [{ type: 'instagram', handle: 'z' }] });
  void c;
  const summary = reportCsv(h.ctx, { period: 'day', table: 'summary' });
  assert.match(summary.name, /^crm-summary-2026-03-16\.csv$/);
  assert.match(summary.csv, /Reachouts sent,no data,no data/);
  assert.match(summary.csv, /Prospects added,1,no data/);
  const bySource = reportCsv(h.ctx, { period: 'day', table: 'by-source' });
  assert.ok(bySource.csv.startsWith('Source,Prospects added'));
  h.ctx.db.prepare("UPDATE batches SET name = name").run();
  h.ctx.db.prepare("UPDATE contacts SET source = '=cmd|x'").run();
  assert.match(reportCsv(h.ctx, { period: 'day', table: 'by-source' }).csv, /'=cmd\|x/);
  assert.throws(() => reportCsv(h.ctx, { period: 'day', table: 'bogus' }), /table/);
  assert.throws(() => reportCsv(h.ctx, { table: 'summary', period: 'day', batch: '99' }), /batch/);
});
