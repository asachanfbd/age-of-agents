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

const { CameraController } = await import('../src/scene/cameraController.ts');
const {
  HOME_ORBIT, HOME_FLIGHT_MS, MINIMAP_FLIGHT_MS, MAP_HALF, MAX_ELEVATION, orbitOfView, positionOfOrbit, sameOrbit, streetWalkElevation,
} = await import('../src/scene/cameraMath.ts');
const { ROTATE_RATE } = await import('../src/scene/cameraKeys.ts');
const { DEFAULT_VIEW } = await import('../src/scene/defaultView.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/** A stand-in for drei's MapControls: a target, a camera position, update() and start/change events. */
function fakeControls(position = DEFAULT_VIEW.position, target = DEFAULT_VIEW.target) {
  const vec = ([x, y, z]) => ({ x, y, z, set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; return this; } });
  const listeners = { start: new Set(), change: new Set() };
  const controls = {
    target: vec(target),
    /** Every write the controller makes, in order: a position change ('position') or a re-aim ('lookAt'). */
    log: [],
    object: {
      position: vec(position),
      lookAt(x, y, z) { controls.log.push(['lookAt', x, y, z]); },
    },
    updates: 0,
    update() { this.updates += 1; this.emit('change'); },
    addEventListener(type, fn) { listeners[type].add(fn); },
    removeEventListener(type, fn) { listeners[type].delete(fn); },
    emit(type) { for (const fn of listeners[type]) fn(); },
    listenerCount: () => listeners.start.size + listeners.change.size,
    orbit() { return orbitOfView([this.object.position.x, this.object.position.y, this.object.position.z], [this.target.x, this.target.y, this.target.z]); },
    /** The user moves the camera: write a new orbit, then emit change as OrbitControls does. */
    userMove(orbit) {
      this.emit('start');
      this.target.set(orbit.target.x, 0, orbit.target.z);
      this.object.position.set(...positionOfOrbit(orbit));
      this.emit('change');
    },
  };
  return controls;
}

function setup(position, target) {
  let now = 0;
  const camera = new CameraController(() => now);
  const controls = fakeControls(position, target);
  let invalidations = 0;
  const detach = camera.attach(controls, () => { invalidations += 1; });
  return {
    camera, controls, detach,
    advance(ms) { now += ms; camera.tick(); },
    get invalidations() { return invalidations; },
  };
}

/** A panned, zoomed and rotated view; the street-walk rule lowers its elevation once the controller sees it. */
const elsewhere = { target: { x: -9, z: 7 }, distance: 30, azimuth: -2.1, elevation: HOME_ORBIT.elevation };
const assertAtOrbit = (controls, orbit) => {
  const seen = controls.orbit();
  assert.ok(sameOrbit(seen, orbit), `${JSON.stringify(seen)} vs ${JSON.stringify(orbit)}`);
};

test('U16 Home from the Home view is a no-op that finishes at once', () => {
  const t = setup();
  t.camera.goHome();
  assert.equal(t.camera.flying, false);
  assert.equal(t.invalidations, 0);
});

test('U17 user input or a disabled camera stops a flight where it is, with no snap', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  t.camera.goHome();
  t.advance(HOME_FLIGHT_MS / 2);
  const stopped = t.controls.orbit();
  t.controls.emit('start');
  t.advance(HOME_FLIGHT_MS);
  assertAtOrbit(t.controls, stopped);

  t.camera.goHome();
  t.advance(100);
  const paused = t.controls.orbit();
  t.camera.setEnabled(false);
  t.advance(HOME_FLIGHT_MS);
  assertAtOrbit(t.controls, paused);
});

test('U18 Home and minimap moves are refused while the camera is paused for a Project drag', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  const settled = t.controls.orbit();
  t.camera.setEnabled(false);
  t.camera.goHome();
  t.camera.flyToPoint({ x: 4, z: 4 });
  t.camera.moveToPoint({ x: 4, z: 4 });
  t.camera.panByKey('ArrowUp');
  assert.equal(t.camera.flying, false);
  assertAtOrbit(t.controls, settled);
});

test('U23 a minimap click flies to the clicked target only, keeping zoom and rotation', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  const settled = t.controls.orbit();
  t.camera.flyToPoint({ x: 99, z: 3 });
  t.advance(MINIMAP_FLIGHT_MS);
  assertAtOrbit(t.controls, { ...settled, target: { x: MAP_HALF, z: 3 } });
});

test('I01 Home from a panned, zoomed and rotated view ends exactly at DEFAULT_VIEW, with updates only while flying', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  t.camera.goHome();
  const updatesBefore = t.controls.updates;
  for (let i = 0; i < 7; i += 1) t.advance(HOME_FLIGHT_MS / 7);
  assert.equal(t.camera.flying, false);
  const { x, y, z } = t.controls.object.position;
  [x, y, z].forEach((v, i) => close(v, DEFAULT_VIEW.position[i]));
  close(t.controls.target.x, DEFAULT_VIEW.target[0]);
  close(t.controls.target.z, DEFAULT_VIEW.target[2]);
  assert.equal(t.controls.updates - updatesBefore, 7, 'update() once per tick');
  const done = { updates: t.controls.updates, invalidations: t.invalidations };
  for (let i = 0; i < 5; i += 1) t.advance(16);
  assert.deepEqual({ updates: t.controls.updates, invalidations: t.invalidations }, done, 'nothing after the flight ends');
});

test('I02 a controls start event mid-flight cancels it', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  t.camera.goHome();
  t.advance(200);
  t.controls.emit('start');
  const at = t.controls.orbit();
  t.advance(200);
  t.advance(1000);
  assertAtOrbit(t.controls, at);
  assert.equal(t.camera.flying, false);
});

test('I03 a Project drag starting between two ticks cancels the flight and pauses Home and the minimap until drop', () => {
  useWorldStore.setState({ controlsEnabled: true });
  const t = setup();
  const unfollow = t.camera.followControlsEnabled(useWorldStore);
  t.controls.userMove(elsewhere);
  t.camera.goHome();
  t.advance(100);
  useWorldStore.getState().setControlsEnabled(false);
  assert.equal(t.camera.getSnapshot().enabled, false);
  const at = t.controls.orbit();
  t.advance(100);
  useWorldStore.getState().setControlsEnabled(true);
  t.advance(HOME_FLIGHT_MS);
  assertAtOrbit(t.controls, at);
  assert.equal(t.camera.getSnapshot().enabled, true);
  assert.equal(t.camera.flying, false, 're-enabling does not resume');
  unfollow();
});

test('I04 a minimap click flies to the clicked point, clamped, keeping zoom and rotation', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  const settled = t.controls.orbit();
  t.camera.flyToPoint({ x: 5, z: -200 });
  t.advance(MINIMAP_FLIGHT_MS / 2);
  assert.equal(t.camera.flying, true);
  t.advance(MINIMAP_FLIGHT_MS / 2);
  assertAtOrbit(t.controls, { ...settled, target: { x: 5, z: -MAP_HALF } });
});

test('I05 a minimap drag moves the target with each move and no flight', () => {
  const t = setup();
  for (const [x, z] of [[1, 1], [2, 3], [4, 5]]) {
    const updates = t.controls.updates;
    const invalidations = t.invalidations;
    t.camera.moveToPoint({ x, z });
    assert.equal(t.camera.flying, false);
    assert.deepEqual([t.controls.target.x, t.controls.target.z], [x, z]);
    assert.equal(t.controls.updates, updates + 1);
    assert.equal(t.invalidations, invalidations + 1);
  }
  assert.equal(t.camera.panByKey('ArrowUp'), true);
  assert.deepEqual([t.controls.target.x, t.controls.target.z], [4, 0]);
  assert.equal(t.camera.panByKey('x'), false);
});

test('I06 every controls change republishes the camera orbit for the minimap', () => {
  const t = setup();
  let notified = 0;
  const unsubscribe = t.camera.subscribe(() => { notified += 1; });
  const moved = { ...HOME_ORBIT, target: { x: -3, z: 6 } };
  t.controls.userMove(moved);
  assert.equal(notified, 1);
  assert.ok(sameOrbit(t.camera.getSnapshot().orbit, moved));
  assert.ok(sameOrbit(t.camera.getSnapshot().orbit, t.controls.orbit()));
  unsubscribe();
});

test('I07 a pan past the map edge moves target and camera back by the same delta, keeping the tilt', () => {
  const t = setup();
  const before = t.controls.orbit();
  t.controls.userMove({ ...before, target: { x: MAP_HALF + 6, z: -MAP_HALF - 2 } });
  const after = t.controls.orbit();
  close(after.target.x, MAP_HALF);
  close(after.target.z, -MAP_HALF);
  close(after.elevation, before.elevation);
  close(after.distance, before.distance);
  close(after.azimuth, before.azimuth);
  close(t.controls.object.position.x - t.controls.target.x, DEFAULT_VIEW.position[0] - DEFAULT_VIEW.target[0]);
});

test('I07b zooming in lowers the camera toward street level and keeps the user tilt', () => {
  const t = setup();
  const seen = t.controls.orbit();
  t.controls.userMove({ ...seen, distance: 20 });
  close(t.controls.orbit().elevation, streetWalkElevation(20));
  assert.ok(t.controls.orbit().elevation < HOME_ORBIT.elevation);
  t.controls.userMove({ ...t.controls.orbit(), distance: 1 });
  close(t.controls.orbit().distance, 8);
});

test('I08 camera changes notify no world store subscribers', () => {
  let storeNotifications = 0;
  const unsubscribe = useWorldStore.subscribe(() => { storeNotifications += 1; });
  const t = setup();
  t.controls.userMove(elsewhere);
  t.camera.goHome();
  for (let i = 0; i < 10; i += 1) t.advance(100);
  t.camera.moveToPoint({ x: 1, z: 2 });
  assert.equal(storeNotifications, 0);
  unsubscribe();
});

test('I09 an idle camera asks for no frames', () => {
  const t = setup();
  for (let i = 0; i < 50; i += 1) t.advance(16);
  assert.equal(t.invalidations, 0);
});

test('I10 a Project drag mid-flight cancels it and Home and minimap input is ignored until drop', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  t.camera.flyToPoint({ x: 0, z: 0 });
  t.advance(100);
  t.camera.setEnabled(false);
  const at = t.controls.orbit();
  t.camera.goHome();
  t.camera.moveToPoint({ x: 10, z: 10 });
  t.advance(1000);
  assertAtOrbit(t.controls, at);
  t.camera.setEnabled(true);
  t.camera.goHome();
  assert.equal(t.camera.flying, true);
});

test('I11 pressing Home again mid-flight restarts from where the camera is, with no jump', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  t.camera.goHome();
  t.advance(300);
  const mid = t.controls.orbit();
  t.camera.goHome();
  t.advance(0);
  assertAtOrbit(t.controls, mid);
  t.advance(HOME_FLIGHT_MS);
  assertAtOrbit(t.controls, HOME_ORBIT);
});

test('I12 a minimap click during a Home flight replaces it and ends at the clicked target', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  t.camera.goHome();
  t.advance(300);
  const mid = t.controls.orbit();
  t.camera.flyToPoint({ x: -12, z: 12 });
  t.advance(MINIMAP_FLIGHT_MS);
  assertAtOrbit(t.controls, { ...mid, target: { x: -12, z: 12 } });
});

test('detaching removes the listeners and stops the controller moving the camera', () => {
  const t = setup();
  t.detach();
  assert.equal(t.controls.listenerCount(), 0);
  t.camera.moveToPoint({ x: 3, z: 3 });
  t.camera.goHome();
  assert.equal(t.camera.flying, false);
  t.camera.setAspect(4 / 3);
  t.camera.setAspect(-1);
  t.camera.setAspect(Infinity);
  assert.equal(t.camera.getSnapshot().aspect, 4 / 3);
});

test('I13 after a clamp or street-walk write the camera is re-aimed at the target, not left on the old orientation', () => {
  const t = setup();
  const set = t.controls.object.position.set;
  t.controls.object.position.set = function (...args) { t.controls.log.push(['position']); return set.apply(this, args); };

  const updates = t.controls.updates;
  // A pan past the edge: the clamp moves target and camera, then re-aims.
  t.controls.userMove({ ...HOME_ORBIT, target: { x: MAP_HALF + 5, z: 0 } });
  const clamped = t.controls.log.slice(1);
  assert.deepEqual(clamped.map((entry) => entry[0]), ['position', 'lookAt']);
  assert.deepEqual(clamped[1].slice(1), [t.controls.target.x, t.controls.target.y, t.controls.target.z]);
  close(t.controls.target.x, MAP_HALF);

  // A zoom: the street-walk elevation moves the camera, then re-aims.
  t.controls.log.length = 0;
  t.controls.userMove({ ...t.controls.orbit(), distance: 20 });
  assert.deepEqual(t.controls.log.slice(1).map((entry) => entry[0]), ['position', 'lookAt']);

  // A plain pan inside the map changes nothing, so there is nothing to re-aim.
  t.controls.log.length = 0;
  t.controls.userMove({ ...t.controls.orbit(), target: { x: 1, z: 1 } });
  assert.deepEqual(t.controls.log.map((entry) => entry[0]), ['position']);
  assert.equal(t.controls.updates, updates, 'no update() from inside a change');
});

function fakeWindow() {
  const handlers = {};
  return {
    addEventListener(type, fn) { handlers[type] = fn; },
    removeEventListener(type) { delete handlers[type]; },
    emit(type, event) { handlers[type]?.(event); },
  };
}

const keyEvent = (key, overrides = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, target: null, ...overrides });

test('I1/I2/I3 a held A turns the camera each frame and stops on release', () => {
  const t = setup();
  const before = t.controls.orbit().azimuth;
  assert.equal(t.camera.pressKey(keyEvent('a')), true);
  const requested = t.invalidations;
  t.advance(50);
  const turned = t.controls.orbit();
  close(turned.azimuth - before, -ROTATE_RATE * 0.05, 1e-6);
  assert.ok(sameOrbit(t.camera.getSnapshot().orbit, turned));
  assert.ok(t.invalidations > requested);
  t.camera.releaseKey('a');
  const frames = t.invalidations;
  t.advance(50);
  assert.equal(t.invalidations, frames);
  close(t.controls.orbit().azimuth, turned.azimuth);
});

test('I5/I24 auto-repeat does not double speed and 60 frames match one second', () => {
  const t = setup();
  const before = t.controls.orbit().azimuth;
  t.camera.pressKey(keyEvent('d'));
  for (let i = 0; i < 6; i += 1) {
    t.camera.pressKey(keyEvent('d'));
    t.advance(1000 / 60);
  }
  close(t.controls.orbit().azimuth - before, ROTATE_RATE * 0.1, 1e-6);
});

test('I6 modifiers, other keys and typing targets are not handled', () => {
  const t = setup();
  assert.equal(t.camera.pressKey(keyEvent('a', { ctrlKey: true })), false);
  assert.equal(t.camera.pressKey(keyEvent('q')), false);
  assert.equal(t.camera.pressKey(keyEvent('a', { target: { tagName: 'INPUT' } })), false);
});

test('I7/I8 a disabled camera or covered scene ignores keys and releases held ones', () => {
  for (const stop of [(c) => c.setEnabled(false), (c) => c.setCovered(true)]) {
    const t = setup();
    t.camera.pressKey(keyEvent('a'));
    stop(t.camera);
    const frames = t.invalidations;
    t.advance(50);
    assert.equal(t.invalidations, frames);
    assert.equal(t.camera.pressKey(keyEvent('a')), false);
  }
});

test('I9/I10 a key cancels a flight; Home pressed while a key is held wins', () => {
  const t = setup();
  t.controls.userMove(elsewhere);
  t.camera.goHome();
  t.advance(100);
  t.camera.pressKey(keyEvent('a'));
  assert.equal(t.camera.flying, false);
  t.camera.goHome();
  t.advance(HOME_FLIGHT_MS);
  assertAtOrbit(t.controls, HOME_ORBIT);
});

test('I12/I13/I14 a backwards clock moves nothing; detach and blur release keys; no controls is safe', () => {
  const t = setup();
  t.camera.pressKey(keyEvent('a'));
  t.advance(-10);
  const orbit = t.controls.orbit();
  close(orbit.azimuth, HOME_ORBIT.azimuth);
  t.detach();
  t.advance(50);
  assert.equal(t.camera.pressKey(keyEvent('a')), false);

  const u = setup();
  const win = fakeWindow();
  const unbind = u.camera.bindKeyboard(win);
  u.camera.pressKey(keyEvent('d'));
  win.emit('blur', {});
  const frames = u.invalidations;
  u.advance(50);
  assert.equal(u.invalidations, frames);
  unbind();
});

test('I6 bindKeyboard prevents the default only for used keys', () => {
  const t = setup();
  const win = fakeWindow();
  t.camera.bindKeyboard(win);
  const fire = (type, key) => {
    const e = { ...keyEvent(key), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    win.emit(type, e);
    return e.defaultPrevented;
  };
  assert.equal(fire('keydown', 'w'), true);
  assert.equal(fire('keydown', 'Tab'), false);
  fire('keyup', 'w');
  const frames = t.invalidations;
  t.advance(50);
  assert.equal(t.invalidations, frames);
});

test('I16/I17/I18/I19/I22 rotation composes with Home, minimap flights, zoom and the clamp', () => {
  const t = setup();
  t.camera.pressKey(keyEvent('w'));
  for (let i = 0; i < 30; i += 1) t.advance(50);
  close(t.controls.orbit().elevation, MAX_ELEVATION, 1e-6);
  t.camera.releaseKey('w');
  const rotated = t.controls.orbit();
  t.camera.flyToPoint({ x: 3, z: 4 });
  t.advance(MINIMAP_FLIGHT_MS);
  close(t.controls.orbit().azimuth, rotated.azimuth, 1e-6);
  close(t.controls.orbit().elevation, MAX_ELEVATION, 1e-6);
  t.camera.goHome();
  t.advance(HOME_FLIGHT_MS);
  assertAtOrbit(t.controls, HOME_ORBIT);
});

test('I20/I21 arrow panning is unchanged and works while a rotation key is held', () => {
  const t = setup();
  assert.equal(t.camera.panByKey('w'), false);
  t.camera.pressKey(keyEvent('a'));
  assert.equal(t.camera.panByKey('ArrowUp'), true);
  t.advance(50);
  assert.ok(t.controls.orbit().azimuth < HOME_ORBIT.azimuth);
});

test('I25 the real world store stops a rotation when controls are disabled', () => {
  const t = setup();
  const stop = t.camera.followControlsEnabled(useWorldStore);
  t.camera.pressKey(keyEvent('a'));
  useWorldStore.getState().setControlsEnabled(false);
  const frames = t.invalidations;
  t.advance(50);
  assert.equal(t.invalidations, frames);
  useWorldStore.getState().setControlsEnabled(true);
  stop();
});
