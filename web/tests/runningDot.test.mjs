import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runningDotLook } from '../src/lib/runningDot.ts';

const source = (path) => readFile(new URL(`../src/ui/project-popup/${path}`, import.meta.url), 'utf8');
const [dot, header, commandsPanel] = await Promise.all([
  source('commands/RunningDot.tsx'),
  source('HeaderCommands.tsx'),
  source('commands/CommandsPanel.tsx'),
]);

test('a running command gets a solid blue dot with a static glow', () => {
  const look = runningDotLook('running');
  assert.match(look.className, /\bbg-info\b/);
  assert.match(look.className, /\brounded-full\b/);
  assert.equal(look.style.boxShadow, '0 0 6px 2px color-mix(in srgb, var(--sc-info) 60%, transparent)');
});

test('a minimized run is a hollow blue ring without glow, so it stays distinct from "running"', () => {
  const look = runningDotLook('minimized');
  assert.match(look.className, /\bborder-info\b/);
  assert.match(look.className, /\bbg-transparent\b/);
  assert.equal(look.style.boxShadow, 'none');
  assert.notEqual(look.className, runningDotLook('running').className);
});

test('neither tone animates (looping animations are banned for GPU cost)', () => {
  for (const tone of ['running', 'minimized']) assert.doesNotMatch(runningDotLook(tone).className, /animate-/);
});

test('RunningDot takes its whole look from runningDotLook and stays labelled for screen readers', () => {
  assert.match(dot, /const \{ className, style \} = runningDotLook\(tone\);/);
  assert.match(dot, /<span role="img" aria-label=\{label\} title=\{label\} className=\{className\} style=\{style\} \/>/);
  assert.doesNotMatch(dot, /bg-(success|info)\b/, 'no colours hard-coded outside the helper');
});

test('the header shows the dot on both a highlighted button and its "More commands" dropdown item', () => {
  assert.equal(header.match(/\{active && <RunningDot label="Running" \/>\}/g)?.length, 2);
});

test('the Settings → Commands row shows the dot on its "Running…" button', () => {
  assert.match(commandsPanel, /onClick=\{\(\) => onOpenCommandLog\(active\.id\)\}>\s*<RunningDot label="Running" \/> Running…/);
});

test('both surfaces pick up runs already going when the popup opens', () => {
  for (const file of [header, commandsPanel]) assert.match(file, /loadActiveCommandRuns\(project\.id\)/);
});
