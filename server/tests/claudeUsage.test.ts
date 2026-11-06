import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeUsagePoller, parseOAuthUsage, credentialLocation } from '../src/executors/claudeUsage.ts';
import { SCHEDULE_TOLERANCE_MS, USAGE_REFRESH_MS } from '../src/executors/usagePoller.ts';

const profile = { id: 'a', label: 'A', kind: 'claude-cli' as const, bin: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/usage-account-a' } };
const payload = { five_hour: { utilization: 0, resets_at: '2026-09-15T10:00:00Z' }, seven_day: { utilization: 38, resets_at: '2026-09-20T10:00:00Z' } };

test('normalizes OAuth windows and rejects malformed data', () => {
  assert.deepEqual(parseOAuthUsage(payload, 100)?.fiveHour, { usedPercentage: 0, resetsAt: Date.parse(payload.five_hour.resets_at) / 1000 });
  assert.equal(parseOAuthUsage({ five_hour: { utilization: '42' } }, 100), null);
  assert.equal(parseOAuthUsage({ seven_day: payload.seven_day }, 100)?.fiveHour, null);
});

test('deduplicates concurrent requests and waits about five minutes between polls', async () => {
  let now = 1_000_000;
  let calls = 0;
  const poller = new ClaudeUsagePoller({ now: () => now, token: async () => 'test-token', version: async () => '2.1.270', fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(new Headers(options?.headers).get('user-agent'), 'claude-code/2.1.270');
    assert.equal(options?.redirect, 'error');
    return Response.json(payload);
  } });
  await Promise.all([poller.refresh([profile]), poller.refresh([{ ...profile, id: 'same-account' }])]);
  assert.equal(calls, 1);
  // A scheduled check is let through slightly ahead of the full interval, never well inside it.
  now += USAGE_REFRESH_MS - SCHEDULE_TOLERANCE_MS - 1;
  await poller.refresh([profile]);
  assert.equal(calls, 1);
  now++;
  await poller.refresh([profile]);
  assert.equal(calls, 2);
  assert.equal(poller.get(profile)?.sevenDay?.usedPercentage, 38);
  assert.equal(poller.get({ ...profile, env: { CLAUDE_CONFIG_DIR: '/tmp/usage-account-b' } }), null);
});

test('429 retry-after zero backs off and preserves last good usage', async () => {
  let now = 1_000_000;
  let calls = 0;
  const poller = new ClaudeUsagePoller({ now: () => now, token: async () => 'test-token', version: async () => '2.1.270', fetch: async () => {
    calls++;
    return calls === 1 ? Response.json(payload) : new Response('', { status: 429, headers: { 'retry-after': '0' } });
  } });
  await poller.refresh([profile]);
  const last = poller.get(profile);
  now += USAGE_REFRESH_MS;
  await poller.refresh([profile]);
  now += USAGE_REFRESH_MS;
  await poller.refresh([profile]);
  assert.equal(calls, 2);
  assert.deepEqual(poller.get(profile), last);
  now += USAGE_REFRESH_MS;
  await poller.refresh([profile]);
  assert.equal(calls, 3);
});

test('honors longer retry-after and skips missing credentials and unsupported executors', async () => {
  let now = 1_000_000;
  let calls = 0;
  const poller = new ClaudeUsagePoller({ now: () => now, token: async e => e.id === 'a' ? 'test-token' : null, version: async () => '2.1.270', fetch: async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'retry-after': '1800' } });
  } });
  await poller.refresh([profile, { ...profile, kind: 'codex-cli' }, { ...profile, id: 'no-login', env: { CLAUDE_CONFIG_DIR: '/tmp/no-login' } }]);
  assert.equal(calls, 1);
  now += 1200_000;
  await poller.refresh([profile]);
  assert.equal(calls, 1);
  now += 600_000;
  await poller.refresh([profile]);
  assert.equal(calls, 2);
});

test('secure storage override uses a separate credential identity', () => {
  assert.notEqual(credentialLocation(profile).service, credentialLocation({ ...profile, env: { ...profile.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/other' } }).service);
  assert.equal(credentialLocation({ ...profile, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' } }).service, 'Claude Code-credentials');
});
