import assert from 'node:assert/strict';
import test from 'node:test';
import { agentBarsLabel, limitBar } from '../src/lib/limitBars.ts';

const NOW = 1_000;
const used = (usedPercentage, resetsAt = NOW + 600) => ({ usedPercentage, resetsAt });

test('remaining is 100 minus the percent used', () => {
  assert.equal(limitBar(used(0), NOW).remaining, 100);
  assert.equal(limitBar(used(42), NOW).remaining, 58);
  assert.equal(limitBar(used(100), NOW).remaining, 0);
});

test('used above 100 or below 0 is clamped', () => {
  assert.equal(limitBar(used(150), NOW).remaining, 0);
  assert.equal(limitBar(used(100.0001), NOW).remaining, 0);
  assert.equal(limitBar(used(-5), NOW).remaining, 100);
});

test('levels: green above 30 remaining, orange at 30 or less, red at 10 or less, both inclusive', () => {
  const level = (usedPercentage) => limitBar(used(usedPercentage), NOW).level;
  assert.equal(level(0), 'green');
  assert.equal(level(69), 'green');       // 31 remaining
  assert.equal(level(70), 'orange');      // 30 remaining
  assert.equal(level(89), 'orange');      // 11 remaining
  assert.equal(level(90), 'red');         // 10 remaining
  assert.equal(level(100), 'red');        // 0 remaining
  assert.equal(level(69.9), 'green');      // 30.1 remaining
  assert.equal(level(90.1), 'red');
  assert.equal(level(89.5), 'orange');
});

test('unknown when the window is missing, its percent is not a number, or its reset time has passed', () => {
  for (const window of [null, undefined, used(Number.NaN), used(null), used('40'), used(10, NOW), used(10, NOW - 1), used(10, Number.NaN), used(10, '2026-01-01')]) {
    assert.deepEqual(limitBar(window, NOW), { remaining: null, level: 'unknown' });
  }
});

test('a window without a reset time keeps its value; the same reading turns unknown as time passes', () => {
  assert.equal(limitBar(used(12, null), NOW).remaining, 88);
  const reading = used(50, NOW + 10);
  assert.equal(limitBar(reading, NOW).level, 'green');
  assert.equal(limitBar(reading, NOW + 10).level, 'unknown');
});

test('the accessible name spells out both limits, rounded, and says it opens analytics', () => {
  const label = agentBarsLabel('Claude Pro', limitBar(used(41.6), NOW), limitBar(null, NOW));
  assert.equal(label, 'Claude Pro. 5-hour limit 58% remaining. 7-day limit unknown. Opens analytics');
  assert.match(agentBarsLabel('A', limitBar(used(58.4 + 0), NOW), limitBar(used(0), NOW)), /5-hour limit 42% remaining\. 7-day limit 100% remaining/);
});
