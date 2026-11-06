import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleCelestial, sampleThemedCelestial, projectCelestial, celestialDirection, SKY_HORIZON } from '../src/scene/celestial.ts';

test('India sun rises on screen-right/east and sets screen-left/west', () => {
  const morning = sampleCelestial(new Date('2026-09-14T01:30:00Z'));
  const evening = sampleCelestial(new Date('2026-09-14T12:30:00Z'));
  assert.ok(morning.sunScreen.x > 0.5);
  assert.ok(evening.sunScreen.x < -0.5);
  const east = celestialDirection(-Math.PI/2, 0);
  assert.ok(east[0] > 0 && east[2] < 0);
  const north = celestialDirection(Math.PI, 0);
  assert.ok(north[0] < 0 && north[2] < 0);
});
test('all visible celestial centers remain above the panorama baseline', () => {
  for (let degrees = -180; degrees <= 180; degrees += 5) {
    for (let altitude = 0; altitude <= 90; altitude += 5) {
      const p = projectCelestial(degrees * Math.PI/180, altitude * Math.PI/180);
      assert.ok(p.y > SKY_HORIZON + 0.06 && p.y < 0.9);
      assert.ok(Math.abs(p.x) < 0.9);
    }
  }
});
test('moon follows lunar phase and rise/set, rather than an inverted daily sun arc', () => {
  const newMoon = sampleCelestial(new Date('2026-09-11T03:00:00Z'));
  const fullMoon = sampleCelestial(new Date('2026-09-26T18:30:00Z'));
  assert.ok(newMoon.illumination.fraction < 0.02);
  assert.ok(fullMoon.illumination.fraction > 0.97);
  assert.ok(fullMoon.moonLight > newMoon.moonLight);
  assert.ok(fullMoon.moonReflection > 0.5);
  let below = 0;
  for (let hour = 0; hour < 24; hour++) {
    const state = sampleCelestial(new Date(Date.UTC(2026, 8, 14, hour)));
    if (state.moon.altitude < 0) {
      below++;
      assert.equal(state.moonVisibility, 0);
      assert.equal(state.moonLight, 0);
      assert.equal(state.moonReflection, 0);
    }
    if (state.sun.altitude < -0.015) assert.equal(state.sunReflection, 0);
    assert.ok(state.moonScale > 0.9 && state.moonScale < 1.1);
  }
  assert.ok(below > 0);
});

test('forced themes select a stable day or a legible moonlit night', () => {
  const midday = sampleThemedCelestial(new Date('2026-09-14T18:30:00Z'), 'light');
  assert.ok(midday.sunVisibility > 0.99);
  assert.ok(midday.night < 0.01);

  const midnight = sampleThemedCelestial(new Date('2026-09-11T06:30:00Z'), 'dark');
  assert.equal(midnight.sunVisibility, 0);
  assert.equal(midnight.night, 1);
  assert.ok(midnight.moonLight >= 0.5, 'night fill must not disappear at new moon or moonset');
});
