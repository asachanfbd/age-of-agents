import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isThemePreference, resolveSceneTheme } from '../src/lib/themePreference.ts';

test('theme preferences accept only supported persisted values', () => {
  for (const value of ['light', 'dark', 'system', 'daytime']) assert.equal(isThemePreference(value), true);
  for (const value of ['', 'auto', null, 1]) assert.equal(isThemePreference(value), false);
});

test('system follows device appearance while daytime remains time-driven', () => {
  assert.equal(resolveSceneTheme('system', false), 'light');
  assert.equal(resolveSceneTheme('system', true), 'dark');
  assert.equal(resolveSceneTheme('daytime', true), 'daytime');
});
