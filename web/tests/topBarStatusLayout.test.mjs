import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/ui/TopBar.tsx', import.meta.url), 'utf8');

test('the agent-network overlay keeps its heading and tagline but no longer shows the counts', () => {
  const overlayStart = source.indexOf('pointer-events-none absolute left-[34px]');
  const overlay = source.slice(overlayStart);

  assert.ok(overlayStart >= 0);
  assert.match(overlay, /AGENT NETWORK/);
  assert.match(overlay, /Systems connected\.<br \/>Ideas in motion\./);
  assert.doesNotMatch(source, /Workspace status|summarizeProjectStatus|projectStatus\./);
});

test('agent-network status is a text overlay without a card background', () => {
  const overlay = source.slice(source.indexOf('pointer-events-none absolute left-[34px]'));
  assert.doesNotMatch(overlay, /bg-background|backdrop-blur|rounded-lg|border-border/);
});

test('the top bar no longer holds the bell, the agents strip or the error alert, which moved to the status footer', () => {
  assert.doesNotMatch(source, /\bBell\b|NotificationCenter|countUnreadNotifications/);
  assert.doesNotMatch(source, /<footer|ExecutorFooterItem|sortExecutorsByUsage/);
  assert.doesNotMatch(source, /Alert variant="destructive" role="alert" className="pointer-events-auto/);
});

test('the top bar keeps its clock, view toggle, settings and New Building', () => {
  const actions = source.slice(source.indexOf('ml-auto flex items-center gap-3'));
  const order = ['<ISTClock />', '<ViewModeToggle />', 'aria-label="Open settings"', "'New Building'"].map((marker) => actions.indexOf(marker));
  assert.ok(order.every((index) => index >= 0), 'all four remain');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in their existing order');
});

test('header is a single row: no village overview button or project dropdown', () => {
  assert.doesNotMatch(source, /Village overview\s*<\/Button>|Workspace navigation|Open project…|<Select/);
});

test('C01 the project summary sits under the personal workspace label and no fixed plot limit is shown', () => {
  const workspace = source.indexOf('Personal workspace');
  const summary = source.indexOf('projectSummary(projects.length)');
  const nextSection = source.indexOf('ml-auto flex items-center gap-3');

  assert.ok(workspace >= 0);
  assert.ok(summary > workspace, 'summary should follow the workspace label');
  assert.ok(summary < nextSection, 'summary should live in the workspace block, before the action buttons');
  assert.doesNotMatch(source, /plots occupied|All plots occupied|\/ \{PROJECT_CAPACITY\}/);
});

test('C02/C03 New Building disables only at capacity; the soft warning shows only from "nearly full" up', () => {
  assert.match(source, /const capacity = capacityState\(projects\.length\);\s*const atCapacity = capacity === 'full';/);
  assert.match(source, /<Button type="button" disabled=\{atCapacity\}/);
  assert.match(source, /\{capacity !== 'ok' && </);
});

test('brand reads Age of Agents, not the old Context Village name', () => {
  assert.match(source, /aria-label="Age of Agents workspace"/);
  assert.match(source, /aria-label="Age of Agents overview"/);
  assert.match(source, />\s*Age of Agents\s*</);
  assert.doesNotMatch(source, /Context Village/);
});
