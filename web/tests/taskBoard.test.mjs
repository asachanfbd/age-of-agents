import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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
const { BOARD_COLUMNS, canCollapse, canDragFrom, canDropOn, canOpenCard, cardDetail, cardFooterStartedLabel, cardProgressLine, cardStartedLabel, completedCardActions, findCard, isCardClick, openCardActions, planBoardDrop, runControl, runTimingParts, stepCardElapsedMs, stepCardProgress, taskItemInfo } = await import('../src/lib/taskBoard.ts');
const { buildCompletedRows, buildPlanningQueue, comparePlanningGroupOrder, planningTaskHistory } = await import('../src/lib/projectTasks.ts');
const { formatTimestamp } = await import('../src/lib/sessionTiming.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { buildOpenTaskRows } = await import('../src/lib/projectTasks.ts');

// The Tasks tab's kanban board. Behaviour (which column, what a card's menu offers, its footer, what a
// drop asks for) is tested against the pure helpers in lib/taskBoard.ts; the wiring in the components
// is pinned against their source, as the other web tests do.
const read = (file) => readFile(new URL(`../src/ui/project-popup/${file}`, import.meta.url), 'utf8');
const [panel, board, dnd, itemDetails, header, runView, editForm, sessionView, taskActions, cardDetailHook] = await Promise.all(
  ['TasksPanel.tsx', 'TaskBoard.tsx', 'useBoardDnd.ts', 'TaskItemDetailsView.tsx', 'DetailHeader.tsx', 'WorkflowRunView.tsx', 'TaskEditForm.tsx', 'TaskDetailsView.tsx', 'useTaskActions.ts', 'useCardDetail.ts'].map(read),
);
const floating = await read('FloatingControls.tsx');
const listParts = await read('TaskListParts.tsx');
const copyButton = await readFile(new URL('../src/ui/CopyButton.tsx', import.meta.url), 'utf8');
const projectPopupFiles = await readdir(new URL('../src/ui/project-popup/', import.meta.url));

const NOW = new Date('2026-09-21T12:00:00.000Z').getTime();
const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString();

const task = (id, patch = {}) => ({
  id, projectId: 'p1', executorId: 'exec-claude', executionMode: 'terminal', description: id, status: 'done', kind: 'execute',
  planItemId: null, sessionId: 'sess', blockedQuestion: null, failureReason: null,
  tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
  createdAt: minutesAgo(60), updatedAt: minutesAgo(30), completedAt: minutesAgo(30), ...patch,
});
const item = (id, patch = {}) => ({
  id, projectId: 'p1', title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [],
  executorId: null, createdAt: minutesAgo(600), updatedAt: minutesAgo(600), ...patch,
});
const rows = (items, tasks = []) =>
  buildOpenTaskRows({ items, tasksById: Object.fromEntries(tasks.map((t) => [t.id, t])), showArchived: false, now: NOW });
const rowOf = (...args) => rows(...args)[0];

// ---- Columns ----

test('the board has four columns in order: Planning, Running, Needs you, Completed', () => {
  assert.deepEqual(BOARD_COLUMNS, ['planning', 'running', 'needsYou', 'done']);
  assert.match(panel, /planning: \{ label: 'Planning'[\s\S]*running: \{ label: 'Running'[\s\S]*needsYou: \{ label: 'Needs you'[\s\S]*done: \{ label: 'Completed'/);
});

test('an empty Planning column keeps valid div structure and both creation actions', () => {
  assert.match(panel, /<div className="space-y-2">\s*\{cards\.length > 0 \? cards : <EmptyState subtitle=\{COLUMNS\[column\]\.empty\} loading=\{loading\} \/>\}/);
  assert.match(listParts, /if \(loading\) return <div\b/);
  assert.match(listParts, /return \(\s*<div\b/);
  assert.doesNotMatch(listParts, /<li\b|FilterMenu|ListHeader|Nothing archived|Archived items appear here/);
  assert.match(panel, /<PlanAndBugsPromptDialog/);
  assert.match(panel, /<TaskPromptDialog/);
});

test('columns are filled from the existing grouping helpers, not re-derived', () => {
  assert.match(panel, /buildTaskGroups\(\{ items, tasksById, workflowRunsByProject, projectId: project\.id, showArchived: false, now: nowMs, queue \}\)/);
  assert.match(panel, /buildCompletedRows\(\{ items, taskIds: ids, tasksById, workflowRuns: runsForProject, now: nowMs \}\)/);
  assert.match(panel, /const boardRunning = useMemo\(\(\) => \[\.\.\.groups\.running, \.\.\.groups\.waiting\], \[groups\.running, groups\.waiting\]\);/);
  assert.match(panel, /const columns = \{ planning: planningCards, running: boardRunning, needsYou: groups\.needsYou, done: completedRows \};/);
  assert.match(panel, /count=\{column === 'planning' \? planningQueue\.length : columns\[column\]\.length\}/);
});

test('the board has no heading, subheading, filter dropdowns or progress bar above the columns', () => {
  assert.doesNotMatch(panel, /ListHeader|FilterMenu|StepFilterMenu|stageFilter|showArchived\b(?!: false)|TaskProgressBar|TaskProgressLegend/);
  assert.doesNotMatch(panel, /Drag a Planning task into Running to start it; click a card to open it\./);
  assert.match(panel, /<ActionAlerts error=\{actions\.error\}/);
});

test('swimlanes, priority and the step bar are gone from the board', () => {
  for (const file of ['Swimlanes.tsx', 'priorityStyles.ts', 'StepBar.tsx']) assert.ok(!projectPopupFiles.includes(file), `${file} is deleted`);
  assert.doesNotMatch(panel + board, /Swimlane|priority|Priority|StepBar/);
});

test('the sidebar is gone: no section nav, bulk selection or progress card aside', () => {
  assert.doesNotMatch(panel, /<aside|aria-label="Task groups"|chooseSection|BulkMenu|<Checkbox|Select all/);
  assert.match(panel, /<BoardColumnView/);
});

test('planning-created ready tasks nest once in creation order and released tasks become standalone', () => {
  const planning = task('plan', { kind: 'plan', status: 'stopped', planningSessionNumber: 4, planningQueueOrder: 5 });
  const old = item('old', { planningRef: { session: 4, task: 1 }, planningTaskId: planning.id });
  const newest = item('newest', { planningRef: { session: 4, task: 2 }, planningTaskId: planning.id });
  const manual = item('manual', { planningQueueOrder: 2 });
  const active = buildPlanningQueue({ items: [newest, manual, old], taskIds: [planning.id], tasksById: { [planning.id]: planning }, now: NOW });
  assert.deepEqual(active.map((entry) => [entry.kind, entry.id]), [['task', 'manual'], ['session', planning.id]]);
  assert.deepEqual(active[1].session.ready.map((row) => row.id), ['old', 'newest']);

  const released = buildPlanningQueue({ items: [old], taskIds: [planning.id], tasksById: { [planning.id]: { ...planning, archived: true, planningCompletedAt: minutesAgo(1) } }, now: NOW });
  assert.deepEqual(released.map((entry) => [entry.kind, entry.id]), [['task', 'old']]);
});

test('planning groups have a non-color type cue, dedicated handle, count expander and history', () => {
  assert.match(board, /typeLabel=\{sessionTypeLabel\(row\.kind\)\}/);
  assert.match(board, /aria-label=\{`Reorder \$\{typeLabel === 'Planning' \|\| !typeLabel \? 'planning session'/);
  assert.match(board, /aria-expanded=\{expanded\}/);
  assert.match(board, /conversationExpanderLabel\(row\.ready\.length, nestedBugCount\(row\.references\)\)/);
  assert.match(board, /startedCount[\s\S]*completedCount[\s\S]*archivedCount[\s\S]*removedCount/);
  assert.match(board, /useState\(row\.live !== 'idle'\)/, 'live and input-blocked groups start expanded; idle starts collapsed');
  assert.match(panel, /key=\{`\$\{entry\.id\}-\$\{entry\.session\.live\}`\}/, 'a live-state transition remounts the group with the required default');
});

test('planning history accounts for linked tasks that were archived or deleted', () => {
  const planning = task('plan-history', {
    kind: 'plan', status: 'stopped', planningSessionNumber: 7, planningCreatedTaskCount: 4,
  });
  const ready = item('ready', { planningRef: { session: 7, task: 1 }, planningTaskId: planning.id });
  const started = item('started', { status: 'running', planningRef: { session: 7, task: 2 }, planningTaskId: planning.id });
  const archived = item('archived', { archived: true, planningRef: { session: 7, task: 3 }, planningTaskId: planning.id });
  const queue = buildPlanningQueue({ items: [ready, started, archived], taskIds: [planning.id], tasksById: { [planning.id]: planning }, now: NOW });
  assert.equal(queue.length, 2, 'a legacy started item without a WorkflowRun remains visible in Planning');
  const group = queue.find((entry) => entry.kind === 'session');
  assert.ok(group);
  assert.deepEqual({
    ready: group.session.ready.length,
    started: group.session.startedCount,
    completed: group.session.completedCount,
    archived: group.session.archivedCount,
    removed: group.session.removedCount,
  }, { ready: 1, started: 1, completed: 0, archived: 1, removed: 1 });
});

test('released children use persisted queue slots, independent of their completed parent', () => {
  const plan = task('release-plan', { kind: 'plan', status: 'stopped', archived: true, planningCompletedAt: minutesAgo(1), planningSessionNumber: 8, planningCreatedTaskCount: 2, planningQueueOrder: 3 });
  const second = item('second', { planningRef: { session: 8, task: 2 }, planningQueueOrder: 3.6 });
  const first = item('first', { planningRef: { session: 8, task: 1 }, planningQueueOrder: 3.3 });
  const later = item('later', { planningQueueOrder: 4 });
  const queue = buildPlanningQueue({ items: [later, second, first], taskIds: [plan.id], tasksById: { [plan.id]: plan }, now: NOW });
  assert.deepEqual(queue.map((entry) => entry.id), ['first', 'second', 'later']);
  const afterDelete = buildPlanningQueue({ items: [later, second, first], taskIds: [], tasksById: {}, now: NOW });
  assert.deepEqual(afterDelete.map((entry) => entry.id), ['first', 'second', 'later']);
  assert.deepEqual(planningTaskHistory([first, second], 8, 2).ready.map((linked) => linked.id), ['first', 'second']);
});

test('a group shows its saved custom order, with unpositioned and later tasks after it, oldest first', () => {
  const planning = task('custom-plan', { kind: 'plan', status: 'stopped', planningSessionNumber: 9, planningQueueOrder: 5 });
  const one = item('one', { title: '9.001: One', planningRef: { session: 9, task: 1 }, planningGroupOrder: 2 });
  const two = item('two', { title: '9.002: Two', planningRef: { session: 9, task: 2 }, planningGroupOrder: 0 });
  const three = item('three', { title: '9.003: Three', planningRef: { session: 9, task: 3 }, planningGroupOrder: 1 });
  const five = item('five', { title: '9.005: Five', planningRef: { session: 9, task: 5 } });
  const four = item('four', { title: '9.004: Four', planningRef: { session: 9, task: 4 } });
  const queue = buildPlanningQueue({ items: [one, five, two, four, three], taskIds: [planning.id], tasksById: { [planning.id]: planning }, now: NOW });
  assert.deepEqual(queue[0].session.ready.map((row) => row.id), ['two', 'three', 'one', 'four', 'five']);
  assert.deepEqual(queue[0].session.ready.map((row) => row.title), ['9.002: Two', '9.003: Three', '9.001: One', '9.004: Four', '9.005: Five'], 'numbers and titles are unchanged');
  assert.deepEqual([one, two].sort(comparePlanningGroupOrder).map((linked) => linked.id), ['two', 'one']);
  assert.equal(comparePlanningGroupOrder(four, four), 0);
});

test('completion releases a group in its custom order and restoration regroups it the same way', () => {
  const plan = task('custom-release', { kind: 'plan', status: 'stopped', planningSessionNumber: 12, planningCreatedTaskCount: 3, planningQueueOrder: 3 });
  const first = item('first', { planningRef: { session: 12, task: 1 }, planningGroupOrder: 1 });
  const second = item('second', { planningRef: { session: 12, task: 2 }, planningGroupOrder: 0 });
  const third = item('third', { planningRef: { session: 12, task: 3 } });
  const later = item('later', { planningQueueOrder: 4 });
  const earlier = item('earlier', { planningQueueOrder: 2 });
  const items = [first, third, later, second, earlier];
  const completed = { ...plan, archived: true, planningCompletedAt: minutesAgo(1) };
  const released = buildPlanningQueue({ items, taskIds: [plan.id], tasksById: { [plan.id]: completed }, now: NOW });
  assert.deepEqual(released.map((entry) => entry.id), ['earlier', 'second', 'first', 'third', 'later'], 'unsaved released slots follow the custom order inside the former group slot');

  const restored = buildPlanningQueue({ items, taskIds: [plan.id], tasksById: { [plan.id]: plan }, now: NOW });
  assert.deepEqual(restored.map((entry) => entry.id), ['earlier', plan.id, 'later']);
  assert.deepEqual(restored[1].session.ready.map((row) => row.id), ['second', 'first', 'third'], 'saved positions first, then unpositioned tasks oldest first');

  const startedMeanwhile = buildPlanningQueue({ items: [{ ...second, status: 'running' }, first, third], taskIds: [plan.id], tasksById: { [plan.id]: plan }, now: NOW });
  assert.deepEqual(startedMeanwhile.find((entry) => entry.kind === 'session').session.ready.map((row) => row.id), ['first', 'third'], 'a started task has left the group');
});

test('legacy stopped and failed items stay visible in Planning with their existing status', () => {
  const stopped = item('stopped', { status: 'stopped' });
  const failed = item('failed', { status: 'failed' });
  const groups = buildTaskGroups({ items: [stopped, failed], tasksById: {}, workflowRunsByProject: {}, projectId: 'p1', showArchived: false, now: NOW });
  const queue = buildPlanningQueue({ items: [stopped, failed], taskIds: [], tasksById: {}, now: NOW, openRows: groups.open });
  assert.deepEqual(queue.map((entry) => entry.task.state).sort(), ['failed', 'stopped']);
  assert.match(panel, /openRows: groups\.open/);
});

test('planning detail shows linked ready and history counts, including archived sessions', () => {
  assert.match(sessionView, /planning && !showTaskPanel && <PlanningHistory task=\{task\}/);
  assert.match(sessionView, /aria-label=\{heading\}/);
  assert.match(sessionView, /sessionHistoryView\(\{ items: items \?\? \[\]/);
  assert.match(sessionView, /const \{ history, countsLabel: counts \} = sessionHistoryView/);
  assert.match(sessionView, /history\.ready\.map/);
});

// ---- Card content ----

test('card footer: "Started …" relative to now once a task has run, "Not started" before', () => {
  assert.equal(cardStartedLabel({ startedAt: minutesAgo(5) }, new Date(NOW)), 'Started 5m ago');
  assert.equal(cardStartedLabel({ startedAt: minutesAgo(180) }, new Date(NOW)), 'Started 3h ago');
  assert.equal(cardStartedLabel(null, new Date(NOW)), 'Not started');
});

test('card footer: a waiting task that has not run reads "Waiting", otherwise the usual started label', () => {
  const now = new Date(NOW);
  assert.equal(cardFooterStartedLabel({ metrics: null, waiting: {} }, now), 'Waiting');
  assert.equal(cardFooterStartedLabel({ metrics: null }, now), 'Not started');
  assert.equal(cardFooterStartedLabel({ metrics: { startedAt: minutesAgo(5) }, waiting: {} }, now), 'Started 5m ago');
});

test('a card shows the title, then a footer with the coding agent and its start time — nothing in between', () => {
  assert.doesNotMatch(board, /body/);
  assert.match(board, /<p className="[^"]*font-medium[^"]*" title=\{title\}>\{title\}<\/p>/);
  assert.match(board, /<Bot [^>]*\/>\s*<span className="truncate">\{agent\}<\/span>[\s\S]*<span className="shrink-0">\{started\}<\/span>/);
  assert.match(board, /started=\{cardFooterStartedLabel\(row, now\)\}/);
  assert.match(panel, /agent=\{label\(row\.workerId\)\}/, 'the agent is the executor label');
});

test('a card with no agent (not started yet) shows the footer with only its start time, no Bot icon', () => {
  assert.match(board, /agent: string \| null;/, 'TaskCard takes a nullable agent');
  assert.match(board, /\{agent && \(\s*<>\s*<Bot [^>]*\/>\s*<span className="truncate">\{agent\}<\/span>\s*<span aria-hidden="true">·<\/span>\s*<\/>\s*\)\}\s*<span className="shrink-0">\{started\}<\/span>/, 'the Bot icon and label are skipped entirely when there is no agent');
});

test('not-started Planning-column cards pass no agent; started columns (Running, Needs you, Completed) and planning sessions still pass the executor label', () => {
  assert.match(panel, /<OpenTaskCard key=\{row\.id\} row=\{row\} agent=\{label\(row\.workerId\)\}/, 'Running/Needs you rows keep their agent label');
  assert.match(panel, /<CompletedTaskCard[\s\S]{0,80}agent=\{label\(row\.workerId\)\}/, 'Completed rows keep their agent label');
  assert.match(panel, /<PlanningSessionCard[^>]*agent=\{entry\.session\.cliNotStarted \? null : label\(entry\.session\.workerId\)\}/, 'a planning session (already running) keeps its own agent label; one with no CLI yet shows none');
  assert.match(panel, /<OpenTaskCard key=\{entry\.id\} row=\{entry\.task\} agent=\{null\}/, 'a not-started top-level Planning task shows no agent');
  assert.match(panel, /function nestedCard\(row: OpenTaskRow\) \{\s*return <OpenTaskCard key=\{row\.id\} row=\{row\} agent=\{null\}/, 'a not-started task or bug nested under a group shows no agent too');
  assert.match(panel, /renderTask=\{nestedCard\}/);
});

test('cards have no hover effect — no hover background, shadow, lift or transition', () => {
  const card = board.match(/export function TaskCard[\s\S]*?\n}\n/)[0];
  const cardClass = card.match(/<article[\s\S]*?className=\{`([^`]*)`\}/)[1];
  assert.doesNotMatch(cardClass, /hover:|shadow|translate|transition/);
  const openArea = card.match(/role="button"[\s\S]*?className="([^"]*)"/)[1];
  assert.doesNotMatch(openArea, /hover:|shadow|translate|transition/);
});

test('board cards have no three-dot action menu', () => {
  assert.doesNotMatch(board, /DropdownMenu|EllipsisVertical|CardMenu|Actions for/);
  assert.match(board, /role="button"[\s\S]*onOpen\(\)/);
});

// ---- Menu options per state ----

test('a new, never-started task offers start, edit, duplicate, complete, archive and delete', () => {
  assert.deepEqual(openCardActions(rowOf([item('a')])), ['start', 'edit', 'duplicate', 'complete', 'archive', 'delete']);
});

test('a paused terminal task offers open and resume, but not edit', () => {
  const row = rowOf([item('p', { status: 'stopped', taskIds: ['t'] })], [task('t', { status: 'stopped', sessionId: 'sess-p' })]);
  assert.deepEqual(openCardActions(row), ['open', 'resume', 'duplicate', 'complete', 'archive', 'delete']);
});

test('a running task offers open, pause, duplicate and an interim commit', () => {
  const row = rowOf([item('r', { status: 'developing', taskIds: ['t'] })], [task('t', { status: 'developing', completedAt: null, branch: 'feat/x' })]);
  assert.deepEqual(openCardActions(row), ['open', 'pause', 'duplicate', 'interimCommit']);
});

test('a blocked task in Needs you can be opened but has no play/pause control', () => {
  const row = rowOf([item('b', { status: 'blocked', taskIds: ['t'] })], [task('t', { status: 'blocked', completedAt: null })]);
  const actions = openCardActions(row);
  assert.equal(actions[0], 'open');
  assert.ok(!actions.some((action) => ['start', 'resume', 'pause'].includes(action)));
});

test('a card with a workflow run opens even before its Task is loaded', () => {
  assert.equal(canOpenCard({ workflowRunId: 'run-1', canOpenSession: false }), true);
  assert.equal(canOpenCard({ workflowRunId: null, canOpenSession: false }), false);
});

test('completed cards offer open (with a session), and archive and delete (for a plan item) only', () => {
  assert.deepEqual(completedCardActions({ canOpenSession: true, latestTaskId: 't', canArchive: true, canDelete: true }), ['open', 'archive', 'delete']);
  assert.deepEqual(completedCardActions({ canOpenSession: true, latestTaskId: 't', canUnarchive: true, canDelete: true }), ['open', 'unarchive', 'delete'], 'an Archived-tab card');
  assert.deepEqual(completedCardActions({ canOpenSession: true, latestTaskId: 't', canArchive: false, canDelete: false }), ['open']);
  assert.deepEqual(completedCardActions({ canOpenSession: false, latestTaskId: null, canArchive: true, canDelete: true }), ['archive', 'delete']);
  assert.deepEqual(completedCardActions({ canOpenSession: false, latestTaskId: null, canArchive: false, canDelete: false }), []);
  const completed = buildCompletedRows({ items: [item('d', { status: 'done' })], taskIds: ['t'], tasksById: { t: task('t') }, now: NOW });
  const doneItem = completed.find((row) => row.kind === 'item');
  const freeform = completed.find((row) => row.kind === 'task');
  assert.deepEqual(completedCardActions(doneItem), ['archive', 'delete']);
  assert.deepEqual(completedCardActions(freeform), ['open'], 'a Task with no plan item has nothing to archive');
});

test('task actions formerly on cards are exposed from details', () => {
  for (const label of ['Duplicate', 'Interim commit']) assert.match(header, new RegExp(label));
  assert.match(header, /Start task/);
  assert.match(header, /Stop|Resume/);
  assert.match(header, /Mark complete/);
  assert.match(header, /Archive|Unarchive/);
  assert.match(header, /Delete/);
});

test('there is no Assign worker action anywhere — the coding agent is chosen only in the Start task dialog', async () => {
  const dialogsSource = await readFile(new URL('../src/ui/project-popup/TaskDialogs.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(header, /Assign worker/i);
  assert.doesNotMatch(panel, /Assign worker|kind: 'assign'/i);
  assert.doesNotMatch(board, /onAssign/);
  assert.doesNotMatch(dialogsSource, /AssignWorkerDialog/);
});

test('the details header acts through the shared useTaskActions handlers', () => {
  assert.match(taskActions, /if \(row\.workflowRunId\) return storeCall\('workflowRun', \(\) => stopWorkflowRun\(row\.workflowRunId!\)\);/, 'a run card\'s Stop stops its run');
  assert.match(taskActions, /if \(row\.workflowRunId\) return storeCall\('workflowRun', \(\) => resumeWorkflowRun\(row\.workflowRunId!\)\);/, 'a stopped run card resumes its run');
  assert.match(taskActions, /stopRun: \(runId: string\) => guard\(\(\) => storeCall\('workflowRun', \(\) => stopWorkflowRun\(runId\)\)\),/);
  assert.match(taskActions, /resumeRun: \(runId: string\) => guard\(\(\) => storeCall\('workflowRun', \(\) => resumeWorkflowRun\(runId\)\)\),/);
  assert.match(taskActions, /archive: \(id: string\) => guard\(\(\) => storeCall\('taskActions', \(\) => updatePlanItem\(project\.id, id, \{ archived: true \}\)\)\),/, 'archive patches the plan item, not its Task');
  assert.match(taskActions, /if \(!\(await call\(\)\)\) throw new Error\(useWorldStore\.getState\(\)\.formErrors\[scope\]/, 'a refused store call (e.g. 409) becomes the alert, read from its own scope');
  assert.match(header, /actions\.(?:stopRun|resumeRun|archive|complete|deleteItems)/);
});

// ---- + trigger ----

test('the + in the Planning column header opens the existing TaskPromptDialog', () => {
  assert.match(panel, /if \(column === 'planning'\)[\s\S]*kind: 'plan-and-bugs'[\s\S]*Plan &amp; bugs<\/span><\/Button>[\s\S]*kind: 'add'[\s\S]*>Task<\/span><\/Button>/);
  assert.match(panel, /actions=\{columnActions\(column\)\}/);
  assert.match(panel, /\{dialog\?\.kind === 'add' && <TaskPromptDialog project=\{project\} onClose=\{\(\) => setDialog\(null\)\} \/>\}/);
});

// ---- Drag and drop ----

/** The board's columns as drag-and-drop sees them. */
const board4 = ({ planningIds = [], running = [], needsYou = [], done = [] } = {}) => ({
  planning: planningIds.map((id) => ({ id, primary: 'start' })),
  running: running.map((id) => ({ id, primary: 'pause' })),
  needsYou: needsYou.map((id) => ({ id, primary: 'none' })),
  done,
});

test('planBoardDrop reorders within Planning, Running and Needs you, discounting the dragged card\'s own slot', () => {
  const columns = board4({ planningIds: ['a', 'b', 'c'], running: ['r1', 'r2'], needsYou: ['n1', 'n2'] });
  assert.deepEqual(planBoardDrop(columns, 'c', { column: 'planning', index: 0 }), { kind: 'reorder', ids: ['c', 'a', 'b'] });
  assert.deepEqual(planBoardDrop(columns, 'a', { column: 'planning', index: 3 }), { kind: 'reorder', ids: ['b', 'c', 'a'] }, 'to the bottom');
  assert.deepEqual(planBoardDrop(columns, 'a', { column: 'planning', index: 2 }), { kind: 'reorder', ids: ['b', 'a', 'c'] });
  assert.deepEqual(planBoardDrop(columns, 'r2', { column: 'running', index: 0 }), { kind: 'reorder', ids: ['r2', 'r1'] });
  assert.deepEqual(planBoardDrop(columns, 'n2', { column: 'needsYou', index: 0 }), { kind: 'reorder', ids: ['n2', 'n1'] });
});

test('planBoardDrop is a no-op for a drop back onto the card\'s own place', () => {
  const columns = board4({ planningIds: ['a', 'b', 'c'] });
  assert.equal(planBoardDrop(columns, 'b', { column: 'planning', index: 1 }), null, 'just above itself');
  assert.equal(planBoardDrop(columns, 'b', { column: 'planning', index: 2 }), null, 'just below itself');
});

test('Completed is ordered by completion time: its cards can\'t be dragged or reordered, and nothing drops into it', () => {
  const columns = board4({ planningIds: ['a'], running: ['r1'], needsYou: ['n1'], done: [{ id: 'd1', kind: 'item' }, { id: 't1', kind: 'task' }, { id: 'd2', kind: 'item' }] });
  assert.equal(canDragFrom('done'), false);
  for (const column of ['planning', 'running', 'needsYou']) assert.equal(canDragFrom(column), true, column);
  for (const [id, index] of [['d2', 0], ['d1', 3], ['t1', 0]]) {
    assert.equal(canDropOn(columns, id, 'done'), false, `${id} within Completed`);
    assert.equal(planBoardDrop(columns, id, { column: 'done', index }), null, `${id} within Completed`);
  }
  for (const id of ['a', 'r1', 'n1']) assert.equal(planBoardDrop(columns, id, { column: 'done', index: 0 }), null, `${id} into Completed`);
  for (const column of ['planning', 'running', 'needsYou']) assert.equal(planBoardDrop(columns, 'd1', { column, index: 0 }), null, `out of Completed into ${column}`);
});

test('canCollapse (task 5.018): only Completed can collapse to a strip', () => {
  assert.equal(canCollapse('done'), true);
  for (const column of ['planning', 'running', 'needsYou']) assert.equal(canCollapse(column), false, column);
});

test('regression: a Planning card dropped on Running asks to start it (the start dialog), wherever it lands', () => {
  const columns = board4({ planningIds: ['a', 'b'], running: ['r1'] });
  for (const index of [0, 1, 5]) {
    const drop = planBoardDrop(columns, 'b', { column: 'running', index });
    assert.equal(drop.kind, 'start');
    assert.equal(drop.card.id, 'b');
  }
  assert.equal(planBoardDrop(board4({ planningIds: ['a'] }), 'a', { column: 'running', index: 0 }).kind, 'start', 'into an empty Running column');
});

test('only Planning → Running moves between columns; other moves, unstartable cards and unknown ids are refused', () => {
  const columns = board4({ planningIds: ['a'], running: ['r1'], needsYou: ['n1'], done: [{ id: 'd1', kind: 'item' }] });
  columns.planning.push({ id: 'paused', primary: 'resume' });
  assert.equal(canDropOn(columns, 'a', 'running'), true);
  assert.equal(canDropOn(columns, 'paused', 'running'), false, 'a paused card resumes from its menu instead');
  assert.equal(canDropOn(columns, 'paused', 'planning'), true, 'but can still be reordered');
  for (const [id, column] of [['a', 'needsYou'], ['a', 'done'], ['r1', 'planning'], ['r1', 'done'], ['n1', 'running'], ['d1', 'planning'], ['nope', 'planning']]) {
    assert.equal(canDropOn(columns, id, column), false, `${id} → ${column}`);
    assert.equal(planBoardDrop(columns, id, { column, index: 0 }), null, `${id} → ${column}`);
  }
});

/** Planning with top-level cards and two groups' nested tasks, as `TasksPanel` builds it. */
const groupedPlanning = () => [
  { id: 'solo', primary: 'start' }, { id: 'g1' }, { id: 'g2' },
  ...['a1', 'a2', 'a3'].map((id) => ({ id, primary: 'start', group: 'g1' })),
  { id: 'b1', primary: 'start', group: 'g2' },
];

test('a nested task reorders only among its own group\'s tasks', () => {
  const columns = { ...board4({ running: ['r1'] }), planning: groupedPlanning() };
  assert.deepEqual(planBoardDrop(columns, 'a3', { column: 'planning', group: 'g1', index: 0 }), { kind: 'reorderGroup', group: 'g1', ids: ['a3', 'a1', 'a2'] });
  assert.deepEqual(planBoardDrop(columns, 'a1', { column: 'planning', group: 'g1', index: 3 }), { kind: 'reorderGroup', group: 'g1', ids: ['a2', 'a3', 'a1'] }, 'to the bottom of its group');
  assert.deepEqual(planBoardDrop(columns, 'a1', { column: 'planning', group: 'g1', index: 2 }), { kind: 'reorderGroup', group: 'g1', ids: ['a2', 'a1', 'a3'] });
  assert.equal(planBoardDrop(columns, 'a2', { column: 'planning', group: 'g1', index: 1 }), null, 'back onto its own place');
  assert.equal(canDropOn(columns, 'a1', 'planning', 'g1'), true);
});

test('a nested task dropped at the top level or in another group is cancelled', () => {
  const columns = { ...board4({ running: ['r1'] }), planning: groupedPlanning() };
  for (const index of [0, 1, 3]) assert.equal(planBoardDrop(columns, 'a1', { column: 'planning', index }), null, `top level at ${index}`);
  assert.equal(planBoardDrop(columns, 'a1', { column: 'planning', group: 'g2', index: 0 }), null, 'another group');
  assert.equal(canDropOn(columns, 'a1', 'planning'), false);
  assert.equal(canDropOn(columns, 'a1', 'planning', 'g2'), false);
  assert.equal(planBoardDrop(columns, 'b1', { column: 'planning', group: 'g1', index: 0 }), null, 'the other group\'s task can\'t join it either');
});

test('top-level cards never land inside a group, and reorder among top-level cards only', () => {
  const columns = { ...board4({ running: ['r1'] }), planning: groupedPlanning() };
  assert.equal(planBoardDrop(columns, 'solo', { column: 'planning', group: 'g1', index: 0 }), null);
  assert.equal(canDropOn(columns, 'g2', 'planning', 'g1'), false);
  assert.deepEqual(planBoardDrop(columns, 'solo', { column: 'planning', index: 3 }), { kind: 'reorder', ids: ['g1', 'g2', 'solo'] }, 'nested tasks are not top-level slots');
});

test('regression: a nested task dropped on Running still asks to start it, and its group is unchanged until then', () => {
  const columns = { ...board4({ running: ['r1'] }), planning: groupedPlanning() };
  const drop = planBoardDrop(columns, 'a2', { column: 'running', index: 0 });
  assert.equal(drop.kind, 'start');
  assert.equal(drop.card.id, 'a2');
  assert.deepEqual(columns.planning.filter((card) => card.group === 'g1').map((card) => card.id), ['a1', 'a2', 'a3']);
  assert.match(panel, /else setDialog\(\{ kind: 'start', row: drop\.card as OpenTaskRow \}\)/, 'the start is only a dialog; nothing moves until the server accepts');
});

test('the group list is the nested drop zone and a group reorder is saved by the daemon', () => {
  assert.match(board, /<div data-group-list=\{row\.id\}/);
  assert.match(dnd, /closest<HTMLElement>\('\[data-group-list\]'\)/);
  assert.match(dnd, /cardsAbove\(list, ':scope > \[data-card\]', event\.clientY\)/);
  assert.match(panel, /entry\.session\.ready\.map\(\(row\) => \(\{ \.\.\.row, group: entry\.id \}\)\)/);
  assert.match(panel, /if \(drop\.kind === 'reorderGroup'\) \{\s*const introducerId = bugGroupIntroducerId\(drop\.group\);\s*const saved = introducerId \? reorderBugGroup\(project\.id, introducerId, drop\.ids\) : serverApi\.reorderPlanningGroup\(project\.id, drop\.group, drop\.ids\);\s*void saved\.catch\(\(error\) => actions\.reportError\(error\)\);/);
});

test('task cards drag from the card while planning sessions drag only from their handle', () => {
  const card = board.match(/export function TaskCard[\s\S]*?\n}\n/)[0];
  assert.match(card, /draggable=\{!dragHandle && dnd\?\.draggable\}/);
  assert.match(card, /<GripVertical aria-hidden="true" \/>/);
  assert.match(card, /aria-label=\{`Reorder \$\{typeLabel === 'Planning' \|\| !typeLabel \? 'planning session'/);
  assert.match(board, /dnd=\{dnd\}[\s\S]*export function CompletedTaskCard[\s\S]*dnd=\{dnd\}/, 'open and completed cards both pass it through');
  assert.match(panel, /<OpenTaskCard key=\{row\.id\}[^>]*dnd=\{dnd\.cardDnd\(column, row\)\}/);
  assert.match(panel, /<CompletedTaskCard[\s\S]*?dnd=\{dnd\.cardDnd\(column, row\)\}/);
  assert.match(dnd, /draggable: canDragCard\(column, card\)/, 'every card but a Completed one or a reference card');
  assert.match(dnd, /event\.dataTransfer\.setData\('text\/plain', card\.id\);\s*setDragged\(\{ id: card\.id, column, group: card\.group \}\);/);
});

test('regression: every column is a drop target that accepts on dragenter as well as dragover, and resolves the drop from where it lands', () => {
  assert.match(panel, /drop=\{dnd\.columnDrop\(column\)\}/, 'every column, not only Running');
  assert.match(board, /onDragEnter=\{drop\.onDragEnter\}\s*onDragOver=\{drop\.onDragOver\}\s*onDragLeave=\{drop\.onDragLeave\}\s*onDrop=\{drop\.onDrop\}/);
  assert.match(dnd, /onDragEnter: accept,\s*onDragOver: accept,/);
  assert.match(dnd, /const next = pointerTarget\(event, column, dragged\.group\);\s*if \(!canDropOn\(columns, dragged\.id, column, next\.group\)\) \{[\s\S]*?return;\s*\}\s*event\.preventDefault\(\);/);
  assert.match(dnd, /planBoardDrop\(columns, dragged\.id, pointerTarget\(event, column, dragged\.group\)\)/, 'not a stale dragover target');
});

// ---- Completed, collapsed to a strip (task 5.018) ----

test('Completed starts collapsed every time the board mounts — plain component state, never persisted', () => {
  assert.match(panel, /const \[completedCollapsed, setCompletedCollapsed\] = useState\(true\);/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage/, 'nothing remembers the collapsed state across popup opens or reloads');
});

test('only Completed ever renders as the collapsed strip — Planning, Running and Needs you always render their full column', () => {
  assert.match(panel, /canCollapse\(column\) && completedCollapsed \? \(\s*<CollapsedColumnStrip/);
  assert.match(panel, /\) : \(\s*<BoardColumnView/);
  const planningActions = panel.slice(panel.indexOf("if (column === 'planning')"), panel.indexOf("if (column === 'done')"));
  assert.doesNotMatch(planningActions, /ChevronsRight|CollapsedColumnStrip|setCompletedCollapsed/, 'no collapse/expand control outside Completed');
});

test('the collapsed strip shows the column\'s icon, name, count and attention dot, and is itself the one focusable expand control', () => {
  const strip = board.slice(board.indexOf('export function CollapsedColumnStrip'), board.indexOf('export function TaskCard'));
  assert.match(strip, /<button\s*ref=\{buttonRef\}/, 'a single <button>, not a wrapper with a nested button');
  assert.match(strip, /aria-label=\{`Expand \$\{label\}`\}/);
  assert.match(strip, /aria-expanded=\{false\}/);
  assert.match(strip, /<Icon className="size-4 text-muted-foreground" aria-hidden="true" \/>/);
  assert.match(strip, /<span className="text-xs font-semibold \[writing-mode:vertical-rl\]">\{label\}<\/span>/);
  assert.match(strip, /<span className="text-xs text-muted-foreground">\{count\}<\/span>/, 'always rendered, even when count is 0');
  assert.match(strip, /\{attention && \(/, 'the attention dot only when there is one — same as the full header');
  assert.match(strip, /attention === 'input' \? 'bg-warning' : 'bg-destructive'/, 'the same colors/labels the full header\'s dot uses');
  assert.equal((strip.match(/<button/g) ?? []).length, 1, 'exactly one button in the whole component');
});

test('the strip is wired with the same count and attention the full header would show for Completed, and expands on click', () => {
  assert.match(panel, /count=\{columns\[column\]\.length\}\s*attention=\{attention\[column\]\}\s*onExpand=\{\(\) => setCompletedCollapsed\(false\)\}/);
});

test('expanded, Completed keeps today\'s header, cards and Archive all untouched, plus a new Collapse Completed button', () => {
  assert.match(panel, /<Archive aria-hidden="true" \/> Archive all/, 'Archive all is unchanged');
  assert.match(panel, /ref=\{collapseButtonRef\} aria-expanded=\{true\} aria-label="Collapse Completed" title="Collapse Completed" onClick=\{\(\) => setCompletedCollapsed\(true\)\}/);
  assert.match(panel, /<ChevronsRight aria-hidden="true" \/>/);
  assert.match(panel, /\{columnBody\(column\)\}/, 'the card list/empty state rendering is unchanged');
});

test('toggling Completed is a clean round-trip: expand from the strip, collapse from the header, no stuck third state', () => {
  assert.match(panel, /const \[completedCollapsed, setCompletedCollapsed\] = useState\(true\);/);
  assert.match(panel, /onExpand=\{\(\) => setCompletedCollapsed\(false\)\}/);
  assert.match(panel, /onClick=\{\(\) => setCompletedCollapsed\(true\)\}/);
});

test('expanding moves focus to the Collapse Completed button; collapsing returns it to the strip — keyboard users aren\'t dropped to the top of the page', () => {
  assert.match(panel, /const stripRef = useRef<HTMLButtonElement>\(null\);/);
  assert.match(panel, /const collapseButtonRef = useRef<HTMLButtonElement>\(null\);/);
  assert.match(panel, /const skipFocusMove = useRef\(true\);\s*useEffect\(\(\) => \{\s*if \(skipFocusMove\.current\) \{ skipFocusMove\.current = false; return; \}\s*\(completedCollapsed \? stripRef : collapseButtonRef\)\.current\?\.focus\(\);\s*\}, \[completedCollapsed\]\);/, 'skips the very first run so mounting the board never steals focus; every toggle after that moves it');
});

test('the collapsed flag is declared above the board/detail branch, so opening any card\'s details and going back leaves it untouched', () => {
  const stateIndex = panel.indexOf('const [completedCollapsed, setCompletedCollapsed] = useState(true);');
  const branchIndex = panel.indexOf('detailRunId ? (');
  assert.ok(stateIndex > -1 && branchIndex > stateIndex, 'the flag lives in the same component instance whether the board or a detail view is showing — swapping between them never recreates it');
});

test('a deep link into a task\'s details (initialRunId) never reads or changes whether Completed is collapsed', () => {
  assert.doesNotMatch(panel, /completedCollapsed[\s\S]{0,60}detailRunId|detailRunId[\s\S]{0,60}completedCollapsed/, 'the two are unrelated: opening a run\'s details, however it was reached, leaves the collapse flag exactly where it was');
});

test('the grid gives Completed a narrow fixed track when collapsed and an equal one when expanded; the other three columns always share the rest, and the board still only scrolls horizontally the way it already did', () => {
  assert.match(panel, /className=\{`grid min-h-0 flex-1 grid-rows-\[minmax\(0,1fr\)\] gap-3 overflow-x-auto p-4 sm:px-6 \$\{completedCollapsed \? 'grid-cols-\[repeat\(3,minmax\(15rem,1fr\)\)_3\.75rem\]' : 'grid-cols-\[repeat\(4,minmax\(15rem,1fr\)\)\]'\}`\}/);
});

test('the collapsed strip adds no new drop wiring — Completed was never a valid drop target before this task, so there is nothing new to accept or refuse', () => {
  const strip = board.slice(board.indexOf('export function CollapsedColumnStrip'), board.indexOf('export function TaskCard'));
  assert.doesNotMatch(strip, /onDrag|onDrop|ColumnDrop/);
  const stripUsage = panel.slice(panel.indexOf('<CollapsedColumnStrip'), panel.indexOf('/>', panel.indexOf('<CollapsedColumnStrip')));
  assert.doesNotMatch(stripUsage, /drop=/);
});

test('canCollapse(\'done\') and the board\'s own column order agree — Completed is the only collapsible column and always renders last', () => {
  assert.equal(canCollapse(BOARD_COLUMNS[BOARD_COLUMNS.length - 1]), true);
  assert.ok(BOARD_COLUMNS.slice(0, -1).every((column) => !canCollapse(column)));
});

test('a reorder saves the column\'s order; a start drop opens the start dialog', () => {
  assert.match(panel, /const dnd = useBoardDnd\(columns, onBoardDrop, \{/);
  assert.match(panel, /if \(drop\.kind === 'reorder'\)[\s\S]*reorderPlanningQueue[\s\S]*actions\.reorder\(drop\.ids\)/);
  assert.match(panel, /\{dialog\?\.kind === 'start' && \(\s*<StartTaskDialog/);
});

test('the drop line shows only while reordering the dragged card\'s own column', () => {
  assert.match(dnd, /const reordering = target && dragged\?\.column === column && target\.column === column && target\.group === card\.group;/, 'and, for a nested task, only within its own group');
  assert.match(dnd, /const peers = reorderPeers\(columns\[column\], card\);/);
  assert.match(board, /data-drop=\{dnd\?\.dropPosition \?\? undefined\}/);
  assert.match(board, /data-\[drop=before\]:before:bg-primary/);
  assert.match(board, /data-\[drop=after\]:after:bg-primary/);
});

// ---- Card click → detail → back ----


/** The four board columns for a project, built exactly as `TasksPanel` builds them. */
function boardFor(items, tasks = [], runs = []) {
  const tasksById = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const groups = buildTaskGroups({ items, tasksById, workflowRunsByProject: { p1: runs }, projectId: 'p1', showArchived: false, now: NOW });
  const done = buildCompletedRows({ items, taskIds: tasks.map((t) => t.id), tasksById, now: NOW });
  return { planning: groups.open, running: [...groups.running, ...groups.waiting], needsYou: groups.needsYou, done };
}
const wfRun = (id, status) => ({ id, projectId: 'p1', planItemId: null, status, createdAt: minutesAgo(60), updatedAt: minutesAgo(1) });
const wfRunWithStep = (id, status, patch = {}) => ({
  ...wfRun(id, status),
  currentStepId: 'build',
  workflowSnapshot: { id: 'wf1', name: 'Software development', description: '', enabled: true, steps: [{ id: 'build', name: 'Development', agentId: 'a', instructions: '', canEditCode: true, requiresApproval: false }] },
  ...patch,
});

test('stepCardProgress is null when the run has neither a reported currentStepProgress nor round-timing data', () => {
  assert.equal(stepCardProgress(wfRunWithStep('r1', 'running')), null, 'no progress and no round-timing fields at all');
  assert.equal(stepCardProgress(wfRunWithStep('r1', 'running', { currentStepProgress: null, currentStepRoundStartedAt: null })), null);
});

test('stepCardProgress reads the current step\'s name off workflowSnapshot, paired with the run\'s checklist progress summary — elapsed null with no round-timing fields (an old run record)', () => {
  const progress = stepCardProgress(wfRunWithStep('r1', 'running', { currentStepProgress: { done: 3, total: 7, estimate: '~10m left' } }));
  assert.deepEqual(progress, { stepName: 'Development', elapsed: null, checklist: { done: 3, total: 7, estimate: '~10m left' } });
});

test('stepCardProgress carries the round-timing fields as elapsed inputs, with no checklist reported yet', () => {
  const progress = stepCardProgress(wfRunWithStep('r1', 'running', { currentStepRoundStartedAt: minutesAgo(3), currentStepPriorRoundsMs: 120_000 }));
  assert.deepEqual(progress, { stepName: 'Development', elapsed: { roundStartedAt: minutesAgo(3), priorMs: 120_000 }, checklist: null });
});

test('stepCardProgress carries both elapsed and checklist when both are available, and defaults a missing currentStepPriorRoundsMs to 0', () => {
  const progress = stepCardProgress(wfRunWithStep('r1', 'running', {
    currentStepRoundStartedAt: minutesAgo(3),
    currentStepProgress: { done: 1, total: 2, estimate: null },
  }));
  assert.deepEqual(progress, { stepName: 'Development', elapsed: { roundStartedAt: minutesAgo(3), priorMs: 0 }, checklist: { done: 1, total: 2, estimate: null } });
});

test('stepCardProgress is null if currentStepId no longer matches any step in the snapshot (a stale/missing step), even with progress or round-timing data present', () => {
  assert.equal(stepCardProgress(wfRunWithStep('r1', 'running', { currentStepId: null, currentStepProgress: { done: 1, total: 2, estimate: null }, currentStepRoundStartedAt: minutesAgo(1) })), null);
  assert.equal(stepCardProgress(wfRunWithStep('r1', 'running', { currentStepId: 'ghost', currentStepProgress: { done: 1, total: 2, estimate: null }, currentStepRoundStartedAt: minutesAgo(1) })), null);
});

test('stepCardElapsedMs sums the prior rounds\' ms with how long the active round has been running', () => {
  const roundStartedAt = '2026-09-26T00:00:00.000Z';
  const now = Date.parse('2026-09-26T00:03:12.000Z');
  assert.equal(stepCardElapsedMs({ roundStartedAt, priorMs: 0 }, now), 192_000, 'first round: no prior ms');
  assert.equal(stepCardElapsedMs({ roundStartedAt, priorMs: 600_000 }, now), 792_000, 'a later round carries the earlier rounds\' total forward');
});

test('cardProgressLine: step name, live elapsed time, and checklist counts/estimate, each present only when there\'s data for it', () => {
  const now = Date.parse('2026-09-26T00:03:12.000Z');
  const elapsed = { roundStartedAt: '2026-09-26T00:00:00.000Z', priorMs: 0 };
  assert.equal(cardProgressLine({ stepName: 'Development', elapsed, checklist: { done: 3, total: 7, estimate: '~10m left' } }, now), 'Development · 3m 12s · 3/7 · ~10m left');
  assert.equal(cardProgressLine({ stepName: 'Development', elapsed, checklist: null }, now), 'Development · 3m 12s', 'no checklist reported yet — just the name and the live timer');
  assert.equal(cardProgressLine({ stepName: 'Code Review', elapsed: null, checklist: { done: 2, total: 4, estimate: null } }, now), 'Code Review · 2/4', 'no round-timing data (an old record) — falls back to today\'s checklist-only line');
  assert.equal(cardProgressLine({ stepName: 'Development', elapsed: null, checklist: { done: 0, total: 0, estimate: null } }, now), 'Development · 0/0');
});

test('regression: every card opens a detail, whatever its column or status', () => {
  const columns = boardFor(
    [
      item('new', { title: '3.002: Add login' }),
      item('paused', { status: 'stopped', taskIds: ['tp'] }),
      item('running', { status: 'developing', taskIds: ['tr'], workflowRunId: 'rr' }),
      item('blocked', { status: 'blocked', taskIds: ['tb'] }),
      item('attention', { status: 'developing', taskIds: ['ta'], workflowRunId: 'ra' }),
      item('done', { status: 'done', taskIds: ['td'] }),
      item('doneByHand', { status: 'done' }),
    ],
    [
      task('tp', { status: 'stopped' }),
      task('tr', { status: 'developing', completedAt: null }),
      task('tb', { status: 'blocked', completedAt: null }),
      task('ta', { status: 'developing', completedAt: null }),
      task('td', { status: 'done' }),
    ],
    [wfRun('rr', 'running'), wfRun('ra', 'needs-attention')],
  );
  const opened = (id) => {
    const found = findCard(columns, id);
    assert.ok(found, `${id} is on the board`);
    return [found.column, cardDetail(found.card)];
  };
  assert.deepEqual(opened('new'), ['planning', { kind: 'item', id: 'new' }], 'never started: its own details');
  assert.deepEqual(opened('paused'), ['planning', { kind: 'task', id: 'tp' }]);
  assert.deepEqual(opened('running'), ['running', { kind: 'run', id: 'rr' }]);
  assert.deepEqual(opened('blocked'), ['needsYou', { kind: 'task', id: 'tb' }]);
  assert.deepEqual(opened('attention'), ['needsYou', { kind: 'run', id: 'ra' }]);
  assert.deepEqual(opened('done'), ['done', { kind: 'task', id: 'td' }]);
  assert.deepEqual(opened('doneByHand'), ['done', { kind: 'item', id: 'doneByHand' }], 'marked done by hand: its own details');
  assert.deepEqual(opened('td'), ['done', { kind: 'task', id: 'td' }], 'a settled Task with no plan item opens its session');
});

test('buildTaskGroups attaches a Running row\'s progress line only from its own run, and never for Planning/Needs-you/Done rows', () => {
  const columns = boardFor(
    [
      item('noProgress', { status: 'developing', taskIds: ['t1'], workflowRunId: 'r1' }),
      item('withProgress', { status: 'developing', taskIds: ['t2'], workflowRunId: 'r2' }),
      item('attention', { status: 'developing', taskIds: ['t3'], workflowRunId: 'r3' }),
    ],
    [
      task('t1', { status: 'developing', completedAt: null }),
      task('t2', { status: 'developing', completedAt: null }),
      task('t3', { status: 'developing', completedAt: null }),
    ],
    [
      wfRunWithStep('r1', 'running'),
      wfRunWithStep('r2', 'running', { currentStepProgress: { done: 3, total: 7, estimate: '~10m left' } }),
      wfRunWithStep('r3', 'needs-attention', { currentStepProgress: { done: 1, total: 2, estimate: null } }),
    ],
  );
  const runningRow = (id) => findCard(columns, id).card;
  assert.equal(runningRow('noProgress').progress, null, 'no progress and no round-timing data — nothing extra, exactly today\'s card');
  assert.deepEqual(runningRow('withProgress').progress, { stepName: 'Development', elapsed: null, checklist: { done: 3, total: 7, estimate: '~10m left' } });
  assert.equal(findCard(columns, 'attention').column, 'needsYou');
  assert.equal(runningRow('attention').progress, undefined, 'progress is only ever attached for the Running bucket');
});

test('only OpenTaskCard ever passes a progressLine — CompletedTaskCard and PlanningSessionCard never render one even if a row somehow carried progress', () => {
  const openCard = board.slice(board.indexOf('export function OpenTaskCard'), board.indexOf('export function CompletedTaskCard'));
  assert.match(openCard, /const progressLine = useCardProgressLine\(row\.progress\);/, 'the live timer (task 5.003) ticks through a dedicated hook, not a plain cardProgressLine call');
  assert.match(openCard, /progressLine=\{progressLine\}/);
  const completedCard = board.slice(board.indexOf('export function CompletedTaskCard'), board.indexOf('export function PlanningSessionCard'));
  assert.doesNotMatch(completedCard, /progressLine|useCardProgressLine/);
  const planningCard = board.slice(board.indexOf('export function PlanningSessionCard'));
  assert.doesNotMatch(planningCard, /progressLine|useCardProgressLine/);
});

test('useCardProgressLine ticks every second only while its card actually carries a live elapsed time, so the board\'s other cards aren\'t forced to re-render every second for it (task 5.003)', () => {
  const hook = board.slice(board.indexOf('const LIVE_TIMER_TICK_MS'), board.indexOf('export function BoardColumnView'));
  assert.match(hook, /const LIVE_TIMER_TICK_MS = 1_000;/);
  assert.match(hook, /useNow\(progress\?\.elapsed \? LIVE_TIMER_TICK_MS : undefined\)/, 'falls back to useNow\'s own slower default when there\'s no elapsed time to tick');
});

test('regression: a card is always clickable — the open handler is never gated on having a run or session', () => {
  const card = board.match(/export function TaskCard[\s\S]*?\n}\n/)[0];
  assert.match(card, /onOpen: \(\) => void;/, 'onOpen is required');
  assert.doesNotMatch(board, /onOpen\?:|onOpen \?|actions\.includes\('open'\) \?/);
  assert.match(board, /onOpen=\{\(\) => handlers\.onOpen\(row\)\}/, 'open cards');
  assert.match(board, /export function CompletedTaskCard[\s\S]*onOpen=\{\(\) => handlers\.onOpen\(row\)\}/, 'completed cards');
  assert.match(panel, /onOpen: openCard,/);
  assert.match(panel, /const completedHandlers = \{ onOpen: openCard,/);
  assert.match(panel, /<CompletedTaskCard[\s\S]*?\{\.\.\.completedHandlers\}/);
  assert.match(panel, /function openCard\(row: OpenTaskRow \| CompletedRow\) \{\s*showDetail\(cardDetail\(row\)\);/);
});

test('the card is focusable and opens on Enter (and Space), only when the card itself has focus', () => {
  const card = board.match(/export function TaskCard[\s\S]*?\n}\n/)[0];
  assert.match(card, /role="button"\s*tabIndex=\{0\}\s*aria-label=\{`Open "\$\{title\}"`\}/);
  assert.match(card, /focus-visible:ring-2/);
  assert.match(card, /onKeyDown=\{\(event\) => \{\s*if \(event\.target !== event\.currentTarget\) return;\s*const action = boardKeyAction\('card', event\);\s*if \(action === 'open'\)/);
});

test('keyboard equivalents reorder cards and send ready tasks through the guarded start flow', () => {
  assert.match(dnd, /event\.altKey[\s\S]*ArrowUp[\s\S]*ArrowDown[\s\S]*ArrowRight/);
  assert.match(dnd, /event\.key === 'ArrowRight' && column !== 'planning'/);
  assert.match(dnd, /onDrop\(drop\);[\s\S]*setAnnouncement/);
  assert.match(board, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
  assert.match(board, /aria-keyshortcuts=\{!dragHandle && dnd\?\.draggable \? 'Alt\+ArrowUp Alt\+ArrowDown Alt\+ArrowRight' : undefined\}/, 'nested tasks reorder by keyboard too');
  assert.match(dnd, /\{ column, group: card\.group, index: event\.key === 'ArrowUp' \? index - 1 : index \+ 2 \}/, 'Alt+Up/Down moves among the card\'s own peers');
  assert.match(dnd, /setAnnouncement\(dropAnnouncement\(drop, event\.key === 'ArrowUp' \? 'up' : 'down'\)\)/);
  assert.match(panel, /aria-live="polite">\{dnd\.announcement\}/);
  assert.match(board, /else if \(!dragHandle\) dnd\?\.onKeyDown\(event\)/, 'the planning group body cannot reorder');
  assert.match(board, /aria-keyshortcuts=\{!dragHandle && dnd\?\.draggable/, 'the group body advertises no reorder or start shortcut');
});

test('card activation is independent of planning drag handles and expanders', () => {
  assert.match(board, /role="button"[\s\S]*onClick=\{\(event\) =>[\s\S]*if \(opens\) onOpen\(\)/);
  assert.match(board, /<Button[^>]*draggable=\{dnd\.draggable\}[^>]*aria-label=\{`Reorder \$\{/);
  assert.match(board, /aria-expanded=\{expanded\} onClick=\{\(\) => setExpanded/);
});

test('a drag never opens the details: a press that moved is not a click', () => {
  assert.equal(isCardClick({ x: 10, y: 10 }, { x: 10, y: 10 }), true);
  assert.equal(isCardClick({ x: 10, y: 10 }, { x: 13, y: 12 }), true, 'a little jitter is still a click');
  assert.equal(isCardClick({ x: 10, y: 10 }, { x: 30, y: 10 }), false, 'dragged sideways');
  assert.equal(isCardClick({ x: 10, y: 10 }, { x: 10, y: 60 }), false, 'dragged down');
  assert.equal(isCardClick(null, { x: 0, y: 0 }), true, 'activated without a press (assistive tech)');
  const card = board.match(/export function TaskCard[\s\S]*?\n}\n/)[0];
  assert.match(card, /onPointerDown=\{\(event\) => \{ pressedAt\.current = \{ x: event\.clientX, y: event\.clientY \}; \}\}/);
  assert.match(card, /const opens = isCardClick\(pressedAt\.current, \{ x: event\.clientX, y: event\.clientY \}\);\s*pressedAt\.current = null;\s*if \(opens\) onOpen\(\);/);
});

test('a click never starts a drag: the card is a native drag source, and nothing drag-related runs on press', () => {
  const card = board.match(/export function TaskCard[\s\S]*?\n}\n/)[0];
  assert.doesNotMatch(card, /onPointerDown=\{[^}]*(setDragged|dnd\.)/);
  assert.doesNotMatch(dnd, /onPointerDown|onMouseDown|onClick/);
  assert.match(dnd, /onDragStart: \(event\) => \{/, 'dragging only begins on the browser\'s own dragstart');
});

// ---- Not-started task details ----

test('task details show the title without its number, then the number, where it came from and when it was created', () => {
  const created = '2026-09-13T14:04:00.000Z';
  const planned = taskItemInfo({ title: '3.002: Add login', planningTaskId: 'plan-1', createdAt: created }, { 'plan-1': { planningSessionNumber: 3 } });
  assert.equal(planned.name, 'Add login');
  assert.equal(planned.meta[0], '3.002');
  assert.equal(planned.meta[1], 'From planning session 3');
  assert.equal(planned.meta[2], `Created ${formatTimestamp(created)}`, 'the same date/time format as elsewhere');

  const unloaded = taskItemInfo({ title: '3.002: Add login', planningTaskId: 'plan-1', createdAt: created }, {});
  assert.equal(unloaded.meta[1], 'From a planning session', 'the session Task isn\'t loaded yet');
  const deletedParent = taskItemInfo({ title: '3.002: Add login', planningTaskId: 'plan-1', planningRef: { session: 3, task: 2 }, createdAt: created }, {});
  assert.equal(deletedParent.provenance, 'From planning session 3', 'durable provenance survives deletion of the parent Task');
  assert.match(header, /run \? \[\.\.\.\(info\?\.number[\s\S]*info!\.provenance[\s\S]*runTimingParts/, 'execution details keep the planning reference');

  const manual = taskItemInfo({ title: 'Fix the footer', planningTaskId: null, createdAt: created }, {});
  assert.equal(manual.name, 'Fix the footer');
  assert.deepEqual(manual.meta.slice(0, 1), ['Added manually'], 'no number for a hand-typed task');
  assert.equal(manual.meta.length, 2);

  assert.equal(taskItemInfo({ title: '12.3: Not a task number', createdAt: created }, {}).name, '12.3: Not a task number');
  assert.equal(taskItemInfo({ title: '12.3: Not a task number', createdAt: created }, {}).number, null);
  assert.equal(taskItemInfo({ title: '3.002: Add login', createdAt: created }, {}).number, '3.002');
  assert.equal(taskItemInfo({ title: '1.004: Multi\nline', createdAt: created }, {}).name, 'Multi\nline');
});

test('task details use the shared header with a Start icon instead of a ⋮ menu, Edit in the section, and the board\'s edit form', () => {
  assert.match(itemDetails, /<DetailHeader item=\{item\} run=\{null\} status=\{status\} actions=\{actions\} alerts=\{alerts\} editing=\{editing\} onStart=\{onStart\} fill=\{fill\} onBack=\{onBack\} \/>/);
  assert.doesNotMatch(itemDetails, /MarkdownDocument|TaskSpecification|menu/, 'the description lives in the header now, and there is no menu');
  assert.doesNotMatch(header, /EllipsisVertical|DropdownMenu|\bmenu\b/, 'no ⋮ in the details header');
  assert.doesNotMatch(panel, /OpenCardMenu|CompletedCardMenu/, 'the board card keeps its ⋮; the details don\'t');
  assert.match(panel, /onStart=\{open\?\.primary === 'start' \? \(\) => setDialog\(\{ kind: 'start', row: open \}\) : undefined\}/, 'Start only when the card can start, via the existing StartTaskDialog');
  assert.match(panel, /editing=\{open\?\.canEdit \? \{ editing: editingId === item\.id, onEdit: \(\) => setEditingId\(item\.id\),/, 'Edit only when the card can be edited');
  assert.match(panel, /const open = column === 'done' \? null : \(card as OpenTaskRow\);/, 'a Completed task offers neither');
  assert.match(header, /\{onStart && <HeaderIconButton label="Start task" icon=\{Play\} onClick=\{onStart\} \/>\}/);
  assert.doesNotMatch(header, /HeaderIconButton label="Edit/, 'Edit is not in the header');
  assert.match(header, /\{editing && !editing\.editing && \(\s*<Button type="button" variant="secondary" size="sm" onClick=\{editing\.onEdit\}>\s*<Pencil aria-hidden="true" \/> Edit/, 'Edit sits in the actions row, styled like Archive');
  assert.match(header, /aria-label=\{label\}\s*aria-expanded=\{expanded\}/, 'icon buttons are named');
  assert.match(header, /<TooltipContent side="bottom">\{label\}<\/TooltipContent>/, 'and have a tooltip');
  assert.match(header, /<MarkdownDocument content=\{description\} className="doc-content" \/>/, "the specification renders as markdown, in the design system's doc type scale");
  assert.match(header, /No description\./);
  assert.match(header, /\{editing\?\.editing \? \(\s*<TaskEditForm title=\{item\.title\} description=\{item\.description\}/);
  assert.match(header, /const open = expanded \|\| !!editing\?\.editing;/, 'Edit opens the section');
  assert.match(panel, /<TaskEditForm title=\{row\.title\} description=\{row\.description\}/, 'the board card edits with the same form');
  assert.match(editForm, /export function TaskEditForm/);
  assert.doesNotMatch(panel, /function EditRow/, 'the old inline editor is gone');
});

test('a Planning task\'s details open expanded, with the description filling the remaining height', () => {
  assert.match(panel, /fill=\{column === 'planning'\}/, 'only the Planning column fills');
  assert.match(header, /const \[expanded, setExpanded\] = useState\(fill\);/, 'fill starts expanded');
  assert.match(header, /const filling = fill && open;/, 'collapsing it gives the space back');
  assert.match(header, /<header className=\{filling \? 'flex min-h-0 flex-1 flex-col' : 'shrink-0 border-b'\}>/);
  assert.match(header, /<DetailMore item=\{item\} fill=\{filling\}/);
  assert.match(header, /overflow-y-auto rounded-md \$\{fill \? 'min-h-0 flex-1' : 'max-h-64'\}/, 'the box grows instead of capping at max-h-64');
});

test('the not-started details status follows its column', () => {
  assert.match(panel, /planning: \{ label: 'Planning'[^\n]*status: \{ label: 'Not started'/);
  assert.match(panel, /done: \{ label: 'Completed'[^\n]*status: \{ label: 'Completed'/);
  assert.match(panel, /status=\{COLUMNS\[column\]\.status\}/);
});

test('the run detail and the task details share one header; no Requirement stage/tab is left', () => {
  assert.match(header, /export function DetailHeader/);
  assert.match(header, /label = 'Back to tasks'[\s\S]*aria-label=\{label\}/);
  assert.match(runView, /<DetailHeader\s+item=\{planItems\.find\(\(item\) => item\.id === run\.planItemId\)\}\s+run=\{run\}\s+status=\{runStatusBadge\(run\.status\)\}\s+actions=\{actions\}\s+alerts=\{alerts\}\s+onBack=\{onBack\}/);
  assert.match(runView, /<DetailBackButton onBack=\{onBack\} \/>/, 'the loading header too');
  assert.doesNotMatch(runView, /<ArrowLeft|<Badge|<Square|ConfirmDialog|stopWorkflowRun/, 'no copy of the header or its old Stop left behind');
  assert.doesNotMatch(runView, /TaskSpecification|description=\{description\}/, 'no standalone description block');
  assert.doesNotMatch(runView, /Requirement|requirementStage/, 'no Requirement Analysis stage or tab');
});

test('a step\'s Session mode shows the bare session: no header, no footer, no per-step Stop', () => {
  // Session mode is the bare TaskSessionBody only when there's nothing to split beside it (showSplit
  // false); otherwise (a running round, or a finished one with reported progress) it's RoundProgressSplit
  // instead — see the 40/60 split tests below.
  assert.match(runView, /\{sessionTaskId\s*\?\s*\(showSplit\s*\?[\s\S]*?: <TaskSessionBody key=\{sessionTaskId\} taskId=\{sessionTaskId\} controls=\{controls\} \/>\)/, 'the session fills the content area edge to edge: no wrapper, border, padding or fixed size');
  assert.doesNotMatch(runView, /h-\[36rem\]/);
  assert.doesNotMatch(runView, /<TaskDetailsView|inRun|Stop task|stopTask/);
  const body = sessionView.slice(sessionView.indexOf('export function TaskSessionBody'), sessionView.indexOf('export function TaskDetailsView'));
  assert.doesNotMatch(body, /<header|TaskDescriptionBox|Stop task|stopTask|Composer/, 'the bare session has no header or footer');
  assert.match(body, /<TaskTerminal taskId=\{taskId\} onSessionState=\{setSessionState\} \/>/, 'the terminal reconnects by itself: no remount key');
  assert.match(sessionView, /<TaskSessionBody taskId=\{taskId\} historyIds=\{historyIds\} controls=\{controls\} \/>/, 'the full task view frames the same body, floating its own Stop/Resume');
  assert.doesNotMatch(sessionView, /inRun/);
});

test('run detail layout: rounds are a left sidebar; one content area, no tab row', () => {
  assert.match(runView, /<div className="flex min-h-0 flex-1 flex-col">\s*<StageDetail key=\{activeStage\.id\}/, 'the stage area fills the popup below the stepper');
  assert.match(runView, /<div className="flex min-h-0 flex-1">\s*\{\(entries\.length > 1 \|\| roundOffset > 0\) && \(\s*<nav aria-label="Rounds" className="w-28 shrink-0 space-y-1 overflow-y-auto border-r p-2">/, 'a narrow vertical round list on the left');
  assert.doesNotMatch(runView, /Tabs|TabsContent|TabsTrigger|setTab/, 'the Summary/Output/Session tab row is gone');
  assert.doesNotMatch(runView, /role="tablist" aria-label="Round"/, 'the old horizontal round strip is gone');
});

test('Summary mode: summary left 35%, output right 65%, each scrolling under its own fixed label; one side alone takes the full width', () => {
  assert.match(runView, /const panes = roundPanes\(round\);/);
  assert.match(runView, /<RoundPane label="Summary" className=\{panes\.output \? 'w-\[35%\] shrink-0 border-r' : 'flex-1'\}>/);
  assert.match(runView, /<RoundPane label="Output" className="flex-1">/);
  assert.match(runView, /<h4 className="flex h-10 shrink-0 items-center[^"]*text-muted-foreground uppercase[^"]*">\{label\}<\/h4>\s*\{children\}/, 'a small muted fixed label over the column\'s content');
  assert.match(runView, /const PANE_SCROLL = 'min-h-0 flex-1 overflow-y-auto /, 'one shared scrolling body per column');
  assert.match(runView, /<div className=\{PANE_SCROLL\}><RoundSummary round=\{round\} \/><\/div>/, 'the summary scrolls independently');
});

test('Output tabs are pinned at the top of the Output column and the selected output is its only scroller', () => {
  assert.match(runView, /<div className="flex shrink-0 items-start gap-3[^"]*">\s*<div className="flex flex-1 flex-wrap gap-1\.5" role="tablist" aria-label="Output">/, 'the tab strip does not scroll away');
  assert.match(runView, /<div className=\{PANE_SCROLL\}><MarkdownDocument content=\{output\.content\}/, 'markdown output scrolls below the tabs');
  assert.match(runView, /<iframe title=\{output\.name\}[^>]*className="h-full w-full"/, 'HTML output fills the column and scrolls inside its own frame');
  assert.doesNotMatch(runView, /h-\[32rem\]/, 'no fixed-height iframe nested inside a scrolling pane (double scrollbars)');
});

test('an HTML output sits borderless in the Output column and full screen covers the window above the status footer, tabs included', () => {
  assert.match(runView, /<iframe title=\{output\.name\} srcDoc=\{embeddedHtmlOutput\(output\.content\)\}[^>]*className="h-full w-full" \/>/, 'no border, rounding or backdrop of its own');
  const outputs = runView.slice(runView.indexOf('function RoundOutputs('), runView.indexOf('function OutputTabStrip('));
  assert.doesNotMatch(runView, /requestFullscreen/, 'no OS-level Fullscreen API');
  assert.match(outputs, /onClick=\{\(\) => setExpanded\(true\)\}>\s*<Maximize2[^>]*\/> Full screen/);
  assert.match(outputs, /<Dialog open=\{expanded\} onOpenChange=\{setExpanded\}>/, 'an in-app overlay, closable with Escape');
  assert.match(outputs, /className="left-0 top-0 [^"]*h-\[calc\(100dvh-var\(--status-footer-height\)\)\] max-h-none w-screen/, 'the overlay fills the window down to the status footer');
  assert.equal(outputs.match(/<OutputTabStrip outputs=\{outputs\} index=\{index\} onSelect=\{setIndex\}>/g)?.length, 2, 'inline and full screen share the tab strip and selection');
  assert.match(outputs, /onClick=\{\(\) => setExpanded\(false\)\}>\s*<Minimize2[^>]*\/> Exit full screen/);
});

test('the stepper shows a completed stage\'s time spent, and the current stage\'s live timer, through the same muted suffix markup', async () => {
  const stepper = await read('WorkflowRunStepper.tsx');
  assert.match(stepper, /const timeLabel = stageTimeLabel\(stage, state, run, now\);/, 'current-stage live timer (task 5.003) extends the same call, not a separate one');
  assert.match(stepper, /\{timeLabel && <span className="text-\[10px\] opacity-75">• \{timeLabel\}<\/span>\}/);
});

test('the stepper\'s current-stage timer ticks every second, independently of other panels\' slower staleness ticks (task 5.003)', async () => {
  const stepper = await read('WorkflowRunStepper.tsx');
  assert.match(stepper, /const LIVE_TIMER_TICK_MS = 1_000;/);
  assert.match(stepper, /const now = useNow\(LIVE_TIMER_TICK_MS\);/);
});

test('the stepper never special-cases Complete\'s timer — stageTimeLabel itself is what keeps Complete untimed, even as the fallback current stage', async () => {
  const stepper = await read('WorkflowRunStepper.tsx');
  assert.doesNotMatch(stepper, /stage\.kind === 'complete'/, 'Complete is excluded inside stageTimeLabel, not by a second check here');
});

test('the current stage\'s round badge and its live time suffix sit side by side on the same chip, each independently optional', async () => {
  const stepper = await read('WorkflowRunStepper.tsx');
  const chip = stepper.slice(stepper.indexOf('<span>{stage.name}</span>'), stepper.indexOf('</button>'));
  assert.match(chip, /\{roundBadge && <span className="text-\[10px\] opacity-75">\{roundBadge\}<\/span>\}[\s\S]*\{state === 'skipped'[\s\S]*\{timeLabel && <span/);
});

test('the floating Summary/Session toggle: top-right, above the content, switches mode, icon + label or tooltip + aria-label', () => {
  assert.match(runView, /<TaskSessionBody key=\{sessionTaskId\} taskId=\{sessionTaskId\} controls=\{controls\} \/>/, 'in Session mode it joins the session\'s own floating cluster');
  assert.match(runView, /: round\.taskId && <RoundModeToggle mode=\{shownMode === 'session' \? 'session' : 'summary'\} onChange=\{chooseMode\} \/>\}/, 'a step without a Quick look view keeps today\'s toggle, only when the round has a session');
  assert.match(runView, /\{hasControls && <FloatingControls>\{controls\}<\/FloatingControls>\}/);
  assert.match(runView, /const next: RoundViewMode = mode === 'summary' \? 'session' : 'summary';/);
  assert.match(runView, /onClick=\{\(\) => onChange\(next\)\}/);
  assert.match(runView, /aria-label=\{label\}\s*title=\{label\}/);
  assert.match(runView, /className=\{`shadow-sm \$\{mode === 'session' \? 'size-7' : 'h-7'\}`\}/, 'icon-only over the terminal');
  assert.match(floating, /absolute top-1\.5 right-2 z-10/, 'the cluster is fixed in the corner, not inside a scroller');
  assert.match(floating, /flex items-center gap-1\.5/, 'its buttons sit in one row with a small gap');
  assert.match(runView, /\{mode === 'summary' && 'Session'\}/);
  assert.match(runView, /<RunActions key=\{runId\} runId=\{runId\} run=\{run\} stage=\{activeStage\} \/>/, 'the pinned approve/request-changes bar is still under the content');
});

test('a running (or finished-with-progress) round\'s Session shows the 40/60 split: progress pane left, session right, never for a plain finished session', () => {
  assert.match(runView, /const showSplit = !!sessionTaskId && \(round\.status === 'running' \|\| hasProgress\(round\)\);/, 'a running round always splits, even with no progress yet; a settled one splits only once it has some');
  const split = runView.slice(runView.indexOf('function RoundProgressSplit'), runView.indexOf('function RoundProgressPanel'));
  assert.match(split, /grid min-h-0 flex-1 grid-cols-\[40%_60%\]/, 'a 40/60 CSS grid');
  assert.match(split, /<RoundProgressPanel round=\{round\} \/>\s*\{session\}/, 'progress pane first (left), the session second (right)');
});

test('the split\'s progress pane shows the placeholder before the first report, and the checklist/activity/estimate content after', () => {
  const panel = runView.slice(runView.indexOf('function RoundProgressPanel'), runView.indexOf('function RoundProgressContent'));
  assert.match(panel, /\{hasProgress\(round\)\s*\?\s*<RoundProgressContent[\s\S]*?:\s*<p[^>]*>Waiting for the agent to post its plan…<\/p>\}/);
  const content = runView.slice(runView.indexOf('function RoundProgressContent'), runView.indexOf('const CHECKLIST_STATE_ICON'));
  assert.match(content, /\{counts\.done\} of \{counts\.total\} done/);
  assert.match(content, /progress\.currentActivity && /);
  assert.match(content, /progress\.estimate && /);
  assert.match(content, /estimateStalenessLabel\(progress\.estimatedAt\)/);
});

test('the split\'s expand/collapse control is a separate width toggle from the Summary ⇄ Session RoundModeToggle, and goes full-width without leaving Session mode', () => {
  const split = runView.slice(runView.indexOf('function RoundProgressSplit'), runView.indexOf('const PROGRESS_TICK_MS'));
  assert.match(split, /const \[expanded, setExpanded\] = useState\(false\);/);
  assert.match(split, /aria-label=\{label\} title=\{label\} onClick=\{\(\) => setExpanded\(\(value\) => !value\)\}/);
  assert.match(split, /if \(expanded\) return session;/, 'expanding keeps rendering the very same TaskSessionBody, just without the progress column');
  assert.doesNotMatch(split, /setMode/, 'the width toggle never touches RoundDetail\'s own mode state');
});

test('a finished round\'s Summary shows its final checklist as a collapsed, collapsible "Progress" disclosure, absent with no progress to show', () => {
  assert.match(runView, /\{hasProgress\(round\) && <FinalProgressDisclosure progress=\{round\.progress!\} \/>\}/);
  const disclosure = runView.slice(runView.indexOf('function FinalProgressDisclosure'));
  assert.match(disclosure, /<details className="rounded-md border">/, 'a <details> element starts collapsed by default (no "open" attribute)');
  assert.doesNotMatch(disclosure, /<details[^>]* open/);
  assert.match(disclosure, /<summary className="flex cursor-pointer/);
});

test('the embedded terminal refits whenever its container resizes', async () => {
  const terminal = await readFile(new URL('../src/ui/TaskTerminal.tsx', import.meta.url), 'utf8');
  assert.match(terminal, /new ResizeObserver\(\(\) => \{\s*try \{ fit\.fit\(\); sendSize\(\); \}/);
});

test('a step\'s Summary, Output and completion report render through MarkdownDocument with the doc-content prose styles', () => {
  assert.match(runView, /\{round\.summary && <MarkdownDocument content=\{round\.summary\} className="doc-content" \/>\}/);
  assert.match(runView, /<MarkdownDocument content=\{output\.content\} className="doc-content" \/>/);
  assert.match(runView, /<MarkdownDocument content=\{run\.completionReport\} className="doc-content" \/>/);
  assert.doesNotMatch(runView, /whitespace-pre-wrap">\{round\.summary\}/, 'no plain-text summary');
});

test('the doc-content prose styles restore what Tailwind\'s preflight strips (lists, headings, code, tables, links)', async () => {
  const css = await readFile(new URL('../src/styles/shadcn.css', import.meta.url), 'utf8');
  for (const rule of [/\.doc-content ul \{\s*@apply[^}]*list-disc/, /\.doc-content ol \{\s*@apply[^}]*list-decimal/, /\.doc-content h2 \{/, /\.doc-content pre \{/, /\.doc-content th \{/, /\.doc-content a \{/]) {
    assert.match(css, rule);
  }
});

test('the Settings workflow stage list shows only configured steps, no Requirement analysis row', async () => {
  const settings = await read('SettingsPanel.tsx');
  assert.doesNotMatch(settings, /Requirement analysis|requirementAnalysis/);
  assert.match(settings, /\{workflow\.steps\.map\(\(step\) => \(\s*<StageRow key=\{step\.id\} step=\{step\} steps=\{workflow\.steps\} executors=\{executors\} \/>/);
});

test('the Catalog workflow editor has no Requirement Analysis section, only steps', async () => {
  const catalogModal = await readFile(new URL('../src/ui/CatalogModal.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(catalogModal, /Requirement Analysis|requirementAnalysis/);
});

// ---- The shared task details header ----

test('the run header copies only its branch name and hides the button before a branch exists', () => {
  assert.match(runView, /\{run\.branch \? <><code[^>]*>\{run\.branch\}<\/code><CopyButton text=\{run\.branch\} label="Copy branch name"[^>]*\/><\/> : 'Not created yet'\}/);
  assert.match(copyButton, /await navigator\.clipboard\.writeText\(text\);/);
  assert.match(copyButton, /setCopied\(true\);/);
  assert.match(copyButton, /catch \{\s*onError\?\.\(\);\s*\}/);
});

test('a plain task session copies only its branch name and omits the button without a branch', () => {
  assert.match(sessionView, /\{task\.branch && <p[^>]*><span>Task branch: \{task\.branch\}<\/span><CopyButton text=\{task\.branch\} label="Copy branch name"[^>]*\/><\/p>\}/);
});

test('header top row: back, title, then the status badge with Stop/Resume to its right, then Start and the chevron', () => {
  assert.match(header, /<DetailBackButton onBack=\{onBack\} \/>\s*<h3[^>]*>\{info\?\.name \?\? 'Loading…'\}<\/h3>\s*<div className="flex shrink-0 items-center gap-2">\s*\{item && isBugItem\(item\) && <Badge variant="soft-destructive"><Bug aria-hidden="true" \/> \{BUG_BADGE_LABEL\}<\/Badge>\}\s*<Badge variant=\{status\.variant\}>\{status\.label\}<\/Badge>\s*\{hasAutoMerge\(item\) && <AutoMergeSwitch item=\{item\} run=\{run\} \/>\}\s*\{run && <RunControlButton runId=\{run\.id\} control=\{runControl\(run, tasks\)\} actions=\{actions\} \/>\}\s*\{onStart && <HeaderIconButton/);
  assert.match(header, /if \(!control\) return null;/, 'neither button when neither applies');
  assert.match(header, /await \(stop \? actions\.stopRun\(runId\) : actions\.resumeRun\(runId\)\);/);
  assert.match(header, /<div className="empty:hidden">\{alerts\}<\/div>/, 'a refused stop/resume (409) shows right under the header');
  assert.doesNotMatch(runView, /s\.formErrors|\{lastError/, 'the run view never renders a scope error itself, so a stop/resume failure shows once');
  assert.equal((runView.match(/role="alert"/g) ?? []).length, 2, 'RunActions and the reopened-changes decision each show their own error');
  assert.match(runView, /const lastError = \(\) => useWorldStore\.getState\(\)\.formErrors\.workflowRun \?\? null;/);
  assert.match(runView, /const message = await runActionError\(action, lastError\);\s*setError\(message\);/, 'a failed action reads lastError once, into its own alert');
  assert.doesNotMatch(runView, /<ActionAlerts|actions\.error/, 'the header alone renders the Tasks tab alert');
});

test('runControl: Stop while a CLI is live, Resume once stopped, neither before starting or after finishing', () => {
  const live = [{ status: 'done' }, { status: 'developing' }];
  assert.equal(runControl({ status: 'running' }, live), 'stop');
  assert.equal(runControl({ status: 'awaiting-approval' }, [{ status: 'blocked' }]), 'stop', 'a CLI waiting on input is still running');
  assert.equal(runControl({ status: 'stopped' }, []), 'resume');
  assert.equal(runControl({ status: 'running' }, [{ status: 'done' }]), null, 'nothing live to stop');
  assert.equal(runControl({ status: 'completed' }, live), null);
  assert.equal(runControl(null, live), null, 'not started');
});

test('runTimingParts: start, end ("Running" while live, "—" when halted) and total time spent', () => {
  const start = minutesAgo(90);
  const end = minutesAgo(10);
  assert.deepEqual(runTimingParts({ status: 'completed', createdAt: start, completedAt: end }, 75 * 60_000), [`Started ${formatTimestamp(start)}`, `Ended ${formatTimestamp(end)}`, '1h 15m spent']);
  assert.equal(runTimingParts({ status: 'running', createdAt: start, completedAt: null }, 0)[1], 'Ended Running');
  assert.equal(runTimingParts({ status: 'stopped', createdAt: start, completedAt: null }, 30_000)[1], 'Ended —');
  assert.equal(runTimingParts({ status: 'stopped', createdAt: start, completedAt: null }, 30_000)[2], '<1m spent');
});

test('header second row: task number, timing (ticking), the coding agent, and a chevron that toggles the collapsed section', () => {
  assert.match(header, /runTimingParts\(run, item \? planItemSpentMs\(item, tasksById, now\) : 0\)/);
  assert.match(header, /const now = useNow\(SPENT_TICK_MS\);/, 'time spent keeps moving while live');
  assert.match(header, /workerLabel\(executors, item\?\.executorId \?\? run\?\.executorId \?\? null\)/, 'the existing executor lookup');
  assert.match(header, /fill = false,/, 'collapsed by default, except a Planning task (`fill`)');
  assert.doesNotMatch(header + itemDetails, /defaultExpanded/);
  assert.match(header, /\{onStart && <HeaderIconButton label="Start task"[^\n]*\n\s*<HeaderIconButton label=\{open \? 'Hide task details' : 'Show task details'\} icon=\{open \? ChevronUp : ChevronDown\} expanded=\{open\} onClick=\{\(\) => setExpanded\(!open\)\} \/>\s*<\/div>/, 'the chevron is on the top row, after Start');
  assert.match(header, /<p className="truncate pl-10\.5 text-xs text-muted-foreground">\{facts\.join\(' · '\)\}<\/p>\s*(?:\{hasAutoMerge\(item\) && <AutoMerge\w+ item=\{item\}(?: run=\{run\})? \/>\}\s*)*<\/div>/, 'the second row is metadata only; the Auto-merge status sits under it');
  assert.match(header, /\{open && item && \(\s*<DetailMore/);
});

test('collapsed section: plain label/value rows, one tinted description box, then the actions row under the only divider', () => {
  assert.match(header, /sessionId=\{latestItemTask\(item, tasksById\)\?\.sessionId \?\? null\}/);
  assert.match(header, /<h4 className="text-\[11px\] font-medium tracking-wider text-muted-foreground uppercase">\{children\}<\/h4>/, 'small muted uppercase labels');
  assert.match(header, /<DetailRow label="Session ID">\s*<code className="min-w-0 truncate font-mono text-xs select-text">\{sessionId\}<\/code>\s*<CopyButton text=\{sessionId\} label="Copy session ID"/, 'a plain row, monospace, with a copy icon');
  assert.match(header, /\{links && <DetailRow label="Branch">\{links\}<\/DetailRow>\}/);
  assert.match(header, /<DetailLabel>Task description<\/DetailLabel>\s*\{!editing\?\.editing && <CopyButton text=\{item\.description\} label="Copy task description"/, 'the TASK DESCRIPTION heading with the copy button on its row');
  assert.match(header, /<div className=\{`overflow-y-auto rounded-md \$\{fill \? 'min-h-0 flex-1' : 'max-h-64'\} bg-muted\/50 px-3 py-2`\}>/, 'a scrollable description box, bounded unless it fills the view');
  const more = header.match(/function DetailMore[\s\S]*?\n}\n/)[0] + header.match(/function DetailRow[\s\S]*?\n}\n/)[0];
  assert.equal((more.match(/\bborder\b|border-[tblr]\b/g) ?? []).length, 0, 'no borders — there is no worker select any more');
  assert.equal((more.match(/\bbg-/g) ?? []).length, 1, 'only the description has a background');
  assert.match(header, /<\/div>\s*<Separator \/>\s*<div className=\{`flex flex-wrap items-center gap-2 py-3/, 'actions in one row under a divider');
  assert.match(header, /variant="secondary" size="sm" disabled=\{!!archiveReason\}/);
  assert.match(header, /<Button type="button" variant="destructive" size="sm" className="ml-auto" onClick=\{\(\) => setConfirmDelete\(true\)\}>/);
  assert.equal((header.match(/TITLE_INDENT/g) ?? []).length, 3, 'both blocks sit on the title\'s column');
  assert.match(header, /disabled=\{!!archiveReason\} title=\{archiveReason \?\? [^}]*\} onClick=\{\(\) => void actions\.archive\(item\.id\)\.then\(\(ok\) => ok && onBack\(\)\)\}/, 'archive is disabled with a reason while developing, and goes back once done');
  assert.match(header, /\{canComplete && \([\s\S]*?actions\.complete\(\[\{ id: item\.id, completesViaSession: false, latestTaskId: null \}\]\)/, 'mark complete patches the item (hidden once done)');
  assert.match(header, /<ConfirmDialog\s+title="Delete this task\?"[\s\S]*?void actions\.deleteItems\(\[item\.id\]\)\.then\(\(ok\) => ok && onBack\(\)\)/, 'in-app confirm, then back to the board');
  assert.doesNotMatch(header, /window\.confirm|[^.\w]confirm\(/, 'never the browser confirm()');
});

// ---- Card click → detail → back ----

test('a card\'s detail replaces the board, and a detail opened from the board goes Back to the board', () => {
  assert.match(panel, /function showDetail\(next: CardDetail \| null, fromSessionId: string \| null = null\) \{\s*detailState\.show\(next\);\s*setEditingId\(null\);\s*setOriginSessionId\(fromSessionId\);/, 'opened from the board, a detail has no session to go back to');
  assert.match(panel, /function backFromDetail\(\) \{\s*showDetail\(detailBackTarget\(originSessionId, tasksById\)\);/);
  assert.match(cardDetailHook, /function show\(detail: CardDetail \| null\) \{\s*setRunId\(detail\?\.kind === 'run' \? detail\.id : null\);\s*setDetailTaskId\(detail\?\.kind === 'task' \? detail\.id : null\);\s*setItemId\(detail\?\.kind === 'item' \? detail\.id : null\);/, 'one detail at a time');
  // Keyed by the run and the step round it was asked to open on, so a new request re-applies its focus.
  assert.match(panel, /\{detailRunId \? \(\s*<WorkflowRunView key=\{`\$\{detailRunId\}:\$\{runFocus\?\.stepId \?\? ''\}:\$\{runFocus\?\.round \?\? ''\}`\} runId=\{detailRunId\} focus=\{runFocus\} actions=\{actions\} alerts=\{alerts\} onBack=\{backFromDetail\} \/>/);
  assert.match(panel, /<TaskDetailsView\s+key=\{activeTaskId\}\s+taskId=\{activeTaskId\}\s+historyIds=\{historyIds\}\s+actions=\{actions\}\s+alerts=\{alerts\}\s+onBack=\{backFromDetail\}/);
  assert.match(panel, /\) : openedItem \? \(\s*itemDetailView\(openedItem\)\s*\) : \(\s*<>\s*\{alerts\}/, 'the board only renders when no detail is open');
  const itemView = panel.match(/function itemDetailView[\s\S]*?\n  }\n/)[0];
  assert.equal((itemView.match(/onBack=\{backFromDetail\}/g) ?? []).length, 3, 'item details, and the run or session it turns into once started');
});

test('a not-started task\'s details follow it once started from there, and close when it is deleted', () => {
  const itemView = panel.match(/function itemDetailView[\s\S]*?\n  }\n/)[0];
  assert.match(itemView, /const detail = cardDetail\(card\);/);
  assert.match(itemView, /if \(detail\.kind === 'run'\) return <WorkflowRunView/);
  assert.match(itemView, /if \(detail\.kind === 'task'\) return <TaskDetailsView/);
  assert.match(panel, /const openedCard = detailItemId \? findCard<OpenTaskRow \| CompletedRow>\(detailColumns, detailItemId\) \?\? archivedDoneCard\(detailItemId\) : null;/);
  assert.match(panel, /const openedItem = openedCard && openedItemData \? \{ \.\.\.openedCard, item: openedItemData \} : null;/, 'no card or item, no details');
});

test('a session view is laid out like the task detail: a collapsible header with the actions, and no footer', () => {
  const view = sessionView.slice(sessionView.indexOf('export function TaskDetailsView'));
  assert.match(view, /<SessionHeader task=\{task\} historyIds=\{historyIds\} actions=\{actions\} alerts=\{alerts\} onBack=\{onBack\} \/>[\s\S]*<TaskSessionBody taskId=\{taskId\} historyIds=\{historyIds\} controls=\{controls\} \/>\}\s*<\/div>/, 'nothing after the session');
  assert.doesNotMatch(view, /Composer|ChatTextarea|border-t|InterimCommit|serverApi\./, 'no footer, and every action goes through useTaskActions');
  assert.match(view, /planning \? planningSessionTitle\(chain\) : firstLine\(task\.description\)/, 'a planning session shows its generated title');
  assert.match(view, /const active = task\?\.status === 'developing' \|\| task\?\.status === 'blocked';[\s\S]*<SessionRunButton key=\{active \? 'stop' : 'resume'\} taskId=\{task\.id\} stop=\{active\} actions=\{actions\} \/>/, 'Stop while running or waiting on input, Resume once paused');
  assert.match(view, /task\.kind === 'plan' && !task\.archived && !active/, 'planning completion is unavailable during a live or input-blocked turn');
  const run = view.slice(view.indexOf('function SessionRunButton'), view.indexOf('function SessionTitleForm'));
  assert.match(run, /await \(stop \? actions\.stopSession\(taskId\) : actions\.resumeSession\(taskId\)\)/);
  assert.match(run, /if \(!ok \|\| !stop\) setBusy\(false\);/, 'Stop stays busy until the session settles');
  assert.match(run, /\{stop \? \(busy \? 'Stopping…' : 'Stop session'\) : \(busy \? 'Resuming…' : 'Resume session'\)\}/);
  assert.doesNotMatch(view.slice(view.indexOf('function SessionHeader')), /resumeSession|Resume session/, 'no second Resume in the header');
  assert.match(view, /<HeaderIconButton label=\{expanded \? 'Hide session details' : 'Show session details'\} icon=\{expanded \? ChevronUp : ChevronDown\} expanded=\{expanded\}/);
  assert.match(view, /const \[expanded, setExpanded\] = useState\(false\);/, 'collapsed by default');
  assert.match(view, /\{expanded && \(\s*<SessionMore\s+task=\{task\}\s+description=\{taskDescriptionText\(task, planItem\)\}/);
  const more = view.slice(view.indexOf('function SessionMore'));
  assert.match(more, /\{active && \([\s\S]*actions\.stopSession\(task\.id\)[\s\S]*Stop task/);
  assert.match(more, /\{task\.kind !== 'plan' && !task\.archived && completesViaSession\(task\) && \([\s\S]*actions\.completeSession\(task\.id\)/);
  assert.match(more, /disabled=\{active\}[^\n]*actions\.archiveTasks\(\[task\.id\], !task\.archived\)\.then\(\(ok\) => ok && onBack\(\)\)/);
  assert.match(more, /task\.planItemId \? actions\.deleteItems\(\[task\.planItemId\]\) : actions\.deleteSession\(task\.id\)/, 'a plan item\'s Task is deleted with its item');
  assert.match(more, /<ConfirmDialog[\s\S]*void remove\(\)\.then\(\(ok\) => ok && onBack\(\)\)/, 'Delete asks first');
});

test('useTaskActions drives a session view: resume lands on the new Task, stop and complete go through the daemon', () => {
  assert.match(taskActions, /const reopenSession = useCallback\(async \(taskId: string\) => \{\s*const next = await serverApi\.resumeTerminalTask\(taskId\);\s*await refresh\(\);\s*openSession\(next\.id\);/);
  assert.match(taskActions, /if \(row\.latestTaskId\) await reopenSession\(row\.latestTaskId\);/, 'a card\'s Resume shares it');
  assert.match(taskActions, /resumeSession: \(taskId: string\) => guard\(\(\) => reopenSession\(taskId\)\)/);
  assert.match(taskActions, /stopSession: \(taskId: string\) => guard\(\(\) => storeCall\('taskActions', \(\) => stopTask\(taskId\)\)\)/);
  assert.match(taskActions, /completeSession: \(taskId: string\) => guard\(async \(\) => \{\s*await serverApi\.completeTerminalTask\(taskId\);\s*await refresh\(\);/);
});

test('a planning session\'s title is edited in place from the expanded section — the title only', () => {
  const view = sessionView.slice(sessionView.indexOf('export function TaskDetailsView'));
  assert.match(view, /onEditTitle=\{planning && !editingTitle \? \(\) => setEditingTitle\(true\) : undefined\}/, 'planning sessions only');
  assert.match(view, /\{onEditTitle && \([\s\S]*?<Pencil aria-hidden="true" \/> Edit title/);
  assert.match(view, /\{editingTitle \? \(\s*<SessionTitleForm name=\{planningSessionName\(chain\)\} onSave=\{\(next\) => void rename\(next\)\} onCancel=\{\(\) => setEditingTitle\(false\)\} \/>/, 'edits the name, without its session number');
  assert.match(view, /if \(await actions\.renameSession\(task\.id, title\)\) setEditingTitle\(false\);/, 'a refusal keeps the form open, with the alert under the header');
  const form = sessionView.slice(sessionView.indexOf('function SessionTitleForm'), sessionView.indexOf('function SessionHeader'));
  assert.match(form, /if \(trimmed\) onSave\(trimmed\);/);
  assert.match(form, /if \(event\.key === 'Escape'\) onCancel\(\);/);
  assert.match(form, /maxLength=\{SESSION_TITLE_MAX_LENGTH\}/);
  assert.match(form, /disabled=\{!trimmed\}>Save/);
  assert.doesNotMatch(form, /Textarea|description/i, 'title only');
  assert.match(taskActions, /renameSession: \(taskId: string, title: string\) => guard\(\(\) => serverApi\.renameSession\(taskId, title\)\)/);
});
