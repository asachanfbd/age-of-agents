import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const layout = await import('../src/lib/villageLayout.ts');
const { SLOTS, WORK_CAP, YARD_RECT, AREAS, WORK_TAG_ANCHOR, TAG_WIDTH_UNITS, MERGE_TAG_ANCHOR, machineTagLift, workRobotSpot, workBoxSpot, rectsOverlap, inRect } = layout;
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const bays = SLOTS.work.slice(0, WORK_CAP);
// A tag's footprint on the ground: its estimated width, and a thin depth since the tag is a flat billboard.
const TAG_DEPTH = 0.6;
const tagRect = (i) => {
  const x = bays[i].x + WORK_TAG_ANCHOR.dx;
  return [x - TAG_WIDTH_UNITS / 2, bays[i].z - TAG_DEPTH / 2, x + TAG_WIDTH_UNITS / 2, bays[i].z + TAG_DEPTH / 2];
};
// Shrunk by a hair so a tag that exactly touches a footprint is not counted as covering it.
const around = (p, half) => [p.x - half + 1e-6, p.z - half + 1e-6, p.x + half - 1e-6, p.z + half - 1e-6];
const ROBOT_HALF = 0.35;
const BOX_HALF = 0.3;

test('T01 tagLift is gone; machines keep an alternating lift and the PR queue a fixed anchor', async () => {
  assert.equal('tagLift' in layout, false);
  assert.notEqual(machineTagLift(0), machineTagLift(1));
  assert.equal(machineTagLift(0), machineTagLift(2));
  assert.deepEqual(MERGE_TAG_ANCHOR, { dx: 0, dy: 2.1 });
  assert.doesNotMatch(await read('../src/scene/YardEntities.tsx') + await read('../src/scene/ProjectYard.tsx'), /\btagLift\(/);
});

test('T02/T03 the anchor is finite, at head height and right of the slot', () => {
  const { dx, dy } = WORK_TAG_ANCHOR;
  assert.ok(Number.isFinite(dx) && dx > 0);
  assert.ok(dy >= 1.0 && dy <= 1.2, `height ${dy}`);
});

test('T04 the tag starts right of the crate, never above the robot', () => {
  for (let i = 0; i < bays.length; i++) assert.ok(tagRect(i)[0] >= workBoxSpot(bays[i]).x + BOX_HALF - 1e-9, `slot ${i}`);
});

test('T07 no two work tags overlap', () => {
  for (let i = 0; i < bays.length; i++) for (let j = i + 1; j < bays.length; j++) assert.ok(!rectsOverlap(tagRect(i), tagRect(j)), `${i}/${j}`);
});

test('T08/T09 a tag never covers any bay\'s robot or box, its own included', () => {
  for (let i = 0; i < bays.length; i++) for (let j = 0; j < bays.length; j++) {
    assert.ok(!rectsOverlap(tagRect(i), around(workRobotSpot(bays[j]), ROBOT_HALF)), `tag ${i} on robot ${j}`);
    assert.ok(!rectsOverlap(tagRect(i), around(workBoxSpot(bays[j]), BOX_HALF)), `tag ${i} on box ${j}`);
  }
});

test('T06/T10 tags stay inside the work zone and clear of the "+N more" stack', () => {
  const overflow = SLOTS.work[WORK_CAP];
  for (let i = 0; i < bays.length; i++) {
    const rect = tagRect(i);
    assert.ok(rect[0] >= YARD_RECT[0] && rect[2] <= AREAS.work[2], `slot ${i}`);
    assert.ok(!inRect({ x: overflow.x, z: overflow.z }, rect), `slot ${i} on the overflow stack`);
  }
});

test('T11 a right-hand tag ends at or before the next bay\'s lane', () => {
  for (let i = 0; i + 1 < bays.length; i++) {
    if (bays[i].z === bays[i + 1].z) assert.ok(tagRect(i)[2] <= bays[i + 1].x - 1.8 + 1e-9, `slot ${i}`);
  }
});

test('T15 the width estimate matches the compact badge (about 92px, world-sized by distanceFactor)', async () => {
  assert.ok(TAG_WIDTH_UNITS > 1 && TAG_WIDTH_UNITS <= 1.5);
  const css = await read('../src/index.css');
  assert.match(css, /\.yard-tag--compact \{[^}]*max-width: 92px/);
  assert.match(await read('../src/scene/YardEntities.tsx'), /distanceFactor=\{TAG_DISTANCE_FACTOR\}/, 'tag world size stays fixed at every zoom');
});

test('C01/C02 the work tag is a compact badge: smaller type, truncated title and a one-line status', async () => {
  const css = await read('../src/index.css');
  const rule = css.match(/\.yard-tag--compact \{([^}]*)\}/)[1];
  assert.match(rule, /font-size: 10px/);
  assert.match(rule, /max-width: 92px/);
  assert.match(rule, /min-width: \d+px/);
  assert.match(css, /\.yard-tag__title,\s*\.yard-tag__line \{\s*overflow: hidden;\s*text-overflow: ellipsis;/);
  assert.match(css, /\.yard-tag \{[^}]*white-space: nowrap/);
  const card = (await read('../src/scene/YardEntities.tsx')).match(/function TaskTagCard[\s\S]*?\n\}\n/)[0];
  assert.match(card, /yard-tag yard-tag--compact yard-tag--\$\{tone\}/);
  assert.doesNotMatch(card, /tooltip\.position/);
});

test('I03 TaskEntity places the tag from the anchor beside the slot', async () => {
  const entities = await read('../src/scene/YardEntities.tsx');
  assert.match(entities, /<Tag position=\{\[slot\.x \+ tagAnchor\.dx, tagAnchor\.dy, slot\.z\]\}/);
  assert.match(await read('../src/scene/ProjectYard.tsx'), /tagAnchor=\{entity\.area === 'work' \? WORK_TAG_ANCHOR : MERGE_TAG_ANCHOR\}/);
});
