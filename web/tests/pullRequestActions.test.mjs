import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const {
  CONFLICT_NOTE, EMPTY_PR_ACTIONS, applyMergeStateResponse, conflictRunFor, isActivePhase, isCheckedOut, mergeClickTarget,
  mergeConfirmation, mergeNotice, mergeRequestFor, mergeStatesToLoad, prRowModel, returnMenuItem, runPhase, runStatusLabel, withHeldRows, without,
} = await import('../src/lib/pullRequestActions.ts');
const { buildCompletedRows, planItemTypeLabel } = await import('../src/lib/projectTasks.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { cardDetail } = await import('../src/lib/taskBoard.ts');
const { prReadings } = await import('../src/lib/pullRequestReadings.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE, reportedError } = await import('./errorHelpers.mjs');

/** Web cases WU1 to WU21 (pure row decisions), WS1 to WS9 (the store against the stub) and WC1 to WC6 (source wiring). */

const pr = (number, extra = {}) => ({
  number, title: `PR ${number}`, headBranch: `feature/${number}`, baseBranch: 'main', author: 'octo', url: `https://github.com/o/r/pull/${number}`,
  isDraft: false, createdAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00.000Z`, updatedAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00.000Z`, ...extra,
});
const mergeState = (number, extra = {}) => ({
  number, title: `PR ${number}`, status: 'clean', blockers: [], reason: null, headBranch: `feature/${number}`, baseBranch: 'main', headBranchExists: true, isFork: false, ...extra,
});
const read = (state) => ({ key: 'k', loading: false, state, error: null });
const run = (number, extra = {}) => ({
  id: `run-${number}`, projectId: 'p', planItemId: `item-${number}`, status: 'running', executorId: 'claude-work', attentionReason: null,
  createdAt: '2026-02-01T00:00:00.000Z', prConflict: { number, title: `PR ${number}`, headBranch: `feature/${number}`, baseBranch: 'main', pushRemote: 'origin', outcome: null, detail: null },
  ...extra,
});
const session = (extra = {}) => ({ status: 'developing', runtimeStatus: 'running', ...extra });
const row = (extra = {}) => prRowModel({ pr: pr(5), reading: read(mergeState(5)), run: null, checkout: null, currentBranch: 'main', busy: undefined, rowError: undefined, ...extra });

// ---- WU: row model ----

test('WU1 a clean PR offers Check out and Merge, both enabled', () => {
  const model = row();
  assert.deepEqual(model.checkout, { kind: 'button', disabled: false, pending: false, reason: null });
  assert.deepEqual(model.merge, { kind: 'button', label: 'Merge', opens: 'merge' });
  assert.deepEqual([model.notes, model.badges, model.run, model.error], [[], [], null, null]);
});

test('WU2 a conflicting PR keeps Merge enabled and notes that it conflicts with its base', () => {
  const model = row({ reading: read(mergeState(5, { status: 'conflicts' })) });
  assert.deepEqual(model.merge, { kind: 'button', label: 'Merge', opens: 'agent' });
  assert.deepEqual(model.notes, [{ tone: 'warning', text: CONFLICT_NOTE }]);
  assert.equal(CONFLICT_NOTE, 'This PR conflicts with its base');
  assert.equal(model.checkout.disabled, false, 'it can still be checked out to look at');
});

test('WU3 a blocked PR keeps Merge enabled and shows its blockers as one plain-words line', () => {
  const model = row({ reading: read(mergeState(5, { status: 'blocked', blockers: ['Checks are failing', 'Changes were requested'] })) });
  assert.deepEqual(model.merge, { kind: 'button', label: 'Merge', opens: 'confirm' });
  assert.deepEqual(model.notes, [{ tone: 'warning', text: 'Checks are failing · Changes were requested' }]);
});

test('WU3 conflicts with blockers shows both lines', () => {
  const model = row({ reading: read(mergeState(5, { status: 'conflicts', blockers: ['This PR is a draft'] })) });
  assert.deepEqual(model.notes.map((line) => line.text), [CONFLICT_NOTE, 'This PR is a draft']);
});

test('WU4 an unmergeable PR has no Merge, its reason in that place, and Check out still offered', () => {
  const model = row({ reading: read(mergeState(5, { status: 'unmergeable', reason: 'Your account can\'t merge in this repository' })) });
  assert.deepEqual(model.merge, { kind: 'hidden', reason: 'Your account can\'t merge in this repository' });
  assert.equal(mergeClickTarget(model), 'none');
  assert.deepEqual(model.checkout, { kind: 'button', disabled: false, pending: false, reason: null });
  assert.deepEqual(model.notes, []);
});

test('WU5 a PR whose head branch is gone has Check out disabled with the reason, and no Merge', () => {
  const model = row({ reading: read(mergeState(5, { status: 'unmergeable', reason: 'The head branch no longer exists', headBranchExists: false })) });
  assert.deepEqual(model.checkout, { kind: 'button', disabled: true, pending: false, reason: 'The head branch no longer exists' });
  assert.equal(model.merge.kind, 'hidden');
});

test('WU6 an unreadable merge state shows the error with Retry, no Merge, and Check out still offered', () => {
  const model = row({ reading: { key: 'k', loading: false, state: null, error: 'GitHub CLI is not signed in.' } });
  assert.deepEqual(model.error, { message: 'GitHub CLI is not signed in.', retry: 'merge-state' });
  assert.deepEqual(model.merge, { kind: 'hidden', reason: null });
  assert.equal(model.checkout.kind, 'button');
  assert.equal(model.checkout.disabled, false);
});

test('WU7 a merge state not loaded yet shows Merge as loading, never as an enabled button', () => {
  for (const reading of [undefined, { key: 'k', loading: true, state: null, error: null }]) {
    const model = row({ reading });
    assert.deepEqual(model.merge, { kind: 'loading' });
    assert.equal(mergeClickTarget(model), 'none');
    assert.equal(model.error, null);
  }
  // A row being re-read keeps its last known buttons instead of flickering to a spinner.
  assert.equal(row({ reading: { key: 'k', loading: true, state: mergeState(5), error: null } }).merge.kind, 'button');
});

test('WU8 the checked-out row shows "Checked out" in place of the button, and "Return to <previous branch>"', () => {
  const model = row({ checkout: { number: 5, branch: 'feature/5', previousBranch: 'develop' }, currentBranch: 'feature/5' });
  assert.deepEqual(model.checkout, { kind: 'checked-out', returnLabel: 'Return to develop', returnError: null });
  assert.equal(model.merge.kind, 'button', 'merging still works from the checked-out row');
});

const checkedOut = { checkout: { number: 5, branch: 'feature/5', previousBranch: 'develop' }, currentBranch: 'feature/5' };

test('WU8 a Return the daemon refused (uncommitted changes, folder in use) shows its message on the checked-out row', () => {
  for (const message of ['Commit or discard local changes before switching branches, or create a new branch to carry them over.', 'Work is already running in project "X"\'s own folder']) {
    const model = row({ ...checkedOut, returnError: { message, defaultBranch: null } });
    assert.deepEqual(model.checkout, { kind: 'checked-out', returnLabel: 'Return to develop', returnError: message });
  }
  // Only the checked-out row carries it: another PR's row is unchanged.
  assert.deepEqual(row({ pr: pr(6), ...checkedOut, returnError: { message: 'nope', defaultBranch: null } }).checkout, { kind: 'button', disabled: false, pending: false, reason: null });
});

test('WU8 when the previous branch is gone the row explains it and its button becomes "Return to <default branch>"', () => {
  const message = 'The branch "develop" you were on before no longer exists. Return to "main" instead.';
  const model = row({ ...checkedOut, returnError: { message, defaultBranch: 'main' } });
  assert.deepEqual(model.checkout, { kind: 'checked-out', returnLabel: 'Return to main', returnBranch: 'main', returnError: message });
});

test('WU9 checked-out needs both the PR number and the current branch to match', () => {
  const checkout = { number: 5, branch: 'feature/5', previousBranch: 'main' };
  assert.equal(isCheckedOut(pr(5), checkout, 'feature/5'), true);
  assert.equal(isCheckedOut(pr(6, { headBranch: 'feature/5' }), checkout, 'feature/5'), false, 'another PR with the same branch name');
  assert.equal(isCheckedOut(pr(5), checkout, 'main'), false, 'the folder has moved to another branch since');
  assert.equal(isCheckedOut(pr(5), null, 'feature/5'), false);
  assert.equal(isCheckedOut(pr(5), undefined, null), false);
  assert.equal(row({ pr: pr(6), checkout, currentBranch: 'feature/5' }).checkout.kind, 'button');
});

test('WU10 what a Merge click opens for each state', () => {
  assert.equal(mergeClickTarget(row()), 'merge');
  assert.equal(mergeClickTarget(row({ reading: read(mergeState(5, { status: 'blocked', blockers: ['x'] })) })), 'confirm');
  assert.equal(mergeClickTarget(row({ reading: read(mergeState(5, { status: 'conflicts' })) })), 'agent');
  const active = row({ reading: read(mergeState(5, { status: 'conflicts' })), run: run(5), runSession: session() });
  assert.deepEqual(active.merge, { kind: 'run' });
  assert.equal(mergeClickTarget(active), 'none', 'a run is already working on it: only its status shows');
  assert.equal(active.run.phase, 'resolving');
  assert.equal(mergeClickTarget(row({ busy: 'merging' })), 'none');
});

test('WU11 conflicts resolved with blockers left shows the badge, and Merge opens the confirmation, not the agent dialog', () => {
  const resolved = run(5, { status: 'completed', prConflict: { ...run(5).prConflict, outcome: 'resolved', detail: 'Conflicts resolved.' } });
  const model = row({ reading: read(mergeState(5, { status: 'blocked', blockers: ['This PR is a draft'] })), run: resolved });
  assert.deepEqual(model.badges, ['Conflicts resolved']);
  assert.equal(mergeClickTarget(model), 'confirm');
  assert.equal(model.run.phase, 'resolved');
  assert.equal(model.run.reason, null);
  // If the PR conflicts again later, the old success no longer claims anything.
  assert.deepEqual(row({ reading: read(mergeState(5, { status: 'conflicts' })), run: resolved }).badges, []);
});

test('WU12 after a failed or stopped run the button reads Retry and opens the agent dialog again', () => {
  const conflicts = read(mergeState(5, { status: 'conflicts' }));
  const failed = row({ reading: conflicts, run: run(5, { status: 'needs-attention', attentionReason: 'Resolve conflicts step ended without completing.' }), runSession: session({ status: 'failed' }) });
  assert.deepEqual(failed.merge, { kind: 'button', label: 'Retry', opens: 'agent' });
  assert.deepEqual([failed.run.phase, failed.run.reason], ['failed', 'Resolve conflicts step ended without completing.']);
  assert.deepEqual(failed.notes, [{ tone: 'warning', text: CONFLICT_NOTE }]);

  const stopped = row({ reading: conflicts, run: run(5, { status: 'stopped' }) });
  assert.deepEqual(stopped.merge, { kind: 'button', label: 'Retry', opens: 'agent' });
  assert.match(stopped.run.reason, /stopped before it finished\. Nothing was merged/);

  // The run failed at the merge itself, after resolving: the PR is clean now, so it merges directly.
  const mergeFailed = row({ run: run(5, { status: 'failed', attentionReason: 'Conflicts were resolved, but the merge failed: nope' }) });
  assert.deepEqual(mergeFailed.merge, { kind: 'button', label: 'Merge', opens: 'merge' });
  assert.equal(mergeFailed.run.reason, 'Conflicts were resolved, but the merge failed: nope');
});

test('WU13 the confirmation lists each blocker; Cancel makes no request and "Merge anyway" sends the confirmation flag', () => {
  const model = mergeConfirmation(pr(5), ['Checks are failing', 'This PR is a draft']);
  assert.equal(model.title, 'Merge #5 PR 5?');
  assert.deepEqual(model.blockers, ['Checks are failing', 'This PR is a draft']);
  assert.equal(model.confirmLabel, 'Merge anyway');
  assert.match(model.description, /has problems\. You can merge it anyway/);
  assert.match(mergeConfirmation(pr(5), ['Checks are failing']).description, /has a problem\./);
  assert.deepEqual(mergeRequestFor({ kind: 'confirm' }), { confirmBlockers: true });
  assert.deepEqual(mergeRequestFor({ kind: 'agent', executorId: 'claude-work' }), { executorId: 'claude-work' });
});

test('WU14 the run status label for each state names the chosen agent', () => {
  const phases = [
    [run(5), session({ runtimeStatus: 'starting' }), 'starting', 'Starting · Claude (work)'],
    [run(5), null, 'starting', 'Starting · Claude (work)'],
    [run(5), session(), 'resolving', 'Resolving conflicts · Claude (work)'],
    [run(5, { status: 'needs-attention' }), session({ status: 'blocked', runtimeStatus: 'waiting_input' }), 'waiting', 'Waiting for your answer · Claude (work)'],
    [run(5, { status: 'completing' }), session({ status: 'done' }), 'merging', 'Resolved, merging · Claude (work)'],
    [run(5, { status: 'completed', prConflict: { ...run(5).prConflict, outcome: 'merged' } }), null, 'merged', 'Merged · Claude (work)'],
    [run(5, { status: 'completed', prConflict: { ...run(5).prConflict, outcome: 'resolved' } }), null, 'resolved', 'Conflicts resolved · Claude (work)'],
    [run(5, { status: 'failed' }), null, 'failed', 'Failed · Claude (work)'],
    [run(5, { status: 'needs-attention' }), session({ status: 'stopped' }), 'failed', 'Failed · Claude (work)'],
    [run(5, { status: 'stopped' }), null, 'stopped', 'Stopped · Claude (work)'],
  ];
  for (const [record, task, phase, label] of phases) {
    assert.equal(runPhase(record, task), phase);
    assert.equal(runStatusLabel(phase, 'Claude (work)'), label);
    assert.equal(row({ reading: read(mergeState(5, { status: 'conflicts' })), run: record, runSession: task, agentLabel: 'Claude (work)' }).run.label, label);
  }
  assert.equal(runStatusLabel('resolving', null), 'Resolving conflicts', 'an unknown agent is simply left out');
  assert.deepEqual(['starting', 'resolving', 'waiting', 'merging', 'merged', 'resolved', 'failed', 'stopped'].filter(isActivePhase), ['starting', 'resolving', 'waiting', 'merging']);
});

test('WU15 a run is matched to its row by PR number, and the newest run wins over an older failed one', () => {
  const older = run(5, { id: 'old', status: 'stopped', createdAt: '2026-02-01T00:00:00.000Z' });
  const newer = run(5, { id: 'new', createdAt: '2026-02-02T00:00:00.000Z' });
  const other = run(6, { id: 'other', createdAt: '2026-02-03T00:00:00.000Z' });
  const ordinary = { id: 'plain', createdAt: '2026-02-04T00:00:00.000Z' };
  assert.equal(conflictRunFor([older, other, ordinary, newer], 5).id, 'new');
  assert.equal(conflictRunFor([newer, older], 5).id, 'new');
  assert.equal(conflictRunFor([older, newer, other], 6).id, 'other');
  assert.equal(conflictRunFor([older, ordinary], 7), null);
  assert.equal(conflictRunFor([], 5), null);
});

test('WU16 while merging, that row\'s Merge is a disabled spinner and its Check out waits; other rows are unaffected', () => {
  const merging = row({ busy: 'merging' });
  assert.deepEqual(merging.merge, { kind: 'merging' });
  assert.equal(merging.checkout.disabled, true);
  assert.equal(merging.checkout.pending, false);
  const checkingOut = row({ busy: 'checking-out' });
  assert.deepEqual(checkingOut.checkout, { kind: 'button', disabled: true, pending: true, reason: null });
  assert.equal(row({ pr: pr(6), reading: read(mergeState(6)) }).merge.kind, 'button');
});

test('WU17 a poll that lands while a row\'s merge is in flight keeps that row; after it finishes the next response replaces it', () => {
  const before = [pr(3), pr(2), pr(1)];
  const held = { 2: before[1] };
  // The provider already dropped #2 (it merged there) and changed #1's title.
  const polled = [pr(3), pr(1, { title: 'renamed' })];
  const shown = withHeldRows(polled, held);
  assert.deepEqual(shown.map((p) => p.number), [3, 2, 1], 'the merging row stays, in its place');
  assert.equal(shown.find((p) => p.number === 1).title, 'renamed', 'other rows take the new reading');
  // A poll that changed the merging row itself doesn't overwrite it either.
  assert.equal(withHeldRows([pr(3), pr(2, { title: 'changed mid-merge' }), pr(1)], held).find((p) => p.number === 2).title, 'PR 2');
  // Nothing held: the response is shown exactly as it came.
  assert.equal(withHeldRows(polled, {}), polled);
  assert.deepEqual(without({ 2: 'a', 3: 'b' }, 2), { 3: 'b' });
});

test('WU18 the merge notice: branch deleted, and "not deleted" as a warning with the reason, never an error', () => {
  const target = pr(5, { headBranch: 'feature/login' });
  assert.deepEqual(mergeNotice(target, { branchDeleted: true, branchWarning: null, branchNote: null }), { tone: 'success', text: 'Merged #5 PR 5. The branch "feature/login" was deleted.' });
  assert.deepEqual(
    mergeNotice(target, { branchDeleted: false, branchWarning: 'The branch "feature/login" was not deleted: Cannot delete a protected branch', branchNote: null }),
    { tone: 'warning', text: 'Merged #5 PR 5. The branch "feature/login" was not deleted: Cannot delete a protected branch' },
  );
  assert.deepEqual(mergeNotice(target, { branchDeleted: false, branchWarning: null, branchNote: '"main" is the base or default branch, so it was kept.' }), { tone: 'success', text: 'Merged #5 PR 5. "main" is the base or default branch, so it was kept.' });
  assert.deepEqual(mergeNotice(target, { branchDeleted: false, branchWarning: null, branchNote: null }), { tone: 'success', text: 'Merged #5 PR 5.' });
});

const executor = (id, used = 0) => ({ id, label: id, kind: 'claude-cli', bin: 'claude', env: {}, usage: { totalTokens: 0, taskCount: 0 }, limits: { fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: null } });

const planItem = (extra = {}) => ({
  id: 'item-5', projectId: 'p', title: 'Resolve conflicts: #5 PR 5', description: '', status: 'developing', order: 0, taskIds: ['t1'], milestoneId: null,
  workflowRunId: 'run-5', executorId: 'claude-work', prConflict: run(5).prConflict, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', ...extra,
});
const stepTask = (extra = {}) => ({ id: 't1', projectId: 'p', executorId: 'claude-work', description: 'x', status: 'developing', kind: 'execute', planItemId: 'item-5', workflowRunId: 'run-5', createdAt: '2026-02-01T00:00:01.000Z', ...extra });
const groups = (item, record, task = stepTask()) => buildTaskGroups({ items: [item], tasksById: { t1: task }, workflowRunsByProject: { p: [record] }, projectId: 'p', showArchived: false, now: Date.now() });

test('WU20 a conflict run is a "PR conflicts" card with its title: Running, Needs you when stopped or failed, Completed when merged', () => {
  assert.equal(planItemTypeLabel(planItem()), 'PR conflicts');
  assert.equal(planItemTypeLabel({}), undefined);

  const running = groups(planItem(), run(5)).running;
  assert.deepEqual(running.map((card) => [card.title, card.typeLabel]), [['Resolve conflicts: #5 PR 5', 'PR conflicts']]);
  assert.deepEqual(cardDetail(running[0]), { kind: 'run', id: 'run-5' }, 'opening the card shows the same run the PR row\'s View opens');

  for (const [status, itemStatus] of [['stopped', 'blocked'], ['failed', 'failed'], ['needs-attention', 'blocked']]) {
    const built = groups(planItem({ status: itemStatus }), run(5, { status }), stepTask({ status: 'stopped' }));
    assert.deepEqual(built.needsYou.map((card) => card.typeLabel), ['PR conflicts'], status);
    assert.deepEqual([built.running.length, built.open.length], [0, 0]);
  }

  const merged = run(5, { status: 'completed', prConflict: { ...run(5).prConflict, outcome: 'merged' } });
  const done = planItem({ status: 'done' });
  assert.deepEqual(groups(done, merged, stepTask({ status: 'done' })), { needsYou: [], running: [], waiting: [], open: [], prNotMerged: [] });
  const completed = buildCompletedRows({ items: [done], taskIds: ['t1'], tasksById: { t1: stepTask({ status: 'done' }) }, workflowRuns: [merged], now: Date.now() });
  assert.deepEqual(completed.map((card) => [card.title, card.typeLabel, card.statusBadge]), [['Resolve conflicts: #5 PR 5', 'PR conflicts', 'Completed']]);

  // An ordinary task's card carries no type badge.
  const ordinary = groups(planItem({ prConflict: undefined }), run(5, { prConflict: undefined })).running[0];
  assert.equal('typeLabel' in ordinary, false);
});

test('WU21 the branch menu has a Return item while a PR checkout is remembered and current, and offers the default branch when the previous one is gone', () => {
  const checkout = { number: 5, branch: 'feature/5', previousBranch: 'develop' };
  // No list is consulted: the item stays after that PR was merged and its row left the list.
  assert.deepEqual(returnMenuItem(checkout, 'feature/5'), { label: 'Return to develop', explanation: null });
  assert.equal(returnMenuItem(checkout, 'main'), null, 'the folder is no longer on the PR branch');
  assert.equal(returnMenuItem(null, 'feature/5'), null);
  assert.equal(returnMenuItem(undefined, null), null);

  const gone = { message: 'The branch "develop" you were on before no longer exists. Return to "main" instead.', defaultBranch: 'main' };
  assert.deepEqual(returnMenuItem(checkout, 'feature/5', gone), { label: 'Return to main', branch: 'main', explanation: gone.message });
  const refused = { message: 'Commit or discard local changes before switching branches.', defaultBranch: null };
  assert.deepEqual(returnMenuItem(checkout, 'feature/5', refused), { label: 'Return to develop', explanation: refused.message });
});

test('merge states are read for new and changed rows only, unless forced, and never twice at once', () => {
  const readings = { 1: { key: 'a', loading: false, state: null, error: null }, 2: { key: 'old', loading: false, state: null, error: null }, 3: { key: 'c', loading: true, state: null, error: null } };
  const listed = [{ number: 1, updatedAt: 'a' }, { number: 2, updatedAt: 'new' }, { number: 3, updatedAt: 'changed' }, { number: 4, updatedAt: 'd' }];
  assert.deepEqual(mergeStatesToLoad(listed, readings, false), [2, 4]);
  assert.deepEqual(mergeStatesToLoad(listed, readings, true), [1, 2, 4], 'Refresh re-reads everything not already loading');
  assert.deepEqual(applyMergeStateResponse('k', { number: 1, checkedAt: '', mergeState: mergeState(1) }), { key: 'k', loading: false, state: mergeState(1), error: null });
  assert.deepEqual(applyMergeStateResponse('k', { number: 1, checkedAt: '', mergeState: null, error: 'boom' }), { key: 'k', loading: false, state: null, error: 'boom' });
  assert.equal(applyMergeStateResponse('k', { number: 1, checkedAt: '', mergeState: null }).error, 'Could not read the merge state.');
});

// ---- WS: the store against the stub ----

let project;
let stub;

async function setUp(pulls = [pr(5), pr(6)], states = {}) {
  stub = installServerStub();
  useWorldStore.setState({ projects: [], tasksById: {}, taskIdsByProject: {}, planByProject: {}, workflowRunsByProject: {}, prActionsByProject: {}, ...CLEAN_ERROR_STATE });
  await useWorldStore.getState().addProject(`PR ${Math.random().toString(36).slice(2)}`, 'https://github.com/o/r');
  project = useWorldStore.getState().projects.at(-1);
  const sync = { projectId: project.id, branch: 'main', status: 'synced', aheadBy: 0, behindBy: 0, checkedAt: '2026-01-01T00:00:00.000Z' };
  stub.projects.get(project.id).sync = sync;
  useWorldStore.setState((state) => ({ projects: state.projects.map((p) => (p.id === project.id ? { ...p, sync } : p)) }));
  stub.pullRequests.open.set(project.id, pulls);
  stub.pullRequests.mergeStates.set(project.id, new Map(pulls.map((p) => [p.number, mergeState(p.number, { headBranch: p.headBranch, ...states[p.number] })])));
  await useWorldStore.getState().loadExecutors();
  await prReadings.fetch(project.id, { provider: 'github', force: true });
  await useWorldStore.getState().loadPrMergeStates(project.id, pulls);
  stub.pullRequests.requests.length = 0;
}

const actions = () => useWorldStore.getState().prActionsByProject[project.id] ?? EMPTY_PR_ACTIONS;
const current = () => useWorldStore.getState().projects.find((p) => p.id === project.id);
const requests = () => stub.pullRequests.requests.map(({ action, method, number, body }) => ({ action, method, number, body }));

test('WS1 the client hits the right routes, methods and bodies for merge state, merge, checkout and return', async () => {
  await setUp([pr(5)], { 5: { status: 'blocked', blockers: ['This PR is a draft'] } });
  const state = await serverApi.pullRequestMergeState(project.id, 5);
  assert.deepEqual([state.number, state.mergeState.status], [5, 'blocked']);
  assert.deepEqual(await serverApi.mergePullRequest(project.id, 5), { outcome: 'needs-confirmation', blockers: ['This PR is a draft'] });
  await serverApi.checkoutPullRequest(project.id, 5);
  await serverApi.returnFromPullRequest(project.id);
  await serverApi.checkoutPullRequest(project.id, 5);
  await serverApi.returnFromPullRequest(project.id, 'main');
  assert.equal((await serverApi.mergePullRequest(project.id, 5, { confirmBlockers: true })).outcome, 'merged');
  assert.deepEqual(requests(), [
    { action: 'merge-state', method: 'GET', number: 5, body: undefined },
    { action: 'merge', method: 'POST', number: 5, body: {} },
    { action: 'checkout', method: 'POST', number: 5, body: undefined },
    { action: 'return', method: undefined, number: undefined, body: {} },
    { action: 'checkout', method: 'POST', number: 5, body: undefined },
    { action: 'return', method: undefined, number: undefined, body: { branch: 'main' } },
    { action: 'merge', method: 'POST', number: 5, body: { confirmBlockers: true } },
  ]);
  await assert.rejects(() => serverApi.pullRequestMergeState(project.id, 404), (error) => error.status === 404);
  await assert.rejects(() => serverApi.checkoutPullRequest(project.id, 'abc'), (error) => error.status === 400);
});

test('WS1 a conflicting merge sends the chosen agent, and is refused without one', async () => {
  await setUp([pr(5)], { 5: { status: 'conflicts' } });
  await assert.rejects(() => serverApi.mergePullRequest(project.id, 5), (error) => error.status === 400 && /Choose a coding agent/.test(error.message));
  const started = await serverApi.mergePullRequest(project.id, 5, { executorId: 'test-claude' });
  assert.deepEqual([started.outcome, started.existing, started.run.prConflict.number], ['resolving', false, 5]);
  assert.deepEqual(requests().at(-1), { action: 'merge', method: 'POST', number: 5, body: { executorId: 'test-claude' } });
});

test('WS2 a successful checkout updates the Project\'s branch and sync reading in the store at once', async () => {
  await setUp();
  assert.equal(current().sync.branch, 'main');
  assert.equal(await useWorldStore.getState().checkoutPullRequest(project.id, pr(5)), true);
  assert.deepEqual(current().prCheckout, { number: 5, branch: 'feature/5', previousBranch: 'main' });
  assert.equal(current().sync.branch, 'feature/5');
  assert.deepEqual(actions().busy, {});
  assert.equal(isCheckedOut(pr(5), current().prCheckout, current().sync.branch), true);

  assert.equal(await useWorldStore.getState().returnFromPullRequest(project.id), true);
  assert.equal(current().prCheckout, null);
  assert.equal(current().sync.branch, 'main');
  assert.deepEqual([actions().returning, actions().returnError], [false, null]);
});

test('WS2 a live project event keeps the checked-out state in the store', async () => {
  await setUp();
  await useWorldStore.getState().checkoutPullRequest(project.id, pr(5));
  const patch = mergeWorkerEvent(useWorldStore.getState(), { type: 'project', project: { ...stub.projects.get(project.id), status: 'developing', sync: undefined } });
  const live = patch.projects.find((p) => p.id === project.id);
  assert.deepEqual(live.prCheckout, { number: 5, branch: 'feature/5', previousBranch: 'main' });
  assert.equal(live.sync.branch, 'feature/5', 'the event carries no sync reading, so the last one is kept');
});

test('WS3 a checkout refusal (dirty tree, busy folder, diverged, in progress) puts the server\'s message on that row only', async () => {
  for (const [status, error] of [
    [409, 'Commit or discard local changes before switching branches, or create a new branch to carry them over.'],
    [409, 'Work is already running in project "X"\'s own folder — wait for it to finish'],
    [409, 'Your local branch "feature/5" has commits that pull request #5 doesn\'t have'],
    [409, 'Another merge or checkout is in progress for this project. Try again in a moment.'],
  ]) {
    await setUp();
    stub.pullRequests.checkoutRefusals.set(5, { status, error });
    assert.equal(await useWorldStore.getState().checkoutPullRequest(project.id, pr(5)), false);
    assert.deepEqual(actions().rowErrors, { 5: { message: error, retry: 'checkout' } });
    assert.deepEqual(actions().busy, {});
    assert.equal(current().sync.branch, 'main');
    assert.equal(current().prCheckout ?? null, null);
    assert.equal(reportedError(), null, 'shown on the row, not as a notification');
  }
});

test('WS4 a failed checkout offers Retry on the row, and Retry repeats the request', async () => {
  await setUp();
  stub.pullRequests.checkoutRefusals.set(5, { status: 502, error: 'Could not reach GitHub.' });
  await useWorldStore.getState().checkoutPullRequest(project.id, pr(5));
  const failed = prRowModel({ pr: pr(5), reading: actions().mergeStates[5], run: null, checkout: current().prCheckout, currentBranch: current().sync.branch, busy: actions().busy[5], rowError: actions().rowErrors[5] });
  assert.deepEqual(failed.error, { message: 'Could not reach GitHub.', retry: 'checkout' });

  stub.pullRequests.checkoutRefusals.delete(5);
  assert.equal(await useWorldStore.getState().checkoutPullRequest(project.id, pr(5)), true);
  assert.deepEqual(requests().filter((request) => request.action === 'checkout').length, 2);
  assert.deepEqual(actions().rowErrors, {}, 'the retry cleared the row error');
  assert.equal(current().sync.branch, 'feature/5');
});

test('WS4 Return with the previous branch gone offers the default branch, which then works', async () => {
  await setUp();
  stub.projects.get(project.id).sync.branch = 'scratch';
  await useWorldStore.getState().checkoutPullRequest(project.id, pr(5));
  assert.equal(current().prCheckout.previousBranch, 'scratch');
  stub.pullRequests.goneBranches.add('scratch');

  assert.equal(await useWorldStore.getState().returnFromPullRequest(project.id), false);
  assert.deepEqual(actions().returnError, { message: 'The branch "scratch" you were on before no longer exists. Return to "main" instead.', defaultBranch: 'main' });
  const offer = returnMenuItem(current().prCheckout, current().sync.branch, actions().returnError);
  assert.deepEqual([offer.label, offer.branch], ['Return to main', 'main']);
  // The same refusal reaches the PR row, where Return was clicked.
  const onRow = prRowModel({ pr: pr(5), reading: actions().mergeStates[5], run: null, checkout: current().prCheckout, currentBranch: current().sync.branch, busy: undefined, rowError: undefined, returnError: actions().returnError });
  assert.deepEqual(onRow.checkout, { kind: 'checked-out', returnLabel: 'Return to main', returnBranch: 'main', returnError: 'The branch "scratch" you were on before no longer exists. Return to "main" instead.' });

  assert.equal(await useWorldStore.getState().returnFromPullRequest(project.id, offer.branch), true);
  assert.equal(current().sync.branch, 'main');
  assert.equal(actions().returnError, null);
});

test('WS4 a Return refused for uncommitted changes puts the message on the row, and a later success clears it', async () => {
  await setUp();
  await useWorldStore.getState().checkoutPullRequest(project.id, pr(5));
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).endsWith('/pull-requests/return')
    ? new Response(JSON.stringify({ error: 'Commit or discard local changes before switching branches, or create a new branch to carry them over.' }), { status: 409, headers: { 'content-type': 'application/json' } })
    : original(url, init));
  try {
    assert.equal(await useWorldStore.getState().returnFromPullRequest(project.id), false);
  } finally {
    globalThis.fetch = original;
  }
  const rowNow = () => prRowModel({ pr: pr(5), reading: actions().mergeStates[5], run: null, checkout: current().prCheckout, currentBranch: current().sync.branch, busy: undefined, rowError: undefined, returnError: actions().returnError });
  assert.deepEqual(rowNow().checkout, { kind: 'checked-out', returnLabel: 'Return to main', returnError: 'Commit or discard local changes before switching branches, or create a new branch to carry them over.' });
  assert.equal(current().sync.branch, 'feature/5', 'still on the PR branch');
  assert.equal(reportedError(), null);

  assert.equal(await useWorldStore.getState().returnFromPullRequest(project.id), true);
  assert.equal(actions().returnError, null);
  assert.equal(rowNow().checkout.kind, 'button');
});

test('WS5 a clean merge refetches the list, lowers the tab count, shows the notice and refreshes the sync reading', async () => {
  await setUp();
  assert.equal(prReadings.get(project.id).count, 2);
  const syncBefore = current().sync.checkedAt;
  const response = await useWorldStore.getState().mergePullRequest(project.id, pr(5));
  assert.equal(response.outcome, 'merged');
  assert.equal(prReadings.get(project.id).count, 1);
  assert.deepEqual(prReadings.get(project.id).pullRequests.map((p) => p.number), [6]);
  assert.deepEqual(actions().notice, { tone: 'success', text: 'Merged #5 PR 5. The branch "feature/5" was deleted.' });
  assert.notEqual(current().sync.checkedAt, syncBefore, 'the sync reading was read again');
  assert.deepEqual([actions().busy, actions().held, actions().rowErrors], [{}, {}, {}]);
  useWorldStore.getState().dismissPrNotice(project.id);
  assert.equal(actions().notice, null);
});

test('WS5 a merge whose branch could not be deleted is a warning notice, and the PR still leaves the list', async () => {
  await setUp();
  stub.pullRequests.mergeResults.set(5, { branchDeleted: false, branchWarning: 'The branch "feature/5" was not deleted: Cannot delete a protected branch' });
  const response = await useWorldStore.getState().mergePullRequest(project.id, pr(5));
  assert.equal(response.outcome, 'merged');
  assert.deepEqual(actions().notice, { tone: 'warning', text: 'Merged #5 PR 5. The branch "feature/5" was not deleted: Cannot delete a protected branch' });
  assert.equal(prReadings.get(project.id).count, 1);
  assert.deepEqual(actions().rowErrors, {});
});

test('WS5 while a merge is in flight its row is held and marked merging, and released afterwards', async () => {
  await setUp();
  const pending = useWorldStore.getState().mergePullRequest(project.id, pr(5));
  assert.deepEqual(actions().busy, { 5: 'merging' });
  assert.deepEqual(Object.keys(actions().held), ['5']);
  assert.deepEqual(withHeldRows([pr(6)], actions().held).map((p) => p.number), [6, 5]);
  await pending;
  assert.deepEqual([actions().busy, actions().held], [{}, {}]);
});

test('WS6 a merge the provider refuses keeps the row and shows the reason on it', async () => {
  await setUp([pr(5), pr(6)], { 5: { status: 'blocked', blockers: ['A review is required'] } });
  assert.deepEqual(await useWorldStore.getState().mergePullRequest(project.id, pr(5)), { outcome: 'needs-confirmation', blockers: ['A review is required'] });
  assert.equal(prReadings.get(project.id).count, 2, 'nothing merged without the confirmation');

  stub.pullRequests.mergeRefusals.set(5, 'At least 1 approving review is required by reviewers with write access.');
  assert.equal(await useWorldStore.getState().mergePullRequest(project.id, pr(5), { confirmBlockers: true }), null);
  assert.deepEqual(actions().rowErrors, { 5: { message: 'At least 1 approving review is required by reviewers with write access.', retry: 'merge' } });
  assert.equal(prReadings.get(project.id).count, 2);
  assert.deepEqual([actions().busy, actions().held, actions().notice], [{}, {}, null]);
  assert.equal(reportedError(), null);
});

test('WS7 a conflicting merge with an agent folds the run into the store, so the Tasks board and the row show the same run', async () => {
  await setUp([pr(5)], { 5: { status: 'conflicts' } });
  const response = await useWorldStore.getState().mergePullRequest(project.id, pr(5), { executorId: 'test-codex' });
  assert.equal(response.outcome, 'resolving');
  const state = useWorldStore.getState();
  const stored = conflictRunFor(state.workflowRunsByProject[project.id], 5);
  assert.equal(stored.id, response.run.id);
  assert.equal('lastExecutorId' in actions(), false, 'nothing is remembered: the dialog asks again every time');

  await state.loadPlan(project.id);
  await state.loadProjectTasks(project.id);
  const loaded = useWorldStore.getState();
  const board = buildTaskGroups({ items: loaded.planByProject[project.id].items, tasksById: loaded.tasksById, workflowRunsByProject: loaded.workflowRunsByProject, projectId: project.id, showArchived: false, now: Date.now() });
  assert.deepEqual(board.running.map((card) => [card.title, card.typeLabel, card.workflowRunId]), [['Resolve conflicts: #5 PR 5', 'PR conflicts', stored.id]]);
  assert.deepEqual(cardDetail(board.running[0]), { kind: 'run', id: stored.id });

  const agent = loaded.executors.find((e) => e.id === stored.executorId).label;
  const task = Object.values(loaded.tasksById).find((t) => t.workflowRunId === stored.id);
  const model = prRowModel({ pr: pr(5), reading: actions().mergeStates[5], run: stored, runSession: task, agentLabel: agent, checkout: null, currentBranch: 'main', busy: undefined, rowError: undefined });
  assert.deepEqual([model.run.runId, model.run.label, model.merge.kind], [stored.id, 'Resolving conflicts · Test Codex', 'run']);

  // A second click while it works returns the same run and creates nothing.
  const again = await useWorldStore.getState().mergePullRequest(project.id, pr(5));
  assert.deepEqual([again.existing, again.run.id], [true, stored.id]);
  assert.equal(useWorldStore.getState().workflowRunsByProject[project.id].length, 1);
});

test('WS7 a conflict run the daemon refuses to start puts the refusal on the row and creates nothing', async () => {
  await setUp([pr(5)], { 5: { status: 'conflicts' } });
  assert.equal(await useWorldStore.getState().mergePullRequest(project.id, pr(5), { executorId: 'gone' }), null);
  assert.deepEqual(actions().rowErrors, { 5: { message: 'executor not found', retry: 'merge' } });
  assert.deepEqual(useWorldStore.getState().workflowRunsByProject[project.id] ?? [], []);
});

test('WS8 live run events update the row status, and a fresh store load re-associates the run by PR number', async () => {
  await setUp([pr(5)], { 5: { status: 'conflicts' } });
  const { run: started } = await useWorldStore.getState().mergePullRequest(project.id, pr(5), { executorId: 'test-claude' });
  const phaseNow = () => runPhase(conflictRunFor(useWorldStore.getState().workflowRunsByProject[project.id], 5), session());

  for (const [patch, phase] of [
    [{ status: 'completing', currentStepId: null }, 'merging'],
    [{ status: 'completed', prConflict: { ...started.prConflict, outcome: 'merged', detail: 'Merged.' } }, 'merged'],
  ]) {
    Object.assign(stub.workflowRuns.get(started.id), patch);
    useWorldStore.setState(mergeWorkerEvent(useWorldStore.getState(), { type: 'workflowRun', run: { ...stub.workflowRuns.get(started.id) } }));
    assert.equal(phaseNow(), phase);
  }

  // A page reload: nothing in memory, everything read again from the daemon.
  useWorldStore.setState({ workflowRunsByProject: {}, prActionsByProject: {}, tasksById: {}, taskIdsByProject: {} });
  await useWorldStore.getState().loadWorkflowRunsForProject(project.id);
  const reloaded = conflictRunFor(useWorldStore.getState().workflowRunsByProject[project.id], 5);
  assert.equal(reloaded.id, started.id);
  assert.equal(runPhase(reloaded), 'merged');
  assert.equal(conflictRunFor(useWorldStore.getState().workflowRunsByProject[project.id], 6), null);
});

test('WS9 a merge-state read that fails for one PR leaves the list and the other rows intact', async () => {
  stub = installServerStub();
  useWorldStore.setState({ projects: [], prActionsByProject: {}, ...CLEAN_ERROR_STATE });
  await useWorldStore.getState().addProject('Unreadable', 'https://github.com/o/r');
  project = useWorldStore.getState().projects.at(-1);
  const pulls = [pr(5), pr(6), pr(7)];
  stub.pullRequests.open.set(project.id, pulls);
  stub.pullRequests.mergeStates.set(project.id, new Map([[5, mergeState(5)], [7, mergeState(7, { status: 'conflicts' })]]));
  stub.pullRequests.unreadable.set(6, 'GitHub CLI is not signed in.');
  await prReadings.fetch(project.id, { provider: 'github', force: true });
  await useWorldStore.getState().loadPrMergeStates(project.id, pulls);

  assert.equal(prReadings.get(project.id).count, 3);
  assert.equal(prReadings.get(project.id).error, undefined);
  assert.deepEqual(Object.fromEntries(Object.entries(actions().mergeStates).map(([number, reading]) => [number, reading.state?.status ?? reading.error])), { 5: 'clean', 6: 'GitHub CLI is not signed in.', 7: 'conflicts' });
  assert.equal(reportedError(), null);

  // Retry reads just that row again; an unchanged row isn't read twice; a PR that left the list is forgotten.
  stub.pullRequests.unreadable.delete(6);
  stub.pullRequests.mergeStates.get(project.id).set(6, mergeState(6));
  stub.pullRequests.requests.length = 0;
  await useWorldStore.getState().loadPrMergeStates(project.id, [pr(6)], true);
  assert.equal(actions().mergeStates[6].state.status, 'clean');
  await useWorldStore.getState().loadPrMergeStates(project.id, [pr(6)]);
  assert.equal(requests().length, 1);
  assert.deepEqual(Object.keys(actions().mergeStates), ['6']);
});

test('WS9 a merge-state request that fails outright is that row\'s error too', async () => {
  await setUp([pr(5)]);
  stub.pullRequests.mergeStates.get(project.id).delete(5);
  await useWorldStore.getState().loadPrMergeStates(project.id, [pr(5)], true);
  assert.deepEqual(actions().mergeStates[5], { key: pr(5).updatedAt, loading: false, state: null, error: 'Pull request #5 was not found.' });
});

// ---- WC: source wiring ----

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('WC1 PrPanel renders Check out, Merge and Open on GitHub from the pure row model, not from inline conditions', async () => {
  const panel = await source('../src/ui/project-popup/PrPanel.tsx');
  assert.match(panel, /prRowModel\(\{/);
  assert.match(panel, /const \{ checkout, merge, run \} = model;/);
  assert.match(panel, /mergeClickTarget\(model\)/);
  assert.match(panel, /withHeldRows\(reading\.pullRequests, actions\.held\)/);
  assert.match(panel, /Check out\s*<\/Button>/);
  assert.match(panel, /Open on GitHub<\/a>/);
  assert.doesNotMatch(panel, /\.status === '(clean|conflicts|blocked|unmergeable)'/, 'the merge-state class is never tested in the component');
  assert.doesNotMatch(panel, /serverApi\./, 'every request goes through the store');
});

test('WC2 the Merge button is absent, not just disabled, for an unmergeable row', async () => {
  const panel = await source('../src/ui/project-popup/PrPanel.tsx');
  assert.match(panel, /\{merge\.kind === 'button' && \(\s*<Button type="button" size="sm" onClick=\{\(\) => onMerge\(model\)\}/);
  assert.match(panel, /\{merge\.kind === 'hidden' && merge\.reason && <span[^>]*>\{merge\.reason\}<\/span>\}/);
  const disabledMerge = panel.slice(panel.indexOf("merge.kind === 'merging' || merge.kind === 'loading'"));
  assert.match(disabledMerge, /<Button type="button" size="sm" disabled/);
});

test('WC3 the confirmation dialog renders one line per blocker with Cancel and "Merge anyway"', async () => {
  const dialogs = await source('../src/ui/project-popup/PrDialogs.tsx');
  assert.match(dialogs, /const model = mergeConfirmation\(pr, blockers\);/);
  assert.match(dialogs, /\{model\.blockers\.map\(\(blocker\) => <li key=\{blocker\}>\{blocker\}<\/li>\)\}/);
  assert.match(dialogs, /<Button type="button" variant="outline" onClick=\{onCancel\}>Cancel<\/Button>\s*<Button type="button" onClick=\{onConfirm\}>\{model\.confirmLabel\}<\/Button>/);
  const panel = await source('../src/ui/project-popup/PrPanel.tsx');
  assert.match(panel, /onCancel=\{\(\) => setDialog\(null\)\} onConfirm=\{\(\) => \{ setDialog\(null\); void merge\(dialog\.pr, mergeRequestFor\(\{ kind: 'confirm' \}\)\); \}\}/, 'Cancel only closes, with no request; confirm sends the flag');
});

test('WC4 the Resolve conflicts dialog uses the one shared coding-agent picker, remembers no agent, and creates nothing before Start', async () => {
  const dialogs = await source('../src/ui/project-popup/PrDialogs.tsx');
  assert.match(dialogs, /import \{ CodingAgentPicker \} from '\.\.\/CodingAgentPicker';/);
  assert.match(dialogs, /const \{ executors, executorId, choose \} = useExecutorChoice\(\);/);
  assert.match(dialogs, /<CodingAgentPicker executors=\{executors\} value=\{executorId\} onChange=\{choose\} id="resolve-conflicts-agent" \/>/);
  assert.doesNotMatch(dialogs, /lastExecutorId|agentDialogModel/, 'Retry asks again with the shared preselection');
  assert.match(dialogs, /disabled=\{!executorId \|\| starting\}/);
  assert.match(dialogs, /const refusal = await onStart\(executorId\);\s*if \(refusal\) \{\s*setError\(refusal\);/, 'a refusal stays in the dialog');
  const panel = await source('../src/ui/project-popup/PrPanel.tsx');
  assert.match(panel, /if \(target === 'agent'\) setDialog\(\{ kind: 'agent', pr \}\);/);
  assert.match(panel, /onStart=\{\(executorId\) => merge\(dialog\.pr, mergeRequestFor\(\{ kind: 'agent', executorId \}\)\)\}/);
});

test('WC5 the row\'s View opens the run through the same opener the Tasks board\'s footer links use', async () => {
  const panel = await source('../src/ui/project-popup/PrPanel.tsx');
  assert.match(panel, /const openCardDetail = useWorldStore\(\(s\) => s\.openWorkspaceCardDetail\);/);
  assert.match(panel, /onView=\{\(runId\) => openCardDetail\(project\.id, \{ kind: 'run', id: runId \}\)\}/);
  assert.match(panel, /onClick=\{\(\) => onView\(run\.runId\)\}>View<\/button>/);
  const footer = await source('../src/ui/FooterListPopovers.tsx');
  assert.match(footer, /useWorldStore\(\(s\) => s\.openWorkspaceCardDetail\)/);
  const board = await source('../src/ui/project-popup/TaskBoard.tsx');
  assert.equal(board.match(/typeLabel=\{row\.typeLabel\}/g)?.length, 2, 'open and completed cards both show the type badge');
});

test('WC6 the branch menu renders the Return item first, and the row\'s buttons have accessible names with the PR number', async () => {
  const menu = await source('../src/ui/project-popup/BranchMenu.tsx');
  assert.match(menu, /const returnItem = returnMenuItem\(project\.prCheckout, displayBranch, prActions\.returnError\);/);
  assert.match(menu, /onSelect=\{\(\) => void goBack\(returnItem\.branch\)\}/);
  assert.ok(menu.indexOf('{returnItem && (') < menu.indexOf('{matches.length > 0 && ('), 'before the branch list');
  assert.match(menu, /disabled=\{pending \|\| busy\} onSelect=\{\(\) => void goBack/, 'the same folder-busy rule as switching');
  assert.match(menu, /\}, \[project\.id, syncedBranch\]\);/, 'the shown branch follows a checkout made in the PR tab');

  const panel = await source('../src/ui/project-popup/PrPanel.tsx');
  for (const name of [
    /aria-label=\{`Check out pull request #\$\{pr\.number\}`\}/,
    /aria-label=\{`\$\{checkout\.returnLabel\} from pull request #\$\{pr\.number\}`\}/,
    /onClick=\{\(\) => onReturn\(checkout\.returnBranch\)\}/,
    /\{checkout\.kind === 'checked-out' && checkout\.returnError && <p className="mt-1 text-xs text-destructive" role="alert">\{checkout\.returnError\}<\/p>\}/,
    /aria-label=\{`\$\{merge\.label === 'Retry' \? 'Retry resolving conflicts for' : 'Merge'\} pull request #\$\{pr\.number\}`\}/,
    /aria-label=\{`View the conflict-resolution run for pull request #\$\{pr\.number\}`\}/,
    /aria-label=\{`Retry for pull request #\$\{pr\.number\}`\}/,
    /aria-label=\{`Open pull request #\$\{pr\.number\} on GitHub in a new tab`\}/,
  ]) assert.match(panel, name);
  assert.match(panel, /aria-label="Dismiss merge notice"/);
});

// ---- Required checks (task 19.002) ----

test('WU27 optional-check warnings are separate amber note lines after the blockers, and the row stays a plain Merge', () => {
  const model = row({ reading: read(mergeState(5, { status: 'clean', warnings: ['Optional checks failing: Vercel'] })) });
  assert.deepEqual(model.merge, { kind: 'button', label: 'Merge', opens: 'merge' });
  assert.deepEqual(model.notes, [{ tone: 'warning', text: 'Optional checks failing: Vercel' }]);
  const blocked = row({ reading: read(mergeState(5, { status: 'blocked', blockers: ['Checks are failing: build'], warnings: ['Optional checks failing: Vercel'] })) });
  assert.deepEqual(blocked.notes.map((line) => line.text), ['Checks are failing: build', 'Optional checks failing: Vercel']);
});

test('WU28 a state without warnings (an older daemon) or an unmergeable one shows none', () => {
  assert.deepEqual(row().notes, []);
  assert.deepEqual(row({ reading: read(mergeState(5, { status: 'unmergeable', reason: 'closed', warnings: ['Optional checks failing: Vercel'] })) }).notes, []);
});
