import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The bar's counts are covered against `taskProgress` in projectTasks.test.mjs; these check that the
// building label renders the shared three-colour bar, and the Tasks board no longer does.
const bar = await readFile(new URL('../src/ui/TaskProgressBar.tsx', import.meta.url), 'utf8');
const building = await readFile(new URL('../src/scene/ProjectYard.tsx', import.meta.url), 'utf8');
const tasksPanel = await readFile(new URL('../src/ui/project-popup/TasksPanel.tsx', import.meta.url), 'utf8');

test('the bar draws done, in progress and pending as three distinct colours', () => {
  const colours = [...bar.matchAll(/key: '(\w+)', color: '(bg-[\w-]+)'/g)].map(([, key, colour]) => [key, colour]);
  assert.deepEqual(colours.map(([key]) => key), ['done', 'inProgress', 'pending']);
  assert.equal(new Set(colours.map(([, colour]) => colour)).size, 3);
});

test('each segment is sized by its count and empty segments are skipped', () => {
  assert.match(bar, /progress\[key\] > 0 \?/);
  assert.match(bar, /style=\{\{ flexGrow: progress\[key\] \}\}/);
});

test('the project label shows the bar under the name badge', () => {
  assert.match(building, /<div className="building-badge">\s*<span className="building-name">\{project\.name\}<\/span>\s*<\/div>\s*\{progress && <TaskProgressBar/);
  assert.match(building, /\{progress && <TaskProgressBar progress=\{progress\}/);
});

test('the Tasks board has no progress bar above its columns, and the legend is gone', () => {
  assert.doesNotMatch(tasksPanel, /TaskProgressBar|TaskProgressLegend|taskProgress/);
  assert.doesNotMatch(bar, /TaskProgressLegend/);
});
