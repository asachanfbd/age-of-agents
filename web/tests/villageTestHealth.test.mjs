import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const healthLib = await import('../src/lib/villageTestHealth.ts');
const wall = await import('../src/lib/villageWall.ts');
const { overviewStats, tallyResults, suiteResults } = await import('../src/lib/testingPanel.ts');
const { BUILDING } = await import('../src/lib/villageLayout.ts');
const { testHealth, ageIntensity, latestBranchResult, healthConfigOf, healthAfterTick, sameTestHealth, sameHealthRuns, testHealthTooltip, intensityWeight, INTENSITY_FLOOR, HEALTH_REFRESH_MS } = healthLib;
const { wallColor } = wall;
const GATE = 1;
const wallPieces = (coverage, split, rect = BUILDING, gate = GATE) => wall.wallPieces(coverage, split, rect, gate);

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const PERIMETER = 2 * ((BUILDING[2] - BUILDING[0]) + (BUILDING[3] - BUILDING[1])) - GATE;

let seq = 0;
const suiteDef = (id, patch = {}) => ({ id, label: id, enabled: true, primaryActionId: 'tests', ...patch });
const CONFIG = { root: '/repo', suites: [suiteDef('s1'), suiteDef('a'), suiteDef('b')] };
const health = (runs, branch, now = NOW, config = CONFIG) => testHealth(runs, config, branch, now);
const run = ({ suite = 's1', branch = 'main', status = 'passed', passed = 8, failed = 0, errored, coverage = 90, hours = 1, root = '/repo', actionId = 'tests', purpose = 'result', metrics, counts } = {}) => ({
  id: `r${seq++}`, projectId: 'p1', status, branch, executionRoot: root, completedAt: hoursAgo(hours),
  suite: { id: suite, label: suite }, action: { id: actionId, purpose },
  summary: {
    outcome: 'passed',
    counts: counts === null ? undefined : (counts ?? { passed, failed, ...(errored ? { errored } : {}), total: passed + failed }),
    metrics: metrics ?? (coverage === null ? [] : [{ key: 'line-coverage', label: 'Line coverage', value: coverage, unit: '%' }]),
    findingCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  },
});

test('U1-U7 no wall without a result on exactly the checked-out branch', () => {
  assert.equal(health([], 'main'), null);
  assert.equal(health([run({ branch: 'other' })], 'main'), null);
  assert.equal(health([run({ root: '/repo/.worktrees/t1' })], 'main'), null, 'task worktree runs ignored');
  const runs = [run({ branch: 'main', passed: 5 }), run({ branch: 'feature/x', passed: 9 })];
  assert.equal(health(runs, 'main').passed, 5);
  assert.equal(health(runs, 'feature/x').passed, 9, 'a branch switch changes the result');
  assert.equal(health(runs, 'gone'), null);
  assert.equal(health([run({ branch: null })], null), null);
  assert.equal(health([run({ branch: 'Main' }), run({ branch: 'feature/a-2' })], 'main'), null);
  assert.equal(health([run({ branch: 'feature/a-2' })], 'feature/a'), null);
});

test('U8-U12 only the newest finished result run per suite counts', () => {
  const older = run({ passed: 1, hours: 5 });
  const newer = run({ passed: 7, hours: 2 });
  assert.equal(health([older, newer], 'main').passed, 7);
  assert.equal(health([newer, older], 'main').passed, 7);
  const running = { ...run({ passed: 50, hours: 0.1 }), status: 'running' };
  const queued = { ...run({ hours: 0.1 }), status: 'queued' };
  const stopped = { ...run({ hours: 0.1 }), status: 'stopped' };
  assert.equal(health([newer, running, queued, stopped], 'main').passed, 7);
  assert.equal(health([run({ purpose: 'utility' })], 'main'), null);
  assert.equal(latestBranchResult([{ ...run(), summary: null }], CONFIG, 's1', 'tests', 'main'), null);
  // The Testing tab's rule: enabled suites and each suite's primary action only.
  assert.equal(health([run({ suite: 's1' })], 'main', NOW, { ...CONFIG, suites: [suiteDef('s1', { enabled: false })] }), null, 'disabled suite');
  assert.equal(health([run({ actionId: 'extra' })], 'main'), null, 'non-primary result action');
  assert.equal(health([run({ actionId: 'extra' })], 'main', NOW, { ...CONFIG, suites: [suiteDef('s1', { primaryActionId: 'extra' })] }).passed, 8);
  assert.equal(health([run()], 'main', NOW, null), null, 'no config yet');
  assert.equal(health([run({ suite: 'unknown' })], 'main'), null, 'suite not in the config');
});

test('U13-U15 counts sum across suites exactly like the Testing tab, errored counts as failed', () => {
  const runs = [run({ suite: 'a', passed: 6, failed: 1 }), run({ suite: 'b', passed: 2, failed: 0, errored: 3 })];
  const h = health(runs, 'main');
  const stats = overviewStats(runs.map((r) => ({ id: r.suite.id, label: r.suite.label, enabled: true, latestResult: r })));
  assert.equal(h.passed, stats.passed);
  assert.equal(h.failed, stats.failed);
  assert.equal(h.failed, 4);
  assert.deepEqual(tallyResults(runs.map((r) => ({ suiteLabel: r.suite.label, summary: r.summary }))), stats);
  const noCounts = health([run({ status: 'error', counts: null })], 'main');
  assert.equal(noCounts.passedShare, null);
  assert.equal(noCounts.failedShare, null);
});

test('U16-U22 coverage becomes a 0-1 length; absent when not reported', () => {
  assert.equal(health([run({ coverage: 0 })], 'main').coverageFraction, 0);
  assert.equal(health([run({ coverage: 90 })], 'main').coverageFraction, 0.9);
  assert.equal(health([run({ coverage: 100 })], 'main').coverageFraction, 1);
  const none = health([run({ coverage: null })], 'main');
  assert.equal(none.coverageFraction, null);
  assert.equal(none.passed, 8);
  const metrics = [
    { key: 'function-coverage', value: 10, unit: '%' }, { key: 'branch-coverage', value: 20, unit: '%' }, { key: 'line-coverage', value: 70, unit: '%' },
  ];
  assert.equal(health([run({ metrics })], 'main').coverageFraction, 0.7, 'line coverage preferred');
  assert.equal(health([run({ metrics: metrics.slice(0, 1) })], 'main').coverageFraction, 0.1, 'falls back to the first coverage metric');
  assert.equal(health([run({ coverage: -5 })], 'main').coverageFraction, 0);
  assert.equal(health([run({ coverage: 1e9 })], 'main').coverageFraction, 1);
  for (const bad of [NaN, Infinity, '90']) assert.equal(health([run({ coverage: bad })], 'main').coverageFraction, null, String(bad));
  assert.ok(Math.abs(health([run({ coverage: 0.9 })], 'main').coverageFraction - 0.009) < 1e-12, 'percent, not a fraction');
});

test('U23-U26 passed and failed shares', () => {
  const split = health([run({ passed: 8, failed: 2 })], 'main');
  assert.equal(split.passedShare, 0.8);
  assert.equal(split.failedShare, 0.2);
  const green = health([run({ passed: 4, failed: 0 })], 'main');
  assert.deepEqual([green.passedShare, green.failedShare], [1, 0]);
  const red = health([run({ status: 'failed', passed: 0, failed: 3 })], 'main');
  assert.deepEqual([red.passedShare, red.failedShare], [0, 1]);
  const skipped = health([run({ counts: { passed: 0, failed: 0, skipped: 5, total: 5 } })], 'main');
  assert.equal(skipped.passedShare, null);
  const huge = health([run({ passed: Number.MAX_SAFE_INTEGER, failed: Number.MAX_SAFE_INTEGER })], 'main');
  assert.ok(Number.isFinite(huge.passedShare) && Number.isFinite(huge.failedShare));
});

test('U27-U34 intensity: full within 24h, fades to the floor by 48h, from the newest run', () => {
  assert.equal(ageIntensity(hoursAgo(0), NOW), 1);
  assert.equal(ageIntensity(hoursAgo(23.99), NOW), 1);
  assert.equal(ageIntensity(hoursAgo(24), NOW), 1);
  assert.ok(Math.abs(ageIntensity(hoursAgo(36), NOW) - (1 + INTENSITY_FLOOR) / 2) < 1e-9);
  let last = 1;
  for (let h = 24; h <= 48; h += 1) {
    const i = ageIntensity(hoursAgo(h), NOW);
    assert.ok(i <= last);
    last = i;
  }
  assert.equal(ageIntensity(hoursAgo(48), NOW), INTENSITY_FLOOR);
  assert.equal(ageIntensity(new Date(NOW - 48 * 3_600_000 - 1).toISOString(), NOW), INTENSITY_FLOOR);
  assert.equal(ageIntensity(hoursAgo(24 * 30), NOW), INTENSITY_FLOOR);
  assert.equal(ageIntensity(hoursAgo(-5), NOW), 1, 'clock skew');
  for (const bad of [null, 'garbage']) assert.equal(ageIntensity(bad, NOW), INTENSITY_FLOOR);
  const h = health([run({ suite: 'a', hours: 60 }), run({ suite: 'b', hours: 2 })], 'main');
  assert.equal(h.ageIntensity, 1, 'newest run across suites');
  assert.equal(h.lastRunAt, hoursAgo(2));
  assert.equal(intensityWeight(1), 1);
  assert.equal(intensityWeight(INTENSITY_FLOOR), 0);
});

const total = (pieces, tone) => pieces.filter((p) => !tone || p.tone === tone).reduce((sum, p) => sum + p.length, 0);

test('U35-U44 wall pieces along the fence', () => {
  const split = { passedShare: 1, failedShare: 0 };
  assert.deepEqual(wallPieces(0, split), []);
  assert.deepEqual(wallPieces(null, split), []);
  const ring = wallPieces(1, split);
  assert.ok(Math.abs(total(ring) - PERIMETER) < 1e-9);
  assert.equal(ring.length, 5);
  const ninety = wallPieces(0.9, split);
  assert.ok(Math.abs(total(ninety) - 0.9 * PERIMETER) < 1e-9);
  const start = wallPieces(0.1, split)[0];
  const hd = (BUILDING[3] - BUILDING[1]) / 2;
  assert.equal(start.axis, 'x', 'starts on the front side');
  assert.ok(start.x < -GATE / 2 && Math.abs(start.z - hd) < 1e-9, 'starts at the gate edge, running left');
  assert.ok(Math.abs(start.x + GATE / 2 + start.length / 2) < 1e-9, 'its inner end is the gate edge');
  assert.deepEqual(wallPieces(0.9, split), ninety);
  const mixed = wallPieces(0.5, { passedShare: 0.8, failedShare: 0.2 });
  assert.ok(Math.abs(total(mixed, 'pass') - 0.4 * PERIMETER) < 1e-9);
  assert.ok(Math.abs(total(mixed, 'fail') - 0.1 * PERIMETER) < 1e-9);
  assert.equal(mixed[0].tone, 'pass');
  assert.equal(mixed.at(-1).tone, 'fail');
  assert.equal(new Set(wallPieces(1, split).map((p) => p.tone)).size, 1);
  assert.deepEqual(new Set(wallPieces(1, { passedShare: 0, failedShare: 1 }).map((p) => p.tone)), new Set(['fail']));
  assert.deepEqual(new Set(wallPieces(1, { passedShare: null, failedShare: null }).map((p) => p.tone)), new Set(['unknown']));
  const thirds = wallPieces(1, { passedShare: 1 / 3, failedShare: 2 / 3 });
  assert.ok(Math.abs(total(thirds) - PERIMETER) < 1e-9);
  assert.ok(thirds.every((p) => p.length > 1e-6));
  const tiny = wallPieces(0.001, split);
  assert.equal(tiny.length, 1);
  assert.ok(tiny[0].length > 0 && Number.isFinite(tiny[0].x));
  const crossing = wallPieces(0.3, { passedShare: 0.5, failedShare: 0.5 });
  assert.ok(Math.abs(total(crossing) - 0.3 * PERIMETER) < 1e-9, 'a run spanning a corner splits per side');
});

test('wall never covers the gate gap and ends at the other gate edge', () => {
  const split = { passedShare: 1, failedShare: 0 };
  const hd = (BUILDING[3] - BUILDING[1]) / 2;
  for (const fraction of [0.05, 0.2, 0.5, 0.8, 0.95, 1]) {
    for (const p of wallPieces(fraction, split)) {
      if (p.axis !== 'x' || Math.abs(p.z - hd) > 1e-9) continue;
      assert.ok(Math.abs(p.x) - p.length / 2 >= GATE / 2 - 1e-9, `no front piece overlaps the gate at ${fraction}`);
    }
  }
  const last = wallPieces(1, split).at(-1);
  assert.equal(last.axis, 'x');
  assert.ok(last.x > 0 && Math.abs(last.x - last.length / 2 - GATE / 2) < 1e-9, 'ends at the gate right edge');
  const halfway = wallPieces(0.5, split);
  assert.ok(halfway.every((p) => !(p.axis === 'x' && p.x > 0 && p.z > 0)), 'half coverage stops before the front-right run');
});

test('U45 wall colour lerps from the faded tone to the full colour', () => {
  assert.equal(wallColor('pass', 1), '#2fb344');
  assert.equal(wallColor('fail', 1), '#e5484d');
  assert.equal(wallColor('pass', 0), '#a9bfae');
  assert.notEqual(wallColor('pass', 0.5), wallColor('pass', 1));
  assert.equal(wallColor('pass', 0.5), wallColor('pass', 0.5));
  assert.equal(wallColor('pass', 2), wallColor('pass', 1));
});

test('U46 tooltip text names the branch, counts, coverage and age; missing parts are omitted', () => {
  const full = testHealthTooltip(health([run({ passed: 8, failed: 2, coverage: 87.5, hours: 5 })], 'main'), NOW);
  assert.deepEqual(full, { title: 'main', lines: ['8 passed / 2 failed', '87.5% coverage', 'last run 5h ago'] });
  const bare = testHealthTooltip(health([run({ counts: null, coverage: null, hours: 0 })], 'main'), NOW);
  assert.deepEqual(bare.lines, ['last run just now']);
  assert.ok(!JSON.stringify(full).includes('undefined'));
});

test('I1-I3 equality helpers keep unchanged health and runs stable', () => {
  const a = health([run({ hours: 36 })], 'main');
  assert.equal(sameTestHealth(a, structuredClone(a)), true);
  assert.equal(sameTestHealth(a, { ...a, ageIntensity: a.ageIntensity - 0.001 }), true, 'sub-step drift requests no frame');
  assert.equal(sameTestHealth(a, { ...a, ageIntensity: a.ageIntensity - 0.05 }), false);
  assert.equal(sameTestHealth(a, { ...a, passed: a.passed + 1 }), false);
  assert.equal(sameTestHealth(a, { ...a, branch: 'x' }), false);
  assert.equal(sameTestHealth(null, null), true);
  assert.equal(sameTestHealth(a, null), false);
  const r = run();
  assert.equal(sameHealthRuns([r], [{ ...r, summary: { ...r.summary } }]), true);
  assert.equal(sameHealthRuns([r], [{ ...r, status: 'failed' }]), false);
  assert.equal(sameHealthRuns([r], []), false);
});

test('I4 inside the 24h plateau a later clock changes nothing; crossing it does', () => {
  const runs = [run({ hours: 2 })];
  assert.equal(sameTestHealth(health(runs, 'main'), health(runs, 'main', NOW + 60_000)), true);
  assert.equal(sameTestHealth(health(runs, 'main'), health(runs, 'main', NOW + 30 * 3_600_000)), false);
});

test('config is read from the overview: root from an own-tree result, none without one', () => {
  const suites = [{ id: 's1', label: 'S1', enabled: true, primaryActionId: 'tests', latestResult: run() }, { id: 's2', label: 'S2', enabled: false, primaryActionId: 'x', latestResult: null }];
  assert.deepEqual(healthConfigOf(suites), { root: '/repo', suites: [
    { id: 's1', label: 'S1', enabled: true, primaryActionId: 'tests' }, { id: 's2', label: 'S2', enabled: false, primaryActionId: 'x' }] });
  assert.equal(healthConfigOf([{ ...suites[1] }]), null);
  assert.equal(healthConfigOf([]), null);
});

test('the Testing tab and the wall share one suite selection', () => {
  const a = { label: 'A', enabled: true, r: run() };
  const off = { label: 'Off', enabled: false, r: run() };
  const none = { label: 'None', enabled: true, r: null };
  assert.deepEqual(suiteResults([a, off, none], (suite) => suite.r).map((r) => r.suiteLabel), ['A']);
});

test('I4 the tick yields a new health only when the value changed', () => {
  const runs = [run({ hours: 2 })];
  const at = health(runs, 'main');
  assert.equal(healthAfterTick(at, runs, CONFIG, 'main', NOW + 60_000), null, 'inside the 24h plateau: no frame');
  const crossed = healthAfterTick(at, runs, CONFIG, 'main', NOW + 30 * 3_600_000);
  assert.ok(crossed && crossed.next.ageIntensity < 1);
  assert.deepEqual(healthAfterTick(at, runs, CONFIG, 'other', NOW), { next: null }, 'branch switch to one without runs');
  assert.equal(healthAfterTick(null, [], CONFIG, 'main', NOW), null);
});

test('I6 only an error test run (not a failed one) is a red machine', async () => {
  const src = await read('../src/lib/villageYard.ts');
  assert.match(src, /const failed = run\.status === 'error' && run\.failureUnopened === true;/);
});

test('I5-I6 wiring: slow timer, branch from sync, tooltip below popups, shadows, no duplicated tally', async () => {
  assert.ok(HEALTH_REFRESH_MS >= 60_000 && HEALTH_REFRESH_MS <= 600_000);
  const hook = await read('../src/lib/useTestHealth.ts');
  assert.match(hook, /serverApi\.getTestingOverview\(projectId\), serverApi\.listTestRuns\(projectId, RECENT_RUNS\)/, 'loads the overview and recent runs');
  assert.match(hook, /\[projectId, live\]\);/, 'reloads when a live run changes');
  assert.match(hook, /useHeldList\(/);
  assert.match(hook, /setInterval\(/);
  assert.match(hook, /clearInterval\(timer\)/);
  const yard = await read('../src/scene/ProjectYard.tsx');
  assert.match(yard, /useTestHealth\(project\.id, project\.sync\?\.branch \?\? null\)/);
  assert.match(yard, /\{health && <YardHealthWall health=\{health\} \/>\}/, 'the yard group draws the wall, so it turns with the yard');
  assert.doesNotMatch(yard, /<Warehouse [^>]*health=/);
  assert.match(yard, /testHealthTooltip\(health, Date\.now\(\)\)/);
  const entities = await read('../src/scene/YardEntities.tsx');
  assert.match(entities, /zIndexRange=\{SCENE_HTML_Z_RANGE\}/);
  assert.match(entities, /export function Tag\(/);
  const parts = await read('../src/scene/yardParts.tsx');
  assert.doesNotMatch(parts.slice(parts.indexOf('export function Warehouse('), parts.indexOf('export function YardHealthWall')), /health|wallPieces/i, 'the warehouse draws no wall');
  assert.match(parts, /wallPieces\(health\.coverageFraction, health, HEALTH_WALL_RECT, HEALTH_WALL_GATE\)/);
  assert.match(parts, /HEALTH_WALL_BASE \+ HEALTH_WALL_HEIGHT \/ 2/);
  assert.match(parts, /scale=\{\[piece\.length, 1, 1\]\}\s+raycast=\{noRaycast\}/, 'the wall takes no clicks');
  assert.match(await read('../src/lib/villageTestHealth.ts'), /import \{ suiteResults, tallyResults \} from '\.\/testingPanel'/);
  assert.match(await read('../src/lib/testingPanel.ts'), /return tallyResults\(suiteResults\(/);
});

test('U45 the health wall path stands on the boundary fence, above it', async () => {
  const { HEALTH_WALL_RECT, HEALTH_WALL_BASE, HEALTH_WALL_HEIGHT, HEALTH_WALL_GATE } = await import('../src/scene/healthWallSize.ts');
  const { FENCE_HEIGHT, FENCE_MARGIN, GATE_WIDTH } = await import('../src/scene/scenery.ts');
  const { YARD_RECT, YARD_SCALE } = await import('../src/lib/villageLayout.ts');
  const margin = FENCE_MARGIN / YARD_SCALE;
  HEALTH_WALL_RECT.forEach((v, i) => assert.ok(Math.abs(v - (YARD_RECT[i] + (i < 2 ? -margin : margin))) < 1e-9));
  assert.ok(Math.abs(HEALTH_WALL_BASE - FENCE_HEIGHT / YARD_SCALE) < 1e-9, 'the base is the fence top');
  assert.ok(HEALTH_WALL_HEIGHT > 0);
  const [x0, z0, x1, z1] = HEALTH_WALL_RECT;
  assert.ok(Math.abs(HEALTH_WALL_GATE - GATE_WIDTH / YARD_SCALE) < 1e-9, 'the wall shares the fence gate width');
  const path = total(wallPieces(1, { passedShare: 1, failedShare: 0 }, HEALTH_WALL_RECT, HEALTH_WALL_GATE));
  assert.ok(Math.abs(path - (2 * ((x1 - x0) + (z1 - z0)) - HEALTH_WALL_GATE)) < 1e-9, 'full coverage runs round the fence, gate excluded');
});
