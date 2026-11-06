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

const { ROTATE_RATE, MAX_ROTATE_DT, rotationKey, rotationOfKeys, rotateOrbit, isTypingTarget, isCameraKeyIgnored } = await import('../src/scene/cameraKeys.ts');
const { HOME_ORBIT, MIN_ELEVATION, MAX_ELEVATION, elevationAfterZoom, positionOfOrbit, orbitOfView, sameOrbit } = await import('../src/scene/cameraMath.ts');
const { keyPan } = await import('../src/scene/minimapMath.ts');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const turn = (keys, dt, orbit = HOME_ORBIT) => rotateOrbit(orbit, rotationOfKeys(keys), dt);

test('U1 a/d/w/s map to azimuth and elevation directions', () => {
  assert.deepEqual(rotationOfKeys(['a']), { azimuth: -1, elevation: 0 });
  assert.deepEqual(rotationOfKeys(['d']), { azimuth: 1, elevation: 0 });
  assert.deepEqual(rotationOfKeys(['w']), { azimuth: 0, elevation: 1 });
  assert.deepEqual(rotationOfKeys(['s']), { azimuth: 0, elevation: -1 });
});

test('U2 uppercase letters map like lowercase', () => {
  for (const key of ['A', 'D', 'W', 'S']) assert.equal(rotationKey(key), key.toLowerCase());
});

test('U3 other keys are not rotation keys', () => {
  for (const key of ['ArrowUp', 'q', '', 'Enter', ' ']) assert.equal(rotationKey(key), null);
});

test('U4/U5 opposite keys move by equal amounts in opposite directions', () => {
  const left = turn(['a'], 0.05).azimuth - HOME_ORBIT.azimuth;
  const right = turn(['d'], 0.05).azimuth - HOME_ORBIT.azimuth;
  close(left, -right);
  assert.ok(right > 0);
  const up = turn(['w'], 0.05).elevation - HOME_ORBIT.elevation;
  const down = turn(['s'], 0.05).elevation - HOME_ORBIT.elevation;
  close(up, -down);
  assert.ok(up > 0);
});

test('U6/U7 the step is linear in dt and a full second turns by the rate', () => {
  const small = turn(['d'], 1 / 60).azimuth - HOME_ORBIT.azimuth;
  const double = turn(['d'], 1 / 30).azimuth - HOME_ORBIT.azimuth;
  close(double, 2 * small);
  const second = rotateOrbit(HOME_ORBIT, { azimuth: 1, elevation: 0 }, MAX_ROTATE_DT).azimuth - HOME_ORBIT.azimuth;
  close(second, ROTATE_RATE * MAX_ROTATE_DT);
  assert.ok(ROTATE_RATE >= (60 * Math.PI) / 180 && ROTATE_RATE <= (90 * Math.PI) / 180);
});

test('U8/U9 dt of zero, negative, NaN or Infinity changes nothing', () => {
  for (const dt of [0, -1, NaN, Infinity]) assert.equal(turn(['d', 'w'], dt), HOME_ORBIT);
});

test('U10 a stalled frame is capped', () => {
  close(turn(['d'], 5).azimuth, turn(['d'], MAX_ROTATE_DT).azimuth);
});

test('U11/U12 tilt stops at the elevation limits', () => {
  const top = { ...HOME_ORBIT, elevation: MAX_ELEVATION - 0.001 };
  assert.equal(turn(['w'], 0.1, top).elevation, MAX_ELEVATION);
  const bottom = { ...HOME_ORBIT, elevation: MIN_ELEVATION + 0.001 };
  assert.equal(turn(['s'], 0.1, bottom).elevation, MIN_ELEVATION);
  assert.equal(turn(['w'], 0.1, { ...top, elevation: MAX_ELEVATION }).elevation, MAX_ELEVATION);
});

test('U13 a NaN elevation falls back to Home', () => {
  assert.equal(turn(['w'], 0.05, { ...HOME_ORBIT, elevation: NaN }).elevation, HOME_ORBIT.elevation);
});

test('U14 azimuth stays in (-π, π] across the wrap and many turns', () => {
  let orbit = { ...HOME_ORBIT, azimuth: Math.PI - 0.01 };
  for (let i = 0; i < 600; i += 1) {
    orbit = turn(['d'], 1 / 60, orbit);
    assert.ok(orbit.azimuth > -Math.PI && orbit.azimuth <= Math.PI);
  }
  close(orbit.azimuth, ((Math.PI - 0.01 + ROTATE_RATE * 10 + Math.PI) % (2 * Math.PI)) - Math.PI, 1e-6);
});

test('U15/U16 opposite keys cancel and different axes combine', () => {
  assert.deepEqual(rotationOfKeys(['a', 'd']), { azimuth: 0, elevation: 0 });
  assert.deepEqual(rotationOfKeys(['w', 's']), { azimuth: 0, elevation: 0 });
  assert.deepEqual(rotationOfKeys(['a', 'w']), { azimuth: -1, elevation: 1 });
});

test('U17/U18 rotation keeps target and distance, and the orbit round-trips through a position', () => {
  const rotated = turn(['a', 'w'], 0.05);
  assert.deepEqual(rotated.target, HOME_ORBIT.target);
  assert.equal(rotated.distance, HOME_ORBIT.distance);
  const target = [rotated.target.x, 0, rotated.target.z];
  assert.ok(sameOrbit(orbitOfView(positionOfOrbit(rotated), target), rotated));
});

const event = (overrides = {}) => ({ key: 'a', ctrlKey: false, metaKey: false, altKey: false, target: null, ...overrides });

test('U19/U20 Ctrl, Meta and Alt ignore the key; Shift alone does not', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(isCameraKeyIgnored(event({ [modifier]: true })), true);
  assert.equal(isCameraKeyIgnored(event({ shiftKey: true })), false);
});

test('U21 input, textarea and select targets are typing targets', () => {
  for (const tagName of ['INPUT', 'textarea', 'SELECT']) assert.equal(isTypingTarget({ tagName }), true);
});

const within = (selectors) => ({ tagName: 'DIV', closest: (selector) => (selectors.some((s) => selector.includes(s)) ? {} : null) });

test('U22/U23 contenteditable and terminal descendants are typing targets', () => {
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget(within(['[contenteditable]'])), true);
  assert.equal(isTypingTarget(within(['[data-task-terminal]'])), true);
  assert.equal(isTypingTarget(within([])), false);
});

test('U24/U25 plain elements, null and bare event targets are not typing targets', () => {
  for (const tagName of ['BODY', 'CANVAS', 'BUTTON', 'DIV']) assert.equal(isTypingTarget({ tagName, closest: () => null }), false);
  for (const target of [null, {}, { tagName: undefined }]) assert.equal(isTypingTarget(target), false);
});

test('U26 a key during IME composition is ignored', () => {
  assert.equal(isCameraKeyIgnored(event({ isComposing: true })), true);
});

test('U27 keyPan still pans on arrows and ignores W/A/S/D', () => {
  assert.ok(keyPan('ArrowUp', { x: 0, z: 0 }));
  for (const key of ['w', 'a', 's', 'd']) assert.equal(keyPan(key, { x: 0, z: 0 }), null);
});

test('U28 a tilt is kept through a zoom', () => {
  const tilted = turn(['w'], 0.1);
  const zoomed = elevationAfterZoom(tilted.elevation, HOME_ORBIT.distance, HOME_ORBIT.distance);
  close(zoomed, tilted.elevation);
});
