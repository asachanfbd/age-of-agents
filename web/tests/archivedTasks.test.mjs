import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { buildArchivedRows, buildCompletedRows, bulkFailureMessage, hasArchivedItems } = await import('../src/lib/projectTasks.ts');
const { completedCardActions } = await import('../src/lib/taskBoard.ts');

// The Completed column's "Archive all" and the workspace's Archived tab. Row building and messages are
// tested against the pure helpers; the component wiring is pinned against source, as the other web tests do.
const read = (file) => readFile(new URL(`../src/ui/${file}`, import.meta.url), 'utf8');
const [modal, tasksPanel, archivedPanel, taskActions, dialogs, header, board] = await Promise.all([
  'ProjectWorkspaceModal.tsx',
  'project-popup/TasksPanel.tsx',
  'project-popup/ArchivedPanel.tsx',
  'project-popup/useTaskActions.ts',
  'project-popup/TaskDialogs.tsx',
  'project-popup/DetailHeader.tsx',
  'project-popup/TaskBoard.tsx',
].map(read));

const NOW = Date.parse('2026-09-27T12:00:00Z');
const item = (id, patch = {}) => ({
  id,
  projectId: 'p1',
  title: id,
  description: '',
  status: 'done',
  order: 0,
  taskIds: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  ...patch,
});

// ---- Archive all ----

test('the Completed column offers "Archive all" for every archivable card, and no bulk delete', () => {
  assert.match(tasksPanel, /const archivable = completedRows\.filter\(\(row\) => row\.canArchive\)\.map\(\(row\) => row\.id\);/);
  assert.match(tasksPanel, /disabled=\{archivable\.length === 0\} onClick=\{\(\) => setDialog\(\{ kind: 'archiveAll', ids: archivable \}\)\}/);
  assert.match(tasksPanel, /<Archive aria-hidden="true" \/> Archive all/);
  assert.doesNotMatch(tasksPanel, /Clear completed|Trash2|kind: 'delete'; ids|deletable/, 'the bulk delete and its dead code are gone');
});

test('Archive all asks first, in-app, stating the count, and archives only on confirm', () => {
  const dialog = tasksPanel.match(/\{dialog\?\.kind === 'archiveAll' && \([\s\S]*?\n {6}\)\}/)[0];
  assert.match(dialog, /<ConfirmDialog/);
  assert.match(dialog, /title=\{`Archive \$\{plural\(dialog\.ids\.length, 'completed task'\)\}\?`\}/);
  assert.match(dialog, /destructive=\{false\}/, 'archiving can be undone, so no destructive button');
  assert.match(dialog, /onCancel=\{\(\) => setDialog\(null\)\}/);
  assert.match(dialog, /onConfirm=\{\(\) => \{\s*const rowIds = dialog\.ids;\s*setDialog\(null\);\s*void actions\.archiveItems\(rowIds\);/);
  assert.doesNotMatch(tasksPanel + archivedPanel, /window\.confirm|[^.\w]confirm\(/, 'never the browser confirm()');
});

test('ConfirmDialog\'s confirm is destructive unless told otherwise', () => {
  assert.match(dialogs, /destructive = true,/);
  assert.match(dialogs, /variant=\{destructive \? 'destructive' : 'default'\} onClick=\{onConfirm\}/);
});

test('archiveItems patches each item {archived:true}, tries them all, and reports failures in one alert', () => {
  const body = taskActions.match(/archiveItems: \(ids: string\[\]\) => guard\(async \(\) => \{[\s\S]*?\n {4}\}\),/)[0];
  assert.match(body, /for \(const id of ids\) \{\s*try \{\s*await storeCall\('taskActions', \(\) => updatePlanItem\(project\.id, id, \{ archived: true \}\)\);\s*\} catch \(failure\) \{\s*failures\.push\(\(failure as Error\)\.message\);/);
  assert.match(body, /if \(failures\.length > 0\) throw new Error\(bulkFailureMessage\('archive', failures, ids\.length\)\);/);
});

test('bulkFailureMessage counts the failures out of the total and lists each distinct reason once', () => {
  assert.equal(bulkFailureMessage('archive', ['Busy', 'Busy', 'Gone'], 5), "Couldn't archive 3 of 5 tasks: Busy; Gone");
  assert.equal(bulkFailureMessage('archive', ['Busy'], 1), "Couldn't archive 1 of 1 task: Busy");
});

// ---- Archived rows ----

test('hasArchivedItems is true only when some plan item is archived', () => {
  assert.equal(hasArchivedItems([]), false);
  assert.equal(hasArchivedItems([item('a'), item('b', { archived: false })]), false);
  assert.equal(hasArchivedItems([item('a'), item('b', { archived: true })]), true);
});

test('buildArchivedRows lists every archived item, whatever its status, with unarchive instead of archive', () => {
  const items = [item('a', { archived: true }), item('b'), item('c', { archived: true, status: 'pending' }), item('d', { archived: true, status: 'blocked' })];
  const rows = buildArchivedRows({ items, tasksById: {}, now: NOW });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'c', 'd']);
  assert.deepEqual(rows.map((row) => [row.canArchive, row.canUnarchive]), [[false, true], [false, true], [false, true]]);
  assert.deepEqual(rows.map((row) => row.canDelete), [true, true, false], 'a pre-workflow blocked item can\'t be deleted (planItemActions)');
  assert.deepEqual(completedCardActions(rows[0]), ['unarchive', 'delete']);
  assert.deepEqual(buildArchivedRows({ items: [item('x')], tasksById: {}, now: NOW }), []);
});

test('archived task cards show only their actual non-idle status', () => {
  const states = ['pending', 'stopped', 'failed', 'done'];
  const rows = buildArchivedRows({ items: states.map((status) => item(status, { archived: true, status })), tasksById: {}, now: NOW });
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.statusBadge])), {
    pending: null, stopped: 'Stopped', failed: 'Failed', done: 'Completed',
  });
  assert.match(board, /status=\{row\.statusBadge\}/, 'ArchivedPanel uses the same card and renders that status');
  assert.doesNotMatch(board, /status=\{row\.failed \? 'Failed' : 'Completed'\}/);
});

test('buildArchivedRows orders newest-completed first, like the Completed column', () => {
  const items = [
    item('old', { archived: true, status: 'done', updatedAt: '2026-09-01T00:00:00.000Z' }),
    item('noTime', { archived: true, updatedAt: '' }),
    item('byRun', { archived: true, status: 'done', workflowRunId: 'r1', updatedAt: '2026-09-02T00:00:00.000Z' }),
    item('recent', { archived: true, status: 'done', updatedAt: '2026-09-10T00:00:00.000Z' }),
  ];
  const workflowRuns = [{ id: 'r1', status: 'completed', completedAt: '2026-09-05T00:00:00.000Z' }];
  assert.deepEqual(buildArchivedRows({ items, tasksById: {}, workflowRuns, now: NOW }).map((row) => row.id), ['recent', 'byRun', 'old', 'noTime']);
});

test('Completed rows still archive, never unarchive, and leave archived items out', () => {
  const rows = buildCompletedRows({ items: [item('a'), item('b', { archived: true })], taskIds: [], tasksById: {}, now: NOW });
  assert.deepEqual(rows.map((row) => [row.id, row.canArchive, row.canUnarchive]), [['a', true, false]]);
});

// ---- Archived tab ----

test('the Archived tab sits at the far right, listed only while the project has archived tasks', async () => {
  assert.match(modal, /const hasArchived = useWorldStore\(\(s\) => hasArchivedItems\(s\.planByProject\[projectId\]\?\.items \?\? \[\],/);
  assert.match(modal, /workspaceTabs\(project, \{ reading: prReading, hasArchived \}\)\}/);
  assert.match(await read('WorkspaceBody.tsx'), /archived: Archive,/);
  assert.match(modal, /archived: <ArchivedPanel project=\{project\} \/>,/);
});

test('the Archived tab falls back to Tasks once the last archived task goes away', () => {
  assert.match(modal, /if \(topTab === 'archived' && !hasArchived\) setTopTab\('tasks'\);/);
  assert.doesNotMatch(modal, /useEffect/, 'adjusted during render, not synced in an effect');
});

test('the Archived tab mixes planning and task cards in one ordered grid, with no drag and drop', () => {
  assert.match(archivedPanel, /buildArchivedRows\(\{ items, tasksById, workflowRuns: runs, now: nowMs \}\)/);
  assert.match(archivedPanel, /const archiveEntries = useMemo[\s\S]*planningRows\.map[\s\S]*rows\.map[\s\S]*\.sort\(/);
  assert.match(archivedPanel, /\{archiveEntries\.map[\s\S]*typeLabel=\{sessionTypeLabel\(entry\.row\.kind\)\}[\s\S]*<CompletedTaskCard key=\{entry\.id\}/);
  assert.doesNotMatch(archivedPanel, /dnd=|useBoardDnd|BoardColumnView/);
  assert.match(board, /dnd\?: CardDnd;[\s\S]*export function CompletedTaskCard[\s\S]*dnd\?: CardDnd;/, 'the card takes dnd optionally');
});

test('clicking an archived card opens the same detail the board would', () => {
  assert.match(archivedPanel, /onOpen: \(row: CompletedRow\) => detail\.show\(cardDetail\(row\)\),/);
  assert.match(archivedPanel, /<WorkflowRunView key=\{detail\.runId\} runId=\{detail\.runId\}/);
  assert.match(archivedPanel, /<TaskDetailsView key=\{detail\.taskId\} taskId=\{detail\.taskId\} historyIds=\{detail\.historyIds\}/);
  assert.match(archivedPanel, /<TaskItemDetailsView key=\{openedItem\.id\} item=\{openedItem\} status=\{ARCHIVED_STATUS\}/);
  assert.match(archivedPanel, /items\.find\(\(item\) => item\.id === detail\.itemId && item\.archived\)/, 'unarchived or deleted, the list comes back');
});

test('archived task actions remain in details after card menus are removed', () => {
  assert.match(archivedPanel, /onUnarchive: \(id: string\) => void actions\.unarchive\(id\),/);
  assert.match(taskActions, /unarchive: \(id: string\) => guard\(\(\) => storeCall\('taskActions', \(\) => updatePlanItem\(project\.id, id, \{ archived: false \}\)\)\),/);
  assert.match(archivedPanel, /onDelete: setDeleteId,/);
  assert.match(archivedPanel, /\{deleteId && \(\s*<ConfirmDialog\s+title="Delete this task\?"[\s\S]*?onConfirm=\{\(\) => \{\s*const id = deleteId;\s*setDeleteId\(null\);\s*void actions\.deleteItems\(\[id\]\);/);
  assert.doesNotMatch(board, /EllipsisVertical|DropdownMenu|CardMenu/);
  assert.match(header, /actions\.unarchive\(item\.id\)/);
});

test('an archived task\'s details offer Unarchive in place of Archive', () => {
  assert.match(header, /\{item\.archived \? \(\s*<Button[^>]*onClick=\{\(\) => void actions\.unarchive\(item\.id\)\.then\(\(ok\) => ok && onBack\(\)\)\}>\s*<ArchiveRestore aria-hidden="true" \/> Unarchive/);
});
