import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const lib = await import('../src/lib/autoMerge.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { reportedError, CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const { AUTO_MERGE_STATES, autoMergeChip, autoMergePanel, autoMergeToggle, branchOutcomeText, mergedTimeText, prRowAutoMergeTag, hasAutoMerge } = lib;
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/** Cases W1 to W19 and C1 to C11 of task 10.017. */

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const record = (state, extra = {}) => ({ enabled: true, state, reasons: [], prNumber: 7, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: '2026-10-13T11:00:00.000Z', ...extra });

test('W1 the 13 listed states (10 on-states plus off, no repository, no branch) give a title and a tone', () => {
  const expected = {
    waiting: ['info', 'waiting for the task to complete'], merging: ['info', 'Merging'], resolving: ['info', 'Resolving conflicts'],
    blocked: ['warn', 'Awaiting merge: blocked'], provider: ['warn', 'can\'t reach the provider'], agent: ['warn', 'agent unavailable'],
    merged: ['ok', 'Merged'], failed: ['bad', 'Auto-merge failed'], 'no-pr': ['bad', 'No PR to merge'], 'cannot-merge': ['bad', 'Can\'t be merged'],
  };
  assert.deepEqual([...AUTO_MERGE_STATES].sort(), Object.keys(expected).sort());
  for (const state of AUTO_MERGE_STATES) {
    const panel = autoMergePanel(record(state), NOW);
    assert.equal(panel.tone, expected[state][0], state);
    assert.match(panel.title, new RegExp(expected[state][1]), state);
  }
  assert.equal(autoMergePanel(undefined, NOW), null);
  assert.equal(autoMergePanel(record('merged', { enabled: false }), NOW), null, 'nothing shows while the toggle is off');
});

test('W2 blocked lists every reason; an empty list gets a fallback line', () => {
  assert.deepEqual(autoMergePanel(record('blocked', { reasons: ['Checks are failing', 'This PR is a draft'] }), NOW).reasons, ['Checks are failing', 'This PR is a draft']);
  assert.deepEqual(autoMergePanel(record('blocked'), NOW).reasons, ['The pull request can\'t be merged yet.']);
});

test('W3 the switch is unavailable, with the reason, without a repository or on a run without its own branch', () => {
  const ok = autoMergeToggle({ repositoryUrl: 'https://github.com/o/r', run: null, autoMerge: undefined });
  assert.deepEqual([ok.checked, ok.disabled, ok.reason], [false, false, null]);
  assert.match(ok.tooltip, /once the task completes/);
  const noRepo = autoMergeToggle({ repositoryUrl: null, run: null, autoMerge: undefined });
  assert.deepEqual([noRepo.disabled, noRepo.reason !== null, noRepo.tooltip === noRepo.reason], [true, true, true]);
  const noBranch = autoMergeToggle({ repositoryUrl: 'https://github.com/o/r', run: { branch: 'main' }, autoMerge: undefined });
  assert.match(noBranch.reason, /own branch/);
  assert.equal(noBranch.disabled, true);
  assert.equal(autoMergeToggle({ repositoryUrl: 'https://github.com/o/r', run: { branch: 'f', baseBranch: 'main' }, autoMerge: record('waiting') }).checked, true);
  assert.equal(autoMergeToggle({ repositoryUrl: null, run: null, autoMerge: record('waiting') }).disabled, false, 'an already-on switch can always be turned off');
});

test('W4 actions per state: Retry on Failed and Agent unavailable, Open PR tab on blocked, agent and cannot-merge; never Check now', () => {
  const actions = Object.fromEntries(AUTO_MERGE_STATES.map((state) => [state, autoMergePanel(record(state), NOW).actions]));
  assert.deepEqual(actions, {
    waiting: [], merging: [], resolving: [], blocked: ['open-pr-tab'], provider: [], agent: ['retry', 'open-pr-tab'], merged: [],
    failed: ['retry'], 'no-pr': [], 'cannot-merge': ['open-pr-tab'],
  });
  assert.ok(!JSON.stringify(actions).includes('check'));
});

test('W5 the conflict-run link shows on Resolving and Failed; the keep-going note only on Resolving', () => {
  const resolving = autoMergePanel(record('resolving', { runId: 'run-1' }), NOW);
  assert.equal(resolving.runId, 'run-1');
  assert.match(resolving.note, /keeps this run going/);
  const failed = autoMergePanel(record('failed', { runId: 'run-1' }), NOW);
  assert.equal(failed.runId, 'run-1');
  assert.equal(failed.note, null);
  assert.equal(autoMergePanel(record('merged', { runId: 'run-1' }), NOW).runId, null);
  assert.equal(autoMergePanel(record('blocked', { runId: 'run-1' }), NOW).runId, null);
});

test('W6 the merged time reads just now, minutes, hours, days', () => {
  const ago = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(mergedTimeText(ago(10_000), NOW), 'just now');
  assert.equal(mergedTimeText(ago(5 * 60_000), NOW), '5 min ago');
  assert.equal(mergedTimeText(ago(3 * 3_600_000), NOW), '3 h ago');
  assert.equal(mergedTimeText(ago(2 * 86_400_000), NOW), '2 d ago');
});

test('W7 an out-of-range or invalid merged time never throws', () => {
  for (const value of ['1970-01-01T00:00:00.000Z', new Date(8.64e15).toISOString(), new Date(NOW + 86_400_000).toISOString(), 'not a date', '', null, undefined]) {
    assert.doesNotThrow(() => mergedTimeText(value, NOW));
  }
  assert.equal(mergedTimeText(new Date(NOW + 86_400_000).toISOString(), NOW), 'just now', 'a time in the future reads as now');
  assert.equal(mergedTimeText('not a date', NOW), '');
  assert.equal(mergedTimeText(null, NOW), '');
  assert.match(mergedTimeText('1970-01-01T00:00:00.000Z', NOW), /d ago$/);
  assert.doesNotThrow(() => autoMergePanel(record('merged', { mergedAt: new Date(8.64e15).toISOString() }), NOW));
});

test('W8 the branch outcome is the merge result\'s own words: deleted, delete warning, left in place', () => {
  assert.equal(branchOutcomeText({ branchWarning: null, branchNote: null }), 'The remote branch was deleted.');
  assert.equal(branchOutcomeText({ branchWarning: 'The branch "x" was not deleted: nope', branchNote: null }), 'The branch "x" was not deleted: nope');
  assert.equal(branchOutcomeText({ branchWarning: null, branchNote: '"x" lives in a fork, so it was left in place.' }), '"x" lives in a fork, so it was left in place.');
  assert.deepEqual(autoMergePanel(record('merged', { mergedAt: new Date(NOW - 60_000).toISOString() }), NOW).merged, { when: '1 min ago', branch: 'The remote branch was deleted.' });
});

test('W9 the board chip per state, a red one for Can\'t be merged, none when off, marked live only while merging or resolving', () => {
  for (const state of AUTO_MERGE_STATES) {
    const chip = autoMergeChip(record(state));
    assert.ok(chip && chip.label, state);
    assert.equal(chip.live, state === 'merging' || state === 'resolving', state);
  }
  assert.equal(autoMergeChip(record('cannot-merge')).tone, 'bad');
  assert.equal(autoMergeChip(undefined), null);
  assert.equal(autoMergeChip(record('waiting', { enabled: false })), null);
});

test('W10 the chip tooltip carries the reason; a very long reason is truncated', () => {
  assert.match(autoMergeChip(record('blocked', { reasons: ['Checks are failing'] })).title, /Checks are failing/);
  const long = autoMergeChip(record('failed', { reasons: ['x'.repeat(5000)] }));
  assert.ok(long.title.length <= 160);
  assert.ok(long.title.endsWith('…'));
});

test('W11 the PR row tag follows the owning task\'s state; a conflicting PR with blockers reads "resolving conflicts"', () => {
  const items = (state, extra) => [{ id: 'a', title: 'Add login', autoMerge: record(state, extra) }];
  const text = (state) => prRowAutoMergeTag(items(state), 7)?.text;
  assert.equal(text('waiting'), 'Auto-merge on for task "Add login"');
  assert.equal(text('merging'), 'Being auto-merged by task "Add login"');
  assert.equal(text('resolving'), 'Resolving conflicts for task "Add login"');
  assert.equal(text('blocked'), 'Auto-merge blocked for task "Add login"');
  assert.equal(text('failed'), 'Auto-merge failed for task "Add login"');
  assert.equal(text('merged'), 'Auto-merged by task "Add login"');
  assert.equal(prRowAutoMergeTag(items('resolving'), 7).itemId, 'a');
});

test('W12 a PR no task owns, or whose task has Auto-merge off, has no tag', () => {
  assert.equal(prRowAutoMergeTag([{ id: 'a', title: 'x', autoMerge: record('waiting') }], 8), null);
  assert.equal(prRowAutoMergeTag([{ id: 'a', title: 'x', autoMerge: record('waiting', { enabled: false }) }], 7), null);
  assert.equal(prRowAutoMergeTag([{ id: 'a', title: 'x' }], 7), null);
  assert.equal(prRowAutoMergeTag([], 7), null);
});

test('W14 a very long task title in the tag is truncated', () => {
  const tag = prRowAutoMergeTag([{ id: 'a', title: 'T'.repeat(500), autoMerge: record('waiting') }], 7);
  assert.ok(tag.text.length < 80);
  assert.match(tag.text, /…"$/);
});

test('hasAutoMerge excludes conflict runs and testing setups, which never have a PR of their own', () => {
  assert.equal(hasAutoMerge({ id: 'a' }), true);
  assert.equal(hasAutoMerge({ id: 'a', prConflict: {} }), false);
  assert.equal(hasAutoMerge({ id: 'a', testingSetup: {} }), false);
  assert.equal(hasAutoMerge(undefined), false);
});

// ---- API client and store ----

function reset() {
  useWorldStore.setState({
    projects: [], tasksById: {}, planByProject: {}, planLiveChangesByProject: {}, planLiveRevisionByProject: {},
    taskLiveChangesByProject: {}, taskLiveRevisionByProject: {}, workflowRunsByProject: {}, workflowRunDetails: {}, ...CLEAN_ERROR_STATE,
  });
}

async function projectWithItem(repositoryUrl = 'https://github.com/o/r') {
  const stub = installServerStub();
  reset();
  await useWorldStore.getState().addProject('Auto');
  const project = useWorldStore.getState().projects.at(-1);
  stub.projects.get(project.id).repositoryUrl = repositoryUrl ?? undefined;
  await useWorldStore.getState().loadPlan(project.id);
  const itemId = await useWorldStore.getState().createPlanItem(project.id, { title: 'Task one', description: '' });
  return { stub, projectId: project.id, itemId };
}

test('W16 the client sends PUT { enabled } and POST for Retry, and surfaces 400, 404 and 409 messages', async () => {
  const { projectId, itemId } = await projectWithItem();
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push([init?.method, String(url).replace(/^https?:\/\/[^/]+/, ''), init?.body]); return original(url, init); };
  const saved = await serverApi.setAutoMerge(projectId, itemId, true);
  assert.equal(saved.autoMerge.enabled, true);
  assert.deepEqual(calls[0], ['PUT', `/api/projects/${projectId}/plan-items/${itemId}/auto-merge`, '{"enabled":true}']);
  await assert.rejects(() => serverApi.retryAutoMerge(projectId, itemId), /Only a failed auto-merge/);
  assert.deepEqual(calls[1].slice(0, 2), ['POST', `/api/projects/${projectId}/plan-items/${itemId}/auto-merge/retry`]);
  await assert.rejects(() => serverApi.setAutoMerge(projectId, 'nope', true), /not found/i);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'The body must be { "enabled": true | false }' }), { status: 400 });
  await assert.rejects(() => serverApi.setAutoMerge(projectId, itemId, 'yes'), /enabled/);
});

test('W17 the store toggle is applied at once, kept on success, and put back with the error on a 409', async () => {
  const { projectId, itemId } = await projectWithItem();
  const pending = useWorldStore.getState().setAutoMerge(projectId, itemId, true);
  assert.equal(useWorldStore.getState().planByProject[projectId].items[0].autoMerge.enabled, true, 'optimistic');
  assert.equal(await pending, true);
  assert.equal(useWorldStore.getState().planByProject[projectId].items[0].autoMerge.state, 'waiting');
  assert.equal(await useWorldStore.getState().setAutoMerge(projectId, itemId, false), true);
  assert.equal(useWorldStore.getState().planByProject[projectId].items[0].autoMerge.enabled, false);

  const none = await projectWithItem(null);
  assert.equal(await useWorldStore.getState().setAutoMerge(none.projectId, none.itemId, true), false);
  assert.equal(useWorldStore.getState().planByProject[none.projectId].items[0].autoMerge, undefined, 'reverted');
  assert.match(reportedError() ?? '', /no linked repository/);
});

test('W18 a plan item event updates its task\'s auto-merge and leaves other tasks alone', async () => {
  const { projectId, itemId } = await projectWithItem();
  const other = await useWorldStore.getState().createPlanItem(projectId, { title: 'Task two', description: '' });
  const items = () => useWorldStore.getState().planByProject[projectId].items;
  const mine = items().find((item) => item.id === itemId);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: { ...mine, autoMerge: record('merged', { mergedAt: new Date().toISOString() }) } }));
  assert.equal(items().find((item) => item.id === itemId).autoMerge.state, 'merged');
  assert.equal(items().find((item) => item.id === other).autoMerge, undefined);
});

test('W19 the stub mirrors the daemon: 400 for a bad body, 404 for another project\'s task, 409 without a repository', async () => {
  const { projectId, itemId } = await projectWithItem();
  const put = (project, id, body) => fetch(`http://localhost:4500/api/projects/${project}/plan-items/${id}/auto-merge`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put(projectId, itemId, { enabled: 'true' })).status, 400);
  assert.equal((await put('other-project', itemId, { enabled: true })).status, 404);
  assert.equal((await put(projectId, 'nope', { enabled: true })).status, 404);
  const none = await projectWithItem(null);
  assert.equal((await put(none.projectId, none.itemId, { enabled: true })).status, 409);
});

// ---- Component wiring (the web has no DOM harness: source patterns) ----

test('C1 and C2 the header switch is a labelled switch that is disabled with the reason as its tooltip and as a visible line', async () => {
  const control = await read('../src/ui/project-popup/AutoMergeControl.tsx');
  assert.match(control, /<Switch[\s\S]*aria-disabled=\{view\.disabled\}[\s\S]*disabled=\{view\.disabled\}[\s\S]*aria-label="Auto-merge"/);
  assert.match(control, /<TooltipContent[^>]*>\{view\.tooltip\}/);
  assert.match(control, /Auto-merge is unavailable: \{view\.reason\}/);
});

test('C3 the status panel sits in the header below the facts line; hiding uses style.display, never hidden', async () => {
  const header = await read('../src/ui/project-popup/DetailHeader.tsx');
  assert.ok(header.indexOf('facts.join') < header.indexOf('<AutoMergePanel'));
  assert.ok(header.indexOf('<AutoMergeSwitch') < header.indexOf('facts.join'));
  const control = await read('../src/ui/project-popup/AutoMergeControl.tsx');
  assert.match(control, /style=\{\{ display: 'none' \}\}/);
  assert.doesNotMatch(control, /(?<![-\w])hidden(?![-\w])/, 'no hidden attribute (aria-hidden is fine)');
});

test('C4 and C5 Enter and Space toggle through the store action, not fetch; a disabled switch ignores them', async () => {
  const control = await read('../src/ui/project-popup/AutoMergeControl.tsx');
  assert.match(control, /event\.key === 'Enter'[\s\S]*flip\(\)/);
  assert.match(control, /const flip = \(\) => \{ if \(!view\.disabled\) void setAutoMerge\(/);
  assert.match(control, /onCheckedChange=\{flip\}/);
  assert.doesNotMatch(control, /fetch\(/);
});

test('C6 and C10 the board card renders the chip beside the completion state, the state first', async () => {
  const board = await read('../src/ui/project-popup/TaskBoard.tsx');
  assert.match(board, /\{status && <Badge[^\n]*<AutoMergeChip autoMerge=\{autoMerge\} \/>/);
  assert.match(board, /autoMerge=\{row\.autoMerge\}/g);
  const tasks = await read('../src/lib/projectTasks.ts');
  assert.equal((tasks.match(/\.\.\.\(item\.autoMerge \? \{ autoMerge: item\.autoMerge \} : \{\}\)/g) ?? []).length, 2, 'open and completed rows carry it');
});

test('C7 the PR tab renders the tag and leaves Merge and Check out untouched', async () => {
  const panel = await read('../src/ui/project-popup/PrPanel.tsx');
  assert.match(panel, /autoMergeTag && <p data-auto-merge-tag/);
  assert.match(panel, /onClick=\{\(\) => onMerge\(model\)\}/);
  assert.match(panel, /onClick=\{onCheckout\}/);
  assert.match(panel, /prRowAutoMergeTag\(planItems, pr\.number\)/);
});

test('C8 the run link, Retry and Open PR tab handlers are wired', async () => {
  const control = await read('../src/ui/project-popup/AutoMergeControl.tsx');
  assert.match(control, /openCardDetail\(item\.projectId, \{ kind: 'run', id: panel\.runId! \}\)/);
  assert.match(control, /retryAutoMerge\(item\.projectId, item\.id\)/);
  assert.match(control, /setWorkspaceTab\('pr'\)/);
});

test('C9 there is no "Check now" control anywhere in the Auto-merge UI', async () => {
  for (const file of ['../src/ui/project-popup/AutoMergeControl.tsx', '../src/lib/autoMerge.ts']) assert.doesNotMatch(await read(file), /Check now/i);
});

test('C11 the docs describe every state, the agent choice rule and the blocker policy', async () => {
  const doc = await read('../../docs/auto-merge.md');
  for (const phrase of ['Auto-merge on, waiting', 'Merging', 'Resolving conflicts', 'Awaiting merge: blocked', 'can\'t reach the provider', 'agent unavailable', 'Merged', 'Auto-merge failed', 'No PR to merge', 'Can\'t be merged']) {
    assert.ok(doc.includes(phrase), phrase);
  }
  assert.match(doc, /Development step/);
  assert.match(doc, /first step that can edit code/);
  assert.match(doc, /never overridden/i);
});

test('completedAutoMergeHold: unmerged states hold a finished task, merged and off release it', () => {
  const { completedAutoMergeHold, autoMergeHoldOf } = lib;
  const item = (state, patch = {}) => ({ status: 'done', workflowRunId: 'r1', autoMerge: record(state), ...patch });
  for (const state of ['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent']) assert.equal(completedAutoMergeHold(item(state), null), 'awaiting-merge', state);
  for (const state of ['failed', 'cannot-merge', 'no-pr']) assert.equal(completedAutoMergeHold(item(state), null), 'needs-you', state);
  assert.equal(completedAutoMergeHold(item('merged'), null), null);
  assert.equal(completedAutoMergeHold(item('merging', { autoMerge: record('merging', { enabled: false }) }), null), null);
  assert.equal(completedAutoMergeHold(item('merging', { status: 'developing' }), null), null);
  assert.equal(completedAutoMergeHold(item('merging', { status: 'developing' }), { status: 'completed' }), 'awaiting-merge');
  assert.equal(completedAutoMergeHold(undefined, null), null);
  assert.equal(autoMergeHoldOf(undefined), null);
});

// ---- Required checks (task 19.002) ----

test('W20 the panel carries the optional-checks warnings in every state and they never change the tone or state', () => {
  for (const state of AUTO_MERGE_STATES) {
    const plain = autoMergePanel(record(state), NOW);
    const warned = autoMergePanel(record(state, { warnings: ['Optional checks failing: Vercel'] }), NOW);
    assert.deepEqual(warned.warnings, ['Optional checks failing: Vercel'], state);
    assert.deepEqual([warned.tone, warned.state, warned.reasons, warned.actions], [plain.tone, plain.state, plain.reasons, plain.actions], state);
  }
});

test('W21 a record without warnings (an older daemon) reads as none', () => {
  assert.deepEqual(autoMergePanel(record('waiting'), NOW).warnings, []);
});

test('W22 a blocked panel lists the required checks named in its reasons', () => {
  const panel = autoMergePanel(record('blocked', { reasons: ['Checks are failing: build, lint'] }), NOW);
  assert.deepEqual(panel.reasons, ['Checks are failing: build, lint']);
});

test('C12 the panel shows each warning in the warning text colour, apart from the reasons list and never in the destructive colour', async () => {
  const control = await read('../src/ui/project-popup/AutoMergeControl.tsx');
  assert.match(control, /panel\.warnings\.map\(\(warning\) => <p key=\{warning\} data-auto-merge-warning className="text-warning-foreground">/);
  assert.ok(control.indexOf('panel.reasons.length') < control.indexOf('panel.warnings.map'));
});

test('C13 reading a merged notification resolves it locally, as the daemon does', async () => {
  const store = await read('../src/store/worldStore.ts');
  assert.equal((store.match(/n\.kind === 'automerge\.merged'/g) ?? []).length, 2);
});
