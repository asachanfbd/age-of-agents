import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCron, upcomingRuns } from '../src/scheduler/cron.ts';
import { SeoInputError } from '../src/seo/errors.ts';
import { SCHEDULE_ACTION_LIST } from '../src/seo/scheduleActionList.ts';
import * as p from '../src/seo/proposalRules.ts';
import * as r from '../src/seo/taskRules.ts';
import type { TaskRow } from '../src/seo/taskRules.ts';

const refused = (fn: () => unknown, pattern?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof SeoInputError && (!pattern || pattern.test(e.message)));

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 'a', source: 'manual', title: 'Fix titles', subKind: 'content', group: 'not-started', statusLabel: 'To do', statusNote: null, owner: 'me', dueDate: null, overdue: false, overdueDays: 0,
  priority: null, links: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', runId: null, jobId: null, ...over,
});

test('U01 manual statuses map to the shared groups; cancelled is Done but labelled Cancelled', () => {
  assert.deepEqual(r.manualStatusView('todo'), { group: 'not-started', label: 'To do' });
  assert.deepEqual(r.manualStatusView('in-progress'), { group: 'running', label: 'In progress' });
  assert.deepEqual(r.manualStatusView('blocked'), { group: 'failed-blocked', label: 'Blocked' });
  assert.deepEqual(r.manualStatusView('done'), { group: 'done', label: 'Done' });
  assert.deepEqual(r.manualStatusView('cancelled'), { group: 'done', label: 'Cancelled' });
});

test('U02 an agent task takes its status from the run: queued, running, awaiting approval, succeeded, failed, stopped', () => {
  const view = (run: Parameters<typeof r.agentStatusView>[0]['run']) => r.agentStatusView({ run });
  assert.equal(view(null).group, 'not-started');
  assert.equal(view({ status: 'running', note: null }).group, 'running');
  assert.equal(view({ status: 'awaiting-approval', note: 'Waiting for approval' }).group, 'needs-approval');
  assert.equal(view({ status: 'succeeded', note: null }).group, 'done');
  assert.deepEqual([view({ status: 'failed', note: 'boom' }).group, view({ status: 'failed', note: 'boom' }).note], ['failed-blocked', 'boom']);
  assert.equal(view({ status: 'stopped', note: null }).label, 'Stopped');
  assert.equal(r.agentStatusView({ run: null, startError: 'No workflow' }).group, 'failed-blocked');
});

test('U03 a scheduled fetch reads never run, running, last ok, last failed, auto-disabled and paused', () => {
  const on = { enabled: true, autoDisabled: false };
  assert.equal(r.scheduleStatusView(on, null).label, 'Scheduled');
  assert.equal(r.scheduleStatusView(on, { outcome: 'running', note: null }).group, 'running');
  assert.equal(r.scheduleStatusView(on, { outcome: 'succeeded', note: 'Synced' }).group, 'done');
  assert.equal(r.scheduleStatusView(on, { outcome: 'failed', note: 'nope' }).group, 'failed-blocked');
  assert.equal(r.scheduleStatusView(on, { outcome: 'skipped', note: 'busy' }).label, 'Last run skipped');
  assert.deepEqual(r.scheduleStatusView({ enabled: false, autoDisabled: true }, { outcome: 'failed', note: 'x' }).label, 'Turned off after failures');
  assert.equal(r.scheduleStatusView({ enabled: false, autoDisabled: false }, { outcome: 'succeeded', note: null }).label, 'Paused');
});

test('U04 an approved proposal is Done once handed off, Failed when the handoff failed, Running while it is in flight', () => {
  const run = { status: 'awaiting-approval' as const, note: null };
  assert.equal(r.agentStatusView({ run, approved: true, handoff: 'handed-off' }).group, 'done');
  assert.equal(r.agentStatusView({ run, approved: true, handoff: 'failed' }).group, 'failed-blocked');
  assert.equal(r.agentStatusView({ run, approved: true, handoff: 'handing-off' }).group, 'running');
  assert.equal(r.agentStatusView({ run, approved: true, handoff: 'awaiting-approval' }).group, 'running');
});

test('U05/U32 overdue is a plain-date comparison on open manual tasks only', () => {
  const today = '2026-10-15';
  const late = (dueDate: string | null, status: r.ManualStatus = 'todo') => r.overdueDays({ dueDate, status }, today);
  assert.equal(late('2026-10-14'), 1);
  assert.equal(late('2026-10-15'), 0);
  assert.equal(late('2026-10-16'), 0);
  assert.equal(late(null), 0);
  assert.equal(late('2026-10-01', 'done'), 0);
  assert.equal(late('2026-10-01', 'cancelled'), 0);
  assert.equal(late('2026-10-01', 'blocked'), 14);
});

test('U06 the day rolls over at midnight in the Building\'s timezone', () => {
  assert.equal(r.dayIn(new Date('2026-10-15T23:59:59Z'), 'UTC'), '2026-10-15');
  assert.equal(r.dayIn(new Date('2026-10-16T00:00:00Z'), 'UTC'), '2026-10-16');
  assert.equal(r.dayIn(new Date('2026-10-15T23:30:00Z'), 'Asia/Tokyo'), '2026-10-16');
  assert.equal(r.overdueDays({ dueDate: '2026-10-15', status: 'todo' }, r.dayIn(new Date('2026-10-15T23:59:59Z'), 'UTC')), 0);
  assert.equal(r.overdueDays({ dueDate: '2026-10-15', status: 'todo' }, r.dayIn(new Date('2026-10-16T00:00:00Z'), 'UTC')), 1);
});

test('U07 "due this week" is today through today + 7, inclusive', () => {
  const today = '2026-10-15';
  assert.equal(r.matchesDue('2026-10-15', 'week', today), true);
  assert.equal(r.matchesDue('2026-10-22', 'week', today), true);
  assert.equal(r.matchesDue('2026-10-23', 'week', today), false);
  assert.equal(r.matchesDue('2026-10-14', 'week', today), false);
  assert.equal(r.matchesDue(null, 'week', today), false);
  assert.equal(r.matchesDue(null, 'none', today), true);
  assert.equal(r.matchesDue('2026-10-14', 'overdue', today), true);
  assert.equal(r.matchesDue('2026-10-15', 'today', today), true);
});

test('U08 a title is 1 to 500 characters after trimming; notes at most 20,000', () => {
  refused(() => r.requireTitle(''));
  refused(() => r.requireTitle('   '));
  refused(() => r.requireTitle(5));
  assert.equal(r.requireTitle('  hi  '), 'hi');
  assert.equal(r.requireTitle('x'.repeat(500)).length, 500);
  refused(() => r.requireTitle('x'.repeat(501)), /500/);
  assert.equal(r.optionalNotes('n'.repeat(20_000)).length, 20_000);
  refused(() => r.optionalNotes('n'.repeat(20_001)));
  refused(() => r.optionalNotes(7));
  assert.equal(r.optionalNotes(undefined), '');
});

test('U09 kind, status and priority are exact lower-case values; priority may be null', () => {
  assert.equal(r.requireOneOf('outreach', r.TASK_KINDS, 'kind'), 'outreach');
  refused(() => r.requireOneOf('Outreach', r.TASK_KINDS, 'kind'));
  refused(() => r.requireOneOf('unknown', r.MANUAL_STATUSES, 'status'));
  refused(() => r.requireOneOf(3, r.MANUAL_STATUSES, 'status'));
  assert.equal(r.optionalPriority(null), null);
  assert.equal(r.optionalPriority(undefined), null);
  assert.equal(r.optionalPriority('high'), 'high');
  refused(() => r.optionalPriority('urgent'));
});

test('U10 a due date is a real calendar day from 2000-01-01 to 2100-12-31', () => {
  for (const ok of ['2000-01-01', '2100-12-31', '2028-02-29']) assert.equal(r.optionalDueDate(ok), ok);
  for (const bad of ['1999-12-31', '2101-01-01', '2027-02-29', '2026-10-15T10:00:00Z', '15/10/2026', '2026-1-5', 20261015]) refused(() => r.optionalDueDate(bad));
  assert.equal(r.optionalDueDate(null), null);
});

test('U11 evidence links are http(s) addresses without credentials, at most 20 of at most 2,048 characters, duplicates collapsed', () => {
  assert.deepEqual(r.evidenceLinks(['https://a.test/x', 'https://a.test/x']), ['https://a.test/x']);
  for (const bad of ['javascript:alert(1)', 'ftp://a.test/x', '/relative', 'https://user:pw@a.test/x', 'not a url']) refused(() => r.evidenceLinks([bad]));
  refused(() => r.evidenceLinks([7]));
  refused(() => r.evidenceLinks('https://a.test'));
  const long = (n: number) => `https://a.test/${'x'.repeat(n - 'https://a.test/'.length)}`;
  assert.equal(r.evidenceLinks([long(2048)]).length, 1);
  refused(() => r.evidenceLinks([long(2049)]));
  assert.equal(r.evidenceLinks(Array.from({ length: 20 }, (_, i) => `https://a.test/${i}`)).length, 20);
  refused(() => r.evidenceLinks(Array.from({ length: 21 }, (_, i) => `https://a.test/${i}`)), /20/);
});

test('U12 a linked item has a known type; page addresses and keywords are brought to their one spelling', () => {
  assert.deepEqual(r.parseLink({ type: 'page', ref: 'http://Example.test/a/?utm_source=x' }), { type: 'page', ref: 'https://example.test/a' });
  assert.deepEqual(r.parseLink({ type: 'keyword', ref: '  Blue   Shoes ' }), { type: 'keyword', ref: 'blue shoes' });
  assert.deepEqual(r.parseLink({ type: 'cluster', ref: ' abc ' }), { type: 'cluster', ref: 'abc' });
  assert.equal(r.parseLink(null), null);
  refused(() => r.parseLink({ type: 'banana', ref: 'x' }));
  refused(() => r.parseLink({ type: 'page', ref: 'not a url' }));
  refused(() => r.parseLink({ type: 'keyword', ref: 'k'.repeat(501) }));
  refused(() => r.parseLink({ type: 'page', ref: `https://a.test/${'p'.repeat(2048)}` }));
  refused(() => r.parseLink({ type: 'backlink', ref: '' }));
  refused(() => r.parseLink('page'));
});

test('U13 a snapshot keeps a readable label and detail for each link type, trimmed to the limits', () => {
  for (const type of r.LINK_TYPES) assert.equal(r.snapshotOf(type, 'ref-1').label, 'ref-1');
  const s = r.snapshotOf('backlink', 'u1', { label: 'https://a.com/p', detail: 'to https://x.test/y' });
  assert.deepEqual([s.type, s.label, s.detail], ['backlink', 'https://a.com/p', 'to https://x.test/y']);
  assert.equal(r.snapshotOf('keyword', 'k', { detail: 'd'.repeat(900) }).detail.length, 500);
});

test('U14 an edit changes only the fields it names and ignores unknown ones; the whole result is checked', () => {
  const current: r.ManualFields = { title: 'T', kind: 'other', notes: 'n', status: 'todo', priority: null, dueDate: null, evidence: [] };
  assert.deepEqual(r.parseManualPatch(current, { status: 'done', mystery: 1 }), { ...current, status: 'done' });
  assert.deepEqual(r.parseManualPatch(current, { priority: 'low', dueDate: '2026-11-01' }), { ...current, priority: 'low', dueDate: '2026-11-01' });
  assert.equal(r.parseManualPatch({ ...current, priority: 'high' }, { priority: null }).priority, null);
  refused(() => r.parseManualPatch(current, { title: '' }));
  refused(() => r.parseManualPatch(current, null));
  refused(() => r.parseManualPatch(current, []));
});

test('U15/U16 cron uses the scheduler parser, and the next three runs follow the timezone and a daylight-saving change', () => {
  for (const ok of ['0 6 * * *', '*/15 * * * *', '0 9 * * 1', '@daily', '0 9 * * MON', '  0   6 * * *  ']) assert.equal(parseCron(ok).ok, true, ok);
  for (const bad of ['0 6 * *', '0 6 * * * *', '61 * * * *', '*/0 * * * *', '', '   ']) assert.equal(parseCron(bad).ok, false, bad);
  const parsed = parseCron('0 9 * * *');
  assert.ok(parsed.ok);
  const runs = upcomingRuns(parsed.schedule, Date.parse('2026-10-15T00:00:00Z'), 'UTC', 3).map((t) => new Date(t).toISOString());
  assert.deepEqual(runs, ['2026-10-15T09:00:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-17T09:00:00.000Z']);
  // New York leaves daylight time on 2026-11-01, so 09:00 local moves from 13:00Z to 14:00Z.
  const ny = upcomingRuns(parsed.schedule, Date.parse('2026-10-31T00:00:00Z'), 'America/New_York', 3).map((t) => new Date(t).toISOString());
  assert.deepEqual(ny, ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z']);
});

test('U17 the schedule actions are the four data fetches and the two report saves', () => {
  assert.deepEqual(SCHEDULE_ACTION_LIST.map((a) => a.id), ['sync', 'sitemaps', 'crawl', 'indexnow', 'report-weekly', 'report-monthly']);
});

test('U18 character guidance counts code points: title 30 to 60, meta 70 to 160', () => {
  const g = (field: 'title' | 'meta', n: number) => p.guidance(field, 'a'.repeat(n)).state;
  assert.deepEqual([g('title', 0), g('title', 29), g('title', 30), g('title', 60), g('title', 61)], ['empty', 'short', 'good', 'good', 'long']);
  assert.deepEqual([g('meta', 0), g('meta', 69), g('meta', 70), g('meta', 160), g('meta', 161)], ['empty', 'short', 'good', 'good', 'long']);
  assert.equal(p.guidance('title', '😀😀😀').count, 3);
  assert.equal(p.guidance('title', 'é').count, 2);
});

const proposal = (over: Partial<p.ProposalRow> = {}): p.ProposalRow => ({
  id: 'r1', url: 'https://example.test/a', currentTitle: 'Old', currentMeta: 'Old meta', proposedTitle: 'New title', proposedMeta: 'New meta', notes: '', decision: 'pending', editedTitle: null, editedMeta: null, ...over,
});

test('U19 a row decision can be set and cleared; editing text accepts the row, even a rejected one', () => {
  assert.equal(p.applyRowChange(proposal(), { decision: 'accepted' }).decision, 'accepted');
  assert.equal(p.applyRowChange(proposal({ decision: 'accepted' }), { decision: 'pending' }).decision, 'pending');
  assert.equal(p.applyRowChange(proposal(), { decision: 'rejected' }).decision, 'rejected');
  const edited = p.applyRowChange(proposal(), { title: ' Better title ' });
  assert.deepEqual([edited.decision, edited.editedTitle, p.effectiveTitle(edited)], ['accepted', 'Better title', 'Better title']);
  assert.equal(p.applyRowChange(proposal({ decision: 'rejected' }), { meta: 'Edited meta' }).decision, 'accepted');
  assert.equal(p.applyRowChange(proposal({ decision: 'rejected' }), { meta: 'x', decision: 'rejected' }).decision, 'rejected');
  refused(() => p.applyRowChange(proposal(), { decision: 'maybe' }));
  refused(() => p.applyRowChange(proposal(), 'accept'));
});

test('U20 approving needs at least one accepted row; pending rows are counted and left out', () => {
  assert.deepEqual(p.reviewSummary([proposal(), proposal({ id: 'r2', decision: 'rejected' })]), { accepted: 0, rejected: 1, pending: 1, canApprove: false });
  assert.deepEqual(p.reviewSummary([proposal({ decision: 'accepted' }), proposal({ id: 'r2' })]), { accepted: 1, rejected: 0, pending: 1, canApprove: true });
  assert.equal(p.reviewSummary([]).canApprove, false);
});

test('U21 edited text has a hard cap of 500 (title) and 1,000 (meta) characters; an empty title is allowed', () => {
  assert.equal(p.applyRowChange(proposal(), { title: 'x'.repeat(500) }).editedTitle?.length, 500);
  refused(() => p.applyRowChange(proposal(), { title: 'x'.repeat(501) }));
  assert.equal(p.applyRowChange(proposal(), { meta: 'x'.repeat(1000) }).editedMeta?.length, 1000);
  refused(() => p.applyRowChange(proposal(), { meta: 'x'.repeat(1001) }));
  assert.equal(p.applyRowChange(proposal(), { title: '' }).editedTitle, '');
  refused(() => p.applyRowChange(proposal(), { title: 5 }));
});

test('U22 the agent\'s answer is read from a fenced block or bare JSON; unselected, duplicate and malformed rows are dropped', () => {
  const selected = new Set(['https://example.test/a', 'https://example.test/b']);
  const good = '```json\n{"pages":[{"url":"https://example.test/a","title":"T","meta":"M","notes":"why"},{"url":"https://example.test/zzz","title":"X"},{"url":"https://example.test/a","title":"dup"},{"url":"https://example.test/b","title":5}]}\n```';
  const out = p.parseProposalOutput([good], selected);
  assert.deepEqual(out.rows, [{ url: 'https://example.test/a', proposedTitle: 'T', proposedMeta: 'M', notes: 'why' }]);
  assert.equal(out.skipped, 1);
  assert.equal(p.parseProposalOutput(['[{"url":"https://example.test/b","title":"B"}]'], selected).rows[0]?.proposedTitle, 'B');
  assert.equal(p.parseProposalOutput(['no json here', '{"pages":[{"url":"https://example.test/a","title":"later output"}]}'], selected).rows.length, 1);
  refused(() => p.parseProposalOutput(['{"pages": [ broken'], selected));
  refused(() => p.parseProposalOutput(['just words'], selected));
  refused(() => p.parseProposalOutput([], selected));
  refused(() => p.parseProposalOutput(['{"nothing":1}'], selected));
  const many = new Set(Array.from({ length: 150 }, (_, i) => `https://example.test/p${i}`));
  const rows = JSON.stringify({ pages: [...many].map((url) => ({ url, title: 't' })) });
  assert.equal(p.parseProposalOutput([rows], many).rows.length, 100);
});

test('U23 the CSV holds only accepted rows with edited values, and keeps formulas from running in a spreadsheet', () => {
  const rows = [
    proposal({ decision: 'accepted', proposedTitle: 'Plain', editedTitle: 'Edited, "quoted"', notes: 'line1\nline2' }),
    proposal({ id: 'r2', decision: 'rejected', url: 'https://example.test/rej' }),
    proposal({ id: 'r3', decision: 'pending', url: 'https://example.test/pend' }),
    proposal({ id: 'r4', decision: 'accepted', url: 'https://example.test/f', proposedTitle: '=cmd()', proposedMeta: '+1', currentTitle: '-2', currentMeta: '@x' }),
    proposal({ id: 'r5', decision: 'accepted', url: 'https://example.test/u', proposedTitle: 'Café – ünï ✓' }),
  ];
  const csv = p.proposalCsv(rows);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'url,current_title,new_title,current_meta,new_meta,notes');
  assert.match(csv, /"Edited, ""quoted"""/);
  assert.match(csv, /"line1\nline2"/);
  assert.doesNotMatch(csv, /\/rej|\/pend/);
  assert.match(csv, /'=cmd\(\)/);
  assert.match(csv, /'\+1/);
  assert.match(csv, /'-2/);
  assert.match(csv, /'@x/);
  assert.match(csv, /Café – ünï ✓/);
  assert.equal(p.proposalCsv([]), 'url,current_title,new_title,current_meta,new_meta,notes\r\n');
});

test('U24 the planning prompt holds only accepted rows, is never truncated and is refused past the limit', () => {
  const rows = [proposal({ decision: 'accepted' }), proposal({ id: 'r2', url: 'https://example.test/rej', decision: 'rejected' }), proposal({ id: 'r3', url: 'https://example.test/pend' })];
  const text = p.handoffPrompt('Title proposals', rows)!;
  assert.match(text, /example\.test\/a/);
  assert.doesNotMatch(text, /rej|pend/);
  assert.match(text, /Old -> New title/);
  const exact = p.handoffPrompt('T', [proposal({ decision: 'accepted' })])!;
  assert.equal(p.handoffPrompt('T', [proposal({ decision: 'accepted' })], [...exact].length), exact);
  assert.equal(p.handoffPrompt('T', [proposal({ decision: 'accepted' })], [...exact].length - 1), null);
  const multibyte = proposal({ decision: 'accepted', notes: '日本語'.repeat(4000) });
  assert.equal(p.handoffPrompt('T', [multibyte]), null);
  assert.notEqual(p.handoffPrompt('T', [proposal({ decision: 'accepted', notes: '日本語' })]), null);
});

test('U26 the follow-up task is a short "Publish: ..." task naming the number of approved changes', () => {
  assert.deepEqual(p.followUpTask('New titles for 12 pages', 12), { title: 'Publish: New titles for 12 pages', notes: '12 approved changes from "New titles for 12 pages" are ready to be published on the website.' });
  assert.match(p.followUpTask('x', 1).notes, /^1 approved change from/);
  assert.equal(p.followUpTask('t'.repeat(300), 2).title.length, 120);
});

test('U28 the filters work alone and together, ignore case in the search and keep a stable order', () => {
  const rows = [
    row({ id: 'a', title: 'Fix Titles', source: 'manual', group: 'not-started', owner: 'me', dueDate: '2026-10-14', links: [{ type: 'page', ref: 'p', label: 'https://x.test/pricing', detail: '', inData: null }] }),
    row({ id: 'b', title: 'Sync GSC', source: 'scheduled', group: 'done', owner: 'system' }),
    row({ id: 'c', title: 'Title proposals', source: 'agent', group: 'needs-approval', owner: 'agent', updatedAt: '2026-10-02T00:00:00Z' }),
  ];
  const today = '2026-10-15';
  const ids = (filter: r.TaskFilter) => r.filterRows(rows, filter, today).map((x) => x.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c']);
  assert.deepEqual(ids({ source: 'agent' }), ['c']);
  assert.deepEqual(ids({ group: 'done' }), ['b']);
  assert.deepEqual(ids({ owner: 'me' }), ['a']);
  assert.deepEqual(ids({ due: 'overdue' }), ['a']);
  assert.deepEqual(ids({ linkType: 'page' }), ['a']);
  assert.deepEqual(ids({ search: 'TITLE' }), ['a', 'c']);
  assert.deepEqual(ids({ search: 'pricing' }), ['a']);
  assert.deepEqual(ids({ search: 'title', source: 'manual' }), ['a']);
  assert.deepEqual(ids({ search: 'nothing matches' }), []);
  assert.deepEqual(r.orderRows(rows).map((x) => x.id), ['a', 'b', 'c'].sort((x, y) => (rows.find((q) => q.id === y)!.updatedAt.localeCompare(rows.find((q) => q.id === x)!.updatedAt)) || x.localeCompare(y)));
});

test('U29 the group counts equal the filtered rows', () => {
  const rows = [row({ id: 'a', group: 'done' }), row({ id: 'b', group: 'done' }), row({ id: 'c', group: 'running' })];
  assert.deepEqual(r.groupCounts(rows), { 'not-started': 0, running: 1, 'needs-approval': 0, done: 2, 'failed-blocked': 0 });
  assert.equal(Object.values(r.groupCounts(r.filterRows(rows, { group: 'done' }, '2026-10-15'))).reduce((a, b) => a + b, 0), 2);
});

test('U33 a usage-limit wait reads as deferred, not as a failure', () => {
  const view = r.agentStatusView({ run: { status: 'running', note: 'Usage limit reached; resets at 14:00' } });
  assert.deepEqual([view.group, view.label], ['not-started', 'Deferred (usage limit)']);
  assert.equal(r.agentStatusView({ run: { status: 'failed', note: 'Usage limit reached' } }).group, 'failed-blocked');
});

test('U34 a task id is letters, digits, dash and underscore, at most 100 characters', () => {
  assert.equal(r.requireTaskId('abc-123_X'), 'abc-123_X');
  for (const bad of ['../etc', 'a/b', 'a b', '', 'x'.repeat(101), 5]) refused(() => r.requireTaskId(bad));
});

test('list query: kind, group, owner, due and linkType must be known values; limit 1 to 500, offset 0 to 10,000,000', () => {
  assert.deepEqual(r.parseTaskQuery({}).limit, 100);
  assert.equal(r.parseTaskQuery({ limit: '500', offset: '10000000' }).limit, 500);
  for (const bad of [{ limit: '0' }, { limit: '501' }, { offset: '10000001' }, { limit: '-1' }, { limit: '1.5' }, { limit: 'NaN' }, { limit: '1e400' }, { limit: String(2 ** 53) }, { kind: 'x' }, { group: 'x' }, { owner: 'x' }, { due: 'x' }, { linkType: 'x' }, { search: 's'.repeat(501) }]) {
    refused(() => r.parseTaskQuery(bad), undefined);
  }
});
