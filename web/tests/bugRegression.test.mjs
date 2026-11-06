import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const bugs = await import('../src/lib/bugs.ts');
const runView = await import('../src/lib/workflowRunView.ts');
const { buildCompletedRows, buildOpenTaskRows } = await import('../src/lib/projectTasks.ts');
const { useWorldStore, mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

// Reporting a regression on a completed bug (task 22.001). The web has no render harness: the
// decisions are tested on the pure helpers, the store against the server stub, and the components
// by source pins. How the dialog looks and behaves in a browser is a manual check the person owns.

const AT = '2026-10-01T10:00:00.000Z';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PERSON = { kind: 'person' };
const SESSION = (sessionNumber) => ({ kind: 'report-session', sessionNumber });
const read = (relative) => readFile(new URL(`../src/${relative}`, import.meta.url), 'utf8');

const attributes = (patch = {}) => ({
  severity: null, infoStatus: 'enough', introducedBy: null, suspectedLocation: null, foundWhileWorkingOn: null,
  reportSessionNumber: null, testRef: null, groupOrder: null, regressions: [], ...patch,
});
const item = (id, patch = {}) => ({
  id, projectId: 'p1', title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [],
  executorId: null, createdAt: AT, updatedAt: AT, ...patch,
});
const bug = (id, patch = {}, bugPatch = {}) => item(id, { type: 'bug', bug: attributes(bugPatch), ...patch });

// ---- Pure helpers ----

test('U27 only a completed bug (archived too) can be reported; a task and every other state cannot', () => {
  assert.equal(bugs.canReportRegression(bug('a', { status: 'done' })), true);
  assert.equal(bugs.canReportRegression(bug('a', { status: 'done', archived: true })), true);
  for (const status of ['pending', 'developing', 'blocked', 'failed', 'stopped']) assert.equal(bugs.canReportRegression(bug('a', { status })), false, status);
  assert.equal(bugs.canReportRegression(item('t', { status: 'done' })), false, 'a plain task');
});

test('U25 regressions list newest first, and equal timestamps keep the later-recorded one first', () => {
  const list = [
    { reason: 'first', reportedAt: '2026-10-01T10:00:00.000Z', reporter: PERSON },
    { reason: 'tie-a', reportedAt: '2026-10-02T10:00:00.000Z', reporter: PERSON },
    { reason: 'tie-b', reportedAt: '2026-10-02T10:00:00.000Z', reporter: SESSION(2) },
    { reason: 'latest', reportedAt: '2026-10-03T10:00:00.000Z', reporter: PERSON },
  ];
  assert.deepEqual(bugs.regressionsNewestFirst(bug('a', {}, { regressions: list })).map((entry) => entry.reason), ['latest', 'tie-b', 'tie-a', 'first']);
  assert.deepEqual(list.map((entry) => entry.reason), ['first', 'tie-a', 'tie-b', 'latest'], 'the stored order is not changed');
  assert.deepEqual(bugs.regressionsNewestFirst(bug('a')), []);
  assert.deepEqual(bugs.regressionsNewestFirst(item('t')), [], 'a task has none');
});

test('U26 the "Regressed ×N" badge shows only from one regression up; a legacy bug shows none', () => {
  assert.equal(bugs.regressedBadgeLabel(0), null);
  assert.equal(bugs.regressedBadgeLabel(1), 'Regressed ×1');
  assert.equal(bugs.regressedBadgeLabel(2), 'Regressed ×2');
  const entry = { reason: 'r', reportedAt: AT, reporter: PERSON };
  assert.equal(bugs.bugCardInfo(bug('a', {}, { regressions: [entry, entry] }), new Set()).regressedLabel, 'Regressed ×2');
  assert.equal(bugs.bugCardInfo(bug('a'), new Set()).regressedLabel, null);
  const legacy = item('old', { type: 'bug', bug: { ...attributes(), regressions: undefined } });
  assert.equal(bugs.bugCardInfo(legacy, new Set()).regressedLabel, null, 'a stored bug without the list reads as none');
  assert.equal(bugs.bugCardInfo(item('t'), new Set()), undefined, 'a task has no bug info at all');
});

test('C10 U09 the web reads a bug without a regressions list as empty and drops unreadable entries', () => {
  assert.deepEqual(bugs.readBugAttributes({}).regressions, []);
  assert.deepEqual(bugs.readBugAttributes(null).regressions, []);
  assert.deepEqual(bugs.readBugAttributes({ regressions: 'x' }).regressions, []);
  const read = bugs.readBugAttributes({ regressions: [
    { reason: 'a', reportedAt: AT, reporter: PERSON },
    { reason: 'b', reportedAt: AT, reporter: SESSION(4) },
    { reason: 5, reportedAt: AT, reporter: PERSON },
    { reason: 'c', reportedAt: AT, reporter: { kind: 'robot' } },
    { reason: 'd', reportedAt: AT, reporter: { kind: 'report-session', sessionNumber: 'x' } },
    null,
  ] });
  assert.deepEqual(read.regressions.map((entry) => entry.reason), ['a', 'b']);
});

test('U28 the reporter reads "You" for the person and "Bug report session N" for a session', () => {
  assert.equal(bugs.regressionReporterLabel(PERSON), 'You');
  assert.equal(bugs.regressionReporterLabel(SESSION(7)), 'Bug report session 7');
});

test('U29 the date label is the day for a valid time, and "Unknown date" rather than "Invalid Date" for an unreadable one', () => {
  assert.equal(bugs.regressionDateLabel('1970-01-01T00:00:00.000Z'), '1970-01-01');
  assert.equal(bugs.regressionDateLabel('2026-10-17T23:59:59.999Z'), '2026-10-17');
  for (const bad of ['', 'yesterday', 'NaN']) assert.equal(bugs.regressionDateLabel(bad), 'Unknown date', bad);
});

test('U30 Submit needs a reason that is non-blank and at most 20,000 characters after trimming; the counter shows the raw length', () => {
  assert.equal(bugs.isRegressionReasonValid(''), false);
  assert.equal(bugs.isRegressionReasonValid('   \n\t'), false);
  assert.equal(bugs.isRegressionReasonValid('x'), true);
  assert.equal(bugs.isRegressionReasonValid('x'.repeat(20_000)), true);
  assert.equal(bugs.isRegressionReasonValid('x'.repeat(20_001)), false);
  assert.equal(bugs.isRegressionReasonValid(` ${'x'.repeat(20_000)} `), true, 'padding is not counted');
  assert.equal(bugs.REGRESSION_REASON_MAX, 20_000);
  assert.equal(bugs.regressionCounterLabel(''), '0 / 20,000');
  assert.equal(bugs.regressionCounterLabel('x'.repeat(1234)), '1,234 / 20,000');
});

test('U31 C09 round 2 is numbered after the rounds a step had in earlier runs, in the list and on the stepper badge', () => {
  const run = { regression: { roundOffsets: { rca: 1, fix: 2 } } };
  assert.equal(runView.stepRoundOffset(run, 'rca'), 1);
  assert.equal(runView.stepRoundOffset(run, 'fix'), 2);
  assert.equal(runView.stepRoundOffset(run, 'new-step'), 0, 'a step added since is on its first round');
  assert.equal(runView.stepRoundOffset({}, 'rca'), 0, 'an ordinary run has no offset');
  const rounds = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, round: i + 1 }));
  assert.equal(runView.stageRoundBadge(rounds(1), 1), 'Round 2', 'the first round of a regression run reads as round 2');
  assert.equal(runView.stageRoundBadge(rounds(2), 1), 'Round 3');
  assert.equal(runView.stageRoundBadge(rounds(1), 0), null, 'an ordinary first round has no badge');
  assert.equal(runView.stageRoundBadge(rounds(2)), 'Round 2/2', 'an ordinary loop keeps its badge');
  assert.equal(runView.stageRoundBadge([], 2), null, 'a stage that has not started has none');
});

test('C09 the round list shows the earlier runs\' rounds first (read-only), then this run\'s numbered after them', () => {
  const stepRun = (id, round, extra = {}) => ({ id, runId: 'r', stepId: 'rca', round, ...extra });
  const stage = {
    rounds: [stepRun('c1', 1), stepRun('c2', 2)],
    earlierRounds: [stepRun('e1', 1, { displayRound: 1 }), stepRun('e2', 1, { displayRound: 2 })],
  };
  const entries = runView.roundEntries(stage, 2);
  assert.deepEqual(entries.map((entry) => [entry.round.id, entry.label, entry.earlier]), [
    ['e1', 'Round 1', true], ['e2', 'Round 2', true], ['c1', 'Round 3', false], ['c2', 'Round 4', false],
  ]);
  assert.deepEqual(runView.roundEntries({ rounds: [stepRun('c1', 1), stepRun('c2', 2)] }, 0).map((entry) => entry.label), ['Round 1', 'Round 2'], 'an ordinary run is unchanged');
  const stages = runView.buildRunStages({ steps: [{ step: { id: 'rca', name: 'RCA' }, rounds: [], earlierRounds: stage.earlierRounds }, { step: { id: 'fix', name: 'Fix' }, rounds: [] }] });
  assert.equal(stages[0].earlierRounds.length, 2);
  assert.equal('earlierRounds' in stages[1], false, 'a step with none carries none');
});

test('C11 a reopened bug moves from Completed to Running; once it completes again it is back in Completed', () => {
  const done = bug('a', { status: 'done' });
  const open = (items) => buildOpenTaskRows({ items, tasksById: {}, showArchived: false, now: NOW }).map((row) => row.id);
  const completed = (items) => buildCompletedRows({ items, taskIds: [], tasksById: {}, now: NOW }).map((row) => row.id);
  assert.deepEqual(open([done]), []);
  assert.deepEqual(completed([done]), ['a']);
  const reopened = { ...done, status: 'developing', bug: attributes({ regressions: [{ reason: 'r', reportedAt: AT, reporter: PERSON }] }) };
  assert.deepEqual(open([reopened]), ['a'], 'Running');
  assert.deepEqual(completed([reopened]), []);
  assert.deepEqual(completed([{ ...reopened, status: 'done' }]), ['a'], 'Completed again');
});

// ---- Store against the stub ----

let project;

async function setUp() {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], tasksById: {}, taskIdsByProject: {}, planByProject: {}, workflowRunsByProject: {}, ...CLEAN_ERROR_STATE });
  await useWorldStore.getState().addProject('Regression');
  project = useWorldStore.getState().projects.at(-1);
  await useWorldStore.getState().loadPlan(project.id);
  return stub;
}

function seed(stub, patch = {}) {
  const saved = { ...bug('b1', { status: 'done', title: 'B.001: Crash', description: 'ORIGINAL' }), projectId: project.id, milestoneId: null, ...patch };
  stub.planItems.set(saved.id, saved);
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: structuredClone(saved) }));
  return saved;
}

const itemNow = (id) => useWorldStore.getState().planByProject[project.id].items.find((entry) => entry.id === id);

test('C07 the client posts { reason } to the bug route; the item leaves Completed and carries the new reason', async () => {
  const stub = await setUp();
  seed(stub);
  const note = await useWorldStore.getState().reportRegression(project.id, 'b1', 'Still crashes on save.');
  assert.equal(note, '');
  assert.deepEqual(stub.regressionRequests, [{ planItemId: 'b1', reason: 'Still crashes on save.' }]);
  const after = itemNow('b1');
  assert.equal(after.status, 'developing');
  assert.equal(after.title, 'B.001: Crash');
  assert.equal(after.description, 'ORIGINAL');
  assert.deepEqual(after.bug.regressions.map((entry) => entry.reason), ['Still crashes on save.']);
  const runs = useWorldStore.getState().workflowRunsByProject[project.id] ?? [];
  assert.equal(runs.length, 1, 'the new run is known at once');
  assert.deepEqual(runs[0].regression, { roundOffsets: { development: 1 } });
});

test('C07 a refused request rejects with the daemon\'s message and changes nothing (the dialog shows it and stays open)', async () => {
  const stub = await setUp();
  seed(stub);
  stub.refuseRegressions('Project "p" is at its task limit (1 of 1).');
  await assert.rejects(() => useWorldStore.getState().reportRegression(project.id, 'b1', 'Again.'), /at its task limit/);
  assert.equal(itemNow('b1').status, 'done');
  assert.deepEqual(itemNow('b1').bug.regressions, []);
  stub.refuseRegressions('');
  await assert.rejects(() => useWorldStore.getState().reportRegression(project.id, 'b1', '   '), /reason is required/);
  seed(stub, { id: 'b2', status: 'developing' });
  await assert.rejects(() => useWorldStore.getState().reportRegression(project.id, 'b2', 'Again.'), /is not completed/);
  await assert.rejects(() => useWorldStore.getState().reportRegression(project.id, 'nope', 'Again.'), /not found/);
});

test('C08 a second regression keeps both, and the store applies a live plan-item event that carries the list', async () => {
  const stub = await setUp();
  seed(stub);
  await useWorldStore.getState().reportRegression(project.id, 'b1', 'First.');
  stub.planItems.get('b1').status = 'done';
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: structuredClone(stub.planItems.get('b1')) }));
  await useWorldStore.getState().reportRegression(project.id, 'b1', 'Second.');
  assert.deepEqual(itemNow('b1').bug.regressions.map((entry) => entry.reason), ['First.', 'Second.']);
  assert.deepEqual(bugs.regressionsNewestFirst(itemNow('b1')).map((entry) => entry.reason), ['Second.', 'First.']);
  assert.equal(bugs.bugCardInfo(itemNow('b1'), new Set()).regressedLabel, 'Regressed ×2');
  // A live event from another client for the same bug replaces it, list included.
  const external = { ...stub.planItems.get('b1'), bug: { ...stub.planItems.get('b1').bug, regressions: [...stub.planItems.get('b1').bug.regressions, { reason: 'From a session.', reportedAt: AT, reporter: SESSION(3) }] } };
  useWorldStore.setState((state) => mergeWorkerEvent(state, { type: 'planItem', planItem: structuredClone(external) }));
  assert.equal(itemNow('b1').bug.regressions.at(-1).reason, 'From a session.');
  assert.deepEqual(itemNow('b1').bug.regressions.at(-1).reporter, SESSION(3));
});

// ---- Source pins ----

test('C01 the detail view offers "Report regression" only behind canReportRegression', async () => {
  const source = await read('ui/project-popup/DetailHeader.tsx');
  assert.match(source, /\{canReportRegression\(item\) && \(\s*<Button[^>]*onClick=\{\(\) => setReporting\(true\)\}[^]*?Report regression/);
  assert.equal(source.split('Report regression').length - 1, 1, 'one button');
});

test('C02 C03 C04 the dialog mirrors the reject dialog: a reason only, no agent choice, an in-dialog alert, Cancel, "Submitting…", fresh-branch and resume lines', async () => {
  const source = await read('ui/project-popup/TaskDialogs.tsx');
  const start = source.indexOf('export function ReportRegressionDialog');
  const dialog = source.slice(start, source.indexOf('export function StartTaskDialog', start) > 0 ? source.indexOf('/**\n * The options a task starts with', start) : undefined);
  assert.match(dialog, /<Textarea[^]*placeholder="Reason \(required\)"/);
  assert.match(dialog, /<Alert variant="destructive" role="alert"><AlertDescription>\{error\}<\/AlertDescription><\/Alert>/);
  assert.match(dialog, />Cancel<\/Button>/);
  assert.match(dialog, /pending \? 'Submitting…' : 'Submit'/);
  assert.match(dialog, /const message = await onSubmit\(reason\.trim\(\)\);\s*if \(message\) \{\s*setError\(message\);\s*setPending\(false\);/, 'a failure shows in the dialog and keeps it open');
  assert.doesNotMatch(dialog, /<Select|executorId|AgentSelect|ExecutorSelect/, 'no agent choice: each step keeps the agent it had');
  assert.match(dialog, /Each step resumes its earlier conversation with the same agent/);
  assert.match(dialog, /Round 2 starts on a new branch from the base branch, so an earlier fix that was not merged is not on it/);
  assert.match(dialog, /This bug is archived\. Reporting a regression returns it to the board\./);
  assert.match(dialog, /disabled=\{pending \|\| !isRegressionReasonValid\(reason\)\}/);
  const header = await read('ui/project-popup/DetailHeader.tsx');
  assert.match(header, /await actions\.reportRegression\(item\.id, reason\);\s*setReporting\(false\);\s*return '';/, 'success closes the dialog');
  assert.match(header, /return \(failure as Error\)\.message;/);
});

test('C05 the Regressions section lists newest first with date and reporter, has no edit or delete control, and is absent when empty', async () => {
  const source = await read('ui/project-popup/DetailHeader.tsx');
  const start = source.indexOf('function BugRegressions');
  const section = source.slice(start, source.indexOf('/** The expanded section', start));
  assert.match(section, /regressionsNewestFirst\(item\)/);
  assert.match(section, /if \(regressions\.length === 0\) return null;/);
  assert.match(section, /regressionDateLabel\(regression\.reportedAt\)[^]*regressionReporterLabel\(regression\.reporter\)/);
  assert.doesNotMatch(section, /<Button|<button|onClick|Edit|Delete/, 'append-only: nothing to edit or remove');
  assert.match(source, /<BugRegressions item=\{item\} \/>/);
});

test('C06 the card shows the badge from the card info, only when there is one', async () => {
  const source = await read('ui/project-popup/BugCardParts.tsx');
  assert.match(source, /\{bug\.regressedLabel && <Badge variant="warning">\{bug\.regressedLabel\}<\/Badge>\}/);
});

test('C09 the run view numbers rounds after the step\'s earlier ones and keeps the round list for a single round of a regression run', async () => {
  const view = await read('ui/project-popup/WorkflowRunView.tsx');
  assert.match(view, /const roundOffset = stepRoundOffset\(run, stage\.id\);/);
  assert.match(view, /const entries = roundEntries\(stage, roundOffset\);/);
  assert.match(view, /\(entries\.length > 1 \|\| roundOffset > 0\) && \(/);
  assert.match(view, /<RoundDetail key=\{selected\.round\.id\}[^>]*earlier=\{selected\.earlier\} \/>/);
  assert.match(view, /const view = earlier \? null : quickLookViewFor\(stage\.step\);/, 'an earlier run\'s round has no live working copy to show');
  const stepper = await read('ui/project-popup/WorkflowRunStepper.tsx');
  assert.match(stepper, /stageRoundBadge\(stage\.rounds, stepRoundOffset\(run, stage\.id\)\)/);
});

test('C10 the API client types the regressions list and the run\'s round offsets', async () => {
  const api = await read('lib/serverApi.ts');
  assert.match(api, /regression\?: \{ roundOffsets: Record<string, number> \};/);
  assert.match(api, /reportRegression: \(id: string, reason: string\)[^]*\/api\/plan-items\/\$\{id\}\/regression/);
  assert.match(await read('lib/bugs.ts'), /regressions: BugRegression\[\];/);
});
