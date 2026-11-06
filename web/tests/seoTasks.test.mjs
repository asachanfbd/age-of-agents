import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const t = await import('../src/lib/seoTasks.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const server = (file) => readFileSync(new URL(`../../server/src/${file}`, import.meta.url), 'utf8');

const task = (over = {}) => ({ id: 'a', source: 'manual', title: 'T', subKind: 'other', group: 'not-started', statusLabel: 'To do', statusNote: null, owner: 'me', dueDate: null, overdue: false, overdueDays: 0, priority: null, links: [], createdAt: '', updatedAt: '', runId: null, jobId: null, ...over });

test('C01/C04 the board has five columns in order, each with its tasks; kind badges and labels exist for every kind', () => {
  const cols = t.boardColumns([task({ id: '1', group: 'done' }), task({ id: '2', group: 'running' }), task({ id: '3', group: 'done' })]);
  assert.deepEqual(cols.map((c) => c.label), ['Not started', 'Running', 'Needs approval', 'Done', 'Failed / Blocked']);
  assert.deepEqual(cols.map((c) => c.tasks.length), [0, 1, 0, 2, 0]);
  assert.deepEqual(Object.keys(t.SOURCE_LABEL), ['manual', 'scheduled', 'agent']);
});

test('C02/C03 filters become query parameters, empty ones are left out, and hasFilters drives the Clear filters state', () => {
  assert.equal(t.listParams(t.NO_FILTERS).toString(), 'limit=200');
  const p = t.listParams({ ...t.NO_FILTERS, kind: 'agent', due: 'overdue', search: ' title ' });
  assert.equal(p.get('kind'), 'agent');
  assert.equal(p.get('due'), 'overdue');
  assert.equal(p.get('search'), 'title');
  assert.equal(p.has('owner'), false);
  assert.equal(t.hasFilters(t.NO_FILTERS), false);
  assert.equal(t.hasFilters({ ...t.NO_FILTERS, group: 'done' }), true);
});

test('C05 an overdue manual task reads "Overdue Nd"; other tasks never do', () => {
  assert.equal(t.overdueText({ overdue: true, overdueDays: 3 }), 'Overdue 3d');
  assert.equal(t.overdueText({ overdue: false, overdueDays: 0 }), null);
});

test('C08 the new task form needs a title, a real due date and http(s) evidence; the request nulls empty optional fields', () => {
  assert.match(t.draftError(t.EMPTY_DRAFT), /title/);
  assert.match(t.draftError({ ...t.EMPTY_DRAFT, title: 'x'.repeat(501) }), /500/);
  assert.match(t.draftError({ ...t.EMPTY_DRAFT, title: 'x', dueDate: '15/10/2026' }), /YYYY-MM-DD/);
  assert.match(t.draftError({ ...t.EMPTY_DRAFT, title: 'x', evidence: ['ftp://x'] }), /http/);
  assert.equal(t.draftError({ ...t.EMPTY_DRAFT, title: 'x', evidence: ['https://a.test'] }), null);
  const req = t.draftRequest({ ...t.EMPTY_DRAFT, title: ' Fix ' });
  assert.deepEqual([req.title, req.dueDate, req.priority, req.link], ['Fix', null, null, null]);
});

test('C09 the agent dialog needs 1 to 100 pages for the page slots and a crawl for the audit; five slots exist', () => {
  assert.equal(t.AGENT_SLOTS.length, 5);
  assert.match(t.agentRequestError('title-meta', [], true), /at least one page/);
  assert.match(t.agentRequestError('content', Array(101).fill('x'), true), /at most 100/);
  assert.equal(t.agentRequestError('title-meta', ['a'], false), null);
  assert.match(t.agentRequestError('audit', [], false), /crawl/);
  assert.equal(t.agentRequestError('audit', [], true), null);
  assert.equal(t.agentRequestError('research', [], false), null);
  assert.deepEqual(t.parsePages('https://a.test/x, https://a.test/y\nhttps://a.test/x'), ['https://a.test/x', 'https://a.test/y']);
});

test('C10/C11 schedule cards show the switch state and Run now is blocked while running; the new schedule form checks name, fetch and cron', () => {
  assert.equal(t.triggerLabel({ enabled: true, autoDisabled: false }), 'On');
  assert.equal(t.triggerLabel({ enabled: false, autoDisabled: false }), 'Paused');
  assert.equal(t.triggerLabel({ enabled: false, autoDisabled: true }), 'Turned off after failures');
  assert.equal(t.canRunNow({ last: { outcome: 'running' } }), false);
  assert.equal(t.canRunNow({ last: { outcome: 'succeeded' } }), true);
  assert.equal(t.canRunNow({ last: null }), true);
  assert.match(t.scheduleError('', 'sync', '0 6 * * *'), /name/);
  assert.match(t.scheduleError('n', '', '0 6 * * *'), /Choose/);
  assert.match(t.scheduleError('n', 'sync', '0 6 * *'), /five fields/);
  assert.equal(t.scheduleError('n', 'sync', t.CRON_PRESETS[0].cron), null);
  assert.equal(t.CRON_PRESETS.length, 4);
  const ui = src('ui/SeoSchedules.tsx');
  assert.doesNotMatch(ui, /report/i, 'no report option');
  assert.match(ui, /Next runs/);
});

test('C12 proposal review: counters, decisions, filters and the Approve rule', () => {
  assert.deepEqual([t.guidance('title', 'a'.repeat(29)).state, t.guidance('title', 'a'.repeat(30)).state, t.guidance('title', 'a'.repeat(61)).state, t.guidance('meta', '').state], ['short', 'good', 'long', 'empty']);
  assert.equal(t.guidance('title', '😀😀').count, 2);
  assert.equal(t.toggledDecision('pending', 'accepted'), 'accepted');
  assert.equal(t.toggledDecision('accepted', 'accepted'), 'pending');
  assert.equal(t.toggledDecision('accepted', 'rejected'), 'rejected');
  const rows = [{ id: '1', decision: 'accepted' }, { id: '2', decision: 'pending' }, { id: '3', decision: 'rejected' }];
  assert.deepEqual(t.filterProposal(rows, 'pending').map((r) => r.id), ['2']);
  assert.equal(t.filterProposal(rows, 'all').length, 3);
  assert.equal(t.approveSummary({ accepted: 0, rejected: 1, pending: 2, canApprove: false }).disabled, true);
  assert.equal(t.approveSummary({ accepted: 1, rejected: 0, pending: 2, canApprove: true }).text, '1 accepted. 2 pending will not be included.');
  assert.equal(t.effectiveTitle({ proposedTitle: 'A', editedTitle: 'B' }), 'B');
  assert.equal(t.effectiveMeta({ proposedMeta: 'A', editedMeta: null }), 'A');
});

test('C13 the handoff result shows linked, not linked and failed (Retry and the manual fallback)', () => {
  const base = { path: 'software', targetName: 'Site', sessionId: 's', sessionStatus: 'running', error: null, manualTaskId: null, followUpTaskId: null };
  assert.match(t.handoffView({ ...base, state: 'handed-off' }).title, /Planning session started in Site/);
  assert.match(t.handoffView({ ...base, state: 'handed-off', sessionStatus: 'unavailable' }).body, /unavailable/);
  assert.equal(t.handoffView({ ...base, path: 'manual', state: 'handed-off' }).title, 'Saved as a manual task');
  const failed = t.handoffView({ ...base, state: 'failed', error: 'busy' });
  assert.deepEqual([failed.tone, failed.body, failed.retry, failed.fallback], ['bad', 'busy', true, true]);
  assert.equal(t.handoffView({ ...base, state: 'failed', manualTaskId: 'm' }).fallback, false);
  assert.equal(t.handoffView({ ...base, state: 'awaiting-approval' }).tone, 'wait');
});

test('C14/C15 quick actions prefill the form for a lost backlink, an un-indexed page, a page, a keyword and a cluster', () => {
  const b = t.prefill.backlink({ uid: 'l1', sourceUrl: 'https://a.com/p', targetUrl: 'https://x.test/y', anchor: 'hi', status: 'lost' });
  assert.deepEqual([b.kind, b.link], ['link-building', { type: 'backlink', ref: 'l1' }]);
  const u = t.prefill.unindexedPage('https://x.test/new', 'Discovered, not indexed');
  assert.deepEqual([u.kind, u.link.type, u.notes], ['technical-fix', 'page', 'Discovered, not indexed']);
  assert.equal(t.prefill.page('https://x.test/a/b?c=1').title, 'Work on /a/b?c=1');
  assert.deepEqual(t.prefill.keyword('blue shoes').link, { type: 'keyword', ref: 'blue shoes' });
  assert.deepEqual(t.prefill.cluster('c1', 'Shoes').link, { type: 'cluster', ref: 'c1' });
  const backlinks = src('ui/SeoBacklinks.tsx');
  assert.match(backlinks, /const HAS_TASKS_PANEL = true;/);
  assert.match(backlinks, /prefill\.backlink\(link\)/);
});

test('C14/C16/C17 the Tasks tab replaces the placeholder, has both segments, related-task blocks on the drill-downs, and accessible rows and dialogs', () => {
  const ws = src('ui/SeoWorkspace.tsx');
  assert.match(ws, /tab === 'tasks' \? <SeoTasks project=\{project\} \/>/);
  const tasksUi = src('ui/SeoTasks.tsx');
  assert.match(tasksUi, /All tasks/);
  assert.match(tasksUi, /Schedules/);
  assert.match(tasksUi, /<button type="button" onClick=\{onOpen\}/, 'rows are buttons, so Enter opens the drawer');
  assert.match(src('ui/SeoTaskDialogs.tsx'), /<DialogContent aria-label="New task">/);
  for (const [file, type] of [['ui/SeoPages.tsx', 'page'], ['ui/SeoKeywords.tsx', 'keyword'], ['ui/SeoBacklinks.tsx', 'backlink']]) assert.match(src(file), new RegExp(`<RelatedTasks[^>]*type="${type}"`));
  assert.match(src('ui/SeoTasks.tsx'), /Yes, delete/);
  assert.match(src('ui/SeoTasks.tsx'), /Keep/);
});

test('C18 every task call the web client makes matches a route the daemon mounts', () => {
  const routes = [...server('api/seoTaskRoutes.ts').matchAll(/router\.(get|post|put|patch|delete)\(`\$\{base\}([^`]*)`/g)].map((m) => `${m[1].toUpperCase()} ${m[2].replace(/:\w+/g, ':p')}`);
  const api = src('lib/serverApi.ts');
  const calls = [...api.matchAll(/seo\/(tasks|agent-tasks|schedules)([^`?]*)[^`]*`(?:, \{ method: '(\w+)')?/g)]
    .map((m) => `${(m[3] ?? 'GET')} /${m[1]}${m[2].replace(/\$\{[^}]+\}/g, ':p')}`);
  assert.ok(calls.length >= 20, `found ${calls.length} client calls`);
  for (const call of new Set(calls)) assert.ok(routes.includes(call.replace(/(\/:p)+$/, (x) => x)), `no daemon route for ${call}`);
});

test('C19 task text is rendered as text, never as markup', () => {
  for (const file of ['ui/SeoTasks.tsx', 'ui/SeoTaskDialogs.tsx', 'ui/SeoProposalReview.tsx', 'ui/SeoSchedules.tsx', 'ui/SeoRelatedTasks.tsx']) assert.doesNotMatch(src(file), /dangerouslySetInnerHTML/);
});

test('C20 a failed load shows the error with Retry', () => {
  assert.match(src('ui/SeoTasks.tsx'), /role="alert"[^]*Retry/);
  assert.match(src('ui/SeoSchedules.tsx'), /Retry/);
});

test('C21 the global board link opens the run by its id', () => {
  assert.match(src('ui/SeoTasks.tsx'), /openWorkspaceCardDetail\(projectId, \{ kind: 'run', id: task\.runId!? \}\)/);
});

test('the seo.tasks_overdue notification kind is known to the web', () => {
  assert.match(src('lib/serverApi.ts'), /'seo\.tasks_overdue'/);
});
