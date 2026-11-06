import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { accountIdentity } from '../src/analytics/accountIdentity.ts';
import { activeDurationMs, taskActivityState } from '../src/analytics/activity.ts';
import { ActivityRecorder } from '../src/analytics/activityRecorder.ts';
import { AnalyticsHistory } from '../src/analytics/analyticsHistory.ts';
import { claudeSessionUsage, codexSessionUsage, readCliSessionUsage, totalTokens, usageIncrement } from '../src/analytics/cliUsage.ts';
import { configuredAgent } from '../src/analytics/quotaSampler.ts';
import type { TaskRecord, TaskStatus, TerminalRuntimeStatus } from '../src/domain/types.ts';
import { analyticsHarness, claudeA, claudeB, DAY, memoryStorage, MINUTE, stepRun, T0, taskAt, taskRecord, tokens, workflowRun, type AnalyticsHarness } from './helpers/analyticsFakes.ts';

const at = (minutes: number) => T0 + minutes * MINUTE;

/** Feeds Task states to the recorder as the worker would emit them, each at its own minute. */
async function emit(harness: AnalyticsHarness, task: TaskRecord, steps: [minute: number, patch: Partial<TaskRecord>][]): Promise<TaskRecord> {
  let current = task;
  for (const [minute, patch] of steps) {
    current = taskAt(current, at(minute), patch);
    harness.clock.set(at(minute));
    harness.recorder.handle({ type: 'task', task: current });
  }
  await harness.recorder.idle();
  return current;
}

function stepTask(harness: AnalyticsHarness, id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  harness.world.runs.set('run-1', workflowRun({ id: 'run-1' }));
  harness.world.tasks.add(id);
  return taskRecord({ id, planItemId: 'item-1', workflowRunId: 'run-1', workflowStepId: 'development', ...patch });
}

test('U36 a coding step round produces an interval with Project, task, agent, kind, step name and round', async () => {
  const harness = analyticsHarness();
  const task = stepTask(harness, 'task-1');
  await emit(harness, task, [[0, {}], [1, { runtimeStatus: 'running' }]]);
  harness.recorder.handle({ type: 'stepRun', stepRun: stepRun({ id: 'sr-1', runId: 'run-1', taskId: 'task-1', round: 2 }) });
  await harness.recorder.idle();
  const record = (await harness.history.activity('task-1'))!;
  assert.deepEqual(
    [record.kind, record.projectName, record.label, record.agentLabel, record.executorId, record.account],
    ['coding', 'Age of Agents', '8.001: Analytics', 'Claude A', claudeA.id, accountIdentity(claudeA)],
  );
  assert.deepEqual(record.workflow, { id: 'software-development', name: 'Software Development', runId: 'run-1', stepId: 'development', stepName: 'Development', round: 2, status: 'running' });
  assert.deepEqual(record.segments, [{ state: 'active', start: at(0), end: null }]);
  assert.equal(record.approximate, false);
});

test('U37 a planning session produces a planning interval with no step or round, named once its title arrives', async () => {
  const harness = analyticsHarness();
  const task = taskRecord({ id: 'plan-1', kind: 'plan', planningSessionNumber: 4 });
  const started = await emit(harness, task, [[0, {}]]);
  assert.deepEqual([(await harness.history.activity('plan-1'))!.kind, (await harness.history.activity('plan-1'))!.label, (await harness.history.activity('plan-1'))!.workflow], ['planning', 'Planning session #4', null]);
  harness.recorder.handle({ type: 'task', task: { ...started, title: 'Quota analytics plan' } });
  await harness.recorder.idle();
  assert.equal((await harness.history.activity('plan-1'))!.label, 'Quota analytics plan');
});

test('U38 naming and summarizing turns produce app background work intervals with their exact reported usage', async () => {
  const harness = analyticsHarness();
  const usage = { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 300, totalCostUsd: 0.01 };
  const result = await harness.recorder.trackBackground(claudeA, { purpose: 'Completion summary', projectId: 'project-1', planItemId: 'item-1' }, async () => {
    harness.clock.advance(MINUTE);
    return { usage, status: 'done' };
  });
  assert.equal(result.status, 'done');
  await assert.rejects(harness.recorder.trackBackground(claudeA, { purpose: 'Task naming', projectId: 'project-1' }, async () => { harness.clock.advance(MINUTE); throw new Error('turn failed'); }), /turn failed/);
  assert.equal(await harness.recorder.trackBackground(claudeA, { purpose: 'Session naming' }, async () => null), null, 'a timed-out turn resolves null');
  const records = (await harness.history.activities()).sort((a, b) => a.startedAt - b.startedAt);
  assert.deepEqual(records.map((r) => [r.kind, r.label, r.projectName, r.endedAt! - r.startedAt]), [
    ['background', 'Completion summary', 'Age of Agents', MINUTE],
    ['background', 'Task naming', 'Age of Agents', MINUTE],
    ['background', 'Session naming', null, 0],
  ]);
  assert.deepEqual(records.map((r) => r.tokens), [tokens(100, 20, 5, 300), null, null]);
  assert.ok(records.every((r) => r.taskId === null && r.account === accountIdentity(claudeA)));
});

test('U39 stopped, failed, paused, blocked and approval-waiting periods split the interval and are not active', async () => {
  const cases: [name: string, patch: { status?: TaskStatus; runtimeStatus?: TerminalRuntimeStatus }, state: string][] = [
    ['stopped', { status: 'stopped', runtimeStatus: 'stopped' }, 'ended'],
    ['failed', { status: 'failed', runtimeStatus: 'failed' }, 'ended'],
    ['paused by a CLI exit', { status: 'stopped', runtimeStatus: 'stopped' }, 'ended'],
    ['CLI turn failure', { runtimeStatus: 'failed' }, 'ended'],
    ['disconnected', { runtimeStatus: 'disconnected' }, 'ended'],
    ['blocked on a question', { status: 'blocked' }, 'waiting'],
    ['waiting for approval', { runtimeStatus: 'waiting_input' }, 'waiting'],
  ];
  for (const [name, patch, state] of cases) {
    assert.equal(taskActivityState({ status: 'developing', runtimeStatus: 'running', ...patch }), state, name);
    const harness = analyticsHarness();
    await emit(harness, taskRecord({ id: 'task-1' }), [[0, {}], [10, patch]]);
    const record = (await harness.history.activity('task-1'))!;
    assert.equal(activeDurationMs(record, at(60)), 10 * MINUTE, `${name}: nothing after the change counts as active`);
    assert.equal(record.endedAt, state === 'ended' ? at(10) : null, name);
  }
  assert.equal(taskActivityState({ status: 'developing', runtimeStatus: 'starting' }), 'active');
  assert.equal(taskActivityState({ status: 'developing', runtimeStatus: undefined }), 'active');
});

test('U39 a state change that leaves the Task\'s own timestamp behind is timed when it was seen', async () => {
  const harness = analyticsHarness();
  const task = await emit(harness, stepTask(harness, 'task-1'), [[0, {}]]);
  harness.clock.set(at(12));
  // Not every settle path moves `runtimeStatusChangedAt`: here it still reads minute 0.
  harness.recorder.handle({ type: 'task', task: { ...task, status: 'failed' } });
  // The queue reaching the event later must not move it either.
  harness.clock.set(at(50));
  await harness.recorder.idle();
  const record = (await harness.history.activity('task-1'))!;
  assert.deepEqual([record.endedAt, record.segments], [at(12), [{ state: 'active', start: at(0), end: at(12) }]]);
  assert.equal(activeDurationMs(record, at(60)), 12 * MINUTE);
});

test('U40 a wait for user input is left out of active time and kept as a waiting segment', async () => {
  const harness = analyticsHarness();
  await emit(harness, taskRecord({ id: 'task-1' }), [
    [0, {}], [1, { runtimeStatus: 'running' }], [10, { runtimeStatus: 'waiting_input' }], [40, { runtimeStatus: 'running' }], [45, { status: 'done', runtimeStatus: 'completed' }],
  ]);
  const record = (await harness.history.activity('task-1'))!;
  assert.deepEqual(record.segments, [
    { state: 'active', start: at(0), end: at(10) },
    { state: 'waiting', start: at(10), end: at(40) },
    { state: 'active', start: at(40), end: at(45) },
  ]);
  assert.equal(activeDurationMs(record, at(999)), 15 * MINUTE);
  assert.deepEqual([record.startedAt, record.endedAt], [at(0), at(45)]);
});

test('U41 a round still running has an open end', async () => {
  const harness = analyticsHarness();
  await emit(harness, taskRecord({ id: 'task-1' }), [[0, {}]]);
  const record = (await harness.history.activity('task-1'))!;
  assert.deepEqual([record.endedAt, record.segments.at(-1)!.end], [null, null]);
  assert.equal(activeDurationMs(record, at(7)), 7 * MINUTE);
});

test('U42 a Task first seen while already running is flagged approximate, and one first seen after it ended is not invented', async () => {
  const harness = analyticsHarness();
  const old = new Date(at(-90)).toISOString();
  await emit(harness, taskRecord({ id: 'already-running', createdAt: old }), [[0, { runtimeStatus: 'running' }]]);
  const record = (await harness.history.activity('already-running'))!;
  assert.deepEqual([record.approximate, record.startedAt, record.endedAt], [true, at(0), null]);
  await emit(harness, taskRecord({ id: 'already-over', createdAt: old }), [[0, { status: 'done', runtimeStatus: 'completed' }]]);
  assert.equal(await harness.history.activity('already-over'), undefined);
});

test('U42 a Task created long before it starts has an observed start and is not approximate', async () => {
  const harness = analyticsHarness();
  const queued = taskRecord({ id: 'queued', createdAt: new Date(at(-10)).toISOString() });
  await emit(harness, queued, [[0, {}], [1, { runtimeStatus: 'running' }], [6, { status: 'done', runtimeStatus: 'completed' }]]);
  const record = (await harness.history.activity('queued'))!;
  assert.deepEqual([record.approximate, record.startedAt, record.endedAt], [false, at(0), at(6)]);
});

test('U43 a daemon restart mid-round closes the interval at the last known activity time and flags it approximate', async () => {
  const storage = memoryStorage();
  const before = analyticsHarness({ storage });
  const task = await emit(before, taskRecord({ id: 'task-1' }), [[0, {}], [3, { runtimeStatus: 'running' }]]);
  before.clock.set(at(10));
  await before.recorder.heartbeat();

  // The daemon stops at some unknown later moment and starts again an hour on.
  const after = analyticsHarness({ storage: memoryStorage(storage.files) });
  after.clock.set(at(70));
  await after.recorder.recoverInterrupted();
  const closed = (await after.history.activity('task-1'))!;
  assert.deepEqual([closed.endedAt, closed.approximate, closed.segments.at(-1)], [at(10), true, { state: 'active', start: at(0), end: at(10) }]);
  // Settling the interrupted Task afterwards does not move the end to the restart time.
  await emit(after, task, [[70, { status: 'stopped', runtimeStatus: 'stopped' }]]);
  assert.equal((await after.history.activity('task-1'))!.endedAt, at(10));
});

test('U44 a skipped step produces no interval; the Complete stage produces a timeline interval but no comparison row', async () => {
  const harness = analyticsHarness();
  const run = workflowRun({ id: 'run-1' });
  harness.world.runs.set(run.id, run);
  await harness.history.syncAgents([configuredAgent(claudeA)]);
  harness.recorder.handle({ type: 'stepRun', stepRun: stepRun({ id: 'sr-skipped', runId: 'run-1', taskId: null, status: 'skipped', skippedReason: 'Left out at start' }) });
  await harness.recorder.idle();
  assert.deepEqual(await harness.history.activities(), []);

  await harness.recorder.trackBackground(claudeA, { purpose: 'Completion summary', workflowRun: run }, async () => { harness.clock.advance(MINUTE); return { usage: null }; });
  const [complete] = await harness.history.activities();
  assert.deepEqual([complete!.kind, complete!.workflow?.stepName, complete!.projectId, complete!.planItemId], ['background', 'Complete', 'project-1', 'item-1']);
  harness.clock.set(at(30));
  const day = await harness.service.getDay(claudeA.id, T0, T0 + DAY);
  assert.deepEqual(day.activities.map((activity) => [activity.kind, activity.workflow?.stepName]), [['background', 'Complete']]);
  assert.deepEqual((await harness.service.getSteps(claudeA.id)).rows, []);
});

test('U44 a round the agent skipped itself, and a planning session, are not comparison rows', async () => {
  const harness = analyticsHarness();
  await harness.history.syncAgents([configuredAgent(claudeA)]);
  await emit(harness, stepTask(harness, 'skipped-round'), [[0, {}], [2, { status: 'done', runtimeStatus: 'completed' }]]);
  harness.recorder.handle({ type: 'stepRun', stepRun: stepRun({ id: 'sr-1', runId: 'run-1', taskId: 'skipped-round', status: 'skipped', skippedReason: 'No UI' }) });
  await emit(harness, taskRecord({ id: 'plan-1', kind: 'plan' }), [[3, {}], [4, { status: 'stopped', runtimeStatus: 'stopped' }]]);
  harness.clock.set(at(30));
  assert.deepEqual((await harness.service.getSteps(claudeA.id)).rows, []);
  assert.equal((await harness.service.getDay(claudeA.id, T0, T0 + DAY)).activities.length, 2, 'both still show on the timeline');
});

test('U45 an interval keeps its Project, task, workflow and step names as a snapshot after they are renamed', async () => {
  const harness = analyticsHarness();
  await harness.history.syncAgents([configuredAgent(claudeA)]);
  const task = await emit(harness, stepTask(harness, 'task-1'), [[0, {}]]);
  harness.world.projects.set('project-1', 'Renamed project');
  harness.world.planItems.set('item-1', 'Renamed task');
  const renamedRun = workflowRun({ id: 'run-1' });
  renamedRun.workflowSnapshot.name = 'Renamed workflow';
  renamedRun.workflowSnapshot.steps[0]!.name = 'Renamed step';
  harness.world.runs.set('run-1', renamedRun);
  await emit(harness, task, [[5, { status: 'done', runtimeStatus: 'completed' }]]);
  harness.clock.set(at(30));
  const [view] = (await harness.service.getDay(claudeA.id, T0, T0 + DAY)).activities;
  assert.deepEqual([view!.projectName, view!.label, view!.workflow?.name, view!.workflow?.stepName], ['Age of Agents', '8.001: Analytics', 'Software Development', 'Development']);
  assert.deepEqual(view!.target, { kind: 'run', projectId: 'project-1', runId: 'run-1', stepId: 'development', round: null }, 'still resolvable to the live record');
});

test('U46 an interval whose task was deleted reads "Deleted task" and has no navigation target', async () => {
  const harness = analyticsHarness();
  await harness.history.syncAgents([configuredAgent(claudeA)]);
  await emit(harness, stepTask(harness, 'task-1'), [[0, {}], [5, { status: 'done', runtimeStatus: 'completed' }]]);
  await emit(harness, taskRecord({ id: 'plan-1', kind: 'plan' }), [[6, {}], [8, { status: 'stopped', runtimeStatus: 'stopped' }]]);
  harness.world.tasks.add('plan-1');
  harness.clock.set(at(30));
  const before = (await harness.service.getDay(claudeA.id, T0, T0 + DAY)).activities;
  assert.deepEqual(before.map((activity) => [activity.deleted, activity.target?.kind]), [[false, 'run'], [false, 'task']]);

  harness.world.planItems.delete('item-1');
  harness.world.runs.delete('run-1');
  harness.world.tasks.delete('plan-1');
  const after = (await harness.service.getDay(claudeA.id, T0, T0 + DAY)).activities;
  assert.deepEqual(after.map((activity) => [activity.label, activity.deleted, activity.target]), [['Deleted task', true, null], ['Deleted task', true, null]]);
  assert.equal(after[0]!.projectName, 'Age of Agents', 'the rest of the record stays as it was');
});

test('U46 a deleted Project leaves its activity readable with no link', async () => {
  const harness = analyticsHarness();
  await harness.history.syncAgents([configuredAgent(claudeA)]);
  await emit(harness, stepTask(harness, 'task-1'), [[0, {}], [5, { status: 'done', runtimeStatus: 'completed' }]]);
  harness.world.projects.delete('project-1');
  harness.clock.set(at(30));
  const [view] = (await harness.service.getDay(claudeA.id, T0, T0 + DAY)).activities;
  assert.deepEqual([view!.projectName, view!.label, view!.target], ['Age of Agents', '8.001: Analytics', null]);
});

test('U47 a round on a step with its own agent override is attributed to that agent, not the run default', async () => {
  const harness = analyticsHarness({ executors: [claudeA, claudeB] });
  // The run's default is Claude A; the step's Task carries the override it actually ran on.
  await emit(harness, stepTask(harness, 'task-1', { executorId: claudeB.id }), [[0, {}]]);
  const record = (await harness.history.activity('task-1'))!;
  assert.deepEqual([record.executorId, record.agentLabel, record.account], [claudeB.id, 'Claude B', accountIdentity(claudeB)]);
});

test('U47 a Task whose executor is no longer configured keeps its own bucket and uses the session executor when it has one', async () => {
  const harness = analyticsHarness();
  await emit(harness, taskRecord({ id: 'gone', executorId: 'removed' }), [[0, {}]]);
  assert.deepEqual([(await harness.history.activity('gone'))!.account, (await harness.history.activity('gone'))!.agentLabel], ['unknown-removed', 'removed']);
  await emit(harness, taskRecord({ id: 'saved', executorId: 'removed', sessionExecutor: { kind: 'claude-cli', bin: claudeB.bin, env: claudeB.env } }), [[0, {}]]);
  assert.equal((await harness.history.activity('saved'))!.account, accountIdentity(claudeB));
});

// ---- Tokens ----

const assistant = (id: string, usage: Record<string, number>) => JSON.stringify({ type: 'assistant', message: { id, usage } });

test('U58 a CLI usage report gives input, output, cache-creation and cache-read, and a total that follows the app convention', () => {
  const file = [
    JSON.stringify({ type: 'user', message: { content: 'SECRET-PROMPT-TEXT' } }),
    assistant('msg-1', { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }),
    // The same message is written again as it streams: it counts once, at its final figures.
    assistant('msg-1', { input_tokens: 2, output_tokens: 30, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }),
    assistant('msg-2', { input_tokens: 3, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 1100 }),
    '{ a partly written line',
  ].join('\n');
  const { usage } = claudeSessionUsage(file)!;
  assert.deepEqual(usage, tokens(5, 37, 100, 2100));
  assert.equal(totalTokens(usage), 5 + 37 + 100 + 2100);

  const codexFile = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 40 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 300, output_tokens: 90, reasoning_output_tokens: 50 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
  ].join('\n');
  // Codex reports a running total: the last one is the session's, with cached input counted once.
  assert.deepEqual(codexSessionUsage(codexFile)!.usage, tokens(600, 90, 0, 300));
});

test('U59 no usage evidence is unavailable, and a legacy all-zero Task total is not treated as evidence', async () => {
  assert.equal(claudeSessionUsage(JSON.stringify({ type: 'user', message: {} })), null);
  assert.equal(codexSessionUsage(''), null);
  const harness = analyticsHarness();
  await harness.history.syncAgents([configuredAgent(claudeA)]);
  // The Task record carries the all-zero usage every interactive session is saved with.
  await emit(harness, stepTask(harness, 'task-1'), [[0, {}], [5, { status: 'done', runtimeStatus: 'completed' }]]);
  harness.recorder.handle({ type: 'stepRun', stepRun: stepRun({ id: 'sr-1', runId: 'run-1', taskId: 'task-1', status: 'done' }) });
  await harness.recorder.recordCliUsage({ taskId: 'task-1', kind: 'claude-cli', sessionKey: 'session-1', sessionFile: '/no/usage/here' }, true);
  assert.equal((await harness.history.activity('task-1'))!.tokens, null);
  harness.clock.set(at(30));
  const [row] = (await harness.service.getSteps(claudeA.id)).rows;
  assert.deepEqual([row!.tokens, row!.comparison.tokens.value], [null, null]);
});

test('U60 a resumed session reporting cumulative totals gives the later round only the increase, and a replayed report adds nothing', async () => {
  assert.deepEqual(usageIncrement(null, tokens(10, 5)), tokens(10, 5));
  assert.deepEqual(usageIncrement(tokens(10, 5, 1, 100), tokens(25, 9, 1, 400)), tokens(15, 4, 0, 300));
  assert.deepEqual(usageIncrement(tokens(10, 5), tokens(10, 5)), tokens(0, 0));
  // A total lower than what was assigned means the CLI started counting again: all of it is new.
  assert.deepEqual(usageIncrement(tokens(100, 50), tokens(8, 2)), tokens(8, 2));

  const harness = analyticsHarness();
  const session = { kind: 'claude-cli' as const, sessionKey: 'session-1', sessionFile: '/sessions/1.jsonl' };
  const first = stepTask(harness, 'round-1');
  await emit(harness, first, [[0, {}]]);
  harness.usage.set(session.sessionFile, tokens(100, 40, 10, 1000));
  await harness.recorder.recordCliUsage({ taskId: 'round-1', ...session }, true);
  await emit(harness, first, [[5, { status: 'done', runtimeStatus: 'completed' }]]);

  await emit(harness, stepTask(harness, 'round-2', { sessionId: 'session-1' }), [[10, {}]]);
  harness.usage.set(session.sessionFile, tokens(160, 70, 10, 2500));
  await harness.recorder.recordCliUsage({ taskId: 'round-2', ...session }, true);
  await harness.recorder.recordCliUsage({ taskId: 'round-2', ...session }, true);
  assert.deepEqual((await harness.history.activity('round-1'))!.tokens, tokens(100, 40, 10, 1000));
  assert.deepEqual((await harness.history.activity('round-2'))!.tokens, tokens(60, 30, 0, 1500));
});

test('U60 a resumed session the CLI wrote to a new file under a new id does not count the repeated messages again', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = analyticsHarness();
  const recorder = new ActivityRecorder({ history: harness.history, lookups: harness.world.lookups, readUsage: readCliSessionUsage, now: harness.clock.now });
  const sessionFile = async (name: string, lines: string[]) => {
    const file = path.join(dir, name);
    await writeFile(file, lines.join('\n'));
    return file;
  };
  const earlier = [assistant('msg-1', { input_tokens: 100, output_tokens: 40 }), assistant('msg-2', { input_tokens: 50, output_tokens: 10 })];

  await emit(harness, stepTask(harness, 'round-1'), [[0, {}]]);
  await recorder.recordCliUsage({ taskId: 'round-1', kind: 'claude-cli', sessionKey: 'session-1', sessionFile: await sessionFile('first.jsonl', earlier) }, true);
  await emit(harness, stepTask(harness, 'round-2'), [[10, {}]]);
  const resumed = await sessionFile('resumed.jsonl', [...earlier, assistant('msg-3', { input_tokens: 7, output_tokens: 3 })]);
  await recorder.recordCliUsage({ taskId: 'round-2', kind: 'claude-cli', sessionKey: 'session-2', sessionFile: resumed }, true);
  // A different conversation is counted in full, even when its total is higher in every category.
  await emit(harness, stepTask(harness, 'round-3'), [[20, {}]]);
  const fresh = await sessionFile('fresh.jsonl', [assistant('msg-9', { input_tokens: 900, output_tokens: 90 })]);
  await recorder.recordCliUsage({ taskId: 'round-3', kind: 'claude-cli', sessionKey: 'session-3', sessionFile: fresh }, true);

  const assigned = await Promise.all(['round-1', 'round-2', 'round-3'].map(async (id) => (await harness.history.activity(id))!.tokens));
  assert.deepEqual(assigned, [tokens(150, 50), tokens(7, 3), tokens(900, 90)]);
  assert.equal(await readCliSessionUsage('claude-cli', path.join(dir, 'missing.jsonl')), null);
});

test('U60 usage written after the last turn hook is still read when the session ends', async () => {
  const harness = analyticsHarness();
  const session = { taskId: 'task-1', kind: 'claude-cli' as const, sessionKey: 'session-1', sessionFile: '/sessions/1.jsonl' };
  const task = await emit(harness, stepTask(harness, 'task-1'), [[0, {}]]);
  // A tool hook only notes where the session file is; it reads nothing.
  harness.usage.set(session.sessionFile, tokens(50, 5));
  await harness.recorder.recordCliUsage(session, false);
  assert.equal((await harness.history.activity('task-1'))!.tokens, null);
  // The session is torn down before its final Stop hook arrives.
  harness.usage.set(session.sessionFile, tokens(90, 15));
  await emit(harness, task, [[5, { status: 'done', runtimeStatus: 'completed' }]]);
  assert.deepEqual((await harness.history.activity('task-1'))!.tokens, tokens(90, 15));
});

test('U61 a failed or stopped round keeps its last confirmed usage, flagged partial, with no invented final total', async () => {
  const harness = analyticsHarness();
  await harness.history.syncAgents([configuredAgent(claudeA)]);
  const task = await emit(harness, stepTask(harness, 'task-1'), [[0, {}]]);
  harness.recorder.handle({ type: 'stepRun', stepRun: stepRun({ id: 'sr-1', runId: 'run-1', taskId: 'task-1' }) });
  harness.usage.set('/sessions/1.jsonl', tokens(80, 20));
  await harness.recorder.recordCliUsage({ taskId: 'task-1', kind: 'claude-cli', sessionKey: 'session-1', sessionFile: '/sessions/1.jsonl' }, true);
  await emit(harness, task, [[5, { status: 'failed', runtimeStatus: 'failed' }]]);
  harness.recorder.handle({ type: 'stepRun', stepRun: stepRun({ id: 'sr-1', runId: 'run-1', taskId: 'task-1', status: 'failed' }) });
  await harness.recorder.idle();
  harness.clock.set(at(30));
  const [row] = (await harness.service.getSteps(claudeA.id)).rows;
  assert.deepEqual([row!.status, row!.tokens], ['failed', { counts: tokens(80, 20), total: 100, partial: true }]);
});

test('a failed history update does not stop later events from being recorded', async () => {
  const storage = memoryStorage();
  const history = new AnalyticsHistory({ storage });
  const failing = { executor: async () => { throw new Error('lookup failed'); }, projectName: async () => null, planItemTitle: async () => null, workflowRun: async () => undefined };
  const recorder = new ActivityRecorder({ history, lookups: failing, readUsage: async () => null });
  recorder.handle({ type: 'task', task: taskRecord({ id: 'task-1' }) });
  recorder.handle({ type: 'project' });
  await recorder.idle();
  assert.equal(await history.activity('task-1'), undefined);
  await recorder.heartbeat();
});
