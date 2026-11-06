import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { skyLightPosition } from '../src/scene/skyLight.ts';
import { sampleCelestial } from '../src/scene/celestial.ts';

test('panoramic sun casts ground shadows away from its visible east/west side', () => {
  for (const hour of [1, 3, 6, 9, 12]) {
    const state = sampleCelestial(new Date(Date.UTC(2026, 8, 14, hour)));
    const source = skyLightPosition(state.sunScreen, state.sun.altitude, new THREE.Vector3());
    assert.ok(source.y > 0);
    const east = (source.x - source.z) / Math.SQRT2;
    const north = -(source.x + source.z) / Math.SQRT2;
    assert.ok(north > 0, 'visible sky is north of town, so shadows fall toward the viewer');
    assert.equal(Math.sign(east), Math.sign(state.sunScreen.x));
    const shadowEast = -east / source.y;
    assert.ok(shadowEast * state.sunScreen.x <= 0);
  }
});
test('higher sun produces shorter shadows instead of camera-dependent streaks', () => {
  const morning = skyLightPosition({x:0.7,y:0.3}, Math.PI/6, new THREE.Vector3());
  const noon = skyLightPosition({x:0,y:0.6}, Math.PI/3, new THREE.Vector3());
  const length = p => Math.hypot(p.x,p.z)/p.y;
  assert.ok(length(noon) < length(morning));
});
