import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const layout = await import('../src/scene/townLayout.ts');
const { PROJECT_PLOTS, PROJECT_CAPACITY, samePlot, nearestFreePlot, SIDES, STREET_COUNT, SLOTS_PER_SIDE, ROAD_WIDTH, WORLD_BOUND, STREET_HALF_LENGTH } = layout;
const { yardWorldRect, rectsOverlap, CITY_CENTER_RECT } = await import('../src/lib/villageLayout.ts');
const { STREET_ROADS, CROSS_ROAD } = await import('../src/scene/scenery.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { sampleSky } = await import('../src/scene/skyKeyframes.ts');
const { installServerStub } = await import('./serverStub.mjs');

const nearestToCenter = PROJECT_PLOTS.map((p, index) => ({ p, index, d: Math.round((p.x ** 2 + p.z ** 2) * 1e6) })).sort((a, b) => a.d - b.d || a.index - b.index).map((e) => e.p);
const world = (plot) => [plot.x * layout.TOWN_SCALE, plot.z * layout.TOWN_SCALE];

test('U01 capacity is derived from the street, side and slot counts: 12 x 2 x 10 = 240 plots', () => {
  assert.equal(STREET_COUNT, 12);
  assert.deepEqual(SIDES, ['left', 'right']);
  assert.equal(SLOTS_PER_SIDE, 10);
  assert.equal(PROJECT_CAPACITY, 240);
  assert.equal(PROJECT_PLOTS.length, 240);
});

test('U02 every plot is distinct, outside the tolerance of any other, and none is the City Center', () => {
  for (let i = 0; i < PROJECT_PLOTS.length; i++) {
    assert.ok(!samePlot(PROJECT_PLOTS[i], { x: 0, z: 0 }), `plot ${i} is not City Center`);
    for (let j = i + 1; j < PROJECT_PLOTS.length; j++) assert.ok(!samePlot(PROJECT_PLOTS[i], PROJECT_PLOTS[j]), `plots ${i}/${j}`);
  }
});

test('U03 left and right plots of a street sit on opposite sides of its centre line at the same distance and the same slot positions', () => {
  for (let street = 1; street <= STREET_COUNT; street++) {
    const centre = layout.streetX(street);
    for (let slot = 1; slot <= SLOTS_PER_SIDE; slot++) {
      const left = world(PROJECT_PLOTS[layout.flatIndexOfRef({ street, side: 'left', slot })]);
      const right = world(PROJECT_PLOTS[layout.flatIndexOfRef({ street, side: 'right', slot })]);
      assert.ok(left[0] < centre && right[0] > centre);
      assert.ok(Math.abs((centre - left[0]) - (right[0] - centre)) < 1e-3);
      assert.ok(Math.abs(left[1] - right[1]) < 1e-3, 'same slot, same position along the street');
    }
  }
});

test('U04/U05 yards on one side are evenly spaced, and no yard overlaps a road, City Center or another yard', () => {
  const rects = PROJECT_PLOTS.map((plot) => yardWorldRect([plot.x, plot.z]));
  for (let i = 0; i < rects.length; i++) {
    assert.ok(!rectsOverlap(rects[i], CITY_CENTER_RECT));
    for (const road of [...STREET_ROADS, CROSS_ROAD]) assert.ok(!rectsOverlap(rects[i], road), `plot ${i} on a road`);
    for (let j = i + 1; j < rects.length; j++) assert.ok(!rectsOverlap(rects[i], rects[j]), `plots ${i}/${j}`);
  }
  for (const side of SIDES) {
    const zs = Array.from({ length: SLOTS_PER_SIDE }, (_, k) => world(PROJECT_PLOTS[layout.flatIndexOfRef({ street: 1, side, slot: k + 1 })])[1]);
    for (let k = 1; k < zs.length; k++) assert.ok(Math.abs(Math.abs(zs[k] - zs[k - 1]) - layout.SLOT_PITCH) < 1e-3);
  }
});

test('U06/U45 every yard is inside the world, which is far larger than what the camera shows at once', () => {
  for (const plot of PROJECT_PLOTS) {
    const [x0, z0, x1, z1] = yardWorldRect([plot.x, plot.z]);
    assert.ok(Math.min(x0, z0) > -WORLD_BOUND + 3 && Math.max(x1, z1) < WORLD_BOUND - 3);
  }
  assert.ok(STREET_HALF_LENGTH < WORLD_BOUND && layout.CROSS_ROAD_HALF_LENGTH < WORLD_BOUND);
  assert.ok(WORLD_BOUND >= 3 * 17, 'the 13.001 camera frame shows about 17 units around the middle');
  assert.equal(ROAD_WIDTH > 0, true);
});

test('U10/U11 nearestFreePlot picks the closest free plot on either side of a street, skips occupied ones, and is null when full', () => {
  const left = PROJECT_PLOTS[layout.flatIndexOfRef({ street: 3, side: 'left', slot: 4 })];
  const right = PROJECT_PLOTS[layout.flatIndexOfRef({ street: 3, side: 'right', slot: 4 })];
  assert.deepEqual(nearestFreePlot(left.x + 0.1, left.z, []), [left.x, left.z]);
  assert.deepEqual(nearestFreePlot(right.x - 0.1, right.z, []), [right.x, right.z]);
  assert.notDeepEqual(nearestFreePlot(left.x, left.z, [left]), [left.x, left.z]);
  assert.deepEqual(nearestFreePlot(left.x, left.z, [left, right]).length, 2);
  assert.equal(nearestFreePlot(0, 0, PROJECT_PLOTS), null);
  const last = PROJECT_PLOTS[239];
  assert.deepEqual(nearestFreePlot(0, 0, PROJECT_PLOTS.slice(0, 239)), [last.x, last.z]);
  for (const bad of [NaN, Infinity, -Infinity]) assert.equal(nearestFreePlot(bad, 0, []), null);
  assert.ok(nearestFreePlot(1e9, 1e9, []), 'a point far outside the world still answers');
  assert.deepEqual(nearestFreePlot(left.x, left.z, []), nearestFreePlot(left.x, left.z, []), 'deterministic');
});

test('U12 samePlot tolerance: 0.0009 matches and 0.0011 does not', () => {
  assert.equal(samePlot({ x: 1, z: 1 }, { x: 1.0009, z: 1 }), true);
  assert.equal(samePlot({ x: 1, z: 1 }, { x: 1.0011, z: 1 }), false);
});

test('U15/U18 legacy block-grid coordinates are 32 distinct plots that coincide with no street plot, and map, in order, to the street plots nearest City Center', () => {
  assert.equal(layout.LEGACY_PLOTS.length, 32);
  for (const legacy of layout.LEGACY_PLOTS) assert.ok(!PROJECT_PLOTS.some((plot) => samePlot(plot, legacy)));
  layout.LEGACY_PLOTS.forEach((legacy, i) => assert.deepEqual(layout.migrateLegacyPosition([legacy.x, legacy.z]), [nearestToCenter[i].x, nearestToCenter[i].z]));
  assert.equal(layout.migrateLegacyPosition([PROJECT_PLOTS[0].x, PROJECT_PLOTS[0].z]), null, 'a street plot is not remapped again');
  for (const bad of [null, undefined, [1], [NaN, 0], [0, 0], ['0.78', '0.78']]) assert.equal(layout.migrateLegacyPosition(bad), null);
});

test('creation, dragging, collisions, and full capacity all enforce fixed plots', async () => {
  installServerStub();
  useWorldStore.setState({ projects: [], selectedId: null });
  const state = () => useWorldStore.getState();
  // Sequential, not Promise.all: each call reads the previous one's committed position to pick
  // the next free plot, exactly like a user clicking "Create Project" once at a time for real.
  await state().addProject('Test A'); await state().addProject('Test B');
  const [first, second] = state().projects;
  state().moveProject(first.id, ...second.position);
  assert.notDeepEqual(state().projects[0].position, second.position);
  state().moveProject(first.id, 99999, -99999);
  const moved = state().projects[0].position;
  assert.ok(PROJECT_PLOTS.some((p) => samePlot(p, { x: moved[0], z: moved[1] })));
  state().moveProject(first.id, NaN, 0);
  assert.deepEqual(state().projects[0].position, moved);
  for (let i = 0; i < PROJECT_CAPACITY + 3; i++) await state().addProject(`Test ${i}`);
  assert.equal(state().projects.length, PROJECT_CAPACITY);
  assert.equal(new Set(state().projects.map((p) => p.position.join(':'))).size, PROJECT_CAPACITY);
  state().moveProject(first.id, 0, 0);
  assert.equal(new Set(state().projects.map((p) => p.position.join(':'))).size, PROJECT_CAPACITY);
  useWorldStore.setState({ projects: [], selectedId: null });
});

test('full daylight holds from 8 AM through 5 PM and night remains distinct', () => {
  const noon = sampleSky(12 / 24);
  const daylight = { sun: noon.sunIntensity, ambient: noon.hemisphereIntensity, sky: noon.sky.getHex() };
  for (const hour of [8, 9, 12, 15, 17]) {
    const sky = sampleSky(hour / 24);
    assert.ok(Math.abs(sky.sunIntensity - daylight.sun) < 1e-9);
    assert.ok(Math.abs(sky.hemisphereIntensity - daylight.ambient) < 1e-9);
    assert.equal(sky.sky.getHex(), daylight.sky);
  }
  assert.ok(daylight.sun >= 2.5);
  assert.ok(daylight.ambient >= 2);
  assert.ok(sampleSky(23 / 24).sunIntensity < daylight.sun / 3);
});
