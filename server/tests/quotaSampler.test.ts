import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountIdentity } from '../src/analytics/accountIdentity.ts';
import { QuotaSampler } from '../src/analytics/quotaSampler.ts';
import { ClaudeUsagePoller } from '../src/executors/claudeUsage.ts';
import { CodexUsagePoller } from '../src/executors/codexUsage.ts';
import { MANUAL_REFRESH_MIN_MS, SCHEDULE_TOLERANCE_MS, USAGE_REFRESH_MS, UsageReadError } from '../src/executors/usagePoller.ts';
import { analyticsHarness, claudeA, claudeA2, codex, HOUR, limits, MINUTE, T0 } from './helpers/analyticsFakes.ts';

const accountA = accountIdentity(claudeA);

/** Lets the sampler's async tick, started by a timer, run to completion. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('U19 the sampler samples at start and then every five minutes on a timer, with no client connected', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const harness = analyticsHarness();
  harness.claude.next = limits(T0, 10, 20);
  const stop = harness.sampler.start();
  await settle();
  assert.equal(harness.claude.calls, 1);
  for (let round = 1; round <= 3; round += 1) {
    harness.clock.advance(USAGE_REFRESH_MS);
    harness.claude.next = limits(harness.clock.now(), 10 + round, 20);
    t.mock.timers.tick(USAGE_REFRESH_MS);
    await settle();
  }
  assert.equal(USAGE_REFRESH_MS, 5 * MINUTE);
  assert.deepEqual((await harness.history.readingsFor(accountA)).map((r) => r.at), [0, 1, 2, 3].map((n) => T0 + n * USAGE_REFRESH_MS));
  stop();
  harness.clock.advance(USAGE_REFRESH_MS);
  t.mock.timers.tick(USAGE_REFRESH_MS);
  await settle();
  assert.equal(harness.claude.calls, 4, 'a stopped sampler no longer samples');
});

test('U19 a provider that takes time to answer still gets one check, and one stored reading, per five-minute tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const harness = analyticsHarness();
  harness.claude.readMs = 800;
  harness.claude.next = limits(T0, 10, 20);
  const stop = harness.sampler.start();
  await settle();
  for (let round = 1; round <= 6; round += 1) {
    // The timer fires one interval after the previous tick began, not after the provider answered.
    harness.clock.set(T0 + round * USAGE_REFRESH_MS);
    harness.claude.next = limits(harness.clock.now(), 10 + round, 20);
    t.mock.timers.tick(USAGE_REFRESH_MS);
    await settle();
  }
  stop();
  assert.equal(harness.claude.calls, 7);
  assert.deepEqual((await harness.history.readingsFor(accountA)).map((r) => r.at), [0, 1, 2, 3, 4, 5, 6].map((n) => T0 + n * USAGE_REFRESH_MS));
});

test('U19 a scheduled tick arriving a moment early is let through, and one well inside the interval is not', async () => {
  const harness = analyticsHarness();
  harness.claude.next = limits(T0, 10, 20);
  await harness.sampler.tick();
  harness.clock.set(T0 + USAGE_REFRESH_MS - SCHEDULE_TOLERANCE_MS - 1);
  await harness.sampler.tick();
  assert.equal(harness.claude.calls, 1, 'still inside the interval');
  harness.clock.advance(1);
  harness.claude.next = limits(harness.clock.now(), 11, 20);
  await harness.sampler.tick();
  assert.equal(harness.claude.calls, 2);
  assert.equal((await harness.history.readingsFor(accountA)).length, 2);
});

test('U20 a tick during provider backoff adds no point and no duplicate', async () => {
  const harness = analyticsHarness();
  harness.claude.next = limits(T0, 10, 20);
  await harness.sampler.tick();
  harness.claude.next = new UsageReadError('provider-error');
  harness.clock.advance(USAGE_REFRESH_MS);
  await harness.sampler.tick();
  assert.equal(harness.claude.calls, 2);
  // Backing off for ten minutes: the next tick does not reach the provider.
  harness.clock.advance(USAGE_REFRESH_MS - 1);
  await harness.sampler.tick();
  assert.equal(harness.claude.calls, 2);
  assert.deepEqual((await harness.history.readingsFor(accountA)).map((r) => r.at), [T0]);
  assert.deepEqual(await harness.history.failuresFor(accountA), [{ at: T0 + USAGE_REFRESH_MS, reason: 'provider-error' }]);
});

test('U21 a manual refresh while eligible calls the provider once and stores one point', async () => {
  const harness = analyticsHarness();
  harness.claude.next = limits(T0, 10, 20);
  await harness.sampler.tick();
  harness.clock.advance(MANUAL_REFRESH_MIN_MS);
  harness.claude.next = limits(harness.clock.now(), 12, 20);
  const outcome = await harness.sampler.refresh(claudeA);
  assert.deepEqual([outcome.result, outcome.failureReason, outcome.nextEligibleAt], ['refreshed', null, harness.clock.now() + MANUAL_REFRESH_MIN_MS]);
  assert.equal(harness.claude.calls, 2);
  assert.deepEqual((await harness.history.readingsFor(accountA)).map((r) => r.at), [T0, T0 + MANUAL_REFRESH_MIN_MS]);
});

test('U22 a manual refresh during backoff does not call the provider and says when another check is eligible', async () => {
  const harness = analyticsHarness();
  harness.claude.next = limits(T0, 10, 20);
  await harness.sampler.tick();
  harness.claude.next = new UsageReadError('provider-error');
  harness.clock.advance(USAGE_REFRESH_MS);
  await harness.sampler.tick();
  harness.clock.advance(MINUTE);
  const outcome = await harness.sampler.refresh(claudeA);
  assert.equal(harness.claude.calls, 2, 'the provider is not contacted inside backoff');
  assert.deepEqual([outcome.result, outcome.nextEligibleAt], ['not-eligible', T0 + USAGE_REFRESH_MS + 2 * USAGE_REFRESH_MS]);
  assert.deepEqual((await harness.history.readingsFor(accountA)).map((r) => r.at), [T0], 'the last good reading keeps its real time');
});

test('U22 a manual refresh right after a good check is throttled, not repeated', async () => {
  const harness = analyticsHarness();
  harness.claude.next = limits(T0, 10, 20);
  await harness.sampler.tick();
  harness.clock.advance(MANUAL_REFRESH_MIN_MS - 1);
  const outcome = await harness.sampler.refresh(claudeA);
  assert.deepEqual([outcome.result, outcome.nextEligibleAt, harness.claude.calls], ['not-eligible', T0 + MANUAL_REFRESH_MIN_MS, 1]);
});

test('U23 two manual refreshes at once share one provider call and store one point', async () => {
  const harness = analyticsHarness({ executors: [claudeA, claudeA2] });
  await harness.history.syncAgents([]);
  harness.claude.next = limits(T0, 10, 20);
  const outcomes = await Promise.all([harness.sampler.refresh(claudeA), harness.sampler.refresh(claudeA2)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.result), ['refreshed', 'refreshed']);
  assert.equal(harness.claude.calls, 1);
  assert.equal((await harness.history.readingsFor(accountA)).length, 1);
});

test('U24 a Retry-After response sets the next eligible time to at least that delay', async () => {
  let now = T0;
  const poller = new ClaudeUsagePoller({
    now: () => now, token: async () => 'test-token', version: async () => '2.1.270',
    fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '1800' } }),
  });
  await poller.refresh([claudeA]);
  const status = poller.status(claudeA)!;
  assert.deepEqual(status.lastFailure, { at: T0, reason: 'provider-error' });
  assert.ok(status.nextAttemptAt >= T0 + 1800_000 && status.nextManualAt >= T0 + 1800_000);
  now += 1799_000;
  await poller.refresh([claudeA], { manual: true });
  assert.deepEqual(poller.status(claudeA)!.lastFailure, { at: T0, reason: 'provider-error' }, 'no new attempt before Retry-After has passed');
});

test('U25 a refresh that returns only one window stores that window and leaves the other unavailable', async () => {
  const harness = analyticsHarness();
  await harness.history.syncAgents([]);
  harness.claude.next = limits(T0, 33, null);
  await harness.sampler.refresh(claudeA);
  const [stored] = await harness.history.readingsFor(accountA);
  assert.deepEqual([stored!.fiveHour?.usedPercentage, stored!.sevenDay], [33, null]);
});

test('U26 a check with no access token or no CLI version is a "no account access" failure, never a zero', async () => {
  for (const deps of [{ token: async () => null, version: async () => '2.1.270' }, { token: async () => 'test-token', version: async () => null }]) {
    const harness = analyticsHarness();
    const poller = new ClaudeUsagePoller({ now: harness.clock.now, fetch: async () => { throw new Error('must not be called'); }, ...deps });
    const sampler = new QuotaSampler({ history: harness.history, listExecutors: async () => [claudeA], pollers: { 'claude-cli': poller }, readLimits: async (executor) => poller.get(executor), now: harness.clock.now });
    await sampler.tick();
    assert.deepEqual(await harness.history.readingsFor(accountA), []);
    assert.deepEqual(await harness.history.failuresFor(accountA), [{ at: T0, reason: 'no-access' }]);
    assert.equal((await sampler.refresh(claudeA)).result, 'not-eligible');
    harness.clock.advance(MANUAL_REFRESH_MIN_MS);
    const retried = await sampler.refresh(claudeA);
    assert.deepEqual([retried.result, retried.failureReason], ['failed', 'no-access']);
  }
});

test('U27 a Codex read timeout or early exit is recorded as a failure and keeps the last reading', async () => {
  const harness = analyticsHarness({ executors: [codex] });
  let answer: unknown = { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 25, resetsAt: (T0 + HOUR) / 1000 } } };
  const poller = new CodexUsagePoller(async () => { if (answer instanceof Error) throw answer; return answer; }, harness.clock.now);
  const sampler = new QuotaSampler({ history: harness.history, listExecutors: async () => [codex], pollers: { 'codex-cli': poller }, readLimits: async (executor) => poller.get(executor), now: harness.clock.now });
  await sampler.tick();
  for (const failure of [new Error('Codex usage request timed out'), new Error('Codex usage reader exited early')]) {
    answer = failure;
    harness.clock.advance(HOUR);
    await sampler.tick();
  }
  const account = accountIdentity(codex);
  assert.deepEqual((await harness.history.readingsFor(account)).map((r) => [r.at, r.fiveHour?.usedPercentage, r.sevenDay]), [[T0, 25, null]]);
  assert.deepEqual((await harness.history.failuresFor(account)).map((f) => f.reason), ['provider-error', 'provider-error']);
  assert.equal(poller.get(codex)?.fiveHour?.usedPercentage, 25);
});
