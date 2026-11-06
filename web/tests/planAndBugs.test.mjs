import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const bugs = await import('../src/lib/bugs.ts');
const deps = await import('../src/lib/dependencies.ts');
const projectTasks = await import('../src/lib/projectTasks.ts');
const { buildPlanningTaskPanel, sessionPanelWording, sessionHistoryView } = await import('../src/lib/planningTaskPanel.ts');

/**
 * The Plan & bugs session on the web: kind helpers, board placement and counts, the session panel, the
 * footer popover, and bugs as dependency parents and children. The web has no render harness, so
 * components are pinned by source.
 */

const AT = '2026-10-01T10:00:00.000Z';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const at = (minutes) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

const item = (id, patch = {}) => ({
  id, projectId: 'p1', title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [],
  executorId: null, createdAt: AT, updatedAt: AT, ...patch,
});
const task = (id, number, patch = {}) => item(id, { title: `7.00${number}: Task ${id}`, planningRef: { session: 7, task: number }, ...patch });
const bug = (id, patch = {}, bugPatch = {}) => item(id, {
  type: 'bug', title: `B.00${id.length}: Bug ${id}`,
  bug: { severity: null, infoStatus: 'enough', introducedBy: null, suspectedLocation: null, foundWhileWorkingOn: null, reportSessionNumber: 7, testRef: null, groupOrder: null, regressions: [], ...bugPatch },
  ...patch,
});
const session = (id, patch = {}) => ({
  id, projectId: 'p1', executorId: 'exec-claude', executionMode: 'terminal', description: `Session ${id}`, status: 'stopped', autonomy: 'auto',
  kind: 'plan', planItemId: null, sessionId: `sess-${id}`, blockedQuestion: null, failureReason: null, createdAt: AT, updatedAt: AT, completedAt: null,
  planningSessionNumber: 7, planningCreatedTaskCount: 4, planningPurpose: 'plan-and-bugs', ...patch,
});
const byId = (records) => Object.fromEntries(records.map((record) => [record.id, record]));
const REPO = 'https://github.com/test/repo';

// ---- Kinds, labels and status words ----

test('WU15 the kind helpers tell planning, bug report and Plan & bugs apart', () => {
  const planning = session('a', { planningPurpose: undefined });
  const report = session('b', { planningPurpose: 'bug-report' });
  const combined = session('c');
  assert.deepEqual([planning, report, combined].map(bugs.sessionKindOf), ['planning', 'bug-report', 'plan-and-bugs']);
  assert.equal(bugs.isPlanAndBugsSession(combined), true);
  assert.equal(bugs.isBugReportSession(combined), false);
  assert.equal(bugs.isPlanAndBugsSession({ kind: 'execute', planningPurpose: 'plan-and-bugs' }), false);
  assert.equal(bugs.isPlanAndBugsSession(undefined), false);
  assert.deepEqual(['planning', 'bug-report', 'plan-and-bugs'].map(bugs.sessionTypeLabel), ['Planning', 'Bug report', 'Plan & bugs']);
});

test('WU10 the Plan & bugs status: Planning while working, Needs you while waiting, none between turns, CLI not started', () => {
  assert.equal(bugs.planAndBugsStatusLabel({ live: 'running', cliNotStarted: false }), 'Planning');
  assert.equal(bugs.planAndBugsStatusLabel({ live: 'blocked', cliNotStarted: false }), 'Needs you');
  assert.equal(bugs.planAndBugsStatusLabel({ live: 'idle', cliNotStarted: false }), null);
  assert.equal(bugs.planAndBugsStatusLabel({ live: 'running', cliNotStarted: true }), 'CLI not started');
  assert.equal(bugs.bugReportStatusLabel({ live: 'running', cliNotStarted: false }), 'Reporting', 'the old kind keeps its word');
  const rows = projectTasks.buildPlanningRows({ taskIds: ['p', 'r', 'c', 'n'], tasksById: byId([
    session('p', { planningPurpose: undefined, status: 'developing', planningSessionNumber: 1 }),
    session('r', { planningPurpose: 'bug-report', planningSessionNumber: 2 }),
    session('c', { status: 'developing', planningSessionNumber: 3 }),
    session('n', { cliNotStarted: true, planningSessionNumber: 4 }),
  ]), showArchived: false, now: NOW, includeBugReports: true });
  assert.deepEqual(rows.map((row) => [row.id, row.kind, row.live, row.cliNotStarted]).sort(), [
    ['c', 'plan-and-bugs', 'running', false], ['n', 'plan-and-bugs', 'idle', true], ['p', 'planning', 'running', false], ['r', 'bug-report', 'idle', false],
  ]);
});

test('WU11 the expander counts both kinds: "N tasks ready · M bugs", singular forms, and nothing filed', () => {
  assert.equal(bugs.planAndBugsExpanderLabel(2, 2, 4), 'Plan & bugs · 2 tasks ready · 2 bugs');
  assert.equal(bugs.planAndBugsExpanderLabel(1, 1, 2), 'Plan & bugs · 1 task ready · 1 bug');
  assert.equal(bugs.planAndBugsExpanderLabel(3, 0, 3), 'Plan & bugs · 3 tasks ready');
  assert.equal(bugs.planAndBugsExpanderLabel(0, 2, 2), 'Plan & bugs · 0 tasks ready · 2 bugs');
  assert.equal(bugs.planAndBugsExpanderLabel(0, 0, 0), 'Plan & bugs · nothing filed yet');
  assert.equal(bugs.conversationExpanderLabel(2, 1), 'Planning · 2 tasks ready · 1 bug', 'a planning conversation is unchanged');
});

test('WU11 the history counts name tasks and bugs; started, completed, archived and removed items are not "ready"', () => {
  const items = [
    task('t1', 1), task('t2', 2), bug('b1'), bug('b2'),
    task('t3', 3, { status: 'developing' }), bug('b3', { status: 'done' }), task('t4', 4, { archived: true }),
  ];
  const history = projectTasks.planAndBugsHistory(items, 7, 9);
  assert.equal(projectTasks.planAndBugsCountsLabel(history), '2 tasks ready · 2 bugs · 1 started · 1 completed · 1 archived · 2 removed');
  assert.equal(projectTasks.planAndBugsCountsLabel(projectTasks.planAndBugsHistory([task('t1', 1)], 7, 1)), '1 task ready');
  assert.equal(projectTasks.planAndBugsCountsLabel(projectTasks.planAndBugsHistory([bug('b1')], 7, 1)), '0 tasks ready · 1 bug');
  assert.equal(projectTasks.planAndBugsCountsLabel(projectTasks.planAndBugsHistory([], null, 0)), '0 tasks ready');
  assert.equal(sessionHistoryView({ items, sessionNumber: 7, createdTaskCount: 9, kind: 'plan-and-bugs' }).countsLabel, projectTasks.planAndBugsCountsLabel(history));
});

test('WU12 only this session\'s items are linked: numbered tasks by session, bugs by the session that filed them', () => {
  const items = [task('t', 1), bug('b'), bug('other', {}, { reportSessionNumber: 8 }), item('person'), item('report-task', { reportSessionNumber: 7 })];
  assert.deepEqual(bugs.planAndBugsLinkedItems(items, 7).map((entry) => entry.id), ['t', 'b', 'report-task']);
  assert.deepEqual(bugs.planAndBugsLinkedItems(items, null), []);
});

// ---- Board placement ----

test('WU09 WU20 the session nests its tasks, bugs sit under their introducing task or alone, and the line counts both', () => {
  const introducer = item('intro', { title: '4.002: Add login', status: 'done' });
  const items = [
    task('t1', 1), task('t2', 2), introducer,
    bug('under', {}, { introducedBy: { planItemId: 'intro', number: '4.002', title: 'Add login', commit: null } }),
    bug('alone'),
  ];
  const queue = projectTasks.buildPlanningQueue({ items, taskIds: ['s'], tasksById: byId([session('s')]), now: NOW });
  const entry = queue.find((candidate) => candidate.kind === 'session').session;
  assert.equal(entry.kind, 'plan-and-bugs');
  assert.deepEqual(entry.ready.map((row) => row.id), ['t1', 't2'], 'tasks nest, bugs do not');
  assert.equal(entry.readyTaskCount, 2);
  assert.equal(entry.readyBugCount, 2);
  assert.deepEqual(queue.filter((candidate) => candidate.kind === 'reference').map((candidate) => candidate.reference.bugs.map((row) => row.id)), [['under']]);
  assert.deepEqual(queue.filter((candidate) => candidate.kind === 'task').map((candidate) => candidate.id).sort(), ['alone'], 'the standalone bug is its own entry');
});

test('WU09 a waiting ready bug keeps its Planning placement; a started waiting bug sits in Running with a Waiting badge', () => {
  const waiting = { state: 'waiting', reasons: [], options: { executorId: 'e' }, since: AT, longWaitNotified: false, updatedAt: AT };
  const ready = bug('ready', { dependsOn: ['t1'], waiting });
  const queue = projectTasks.buildPlanningQueue({ items: [task('t1', 1), ready], taskIds: ['s'], tasksById: byId([session('s')]), now: NOW });
  assert.ok(queue.some((entry) => entry.kind === 'task' && entry.id === 'ready'), 'still a Planning entry');
  const [row] = projectTasks.buildOpenTaskRows({ items: [ready], tasksById: {}, showArchived: false, now: NOW });
  assert.equal(row.waiting.state, 'waiting');
  assert.equal(deps.waitingView(row.waiting).badge, 'Waiting');
  assert.equal(deps.waitingView({ ...waiting, state: 'blocked' }).badge, 'Blocked');
});

test('WU14 the shared board filter: the Plan & bugs session appears for every caller except the earlier-kind exclusion', () => {
  const tasksById = byId([
    session('plan', { planningPurpose: undefined, planningSessionNumber: 1 }),
    session('report', { planningPurpose: 'bug-report', planningSessionNumber: 2 }),
    session('combined', { planningSessionNumber: 3 }),
  ]);
  const ids = Object.keys(tasksById);
  const rows = (includeBugReports) => projectTasks.buildPlanningRows({ taskIds: ids, tasksById, showArchived: false, now: NOW, ...(includeBugReports ? { includeBugReports } : {}) }).map((row) => row.id).sort();
  assert.deepEqual(rows(false), ['combined', 'plan'], 'village yard and any caller that does not ask for bug reports: planning-type, so Plan & bugs is in');
  assert.deepEqual(rows(true), ['combined', 'plan', 'report']);
  const queue = projectTasks.buildPlanningQueue({ items: [], taskIds: ids, tasksById, now: NOW });
  assert.deepEqual(queue.map((entry) => entry.id).sort(), ['combined', 'plan', 'report'], 'the Planning queue');
  const archived = projectTasks.buildPlanningRows({ taskIds: ids, tasksById: byId(Object.values(tasksById).map((entry) => ({ ...entry, archived: true, planningCompletedAt: AT }))), showArchived: true, now: NOW, includeBugReports: true });
  assert.equal(archived.length, 3, 'the Archived panel');
  assert.equal(projectTasks.PLANNING_LIVE_DOT.running.length > 0, true);
});

// ---- The session panel ----

test('WU12 the session panel lists both kinds with tags, badges and Depends on chips; it is read-only', () => {
  const items = [
    task('t1', 1, { createdAt: at(1) }),
    bug('b1', { createdAt: at(2), dependsOn: ['t1'] }),
    task('t2', 2, { createdAt: at(3), status: 'developing', dependsOn: ['b1', 'gone'] }),
    item('other', { title: '8.001: Not ours', planningRef: { session: 8, task: 1 } }),
  ];
  const panel = buildPlanningTaskPanel({ items, tasksById: {}, sessionNumber: 7, createdTaskCount: 3, kind: 'plan-and-bugs' });
  assert.deepEqual(panel.rows.map((row) => [row.id, row.kindTag, row.badge.label, row.action, row.dependsOnChip]), [
    ['t1', 'Task', 'Ready', 'expand', undefined],
    ['b1', 'Bug', 'Ready', 'expand', '#7.001'.replace('#7.001', 'Depends on #7.001')],
    ['t2', 'Task', 'Running', 'open', 'Depends on #B.002, a deleted task'],
  ]);
  assert.equal(panel.rows[2].lockedLabel, 'Started – locked');
  assert.equal(panel.countsLabel, '1 task ready · 1 bug · 1 started');
  assert.deepEqual(sessionPanelWording('plan-and-bugs'), { heading: 'Session bugs and tasks', historyHeading: 'Plan & bugs history', emptyText: 'Bugs and tasks this session files will appear here.' });
  assert.equal(sessionPanelWording('planning').heading, 'Session tasks');
  assert.equal(sessionPanelWording('bug-report').historyHeading, 'Bug report history');
  assert.equal(buildPlanningTaskPanel({ items: [], tasksById: {}, sessionNumber: 7, createdTaskCount: 0, kind: 'plan-and-bugs' }).empty, true);
  assert.equal(panel.rows.some((row) => 'kindTag' in buildPlanningTaskPanel({ items, tasksById: {}, sessionNumber: 7, createdTaskCount: 3, kind: 'bug-report' }).rows[0]), false, 'the older kind has no tags');
});

// ---- Bugs in dependency chains ----

test('WU01 a bug is a parent exactly as a task is, in every state', () => {
  const states = [
    ['Ready', {}], ['In progress', { status: 'developing' }], ['Needs you', { status: 'blocked' }], ['Waiting to merge', { status: 'done' }],
    [null, { status: 'done', pullRequest: { state: 'merged' } }], [null, { archived: true }], [null, { status: 'failed' }], [null, { status: 'stopped' }],
    [null, { prConflict: {} }], [null, { testingSetup: { mode: 'x' } }],
  ];
  for (const [expected, patch] of states) {
    assert.equal(deps.parentState(bug('b', patch)), expected, JSON.stringify(patch));
    assert.equal(deps.parentState(item('t', patch)), expected, JSON.stringify(patch));
    assert.equal(deps.canBeParent(bug('b', patch)), expected !== null);
  }
});

test('WU02 the picker offers tasks and bugs together, tagged, and flags a cross-kind cycle', () => {
  const child = bug('child');
  const items = [child, task('t1', 1), bug('parent', { status: 'developing' }), task('t2', 2, { dependsOn: ['child'] }), bug('merged', { status: 'done', pullRequest: { state: 'merged' } })];
  const options = deps.pickerOptions(child, items);
  assert.deepEqual(options.map((option) => [option.id, option.kind, option.state, option.flag !== null]), [
    ['t1', 'Task', 'Ready', false],
    ['t2', 'Task', 'Ready', true],
    ['parent', 'Bug', 'In progress', false],
  ]);
  assert.deepEqual(deps.linkCandidates(child, items).map((option) => option.id), ['t1', 'parent'], 'the cycle-maker is not a candidate');
});

test('WU03 WU04 a bug\'s Depends on section is editable, read-only, hidden or unavailable; labels name bugs by number', () => {
  const child = bug('child', { dependsOn: ['t1'] });
  const items = [child, task('t1', 1)];
  assert.equal(deps.dependsOnSection(child, items, REPO).mode, 'editable');
  assert.equal(deps.dependsOnSection({ ...child, status: 'developing' }, items, REPO).mode, 'readonly');
  assert.equal(deps.dependsOnSection(bug('lonely', { status: 'developing' }), items, REPO).mode, 'hidden');
  assert.equal(deps.dependsOnSection(child, items, null).mode, 'unavailable');
  assert.equal(deps.dependencyLabel({ title: 'B.004: Crash' }), '#B.004');
  assert.equal(deps.dependencyLabel({ title: '12.003.001: Crash' }), '#12.003.001');
  assert.equal(deps.dependencyLabel({ title: 'Plain title' }), 'Plain title');
  assert.equal(deps.dependsOnSection(child, [child], REPO).parents[0].label, 'Deleted task');
});

test('WU05 dragging links bug to task, task to bug and bug to bug; not for no repository, a started child, a cycle or an existing link', () => {
  const t = task('t1', 1);
  const b1 = bug('b1');
  const b2 = bug('b2');
  const items = [t, b1, b2];
  assert.deepEqual(deps.planLinkDrop('t1', 'b1', items, REPO), { itemId: 'b1', dependsOn: ['t1'] });
  assert.deepEqual(deps.planLinkDrop('b1', 't1', items, REPO), { itemId: 't1', dependsOn: ['b1'] });
  assert.deepEqual(deps.planLinkDrop('b1', 'b2', items, REPO), { itemId: 'b2', dependsOn: ['b1'] });
  assert.equal(deps.planLinkDrop('t1', 'b1', items, null), null);
  assert.equal(deps.planLinkDrop('t1', 'b1', [t, bug('b1', { status: 'developing' })], REPO), null, 'a started child');
  assert.equal(deps.planLinkDrop('b2', 'b1', [t, b1, bug('b2', { dependsOn: ['b1'] })], REPO), null, 'a cycle');
  assert.equal(deps.planLinkDrop('t1', 'b1', [t, bug('b1', { dependsOn: ['t1'] })], REPO), null, 'already linked');
});

test('WU06 WU07 WU08 forests, chips and the start confirmation treat bug parents like task parents', () => {
  const rows = [{ id: 'b', dependsOn: ['t'] }, { id: 't' }, { id: 'c', dependsOn: ['b'] }];
  const forest = deps.dependencyForest(rows);
  assert.deepEqual(forest.map((node) => [node.row.id, node.children.map((child) => [child.row.id, child.children.map((grand) => grand.row.id)])]), [['t', [['b', ['c']]]]]);
  assert.doesNotThrow(() => deps.dependencyForest([{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }]));
  assert.equal(deps.dependencyChip(['#B.001']), 'Depends on #B.001');
  assert.equal(deps.dependencyChip(['#B.001', '#7.002']), 'Depends on #B.001, #7.002');
  assert.equal(deps.dependencyChip([]), null);
  assert.equal(deps.START_WHEN_MERGED_LABEL, 'Start when parents are merged');
  const confirm = deps.startConfirm([
    { id: 'b', label: '#B.001', title: 'Crash', satisfied: false, reason: { text: 'Waiting for #B.001 to finish', blocked: false } },
    { id: 't', label: '#7.001', title: 'Task', satisfied: true, reason: null },
  ]);
  assert.deepEqual(confirm.map((entry) => entry.id), ['b'], 'only the unsatisfied parent is listed');
});

// ---- Source pins (no DOM harness) ----

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('WC01 WC10 the Planning header has Plan & bugs and Task only; no leftovers of the removed buttons', async () => {
  const panel = await source('../src/ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /Plan &amp; bugs<\/span><\/Button>/);
  assert.doesNotMatch(panel, /> Plan<\/Button>|Report bug|PlanningPromptDialog|BugReportPromptDialog/);
  assert.match(panel, />Task<\/span><\/Button>/);
  assert.match(panel, /Chain tasks|kind: 'chain'/, 'Chain tasks stays for planning groups');
  for (const gone of ['ui/project-popup/PlanningPrompt.tsx', 'ui/project-popup/BugReportPrompt.tsx', 'lib/planningDraft.ts', 'lib/bugReportDraft.ts']) {
    await assert.rejects(source(`../src/${gone}`), /ENOENT/, gone);
  }
  const store = await source('../src/store/worldStore.ts');
  assert.doesNotMatch(store, /startBugReportSession|sendChatMessage/);
});

test('WC02 the start dialog sends with an agent and creates the session with none', async () => {
  const prompt = await source('../src/ui/project-popup/PlanAndBugsPrompt.tsx');
  assert.match(prompt, /const dialog = reportDialogState\(executorId !== ''\);/);
  assert.match(prompt, /dialog\.notice && <p role="status"/);
  assert.match(prompt, /sendLabel=\{dialog\.sendLabel\}/);
  assert.deepEqual(bugs.reportDialogState(true), { sendLabel: 'Send', notice: null });
  const none = bugs.reportDialogState(false);
  assert.equal(none.sendLabel, 'Create session');
  assert.match(none.notice, /No coding agent is available right now/);
});

test('WC03 WC08 the session panel shows tags and Depends on chips', async () => {
  const panel = await source('../src/ui/project-popup/PlanningTaskPanel.tsx');
  assert.match(panel, /row\.kindTag && <Badge variant="outline"/);
  assert.match(panel, /row\.dependsOnChip && /);
  assert.doesNotMatch(panel, /TaskEditForm|Delete|Edit/, 'read-only for the person');
});

test('WC04 WC05 WC06 the pickers tag tasks and bugs, and a bug card uses the same dependency chip and drag-link as a task', async () => {
  for (const file of ['DependsOnPicker', 'DependenciesControl']) {
    assert.match(await source(`../src/ui/project-popup/${file}.tsx`), /<KindTag kind=\{option\.kind\} \/>/, file);
  }
  const board = await source('../src/ui/project-popup/TaskBoard.tsx');
  assert.match(board, /dependencyChip\(dependsOnLabels\)/);
  assert.match(board, /dependsOnPicker=\{row\.canEdit && !row\.archived \? <DependsOnPicker/);
  const panel = await source('../src/ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /canLink: \(parentId, childId\) => planLinkDrop\(parentId, childId, items, project\.repositoryUrl\) !== null/);
  assert.match(panel, /dnd=\{dnd\.cardDnd\('planning', nestedPlanningCards\.find/, 'nested bugs are drag targets');
  const header = await source('../src/ui/project-popup/DetailHeader.tsx');
  assert.match(header, /\{item && <div[^>]*><DependsOnSection item=\{item\} \/><\/div>\}/, 'every item, bugs included');
});

test('WC11 the docs describe the Plan & bugs session, its dependency tool and bugs in dependency chains', async () => {
  const board = await source('../../docs/unified-planning-board.md');
  const dependent = await source('../../docs/dependent-tasks.md');
  const blueprint = await source('../../.docs/blueprint.md');
  for (const doc of [board, blueprint]) {
    assert.match(doc, /Plan & bugs/);
    assert.match(doc, /set_dependencies/);
  }
  assert.match(board, /merge them into ONE task|one task|merge/i);
  assert.match(dependent, /bug/i);
  assert.match(dependent, /Plan & bugs/);
});
