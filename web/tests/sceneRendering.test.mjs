import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SKY_REFRESH_MS, isSceneCovered } from '../src/lib/sceneRendering.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('nothing covers the village when no popup is open', () => {
  assert.equal(isSceneCovered({ workspaceProjectId: null, catalogOpen: false }), false);
});

test('an open project workspace or Catalog covers the village', () => {
  assert.equal(isSceneCovered({ workspaceProjectId: 'p1', catalogOpen: false }), true);
  assert.equal(isSceneCovered({ workspaceProjectId: null, catalogOpen: true }), true);
});

test('the sky and its shadows refresh every 3 minutes', () => {
  assert.equal(SKY_REFRESH_MS, 180_000);
});

test('the Canvas renders on demand, never continuously', async () => {
  const source = await read('../src/ui/WorldView.tsx');
  assert.match(source, /<Canvas[^>]*frameloop="demand"/);
});

test('the scene schedules the periodic sky refresh and repaints when a popup closes', async () => {
  const source = await read('../src/scene/Scene.tsx');
  assert.match(source, /setInterval\(invalidate, SKY_REFRESH_MS\)/);
  assert.match(source, /if \(!covered\) invalidate\(\)/);
});
