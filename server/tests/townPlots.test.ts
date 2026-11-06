import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROJECT_PLOTS, migrateLegacyPlot, resolveProjectPlot, samePlot } from '../src/projects/townPlots.ts';
import { LEGACY_PLOTS, PROJECT_PLOTS as WEB_PLOTS, migrateLegacyPosition } from '../../web/src/scene/townLayout.ts';

test('S01 there are 240 distinct project plots, each resolves to itself, and the server table equals the web generator', () => {
  assert.equal(PROJECT_PLOTS.length, 240);
  for (const plot of PROJECT_PLOTS) assert.deepEqual(resolveProjectPlot(plot), plot);
  assert.equal(WEB_PLOTS.length, PROJECT_PLOTS.length);
  WEB_PLOTS.forEach((plot, index) => {
    const [x, z] = PROJECT_PLOTS[index] ?? [NaN, NaN];
    assert.ok(Math.abs(plot.x - x) < 0.001);
    assert.ok(Math.abs(plot.z - z) < 0.001);
  });
  for (let i = 0; i < PROJECT_PLOTS.length; i++) for (let j = i + 1; j < PROJECT_PLOTS.length; j++) assert.ok(!samePlot(PROJECT_PLOTS[i]!, PROJECT_PLOTS[j]!));
});

test('S03 malformed, non-finite and extreme positions resolve to null', () => {
  const [x, z] = PROJECT_PLOTS[0]!;
  for (const bad of [undefined, null, 'x', [], [x], [x, z, x], [String(x), String(z)], {}, [NaN, z], [Infinity, z], [null, z], [1e308, z], [-1e308, z], [Number.MAX_SAFE_INTEGER, z], [5e-324, 5e-324], [0, 0], [1, 1]]) {
    assert.equal(resolveProjectPlot(bad), null, JSON.stringify(bad));
  }
});

test('S02 positions within 0.001 of a plot snap to the exact plot, 0.002 away is rejected', () => {
  const first = PROJECT_PLOTS[0] ?? [NaN, NaN];
  const [x, z] = first;
  assert.deepEqual(resolveProjectPlot([x + 0.0005, z]), first);
  assert.equal(resolveProjectPlot([x + 0.002, z]), null);
});

test('S04 the server legacy remap equals the web remap for all 32 block-grid coordinates, never moves a street plot, and is idempotent', () => {
  assert.equal(LEGACY_PLOTS.length, 32);
  for (const legacy of LEGACY_PLOTS) {
    const server = migrateLegacyPlot([legacy.x, legacy.z]);
    const web = migrateLegacyPosition([legacy.x, legacy.z]);
    assert.ok(server && web);
    assert.deepEqual(server, web);
    assert.deepEqual(resolveProjectPlot(server), server);
    assert.equal(migrateLegacyPlot(server), null, 'already migrated');
  }
  assert.equal(new Set(LEGACY_PLOTS.map((p) => migrateLegacyPlot([p.x, p.z])!.join())).size, 32);
  for (const bad of [null, undefined, [1], [NaN, 0], [0, 0], ['0.78', '0.78']]) assert.equal(migrateLegacyPlot(bad), null);
});
