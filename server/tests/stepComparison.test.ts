import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountIdentity } from '../src/analytics/accountIdentity.ts';
import { configuredAgent } from '../src/analytics/quotaSampler.ts';
import { compareRound, comparisonGroup, median, MIN_BASELINE_SAMPLES, type ComparisonMetric, type RoundSample } from '../src/analytics/stepComparison.ts';
import { RETENTION_MS, type ActivityRecord, type TokenCounts } from '../src/analytics/types.ts';
import { analyticsHarness, claudeA, claudeB, DAY, HOUR, MINUTE, reading, stepRun, T0, tokens, workflowRun, type AnalyticsHarness } from './helpers/analyticsFakes.ts';

const NOW = T0 + 30 * DAY;
const GROUP = comparisonGroup('software-development', 'Development', 'agent-a');
const NO_METRICS: Record<ComparisonMetric, number | null> = { activeDuration: null, tokens: null, fiveHourDecrease: null, sevenDayDecrease: null };

function sample(id: string, finishedDay: number | null, metrics: Partial<Record<ComparisonMetric, number | null>>, patch: Partial<RoundSample> = {}): RoundSample {
  return { id, group: GROUP, completed: true, finishedAt: finishedDay === null ? null : T0 + finishedDay * DAY, metrics: { ...NO_METRICS, ...metrics }, ...patch };
}

/** `count` earlier completed rounds, each with the same value for `metric`. */
const priors = (count: number, metric: ComparisonMetric, value: number) => Array.from({ length: count }, (_, index) => sample(`prior-${index}`, index + 1, { [metric]: value }));

test('U62 the median of an odd and an even sample set, and none for an empty set', () => {
  assert.equal(median([5, 1, 9]), 5);
  assert.equal(median([4, 1, 9, 2]), 3);
  assert.equal(median([7]), 7);
  assert.equal(median([]), null);
});

test('U63 the comparison group is the same Workflow, step name and agent, across Projects', () => {
  // A Project is not part of the key, so rounds from different Projects share a group.
  assert.equal(comparisonGroup('wf', 'Development', 'agent-a'), comparisonGroup('wf', 'Development', 'agent-a'));
  const judged = sample('judged', 20, { tokens: 100 });
  const comparison = compareRound(judged, [...priors(5, 'tokens', 50), judged], NOW);
  assert.deepEqual([comparison.tokens.median, comparison.tokens.samples], [50, 5]);
});

test('U64 a renamed step forms a new group, and another agent or Workflow never mixes in', () => {
  assert.notEqual(comparisonGroup('wf', 'Development', 'agent-a'), comparisonGroup('wf', 'Build', 'agent-a'));
  assert.notEqual(comparisonGroup('wf', 'Development', 'agent-a'), comparisonGroup('wf', 'development', 'agent-a'), 'step names are case-sensitive');
  assert.notEqual(comparisonGroup('wf', 'Development', 'agent-a'), comparisonGroup('wf', 'Development', 'agent-b'));
  assert.notEqual(comparisonGroup('wf', 'Development', 'agent-a'), comparisonGroup('other', 'Development', 'agent-a'));
  const judged = sample('judged', 20, { tokens: 100 });
  const others = [
    ...priors(5, 'tokens', 50).map((prior) => ({ ...prior, group: comparisonGroup('software-development', 'Build', 'agent-a') })),
    ...priors(5, 'tokens', 50).map((prior) => ({ ...prior, id: `b-${prior.id}`, group: comparisonGroup('software-development', 'Development', 'agent-b') })),
  ];
  assert.deepEqual(compareRound(judged, others, NOW).tokens, { value: 100, median: null, samples: 0, enoughHistory: false, highUsage: false });
});

test('U65 the round being judged is excluded from its own baseline', () => {
  const judged = sample('judged', 20, { tokens: 1000 });
  const comparison = compareRound(judged, [...priors(5, 'tokens', 10), judged], NOW);
  assert.deepEqual([comparison.tokens.median, comparison.tokens.samples], [10, 5]);
});

test('U66 only completed rounds that finished earlier count as prior, and rounds older than 90 days are left out', () => {
  const judged = sample('judged', 20, { tokens: 100 });
  const all = [
    sample('earlier', 10, { tokens: 10 }),
    sample('later', 25, { tokens: 500 }),
    sample('same-moment', 20, { tokens: 500 }),
    sample('running', null, { tokens: 500 }, { completed: false }),
    sample('failed', 5, { tokens: 500 }, { completed: false }),
    sample('expired', -61, { tokens: 500 }),
    judged,
  ];
  assert.equal(NOW - RETENTION_MS, T0 - 60 * DAY);
  assert.deepEqual([compareRound(judged, all, NOW).tokens.median, compareRound(judged, all, NOW).tokens.samples], [10, 1]);
});

test('U67 each metric counts only rounds where that metric is known, so sample counts differ per metric', () => {
  const all = [
    sample('a', 1, { activeDuration: 60, tokens: 10 }),
    sample('b', 2, { activeDuration: 80 }),
    sample('c', 3, { activeDuration: 100, tokens: 30, fiveHourDecrease: 4 }),
  ];
  const comparison = compareRound(sample('judged', 20, {}), all, NOW);
  assert.deepEqual(
    [comparison.activeDuration.samples, comparison.tokens.samples, comparison.fiveHourDecrease.samples, comparison.sevenDayDecrease.samples],
    [3, 2, 1, 0],
  );
  assert.deepEqual([comparison.activeDuration.median, comparison.tokens.median, comparison.fiveHourDecrease.median, comparison.sevenDayDecrease.median], [80, 20, 4, null]);
});

test('U69 four prior rounds is not enough history and gives no marker even at ten times the values', () => {
  const comparison = compareRound(sample('judged', 20, { tokens: 1000 }), priors(MIN_BASELINE_SAMPLES - 1, 'tokens', 100), NOW);
  assert.deepEqual(comparison.tokens, { value: 1000, median: 100, samples: 4, enoughHistory: false, highUsage: false });
});

test('U70 five prior rounds and a value exactly twice the median is High usage; 1.99 times is not', () => {
  const baseline = priors(5, 'tokens', 100);
  assert.equal(compareRound(sample('judged', 20, { tokens: 200 }), baseline, NOW).tokens.highUsage, true);
  assert.equal(compareRound(sample('judged', 20, { tokens: 199 }), baseline, NOW).tokens.highUsage, false);
  assert.equal(compareRound(sample('judged', 20, { tokens: 200 }), baseline, NOW).tokens.enoughHistory, true);
});

test('U71 a zero median never triggers, and neither does an unavailable one', () => {
  assert.equal(compareRound(sample('judged', 20, { fiveHourDecrease: 5 }), priors(5, 'fiveHourDecrease', 0), NOW).fiveHourDecrease.highUsage, false);
  const unknown = Array.from({ length: 5 }, (_, index) => sample(`prior-${index}`, index + 1, {}));
  assert.deepEqual(compareRound(sample('judged', 20, { tokens: 999 }), unknown, NOW).tokens, { value: 999, median: null, samples: 0, enoughHistory: false, highUsage: false });
  assert.equal(compareRound(sample('judged', 20, {}), priors(5, 'tokens', 100), NOW).tokens.highUsage, false, 'an unknown value is never High usage');
});

test('U73 a running round gets current values and a baseline but no marker', () => {
  const running = sample('running', null, { tokens: 900 }, { completed: false });
  assert.deepEqual(compareRound(running, priors(5, 'tokens', 100), NOW).tokens, { value: 900, median: 100, samples: 5, enoughHistory: true, highUsage: false });
});

// ---- Through the service, from recorded rounds ----

const at = (minutes: number) => T0 + minutes * MINUTE;

interface RoundOptions { start: number; activeMinutes?: number; tokens?: TokenCounts | null; status?: 'done' | 'running' | 'failed' | 'stopped'; stepName?: string; executorId?: string; workflowId?: string; approximate?: boolean; waitMinutes?: number }

function round(harness: AnalyticsHarness, id: string, options: RoundOptions): ActivityRecord {
  const { start, activeMinutes = 10, status = 'done', stepName = 'Development', executorId = claudeA.id, workflowId = 'software-development', waitMinutes = 0 } = options;
  const executor = harness.world.executors.find((candidate) => candidate.id === executorId)!;
  const live = status === 'running';
  const activeEnd = start + activeMinutes * MINUTE;
  const end = activeEnd + waitMinutes * MINUTE;
  harness.world.runs.set('run-1', workflowRun({ id: 'run-1' }));
  return {
    id, account: accountIdentity(executor), executorId, agentLabel: executor.label, kind: 'coding', projectId: 'project-1', projectName: 'Age of Agents',
    taskId: id, planItemId: 'item-1', label: '8.001: Analytics',
    workflow: { id: workflowId, name: 'Software Development', runId: 'run-1', stepId: 'development', stepName, round: 1, status },
    segments: [{ state: 'active', start, end: live ? null : activeEnd }, ...(waitMinutes ? [{ state: 'waiting' as const, start: activeEnd, end }] : [])],
    startedAt: start, endedAt: live ? null : end, lastSeenAt: end, approximate: options.approximate ?? false, tokens: options.tokens === undefined ? tokens(1000) : options.tokens,
  };
}

/** Five completed prior rounds, one per hour, of ten active minutes and 1,000 tokens each. */
const baselineRounds = (harness: AnalyticsHarness, patch: Partial<RoundOptions> = {}) =>
  Array.from({ length: 5 }, (_, index) => round(harness, `prior-${index}`, { start: at(index * 60), ...patch }));

async function stepsFor(harness: AnalyticsHarness, records: ActivityRecord[], nowMinute = 24 * 60) {
  await harness.history.syncAgents(harness.world.executors.map(configuredAgent));
  await harness.history.putActivities(records);
  harness.clock.set(at(nowMinute));
  return (await harness.service.getSteps(claudeA.id)).rows;
}

test('U68 reset-spanning, gap-spanning and shared intervals are left out of quota medians but still listed', async () => {
  const harness = analyticsHarness();
  const account = accountIdentity(claudeA);
  // Readings every five minutes across the day, falling one point each, except for a gap and a reset.
  for (let minute = 0; minute <= 600; minute += 5) {
    if (minute > 120 && minute < 170) continue;
    const used = minute < 300 ? 10 + minute / 5 : minute / 5 - 55;
    await harness.history.recordReading(account, reading(at(minute), used, 10));
  }
  const rows = await stepsFor(harness, [
    round(harness, 'clean', { start: at(11), activeMinutes: 8 }),
    round(harness, 'gap', { start: at(112), activeMinutes: 60 }),
    round(harness, 'shared-1', { start: at(201), activeMinutes: 8 }),
    round(harness, 'shared-2', { start: at(203), activeMinutes: 4 }),
    round(harness, 'reset', { start: at(291), activeMinutes: 18 }),
    round(harness, 'judged', { start: at(401), activeMinutes: 8 }),
  ]);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.clean!.decrease.fiveHour, { available: true, points: 2, from: at(10), to: at(20), sharedWith: 0 });
  assert.deepEqual(byId.gap!.decrease.fiveHour, { available: false, reason: 'gap', sharedWith: 0 });
  assert.deepEqual(byId.reset!.decrease.fiveHour, { available: false, reason: 'reset', sharedWith: 0 });
  assert.deepEqual([byId['shared-1']!.decrease.fiveHour.available, byId['shared-1']!.decrease.fiveHour.sharedWith], [true, 1]);
  assert.equal(rows.length, 6, 'every round is still listed');
  // Only the clean round's decrease is comparable.
  assert.deepEqual([byId.judged!.comparison.fiveHourDecrease.samples, byId.judged!.comparison.fiveHourDecrease.median], [1, 2]);
  assert.equal(byId.judged!.comparison.activeDuration.samples, 5, 'duration still compares against them all');
});

test('U72 the marker names every metric that triggered, with the round value and the median', async () => {
  const harness = analyticsHarness();
  const rows = await stepsFor(harness, [...baselineRounds(harness), round(harness, 'judged', { start: at(600), activeMinutes: 25, tokens: tokens(1500, 500, 0, 1000) })]);
  const judged = rows.find((row) => row.id === 'judged')!;
  assert.deepEqual(judged.highUsage, ['activeDuration', 'tokens']);
  assert.deepEqual(judged.comparison.activeDuration, { value: 25 * MINUTE, median: 10 * MINUTE, samples: 5, enoughHistory: true, highUsage: true });
  assert.deepEqual(judged.comparison.tokens, { value: 3000, median: 1000, samples: 5, enoughHistory: true, highUsage: true });
  assert.deepEqual(rows.filter((row) => row.id !== 'judged').flatMap((row) => row.highUsage), []);
});

test('U73 a running round shows "so far" values and a baseline but gets no completed-round marker', async () => {
  const harness = analyticsHarness();
  const rows = await stepsFor(harness, [...baselineRounds(harness), round(harness, 'live', { start: at(600), status: 'running', tokens: tokens(9000) })], 700);
  const live = rows.find((row) => row.id === 'live')!;
  assert.deepEqual([live.status, live.duration, live.finishedAt], ['running', { ms: 100 * MINUTE, live: true, approximate: false }, null]);
  assert.deepEqual([live.comparison.tokens.median, live.comparison.tokens.samples, live.highUsage], [1000, 5, []]);
  assert.equal(live.tokens?.partial, false);
});

test('U74 active duration of a completed round is frozen; of a live round it grows with the clock', async () => {
  const harness = analyticsHarness();
  const records = [round(harness, 'done', { start: at(0), activeMinutes: 10, waitMinutes: 30 }), round(harness, 'live', { start: at(60), status: 'running' })];
  const early = await stepsFor(harness, records, 90);
  const late = await stepsFor(harness, records, 240);
  const duration = (rows: typeof early, id: string) => rows.find((row) => row.id === id)!.duration.ms;
  assert.deepEqual([duration(early, 'done'), duration(late, 'done')], [10 * MINUTE, 10 * MINUTE], 'waiting time is not counted');
  assert.deepEqual([duration(early, 'live'), duration(late, 'live')], [30 * MINUTE, 180 * MINUTE]);
});

test('U75 a legacy round without separable waiting time is approximate, and unavailable when its finish is missing', async () => {
  const harness = analyticsHarness();
  const legacy = (id: string, completedAt: string | null) => ({
    stepRun: stepRun({ id, runId: 'run-1', taskId: `${id}-task`, status: 'done', createdAt: new Date(at(0)).toISOString(), completedAt }),
    executorId: claudeA.id, account: null, projectId: 'project-1', projectName: 'Age of Agents', planItemId: 'item-1', label: '8.001: Analytics',
    workflowId: 'software-development', workflowName: 'Software Development', stepName: 'Development',
  });
  harness.world.legacy = [
    legacy('timed', new Date(at(45)).toISOString()),
    legacy('no-finish', null),
    { ...legacy('other-agent', new Date(at(45)).toISOString()), executorId: 'someone-else' },
    { ...legacy('skipped', new Date(at(45)).toISOString()), stepRun: stepRun({ id: 'skipped', runId: 'run-1', taskId: 'skipped-task', status: 'skipped' }) },
  ];
  const rows = await stepsFor(harness, [...baselineRounds(harness, { start: at(100) }), round(harness, 'approx', { start: at(500), approximate: true }), round(harness, 'judged', { start: at(600) })]);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.timed!.duration, { ms: 45 * MINUTE, live: false, approximate: true });
  assert.deepEqual(byId['no-finish']!.duration, { ms: null, live: false, approximate: true });
  // Old records carry no usage evidence and no readings: both are unavailable, never zero.
  assert.deepEqual([byId.timed!.tokens, byId.timed!.decrease.fiveHour], [null, { available: false, reason: 'missing-boundary-reading', sharedWith: 0 }]);
  assert.ok(!('other-agent' in byId) && !('skipped' in byId));
  // Approximate durations never feed a median, and are never judged against one.
  assert.equal(byId.judged!.comparison.activeDuration.samples, 5);
  assert.deepEqual([byId.approx!.duration.approximate, byId.approx!.comparison.activeDuration.value, byId.approx!.highUsage], [true, null, []]);
});

test('rounds on another agent, a renamed step or another Workflow do not enter the baseline', async () => {
  const harness = analyticsHarness({ executors: [claudeA, claudeB] });
  const rows = await stepsFor(harness, [
    ...baselineRounds(harness, { executorId: claudeB.id }),
    ...baselineRounds(harness, { stepName: 'Build' }).map((record) => ({ ...record, id: `renamed-${record.id}` })),
    ...baselineRounds(harness, { workflowId: 'bug-fix' }).map((record) => ({ ...record, id: `other-wf-${record.id}` })),
    round(harness, 'judged', { start: at(600), tokens: tokens(50_000) }),
  ]);
  const judged = rows.find((row) => row.id === 'judged')!;
  assert.deepEqual([judged.comparison.tokens.samples, judged.highUsage], [0, []]);
  assert.ok(rows.every((row) => !row.id.startsWith('prior-')), 'the other agent\'s rounds are not this agent\'s rows');
  assert.equal(rows.length, 11);
});

test('a round whose own record was never seen reads by its session: running while live, stopped once over', async () => {
  const harness = analyticsHarness();
  const unknown = (id: string, live: boolean): ActivityRecord => {
    const record = round(harness, id, { start: at(0), status: live ? 'running' : 'done' });
    return { ...record, workflow: { ...record.workflow!, status: null, round: null } };
  };
  const rows = await stepsFor(harness, [unknown('live', true), unknown('over', false), { ...round(harness, 'orphaned', { start: at(HOUR / MINUTE) }), workflow: { ...round(harness, 'x', { start: 0 }).workflow!, status: 'running' } }]);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.status])), { live: 'running', over: 'stopped', orphaned: 'stopped' });
});
