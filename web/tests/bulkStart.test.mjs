import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { render } from './renderHelper.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const bulk = await import('../src/lib/bulkStart.ts');
const { startOptions } = await import('../src/lib/startTaskDialog.ts');
const { resolveExecutorChoice } = await import('../src/lib/executorAvailability.ts');
const { startConfirm } = await import('../src/lib/dependencies.ts');
const { queuePlaces } = await import('../src/lib/waitingList.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { serverApi, ApiError } = await import('../src/lib/serverApi.ts');
const {
  buildBulkRows, waitsForText, selectableIds, toggleChecked, checkedRows, selectionSummary, playButtonState, SAME_AS_ALL, liveOverride, rowAgentId,
  setOverride, sameAsAllLabel, lockedAgentLabel, rowStartOptions, startButtonLabel, startBlockReason, bulkLimitNote, classifyStart, refusalMessage,
  rowStatusText, summaryLine, progressLine, failedIds, rowPickerEnabled, createBulkRunner, NO_WORKFLOW_NOTE, DEFAULTS_NOTE, NOTHING_TO_START,
  NOT_SELECTED_STATUS, NO_AGENT_REASON, NOTHING_SELECTED_REASON, PLAY_BUTTON_LABEL, AUTO_MERGE_ALL_DEFAULT, setAutoMergeOverride, rowAutoMerge,
  lockedAutoMergeLabel, rowSendOptions,
} = bulk;

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const T = '2026-11-05T10:00:00.000Z';
const NOW = Date.parse(T) / 1000;

// ---- Fixtures ----

/** An OpenTaskRow as the planning queue carries it; only the fields bulk start reads. */
const row = (id, patch = {}) => ({ id, title: id, state: 'todo', primary: 'start', workflowRunId: null, ...patch });
const task = (id, patch = {}) => ({ kind: 'task', id, order: 0, task: row(id, patch) });
const session = (id, ready, references = []) => ({ kind: 'session', id, order: 0, session: { id, kind: 'planning', ready, references } });
const reference = (id, bugs) => ({ kind: 'reference', id, order: 0, reference: { id, bugs } });
const item = (id, patch = {}) => ({ id, projectId: 'p1', title: id, description: '', status: 'pending', order: 0, taskIds: [], createdAt: T, updatedAt: T, ...patch });
const bugItem = (id, patch = {}) => item(id, { type: 'bug', bug: { infoStatus: null }, ...patch });
const DEFAULTS = { projectDefaultId: 'wf-default', enabledIds: ['wf-default', 'bug-fix'], bugWorkflowId: 'bug-fix' };
const executor = (id, label, patch = {}) => ({ id, label, kind: 'claude-cli', bin: id, env: {}, usage: {}, ...patch });
const CLAUDE = executor('claude', 'Claude Code', { isDefault: true });
const CODEX = executor('codex', 'Codex', { kind: 'codex-cli' });
const OUT = { limits: { observedAt: 1, fiveHour: { usedPercentage: 100, resetsAt: null }, sevenDay: null } };
const EXECUTORS = [CLAUDE, CODEX];
const bulkRow = (id, patch = {}) => ({ id, title: id, kind: 'Task', number: null, needsMoreInfo: false, hasParents: false, workflowId: 'wf-default', locked: false, ...patch });
const rows7 = Array.from({ length: 7 }, (_, index) => bulkRow(`r${index + 1}`));
const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Runs a batch against a scripted start, recording the call order and every result change. */
function scriptedRunner(script) {
  const calls = [];
  const results = {};
  const history = [];
  const runner = createBulkRunner(async (id) => { calls.push(id); return script(id); }, (id, result) => { results[id] = result; history.push([id, result.status]); });
  return { runner, calls, results, history };
}

// ---- Row building ----

test('U01 U04 rows follow the display order: top-level tasks, tasks nested in sessions, then bugs in reference groups, collapsed or not', () => {
  const queue = [task('a'), session('s1', [row('b'), row('c')], [{ id: 'ref1', bugs: [row('d')] }]), reference('ref2', [row('e')]), task('f')];
  const items = ['a', 'b', 'c', 'f'].map((id) => item(id)).concat([bugItem('d'), bugItem('e')]);
  assert.deepEqual(buildBulkRows(queue, items, DEFAULTS).map((r) => r.id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('U02 sessions and reference cards are never listed; only their startable cards are', () => {
  const queue = [session('s1', []), { kind: 'session', id: 's2', order: 0, session: { id: 's2', kind: 'plan-and-bugs', ready: [] } }, { kind: 'session', id: 's3', order: 0, session: { id: 's3', kind: 'bug-report', ready: [] } }, reference('ref', [])];
  assert.deepEqual(buildBulkRows(queue, [], DEFAULTS), []);
});

test('U03 only cards whose primary action is Start: waiting, queued, running and stopped cards are left out', () => {
  const queue = [
    task('start'),
    task('waiting', { waiting: { state: 'waiting', reasons: [] } }),
    task('queued', { queued: { entryId: 'e', position: 1 } }),
    task('stopped', { primary: 'resume', state: 'stopped', workflowRunId: 'run-1' }),
    task('none', { primary: 'none' }),
  ];
  assert.deepEqual(buildBulkRows(queue, [], DEFAULTS).map((r) => r.id), ['start']);
});

test('U05 type label and number come from dependencyLabel; a title with no number shows the title only', () => {
  const queue = [task('a', { title: '37.003: Login' }), task('b', { title: 'B.12: Crash' }), task('c', { title: 'P.3  T2: Plan task' }), task('d', { title: 'Plain title' })];
  const items = [item('a'), bugItem('b'), item('c'), item('d')];
  const rows = buildBulkRows(queue, items, DEFAULTS);
  assert.deepEqual(rows.map((r) => [r.kind, r.number]), [['Task', '#37.003'], ['Bug', '#B.12'], ['Task', '#P.3 T2'], ['Task', null]]);
});

test('U06 "Needs more info" only on a bug marked so, never on a task', () => {
  const queue = [task('bug', { bug: { needsMoreInfo: true } }), task('ok', { bug: { needsMoreInfo: false } }), task('task', { bug: { needsMoreInfo: true } })];
  const rows = buildBulkRows(queue, [bugItem('bug'), bugItem('ok'), item('task')], DEFAULTS);
  assert.deepEqual(rows.map((r) => r.needsMoreInfo), [true, false, false]);
});

test('U07 "Waits for" names the unsatisfied parents; none when every parent is merged or there are none', () => {
  const parent = (label, satisfied) => ({ id: label, label, title: label, satisfied, reason: null });
  assert.equal(waitsForText(startConfirm([parent('#37.003', false)])), 'Waits for #37.003');
  assert.equal(waitsForText(startConfirm([parent('#37.004', false), parent('#37.005', true), parent('#37.006', false)])), 'Waits for #37.004, #37.006');
  assert.equal(waitsForText(startConfirm([parent('#37.004', true)])), null);
  assert.equal(waitsForText([]), null);
  assert.equal(waitsForText(undefined), null);
  const rows = buildBulkRows([task('child'), task('free')], [item('child', { dependsOn: ['p'] }), item('free')], DEFAULTS);
  assert.deepEqual(rows.map((r) => r.hasParents), [true, false]);
});

test('U08 a rejected parent lookup leaves no text and the row stays startable', () => {
  // The dialog records [] for a failed lookup (useParentLookups).
  assert.equal(waitsForText([]), null);
  const rows = buildBulkRows([task('child')], [item('child', { dependsOn: ['p'] })], DEFAULTS);
  assert.equal(rows[0].locked, false);
  assert.deepEqual(selectableIds(rows), ['child']);
});

test('U09 the full title is kept, even 2,000 characters with no break', () => {
  const long = 'x'.repeat(2000);
  assert.equal(buildBulkRows([task('a', { title: long })], [item('a')], DEFAULTS)[0].title, long);
});

test('U10 on open every selectable row is checked', () => {
  assert.equal(selectionSummary(rows7, selectableIds(rows7)).text, '7 of 7 selected');
});

test('U11 no default workflow: locked, unchecked, its note, and out of the count and Select all', () => {
  const defaults = { projectDefaultId: '', enabledIds: ['wf-a', 'wf-b'], bugWorkflowId: 'bug-fix' };
  const rows = buildBulkRows([task('a'), task('b')], [item('a'), bugItem('b', { bug: { infoStatus: null } })], { ...defaults, enabledIds: ['wf-a', 'wf-b', 'bug-fix'] });
  assert.deepEqual(rows.map((r) => [r.id, r.locked, r.workflowId]), [['a', true, ''], ['b', false, 'bug-fix']]);
  assert.deepEqual(selectableIds(rows), ['b']);
  assert.equal(selectionSummary(rows, selectableIds(rows)).text, '1 of 1 selected');
  assert.deepEqual(toggleChecked(rows, [], 'a'), [], 'a locked row cannot be checked');
  assert.deepEqual(checkedRows(rows, ['a', 'b']).map((r) => r.id), ['b'], 'and is never sent');
  assert.equal(NO_WORKFLOW_NOTE, 'No default workflow · open the task to choose one');
});

test('U12 no workflows enabled: startable, and workflowId left out of the start', () => {
  const [only] = buildBulkRows([task('a')], [item('a')], { projectDefaultId: '', enabledIds: [], bugWorkflowId: 'bug-fix' });
  assert.equal(only.locked, false);
  assert.equal('workflowId' in rowStartOptions(only, 'claude', true, true), false);
});

test('U13 a bug gets the bug workflow through startWorkflowChoice, else the Project default when that one is disabled', () => {
  assert.equal(buildBulkRows([task('b')], [bugItem('b')], DEFAULTS)[0].workflowId, 'bug-fix');
  assert.equal(buildBulkRows([task('b')], [bugItem('b')], { ...DEFAULTS, enabledIds: ['wf-default'] })[0].workflowId, 'wf-default');
  assert.equal(buildBulkRows([task('t')], [item('t')], DEFAULTS)[0].workflowId, 'wf-default');
});

// ---- Selection and play button ----

test('U14 toggling rows updates the count and keeps column order', () => {
  let checked = selectableIds(rows7);
  checked = toggleChecked(rows7, checked, 'r2');
  checked = toggleChecked(rows7, checked, 'r5');
  assert.equal(selectionSummary(rows7, checked).text, '5 of 7 selected');
  assert.deepEqual(toggleChecked(rows7, checked, 'r2'), ['r1', 'r2', 'r3', 'r4', 'r6', 'r7']);
});

test('U15 Select all / none leave locked rows alone and are disabled when they would change nothing', () => {
  const rows = [...rows7.slice(0, 2), bulkRow('locked', { locked: true })];
  const all = selectionSummary(rows, selectableIds(rows));
  assert.deepEqual([all.canSelectAll, all.canSelectNone], [false, true]);
  const none = selectionSummary(rows, []);
  assert.deepEqual([none.text, none.canSelectAll, none.canSelectNone], ['0 of 2 selected', true, false]);
  assert.equal(selectableIds(rows).includes('locked'), false);
});

test('U16 the play button is enabled while one row can be checked, else disabled with its reason', () => {
  assert.deepEqual(playButtonState(rows7), { disabled: false, title: PLAY_BUTTON_LABEL });
  for (const rows of [[], [bulkRow('l', { locked: true })]]) assert.deepEqual(playButtonState(rows), { disabled: true, title: NOTHING_TO_START });
  assert.equal(NOTHING_TO_START, 'No pending task can be started from this column');
  assert.equal(PLAY_BUTTON_LABEL, 'Start pending tasks');
});

// ---- Coding agent ----

test('U17 U18 the common agent is the Start dialog preselection; a row follows it as "Same as all"', () => {
  const common = resolveExecutorChoice(EXECUTORS, '', NOW);
  assert.equal(common, 'claude');
  assert.equal(rowAgentId(EXECUTORS, common, undefined, NOW), 'claude');
  assert.equal(sameAsAllLabel(EXECUTORS, common), 'Same as all · Claude Code');
  assert.equal(liveOverride(EXECUTORS, undefined, NOW), null);
});

test('U19 U20 U21 changing the common agent moves rows that follow it; overrides stay, even one equal to the common agent; clearing follows again', () => {
  let overrides = setOverride({}, 'r2', 'codex');
  overrides = setOverride(overrides, 'r3', 'claude');
  const agents = (common) => ['r1', 'r2', 'r3'].map((id) => rowAgentId(EXECUTORS, common, overrides[id], NOW));
  assert.deepEqual(agents('claude'), ['claude', 'codex', 'claude']);
  assert.deepEqual(agents('codex'), ['codex', 'codex', 'claude'], 'r3 stays an override');
  overrides = setOverride(overrides, 'r2', SAME_AS_ALL);
  assert.equal('r2' in overrides, false);
  assert.deepEqual(agents('claude'), ['claude', 'claude', 'claude']);
});

test('U22 locked label: own pick "(chosen for this task)", a follower shows the name only', () => {
  assert.equal(lockedAgentLabel(EXECUTORS, 'claude', 'codex', NOW), 'Codex (chosen for this task)');
  assert.equal(lockedAgentLabel(EXECUTORS, 'claude', undefined, NOW), 'Claude Code');
});

test('U23 U24 an override that is out of quota or deleted falls back to the common agent', () => {
  const outCodex = [CLAUDE, { ...CODEX, ...OUT }];
  assert.equal(rowAgentId(outCodex, 'claude', 'codex', NOW), 'claude');
  assert.equal(rowAgentId(EXECUTORS, 'claude', 'deleted', NOW), 'claude');
  assert.equal(lockedAgentLabel(outCodex, 'claude', 'codex', NOW), 'Claude Code');
});

test('U25 an unchecked row\'s picker is disabled; re-checking restores its override', () => {
  assert.equal(rowPickerEnabled({ phase: 'idle', checked: false, result: undefined }), false);
  assert.equal(rowPickerEnabled({ phase: 'idle', checked: true, result: undefined }), true);
  const overrides = setOverride({}, 'r1', 'codex');
  let checked = toggleChecked(rows7, selectableIds(rows7), 'r1');
  checked = toggleChecked(rows7, checked, 'r1');
  assert.ok(checked.includes('r1'));
  assert.equal(rowAgentId(EXECUTORS, 'claude', overrides.r1, NOW), 'codex');
});

test('U26 no usable agent: Start is disabled with its reason and rows read "No agent"', () => {
  for (const executors of [[], [{ ...CLAUDE, ...OUT }]]) {
    const common = resolveExecutorChoice(executors, '', NOW);
    assert.equal(common, '');
    assert.equal(startBlockReason({ selected: 3, commonAgentId: common }), NO_AGENT_REASON);
    assert.equal(lockedAgentLabel(executors, common, undefined, NOW), 'No agent');
  }
  assert.equal(NO_AGENT_REASON, 'Add a coding agent to start tasks.');
});

// ---- Start options ----

test('AU10 a row starts with the single Start dialog\'s workflow and every step, plus this dialog\'s agent and Auto-merge', () => {
  const expected = startOptions({ executorId: 'codex', createBranch: true, hasRepository: true, autoMerge: true, workflowId: 'wf-default', skippedStepIds: [] });
  assert.deepEqual(rowStartOptions(bulkRow('a'), 'codex', true, true), expected);
  assert.deepEqual(expected, { executorId: 'codex', createBranch: true, autoMerge: true, workflowId: 'wf-default' });
  assert.equal('skippedStepIds' in expected, false);
});

test('AU11 with a repository and Auto-merge off, autoMerge false is sent', () => {
  const options = rowStartOptions(bulkRow('a'), 'claude', false, true);
  assert.equal('autoMerge' in options, true);
  assert.equal(options.autoMerge, false);
});

test('AU12 no repository: no branch and no autoMerge key, even with Auto-merge on', () => {
  assert.deepEqual(rowStartOptions(bulkRow('a'), 'claude', true, false), { executorId: 'claude', createBranch: false, workflowId: 'wf-default' });
});

test('AU13 an empty workflowId is left out while autoMerge is still sent', () => {
  assert.deepEqual(rowStartOptions(bulkRow('a', { workflowId: '' }), 'claude', true, true), { executorId: 'claude', createBranch: true, autoMerge: true });
});

// ---- Footer ----

test('U30 Start labels and the nothing-selected reason', () => {
  assert.deepEqual([0, 1, 6].map(startButtonLabel), ['Start tasks', 'Start 1 task', 'Start 6 tasks']);
  assert.equal(startBlockReason({ selected: 0, commonAgentId: 'claude' }), NOTHING_SELECTED_REASON);
  assert.equal(NOTHING_SELECTED_REASON, 'Select at least one task.');
  assert.equal(startBlockReason({ selected: 2, commonAgentId: 'claude' }), null);
});

test('U31 the plural task-limit note, hidden below the limit', () => {
  assert.equal(bulkLimitNote(6, 6), 'All 6 slots are in use; the started tasks will wait in line in this order and start on their own.');
  assert.equal(bulkLimitNote(1, 1), 'All 1 slot is in use; the started tasks will wait in line in this order and start on their own.');
  assert.equal(bulkLimitNote(5, 6), null);
});

// ---- Running a batch ----

test('U32 U33 only checked rows are sent, in column order, each after the previous one settled', async () => {
  const gates = new Map();
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runner = createBulkRunner(async (id) => {
    order.push(id); inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    const gate = deferred(); gates.set(id, gate);
    await gate.promise; inFlight -= 1;
    return { status: 'started' };
  }, () => undefined);
  const checked = toggleChecked(rows7, toggleChecked(rows7, selectableIds(rows7), 'r2'), 'r6');
  const done = runner.run(checkedRows(rows7, checked).map((r) => r.id));
  await tick();
  assert.deepEqual(order, ['r1'], 'the next start waits');
  for (const id of ['r1', 'r3', 'r4', 'r5', 'r7']) { await tick(); gates.get(id).resolve(); await tick(); }
  await done;
  assert.deepEqual(order, ['r1', 'r3', 'r4', 'r5', 'r7']);
  assert.equal(maxInFlight, 1);
  assert.equal(order.includes('r2') || order.includes('r6'), false, 'unchecked rows are never passed to start');
});

test('U34 U35 U36 classifying an accepted start: a run id, a queue entry with its Project-wide place, or waiting for parents', () => {
  assert.deepEqual(classifyStart('run-1', [], 'a'), { status: 'started' });
  const queue = [{ id: 'e1', projectId: 'p1', planItemId: 'x', position: 0, createdAt: T }, { id: 'e2', projectId: 'p1', planItemId: 'y', position: 1, createdAt: T }, { id: 'e3', projectId: 'p1', planItemId: 'a', position: 2, createdAt: T }];
  assert.deepEqual(classifyStart('', queue, 'a'), { status: 'queued', position: 3 });
  assert.deepEqual(classifyStart('', queue, 'dependent'), { status: 'waiting' });
  assert.equal(rowStatusText({ status: 'started' }), '✓ Started');
  assert.equal(rowStatusText({ status: 'queued', position: 3 }), 'Queued (position 3)');
  assert.equal(rowStatusText({ status: 'waiting' }), 'Waiting · starts by itself once its parents are merged');
});

test('U37 U38 U39 refusals mark their row and the batch carries on', async () => {
  const limit = new ApiError('This project is at its task limit', 409, { code: 'task_limit_reached', details: { limit: 6 } });
  const failures = {
    busy: new ApiError('The project folder is busy with another task', 409),
    limit,
    executor: new ApiError('Unknown executor', 400),
    network: new TypeError('Failed to fetch'),
  };
  const ids = ['ok1', 'busy', 'limit', 'executor', 'network', 'ok2'];
  const { runner, calls, results } = scriptedRunner(async (id) => { if (failures[id]) throw failures[id]; return { status: 'started' }; });
  await runner.run(ids);
  assert.deepEqual(calls, ids);
  assert.deepEqual(Object.fromEntries(ids.map((id) => [id, rowStatusText(results[id])])), {
    ok1: '✓ Started',
    busy: '✕ Not started: The project folder is busy with another task',
    limit: '✕ Not started: This project is at its task limit',
    executor: '✕ Not started: Unknown executor',
    network: '✕ Not started: Failed to fetch',
    ok2: '✓ Started',
  });
});

test('U40 a refusal with no message falls back to "Something went wrong."', () => {
  assert.equal(refusalMessage(new ApiError('', 409)), 'Something went wrong.');
  assert.equal(refusalMessage(new Error('   ')), 'Something went wrong.');
  assert.equal(refusalMessage('nope'), 'Something went wrong.');
});

test('U41 rows go Next in line, Starting, then their result; the progress line counts the batch', async () => {
  const gate = deferred();
  const { runner, results, history } = scriptedRunner(async (id) => { if (id === 'c') await gate.promise; return { status: 'started' }; });
  const sent = ['a', 'b', 'c', 'd', 'e', 'f'];
  const done = runner.run(sent);
  await tick();
  assert.equal(progressLine(sent, results), 'Starting 3 of 6…');
  assert.equal(rowStatusText(results.d), 'Next in line…');
  assert.equal(rowStatusText(results.c), 'Starting…');
  gate.resolve();
  await done;
  assert.deepEqual(history.filter(([id]) => id === 'a').map(([, status]) => status), ['next', 'starting', 'started']);
  assert.equal(progressLine(sent, results), null);
});

test('U42 the summary line leaves out zero counts', () => {
  const results = { a: { status: 'started' }, b: { status: 'started' }, c: { status: 'queued', position: 1 }, d: { status: 'waiting' }, e: { status: 'waiting' }, f: { status: 'failed', message: 'x' } };
  assert.equal(summaryLine(results), '2 started · 1 queued · 2 waiting for parents · 1 not started');
  assert.equal(summaryLine({ a: { status: 'started' } }), '1 started');
});

test('U41 Retry restarts the progress count from its own rows', async () => {
  const dialog = src('ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /function retryFailed\(\) \{\s*if \(runner\.current\?\.busy\) return;\s*setSent\(failed\);\s*void send\(failed\);/);
  const html = await body(bodyProps({ rows: rows7.slice(0, 3), phase: 'running', sent: ['r3'], results: { r1: { status: 'started' }, r2: { status: 'started' }, r3: { status: 'starting' } } }));
  assert.match(html, />Starting 1 of 1…</);
});

test('U43 an unchecked row reads "Not selected · left as it is"', () => {
  assert.equal(NOT_SELECTED_STATUS, 'Not selected · left as it is');
  assert.equal(rowStatusText(undefined), null);
});

test('U44 a second Start while running does nothing; each row is sent once', async () => {
  const gate = deferred();
  const { runner, calls } = scriptedRunner(async () => { await gate.promise; return { status: 'started' }; });
  const first = runner.run(['a', 'b']);
  assert.equal(runner.busy, true, 'busy is set before the first await');
  const second = runner.run(['a', 'b']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(runner.busy, false);
  await runner.run([]);
  assert.deepEqual(calls, ['a', 'b'], 'an empty batch sends nothing');
});

test('U45 U46 U48 after a run, Retry sends only refused rows in column order, and the count follows', async () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => bulkRow(id));
  let attempt = 0;
  const { runner, calls, results } = scriptedRunner(async (id) => {
    if (id === 'b' || id === 'd') { attempt += 1; if (attempt <= 3) throw new Error(`refused ${attempt}`); }
    return id === 'c' ? { status: 'queued', position: 1 } : { status: 'started' };
  });
  await runner.run(['a', 'b', 'c', 'd']);
  assert.deepEqual(failedIds(rows, results), ['b', 'd']);
  calls.length = 0;
  await runner.run(failedIds(rows, results));
  assert.deepEqual(calls, ['b', 'd'], 'started and queued rows are not sent again');
  assert.equal(rowStatusText(results.b), '✕ Not started: refused 3', 'the new message replaces the old');
  assert.deepEqual(failedIds(rows, results), ['b'], 'Retry failed (1)');
  calls.length = 0;
  await runner.run(failedIds(rows, results));
  assert.deepEqual(failedIds(rows, results), [], 'Retry is hidden once every row succeeded');
  assert.deepEqual(calls, ['b']);
});

test('U47 after a run only refused rows get their picker back', () => {
  assert.equal(rowPickerEnabled({ phase: 'done', checked: true, result: { status: 'failed', message: 'x' } }), true);
  for (const status of ['started', 'waiting']) assert.equal(rowPickerEnabled({ phase: 'done', checked: true, result: { status } }), false);
  assert.equal(rowPickerEnabled({ phase: 'running', checked: true, result: { status: 'failed', message: 'x' } }), false);
  assert.equal(rowPickerEnabled({ phase: 'done', checked: false, result: undefined }), false);
});

test('U49 U16 C16 close and Escape are blocked only while running; Cancel before Start sends nothing', () => {
  const dialog = src('ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /<Dialog open onOpenChange=\{\(open\) => \{ if \(!open && !running\) onClose\(\); \}\}>/);
  assert.match(dialog, /<Button type="button" variant="outline" disabled=\{!idle\} onClick=\{onClose\}>\{idle \? 'Cancel' : 'Close'\}<\/Button>/);
  // Nothing is sent before Start: the only path to the runner is startAll / Retry.
  assert.equal(dialog.match(/runner\.current\.run\(/g).length, 1);
  assert.match(dialog, /onStart=\{startAll\}/);
});

test('U50 after a run focus goes to Retry when something failed, else to Close', () => {
  const dialog = src('ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /if \(phase === 'done'\) \(failed\.length > 0 \? retryRef : closeRef\)\.current\?\.focus\(\);/);
});

test('U51 the run list is fixed at Start: a later store change adds or drops nothing', async () => {
  const dialog = src('ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /const shown = frozen \?\? rows;/);
  assert.match(dialog, /setFrozen\(rows\);\s*setSent\(ids\);/);
  // The runner itself takes its ids once.
  const ids = ['a', 'b'];
  const { runner, calls } = scriptedRunner(async (id) => { if (id === 'a') ids.push('late'); return { status: 'started' }; });
  await runner.run([...ids]);
  assert.deepEqual(calls, ['a', 'b']);
});

test('U52 Start stays disabled while parent lookups run', async () => {
  const props = bodyProps({ rows: [bulkRow('child', { hasParents: true })], checked: ['child'] });
  assert.match(await body({ ...props, parents: {} }), /<button[^>]*disabled=""[^>]*>Start 1 task<\/button>/);
  assert.doesNotMatch(await body({ ...props, parents: { child: [] } }), /<button[^>]*disabled=""[^>]*>Start 1 task<\/button>/);
});

test('U53 100 rows keep their order and are all sent one by one', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => bulkRow(`t${String(index).padStart(3, '0')}`));
  assert.equal(selectionSummary(rows, selectableIds(rows)).text, '100 of 100 selected');
  const { runner, calls } = scriptedRunner(async () => ({ status: 'started' }));
  await runner.run(checkedRows(rows, selectableIds(rows)).map((r) => r.id));
  assert.deepEqual(calls, rows.map((r) => r.id));
});

// ---- Integration: the real store with a stubbed daemon ----

/** The dialog's own start pipeline (BulkStartDialog's runner) over the store's single-start call. */
function storeRunner(rows, { common = 'claude', overrides = {}, hasRepository = true, autoMergeAll = AUTO_MERGE_ALL_DEFAULT, autoMergeOverrides = {} } = {}) {
  const results = {};
  // Mutable like the dialog's `latest.current`: a test may change a choice between runs.
  const latest = { shown: rows, overrides, commonId: common, executors: EXECUTORS, now: NOW, hasRepository, autoMergeAll, autoMergeOverrides };
  const runner = createBulkRunner(async (id) => {
    const { options } = rowSendOptions(latest, id);
    const runId = await useWorldStore.getState().startPlanItem('p1', id, options);
    return classifyStart(runId, useWorldStore.getState().planItemQueueByProject.p1, id);
  }, (id, result) => { results[id] = result; });
  return { runner, results, latest };
}

function stubDaemon(answers) {
  const saved = { ...serverApi };
  const requests = [];
  const run = (id) => ({ id: `run-${id}`, projectId: 'p1', planItemId: id, status: 'running', steps: [], createdAt: T, updatedAt: T });
  serverApi.executePlanItem = async (id, options) => { requests.push(['execute', id, options]); return answers(id) ?? { started: true, run: run(id) }; };
  serverApi.startWhenReady = async (projectId, id, options) => { requests.push(['start-when-ready', id, options]); return answers(id) ?? { started: true, run: run(id) }; };
  serverApi.updatePlanItem = async (...args) => { requests.push(['update', ...args]); throw new Error('no writes'); };
  serverApi.setDefaultExecutor = async (...args) => { requests.push(['default', ...args]); throw new Error('no writes'); };
  serverApi.setAutoMerge = async (...args) => { requests.push(['auto-merge', ...args]); throw new Error('no writes'); };
  return { requests, restore: () => Object.assign(serverApi, saved) };
}

const seed = (items) => useWorldStore.setState({ planByProject: { p1: { items } }, planItemQueueByProject: {}, workflowRunsByProject: {}, executors: EXECUTORS });
const queueEntry = (id, planItemId, position) => ({ id, projectId: 'p1', planItemId, position, createdAt: T });

test('I01 I05 AI01 AI06 a row with no parents posts the startOptions body to execute, and nothing else is written', async () => {
  // Saved Auto-merge off, yet the common switch (on) is what is sent; the daemon saves it with the start.
  seed([item('a', { autoMerge: { enabled: false } }), item('skip')]);
  const rows = [bulkRow('a'), bulkRow('skip')];
  const daemon = stubDaemon(() => null);
  try {
    const { runner, results } = storeRunner(rows, { overrides: { a: 'codex' } });
    await runner.run(checkedRows(rows, ['a']).map((r) => r.id));
    assert.deepEqual(daemon.requests, [['execute', 'a', { executorId: 'codex', createBranch: true, autoMerge: true, workflowId: 'wf-default' }]]);
    assert.deepEqual(results.a, { status: 'started' });
    assert.equal(results.skip, undefined, 'the unchecked row is untouched');
  } finally { daemon.restore(); }
});

test('I02 a row with parents goes through start-when-ready and shows Waiting', async () => {
  const child = item('child', { dependsOn: ['parent'] });
  seed([item('parent'), child]);
  const daemon = stubDaemon(() => ({ started: false, item: { ...child, waiting: { state: 'waiting', reasons: [], options: {}, since: T } } }));
  try {
    const { runner, results } = storeRunner([bulkRow('child', { hasParents: true })]);
    await runner.run(['child']);
    assert.equal(daemon.requests[0][0], 'start-when-ready');
    assert.deepEqual(results.child, { status: 'waiting' });
    assert.ok(useWorldStore.getState().planByProject.p1.items.find((i) => i.id === 'child').waiting, 'the item is reconciled');
  } finally { daemon.restore(); }
});

test('I03 a 202 queued answer adds the entry; the row\'s place equals the card badge\'s', async () => {
  seed([item('a'), item('b')]);
  useWorldStore.setState({ planItemQueueByProject: { p1: [queueEntry('e0', 'other', 0)] } });
  const daemon = stubDaemon((id) => ({ started: false, entry: queueEntry(`e-${id}`, id, 1) }));
  try {
    const { runner, results } = storeRunner([bulkRow('a')]);
    await runner.run(['a']);
    const queue = useWorldStore.getState().planItemQueueByProject.p1;
    assert.deepEqual(queue.map((e) => e.id), ['e0', 'e-a']);
    assert.deepEqual(results.a, { status: 'queued', position: queuePlaces(queue).get('a').position });
    assert.equal(results.a.position, 2);
    const groups = buildTaskGroups({ items: useWorldStore.getState().planByProject.p1.items, tasksById: {}, workflowRunsByProject: { p1: [] }, projectId: 'p1', showArchived: false, now: 0, queue });
    assert.equal(groups.waiting.find((r) => r.id === 'a').queued.position, results.a.position, 'the card\'s queued badge shows the same place');
  } finally { daemon.restore(); }
});

test('I04 a mixed batch sends every request in order: started, queued, folder busy, started', async () => {
  seed(['a', 'b', 'c', 'd'].map((id) => item(id)));
  const daemon = stubDaemon((id) => {
    if (id === 'b') return { started: false, entry: queueEntry('e-b', 'b', 0) };
    if (id === 'c') throw new ApiError('The project folder is busy', 409);
    return null;
  });
  try {
    const rows = ['a', 'b', 'c', 'd'].map((id) => bulkRow(id));
    const { runner, results } = storeRunner(rows);
    await runner.run(rows.map((r) => r.id));
    assert.deepEqual(daemon.requests.map(([, id]) => id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => results[id].status), ['started', 'queued', 'failed', 'started']);
  } finally { daemon.restore(); }
});

test('I06 the dialog looks parents up once per row with parents, and a rejection leaves no text', async () => {
  const dialog = src('ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /const key = rows\.filter\(\(row\) => row\.hasParents\)\.map\(\(row\) => row\.id\)\.join\(','\);/);
  assert.match(dialog, /if \(asked\.current\.has\(id\)\) continue;\s*asked\.current\.add\(id\);/);
  assert.match(dialog, /lookupRef\.current\(id\)\.then\(record, \(\) => record\(\[\]\)\);/);
  const panel = src('ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /lookupParents=\{\(itemId\) => serverApi\.dependencyStatus\(project\.id, itemId\)\.then\(startConfirm\)\}/);
});

test('I07 a double click while execute is pending sends one request per row', async () => {
  seed([item('a'), item('b')]);
  const gate = deferred();
  const daemon = stubDaemon(() => null);
  const execute = serverApi.executePlanItem;
  serverApi.executePlanItem = async (...args) => { await gate.promise; return execute(...args); };
  try {
    const { runner } = storeRunner([bulkRow('a'), bulkRow('b')]);
    const first = runner.run(['a', 'b']);
    const second = runner.run(['a', 'b']);
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(daemon.requests.map(([, id]) => id), ['a', 'b']);
  } finally { daemon.restore(); }
});

test('I08 Retry after a 409 asks again for that row only, which then shows Started', async () => {
  seed([item('a'), item('b')]);
  let refuse = true;
  const daemon = stubDaemon((id) => { if (id === 'b' && refuse) { refuse = false; throw new ApiError('Folder busy', 409); } return null; });
  try {
    const rows = [bulkRow('a'), bulkRow('b')];
    const { runner, results } = storeRunner(rows);
    await runner.run(['a', 'b']);
    daemon.requests.length = 0;
    await runner.run(failedIds(rows, results));
    assert.deepEqual(daemon.requests.map(([, id]) => id), ['b']);
    assert.deepEqual(results.b, { status: 'started' });
  } finally { daemon.restore(); }
});

// ---- Components ----

const DIALOG = 'src/ui/project-popup/BulkStartDialog.tsx';
const noop = () => undefined;
function bodyProps(patch = {}) {
  const rows = patch.rows ?? rows7;
  return {
    rows, checked: selectableIds(rows), overrides: {}, results: {}, sent: [], phase: 'idle', executors: EXECUTORS, commonId: 'claude', now: NOW, parents: {},
    hasRepository: true, slotsInUse: 0, autoMergeAll: true, autoMergeOverrides: {}, onCommonChange: noop, onToggle: noop, onSelectAll: noop, onSelectNone: noop, onOverride: noop,
    onAutoMergeAllChange: noop, onAutoMergeOverride: noop, onStart: noop, onRetry: noop, onClose: noop,
    ...patch,
  };
}
const body = (props) => render(DIALOG, 'BulkStartBody', props);
const panel = src('ui/project-popup/TasksPanel.tsx');

test('C01 the play button: aria-label, icon size, first in the Planning header', async () => {
  const html = await render(DIALOG, 'StartPendingButton', { rows: rows7, onOpen: noop });
  assert.match(html, /aria-label="Start pending tasks"/);
  assert.match(html, /size-8 p-0/, 'icon-sm');
  assert.doesNotMatch(html, /aria-disabled="/);
  const actions = panel.slice(panel.indexOf('function columnActions'));
  assert.ok(actions.indexOf('<StartPendingButton') < actions.indexOf("kind: 'plan-and-bugs'"));
});

test('C02 disabled play button: aria-disabled with its title, no disabled attribute, a click does nothing', async () => {
  const html = await render(DIALOG, 'StartPendingButton', { rows: [], onOpen: noop });
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /title="No pending task can be started from this column"/);
  assert.doesNotMatch(html, / disabled=""/);
  assert.match(src('ui/project-popup/BulkStartDialog.tsx'), /onClick=\{\(\) => \{ if \(!state\.disabled\) onOpen\(\); \}\}/);
});

test('C03 the Pending-only view header has the same play button', () => {
  assert.match(panel, /<BoardColumnView label="Planning · pending tasks"[^\n]*actions=\{<StartPendingButton rows=\{bulkRows\} onOpen=\{\(\) => setDialog\(\{ kind: 'bulk-start' \}\)\} \/>\}>/);
});

test('C04 the compact header keeps the buttons\' names and tooltips', () => {
  assert.match(panel, /aria-label="Plan & bugs" title="Plan & bugs"/);
  assert.match(panel, /aria-label="Task" title="Task"/);
  assert.match(src('ui/project-popup/TaskBoard.tsx'), /className=\{`@container flex min-h-0 flex-col/);
});

test('C05 the dialog opens with its picker, count, defaults note, Cancel and Start', async () => {
  const html = await body(bodyProps());
  for (const text of ['Coding agent for all', '7 of 7 selected', DEFAULTS_NOTE, '>Cancel<', '>Start 7 tasks<']) assert.ok(html.includes(text), text);
  const dialog = src('ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /<DialogTitle>Start pending tasks<\/DialogTitle>/);
  assert.match(dialog, /Starts the checked tasks one by one, in board order\./);
});

test('C06 a row: checkbox with a matching label around badge, marker, clamped title and Waits for; the picker sits outside', async () => {
  const r = bulkRow('b1', { kind: 'Bug', number: '#B.12', needsMoreInfo: true, hasParents: true, title: 'A long bug title' });
  const html = await body(bodyProps({ rows: [r], parents: { b1: [{ id: 'p', label: '#37.003', title: '', satisfied: false, status: '' }] } }));
  assert.match(html, /<button[^>]*role="checkbox"[^>]*id="bulk-start-row-b1"/);
  const start = html.lastIndexOf('<label', html.indexOf('for="bulk-start-row-b1"'));
  const label = html.slice(start, html.indexOf('</label>', start));
  assert.ok(start > 0 && label.includes('for="bulk-start-row-b1"'));
  for (const text of ['Bug', '#B.12', 'Needs more info', 'Waits for #37.003', 'line-clamp-2', 'title="A long bug title"']) assert.ok(label.includes(text), text);
  assert.ok(!label.includes('bulk-start-row-b1-agent'), 'the picker is not inside the label');
  assert.ok(html.includes('id="bulk-start-row-b1-agent"'));
});

test('C07 the row picker follows "Same as all", and an override has its own styling and label', async () => {
  const html = await body(bodyProps({ rows: [bulkRow('a', { title: 'Alpha' }), bulkRow('b', { title: 'Beta' })], overrides: { b: 'codex' } }));
  assert.ok(html.includes('Same as all · Claude Code'));
  assert.ok(html.includes('Coding agent for Alpha'));
  const beta = html.slice(html.indexOf('data-row="b"'));
  assert.match(beta, /data-overridden="true"/);
  assert.ok(beta.includes('Codex'));
});

test('C08 the shared picker takes a label and an inherit option; the Start task dialog keeps "Coding agent"', () => {
  const picker = src('ui/CodingAgentPicker.tsx');
  assert.match(picker, /\{inherit && <SelectItem value=\{inherit\.value\}>\{inherit\.label\}<\/SelectItem>\}/);
  assert.match(src('ui/project-popup/TaskDialogs.tsx'), /<CodingAgentPicker executors=\{executors\} value=\{executorId\} onChange=\{choose\} id="start-agent" \/>/);
});

test('C09 no usable agent: the empty picker text, "No agent" rows, Start disabled with the reason', async () => {
  const html = await body(bodyProps({ executors: [], commonId: '' }));
  assert.ok(html.includes('No coding agent is configured'));
  assert.ok(html.includes('No agent'));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start 7 tasks<\/button>/);
  assert.ok(html.includes(NO_AGENT_REASON));
});

test('C10 0 selected: "Start tasks" disabled with "Select at least one task."', async () => {
  const html = await body(bodyProps({ checked: [] }));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start tasks<\/button>/);
  assert.ok(html.includes(NOTHING_SELECTED_REASON));
});

test('C11 while running: inputs locked, "Starting…" disabled, Close disabled, the progress line is live', async () => {
  const rows = rows7.slice(0, 4);
  const html = await body(bodyProps({ rows, checked: ['r1', 'r2', 'r3'], phase: 'running', sent: ['r1', 'r2', 'r3'], results: { r1: { status: 'started' }, r2: { status: 'starting' }, r3: { status: 'next' } } }));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Starting…<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Close<\/button>/);
  assert.match(html, /aria-live="polite"[^>]*>Starting 2 of 3…</);
  assert.equal((html.match(/role="checkbox"[^>]*disabled=""/g) ?? []).length, 4);
  assert.ok(html.includes(NOT_SELECTED_STATUS), 'U43 an unchecked row during the run');
  assert.ok(html.includes('Next in line…'));
  assert.ok(html.includes('Claude Code'), 'locked rows show the agent as text');
});

test('C12 after the run: statuses, a red alert for a refusal, the summary, Retry failed and Close; the failed row\'s picker is enabled', async () => {
  const rows = rows7.slice(0, 4);
  const results = { r1: { status: 'started' }, r2: { status: 'failed', message: 'Folder busy' }, r3: { status: 'queued', position: 2 } };
  const html = await body(bodyProps({ rows, phase: 'done', checked: ['r1', 'r2', 'r3'], sent: ['r1', 'r2', 'r3'], results }));
  assert.match(html, /<p role="alert" class="[^"]*text-destructive">✕ Not started: Folder busy<\/p>/);
  for (const text of ['✓ Started', 'Queued (position 2)', NOT_SELECTED_STATUS, '1 started · 1 queued · 1 not started', 'Retry failed (1)', '>Close<']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, />Start (\d+ )?tasks?</, 'U45 Start is gone after the run');
  const failedRow = html.slice(html.indexOf('data-row="r2"'), html.indexOf('data-row="r3"'));
  assert.ok(failedRow.includes('id="bulk-start-row-r2-agent"'), 'a picker, not text');
  assert.doesNotMatch(failedRow, /id="bulk-start-row-r2-agent"[^>]*disabled=""/);
});

test('C13 a row with no default workflow: disabled checkbox and its note', async () => {
  const html = await body(bodyProps({ rows: [bulkRow('l', { locked: true, workflowId: '' })] }));
  assert.match(html, /role="checkbox"[^>]*disabled=""[^>]*id="bulk-start-row-l"|id="bulk-start-row-l"[^>]*disabled=""/);
  assert.ok(html.includes(NO_WORKFLOW_NOTE));
});

test('C14 the task-limit note shows at the limit', async () => {
  assert.ok((await body(bodyProps({ slotsInUse: 6 }))).includes('All 6 slots are in use; the started tasks will wait in line in this order'));
  assert.ok(!(await body(bodyProps({ slotsInUse: 2 }))).includes('slots are in use'));
});

test('C15 TasksPanel wires the dialog to the single Start\'s call, the repository and the shared slot count', () => {
  const wiring = panel.slice(panel.indexOf("dialog?.kind === 'bulk-start'"), panel.indexOf("dialog?.kind === 'archiveAll'"));
  assert.match(wiring, /start=\{actions\.start\}/);
  assert.match(wiring, /hasRepository=\{!!project\.repositoryUrl\}/);
  assert.match(wiring, /slotsInUse=\{slotsInUse\}/);
  assert.match(panel, /<StartTaskDialog[\s\S]*slotsInUse=\{slotsInUse\}/);
  assert.match(panel, /const bulkRows = buildBulkRows\(planningQueue, items, workflowDefaults\);/);
  assert.match(src('ui/project-popup/useTaskActions.ts'), /if \(notice\) toast\(notice\);\s*return runId;/);
});

test('C17 the blueprint\'s Tasks board section describes the play button and the dialog', () => {
  const blueprint = readFileSync(new URL('../../.docs/blueprint.md', import.meta.url), 'utf8');
  assert.match(blueprint, /Start pending tasks/);
  assert.match(blueprint, /web\/src\/lib\/bulkStart\.ts/);
});

// ---- Auto-merge (task 38.001): unit ----

test('AU01 "Auto-merge for all" is on by default', () => {
  assert.equal(AUTO_MERGE_ALL_DEFAULT, true);
});

test('AU02 a row with no override follows the common switch', () => {
  assert.equal(rowAutoMerge(true, undefined), true);
  assert.equal(rowAutoMerge(false, undefined), false);
});

test('AU03 switching the common value moves every row that has no override', () => {
  const values = (common) => ['a', 'b'].map((id) => rowAutoMerge(common, ({})[id]));
  assert.deepEqual(values(true), [true, true]);
  assert.deepEqual(values(false), [false, false]);
});

test('AU04 an override survives a common toggle, in either direction', () => {
  const overrides = setAutoMergeOverride({}, 'b', true);
  const values = (common) => ['a', 'b'].map((id) => rowAutoMerge(common, overrides[id]));
  assert.deepEqual(values(true), [true, true]);
  assert.deepEqual(values(false), [false, true], 'b keeps its own value; a follows');
  assert.equal(rowAutoMerge(true, setAutoMergeOverride({}, 'c', false).c), false);
});

test('AU05 an override equal to the common value stays an override', () => {
  const overrides = setAutoMergeOverride({}, 'a', true);
  assert.equal(rowAutoMerge(false, overrides.a), true);
});

test('AU06 clearing an override ("Same as all") makes the row follow again', () => {
  const overrides = setAutoMergeOverride(setAutoMergeOverride({}, 'a', false), 'a', null);
  assert.equal('a' in overrides, false);
  assert.equal(rowAutoMerge(true, overrides.a), true);
});

test('AU07 setAutoMergeOverride never mutates its input; clearing an id with no override returns an equal map', () => {
  const input = Object.freeze({ a: true });
  const set = setAutoMergeOverride(input, 'b', false);
  assert.deepEqual(input, { a: true });
  assert.deepEqual(set, { a: true, b: false });
  const cleared = setAutoMergeOverride(input, 'missing', null);
  assert.deepEqual(cleared, { a: true });
  assert.notEqual(cleared, input);
});

test('AU08 a stale override for a row no longer listed changes no other row', () => {
  const rows = [bulkRow('a'), bulkRow('b')];
  const snapshot = (autoMergeOverrides) => ({ shown: rows, overrides: {}, commonId: 'claude', executors: EXECUTORS, now: NOW, hasRepository: true, autoMergeAll: true, autoMergeOverrides });
  for (const id of ['a', 'b']) assert.deepEqual(rowSendOptions(snapshot({ ghost: false }), id), rowSendOptions(snapshot({}), id));
});

test('AU09 locked label: on/off, and "(chosen for this task)" for a row\'s own value, even one equal to the common one', () => {
  assert.equal(lockedAutoMergeLabel(true, undefined), 'Auto-merge on');
  assert.equal(lockedAutoMergeLabel(false, undefined), 'Auto-merge off');
  assert.equal(lockedAutoMergeLabel(false, true), 'Auto-merge on (chosen for this task)');
  assert.equal(lockedAutoMergeLabel(true, false), 'Auto-merge off (chosen for this task)');
  assert.equal(lockedAutoMergeLabel(true, true), 'Auto-merge on (chosen for this task)');
});

test('AU14 rows no longer carry the task\'s saved Auto-merge', () => {
  const rows = buildBulkRows([task('on'), task('off')], [item('on', { autoMerge: { enabled: true } }), item('off', { autoMerge: { enabled: false } })], DEFAULTS);
  for (const r of rows) assert.equal('autoMerge' in r, false);
});

const snapshotOf = (rows, patch = {}) => ({ shown: rows, overrides: {}, commonId: 'claude', executors: EXECUTORS, now: NOW, hasRepository: true, autoMergeAll: true, autoMergeOverrides: {}, ...patch });

test('AU15 the saved setting is ignored end to end: the common switch decides', () => {
  const rows = buildBulkRows([task('on'), task('off')], [item('on', { autoMerge: { enabled: true } }), item('off', { autoMerge: { enabled: false } })], DEFAULTS);
  assert.equal(rowSendOptions(snapshotOf(rows), 'off').options.autoMerge, true, 'saved Off sends true under common ON');
  assert.equal(rowSendOptions(snapshotOf(rows, { autoMergeAll: false }), 'on').options.autoMerge, false, 'saved On sends false under common OFF');
});

test('AU16 rowSendOptions combines the agent and Auto-merge overrides per row', () => {
  const rows = [bulkRow('own'), bulkRow('follower')];
  const snapshot = snapshotOf(rows, { overrides: { own: 'codex' }, autoMergeOverrides: { own: false } });
  const own = rowSendOptions(snapshot, 'own');
  assert.equal(own.row, rows[0]);
  assert.deepEqual(own.options, { executorId: 'codex', createBranch: true, autoMerge: false, workflowId: 'wf-default' });
  assert.deepEqual(rowSendOptions(snapshot, 'follower').options, { executorId: 'claude', createBranch: true, autoMerge: true, workflowId: 'wf-default' });
});

test('AU17 without a repository no autoMerge is sent, overrides or not', () => {
  const rows = [bulkRow('a')];
  const { options } = rowSendOptions(snapshotOf(rows, { hasRepository: false, autoMergeOverrides: { a: true } }), 'a');
  assert.equal('autoMerge' in options, false);
  assert.equal(options.createBranch, false);
});

test('AU17b a row that is not listed is refused, so the runner marks it failed', async () => {
  assert.throws(() => rowSendOptions(snapshotOf([]), 'gone'), /Row gone is not listed\./);
  const results = {};
  await createBulkRunner(async (id) => { rowSendOptions(snapshotOf([]), id); return { status: 'started' }; }, (id, result) => { results[id] = result; }).run(['gone']);
  assert.deepEqual(results.gone, { status: 'failed', message: 'Row gone is not listed.' });
});

test('AU18 Retry reads the latest value: a refused row is re-sent with the switch it shows now', async () => {
  const rows = [bulkRow('a'), bulkRow('b')];
  const latest = snapshotOf(rows);
  const sent = [];
  let refuse = true;
  const results = {};
  const runner = createBulkRunner(async (id) => {
    const { options } = rowSendOptions(latest, id);
    sent.push([id, options.autoMerge]);
    if (id === 'b' && refuse) { refuse = false; throw new Error('busy'); }
    return { status: 'started' };
  }, (id, result) => { results[id] = result; });
  await runner.run(['a', 'b']);
  latest.autoMergeOverrides = setAutoMergeOverride(latest.autoMergeOverrides, 'b', false);
  await runner.run(failedIds(rows, results));
  assert.deepEqual(sent, [['a', true], ['b', true], ['b', false]]);
});

test('AU19 a change made while an earlier row is starting reaches the later row', async () => {
  const rows = [bulkRow('a'), bulkRow('b')];
  const latest = snapshotOf(rows);
  const gate = deferred();
  const sent = {};
  const runner = createBulkRunner(async (id) => {
    sent[id] = rowSendOptions(latest, id).options.autoMerge;
    if (id === 'a') await gate.promise;
    return { status: 'started' };
  }, () => undefined);
  const done = runner.run(['a', 'b']);
  await tick();
  latest.autoMergeOverrides = { b: false };
  gate.resolve();
  await done;
  assert.deepEqual(sent, { a: true, b: false });
});

test('AU20 the defaults note no longer says the options are the task\'s own', () => {
  assert.equal(DEFAULTS_NOTE, 'Each task runs its default workflow with every step. Open a task to change them.');
});

// ---- Auto-merge: integration with the real store and a stubbed daemon ----

test('AI02 one batch sends each row\'s own value in order: an override off, then a follower on', async () => {
  seed([item('a'), item('b')]);
  const daemon = stubDaemon(() => null);
  try {
    const { runner } = storeRunner([bulkRow('a'), bulkRow('b')], { autoMergeOverrides: { a: false } });
    await runner.run(['a', 'b']);
    assert.deepEqual(daemon.requests.map(([kind, id, options]) => [kind, id, options.autoMerge]), [['execute', 'a', false], ['execute', 'b', true]]);
  } finally { daemon.restore(); }
});

test('AI03 a row with parents sends autoMerge through start-when-ready', async () => {
  const child = item('child', { dependsOn: ['parent'] });
  seed([item('parent'), child]);
  const daemon = stubDaemon(() => ({ started: false, item: { ...child, waiting: { state: 'waiting', reasons: [], options: {}, since: T } } }));
  try {
    const { runner } = storeRunner([bulkRow('child', { hasParents: true })], { autoMergeAll: false });
    await runner.run(['child']);
    assert.deepEqual(daemon.requests[0], ['start-when-ready', 'child', { executorId: 'claude', createBranch: true, autoMerge: false, workflowId: 'wf-default', uiPlanningWaitsForParent: false }]);
  } finally { daemon.restore(); }
});

test('AI04 a 202 queued answer: the request carried autoMerge and the row shows Queued', async () => {
  seed([item('a')]);
  const daemon = stubDaemon((id) => ({ started: false, entry: queueEntry(`e-${id}`, id, 0) }));
  try {
    const { runner, results } = storeRunner([bulkRow('a')]);
    await runner.run(['a']);
    assert.equal(daemon.requests[0][2].autoMerge, true);
    assert.deepEqual(results.a, { status: 'queued', position: 1 });
  } finally { daemon.restore(); }
});

test('AI05 no repository: the execute body has no autoMerge key and no branch', async () => {
  seed([item('a')]);
  const daemon = stubDaemon(() => null);
  try {
    const { runner } = storeRunner([bulkRow('a')], { hasRepository: false, autoMergeOverrides: { a: true } });
    await runner.run(['a']);
    assert.deepEqual(daemon.requests, [['execute', 'a', { executorId: 'claude', createBranch: false, workflowId: 'wf-default' }]]);
  } finally { daemon.restore(); }
});

test('AI07 Retry after a 409 re-sends only that row, with its flipped Auto-merge', async () => {
  seed([item('a'), item('b')]);
  let refuse = true;
  const daemon = stubDaemon((id) => { if (id === 'b' && refuse) { refuse = false; throw new ApiError('Folder busy', 409); } return null; });
  try {
    const rows = [bulkRow('a'), bulkRow('b')];
    const { runner, results, latest } = storeRunner(rows);
    await runner.run(['a', 'b']);
    latest.autoMergeOverrides = setAutoMergeOverride(latest.autoMergeOverrides, 'b', false);
    daemon.requests.length = 0;
    await runner.run(failedIds(rows, results));
    assert.deepEqual(daemon.requests.map(([, id, options]) => [id, options.autoMerge]), [['b', false]]);
    assert.deepEqual(results.b, { status: 'started' });
  } finally { daemon.restore(); }
});

// ---- Auto-merge: components ----

const tagWithId = (html, id) => html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
const rowSwitch = (html, id) => tagWithId(html, `bulk-start-row-${id}-auto-merge`);
const COMMON_SWITCH = 'bulk-start-auto-merge';
const ab = [bulkRow('a', { title: 'Alpha' }), bulkRow('b', { title: 'Beta' })];
const rowHtml = (html, id) => { const start = html.indexOf(`data-row="${id}"`); const end = html.indexOf('data-row="', start + 1); return html.slice(start, end === -1 ? undefined : end); };

test('AC01 "Auto-merge for all": label, default-size switch on, help line, between the agent picker and the list', async () => {
  const html = await body(bodyProps({ rows: ab }));
  assert.match(html, /<label[^>]*for="bulk-start-auto-merge"[^>]*>Auto-merge for all<\/label>/);
  const common = tagWithId(html, COMMON_SWITCH);
  assert.match(common, /role="switch"/);
  assert.match(common, /aria-checked="true"/);
  assert.match(common, /data-size="default"/);
  assert.match(html, /Merges each task(&#x27;|')s pull request once it completes\./);
  const at = html.indexOf(`id="${COMMON_SWITCH}"`);
  assert.ok(html.indexOf('id="bulk-start-agent"') < at && at < html.indexOf('<ul'));
});

test('AC02 default ON: the dialog starts with AUTO_MERGE_ALL_DEFAULT and no overrides; every row switch is on', async () => {
  const dialog = src('ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /const \[autoMergeAll, setAutoMergeAll\] = useState\(AUTO_MERGE_ALL_DEFAULT\);/);
  assert.match(dialog, /const \[autoMergeOverrides, setAutoMergeOverrides\] = useState<Record<string, boolean>>\(\{\}\);/);
  const html = await body(bodyProps({ rows: ab }));
  for (const id of ['a', 'b']) assert.match(rowSwitch(html, id), /aria-checked="true"/, id);
});

test('AC03 common OFF flows to every row without an override', async () => {
  const html = await body(bodyProps({ rows: ab, autoMergeAll: false }));
  assert.match(tagWithId(html, COMMON_SWITCH), /aria-checked="false"/);
  for (const id of ['a', 'b']) assert.match(rowSwitch(html, id), /aria-checked="false"/, id);
});

test('AC04 a row override shows its own value and the overridden marker', async () => {
  const html = await body(bodyProps({ rows: ab, autoMergeAll: false, autoMergeOverrides: { b: true } }));
  assert.match(rowSwitch(html, 'a'), /aria-checked="false"/);
  assert.match(rowSwitch(html, 'b'), /aria-checked="true"/);
  const label = rowHtml(html, 'b').match(/<label[^>]*data-auto-merge-overridden="true"[^>]*>/)?.[0];
  assert.ok(label, 'overridden marker');
  assert.match(label, /data-\[auto-merge-overridden=true\]:font-semibold/);
  assert.match(label, /data-\[auto-merge-overridden=true\]:text-foreground/);
  assert.doesNotMatch(rowHtml(html, 'a'), /data-auto-merge-overridden=/);
});

test('AC05 "Same as all" only on an overridden row, with its name and a 24px hit area', async () => {
  const html = await body(bodyProps({ rows: ab, autoMergeOverrides: { b: false } }));
  assert.doesNotMatch(rowHtml(html, 'a'), /Same as all</);
  const button = rowHtml(html, 'b').match(/<button[^>]*aria-label="Use auto-merge for all for Beta"[^>]*>Same as all<\/button>/)?.[0];
  assert.ok(button, 'Same as all button');
  assert.match(button, /h-6/);
});

test('AC06 the row switch: its name, default size, outside the checkbox label', async () => {
  const html = await body(bodyProps({ rows: ab }));
  const tag = rowSwitch(html, 'a');
  assert.match(tag, /aria-label="Auto-merge for Alpha"/);
  assert.match(tag, /data-size="default"/);
  const start = html.lastIndexOf('<label', html.indexOf('for="bulk-start-row-a"'));
  const label = html.slice(start, html.indexOf('</label>', start));
  assert.ok(!label.includes('bulk-start-row-a-auto-merge'));
});

test('AC07 titles are escaped in the switch and "Same as all" names; a 2,000-character title is kept whole', async () => {
  const html = await body(bodyProps({ rows: [bulkRow('q', { title: 'Fix "a" & b' })], autoMergeOverrides: { q: true } }));
  assert.match(rowSwitch(html, 'q'), /aria-label="Auto-merge for Fix &quot;a&quot; &amp; b"/);
  assert.ok(html.includes('aria-label="Use auto-merge for all for Fix &quot;a&quot; &amp; b"'));
  const long = 'x'.repeat(2000);
  assert.ok((await body(bodyProps({ rows: [bulkRow('l', { title: long })] }))).includes(`aria-label="Auto-merge for ${long}"`));
});

test('AC08 without a repository no Auto-merge control or text shows, in any phase', async () => {
  const results = { a: { status: 'started' }, b: { status: 'failed', message: 'x' } };
  for (const patch of [{}, { phase: 'running', sent: ['a', 'b'], results: { a: { status: 'starting' } } }, { phase: 'done', sent: ['a', 'b'], results }]) {
    const html = await body(bodyProps({ rows: ab, hasRepository: false, autoMergeOverrides: { b: false }, ...patch }));
    assert.ok(!html.includes('Auto-merge for all'));
    assert.doesNotMatch(html, /role="switch"/);
    assert.doesNotMatch(html, /Auto-merge (on|off)/);
  }
});

test('AC09 idle: an unchecked row\'s switch and "Same as all" are disabled, a checked row\'s are enabled, the common switch is enabled', async () => {
  const html = await body(bodyProps({ rows: ab, checked: ['b'], autoMergeOverrides: { a: true, b: true } }));
  assert.match(rowSwitch(html, 'a'), /disabled=""/);
  assert.match(rowHtml(html, 'a'), /<button[^>]*disabled=""[^>]*>Same as all</);
  assert.doesNotMatch(rowSwitch(html, 'b'), /disabled=""/);
  assert.doesNotMatch(rowHtml(html, 'b'), /<button[^>]*disabled=""[^>]*>Same as all</);
  assert.doesNotMatch(tagWithId(html, COMMON_SWITCH), /disabled=""/);
});

test('AC10 running: the common switch is disabled and rows show their value as text', async () => {
  const html = await body(bodyProps({ rows: ab, phase: 'running', sent: ['a', 'b'], autoMergeOverrides: { b: false }, results: { a: { status: 'starting' }, b: { status: 'next' } } }));
  assert.match(tagWithId(html, COMMON_SWITCH), /disabled=""/);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 1, 'only the common switch');
  assert.match(rowHtml(html, 'a'), />Auto-merge on</);
  assert.match(rowHtml(html, 'b'), />Auto-merge off \(chosen for this task\)</);
});

test('AC11 done: only a refused row gets its switch (and "Same as all") back; started and unselected rows show text', async () => {
  const rows = [...ab, bulkRow('c', { title: 'Gamma' })];
  const results = { a: { status: 'started' }, b: { status: 'failed', message: 'busy' } };
  const html = await body(bodyProps({ rows, phase: 'done', checked: ['a', 'b'], sent: ['a', 'b'], results, autoMergeOverrides: { b: false } }));
  assert.match(tagWithId(html, COMMON_SWITCH), /disabled=""/);
  assert.doesNotMatch(rowSwitch(html, 'b'), /disabled=""/);
  const sameAsAll = rowHtml(html, 'b').match(/<button[^>]*>Same as all<\/button>/)?.[0];
  assert.ok(sameAsAll && !sameAsAll.includes('disabled=""'));
  assert.equal(rowSwitch(html, 'a'), undefined);
  assert.equal(rowSwitch(html, 'c'), undefined);
  assert.match(rowHtml(html, 'a'), />Auto-merge on</);
  assert.match(rowHtml(html, 'c'), />Auto-merge on</);
});

test('AC12 no usable agent: rows read "No agent" but keep their switch, and the common field shows', async () => {
  const html = await body(bodyProps({ rows: ab, executors: [], commonId: '' }));
  assert.ok(html.includes('No agent'));
  assert.ok(rowSwitch(html, 'a') && rowSwitch(html, 'b'));
  assert.ok(tagWithId(html, COMMON_SWITCH));
});

test('AC13 the new defaults note shows while idle and is gone after Start', async () => {
  assert.ok((await body(bodyProps({ rows: ab }))).includes(DEFAULTS_NOTE));
  assert.ok(!(await body(bodyProps({ rows: ab, phase: 'running', sent: ['a'], results: { a: { status: 'starting' } } }))).includes(DEFAULTS_NOTE));
});

test('AC14 a row locked for want of a default workflow has a disabled switch', async () => {
  const html = await body(bodyProps({ rows: [bulkRow('l', { locked: true, workflowId: '' })] }));
  assert.match(rowSwitch(html, 'l'), /disabled=""/);
});

test('AC15 the dialog sends what rowSendOptions reads from its latest choices, and the switches call their setters', () => {
  const dialog = src('ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /latest\.current = \{[^}]*autoMergeAll, autoMergeOverrides[^}]*\};/);
  assert.match(dialog, /const current = latest\.current;\s*const \{ row, options \} = rowSendOptions\(current, id\);\s*const runId = await current\.start\(row, options\);/);
  assert.match(dialog, /onChange=\{\(value\) => onAutoMergeOverride\(row\.id, value\)\}/);
  assert.match(dialog, /onClick=\{\(\) => onChange\(null\)\}>Same as all</);
  assert.match(dialog, /onAutoMergeAllChange=\{setAutoMergeAll\}/);
  assert.match(dialog, /onAutoMergeOverride=\{\(id, value\) => setAutoMergeOverrides\(\(current\) => setAutoMergeOverride\(current, id, value\)\)\}/);
});

test('AC16 the spec and the known gaps describe the Auto-merge switches', () => {
  const spec = readFileSync(new URL('../../docs/unified-planning-board.md', import.meta.url), 'utf8');
  assert.match(spec, /\*\*Auto-merge for all\*\*/);
  assert.doesNotMatch(spec, /its own Auto-merge setting/);
  const testing = readFileSync(new URL('../../.docs/testing.md', import.meta.url), 'utf8');
  assert.match(testing, /Auto-merge toggles \(task 38\.001\)/);
});

test('AC17 the task\'s saved Auto-merge is no longer read by bulk start', () => {
  for (const path of ['lib/bulkStart.ts', 'ui/project-popup/BulkStartDialog.tsx']) {
    const code = src(path);
    assert.ok(!code.includes('row.autoMerge') && !code.includes('item?.autoMerge'), path);
  }
});
