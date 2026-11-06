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

const { HOME_ORBIT, MAP_HALF, MIN_DISTANCE, MAX_DISTANCE, MIN_ELEVATION } = await import('../src/scene/cameraMath.ts');
const {
  MINIMAP_VIEWBOX, CLICK_DRAG_THRESHOLD_PX, KEY_PAN_STEP, HOME_MARKER, worldToMinimap, minimapToWorld, isMinimapDrag,
  keyPan, groundFootprint, minimapDots, pressStart, pressMove, pressEnd, minimapKey,
} = await import('../src/scene/minimapMath.ts');
const { DEFAULT_VIEW } = await import('../src/scene/defaultView.ts');
const { worldOfPlot } = await import('../src/lib/villageLayout.ts');
const { CITY_POSITION } = await import('../src/scene/townLayout.ts');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const FOV = DEFAULT_VIEW.fov;
const area = (points) => Math.abs(points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length];
  return sum + p.x * q.z - q.x * p.z;
}, 0)) / 2;
const insidePolygon = (point, polygon) => polygon.every((p, i) => {
  const q = polygon[(i + 1) % polygon.length];
  return (q.x - p.x) * (point.z - p.z) - (q.z - p.z) * (point.x - p.x) >= 0;
}) || polygon.every((p, i) => {
  const q = polygon[(i + 1) % polygon.length];
  return (q.x - p.x) * (point.z - p.z) - (q.z - p.z) * (point.x - p.x) <= 0;
});

test('U19 worldToMinimap maps centre to centre and corners to corners, north up, at 200px and 140px', () => {
  for (const size of [200, 140]) {
    assert.deepEqual(worldToMinimap({ x: 0, z: 0 }, size), { x: size / 2, y: size / 2 });
    assert.deepEqual(worldToMinimap({ x: -MAP_HALF, z: -MAP_HALF }, size), { x: 0, y: 0 });
    assert.deepEqual(worldToMinimap({ x: MAP_HALF, z: MAP_HALF }, size), { x: size, y: size });
    assert.deepEqual(worldToMinimap({ x: MAP_HALF, z: -MAP_HALF }, size), { x: size, y: 0 }, '-z (north) is at the top');
  }
});

test('U20 minimapToWorld undoes worldToMinimap', () => {
  for (const point of [{ x: 0, z: 0 }, { x: 3.3, z: -12.1 }, { x: -MAP_HALF, z: MAP_HALF }, { x: 17, z: 2 }]) {
    const pixel = worldToMinimap(point, 200);
    const back = minimapToWorld(pixel.x, pixel.y, 200, 200);
    close(back.x, point.x);
    close(back.z, point.z);
  }
});

test('U21 a pointer off the minimap or at a huge position maps to the map edge', () => {
  assert.deepEqual(minimapToWorld(-20, -1, 200, 200), { x: -MAP_HALF, z: -MAP_HALF });
  assert.deepEqual(minimapToWorld(260, 500, 200, 200), { x: MAP_HALF, z: MAP_HALF });
  assert.deepEqual(minimapToWorld(1e308, -1e308, 140, 140), { x: MAP_HALF, z: -MAP_HALF });
});

test('U22 a zero-size minimap or a NaN pointer gives no point, so the camera stays put', () => {
  assert.equal(minimapToWorld(10, 10, 0, 200), null);
  assert.equal(minimapToWorld(10, 10, 200, 0), null);
  assert.equal(minimapToWorld(NaN, 10, 200, 200), null);
  assert.equal(minimapToWorld(10, NaN, 200, 200), null);
});

test('U24 a press that moves under 3px is a click; 3px or more is a drag', () => {
  assert.equal(CLICK_DRAG_THRESHOLD_PX, 3);
  const start = { x: 50, y: 50 };
  assert.equal(isMinimapDrag(start, { x: 52, y: 52 }), false);
  assert.equal(isMinimapDrag(start, { x: 53, y: 50 }), true);
  assert.equal(isMinimapDrag(start, start), false);
});

test('U25 the Home footprint is a finite trapezoid around the target, symmetric about the view axis', () => {
  const points = groundFootprint(HOME_ORBIT, 16 / 9, FOV);
  assert.equal(points.length, 4);
  for (const p of points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
  assert.ok(insidePolygon(HOME_ORBIT.target, points));
  const [nl, nr, fr, fl] = points;
  const len = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  assert.ok(len(nl, nr) < len(fl, fr), 'near edge shorter than far edge');
  // Mirror each point across the view axis (through the target, along the azimuth).
  const axis = { x: Math.sin(HOME_ORBIT.azimuth), z: Math.cos(HOME_ORBIT.azimuth) };
  const mirror = (p) => {
    const rx = p.x - HOME_ORBIT.target.x;
    const rz = p.z - HOME_ORBIT.target.z;
    const along = rx * axis.x + rz * axis.z;
    return { x: HOME_ORBIT.target.x + 2 * along * axis.x - rx, z: HOME_ORBIT.target.z + 2 * along * axis.z - rz };
  };
  close(mirror(nl).x, nr.x, 1e-6);
  close(mirror(nl).z, nr.z, 1e-6);
  close(mirror(fl).x, fr.x, 1e-6);
  close(mirror(fl).z, fr.z, 1e-6);
});

test('U26 panning by a delta moves every footprint point by the same delta (minimap stays in sync)', () => {
  const before = groundFootprint(HOME_ORBIT, 16 / 9, FOV);
  const after = groundFootprint({ ...HOME_ORBIT, target: { x: HOME_ORBIT.target.x + 4, z: HOME_ORBIT.target.z - 7 } }, 16 / 9, FOV);
  after.forEach((p, i) => {
    close(p.x - before[i].x, 4, 1e-9);
    close(p.z - before[i].z, -7, 1e-9);
  });
});

test('U27 zooming in shrinks the footprint and zooming out grows it', () => {
  const home = area(groundFootprint(HOME_ORBIT, 16 / 9, FOV));
  assert.ok(area(groundFootprint({ ...HOME_ORBIT, distance: MIN_DISTANCE + 10 }, 16 / 9, FOV)) < home);
  assert.ok(area(groundFootprint({ ...HOME_ORBIT, distance: MAX_DISTANCE }, 16 / 9, FOV)) > home);
});

test('U28 rotating the azimuth by 90 degrees rotates the footprint by 90 degrees about the target', () => {
  const before = groundFootprint(HOME_ORBIT, 16 / 9, FOV);
  const after = groundFootprint({ ...HOME_ORBIT, azimuth: HOME_ORBIT.azimuth + Math.PI / 2 }, 16 / 9, FOV);
  const { x: tx, z: tz } = HOME_ORBIT.target;
  after.forEach((p, i) => {
    const rx = before[i].x - tx;
    const rz = before[i].z - tz;
    // Positive azimuth turns +z toward +x: (x, z) -> (z, -x).
    close(p.x - tx, rz, 1e-6);
    close(p.z - tz, -rx, 1e-6);
  });
});

test('U29 at the lowest tilt the far edge reaching the horizon is capped to a finite point', () => {
  const points = groundFootprint({ ...HOME_ORBIT, elevation: MIN_ELEVATION, distance: MAX_DISTANCE }, 16 / 9, FOV);
  for (const p of points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), JSON.stringify(p));
  const beyond = groundFootprint({ ...HOME_ORBIT, elevation: MIN_ELEVATION / 4 }, 16 / 9, FOV);
  for (const p of beyond) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
});

test('U30 one dot per Project at its yard with its status colour; Home at City Center; off-map Projects at the edge', () => {
  const projects = [
    { id: 'a', name: 'Alpha', position: [3.6 + 0.78, 0.78], status: 'idle' },
    { id: 'b', name: 'Beta', position: [40, -40], status: 'developing' },
  ];
  const dots = minimapDots(projects, (p) => (p.status === 'idle' ? '#111' : '#222'));
  assert.equal(dots.length, 2);
  const [wx, wz] = worldOfPlot(projects[0].position);
  assert.deepEqual(dots[0], { id: 'a', name: 'Alpha', color: '#111', ...worldToMinimap({ x: wx, z: wz }, MINIMAP_VIEWBOX) });
  assert.deepEqual({ x: dots[1].x, y: dots[1].y }, { x: MINIMAP_VIEWBOX, y: 0 });
  assert.equal(dots[1].color, '#222');
  const [hx, hz] = worldOfPlot(CITY_POSITION);
  assert.deepEqual(HOME_MARKER, worldToMinimap({ x: hx, z: hz }, MINIMAP_VIEWBOX));
  assert.deepEqual(minimapDots([], () => '#000'), []);
});

test('U31 arrow keys pan the target 5 units north-up, other keys do nothing, and the edge holds', () => {
  assert.equal(KEY_PAN_STEP, 5);
  const t = { x: 1, z: 1 };
  assert.deepEqual(keyPan('ArrowUp', t), { x: 1, z: -4 });
  assert.deepEqual(keyPan('ArrowDown', t), { x: 1, z: 6 });
  assert.deepEqual(keyPan('ArrowLeft', t), { x: -4, z: 1 });
  assert.deepEqual(keyPan('ArrowRight', t), { x: 6, z: 1 });
  assert.equal(keyPan('a', t), null);
  assert.equal(keyPan('Enter', t), null);
  assert.deepEqual(keyPan('ArrowRight', { x: MAP_HALF - 1, z: 0 }), { x: MAP_HALF, z: 0 });
});

/** Plays a press through the helpers like the card does; returns the actions it would send. */
function playPress(points, { button = 0, disabled = false, cancelled = false } = {}) {
  const actions = [];
  let press = pressStart(points[0], button, disabled);
  for (const at of points.slice(1)) {
    const next = pressMove(press, at, disabled);
    press = next.press;
    if (next.action) actions.push(next.action);
  }
  const end = pressEnd(press, disabled, cancelled);
  if (end) actions.push(end);
  return actions;
}

test('U24b a press that stays under 3px flies on release, and never follows', () => {
  assert.deepEqual(playPress([{ x: 10, y: 10 }]), ['fly']);
  assert.deepEqual(playPress([{ x: 10, y: 10 }, { x: 11, y: 11 }, { x: 12, y: 10 }]), ['fly']);
});

test('U24c a press that moves 3px or more follows on every move from then on and does not fly on release', () => {
  assert.deepEqual(playPress([{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 13, y: 10 }, { x: 12, y: 10 }, { x: 40, y: 40 }]), ['follow', 'follow', 'follow']);
});

test('U24d a non-primary button, a disabled minimap and a cancelled press do nothing', () => {
  assert.equal(pressStart({ x: 0, y: 0 }, 2, false), null);
  assert.deepEqual(playPress([{ x: 0, y: 0 }, { x: 20, y: 0 }], { button: 2 }), []);
  assert.deepEqual(playPress([{ x: 0, y: 0 }, { x: 20, y: 0 }], { disabled: true }), []);
  assert.deepEqual(playPress([{ x: 0, y: 0 }], { cancelled: true }), []);
  // Disabled mid-press (a Project drag started): no more follows, no fly.
  const press = pressStart({ x: 0, y: 0 }, 0, false);
  assert.deepEqual(pressMove(press, { x: 20, y: 0 }, true), { press, action: null });
  assert.equal(pressEnd(press, true, false), null);
  assert.equal(pressEnd(null, false, false), null);
});

test('U31b an arrow key on the minimap is used (default prevented) only when enabled and the camera panned', () => {
  const pans = [];
  const pan = (key) => { pans.push(key); return key.startsWith('Arrow'); };
  assert.equal(minimapKey('ArrowUp', false, pan), true);
  assert.equal(minimapKey('Tab', false, pan), false);
  assert.equal(minimapKey('ArrowUp', true, pan), false);
  assert.deepEqual(pans, ['ArrowUp', 'Tab']);
});
