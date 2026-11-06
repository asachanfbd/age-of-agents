import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseLimits, readExecutorLimits } from '../src/executors/executorLimits.ts';

test('validates quota data without treating zero or missing windows as full usage', () => {
  assert.equal(parseLimits({}), null);
  assert.deepEqual(parseLimits({ observed_at: 100, rate_limits: { five_hour: { used_percentage: 0, resets_at: 200 } } }), {
    observedAt: 100, fiveHour: { usedPercentage: 0, resetsAt: 200 }, sevenDay: null,
  });
  assert.equal(parseLimits({ observed_at: 100, rate_limits: { five_hour: { used_percentage: 101 } } }), null);
});

test('status-line cache preserves last data and isolates profile directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-test-'));
  try {
    const run = (payload: object) => execFileSync('bash', ['-c', 'input=$(cat); source scripts/statusline-usage-cache.sh'], {
      cwd: new URL('../', import.meta.url), input: JSON.stringify(payload), env: { ...process.env, CLAUDE_CONFIG_DIR: directory },
    });
    run({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 2000000000 } }, secret: 'must not be cached' });
    const profile = { id: 'test', label: 'test', kind: 'claude-cli' as const, bin: 'claude', env: { CLAUDE_CONFIG_DIR: directory } };
    assert.equal((await readExecutorLimits(profile))?.fiveHour?.usedPercentage, 42);
    assert.equal((await readFile(join(directory, 'context-village-usage.json'), 'utf8')).includes('secret'), false);
    run({});
    assert.equal((await readExecutorLimits(profile))?.fiveHour?.usedPercentage, 42);
    assert.equal(await readExecutorLimits({ ...profile, env: { CLAUDE_CONFIG_DIR: join(directory, 'other') } }), null);
    await writeFile(join(directory, 'context-village-usage.json'), 'broken');
    assert.equal(await readExecutorLimits(profile), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
