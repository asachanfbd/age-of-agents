import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
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

const {
  buildRunStages,
  defaultSelectedStageId,
  stageStates,
  stageRoundBadge,
  defaultRoundIndex,
  runStatusBadge,
  isRejectReasonValid,
  hasRejectDraft,
  canSendRejection,
  isRejectDraftStale,
  rejectKeyAction,
  sendApprovalDecision,
  runActionError,
  visibleRunActions,
  hasPrCreationError,
  embeddedHtmlOutput,
  stageSpentMs,
  stageTimeLabel,
  roundPanes,
  hasRoundSummary,
  showsSkipReasonLine,
  initialRoundMode,
  roundStartMode,
  followRoundMode,
  followRoundIndex,
  stageSelectionFor,
  hasProgress,
  checklistCounts,
  checklistPercent,
  estimateStalenessLabel,
} = await import('../src/lib/workflowRunView.ts');

const step = (id, name, patch = {}) => ({ id, name, agentId: 'agent-1', instructions: '', canEditCode: true, requiresApproval: false, ...patch });

const stepRun = (id, stepId, round, patch = {}) => ({
  id,
  runId: 'run-1',
  stepId,
  round,
  taskId: `task-${id}`,
  status: 'done',
  summary: null,
  outputs: [],
  verdict: null,
  skippedReason: null,
  approval: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  completedAt: '2026-09-26T00:05:00.000Z',
  ...patch,
});

const run = (patch = {}) => ({
  id: 'run-1',
  projectId: 'p1',
  planItemId: 'i1',
  workflowId: 'wf1',
  workflowSnapshot: { id: 'wf1', name: 'Software development', description: '', enabled: true, steps: [step('ui', 'UI Planning'), step('dev', 'Development')] },
  status: 'running',
  currentStepId: null,
  baseBranch: 'main',
  branch: 'run-1-branch',
  executorId: 'exec-claude',
  prUrl: null,
  completionReport: null,
  attentionReason: null,
  loopRoundAllowance: 0,
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
  completedAt: null,
  ...patch,
});

const detail = (runPatch = {}, steps = [{ step: step('ui', 'UI Planning'), rounds: [stepRun('sr1', 'ui', 1)] }, { step: step('dev', 'Development'), rounds: [stepRun('sr2', 'dev', 1)] }]) => ({
  run: run(runPatch),
  steps,
});

test('buildRunStages lists only the configured steps, then Complete', () => {
  const stages = buildRunStages(detail());
  assert.deepEqual(stages.map((s) => [s.id, s.name, s.kind]), [
    ['ui', 'UI Planning', 'step'],
    ['dev', 'Development', 'step'],
    ['complete', 'Complete', 'complete'],
  ]);
});

test('buildRunStages carries each step\'s full round list', () => {
  const rounds = [stepRun('sr1', 'ui', 1), stepRun('sr2', 'ui', 2)];
  const stages = buildRunStages(detail({}, [{ step: step('ui', 'UI Planning'), rounds }]));
  assert.equal(stages[0].rounds, rounds);
});

test('defaultSelectedStageId picks the stage matching currentStepId', () => {
  assert.equal(defaultSelectedStageId(detail({ currentStepId: 'dev' })), 'dev');
});

test('defaultSelectedStageId falls back to Complete when currentStepId is null and the run has not failed', () => {
  assert.equal(defaultSelectedStageId(detail({ currentStepId: null, status: 'completing' })), 'complete');
  assert.equal(defaultSelectedStageId(detail({ currentStepId: null, status: 'awaiting-approval' })), 'complete');
});

test('defaultSelectedStageId falls back to the first step when currentStepId is null and the run failed', () => {
  assert.equal(defaultSelectedStageId(detail({ currentStepId: null, status: 'failed' })), 'ui');
});

test('defaultSelectedStageId falls back to Complete for a failed run with no steps', () => {
  assert.equal(defaultSelectedStageId(detail({ currentStepId: null, status: 'failed' }, [])), 'complete');
});

test('defaultSelectedStageId falls back the same way when currentStepId no longer matches any stage', () => {
  assert.equal(defaultSelectedStageId(detail({ currentStepId: 'no-such-step', status: 'running' })), 'complete');
  assert.equal(defaultSelectedStageId(detail({ currentStepId: 'no-such-step', status: 'failed' })), 'ui');
});

test('stageStates marks everything before the current step done, it current, the rest pending', () => {
  const stages = buildRunStages(detail({ currentStepId: 'dev' }));
  assert.deepEqual(stageStates(stages, run({ currentStepId: 'dev', status: 'awaiting-approval' })), ['done', 'current', 'pending']);
});

const skippedAtStart = (id, stepId) => stepRun(id, stepId, 1, {
  taskId: null, status: 'skipped', skippedReason: 'Skipped when the task was started', summary: 'Skipped: Skipped when the task was started',
});

const fourSteps = (rounds) => buildRunStages({ steps: [
  { step: step('ui', 'UI Planning'), rounds: rounds.ui ?? [] },
  { step: step('plan', 'Test Case Planning'), rounds: rounds.plan ?? [] },
  { step: step('dev', 'Development'), rounds: rounds.dev ?? [] },
  { step: step('signoff', 'Human Code Review', { requiresApproval: true }), rounds: rounds.signoff ?? [] },
] });

test('stageStates reads a skipped step as skipped, before or after the current step, and never Complete', () => {
  const stages = fourSteps({
    ui: [skippedAtStart('s1', 'ui')], plan: [skippedAtStart('s2', 'plan')],
    dev: [stepRun('s3', 'dev', 1, { status: 'running' })], signoff: [skippedAtStart('s4', 'signoff')],
  });
  assert.deepEqual(stageStates(stages, run({ currentStepId: 'dev' })), ['skipped', 'skipped', 'current', 'skipped', 'pending']);
  assert.deepEqual(stageStates(stages, run({ currentStepId: null, status: 'completing' })), ['skipped', 'skipped', 'done', 'skipped', 'current']);
});

test('stageStates also reads a step the agent skipped as skipped, but a skipped round followed by a newer one by its latest round', () => {
  const stages = fourSteps({
    ui: [stepRun('s1', 'ui', 1, { status: 'skipped', skippedReason: 'No UI.' })],
    plan: [stepRun('s2', 'plan', 1, { status: 'skipped', skippedReason: 'x' }), stepRun('s3', 'plan', 2)],
  });
  assert.deepEqual(stageStates(stages, run({ currentStepId: 'dev' })), ['skipped', 'done', 'current', 'pending', 'pending']);
});

test('a skipped stage shows no time label, and its round only a Summary pane', () => {
  const [ui] = fourSteps({ ui: [skippedAtStart('s1', 'ui')] });
  assert.equal(stageTimeLabel(ui, 'skipped', run(), Date.now()), null);
  assert.deepEqual(roundPanes(ui.rounds[0]), { summary: true, output: false });
  assert.equal(hasRoundSummary(ui.rounds[0]), true);
});

test('defaultSelectedStageId opens on the first step that runs, not on steps skipped at start', () => {
  const steps = [
    { step: step('ui', 'UI Planning'), rounds: [skippedAtStart('s1', 'ui')] },
    { step: step('dev', 'Development'), rounds: [stepRun('s2', 'dev', 1, { status: 'running' })] },
  ];
  assert.equal(defaultSelectedStageId(detail({ currentStepId: 'dev' }, steps)), 'dev');
});

test('visibleRunActions offers nothing on a selected skipped stage', () => {
  const [ui] = fourSteps({ ui: [skippedAtStart('s1', 'ui')] });
  for (const status of ['running', 'awaiting-approval']) {
    const actions = visibleRunActions(run({ status, currentStepId: 'dev' }), ui);
    assert.equal(actions.approveRequestChanges, false);
    assert.equal(actions.loopDecision, false);
  }
});

test('the stepper draws a skipped stage dashed and muted, with a "Skipped" suffix', async () => {
  const stepper = await readFile(new URL('../src/ui/project-popup/WorkflowRunStepper.tsx', import.meta.url), 'utf8');
  assert.match(stepper, /skipped: 'border-dashed border-muted-foreground\/50 bg-transparent text-muted-foreground'/);
  assert.match(stepper, /\{state === 'skipped' && <span[^>]*>Skipped<\/span>\}/);
});

test('stageStates reads a null currentStepId as Complete when the run has not failed', () => {
  const stages = buildRunStages(detail());
  assert.deepEqual(stageStates(stages, run({ currentStepId: null, status: 'completing' })), ['done', 'done', 'current']);
});

test('stageStates reads a null currentStepId as the first step when the run failed before any step started', () => {
  const stages = buildRunStages(detail());
  assert.deepEqual(stageStates(stages, run({ currentStepId: null, status: 'failed' })), ['current', 'pending', 'pending']);
});

test('a run record still carrying the old requirement stage/source shows no requirement stage', () => {
  const legacy = { ...detail(), requirementStage: { kind: 'manual' }, run: { ...run(), requirementSource: { kind: 'manual' } } };
  const stages = buildRunStages(legacy);
  assert.ok(stages.every((s) => s.kind !== 'requirement' && !/requirement/i.test(s.name)));
  assert.deepEqual(stages.map((s) => s.id), ['ui', 'dev', 'complete']);
});

test('stageRoundBadge is null for zero or one round, "Round N/N" for more', () => {
  assert.equal(stageRoundBadge([]), null);
  assert.equal(stageRoundBadge([stepRun('sr1', 'ui', 1)]), null);
  assert.equal(stageRoundBadge([stepRun('sr1', 'ui', 1), stepRun('sr2', 'ui', 2)]), 'Round 2/2');
  assert.equal(stageRoundBadge([stepRun('sr1', 'ui', 1), stepRun('sr2', 'ui', 2), stepRun('sr3', 'ui', 3)]), 'Round 3/3');
});

test('defaultRoundIndex is the latest round\'s index, or 0 with none yet', () => {
  assert.equal(defaultRoundIndex([]), 0);
  assert.equal(defaultRoundIndex([stepRun('sr1', 'ui', 1)]), 0);
  assert.equal(defaultRoundIndex([stepRun('sr1', 'ui', 1), stepRun('sr2', 'ui', 2)]), 1);
});

const progress = (patch = {}) => ({ checklist: [], currentActivity: null, estimate: null, estimatedAt: null, ...patch });
const checklistItem = (text, state, note = null) => ({ text, state, note });

test('initialRoundMode: a running round always opens split', () => {
  assert.equal(initialRoundMode(stepRun('a', 'dev', 1, { status: 'running' })), 'split');
});

test('initialRoundMode: a settled round with summary content (or outputs) opens on Summary', () => {
  assert.equal(initialRoundMode(stepRun('a', 'dev', 1, { status: 'done', summary: 'Did it' })), 'summary');
  assert.equal(initialRoundMode(stepRun('a', 'dev', 1, { status: 'done', summary: null, outputs: [{ name: 'x', format: 'markdown', content: '# x' }] })), 'summary');
  assert.equal(initialRoundMode(stepRun('a', 'dev', 1, { status: 'done', verdict: 'pass' })), 'summary');
  assert.equal(initialRoundMode(stepRun('a', 'dev', 1, { status: 'skipped', skippedReason: 'No UI.', summary: 'Skipped: No UI.' })), 'summary');
});

test('initialRoundMode: a settled round (failed/stopped) with no summary content but a session opens on Session', () => {
  assert.equal(initialRoundMode(stepRun('a', 'dev', 1, { status: 'failed', summary: null, taskId: 'task-a' })), 'session');
  assert.equal(initialRoundMode(stepRun('a', 'dev', 1, { status: 'stopped', summary: null, taskId: 'task-a' })), 'session');
});

test('initialRoundMode: a settled round with neither summary content nor a session (skipped at start) falls back to Summary, unchanged', () => {
  assert.equal(initialRoundMode(stepRun('a', 'dev', 1, { status: 'failed', summary: null, taskId: null })), 'summary');
});

test('roundStartMode: the mode a round opens on (initialRoundMode, with split shown as Session); an earlier run\'s round is always Summary', () => {
  assert.equal(roundStartMode(stepRun('a', 'dev', 1, { status: 'running' }), false), 'session');
  assert.equal(roundStartMode(stepRun('a', 'dev', 1, { status: 'done', summary: 'Did it' }), false), 'summary');
  assert.equal(roundStartMode(stepRun('a', 'dev', 1, { status: 'failed', summary: null, taskId: 'task-a' }), false), 'session');
  assert.equal(roundStartMode(stepRun('a', 'dev', 1, { status: 'failed', summary: null, taskId: null }), false), 'summary');
  assert.equal(roundStartMode(stepRun('a', 'dev', 1, { status: 'running' }), true), 'summary');
});

const htmlOutput = { name: 'Mockup', format: 'html', content: '<p>UI</p>' };
const followCases = [
  // [label, prevStatus, round patch, current, manual, earlier, expected]
  ['running → awaiting-approval with an HTML output shows the Summary (the produced UI)', 'running', { status: 'awaiting-approval', outputs: [htmlOutput] }, 'session', false, false, 'summary'],
  ['running → awaiting-approval with a summary shows the Summary', 'running', { status: 'awaiting-approval', summary: 'Ready' }, 'session', false, false, 'summary'],
  ['running → done shows the Summary', 'running', { status: 'done', summary: 'Did it' }, 'session', false, false, 'summary'],
  ['running → skipped shows the Summary', 'running', { status: 'skipped', skippedReason: 'No UI.', summary: 'Skipped: No UI.' }, 'session', false, false, 'summary'],
  ['running → failed with summary content shows the Summary', 'running', { status: 'failed', summary: 'Broke' }, 'session', false, false, 'summary'],
  ['running → stopped with summary content shows the Summary', 'running', { status: 'stopped', verdict: 'issues' }, 'session', false, false, 'summary'],
  ['running → failed with no summary but a session stays on Session', 'running', { status: 'failed', summary: null, taskId: 'task-a' }, 'session', false, false, 'session'],
  ['awaiting-approval → changes-requested (with the approval) shows the Summary', 'awaiting-approval', { status: 'changes-requested', approval: { decision: 'rejected', reason: 'Redo' } }, 'session', false, false, 'summary'],
  ['an unchanged status (progress updates while running) keeps the current mode', 'running', { status: 'running', summary: 'Partial' }, 'session', false, false, 'session'],
  ['an unchanged status keeps Summary too', 'done', { status: 'done', summary: 'Did it' }, 'summary', false, false, 'summary'],
  ['a manual choice is kept across a status change (Session)', 'running', { status: 'done', summary: 'Did it' }, 'session', true, false, 'session'],
  ['a manual choice is kept across a status change (Quick look)', 'running', { status: 'awaiting-approval', outputs: [htmlOutput] }, 'quickLook', true, false, 'quickLook'],
  ['an earlier run\'s round always moves to Summary on a change', 'running', { status: 'failed', summary: null, taskId: 'task-a' }, 'session', false, true, 'summary'],
];
for (const [label, prevStatus, patch, current, manual, earlier, expected] of followCases) {
  test(`followRoundMode: ${label}`, () => {
    assert.equal(followRoundMode({ prevStatus, round: stepRun('a', 'ui', 1, patch), earlier, current, manual }), expected);
  });
}

const indexCases = [
  // [label, prevCount, nextCount, index, manual, expected]
  ['a new round with no manual pick selects the latest', 1, 2, 0, false, 1],
  ['a new round after the owner pinned an earlier round keeps it', 2, 3, 0, true, 0],
  ['an unchanged round count keeps the selection', 2, 2, 0, false, 0],
  ['the first round of a not-yet-started stage selects it', 0, 1, 0, false, 0],
  ['counts include an earlier run\'s rounds, so the latest index is past them', 3, 4, 2, false, 3],
  ['a shrinking list (never expected) keeps the selection', 3, 2, 1, false, 1],
];
for (const [label, prevCount, nextCount, index, manual, expected] of indexCases) {
  test(`followRoundIndex: ${label}`, () => {
    assert.equal(followRoundIndex({ prevCount, nextCount, index, manual }), expected);
  });
}

test('stageSelectionFor: clicking the current stage follows the run (null); clicking another stage pins it', () => {
  assert.equal(stageSelectionFor('dev', 'dev'), null);
  assert.equal(stageSelectionFor('ui', 'dev'), 'ui');
  assert.equal(stageSelectionFor('complete', 'dev'), 'complete');
});

test('the open run view follows live round updates instead of fixing its view state at mount (B.032)', async () => {
  const source = await readFile(new URL('../src/ui/project-popup/WorkflowRunView.tsx', import.meta.url), 'utf8');
  const roundDetail = source.slice(source.indexOf('function RoundDetail('), source.indexOf('function RoundProgressSplit('));
  assert.match(roundDetail, /useState<RoundViewMode>\(\(\) => roundStartMode\(round, earlier\)\)/);
  assert.match(roundDetail, /if \(seenStatus !== round\.status\) \{[\s\S]*setMode\(followRoundMode\(\{ prevStatus: seenStatus, round, earlier, current: mode, manual: manualMode \}\)\)/, 'a status change re-derives the mode');
  assert.match(roundDetail, /const chooseMode = \(next: RoundViewMode\) => \{\s*setManualMode\(true\);\s*setMode\(next\);/, 'the owner\'s toggle marks the mode as manual');
  assert.doesNotMatch(roundDetail, /onChange=\{setMode\}/, 'no control sets the mode without marking it manual');

  const stageDetail = source.slice(source.indexOf('function StepStageDetail('), source.indexOf('function RoundDetail('));
  assert.match(stageDetail, /useState\(focusRound !== null\)/, 'a deep-linked round counts as pinned');
  assert.match(stageDetail, /if \(seenCount !== entries\.length\) \{[\s\S]*setRoundIndex\(followRoundIndex\(\{ prevCount: seenCount, nextCount: entries\.length, index: roundIndex, manual: manualRound \}\)\)/);
  assert.match(stageDetail, /onClick=\{\(\) => chooseRound\(index\)\}/);
  assert.match(stageDetail, /setManualRound\(index !== entries\.length - 1\)/, 'clicking the latest round goes back to following');

  assert.match(source, /onSelect=\{\(id\) => setSelectedStageId\(stageSelectionFor\(id, defaultSelectedStageId\(detail\)\)\)\}/);
  assert.doesNotMatch(source, /onSelect=\{setSelectedStageId\}/);
});

test('initialRoundMode\'s doc no longer describes an initial-only view', async () => {
  const lib = await readFile(new URL('../src/lib/workflowRunView.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(lib, /Deliberately decides only the \*initial\* view/);
});

test('hasProgress is false for progress absent/null, true once a checklist item, currentActivity or estimate exists', () => {
  assert.equal(hasProgress(stepRun('a', 'dev', 1, { progress: undefined })), false);
  assert.equal(hasProgress(stepRun('a', 'dev', 1, { progress: null })), false);
  assert.equal(hasProgress(stepRun('a', 'dev', 1, { progress: progress() })), false, 'an all-empty progress object still reads as none');
  assert.equal(hasProgress(stepRun('a', 'dev', 1, { progress: progress({ checklist: [checklistItem('Do x', 'pending')] }) })), true);
  assert.equal(hasProgress(stepRun('a', 'dev', 1, { progress: progress({ currentActivity: 'Working' }) })), true);
  assert.equal(hasProgress(stepRun('a', 'dev', 1, { progress: progress({ estimate: '~5m left' }) })), true);
});

test('checklistCounts: total includes skipped items, done never does, and an empty checklist is 0/0', () => {
  assert.deepEqual(checklistCounts([]), { total: 0, done: 0, skipped: 0 });
  assert.deepEqual(checklistCounts([checklistItem('a', 'pending'), checklistItem('b', 'done'), checklistItem('c', 'done'), checklistItem('d', 'skipped')]), { total: 4, done: 2, skipped: 1 });
  assert.deepEqual(checklistCounts([checklistItem('a', 'pending'), checklistItem('b', 'in-progress')]), { total: 2, done: 0, skipped: 0 });
});

test('checklistPercent is 0 for an empty checklist (never NaN/divide-by-zero), and done/total elsewhere', () => {
  assert.equal(checklistPercent({ done: 0, total: 0 }), 0);
  assert.equal(checklistPercent({ done: 3, total: 7 }), 43);
  assert.equal(checklistPercent({ done: 7, total: 7 }), 100);
});

test('estimateStalenessLabel reads "estimated N ago" from estimatedAt, and is null with no estimate given', () => {
  const now = new Date('2026-09-26T00:10:00.000Z');
  assert.equal(estimateStalenessLabel('2026-09-26T00:08:00.000Z', now), 'estimated 2m ago');
  assert.equal(estimateStalenessLabel('2026-09-26T00:12:00.000Z', now), 'estimated in 2m', 'a future estimate (clock skew) reads forward');
  assert.equal(estimateStalenessLabel(null, now), null);
});

test('runStatusBadge labels and colors every WorkflowRunStatus', () => {
  assert.deepEqual(runStatusBadge('running'), { label: 'Running', variant: 'success' });
  assert.deepEqual(runStatusBadge('awaiting-approval'), { label: 'Awaiting approval', variant: 'warning' });
  assert.deepEqual(runStatusBadge('needs-attention'), { label: 'Needs attention', variant: 'warning' });
  assert.deepEqual(runStatusBadge('completing'), { label: 'Completing', variant: 'success' });
  assert.deepEqual(runStatusBadge('completed'), { label: 'Completed', variant: 'success' });
  assert.deepEqual(runStatusBadge('failed'), { label: 'Failed', variant: 'soft-destructive' });
  assert.deepEqual(runStatusBadge('stopped'), { label: 'Stopped', variant: 'secondary' });
});

test('isRejectReasonValid requires a non-blank reason', () => {
  assert.equal(isRejectReasonValid(''), false);
  assert.equal(isRejectReasonValid('   \n'), false);
  assert.equal(isRejectReasonValid('fix the styling'), true);
});

function recordingCalls(result = true) {
  const calls = [];
  return {
    calls,
    api: {
      approve: async (...args) => { calls.push(['approve', ...args]); return result; },
      requestChanges: async (...args) => { calls.push(['requestChanges', ...args]); return result; },
    },
  };
}

test('sendApprovalDecision approves with no comment when there is no reject reason', async () => {
  const { calls, api } = recordingCalls();
  assert.equal(await sendApprovalDecision('run-1', null, api), true);
  assert.deepEqual(calls, [['approve', 'run-1']]);
});

test('sendApprovalDecision requests changes with the trimmed reject reason as the comment', async () => {
  const { calls, api } = recordingCalls();
  assert.equal(await sendApprovalDecision('run-1', '  please fix the styling \n', api), true);
  assert.deepEqual(calls, [['requestChanges', 'run-1', 'please fix the styling']]);
});

test('sendApprovalDecision passes a failed call through', async () => {
  const { api } = recordingCalls(false);
  assert.equal(await sendApprovalDecision('run-1', 'nope', api), false);
});

test('runActionError is empty on success and never reads lastError then', async () => {
  let reads = 0;
  assert.equal(await runActionError(async () => true, () => { reads += 1; return 'stale'; }), '');
  assert.equal(reads, 0);
});

test('runActionError returns the store error on failure, or a fallback when there is none', async () => {
  assert.equal(await runActionError(async () => false, () => 'Run is not awaiting approval'), 'Run is not awaiting approval');
  assert.equal(await runActionError(async () => false, () => null), 'Something went wrong.');
});

const runViewSource = await readFile(new URL('../src/ui/project-popup/WorkflowRunView.tsx', import.meta.url), 'utf8');
const autoGrowSource = await readFile(new URL('../src/ui/AutoGrowTextarea.tsx', import.meta.url), 'utf8');
const dialogsSource = await readFile(new URL('../src/ui/project-popup/TaskDialogs.tsx', import.meta.url), 'utf8');
const approvalBar = runViewSource.slice(runViewSource.indexOf('{visibility.approveRequestChanges && ('), runViewSource.indexOf('{visibility.loopDecision && ('));

test('the collapsed approval bar is a muted prompt plus Reject and Approve; the reason box shows only while rejecting', () => {
  assert.match(approvalBar, /text-muted-foreground">Waiting for your approval</);
  assert.match(approvalBar, /variant="outline" size="sm" disabled=\{pending !== null\} onClick=\{openRejectReason\}>Reject</, 'Reject expands the reason box');
  assert.match(approvalBar, /\{rejecting && \(\s*<div className="space-y-1">/, 'the reason box is conditional');
  assert.match(approvalBar, /sendApprovalDecision\(runId, null, approvalCalls\)/, 'Approve sends no comment');
  assert.match(approvalBar, /'Approving…' : 'Approve'/, 'Approve shows its pending state');
  assert.doesNotMatch(runViewSource, /approvalComment|approveButtonLabel/, 'the old comment box is gone');
});

test('the old RejectStepDialog and the "Reject this step?" popup are gone', () => {
  assert.doesNotMatch(dialogsSource + runViewSource, /RejectStepDialog|Reject this step\?|reject-step-reason/);
  assert.doesNotMatch(dialogsSource, /isRejectReasonValid/, 'nothing only the dialog used is left behind');
  assert.doesNotMatch(dialogsSource + runViewSource, /window\.prompt|\bprompt\(/, 'no browser prompt');
});

test('the expanded bar has a labelled reason box, Send rejection, Cancel and Approve; Reject is replaced', () => {
  assert.match(approvalBar, /<label htmlFor="run-reject-reason"[^>]*>Rejection reason<\/label>/);
  assert.match(approvalBar, /placeholder="Reason \(required\)"/);
  assert.match(approvalBar, /\{rejecting \? \(\s*<>\s*<Button[^>]*disabled=\{!canSendRejection\(rejectReason, pending !== null\)\}[^>]*onClick=\{\(\) => void sendRejection\(\)\}>/);
  assert.match(approvalBar, /'Sending…' : 'Send rejection'/);
  assert.match(approvalBar, /onClick=\{collapseRejectReason\}>Cancel</);
  assert.match(approvalBar, /\) : \(\s*<Button ref=\{rejectButtonRef\}[^>]*>Reject</, 'Reject shows only while collapsed');
  assert.match(approvalBar, /flex-wrap/, 'buttons wrap on narrow widths');
});

test('sending disables the reason box; failures use the bar alert and keep the text', () => {
  assert.match(approvalBar, /disabled=\{pending === 'reject'\}/);
  assert.match(runViewSource, /\{error && \(\s*<Alert variant="destructive" role="alert">/, 'the bar alert is shared with Approve');
  assert.match(runViewSource, /const message = await submit\('reject', \(\) => sendApprovalDecision\(runId, rejectReason, approvalCalls\)\);\s*if \(message\) return;/, 'a failure returns before clearing anything');
  assert.match(runViewSource, /clearRejectDraft\(runId\);\s*setRejectReason\(''\);\s*collapseRejectReason\(\);/, 'success clears the draft and collapses');
});

test('keyboard and focus are wired through the pure key rules and refs', () => {
  assert.match(runViewSource, /rejectKeyAction\(\{ key: event\.key, .*isComposing: event\.nativeEvent\.isComposing \}/);
  assert.match(approvalBar, /onKeyDown=\{onRejectKeyDown\}/);
  assert.match(runViewSource, /focusTarget\.current = 'reason'/);
  assert.match(runViewSource, /focusTarget\.current = 'reject'/);
});

test('the reject draft is read at mount, saved per keystroke, and cleared when the run leaves awaiting approval', () => {
  assert.match(runViewSource, /useState\(\(\) => readRejectDraft\(runId\)\)/);
  assert.match(runViewSource, /useState\(\(\) => hasRejectDraft\(readRejectDraft\(runId\)\)\)/);
  assert.match(runViewSource, /saveRejectDraft\(runId, reason\)/);
  assert.match(runViewSource, /if \(!isRejectDraftStale\(run\.status\)\) return;\s*clearRejectDraft\(runId\);/);
  assert.match(runViewSource, /<RunActions key=\{runId\}/, 'state never leaks between runs');
  assert.doesNotMatch(runViewSource, /loopComment.*(?:Draft|localStorage)/, 'the loop comment is not persisted');
});

test('the bar keeps its height cap, and both textareas use the one shared auto-growing component', () => {
  assert.match(runViewSource, /max-h-\[45%\] shrink-0 space-y-2 overflow-y-auto/);
  assert.match(runViewSource, /<AutoGrowTextarea id="run-loop-comment".*minLines=\{2\}/);
  assert.doesNotMatch(runViewSource, /rows=\{2\}|<Textarea/);
  assert.equal((autoGrowSource.match(/forwardRef/g) ?? []).length, 1, 'one definition of the growth behaviour');
});

test('the shared textarea starts at one row so it can be compact and shrink', () => {
  assert.match(autoGrowSource, /<Textarea ref=\{setRef\} rows=\{1\}/);
});

test('leaving awaiting approval also resets the open reason box and its text, not just storage', () => {
  assert.match(runViewSource, /if \(!isRejectDraftStale\(run\.status\)\) return;\s*clearRejectDraft\(runId\);\s*setRejectReason\(''\);\s*setRejecting\(false\);/);
});

test('the testing-setup gate, Retry step and the loop buttons are unchanged', () => {
  assert.match(runViewSource, /<SetupProposalDecision runId=\{runId\}/);
  assert.match(runViewSource, /'Retrying…' : 'Retry step'/);
  assert.match(runViewSource, /'Continue anyway'/);
  assert.match(runViewSource, /'Run another round'/);
});

test('rejection helpers: draft, send and stale rules', () => {
  assert.equal(hasRejectDraft(''), false);
  assert.equal(hasRejectDraft('  \n '), false);
  assert.equal(hasRejectDraft(' fix it '), true);
  assert.equal(canSendRejection('fix', false), true);
  assert.equal(canSendRejection('   ', false), false);
  assert.equal(canSendRejection('fix', true), false);
  assert.equal(canSendRejection('x'.repeat(5000), false), true);
  assert.equal(isRejectDraftStale('awaiting-approval'), false);
  for (const status of ['running', 'completed', 'failed', 'stopped', 'needs-attention', 'starting', 'completing']) assert.equal(isRejectDraftStale(status), true, status);
});

test('rejectKeyAction: Ctrl/Cmd+Enter sends when allowed, Escape collapses, Enter types', () => {
  const key = (over) => ({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...over });
  const ready = { reason: 'fix', sending: false };
  assert.equal(rejectKeyAction(key({ ctrlKey: true }), ready), 'send');
  assert.equal(rejectKeyAction(key({ metaKey: true }), ready), 'send');
  assert.equal(rejectKeyAction(key({}), ready), null);
  assert.equal(rejectKeyAction(key({ shiftKey: true }), ready), null);
  assert.equal(rejectKeyAction(key({ ctrlKey: true }), { reason: ' ', sending: false }), null);
  assert.equal(rejectKeyAction(key({ ctrlKey: true }), { reason: 'fix', sending: true }), null);
  assert.equal(rejectKeyAction(key({ ctrlKey: true, isComposing: true }), ready), null);
  assert.equal(rejectKeyAction(key({ key: 'Escape' }), { reason: '', sending: false }), 'collapse');
  assert.equal(rejectKeyAction(key({ key: 'Escape' }), { reason: 'fix', sending: true }), null);
  assert.equal(rejectKeyAction(key({ key: 'a', ctrlKey: true }), ready), null);
});

test('rejecting sends the trimmed reason as the request-changes comment; approving sends none', async () => {
  const calls = [];
  const api = { approve: async (id) => (calls.push(['approve', id]), true), requestChanges: async (id, c) => (calls.push(['changes', id, c]), true) };
  await sendApprovalDecision('r1', '  tweak the header \n', api);
  await sendApprovalDecision('r1', null, api);
  assert.deepEqual(calls, [['changes', 'r1', 'tweak the header'], ['approve', 'r1']]);
});

test('visibleRunActions: approveRequestChanges only when awaiting-approval and the selected stage is the current one', () => {
  const stages = buildRunStages(detail({ currentStepId: 'dev' }));
  const devStage = stages.find((s) => s.id === 'dev');
  const uiStage = stages.find((s) => s.id === 'ui');
  assert.equal(visibleRunActions(run({ status: 'awaiting-approval', currentStepId: 'dev' }), devStage).approveRequestChanges, true);
  assert.equal(visibleRunActions(run({ status: 'awaiting-approval', currentStepId: 'dev' }), uiStage).approveRequestChanges, false);
  assert.equal(visibleRunActions(run({ status: 'running', currentStepId: 'dev' }), devStage).approveRequestChanges, false);
});

test('visibleRunActions: loopDecision only when needs-attention, the selected stage is current, and it has a loopBack', () => {
  const withLoop = detail({ currentStepId: 'ui' }, [{ step: step('ui', 'UI Planning', { loopBack: { toStepId: 'ui', maxRounds: 3 } }), rounds: [] }, { step: step('dev', 'Development'), rounds: [] }]);
  const stages = buildRunStages(withLoop);
  const uiStage = stages.find((s) => s.id === 'ui');
  const devStage = stages.find((s) => s.id === 'dev');
  assert.equal(visibleRunActions(run({ status: 'needs-attention', currentStepId: 'ui' }), uiStage).loopDecision, true);
  assert.equal(visibleRunActions(run({ status: 'needs-attention', currentStepId: 'ui' }), devStage).loopDecision, false);
  assert.equal(visibleRunActions(run({ status: 'needs-attention', currentStepId: 'dev' }), stages.find((s) => s.id === 'dev')).loopDecision, false);
});

test('visibleRunActions: retryStep whenever needs-attention, regardless of selected stage', () => {
  const stages = buildRunStages(detail());
  const completeStage = stages.find((s) => s.id === 'complete');
  assert.equal(visibleRunActions(run({ status: 'needs-attention' }), completeStage).retryStep, true);
  assert.equal(visibleRunActions(run({ status: 'running' }), completeStage).retryStep, false);
});

test('hasPrCreationError reads the backend\'s exact stitched-report phrasing', () => {
  assert.equal(hasPrCreationError(null), false);
  assert.equal(hasPrCreationError('## Pull request\nhttps://example.com/pr/1'), false);
  assert.equal(hasPrCreationError('## Pull request\nCould not be created automatically: no remote configured'), true);
});

test('stageSpentMs sums every round\'s completedAt - createdAt', () => {
  const rounds = [
    stepRun('sr1', 'dev', 1, { createdAt: '2026-09-26T00:00:00.000Z', completedAt: '2026-09-26T00:02:10.000Z' }),
    stepRun('sr2', 'dev', 2, { createdAt: '2026-09-26T01:00:00.000Z', completedAt: '2026-09-26T01:05:00.000Z' }),
  ];
  assert.equal(stageSpentMs(rounds, 0), 130_000 + 300_000);
});

test('stageSpentMs counts a running round up to now, and skips a settled round with no completedAt', () => {
  const now = Date.parse('2026-09-26T00:03:00.000Z');
  assert.equal(stageSpentMs([stepRun('sr1', 'dev', 1, { status: 'running', completedAt: null })], now), 180_000);
  assert.equal(stageSpentMs([stepRun('sr1', 'dev', 1, { status: 'stopped', completedAt: null })], now), 0);
  assert.equal(stageSpentMs([], now), 0);
});

test('stageTimeLabel: a done step stage\'s time spent, in the shared compact format, regardless of run status or now', () => {
  const stages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds: [stepRun('sr1', 'dev', 1), stepRun('sr2', 'dev', 2)] }]));
  assert.equal(stageTimeLabel(stages[0], 'done', run({ status: 'running' }), 0), '10m');
  const short = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds: [
    stepRun('sr1', 'dev', 1, { createdAt: '2026-09-26T00:00:00.000Z', completedAt: '2026-09-26T00:01:05.000Z' }),
    stepRun('sr2', 'dev', 2, { createdAt: '2026-09-26T00:10:00.000Z', completedAt: '2026-09-26T00:11:05.000Z' }),
  ] }]));
  assert.equal(stageTimeLabel(short[0], 'done', run({ status: 'running' }), 0), '2m 10s', 'minutes and seconds, summed over rounds');
  assert.equal(stageTimeLabel(stages[0], 'pending', run(), 0), null);
  assert.equal(stageTimeLabel(stages[1], 'done', run(), 0), null, 'never on Complete');
  const empty = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds: [] }]));
  assert.equal(stageTimeLabel(empty[0], 'done', run(), 0), null, 'a step with no rounds yet shows no time');
});

test('stageTimeLabel: the current step stage ticks live while its round is still running (task 5.003)', () => {
  const started = Date.parse('2026-09-26T00:00:00.000Z');
  const stages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds: [
    stepRun('sr1', 'dev', 1, { status: 'running', createdAt: new Date(started).toISOString(), completedAt: null }),
  ] }]));
  assert.equal(stageTimeLabel(stages[0], 'current', run({ status: 'running' }), started), '<1s', 'the instant the first round starts');
  assert.equal(stageTimeLabel(stages[0], 'current', run({ status: 'running' }), started + 125_000), '2m 5s', 'ticks up as now advances');
});

test('stageTimeLabel never shows on Complete, even as the fallback current stage', () => {
  const stages = buildRunStages(detail());
  const complete = stages[stages.length - 1];
  assert.equal(stageTimeLabel(complete, 'current', run({ status: 'completing' }), Date.now()), null);
});

test('stageTimeLabel: a second round continues the first round\'s total instead of restarting at zero', () => {
  const rounds = [
    stepRun('sr1', 'dev', 1, { status: 'done', createdAt: '2026-09-26T00:00:00.000Z', completedAt: '2026-09-26T00:02:00.000Z' }),
    stepRun('sr2', 'dev', 2, { status: 'running', createdAt: '2026-09-26T00:10:00.000Z', completedAt: null }),
  ];
  const stages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds }]));
  const now = Date.parse('2026-09-26T00:10:30.000Z');
  assert.equal(stageTimeLabel(stages[0], 'current', run({ status: 'running' }), now), '2m 30s', 'round 1\'s 2m plus round 2\'s 30s so far');
});

test('stageTimeLabel freezes the current stage while awaiting approval, needing attention (a loop/step outcome) or stopped — the round\'s own completedAt is already fixed by then, so advancing now changes nothing', () => {
  const rounds = [stepRun('sr1', 'dev', 1, { status: 'done', createdAt: '2026-09-26T00:00:00.000Z', completedAt: '2026-09-26T00:02:14.000Z' })];
  const stages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds }]));
  const muchLater = Date.parse('2026-09-26T05:00:00.000Z');
  for (const status of ['awaiting-approval', 'needs-attention', 'stopped']) {
    assert.equal(stageTimeLabel(stages[0], 'current', run({ status, updatedAt: '2026-09-26T00:02:14.000Z' }), muchLater), '2m 14s', `frozen while ${status}`);
  }
});

test('stageTimeLabel freezes at the run\'s own updatedAt for a round still mid-session with no completedAt yet (needs-attention from a genuine open question)', () => {
  const rounds = [stepRun('sr1', 'dev', 1, { status: 'running', createdAt: '2026-09-26T00:00:00.000Z', completedAt: null })];
  const stages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds }]));
  const now = Date.parse('2026-09-26T05:00:00.000Z');
  assert.equal(
    stageTimeLabel(stages[0], 'current', run({ status: 'needs-attention', updatedAt: '2026-09-26T00:03:00.000Z' }), now),
    '3m',
    'frozen at the moment the run flipped to needs-attention, not advancing with now',
  );
});

test('stageTimeLabel freezes once the run has failed', () => {
  const rounds = [stepRun('sr1', 'dev', 1, { status: 'running', createdAt: '2026-09-26T00:00:00.000Z', completedAt: null })];
  const stages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds }]));
  const now = Date.parse('2026-09-26T05:00:00.000Z');
  assert.equal(stageTimeLabel(stages[0], 'current', run({ status: 'failed', updatedAt: '2026-09-26T00:01:30.000Z' }), now), '1m 30s');
});

test('stageTimeLabel resumes ticking (from the old frozen total) once a new round starts', () => {
  const rounds = [
    stepRun('sr1', 'dev', 1, { status: 'stopped', createdAt: '2026-09-26T00:00:00.000Z', completedAt: '2026-09-26T00:05:00.000Z' }),
    stepRun('sr2', 'dev', 2, { status: 'running', createdAt: '2026-09-26T01:00:00.000Z', completedAt: null }),
  ];
  const stages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds }]));
  const now = Date.parse('2026-09-26T01:00:20.000Z');
  assert.equal(
    stageTimeLabel(stages[0], 'current', run({ status: 'running' }), now),
    '5m 20s',
    'the stopped round\'s 5m plus the new round\'s 20s so far, ticking again now the run is running',
  );
});

test('stageTimeLabel reflects true elapsed time computed fresh from createdAt/completedAt/updatedAt — correct after a simulated reload, not just from when a view first opened', () => {
  const rounds = [stepRun('sr1', 'dev', 1, { status: 'running', createdAt: '2026-09-26T00:00:00.000Z', completedAt: null })];
  const stages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds }]));
  const muchLaterNow = Date.parse('2026-09-26T01:05:00.000Z');
  assert.equal(stageTimeLabel(stages[0], 'current', run({ status: 'running' }), muchLaterNow), '1h 5m');
});

test('stageTimeLabel: a finished step\'s label equals the live timer\'s last value — no jump on completion', () => {
  const liveRounds = [stepRun('sr1', 'dev', 1, { status: 'running', createdAt: '2026-09-26T00:00:00.000Z', completedAt: null })];
  const liveStages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds: liveRounds }]));
  const settleAt = Date.parse('2026-09-26T00:04:10.000Z');
  const lastLiveValue = stageTimeLabel(liveStages[0], 'current', run({ status: 'running' }), settleAt);

  const doneRounds = [stepRun('sr1', 'dev', 1, { status: 'done', createdAt: '2026-09-26T00:00:00.000Z', completedAt: new Date(settleAt).toISOString() })];
  const doneStages = buildRunStages(detail({}, [{ step: step('dev', 'Development'), rounds: doneRounds }]));
  assert.equal(stageTimeLabel(doneStages[0], 'done', run({ status: 'running' }), settleAt), lastLiveValue);
});

test('roundPanes: both columns when the round has both, otherwise the one it has; Summary when it has neither', () => {
  const output = { name: 'Report', format: 'markdown', content: '# x' };
  assert.deepEqual(roundPanes(stepRun('a', 'dev', 1, { summary: 'Did it', outputs: [output] })), { summary: true, output: true });
  assert.deepEqual(roundPanes(stepRun('b', 'dev', 1, { outputs: [output] })), { summary: false, output: true });
  assert.deepEqual(roundPanes(stepRun('c', 'dev', 1, { verdict: 'pass' })), { summary: true, output: false });
  assert.deepEqual(roundPanes(stepRun('d', 'dev', 1)), { summary: true, output: false });
});

test('hasRoundSummary is true for any of verdict, skip reason, summary or approval', () => {
  assert.equal(hasRoundSummary(stepRun('a', 'dev', 1)), false);
  assert.equal(hasRoundSummary(stepRun('a', 'dev', 1, { skippedReason: 'n/a' })), true);
  assert.equal(hasRoundSummary(stepRun('a', 'dev', 1, { approval: { decision: 'approved', comment: null } })), true);
});

test('showsSkipReasonLine hides the separate skip line when the summary already carries the reason', () => {
  const reason = 'No **UI** in this task.';
  assert.equal(showsSkipReasonLine(stepRun('a', 'ui', 1, { status: 'skipped', skippedReason: reason, summary: `Skipped: ${reason}` })), false);
});

test('showsSkipReasonLine keeps the skip line when the round has a skip reason but no summary, or one without the reason', () => {
  assert.equal(showsSkipReasonLine(stepRun('a', 'ui', 1, { status: 'skipped', skippedReason: 'Skipped when the task was started' })), true);
  assert.equal(showsSkipReasonLine(stepRun('b', 'ui', 1, { status: 'skipped', skippedReason: 'n/a', summary: 'Nothing to plan.' })), true);
  assert.equal(showsSkipReasonLine(stepRun('c', 'dev', 1, { summary: 'Did it' })), false);
});

test('the Summary column shows the skip line only via showsSkipReasonLine and keeps verdict, summary, approval and empty states', async () => {
  const source = await readFile(new URL('../src/ui/project-popup/WorkflowRunView.tsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function RoundSummary'), source.indexOf('function RoundOutputs'));
  assert.match(body, /\{showsSkipReasonLine\(round\) && <p><span className="font-medium">Skipped:<\/span> \{round\.skippedReason\}<\/p>\}/);
  assert.doesNotMatch(body, /\{round\.skippedReason &&/);
  assert.match(body, /\{round\.verdict && /);
  assert.match(body, /\{round\.summary && <MarkdownDocument content=\{round\.summary\}/);
  assert.match(body, /\{round\.approval && /);
  assert.match(body, /\{!hasRoundSummary\(round\) && <p[^>]*>No summary yet\.<\/p>\}/);
});

test('embeddedHtmlOutput keeps the page and appends a reset that clears its backdrop and outer spacing', () => {
  const page = '<!doctype html><html><body style="background:#f5f6f8;padding:32px">Mockup</body></html>';
  const embedded = embeddedHtmlOutput(page);
  assert.ok(embedded.startsWith(page), 'original markup comes first so the doctype stays at the top');
  assert.match(embedded, /<style>html,body\{background:transparent!important;margin:0!important;padding:0!important\}<\/style>$/);
});
