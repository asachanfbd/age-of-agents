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

const cam = await import('../src/scene/cameraMath.ts');
const { DEFAULT_VIEW } = await import('../src/scene/defaultView.ts');
const { WAREHOUSE_RIDGE_HEIGHT, plotOfWorld, yardWorldRect } = await import('../src/lib/villageLayout.ts');
const { TOWN_SCALE, ROAD_REACH, STREET_HALF_LENGTH, CROSS_ROAD_HALF_LENGTH, PROJECT_PLOTS, streetX, worldOfRef } = await import('../src/scene/townLayout.ts');
const {
  HOME_ORBIT, MAP_HALF, MIN_DISTANCE, MAX_DISTANCE, MIN_ELEVATION, MAX_ELEVATION, STREET_ELEVATION,
  orbitOfView, positionOfOrbit, clampTarget, clampDistance, clampElevation, streetWalkElevation, tiltedElevation,
  elevationAfterZoom, normalizeAzimuth, easeInOut, interpolateOrbit, flightStep, sameOrbit,
} = cam;

const deg = (rad) => (rad * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const scene = await readFile(new URL('../src/scene/Scene.tsx', import.meta.url), 'utf8');
const FOG_NEAR = Number(scene.match(/const FOG_NEAR = ([\d.]+);/)?.[1]);

// A by-hand perspective projection (three.js is not installed for tests).
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((v) => v / Math.hypot(...a));
function projector(orbit, aspect) {
  const position = positionOfOrbit(orbit);
  const target = [orbit.target.x, 0, orbit.target.z];
  const forward = unit(sub(target, position));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const f = 1 / Math.tan((DEFAULT_VIEW.fov * Math.PI) / 360);
  return (point) => {
    const rel = sub(point, position);
    const depth = dot(rel, forward);
    return { x: (dot(rel, right) * f) / aspect / depth, y: (dot(rel, up) * f) / depth, depth, range: Math.hypot(...rel) };
  };
}
const yardCorners = PROJECT_PLOTS.flatMap((plot) => {
  const [x0, z0, x1, z1] = yardWorldRect([plot.x, plot.z]);
  return [x0, x1].flatMap((x) => [z0, z1].flatMap((z) => [0, WAREHOUSE_RIDGE_HEIGHT].map((y) => [x, y, z])));
});

test('U01 the Home orbit is derived from DEFAULT_VIEW at a 36 degree elevation', () => {
  const [px, py, pz] = DEFAULT_VIEW.position;
  const [tx, ty, tz] = DEFAULT_VIEW.target;
  assert.deepEqual(HOME_ORBIT.target, { x: tx, z: tz });
  close(HOME_ORBIT.distance, Math.hypot(px - tx, py - ty, pz - tz));
  close(HOME_ORBIT.azimuth, Math.atan2(px - tx, pz - tz));
  assert.ok(Math.abs(deg(HOME_ORBIT.elevation) - 36) <= 0.5, `${deg(HOME_ORBIT.elevation)}`);
  close(Math.abs(px - tx), Math.abs(pz - tz));
  assert.deepEqual([...DEFAULT_VIEW.target], [2, 0, 2]);
  assert.equal(DEFAULT_VIEW.fov, 40);
});

test('U01b Home sits well above the street angle and inside the tilt limits, and the walk-in eases monotonically', () => {
  assert.ok(deg(HOME_ORBIT.elevation) - deg(STREET_ELEVATION) >= 8);
  assert.ok(deg(HOME_ORBIT.elevation) - deg(MIN_ELEVATION) >= 15);
  assert.ok(deg(MAX_ELEVATION) - deg(HOME_ORBIT.elevation) >= 40);
  let prev = -Infinity;
  for (let i = 0; i <= 6; i++) {
    const e = streetWalkElevation(MIN_DISTANCE + ((HOME_ORBIT.distance - MIN_DISTANCE) * i) / 6);
    assert.ok(e > prev, `step ${i}`);
    prev = e;
  }
});

test('U02 orbit to position round trip gives DEFAULT_VIEW.position back', () => {
  positionOfOrbit(HOME_ORBIT).forEach((v, i) => close(v, DEFAULT_VIEW.position[i]));
  const orbit = orbitOfView([1, 9, -4], [3, 0, 2]);
  positionOfOrbit(orbit).forEach((v, i) => close(v, [1, 9, -4][i]));
});

test('U03 clampTarget leaves a point inside the map unchanged', () => {
  assert.deepEqual(clampTarget({ x: 3.5, z: -7 }), { x: 3.5, z: -7 });
});

test('U04 clampTarget snaps a point past an edge or corner to the edge', () => {
  assert.deepEqual(clampTarget({ x: 99, z: 1 }), { x: MAP_HALF, z: 1 });
  assert.deepEqual(clampTarget({ x: 1, z: -99 }), { x: 1, z: -MAP_HALF });
  assert.deepEqual(clampTarget({ x: -99, z: 99 }), { x: -MAP_HALF, z: MAP_HALF });
});

test('U05 clampTarget leaves a point exactly on the boundary unchanged', () => {
  assert.deepEqual(clampTarget({ x: MAP_HALF, z: -MAP_HALF }), { x: MAP_HALF, z: -MAP_HALF });
});

test('U06 clampTarget turns NaN, Infinity and huge numbers into a finite point on the map', () => {
  assert.deepEqual(clampTarget({ x: Infinity, z: -Infinity }), { x: MAP_HALF, z: -MAP_HALF });
  assert.deepEqual(clampTarget({ x: 1e308, z: -1e308 }), { x: MAP_HALF, z: -MAP_HALF });
  assert.deepEqual(clampTarget({ x: NaN, z: NaN }, { x: 4, z: -3 }), { x: 4, z: -3 });
  assert.deepEqual(clampTarget({ x: NaN, z: 1 }), { x: HOME_ORBIT.target.x, z: 1 });
});

test('U07 the map bounds come from the town layout constants, not a literal', async () => {
  assert.equal(MAP_HALF, ROAD_REACH);
  assert.equal(ROAD_REACH, Math.max(STREET_HALF_LENGTH, CROSS_ROAD_HALF_LENGTH), 'as far as the longest road reaches');
  const source = await readFile(new URL('../src/scene/cameraMath.ts', import.meta.url), 'utf8');
  assert.match(source, /export const MAP_HALF = ROAD_REACH;/);
});

test('U08 clampDistance keeps the zoom between the limits for any input', () => {
  assert.equal(clampDistance(1), MIN_DISTANCE);
  assert.equal(clampDistance(500), MAX_DISTANCE);
  assert.equal(clampDistance(40), 40);
  assert.equal(clampDistance(0), MIN_DISTANCE);
  assert.equal(clampDistance(-5), MIN_DISTANCE);
  assert.equal(clampDistance(Infinity), MAX_DISTANCE);
  assert.equal(clampDistance(NaN), HOME_ORBIT.distance);
  assert.ok(MIN_DISTANCE < HOME_ORBIT.distance && HOME_ORBIT.distance < MAX_DISTANCE);
});

test('U09 street-walk elevation is Home at Home distance, ~28 degrees at the closest, never decreasing', () => {
  close(streetWalkElevation(HOME_ORBIT.distance), HOME_ORBIT.elevation);
  close(streetWalkElevation(MIN_DISTANCE), STREET_ELEVATION);
  close(deg(STREET_ELEVATION), 28);
  let previous = -Infinity;
  for (let d = 0; d <= MAX_DISTANCE + 10; d += 0.5) {
    const e = streetWalkElevation(d);
    assert.ok(e >= previous - 1e-12, `drops at ${d}`);
    assert.ok(e <= MAX_ELEVATION);
    previous = e;
  }
  close(streetWalkElevation(MAX_DISTANCE), HOME_ORBIT.elevation);
});

test('U09b zooming in to street level and back out returns to the Home elevation', () => {
  const closeIn = elevationAfterZoom(HOME_ORBIT.elevation, HOME_ORBIT.distance, MIN_DISTANCE);
  close(closeIn, STREET_ELEVATION);
  close(elevationAfterZoom(closeIn, MIN_DISTANCE, HOME_ORBIT.distance), HOME_ORBIT.elevation);
});

test('U10 tilt keeps the elevation within 20-80 degrees and the polar angle strictly between 0 and 90', () => {
  for (const tilt of [-1e6, -2, -0.3, 0, 0.3, 2, 1e6]) {
    for (const d of [MIN_DISTANCE, HOME_ORBIT.distance, MAX_DISTANCE]) {
      const e = tiltedElevation(d, tilt);
      assert.ok(e >= MIN_ELEVATION && e <= MAX_ELEVATION, `tilt ${tilt} at ${d}: ${deg(e)}`);
      const polar = Math.PI / 2 - e;
      assert.ok(polar > 0 && polar < Math.PI / 2);
    }
  }
  close(deg(MIN_ELEVATION), 20);
  close(deg(MAX_ELEVATION), 80);
  assert.equal(clampElevation(NaN), HOME_ORBIT.elevation);
  // A zoom keeps the user's own tilt on top of the street-walk curve.
  const tilted = HOME_ORBIT.elevation + rad(5);
  close(elevationAfterZoom(tilted, HOME_ORBIT.distance, 30), streetWalkElevation(30) + rad(5));
});

test('U11 the camera is above the ground at every clamped distance and elevation', () => {
  for (let d = MIN_DISTANCE; d <= MAX_DISTANCE; d += 2) {
    for (let e = deg(MIN_ELEVATION); e <= deg(MAX_ELEVATION); e += 2.5) {
      assert.ok(positionOfOrbit({ ...HOME_ORBIT, distance: d, elevation: rad(e) })[1] > 0);
    }
  }
});

test('U12 azimuths are normalised and interpolate the short way round', () => {
  close(normalizeAzimuth(3 * Math.PI), Math.PI);
  close(normalizeAzimuth(-2.5 * Math.PI), -0.5 * Math.PI);
  const big = normalizeAzimuth(1e6);
  assert.ok(big > -Math.PI && big <= Math.PI);
  assert.equal(normalizeAzimuth(Infinity), 0);
  const from = { ...HOME_ORBIT, azimuth: rad(350) };
  const to = { ...HOME_ORBIT, azimuth: rad(10) };
  close(deg(normalizeAzimuth(interpolateOrbit(from, to, 0.5).azimuth)), 0, 1e-9);
  close(deg(normalizeAzimuth(interpolateOrbit(from, to, 0.25).azimuth - from.azimuth)), 5, 1e-9);
});

test('U13 easeInOut runs 0..1, is monotonic and clamps out-of-range input', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(0.5), 0.5);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(-3), 0);
  assert.equal(easeInOut(7), 1);
  assert.equal(easeInOut(NaN), 0);
  for (let t = 0; t < 1; t += 0.01) assert.ok(easeInOut(t + 0.01) >= easeInOut(t));
});

const away = { target: { x: -10, z: 6 }, distance: 20, azimuth: rad(-120), elevation: rad(35) };

test('U14 flightStep starts at the start, ends exactly at the goal, and survives odd timings', () => {
  const flight = { from: away, to: HOME_ORBIT, startedAt: 1000, duration: 700 };
  assert.deepEqual(flightStep(flight, 1000), { orbit: away, done: false });
  assert.deepEqual(flightStep(flight, 1700), { orbit: HOME_ORBIT, done: true });
  assert.deepEqual(flightStep(flight, 99999), { orbit: HOME_ORBIT, done: true });
  assert.deepEqual(flightStep(flight, 500), { orbit: away, done: false });
  assert.deepEqual(flightStep({ ...flight, duration: 0 }, 1000), { orbit: HOME_ORBIT, done: true });
});

test('U15 interpolateOrbit midpoint lies between start and goal and its end is exactly the Home view', () => {
  const mid = interpolateOrbit(away, HOME_ORBIT, 0.5);
  const between = (v, a, b) => assert.ok(v >= Math.min(a, b) && v <= Math.max(a, b));
  between(mid.target.x, away.target.x, HOME_ORBIT.target.x);
  between(mid.target.z, away.target.z, HOME_ORBIT.target.z);
  between(mid.distance, away.distance, HOME_ORBIT.distance);
  between(mid.elevation, away.elevation, HOME_ORBIT.elevation);
  const end = interpolateOrbit(away, HOME_ORBIT, 1);
  assert.equal(end, HOME_ORBIT);
  positionOfOrbit(end).forEach((v, i) => close(v, DEFAULT_VIEW.position[i]));
  assert.ok(sameOrbit(HOME_ORBIT, { ...HOME_ORBIT, azimuth: HOME_ORBIT.azimuth + 2 * Math.PI }));
  assert.ok(!sameOrbit(HOME_ORBIT, away));
});

test('U32 street walk: at the closest zoom on a street, the yards on both sides fill the screen from the side', () => {
  // Street 2 (south of the cross road), looking north along it at its first pair of yards.
  const [leftX, z] = worldOfRef({ street: 2, side: 'left', slot: 1 });
  const [rightX] = worldOfRef({ street: 2, side: 'right', slot: 1 });
  const left = { x: leftX / TOWN_SCALE, z: z / TOWN_SCALE };
  const right = { x: rightX / TOWN_SCALE, z: z / TOWN_SCALE };
  assert.ok([left, right].every((plot) => PROJECT_PLOTS.some((p) => Math.abs(p.x - plot.x) < 1e-3 && Math.abs(p.z - plot.z) < 1e-3)), 'a pair of yards across the street');
  const orbit = { target: { x: streetX(2), z }, distance: MIN_DISTANCE, azimuth: 0, elevation: streetWalkElevation(MIN_DISTANCE) };
  const project = projector(orbit, 16 / 9);
  for (const cx of [leftX, rightX]) {
    const centre = project([cx, 0, z]);
    assert.ok(centre.depth > 0 && Math.abs(centre.x) <= 1 && Math.abs(centre.y) <= 1, `yard centre at (${centre.x}, ${centre.y})`);
    const [x0, , x1] = yardWorldRect(plotOfWorld(cx, z));
    const a = project([x0, 0, z]).x;
    const b = project([x1, 0, z]).x;
    const visible = (Math.min(1, Math.max(a, b)) - Math.max(-1, Math.min(a, b))) / 2;
    assert.ok(visible >= 0.25, `yard spans ${(visible * 100).toFixed(0)}% of the width`);
    assert.ok(project([cx, WAREHOUSE_RIDGE_HEIGHT, z]).y > centre.y, 'warehouse roof above the yard ground');
  }
  assert.ok(deg(orbit.elevation) < 30);
});

test('U33 zoomed all the way out at the Home elevation, every yard is on screen and nearer than the fog', () => {
  const orbit = { ...HOME_ORBIT, distance: MAX_DISTANCE };
  for (const aspect of [16 / 9, 4 / 3]) {
    const project = projector(orbit, aspect);
    for (const corner of yardCorners) {
      const p = project(corner);
      assert.ok(p.depth > 0 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1, `corner ${corner} at aspect ${aspect}`);
      assert.ok(p.range < FOG_NEAR, `corner ${corner} is ${p.range.toFixed(1)} away`);
    }
  }
});
