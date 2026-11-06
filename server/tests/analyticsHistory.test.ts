import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountIdentity } from '../src/analytics/accountIdentity.ts';
import { AnalyticsHistory, toQuotaReading } from '../src/analytics/analyticsHistory.ts';
import { configuredAgent } from '../src/analytics/quotaSampler.ts';
import { currentCapacity, remainingPercent } from '../src/analytics/quotaSeries.ts';
import { RETENTION_MS, type ActivityRecord } from '../src/analytics/types.ts';
import { analyticsHarness, claudeA, claudeA2, claudeB, DAY, fakeClock, limits, memoryStorage, MINUTE, reading, T0, taskRecord, tokens } from './helpers/analyticsFakes.ts';

const accountA = accountIdentity(claudeA);
const accountB = accountIdentity(claudeB);

function activity(id: string, startedAt: number, endedAt: number | null): ActivityRecord {
  return {
    id, account: accountA, executorId: claudeA.id, agentLabel: claudeA.label, kind: 'coding', projectId: 'project-1', projectName: 'Age of Agents',
    taskId: id, planItemId: null, label: 'Coding task', workflow: null,
    segments: [{ state: 'active', start: startedAt, end: endedAt }], startedAt, endedAt, lastSeenAt: endedAt ?? startedAt, approximate: false, tokens: null,
  };
}

test('U01 remaining is 100 minus the provider used percentage', () => {
  assert.equal(remainingPercent(22), 78);
  assert.equal(remainingPercent(0), 100);
  assert.equal(remainingPercent(100), 0);
});

test('U02 a window the provider did not report stays null, never 0 or 100', () => {
  const stored = toQuotaReading(limits(T0, 22, null));
  assert.equal(stored.sevenDay, null);
  const current = currentCapacity(stored, 'sevenDay', T0, null);
  assert.deepEqual([current.state, current.remaining, current.used], ['unavailable', null, null]);
});

test('U03 one reading holds a valid window beside an unavailable one, either way round', async () => {
  const { history } = analyticsHarness();
  await history.recordReading(accountA, toQuotaReading(limits(T0, 22, null)));
  await history.recordReading(accountA, toQuotaReading(limits(T0 + 5 * MINUTE, null, 40)));
  const [first, second] = await history.readingsFor(accountA);
  assert.deepEqual([first!.fiveHour?.usedPercentage, first!.sevenDay], [22, null]);
  assert.deepEqual([second!.fiveHour, second!.sevenDay?.usedPercentage], [null, 40]);
});

test('U04 a reading keeps the provider observation time, not the time it was saved', async () => {
  const { history, clock } = analyticsHarness();
  clock.set(T0 + 3 * MINUTE);
  await history.recordReading(accountA, toQuotaReading(limits(T0, 22, 10, { fiveHour: T0 + 60 * MINUTE })));
  const [stored] = await history.readingsFor(accountA);
  assert.equal(stored!.at, T0);
  assert.equal(stored!.fiveHour?.resetsAt, T0 + 60 * MINUTE);
});

test('U05 the same account and observation time stored twice keeps one point', async () => {
  const { history } = analyticsHarness();
  assert.equal(await history.recordReading(accountA, reading(T0, 22)), true);
  assert.equal(await history.recordReading(accountA, reading(T0, 22)), false);
  assert.equal((await history.readingsFor(accountA)).length, 1);
});

test('U06 the same percentages at a later observation time are a new point', async () => {
  const { history } = analyticsHarness();
  await history.recordReading(accountA, reading(T0, 22));
  assert.equal(await history.recordReading(accountA, reading(T0 + 5 * MINUTE, 22)), true);
  assert.deepEqual((await history.readingsFor(accountA)).map((r) => r.at), [T0, T0 + 5 * MINUTE]);
});

test('U07 two profiles on one account share one stored reading, readable from either', async () => {
  assert.equal(accountIdentity(claudeA2), accountA);
  const { history } = analyticsHarness();
  await history.recordReading(accountIdentity(claudeA), reading(T0, 22));
  assert.equal(await history.recordReading(accountIdentity(claudeA2), reading(T0, 22)), false);
  assert.equal((await history.readingsFor(accountIdentity(claudeA2))).length, 1);
});

test('U08 two profiles on different accounts keep separate series', async () => {
  assert.notEqual(accountA, accountB);
  const { history } = analyticsHarness();
  await history.recordReading(accountA, reading(T0, 22));
  await history.recordReading(accountB, reading(T0, 70));
  assert.deepEqual((await history.readingsFor(accountA)).map((r) => r.fiveHour?.usedPercentage), [22]);
  assert.deepEqual((await history.readingsFor(accountB)).map((r) => r.fiveHour?.usedPercentage), [70]);
});

test('U09 the saved file holds a derived account id: no token, credential path or environment value', async () => {
  const secretProfile = { ...claudeA, id: 'secret', env: { CLAUDE_CONFIG_DIR: '/tmp/SECRET-CREDENTIAL-DIR', ANTHROPIC_API_KEY: 'sk-SECRET-TOKEN' } };
  const { history, storage } = analyticsHarness();
  await history.syncAgents([configuredAgent(secretProfile)]);
  await history.recordReading(accountIdentity(secretProfile), reading(T0, 22));
  const saved = [...storage.files.values()].join('\n');
  assert.match(accountIdentity(secretProfile), /^[0-9a-f]{16}$/);
  assert.ok(saved.includes(accountIdentity(secretProfile)));
  for (const secret of ['SECRET-CREDENTIAL-DIR', 'sk-SECRET-TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']) assert.ok(!saved.includes(secret), `${secret} must not be saved`);
});

test('U10 pruning drops readings older than 90 days and keeps one exactly at the boundary', async () => {
  const { history, clock } = analyticsHarness();
  await history.recordReading(accountA, reading(T0 - 1, 10));
  await history.recordReading(accountA, reading(T0, 20));
  await history.recordReading(accountA, reading(T0 + DAY, 30));
  clock.set(T0 + RETENTION_MS);
  await history.pruneExpired();
  assert.deepEqual((await history.readingsFor(accountA)).map((r) => r.at), [T0, T0 + DAY]);
});

test('U11 pruning drops activity that ended over 90 days ago and keeps one that started earlier but ended inside retention', async () => {
  const { history, clock } = analyticsHarness();
  await history.putActivities([
    activity('ended-long-ago', T0 - 2 * DAY, T0 - DAY),
    activity('started-early-ended-inside', T0 - 2 * DAY, T0 + DAY),
    activity('still-running', T0 - 2 * DAY, null),
  ]);
  clock.set(T0 + RETENTION_MS);
  await history.pruneExpired();
  assert.deepEqual((await history.activities()).map((record) => record.id).sort(), ['started-early-ended-inside', 'still-running']);
});

test('U12 history saved by one instance is read back by a fresh one, as after a restart', async () => {
  const first = analyticsHarness();
  await first.history.syncAgents([configuredAgent(claudeA)]);
  await first.history.recordReading(accountA, reading(T0, 22, 40));
  await first.history.recordFailure(accountA, { at: T0 + 5 * MINUTE, reason: 'provider-error' });
  await first.history.putActivities([activity('task-1', T0, T0 + MINUTE)]);
  await first.history.assignSessionUsage('session-1', tokens(10, 5), { ...activity('task-1', T0, T0 + MINUTE), tokens: tokens(10, 5) });

  const restarted = new AnalyticsHistory({ storage: memoryStorage(first.storage.files), now: fakeClock(T0 + DAY).now });
  assert.deepEqual(await restarted.readingsFor(accountA), [reading(T0, 22, 40)]);
  assert.deepEqual(await restarted.failuresFor(accountA), [{ at: T0 + 5 * MINUTE, reason: 'provider-error' }]);
  assert.deepEqual((await restarted.activity('task-1'))?.tokens, tokens(10, 5));
  assert.deepEqual(await restarted.sessionUsage('session-1'), tokens(10, 5));
  assert.equal(await restarted.startedAt(), T0);
  assert.equal((await restarted.agentLinks())[0]?.executorId, claudeA.id);
});

test('U13 a corrupt history file gives an error state and is never overwritten with empty history', async () => {
  const storage = memoryStorage(new Map([['quota-history.json', '{ not json']]));
  const history = new AnalyticsHistory({ storage, now: fakeClock().now });
  assert.match((await history.status()).loadError ?? '', /could not be read/);
  await history.recordReading(accountA, reading(T0, 22));
  assert.equal(storage.files.get('quota-history.json'), '{ not json');
  assert.equal((await history.readingsFor(accountA)).length, 1, 'collection carries on in memory');
});

test('U13 an unreadable history file is reported the same way', async () => {
  const storage = memoryStorage();
  storage.failReads = true;
  const history = new AnalyticsHistory({ storage, now: fakeClock().now });
  assert.ok((await history.status()).loadError);
  await history.recordReading(accountA, reading(T0, 22));
  assert.equal(storage.writes, 0);
});

test('U14 a failed write keeps earlier readings in memory and reports a history-save error, which clears on the next good save', async () => {
  const { history, storage } = analyticsHarness();
  await history.recordReading(accountA, reading(T0, 22));
  storage.failWrites = true;
  assert.equal(await history.recordReading(accountA, reading(T0 + 5 * MINUTE, 25)), true);
  assert.match((await history.status()).saveError ?? '', /could not be saved/);
  assert.equal((await history.readingsFor(accountA)).length, 2);
  storage.failWrites = false;
  await history.recordReading(accountA, reading(T0 + 10 * MINUTE, 27));
  assert.equal((await history.status()).saveError, null);
});

test('U14 a failed save of one history file is not cleared by a good save of the other', async () => {
  const { history, storage } = analyticsHarness();
  storage.failWrites = 'quota-history.json';
  await history.recordReading(accountA, reading(T0, 22));
  await history.putActivities([activity('task-1', T0, T0 + MINUTE)]);
  assert.match((await history.status()).saveError ?? '', /could not be saved/);
  storage.failWrites = false;
  await history.recordReading(accountA, reading(T0 + 5 * MINUTE, 25));
  assert.equal((await history.status()).saveError, null);
});

test('U15 a failed poll is recorded with its time and leaves the last good reading untouched', async () => {
  const { history } = analyticsHarness();
  await history.recordReading(accountA, reading(T0, 22));
  assert.equal(await history.recordFailure(accountA, { at: T0 + 5 * MINUTE, reason: 'provider-error' }), true);
  assert.equal(await history.recordFailure(accountA, { at: T0 + 5 * MINUTE, reason: 'provider-error' }), false, 'one marker per failed check');
  assert.deepEqual(await history.readingsFor(accountA), [reading(T0, 22)]);
  assert.deepEqual(await history.failuresFor(accountA), [{ at: T0 + 5 * MINUTE, reason: 'provider-error' }]);
});

test('U16 a removed profile is retired with its last label, and a new profile on another account does not show its history', async () => {
  const { history, clock } = analyticsHarness();
  await history.syncAgents([configuredAgent(claudeA)]);
  await history.syncAgents([configuredAgent({ ...claudeA, label: 'Claude A renamed' })]);
  await history.recordReading(accountA, reading(T0, 22));
  clock.advance(DAY);
  const links = await history.syncAgents([configuredAgent(claudeB)]);
  const retired = links.find((link) => link.executorId === claudeA.id)!;
  assert.deepEqual([retired.label, retired.retiredAt], ['Claude A renamed', T0 + DAY]);
  const fresh = links.find((link) => link.executorId === claudeB.id)!;
  assert.equal(fresh.retiredAt, null);
  assert.deepEqual(await history.readingsFor(fresh.account), []);
});

test('U17 a new profile reusing a removed profile id and label on a different account does not inherit the old history', async () => {
  const { history, clock } = analyticsHarness();
  await history.syncAgents([configuredAgent(claudeA)]);
  await history.recordReading(accountA, reading(T0, 22));
  clock.advance(DAY);
  await history.syncAgents([]);
  clock.advance(DAY);
  const reused = { ...claudeB, id: claudeA.id, label: claudeA.label };
  const links = await history.syncAgents([configuredAgent(reused)]);
  const [old, current] = links;
  assert.deepEqual([old!.retiredAt, old!.account], [T0 + DAY, accountA]);
  assert.deepEqual([current!.retiredAt, current!.account, current!.executorId], [null, accountB, claudeA.id]);
  assert.notEqual(old!.id, current!.id);
  assert.deepEqual(await history.readingsFor(current!.account), []);
});

test('U17 a profile re-pointed at another account retires its old link in the same sync', async () => {
  const { history } = analyticsHarness();
  await history.syncAgents([configuredAgent(claudeA)]);
  const links = await history.syncAgents([configuredAgent({ ...claudeA, env: claudeB.env })]);
  assert.deepEqual(links.map((link) => [link.account, link.retiredAt === null]), [[accountA, false], [accountB, true]]);
});

test('U18 no reading exists for times before collection started, even when old Tasks exist', async () => {
  const harness = analyticsHarness();
  harness.world.tasks.add('old-task');
  // An old Task's record is all that exists; nothing has been sampled yet.
  harness.recorder.handle({ type: 'task', task: taskRecord({ id: 'old-task', status: 'done', runtimeStatus: 'completed', createdAt: new Date(T0 - 30 * DAY).toISOString() }) });
  await harness.recorder.idle();
  harness.claude.next = limits(T0, 22, 40);
  await harness.sampler.tick();
  assert.equal(await harness.history.startedAt(), T0);
  assert.deepEqual((await harness.history.readingsFor(accountA)).map((r) => r.at), [T0]);
  assert.deepEqual(await harness.history.activities(), []);
});

test('U18 a status-line reading observed before collection began is not taken in', async () => {
  const harness = analyticsHarness();
  harness.cached.set(claudeA.id, limits(T0 - DAY, 5, 5));
  harness.claude.next = new Error('offline');
  await harness.sampler.tick();
  assert.deepEqual(await harness.history.readingsFor(accountA), []);
});
