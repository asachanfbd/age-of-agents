import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const lib = await import('../src/lib/runningCommands.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const projects = [{ id: 'p-b', name: 'beta' }, { id: 'p-a', name: 'Alpha' }, { id: 'p-a2', name: 'alpha' }];
const cmd = (id, projectId, patch = {}) => ({ id, projectId, commandId: `c-${id}`, commandName: id, commandText: 'x', origin: 'saved', location: { kind: 'main' }, status: 'running', exitCode: null, output: '', startedAt: iso(0), completedAt: null, ...patch });
const testRun = (id, projectId, patch = {}) => ({ id, projectId, batchId: null, suite: { id: 's', label: 'Unit', kind: 'unit' }, action: { id: 'a', label: 'Run' }, trigger: 'manual', taskId: null, cwd: null, branch: null, status: 'running', startedAt: iso(0), ...patch });
const groupsOf = (commands = [], tests = [], list = projects) => lib.buildRunningGroups({
  projects: list,
  commandRunsById: Object.fromEntries(commands.map((r) => [r.id, r])),
  testRunsById: Object.fromEntries(tests.map((r) => [r.id, r])),
});
const count = (commands, tests, list) => lib.countRunningRows(groupsOf(commands, tests, list));

test('U22-U24 a saved command, a task working copy command and a one-off command all count', () => {
  assert.equal(count([cmd('saved', 'p-a'), cmd('task', 'p-a', { location: { kind: 'task', workflowRunId: 'w', planItemId: 'i', branch: 'b', taskRef: '5.008' } }), cmd('one', 'p-a', { origin: 'adhoc' })]), 3);
});

test('U25-U26 a running sync run counts (it blocks an app update); settled command runs never do', () => {
  assert.equal(count([cmd('sync', 'p-a', { origin: 'sync' })]), 1);
  assert.equal(count(['success', 'failed', 'stopped'].map((status) => cmd(status, 'p-a', { status }))), 0);
});

test('U27-U30 executing and queued test runs count whoever started them; settled ones do not', () => {
  assert.equal(count([], [testRun('m', 'p-a'), testRun('g', 'p-a', { trigger: 'agent' })]), 2);
  assert.equal(count([], [testRun('q', 'p-a', { status: 'queued', startedAt: null })]), 1);
  assert.equal(count([], ['passed', 'failed', 'error', 'stopped'].map((status) => testRun(status, 'p-a', { status }))), 0);
});

test('U27b a queued test run is flagged queued, sorts after started runs and a running one is not flagged', () => {
  const rows = groupsOf([], [testRun('q', 'p-a', { status: 'queued', startedAt: null }), testRun('r', 'p-a')])[0].rows;
  assert.deepEqual(rows.map((row) => [row.runId, row.queued]), [['r', undefined], ['q', true]]);
});

test('U31-U33 a run of an unlisted project is hidden, an empty set is 0', () => {
  assert.equal(count([cmd('gone', 'p-missing')], [testRun('t', 'p-missing')]), 0);
  assert.equal(count([], []), 0);
  assert.equal(count([cmd('c', 'p-a')], [], []), 0, 'no projects, no rows (a project still loading contributes nothing)');
});

test('U34 the wording is "N running commands"', () => {
  for (const n of [0, 1, 12]) assert.equal(lib.runningCommandsLabel(n), `${n} running commands`);
});

test('U38-U39 projects sort A-Z ignoring case, ties by id', () => {
  const groups = groupsOf([cmd('x', 'p-b'), cmd('y', 'p-a2'), cmd('z', 'p-a')]);
  assert.deepEqual(groups.map((g) => g.projectId), ['p-a', 'p-a2', 'p-b']);
});

test('U40-U41 within a project the earliest start comes first, ties by name then id; a bad start sorts last', () => {
  const rows = groupsOf([
    cmd('late', 'p-a', { startedAt: iso(5000) }), cmd('beta', 'p-a', { startedAt: iso(0) }), cmd('alpha', 'p-a', { startedAt: iso(0) }),
    cmd('bad', 'p-a', { startedAt: 'nonsense' }),
  ], [testRun('t', 'p-a', { startedAt: iso(-1000) })])[0].rows;
  assert.deepEqual(rows.map((r) => r.runId), ['t', 'alpha', 'beta', 'late', 'bad']);
});

test('U36 U42 the footer number equals the badge sum, from one selector', () => {
  const groups = groupsOf([cmd('a', 'p-a'), cmd('b', 'p-b')], [testRun('t', 'p-a')]);
  assert.equal(lib.countRunningRows(groups), groups.reduce((n, g) => n + g.rows.length, 0));
  assert.deepEqual(groups.map((g) => g.rows.length), [2, 1]);
});

test('U43-U44 U50 names, test marker and agent flag', () => {
  const [group] = groupsOf([cmd('Dev server', 'p-a', { commandName: 'Dev server' })], [testRun('t', 'p-a', { trigger: 'agent' })]);
  const byKind = Object.fromEntries(group.rows.map((r) => [r.kind, r]));
  assert.equal(byKind.command.name, 'Dev server');
  assert.equal(byKind.command.startedByAgent, false);
  assert.equal(byKind.test.name, 'Unit: Run');
  assert.equal(byKind.test.startedByAgent, true);
});

test('U45-U48 where it runs', () => {
  const task = (patch) => ({ location: { kind: 'task', workflowRunId: 'w', planItemId: 'i', branch: null, taskRef: null, ...patch } });
  assert.equal(lib.commandWhere({}), 'Main checkout');
  assert.equal(lib.commandWhere({ location: { kind: 'main' } }), 'Main checkout');
  assert.equal(lib.commandWhere(task({ taskRef: '5.008', branch: 'feat' })), '5.008');
  assert.equal(lib.commandWhere(task({ branch: 'feat' })), 'feat');
  assert.equal(lib.commandWhere(task({})), 'Task working copy');
  assert.equal(lib.testWhere({ taskId: null, branch: 'main' }), 'Main checkout');
  assert.equal(lib.testWhere({ taskId: 't', branch: 'feat' }), 'feat');
  assert.equal(lib.testWhere({ taskId: 't', branch: null }), 'Task working copy');
});

test('U49 elapsed text, clamped at 0 for a future or unreadable start', () => {
  assert.equal(lib.runningElapsed(iso(0), T0), '0s');
  assert.equal(lib.runningElapsed(iso(0), T0 + 59_000), '59s');
  assert.equal(lib.runningElapsed(iso(0), T0 + 60_000), '1m');
  assert.equal(lib.runningElapsed(iso(0), T0 + 3_700_000), '1h 2m');
  assert.equal(lib.runningElapsed(iso(10_000), T0), '0s');
  assert.equal(lib.runningElapsed(null, T0), '0s');
});

test('U51 the empty message', () => assert.equal(lib.EMPTY_RUNNING_MESSAGE, 'No running commands'));

test('U54 a very long name is kept in full for the tooltip', () => {
  assert.equal(groupsOf([cmd('l', 'p-a', { commandName: 'n'.repeat(500) })])[0].rows[0].name.length, 500);
});

test('mergeRunningLoad keeps settled runs settled, adds listed ones, and reports stale running ones', () => {
  const existing = { done: cmd('done', 'p-a', { status: 'success' }), old: cmd('old', 'p-a'), other: cmd('other', 'p-b') };
  const { merged, staleIds } = lib.mergeRunningLoad(existing, [cmd('done', 'p-a'), cmd('fresh', 'p-a')], 'p-a');
  assert.equal(merged.done.status, 'success');
  assert.ok(merged.fresh);
  assert.deepEqual(staleIds, ['old']);
});

// ---- store ----

function resetStore() {
  useWorldStore.setState({
    projects: [{ id: 'p-a', name: 'Alpha' }, { id: 'p-b', name: 'Beta' }], commandRunsById: {}, testRunsById: {}, testRunDetailsById: {}, testRunLogsById: {},
    workspaceProjectId: null, workspaceTab: 'tasks', workspaceTestRunRequest: null, footerCommandLogRunId: null,
    catalogOpen: false, notificationCenterOpen: false, notificationsById: {}, ...CLEAN_ERROR_STATE,
  });
}

async function withApi(overrides, body) {
  const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, serverApi[k]]));
  Object.assign(serverApi, overrides);
  try { await body(); } finally { Object.assign(serverApi, saved); }
}

test('W01-W02 loadRunningRuns fills the count for a project nobody opened, one call per kind', async () => {
  resetStore();
  const calls = [];
  await withApi({
    listCommandRuns: async (projectId, status) => { calls.push(['commands', projectId, status]); return [cmd('c1', projectId)]; },
    listTestRuns: async (projectId, limit, status) => { calls.push(['tests', projectId, status]); return { runs: [status === 'queued' ? testRun('t2', projectId, { status, startedAt: null }) : testRun('t1', projectId)], total: 1, limit, offset: 0 }; },
  }, async () => {
    await useWorldStore.getState().loadRunningRuns('p-a');
    assert.deepEqual(calls, [['commands', 'p-a', 'running'], ['tests', 'p-a', 'running'], ['tests', 'p-a', 'queued']]);
    const s = useWorldStore.getState();
    assert.equal(lib.countRunningRows(lib.buildRunningGroups(s)), 3);
  });
});

test('W03 a reload after reconnect settles a run that finished while disconnected, and adds a new one', async () => {
  resetStore();
  useWorldStore.setState({ commandRunsById: { gone: cmd('gone', 'p-a') } });
  await withApi({
    listCommandRuns: async () => [cmd('new', 'p-a')],
    listTestRuns: async () => ({ runs: [], total: 0, limit: 100, offset: 0 }),
    getCommandRun: async (id) => cmd(id, 'p-a', { status: 'success' }),
  }, async () => {
    await useWorldStore.getState().loadRunningRuns('p-a');
    const rows = lib.buildRunningGroups(useWorldStore.getState())[0].rows;
    assert.deepEqual(rows.map((r) => r.runId), ['new']);
  });
});

test('W03b a stale run the daemon no longer knows is dropped', async () => {
  resetStore();
  useWorldStore.setState({ commandRunsById: { gone: cmd('gone', 'p-a') }, testRunsById: { tgone: testRun('tgone', 'p-a') } });
  await withApi({
    listCommandRuns: async () => [],
    listTestRuns: async () => ({ runs: [], total: 0, limit: 100, offset: 0 }),
    getCommandRun: async () => { throw new Error('404'); },
    getTestRun: async () => { throw new Error('404'); },
  }, async () => {
    await useWorldStore.getState().loadRunningRuns('p-a');
    const s = useWorldStore.getState();
    assert.deepEqual([s.commandRunsById, s.testRunsById], [{}, {}]);
  });
});

test('W11 a late list response never resurrects a run already settled by an event', async () => {
  resetStore();
  useWorldStore.setState({ commandRunsById: { c1: cmd('c1', 'p-a', { status: 'success' }) } });
  await withApi({
    listCommandRuns: async () => [cmd('c1', 'p-a')],
    listTestRuns: async () => ({ runs: [], total: 0, limit: 100, offset: 0 }),
  }, async () => {
    await useWorldStore.getState().loadRunningRuns('p-a');
    assert.equal(useWorldStore.getState().commandRunsById.c1.status, 'success');
  });
});

test('W04-W08 live events add a run when it starts and drop it the moment it ends', () => {
  resetStore();
  const apply = (event) => useWorldStore.setState((state) => mergeWorkerEvent(state, event));
  const n = () => lib.countRunningRows(lib.buildRunningGroups(useWorldStore.getState()));
  apply({ type: 'commandRun', run: cmd('c1', 'p-a') });
  apply({ type: 'testRun', run: testRun('t0', 'p-a', { status: 'queued' }) });
  assert.equal(n(), 2, 'queued is counted');
  apply({ type: 'testRun', run: testRun('t0', 'p-a') });
  assert.equal(n(), 2);
  for (const status of ['success', 'failed', 'stopped']) {
    apply({ type: 'commandRun', run: cmd('c1', 'p-a') });
    apply({ type: 'commandRun', run: cmd('c1', 'p-a', { status }) });
    assert.equal(n(), 1, `command ${status}`);
  }
  for (const status of ['passed', 'failed', 'error', 'stopped']) {
    apply({ type: 'testRun', run: testRun('t0', 'p-a') });
    apply({ type: 'testRun', run: testRun('t0', 'p-a', { status }) });
    assert.equal(n(), 0, `test ${status}`);
  }
});

test('W03b a queued test run that left the list is refetched, so it cannot stay queued in the footer', async () => {
  resetStore();
  useWorldStore.setState({ testRunsById: { q: testRun('q', 'p-a', { status: 'queued', startedAt: null }) } });
  await withApi({
    listCommandRuns: async () => [],
    listTestRuns: async () => ({ runs: [], total: 0, limit: 100, offset: 0 }),
    getTestRun: async (id) => testRun(id, 'p-a', { status: 'passed' }),
  }, async () => {
    await useWorldStore.getState().loadRunningRuns('p-a');
    assert.equal(lib.countRunningRows(lib.buildRunningGroups(useWorldStore.getState())), 0);
  });
});

test('W09 an event for an unlisted project never shows, and removing a project drops its rows', () => {
  resetStore();
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'commandRun', run: cmd('c1', 'p-unknown') }));
  assert.equal(lib.countRunningRows(lib.buildRunningGroups(useWorldStore.getState())), 0);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'commandRun', run: cmd('c2', 'p-b') }));
  useWorldStore.setState({ projects: [{ id: 'p-a', name: 'Alpha' }] });
  assert.equal(lib.countRunningRows(lib.buildRunningGroups(useWorldStore.getState())), 0);
});

test('W12-W13 a footer log opens without touching the project popup, and a second one replaces the first', async () => {
  resetStore();
  useWorldStore.setState({ workspaceProjectId: 'p-b', workspaceTab: 'code' });
  await withApi({ getCommandRun: async (id) => cmd(id, 'p-a', { status: 'success', output: 'done' }) }, async () => {
    await useWorldStore.getState().openFooterCommandLog('r1');
    let s = useWorldStore.getState();
    assert.equal(s.footerCommandLogRunId, 'r1');
    assert.equal(s.commandRunsById.r1.output, 'done', 'a run that just finished shows its finished result');
    assert.deepEqual([s.workspaceProjectId, s.workspaceTab], ['p-b', 'code']);
    await s.openFooterCommandLog('r2');
    assert.equal(useWorldStore.getState().footerCommandLogRunId, 'r2');
    useWorldStore.getState().closeFooterCommandLog();
    s = useWorldStore.getState();
    assert.deepEqual([s.footerCommandLogRunId, s.workspaceProjectId, s.workspaceTab], [null, 'p-b', 'code']);
  });
});

test('W16 a failed run fetch leaves no half-open popup', async () => {
  resetStore();
  await withApi({ getCommandRun: async () => { throw new Error('boom'); } }, async () => {
    await useWorldStore.getState().openFooterCommandLog('r1');
    assert.equal(useWorldStore.getState().footerCommandLogRunId, null);
  });
});

test('W17-W18 a test run row opens the Testing tab with its drawer, switching project and closing the Catalog and the drawer; a vanished run leaves just the tab', async () => {
  resetStore();
  useWorldStore.setState({ workspaceProjectId: 'p-b', catalogOpen: true, notificationCenterOpen: true });
  await withApi({ getTestRun: async (id) => testRun(id, 'p-a') }, async () => {
    await useWorldStore.getState().openTestRunFromFooter('p-a', 't1');
    const s = useWorldStore.getState();
    assert.deepEqual([s.workspaceProjectId, s.workspaceTab, s.workspaceTestRunRequest, s.catalogOpen, s.notificationCenterOpen], ['p-a', 'testing', { runId: 't1' }, false, false]);
  });
  await withApi({ getTestRun: async () => { throw new Error('404'); } }, async () => {
    await useWorldStore.getState().openTestRunFromFooter('p-a', 'gone');
    assert.deepEqual(useWorldStore.getState().workspaceTestRunRequest, { runId: null });
  });
});

const notification = (kind, subject) => ({ id: 'n1', kind, severity: 'info', subject, projectId: subject.projectId, title: 't', description: '', readAt: null, resolvedAt: null, createdAt: iso(0), updatedAt: iso(0) });

test('W19-W20 selecting a completion notification opens the log on top, or the run drawer, and marks it read', async () => {
  resetStore();
  const read = [];
  await withApi({
    getCommandRun: async (id) => cmd(id, 'p-a', { status: 'success' }),
    getTestRun: async (id) => testRun(id, 'p-a'),
    markNotificationsRead: async (ids) => { read.push(...ids); },
  }, async () => {
    useWorldStore.setState({ workspaceProjectId: 'p-b' });
    await useWorldStore.getState().openNotificationTarget(notification('command.completed', { type: 'command', projectId: 'p-a', commandId: 'c', runId: 'r1' }));
    let s = useWorldStore.getState();
    assert.deepEqual([s.footerCommandLogRunId, s.workspaceProjectId], ['r1', 'p-b']);
    await s.openNotificationTarget(notification('testing.passed', { type: 'testRun', projectId: 'p-a', runId: 't1' }));
    s = useWorldStore.getState();
    assert.deepEqual([s.workspaceProjectId, s.workspaceTab, s.workspaceTestRunRequest], ['p-a', 'testing', { runId: 't1' }]);
    assert.deepEqual(read, ['n1', 'n1'], 'both notifications were marked read');
  });
});

test('W28 a failed command notification still deep-links to Settings > Commands', async () => {
  resetStore();
  await withApi({ markNotificationsRead: async () => {} }, async () => {
    await useWorldStore.getState().openNotificationTarget(notification('command.failed', { type: 'command', projectId: 'p-a', commandId: 'c', runId: 'r1' }));
    const s = useWorldStore.getState();
    assert.deepEqual([s.workspaceProjectId, s.workspaceTab, s.footerCommandLogRunId], ['p-a', 'settings', null]);
  });
});

// ---- watch registration ----

test('W21-W23 watchRun registers once per run, refcounts views and releases on the last one', async () => {
  const sent = [];
  const { watchRun } = await import('../src/lib/serverApi.ts');
  const original = globalThis.WebSocket;
  class FakeSocket {
    static instances = [];
    readyState = 1;
    listeners = {};
    constructor() { FakeSocket.instances.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    send(data) { sent.push(JSON.parse(data)); }
    close() {}
  }
  globalThis.WebSocket = FakeSocket;
  globalThis.window ??= { location: { origin: 'http://localhost' } };
  try {
    const stop = serverApi.connectLiveUpdates(() => {});
    FakeSocket.instances[0].listeners.open();
    const releaseA = watchRun('command', 'r1');
    const releaseB = watchRun('command', 'r1');
    assert.deepEqual(sent, [{ type: 'watchRun', kind: 'command', runId: 'r1' }]);
    releaseA();
    assert.equal(sent.length, 1, 'still shown by another view');
    releaseB();
    assert.deepEqual(sent[1], { type: 'unwatchRun', kind: 'command', runId: 'r1' });
    // A run still open when the socket reconnects is registered again on the new socket.
    const releaseT = watchRun('test', 't1');
    sent.length = 0;
    FakeSocket.instances[0].listeners.open();
    assert.deepEqual(sent, [{ type: 'watchRun', kind: 'test', runId: 't1' }]);
    releaseT();
    stop();
  } finally {
    globalThis.WebSocket = original;
  }
});

// ---- source checks ----

test('C15 C34 the Commands group is always rendered and its list says "No running commands"', async () => {
  const footer = await read('../src/ui/StatusFooter.tsx');
  assert.match(footer, /heading="Commands"/);
  assert.match(footer, /dot=\{running > 0 \? 'bg-warning' : 'bg-muted-foreground\/40'\} muted=\{running === 0\}/);
  assert.match(footer, /label=\{runningCommandsLabel\(running\)\}/);
  const lists = await read('../src/ui/FooterListPopovers.tsx');
  assert.match(lists, /<Empty>\{EMPTY_RUNNING_MESSAGE\}<\/Empty>/);
});

test('C19 C21 C22 every footer list scrolls under a modal, and project headings are bold, solid, pinned and badged', async () => {
  const shell = await read('../src/ui/FooterCountPopover.tsx');
  assert.match(shell, /isolateScroll\(node\)/);
  assert.match(shell, /overflow-y-auto overscroll-contain/);
  const heading = await read('../src/ui/FooterListHeading.tsx');
  assert.match(heading, /sticky top-0[^"]*bg-popover[^"]*font-bold text-foreground/);
  assert.match(heading, /\{count\}/);
  assert.match(heading, /<TaskCountsBadge counts=\{taskCounts\} \/>/, 'the Tasks popup shows a count per state instead');
  const tasks = await read('../src/ui/TasksPopover.tsx');
  assert.match(tasks, /isolateScroll\(node\)/);
  assert.match(tasks, /<FooterListHeading name=\{group\.projectName\} taskCounts=\{group\.counts\} \/>/);
  const lists = await read('../src/ui/FooterListPopovers.tsx');
  assert.equal(lists.match(/<FooterListHeading name=\{group\.projectName\} count=\{group\.rows\.length\} \/>/g)?.length, 1, 'the Commands list');
  const planning = await read('../src/ui/PlanningSessionsPopover.tsx');
  assert.match(planning, /<FooterListHeading name=\{group\.projectName\} count=\{group\.sessions\.length\} \/>/);
  const scroll = await read('../src/lib/scrollIsolation.ts');
  assert.match(scroll, /'wheel', 'touchmove'/);
});

test('C01-C05 the agent item draws its name and two aria-hidden bars, 5h above 7d, with no percent text', async () => {
  const item = await read('../src/ui/ExecutorFooterItem.tsx');
  assert.match(item, /<LimitTrack bar=\{fiveHour\} \/><LimitTrack bar=\{sevenDay\} \/>/);
  assert.match(item, /aria-hidden="true" className="block h-1/);
  assert.match(item, /aria-label=\{agentBarsLabel\(executor\.label, fiveHour, sevenDay\)\}/);
  assert.match(item, /green: 'bg-success'[\s\S]*orange: 'bg-warning'[\s\S]*red: 'bg-destructive'/);
  assert.match(item, /bar\.remaining !== null &&/, 'an unknown bar has no fill');
  assert.match(item, /style=\{\{ width: `\$\{bar\.remaining\}%` \}\}/);
  assert.doesNotMatch(item, /%\}<|5h|7d •/);
  assert.match(item, /Select to open analytics/, 'the hover box is unchanged');
  assert.match(item, /onClick=\{\(\) => openAnalytics\(executor\.id\)\}/);
});

test('C32 the footer log popup is mounted at the app root after the drawer, and every offset uses the one height', async () => {
  const app = await read('../src/App.tsx');
  assert.match(app, /<NotificationCenter \/>\s*<FooterCommandLog \/>/);
  const { STATUS_FOOTER_HEIGHT } = await import('../src/lib/statusFooter.ts');
  assert.equal(STATUS_FOOTER_HEIGHT, 46);
  assert.match(app, /bottom: STATUS_FOOTER_HEIGHT \+ 20/);
  for (const file of ['../src/ui/AppReconnectBanner.tsx', '../src/ui/AppUpdateReloadBanner.tsx']) assert.match(await read(file), /bottom: STATUS_FOOTER_HEIGHT/);
  assert.match(await read('../src/components/ui/sheet.tsx'), /bottom-\[var\(--status-footer-height\)\]/);
  assert.match(await read('../src/ui/ProjectCardsView.tsx'), /pb-\[calc\(var\(--status-footer-height\)\+5rem\)\]/);
});

test('C24 C25 C27 Commands rows show name, elapsed time, where it runs, the test tag and the agent tag', async () => {
  const lists = await read('../src/ui/FooterListPopovers.tsx');
  assert.match(lists, /useNow\(1_000\)/);
  assert.match(lists, /Test run<\/span>/);
  assert.match(lists, /started by agent<\/span>/);
  assert.match(lists, /openFooterCommandLog\(row\.runId\)/);
  assert.match(lists, /openTestRunFromFooter\(row\.projectId, row\.runId\)/);
});

test('both the command log popup and the test run drawer register a watch', async () => {
  assert.match(await read('../src/ui/project-popup/commands/CommandLogPopup.tsx'), /useEffect\(\(\) => watchRun\('command', runId\), \[runId\]\)/);
  assert.match(await read('../src/ui/project-popup/TestingPanel.tsx'), /useEffect\(\(\) => watchRun\('test', runId\), \[runId\]\)/);
});
