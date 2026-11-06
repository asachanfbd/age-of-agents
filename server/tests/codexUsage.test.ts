import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexUsagePoller, parseCodexLimits, readCodexRateLimits } from '../src/executors/codexUsage.ts';
import { USAGE_REFRESH_MS } from '../src/executors/usagePoller.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
const executor = { id: 'codex', label: 'Codex', kind: 'codex-cli' as const, bin: 'codex', env: {} };
const rateLimits = { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 3000 } };
test('uses Codex bucket and matches duration instead of assuming order', () => {
  const result = parseCodexLimits({ rateLimits: {}, rateLimitsByLimitId: { codex: { primary: rateLimits.secondary, secondary: rateLimits.primary } } }, 1000);
  assert.equal(result?.fiveHour?.usedPercentage, 25);
  assert.equal(result?.sevenDay?.usedPercentage, 50);
  assert.equal(parseCodexLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 15 } } }, 1000), null);
  assert.equal(parseCodexLimits({ rateLimits, rateLimitsByLimitId: { other: rateLimits } }, 1000), null);
  assert.equal(parseCodexLimits(null, 1000), null);
});
test('poller deduplicates, separates profiles, backs off and retains last good data', async () => {
  let now = 1_000_000, calls = 0, fail = false;
  const poller = new CodexUsagePoller(async () => { calls++; if (fail) throw Error('offline'); return { rateLimits }; }, () => now);
  await Promise.all([poller.refresh([executor]), poller.refresh([executor])]);
  assert.equal(calls, 1);
  await poller.refresh([executor]); assert.equal(calls, 1);
  await poller.refresh([{ ...executor, env: { CODEX_HOME: '/tmp/other' } }]); assert.equal(calls, 2);
  now += USAGE_REFRESH_MS; fail = true;
  await poller.refresh([executor]); assert.equal(calls, 3);
  assert.equal(poller.get(executor)?.fiveHour?.usedPercentage, 25);
  now += USAGE_REFRESH_MS;
  await poller.refresh([executor]); assert.equal(calls, 3);
});
test('stdio handshake requests only limits and closes the subprocess', async () => {
  const methods: string[] = []; let killed = false;
  const spawnFn = ((_bin: string, _args: string[], config: any) => {
    assert.equal(config.env.CODEX_HOME, '/tmp/account');
    const stdout = new PassThrough(), stdin = new PassThrough();
    stdin.on('data', data => {
      const msg = JSON.parse(data.toString()); methods.push(msg.method);
      setImmediate(() => {
        if (msg.id) stdout.write(JSON.stringify({ id: msg.id, result: msg.id === 1 ? {} : { rateLimits } }) + '\n');
      });
    });
    return Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), kill: () => { killed = true; } });
  }) as unknown as typeof spawn;
  assert.deepEqual(await readCodexRateLimits({ ...executor, env: { CODEX_HOME: '/tmp/account' } }, spawnFn), { rateLimits });
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.ok(killed);
});
