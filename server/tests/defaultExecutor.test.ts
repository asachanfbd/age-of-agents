import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutorProfile } from '../src/domain/types.ts';
import type { ExecutorLimits } from '../src/executors/executorLimits.ts';
import {
  DefaultExecutorNotFoundError, DefaultExecutorService, DefaultExecutorUnavailableError,
  exhaustion, isAvailable, pickMostQuotaLeft, unavailableReason,
  type DefaultChangedEvent, type DefaultExecutorStore,
} from '../src/executors/defaultExecutor.ts';

/** Task 19.001: the default coding agent's availability and ranking rules, sticky switching and notification. */

const NOW = Date.parse('2026-01-01T12:00:00Z');
const sec = (offsetMs: number) => (NOW + offsetMs) / 1000;
const HOUR = 3_600_000;
const win = (usedPercentage: number, resetOffsetMs: number | null) => ({ usedPercentage, resetsAt: resetOffsetMs === null ? null : sec(resetOffsetMs) });
const limits = (fiveHour: ReturnType<typeof win> | null, sevenDay: ReturnType<typeof win> | null = null): ExecutorLimits => ({ observedAt: 1, fiveHour, sevenDay });
const profile = (id: string, label = id): ExecutorProfile => ({ id, label, kind: 'claude-cli', bin: 'claude', env: {} });

interface Harness {
  service: DefaultExecutorService;
  executors: ExecutorProfile[];
  readings: Map<string, ExecutorLimits | null | 'throw'>;
  stored: { value: { executorId: string; label: string } | undefined; writes: number };
  events: DefaultChangedEvent[];
  raised: { title: string; description: string; kind: string; subject: unknown }[];
  resolved: number;
  gate?: { release: () => void };
}

function harness(ids: string[], options: { stored?: string; gateReads?: boolean } = {}): Harness {
  const h: Harness = {
    executors: ids.map((id) => profile(id, id.toUpperCase())),
    readings: new Map(),
    stored: { value: options.stored ? { executorId: options.stored, label: options.stored.toUpperCase() } : undefined, writes: 0 },
    events: [], raised: [], resolved: 0, service: undefined as never,
  };
  const store: DefaultExecutorStore = {
    get: async () => h.stored.value ? { id: 'default', ...h.stored.value } : undefined,
    set: async (value) => { h.stored.value = value; h.stored.writes += 1; },
    clear: async () => { h.stored.value = undefined; },
  };
  let latch: Promise<void> | null = null;
  if (options.gateReads) {
    latch = new Promise<void>((resolve) => { h.gate = { release: resolve }; });
  }
  h.service = new DefaultExecutorService({
    listExecutors: async () => h.executors,
    readLimits: async (executor) => {
      if (latch) await latch;
      const value = h.readings.get(executor.id);
      if (value === 'throw') throw new Error('boom');
      return value ?? null;
    },
    store,
    raise: async (input) => { h.raised.push(input); },
    resolve: async () => { h.resolved += 1; },
    now: () => NOW,
  });
  h.service.onEvent((event) => h.events.push(event));
  return h;
}

test('S01-S07 availability: missing limits, blocking windows, unknown reset, past reset, boundary and out-of-range percentages', () => {
  assert.equal(isAvailable(null, NOW), true, 'S01 missing data');
  assert.equal(isAvailable(limits(null, null), NOW), true, 'S01 no windows');
  assert.equal(isAvailable(limits(win(100, HOUR)), NOW), false, 'S02');
  assert.equal(isAvailable(limits(null, win(100, HOUR)), NOW), false, 'S03');
  assert.equal(isAvailable(limits(win(100, null)), NOW), false, 'S04');
  assert.equal(isAvailable(limits(win(100, -HOUR)), NOW), true, 'S05');
  assert.equal(isAvailable(limits(win(100, 0)), NOW), true, 'S06 reset exactly now');
  assert.equal(isAvailable(limits(win(99.9, HOUR)), NOW), true, 'S07');
  assert.equal(isAvailable(limits(win(250, HOUR)), NOW), false, 'S07 above range');
});

test('S08-S13 most quota left: 5-hour, then 7-day, missing or reset windows count as unused, ties keep order, none gives null', () => {
  const pick = (entries: [string, ExecutorLimits | null][]) => pickMostQuotaLeft(entries.map(([id, l]) => ({ executor: profile(id), limits: l })), NOW)?.id ?? null;
  assert.equal(pick([['a', limits(win(50, HOUR))], ['b', limits(win(20, HOUR))]]), 'b', 'S08');
  assert.equal(pick([['a', limits(win(20, HOUR), win(60, HOUR))], ['b', limits(win(20, HOUR), win(10, HOUR))]]), 'b', 'S09');
  assert.equal(pick([['a', limits(win(20, HOUR))], ['b', null]]), 'b', 'S10');
  assert.equal(pick([['a', limits(win(20, HOUR))], ['b', limits(win(95, -HOUR))]]), 'b', 'S11');
  assert.equal(pick([['a', limits(win(20, HOUR))], ['b', limits(win(20, HOUR))]]), 'a', 'S12');
  assert.equal(pick([['a', limits(win(100, HOUR))]]), null, 'S13');
  assert.equal(pick([]), null);
});

test('S38-S40 exhaustion names the blocking window, preferring the later reset when both are used up', () => {
  assert.deepEqual(exhaustion(limits(win(100, HOUR)), NOW), { window: '5-hour', resetsAt: sec(HOUR) });
  assert.deepEqual(exhaustion(limits(null, win(100, HOUR)), NOW), { window: '7-day', resetsAt: sec(HOUR) });
  assert.equal(exhaustion(limits(win(100, HOUR), win(100, 5 * HOUR)), NOW)?.window, '7-day');
  assert.equal(exhaustion(limits(win(100, 5 * HOUR), win(100, HOUR)), NOW)?.window, '5-hour');
  assert.equal(exhaustion(limits(win(100, HOUR), win(100, null)), NOW)?.window, '7-day', 'unknown reset is the latest');
  assert.equal(exhaustion(limits(win(100, null), win(100, HOUR)), NOW)?.window, '5-hour');
  assert.equal(exhaustion(limits(win(10, HOUR)), NOW), null);
  assert.match(unavailableReason('Codex', limits(win(100, HOUR)), NOW), /Codex is out of quota.*5-hour.*resets 2026-01-01 13:00 UTC/);
  assert.match(unavailableReason('Codex', limits(win(100, null)), NOW), /reset time is unknown/);
});

test('S14-S16 first pick is silent and only happens once an agent is available', async () => {
  const none = harness([]);
  await none.service.recheck();
  assert.equal(none.stored.value, undefined, 'S15');
  const h = harness(['a', 'b']);
  h.readings.set('a', limits(win(100, HOUR)));
  h.readings.set('b', limits(win(100, HOUR)));
  await h.service.recheck();
  assert.equal(h.stored.value, undefined, 'S16 none available');
  h.readings.set('b', limits(win(10, HOUR)));
  await h.service.recheck();
  assert.equal(await h.service.current(), 'b');
  assert.deepEqual(h.events, [{ type: 'executors.default_changed', defaultExecutorId: 'b', previousExecutorId: null, reason: 'initial' }], 'S14');
  assert.equal(h.raised.length, 0, 'S14 silent');
});

test('S17 S19 S20 S49 the default is sticky: a better agent changes nothing, no switch back, all exhausted keeps it, steady state is quiet', async () => {
  const h = harness(['a', 'b'], { stored: 'a' });
  h.readings.set('a', limits(win(80, HOUR)));
  h.readings.set('b', limits(win(1, HOUR)));
  await h.service.recheck();
  assert.equal(h.stored.value?.executorId, 'a', 'S17');
  h.readings.set('a', limits(win(100, HOUR)));
  await h.service.recheck();
  assert.equal(h.stored.value?.executorId, 'b');
  assert.equal(h.events.at(-1)?.reason, 'exhausted', 'S18');
  h.readings.set('a', limits(win(0, HOUR)));
  await h.service.recheck();
  assert.equal(h.stored.value?.executorId, 'b', 'S19 no switch back');
  const events = h.events.length;
  await h.service.recheck();
  await h.service.recheck();
  assert.equal(h.events.length, events, 'S49');

  const out = harness(['a', 'b'], { stored: 'a' });
  out.readings.set('a', limits(win(100, HOUR)));
  out.readings.set('b', limits(win(100, HOUR)));
  await out.service.recheck();
  assert.equal(out.stored.value?.executorId, 'a', 'S20');
  assert.equal(out.events.length + out.raised.length, 0);
  out.readings.set('b', limits(win(5, HOUR)));
  await out.service.recheck();
  assert.equal(out.stored.value?.executorId, 'b', 'S21 switches as soon as another becomes available');
});

test('S18 S38-S43 the exhausted switch raises one info notification that names the old limit and is updated, not duplicated', async () => {
  const h = harness(['a', 'b', 'c'], { stored: 'a' });
  h.readings.set('a', limits(win(100, HOUR), win(100, 3 * HOUR)));
  h.readings.set('b', limits(win(10, HOUR)));
  h.readings.set('c', limits(win(50, HOUR)));
  await h.service.recheck();
  assert.equal(h.raised.length, 1);
  const [note] = h.raised;
  assert.equal(note?.kind, 'executor.default_switched');
  assert.deepEqual(note?.subject, { type: 'app' });
  assert.equal(note?.title, 'Default coding agent changed');
  assert.equal(note?.description, 'A has used its 7-day limit (resets 2026-01-01 15:00 UTC). New sessions now use B.', 'S40 later reset named');
  assert.deepEqual(h.events[0], { type: 'executors.default_changed', defaultExecutorId: 'b', previousExecutorId: 'a', reason: 'exhausted' });
  // A second switch while the first is unresolved goes through the same raise call, which the notification service upserts (S43).
  h.readings.set('b', limits(win(100, HOUR)));
  await h.service.recheck();
  assert.equal(h.raised.length, 2);
  assert.match(h.raised[1]!.description, /^B has used its 5-hour limit .* New sessions now use C\.$/);
});

test('S22-S26 removal switches with the removed text, clears when none is available, and edits keep the default', async () => {
  const h = harness(['a', 'b'], { stored: 'a' });
  h.executors = [profile('b', 'B')];
  await h.service.recheck();
  assert.equal(h.stored.value?.executorId, 'b');
  assert.equal(h.raised[0]?.description, 'A was removed. New sessions now use B.', 'S41');
  assert.equal(h.events[0]?.reason, 'removed');

  const other = harness(['a', 'b'], { stored: 'a' });
  other.executors = [profile('a', 'A')];
  await other.service.recheck();
  assert.equal(other.stored.value?.executorId, 'a', 'S23');
  assert.equal(other.events.length, 0);

  const none = harness(['a', 'b'], { stored: 'a' });
  none.executors = [profile('b', 'B')];
  none.readings.set('b', limits(win(100, HOUR)));
  await none.service.recheck();
  assert.equal(none.stored.value, undefined, 'S24 cleared');
  assert.equal(none.raised.length, 0);
  none.readings.set('b', limits(win(1, HOUR)));
  await none.service.recheck();
  assert.equal(none.events[0]?.reason, 'initial', 'S24 later silent pick');

  const only = harness(['a'], { stored: 'a' });
  only.executors = [];
  await only.service.recheck();
  assert.equal(only.stored.value, undefined, 'S25');

  const renamed = harness(['a', 'b'], { stored: 'a' });
  renamed.executors = [{ ...profile('a', 'Renamed'), kind: 'codex-cli' }, profile('b')];
  await renamed.service.recheck();
  assert.deepEqual([renamed.stored.value?.executorId, renamed.stored.value?.label], ['a', 'Renamed'], 'S26');
  assert.equal(renamed.events.length, 0);
});

test('S27-S29 a stored default survives a restart, a missing one counts as removed, an exhausted one switches', async () => {
  const restarted = harness(['a', 'b'], { stored: 'b' });
  await restarted.service.recheck();
  assert.equal(await restarted.service.current(), 'b', 'S27');
  const missing = harness(['a'], { stored: 'ghost' });
  await missing.service.recheck();
  assert.equal(missing.stored.value?.executorId, 'a', 'S28');
  assert.match(missing.raised[0]!.description, /GHOST was removed/);
  const exhausted = harness(['a', 'b'], { stored: 'a' });
  exhausted.readings.set('a', limits(win(100, HOUR)));
  await exhausted.service.recheck();
  assert.equal(exhausted.stored.value?.executorId, 'b', 'S29');
});

test('S35-S37 a manual set emits manual, resolves the switch notification and refuses unknown or unavailable agents', async () => {
  const h = harness(['a', 'b'], { stored: 'a' });
  assert.equal(await h.service.setDefault('b'), 'b');
  assert.deepEqual(h.events, [{ type: 'executors.default_changed', defaultExecutorId: 'b', previousExecutorId: 'a', reason: 'manual' }], 'S35');
  assert.equal(h.raised.length, 0);
  assert.equal(h.resolved, 1, 'S36');
  const writes = h.stored.writes;
  assert.equal(await h.service.setDefault('b'), 'b');
  assert.equal(h.stored.writes, writes, 'no-op write');
  assert.equal(h.events.length, 1, 'no-op event');
  await assert.rejects(h.service.setDefault('zzz'), DefaultExecutorNotFoundError);
  h.readings.set('a', limits(win(100, HOUR)));
  await assert.rejects(h.service.setDefault('a'), (error: Error) => error instanceof DefaultExecutorUnavailableError && /A is out of quota/.test(error.message), 'S37');
  const fresh = harness(['a']);
  await fresh.service.setDefault('a');
  assert.equal(fresh.events[0]?.previousExecutorId, null);
});

test('S45 S46 overlapping rechecks switch once and a manual set during a re-check is not overwritten', async () => {
  const h = harness(['a', 'b'], { stored: 'a', gateReads: true });
  h.readings.set('a', limits(win(100, HOUR)));
  h.readings.set('b', limits(win(10, HOUR)));
  const first = h.service.recheck();
  const second = h.service.recheck();
  h.gate!.release();
  await Promise.all([first, second]);
  assert.equal(h.events.length, 1, 'S45 one switch');
  assert.equal(h.raised.length, 1, 'S45 one notification');

  const race = harness(['a', 'b'], { stored: 'a', gateReads: true });
  race.readings.set('b', limits(win(10, HOUR)));
  const recheck = race.service.recheck();
  const manual = race.service.setDefault('b');
  race.gate!.release();
  await Promise.all([recheck, manual]);
  assert.equal(race.stored.value?.executorId, 'b', 'S46 manual choice stands');
  assert.deepEqual(race.events.map((event) => event.reason), ['manual']);
});

test('S47 S48 agents sharing readings follow the same rules, and a failing read counts as available', async () => {
  const shared = harness(['a', 'b'], { stored: 'a' });
  const same = limits(win(100, HOUR));
  shared.readings.set('a', same);
  shared.readings.set('b', same);
  await shared.service.recheck();
  assert.equal(shared.stored.value?.executorId, 'a', 'S47 both out: nothing changes');
  const failing = harness(['a', 'b'], { stored: 'a' });
  failing.readings.set('a', 'throw');
  await failing.service.recheck();
  assert.equal(failing.stored.value?.executorId, 'a', 'S48');
  assert.equal(await failing.service.setDefault('a'), 'a');
});

test('unsubscribing stops a listener from receiving events', async () => {
  const h = harness(['a']);
  const seen: DefaultChangedEvent[] = [];
  const off = h.service.onEvent((event) => seen.push(event));
  await h.service.recheck();
  assert.equal(seen.length, 1);
  off();
  h.executors = [profile('b')];
  await h.service.recheck();
  assert.equal(seen.length, 1);
});
