import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const a = await import('../src/lib/agentAnalytics.ts');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Local times, like the view: 7 Oct 2026 at the given hour and minute. */
const at = (hour, minute = 0, day = 7) => new Date(2026, 9, day, hour, minute).getTime();
const DAY = { from: at(0), to: at(0, 0, 8) };
const point = (time, remaining, patch = {}) => ({ at: time, remaining, used: 100 - remaining, resetsAt: at(18), segment: 0, ...patch });
const series = (points = [], gaps = [], resets = []) => ({ points, gaps, resets });
const NO_DECREASE = { available: false, reason: 'missing-boundary-reading', sharedWith: 0 };
const activity = (id, start, end, patch = {}) => ({
  id, kind: 'coding', agentLabel: 'Claude · Personal', projectName: 'Age of Agents', label: '8.001: Analytics', deleted: false,
  workflow: { name: 'Software Development', stepName: 'Development', round: 2 },
  startedAt: start, endedAt: end, approximate: false, segments: [{ state: 'active', start, end }], activeMs: (end ?? start) - start,
  decrease: { fiveHour: NO_DECREASE, sevenDay: NO_DECREASE },
  target: { kind: 'run', projectId: 'p1', runId: 'run-1', stepId: 'build', round: 2 },
  ...patch,
});

// ---- Tiles ----

test('C01 tile text gives remaining with used beside it, and the observation and reset times', () => {
  const tile = a.capacityTile({ state: 'measured', remaining: 78, used: 22, observedAt: at(14, 30), resetsAt: at(18) });
  assert.equal(tile.headline, '78% remaining (22% used)');
  assert.equal(tile.detail, 'Observed 7 Oct, 14:30 · resets 7 Oct, 18:00');
  assert.equal(tile.meter, 78);
  assert.equal(a.remainingText(77.56, 22.44), '77.6% remaining (22.4% used)');
  assert.match(a.capacityTile({ state: 'measured', remaining: 78, used: 22, observedAt: at(14, 30), resetsAt: null }).detail, /reset time unknown/);
});

test('C02 missing, expired, stale, failed and awaiting-first-reading tiles are each distinct from a measured 0% and 100%', () => {
  const measured0 = a.capacityTile({ state: 'measured', remaining: 0, used: 100, observedAt: at(14), resetsAt: at(18) });
  const measured100 = a.capacityTile({ state: 'measured', remaining: 100, used: 0, observedAt: at(14), resetsAt: at(18) });
  assert.deepEqual([measured0.headline, measured0.meter], ['0% remaining (100% used)', 0]);
  assert.deepEqual([measured100.headline, measured100.meter], ['100% remaining (0% used)', 100]);
  const empty = { remaining: null, used: null };
  const tiles = {
    unavailable: a.capacityTile({ ...empty, state: 'unavailable', observedAt: at(14), resetsAt: null }),
    expired: a.capacityTile({ ...empty, state: 'expired', observedAt: at(9), resetsAt: at(13) }),
    awaiting: a.capacityTile({ ...empty, state: 'awaiting', observedAt: null, resetsAt: null }),
    stale: a.capacityTile({ state: 'stale', remaining: 40, used: 60, observedAt: at(9), resetsAt: at(18) }),
    failed: a.capacityTile({ state: 'failed', remaining: 40, used: 60, observedAt: at(9), resetsAt: at(18) }),
  };
  for (const state of ['unavailable', 'expired', 'awaiting']) {
    assert.equal(tiles[state].meter, null, `${state} draws no meter`);
    assert.doesNotMatch(tiles[state].headline, /%/, `${state} states no percentage`);
  }
  assert.deepEqual([tiles.unavailable.headline, tiles.expired.headline, tiles.awaiting.headline], ['Unavailable', 'Awaiting a reading after reset', 'Awaiting first reading']);
  assert.match(tiles.stale.detail, /^Last reading 7 Oct, 09:00, nothing newer/);
  assert.match(tiles.failed.detail, /^Last check failed · last successful reading 7 Oct, 09:00/);
  const texts = [measured0, measured100, ...Object.values(tiles)].map((tile) => `${tile.headline}|${tile.detail}`);
  assert.equal(new Set(texts).size, texts.length, 'no two states read the same');
});

// ---- Geometry ----

test('C03 time-to-x maps 00:00 to the left edge, 24:00 to the right edge and noon to the middle', () => {
  assert.equal(a.timeToX(at(0), DAY, 960), 0);
  assert.equal(a.timeToX(DAY.to, DAY, 960), 960);
  assert.equal(a.timeToX(at(12), DAY, 960), 480);
});

test('C04 remaining-to-y maps 100 to the top and 0 to the bottom', () => {
  assert.deepEqual([a.remainingToY(100, 220), a.remainingToY(0, 220), a.remainingToY(50, 220)], [0, 220, 110]);
});

test('C05 the line builder emits one path per segment and never joins across a gap or reset', () => {
  const points = [point(at(1), 90), point(at(2), 80), point(at(5), 70, { segment: 1 }), point(at(6), 60, { segment: 1 }), point(at(7), 100, { segment: 2 }), point(at(8), 95, { segment: 2 })];
  const { paths, points: plotted } = a.linePaths(series(points), DAY, 960, 220, at(23));
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => (path.match(/M/g) ?? []).length === 1 && (path.match(/L/g) ?? []).length === 1), 'each path covers only its own two points');
  assert.equal(paths[0], 'M40.00 22.00 L80.00 44.00');
  assert.equal(plotted.length, 6);
});

test('C06 a single reading renders as a point with no path', () => {
  const { paths, points } = a.linePaths(series([point(at(9), 78)]), DAY, 960, 220, at(23));
  assert.deepEqual(paths, []);
  assert.deepEqual(points.map(({ x, y }) => [x, y]), [[360, 48.4]]);
  // A lone reading between two gaps is also only a point.
  const lone = a.linePaths(series([point(at(1), 90), point(at(2), 80), point(at(9), 78, { segment: 1 })]), DAY, 960, 220, at(23));
  assert.deepEqual([lone.paths.length, lone.points.length], [1, 3]);
});

test('C07 for today the Now marker follows the clock and nothing is drawn after it', () => {
  assert.equal(a.nowMarkerX(at(12), DAY, 960), 480);
  assert.equal(a.nowMarkerX(at(6), DAY, 960), 240);
  assert.equal(a.nowMarkerX(at(12, 0, 8), DAY, 960), null, 'another day has no Now marker');
  assert.equal(a.nowMarkerX(at(23, 0, 6), DAY, 960), null);
  const { points, paths } = a.linePaths(series([point(at(10), 80), point(at(11), 70), point(at(13), 60)]), DAY, 960, 220, at(12));
  assert.deepEqual(points.map(({ point: p }) => p.at), [at(10), at(11)]);
  assert.equal(paths.length, 1);
});

// ---- Days ----

test('C08 the date switcher disables next on today and previous on the oldest retained day, and Today returns to the current date', () => {
  const now = at(15, 20);
  const earliest = at(9, 0, 5);
  assert.deepEqual(a.daySwitcher(at(0), now, earliest), { isToday: true, canPrevious: true, canNext: false, oldestDay: at(0, 0, 5), today: at(0) });
  assert.deepEqual(a.daySwitcher(at(0, 0, 6), now, earliest), { isToday: false, canPrevious: true, canNext: true, oldestDay: at(0, 0, 5), today: at(0) });
  const oldest = a.daySwitcher(at(0, 0, 5), now, earliest);
  assert.deepEqual([oldest.canPrevious, oldest.canNext, oldest.today], [false, true, at(0)]);
  // Collection that starts today leaves nowhere to go.
  assert.deepEqual([a.daySwitcher(at(0), now, now).canPrevious, a.daySwitcher(at(0), now, now).canNext], [false, false]);
  assert.equal(a.startOfLocalDay(now), at(0));
  assert.equal(a.dateInputValue(at(0)), '2026-10-07');
  assert.equal(a.parseDateInput('2026-10-06', at(0, 0, 5), at(0)), at(0, 0, 6));
  assert.equal(a.parseDateInput('2026-11-30', at(0, 0, 5), at(0)), at(0), 'a later date lands on today');
  assert.equal(a.parseDateInput('2026-01-01', at(0, 0, 5), at(0)), at(0, 0, 5), 'an older date lands on the oldest day');
  assert.equal(a.parseDateInput('', at(0, 0, 5), at(0)), null);
  assert.equal(a.formatDayTitle(at(0)), 'Wed, 7 Oct 2026');
});

test('C09 stepping a day across a month boundary and a daylight-saving change lands on the right local date', () => {
  const lastOfMonth = new Date(2026, 9, 31).getTime();
  assert.equal(a.shiftDay(lastOfMonth, 1), new Date(2026, 10, 1).getTime());
  assert.equal(a.shiftDay(new Date(2026, 10, 1).getTime(), -1), lastOfMonth);
  assert.equal(a.shiftDay(new Date(2026, 11, 31).getTime(), 1), new Date(2027, 0, 1).getTime());
  // Days around the spring and autumn clock changes of the zones that have them are 23 or 25 hours
  // long; stepping by calendar day still lands on local midnight, in whatever zone this runs.
  for (const [month, day] of [[2, 8], [2, 29], [9, 25], [10, 1]]) {
    for (let step = -1; step <= 2; step += 1) {
      const landed = new Date(a.shiftDay(new Date(2026, month, day).getTime(), step));
      assert.deepEqual([landed.getHours(), landed.getMinutes(), landed.getDate()], [0, 0, new Date(2026, month, day + step).getDate()]);
    }
  }
  const range = a.dayRange(lastOfMonth);
  assert.deepEqual([range.from, range.to], [lastOfMonth, new Date(2026, 10, 1).getTime()]);
});

test('C10 the day summary gives the lowest 5h remaining and its time, the reset count, session count and unattributed flag', () => {
  const view = {
    series: {
      fiveHour: series([point(at(9), 80), point(at(13, 5), 41), point(at(14), 100)], [], [{ at: at(14), before: 41, after: 100 }]),
      sevenDay: series([point(at(9), 70)], [], [{ at: at(11), before: 5, after: 100 }]),
    },
    activities: [activity('a', at(9), at(10)), activity('b', at(11), at(12)), activity('c', at(12), null)],
    unattributed: [{ window: 'fiveHour', from: at(3), to: at(3, 5), points: 4 }],
  };
  assert.equal(a.daySummary(view), 'Lowest 5h remaining 41% at 13:05 · 2 resets · 3 tracked sessions · Unattributed activity seen');
  assert.equal(
    a.daySummary({ series: { fiveHour: series(), sevenDay: series() }, activities: [activity('a', at(9), at(10))], unattributed: [] }),
    'No 5h readings · 0 resets · 1 tracked session · No unattributed activity',
  );
});

// ---- Lanes and bands ----

test('C11 overlapping intervals get different lanes and non-overlapping intervals reuse a lane', () => {
  const lanes = a.assignLanes([activity('a', at(9), at(11)), activity('b', at(10), at(12)), activity('c', at(11), at(13)), activity('d', at(10, 30), at(10, 45))], at(23));
  assert.deepEqual(Object.fromEntries(lanes), { a: 0, b: 1, d: 2, c: 0 });
});

test('C12 lane assignment is stable when a new interval is added', () => {
  const existing = [activity('a', at(9), at(11)), activity('b', at(10), at(12)), activity('c', at(11, 30), null)];
  const before = a.assignLanes(existing, at(13));
  const after = a.assignLanes([activity('new', at(12, 30), null), ...existing], at(13));
  for (const [id, lane] of before) assert.equal(after.get(id), lane, `${id} keeps its lane`);
  assert.equal(after.get('new'), 1);
});

test('C13 fifty concurrent intervals each get a lane with no collisions', () => {
  const dense = Array.from({ length: 50 }, (_, index) => activity(`t${String(index).padStart(2, '0')}`, at(9, index), at(15)));
  const lanes = a.assignLanes(dense, at(23));
  assert.equal(lanes.size, 50);
  assert.equal(new Set(lanes.values()).size, 50, 'all overlap, so each has its own lane');
  const mixed = [...dense, ...Array.from({ length: 50 }, (_, index) => activity(`later${index}`, at(16, index), at(20)))];
  const assigned = a.assignLanes(mixed, at(23));
  for (const one of mixed) {
    for (const other of mixed) {
      if (one === other || assigned.get(one.id) !== assigned.get(other.id)) continue;
      assert.ok(one.endedAt <= other.startedAt || other.endedAt <= one.startedAt, `${one.id} and ${other.id} share a lane without overlapping`);
    }
  }
  assert.equal(Math.max(...assigned.values()), 49, 'later sessions reuse the freed lanes');
});

test('C14 an interval crossing midnight is clipped to the day with a clip marker, while its label keeps the real start and end', () => {
  const overnight = activity('o', at(22, 0, 6), at(2, 0, 8), { segments: [{ state: 'active', start: at(22, 0, 6), end: at(1) }, { state: 'waiting', start: at(1), end: at(2, 0, 8) }] });
  const band = a.activityBand(overnight, DAY, at(12, 0, 8), 960);
  assert.deepEqual([band.x, band.width, band.clippedStart, band.clippedEnd, band.live], [0, 960, true, true, false]);
  assert.deepEqual(band.parts, [{ x: 0, width: 40, state: 'active' }, { x: 40, width: 920, state: 'waiting' }]);
  const details = Object.fromEntries(a.activityDetails(overnight).map(({ label, value }) => [label, value]));
  assert.deepEqual([details.Started, details.Ended], ['6 Oct, 22:00', '8 Oct, 02:00']);

  const inside = a.activityBand(activity('i', at(6), at(12)), DAY, at(23), 960);
  assert.deepEqual([inside.x, inside.width, inside.clippedStart, inside.clippedEnd], [240, 240, false, false]);
  const live = a.activityBand(activity('l', at(6), null, { segments: [{ state: 'active', start: at(6), end: null }] }), DAY, at(9), 960);
  assert.deepEqual([live.width, live.live, live.parts], [120, true, [{ x: 240, width: 120, state: 'active' }]]);
  assert.equal(a.activityBand(activity('gone', at(1, 0, 5), at(2, 0, 5)), DAY, at(23), 960), null, 'nothing of it is on this day');
});

test('C15 band style gives a distinct colour and texture for coding, planning and background, and marks approximate bands', () => {
  const styles = ['coding', 'planning', 'background'].map((kind) => a.bandStyle({ kind, approximate: false }));
  assert.deepEqual(styles.map((style) => style.texture), ['solid', 'striped', 'dotted']);
  assert.deepEqual(styles.map((style) => style.colorVar), ['--analytics-coding', '--analytics-planning', '--analytics-background']);
  assert.equal(new Set(styles.map((style) => style.texture)).size, 3);
  assert.equal(a.bandStyle({ kind: 'coding', approximate: true }).approximate, true);
  assert.deepEqual(['coding', 'planning', 'background'].map(a.activityKindLabel), ['Coding', 'Planning', 'App background work']);
});

test('C16 hover-box content lists Project, task, agent, kind, step, round, start, end, active time and both decreases', () => {
  const details = a.activityDetails(activity('a', at(9), at(9, 42), {
    activeMs: 31 * MINUTE,
    decrease: { fiveHour: { available: true, points: 3, from: at(8, 55), to: at(9, 45), sharedWith: 0 }, sevenDay: NO_DECREASE },
  }));
  assert.deepEqual(details, [
    { label: 'Project', value: 'Age of Agents' },
    { label: 'Task', value: '8.001: Analytics' },
    { label: 'Agent', value: 'Claude · Personal' },
    { label: 'Kind', value: 'Coding' },
    { label: 'Step', value: 'Development (Software Development)' },
    { label: 'Round', value: '2' },
    { label: 'Started', value: '7 Oct, 09:00' },
    { label: 'Ended', value: '7 Oct, 09:42' },
    { label: 'Active time', value: '31m' },
    { label: '5h decrease', value: 'observed 3 pts (estimate)' },
    { label: '7d decrease', value: 'Unavailable — missing boundary reading' },
  ]);
  const planning = a.activityDetails(activity('p', at(9), null, { kind: 'planning', workflow: null, projectName: null, activeMs: 5 * MINUTE }));
  assert.deepEqual(planning.map(({ label }) => label), ['Project', 'Task', 'Agent', 'Kind', 'Started', 'Ended', 'Active time', '5h decrease', '7d decrease']);
  assert.deepEqual([planning[0].value, planning[5].value, planning[6].value], ['Unknown project', 'Still running', '5m so far']);
  const approximate = a.activityDetails(activity('x', at(9), at(10), { approximate: true, activeMs: HOUR, workflow: { name: 'W', stepName: 'S', round: null } }));
  assert.deepEqual([approximate[5].value, approximate[7].value, approximate[8].value], ['Unknown', '7 Oct, 10:00 (approximate)', 'approx. 1h']);
});

test('C17 decrease wording: an observed estimate, a shared decrease that is not divided, and unavailable with its reason', () => {
  const observed = { available: true, points: 3, from: 0, to: 1 };
  assert.equal(a.decreaseText({ ...observed, sharedWith: 0 }), 'observed 3 pts (estimate)');
  assert.equal(a.decreaseText({ ...observed, points: 0, sharedWith: 0 }), 'observed 0 pts (estimate)');
  assert.equal(a.decreaseText({ ...observed, points: 2.46, sharedWith: 2 }), 'observed 2.5 pts (estimate) · Shared with 2 overlapping sessions — not divided');
  assert.equal(a.decreaseText({ ...observed, sharedWith: 1 }), 'observed 3 pts (estimate) · Shared with 1 overlapping session — not divided');
  const reasons = { 'missing-boundary-reading': 'missing boundary reading', reset: 'the window reset during it', gap: 'readings are missing during it', 'in-progress': 'still in progress' };
  for (const [reason, text] of Object.entries(reasons)) assert.equal(a.decreaseText({ available: false, reason, sharedWith: 0 }), `Unavailable — ${text}`);
});

test('C18 no formatter ever outputs a token count derived from a percentage', () => {
  const decreases = [
    { available: true, points: 12.5, from: 0, to: 1, sharedWith: 0 },
    { available: true, points: 40, from: 0, to: 1, sharedWith: 3 },
    { available: false, reason: 'gap', sharedWith: 0 },
  ];
  const texts = [
    ...decreases.map(a.decreaseText),
    ...decreases.flatMap((decrease) => a.activityDetails(activity('a', at(9), at(10), { decrease: { fiveHour: decrease, sevenDay: decrease } })).map(({ value }) => value)),
    a.metricValueText('fiveHourDecrease', 12.5), a.metricValueText('sevenDayDecrease', 3),
    a.medianCell('fiveHourDecrease', { value: 4, median: 2, samples: 6, enoughHistory: true, highUsage: true }),
    a.capacityTile({ state: 'measured', remaining: 78, used: 22, observedAt: at(14), resetsAt: at(18) }).headline,
    a.readingAnnouncement('fiveHour', point(at(14), 78)),
    a.daySummary({ series: { fiveHour: series([point(at(9), 80)]), sevenDay: series() }, activities: [], unattributed: [] }),
  ];
  for (const text of texts) assert.doesNotMatch(text, /token/i, text);
  assert.equal(a.metricValueText('fiveHourDecrease', 12.5), '12.5 pts');
  // A token figure appears only when the row carries exact CLI tokens.
  assert.equal(a.tokenCell(null).text, 'Unavailable');
});

test('C19 a band for an existing task links to its session at the matching round; a deleted task has no link and reads "Deleted task"', () => {
  const existing = activity('a', at(9), at(10));
  assert.deepEqual(existing.target, { kind: 'run', projectId: 'p1', runId: 'run-1', stepId: 'build', round: 2 });
  assert.equal(a.activityAction(existing), 'Select to open the task.');
  assert.match(a.activityAriaLabel(existing), /^Project: Age of Agents\. Task: 8\.001: Analytics\. .*Round: 2\. .*Select to open the task\.$/);
  const deleted = activity('d', at(9), at(10), { deleted: true, label: 'Deleted task', target: null });
  assert.equal(a.activityAction(deleted), 'This task was deleted; there is nothing to open.');
  assert.match(a.activityAriaLabel(deleted), /Task: Deleted task\./);
  assert.equal(a.activityAction(activity('o', at(9), at(10), { target: null })), 'This work can no longer be opened.');
  assert.equal(a.bandCaption(existing), 'Development r2 · 8.001: Analytics');
  assert.equal(a.bandCaption(activity('p', at(9), at(10), { workflow: null, label: 'Planning session #4' })), 'Planning session #4');
  assert.equal(a.bandCaption(activity('u', at(9), at(10), { workflow: { name: 'W', stepName: 'Complete', round: null } })), 'Complete · 8.001: Analytics');
});

// ---- Readings ----

test('C20 keyboard stepping over readings: arrows, Page Up and Down, Home and End move the index and clamp at both ends', () => {
  const step = (index, key) => a.stepReadingIndex(index, key, 30);
  assert.deepEqual([step(5, 'ArrowRight'), step(5, 'ArrowLeft'), step(5, 'PageDown'), step(20, 'PageUp'), step(5, 'Home'), step(5, 'End')], [6, 4, 17, 8, 0, 29]);
  assert.deepEqual([step(0, 'ArrowLeft'), step(29, 'ArrowRight'), step(3, 'PageUp'), step(25, 'PageDown')], [0, 29, 0, 29], 'clamped at both ends');
  assert.deepEqual([step(-1, 'ArrowRight'), step(-1, 'ArrowLeft'), step(-1, 'End')], [0, 0, 29], 'the first key press lands on a reading');
  assert.equal(step(5, 'Enter'), 5, 'other keys change nothing');
  assert.equal(a.stepReadingIndex(0, 'ArrowRight', 0), -1, 'no readings, nothing to focus');
  assert.deepEqual([...a.READING_KEYS].sort(), ['ArrowLeft', 'ArrowRight', 'End', 'Home', 'PageDown', 'PageUp']);
});

test('C21 the live-region text for a focused reading gives the window, exact percentage, time and reset', () => {
  assert.equal(a.readingAnnouncement('fiveHour', point(at(14, 30), 77.6, { used: 22.4 })), '5h: 77.6% remaining (22.4% used) at 14:30, resets 7 Oct, 18:00');
  assert.equal(a.readingAnnouncement('sevenDay', point(at(14, 30), 60, { resetsAt: null })), '7d: 60% remaining (40% used) at 14:30, reset time unknown');
});

test('C22 readings table rows are chronological and include gap and reset rows', () => {
  const rows = a.readingRows({
    fiveHour: series(
      [point(at(9), 80), point(at(9, 5), 78), point(at(10), 70, { segment: 1 }), point(at(10, 5), 100, { segment: 2 })],
      [{ from: at(9, 5), to: at(10), reason: 'check-failed' }],
      [{ at: at(10, 5), before: 70, after: 100 }],
    ),
    sevenDay: series([point(at(9), 60), point(at(10), 59)], [{ from: at(9), to: at(10), reason: 'window-unavailable' }]),
  });
  assert.deepEqual(rows.map((row) => [a.formatClock(row.at), row.event]), [
    ['09:00', '7d gap'], ['09:00', 'Reading'], ['09:05', '5h gap'], ['09:05', 'Reading'], ['10:00', 'Reading'], ['10:05', '5h reset'], ['10:05', 'Reading'],
  ]);
  assert.ok(rows.every((row, index) => index === 0 || rows[index - 1].at <= row.at));
  assert.deepEqual(rows[1], { at: at(9), kind: 'reading', event: 'Reading', fiveHour: '80% remaining (20% used), resets 7 Oct, 18:00', sevenDay: '60% remaining (40% used), resets 7 Oct, 18:00' });
  assert.equal(rows[3].sevenDay, 'Unavailable', 'a window with no value at that reading says so');
  assert.deepEqual([rows[2].fiveHour, rows[2].sevenDay], ['Check failed until 7 Oct, 10:00', '']);
  assert.equal(rows[0].sevenDay, 'Window unavailable until 7 Oct, 10:00');
  assert.equal(rows[5].fiveHour, 'Replenished: 70% → 100% remaining');
  assert.deepEqual(a.readingRows({ fiveHour: series(), sevenDay: series() }), []);
  assert.deepEqual(['no-readings', 'check-failed', 'window-unavailable'].map(a.gapText), ['No readings', 'Check failed', 'Window unavailable']);
});

// ---- Step comparison ----

const comparison = (value, median = null, samples = 0) => ({ value, median, samples, enoughHistory: samples >= 5, highUsage: false });
const NO_COMPARISON = { activeDuration: comparison(null), tokens: comparison(null), fiveHourDecrease: comparison(null), sevenDayDecrease: comparison(null) };
const row = (id, patch = {}) => ({
  id, projectName: 'Age of Agents', label: '8.001: Analytics', deleted: false, workflowName: 'Software Development', stepName: 'Development', round: 1, status: 'completed',
  startedAt: at(9), finishedAt: at(10), duration: { ms: 10 * MINUTE, live: false, approximate: false }, tokens: null,
  decrease: { fiveHour: NO_DECREASE, sevenDay: NO_DECREASE }, comparison: NO_COMPARISON, highUsage: [], target: null, ...patch,
});

test('C23 the token cell shows the total with its categories when known, and "Unavailable", never "0", when unknown', () => {
  const counts = { inputTokens: 1200, outputTokens: 3400, cacheCreationInputTokens: 50_000, cacheReadInputTokens: 1_180_000 };
  assert.deepEqual(a.tokenCell({ counts, total: 1_234_600, partial: false }), { text: '1,234,600', detail: 'input 1,200 · output 3,400 · cache write 50,000 · cache read 1,180,000' });
  assert.equal(a.tokenCell({ counts, total: 1_234_600, partial: true }).text, '1,234,600 (partial)');
  assert.deepEqual(a.tokenCell(null), { text: 'Unavailable', detail: null });
  assert.notEqual(a.tokenCell(null).text, '0');
});

test('C24 the duration cell says "so far" for a live round, is plain for a completed one, and "approx." or "Unavailable" for legacy records', () => {
  assert.equal(a.durationCell({ ms: 12 * MINUTE, live: true, approximate: false }), '12m so far');
  assert.equal(a.durationCell({ ms: 12 * MINUTE + 5000, live: false, approximate: false }), '12m 5s');
  assert.equal(a.durationCell({ ms: 45 * MINUTE, live: false, approximate: true }), 'approx. 45m');
  assert.equal(a.durationCell({ ms: null, live: false, approximate: true }), 'Unavailable');
});

test('C25 the median cell shows the median and sample count, or "Not enough history" below five', () => {
  assert.equal(a.medianCell('activeDuration', comparison(20 * MINUTE, 10 * MINUTE, 6)), 'median 10m · 6 prior');
  assert.equal(a.medianCell('tokens', comparison(3000, 1500.5, 5)), 'median 1,501 · 5 prior');
  assert.equal(a.medianCell('fiveHourDecrease', comparison(4, 2, 7)), 'median 2 pts · 7 prior');
  assert.equal(a.medianCell('tokens', comparison(3000, 1500, 4)), 'Not enough history (4 prior)');
  assert.equal(a.medianCell('sevenDayDecrease', comparison(null, null, 0)), 'Not enough history (0 prior)');
  const marked = row('high', {
    highUsage: ['activeDuration', 'tokens'],
    comparison: { ...NO_COMPARISON, activeDuration: { value: 25 * MINUTE, median: 10 * MINUTE, samples: 5, enoughHistory: true, highUsage: true }, tokens: { value: 3000, median: 1000, samples: 5, enoughHistory: true, highUsage: true } },
  });
  assert.deepEqual(a.highUsageNotes(marked), ['Active duration: 25m is 2.5× the median 10m', 'Tokens: 3,000 is 3× the median 1,000']);
  assert.deepEqual(a.highUsageNotes(row('plain')), []);
});

test('C26 sorting by each metric puts unavailable values last in both directions, and the High usage filter keeps only marked rows', () => {
  const withMetric = (id, metric, value, patch = {}) => row(id, { comparison: { ...NO_COMPARISON, [metric]: comparison(value) }, ...patch });
  for (const metric of ['activeDuration', 'tokens', 'fiveHourDecrease', 'sevenDayDecrease']) {
    const rows = [withMetric('mid', metric, 20), withMetric('none', metric, null), withMetric('high', metric, 30), withMetric('low', metric, 10), withMetric('none2', metric, null)];
    assert.deepEqual(a.sortRounds(rows, metric, 'desc').map((r) => r.id), ['high', 'mid', 'low', 'none', 'none2'], `${metric} descending`);
    assert.deepEqual(a.sortRounds(rows, metric, 'asc').map((r) => r.id), ['low', 'mid', 'high', 'none', 'none2'], `${metric} ascending`);
    assert.deepEqual(rows.map((r) => r.id), ['mid', 'none', 'high', 'low', 'none2'], 'the input is not reordered');
  }
  const byStart = [row('b', { startedAt: at(10) }), row('a', { startedAt: at(9) }), row('c', { startedAt: at(11) })];
  assert.deepEqual(a.sortRounds(byStart, 'startedAt', 'desc').map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual(a.sortRounds(byStart, 'startedAt', 'asc').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(a.onlyHighUsage([row('plain'), row('marked', { highUsage: ['tokens'] })]).map((r) => r.id), ['marked']);
  assert.deepEqual(Object.values(a.METRIC_LABEL), ['Active duration', 'Tokens', '5h decrease', '7d decrease']);
});

// ---- Refresh ----

test('C27 refresh status text: refreshing, refreshed, next check eligible, failed with the last successful check time, and a history-save error', () => {
  const good = { lastSuccessAt: at(14, 30), lastFailure: null, nextEligibleAt: null };
  assert.equal(a.refreshStatusText('idle', good, null), 'Last successful check 7 Oct, 14:30 · checks run about every 5 minutes');
  assert.equal(a.refreshStatusText('refreshing', good, null), 'Checking the provider…');
  assert.equal(a.refreshStatusText('refreshed', good, null), 'Refreshed · last successful check 7 Oct, 14:30');
  assert.equal(
    a.refreshStatusText('not-eligible', { ...good, nextEligibleAt: at(14, 31) }, null),
    'Not checked: the provider allows another check later · last successful check 7 Oct, 14:30 · next check eligible at 14:31',
  );
  assert.equal(
    a.refreshStatusText('failed', { lastSuccessAt: at(14, 30), lastFailure: { at: at(14, 35), reason: 'provider-error' }, nextEligibleAt: at(14, 45) }, null),
    'Check failed (the provider could not be reached) · last successful check 7 Oct, 14:30 · next check eligible at 14:45',
  );
  assert.equal(
    a.refreshStatusText('idle', { lastSuccessAt: null, lastFailure: { at: at(14, 35), reason: 'no-access' }, nextEligibleAt: null }, null),
    'Check failed (no account access) · no successful check yet',
  );
  assert.equal(a.refreshStatusText('idle', null, null), 'No successful check yet · checks run about every 5 minutes');
  const saveError = 'Analytics history could not be saved.';
  assert.equal(a.refreshStatusText('refreshed', good, { saveError, loadError: null }), `Refreshed · last successful check 7 Oct, 14:30 · ${saveError}`);
  assert.match(a.refreshStatusText('idle', good, { saveError: null, loadError: 'Saved analytics history could not be read.' }), /could not be read\.$/);
});
