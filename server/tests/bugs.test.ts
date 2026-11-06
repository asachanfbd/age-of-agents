import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUG_LIMITS, BugValidationError, agentBugSections, bugGroupId, bugNumber, bugTitle, buildBugDescription, compareBugGroupOrder,
  hasStarted, isOpenBug, isReadyBug, linkedSessionNumber, parseAgentBug, parseBugReport, parseBugReportPatch, parseBugTitle,
  parseCommit, parseInfoStatus, parseReportedTask, parseReportedTaskPatch, parseSeverity, parseSuspectedLocation, planItemType, readBugAttributes, readRelatedBug, sameTestRef,
  splitNumberedTitle, taskRefOf, withPlanItemType,
} from '../src/projects/bugs.ts';
import type { BugAttributes, PlanItemRecord } from '../src/domain/types.ts';

const NOW = '2026-10-11T10:00:00.000Z';

function record(patch: Partial<PlanItemRecord> = {}): PlanItemRecord {
  return {
    id: 'item-1', projectId: 'p1', title: 'A task', description: '', status: 'pending', order: 0,
    taskIds: [], milestoneId: null, createdAt: NOW, updatedAt: NOW, ...patch,
  };
}

const FULL_BUG: BugAttributes = {
  severity: 'high',
  infoStatus: 'enough',
  introducedBy: { planItemId: 'intro', number: '4.002', title: 'Add login', commit: 'abc1234' },
  suspectedLocation: 'web/src/login',
  foundWhileWorkingOn: { planItemId: 'found', number: '5.001', title: 'Other' },
  reportSessionNumber: 7,
  testRef: { suiteId: 'server', actionId: 'tests', caseId: 'login works' },
  groupOrder: 2,
  summary: 'Login fails',
  expectedVsActual: 'Should log in; shows an error',
  stepsToReproduce: 'Open the app',
  regressions: [],
};

const stored = (bug: unknown, patch: Partial<PlanItemRecord> = {}) => withPlanItemType(record({ type: 'bug', bug: bug as BugAttributes, ...patch }));

// ---- Reading stored records ----

test('U1 a record with no type reads as a task, with no bug object', () => {
  const item = withPlanItemType(record());
  assert.equal(item.type, 'task');
  assert.equal('bug' in item, false);
  assert.equal(planItemType(record()), 'task');
});

test('U2 a full valid bug round-trips unchanged', () => {
  const item = stored(FULL_BUG);
  assert.equal(item.type, 'bug');
  assert.deepEqual(item.bug, FULL_BUG);
  assert.deepEqual(withPlanItemType(item), item, 'reading an already-read bug changes nothing');
});

test('U3 an invalid stored severity reads null and keeps every other attribute', () => {
  assert.deepEqual(stored({ ...FULL_BUG, severity: 'urgent' }).bug, { ...FULL_BUG, severity: null });
});

test('U4 an invalid stored Info status reads null', () => {
  assert.equal(stored({ ...FULL_BUG, infoStatus: 'Needs more info' }).bug!.infoStatus, null);
});

test('U5 a malformed introducedBy (a string, or no planItemId) reads null', () => {
  assert.equal(stored({ ...FULL_BUG, introducedBy: '4.002' }).bug!.introducedBy, null);
  assert.equal(stored({ ...FULL_BUG, introducedBy: { number: '4.002', title: 'x' } }).bug!.introducedBy, null);
  assert.equal(stored({ ...FULL_BUG, foundWhileWorkingOn: 42 }).bug!.foundWhileWorkingOn, null);
  assert.equal(stored({ ...FULL_BUG, testRef: { suiteId: 'server' } }).bug!.testRef, null);
  assert.equal(stored({ ...FULL_BUG, groupOrder: 'first', reportSessionNumber: 1.5 }).bug!.groupOrder, null);
  assert.equal(stored({ ...FULL_BUG, reportSessionNumber: 1.5 }).bug!.reportSessionNumber, null);
});

test('U6 a bug whose stored bug value is a string, an array or null has every attribute absent and never throws', () => {
  const empty = readBugAttributes(undefined);
  assert.ok(Object.entries(empty).every(([key, value]) => (key === 'regressions' ? Array.isArray(value) && value.length === 0 : value === null)));
  for (const value of ['broken', ['a'], null, 7]) {
    const item = stored(value);
    assert.equal(item.type, 'bug', 'it stays a bug');
    assert.deepEqual(item.bug, empty);
  }
});

test('U7 an unknown type value reads as a task', () => {
  const item = withPlanItemType(record({ type: 'epic' as never }));
  assert.equal(item.type, 'task');
});

test('U8 bug attributes on a task record are ignored', () => {
  const item = withPlanItemType(record({ type: 'task', bug: FULL_BUG }));
  assert.equal(item.type, 'task');
  assert.equal('bug' in item, false);
  assert.equal(linkedSessionNumber(record({ bug: FULL_BUG })), undefined);
  assert.equal(bugGroupId(record({ bug: FULL_BUG })), null);
});

// ---- Field validation ----

const refused = (run: () => unknown, pattern?: RegExp) => assert.throws(run, (error) => error instanceof BugValidationError && (!pattern || pattern.test((error as Error).message)));

test('U9 title: 200 characters pass, 201 are refused, whitespace-only is missing, the value is trimmed', () => {
  assert.equal(parseBugTitle('x'.repeat(BUG_LIMITS.title)).length, 200);
  refused(() => parseBugTitle('x'.repeat(201)), /at most 200/);
  refused(() => parseBugTitle('   '), /title is required/);
  refused(() => parseBugTitle(undefined), /title is required/);
  assert.equal(parseBugTitle('  Crash on save  '), 'Crash on save');
});

test('U10 description: the composed text takes 20,000 characters and not 20,001; an agent sends at most 18,000, which always fits', () => {
  const empty = buildBugDescription({ summary: null, expectedVsActual: null, stepsToReproduce: null, suspectedLocation: null, introducedBy: null });
  const room = BUG_LIMITS.description - (empty.length - 'Unknown'.length);
  assert.equal(buildBugDescription({ summary: 's'.repeat(room), expectedVsActual: null, stepsToReproduce: null, suspectedLocation: null, introducedBy: null }).length, 20_000);
  refused(() => buildBugDescription({ summary: 's'.repeat(room + 1), expectedVsActual: null, stepsToReproduce: null, suspectedLocation: null, introducedBy: null }), /at most 20,000 characters \(got 20,001\)/);

  // The longest ids an agent may send, with the longest description it may send.
  const longest = { title: 'T', suiteId: 's'.repeat(BUG_LIMITS.testId), actionId: 'a'.repeat(BUG_LIMITS.testId), caseId: 'c'.repeat(BUG_LIMITS.caseId) };
  const draft = parseAgentBug({ ...longest, description: 'd'.repeat(18_000) });
  assert.equal(draft.description.length, 18_000);
  const composed = buildBugDescription({ ...agentBugSections(draft), suspectedLocation: null, introducedBy: null });
  assert.ok(composed.length <= BUG_LIMITS.description, 'an accepted agent bug is never refused when its description is composed');
  refused(() => parseAgentBug({ ...longest, description: 'd'.repeat(18_001) }), /description must be at most 18,000/);
});

test('U11 suspected location: 500 characters pass and 501 are refused', () => {
  assert.equal(parseSuspectedLocation('l'.repeat(500))!.length, 500);
  refused(() => parseSuspectedLocation('l'.repeat(501)), /at most 500/);
});

test('U12 commit: 64 characters pass, 65 are refused, empty becomes null', () => {
  assert.equal(parseCommit('c'.repeat(64))!.length, 64);
  refused(() => parseCommit('c'.repeat(65)), /at most 64/);
  assert.equal(parseCommit(''), null);
  assert.equal(parseCommit('   '), null);
  assert.equal(parseCommit(undefined), null);
});

test('U13 severity: the four values pass, omitted is null, other spellings and types are refused', () => {
  for (const severity of ['critical', 'high', 'medium', 'low']) assert.equal(parseSeverity(severity), severity);
  assert.equal(parseSeverity(undefined), null);
  for (const bad of ['High', 'HIGH', 'urgent', '', 3]) refused(() => parseSeverity(bad), /severity must be one of/);
});

test('U14 Info status: the two values pass; other spellings and an omitted value are refused', () => {
  assert.equal(parseInfoStatus('enough'), 'enough');
  assert.equal(parseInfoStatus('needs-more-info'), 'needs-more-info');
  for (const bad of ['Needs more info', 'needs_more_info', 'enough-info', undefined, null]) refused(() => parseInfoStatus(bad), /infoStatus must be one of/);
});

test('U15 a non-string title, section or location is refused, never coerced', () => {
  for (const bad of [42, { a: 1 }, ['x']]) {
    refused(() => parseBugTitle(bad), /title must be text/);
    refused(() => parseSuspectedLocation(bad), /suspectedLocation must be text/);
    refused(() => parseBugReport({ title: 'T', infoStatus: 'enough', summary: bad }), /summary must be text/);
    refused(() => parseAgentBug({ title: 'T', suiteId: 's', actionId: 'a', caseId: 'c', description: bad }), /description must be text/);
  }
});

test('U16 a 200-character title with surrounding spaces passes: length is counted after trimming', () => {
  assert.equal(parseBugTitle(`  ${'x'.repeat(200)}  `).length, 200);
});

test('a report draft keeps what was sent, and a patch only the fields sent', () => {
  const draft = parseBugReport({ title: ' Crash ', infoStatus: 'needs-more-info' });
  assert.deepEqual(draft, {
    title: 'Crash', severity: null, infoStatus: 'needs-more-info', suspectedLocation: null, introducedByTaskId: null,
    commit: null, summary: null, expectedVsActual: null, stepsToReproduce: null,
  });
  assert.deepEqual(parseBugReportPatch({ severity: 'low', introducedByTaskId: null }), { severity: 'low', introducedByTaskId: null });
  assert.deepEqual(parseBugReportPatch({ introducedByTaskId: ' task-1 ' }), { introducedByTaskId: 'task-1' });
  refused(() => parseBugReportPatch({}), /at least one field/);
  refused(() => parseBugReportPatch(null), /at least one field/);
  refused(() => parseBugReportPatch({ title: '  ' }), /title is required/);
  refused(() => parseBugReportPatch({ introducedByTaskId: 7 }), /introducedByTaskId/);
  refused(() => parseBugReport({ title: 'T', infoStatus: 'enough', introducedByTaskId: '' }), /introducedByTaskId/);
});

test('an agent bug needs every one of its fields, each within its limit', () => {
  const full = { title: 'T', suiteId: 'server', actionId: 'tests', caseId: ' case one ', description: 'failed: boom' };
  assert.deepEqual(parseAgentBug(full), { title: 'T', description: 'failed: boom', testRef: { suiteId: 'server', actionId: 'tests', caseId: 'case one' } });
  for (const field of Object.keys(full)) {
    refused(() => parseAgentBug({ ...full, [field]: undefined }), new RegExp(`${field} is required`));
    refused(() => parseAgentBug({ ...full, [field]: '   ' }), new RegExp(`${field} is required`));
  }
  assert.equal(parseAgentBug({ ...full, caseId: 'c'.repeat(500) }).testRef.caseId.length, 500);
  refused(() => parseAgentBug({ ...full, caseId: 'c'.repeat(501) }), /caseId must be at most 500/);
});

// ---- Description builder ----

const SECTIONS = { summary: 'S', expectedVsActual: 'E', stepsToReproduce: 'R', suspectedLocation: 'L', introducedBy: FULL_BUG.introducedBy };
const headings = (description: string) => [...description.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

test('U17 the description has five sections in a fixed order', () => {
  assert.deepEqual(headings(buildBugDescription(SECTIONS)), ['Summary', 'Expected vs actual', 'Steps to reproduce', 'Suspected location', 'Introduced by']);
});

test('U18 missing or blank sections are written "Unknown", never omitted', () => {
  const description = buildBugDescription({ summary: null, expectedVsActual: '  ', stepsToReproduce: null, suspectedLocation: null, introducedBy: null });
  assert.equal(headings(description).length, 5);
  assert.equal(description.match(/^Unknown$/gm)?.length, 5);
});

test('U19 Introduced by shows the number, title and commit, and "Unknown" when there is none', () => {
  assert.match(buildBugDescription(SECTIONS), /## Introduced by\n\n4\.002: Add login \(commit abc1234\)$/);
  assert.match(buildBugDescription({ ...SECTIONS, introducedBy: { planItemId: 'i', number: null, title: 'Hand task', commit: null } }), /## Introduced by\n\nHand task$/);
  assert.match(buildBugDescription({ ...SECTIONS, introducedBy: null }), /## Introduced by\n\nUnknown$/);
});

test('U20 a composed description over 20,000 characters is refused, never truncated', () => {
  refused(() => buildBugDescription({ ...SECTIONS, summary: 's'.repeat(20_000) }), /description must be at most 20,000/);
  const fits = buildBugDescription({ ...SECTIONS, summary: 's'.repeat(19_000) });
  assert.ok(fits.includes('s'.repeat(19_000)));
});

test('an agent-found bug describes the failure as its summary and the failing test as the way to reproduce it', () => {
  const sections = agentBugSections({ title: 'T', description: 'AssertionError: 1 !== 2', testRef: { suiteId: 'server', actionId: 'tests', caseId: 'adds numbers' } });
  assert.equal(sections.summary, 'AssertionError: 1 !== 2');
  assert.equal(sections.expectedVsActual, null);
  assert.match(sections.stepsToReproduce!, /"tests" action of the "server" test suite\. Failing case: adds numbers/);
});

// ---- Numbering ----

test('U21 U22 a bug under a task is numbered <task number>.<NNN>, per introducing task', () => {
  assert.equal(bugNumber('4.002', 1), '4.002.001');
  assert.equal(bugNumber('4.002', 2), '4.002.002');
  assert.equal(bugNumber('4.003', 1), '4.003.001');
});

test('U24 U25 a bug with no numbered introducing task is B.NNN', () => {
  assert.equal(bugNumber(null, 1), 'B.001');
  assert.equal(bugNumber(null, 2), 'B.002');
  assert.equal(taskRefOf({ id: 'hand', title: 'Typed by hand' }).number, null, 'a hand-added task has no number to build on');
});

test('U26 a bug introduced by a bug appends another .NNN', () => {
  assert.equal(taskRefOf({ id: 'b', title: '4.002.001: First bug' }).number, '4.002.001');
  assert.equal(bugNumber('4.002.001', 1), '4.002.001.001');
  assert.equal(bugNumber(taskRefOf({ id: 'b', title: 'B.003: Standalone bug' }).number, 2), 'B.003.002');
});

test('U27 the 1000th bug is <number>.1000: no wrap and no truncation', () => {
  assert.equal(bugNumber('4.002', 1000), '4.002.1000');
  assert.equal(bugNumber(null, 12345), 'B.12345');
});

test('a bug title carries its number once, and a numbered title splits back into number and title', () => {
  assert.equal(bugTitle('4.002.001', 'Crash on save'), '4.002.001: Crash on save');
  assert.equal(bugTitle('4.002.001', '9.001: Crash on save'), '4.002.001: Crash on save', 'a number the title already carries is replaced');
  assert.deepEqual(splitNumberedTitle('4.002: Add login'), { number: '4.002', title: 'Add login' });
  assert.deepEqual(splitNumberedTitle('B.004: Odd crash'), { number: 'B.004', title: 'Odd crash' });
  assert.deepEqual(splitNumberedTitle('No number here: really'), { number: null, title: 'No number here: really' });
});

// ---- Dedupe ----

test('U29 the same suite, action and case match; a letter-case difference does not; a padded case id matches after trimming', () => {
  const ref = { suiteId: 'server', actionId: 'tests', caseId: 'adds numbers' };
  assert.equal(sameTestRef(ref, { ...ref }), true);
  assert.equal(sameTestRef({ ...ref, caseId: '  adds numbers ' }, ref), true);
  assert.equal(sameTestRef(ref, { ...ref, caseId: 'Adds numbers' }), false);
  assert.equal(sameTestRef(ref, { ...ref, suiteId: 'Server' }), false);
  assert.equal(sameTestRef(ref, { ...ref, actionId: 'lint' }), false);
  assert.equal(sameTestRef(null, ref), false);
});

test('U30 pending, developing, blocked, stopped and failed bugs are open; done or archived ones are not', () => {
  for (const status of ['pending', 'developing', 'blocked', 'stopped', 'failed'] as const) assert.equal(isOpenBug(record({ type: 'bug', status })), true, status);
  assert.equal(isOpenBug(record({ type: 'bug', status: 'done' })), false);
  assert.equal(isOpenBug(record({ type: 'bug', status: 'failed', archived: true })), false);
  assert.equal(isOpenBug(record({ status: 'pending' })), false, 'a task is never an open bug');
});

// ---- Grouping helpers ----

test('a ready bug is grouped by its introducing task, and a group orders positioned bugs first, then by creation', () => {
  const bug = (id: string, groupOrder: number | null, createdAt: string) => record({ id, type: 'bug', bug: { ...FULL_BUG, groupOrder }, createdAt });
  assert.equal(bugGroupId(bug('a', null, NOW)), 'intro');
  assert.equal(bugGroupId(record({ type: 'bug', bug: { ...FULL_BUG, introducedBy: null } })), null);
  assert.equal(isReadyBug(bug('a', null, NOW)), true);
  assert.equal(isReadyBug(record({ type: 'bug', status: 'developing' })), false);
  assert.equal(isReadyBug(record({ type: 'bug', archived: true })), false);
  const sorted = [bug('late', null, '2026-10-11T12:00:00.000Z'), bug('second', 1, NOW), bug('early', null, '2026-10-11T11:00:00.000Z'), bug('first', 0, NOW), bug('early-b', null, '2026-10-11T11:00:00.000Z')]
    .sort(compareBugGroupOrder).map((item) => item.id);
  assert.deepEqual(sorted, ['first', 'second', 'early', 'early-b', 'late']);
});

test('a session number links a task to its planning conversation and a bug to its report session', () => {
  assert.equal(linkedSessionNumber(record({ planningRef: { session: 3, task: 1 } })), 3);
  assert.equal(linkedSessionNumber(record({ type: 'bug', bug: FULL_BUG })), 7);
  assert.equal(linkedSessionNumber(record({ type: 'bug', bug: { ...FULL_BUG, reportSessionNumber: null } })), undefined);
  assert.equal(linkedSessionNumber(record()), undefined);
});

test('only a task that has started can have introduced a bug', () => {
  assert.equal(hasStarted(record()), false);
  assert.equal(hasStarted(record({ status: 'done' })), true);
  assert.equal(hasStarted(record({ taskIds: ['t1'] })), true);
  assert.equal(hasStarted(record({ workflowRunId: 'run-1' })), true);
});

// ---- Report session tasks (U1–U19) ----

test('U1 U12 a task draft trims title and description and keeps multi-line, emoji and right-to-left text', () => {
  assert.deepEqual(parseReportedTask({ title: '  Add a diagnostics view  ', description: '  Full brief\nline two  ' }), {
    title: 'Add a diagnostics view', description: 'Full brief\nline two', relatedBugId: null,
  });
  assert.equal(parseReportedTask({ title: '🚀 مرحبا', description: 'x' }).title, '🚀 مرحبا');
});

test('U2 U3 U4 a blank title is allowed with a description; a missing or blank description, or no body, is refused', () => {
  assert.equal(parseReportedTask({ title: '   ', description: 'Brief' }).title, '');
  assert.equal(parseReportedTask({ description: 'Brief' }).title, '');
  for (const body of [{ title: 'T' }, { title: 'T', description: '   ' }, undefined, 'text', [], null, {}]) {
    assert.throws(() => parseReportedTask(body), (error) => error instanceof BugValidationError && /description is required/.test(error.message));
  }
});

test('U5 U6 U7 U8 U33 limits: 200 characters of title and 20,000 of description are accepted, one more is refused', () => {
  assert.equal(parseReportedTask({ title: 't'.repeat(200), description: 'd'.repeat(20_000) }).description.length, 20_000);
  assert.throws(() => parseReportedTask({ title: 't'.repeat(201), description: 'x' }), BugValidationError);
  assert.throws(() => parseReportedTask({ title: 't', description: 'd'.repeat(20_001) }), BugValidationError);
});

test('U9 U10 non-text title or description is refused', () => {
  for (const value of [5, [], {}, true]) {
    assert.throws(() => parseReportedTask({ title: value, description: 'x' }), /title must be text/);
    assert.throws(() => parseReportedTask({ title: 't', description: value }), /description must be text/);
  }
});

test('U11 a numbered-looking title is kept exactly as typed', () => {
  assert.equal(parseReportedTask({ title: '4.002: Foo', description: 'x' }).title, '4.002: Foo');
});

test('U13 relatedBugId: absent or null is none, a padded id is trimmed, anything else is refused', () => {
  assert.equal(parseReportedTask({ description: 'x' }).relatedBugId, null);
  assert.equal(parseReportedTask({ description: 'x', relatedBugId: null }).relatedBugId, null);
  assert.equal(parseReportedTask({ description: 'x', relatedBugId: '  b1 ' }).relatedBugId, 'b1');
  for (const value of ['', '   ', 5, {}]) assert.throws(() => parseReportedTask({ description: 'x', relatedBugId: value }), /relatedBugId/);
});

test('U14 priority and unknown fields are ignored and not stored', () => {
  const draft = parseReportedTask({ title: 'T', description: 'x', priority: 'high', extra: 1 });
  assert.deepEqual(Object.keys(draft).sort(), ['description', 'relatedBugId', 'title']);
});

test('U15 U16 U17 the task patch needs a field; null clears the link, absent leaves it; a blank title or description is refused', () => {
  assert.throws(() => parseReportedTaskPatch({}), /at least one field/);
  assert.throws(() => parseReportedTaskPatch(undefined), /at least one field/);
  assert.throws(() => parseReportedTaskPatch({ priority: 'high' }), /at least one field/);
  assert.deepEqual(parseReportedTaskPatch({ relatedBugId: null }), { relatedBugId: null });
  assert.deepEqual(parseReportedTaskPatch({ title: ' New ' }), { title: 'New' });
  assert.deepEqual(parseReportedTaskPatch({ description: ' Brief ' }), { description: 'Brief' });
  assert.throws(() => parseReportedTaskPatch({ title: '  ' }), /title is required/);
  assert.throws(() => parseReportedTaskPatch({ description: '' }), /description is required/);
});

test('U18 readRelatedBug returns null for missing, mistyped, empty or non-object input and never throws', () => {
  for (const value of [undefined, null, 'x', 5, [], {}, { planItemId: '' }, { planItemId: 5 }]) assert.equal(readRelatedBug(value), null);
  assert.deepEqual(readRelatedBug({ planItemId: 'b', number: '  ', title: 'T' }), { planItemId: 'b', number: null, title: 'T' });
  const task = record({ relatedBug: 'junk' as never });
  assert.equal('relatedBug' in withPlanItemType(task), false);
  assert.deepEqual(withPlanItemType(record({ relatedBug: { planItemId: 'b', number: 'B.001', title: 'T' } })).relatedBug, { planItemId: 'b', number: 'B.001', title: 'T' });
});

test('U19 a task counts as started once it left pending, has runs, or has a workflow run', () => {
  assert.equal(hasStarted(record()), false);
  for (const status of ['developing', 'done', 'failed', 'stopped', 'blocked'] as const) assert.equal(hasStarted(record({ status })), true, status);
  assert.equal(hasStarted(record({ taskIds: ['t'] })), true);
  assert.equal(hasStarted(record({ workflowRunId: 'r' })), true);
});

test('a task filed by a report session belongs to that session', () => {
  assert.equal(linkedSessionNumber(record({ reportSessionNumber: 9 })), 9);
  assert.equal(linkedSessionNumber(record({ planningRef: { session: 3, task: 1 }, reportSessionNumber: 9 })), 3);
});
