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

const { useWorldStore } = await import('../src/store/worldStore.ts');
const { dayRange, shiftDay, startOfLocalDay } = await import('../src/lib/agentAnalytics.ts');
const { defaultRoundIndex } = await import('../src/lib/workflowRunView.ts');
const { resolveCardDetail } = await import('../src/lib/footerPopovers.ts');
const { installServerStub } = await import('./serverStub.mjs');

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const T = '2026-10-04T10:00:00.000Z';
const project = (id) => ({ id, name: id, slug: id, relativePath: `projects/${id}`, status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: T, updatedAt: T });
const analytics = () => useWorldStore.getState().analytics;
// Readings are placed just after the start of the local day, so they are on "today" whatever time the test runs.
const reading = (at, fiveHourUsed, sevenDayUsed = 40) => ({ at, fiveHour: { usedPercentage: fiveHourUsed, resetsAt: at + 3_600_000 }, sevenDay: { usedPercentage: sevenDayUsed, resetsAt: null } });

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition never held');
}

/** A fresh stub and a store with Analytics closed and nothing loaded. */
function fresh() {
  const stub = installServerStub();
  useWorldStore.getState().closeAnalytics();
  useWorldStore.setState((state) => ({ analytics: { ...state.analytics, open: false, agentId: null, agents: null, day: null, steps: null, loading: false, error: null, refreshPhase: 'idle' } }));
  return stub;
}

const loaded = () => waitFor(() => !analytics().loading && (analytics().day !== null || analytics().error !== null || analytics().agents?.length === 0));

test('C28 the store loads analytics through the server stub: agents, the day shown and the step comparison', async () => {
  const stub = fresh();
  const now = Date.now();
  stub.analytics.readings.set('test-claude', [reading(startOfLocalDay(now) + 1, 20), reading(startOfLocalDay(now) + 2, 22)]);
  stub.analytics.stepRows = [{ id: 'round-1' }];
  useWorldStore.getState().openAnalytics('test-claude');
  assert.deepEqual([analytics().open, analytics().agentId, analytics().dayStart], [true, 'test-claude', startOfLocalDay(now)]);
  await loaded();
  const state = analytics();
  assert.deepEqual(state.agents.map((agent) => agent.id), ['test-claude', 'test-codex']);
  assert.deepEqual(state.day.range, dayRange(startOfLocalDay(now)), 'the day is cut in this browser\'s timezone');
  assert.deepEqual(state.day.series.fiveHour.points.map((point) => [point.remaining, point.used]), [[80, 20], [78, 22]]);
  assert.deepEqual([state.day.current.fiveHour.remaining, state.day.current.sevenDay.remaining], [78, 60]);
  assert.deepEqual([state.steps.rows, state.error], [[{ id: 'round-1' }], null]);
});

test('C28 a failed load keeps the previous data and sets an error; the next good load clears it', async () => {
  const stub = fresh();
  stub.analytics.readings.set('test-claude', [reading(startOfLocalDay(Date.now()) + 1, 22)]);
  useWorldStore.getState().openAnalytics('test-claude');
  await loaded();
  const before = analytics().day;
  stub.analytics.failing = true;
  await useWorldStore.getState().loadAnalytics();
  assert.deepEqual([analytics().day, analytics().error, analytics().loading], [before, 'analytics unavailable', false]);
  assert.equal(useWorldStore.getState().errorNotificationsById && Object.keys(useWorldStore.getState().errorNotificationsById).length, 0, 'the error stays inside the view');
  stub.analytics.failing = false;
  await useWorldStore.getState().loadAnalytics();
  assert.deepEqual([analytics().error, analytics().day.current.fiveHour.remaining], [null, 78]);
});

test('C28 changing day or agent reloads for that selection, and an unknown agent falls back to the first listed', async () => {
  const stub = fresh();
  const now = Date.now();
  stub.analytics.readings.set('test-claude', [reading(startOfLocalDay(now) + 1, 22)]);
  stub.analytics.readings.set('test-codex', [reading(startOfLocalDay(now) + 1, 60)]);
  useWorldStore.getState().openAnalytics('no-such-agent');
  await loaded();
  assert.equal(analytics().agentId, 'test-claude');

  const yesterday = shiftDay(startOfLocalDay(now), -1);
  useWorldStore.getState().setAnalyticsDay(yesterday);
  await waitFor(() => analytics().day?.range.from === yesterday);
  assert.deepEqual(analytics().day.series.fiveHour.points, [], 'yesterday has no readings');

  useWorldStore.getState().setAnalyticsAgent('test-codex');
  assert.equal(analytics().day, null, 'the previous agent\'s day is not shown under the new one');
  await loaded();
  assert.deepEqual([analytics().agentId, analytics().day.agent.id, analytics().day.current.fiveHour.remaining], ['test-codex', 'test-codex', 40]);
});

test('C28 with no configured agents the view loads an empty list and no day', async () => {
  const stub = fresh();
  stub.executors.clear();
  useWorldStore.getState().openAnalytics(null);
  await loaded();
  assert.deepEqual([analytics().agents, analytics().agentId, analytics().day, analytics().error], [[], null, null, null]);
});

test('C27 a manual refresh asks the daemon once, reloads, and keeps the daemon\'s answer as the status', async () => {
  const stub = fresh();
  stub.analytics.readings.set('test-claude', [reading(startOfLocalDay(Date.now()) + 1, 22)]);
  useWorldStore.getState().openAnalytics('test-claude');
  await loaded();
  await useWorldStore.getState().refreshAnalytics();
  assert.deepEqual([stub.analytics.refreshCount, analytics().refreshPhase], [1, 'refreshed']);
  stub.analytics.refreshResult = 'not-eligible';
  await useWorldStore.getState().refreshAnalytics();
  assert.deepEqual([stub.analytics.refreshCount, analytics().refreshPhase], [2, 'not-eligible']);
  stub.analytics.failing = true;
  await useWorldStore.getState().refreshAnalytics();
  assert.deepEqual([analytics().refreshPhase, analytics().error, analytics().day !== null], ['idle', 'analytics unavailable', true]);
  fresh();
  await useWorldStore.getState().refreshAnalytics();
  assert.equal(analytics().refreshPhase, 'idle', 'with no agent there is nothing to refresh');
});

test('C29 opening and closing the view does not change the open Project workspace state', async () => {
  fresh();
  const workspace = { workspaceProjectId: 'alpha', workspaceTab: 'settings', workspaceDetailTaskId: 'task-9', workspaceSettingsSection: 'commands', catalogOpen: false, notificationCenterOpen: false };
  useWorldStore.setState(workspace);
  const read = () => Object.fromEntries(Object.keys(workspace).map((key) => [key, useWorldStore.getState()[key]]));
  useWorldStore.getState().openAnalytics('test-claude');
  assert.deepEqual(read(), workspace);
  await loaded();
  useWorldStore.getState().setAnalyticsDay(shiftDay(analytics().dayStart, -1));
  useWorldStore.getState().closeAnalytics();
  assert.deepEqual(read(), workspace);
  assert.equal(analytics().open, false);
  useWorldStore.setState({ workspaceProjectId: null, workspaceTab: 'tasks', workspaceDetailTaskId: null, workspaceSettingsSection: 'workflow' });
});

test('C19 selecting an activity closes the view and opens its task at the matching step round', async () => {
  const stub = fresh();
  stub.projects.set('alpha', project('alpha'));
  stub.planDocsByProject.set('alpha', []);
  const run = { id: 'run-1', projectId: 'alpha' };
  useWorldStore.setState({ workflowRunsByProject: { alpha: [run] }, tasksById: { 'task-1': { id: 'task-1', projectId: 'alpha' } }, planByProject: { alpha: { docs: [], items: [{ id: 'item-1' }] } } });
  useWorldStore.getState().openAnalytics('test-claude');

  useWorldStore.getState().openAnalyticsTarget({ kind: 'run', projectId: 'alpha', runId: 'run-1', stepId: 'build', round: 2 });
  let state = useWorldStore.getState();
  assert.deepEqual([state.analytics.open, state.workspaceProjectId, state.workspaceTab], [false, 'alpha', 'tasks']);
  assert.deepEqual(state.workspaceCardDetailRequest, { detail: { kind: 'run', id: 'run-1', focus: { stepId: 'build', round: 2 } } });

  useWorldStore.getState().openAnalyticsTarget({ kind: 'task', projectId: 'alpha', taskId: 'task-1' });
  assert.deepEqual(useWorldStore.getState().workspaceCardDetailRequest, { detail: { kind: 'task', id: 'task-1' } });
  useWorldStore.getState().openAnalyticsTarget({ kind: 'item', projectId: 'alpha', planItemId: 'item-1' });
  assert.deepEqual(useWorldStore.getState().workspaceCardDetailRequest, { detail: { kind: 'item', id: 'item-1' } });
  // Work deleted between the reading and the click opens the Project's board, not a broken detail.
  useWorldStore.getState().openAnalyticsTarget({ kind: 'run', projectId: 'alpha', runId: 'gone', stepId: 'build', round: 1 });
  assert.deepEqual(useWorldStore.getState().workspaceCardDetailRequest, { detail: null });
  useWorldStore.setState({ workspaceProjectId: null, workflowRunsByProject: {}, tasksById: {}, planByProject: {}, workspaceCardDetailRequest: null });
});

test('C19 a run detail asked for one step round opens on that round, else on the latest', () => {
  const rounds = [{ round: 1 }, { round: 2 }, { round: 3 }];
  assert.equal(defaultRoundIndex(rounds), 2);
  assert.equal(defaultRoundIndex(rounds, 2), 1);
  assert.equal(defaultRoundIndex(rounds, 9), 2, 'a round that is not there falls back to the latest');
  assert.equal(defaultRoundIndex([], 1), 0);
  const focused = { kind: 'run', id: 'run-1', focus: { stepId: 'build', round: 2 } };
  assert.equal(resolveCardDetail(focused, 'alpha', { planByProject: {}, tasksById: {}, workflowRunsByProject: { alpha: [{ id: 'run-1' }] } }), focused, 'the focus survives resolution');
  const runView = source('ui/project-popup/WorkflowRunView.tsx');
  assert.match(runView, /useState<string \| null>\(focus\?\.stepId \?\? null\)/);
  assert.match(runView, /focusRound=\{focus\?\.stepId === activeStage\.id \? focus\.round : null\}/);
  assert.match(runView, /earlierCount \+ defaultRoundIndex\(stage\.rounds, focusRound\)/);
  assert.match(source('ui/project-popup/TasksPanel.tsx'), /<WorkflowRunView key=\{`\$\{detailRunId\}:\$\{runFocus\?\.stepId \?\? ''\}:\$\{runFocus\?\.round \?\? ''\}`\} runId=\{detailRunId\} focus=\{runFocus\}/);
  assert.match(source('ui/project-popup/useCardDetail.ts'), /setRunFocus\(detail\?\.kind === 'run' \? detail\.focus \?\? null : null\)/);
});

test('C30 the footer item is a button that opens the dialog, and the dialog is labelled and returns focus on close', () => {
  const item = source('ui/ExecutorFooterItem.tsx');
  assert.match(item, /<button\s+type="button"/);
  assert.match(item, /onClick=\{\(\) => openAnalytics\(executor\.id\)\}/);
  assert.match(item, /aria-label=\{agentBarsLabel\(executor\.label, fiveHour, sevenDay\)\}/);
  assert.match(item, /\[ANALYTICS_TRIGGER_ATTRIBUTE\]: executor\.id/);
  assert.match(item, /limitBar\(executor\.limits\?\.fiveHour, now\)/, 'the footer item draws the limit bars from the same readings');

  const dialog = source('ui/analytics/AgentAnalyticsDialog.tsx');
  assert.match(dialog, /<Dialog open=\{analytics\.open\} onOpenChange=\{\(open\) => \{ if \(!open\) closeAnalytics\(\); \}\}>/);
  assert.match(dialog, /<DialogTitle[^>]*>Agent analytics<\/DialogTitle>/);
  assert.match(dialog, /onCloseAutoFocus=\{\(event\) => \{[\s\S]*?\[\$\{ANALYTICS_TRIGGER_ATTRIBUTE\}="\$\{CSS\.escape\(agentId\)\}"\][\s\S]*?trigger\.focus\(\)/);
  assert.match(dialog, /aria-label="Close analytics"/);
  assert.match(dialog, /<label className="sr-only" htmlFor="analytics-agent">Coding agent<\/label>/);
  assert.match(dialog, /<span role="status"/);
  assert.match(dialog, />Refresh<\/Button>/);
  assert.match(dialog, /No coding agents are configured/);
  assert.match(dialog, /Retired agent: this profile was removed/);
  assert.match(dialog, /this is not independent capacity/);
  assert.match(source('App.tsx'), /<AgentAnalyticsDialog \/>/);
  // With no agent configured there is no item to select, so the placeholder opens the view's empty state.
  assert.match(source('ui/StatusFooter.tsx'), /onClick=\{\(\) => openAnalytics\(null\)\}[^>]*italic text-muted-foreground">No coding agents configured<\/button>/);
});

test('C30 the plot is focusable with an accessible name, bands are buttons with accessible labels, and there is no CSV export', () => {
  const chart = source('ui/analytics/CapacityChart.tsx');
  assert.match(chart, /data-analytics-plot\s+tabIndex=\{0\}\s+role="group"\s+aria-label="Remaining capacity through the day\. Use the arrow keys/);
  assert.match(chart, /onKeyDown=\{onKeyDown\}/);
  assert.match(chart, /<p aria-live="polite" className="sr-only">/);
  assert.match(chart, /sevenDay: '6 4'/, 'the 7d line is dashed, so the series differ by more than colour');
  assert.match(chart, /<ActivityLanes view=\{view\} width=\{width\}/, 'the lanes share the plot\'s time axis');

  const lanes = source('ui/analytics/ActivityLanes.tsx');
  assert.match(lanes, /<button\s+key=\{activity\.id\}\s+type="button"\s+data-analytics-band\s+aria-label=\{activityAriaLabel\(activity\)\}\s+aria-disabled=\{!openable\}/);
  assert.match(lanes, /onClick=\{\(\) => \{ if \(openable\) onOpenTarget\(activity\); \}\}/);
  assert.match(lanes, /onFocus=\{\(\) => setHoveredId\(activity\.id\)\}/, 'keyboard focus shows the same hover box as the pointer');
  assert.match(lanes, /top: top\(hovered\) \+ LANE_HEIGHT \+ 6/, 'the hover box sits below the band it describes');

  const panel = source('ui/analytics/CapacityPanel.tsx');
  assert.match(panel, /aria-label="Previous day" disabled=\{!switcher\.canPrevious\}/);
  assert.match(panel, /aria-label="Next day" disabled=\{!switcher\.canNext\}/);
  assert.match(panel, /disabled=\{switcher\.isToday\} onClick=\{\(\) => onSelectDay\(switcher\.today\)\}>Today<\/Button>/);
  assert.match(panel, /<caption className="sr-only">Readings, resets and gaps on/);
  assert.match(panel, /aria-pressed=\{!hidden\[window\]\}/, 'each series can be hidden from the legend');
  assert.match(panel, /never a token count/);
  assert.doesNotMatch(panel, /24h|30d|90d range/i, 'the view shows one day, not range buttons');

  const steps = source('ui/analytics/StepComparisonPanel.tsx');
  assert.match(steps, /<Badge variant="destructive">High usage<\/Badge>/);
  assert.match(steps, /High usage only/);
  for (const file of ['ui/analytics/AgentAnalyticsDialog.tsx', 'ui/analytics/CapacityPanel.tsx', 'ui/analytics/CapacityChart.tsx', 'ui/analytics/ActivityLanes.tsx', 'ui/analytics/StepComparisonPanel.tsx']) {
    assert.doesNotMatch(source(file), /csv|export data|download/i, `${file} offers no export`);
  }
});
