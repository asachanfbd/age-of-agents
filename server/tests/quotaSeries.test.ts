import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountIdentity } from '../src/analytics/accountIdentity.ts';
import { buildWindowSeries, currentCapacity, findDrops, observedDecrease, sliceSeries } from '../src/analytics/quotaSeries.ts';
import type { ActivityRecord } from '../src/analytics/types.ts';
import { analyticsHarness, claudeA, claudeB, DAY, HOUR, MINUTE, reading, T0, type AnalyticsHarness } from './helpers/analyticsFakes.ts';

const at = (minutes: number) => T0 + minutes * MINUTE;
/** Readings five minutes apart from `startMinute`, one per used percentage. */
const every5 = (startMinute: number, used: number[]) => used.map((value, index) => reading(at(startMinute + index * 5), value));

test('U28 readings further apart than the gap threshold split the line into separate segments', () => {
  const series = buildWindowSeries([reading(at(0), 10), reading(at(5), 12), reading(at(30), 15), reading(at(35), 16)], [], 'fiveHour');
  assert.deepEqual(series.points.map((point) => point.segment), [0, 0, 1, 1]);
  assert.deepEqual(series.gaps, [{ from: at(5), to: at(30), reason: 'no-readings' }]);
  assert.deepEqual(series.resets, []);
});

test('U28 one skipped five-minute sample does not break the line or the decrease across it, and two do', () => {
  const sparse = buildWindowSeries([reading(at(0), 10), reading(at(10) + 1000, 14), reading(at(20) + 2000, 19)], [], 'fiveHour');
  assert.deepEqual([sparse.points.map((point) => point.segment), sparse.gaps], [[0, 0, 0], []]);
  assert.deepEqual(observedDecrease(sparse, at(9), at(12)), { available: true, points: 9, from: at(0), to: at(20) + 2000 });
  const split = buildWindowSeries([reading(at(0), 10), reading(at(15), 14)], [], 'fiveHour');
  assert.deepEqual(split.points.map((point) => point.segment), [0, 1]);
  assert.deepEqual(observedDecrease(split, at(1), at(14)), { available: false, reason: 'gap' });
});

test('U29 a failed check between two close readings still splits the segment', () => {
  const series = buildWindowSeries([reading(at(0), 10), reading(at(8), 12)], [{ at: at(5), reason: 'provider-error' }], 'fiveHour');
  assert.deepEqual(series.points.map((point) => point.segment), [0, 1]);
  assert.deepEqual(series.gaps, [{ from: at(0), to: at(8), reason: 'check-failed' }]);
});

test('U29 failed checks after the last reading leave an open gap, not a flat line', () => {
  const series = buildWindowSeries([reading(at(0), 10)], [{ at: at(5), reason: 'provider-error' }, { at: at(15), reason: 'provider-error' }], 'fiveHour');
  assert.deepEqual(series.gaps, [{ from: at(0), to: at(15), reason: 'check-failed' }]);
});

test('U30 a single reading yields one point and nothing to join it to', () => {
  const series = buildWindowSeries([reading(at(0), 22)], [], 'fiveHour');
  assert.equal(series.points.length, 1);
  assert.deepEqual([series.points[0]!.remaining, series.points[0]!.used], [78, 22]);
  assert.deepEqual([series.gaps, series.resets, findDrops(series)], [[], [], []]);
});

test('U31 remaining going up is marked replenishment and never yields negative consumption', () => {
  const series = buildWindowSeries(every5(0, [40, 45, 5, 8]), [], 'fiveHour');
  assert.deepEqual(series.resets, [{ at: at(10), before: 55, after: 95 }]);
  assert.deepEqual(series.points.map((point) => point.segment), [0, 0, 1, 1]);
  assert.deepEqual(findDrops(series).map((drop) => drop.points), [5, 3]);
  assert.ok(findDrops(series).every((drop) => drop.points > 0));
});

test('U32 a changed or passed reset time is a reset even when remaining looks lower', () => {
  const changed = buildWindowSeries([
    reading(at(0), 40, 10, { fiveHour: at(60) }),
    reading(at(5), 45, 10, { fiveHour: at(360) }),
  ], [], 'fiveHour');
  assert.deepEqual(changed.resets.map((reset) => reset.at), [at(5)]);
  const passed = buildWindowSeries([
    reading(at(0), 40, 10, { fiveHour: at(3) }),
    reading(at(5), 45, 10, { fiveHour: null }),
  ], [], 'fiveHour');
  assert.deepEqual(passed.resets.map((reset) => reset.at), [at(5)]);
  assert.deepEqual(findDrops(passed), []);
  // A reset time that only wobbles by a second is the same window.
  const steady = buildWindowSeries([reading(at(0), 40, 10, { fiveHour: at(60) }), reading(at(5), 45, 10, { fiveHour: at(60) + 1000 })], [], 'fiveHour');
  assert.deepEqual(steady.resets, []);
});

test('U33 a 5h reset neither breaks nor marks the 7d series', () => {
  const readings = [reading(at(0), 80, 20), reading(at(5), 2, 21), reading(at(10), 4, 22)];
  assert.equal(buildWindowSeries(readings, [], 'fiveHour').resets.length, 1);
  const sevenDay = buildWindowSeries(readings, [], 'sevenDay');
  assert.deepEqual(sevenDay.resets, []);
  assert.deepEqual(sevenDay.points.map((point) => point.segment), [0, 0, 0]);
});

test('U33 one window going unavailable gaps only that window', () => {
  const readings = [reading(at(0), 10, 20), reading(at(5), null, 21), reading(at(10), 12, 22)];
  assert.deepEqual(buildWindowSeries(readings, [], 'fiveHour').gaps, [{ from: at(0), to: at(10), reason: 'window-unavailable' }]);
  assert.deepEqual(buildWindowSeries(readings, [], 'sevenDay').gaps, []);
});

test('U34 a window whose reset time has passed with no newer reading is expired, distinct from a measured 0% or 100%', () => {
  const latest = reading(at(0), 100, 0, { fiveHour: at(10) });
  assert.deepEqual(currentCapacity(latest, 'fiveHour', at(5), null), { state: 'measured', remaining: 0, used: 100, observedAt: at(0), resetsAt: at(10) });
  const expired = currentCapacity(latest, 'fiveHour', at(12), null);
  assert.deepEqual([expired.state, expired.remaining, expired.used], ['expired', null, null]);
  assert.deepEqual(currentCapacity(latest, 'sevenDay', at(5), null).remaining, 100);
  assert.equal(currentCapacity(undefined, 'fiveHour', at(5), null).state, 'awaiting');
  assert.equal(currentCapacity(latest, 'sevenDay', at(20), null).state, 'stale');
  assert.equal(currentCapacity(latest, 'sevenDay', at(5), at(4)).state, 'failed');
});

test('U35 slicing returns only what falls in the selected day, and nothing for a day without readings', () => {
  const series = buildWindowSeries([reading(T0 - HOUR, 10), reading(T0 + HOUR, 12), reading(T0 + DAY + HOUR, 14)], [], 'fiveHour');
  const day = sliceSeries(series, T0, T0 + DAY);
  assert.deepEqual(day.points.map((point) => point.at), [T0 + HOUR]);
  assert.equal(day.gaps.length, 2, 'the gaps reaching into the day are kept');
  assert.deepEqual(sliceSeries(series, T0 + 3 * DAY, T0 + 4 * DAY), { points: [], gaps: [], resets: [] });
});

// ---- Observed quota decrease ----

test('U48 with trustworthy readings either side of an isolated interval, the decrease is start remaining minus end remaining, per window', () => {
  const readings = [reading(at(0), 20, 10), reading(at(5), 23, 10.5), reading(at(10), 26, 11), reading(at(15), 27, 11)];
  assert.deepEqual(observedDecrease(buildWindowSeries(readings, [], 'fiveHour'), at(2), at(12)), { available: true, points: 7, from: at(0), to: at(15) });
  assert.deepEqual(observedDecrease(buildWindowSeries(readings, [], 'sevenDay'), at(2), at(12)), { available: true, points: 1, from: at(0), to: at(15) });
});

test('U49 no reading near the start, or none near the end, is unavailable for a missing boundary reading', () => {
  const series = buildWindowSeries(every5(0, [20, 23, 26]), [], 'fiveHour');
  assert.deepEqual(observedDecrease(series, at(-20), at(5)), { available: false, reason: 'missing-boundary-reading' });
  assert.deepEqual(observedDecrease(series, at(2), at(40)), { available: false, reason: 'missing-boundary-reading' });
  assert.deepEqual(observedDecrease(buildWindowSeries([], [], 'fiveHour'), at(2), at(8)), { available: false, reason: 'missing-boundary-reading' });
  assert.deepEqual(observedDecrease(series, at(2), null), { available: false, reason: 'in-progress' });
});

test('U50 a reset inside the interval makes the decrease unavailable', () => {
  const series = buildWindowSeries(every5(0, [80, 85, 3, 6]), [], 'fiveHour');
  assert.deepEqual(observedDecrease(series, at(2), at(13)), { available: false, reason: 'reset' });
});

test('U51 a gap or a failed check inside the interval makes the decrease unavailable', () => {
  const gapped = buildWindowSeries([reading(at(0), 20), reading(at(5), 22), reading(at(40), 30), reading(at(45), 31)], [], 'fiveHour');
  assert.deepEqual(observedDecrease(gapped, at(2), at(42)), { available: false, reason: 'gap' });
  const failed = buildWindowSeries(every5(0, [20, 22, 24]), [{ at: at(7), reason: 'provider-error' }], 'fiveHour');
  assert.deepEqual(observedDecrease(failed, at(2), at(9)), { available: false, reason: 'gap' });
});

test('U54 remaining unchanged is a measured decrease of 0, distinct from unavailable', () => {
  const series = buildWindowSeries(every5(0, [20, 20, 20]), [], 'fiveHour');
  assert.deepEqual(observedDecrease(series, at(2), at(8)), { available: true, points: 0, from: at(0), to: at(10) });
});

test('U55 5h can be available while 7d is unavailable for the same interval', () => {
  const readings = [reading(at(0), 20, 10), reading(at(5), 23, null), reading(at(10), 26, 11)];
  assert.equal(observedDecrease(buildWindowSeries(readings, [], 'fiveHour'), at(2), at(8)).available, true);
  assert.deepEqual(observedDecrease(buildWindowSeries(readings, [], 'sevenDay'), at(2), at(8)), { available: false, reason: 'gap' });
});

// ---- Sharing and attribution, through the service ----

function session(harness: AnalyticsHarness, id: string, start: number, end: number | null, patch: Partial<ActivityRecord> = {}): ActivityRecord {
  harness.world.tasks.add(id);
  return {
    id, account: accountIdentity(claudeA), executorId: claudeA.id, agentLabel: claudeA.label, kind: 'coding', projectId: 'project-1', projectName: 'Age of Agents',
    taskId: id, planItemId: null, label: 'Coding task', workflow: null, segments: [{ state: 'active', start, end }],
    startedAt: start, endedAt: end, lastSeenAt: end ?? start, approximate: false, tokens: null, ...patch,
  };
}

async function dayWith(harness: AnalyticsHarness, used: number[], sessions: ActivityRecord[]) {
  await harness.history.syncAgents(harness.world.executors.map((executor) => ({ executorId: executor.id, label: executor.label, kind: executor.kind, account: accountIdentity(executor) })));
  for (const entry of every5(0, used)) await harness.history.recordReading(accountIdentity(claudeA), entry);
  await harness.history.putActivities(sessions);
  harness.clock.set(at(used.length * 5 + 30));
  return harness.service.getDay(claudeA.id, T0, T0 + DAY);
}

test('U52 two overlapping sessions on one account each show the same shared decrease, flagged shared and never divided', async () => {
  const harness = analyticsHarness();
  const view = await dayWith(harness, [20, 23, 26, 29], [session(harness, 'one', at(2), at(12)), session(harness, 'two', at(3), at(11))]);
  const decreases = view.activities.map((activity) => activity.decrease.fiveHour);
  assert.deepEqual(decreases, [
    { available: true, points: 9, from: at(0), to: at(15), sharedWith: 1 },
    { available: true, points: 9, from: at(0), to: at(15), sharedWith: 1 },
  ]);
});

test('U48 the decrease is measured around the working time, not across a long wait after it', async () => {
  const harness = analyticsHarness();
  const waited = session(harness, 'waited', at(2), at(40), { segments: [{ state: 'active', start: at(2), end: at(4) }, { state: 'waiting', start: at(4), end: at(40) }] });
  const view = await dayWith(harness, [20, 23, 26, 29, 32, 35, 38, 41, 44, 47], [waited]);
  assert.deepEqual(view.activities[0]!.decrease.fiveHour, { available: true, points: 3, from: at(0), to: at(5), sharedWith: 0 });
});

test('U53 overlapping sessions on different accounts are not flagged shared', async () => {
  const harness = analyticsHarness({ executors: [claudeA, claudeB] });
  const other = session(harness, 'other-account', at(3), at(11), { account: accountIdentity(claudeB), executorId: claudeB.id });
  const view = await dayWith(harness, [20, 23, 26, 29], [session(harness, 'one', at(2), at(12)), other]);
  assert.deepEqual(view.activities.map((activity) => [activity.id, activity.decrease.fiveHour.sharedWith]), [['one', 0]]);
});

test('U56 a drop between readings with no tracked activity on the account is unattributed', async () => {
  const harness = analyticsHarness();
  const view = await dayWith(harness, [20, 20, 28, 28], []);
  assert.deepEqual(view.unattributed.filter((drop) => drop.window === 'fiveHour'), [{ window: 'fiveHour', from: at(5), to: at(10), points: 8 }]);
});

test('U56 unattributed drops that follow one another are reported as one stretch, and a tracked session splits them', async () => {
  const harness = analyticsHarness();
  // Falls at every reading; a session works only between the readings at minutes 15 and 20.
  const view = await dayWith(harness, [20, 22, 24, 26, 28, 30, 32], [session(harness, 'one', at(16), at(19))]);
  assert.deepEqual(view.unattributed.filter((drop) => drop.window === 'fiveHour'), [
    { window: 'fiveHour', from: at(0), to: at(15), points: 6 },
    { window: 'fiveHour', from: at(20), to: at(30), points: 4 },
  ]);
});

test('U56 level readings do not split an unattributed stretch, but a reset does', async () => {
  const level = analyticsHarness();
  const joined = await dayWith(level, [20, 22, 22, 22, 25, 25], []);
  assert.deepEqual(joined.unattributed.filter((drop) => drop.window === 'fiveHour'), [{ window: 'fiveHour', from: at(0), to: at(20), points: 5 }]);
  const reset = analyticsHarness();
  const split = await dayWith(reset, [20, 22, 3, 3, 6], []);
  assert.deepEqual(split.unattributed.filter((drop) => drop.window === 'fiveHour').map((drop) => [drop.from, drop.to, drop.points]), [[at(0), at(5), 2], [at(15), at(20), 3]]);
});

test('U57 a drop partly covered by tracked activity is not unattributed, and a waiting session does not cover one', async () => {
  const covered = analyticsHarness();
  const partly = await dayWith(covered, [20, 20, 28, 28], [session(covered, 'partly', at(8), at(9))]);
  assert.deepEqual(partly.unattributed, []);

  const waiting = analyticsHarness();
  const idle = session(waiting, 'idle', at(0), at(15), { segments: [{ state: 'waiting', start: at(0), end: at(15) }] });
  const view = await dayWith(waiting, [20, 20, 28, 28], [idle]);
  assert.equal(view.unattributed.filter((drop) => drop.window === 'fiveHour').length, 1);
});
