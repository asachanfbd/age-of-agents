import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const bugs = await import('../src/lib/bugs.ts');
const { buildOpenTaskRows, buildPlanningQueue, bugReportHistory, bugReportCountsLabel, planningTaskHistory, planningHistoryCountsLabel } = await import('../src/lib/projectTasks.ts');
const { buildPlanningTaskPanel } = await import('../src/lib/planningTaskPanel.ts');

// A bug report session's tasks and their link to the bug filed beside them. Pure view-model tests;
// how the line renders (truncation, strike-through, focus ring) is only checked as source wiring.

const AT = '2026-10-01T10:00:00.000Z';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const item = (id, patch = {}) => ({
  id, projectId: 'p1', title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [],
  executorId: null, createdAt: AT, updatedAt: AT, ...patch,
});
const bug = (id, patch = {}) => item(id, {
  type: 'bug', title: '10.010.003: Crash', bug: { severity: null, infoStatus: 'enough', introducedBy: null, reportSessionNumber: 7, groupOrder: null, ...patch.bug },
  ...patch.item,
});
const task = (id, relatedBugId, patch = {}) => item(id, {
  title: 'Add diagnostics view', reportSessionNumber: 7,
  ...(relatedBugId ? { relatedBug: { planItemId: relatedBugId, number: '10.010.003', title: 'Crash' } } : {}), ...patch,
});
const rows = (items) => buildOpenTaskRows({ items, tasksById: {}, showArchived: false, now: NOW });
const rowFor = (items, id) => rows(items).find((row) => row.id === id);

test('U24 a task shows "Related to <number>: title" as a link to its bug; a removed bug is plain, not clickable', () => {
  const linked = bugs.relatedLinks(task('t'), [bug('b'), task('t', 'b')]);
  assert.deepEqual(linked, []);
  const withLink = task('t', 'b');
  assert.deepEqual(bugs.relatedLinks(withLink, [bug('b'), withLink]), [{ prefix: 'Related to', text: '10.010.003: Crash', itemId: 'b' }]);
  assert.deepEqual(bugs.relatedLinks(withLink, [withLink]), [{ prefix: 'Related to', text: '10.010.003: Crash', itemId: null }]);
});

test('U25 a bug lists the tasks pointing at it: none, one, many; archived and deleted tasks drop out', () => {
  const b = bug('b');
  assert.deepEqual(bugs.relatedLinks(b, [b]), []);
  assert.deepEqual(bugs.relatedLinks(b, [b, task('t1', 'b')]), [{ prefix: 'Related task', text: 'Add diagnostics view', itemId: 't1' }]);
  assert.equal(bugs.relatedLinks(b, [b, task('t1', 'b'), task('t2', 'b', { title: 'Second' })]).length, 2);
  assert.deepEqual(bugs.relatedLinks(b, [b, task('t1', 'b', { archived: true })]), []);
});

test('U26 legacy items without relatedBug, and unreadable values, read as no link', () => {
  const plain = item('plain');
  assert.deepEqual(bugs.relatedLinks(plain, [plain]), []);
  assert.deepEqual(bugs.relatedLinks({ ...plain, relatedBug: 'junk' }, [plain]), []);
  assert.equal(bugs.readRelatedBug(undefined), null);
  assert.equal(bugs.readRelatedBug({ planItemId: '' }), null);
  assert.deepEqual(bugs.readRelatedBug({ planItemId: 'b', number: ' ', title: 3 }), { planItemId: 'b', number: null, title: '' });
});

test('C1 C2 C3 C4 C5 the board rows carry the link on both cards, none without a link, and a session-made task is an ordinary Unstarted task', () => {
  const items = [bug('b'), task('t1', 'b'), task('t2', 'b', { title: 'Second' }), task('free')];
  assert.deepEqual(rowFor(items, 't1').related, [{ prefix: 'Related to', text: '10.010.003: Crash', itemId: 'b' }]);
  assert.equal(rowFor(items, 'b').related.length, 2);
  assert.equal(rowFor(items, 'free').related, undefined);
  assert.equal(rowFor(items, 't1').state, 'todo');
  assert.equal(rowFor(items, 't1').typeLabel, undefined);
  assert.equal(rowFor([task('t1', 'gone')], 't1').related[0].itemId, null);
  assert.equal(rowFor([bug('b')], 'b').related, undefined);
});

test('C9 C10 the link is a button with the other item\'s text and truncates with a tooltip', async () => {
  const parts = await readFile(new URL('../src/ui/project-popup/BugCardParts.tsx', import.meta.url), 'utf8');
  assert.match(parts, /export function RelatedLine/);
  assert.match(parts, /<button type="button"[^>]*onClick=\{\(\) => onOpenItem\(itemId\)\}/);
  assert.match(parts, /className="truncate[^"]*"[^>]*title=\{`\$\{link\.prefix\} \$\{link\.text\}`\}/);
  assert.match(parts, /line-through/);
  const board = await readFile(new URL('../src/ui/project-popup/TaskBoard.tsx', import.meta.url), 'utf8');
  assert.match(board, /<RelatedLine/);
  assert.match(board, /related=\{row\.related\}/);
});

test('U27 the session card line counts bugs and tasks', () => {
  const line = (patch) => bugs.bugReportCardLine({ cliNotStarted: false, readyCount: 0, filedCount: 1, ...patch });
  assert.equal(line({ cliNotStarted: true }), 'Waiting for a coding agent');
  assert.equal(line({ filedCount: 0 }), 'No bugs filed yet');
  assert.equal(line({ readyCount: 2, readyTaskCount: 0 }), '2 bugs ready · shown under their introducing tasks');
  assert.equal(line({ readyCount: 2 }), '2 bugs ready · shown under their introducing tasks');
  assert.equal(line({ readyCount: 2, readyTaskCount: 1, filedCount: 3 }), '2 bugs ready, 1 task filed · bugs shown under their introducing tasks');
  assert.equal(line({ readyCount: 1, readyTaskCount: 2, filedCount: 3 }), '1 bug ready, 2 tasks filed · bugs shown under their introducing tasks');
  assert.equal(line({ readyCount: 0, readyTaskCount: 1 }), '1 task filed');
});

test('U28 the linked items of a session are its bugs and tasks only; no session number lists none', () => {
  const items = [bug('b'), task('t'), task('other', null, { reportSessionNumber: 8 }), item('manual'), bug('b2', { bug: { reportSessionNumber: 8 } })];
  assert.deepEqual(bugs.bugReportLinkedItems(items, 7).map((entry) => entry.id), ['b', 't']);
  assert.deepEqual(bugs.bugReportLinkedItems(items, null), []);
});

test('C7 the Planning queue counts a report session\'s ready bugs and tasks separately', () => {
  const sessionTask = {
    id: 's', projectId: 'p1', executorId: 'exec-claude', executionMode: 'terminal', description: 'Session', status: 'stopped', autonomy: 'auto',
    kind: 'plan', planningPurpose: 'bug-report', planItemId: null, sessionId: 'x', blockedQuestion: null, failureReason: null,
    createdAt: AT, updatedAt: AT, completedAt: null, planningSessionNumber: 7, planningCreatedTaskCount: 3,
  };
  const queue = buildPlanningQueue({ items: [bug('b'), bug('b2'), task('t')], taskIds: ['s'], tasksById: { s: sessionTask }, now: NOW });
  const entry = queue.find((candidate) => candidate.kind === 'session').session;
  assert.equal(entry.readyBugCount, 2);
  assert.equal(entry.readyTaskCount, 1);
  assert.deepEqual(entry.ready, []);
});

test('U29 C8 the session panel lists bugs and tasks with links, a "Started – locked" label once started, and no priority', () => {
  const items = [bug('b'), task('t', 'b'), task('s', null, { status: 'developing', title: 'Started one' })];
  const panel = buildPlanningTaskPanel({ items, tasksById: {}, sessionNumber: 7, createdTaskCount: 3, kind: 'bug-report' });
  const byId = Object.fromEntries(panel.rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.t.related, [{ prefix: 'Related to', text: '10.010.003: Crash', itemId: 'b' }]);
  assert.equal(byId.t.lockedLabel, undefined);
  assert.equal(byId.s.lockedLabel, 'Started – locked');
  assert.equal(byId.b.related.length, 1);
  assert.ok(panel.rows.every((row) => !('priority' in row)));
  assert.match(panel.countsLabel, /^2 items ready · 1 started/);
});

test('U30 planning-session counts and labels are unchanged', () => {
  const planned = item('p', { planningRef: { session: 2, task: 1 }, title: '2.001: Plan' });
  assert.equal(planningHistoryCountsLabel(planningTaskHistory([planned], 2, 1)), '1 task ready');
  assert.equal(bugReportCountsLabel(bugReportHistory([bug('b')], 7, 1)), '1 bug ready');
});
