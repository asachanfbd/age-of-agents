import assert from 'node:assert/strict';
import { test } from 'node:test';

const { availableExecutors, mostRemainingExecutorId } = await import('../src/lib/executorAvailability.ts');

const executor = (id, limits) => ({
  id,
  label: id,
  kind: 'claude-cli',
  usage: { totalTokens: 0, taskCount: 0 },
  limits,
});

test('availableExecutors hides accounts whose active quota window is exhausted', () => {
  const now = 2_000;
  const available = executor('available', {
    observedAt: now,
    fiveHour: { usedPercentage: 80, resetsAt: 3_000 },
    sevenDay: { usedPercentage: 20, resetsAt: 4_000 },
  });
  const exhausted = executor('exhausted', {
    observedAt: now,
    fiveHour: { usedPercentage: 100, resetsAt: 3_000 },
    sevenDay: { usedPercentage: 20, resetsAt: 4_000 },
  });

  assert.deepEqual(availableExecutors([available, exhausted], now).map(({ id }) => id), ['available']);
});

test('availableExecutors keeps unknown usage and accounts whose quota has reset', () => {
  const now = 2_000;
  const unknown = executor('unknown', null);
  const reset = executor('reset', {
    observedAt: 1_000,
    fiveHour: { usedPercentage: 100, resetsAt: 1_500 },
    sevenDay: null,
  });

  assert.deepEqual(availableExecutors([unknown, reset], now).map(({ id }) => id), ['unknown', 'reset']);
});

test('mostRemainingExecutorId chooses the account with the lowest active quota usage', () => {
  const now = 2_000;
  const limits = (fiveHour, sevenDay) => ({
    observedAt: now,
    fiveHour: { usedPercentage: fiveHour, resetsAt: 3_000 },
    sevenDay: { usedPercentage: sevenDay, resetsAt: 4_000 },
  });

  assert.equal(mostRemainingExecutorId([
    executor('busy', limits(70, 10)),
    executor('weekly-busy', limits(20, 80)),
    executor('most-remaining', limits(20, 30)),
  ], now), 'most-remaining');
});

test('mostRemainingExecutorId skips exhausted accounts and treats reset windows as unused', () => {
  const now = 2_000;
  const exhausted = executor('exhausted', {
    observedAt: now,
    fiveHour: { usedPercentage: 100, resetsAt: 3_000 },
    sevenDay: { usedPercentage: 5, resetsAt: 4_000 },
  });
  const active = executor('active', {
    observedAt: now,
    fiveHour: { usedPercentage: 10, resetsAt: 3_000 },
    sevenDay: { usedPercentage: 10, resetsAt: 4_000 },
  });
  const reset = executor('reset', {
    observedAt: now,
    fiveHour: { usedPercentage: 100, resetsAt: 1_500 },
    sevenDay: { usedPercentage: 10, resetsAt: 4_000 },
  });

  assert.equal(mostRemainingExecutorId([exhausted, active, reset], now), 'reset');
  assert.equal(mostRemainingExecutorId([exhausted], now), '');
});
