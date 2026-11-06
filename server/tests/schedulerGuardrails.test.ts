import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuildingTypeDefinition, ScheduledJobDeclaration } from '../src/buildings/contract.ts';
import { assertValidDefinition } from '../src/buildings/registry.ts';
import type { ExecutorLimits } from '../src/executors/executorLimits.ts';
import { declaredJobSettings } from '../src/scheduler/declarations.ts';
import {
  approvalGateIndex, compareDueStarts, dailyLimitReason, decideMissed, decideOverlap, decideUsage, durationMs, entriesToPrune,
  failureCountAfter, reachedFailureThreshold, runsOnDay, withApprovalGate,
} from '../src/scheduler/guardrails.ts';
import type { EntryOutcome } from '../src/scheduler/types.ts';

const at = (text: string): number => Date.parse(text);
const NOW = at('2026-10-11T05:50:00Z');
const seconds = (text: string): number => at(text) / 1000;
const limits = (fiveHour: [number, string | null] | null, sevenDay: [number, string | null] | null): ExecutorLimits => ({
  observedAt: NOW,
  fiveHour: fiveHour && { usedPercentage: fiveHour[0], resetsAt: fiveHour[1] === null ? null : seconds(fiveHour[1]) },
  sevenDay: sevenDay && { usedPercentage: sevenDay[0], resetsAt: sevenDay[1] === null ? null : seconds(sevenDay[1]) },
});
const gate = (maxFiveHourPercent: number | null, maxWeeklyPercent: number | null) => ({ maxFiveHourPercent, maxWeeklyPercent });

test('UG01 overlap skip with a run going skips, with the reason', () => {
  assert.deepEqual(decideOverlap('skip', { going: 1, queued: 0 }), { action: 'skip', reason: 'The previous run is still going' });
  assert.equal(decideOverlap('skip', { going: 0, queued: 1 }).action, 'skip', 'a start already waiting for a slot also holds the next one back');
});

test('UG02 overlap queue with a run going queues one; a second while one is queued is skipped', () => {
  assert.deepEqual(decideOverlap('queue', { going: 1, queued: 0 }), { action: 'queue' });
  assert.equal(decideOverlap('queue', { going: 1, queued: 1 }).action, 'skip');
  assert.equal(decideOverlap('queue', { going: 0, queued: 1 }).action, 'skip');
});

test('UG03 overlap parallel with a run going starts', () => {
  assert.deepEqual(decideOverlap('parallel', { going: 3, queued: 2 }), { action: 'start' });
});

test('UG04 with no run going, every rule starts', () => {
  for (const rule of ['skip', 'queue', 'parallel'] as const) assert.deepEqual(decideOverlap(rule, { going: 0, queued: 0 }), { action: 'start' });
});

test('UG05 the daily limit: below starts, at the limit skips with the count, and the day turns over at local midnight', () => {
  assert.equal(dailyLimitReason(2, 1), null);
  assert.equal(dailyLimitReason(2, 2), 'Daily limit of 2 runs reached');
  assert.equal(dailyLimitReason(1, 5), 'Daily limit of 1 run reached');
  assert.equal(dailyLimitReason(null, 999), null);
  const run = (text: string) => ({ runStartedAt: text });
  // 18:30 UTC is local midnight in Asia/Kolkata.
  const kolkata = [run('2026-10-10T18:29:59Z'), run('2026-10-10T18:30:00Z'), run('2026-10-11T05:00:00Z')];
  assert.equal(runsOnDay(kolkata, NOW, 'Asia/Kolkata'), 2);
  assert.equal(runsOnDay(kolkata, NOW, 'UTC'), 1);
  // 14 Mar 2027 has 23 hours in New York (05:00Z to 04:00Z); 1 Nov 2026 has 25 (04:00Z to 05:00Z).
  const shortDay = [run('2027-03-14T04:59:59Z'), run('2027-03-14T05:00:00Z'), run('2027-03-15T03:59:59Z'), run('2027-03-15T04:00:00Z')];
  assert.equal(runsOnDay(shortDay, at('2027-03-14T12:00:00Z'), 'America/New_York'), 2);
  const longDay = [run('2026-11-01T03:59:59Z'), run('2026-11-01T04:00:00Z'), run('2026-11-02T04:59:59Z'), run('2026-11-02T05:00:00Z')];
  assert.equal(runsOnDay(longDay, at('2026-11-01T12:00:00Z'), 'America/New_York'), 2);
});

test('UG06 the daily count is the runs that started, however they were started', () => {
  const today = '2026-10-11T03:00:00Z';
  const entries = [
    { runStartedAt: today }, // schedule
    { runStartedAt: today }, // run now
    { runStartedAt: today }, // catch-up
    { runStartedAt: null }, // skipped
    { runStartedAt: null }, // check failed
    { runStartedAt: null }, // deferred, not started yet
  ];
  assert.equal(runsOnDay(entries, NOW, 'UTC'), 3);
});

test('UG07 the 5-hour gate starts at the limit and defers above it until the reset', () => {
  assert.deepEqual(decideUsage(gate(80, null), limits([80, '2026-10-11T08:00:00Z'], null), NOW), { action: 'start' });
  assert.deepEqual(decideUsage(gate(80, null), limits([80.1, '2026-10-11T08:00:00Z'], null), NOW), {
    action: 'defer', until: at('2026-10-11T08:00:00Z'), reason: '5-hour usage is at 80.1% (limit 80%)',
  });
  assert.deepEqual(decideUsage(gate(null, null), limits([100, '2026-10-11T08:00:00Z'], [100, null]), NOW), { action: 'start' }, 'no limit set, no gate');
});

test('UG08 the weekly gate likewise; with both over, the start waits for the later reset', () => {
  assert.deepEqual(decideUsage(gate(null, 90), limits([99, '2026-10-11T08:00:00Z'], [91, '2026-10-14T00:00:00Z']), NOW), {
    action: 'defer', until: at('2026-10-14T00:00:00Z'), reason: 'Weekly usage is at 91% (limit 90%)',
  });
  const both = decideUsage(gate(80, 90), limits([85, '2026-10-11T08:00:00Z'], [95, '2026-10-14T00:00:00Z']), NOW);
  assert.deepEqual(both, { action: 'defer', until: at('2026-10-14T00:00:00Z'), reason: '5-hour usage is at 85% (limit 80%); Weekly usage is at 95% (limit 90%)' });
});

test('UG09 no usage reading starts; over the limit with no reset time skips and says so', () => {
  assert.deepEqual(decideUsage(gate(80, 90), null, NOW), { action: 'start' });
  assert.deepEqual(decideUsage(gate(80, 90), limits(null, [50, null]), NOW), { action: 'start' }, 'a window with no reading does not gate');
  assert.deepEqual(decideUsage(gate(80, null), limits([90, null], null), NOW), { action: 'skip', reason: '5-hour usage is at 90% (limit 80%), and the reset time is not known' });
});

test('UG10 a reading whose reset time has passed does not defer forever', () => {
  assert.deepEqual(decideUsage(gate(80, null), limits([95, '2026-10-11T05:00:00Z'], null), NOW), { action: 'start' });
  assert.deepEqual(decideUsage(gate(80, null), limits([95, '2026-10-11T05:50:00Z'], null), NOW), { action: 'start' }, 'a reset exactly now has happened');
});

test('UG11 the failure counter: failed adds one, succeeded resets, everything else leaves it', () => {
  assert.equal(failureCountAfter(1, 'failed'), 2);
  assert.equal(failureCountAfter(2, 'succeeded'), 0);
  for (const outcome of ['stopped', 'skipped', 'deferred', 'check-failed', 'queued', 'running', 'awaiting-approval'] as EntryOutcome[]) assert.equal(failureCountAfter(2, outcome), 2, outcome);
});

test('UG12 reaching the threshold turns the job off; a threshold of 1 does so on the first failure', () => {
  assert.equal(reachedFailureThreshold(2, 3), false);
  assert.equal(reachedFailureThreshold(3, 3), true);
  assert.equal(reachedFailureThreshold(failureCountAfter(0, 'failed'), 1), true);
  // Switching the job back on starts the count from 0 (the engine's reset), so the next failure is the first again.
  assert.equal(reachedFailureThreshold(failureCountAfter(0, 'failed'), 3), false);
});

test('UG13 the missed-run policy: skip records one entry, once catches up with one run, nothing missed does nothing', () => {
  assert.deepEqual(decideMissed('skip', NOW), { action: 'record-skip' });
  assert.deepEqual(decideMissed('once', NOW), { action: 'catch-up' });
  for (const policy of ['skip', 'once'] as const) assert.deepEqual(decideMissed(policy, null), { action: 'none' });
});

test('UG14 a poll job never catches up', () => {
  assert.deepEqual(decideMissed(null, NOW), { action: 'none' });
});

test('UG15 due starts are ordered by due time, then the job\'s creation time, then its id, whatever order they arrive in', () => {
  const start = (dueAt: string, createdAt: string, id: string) => ({ dueAt, job: { createdAt, id } });
  const ordered = [
    start('2026-10-11T09:00:00.000Z', '2026-02-01T00:00:00.000Z', 'z'),
    start('2026-10-11T10:00:00.000Z', '2026-01-01T00:00:00.000Z', 'a'),
    start('2026-10-11T10:00:00.000Z', '2026-01-01T00:00:00.000Z', 'b'),
    start('2026-10-11T10:00:00.000Z', '2026-03-01T00:00:00.000Z', '0'),
  ];
  const ids = (starts: typeof ordered) => starts.map((s) => s.job.id);
  for (const shuffled of [[...ordered].reverse(), [ordered[2]!, ordered[0]!, ordered[3]!, ordered[1]!], [ordered[1]!, ordered[3]!, ordered[2]!, ordered[0]!]]) {
    assert.deepEqual(ids(shuffled.sort(compareDueStarts)), ['z', 'a', 'b', '0']);
  }
});

test('UG16 the approval gate waits before the last step, after a single step, and never twice in one place', () => {
  const steps = (...approvals: boolean[]) => approvals.map((requiresApproval, index) => ({ id: `s${index}`, requiresApproval }));
  assert.equal(approvalGateIndex(steps(false, false, false)), 1);
  assert.deepEqual(withApprovalGate(steps(false, false, false)).map((s) => s.requiresApproval), [false, true, false]);
  assert.equal(approvalGateIndex(steps(false)), 0);
  assert.deepEqual(withApprovalGate(steps(false)).map((s) => s.requiresApproval), [true]);
  assert.equal(approvalGateIndex(steps(false, false, true)), 1, 'a last step that is an approval step pauses only after it has run, so the gate still goes before it');
  assert.equal(approvalGateIndex(steps(false, true)), 0);
  assert.equal(approvalGateIndex(steps(true, true)), null);
  assert.equal(approvalGateIndex(steps(false, true, false)), null, 'the step before the last already pauses');
  assert.equal(approvalGateIndex(steps(true)), null);
  assert.equal(approvalGateIndex(steps(false, false)), 0);
  assert.equal(approvalGateIndex([]), null);
  const original = steps(false, false);
  withApprovalGate(original);
  assert.deepEqual(original.map((s) => s.requiresApproval), [false, false], 'the workflow handed in is not changed');
});

test('UG17 history pruning keeps the newest 200 and never drops an entry whose start has not finished', () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ id: `e${i + 1}`, seq: i + 1, outcome: 'succeeded' as EntryOutcome }));
  const open: [number, EntryOutcome][] = [[1, 'running'], [2, 'queued'], [3, 'deferred'], [4, 'awaiting-approval']];
  for (const [seq, outcome] of open) entries[seq - 1]!.outcome = outcome;
  const pruned = entriesToPrune(entries);
  assert.deepEqual(pruned.sort(), entries.slice(4, 54).map((e) => e.id).sort(), 'the four open entries stay, so 196 finished ones do');
  assert.equal(entries.length - pruned.length, 200);
  assert.deepEqual(entriesToPrune(entries.slice(0, 200)), []);
  assert.deepEqual(entriesToPrune([...entries].reverse(), 249), ['e5'], 'the order handed in does not matter');
  assert.deepEqual(entriesToPrune(entries.slice(0, 4), 2), [], 'open entries are kept even past the limit');
});

test('UG18 a duration is finish minus start, null while going, and never negative', () => {
  assert.equal(durationMs('2026-10-11T09:00:00.000Z', '2026-10-11T09:14:00.000Z'), 14 * 60_000);
  assert.equal(durationMs('2026-10-11T09:00:00.000Z', null), null);
  assert.equal(durationMs(null, '2026-10-11T09:00:00.000Z'), null);
  assert.equal(durationMs('2026-10-11T09:00:00.000Z', '2026-10-11T08:59:00.000Z'), 0);
});

const SLOTS = [{ id: 'review', label: 'Review', usedWhen: 'x', defaultWorkflowId: 'w' }, { id: 'publish', label: 'Publish', usedWhen: 'x', defaultWorkflowId: 'w' }];
const typeWith = (scheduledJobs: ScheduledJobDeclaration[]): BuildingTypeDefinition => ({
  id: 'scheduled-type', name: 'Scheduled', description: 'A type with declared jobs.', category: 'Test', version: 1,
  look: { model: 'generic', color: '#fff' }, workspace: 'notes', repository: false,
  validateCreate: () => ({ ok: true, value: { name: 'x' } }),
  slots: SLOTS, agents: [], scheduledJobs, capabilities: [], events: [],
});

test('UG19 declared jobs come out in their declared state; a bad declaration fails type registration naming scheduledJobs', () => {
  const on = declaredJobSettings({ id: 'weekly', description: 'Review every week', cron: '0 9 * * 1', enabled: true, slotId: 'publish', name: 'Weekly', task: 'Publish it.', overlap: 'queue', needsApproval: true }, SLOTS);
  assert.deepEqual(on.ok && on.value, {
    name: 'Weekly', enabled: true, trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'slot', slotId: 'publish', description: 'Publish it.' },
    overlap: 'queue', missedPolicy: 'skip', maxRunsPerDay: null, maxFiveHourPercent: null, maxWeeklyPercent: null, needsApproval: true, failureThreshold: 3,
  });
  const off = declaredJobSettings({ id: 'daily', description: 'Check daily', cron: '@daily' }, SLOTS);
  assert.deepEqual(off.ok && [off.value.enabled, off.value.name, off.value.target], [false, 'Check daily', { kind: 'slot', slotId: 'review', description: 'Check daily' }]);

  assert.doesNotThrow(() => assertValidDefinition(typeWith([{ id: 'a', description: 'A', cron: '@daily' }, { id: 'b', description: 'B', cron: '@hourly' }])));
  const bad: [ScheduledJobDeclaration[], RegExp][] = [
    [[{ id: 'a', description: 'A', cron: '61 * * * *' }], /scheduledJobs job "a" is not valid: Invalid cron/],
    [[{ id: 'a', description: 'A', cron: '@daily' }, { id: 'a', description: 'B', cron: '@daily' }], /scheduledJobs has a duplicate job id "a"/],
    [[{ id: 'a', description: 'A', cron: '@daily', slotId: 'ghost' }], /scheduledJobs job "a" is not valid: .*"ghost"/],
    [[{ id: '', description: 'A', cron: '@daily' }], /scheduledJobs has a job without an id/],
  ];
  for (const [jobs, problem] of bad) assert.throws(() => assertValidDefinition(typeWith(jobs)), problem);
  assert.throws(() => assertValidDefinition({ ...typeWith([{ id: 'a', description: 'A', cron: '@daily' }]), slots: [] }), /scheduledJobs/, 'a type with no slot cannot declare a job');
});
