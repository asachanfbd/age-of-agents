import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Pure checks on the village's static scenery (scene/scenery.ts), plus source-wiring checks for the
// components that draw it: there is no DOM or WebGL harness here, so what the terrain looks like is
// a manual browser check.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const scenery = await import('../src/scene/scenery.ts');
const layout = await import('../src/scene/townLayout.ts');
const { yardWorldRect, rectsOverlap, growRect, inRect } = await import('../src/lib/villageLayout.ts');
const { BUILDING_STATUS_STYLES } = await import('../src/lib/buildingVisualStatus.ts');
const { TREES, ROCKS, FENCES, GATE_PATHS, ROADS, STREET_ROADS, CROSS_ROAD, LAMPS, PONDS, isBuiltOn } = scenery;
const { PROJECT_PLOTS, WORLD_BOUND, SCENERY_BOUND } = layout;

const yards = PROJECT_PLOTS.map((plot) => yardWorldRect([plot.x, plot.z]));
const inBounds = (x, z) => Math.abs(x) < WORLD_BOUND && Math.abs(z) < WORLD_BOUND;

test('U37 the same seed gives the same trees and rocks, however often the module is evaluated', async () => {
  const again = await import('../src/scene/scenery.ts?again');
  assert.deepEqual(again.TREES, TREES);
  assert.deepEqual(again.ROCKS, ROCKS);
  assert.deepEqual(again.FENCES, FENCES);
  assert.ok(TREES.length > 100 && ROCKS.length > 30, 'there is something to see');
});

test('U38 no tree or rock lands on a road, in a yard, on City Center or in water, and all are inside the world', () => {
  for (const prop of [...TREES, ...ROCKS]) {
    assert.ok(inBounds(prop.x, prop.z), 'in bounds');
    assert.ok(Math.abs(prop.x) <= SCENERY_BOUND && Math.abs(prop.z) <= SCENERY_BOUND, 'on solid ground, inside the scenery bound');
    assert.ok(!isBuiltOn(prop.x, prop.z));
    assert.ok(!ROADS.some((road) => inRect(prop, [road[0], road[1], road[2], road[3]]) || (prop.x > road[0] && prop.x < road[2] && prop.z > road[1] && prop.z < road[3])), 'not on a road');
    assert.ok(!yards.some(([x0, z0, x1, z1]) => prop.x > x0 && prop.x < x1 && prop.z > z0 && prop.z < z1), 'not in a yard');
    assert.ok(!PONDS.some((pond) => Math.hypot(prop.x - pond.x, prop.z - pond.z) < pond.radius), 'not in water');
  }
});

test('U39 fences surround every yard and leave a gate gap on the street side', () => {
  assert.equal(FENCES.length, PROJECT_PLOTS.length * 5);
  PROJECT_PLOTS.forEach((plot, i) => {
    const [x0, z0, x1, z1] = yards[i];
    const mine = FENCES.slice(i * 5, i * 5 + 5);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const toward = layout.sideOfPlot([plot.x, plot.z]) === 'left' ? 1 : -1;
    const gateX = toward === 1 ? x1 : x0;
    const gateSegments = mine.filter((fence) => !fence.alongX && Math.abs(fence.x - gateX) < 0.2);
    assert.equal(gateSegments.length, 2, 'two pieces beside the gate');
    assert.ok(gateSegments.every((fence) => Math.abs(fence.z - cz) > 0.6), 'no fence in the gate gap');
    assert.equal(mine.filter((fence) => fence.alongX).length, 2);
    for (const fence of mine) assert.ok(fence.x >= x0 - 0.2 && fence.x <= x1 + 0.2 && fence.z >= z0 - 0.2 && fence.z <= z1 + 0.2, 'around the yard');
    assert.ok(Math.abs(cx - plot.x * layout.TOWN_SCALE) < 1e-6);
  });
});

test('U40 every plot has a gate path joining its street; roads have the right width', () => {
  assert.equal(GATE_PATHS.length, PROJECT_PLOTS.length);
  PROJECT_PLOTS.forEach((plot, i) => {
    const street = layout.refOfFlatIndex(i).street;
    const road = STREET_ROADS[street - 1];
    const path = GATE_PATHS[i];
    assert.ok(Math.abs(path[1] + path[3] - 2 * plot.z * layout.TOWN_SCALE) < 1e-6, 'level with its plot');
    const touchesRoad = path[0] <= road[2] + 1e-6 && path[2] >= road[0] - 1e-6;
    assert.ok(touchesRoad, `gate path ${i} reaches street ${street}`);
  });
  for (const road of STREET_ROADS) assert.ok(Math.abs(road[2] - road[0] - layout.ROAD_WIDTH) < 1e-9);
  assert.ok(Math.abs(CROSS_ROAD[3] - CROSS_ROAD[1] - layout.ROAD_WIDTH) < 1e-9);
  assert.equal(STREET_ROADS.length, 12);
  assert.ok(LAMPS.length > 0 && LAMPS.every((lamp) => inBounds(lamp.x, lamp.z)));
  assert.ok(LAMPS.every((lamp) => !yards.some(([x0, z0, x1, z1]) => lamp.x > x0 && lamp.x < x1 && lamp.z > z0 && lamp.z < z1)), 'no lamp in a yard');
});

test('U41 water is fixed, inside the world, and overlaps no plot or road', () => {
  assert.equal(PONDS.length, 3);
  for (const pond of PONDS) {
    assert.ok(inBounds(pond.x + pond.radius, pond.z + pond.radius) && inBounds(pond.x - pond.radius, pond.z - pond.radius));
    assert.ok(Math.max(Math.abs(pond.x), Math.abs(pond.z)) + pond.radius + 0.5 <= SCENERY_BOUND, 'water and its foam ring sit inside the scenery bound');
    const box = [pond.x - pond.radius, pond.z - pond.radius, pond.x + pond.radius, pond.z + pond.radius];
    for (const rect of [...yards, ...ROADS]) assert.ok(!rectsOverlap(growRect(box, 0.5), rect));
  }
});

test('U42 the hills are gone: no landscape mesh, height function or hill constants remain in the source', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url), { recursive: true, withFileTypes: true })).filter((e) => e.isFile() && /\.tsx?$/.test(e.name));
  for (const file of files) {
    const source = await readFile(`${file.parentPath ?? file.path}/${file.name}`, 'utf8');
    assert.doesNotMatch(source, /makeLandscape|LANDSCAPE_SCALE|heightAt\(|BLOCK_CENTERS|ROAD_LINES|TOWN_HALF|domeWorldPoint|\bDOME\b|<Dome\b/, file.name);
  }
});

test('U43/U44 scenery is a bounded instance count, built once and quickly', async () => {
  const total = TREES.length + ROCKS.length + FENCES.length + GATE_PATHS.length + ROADS.length + LAMPS.length;
  assert.ok(total < 6000, `instances ${total}`);
  const started = performance.now();
  await import('../src/scene/scenery.ts?timed');
  assert.ok(performance.now() - started < 200, 'generation is fast');
  assert.equal(scenery.TREES, scenery.TREES, 'generated once per module');
});

test('the scenery bound lies inside the ground\'s faded edge (Ground.tsx fades from 43% of its width)', () => {
  assert.ok(SCENERY_BOUND < 0.43 * (WORLD_BOUND * 2 + 2));
  assert.match(ground, /smoothstep\(0\.43, 0\.5, edge\)/);
});

test('U45 the ground covers the world bound with a margin around every plot and road', () => {
  for (const [x0, z0, x1, z1] of [...yards, ...ROADS]) assert.ok(Math.max(Math.abs(x0), Math.abs(x1), Math.abs(z0), Math.abs(z1)) <= WORLD_BOUND - 3);
});

test('U34 the warehouse lamp and eave trim reuse the six status colours', () => {
  assert.deepEqual(Object.keys(BUILDING_STATUS_STYLES).sort(), ['completed', 'developing', 'error', 'idle', 'notice', 'question']);
});

const terrain = await read('../src/scene/Terrain.tsx');
const streets = await read('../src/scene/TownStreets.tsx');
const ground = await read('../src/scene/Ground.tsx');
const backdrop = await read('../src/scene/Backdrop.tsx');
const parts = await read('../src/scene/yardParts.tsx');
const yardFile = await read('../src/scene/ProjectYard.tsx');
const sceneFile = await read('../src/scene/Scene.tsx');

test('C08 ProjectYard keeps the label, click and drag handlers and renders the warehouse inside the yard', () => {
  assert.match(yardFile, /<Html position=\{\[BUILDING_CENTER\.x, LABEL_Y, BUILDING_CENTER\.z\]\} center occlude=\{false\}/);
  assert.match(yardFile, /className=\{`building-label/);
  assert.match(yardFile, /onPointerDown=\{handlePointerDown\}[\s\S]*onPointerUp=\{handlePointerUp\}/);
  assert.match(yardFile, /rotation=\{\[0, yardFacing\(project\.position\), 0\]\}/);
  assert.match(yardFile, /<YardGround \/>[\s\S]{0,200}<Warehouse /);
});

test('C09/C10 the warehouse has a pitched roof, double doors, windows, a lamp and a chimney from shared materials; selecting turns the ridge cap purple', () => {
  const warehouse = parts.slice(parts.indexOf('export function Warehouse'), parts.indexOf('// ---- Box ----'));
  for (const piece of ['G.roof', 'G.doorway', 'G.doorSplit', 'G.windowPane', 'G.lamp', 'G.chimney', 'G.awning']) assert.match(warehouse, new RegExp(piece.replace('.', '\\.')));
  assert.match(warehouse, /material=\{selected \? M\.pin : M\.white\}/);
  assert.match(warehouse, /material=\{status\}/);
  assert.doesNotMatch(warehouse, /new THREE\./);
});

test('C11 Terrain draws trees, rocks, fences and paths as instanced meshes, keeps the water, and has no hills', () => {
  assert.match(terrain, /<Instances limit=\{TREES\.length\}/);
  assert.match(terrain, /<Instances limit=\{ROCKS\.length\}/);
  assert.match(streets, /<Instances limit=\{FENCES\.length\}/);
  assert.match(streets, /<Instances limit=\{GATE_PATHS\.length\}/);
  assert.match(streets, /<Instances limit=\{ROADS\.length\}/);
  assert.match(terrain, /export function Ponds/);
  assert.doesNotMatch(terrain + streets + backdrop, /hill|Hill/);
});

test('C12 Ground and Backdrop are sized from the world bound and contain no hill meshes', () => {
  assert.match(ground, /const GROUND_SIZE = WORLD_BOUND \* 2 \+ 2;/);
  assert.match(backdrop, /WORLD_BOUND/);
  assert.doesNotMatch(backdrop, /icosahedronGeometry|Instances|landscape/i);
});

test('C13 no per-plot light, and the only shadow caster in the street components is the fence batch', () => {
  for (const source of [streets, terrain, ground]) assert.doesNotMatch(source, /pointLight|spotLight/);
  for (const source of [terrain, ground]) assert.doesNotMatch(source, /castShadow/);
  assert.equal(streets.match(/castShadow/g).length, 1);
  assert.doesNotMatch(yardFile, /pointLight|spotLight/);
});

test('C13b the fence casts a shadow like the health wall on top of it, and still takes no clicks', () => {
  const fenceTag = streets.match(/<Instances limit=\{FENCES\.length\}[^>]*>/)[0];
  assert.match(fenceTag, /\bcastShadow\b/);
  assert.match(fenceTag, /raycast=\{noRaycast\}/);
});

test('C15 the static scenery takes no project props, so a status change never rebuilds it', () => {
  for (const source of [terrain, streets]) assert.doesNotMatch(source, /ProjectData|useWorldStore/);
  assert.match(sceneFile, /<TownStreets \/>/);
  assert.match(sceneFile, /<Ground \/>/);
});

test('I12 connection lines join warehouses, not plot centres', async () => {
  const lines = await read('../src/scene/ConnectionLines.tsx');
  assert.match(lines, /buildingWorldPoint\(p\.position\)/);
  assert.doesNotMatch(lines, /domeWorldPoint|worldOfPlot/);
});

test('C14 no ambient animation: terrain and props run no frame loop, and the streets\' only one is the existing lamp glow', () => {
  assert.doesNotMatch(terrain, /useFrame/);
  assert.equal((streets.match(/useFrame\(/g) ?? []).length, 1);
  assert.match(streets, /lampMaterial\.current\.emissiveIntensity/);
});
