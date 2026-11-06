import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const { startupCardProgress, startupGlyph, startupLabel, startupView } = await import('../src/lib/runStartup.ts');
const { runStatusBadge, visibleRunActions } = await import('../src/lib/workflowRunView.ts');
const { runControl, runTimingParts } = await import('../src/lib/taskBoard.ts');
const { buildTaskGroups } = await import('../src/lib/workflowTaskGroups.ts');
const { isProjectFolderBusy } = await import('../src/lib/branchMenu.ts');
const { runPhase, isActivePhase } = await import('../src/lib/pullRequestActions.ts');
const { setupHeader, setupStage } = await import('../src/lib/testingPanel.ts');
const { countProjectTasks } = await import('../src/lib/workspaceCounts.ts');

const NOW = new Date('2026-10-11T12:00:00.000Z').getTime();
const iso = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const STEP_NAMES = { name: 'Choosing branch name', worktree: 'Creating worktree', hooks: 'Installing CLI hooks', launch: 'Launching agent' };
const startup = (states, reasons = {}) => ({
  reuseBranch: false,
  steps: Object.keys(STEP_NAMES).map((id, index) => ({ id, name: STEP_NAMES[id], state: states[index] ?? 'pending', ...(reasons[id] ? { reason: reasons[id] } : {}) })),
});

const run = (patch = {}) => ({
  id: 'r1', projectId: 'p1', planItemId: 'i1', workflowId: 'wf',
  workflowSnapshot: { id: 'wf', name: 'Dev', description: '', enabled: true, steps: [{ id: 'dev', name: 'Development', agentId: 'a', instructions: '', canEditCode: true, requiresApproval: false }] },
  status: 'starting', currentStepId: 'dev', executorId: 'x', prUrl: null, completionReport: null, attentionReason: null,
  loopRoundAllowance: 0, createdAt: iso(5), updatedAt: iso(1), completedAt: null,
  startup: startup(['done', 'running']),
  ...patch,
});

const item = (patch = {}) => ({ id: 'i1', projectId: 'p1', title: 'Item', description: '', status: 'developing', order: 0, taskIds: [], executorId: null, workflowRunId: 'r1', createdAt: iso(60), updatedAt: iso(1), ...patch });
const groups = (runs, items = [item()]) => buildTaskGroups({ items, tasksById: {}, workflowRunsByProject: { p1: runs }, projectId: 'p1', showArchived: false, now: NOW });

test('U29/U30 the view names the current step and lists each as done, current or pending, with a count', () => {
  const view = startupView(run());
  assert.deepEqual(view.steps.map((step) => step.state), ['done', 'running', 'pending', 'pending']);
  assert.equal(view.current.name, 'Creating worktree');
  assert.equal(startupLabel(view), 'Creating worktree · 1/4');
  assert.deepEqual(view.steps.map(startupGlyph), ['✓', '●', '○', '○']);
  assert.equal(view.failure, null);
});

test('U31/C06 a failed start reads as the failing step and its reason', () => {
  const failed = run({ status: 'failed', startup: startup(['done', 'failed'], { worktree: 'disk full' }) });
  const view = startupView(failed);
  assert.deepEqual(view.failure, { name: 'Creating worktree', reason: 'disk full' });
  assert.equal(startupLabel(view), 'Creating worktree failed: disk full');
  assert.equal(startupGlyph(view.steps[1]), '✕');
  assert.equal(startupCardProgress(failed).stepName, 'Creating worktree failed: disk full');
});

test('U32 a run from before the phase, or one whose steps all finished, has no start view and reads as before', () => {
  assert.equal(startupView(run({ status: 'running', startup: undefined })), null);
  assert.equal(startupView(run({ status: 'running', startup: startup(['done', 'done', 'done', 'done']) })), null);
  assert.equal(startupCardProgress(run({ status: 'running', startup: undefined })), null);
});

test('U28/C03 the Starting badge has its own label and a neutral static variant', () => {
  assert.deepEqual(runStatusBadge('starting'), { label: 'Starting', variant: 'secondary' });
});

test('U33/C07 Stop is offered for a starting run even though it has no session yet; a stopped one resumes', () => {
  assert.equal(runControl(run(), []), 'stop');
  assert.equal(runControl(run({ status: 'stopped' }), []), 'resume');
});

test('U26/U36 a starting run counts as live: it shows as Running in the timing line, in the folder guard and in the footer counts', () => {
  assert.equal(runTimingParts(run(), 0)[1], 'Ended Running');
  assert.equal(isProjectFolderBusy([], [{ status: 'starting' }]), true);
  const counts = countProjectTasks({ projectId: 'p1', items: [item()], taskIds: [], runs: [run()] }, {});
  assert.deepEqual(counts, { active: 1, blocked: 0, pending: 0 });
});

test('U27/C04 a starting run sits in the Running column with the compact current-step label; a failed start sits in Needs you with its reason', () => {
  const running = groups([run()]);
  assert.deepEqual(running.running.map((row) => row.id), ['i1']);
  assert.equal(running.running[0].progress.stepName, 'Creating worktree · 1/4');
  assert.equal(running.running[0].primary, 'pause', 'the card offers Stop');

  const failed = groups([run({ status: 'failed', startup: startup(['failed'], { name: 'git is locked' }) })], [item({ status: 'failed' })]);
  assert.deepEqual(failed.needsYou.map((row) => row.id), ['i1']);
  assert.equal(failed.needsYou[0].progress.stepName, 'Choosing branch name failed: git is locked');

  const launched = groups([run({ status: 'running', startup: startup(['done', 'done', 'done', 'done']), currentStepId: 'dev' })]);
  assert.equal(launched.running[0].progress, null, 'an ordinary running run has no start line');
});

test('U34 the pull-request phase for a starting conflict run is Starting, and counts as active', () => {
  assert.equal(runPhase({ status: 'starting' }), 'starting');
  assert.equal(isActivePhase(runPhase({ status: 'starting' })), true);
});

test('U35/C13 the testing panel reads a starting setup run as its own stage, with a status line', () => {
  const setup = { planItem: { title: 'Set up testing' }, run: run(), queueEntry: null, active: true };
  assert.equal(setupStage(setup), 'starting');
  assert.equal(setupHeader({ state: 'absent' }, setup).status.badge, 'Starting');
});

test('Retry is offered for a start that failed, not for an ordinary failed run', () => {
  const stage = { kind: 'step', step: { id: 'dev' } };
  assert.equal(visibleRunActions(run({ status: 'failed', startup: startup(['failed'], { name: 'x' }) }), stage).retryStep, true);
  assert.equal(visibleRunActions(run({ status: 'failed', startup: undefined }), stage).retryStep, false);
  assert.equal(visibleRunActions(run({ status: 'needs-attention' }), stage).retryStep, true);
});

test('C05/C08 the detail view mounts the step list, and nothing about the Starting indicator animates', () => {
  const panel = readFileSync(new URL('../src/ui/project-popup/RunStartupSteps.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /animate-|transition|keyframes|setInterval|requestAnimationFrame/);
  const detail = readFileSync(new URL('../src/ui/project-popup/WorkflowRunView.tsx', import.meta.url), 'utf8');
  assert.match(detail, /<RunStartupSteps run=\{run\} \/>/);
});

test('C01/C02 the dialog closes on an accepted start and keeps the server reason on a refusal (the store resolves the run id, or throws)', () => {
  const store = readFileSync(new URL('../src/store/worldStore.ts', import.meta.url), 'utf8');
  assert.match(store, /executePlanItem: async \(itemId, options\) => \{\s*const result = await serverApi\.executePlanItem\(itemId, options\);\s*if \(!\('run' in result\)\) \{ queueEntryJoined\(set, result\.entry\); return ''; \}\s*const \{ run \} = result;/);
  assert.match(store, /return run\.id;/);
});

test('C14 a start that fails sounds the attention chime like any failed run: the run was seen Starting, then Failed', async () => {
  const { snapshotRunStates, attentionWorkflowRunIds } = await import('../src/lib/taskSounds.ts');
  const starting = run();
  const previous = snapshotRunStates([starting]);
  assert.deepEqual(attentionWorkflowRunIds(previous, [{ ...starting, status: 'failed' }]), ['r1']);
  assert.deepEqual(attentionWorkflowRunIds(previous, [{ ...starting, status: 'running' }]), [], 'a start that works makes no attention sound');
});

test('C12/C13 a testing setup that failed to start shows the failing step, not the generic stopped line', () => {
  const failed = run({ status: 'failed', startup: startup(['done', 'failed'], { worktree: 'disk full' }) });
  const setup = { planItem: { title: 'Set up testing' }, run: failed, queueEntry: null, active: true };
  assert.match(setupHeader({ state: 'absent' }, setup).status.text, /Creating worktree failed: disk full/);
});

test('the step list heading follows the run: Starting while it sets up, Start failed after a failure, Stopped once stopped', () => {
  const panel = readFileSync(new URL('../src/ui/project-popup/RunStartupSteps.tsx', import.meta.url), 'utf8');
  assert.match(panel, /view\.failure \? 'Start failed' : run\.status === 'starting' \?/);
  assert.match(panel, /'Stopped before the start finished'/);
});
