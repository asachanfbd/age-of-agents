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

const yard = await import('../src/lib/villageYard.ts');
const { PLANNING_LIVE_DOT, PLANNING_LIVE_TITLE } = await import('../src/lib/projectTasks.ts');
const { buildingBadge, lookFor, GENERIC_LOOK_COLOR, SOFTWARE_LOOK } = await import('../src/lib/buildingTypes.ts');
const {
  buildYardModel, mergeStatus, mergeHint, mergeTooltip, taskTooltip, taskTitleLine, truncate, TITLE_LIMIT, machineElapsed,
  msUntilNextMinute, machineTooltip, planningTooltip, compareWork, assignSlots, layoutYard, overflowText, hiddenWorkCounts,
  yardTransitions, workspaceTotals, openYardTarget, taskKey, sameYardCommandRuns, sameYardTestRuns, projectRuns,
  pendingStack, pendingTooltip, stackChange, pickUpDelay, pickUpOrder, survivingTransit, yardTargetOf, isYardClick,
} = yard;
const { pendingOnlyView, PENDING_ONLY_EMPTY } = await import('../src/lib/taskBoard.ts');
const { buildPlanningQueue } = await import('../src/lib/projectTasks.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { CRATE_CAP } = await import('../src/lib/villageLayout.ts');

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString();
const usage = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });

const STEP_NAMES = ['Planning', 'Test Case Planning', 'UI Planning', 'Development', 'Code Review', 'QA', 'Sign-off'];
const SNAPSHOT = { id: 'wf', name: 'Software', description: '', enabled: true, steps: STEP_NAMES.map((name, i) => ({ id: `s${i + 1}`, name, agentId: 'a', instructions: '', canEditCode: true, requiresApproval: false })) };

const task = (id, patch = {}) => ({
  id, projectId: 'p1', executorId: 'exec', executionMode: 'terminal', description: id, status: 'developing', kind: 'execute', planItemId: null,
  sessionId: null, blockedQuestion: null, failureReason: null, tokenUsage: usage(), createdAt: minutesAgo(30), updatedAt: minutesAgo(30), completedAt: null, ...patch,
});
const item = (id, patch = {}) => ({ id, projectId: 'p1', title: `13.0${id.slice(-2).padStart(2, '0')}: Task ${id}`, description: '', status: 'pending', order: 0, taskIds: [], executorId: null, createdAt: minutesAgo(600), updatedAt: minutesAgo(600), ...patch });
const wfRun = (id, planItemId, patch = {}) => ({
  id, projectId: 'p1', planItemId, workflowId: 'wf', workflowSnapshot: SNAPSHOT, status: 'running', currentStepId: 's4', branch: 'feature/x', baseBranch: 'main',
  executorId: 'exec', prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0,
  currentStepProgress: { done: 1, total: 3, estimate: null, currentLabel: 'writing code' }, createdAt: minutesAgo(40), updatedAt: minutesAgo(1), completedAt: null, ...patch,
});
const autoMerge = (state, patch = {}) => ({ enabled: true, state, reasons: [], warnings: [], prNumber: 118, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: minutesAgo(1), ...patch });

/** A task with one Task and (unless `run: null`) its own WorkflowRun. */
function started(id, { itemPatch = {}, runPatch = {}, taskPatch = {}, run = true, startedMinutesAgo = 30 } = {}) {
  const t = task(`t-${id}`, { planItemId: id, createdAt: minutesAgo(startedMinutesAgo), ...taskPatch });
  const it = item(id, { status: 'developing', taskIds: [t.id], workflowRunId: run ? `r-${id}` : null, ...itemPatch });
  return { item: it, task: t, run: run ? wfRun(`r-${id}`, id, runPatch) : null };
}

function sources(entries, extra = {}) {
  return {
    projectId: 'p1',
    items: entries.map((e) => e.item),
    tasksById: Object.fromEntries(entries.flatMap((e) => (e.task ? [[e.task.id, e.task]] : [])).concat(Object.entries(extra.tasksById ?? {}))),
    taskIds: extra.taskIds ?? entries.flatMap((e) => (e.task ? [e.task.id] : [])),
    workflowRuns: entries.flatMap((e) => (e.run ? [e.run] : [])),
    commandRuns: extra.commandRuns ?? [],
    testRuns: extra.testRuns ?? [],
    ...(extra.override ?? {}),
  };
}
const model = (entries, extra) => buildYardModel(sources(entries, extra));
const areaOf = (m, id) => (m.work.some((w) => w.key === taskKey(id)) ? 'work' : m.merge.some((w) => w.key === taskKey(id)) ? 'merge' : null);
const boxOf = (m, id) => m.work.find((w) => w.key === taskKey(id));

// ---- Which tasks get a work box ----

test('U01 a run that is starting, running or completing is a Running box', () => {
  for (const status of ['starting', 'running', 'completing']) {
    const m = model([started('i1', { runPatch: { status } })]);
    assert.equal(boxOf(m, 'i1')?.state, 'running', status);
  }
});

test('U02 a run awaiting approval or needing attention, or a pre-workflow blocked task, is Needs you', () => {
  for (const status of ['awaiting-approval', 'needs-attention']) {
    assert.equal(boxOf(model([started('i1', { itemPatch: { status: 'blocked' }, runPatch: { status } })]), 'i1')?.state, 'needs-you', status);
  }
  const preWorkflow = started('i2', { run: false, itemPatch: { status: 'blocked' }, taskPatch: { status: 'blocked' } });
  assert.equal(boxOf(model([preWorkflow]), 'i2')?.state, 'needs-you');
});

test('U03 a failed run is a Stopped/Failed box saying Failed; a stopped run one saying Stopped', () => {
  const failed = boxOf(model([started('i1', { itemPatch: { status: 'failed' }, runPatch: { status: 'failed' } })]), 'i1');
  assert.equal(failed.state, 'stopped');
  assert.deepEqual(failed.tooltip.status, { text: 'Failed', tone: 'red' });
  const stopped = boxOf(model([started('i1', { itemPatch: { status: 'stopped' }, runPatch: { status: 'stopped' } })]), 'i1');
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.tooltip.status, { text: 'Stopped', tone: 'red' });
});

test('U04 a freeform task that failed or was stopped (no run) is a Stopped/Failed box', () => {
  const failed = started('i1', { run: false, itemPatch: { status: 'failed' }, taskPatch: { status: 'failed', executionMode: 'structured' } });
  assert.equal(boxOf(model([failed]), 'i1')?.tooltip.status.text, 'Failed');
  const stopped = started('i2', { run: false, itemPatch: { status: 'stopped' }, taskPatch: { status: 'stopped', executionMode: 'structured' } });
  assert.equal(boxOf(model([stopped]), 'i2')?.tooltip.status.text, 'Stopped');
});

test('U05 tasks not started (to do, ready, waiting for their parents) get no box', () => {
  const todo = { item: item('i1'), task: null, run: null };
  const waiting = { item: item('i2', { waiting: { options: {}, state: 'waiting', reasons: [], since: minutesAgo(5), longWaitNotified: false, updatedAt: minutesAgo(5) } }), task: null, run: null };
  const m = model([todo, waiting]);
  assert.deepEqual(m.work, []);
  assert.deepEqual(m.merge, []);
});

test('U06 an archived item is in no area whatever its state', () => {
  const running = started('i1', { itemPatch: { archived: true } });
  const failed = started('i2', { itemPatch: { archived: true, status: 'failed' }, runPatch: { status: 'failed' } });
  const waiting = started('i3', { itemPatch: { archived: true, status: 'done', pullRequest: { state: 'open', prNumber: 4, readAt: minutesAgo(1) } }, runPatch: { status: 'completed' } });
  const m = model([running, failed, waiting]);
  assert.deepEqual([m.work, m.merge, Object.keys(m.exits)], [[], [], []]);
});

test('U07 a deleted item (gone from the plan) shows nothing, even if its run is still listed', () => {
  const gone = started('i1');
  const m = buildYardModel({ ...sources([gone]), items: [] });
  assert.deepEqual([m.work, m.merge], [[], []]);
});

test('U08 a paused task (stopped, resumable, no live run) gets no box', () => {
  const paused = started('i1', { run: false, itemPatch: { status: 'stopped' }, taskPatch: { status: 'stopped', executionMode: 'terminal', sessionId: 'sess' } });
  assert.deepEqual(model([paused]).work, []);
});

test('U09 planning sessions never produce task boxes', () => {
  const plan = task('plan-1', { kind: 'plan', planningSessionNumber: 3 });
  const m = model([], { tasksById: { [plan.id]: plan }, taskIds: [plan.id] });
  assert.deepEqual(m.work, []);
  assert.equal(m.planning.length, 1);
});

test('U10 a retry (failed → running) keeps the entity key task:<itemId> and becomes Running', () => {
  const before = model([started('i1', { itemPatch: { status: 'failed' }, runPatch: { status: 'failed' } })]);
  const after = model([started('i1')]);
  assert.equal(before.work[0].key, 'task:i1');
  assert.equal(after.work[0].key, 'task:i1');
  assert.equal(after.work[0].state, 'running');
});

test('U11 Running → Needs you → Running keeps the same key and entity', () => {
  const keys = ['running', 'awaiting-approval', 'running'].map((status) => model([started('i1', { runPatch: { status } })]).work[0].key);
  assert.deepEqual(keys, ['task:i1', 'task:i1', 'task:i1']);
});

// ---- Merge-wait rule ----

const finished = (id, itemPatch = {}, runPatch = {}) => started(id, { itemPatch: { status: 'done', ...itemPatch }, runPatch: { status: 'completed', completedAt: minutesAgo(5), ...runPatch } });

test('U12 Auto-merge off, finished, PR open → merge-waiting with the PR number', () => {
  const m = model([finished('i1', { pullRequest: { state: 'open', prNumber: 115, readAt: minutesAgo(1) } })]);
  assert.equal(m.merge[0].key, 'task:i1');
  assert.equal(m.merge[0].prNumber, 115);
  assert.deepEqual(m.work, []);
});

test('U13 Auto-merge off, PR merged → not waiting, carried in', () => {
  const m = model([finished('i1', { pullRequest: { state: 'merged', prNumber: 115, readAt: minutesAgo(1) } })]);
  assert.deepEqual(m.merge, []);
  assert.equal(m.exits['task:i1'], 'carry-in');
});

test('U14 Auto-merge off, PR closed → not waiting, leaves quietly', () => {
  const m = model([finished('i1', { pullRequest: { state: 'closed', prNumber: 115, readAt: minutesAgo(1) } })]);
  assert.deepEqual(m.merge, []);
  assert.equal(m.exits['task:i1'], 'quiet');
});

test('U15 Auto-merge off, no reading or a "none" reading → no PR, not waiting', () => {
  assert.equal(model([finished('i1')]).exits['task:i1'], 'carry-in');
  assert.equal(model([finished('i1', { pullRequest: { state: 'none', prNumber: null, readAt: minutesAgo(1) } })]).exits['task:i1'], 'carry-in');
});

test('U16 Auto-merge on: every state in which the PR is still unmerged is waiting (8 states)', () => {
  for (const state of ['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent', 'failed', 'cannot-merge']) {
    const m = model([finished('i1', { autoMerge: autoMerge(state) })]);
    assert.equal(m.merge.length, 1, state);
    assert.equal(m.merge[0].autoMerge, true, state);
  }
});

test('U17 Auto-merge on, merged → carried in', () => {
  assert.equal(model([finished('i1', { autoMerge: autoMerge('merged') })]).exits['task:i1'], 'carry-in');
});

test('U18 Auto-merge on, no PR → carried in, not waiting', () => {
  const m = model([finished('i1', { autoMerge: autoMerge('no-pr', { prNumber: null }) })]);
  assert.deepEqual(m.merge, []);
  assert.deepEqual(m.work, [], 'not a Needs-you box either');
  assert.equal(m.exits['task:i1'], 'carry-in');
});

test('U19 Auto-merge on, can\'t merge because "This PR is closed" → quiet exit', () => {
  const m = model([finished('i1', { autoMerge: autoMerge('cannot-merge', { reasons: ['This PR is closed'] }) })]);
  assert.deepEqual(m.merge, []);
  assert.equal(m.exits['task:i1'], 'quiet');
});

test('U20 a PR open while the run is still running → a work box, not merge-waiting', () => {
  const m = model([started('i1', { itemPatch: { pullRequest: { state: 'open', prNumber: 3, readAt: minutesAgo(1) } } })]);
  assert.equal(areaOf(m, 'i1'), 'work');
  assert.deepEqual(mergeStatus(m.work[0] && started('i1').item, started('i1').run), { kind: 'working' });
});

test('U21 a run on the Project\'s own branch (no branch/base branch) that completed never waits', () => {
  const ownBranch = finished('i1', { pullRequest: { state: 'open', prNumber: 3, readAt: minutesAgo(1) } }, { branch: undefined, baseBranch: undefined });
  const m = model([ownBranch]);
  assert.deepEqual(m.merge, []);
  assert.equal(m.exits['task:i1'], 'carry-in');
});

test('U22 conflict runs and testing setups never wait to merge', () => {
  const conflict = finished('i1', { prConflict: { number: 9, title: 't', headBranch: 'h', baseBranch: 'main', pushRemote: 'origin' }, pullRequest: { state: 'open', prNumber: 9, readAt: minutesAgo(1) } });
  const setup = finished('i2', { testingSetup: { mode: 'create' }, autoMerge: autoMerge('waiting') });
  const m = model([conflict, setup]);
  assert.deepEqual(m.merge, []);
});

test('U23 Auto-merge failed / can\'t merge: the board says Needs you, the yard shows merge-wait only (never also a box)', () => {
  for (const state of ['failed', 'cannot-merge']) {
    const m = model([finished('i1', { autoMerge: autoMerge(state, { reasons: ['Your account can\'t merge in this repository'] }) })]);
    assert.equal(areaOf(m, 'i1'), 'merge', state);
    assert.equal(m.work.length, 0, state);
  }
});

// ---- Merge hint ----

test('U24 resolving conflicts → "Conflicts"', () => {
  assert.equal(mergeHint(autoMerge('resolving')), 'Conflicts');
});

test('U25 blocked with failing checks → "Checks failing"', () => {
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['Checks are failing: lint, unit'] })), 'Checks failing');
});

test('U26 a review required or changes requested → "Review required"', () => {
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['A review is required'] })), 'Review required');
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['Changes were requested'] })), 'Review required');
});

test('U27 out of date with its base → "Behind base"', () => {
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['The branch is out of date with its base'] })), 'Behind base');
});

test('U28 blocked by anything else → "Blocked"', () => {
  for (const reason of ['This PR is a draft', 'The base branch\'s protection rules are not satisfied', 'Checks are still running: ci', 'Merge state is not known yet']) {
    assert.equal(mergeHint(autoMerge('blocked', { reasons: [reason] })), 'Blocked', reason);
  }
  assert.equal(mergeHint(autoMerge('blocked')), 'Blocked', 'no reasons at all');
});

test('U29 several reasons: Checks failing > Review required > Behind base > Blocked', () => {
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['The branch is out of date with its base', 'A review is required', 'Checks are failing: x'] })), 'Checks failing');
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['The branch is out of date with its base', 'Changes were requested'] })), 'Review required');
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['This PR is a draft', 'The branch is out of date with its base'] })), 'Behind base');
});

test('U30 no hint for other states, or with Auto-merge off', () => {
  for (const state of ['waiting', 'merging', 'provider', 'agent', 'failed', 'cannot-merge']) assert.equal(mergeHint(autoMerge(state, { reasons: ['Checks are failing'] })), null, state);
  assert.equal(mergeHint(undefined), null);
  assert.equal(mergeHint(autoMerge('blocked', { enabled: false, reasons: ['Checks are failing'] })), null);
});

test('U31 matching is a case-sensitive prefix', () => {
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['checks are failing'] })), 'Blocked');
  assert.equal(mergeHint(autoMerge('blocked', { reasons: ['Note: Checks are failing'] })), 'Blocked');
});

// ---- Merge-wait tooltip ----

test('U32 the merge tooltip: title, PR number with the hint, Auto-merge on', () => {
  const m = model([finished('i1', { title: '12.021: Footer clock', autoMerge: autoMerge('blocked', { reasons: ['Checks are failing'] }) })]);
  assert.deepEqual(mergeTooltip(m.merge[0]), { title: '#12.021 Footer clock', pr: 'PR #118 · Checks failing', autoMerge: 'Auto-merge on' });
});

test('U33 Auto-merge off with no hint → "Waiting to be merged", Auto-merge off', () => {
  assert.deepEqual(mergeTooltip({ title: 't', prNumber: 115, hint: null, autoMerge: false }), { title: 't', pr: 'PR #115 · Waiting to be merged', autoMerge: 'Auto-merge off' });
});

test('U34 an unknown PR number shows no "PR #"', () => {
  assert.equal(mergeTooltip({ title: 't', prNumber: null, hint: null, autoMerge: false }).pr, 'Waiting to be merged');
});

test('U35 a huge PR number prints in full', () => {
  assert.equal(mergeTooltip({ title: 't', prNumber: 9007199254740991, hint: null, autoMerge: true }).pr, 'PR #9007199254740991 · Waiting to be merged');
});

// ---- Task tooltip ----

test('U36 a Running tooltip: number and title, step and summary, step N of M', () => {
  const m = model([started('i1', { itemPatch: { title: '13.002: Sidebar polish' } })]);
  assert.deepEqual(m.work[0].tooltip, { title: '#13.002 Sidebar polish', status: null, step: 'Development · writing code', position: 'step 4 of 7' });
});

test('U37 a Needs-you tooltip says "Waiting for you" (amber) right after the title', () => {
  const m = model([started('i1', { runPatch: { status: 'awaiting-approval' } })]);
  assert.deepEqual(m.work[0].tooltip.status, { text: 'Waiting for you', tone: 'amber' });
});

test('U38 a Stopped/Failed tooltip has a red status chip with its word', () => {
  const tip = taskTooltip('13.001: X', 'stopped', wfRun('r', 'i'), 'Failed');
  assert.deepEqual(tip.status, { text: 'Failed', tone: 'red' });
});

test('U39 an unknown summary (null, blank, whitespace) shows the step name only', () => {
  for (const currentLabel of [null, '', '   ', undefined]) {
    const tip = taskTooltip('X', 'running', wfRun('r', 'i', { currentStepProgress: { done: 0, total: 1, estimate: null, currentLabel } }));
    assert.equal(tip.step, 'Development', String(currentLabel));
  }
  assert.equal(taskTooltip('X', 'running', wfRun('r', 'i', { currentStepProgress: null })).step, 'Development');
});

test('U40 an unknown step position → no "step N of M" (never "step 0 of M")', () => {
  assert.equal(taskTooltip('X', 'running', wfRun('r', 'i', { currentStepId: null })).position, null);
  assert.equal(taskTooltip('X', 'running', wfRun('r', 'i', { currentStepId: 'gone' })).position, null);
  assert.equal(taskTooltip('X', 'running', wfRun('r', 'i', { currentStepId: 'gone' })).step, null);
});

test('U41 no workflow steps known (no run) → title only, plus "Waiting for you" for Needs you', () => {
  assert.deepEqual(taskTooltip('13.004: Free', 'running', null), { title: '#13.004 Free', status: null, step: null, position: null });
  assert.deepEqual(taskTooltip('13.004: Free', 'needs-you', null).status, { text: 'Waiting for you', tone: 'amber' });
});

test('U42 titles cut at the limit with an ellipsis, never splitting an emoji', () => {
  const exact = 'a'.repeat(TITLE_LIMIT);
  assert.equal(truncate(exact), exact);
  const over = truncate('a'.repeat(TITLE_LIMIT + 1));
  assert.equal([...over].length, TITLE_LIMIT);
  assert.ok(over.endsWith('…'));
  assert.equal([...truncate('x'.repeat(10_000))].length, TITLE_LIMIT);
  const emoji = truncate('😀'.repeat(TITLE_LIMIT + 5));
  assert.equal([...emoji].length, TITLE_LIMIT);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji));
});

test('U43 the number comes from splitTaskNumber; two identical titles differ by number', () => {
  assert.equal(taskTitleLine('Fix login'), 'Fix login');
  assert.notEqual(taskTitleLine('13.001: Fix login'), taskTitleLine('13.002: Fix login'));
  assert.equal(taskTitleLine('B.004: A bug'), '#B.004 A bug');
});

test('U44 step N of M: 1-based index in the snapshot, skipped steps counted', () => {
  assert.equal(taskTooltip('X', 'running', wfRun('r', 'i', { currentStepId: 's1' })).position, 'step 1 of 7');
  assert.equal(taskTooltip('X', 'running', wfRun('r', 'i', { currentStepId: 's7' })).position, 'step 7 of 7');
});

test('U45 the summary is the run summary\'s currentLabel, and a live update replaces it', () => {
  const before = model([started('i1')]).work[0].tooltip.step;
  const after = model([started('i1', { runPatch: { currentStepProgress: { done: 2, total: 3, estimate: null, currentLabel: 'running tests' } } })]).work[0].tooltip.step;
  assert.deepEqual([before, after], ['Development · writing code', 'Development · running tests']);
});

// ---- Command machines ----

const commandRun = (id, patch = {}) => ({ id, projectId: 'p1', commandId: 'c', commandName: 'npm run build', commandText: 'npm run build', origin: 'saved', location: { kind: 'main' }, status: 'running', exitCode: null, output: '', startedAt: minutesAgo(63), completedAt: null, ...patch });
const testRun = (id, patch = {}) => ({ id, projectId: 'p1', batchId: null, suite: { id: 'web', label: 'Web', kind: 'unit' }, action: { id: 'tests', label: 'Run tests' }, trigger: 'manual', taskId: null, executionRoot: '/x', cwd: null, branch: null, commit: null, status: 'running', exitCode: null, queuedAt: minutesAgo(5), startedAt: minutesAgo(4), completedAt: null, durationMs: null, outputTruncated: false, summary: null, diagnostics: [], artifactDir: null, ...patch });
const machines = (extra, entries = []) => model(entries, extra).commands;

test('U46 a running saved or ad hoc command run is a Command machine', () => {
  const m = machines({ commandRuns: [commandRun('c1'), commandRun('c2', { origin: 'adhoc' })] });
  assert.deepEqual(m.map((w) => [w.key, w.runKind]), [['command:c1', 'command'], ['command:c2', 'command']]);
});

test('U47 a sync run is never a machine', () => {
  assert.deepEqual(machines({ commandRuns: [commandRun('c1', { origin: 'sync' }), commandRun('c2', { origin: 'sync', status: 'failed', failureUnopened: true })] }), []);
});

test('U48 a running test run is a Test run machine named suite: action; a queued one is not', () => {
  const m = machines({ testRuns: [testRun('t1'), testRun('t2', { status: 'queued', startedAt: null })] });
  assert.equal(m.length, 1);
  assert.equal(m[0].name, 'Web: Run tests');
  assert.equal(machineTooltip(m[0], NOW).kindLabel, 'Test run');
});

test('U49 successful and stopped runs leave no machine', () => {
  const m = machines({
    commandRuns: [commandRun('c1', { status: 'success' }), commandRun('c2', { status: 'stopped' })],
    testRuns: [testRun('t1', { status: 'passed' }), testRun('t2', { status: 'stopped' })],
  });
  assert.deepEqual(m, []);
});

test('U50 a failed command, or errored test run, with its log unopened → a red machine', () => {
  const m = machines({
    commandRuns: [commandRun('c1', { status: 'failed', failureUnopened: true, completedAt: minutesAgo(60) })],
    testRuns: [testRun('t2', { status: 'error', failureUnopened: true })],
  });
  assert.deepEqual(m.map((w) => [w.key, w.failed]), [['command:c1', true], ['test:t2', true]]);
});

test('U50b a test run whose tests failed (status failed) is a normal result, not a red machine', () => {
  assert.deepEqual(machines({ testRuns: [testRun('t1', { status: 'failed', failureUnopened: true })] }), []);
});

test('U51 a failed run whose log was opened (flag cleared) → no machine', () => {
  assert.deepEqual(machines({ commandRuns: [commandRun('c1', { status: 'failed' })], testRuns: [testRun('t1', { status: 'failed' })] }), []);
});

test('U52 a failed run recorded before the flag existed counts as opened', () => {
  const legacy = commandRun('c1', { status: 'failed' });
  delete legacy.failureUnopened;
  assert.deepEqual(machines({ commandRuns: [legacy] }), []);
});

test('U53 a red run clears when its task is archived or deleted; a main-checkout one stays', () => {
  const live = started('i1');
  const archived = { ...started('i2'), item: { ...started('i2').item, archived: true } };
  const taskRun = (id, planItemId) => commandRun(id, { status: 'failed', failureUnopened: true, location: { kind: 'task', workflowRunId: 'r', planItemId, branch: null, taskRef: null } });
  const testFor = (id, taskId) => testRun(id, { status: 'error', failureUnopened: true, taskId });
  const ghostTask = task('t-ghost', { planItemId: 'deleted-item' });
  const m = machines({
    commandRuns: [taskRun('c-live', 'i1'), taskRun('c-archived', 'i2'), taskRun('c-deleted', 'nope'), commandRun('c-main', { status: 'failed', failureUnopened: true })],
    testRuns: [testFor('t-live', live.task.id), testFor('t-archived', archived.task.id), testFor('t-ghost', ghostTask.id), testFor('t-gone', 'never-existed')],
    tasksById: { [ghostTask.id]: ghostTask },
  }, [live, archived]);
  assert.deepEqual(m.map((w) => w.key).sort(), ['command:c-live', 'command:c-main', 'test:t-live']);
});

test('U54 a run that failed before the page loaded and is still unopened is shown', () => {
  assert.equal(machines({ commandRuns: [commandRun('c1', { status: 'failed', failureUnopened: true, startedAt: minutesAgo(2000), completedAt: minutesAgo(1999) })] }).length, 1);
});

test('U55 SEO jobs are never machines (they are not command or test runs)', () => {
  const s = sources([]);
  assert.ok(!('seoJobsById' in s));
  const m = buildYardModel({ ...s, seoJobsById: { j: { id: 'j', status: 'running' } } });
  assert.deepEqual([m.work, m.commands], [[], []]);
});

test('U56 another Project\'s runs never appear in this yard', () => {
  assert.deepEqual(machines({ commandRuns: [commandRun('c1', { projectId: 'p2' })], testRuns: [testRun('t1', { projectId: 'p2' })] }), []);
});

test('a streamed log chunk changes nothing the yard reads; a status, flag or location change does', () => {
  const before = [commandRun('c1'), commandRun('c2')];
  assert.equal(sameYardCommandRuns(before, [before[0], { ...before[1], output: 'line 1\nline 2' }]), true, 'output is ignored');
  assert.equal(sameYardCommandRuns(before, [before[0], { ...before[1], status: 'failed', failureUnopened: true }]), false);
  assert.equal(sameYardCommandRuns(before, [before[0], { ...before[1], location: { kind: 'task', workflowRunId: 'r', planItemId: 'i1', branch: null, taskRef: null } }]), false);
  assert.equal(sameYardCommandRuns(before, [before[0]]), false, 'a run leaving changes the list');
  const tests = [testRun('t1')];
  assert.equal(sameYardTestRuns(tests, [{ ...tests[0], diagnostics: [{ code: 'x', message: 'y' }], summary: { passed: 3 } }]), true, 'progress fields are ignored');
  assert.equal(sameYardTestRuns(tests, [{ ...tests[0], status: 'error', failureUnopened: true }]), false);
  assert.equal(sameYardTestRuns(tests, [{ ...tests[0], action: { ...tests[0].action, label: 'Lint' } }]), false);
});

test('projectRuns selects one Project\'s runs, or every run for the totals strip', () => {
  const byId = { a: commandRun('a'), b: commandRun('b', { projectId: 'p2' }) };
  assert.deepEqual(projectRuns(byId, 'p1').map((r) => r.id), ['a']);
  assert.deepEqual(projectRuns(byId, null).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(projectRuns({}, 'p1'), []);
});

test('U57 machine tooltips: "Running · 1h 3m" and "Failed after 2m"', () => {
  const [running] = machines({ commandRuns: [commandRun('c1')] });
  assert.deepEqual(machineTooltip(running, NOW), { title: 'npm run build', kindLabel: 'Command', status: 'Running · 1h 3m', failed: false });
  const [failed] = machines({ commandRuns: [commandRun('c1', { status: 'failed', failureUnopened: true, startedAt: minutesAgo(10), completedAt: minutesAgo(8) })] });
  assert.equal(machineTooltip(failed, NOW).status, 'Failed after 2m');
});

// ---- Elapsed time, no seconds ----

test('U58 under a minute reads "<1m"', () => {
  for (const ms of [0, 1, 59_999]) assert.equal(machineElapsed(ms), '<1m');
});

test('U59 minutes and hours', () => {
  assert.equal(machineElapsed(60_000), '1m');
  assert.equal(machineElapsed(61 * 60_000), '1h 1m');
  assert.equal(machineElapsed(121 * 60_000), '2h 1m');
  assert.equal(machineElapsed(120 * 60_000), '2h 0m');
});

test('U60 a day or more is hours only', () => {
  assert.equal(machineElapsed((26 * 60 + 5) * 60_000), '26h 5m');
});

test('U61 a future, missing or unreadable start reads "<1m"', () => {
  for (const startedAt of [minutesAgo(-5), null, 'not a date']) {
    assert.equal(machineTooltip({ kind: 'command', key: 'k', runKind: 'command', runId: 'r', name: 'n', failed: false, startedAt, completedAt: null }, NOW).status, 'Running · <1m');
  }
});

test('U62 a start at the epoch gives a large finite hour count; one in 9999 reads "<1m"', () => {
  const tip = (startedAt) => machineTooltip({ kind: 'command', key: 'k', runKind: 'command', runId: 'r', name: 'n', failed: false, startedAt, completedAt: null }, NOW).status;
  assert.match(tip('1970-01-01T00:00:00Z'), /^Running · \d+h \d+m$/);
  assert.doesNotMatch(tip('1970-01-01T00:00:00Z'), /NaN|e\+/);
  assert.equal(tip('9999-12-31T00:00:00Z'), 'Running · <1m');
});

test('U63 a failed run with no completion time just says "Failed"', () => {
  assert.equal(machineTooltip({ kind: 'command', key: 'k', runKind: 'command', runId: 'r', name: 'n', failed: true, startedAt: minutesAgo(3), completedAt: null }, NOW).status, 'Failed');
});

test('U64 msUntilNextMinute waits for the next whole minute of elapsed time', () => {
  const start = new Date(NOW - 90_000).toISOString();
  assert.equal(msUntilNextMinute(start, NOW), 30_000);
  assert.equal(msUntilNextMinute(new Date(NOW).toISOString(), NOW), 60_000);
  assert.equal(msUntilNextMinute(null, NOW), 60_000);
  assert.equal(msUntilNextMinute(minutesAgo(-5), NOW), 60_000);
});

// ---- Planning robots ----

const planTask = (id, patch = {}) => task(id, { kind: 'plan', planningSessionNumber: 7, createdAt: minutesAgo(20), ...patch });
const planningOf = (tasks) => model([], { tasksById: Object.fromEntries(tasks.map((t) => [t.id, t])), taskIds: tasks.map((t) => t.id) }).planning;

test('U65 a live session gets one robot; archived or completed ones none', () => {
  assert.equal(planningOf([planTask('p1')]).length, 1);
  assert.equal(planningOf([planTask('p1', { archived: true })]).length, 0);
  assert.equal(planningOf([planTask('p1', { planningCompletedAt: minutesAgo(1) })]).length, 0);
});

test('U66 the words and colours are the Planning board card\'s own (shared constants)', () => {
  const expected = { running: 'Running', blocked: 'Waiting for input', idle: 'Between turns' };
  for (const [live, words] of Object.entries(expected)) {
    const tip = planningTooltip({ sessionNumber: 1, live });
    assert.equal(tip.live, words);
    assert.equal(tip.live, PLANNING_LIVE_TITLE[live]);
    assert.equal(tip.dotClass, PLANNING_LIVE_DOT[live]);
  }
  const developing = planningOf([planTask('p1', { status: 'developing' })])[0];
  const blocked = planningOf([planTask('p1', { status: 'blocked' })])[0];
  const idle = planningOf([planTask('p1', { status: 'done' })])[0];
  assert.deepEqual([developing.live, blocked.live, idle.live], ['running', 'blocked', 'idle']);
});

test('U67 "Planning #7"; no number → "Planning"; bug report sessions get no robot', () => {
  assert.equal(planningTooltip({ sessionNumber: 7, live: 'idle' }).title, 'Planning #7');
  assert.equal(planningTooltip({ sessionNumber: null, live: 'idle' }).title, 'Planning');
  assert.equal(planningOf([planTask('p1', { planningPurpose: 'bug-report' })]).length, 0);
});

test('U68 planning robots are ordered earliest-started first, ties by key', () => {
  const seats = planningOf([planTask('late', { createdAt: minutesAgo(5), conversationId: 'b' }), planTask('early', { createdAt: minutesAgo(50), conversationId: 'c' }), planTask('tie', { createdAt: minutesAgo(5), conversationId: 'a' })]);
  assert.deepEqual(seats.map((s) => s.taskId), ['early', 'tie', 'late']);
});

test('U69 a huge session number prints in full', () => {
  assert.equal(planningTooltip({ sessionNumber: 2147483648, live: 'idle' }).title, 'Planning #2147483648');
});

test('a planning robot keeps its key across turns (keyed by the conversation, not the latest Task)', () => {
  const first = planTask('turn-1', { conversationId: 'conv', createdAt: minutesAgo(30) });
  const second = planTask('turn-2', { conversationId: 'conv', createdAt: minutesAgo(1) });
  assert.equal(planningOf([first])[0].key, planningOf([second, first])[0].key);
  assert.equal(planningOf([second, first])[0].taskId, 'turn-2', 'opening it shows the latest turn');
});

// ---- Caps, priority, overflow ----

const runningAt = (id, minutes, runPatch = {}) => started(id, { startedMinutesAgo: minutes, runPatch });

test('U70 work priority: Needs you, Running, Stopped/Failed; ties earliest-started then key', () => {
  const m = model([
    runningAt('i1', 10),
    runningAt('i2', 20),
    started('i3', { itemPatch: { status: 'failed' }, runPatch: { status: 'failed' }, startedMinutesAgo: 90 }),
    started('i4', { runPatch: { status: 'awaiting-approval' }, startedMinutesAgo: 5 }),
  ], { commandRuns: [commandRun('c1', { startedAt: minutesAgo(500) })] });
  assert.deepEqual(m.work.map((w) => w.key), ['task:i4', 'task:i2', 'task:i1', 'task:i3']);
  const tie = [{ state: 'running', key: 'task:b', startedAt: minutesAgo(1) }, { state: 'running', key: 'task:a', startedAt: minutesAgo(1) }].sort(compareWork);
  assert.deepEqual(tie.map((w) => w.key), ['task:a', 'task:b']);
});

test('A01 work holds tasks only; machines go to their own commands list', () => {
  const m = model([runningAt('i1', 10)], { commandRuns: [commandRun('c1')], testRuns: [testRun('t1')] });
  assert.deepEqual(m.work.map((w) => w.key), ['task:i1']);
  assert.deepEqual(m.commands.map((c) => c.key).sort(), ['command:c1', 'test:t1']);
  assert.ok(m.work.every((w) => !('runKind' in w)) && m.commands.every((c) => 'runKind' in c));
});

test('A02 commands are ordered earliest-started first, then by key', () => {
  const m = model([], { commandRuns: [commandRun('b', { startedAt: minutesAgo(5) }), commandRun('a', { startedAt: minutesAgo(5) }), commandRun('c', { startedAt: minutesAgo(50) })], testRuns: [testRun('t', { startedAt: minutesAgo(20) })] });
  assert.deepEqual(m.commands.map((c) => c.key), ['command:c', 'test:t', 'command:a', 'command:b']);
});

test('A03 the work priority has no command kind; the work breakdown lists only task kinds', () => {
  assert.deepEqual([...yard.WORK_PRIORITY], ['needs-you', 'running', 'stopped']);
  const m = model(manyRunning(8), { commandRuns: [commandRun('c1'), commandRun('c2'), commandRun('c3'), commandRun('c4')] });
  assert.deepEqual(hiddenWorkCounts(m, layoutOf(m)), [['running', 2]]);
});

test('A04 commands 0 / 3 / 4 / 50 hide 0 / 0 / 1 / 47; with 10 commands all 6 task bays still show', () => {
  const hiddenFor = (n) => layoutOf(model([], { commandRuns: Array.from({ length: n }, (_, i) => commandRun(`c${i}`)) })).commands.hidden.length;
  assert.deepEqual([0, 3, 4, 50].map(hiddenFor), [0, 0, 1, 47]);
  const l = layoutOf(model(manyRunning(6), { commandRuns: Array.from({ length: 10 }, (_, i) => commandRun(`c${i}`)) }));
  assert.deepEqual([Object.keys(l.work.slots).length, l.work.hidden.length, Object.keys(l.commands.slots).length], [6, 0, 3]);
});

test('A05 the commands marker reads "N more hidden: N command(s)"', () => {
  const textFor = (n) => {
    const m = model([], { commandRuns: Array.from({ length: n }, (_, i) => commandRun(`c${i}`)) });
    return overflowText('commands', m, layoutOf(m));
  };
  assert.equal(textFor(4), '1 more hidden: 1 command');
  assert.equal(textFor(7), '4 more hidden: 4 commands');
});

test('U71 a retried task\'s tie-break uses its latest attempt\'s start', () => {
  const oldTask = task('t-old', { planItemId: 'i1', createdAt: minutesAgo(500) });
  const retried = { ...runningAt('i1', 1), item: { ...runningAt('i1', 1).item, taskIds: [oldTask.id, 't-i1'] } };
  const m = model([retried, runningAt('i2', 30)], { tasksById: { [oldTask.id]: oldTask } });
  assert.deepEqual(m.work.map((w) => w.key), ['task:i2', 'task:i1']);
});

const layoutOf = (m) => layoutYard(m, null);
const manyRunning = (n) => Array.from({ length: n }, (_, i) => runningAt(`i${String(i).padStart(3, '0')}`, n - i));

test('U72 an empty work area: nothing shown, no marker', () => {
  const l = layoutOf(model([]));
  assert.deepEqual([Object.keys(l.work.slots).length, l.work.hidden.length], [0, 0]);
});

test('U73 exactly 6 → 6 shown, no marker', () => {
  const l = layoutOf(model(manyRunning(6)));
  assert.deepEqual([Object.keys(l.work.slots).length, l.work.hidden.length], [6, 0]);
});

test('U74 7 → 6 shown and a marker for 1, with its kind', () => {
  const m = model(manyRunning(7));
  const l = layoutOf(m);
  assert.deepEqual([Object.keys(l.work.slots).length, l.work.hidden.length], [6, 1]);
  assert.deepEqual(hiddenWorkCounts(m, l), [['running', 1]]);
});

test('U75 100 → exactly 94 hidden; per-kind counts add up', () => {
  const m = model([...manyRunning(96), ...Array.from({ length: 4 }, (_, i) => started(`n${i}`, { runPatch: { status: 'awaiting-approval' } }))]);
  const l = layoutOf(m);
  assert.equal(l.work.hidden.length, 94);
  assert.equal(hiddenWorkCounts(m, l).reduce((sum, [, n]) => sum + n, 0), 94);
});

test('U76 six Needs you plus three commands (one red): the commands keep their own machines, none hidden', () => {
  const needs = Array.from({ length: 6 }, (_, i) => started(`n${i}`, { runPatch: { status: 'awaiting-approval' } }));
  const m = model(needs, { commandRuns: [commandRun('c1'), commandRun('c2'), commandRun('c3', { status: 'failed', failureUnopened: true })] });
  const l = layoutOf(m);
  assert.deepEqual([l.work.hidden, l.commands.hidden], [[], []]);
  assert.deepEqual(Object.keys(l.commands.slots).sort(), ['command:c1', 'command:c2', 'command:c3']);
});

test('U77 merge-wait 0 / 6 / 7; ordered by when waiting started; a newcomer never displaces a shown robot', () => {
  const waiting = (id, minutes) => finished(id, { pullRequest: { state: 'open', prNumber: 1, readAt: minutesAgo(1) } }, { completedAt: minutesAgo(minutes) });
  assert.equal(layoutOf(model([])).merge.hidden.length, 0);
  const six = Array.from({ length: 6 }, (_, i) => waiting(`m${i}`, 100 - i));
  const l6 = layoutOf(model(six));
  assert.deepEqual([Object.keys(l6.merge.slots).length, l6.merge.hidden.length], [6, 0]);
  const m7 = model([...six, waiting('m-new', 1)]);
  const l7 = layoutYard(m7, l6);
  assert.deepEqual(l7.merge.hidden, ['task:m-new']);
  assert.deepEqual(l7.merge.slots, l6.merge.slots);
  assert.deepEqual(m7.merge.map((w) => w.key).slice(0, 2), ['task:m0', 'task:m1']);
});

test('A06 planning 0 / 8 / 9 / 25 → marker from 9 (hidden 1), at 25 hidden 17', () => {
  const seats = (n) => Array.from({ length: n }, (_, i) => planTask(`p${i}`, { conversationId: `c${i}`, createdAt: minutesAgo(100 - i) }));
  const hiddenFor = (n) => layoutOf(model([], { tasksById: Object.fromEntries(seats(n).map((t) => [t.id, t])), taskIds: seats(n).map((t) => t.id) })).planning.hidden.length;
  assert.deepEqual([0, 8, 9, 25].map(hiddenFor), [0, 0, 1, 17]);
});

test('U79 the work marker text lists kinds in priority order, singular and plural', () => {
  const needs = Array.from({ length: 6 }, (_, i) => started(`n${i}`, { runPatch: { status: 'awaiting-approval' } }));
  const stopped = started('s1', { itemPatch: { status: 'failed' }, runPatch: { status: 'failed' } });
  const m = model([...needs, stopped, runningAt('r1', 5), runningAt('r2', 6)], { commandRuns: [commandRun('c1'), commandRun('c2')] });
  assert.equal(overflowText('work', m, layoutOf(m)), '3 more hidden: 2 Running, 1 Stopped/Failed');
  const one = model([...needs, runningAt('r1', 5)]);
  assert.equal(overflowText('work', one, layoutOf(one)), '1 more hidden: 1 Running');
  assert.equal(yard.MORE_CLICK_HINT, 'Click to open the Tasks tab');
});

test('U80 the merge and planning marker texts', () => {
  const waiting = Array.from({ length: 8 }, (_, i) => finished(`m${i}`, { pullRequest: { state: 'open', prNumber: i, readAt: minutesAgo(1) } }));
  const m = model(waiting);
  assert.equal(overflowText('merge', m, layoutOf(m)), '2 more hidden: 2 waiting to merge');
  const seats = Array.from({ length: 10 }, (_, i) => planTask(`p${i}`, { conversationId: `c${i}` }));
  const p = model([], { tasksById: Object.fromEntries(seats.map((t) => [t.id, t])), taskIds: seats.map((t) => t.id) });
  assert.equal(overflowText('planning', p, layoutOf(p)), '2 more hidden: 2 planning');
});

// ---- Sticky slots ----

test('U81 a first assignment fills slots 0… in priority order', () => {
  assert.deepEqual(assignSlots(['a', 'b', 'c'], 6, undefined), { slots: { a: 0, b: 1, c: 2 }, hidden: [] });
});

test('U82 Running → Needs you keeps its slot even though the order changed', () => {
  const first = layoutOf(model([runningAt('i1', 30), runningAt('i2', 20)]));
  const changed = model([runningAt('i1', 30), runningAt('i2', 20, { status: 'awaiting-approval' })]);
  assert.deepEqual(changed.work.map((w) => w.key), ['task:i2', 'task:i1'], 'i2 now ranks first');
  assert.deepEqual(layoutYard(changed, first).work.slots, first.work.slots);
});

test('U83 leaving frees a slot; a newcomer takes the lowest free one; nobody else moves', () => {
  const before = assignSlots(['a', 'b', 'c'], 6, undefined);
  const after = assignSlots(['a', 'c', 'd'], 6, before.slots);
  assert.deepEqual(after.slots, { a: 0, c: 2, d: 1 });
});

test('U84 an item promoted from hidden takes the lowest free slot and fades in (no walk-out)', () => {
  const sevenModel = model(manyRunning(7));
  const seven = layoutOf(sevenModel);
  const hiddenKey = seven.work.hidden[0];
  const leftKey = sevenModel.work[0].key;
  const sixModel = model(manyRunning(7).filter((e) => taskKey(e.item.id) !== leftKey));
  const six = layoutYard(sixModel, seven);
  assert.equal(six.work.slots[hiddenKey], seven.work.slots[leftKey]);
  assert.equal(yardTransitions({ model: sevenModel, layout: seven }, { model: sixModel, layout: six })[hiddenKey], 'fade-in');
});

test('U85 shown never exceeds the cap; the marker uses the reserved slot', () => {
  const l = layoutOf(model(manyRunning(40)));
  assert.ok(Math.max(...Object.values(l.work.slots)) < yard.AREA_CAPS.work);
  assert.deepEqual(yard.AREA_CAPS, { work: 6, commands: 3, merge: 6, planning: 8 });
  const slots = assignSlots(Array.from({ length: 30 }, (_, i) => `k${i}`), 10, { k0: 99 }).slots;
  assert.ok(Object.values(slots).every((slot) => slot < 10), 'a stale out-of-range slot is reassigned');
});

test('U86 areas assign independently: moving to merge frees the work slot and takes a merge slot', () => {
  const before = model([runningAt('i1', 30), runningAt('i2', 20)]);
  const lb = layoutOf(before);
  const after = model([finished('i1', { pullRequest: { state: 'open', prNumber: 2, readAt: minutesAgo(1) } }), runningAt('i2', 20)]);
  const la = layoutYard(after, lb);
  assert.equal(la.work.slots['task:i1'], undefined);
  assert.equal(la.merge.slots['task:i1'], 0);
  assert.equal(la.work.slots['task:i2'], lb.work.slots['task:i2']);
});

// ---- Lifecycle transitions ----

const step = (previous, m) => {
  const layout = layoutYard(m, previous?.layout ?? null);
  return { model: m, layout, transitions: yardTransitions(previous, { model: m, layout }) };
};

test('U87 first load: everything appears in place', () => {
  const s = step(null, model([runningAt('i1', 5), finished('i2', { pullRequest: { state: 'open', prNumber: 1, readAt: minutesAgo(1) } })], { commandRuns: [commandRun('c1')] }));
  assert.deepEqual(new Set(Object.values(s.transitions)), new Set(['appear']));
  assert.equal(Object.keys(s.transitions).length, 3);
});

test('U88 plan not loaded → an empty model; when data arrives everything appears in place', () => {
  const empty = buildYardModel({ ...sources([runningAt('i1', 5)]), items: undefined });
  assert.deepEqual(empty, { loaded: false, pending: [], work: [], commands: [], merge: [], planning: [], exits: {} });
  const s0 = step(null, empty);
  const s1 = step(s0, model([runningAt('i1', 5)]));
  assert.equal(s1.transitions['task:i1'], 'appear');
});

test('U89 a task started after load walks out', () => {
  const s0 = step(null, model([]));
  assert.equal(step(s0, model([runningAt('i1', 1)])).transitions['task:i1'], 'walk-out');
});

test('U90 Running → finished with no merge needed → carried in', () => {
  const s0 = step(null, model([runningAt('i1', 5)]));
  assert.equal(step(s0, model([finished('i1')])).transitions['task:i1'], 'carry-in');
});

test('U91 Running → merge-wait → carried to merge: the same entity, never in both areas', () => {
  const s0 = step(null, model([runningAt('i1', 5)]));
  const s1 = step(s0, model([finished('i1', { pullRequest: { state: 'open', prNumber: 1, readAt: minutesAgo(1) } })]));
  assert.equal(s1.transitions['task:i1'], 'carry-to-merge');
  assert.equal(s1.layout.work.slots['task:i1'], undefined);
});

test('U92 merge-wait → merged → carried in', () => {
  const s0 = step(null, model([finished('i1', { pullRequest: { state: 'open', prNumber: 1, readAt: minutesAgo(1) } })]));
  assert.equal(step(s0, model([finished('i1', { pullRequest: { state: 'merged', prNumber: 1, readAt: minutesAgo(0) } })])).transitions['task:i1'], 'carry-in');
  const a0 = step(null, model([finished('i1', { autoMerge: autoMerge('merging') })]));
  assert.equal(step(a0, model([finished('i1', { autoMerge: autoMerge('merged') })])).transitions['task:i1'], 'carry-in', 'Auto-merge too');
});

test('U93 merge-wait → PR closed → leaves quietly', () => {
  const s0 = step(null, model([finished('i1', { pullRequest: { state: 'open', prNumber: 1, readAt: minutesAgo(1) } })]));
  assert.equal(step(s0, model([finished('i1', { pullRequest: { state: 'closed', prNumber: 1, readAt: minutesAgo(0) } })])).transitions['task:i1'], 'quiet-leave');
});

test('U94 Running → Stopped/Failed: the robot returns to the dome, the red box stays', () => {
  const s0 = step(null, model([runningAt('i1', 5)]));
  const s1 = step(s0, model([started('i1', { itemPatch: { status: 'failed' }, runPatch: { status: 'failed' } })]));
  assert.equal(s1.transitions['task:i1'], 'return-to-dome');
  assert.equal(s1.layout.work.slots['task:i1'], s0.layout.work.slots['task:i1']);
});

test('U95 Stopped → retried: the robot walks out to the same box', () => {
  const s0 = step(null, model([started('i1', { itemPatch: { status: 'stopped' }, runPatch: { status: 'stopped' } })]));
  assert.equal(step(s0, model([runningAt('i1', 1)])).transitions['task:i1'], 'walk-out');
});

test('U96 archived or deleted while Running → leaves quietly', () => {
  const s0 = step(null, model([runningAt('i1', 5), runningAt('i2', 5)]));
  const s1 = step(s0, model([{ ...runningAt('i1', 5), item: { ...runningAt('i1', 5).item, archived: true } }]));
  assert.equal(s1.transitions['task:i1'], 'quiet-leave');
  assert.equal(s1.transitions['task:i2'], 'quiet-leave');
});

test('U97 Running → Needs you → Running: a pose change only, same slot', () => {
  const s0 = step(null, model([runningAt('i1', 5)]));
  const s1 = step(s0, model([runningAt('i1', 5, { status: 'awaiting-approval' })]));
  const s2 = step(s1, model([runningAt('i1', 5)]));
  assert.deepEqual([s1.transitions['task:i1'], s2.transitions['task:i1']], ['pose', 'pose']);
  assert.equal(s2.layout.work.slots['task:i1'], s0.layout.work.slots['task:i1']);
});

test('U98 leaving 3D and coming back (a fresh mount, no previous) is a first load', () => {
  const s = step(null, model([runningAt('i1', 5)]));
  assert.equal(s.transitions['task:i1'], 'appear');
});

test('U99 a removed Project\'s entities go with it; other Projects are unaffected', () => {
  const p1 = model([runningAt('i1', 5)]);
  const p2 = buildYardModel({ ...sources([runningAt('i9', 5)]), projectId: 'p2', items: [{ ...runningAt('i9', 5).item, projectId: 'p2' }], workflowRuns: [{ ...runningAt('i9', 5).run, projectId: 'p2' }] });
  assert.deepEqual(workspaceTotals([p1, p2]).inProgress, 2);
  assert.deepEqual(workspaceTotals([p2]).inProgress, 1, 'p1 removed: its counts go, p2 stays');
  assert.equal(step(null, p2).transitions['task:i9'], 'appear');
});

test('U100 no task is ever in two areas: every task state × Auto-merge state × PR reading', () => {
  const itemStatuses = ['pending', 'developing', 'blocked', 'done', 'failed', 'stopped'];
  const runStatuses = [null, 'starting', 'running', 'completing', 'awaiting-approval', 'needs-attention', 'failed', 'stopped', 'completed'];
  const autoMerges = [undefined, ...['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent', 'merged', 'failed', 'no-pr', 'cannot-merge'].map((s) => autoMerge(s)), autoMerge('waiting', { enabled: false })];
  const readings = [undefined, ...['open', 'merged', 'closed', 'none'].map((state) => ({ state, prNumber: 5, readAt: minutesAgo(1) }))];
  let cases = 0;
  for (const status of itemStatuses) for (const runStatus of runStatuses) for (const am of autoMerges) for (const pr of readings) {
    const entry = started('i1', { run: runStatus !== null, itemPatch: { status, ...(am ? { autoMerge: am } : {}), ...(pr ? { pullRequest: pr } : {}) }, runPatch: { status: runStatus ?? 'running' } });
    const m = model([entry]);
    const keys = [...m.pending, ...[...m.work, ...m.merge].map((w) => w.key)];
    assert.ok(keys.length <= 1, JSON.stringify({ status, runStatus, am: am?.state, pr: pr?.state }));
    assert.ok(!(keys.length === 1 && m.exits['task:i1']), 'a shown task has no exit');
    cases += 1;
  }
  assert.equal(cases, 6 * 9 * 12 * 5);
});

// ---- Workspace totals ----

test('U117 totals are exact and never capped (50 running counts 50)', () => {
  const m = model([...manyRunning(50), started('n1', { runPatch: { status: 'awaiting-approval' } }), started('s1', { itemPatch: { status: 'failed' }, runPatch: { status: 'failed' } }), finished('m1', { pullRequest: { state: 'open', prNumber: 1, readAt: minutesAgo(1) } })], {
    commandRuns: [commandRun('c1'), commandRun('c2', { status: 'failed', failureUnopened: true })],
  });
  assert.deepEqual(workspaceTotals([m]), { pending: 0, inProgress: 50, needsYou: 1, waitingToMerge: 1, stopped: 1, commands: 2, planning: 0 });
});

test('U118 no Projects or nothing live → all zeros', () => {
  assert.deepEqual(workspaceTotals([]), yard.EMPTY_TOTALS);
  assert.deepEqual(workspaceTotals([model([])]), { pending: 0, inProgress: 0, needsYou: 0, waitingToMerge: 0, stopped: 0, commands: 0, planning: 0 });
});

test('U119 the totals are the sum of the per-Project models (same derivation, archived excluded)', () => {
  const a = model([runningAt('i1', 5), { ...runningAt('i2', 5), item: { ...runningAt('i2', 5).item, archived: true } }]);
  const b = model([runningAt('i3', 5), runningAt('i4', 5)]);
  const sum = (key) => workspaceTotals([a])[key] + workspaceTotals([b])[key];
  assert.deepEqual(workspaceTotals([a, b]).inProgress, sum('inProgress'));
  assert.equal(workspaceTotals([a]).inProgress, 1);
});

test('U120 a Project with no data loaded contributes 0', () => {
  assert.deepEqual(workspaceTotals([buildYardModel({ ...sources([runningAt('i1', 5)]), items: undefined })]), yard.EMPTY_TOTALS);
});

// ---- Label ----

test('U121 the dome label badge uses buildingBadge wording; a normal Project has none', () => {
  assert.equal(buildingBadge({ readOnly: true }), 'Read-only');
  assert.equal(buildingBadge({ typeUnavailable: true }), 'Type unavailable');
  assert.equal(buildingBadge({ readOnly: true, readOnlyReason: 'Migration to v2 failed' }), 'Migration failed');
  assert.equal(buildingBadge({}), null);
});

test('U122 the dome tint is the Building Type colour with the same fallback for an unknown type', () => {
  assert.equal(lookFor({}, []).color, SOFTWARE_LOOK.color);
  assert.equal(lookFor({ typeId: 'notes' }, [{ id: 'notes', look: { model: 'generic', color: '#e0a030' } }]).color, '#e0a030');
  assert.equal(lookFor({ typeId: 'mystery' }, []).color, GENERIC_LOOK_COLOR);
});

// ---- Clicks ----

function clickHarness(state = {}) {
  const calls = [];
  const actions = Object.fromEntries(['openWorkspace', 'openWorkspacePendingTasks', 'openWorkspaceCardDetail', 'openPlanningSession', 'openCommandRunFromVillage', 'openTestRunFromFooter'].map((name) => [name, (...args) => calls.push([name, ...args])]));
  const entry = started('i1');
  const base = { projects: [{ id: 'p1' }], planByProject: { p1: { items: [entry.item, item('i2')] } }, tasksById: { [entry.task.id]: entry.task }, ...state };
  return { calls, click: (target, projectId = 'p1') => openYardTarget(projectId, target, base, actions) };
}

test('U110 the dome opens the Project Workspace', () => {
  const h = clickHarness();
  h.click({ kind: 'dome' });
  assert.deepEqual(h.calls, [['openWorkspace', 'p1']]);
});

test('U111 a task box, its robot or a merge robot opens that task as its board card would', () => {
  const h = clickHarness();
  h.click({ kind: 'task', itemId: 'i1' });
  h.click({ kind: 'task', itemId: 'i2' });
  assert.deepEqual(h.calls, [
    ['openWorkspaceCardDetail', 'p1', { kind: 'run', id: 'r-i1' }],
    ['openWorkspaceCardDetail', 'p1', { kind: 'item', id: 'i2' }],
  ]);
});

test('U112 a task deleted before the click, or a deleted Project, opens nothing and does not throw', () => {
  const h = clickHarness();
  assert.doesNotThrow(() => h.click({ kind: 'task', itemId: 'gone' }));
  assert.doesNotThrow(() => h.click({ kind: 'dome' }, 'deleted-project'));
  assert.doesNotThrow(() => h.click({ kind: 'task', itemId: 'i1' }, 'deleted-project'));
  const noPlan = clickHarness({ planByProject: {} });
  assert.doesNotThrow(() => noPlan.click({ kind: 'task', itemId: 'i1' }));
  assert.deepEqual([...h.calls, ...noPlan.calls], []);
});

test('U113 a planning robot opens its session', () => {
  const h = clickHarness();
  h.click({ kind: 'planning', taskId: 'plan-7' });
  assert.deepEqual(h.calls, [['openPlanningSession', 'p1', 'plan-7']]);
});

test('U114 a command machine opens Settings › Commands with its log; a test machine its Testing run', () => {
  const h = clickHarness();
  h.click({ kind: 'command', runId: 'c1' });
  h.click({ kind: 'test', runId: 't1' });
  assert.deepEqual(h.calls, [['openCommandRunFromVillage', 'p1', 'c1'], ['openTestRunFromFooter', 'p1', 't1']]);
});

test('U115 any "+N more" opens the Tasks tab (the workspace opens on Tasks)', () => {
  const h = clickHarness();
  h.click({ kind: 'more' });
  assert.deepEqual(h.calls, [['openWorkspace', 'p1']]);
});

// ---- The pending stack: which tasks are pending ----

const todo = (id, patch = {}) => ({ item: item(id, patch), task: null, run: null });
const WAITING = { options: {}, state: 'waiting', reasons: [], since: minutesAgo(5), longWaitNotified: false, updatedAt: minutesAgo(5) };
/** A planning conversation (session 7) with `ready` tasks it created, which nest beneath it on the board. */
function sessionWithReady(ids) {
  const plan = task('plan-7', { kind: 'plan', planningSessionNumber: 7, planningCreatedTaskCount: ids.length });
  return { entries: ids.map((id, i) => todo(id, { planningRef: { session: 7, task: i + 1 } })), extra: { tasksById: { [plan.id]: plan }, taskIds: [plan.id] } };
}

test('P01 a not-started task with no run is pending', () => {
  assert.deepEqual(model([todo('i1')]).pending, ['task:i1']);
});

test('P02 a paused task with no live run is pending (and gets no box)', () => {
  const paused = started('i1', { run: false, itemPatch: { status: 'stopped' }, taskPatch: { status: 'stopped', executionMode: 'terminal', sessionId: 'sess' } });
  const m = model([paused]);
  assert.deepEqual([m.pending, m.work], [['task:i1'], []]);
});

test('P03 a ready task nested under a planning session is pending; the session is a desk, not a crate', () => {
  const { entries, extra } = sessionWithReady(['i1', 'i2']);
  const m = model(entries, extra);
  assert.deepEqual(m.pending, ['task:i1', 'task:i2']);
  assert.equal(m.planning.length, 1);
});

test('P04 a freeform task executing in its terminal (no workflow run) is a Running box, not pending', () => {
  const freeform = started('i1', { run: false, taskPatch: { status: 'developing', executionMode: 'terminal' } });
  const m = model([freeform]);
  assert.deepEqual([m.pending, m.work.map((w) => [w.key, w.state])], [[], [['task:i1', 'running']]]);
});

test('P05 a task whose run status the board files under Planning (the open fallback) is pending', () => {
  const m = model([started('i1', { runPatch: { status: 'queued' } })]);
  assert.deepEqual([m.pending, m.work], [['task:i1'], []]);
});

test('P06 stopped or failed with no run is a red box only, never pending', () => {
  const failed = started('i1', { run: false, itemPatch: { status: 'failed' }, taskPatch: { status: 'failed', executionMode: 'structured' } });
  const m = model([failed]);
  assert.deepEqual(m.pending, []);
  assert.equal(boxOf(m, 'i1').state, 'stopped');
});

test('P07 a task waiting for its parents is neither pending nor a box', () => {
  const m = model([todo('i1', { waiting: WAITING })]);
  assert.deepEqual([m.pending, m.work], [[], []]);
});

test('P08 archived or deleted tasks are not pending', () => {
  assert.deepEqual(model([todo('i1', { archived: true })]).pending, []);
  assert.deepEqual(buildYardModel({ ...sources([todo('i1')]), items: [] }).pending, []);
});

test('P09 planning sessions are desks only, never crates', () => {
  const plan = task('plan-1', { kind: 'plan', planningSessionNumber: 3 });
  const m = model([], { tasksById: { [plan.id]: plan }, taskIds: [plan.id] });
  assert.deepEqual([m.pending, m.planning.length], [[], 1]);
});

test('P10 running, needs-you, merge-wait and completed tasks are never pending', () => {
  const m = model([
    runningAt('i1', 5),
    started('i2', { itemPatch: { status: 'blocked' }, runPatch: { status: 'awaiting-approval' } }),
    finished('i3', { pullRequest: { state: 'open', prNumber: 3, readAt: minutesAgo(1) } }),
    finished('i4', { pullRequest: { state: 'merged', prNumber: 4, readAt: minutesAgo(1) } }),
  ]);
  assert.deepEqual(m.pending, []);
});

test('P11 pending keys are unique and in the Planning column\'s own order', () => {
  const m = model([todo('a', { planningQueueOrder: 3 }), todo('b', { planningQueueOrder: 1 }), todo('c', { planningQueueOrder: 2 })]);
  assert.deepEqual(m.pending, ['task:b', 'task:c', 'task:a']);
  assert.equal(new Set(m.pending).size, m.pending.length);
});

test('P12 plan not loaded → pending [] and loaded false', () => {
  const m = buildYardModel({ ...sources([todo('i1')]), items: undefined });
  assert.deepEqual([m.pending, m.loaded], [[], false]);
});

test('P14 the pending count equals the Pending only filter\'s card count for the same data (badge = chip)', () => {
  const { entries, extra } = sessionWithReady(['s1', 's2']);
  const all = [...entries, todo('i1'), todo('i2', { waiting: WAITING }), runningAt('i3', 4), started('i4', { run: false, itemPatch: { status: 'failed' }, taskPatch: { status: 'failed', executionMode: 'structured' } })];
  const src = sources(all, extra);
  const groups = buildTaskGroups({ items: src.items, tasksById: src.tasksById, workflowRunsByProject: { p1: src.workflowRuns }, projectId: 'p1', showArchived: false, now: 0 });
  const queue = buildPlanningQueue({ items: src.items, taskIds: src.taskIds, tasksById: src.tasksById, now: 0, openRows: groups.open });
  const view = pendingOnlyView(queue, { running: 1, needsYou: 0, done: 0 });
  const m = buildYardModel(src);
  assert.equal(view.cards.length, m.pending.length);
  assert.deepEqual(view.cards.map((row) => taskKey(row.id)), m.pending);
});

test('P15 cancelling a task\'s wait for its parents makes it pending', () => {
  assert.deepEqual(model([todo('i1', { waiting: WAITING })]).pending, []);
  assert.deepEqual(model([todo('i1')]).pending, ['task:i1']);
});

// ---- The pending stack: crates, badge, tooltip ----

test('S01 0 pending → no crates and no badge (an empty pallet)', () => {
  assert.deepEqual(pendingStack(0, 0), { resting: 0, transit: 0, badge: null });
});

test('S02 1 → 1 crate, badge "1"', () => {
  assert.deepEqual(pendingStack(1, 0), { resting: 1, transit: 0, badge: '1' });
});

test('S03 11 → 11; 12 → 12; 13 → 12 crates with badge "13"', () => {
  assert.equal(CRATE_CAP, 12);
  assert.deepEqual([11, 12, 13].map((n) => [pendingStack(n, 0).resting, pendingStack(n, 0).badge]), [[11, '11'], [12, '12'], [12, '13']]);
});

test('S04 27, 10000 and MAX_SAFE_INTEGER → 12 crates; the badge prints every digit', () => {
  for (const n of [27, 10000, Number.MAX_SAFE_INTEGER]) {
    const view = pendingStack(n, 0);
    assert.equal(view.resting, 12);
    assert.equal(view.badge, String(n));
    assert.match(view.badge, /^\d+$/, 'no "99+", separators or exponent');
  }
  assert.equal(pendingStack(Number.MAX_SAFE_INTEGER, 0).badge, '9007199254740991');
});

test('S05 1 in transit with 26 left → 11 resting + 1 transit (never more than 12 drawn)', () => {
  assert.deepEqual(pendingStack(26, 1), { resting: 11, transit: 1, badge: '26' });
});

test('S06 1 in transit with 2 left → 2 + 1 (the stack never shrinks before the lift)', () => {
  assert.deepEqual([pendingStack(2, 1).resting, pendingStack(2, 1).transit], [2, 1]);
});

test('S07 1 in transit with 0 left → 0 + 1 and no badge', () => {
  assert.deepEqual(pendingStack(0, 1), { resting: 0, transit: 1, badge: null });
});

test('S08 2 in transit with 30 left → 10 + 2', () => {
  assert.deepEqual([pendingStack(30, 2).resting, pendingStack(30, 2).transit], [10, 2]);
});

test('S09 more than 12 in transit → 12 transit and 0 resting', () => {
  assert.deepEqual([pendingStack(5, 20).resting, pendingStack(5, 20).transit], [0, 12]);
});

test('S11 the stack tooltip: count wording, crates-shown suffix past the cap, and the click hint last', () => {
  assert.deepEqual(pendingTooltip(0), ['Pending dock', 'No pending tasks', 'Click to open Tasks › Pending only']);
  assert.equal(pendingTooltip(1)[1], '1 pending task');
  assert.equal(pendingTooltip(12)[1], '12 pending tasks');
  assert.equal(pendingTooltip(13)[1], '13 pending tasks (12 crates shown)');
  for (const n of [0, 1, 12, 13, 5000]) assert.equal(pendingTooltip(n).at(-1), yard.PENDING_CLICK_HINT);
});

test('S12 the stack follows the net count: up k drops k, down k fades k, a same-count swap and a first load show nothing', () => {
  const m = (n, prefix = 'i') => model(Array.from({ length: n }, (_, i) => todo(`${prefix}${i}`)));
  assert.deepEqual(stackChange(m(2), m(5), {}), { drops: 3, fades: 0 });
  assert.deepEqual(stackChange(m(5), m(1), {}), { drops: 0, fades: 4 });
  assert.deepEqual(stackChange(m(3, 'a'), m(3, 'b'), {}), { drops: 0, fades: 0 });
  assert.deepEqual(stackChange(null, m(4), {}), { drops: 0, fades: 0 });
  assert.deepEqual(stackChange(buildYardModel({ ...sources([]), items: undefined }), m(4), {}), { drops: 0, fades: 0 }, 'a reload');
});

// ---- Transitions: picking a crate up ----

test('T01 pending → Running with a free bay picks its crate up', () => {
  const s0 = step(null, model([todo('i1')]));
  const s1 = step(s0, model([runningAt('i1', 1)]));
  assert.equal(s1.transitions['task:i1'], 'pick-up');
  assert.deepEqual(stackChange(s0.model, s1.model, s1.transitions), { drops: 0, fades: 0 }, 'the robot takes the crate; nothing fades');
});

test('T02 pending → Needs you in the same update, with a free bay, picks up too', () => {
  const s0 = step(null, model([todo('i1')]));
  const s1 = step(s0, model([started('i1', { itemPatch: { status: 'blocked' }, runPatch: { status: 'awaiting-approval' } })]));
  assert.equal(s1.transitions['task:i1'], 'pick-up');
});

test('T03 pending → work behind "+N more": no walk, one crate fades and the work overflow goes up by 1', () => {
  const busy = manyRunning(6);
  const s0 = step(null, model([...busy, todo('z1')]));
  const s1 = step(s0, model([...busy, runningAt('z1', 0)]));
  assert.equal(s1.transitions['task:z1'], undefined);
  assert.equal(s1.layout.work.hidden.length, s0.layout.work.hidden.length + 1);
  assert.deepEqual(stackChange(s0.model, s1.model, s1.transitions), { drops: 0, fades: 1 });
});

test('T04 pending → stopped/failed directly: the red box appears and one crate fades', () => {
  const s0 = step(null, model([todo('i1')]));
  const s1 = step(s0, model([started('i1', { itemPatch: { status: 'failed' }, runPatch: { status: 'failed' } })]));
  assert.equal(s1.transitions['task:i1'], 'appear');
  assert.deepEqual(stackChange(s0.model, s1.model, s1.transitions), { drops: 0, fades: 1 });
});

test('T05 a retried stopped task walks out with no crate', () => {
  const s0 = step(null, model([started('i1', { itemPatch: { status: 'stopped' }, runPatch: { status: 'stopped' } })]));
  const s1 = step(s0, model([runningAt('i1', 1)]));
  assert.equal(s1.transitions['task:i1'], 'walk-out');
});

test('T06 a task released from waiting walks out with no crate', () => {
  const s0 = step(null, model([todo('i1', { waiting: WAITING })]));
  const s1 = step(s0, model([runningAt('i1', 1)]));
  assert.equal(s1.transitions['task:i1'], 'walk-out');
  assert.deepEqual(stackChange(s0.model, s1.model, s1.transitions), { drops: 0, fades: 0 });
});

test('T07 a first load, a reload or an unloaded previous model shows everything in place: no pick-up, no transit crate', () => {
  const running = model([runningAt('i1', 1), todo('i2')]);
  assert.equal(step(null, running).transitions['task:i1'], 'appear');
  const unloaded = step(null, buildYardModel({ ...sources([todo('i1')]), items: undefined }));
  const s1 = step(unloaded, running);
  assert.equal(s1.transitions['task:i1'], 'appear');
  assert.deepEqual(pickUpOrder(s1.model, s1.transitions), []);
});

test('T08 two starts in one update with two free bays → two pick-ups, staggered 0 and 1 in work priority order', () => {
  const s0 = step(null, model([todo('a'), todo('b')]));
  const s1 = step(s0, model([runningAt('a', 1), started('b', { itemPatch: { status: 'blocked' }, runPatch: { status: 'awaiting-approval' }, startedMinutesAgo: 1 })]));
  assert.deepEqual([s1.transitions['task:a'], s1.transitions['task:b']], ['pick-up', 'pick-up']);
  assert.deepEqual(pickUpOrder(s1.model, s1.transitions), ['task:b', 'task:a'], 'Needs you ranks first');
});

test('T09 three starts with two free bays → two pick-ups and one hidden that fades a crate', () => {
  const busy = manyRunning(4);
  const s0 = step(null, model([...busy, todo('x'), todo('y'), todo('z')]));
  const s1 = step(s0, model([...busy, runningAt('x', 0.3), runningAt('y', 0.2), runningAt('z', 0.1)]));
  assert.equal(pickUpOrder(s1.model, s1.transitions).length, 2);
  assert.equal(s1.layout.work.hidden.length, 1);
  assert.deepEqual(stackChange(s0.model, s1.model, s1.transitions), { drops: 0, fades: 1 });
});

test('T10 a work task back in Planning: its robot leaves quietly (never carried in) and a crate drops', () => {
  const s0 = step(null, model([runningAt('i1', 5)]));
  const s1 = step(s0, model([todo('i1')]));
  assert.equal(s1.transitions['task:i1'], 'quiet-leave');
  assert.deepEqual(stackChange(s0.model, s1.model, s1.transitions), { drops: 1, fades: 0 });
});

test('T11 a pending task archived or deleted fades one crate; it has no entity', () => {
  const s0 = step(null, model([todo('i1'), todo('i2')]));
  const archived = step(s0, model([todo('i1', { archived: true }), todo('i2')]));
  assert.equal(archived.transitions['task:i1'], undefined);
  assert.deepEqual(stackChange(s0.model, archived.model, archived.transitions), { drops: 0, fades: 1 });
  const deleted = step(s0, model([todo('i2')]));
  assert.deepEqual(stackChange(s0.model, deleted.model, deleted.transitions), { drops: 0, fades: 1 });
});

test('T12 a planning session that starts still walks out to a desk', () => {
  const s0 = step(null, model([]));
  const plan = planTask('p1', { conversationId: 'c1' });
  const s1 = step(s0, model([], { tasksById: { [plan.id]: plan }, taskIds: [plan.id] }));
  assert.equal(Object.values(s1.transitions)[0], 'walk-out');
});

test('T13 pickUpDelay(i) is i × 0.4 seconds', () => {
  assert.deepEqual([0, 1, 2, 5].map(pickUpDelay), [0, 0.4, 0.8, 2]);
});

test('A08 layoutYard keeps each zone\'s slots sticky and independent, commands included', () => {
  const m0 = model([runningAt('i1', 5)], { commandRuns: [commandRun('c1'), commandRun('c2', { startedAt: minutesAgo(1) })] });
  const l0 = layoutOf(m0);
  const m1 = model([runningAt('i1', 5), runningAt('i2', 4)], { commandRuns: [commandRun('c2', { startedAt: minutesAgo(1) })] });
  const l1 = layoutYard(m1, l0);
  assert.equal(l1.commands.slots['command:c2'], l0.commands.slots['command:c2'], 'a machine keeps its slot');
  assert.equal(l1.work.slots['task:i1'], l0.work.slots['task:i1']);
  assert.equal(l1.work.slots['task:i2'], 1, 'tasks and machines never share slots');
});

// ---- Totals ----

test('W01 pending totals are summed across models and never capped (1000 → 1000)', () => {
  const big = model(Array.from({ length: 1000 }, (_, i) => todo(`i${i}`, { planningQueueOrder: i })));
  assert.equal(workspaceTotals([big, model([todo('x')])]).pending, 1001);
});

test('W02 EMPTY_TOTALS.pending is 0 and an unloaded Project contributes 0', () => {
  assert.equal(yard.EMPTY_TOTALS.pending, 0);
  assert.equal(workspaceTotals([buildYardModel({ ...sources([todo('i1')]), items: undefined })]).pending, 0);
});

test('W03 a start moves pending −1 and in progress +1 in the same computation', () => {
  const before = workspaceTotals([model([todo('i1'), todo('i2')])]);
  const after = workspaceTotals([model([runningAt('i1', 0), todo('i2')])]);
  assert.deepEqual([after.pending - before.pending, after.inProgress - before.inProgress], [-1, 1]);
});

test('W04/W05 hidden items still count: work 100, commands 50, merge 20, planning 25', () => {
  const merge = Array.from({ length: 20 }, (_, i) => finished(`m${i}`, { pullRequest: { state: 'open', prNumber: i, readAt: minutesAgo(1) } }));
  const seats = Array.from({ length: 25 }, (_, i) => planTask(`p${i}`, { conversationId: `c${i}` }));
  const m = model([...manyRunning(100), ...merge], {
    commandRuns: Array.from({ length: 50 }, (_, i) => commandRun(`c${i}`)),
    tasksById: Object.fromEntries(seats.map((t) => [t.id, t])),
    taskIds: seats.map((t) => t.id),
  });
  const totals = workspaceTotals([m]);
  assert.deepEqual([totals.inProgress, totals.commands, totals.waitingToMerge, totals.planning], [100, 50, 20, 25]);
});

// ---- The Pending only filter's view ----

function boardOf(entries, extra) {
  const src = sources(entries, extra);
  const groups = buildTaskGroups({ items: src.items, tasksById: src.tasksById, workflowRunsByProject: { p1: src.workflowRuns }, projectId: 'p1', showArchived: false, now: 0 });
  return buildPlanningQueue({ items: src.items, taskIds: src.taskIds, tasksById: src.tasksById, now: 0, openRows: groups.open });
}

test('F01 the filter shows pending task cards flattened (nested ones included, sessions left out) in board order', () => {
  const { entries, extra } = sessionWithReady(['s1', 's2']);
  const queue = boardOf([...entries, todo('solo', { planningQueueOrder: -1e15 })], extra);
  const view = pendingOnlyView(queue, { running: 0, needsYou: 0, done: 0 });
  const expected = queue.flatMap((entry) => (entry.kind === 'task' ? [entry.id] : entry.kind === 'session' ? entry.session.ready.map((row) => row.id) : []));
  assert.deepEqual(view.cards.map((row) => row.id), expected);
  assert.deepEqual([...view.cards.map((row) => row.id)].sort(), ['s1', 's2', 'solo']);
});

test('F02 every other column becomes a strip with its exact count', () => {
  const view = pendingOnlyView(boardOf([todo('i1')]), { running: 4, needsYou: 7, done: 1234 });
  assert.deepEqual(view.strips, [{ column: 'running', count: 4 }, { column: 'needsYou', count: 7 }, { column: 'done', count: 1234 }]);
});

test('F03 the hint counts hidden sessions and other tasks in singular or plural; with none pending it says so', () => {
  const plans = ['plan-1', 'plan-2'].map((id, i) => task(id, { kind: 'plan', planningSessionNumber: i + 1 }));
  const extra = { tasksById: Object.fromEntries(plans.map((t) => [t.id, t])), taskIds: plans.map((t) => t.id) };
  assert.equal(pendingOnlyView(boardOf([todo('i1')], extra), { running: 4, needsYou: 4, done: 6 }).hint, 'Not-started tasks from the Planning column. 2 planning sessions and 14 other tasks are hidden.');
  const one = { tasksById: { [plans[0].id]: plans[0] }, taskIds: [plans[0].id] };
  assert.equal(pendingOnlyView(boardOf([todo('i1')], one), { running: 1, needsYou: 0, done: 0 }).hint, 'Not-started tasks from the Planning column. 1 planning session and 1 other task are hidden.');
  assert.equal(pendingOnlyView(boardOf([todo('i1')]), { running: 1, needsYou: 0, done: 0 }).hint, 'Not-started tasks from the Planning column. 1 other task is hidden.');
  assert.equal(pendingOnlyView(boardOf([todo('i1')]), { running: 0, needsYou: 0, done: 0 }).hint, 'Not-started tasks from the Planning column.');
  assert.equal(pendingOnlyView(boardOf([]), { running: 3, needsYou: 0, done: 0 }).hint, PENDING_ONLY_EMPTY);
  assert.equal(PENDING_ONLY_EMPTY, 'No task is waiting to start.');
});

test('F04 a task started elsewhere leaves the filtered grid and the count drops', () => {
  const before = pendingOnlyView(boardOf([todo('i1'), todo('i2')]), { running: 0, needsYou: 0, done: 0 });
  const after = pendingOnlyView(boardOf([runningAt('i1', 0), todo('i2')]), { running: 1, needsYou: 0, done: 0 });
  assert.deepEqual([before.cards.length, after.cards.map((row) => row.id)], [2, ['i2']]);
});

// ---- Clicking the stack ----

test('K02/K07 the stack opens Tasks › Pending only; a gone Project opens nothing; other targets are unchanged', () => {
  const h = clickHarness();
  h.click({ kind: 'pending' });
  assert.doesNotThrow(() => h.click({ kind: 'pending' }, 'deleted-project'));
  h.click({ kind: 'dome' });
  h.click({ kind: 'more' });
  assert.deepEqual(h.calls, [['openWorkspacePendingTasks', 'p1'], ['openWorkspace', 'p1'], ['openWorkspace', 'p1']]);
});

test('T14 a fetched crate stays in transit while its task keeps its bay; a stop, finish or leave mid-walk releases it', () => {
  const s0 = step(null, model([todo('a'), todo('b'), todo('c')]));
  const s1 = step(s0, model([runningAt('a', 1), runningAt('b', 1), runningAt('c', 1)]));
  const picked = pickUpOrder(s1.model, s1.transitions);
  const transit = survivingTransit([], s1.layout, s1.transitions, picked);
  assert.deepEqual([...transit].sort(), ['task:a', 'task:b', 'task:c']);
  // Next change: a stops (red box), b moves to Needs you (a pose change), c is archived.
  const s2 = step(s1, model([
    started('a', { itemPatch: { status: 'failed' }, runPatch: { status: 'failed' }, startedMinutesAgo: 1 }),
    started('b', { itemPatch: { status: 'blocked' }, runPatch: { status: 'awaiting-approval' }, startedMinutesAgo: 1 }),
    { ...runningAt('c', 1), item: { ...runningAt('c', 1).item, archived: true } },
    todo('d'),
  ]));
  assert.deepEqual([s2.transitions['task:a'], s2.transitions['task:b'], s2.transitions['task:c']], ['return-to-dome', 'pose', 'quiet-leave']);
  assert.deepEqual([...survivingTransit(transit, s2.layout, s2.transitions, [])], ['task:b'], 'only the robot still walking to its bay keeps a crate in transit');
  const s3 = step(s2, model([runningAt('b', 1), todo('d'), runningAt('e', 0)]));
  assert.deepEqual([...survivingTransit(['task:b'], s3.layout, s3.transitions, pickUpOrder(s3.model, s3.transitions))].sort(), ['task:b'], 'an unrelated change keeps it; e was never pending, so it walks out with no crate');
});

const node = (yardTarget, parent = null) => ({ userData: yardTarget ? { yardTarget } : {}, parent });

test('yardTargetOf finds the nearest tagged ancestor', () => {
  const warehouse = node({ kind: 'dome' });
  assert.deepEqual(yardTargetOf(node(null, warehouse)), { kind: 'dome' });
  const crate = node({ kind: 'task', itemId: 't1' }, warehouse);
  assert.deepEqual(yardTargetOf(node(null, crate)), { kind: 'task', itemId: 't1' });
});

test('yardTargetOf returns null for bare ground and untagged parts', () => {
  assert.equal(yardTargetOf(node(null, node(null))), null);
  assert.equal(yardTargetOf(null), null);
});

test('isYardClick opens only when the press began here and did not drag', () => {
  assert.equal(isYardClick(true, false), true);
  assert.equal(isYardClick(false, false), false); // release after a camera drag
  assert.equal(isYardClick(true, true), false);
});

test('a run-less task that is executing (the docs bootstrap) is a Running box, not a pending crate', () => {
  const m = model([started('i1', { run: false })]);
  assert.equal(boxOf(m, 'i1')?.state, 'running');
  assert.deepEqual(m.pending, []);
});
