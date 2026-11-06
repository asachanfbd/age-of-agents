import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';

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
const { DEFAULT_VIEW } = await import('../src/scene/defaultView.ts');

const fakeDom = () => ({ style: {}, addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {}, getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }), ownerDocument: { addEventListener() {}, removeEventListener() {} } });

function setup() {
  let now = 0;
  const camera = new PerspectiveCamera(DEFAULT_VIEW.fov, 16 / 9, 0.1, 2000);
  camera.position.set(...DEFAULT_VIEW.position);
  const controls = new MapControls(camera, fakeDom());
  controls.target.set(...DEFAULT_VIEW.target);
  controls.enableDamping = true;
  controls.update();
  const controller = new CameraController(() => now);
  controller.attach(controls, () => {});
  const direction = () => camera.getWorldDirection(new Vector3());
  return { camera, controller, direction, advance: (ms) => { now += ms; } };
}

for (const [key, what] of [['a', 'azimuth'], ['d', 'azimuth'], ['w', 'tilt'], ['s', 'tilt']]) {
  test(`holding ${key} moves a real camera (${what})`, () => {
    const { camera, controller, direction, advance } = setup();
    const before = { position: camera.position.clone(), direction: direction() };
    assert.equal(controller.pressKey({ key }), true);
    advance(200);
    controller.tick();
    assert.ok(camera.position.distanceTo(before.position) > 0.1, 'position changed');
    assert.ok(direction().distanceTo(before.direction) > 0.01, 'view direction changed');
  });
}

test('a real camera keeps its new view on later controls updates', () => {
  const { camera, controller, advance } = setup();
  controller.pressKey({ key: 'd' });
  advance(200);
  controller.tick();
  const moved = camera.position.clone();
  controller.releaseKey('d');
  controller.tick();
  assert.ok(camera.position.distanceTo(moved) < 1e-6);
});

test('Scene attaches the controls drei currently holds, not the first instance', async () => {
  const { readFile } = await import('node:fs/promises');
  const scene = await readFile(new URL('../src/scene/Scene.tsx', import.meta.url), 'utf8');
  assert.match(scene, /useThree\(\(s\) => s\.controls\)/);
  assert.match(scene, /villageCamera\.attach\(controls, invalidate\)[\s\S]*?\[controls, invalidate\]/);
  assert.doesNotMatch(scene, /controlsRef/);
});
