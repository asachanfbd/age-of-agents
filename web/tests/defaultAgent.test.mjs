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

// Task 19.001: the default coding agent, the one shared picker and the reordered Start task dialog.
// The web has no DOM harness, so behaviour is pinned as pure helpers, the store through the server stub, and source.
const {
  analyticsDefaultControl, defaultDotModel, defaultExecutorId, executorOptions, preselectedExecutorId, resolveExecutorChoice, retainedChoice, unavailableReason,
} = await import('../src/lib/executorAvailability.ts');
const {
  AUTO_MERGE_NEEDS_BRANCH, START_FIELD_ORDER, autoMergeAfterBranchChange, autoMergeSwitch, startOptions, stepsAreExpanded,
} = await import('../src/lib/startTaskDialog.ts');
const { stepSelectionCount, initialStepSelection } = await import('../src/lib/stepSelection.ts');
const { applyDefaultExecutor, mergeWorkerEvent, useWorldStore } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
const NOW = 1_000_000;
const win = (usedPercentage, resetsAt = NOW + 3600) => ({ usedPercentage, resetsAt });
const agent = (id, five = null, seven = null, extra = {}) => ({
  id, label: id.toUpperCase(), kind: 'claude-cli', bin: id, env: {}, usage: { totalTokens: 0, taskCount: 0 },
  limits: five || seven ? { observedAt: NOW, fiveHour: five, sevenDay: seven } : null, ...extra,
});

test('W01-W03 the unavailable reason names the window that resets later, and says so when the reset is unknown', () => {
  assert.match(unavailableReason(agent('a', win(100)), NOW), /A is out of quota \(5-hour limit\) and resets /);
  assert.match(unavailableReason(agent('a', win(100, NOW + 100), win(100, NOW + 9000)), NOW), /7-day limit/, 'W02 the later reset');
  assert.match(unavailableReason(agent('a', win(100, NOW + 9000), win(100, NOW + 100)), NOW), /5-hour limit/);
  assert.match(unavailableReason(agent('a', win(100, null)), NOW), /its reset time is unknown/, 'W03');
  assert.equal(unavailableReason(agent('a', win(40)), NOW), null);
  assert.equal(unavailableReason(agent('a', win(100, NOW - 1)), NOW), null, 'a passed reset is available');
});

test('W04-W08 preselection: the default when available, else the most quota left, else nothing', () => {
  const list = (defaultId, ...rest) => rest.map((e) => ({ ...e, isDefault: e.id === defaultId }));
  assert.equal(preselectedExecutorId(list('b', agent('a', win(5)), agent('b', win(80))), NOW), 'b', 'W04 the default stays even with less quota');
  assert.equal(preselectedExecutorId(list('b', agent('a', win(5)), agent('b', win(100))), NOW), 'a', 'W05');
  assert.equal(preselectedExecutorId(list('', agent('a', win(50)), agent('b', win(10))), NOW), 'b', 'W06');
  assert.equal(preselectedExecutorId(list('', agent('a', win(100))), NOW), '', 'W07');
  assert.equal(preselectedExecutorId([agent('a', win(30))].map((e) => ({ ...e, isDefault: false })), NOW), 'a');
  assert.equal(preselectedExecutorId([], NOW), '', 'W14');
  assert.equal(defaultExecutorId(list('ghost', agent('a'))), '', 'W08 an id missing from the list is no default');
  assert.equal(defaultExecutorId([agent('a', null, null, { isDefault: true }), agent('b', null, null, { isDefault: true })]), 'a', 'W48 more than one is tolerated, first wins');
  assert.equal(defaultExecutorId([agent('a')]), '', 'W47 an old daemon list has no isDefault');
});

test('W09-W13 an untouched picker follows the default, a touched one keeps its pick until it becomes unavailable', () => {
  const at = (defaultId, ...rest) => rest.map((e) => ({ ...e, isDefault: e.id === defaultId }));
  assert.equal(resolveExecutorChoice(at('a', agent('a'), agent('b')), '', NOW), 'a');
  assert.equal(resolveExecutorChoice(at('b', agent('a'), agent('b')), '', NOW), 'b', 'W09 follows the live default');
  assert.equal(resolveExecutorChoice(at('b', agent('a'), agent('b')), 'a', NOW), 'a', 'W10 a touched pick holds');
  assert.equal(resolveExecutorChoice(at('b', agent('a', win(100)), agent('b')), 'a', NOW), 'b', 'W11 falls back');
  assert.equal(resolveExecutorChoice(at('b', agent('b')), 'a', NOW), 'b', 'W12 a removed pick falls back');
  assert.equal(resolveExecutorChoice([], 'a', NOW), '', 'W14');
});

test('W13 a pick that fell back is not restored when the agent frees up again', () => {
  const exhausted = [agent('a', win(100)), agent('b')];
  assert.equal(retainedChoice(exhausted, 'a', NOW), '', 'the pick is dropped, so the picker follows the default again');
  const freed = [agent('a', win(10)), agent('b')];
  assert.equal(retainedChoice(freed, '', NOW), '', 'nothing is held any more');
  assert.equal(retainedChoice(freed, 'a', NOW), 'a', 'a pick that stays usable is held');
  assert.equal(retainedChoice(freed, 'gone', NOW), '');
  assert.equal(retainedChoice(freed, '', NOW), '');
});

test('W32 W33 the dialog keeps its own state when a start is refused, and only an accepted start closes it', async () => {
  const dialogs = await source('ui/project-popup/TaskDialogs.tsx');
  const start = dialogs.slice(dialogs.indexOf('async function start()'), dialogs.indexOf('if (parents === null) return null;'));
  assert.match(start, /await onStart\(startOptions/);
  assert.doesNotMatch(start.slice(start.indexOf('catch')), /setAutoMerge|setCreateBranch/, 'a refusal never resets the switch');
  const panel = await source('ui/project-popup/TasksPanel.tsx');
  assert.match(panel, /await actions\.start\(dialog\.row, options\);\s*setDialog\(null\);/, 'closing happens only after the daemon accepted it');
});

test('S30 S33 the sampler and the CLI hook both ask the daemon to re-check the default', async () => {
  const analytics = await readFile(new URL('../../server/src/analytics/index.ts', import.meta.url), 'utf8');
  assert.match(analytics, /await options\.onSampled\?\.\(\);/);
  assert.match(analytics, /onSampled: \(\) => defaultExecutor\.recheck\(\)/);
  const router = await readFile(new URL('../../server/src/api/router.ts', import.meta.url), 'utf8');
  assert.match(router, /recordCliUsage\(\{ taskId[\s\S]*?void defaultExecutor\.recheck\(\)/);
});

test('W15-W19 option model: name, kind, Default marker only on the default, unavailable disabled with a reason', () => {
  const options = executorOptions([agent('a', win(100), null, { isDefault: false }), agent('b', win(10), null, { isDefault: true })], NOW);
  assert.deepEqual(options.map(({ executor, isDefault, disabled }) => [executor.label, executor.kind, isDefault, disabled]), [['A', 'claude-cli', false, true], ['B', 'claude-cli', true, false]]);
  assert.match(options[0].reason, /resets/);
  assert.equal(options[1].reason, null);
  assert.equal(executorOptions([agent('a', win(100, NOW - 5))], NOW)[0].disabled, false, 'W19 a passed reset enables it');
});

test('W34-W35 footer dot: accessible name, selected state, and disabled with the reason for an exhausted agent', () => {
  const dot = defaultDotModel(agent('a', win(10), null, { isDefault: true }), NOW);
  assert.deepEqual([dot.label, dot.selected, dot.disabled], ['Make A the default coding agent', true, false]);
  const other = defaultDotModel(agent('b', win(10)), NOW);
  assert.deepEqual([other.selected, other.disabled, other.tooltip], [false, false, 'Make B the default for new sessions']);
  const spent = defaultDotModel(agent('c', win(100)), NOW);
  assert.equal(spent.disabled, true);
  assert.match(spent.tooltip, /C is out of quota/);
  assert.equal(defaultDotModel(agent('d', win(100), null, { isDefault: true }), NOW).disabled, false, 'the current default is never disabled');
});

test('W38 Analytics control states: current, action, retired and unavailable', () => {
  const executors = [agent('a', null, null, { isDefault: true }), agent('b', win(10)), agent('c', win(100))];
  assert.deepEqual(analyticsDefaultControl({ id: 'a', retired: false }, executors, NOW), { kind: 'current' });
  assert.deepEqual(analyticsDefaultControl({ id: 'b', retired: false }, executors, NOW), { kind: 'action' });
  assert.equal(analyticsDefaultControl({ id: 'retired-x', retired: true }, executors, NOW).kind, 'disabled');
  assert.match(analyticsDefaultControl({ id: 'c', retired: false }, executors, NOW).reason, /out of quota/);
  assert.equal(analyticsDefaultControl({ id: 'gone', retired: false }, executors, NOW).kind, 'disabled');
});

test('W20-W24 Start task: field order, Steps collapsed and auto-expanding, count text', () => {
  assert.deepEqual(START_FIELD_ORDER, ['workflow', 'steps', 'createBranch', 'autoMerge', 'codingAgent']);
  assert.equal(stepsAreExpanded(false, 6, 7), false, 'W21 collapsed on open');
  assert.equal(stepsAreExpanded(true, 6, 7), true);
  assert.equal(stepsAreExpanded(false, 0, 7), true, 'W23 no step selected expands it');
  assert.equal(stepsAreExpanded(false, 0, 0), false, 'no workflow, no steps, nothing to expand');
  const steps = Array.from({ length: 7 }, (_, index) => ({ id: `s${index}`, name: `S${index}`, canEditCode: false, requiresApproval: false, instructions: '' }));
  assert.equal(stepSelectionCount(steps, initialStepSelection(steps)), '7 of 7', 'W24 the count text the checklist already showed');
});

test('W25-W31 Auto-merge switch: opens in the task setting, off and disabled without a branch, not restored, hidden without a repository, sent with Start', () => {
  assert.deepEqual(autoMergeSwitch({ hasRepository: true, createBranch: true, value: true }), { visible: true, checked: true, disabled: false, reason: null }, 'W25');
  assert.equal(autoMergeSwitch({ hasRepository: true, createBranch: true, value: false }).checked, false, 'W26');
  assert.deepEqual(autoMergeSwitch({ hasRepository: true, createBranch: false, value: true }), { visible: true, checked: false, disabled: true, reason: AUTO_MERGE_NEEDS_BRANCH }, 'W27');
  assert.equal(AUTO_MERGE_NEEDS_BRANCH, 'Auto-merge needs a separate branch');
  let value = true;
  value = autoMergeAfterBranchChange(false, value);
  value = autoMergeAfterBranchChange(true, value);
  assert.equal(value, false, 'W28 re-checking does not turn it back on');
  assert.equal(autoMergeSwitch({ hasRepository: false, createBranch: false, value: false }).visible, false, 'W29 hidden');
  const base = { executorId: 'a', workflowId: 'w', skippedStepIds: [] };
  assert.equal('autoMerge' in startOptions({ ...base, createBranch: false, hasRepository: false, autoMerge: false }), false, 'W29 omitted without a repository');
  assert.equal(startOptions({ ...base, createBranch: true, hasRepository: true, autoMerge: true }).autoMerge, true, 'W30');
  assert.equal(startOptions({ ...base, createBranch: false, hasRepository: true, autoMerge: true }).autoMerge, false, 'W31');
  assert.deepEqual(startOptions({ executorId: 'a', workflowId: '', skippedStepIds: ['x'], createBranch: true, hasRepository: false, autoMerge: false }), { executorId: 'a', createBranch: true, skippedStepIds: ['x'] });
});

test('W39 W40 W47 a live default event updates every agent\'s flag without a refetch, whatever the reason', () => {
  const executors = [agent('a', null, null, { isDefault: true }), agent('b')];
  for (const reason of ['manual', 'exhausted', 'removed', 'initial']) {
    const next = mergeWorkerEvent({ executors }, { type: 'executors.default_changed', defaultExecutorId: 'b', previousExecutorId: 'a', reason });
    assert.deepEqual(next.executors.map((e) => [e.id, e.isDefault]), [['a', false], ['b', true]], reason);
  }
  assert.deepEqual(applyDefaultExecutor([agent('a')], 'zzz').map((e) => e.isDefault), [false], 'an unknown id clears the flags');
  assert.deepEqual(mergeWorkerEvent({}, { type: 'executors.default_changed', defaultExecutorId: 'a', previousExecutorId: null, reason: 'initial' }).executors, [], 'no executors loaded yet');
});

test('W41-W44 W46 the store sets the default, reports failures to the right place and tracks quota live', async () => {
  const stub = installServerStub();
  await useWorldStore.getState().loadExecutors();
  assert.deepEqual(useWorldStore.getState().executors.map((e) => e.isDefault), [false, false], 'no stored default');
  assert.equal(await useWorldStore.getState().setDefaultExecutor('test-codex'), null, 'W41');
  assert.equal(defaultExecutorId(useWorldStore.getState().executors), 'test-codex');

  const notificationsBefore = Object.keys(useWorldStore.getState().errorNotificationsById).length;
  stub.executors.get('test-claude').limits = { observedAt: 1, fiveHour: { usedPercentage: 100, resetsAt: null }, sevenDay: null };
  const message = await useWorldStore.getState().setDefaultExecutor('test-claude');
  assert.match(message, /out of quota/, 'W43 the message comes back to the caller');
  assert.equal(Object.keys(useWorldStore.getState().errorNotificationsById).length, notificationsBefore, 'W43 no notification');
  assert.match(await useWorldStore.getState().setDefaultExecutor('test-claude', { notify: true }), /out of quota/);
  assert.equal(Object.keys(useWorldStore.getState().errorNotificationsById).length, notificationsBefore + 1, 'W42 the footer raises one');
  assert.equal(defaultExecutorId(useWorldStore.getState().executors), 'test-codex', 'a refused request changes nothing');

  assert.deepEqual(stub.defaultExecutor.requests.map((body) => body.executorId), ['test-codex', 'test-claude', 'test-claude']);
  const stubPut = (body) => fetch('http://stub.local/api/executors/default', { method: 'PUT', body: JSON.stringify(body) });
  assert.equal((await stubPut({})).status, 400, 'W44');
  assert.equal((await stubPut({ executorId: 'nope' })).status, 404);

  useWorldStore.setState({ executors: useWorldStore.getState().executors.map((e) => (e.id === 'test-codex' ? { ...e, limits: { observedAt: 1, fiveHour: { usedPercentage: 100, resetsAt: null }, sevenDay: null } } : e)) });
  const state = useWorldStore.getState().executors.find((e) => e.id === 'test-codex');
  assert.equal(defaultDotModel(state).selected, true, 'W46 the current default keeps its dot');
  assert.equal(executorOptions(useWorldStore.getState().executors)[1].disabled, true, 'W46 its picker option is disabled live');
});

test('W45 with no coding agent the picker shows its empty state', async () => {
  const picker = await source('ui/CodingAgentPicker.tsx');
  assert.match(picker, /if \(executors\.length === 0\) return <p className="text-sm text-muted-foreground">No coding agent is configured<\/p>;/);
  const footer = await source('ui/StatusFooter.tsx');
  assert.match(footer, /No coding agents configured/);
  assert.match(await source('ui/analytics/AgentAnalyticsDialog.tsx'), /No coding agents are configured, so there is no capacity to chart/);
});

test('C01-C05 C18 every surface uses the one shared picker; the old pickers and the second preselection are gone', async () => {
  const surfaces = {
    'ui/project-popup/TaskDialogs.tsx': 'id="start-agent"',
    'ui/project-popup/PlanAndBugsPrompt.tsx': 'id="plan-and-bugs-agent"',
    'ui/project-popup/DeferredSessionForm.tsx': 'id="deferred-session-agent"',
    'ui/project-popup/PrDialogs.tsx': 'id="resolve-conflicts-agent"',
  };
  for (const [file, id] of Object.entries(surfaces)) {
    const text = await source(file);
    assert.match(text, /import \{ CodingAgentPicker \} from '\.\.\/CodingAgentPicker';/, file);
    assert.match(text, /import \{ useExecutorChoice \} from '\.\.\/useExecutorChoice';/, file);
    assert.ok(text.includes(id), file);
    assert.doesNotMatch(text, /availableExecutors|mostRemainingExecutorId|preferredExecutorId|WorkerRadioGroup/, `${file} has no second preselection`);
  }
  await assert.rejects(source('ui/project-popup/WorkerRadioGroup.tsx'), /ENOENT/, 'C02');
  const bar = await source('ui/project-popup/PromptBar.tsx');
  assert.doesNotMatch(bar, /DropdownMenu|pickerLabel|menuExtras|options/, 'C03 the prompt bar has no agent menu');
  assert.doesNotMatch(await source('ui/project-popup/DeferredSessionForm.tsx'), /<Select|<option/, 'C04');
  const lib = await source('lib/executorAvailability.ts');
  assert.equal(lib.match(/export function preselectedExecutorId/g).length, 1, 'C05');
  assert.doesNotMatch(lib, /preferredExecutorId/, 'C18 the dead helper is removed');
  for (const file of ['ui/CodingAgentPicker.tsx', 'ui/useExecutorChoice.ts']) assert.doesNotMatch(await source(file), /setDefaultExecutor/, 'C06 a pick never changes the default');
});

test('C07 C09 C10 Resolve conflicts keeps nothing, Plan & bugs keeps the no-agent flow, the session form needs a selection', async () => {
  assert.doesNotMatch(await source('lib/pullRequestActions.ts'), /lastExecutorId/, 'C07');
  const report = await source('ui/project-popup/PlanAndBugsPrompt.tsx');
  assert.match(report, /dialog\.notice && <p role="status"/, 'C09');
  assert.doesNotMatch(report, /unavailable=/);
  assert.match(await source('ui/project-popup/DeferredSessionForm.tsx'), /canStartDeferredSession\(\{ description, executorId \}\)/, 'C10');
});

test('C11-C13 C17 the Start task dialog: field order, a Steps expander button, the Auto-merge Switch with its reason', async () => {
  const dialog = await source('ui/project-popup/TaskDialogs.tsx');
  const body = dialog.slice(dialog.indexOf('export function StartTaskDialog'));
  const at = (needle) => body.indexOf(needle);
  const order = [at('id="start-workflow"'), at('<StepChecklist'), at('id="start-create-branch"'), at('<AutoMergeField'), at('<CodingAgentPicker')];
  assert.ok(order.every((index) => index > 0), 'every field is present');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'C11 source order');
  assert.ok(at('infoWarning && ') < order[0], 'the bug warning stays first');
  assert.match(dialog, /<button\s+type="button"\s+aria-expanded=\{expanded\}\s+aria-controls=\{panelId\}/, 'C12');
  assert.match(dialog, /<Switch id="start-auto-merge" checked=\{state\.checked\} disabled=\{state\.disabled\}/, 'C13');
  assert.match(dialog, /state\.reason \?\? /);
  assert.match(body, /function ParentsConfirmation/, 'C17 the dependent-task screen is still there');
  assert.match(body, /START_WHEN_MERGED_LABEL/);
  assert.match(body, /const \[stepsOpen, setStepsOpen\] = useState\(false\);/, 'collapsed on every open');
  assert.match(body, /setSelection\(initialStepSelection\(workflows\.find/, 'a workflow change resets the selection and leaves stepsOpen alone');
});

test('C14 C15 C16 C19 footer dot, Analytics control, failure routes and the live handler', async () => {
  const item = await source('ui/ExecutorFooterItem.tsx');
  assert.match(item, /role="radio"\s+aria-checked=\{dot\.selected\}\s+aria-disabled=\{dot\.disabled\}\s+aria-label=\{dot\.label\}/, 'C14 its own focusable button');
  assert.match(item, /setDefaultExecutor\(executor\.id, \{ notify: true \}\)/, 'C16 the footer failure goes to the notification store');
  assert.doesNotMatch(item.slice(0, item.indexOf('ANALYTICS_TRIGGER_ATTRIBUTE')), /openAnalytics\(/, 'the dot never opens Analytics');
  assert.match(item, /Default coding agent/, 'hover card line');
  const dialog = await source('ui/analytics/AgentAnalyticsDialog.tsx');
  assert.ok(dialog.indexOf('<DefaultForNewSessions') > dialog.indexOf('id="analytics-agent"'), 'C15 beside the selector');
  assert.match(dialog, /Could not set the default coding agent: \{defaultError\}/);
  assert.match(dialog, /aria-pressed=\{control\.kind === 'current'\}/);
  assert.match(await source('store/worldStore.ts'), /event\.type === 'executors\.default_changed'/, 'C19');
});

test('C20 the picker is a labelled "Coding agent" dropdown whose unavailable options are disabled', async () => {
  const picker = await source('ui/CodingAgentPicker.tsx');
  assert.match(picker, /label = 'Coding agent',/);
  assert.match(picker, /<Label htmlFor=\{id\} className=\{compact \? 'sr-only' : undefined\}>\{label\}<\/Label>/);
  assert.match(picker, /<SelectItem key=\{executor\.id\} value=\{executor\.id\} disabled=\{disabled\}>/);
  assert.match(picker, /<ExecutorLimitStatus executor=\{executor\} \/>/, 'the same quota text as before');
  assert.match(picker, />Default<\/span>/);
});
