import assert from 'node:assert/strict';
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

const { serverApi } = await import('../src/lib/serverApi.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { reportedError, CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const {
  SETUP_CTA_LABELS, approvalDecision, countsText, diagnosticsBanner, evidenceRows, formatDuration, isSetupProposalGate,
  lastTaskSignature, metricDisplay, overviewStats, resultSections, runAllGuard, runHistoryRow, runStaleness, setupHeader,
  setupModeFor, setupStage, sortCasesFailedFirst, sortFindingsBySeverity, statCards, suiteCardModel, testRunBadge,
  testRunsSignature,
} = await import('../src/lib/testingPanel.ts');

/**
 * Task 2.005's web side: the testing API client, the store's Test Run slice and setup actions, and
 * the Testing tab's pure view models (lib/testingPanel.ts) — every state the tab and the setup's
 * approval gate render, without a DOM.
 */

// ---- Fixtures ----

const ABSENT = { state: 'absent', path: '.docs/testing/config.json' };
const VALID = { state: 'valid', path: '.docs/testing/config.json', config: { schemaVersion: 1, suites: [] } };
const INVALID = { state: 'invalid', path: '.docs/testing/config.json', issues: [{ code: 'unsafe-path', path: 'suites[0]', message: 'bad' }] };
const ZERO = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

function run(overrides = {}) {
  return {
    id: 'run-1', projectId: 'p1', planItemId: 'i1', workflowId: 'testing-setup', status: 'running', currentStepId: 'proposal',
    branch: 'task/set-up-testing', prUrl: null, attentionReason: null, testingSetup: { mode: 'setup', evidence: null }, ...overrides,
  };
}

function setup(runOverrides = {}, extra = {}) {
  return { planItem: { id: 'i1', title: 'Set up testing' }, run: runOverrides === null ? null : run(runOverrides), queueEntry: null, active: true, ...extra };
}

function testRun(overrides = {}) {
  return {
    id: 't1', projectId: 'p1', status: 'passed', trigger: 'manual', branch: 'main', commit: 'a1b2c3d4e5', durationMs: 24_800,
    action: { id: 'run', purpose: 'result' },
    summary: { outcome: 'passed', counts: { total: 10, passed: 9, skipped: 1 }, metrics: [], findingCounts: ZERO },
    ...overrides,
  };
}

function suite(overrides = {}) {
  return {
    id: 'unit', label: 'Unit', kind: 'unit', enabled: true, primaryActionId: 'run', latestResult: testRun(),
    actions: [
      { id: 'run', label: 'Run unit tests', purpose: 'result', enabled: true, latestResult: null, latestRun: null, activeRun: null },
      { id: 'cov', label: 'Run with coverage', purpose: 'result', enabled: true, latestResult: null, latestRun: null, activeRun: null },
      { id: 'snap', label: 'Update snapshots', purpose: 'utility', enabled: true, latestResult: null, latestRun: null, activeRun: null },
    ],
    ...overrides,
  };
}

function mockFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url).replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ---- API client ----

test('the testing and setup API calls hit their routes with the right method and body', async () => {
  const { calls, restore } = mockFetch((call) => ({ status: call.method === 'DELETE' ? 204 : 200, body: {} }));
  try {
    await serverApi.getTestingSetup('p1');
    await serverApi.startTestingSetup('p1');
    await serverApi.approveTestingSetup('r1', 2, 'ok');
    await serverApi.reviseTestingSetup('r1', 'smaller');
    await serverApi.rejectTestingSetup('r1');
    await serverApi.getTestingOverview('p1');
    await serverApi.listTestRuns('p1', 5);
    await serverApi.getTestRun('t1');
    await serverApi.runTestAction('p1', 'unit', 'run');
    await serverApi.runAllTests('p1');
    await serverApi.stopTestRun('t1');
    assert.equal(await serverApi.removeQueuedTestRun('t1'), undefined);
  } finally {
    restore();
  }
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'GET /api/projects/p1/testing/setup',
    'POST /api/projects/p1/testing/setup',
    'POST /api/testing-setup/r1/approve',
    'POST /api/testing-setup/r1/revise',
    'POST /api/testing-setup/r1/reject',
    'GET /api/projects/p1/testing',
    'GET /api/projects/p1/test-runs?limit=5',
    'GET /api/test-runs/t1',
    'POST /api/projects/p1/test-runs',
    'POST /api/projects/p1/test-runs/run-all',
    'POST /api/test-runs/t1/stop',
    'DELETE /api/test-runs/t1',
  ]);
  assert.deepEqual(calls[2].body, { proposalRound: 2, comment: 'ok' });
  assert.deepEqual(calls[3].body, { comment: 'smaller' });
  assert.deepEqual(calls[8].body, { suiteId: 'unit', actionId: 'run' });
});

test('a refused approval surfaces the server message', async () => {
  const { restore } = mockFetch(() => ({ status: 409, body: { error: 'Proposal round 1 is not the one awaiting approval (round 2 is).' } }));
  try {
    await assert.rejects(serverApi.approveTestingSetup('r1', 1), /round 2 is/);
  } finally {
    restore();
  }
});

// ---- Store ----

function resetStore() {
  useWorldStore.setState({ workflowRunsByProject: {}, workflowRunDetails: {}, testRunsById: {}, testRunDetailsById: {}, testRunLogsById: {}, ...CLEAN_ERROR_STATE });
}

test('Test Run events upsert and remove runs by id', () => {
  let state = { testRunsById: {}, testRunDetailsById: {}, testRunLogsById: {} };
  state = { ...state, ...mergeWorkerEvent(state, { type: 'testRun', run: { id: 'r1', projectId: 'p1', status: 'queued' } }) };
  state = { ...state, ...mergeWorkerEvent(state, { type: 'testRun', run: { id: 'r1', projectId: 'p1', status: 'running' } }) };
  assert.equal(state.testRunsById.r1.status, 'running');
  assert.deepEqual(mergeWorkerEvent(state, { type: 'testRunRemoved', runId: 'unknown', projectId: 'p1' }), {});
  state = { ...state, ...mergeWorkerEvent(state, { type: 'testRunRemoved', runId: 'r1', projectId: 'p1' }) };
  assert.deepEqual(state.testRunsById, {});
});

test('a testRun event patches an already-fetched detail\'s live fields without touching its log/result', () => {
  let state = {
    testRunsById: {},
    testRunDetailsById: { r1: { id: 'r1', projectId: 'p1', status: 'running', summary: null, output: 'partial output\n', result: null } },
    testRunLogsById: { r1: 'partial output\n' },
  };
  state = {
    ...state,
    ...mergeWorkerEvent(state, { type: 'testRun', run: { id: 'r1', projectId: 'p1', status: 'passed', summary: { outcome: 'passed', counts: { passed: 1 }, metrics: [], findingCounts: {} } } }),
  };
  assert.equal(state.testRunDetailsById.r1.status, 'passed');
  assert.deepEqual(state.testRunDetailsById.r1.summary, { outcome: 'passed', counts: { passed: 1 }, metrics: [], findingCounts: {} });
  // output/result survive the live patch — only a fresh loadTestRunDetail() call replaces those.
  assert.equal(state.testRunDetailsById.r1.output, 'partial output\n');
  assert.equal(state.testRunDetailsById.r1.result, null);
  // A run with no fetched detail yet is only upserted into the lightweight list, never given a detail entry.
  assert.deepEqual(mergeWorkerEvent({ testRunsById: {}, testRunDetailsById: {}, testRunLogsById: {} }, { type: 'testRun', run: { id: 'r2', projectId: 'p1', status: 'queued' } }), {
    testRunsById: { r2: { id: 'r2', projectId: 'p1', status: 'queued' } },
  });
});

test('testRunLog streams onto a run\'s log only once its detail has been fetched; an unknown run is ignored', () => {
  const unseen = { testRunsById: {}, testRunDetailsById: {}, testRunLogsById: {} };
  assert.deepEqual(mergeWorkerEvent(unseen, { type: 'testRunLog', runId: 'r1', projectId: 'p1', chunk: 'ok\n' }), {}, 'a WS reconnect gap has nothing to append to');

  let state = { testRunsById: {}, testRunDetailsById: {}, testRunLogsById: { r1: 'first line\n' } };
  state = { ...state, ...mergeWorkerEvent(state, { type: 'testRunLog', runId: 'r1', projectId: 'p1', chunk: 'second line\n' }) };
  assert.equal(state.testRunLogsById.r1, 'first line\nsecond line\n');
  state = { ...state, ...mergeWorkerEvent(state, { type: 'testRunLog', runId: 'r1', projectId: 'p1', chunk: 'third line\n' }) };
  assert.equal(state.testRunLogsById.r1, 'first line\nsecond line\nthird line\n');
});

test('testRunRemoved clears the run from every slice, including its log buffer', () => {
  const state = {
    testRunsById: { r1: { id: 'r1', projectId: 'p1', status: 'passed' } },
    testRunDetailsById: { r1: { id: 'r1', status: 'passed' } },
    testRunLogsById: { r1: 'output\n' },
  };
  const patch = mergeWorkerEvent(state, { type: 'testRunRemoved', runId: 'r1', projectId: 'p1' });
  assert.deepEqual(patch, { testRunsById: {}, testRunDetailsById: {}, testRunLogsById: {} });
});

test('loadTestRunDetail seeds both the detail and its live log buffer; a failure reports the error', async () => {
  resetStore();
  let mock = mockFetch(() => ({ body: { id: 't1', projectId: 'p1', status: 'passed', output: 'done\n', result: null } }));
  try {
    const detail = await useWorldStore.getState().loadTestRunDetail('t1');
    assert.equal(detail.status, 'passed');
    assert.equal(useWorldStore.getState().testRunDetailsById.t1.status, 'passed');
    assert.equal(useWorldStore.getState().testRunLogsById.t1, 'done\n');
  } finally {
    mock.restore();
  }
  mock = mockFetch(() => ({ status: 404, body: { error: 'not found' } }));
  try {
    assert.equal(await useWorldStore.getState().loadTestRunDetail('missing'), null);
    assert.equal(reportedError(), 'not found');
  } finally {
    mock.restore();
  }
});

test('startTestingSetup folds the returned run into the store; a failure resolves null with an error reported', async () => {
  resetStore();
  let mock = mockFetch(() => ({ status: 201, body: { existing: false, planItem: { id: 'i1' }, run: run(), queueEntry: null } }));
  try {
    const result = await useWorldStore.getState().startTestingSetup('p1');
    assert.equal(result.run.id, 'run-1');
    assert.deepEqual(useWorldStore.getState().workflowRunsByProject.p1.map((r) => r.id), ['run-1']);
  } finally {
    mock.restore();
  }
  mock = mockFetch(() => ({ status: 201, body: { existing: false, planItem: { id: 'i2' }, run: null, queueEntry: { id: 'q1' } } }));
  try {
    assert.equal((await useWorldStore.getState().startTestingSetup('p1')).queueEntry.id, 'q1');
    assert.equal(reportedError(), null);
  } finally {
    mock.restore();
  }
  mock = mockFetch(() => ({ status: 404, body: { error: 'No executor "x"' } }));
  try {
    assert.equal(await useWorldStore.getState().startTestingSetup('p1'), null);
    assert.equal(reportedError(), 'No executor "x"');
  } finally {
    mock.restore();
  }
});

test('approve, revise and reject apply the returned run, or report the error when refused', async () => {
  resetStore();
  const statuses = { approve: 'running', revise: 'running', reject: 'stopped' };
  const mock = mockFetch((call) => {
    const action = call.url.split('/').at(-1);
    return { body: run({ status: statuses[action], currentStepId: action === 'approve' ? 'implementation' : 'proposal' }) };
  });
  try {
    assert.equal(await useWorldStore.getState().approveTestingSetup('run-1', 1), true);
    assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].currentStepId, 'implementation');
    assert.equal(await useWorldStore.getState().reviseTestingSetup('run-1', 'smaller'), true);
    assert.equal(await useWorldStore.getState().rejectTestingSetup('run-1'), true);
    assert.equal(useWorldStore.getState().workflowRunsByProject.p1[0].status, 'stopped');
  } finally {
    mock.restore();
  }
  const refused = mockFetch(() => ({ status: 409, body: { error: 'nope' } }));
  try {
    for (const action of [() => useWorldStore.getState().approveTestingSetup('run-1', 1), () => useWorldStore.getState().reviseTestingSetup('run-1', 'x'), () => useWorldStore.getState().rejectTestingSetup('run-1')]) {
      assert.equal(await action(), false);
      assert.equal(reportedError(), 'nope');
    }
  } finally {
    refused.restore();
  }
});

// ---- Setup stage and header ----

test('setupStage reads a setup from its run: queued, discovery, the gate, implementing and the rest', () => {
  assert.equal(setupStage(setup(null)), 'queued');
  assert.equal(setupStage(setup({ status: 'running', currentStepId: 'proposal' })), 'discovery');
  assert.equal(setupStage(setup({ status: 'running', currentStepId: 'implementation' })), 'implementing');
  for (const status of ['awaiting-approval', 'needs-attention', 'completing', 'completed', 'failed', 'stopped']) {
    assert.equal(setupStage(setup({ status })), status);
  }
});

test('with no setup, the header offers the entry point for the config state', () => {
  assert.equal(setupModeFor(ABSENT), 'setup');
  assert.deepEqual(setupHeader(ABSENT, null), { cta: { label: 'Set up testing', mode: 'setup' }, status: null });
  assert.deepEqual(setupHeader(VALID, null).cta, { label: 'Reconfigure testing', mode: 'reconfigure' });
  assert.deepEqual(setupHeader(INVALID, null).cta, { label: 'Repair testing', mode: 'repair' });
  assert.deepEqual(setupHeader(null, null), { cta: null, status: null }, 'nothing until the config has loaded');
  assert.deepEqual(SETUP_CTA_LABELS, { setup: 'Set up testing', reconfigure: 'Reconfigure testing', repair: 'Repair testing' });
});

test('an active setup replaces the button with a status line linking to its task', () => {
  const line = (s) => setupHeader(ABSENT, s);
  const queued = line(setup(null));
  assert.equal(queued.cta, null, 'no second setup can be started from here');
  assert.deepEqual([queued.status.badge, queued.status.runId, queued.status.linkLabel], ['Queued', null, 'Open task']);
  assert.match(queued.status.text, /Set up testing is waiting/);
  assert.match(line(setup({ status: 'running', currentStepId: 'proposal' })).status.text, /Nothing can be changed yet/);
  const gate = line(setup({ status: 'awaiting-approval' })).status;
  assert.deepEqual([gate.tone, gate.badge, gate.linkLabel, gate.runId], ['warning', 'Needs your approval', 'Review proposal', 'run-1']);
  assert.equal(line(setup({ status: 'running', currentStepId: 'implementation' })).status.badge, 'In progress');
  assert.equal(line(setup({ status: 'completing', currentStepId: null })).status.badge, 'In progress');
  const attention = line(setup({ status: 'needs-attention', attentionReason: 'unit/run produced no result' })).status;
  assert.deepEqual([attention.tone, attention.text], ['danger', 'unit/run produced no result']);
  assert.match(line(setup({ status: 'failed' })).status.text, /stopped before it finished/);
  assert.equal(line(setup({ status: 'stopped' })).status, null);
});

test('a completed setup shows "Done" with its branch and PR until dismissed, then the button returns', () => {
  const done = setup({ status: 'completed', prUrl: 'https://github.com/o/r/pull/1' }, { active: false });
  const header = setupHeader(VALID, done);
  assert.equal(header.cta, null);
  assert.deepEqual([header.status.badge, header.status.prUrl, header.status.dismissible], ['Done', 'https://github.com/o/r/pull/1', true]);
  assert.match(header.status.text, /pushed to task\/set-up-testing\. It shows here once that branch is merged/);
  assert.match(setupHeader(VALID, setup({ status: 'completed', branch: undefined }, { active: false })).status.text, /^Testing setup finished\.$/);
  assert.deepEqual(setupHeader(VALID, done, 'run-1'), { cta: { label: 'Reconfigure testing', mode: 'reconfigure' }, status: null });
  assert.equal(setupHeader(VALID, setup({ status: 'awaiting-approval' }), 'run-1').status.badge, 'Needs your approval', 'an active setup cannot be dismissed');
});

// ---- Runs, suites and stats ----

test('testRunBadge never shows an errored run as passed, and marks a utility run as log only', () => {
  assert.deepEqual(testRunBadge(testRun({ status: 'error' })), { label: 'Error', variant: 'warning' });
  assert.deepEqual(testRunBadge(testRun({ status: 'failed' })), { label: 'Failed', variant: 'soft-destructive' });
  assert.deepEqual(testRunBadge(testRun({ status: 'queued' })), { label: 'Queued', variant: 'secondary' });
  assert.deepEqual(testRunBadge(testRun({ status: 'running' })), { label: 'Running', variant: 'success' });
  assert.deepEqual(testRunBadge(testRun({ status: 'stopped' })), { label: 'Stopped', variant: 'secondary' });
  assert.deepEqual(testRunBadge(testRun()), { label: 'Passed', variant: 'success' });
  assert.deepEqual(testRunBadge(testRun({ action: { purpose: 'utility' } })), { label: 'Log only', variant: 'secondary' });
});

test('formatDuration and countsText', () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(formatDuration(1234), '1.2s');
  assert.equal(formatDuration(41_200), '41s');
  assert.equal(formatDuration(125_000), '2m 05s');
  assert.equal(countsText(null), null);
  assert.equal(countsText({ total: 4, passed: 2, failed: 1, errored: 1, skipped: 0 }), '2 passed · 1 failed · 1 errored');
  assert.equal(countsText({ total: 4 }), '4 total');
  assert.equal(countsText({}), null);
});

test('suiteCardModel shows the latest result, or the live state of the primary action, and splits its actions', () => {
  const idle = suiteCardModel(suite());
  assert.deepEqual(idle.badge, { label: 'Passed', variant: 'success' });
  assert.equal(idle.counts, '9 passed · 1 skipped');
  assert.equal(idle.duration, '25s');
  assert.equal(idle.where, 'main@a1b2c3d');
  assert.equal(idle.trigger, 'manual');
  assert.deepEqual([idle.runLabel, idle.canRun], ['Run', true]);
  assert.deepEqual(idle.resultActions.map((a) => [a.id, a.primary]), [['run', true], ['cov', false]]);
  assert.deepEqual(idle.utilityActions.map((a) => a.id), ['snap']);

  const runningActions = suite().actions.map((a) => (a.id === 'run' ? { ...a, activeRun: testRun({ id: 'live', status: 'running' }) } : a));
  const running = suiteCardModel(suite({ actions: runningActions }));
  assert.deepEqual([running.badge.label, running.runLabel, running.canRun, running.resultActions[0].enabled], ['Running', 'Running', false, false]);
  const queuedActions = suite().actions.map((a) => (a.id === 'run' ? { ...a, activeRun: testRun({ status: 'queued' }) } : a));
  assert.equal(suiteCardModel(suite({ actions: queuedActions })).runLabel, 'Queued');

  const disabled = suiteCardModel(suite({ enabled: false }));
  assert.deepEqual([disabled.badge.label, disabled.canRun], ['Disabled in config', false]);
  const empty = suiteCardModel(suite({ latestResult: null }));
  assert.deepEqual([empty.badge.label, empty.counts, empty.where, empty.trigger], ['No results yet', null, null, null]);
  assert.equal(suiteCardModel(suite({ latestResult: testRun({ commit: null }) })).where, 'main');
});

test('overviewStats sums each enabled suite\'s latest result, takes the first coverage metric, and counts findings', () => {
  const failing = testRun({ summary: { outcome: 'failed', counts: { total: 86, passed: 83, failed: 3 }, metrics: [{ key: 'p95', value: 212 }], findingCounts: ZERO } });
  const covered = testRun({ summary: { outcome: 'passed', counts: { total: 10, passed: 10 }, metrics: [{ key: 'line-coverage', value: 91.4, unit: '%' }], findingCounts: { ...ZERO, high: 1, medium: 1 } } });
  const stats = overviewStats([
    suite({ id: 'a', label: 'API', latestResult: failing }),
    suite({ id: 'b', label: 'Unit', latestResult: covered }),
    suite({ id: 'c', latestResult: null }),
    suite({ id: 'd', enabled: false, latestResult: covered }),
  ]);
  assert.deepEqual([stats.passed, stats.failed, stats.total, stats.failingSuites], [93, 3, 96, 1]);
  assert.deepEqual(stats.coverage, { value: 91.4, unit: '%', suiteLabel: 'Unit' });
  assert.deepEqual(stats.findings, { ...ZERO, high: 1, medium: 1 });
  assert.equal(overviewStats([]).coverage, null);
  assert.equal(stats.countsReported, true);
  assert.equal(overviewStats([]).countsReported, false, 'no suite at all');
  assert.equal(overviewStats([suite({ latestResult: null })]).countsReported, false, 'never run');
  assert.equal(overviewStats([suite({ latestResult: testRun({ summary: { outcome: 'passed', counts: undefined, metrics: [], findingCounts: ZERO } }) })]).countsReported, false, 'ran, but the collector reported no counts');
});

test('statCards shows exactly 3 cards, "Not reported" (not "0") until a suite has actually reported', () => {
  const never = statCards([]);
  assert.deepEqual(never.map((c) => c.label), ['Passed', 'Failed', 'Coverage']);
  assert.deepEqual(never.map((c) => c.value), ['Not reported', 'Not reported', 'Not reported']);

  const zero = testRun({ summary: { outcome: 'passed', counts: { total: 0, passed: 0, failed: 0 }, metrics: [], findingCounts: ZERO } });
  const reportedZero = statCards([suite({ latestResult: zero })]);
  assert.deepEqual(reportedZero.map((c) => c.value), ['0', '0', 'Not reported'], 'a real reported zero is distinguishable from "nothing reported"');

  const covered = testRun({ summary: { outcome: 'passed', counts: { total: 2, passed: 2 }, metrics: [{ key: 'line-coverage', value: 88, unit: '%' }], findingCounts: ZERO } });
  const populated = statCards([suite({ latestResult: covered }), suite({ id: 'disabled-cov', enabled: false, latestResult: covered })]);
  assert.deepEqual(populated.map((c) => c.value), ['2', '0', '88%'], 'a disabled suite\'s coverage is skipped even if it would otherwise match first');
});

test('runStaleness: stale once the suite or action id is gone from the current valid config, never for a merely-disabled one', () => {
  const run = { suite: { id: 'unit' }, action: { id: 'run' } };
  const validWithBoth = { state: 'valid', path: 'x', config: { schemaVersion: 1, suites: [{ id: 'unit', enabled: true, actions: [{ id: 'run', enabled: true }] }] } };
  assert.deepEqual(runStaleness(run, validWithBoth), { stale: false, reason: null });

  const disabledSuite = { state: 'valid', path: 'x', config: { schemaVersion: 1, suites: [{ id: 'unit', enabled: false, actions: [{ id: 'run', enabled: true }] }] } };
  assert.equal(runStaleness(run, disabledSuite).stale, false, 'disabled is not the same as removed');

  const noSuite = { state: 'valid', path: 'x', config: { schemaVersion: 1, suites: [] } };
  assert.match(runStaleness(run, noSuite).reason, /suite is no longer configured/);

  const noAction = { state: 'valid', path: 'x', config: { schemaVersion: 1, suites: [{ id: 'unit', enabled: true, actions: [] }] } };
  assert.match(runStaleness(run, noAction).reason, /action is no longer configured/);

  assert.equal(runStaleness(run, ABSENT).stale, true);
  assert.equal(runStaleness(run, INVALID).stale, true);
});

test('resultSections renders by what data is present, independent of suite kind', () => {
  assert.deepEqual(resultSections(null), { hasCases: false, hasMetrics: false, hasFindings: false, isEmpty: false });
  assert.deepEqual(resultSections({ cases: [], metrics: [], findings: [] }), { hasCases: false, hasMetrics: false, hasFindings: false, isEmpty: true });
  assert.deepEqual(resultSections({ cases: [{ name: 'a' }], metrics: [], findings: [] }), { hasCases: true, hasMetrics: false, hasFindings: false, isEmpty: false });
  assert.deepEqual(resultSections({ cases: [{ name: 'a' }], metrics: [{ key: 'cov' }], findings: [] }), { hasCases: true, hasMetrics: true, hasFindings: false, isEmpty: false }, 'a coverage run that also reports cases shows both sections');
  assert.deepEqual(resultSections({ cases: [], metrics: [], findings: [{ severity: 'low' }] }), { hasCases: false, hasMetrics: false, hasFindings: true, isEmpty: false });
});

test('sortFindingsBySeverity groups worst-first', () => {
  const findings = [{ title: 'a', severity: 'low' }, { title: 'b', severity: 'critical' }, { title: 'c', severity: 'medium' }, { title: 'd', severity: 'high' }];
  assert.deepEqual(sortFindingsBySeverity(findings).map((f) => f.severity), ['critical', 'high', 'medium', 'low']);
});

test('metricDisplay: the Collector\'s own label/unit first, else the config\'s declared display, else the raw key', () => {
  const config = [{ key: 'line-coverage', label: 'Line coverage', unit: '%', direction: 'higher-is-better' }];
  assert.deepEqual(metricDisplay({ key: 'line-coverage', value: 1 }, config), { label: 'Line coverage', unit: '%' });
  assert.deepEqual(metricDisplay({ key: 'line-coverage', label: 'Own label', unit: 'pts', value: 1 }, config), { label: 'Own label', unit: 'pts' });
  assert.deepEqual(metricDisplay({ key: 'unknown', value: 1 }, config), { label: 'unknown', unit: undefined });
});

test('diagnosticsBanner surfaces every enabled suite\'s missing-report/truncated diagnostic, never a disabled suite\'s stale one', () => {
  const missing = testRun({ diagnostics: [{ code: 'no-report', message: 'no usable report' }] });
  const truncated = testRun({ outputTruncated: true, diagnostics: [] });
  const clean = testRun({ diagnostics: [], outputTruncated: false });
  const entries = diagnosticsBanner([
    suite({ id: 'a', label: 'API', latestResult: missing }),
    suite({ id: 'b', label: 'E2E', latestResult: truncated }),
    suite({ id: 'c', label: 'Unit', latestResult: clean }),
    suite({ id: 'd', label: 'Old', enabled: false, latestResult: missing }),
  ]);
  assert.deepEqual(entries.map((e) => [e.suiteLabel, e.message]), [
    ['API', 'no usable report'],
    ['E2E', 'The log was cut off at its size limit.'],
  ]);
});

test('runAllGuard: disabled with nothing runnable or once the whole batch is already active, otherwise enabled', () => {
  assert.deepEqual(runAllGuard([]), { enabled: false, reason: 'No runnable suites are configured' });
  assert.deepEqual(runAllGuard([suite({ enabled: false })]), { enabled: false, reason: 'No runnable suites are configured' });
  assert.deepEqual(runAllGuard([suite()]), { enabled: true });

  const activeActions = suite().actions.map((a) => (a.id === 'run' ? { ...a, activeRun: testRun({ status: 'running' }) } : a));
  assert.deepEqual(runAllGuard([suite({ actions: activeActions })]), { enabled: false, reason: 'Every suite is already queued or running' });

  // Partial overlap (one suite's primary action already active, another idle) still allows the click —
  // see planningGap: this is the rule Development picked for the split case the spec left open.
  const idle = suite({ id: 'b' });
  assert.deepEqual(runAllGuard([suite({ actions: activeActions }), idle]), { enabled: true });
});

test('runHistoryRow: trigger label, branch/commit context, staleness, and "you"/"agent" never leak undefined', () => {
  const config = { state: 'valid', path: 'x', config: { schemaVersion: 1, suites: [{ id: 'unit', enabled: true, actions: [{ id: 'run', enabled: true }] }] } };
  const manual = runHistoryRow({ ...testRun(), suite: { id: 'unit', label: 'Unit' }, action: { id: 'run', label: 'Run', purpose: 'result' }, startedAt: '2024-01-01T00:00:00.000Z', queuedAt: '2024-01-01T00:00:00.000Z' }, config, new Date('2024-01-01T00:10:00.000Z'));
  assert.deepEqual([manual.triggerLabel, manual.context, manual.isUtility, manual.stale], ['you', 'main@a1b2c3d', false, { stale: false, reason: null }]);
  assert.match(manual.startedLabel, /10m ago/);

  const agentNoGit = runHistoryRow({ ...testRun({ trigger: 'agent', branch: null, commit: null, taskId: 't1' }), suite: { id: 'unit', label: 'Unit' }, action: { id: 'snap', label: 'Update snapshots', purpose: 'utility' } }, config);
  assert.deepEqual([agentNoGit.triggerLabel, agentNoGit.context, agentNoGit.isUtility], ['agent', null, true]);

  const removedSuite = runHistoryRow({ ...testRun(), suite: { id: 'gone', label: 'Gone' }, action: { id: 'run', label: 'Run', purpose: 'result' } }, config);
  assert.equal(removedSuite.stale.stale, true);
});

test('lastTaskSignature changes only when the project\'s own most recent Task actually changes', () => {
  const tasksById = { t1: { status: 'developing', updatedAt: '2024-01-01T00:00:00.000Z' } };
  const lastTaskIdByProject = { p1: 't1' };
  const before = lastTaskSignature(tasksById, lastTaskIdByProject, 'p1');
  assert.equal(before, 't1:developing:2024-01-01T00:00:00.000Z');
  assert.equal(lastTaskSignature(tasksById, lastTaskIdByProject, 'p2'), '', 'no task tracked for this project yet');
  const done = { ...tasksById, t1: { status: 'done', updatedAt: '2024-01-01T00:05:00.000Z' } };
  assert.notEqual(lastTaskSignature(done, lastTaskIdByProject, 'p1'), before);
});

test('approvalDecision: blank/whitespace approves the round shown, anything else requests changes with the trimmed text', () => {
  assert.deepEqual(approvalDecision('', 2), { kind: 'approve', round: 2 });
  assert.deepEqual(approvalDecision('   \n ', 3), { kind: 'approve', round: 3 });
  assert.deepEqual(approvalDecision('  please add e2e  ', 1), { kind: 'request-changes', comment: 'please add e2e' });
});

test('sortCasesFailedFirst keeps failures (and errors) first, in their own order', () => {
  const cases = [{ name: 'a', outcome: 'passed' }, { name: 'b', outcome: 'failed' }, { name: 'c', outcome: 'skipped' }, { name: 'd', outcome: 'error' }];
  assert.deepEqual(sortCasesFailedFirst(cases).map((c) => c.name), ['b', 'd', 'a', 'c']);
});

test('testRunsSignature changes only when one of this project\'s runs changes', () => {
  const runs = { r1: { id: 'r1', projectId: 'p1', status: 'running' }, r2: { id: 'r2', projectId: 'p2', status: 'queued' } };
  const before = testRunsSignature(runs, 'p1');
  assert.equal(before, 'r1:running');
  assert.equal(testRunsSignature({ ...runs, r2: { ...runs.r2, status: 'passed' } }, 'p1'), before);
  assert.notEqual(testRunsSignature({ ...runs, r1: { ...runs.r1, status: 'passed' } }, 'p1'), before);
});

// ---- Approval gate and evidence ----

test('isSetupProposalGate applies only to a testing setup paused on its read-only approval step', () => {
  const proposal = { id: 'proposal', canEditCode: false, requiresApproval: true };
  const gateRun = run({ status: 'awaiting-approval', currentStepId: 'proposal' });
  assert.equal(isSetupProposalGate(gateRun, proposal), true);
  assert.equal(isSetupProposalGate({ ...gateRun, testingSetup: undefined }, proposal), false, 'an ordinary run');
  assert.equal(isSetupProposalGate({ ...gateRun, status: 'running' }, proposal), false);
  assert.equal(isSetupProposalGate(gateRun, { ...proposal, canEditCode: true }), false);
  assert.equal(isSetupProposalGate(gateRun, { ...proposal, requiresApproval: false }), false);
  assert.equal(isSetupProposalGate(gateRun, { ...proposal, id: 'other' }), false, 'a stage other than the one paused');
  assert.equal(isSetupProposalGate(gateRun, undefined), false);
});

test('evidenceRows: pending before any check, then the config row and one row per primary action', () => {
  assert.deepEqual(evidenceRows(null).map((r) => r.state), ['pending']);
  const rows = evidenceRows({
    ok: false, checkedAt: 't', config: { state: 'valid', suiteCount: 2, issues: [] }, problems: ['api/run ended error: no junit'],
    actions: [
      { suiteId: 'unit', actionId: 'run', runId: 'r1', status: 'passed', counts: { passed: 12, failed: 0 }, problem: null },
      { suiteId: 'api', actionId: 'run', runId: 'r2', status: 'error', counts: null, problem: 'api/run ended error: no junit' },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.label, r.state, r.detail]), [
    ['config.json contract', 'ok', 'valid · 2 suite(s)'],
    ['unit/run', 'ok', 'passed · 12 passed · 0 failed'],
    ['api/run', 'problem', 'api/run ended error: no junit'],
  ]);
  const invalid = evidenceRows({ ok: false, checkedAt: 't', config: { state: 'invalid', suiteCount: 0, issues: [] }, problems: ['config is broken'], actions: [] });
  assert.deepEqual(invalid.map((r) => [r.state, r.detail]), [['problem', 'config is broken']]);
  assert.equal(evidenceRows({ ok: false, checkedAt: 't', config: { state: 'absent', suiteCount: 0, issues: [] }, problems: [], actions: [] })[0].detail, 'config is absent');
  const none = evidenceRows({ ok: true, checkedAt: 't', config: { state: 'valid', suiteCount: 0, issues: [] }, problems: [], actions: [] });
  assert.deepEqual(none.map((r) => r.detail), ['valid · 0 suite(s)', 'No suites configured.']);
});
