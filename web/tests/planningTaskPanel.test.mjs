import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  DEFAULT_TASK_PANEL_ARRANGEMENT, TASK_PANEL_BREAKPOINT_PX, sessionPanelWording, buildPlanningTaskPanel, detailBackTarget, taskPanelLayout, toggleTaskPanelArrangement, isRowExpanded, planningRowDetail, planningSessionTaskRows, showsTaskPanel, toggleExpanded,
} = await import('../src/lib/planningTaskPanel.ts');
const { comparePlanningGroupOrder, planningHistoryCountsLabel, planningTaskHistory } = await import('../src/lib/projectTasks.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

// The planning session view's task panel. Rows, badges, counts, the breakpoint and expansion are
// tested against the pure helpers in lib/planningTaskPanel.ts; live updates and Start go through the
// store against the server stub; the component wiring is pinned against its source.
const SESSION = 3;
const AT = '2026-09-21T12:00:00.000Z';

const item = (id, patch = {}) => ({
  id, projectId: 'p1', title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [],
  executorId: null, createdAt: AT, updatedAt: AT, ...patch,
});
/** A task the session created: `3.00<n>: Task <n>`. */
const linked = (n, patch = {}) => item(`t${n}`, { title: `${SESSION}.00${n}: Task ${n}`, planningRef: { session: SESSION, task: n }, ...patch });
const task = (id, patch = {}) => ({
  id, projectId: 'p1', executorId: 'exec-claude', executionMode: 'terminal', description: id, status: 'done', kind: 'execute',
  planItemId: null, sessionId: 'sess', createdAt: AT, updatedAt: AT, completedAt: AT, ...patch,
});
const rowsOf = (items, tasksById = {}, session = SESSION) => planningSessionTaskRows(items, tasksById, session);
const idsOf = (rows) => rows.map((row) => row.id);
const badgeOf = (planItem, tasksById = {}) => rowsOf([planItem], tasksById)[0].badge;

// ---- Unit: row derivation ----

test('U1 rows include ready, started and completed tasks', () => {
  const statuses = ['pending', 'developing', 'blocked', 'stopped', 'failed', 'done'];
  const rows = rowsOf(statuses.map((status, index) => linked(index + 1, { status })));
  assert.deepEqual(rows.map((row) => row.category), ['ready', 'started', 'started', 'started', 'started', 'completed']);
});

test('U2 an archived done task is listed as completed', () => {
  const [row] = rowsOf([linked(1, { status: 'done', archived: true })]);
  assert.equal(row.category, 'completed');
});

test('U3 archived tasks that are not done are left out', () => {
  const archived = ['pending', 'stopped', 'failed', 'blocked'].map((status, index) => linked(index + 1, { status, archived: true }));
  assert.deepEqual(rowsOf(archived), []);
});

test('U4 tasks of another session and hand-added tasks are left out', () => {
  const other = item('other', { planningRef: { session: 4, task: 1 } });
  assert.deepEqual(idsOf(rowsOf([linked(1), other, item('manual')])), ['t1']);
});

test('U5 a session with no number has no rows', () => {
  assert.deepEqual(rowsOf([linked(1)], {}, null), []);
});

test('U6 rows are ordered by creation number whatever the input order', () => {
  assert.deepEqual(idsOf(rowsOf([linked(3), linked(1), linked(2)])), ['t1', 't2', 't3']);
});

test('U7 board reordering does not change the panel order', () => {
  const items = [linked(1, { planningGroupOrder: 2 }), linked(2, { planningGroupOrder: 1 }), linked(3, { planningGroupOrder: 0 })];
  assert.deepEqual(items.slice().sort(comparePlanningGroupOrder).map((entry) => entry.id), ['t3', 't2', 't1']);
  assert.deepEqual(idsOf(rowsOf(items)), ['t1', 't2', 't3']);
});

test('U8 the order stays the same while a task goes pending, developing, done', () => {
  for (const status of ['pending', 'developing', 'done']) {
    assert.deepEqual(idsOf(rowsOf([linked(1), linked(2, { status }), linked(3)])), ['t1', 't2', 't3'], status);
  }
});

test('U9 a new task joins the end and earlier rows keep their place', () => {
  const before = idsOf(rowsOf([linked(1), linked(2)]));
  const after = idsOf(rowsOf([linked(4), linked(1), linked(2)]));
  assert.deepEqual(after, [...before, 't4']);
});

test('U10 two tasks with the same creation number are ordered by id, every time', () => {
  const twins = [item('b', { planningRef: { session: SESSION, task: 1 } }), item('a', { planningRef: { session: SESSION, task: 1 } })];
  assert.deepEqual(idsOf(rowsOf(twins)), ['a', 'b']);
  assert.deepEqual(idsOf(rowsOf(twins.slice().reverse())), ['a', 'b']);
});

test('U11 a numbered title is split into its number and name', () => {
  const [row] = rowsOf([linked(2, { title: '3.002: Add login' })]);
  assert.deepEqual([row.number, row.title], ['3.002', 'Add login']);
  assert.equal(row.fullTitle, '3.002: Add login', 'the Start task dialog names the task as the board does');
});

test('U12 a title with no number shows the title only', () => {
  const [row] = rowsOf([linked(1, { title: 'Legacy task' })]);
  assert.deepEqual([row.number, row.title], [null, 'Legacy task']);
});

test('U13 a ready row carries the full description unchanged', () => {
  const description = `# Spec\n\nline two\n${'x'.repeat(400)}`;
  assert.equal(rowsOf([linked(1, { description })])[0].description, description);
});

// ---- Unit: status badges ----

test('U14 a ready task reads Ready on the outline badge', () => {
  assert.deepEqual(badgeOf(linked(1)), { label: 'Ready', variant: 'outline' });
});

test('U15 a developing task reads Running', () => {
  assert.deepEqual(badgeOf(linked(1, { status: 'developing' })), { label: 'Running', variant: 'success' });
});

test('U16 a blocked task reads Needs you', () => {
  assert.deepEqual(badgeOf(linked(1, { status: 'blocked' })), { label: 'Needs you', variant: 'warning' });
});

test('U17 a developing task whose terminal waits for input reads Needs you', () => {
  const waiting = task('run1', { status: 'developing', runtimeStatus: 'waiting_input' });
  assert.deepEqual(badgeOf(linked(1, { status: 'developing', taskIds: ['run1'] }), { run1: waiting }), { label: 'Needs you', variant: 'warning' });
});

test('U18 a stopped task reads Stopped, resumable or not', () => {
  const stopped = { label: 'Stopped', variant: 'secondary' };
  assert.deepEqual(badgeOf(linked(1, { status: 'stopped' })), stopped);
  assert.deepEqual(badgeOf(linked(1, { status: 'stopped', taskIds: ['run1'] }), { run1: task('run1', { status: 'stopped' }) }), stopped);
});

test('U19 a failed task reads Failed', () => {
  assert.deepEqual(badgeOf(linked(1, { status: 'failed' })), { label: 'Failed', variant: 'soft-destructive' });
});

test('U20 a done task reads Completed, archived or not', () => {
  const completed = { label: 'Completed', variant: 'success' };
  assert.deepEqual(badgeOf(linked(1, { status: 'done' })), completed);
  assert.deepEqual(badgeOf(linked(1, { status: 'done', archived: true })), completed);
});

test('U21 every badge label is one of the board\'s words or Ready', () => {
  const allowed = new Set(['Ready', 'Running', 'Needs you', 'Failed', 'Stopped', 'Completed']);
  const rows = rowsOf(['pending', 'developing', 'blocked', 'stopped', 'failed', 'done'].map((status, index) => linked(index + 1, { status })));
  for (const row of rows) assert.ok(allowed.has(row.badge.label), row.badge.label);
});

// ---- Unit: counts, empty state, click target ----

const ALL_CATEGORIES = [linked(1), linked(2, { status: 'developing' }), linked(3, { status: 'done' }), linked(4, { archived: true }), linked(5, { status: 'done', archived: true })];

test('U22 the panel counts are the history strip\'s counts', () => {
  const history = planningTaskHistory(ALL_CATEGORIES, SESSION, 7);
  assert.deepEqual([history.ready.length, history.startedCount, history.completedCount, history.archivedCount, history.removedCount], [1, 1, 2, 1, 2]);
  const panel = buildPlanningTaskPanel({ items: ALL_CATEGORIES, tasksById: {}, sessionNumber: SESSION, createdTaskCount: 7 });
  assert.equal(panel.countsLabel, planningHistoryCountsLabel(history));
  assert.equal(panel.countsLabel, '1 task ready · 1 started · 2 completed · 1 archived · 2 removed');
});

test('U23 the counts label always shows ready and leaves out empty categories', () => {
  const label = (items, created = items.length) => planningHistoryCountsLabel(planningTaskHistory(items, SESSION, created));
  assert.equal(label([]), '0 tasks ready');
  assert.equal(label([linked(1)]), '1 task ready');
  assert.equal(label([linked(1), linked(2)]), '2 tasks ready');
  assert.equal(label([linked(1), linked(2, { status: 'failed' })], 3), '1 task ready · 1 started · 1 removed');
});

test('U24 the removed count is never negative', () => {
  assert.equal(planningTaskHistory([linked(1), linked(2)], SESSION, 1).removedCount, 0);
});

test('U25 a session that created nothing shows the empty state', () => {
  const panel = buildPlanningTaskPanel({ items: [item('manual')], tasksById: {}, sessionNumber: SESSION, createdTaskCount: 0 });
  assert.deepEqual([panel.rows, panel.empty, panel.countsLabel], [[], true, '0 tasks ready']);
  assert.equal(buildPlanningTaskPanel({ items: [linked(1)], tasksById: {}, sessionNumber: SESSION, createdTaskCount: 1 }).empty, false);
});

test('U26 a ready row expands; started and completed rows open', () => {
  const rows = rowsOf([linked(1), linked(2, { status: 'stopped' }), linked(3, { status: 'done' })]);
  assert.deepEqual(rows.map((row) => row.action), ['expand', 'open', 'open']);
});

test('U27 a row opens what its board card would', () => {
  const tasksById = { run1: task('run1') };
  const detail = (planItem) => planningRowDetail([planItem], tasksById, planItem.id);
  assert.deepEqual(detail(linked(1, { status: 'developing', workflowRunId: 'wf1', taskIds: ['run1'] })), { kind: 'run', id: 'wf1' });
  assert.deepEqual(detail(linked(2, { status: 'developing', taskIds: ['run1'] })), { kind: 'task', id: 'run1' });
  assert.deepEqual(detail(linked(3, { status: 'done', workflowRunId: 'wf2' })), { kind: 'run', id: 'wf2' });
  assert.deepEqual(detail(linked(4, { status: 'done' })), { kind: 'item', id: 't4' });
});

test('U28 a row whose task is gone opens nothing', () => {
  assert.equal(planningRowDetail([linked(1)], {}, 'deleted'), null);
});

test('Back from a viewer returns to the planning session that opened it while its Task exists', () => {
  const tasksById = { live: task('live', { kind: 'plan' }), archived: task('archived', { kind: 'plan', archived: true }) };
  assert.deepEqual(detailBackTarget('live', tasksById), { kind: 'task', id: 'live' });
  assert.deepEqual(detailBackTarget('archived', tasksById), { kind: 'task', id: 'archived' }, 'starting its last ready task archives the session');
  assert.equal(detailBackTarget('deleted', tasksById), null, 'a deleted session falls back to the board');
  assert.equal(detailBackTarget(null, tasksById), null, 'a detail opened from the board goes back to the board');
});

// ---- Unit: breakpoint and expansion ----

test('U29 the panel shows only strictly above 1200px', () => {
  assert.equal(TASK_PANEL_BREAKPOINT_PX, 1200);
  assert.deepEqual([0, 1200, 1200.5, 1201].map(showsTaskPanel), [false, false, true, true]);
});

test('U30 toggling expands and collapses without mutating; only ready rows read as expanded', () => {
  const none = new Set();
  const one = toggleExpanded(none, 't1');
  const two = toggleExpanded(one, 't2');
  assert.deepEqual([[...none], [...one], [...two], [...toggleExpanded(two, 't1')]], [[], ['t1'], ['t1', 't2'], ['t2']]);
  const [ready, started] = rowsOf([linked(1), linked(2, { status: 'developing' })]);
  assert.equal(isRowExpanded(two, ready), true);
  assert.equal(isRowExpanded(two, started), false, 'a row started elsewhere no longer expands');
  assert.equal(isRowExpanded(none, ready), false);
});

// ---- Integration: the store, fed by the server stub and the daemon's live events ----

let project;

async function setUp() {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], tasksById: {}, taskIdsByProject: {}, planByProject: {}, ...CLEAN_ERROR_STATE });
  await useWorldStore.getState().addProject('Planned');
  project = useWorldStore.getState().projects.at(-1);
  await useWorldStore.getState().loadPlan(project.id);
  return stub;
}

/** The daemon saving a session-created task and broadcasting it. */
function serverSave(stub, n, patch = {}) {
  const existing = stub.planItems.get(`t${n}`);
  const saved = { ...(existing ?? { ...linked(n), projectId: project.id, order: n, milestoneId: null }), ...patch, updatedAt: new Date().toISOString() };
  stub.planItems.set(saved.id, saved);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...saved } }));
  return saved;
}

function serverDelete(stub, n) {
  stub.planItems.delete(`t${n}`);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItemDeleted', id: `t${n}`, projectId: project.id }));
}

const livePanel = (createdTaskCount) => {
  const state = useWorldStore.getState();
  return buildPlanningTaskPanel({ items: state.planByProject[project.id].items, tasksById: state.tasksById, sessionNumber: SESSION, createdTaskCount });
};
const liveRows = () => livePanel(0).rows.map((row) => `${row.id}:${row.badge.label}`);

/** Records every request the web app makes from here on. */
function recordRequests() {
  const requests = [];
  const stubbed = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${new URL(String(input), 'http://localhost').pathname}`);
    return stubbed(input, init);
  };
  return requests;
}

test('I1 a task the session creates joins the end of the panel live', async () => {
  const stub = await setUp();
  assert.equal(livePanel(0).empty, true);
  serverSave(stub, 1);
  serverSave(stub, 2);
  assert.deepEqual(liveRows(), ['t1:Ready', 't2:Ready']);
});

test('I2 a task started elsewhere turns Running in place', async () => {
  const stub = await setUp();
  [1, 2, 3].forEach((n) => serverSave(stub, n));
  serverSave(stub, 2, { status: 'developing' });
  assert.deepEqual(liveRows(), ['t1:Ready', 't2:Running', 't3:Ready']);
});

test('I3 a task completed elsewhere turns Completed in place and moves between counts', async () => {
  const stub = await setUp();
  [1, 2].forEach((n) => serverSave(stub, n));
  serverSave(stub, 1, { status: 'developing' });
  assert.equal(livePanel(2).countsLabel, '1 task ready · 1 started');
  serverSave(stub, 1, { status: 'done' });
  assert.deepEqual(liveRows(), ['t1:Completed', 't2:Ready']);
  assert.equal(livePanel(2).countsLabel, '1 task ready · 1 completed');
});

test('I4 a deleted task leaves the panel and counts as removed', async () => {
  const stub = await setUp();
  [1, 2].forEach((n) => serverSave(stub, n));
  serverDelete(stub, 1);
  assert.deepEqual(liveRows(), ['t2:Ready']);
  assert.equal(livePanel(2).countsLabel, '1 task ready · 1 removed');
});

test('I5 archiving a ready task removes its row and counts it as archived', async () => {
  const stub = await setUp();
  [1, 2].forEach((n) => serverSave(stub, n));
  assert.equal(await useWorldStore.getState().updatePlanItem(project.id, 't1', { archived: true }), true);
  assert.deepEqual(liveRows(), ['t2:Ready']);
  assert.equal(livePanel(2).countsLabel, '1 task ready · 1 archived');
});

test('I6 archiving a done task keeps its Completed row', async () => {
  const stub = await setUp();
  serverSave(stub, 1, { status: 'done' });
  assert.equal(await useWorldStore.getState().updatePlanItem(project.id, 't1', { archived: true }), true);
  assert.deepEqual(liveRows(), ['t1:Completed']);
});

test('I7 an accepted start sends the dialog\'s options and the row turns started in place', async () => {
  const stub = await setUp();
  stub.projects.get(project.id).repositoryUrl = 'https://example.test/repo.git';
  [1, 2, 3].forEach((n) => serverSave(stub, n));
  const options = { executorId: 'test-claude', workflowId: 'software-development', createBranch: true, skippedStepIds: ['ui'] };

  await useWorldStore.getState().executePlanItem('t2', options);
  serverSave(stub, 2, { status: 'developing' });

  assert.deepEqual(stub.executeRequests, [{ planItemId: 't2', ...options }]);
  assert.deepEqual(liveRows(), ['t1:Ready', 't2:Running', 't3:Ready']);
});

test('I8 a refused start rejects with the server\'s reason and the row stays Ready in place', async () => {
  const stub = await setUp();
  [1, 2].forEach((n) => serverSave(stub, n));

  await assert.rejects(useWorldStore.getState().executePlanItem('t1', { executorId: 'test-claude', createBranch: true }), /no linked repository/);

  assert.equal(useWorldStore.getState().planByProject[project.id].items.find((entry) => entry.id === 't1').status, 'pending');
  assert.deepEqual(liveRows(), ['t1:Ready', 't2:Ready']);
});

test('I9 a start runs the task directly: one execute request and nothing queued', async () => {
  const stub = await setUp();
  serverSave(stub, 1);
  const requests = recordRequests();

  await useWorldStore.getState().executePlanItem('t1', { executorId: 'test-claude', createBranch: false });

  assert.deepEqual(requests.filter((request) => request.startsWith('POST')), ['POST /api/plan-items/t1/execute']);
  assert.deepEqual(requests.filter((request) => /queue/i.test(request)), []);
});

// ---- Component: wiring, pinned against source ----

const readSource = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
const [sessionSource, panelSource, tasksPanel, runView, viewportHook, panelStateHook, workspaceModal] = await Promise.all([
  'ui/project-popup/TaskDetailsView.tsx', 'ui/project-popup/PlanningTaskPanel.tsx', 'ui/project-popup/TasksPanel.tsx',
  'ui/project-popup/WorkflowRunView.tsx', 'lib/useWideViewport.ts', 'ui/project-popup/useSessionTaskPanelState.ts',
  'ui/ProjectWorkspaceModal.tsx',
].map(readSource));
const sessionView = sessionSource.slice(sessionSource.indexOf('export function TaskDetailsView'), sessionSource.indexOf('function PlanningHistory'));
const panelRow = panelSource.slice(panelSource.indexOf('function PanelRow'));

test('C1 only a planning session shows the panel', () => {
  assert.match(sessionView, /const planning = task\?\.kind === 'plan';/);
  assert.match(sessionView, /const showTaskPanel = planning && wideViewport && !!sessionTasks && !!taskPanelSwap;/);
  assert.doesNotMatch(runView, /PlanningTaskPanel|sessionTasks/);
});

test('C2 the panel renders only on a wide viewport', () => {
  assert.match(sessionView, /const wideViewport = useWideViewport\(\);/);
  assert.match(sessionView, /\{showTaskPanel && \(\s*<PlanningTaskPanel /);
});

test('C3 the history strip shows whenever the panel does not, unchanged', () => {
  assert.match(sessionView, /\{planning && !showTaskPanel && <PlanningHistory task=\{task\} \/>\}/);
  assert.match(sessionSource, /<section aria-label=\{heading\}/);
  assert.match(sessionSource, /history\.ready\.map\(\(item\) => <li key=\{item\.id\}>\{item\.title\}<\/li>\)/);
});

test('C4 the breakpoint is live and uses the tested predicate', () => {
  assert.match(viewportHook, /window\.addEventListener\('resize', onChange\);\s*return \(\) => window\.removeEventListener\('resize', onChange\);/);
  assert.match(viewportHook, /useSyncExternalStore\(subscribe, \(\) => showsTaskPanel\(window\.innerWidth\)\)/);
});

test('C5 the CLI is never remounted by the breakpoint', () => {
  assert.equal(sessionView.match(/<TaskSessionBody /g).length, 1);
  assert.match(sessionView, /<div className=\{`relative flex min-h-0 min-w-0 \$\{layout\.cliClass\} flex-col`\}>\s*\{\/\*[^*]*\*\/\}\s*\{task\?\.cliNotStarted \? <DeferredSessionForm key=\{task\.id\} task=\{task\} actions=\{actions\} \/> : <TaskSessionBody taskId=\{taskId\} historyIds=\{historyIds\} controls=\{controls\} \/>\}/);
  assert.doesNotMatch(sessionView, /key=\{[^}]*(wideViewport|showTaskPanel)/);
});

test('C6 the CLI and panel share one row at 7:3 and the panel scrolls on its own', () => {
  assert.match(sessionView, /<div className="flex min-h-0 flex-1">\s*\{\/\*[^*]*\*\/\}\s*<div className=\{`relative flex min-h-0 min-w-0 \$\{layout\.cliClass\} flex-col`\}>/);
  assert.match(panelSource, /<aside aria-label=\{wording\.heading\} className=\{`flex min-h-0 min-w-0 \$\{layout\.panelClass\} flex-col border-l`\}>/);
  assert.match(panelSource, /className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"/);
});

test('C7 the panel reads only what the store already holds', () => {
  assert.match(panelSource, /useWorldStore\(\(s\) => s\.planByProject\[task\.projectId\]\?\.items\)/);
  assert.match(panelSource, /useWorldStore\(\(s\) => s\.tasksById\)/);
  assert.doesNotMatch(panelSource, /serverApi|fetch\(/);
});

test('C8 each row is a native button', () => {
  assert.match(panelRow, /<li className="border-b">\s*<button\s+type="button"/);
});

test('C9 only a ready row exposes aria-expanded', () => {
  assert.match(panelSource, /const STICKY_ROW = 'sticky top-0 z-10 bg-background hover:bg-muted';/, 'an opaque header over the scrolling description, hovered or not');
  assert.match(panelRow, /\$\{expanded \? STICKY_ROW : 'hover:bg-muted\/50'\}/);
  assert.match(panelRow, /const expandable = row\.action === 'expand';/);
  assert.match(panelRow, /aria-expanded=\{expandable \? expanded : undefined\}/);
});

test('C10 rows start collapsed, in the session view\'s own state', () => {
  assert.match(panelStateHook, /useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/);
  assert.match(panelStateHook, /const onToggle = useCallback\(\(id: string\) => setExpanded\(\(current\) => toggleExpanded\(current, id\)\), \[\]\);/);
  assert.match(panelStateHook, /const readScrollTop = useCallback\(\(\) => scrollTop\.current, \[\]\);/, 'stable, so scroll is restored only on mount');
  assert.match(panelStateHook, /const saveScrollTop = useCallback\(\(next: number\) => \{ scrollTop\.current = next; \}, \[\]\);/);
  assert.match(sessionView, /const taskPanelState = useSessionTaskPanelState\(\);/);
  assert.doesNotMatch(panelStateHook + panelSource, /localStorage|useWorldStore\.setState/);
});

test('C11 an expanded row shows the description and Start beside the row button', () => {
  assert.match(panelRow, /<\/button>\s*\{expanded && \(/);
  assert.match(panelRow, /<TaskSpecification description=\{row\.description\} \/>/);
  assert.match(panelRow, /<Button type="button" size="sm" onClick=\{onStart\}>\s*<Play aria-hidden="true" \/> Start/);
});

test('C12 Start exists only inside an expanded ready row', () => {
  assert.match(panelSource, /onStart=\{\(\) => handlers\.onStart\(\{ id: row\.id, title: row\.fullTitle \}\)\}/);
  assert.equal(panelSource.match(/onClick=\{onStart\}/g).length, 1);
  assert.match(panelSource, /expanded=\{isRowExpanded\(state\.expanded, row\)\}/);
});

test('C13 Start opens the board\'s own Start task dialog', () => {
  assert.match(tasksPanel, /sessionTasks=\{\{ onStart: \(row\) => setDialog\(\{ kind: 'start', row \}\)/);
  assert.equal(tasksPanel.match(/<StartTaskDialog/g).length, 1);
  assert.match(tasksPanel, /workflows=\{workflows\}\s*\{\.\.\.startDialogChoice\(dialog\.row\.id\)\}\s*hasRepository=\{!!project\.repositoryUrl\}\s*slotsInUse=\{[^}]*\}\s*initialAutoMerge=\{items\.find/);
});

const startDialog = tasksPanel.slice(tasksPanel.indexOf('<StartTaskDialog'), tasksPanel.indexOf("dialog?.kind === 'delete'"));

test('C14 an accepted start closes the dialog and goes nowhere', () => {
  assert.match(startDialog, /onStart=\{async \(options\) => \{\s*await actions\.start\(dialog\.row, options\);\s*setDialog\(null\);\s*\}\}/);
  assert.doesNotMatch(startDialog, /showDetail/);
});

test('C15 cancelling only closes the dialog', () => {
  assert.match(startDialog, /onCancel=\{\(\) => setDialog\(null\)\}/);
});

test('C16 a refused start reaches the dialog, which shows it and stays open', () => {
  assert.doesNotMatch(startDialog, /catch/);
});

test('C17 a started or completed row opens through the board\'s cardDetail', async () => {
  assert.match(panelSource, /const detail = planningRowDetail\(items, tasksById, row\.id\);/);
  assert.match(await readSource('lib/planningTaskPanel.ts'), /return cardDetail\(\{ id: item\.id, workflowRunId: item\.workflowRunId/);
  assert.match(tasksPanel, /onOpen: \(detail\) => showDetail\(detail, activeTaskId\)/);
});

test('C18 back from a viewer opened in the panel returns to the planning session', () => {
  assert.match(tasksPanel, /function backFromDetail\(\) \{\s*showDetail\(detailBackTarget\(originSessionId, tasksById\)\);/);
  assert.match(tasksPanel, /function showDetail\(next: CardDetail \| null, fromSessionId: string \| null = null\) \{[^}]*setOriginSessionId\(fromSessionId\);/);
  assert.equal(tasksPanel.match(/onBack=\{backFromDetail\}/g).length, 5);
  assert.doesNotMatch(tasksPanel, /onBack=\{\(\) => showDetail\(null\)\}/);
});

test('C19 a click on a row whose task is gone does nothing', () => {
  assert.match(panelSource, /if \(detail\) handlers\.onOpen\(detail\);/);
});

test('C20 the empty state line', () => {
  assert.match(panelSource, /panel\.empty \? \(\s*<p [^>]*>\{wording\.emptyText\}<\/p>/);
  assert.equal(sessionPanelWording(false).emptyText, 'Tasks this session creates will appear here.');
});

test('C21 the panel has no looping animation', () => {
  assert.doesNotMatch(panelSource, /animate-(spin|pulse|ping)|infinite/);
});


// ---- 12.002: swapping the CLI and task list widths ----

test('U1/U2 the default is CLI 7 / tasks 3 and the swap is its exact mirror', () => {
  assert.equal(DEFAULT_TASK_PANEL_ARRANGEMENT, 'cli-wide');
  const wide = taskPanelLayout('cli-wide');
  const swapped = taskPanelLayout('tasks-wide');
  assert.deepEqual([wide.cliClass, wide.panelClass], ['flex-[7]', 'flex-[3]']);
  assert.deepEqual([swapped.cliClass, swapped.panelClass], ['flex-[3]', 'flex-[7]']);
});

test('U3 toggling round-trips between the two arrangements', () => {
  assert.equal(toggleTaskPanelArrangement('cli-wide'), 'tasks-wide');
  assert.equal(toggleTaskPanelArrangement('tasks-wide'), 'cli-wide');
});

test('U4-U6 label, tooltip text and pressed state name what a click does', () => {
  assert.deepEqual([taskPanelLayout('cli-wide').swapLabel, taskPanelLayout('cli-wide').swapPressed], ['Widen tasks', false]);
  assert.deepEqual([taskPanelLayout('tasks-wide').swapLabel, taskPanelLayout('tasks-wide').swapPressed], ['Widen CLI', true]);
});

test('U7 an unknown arrangement reads as the default', () => {
  assert.deepEqual(taskPanelLayout(undefined), taskPanelLayout('cli-wide'));
  assert.deepEqual(taskPanelLayout('bogus'), taskPanelLayout('cli-wide'));
  assert.equal(toggleTaskPanelArrangement(undefined), 'tasks-wide');
});

test('U8/U9 the breakpoint is unchanged and odd widths do not throw', () => {
  for (const [width, shown] of [[0, false], [1199, false], [1200, false], [1200.5, true], [1201, true], [-5, false], [NaN, false], [100000, true]]) {
    assert.equal(showsTaskPanel(width), shown, String(width));
  }
});

test('U10/U11 the row model and expansion state know nothing of the arrangement', () => {
  const panel = buildPlanningTaskPanel({ items: [], tasksById: {}, sessionNumber: 1, createdTaskCount: 0 });
  assert.equal(panel.empty, true);
  assert.doesNotMatch(panelStateHook, /arrangement|swap/i);
});

test('C1/C10/C11/C25 the control is a native button in the Session tasks header with name, tooltip and state', () => {
  assert.match(panelSource, /<header[^>]*>[\s\S]*<h4[^>]*>\{wording\.heading\}<\/h4>[\s\S]*<button\s+type="button"\s+aria-label=\{layout\.swapLabel\}\s+aria-pressed=\{layout\.swapPressed\}\s+title=\{layout\.swapLabel\}\s+onClick=\{swap\.onToggle\}/);
  assert.match(panelSource, /<Columns2 aria-hidden="true"/);
  assert.doesNotMatch(panelSource, /tabIndex=\{-1\}/);
  assert.match(panelSource, /swapLabel\}\s+aria-pressed[\s\S]*focus-visible:outline-2/);
});

test('C2-C5 the control exists only inside the panel, which shows only for a wide planning session with the Tasks tab handlers', () => {
  assert.match(sessionView, /const showTaskPanel = planning && wideViewport && !!sessionTasks && !!taskPanelSwap;/);
  assert.equal(panelSource.match(/aria-pressed=/g).length, 1);
  assert.doesNotMatch(runView, /PlanningTaskPanel|taskPanelSwap/);
  assert.doesNotMatch(panelSource, /panel\.empty[^\n]*swap/);
});

test('C9/C13-C15 the columns keep their sides and nothing remounts on a swap', () => {
  assert.doesNotMatch(sessionView + panelSource, /flex-row-reverse|\border-\d|\border-\[/);
  assert.equal(sessionView.match(/<TaskSessionBody /g).length, 1);
  assert.doesNotMatch(sessionView, /key=\{[^}]*(arrangement|layout|swap)/i);
  assert.doesNotMatch(panelSource, /key=\{[^}]*(arrangement|layout|swap)/i);
  assert.ok(sessionView.indexOf('<TaskSessionBody') < sessionView.indexOf('<PlanningTaskPanel'));
});

test('C17 scroll callbacks stay stable so a swap keeps the scroll position', () => {
  assert.match(panelStateHook, /useCallback\([^]*?\[\]\)/);
});

test('C18/C19 the width change is a class change with no animation, and text wraps to the column', () => {
  assert.doesNotMatch(sessionView + panelSource, /animate-|infinite/);
  assert.match(panelSource, /break-words/);
  assert.match(panelSource, /w-full min-w-0/);
  assert.doesNotMatch(panelSource, /max-w-/);
});

test('C20/C21 both columns can shrink and the header wraps at 30%', () => {
  assert.match(sessionView, /relative flex min-h-0 min-w-0/);
  assert.match(panelSource, /<div className="min-w-0 flex-1">/);
});

test('C22/C23/C24 the choice lives in the popup content, is passed down, and is never stored', () => {
  assert.match(workspaceModal, /const \[taskPanelArrangement, setTaskPanelArrangement\] = useState<TaskPanelArrangement>\(DEFAULT_TASK_PANEL_ARRANGEMENT\)/);
  assert.equal(workspaceModal.match(/<TasksPanel [^>]*taskPanelSwap=\{taskPanelSwap\}/g).length, 2);
  assert.match(workspaceModal, /<WorkspaceContent key=\{workspaceProjectId\}/);
  assert.match(tasksPanel, /taskPanelSwap=\{taskPanelSwap\}/);
  assert.match(tasksPanel, /<TaskDetailsView\s+key=\{activeTaskId\}/);
  assert.doesNotMatch(panelSource + sessionView, /localStorage|sessionStorage|serverApi/);
  assert.doesNotMatch(panelStateHook, /arrangement/);
});
