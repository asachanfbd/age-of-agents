import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPLETION_NOTIFY_MIN_MS, dropWatches, isRunWatched, MAX_WATCH_RUN_ID_LENGTH, parseWatchMessage, ranLongEnough, unwatchRun, watchRun,
} from '../src/notifications/runWatch.ts';
import { NOTIFICATION_KINDS, NOTIFICATION_SEVERITY_BY_KIND } from '../src/domain/types.ts';

test('a watch is per kind and run id, and ends on unwatch or when its owner drops', () => {
  const a = {}; const b = {};
  watchRun(a, 'command', 'r1');
  watchRun(b, 'test', 'r1');
  assert.equal(isRunWatched('command', 'r1'), true);
  assert.equal(isRunWatched('test', 'r1'), true);
  assert.equal(isRunWatched('command', 'r2'), false);
  unwatchRun(a, 'command', 'r1');
  assert.equal(isRunWatched('command', 'r1'), false);
  dropWatches(b);
  assert.equal(isRunWatched('test', 'r1'), false);
});

test('releasing a watch twice, or one never registered, does not throw', () => {
  const owner = {};
  unwatchRun(owner, 'command', 'never');
  watchRun(owner, 'command', 'x');
  unwatchRun(owner, 'command', 'x');
  unwatchRun(owner, 'command', 'x');
  dropWatches(owner);
  dropWatches(owner);
});

test('two windows watching the same run: one dropping does not unwatch the other', () => {
  const a = {}; const b = {};
  watchRun(a, 'command', 'shared'); watchRun(b, 'command', 'shared');
  dropWatches(a);
  assert.equal(isRunWatched('command', 'shared'), true);
  dropWatches(b);
});

test('ranLongEnough is inclusive at 10s and refuses bad input', () => {
  const start = '2026-01-01T00:00:00.000Z';
  const at = (ms: number) => Date.parse(start) + ms;
  assert.equal(COMPLETION_NOTIFY_MIN_MS, 10_000);
  assert.equal(ranLongEnough(start, at(9_900)), false);
  assert.equal(ranLongEnough(start, at(10_000)), true);
  assert.equal(ranLongEnough(start, at(3_600_000)), true);
  assert.equal(ranLongEnough(start, at(-5)), false);
  assert.equal(ranLongEnough(null, at(20_000)), false);
  assert.equal(ranLongEnough('not a date', at(20_000)), false);
  assert.equal(ranLongEnough(start, Number.NaN), false);
});

test('parseWatchMessage accepts watch/unwatch and rejects malformed frames', () => {
  assert.deepEqual(parseWatchMessage({ type: 'watchRun', kind: 'command', runId: 'r' }), { action: 'watch', kind: 'command', runId: 'r' });
  assert.deepEqual(parseWatchMessage({ type: 'unwatchRun', kind: 'test', runId: 'r' }), { action: 'unwatch', kind: 'test', runId: 'r' });
  for (const bad of [null, 'x', {}, { type: 'watchRun', kind: 'command' }, { type: 'watchRun', kind: 'command', runId: 5 },
    { type: 'watchRun', kind: 'nope', runId: 'r' }, { type: 'other', kind: 'command', runId: 'r' },
    { type: 'watchRun', kind: 'command', runId: 'x'.repeat(MAX_WATCH_RUN_ID_LENGTH + 1) }, { type: 'watchRun', kind: 'command', runId: '' }]) {
    assert.equal(parseWatchMessage(bad), null);
  }
});

test('the two completion kinds are registered with info severity', () => {
  for (const kind of ['command.completed', 'testing.passed'] as const) {
    assert.ok(NOTIFICATION_KINDS.includes(kind));
    assert.equal(NOTIFICATION_SEVERITY_BY_KIND[kind], 'info');
  }
});
