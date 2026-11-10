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

const lib = await import('../src/lib/earlyUiPlanning.ts');
const bulk = await import('../src/lib/bulkStart.ts');
const { START_WHEN_MERGED_LABEL } = await import('../src/lib/dependencies.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { reportedError, CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/** Web cases of task 38.002: "UI planning waits for parent" and the early UI Planning it controls. */

const NOW = '2026-11-01T00:00:00.000Z';
const item = (id, extra = {}) => ({ id, projectId: 'p', title: `38.00${id}: Task ${id}`, description: '', status: 'pending', order: Number(id) || 0, taskIds: [], executorId: null, workflowRunId: null, createdAt: NOW, updatedAt: NOW, ...extra });
const waiting = (state = 'waiting', reasons = [{ parentId: 'a', text: 'Waiting for #38.001 to finish', blocked: state === 'blocked' }]) => ({ options: {}, state, reasons, since: NOW, longWaitNotified: false, updatedAt: NOW });
const run = (planItemId, status, early = { stepId: 'ui-planning', revisions: 0 }, extra = {}) => ({
  id: `run-${planItemId}`, projectId: 'p', planItemId, workflowId: 'software-development', status, currentStepId: 'ui-planning', executorId: 'e',
  prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0, createdAt: NOW, updatedAt: NOW, completedAt: null,
  workflowSnapshot: { id: 'software-development', name: 'SD', description: '', enabled: true, steps: [] }, ...(early ? { early } : {}), ...extra,
});
/** A Planning-queue entry for one startable task, as `buildBulkRows` reads it. */
const planningTask = (id) => ({ kind: 'task', id, order: 0, task: { id, title: `38.00${id}: Task ${id}`, state: 'todo', primary: 'start', workflowRunId: null } });
const BULK_DEFAULTS = { projectDefaultId: 'sd', enabledIds: ['sd', 'bug-fix'], bugWorkflowId: 'bug-fix', earlyStepWorkflowIds: ['sd'] };
const UI_STEP = { id: 'ui-planning', requiresApproval: true, canEditCode: false };
const SOFTWARE = [UI_STEP, { id: 'test-case-planning', requiresApproval: false, canEditCode: false }];

// ---- The switch ----

test('W1 a ready task with parents shows an editable switch with the exact label and helper texts', () => {
  const view = lib.uiWaitsSwitch({ item: item('2', { dependsOn: ['1'] }), surface: 'card' });
  assert.deepEqual(view, { shown: true, disabled: false, checked: false, note: null });
  assert.equal(lib.UI_WAITS_LABEL, 'UI planning waits for parent');
  assert.equal(lib.UI_WAITS_HELP_OFF, 'Off: UI Planning runs as soon as the task is started and asks for your approval. Later steps wait for the parents.');
  assert.equal(lib.UI_WAITS_HELP_ON, 'On: nothing runs until the parents are merged. Use this when this task\'s UI builds on UI a parent adds.');
  assert.equal(lib.uiWaitsSwitch({ item: item('2', { dependsOn: ['1'], uiPlanningWaitsForParent: true }), surface: 'detail' }).checked, true);
});

test('W2 no parents: the switch is hidden on the card, in the details and in the bulk row', () => {
  for (const surface of ['card', 'detail']) assert.equal(lib.uiWaitsSwitch({ item: item('2'), surface }).shown, false);
  const [row] = bulk.buildBulkRows([planningTask('2')], [item('2')], BULK_DEFAULTS);
  assert.equal(row.hasParents, false, 'the bulk row shows the switch only for a row with parents (BulkStartDialog: row.hasParents && row.earlyStep)');
});

test('W3 once UI Planning started: hidden on the card, locked with its reason in the details', () => {
  const started = item('2', { dependsOn: ['1'], waiting: waiting(), workflowRunId: 'run-2', status: 'developing' });
  assert.equal(lib.uiWaitsSwitch({ item: started, surface: 'card' }).shown, false);
  assert.deepEqual(lib.uiWaitsSwitch({ item: started, surface: 'detail' }), { shown: true, disabled: true, checked: false, note: 'UI Planning has already started, so this can\'t change now.' });
});

test('W4 a workflow without the UI Planning step: locked with its reason in the details', () => {
  const view = lib.uiWaitsSwitch({ item: item('2', { dependsOn: ['1'] }), surface: 'detail', workflowSteps: [{ id: 'reproduce', requiresApproval: true, canEditCode: false }] });
  assert.equal(view.disabled, true);
  assert.equal(view.note, 'This task\'s workflow has no UI Planning step, so this setting has no effect.');
  assert.equal(lib.uiWaitsSwitch({ item: item('2', { dependsOn: ['1'] }), surface: 'detail', workflowSteps: SOFTWARE }).disabled, false);
  assert.equal(lib.hasEarlyStep(SOFTWARE), true);
  assert.equal(lib.hasEarlyStep([{ ...UI_STEP, canEditCode: true }]), false);
});

// ---- The phase line and badge ----

test('W5 W6 the phase line wording, each with a glyph; none without an early run', () => {
  const child = item('2', { dependsOn: ['1'], waiting: waiting() });
  const queue = [{ planItemId: 'x', position: 0 }, { planItemId: '2', early: true, position: 1 }];
  const cases = [
    [lib.earlyPhaseOf(child, null, queue), '◷ UI planning waits for a free slot · #2'],
    [lib.earlyPhaseOf(child, run('2', 'running'), []), '● UI planning running early'],
    [lib.earlyPhaseOf(child, run('2', 'awaiting-approval'), []), '! UI plan needs your approval'],
    [lib.earlyPhaseOf(child, run('2', 'running', { stepId: 'ui-planning', revisions: 1 }), []), '● UI plan revision running'],
    [lib.earlyPhaseOf(child, run('2', 'held'), []), '✓ UI plan approved, waiting for parents'],
    [lib.earlyPhaseOf(item('2'), run('2', 'held', { stepId: 'ui-planning', revisions: 0, released: true }), [{ planItemId: '2', resumeRunId: 'run-2', position: 0 }]), '✓ UI plan approved'],
  ];
  for (const [phase, text] of cases) {
    const line = lib.earlyPhaseLine(phase);
    assert.equal(line, text);
    assert.match(line, /^[◷●!✓] /, 'W6 a glyph, so the meaning never depends on colour');
  }
  assert.equal(lib.earlyPhaseOf(item('2', { uiPlanningWaitsForParent: true, waiting: waiting() }), null, []), null, 'the setting on: no phase');
  assert.equal(lib.earlyPhaseOf(item('2'), null, [{ planItemId: '2', position: 0 }]), null, 'a plain queued start is not early');
  assert.equal(lib.earlyPhaseOf(child, run('2', 'held', { stepId: 'ui-planning', revisions: 0, skipped: true }), []), null, 'a skipped UI Planning shows no phase');
  assert.equal(lib.earlyPhaseLine(null), null);
});

test('W7 the card badge: Running while working, Needs you for the approval, else Waiting or Blocked', () => {
  const row = (phase, state = 'waiting') => ({ earlyPhase: phase, waiting: waiting(state), state: 'executing' });
  assert.equal(lib.openCardStatus(row({ kind: 'running' })), 'Running');
  assert.equal(lib.openCardStatus(row({ kind: 'revising' })), 'Running');
  assert.equal(lib.openCardStatus(row({ kind: 'awaiting-approval' })), 'Needs you');
  assert.equal(lib.openCardStatus(row({ kind: 'approved', queued: false })), 'Waiting');
  assert.equal(lib.openCardStatus(row({ kind: 'approved', queued: false }, 'blocked')), 'Blocked');
  assert.equal(lib.openCardStatus({ waiting: waiting(), state: 'todo' }), 'Waiting', 'no early run: unchanged');
  assert.equal(lib.openCardStatus({ queued: { position: 1 }, state: 'todo' }), null);
  assert.equal(lib.openCardStatus({ waiting: waiting('blocked'), state: 'todo' }), 'Blocked');
  const plain = ['todo', 'executing', 'blocked', 'failed', 'stopped', 'paused'].map((state) => lib.openCardStatus({ state }));
  assert.deepEqual(plain, [null, 'Running', 'Needs you', 'Failed', 'Stopped', 'Stopped'], 'a card without an early run keeps its badge');
  // The approval card keeps its attention border: the task's status is blocked while the run awaits approval.
  const groups = buildTaskGroups({ items: [item('2', { dependsOn: ['1'], waiting: waiting(), workflowRunId: 'run-2', status: 'blocked' })], tasksById: {}, workflowRunsByProject: { p: [run('2', 'awaiting-approval')] }, projectId: 'p', showArchived: false, now: 0 });
  assert.equal(groups.needsYou[0].attention, 'input', 'data-attention=input');
});

test('W8 the waiting panel: Review UI plan only at the approval, and Cancel waiting asks first once a UI plan exists', () => {
  assert.deepEqual(lib.earlyWaitingActions({ kind: 'awaiting-approval' }), { reviewUiPlan: true, openRun: false, confirmCancel: true });
  assert.deepEqual(lib.earlyWaitingActions({ kind: 'running' }), { reviewUiPlan: false, openRun: true, confirmCancel: true });
  assert.deepEqual(lib.earlyWaitingActions({ kind: 'approved', queued: false }), { reviewUiPlan: false, openRun: false, confirmCancel: true });
  assert.deepEqual(lib.earlyWaitingActions({ kind: 'queued', place: 1 }), { reviewUiPlan: false, openRun: false, confirmCancel: false });
  assert.deepEqual(lib.earlyWaitingActions(null), { reviewUiPlan: false, openRun: false, confirmCancel: false }, 'the setting on: no confirm');
  assert.equal(lib.CANCEL_CONFIRM_TEXT, 'Cancel waiting? The UI plan made so far is discarded.');
  assert.deepEqual([lib.KEEP_WAITING_LABEL, lib.CANCEL_AND_DISCARD_LABEL, lib.REVIEW_UI_PLAN_LABEL], ['Keep waiting', 'Cancel and discard', 'Review UI plan']);
});

// ---- The Start task dialog ----

const startView = (extra = {}) => lib.startParentsView({ steps: SOFTWARE, skippedStepIds: [], createBranch: true, waits: false, slotsInUse: 0, cap: 6, ...extra });

test('W9 the parents step: off runs UI Planning now, on keeps today\'s text and label', () => {
  const off = startView();
  assert.equal(off.primaryLabel, 'Start UI planning now');
  assert.equal(off.body, 'UI Planning runs now and asks for your approval. Test Case Planning and the later steps start by themselves once these parent tasks are merged into the checked-out branch. Until then the task shows in Running as Waiting, and you can cancel waiting at any time.');
  const on = startView({ waits: true });
  assert.equal(on.primaryLabel, START_WHEN_MERGED_LABEL);
  assert.equal(on.body, 'This task starts by itself once these parent tasks are merged into the checked-out branch. Until then it shows in Running as Waiting, and you can cancel waiting at any time.');
  assert.equal(on.switchShown, true);
});

test('W10 no UI Planning step, or UI Planning unchecked: a note instead of the switch, and the waiting label', () => {
  const none = startView({ steps: [{ id: 'build', requiresApproval: false, canEditCode: true }] });
  assert.deepEqual([none.switchShown, none.note, none.primaryLabel], [false, 'This workflow has no UI Planning step, so nothing runs before the parents are merged.', 'Start when parents are merged']);
  const unchecked = startView({ skippedStepIds: ['ui-planning'] });
  assert.deepEqual([unchecked.switchShown, unchecked.note, unchecked.primaryLabel], [false, 'UI Planning isn\'t selected for this run, so nothing runs before the parents are merged.', 'Start when parents are merged']);
  assert.equal(startView({ createBranch: false }).switchShown, false, 'an in-place start never runs early');
});

test('W11 slots full and the setting off: UI Planning waits in line, with the project cap', () => {
  assert.equal(startView({ slotsInUse: 3, cap: 3 }).fullNote, 'All 3 slots are in use; UI Planning will wait in line and start on its own.');
  assert.equal(startView({ slotsInUse: 3, cap: 3, waits: true }).fullNote, null);
  assert.equal(startView({ slotsInUse: 2, cap: 3 }).fullNote, null);
});

test('W12 the Start dialog opens on the stored value, sends the chosen value, and Back or Cancel saves nothing', async () => {
  const dialogs = await read('../src/ui/project-popup/TaskDialogs.tsx');
  assert.match(dialogs, /const \[uiWaits, setUiWaits\] = useState\(initialUiPlanningWaits\);/);
  assert.match(dialogs, /const waits = parents && parents\.length > 0 \? \{ uiPlanningWaitsForParent: uiWaits \} : \{\};/);
  assert.match(dialogs, /await onStart\(\{ \.\.\.startOptions\(/);
  assert.doesNotMatch(dialogs, /setUiPlanningWaits/, 'the dialog never saves on its own: only an accepted start does');
  const panel = await read('../src/ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /initialUiPlanningWaits=\{items\.find\(\(candidate\) => candidate\.id === dialog\.row\.id\)\?\.uiPlanningWaitsForParent === true\}/);
});

// ---- "Start pending tasks" ----

const bulkRow = (id, extra = {}) => ({ id, title: `Task ${id}`, kind: 'Task', number: `#38.00${id}`, needsMoreInfo: false, hasParents: true, workflowId: 'sd', locked: false, uiPlanningWaitsForParent: false, earlyStep: true, ...extra });

test('W13 the bulk note counts checked rows with parents that run UI Planning now', () => {
  assert.equal(lib.bulkEarlyNote(0), null);
  assert.equal(lib.bulkEarlyNote(1), 'UI Planning of the task that waits for parents runs now, so you can approve its UI plan right away.');
  assert.equal(lib.bulkEarlyNote(2), 'UI Planning of the 2 tasks that wait for parents runs now, so you can approve those UI plans together.');
  const rows = [bulkRow('1'), bulkRow('2'), bulkRow('3', { uiPlanningWaitsForParent: true }), bulkRow('4', { hasParents: false }), bulkRow('5')];
  const parents = { 1: [{}], 2: [{}], 3: [{}], 5: [{}] };
  assert.equal(bulk.bulkEarlyRowsNote(rows, ['1', '2', '3', '4'], {}, parents), lib.bulkEarlyNote(2), 'unchecked, setting-on and parentless rows do not count');
  assert.equal(bulk.bulkEarlyRowsNote(rows, ['1', '2'], { 2: true }, parents), lib.bulkEarlyNote(1), 'a row switched on in the dialog no longer counts');
  assert.equal(bulk.bulkEarlyRowsNote(rows, ['1'], {}, { 1: [] }), null, 'parents already merged: it starts at once');
});

test('W14 the row result wording for an early, a slot-waiting and a setting-on start', () => {
  assert.equal(bulk.rowStatusText({ status: 'waiting', early: { place: null } }), 'Waiting · UI Planning runs now; later steps start once its parents are merged');
  assert.equal(bulk.rowStatusText({ status: 'waiting', early: { place: 2 } }), 'Waiting · UI Planning is in line for a free slot (#2); later steps start once its parents are merged');
  assert.equal(bulk.rowStatusText({ status: 'waiting' }), 'Waiting · starts by itself once its parents are merged');
  assert.deepEqual(bulk.classifyStart('', [{ planItemId: 'x', position: 0 }, { planItemId: '2', early: true, position: 1 }], '2', true), { status: 'waiting', early: { place: 2 } });
  assert.deepEqual(bulk.classifyStart('', [], '2', true), { status: 'waiting', early: { place: null } });
  assert.deepEqual(bulk.classifyStart('', [], '2', false), { status: 'waiting' });
  assert.deepEqual(bulk.classifyStart('', [{ planItemId: '2', position: 0 }], '2', false), { status: 'queued', position: 1 });
});

test('W15 the summary adds the UI plans coming for approval, singular at one, and leaves it out at zero', () => {
  const results = { a: { status: 'started' }, b: { status: 'waiting', early: { place: null } }, c: { status: 'waiting', early: { place: 1 } }, d: { status: 'waiting', early: { place: null } }, e: { status: 'waiting' } };
  assert.equal(bulk.summaryLine(results), '1 started · 4 waiting for parents · 3 UI plans coming for approval');
  assert.equal(bulk.summaryLine({ a: { status: 'waiting', early: { place: null } } }), '1 waiting for parents · 1 UI plan coming for approval');
  assert.equal(bulk.summaryLine({ a: { status: 'waiting' } }), '1 waiting for parents');
});

test('W16 rowStartOptions carries the row\'s setting for a task with parents, and the row switch locks once the batch starts', async () => {
  assert.equal(bulk.rowStartOptions(bulkRow('1'), 'e', false, true, true).uiPlanningWaitsForParent, true);
  assert.equal(bulk.rowStartOptions(bulkRow('1'), 'e', false, true, false).uiPlanningWaitsForParent, false);
  assert.equal('uiPlanningWaitsForParent' in bulk.rowStartOptions(bulkRow('1', { hasParents: false }), 'e', false, true, true), false);
  const dialog = await read('../src/ui/project-popup/BulkStartDialog.tsx');
  assert.match(dialog, /disabled=\{phase !== 'idle'\} aria-label=\{`\$\{UI_WAITS_LABEL\}: /);
  const [row] = bulk.buildBulkRows([planningTask('2')], [item('2', { dependsOn: ['1'], uiPlanningWaitsForParent: true })], BULK_DEFAULTS);
  assert.deepEqual([row.hasParents, row.uiPlanningWaitsForParent, row.earlyStep], [true, true, true], 'the row opens on the stored value');
  const [bug] = bulk.buildBulkRows([planningTask('3')], [item('3', { dependsOn: ['1'], type: 'bug', bug: { infoStatus: null } })], BULK_DEFAULTS);
  assert.equal(bug.earlyStep, false, 'the bug workflow has no early step, so the row shows no switch');
});

// ---- Store ----

test('W17 a plan item\'s setting passes through the store; absent reads as off', async () => {
  installServerStub();
  useWorldStore.setState({ ...useWorldStore.getInitialState?.(), ...CLEAN_ERROR_STATE }, false);
  await useWorldStore.getState().addProject('Store pass-through');
  const project = useWorldStore.getState().projects.at(-1);
  await useWorldStore.getState().loadPlan(project.id);
  const on = item('w17a', { projectId: project.id, dependsOn: ['1'], uiPlanningWaitsForParent: true, waiting: waiting() });
  const legacy = item('w17b', { projectId: project.id, dependsOn: ['1'] });
  for (const planItem of [on, legacy]) useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem }));
  const items = useWorldStore.getState().planByProject[project.id].items;
  assert.equal(items.find((entry) => entry.id === 'w17a').uiPlanningWaitsForParent, true);
  assert.equal(items.find((entry) => entry.id === 'w17b').uiPlanningWaitsForParent, undefined, 'absent reads as off');
  assert.equal(lib.uiWaitsSwitch({ item: items.find((entry) => entry.id === 'w17b'), surface: 'card' }).checked, false);
});

test('W17 toPlanItemData copies uiPlanningWaitsForParent', async () => {
  const store = await read('../src/store/worldStore.ts');
  assert.match(store, /\.\.\.\(item\.uiPlanningWaitsForParent !== undefined \? \{ uiPlanningWaitsForParent: item\.uiPlanningWaitsForParent \} : \{\}\),/);
});

test('W18 a held run merges without being dropped, and the web status union knows held', async () => {
  useWorldStore.setState({ ...useWorldStore.getInitialState?.(), ...CLEAN_ERROR_STATE, workflowRunsByProject: { p: [run('2', 'running')] } }, false);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'workflowRun', run: run('2', 'held') }));
  const runs = useWorldStore.getState().workflowRunsByProject.p;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'held');
  assert.deepEqual(runs[0].early, { stepId: 'ui-planning', revisions: 0 });
  assert.match(await read('../src/lib/serverApi.ts'), /export type WorkflowRunStatus = 'starting' \| 'running' \| 'held' \|/);
});

test('W19 board groups: early running to running, approval to needs you, held and early-queued to waiting', () => {
  const items = [
    item('1', { dependsOn: ['9'], waiting: waiting(), workflowRunId: 'run-1', status: 'developing' }),
    item('2', { dependsOn: ['9'], waiting: waiting(), workflowRunId: 'run-2', status: 'blocked' }),
    item('3', { dependsOn: ['9'], waiting: waiting(), workflowRunId: 'run-3', status: 'developing' }),
    item('4', { dependsOn: ['9'], waiting: waiting() }),
  ];
  const groups = buildTaskGroups({
    items, tasksById: {}, projectId: 'p', showArchived: false, now: 0,
    workflowRunsByProject: { p: [run('1', 'running'), run('2', 'awaiting-approval'), run('3', 'held')] },
    queue: [{ id: 'q', projectId: 'p', planItemId: '4', early: true, position: 0, createdAt: NOW }],
  });
  assert.deepEqual(groups.running.map((row) => row.id), ['1']);
  assert.deepEqual(groups.needsYou.map((row) => row.id), ['2']);
  assert.deepEqual(groups.waiting.map((row) => row.id).sort(), ['3', '4']);
  assert.deepEqual(groups.open.map((row) => row.id), []);
  assert.deepEqual(groups.waiting.find((row) => row.id === '3').earlyPhase, { kind: 'approved', queued: false });
});

test('W20 a refused save puts the previous value back with the inline error; an accepted one keeps the new value', async () => {
  assert.deepEqual(await lib.saveUiWaits(false, true, async () => false), { value: false, error: 'Couldn\'t save the setting. Try again.' });
  assert.deepEqual(await lib.saveUiWaits(false, true, async () => true), { value: true, error: null });
});

test('W20 the store saves through the daemon and reports nothing globally when refused', async () => {
  const stub = installServerStub();
  useWorldStore.setState({ ...useWorldStore.getInitialState?.(), ...CLEAN_ERROR_STATE }, false);
  await useWorldStore.getState().addProject('Early');
  const project = useWorldStore.getState().projects.at(-1);
  stub.projects.get(project.id).repositoryUrl = 'https://github.com/o/r';
  await useWorldStore.getState().loadPlan(project.id);
  const create = (title) => useWorldStore.getState().createPlanItem(project.id, { title, description: '' });
  const [a, b] = [await create('38.1: A'), await create('38.2: B')];
  const byId = (id) => useWorldStore.getState().planByProject[project.id].items.find((entry) => entry.id === id);
  assert.equal(await useWorldStore.getState().setUiPlanningWaits(project.id, b, true), false, 'no parents: refused');
  assert.equal(reportedError(), null, 'the switch shows the failure inline');
  await useWorldStore.getState().setDependencies(project.id, b, [a]);
  assert.equal(await useWorldStore.getState().setUiPlanningWaits(project.id, b, true), true);
  assert.equal(byId(b).uiPlanningWaitsForParent, true);
});

// ---- Components (source checks) ----

const board = await read('../src/ui/project-popup/TaskBoard.tsx');
const control = await read('../src/ui/project-popup/DependenciesControl.tsx');
const switchSource = await read('../src/ui/project-popup/UiPlanningWaitsSwitch.tsx');

test('C1 C2 the card switch sits outside the click area, above "Depends on…", and wraps safely', () => {
  const card = board.slice(board.indexOf('export function TaskCard('));
  const clickAreaEnd = card.indexOf('</div>\n      {uiWaitsSwitch}');
  assert.ok(clickAreaEnd > card.indexOf('role="button"'), 'rendered after the role="button" area closes');
  assert.ok(card.indexOf('{uiWaitsSwitch}') < card.indexOf('{dependsOnPicker}'), 'above Depends on…');
  assert.match(switchSource, /<Switch id=\{id\} className="mt-0\.5 shrink-0"/);
  assert.match(switchSource, /<Label htmlFor=\{id\} className="min-w-0 /);
  assert.doesNotMatch(switchSource, /onOpen|onClick/, 'C2 no click handler shared with the card');
});

test('C3 the card\'s phase line sits above the waiting banner; the queued line stays unless the phase names the line', () => {
  const card = board.slice(board.indexOf('export function TaskCard('));
  assert.ok(card.indexOf('data-early-phase') < card.indexOf('<WaitingBanner'));
  assert.match(card, /\{queued && !earlyPhaseLine\?\.queued && <p/);
});

test('C4 the details order: parents, picker, switch with its helper, waiting panel', () => {
  const section = control.slice(control.indexOf('export function DependsOnSection'));
  const order = ['section.parents.map', '<ParentPicker', '<UiPlanningWaitsSwitch item={item} surface="detail"', '<WaitingPanel item={item} view={waiting} />}\n    </section>'].map((needle) => section.indexOf(needle));
  assert.ok(order.every((index) => index > 0), 'every part is present');
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.match(switchSource, /aria-describedby=\{describedBy\}/);
});

test('C5 the waiting panel: Review UI plan opens the run, the inline confirm is a group, and Open run shows while it runs', () => {
  assert.match(control, /\{actions\.reviewUiPlan && <Button type="button" size="sm" onClick=\{openRun\}>\{REVIEW_UI_PLAN_LABEL\}<\/Button>\}/);
  assert.match(control, /openCardDetail\(item\.projectId, \{ kind: 'run', id: item\.workflowRunId \}\)/);
  assert.match(control, /<div role="group" aria-label="Confirm cancel waiting"/);
  assert.match(control, /\{actions\.openRun && <Button type="button" variant="link"[^>]*>Open run<\/Button>\}/);
});

test('C6 a refused save shows an inline alert on the card and in the details', () => {
  assert.match(switchSource, /\{error && <p role="alert" className="text-xs text-destructive">\{error\}<\/p>\}/);
  assert.match(board, /<UiPlanningWaitsSwitch item=\{item\} surface="card" \/>/);
  assert.match(control, /<UiPlanningWaitsSwitch item=\{item\} surface="detail"/);
});

test('C7 the Start dialog\'s parents step: switch, then body, then parents; the label comes from the view-model', async () => {
  const dialogs = await read('../src/ui/project-popup/TaskDialogs.tsx');
  const step = dialogs.slice(dialogs.indexOf('function ParentsConfirmation'));
  const order = ['data-ui-waits="start"', '{view.body}', 'parents.map'].map((needle) => step.indexOf(needle));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.match(dialogs, /\{parentsView\.primaryLabel\}<\/Button>/);
});

test('C8 the bulk row switch sits outside the checkbox label and names its task', async () => {
  const dialog = await read('../src/ui/project-popup/BulkStartDialog.tsx');
  const rowSource = dialog.slice(dialog.indexOf('function BulkStartRow'));
  assert.ok(rowSource.indexOf('</Label>') < rowSource.indexOf('data-row-ui-waits'), 'after the Label closes');
  assert.match(rowSource, /aria-label=\{`\$\{UI_WAITS_LABEL\}: \$\{row\.kind\}\$\{row\.number \? ` \$\{row\.number\}` : ` \$\{row\.title\}`\}`\}/);
  assert.match(rowSource, /disabled=\{phase !== 'idle'\}/);
});

test('C9 every Start entry point sends a dependent task through start-when-ready with the setting', async () => {
  const store = await read('../src/store/worldStore.ts');
  assert.match(store, /return startsWhenReady\(item\) \? get\(\)\.startWhenReady\(projectId, itemId, options\) : get\(\)\.executePlanItem\(itemId, options\);/);
  const panel = await read('../src/ui/project-popup/PlanningTaskPanel.tsx');
  assert.match(panel, /handlers\.onStart\(\{ id: row\.id, title: row\.fullTitle \}\)/, 'the planning panel opens the same Start dialog');
});

test('C10 the client calls the route with the exact method, path and body', async () => {
  const api = await read('../src/lib/serverApi.ts');
  assert.match(api, /setUiPlanningWaits: \(projectId: string, itemId: string, uiPlanningWaitsForParent: boolean\): Promise<PlanItem> =>\n\s+request\(`\/api\/projects\/\$\{projectId\}\/plan-items\/\$\{itemId\}\/ui-planning-waits`, \{ method: 'PUT', body: JSON\.stringify\(\{ uiPlanningWaitsForParent \}\) \}\),/);
  assert.match(api, /uiPlanningWaitsForParent\?: boolean;\n\}/, 'ExecutePlanItemOptions carries the field to start-when-ready');
});

test('W19 the footer counts match its popover rows, and a held early run is listed as Waiting', async () => {
  const { buildTasksPopupGroups } = await import('../src/lib/footerPopovers.ts');
  const { summarizeWorkspaceCounts } = await import('../src/lib/workspaceCounts.ts');
  const items = [
    item('1', { dependsOn: ['9'], waiting: waiting(), workflowRunId: 'run-1', status: 'developing' }),
    item('3', { dependsOn: ['9'], waiting: waiting(), workflowRunId: 'run-3', status: 'developing' }),
    item('4', { dependsOn: ['9'], waiting: waiting() }),
  ];
  const boards = {
    projects: [{ id: 'p', name: 'P', status: 'developing' }], executors: [],
    planByProject: { p: { items } }, taskIdsByProject: { p: [] }, tasksById: {},
    workflowRunsByProject: { p: [run('1', 'running'), run('3', 'held')] },
    planItemQueueByProject: { p: [{ id: 'q', projectId: 'p', planItemId: '4', early: true, position: 0, createdAt: NOW }] },
  };
  const [group] = buildTasksPopupGroups(boards);
  const counts = summarizeWorkspaceCounts(boards);
  assert.equal(group.counts.active + group.counts.blocked + group.counts.pending, group.rows.length);
  assert.deepEqual(counts.tasks, group.counts, 'the footer total equals the popover rows');
  const held = group.rows.find((row) => row.id === '3');
  assert.equal(held.kind, 'pending');
  assert.equal(held.label, 'Waiting');
});

test('W4 a bug that waits on a parent resolves its Bug Fix workflow: no switch on the card, the reason in the details', async () => {
  const workflows = [
    { id: 'software-development', enabled: true, steps: SOFTWARE },
    { id: 'bug-fix', enabled: true, steps: [{ id: 'reproduce', requiresApproval: false, canEditCode: false }] },
  ];
  const context = { workflows, project: { workflowId: 'software-development' }, bugWorkflowId: 'bug-fix' };
  const bug = item('5', { type: 'bug', bug: { infoStatus: null }, dependsOn: ['1'] });
  const steps = lib.startWorkflowSteps(bug, context);
  assert.deepEqual(steps.map((step) => step.id), ['reproduce'], 'the bug default, as the Start dialog preselects it');
  assert.equal(lib.uiWaitsSwitch({ item: bug, surface: 'card', workflowSteps: steps }).shown, false);
  assert.equal(lib.uiWaitsSwitch({ item: bug, surface: 'detail', workflowSteps: steps }).note, lib.UI_WAITS_NO_STEP_NOTE);
  const plain = item('6', { dependsOn: ['1'] });
  assert.equal(lib.uiWaitsSwitch({ item: plain, surface: 'card', workflowSteps: lib.startWorkflowSteps(plain, context) }).shown, true);
  assert.equal(lib.startWorkflowSteps(item('7', { dependsOn: ['1'], waiting: { ...waiting(), options: { workflowId: 'bug-fix' } } }), context)[0].id, 'reproduce', 'a waiting task keeps the workflow it was started with');
  assert.equal(lib.startWorkflowSteps(plain, { ...context, bugWorkflowId: 'gone', workflows: [] }), undefined, 'unknown: no claim');
  const switchSource = await read('../src/ui/project-popup/UiPlanningWaitsSwitch.tsx');
  assert.match(switchSource, /startWorkflowSteps\(item, \{ workflows: s\.catalogWorkflows, project: s\.projects\.find\(\(entry\) => entry\.id === item\.projectId\), bugWorkflowId \}\)/, 'the card and the details share one resolver');
  assert.match(await read('../src/ui/project-popup/TasksPanel.tsx'), /<BugWorkflowIdContext\.Provider value=\{bugWorkflowId\}>/);
});
