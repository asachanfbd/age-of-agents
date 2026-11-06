import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { render } from './renderHelper.mjs';

// Layout cannot be measured without a DOM, so these pin the classes that keep a long task title from widening the
// alert (and the dialog around it): every grid/flex ancestor of the truncating label needs `min-w-0`.
const read = (file) => readFile(new URL(`../src/ui/project-popup/${file}`, import.meta.url), 'utf8');
const [alert, dialogs, listParts] = await Promise.all([read('TaskConflictAlert.tsx'), read('TaskDialogs.tsx'), read('TaskListParts.tsx')]);

const LONG = 'A very long task title that keeps going well past the width of the dialog and would stretch it sideways '.repeat(4).trim();
const conflict = {
  kind: 'limit',
  details: { projectName: 'Age of Agents', limit: 6, inUse: 2, hasRepository: true, occupants: [
    { taskId: 't1', planItemId: null, number: '10.021', title: LONG, state: 'running' },
    { taskId: 't2', planItemId: null, number: '10.022', title: LONG, state: 'waiting_input' },
  ] },
};
const tasksById = { t1: { status: 'running' }, t2: { status: 'waiting_input' } };

test('every ancestor of a conflict row label can shrink below its content width', () => {
  assert.match(alert, /<Alert [^>]*className=\{cn\('min-w-0', className\)\}/);
  assert.match(alert, /<AlertDescription className="[^"]*\bw-full\b[^"]*\bmin-w-0\b[^"]*grid-cols-\[minmax\(0,1fr\)\]/);
  assert.match(alert, /<ul className="[^"]*\bmin-w-0\b[^"]*grid-cols-\[minmax\(0,1fr\)\]/);
  assert.match(alert, /<li [^>]*className="[^"]*\bmin-w-0\b/);
  assert.match(alert, /<span className="min-w-0 truncate" title=/, 'the label truncates and keeps the full title on hover');
  assert.match(alert, /<p className="break-words">\{view\.body\}/);
});

test('the Start task dialog gives its content a shrinkable column and wraps its description', () => {
  assert.match(dialogs, /<DialogContent className="grid-cols-\[minmax\(0,1fr\)\] sm:max-w-md" hideClose>/);
  assert.match(dialogs, /<DialogDescription className="break-words">/);
});

test('the Tasks list alert stays inside its margins', () => {
  assert.match(listParts, /<TaskConflictAlert [^>]*max-w-\[calc\(100%-2rem\)\]/);
});

test('a render with very long titles keeps one truncating row per task and its Open button', async () => {
  const { useWorldStore } = await import('../src/store/worldStore.ts').catch(() => ({}));
  if (useWorldStore) useWorldStore.setState({ tasksById });
  const html = await render('src/ui/project-popup/TaskConflictAlert.tsx', 'TaskConflictAlert', { conflict, onOpen() {} });
  assert.equal((html.match(/<li /g) ?? []).length, 2);
  assert.equal((html.match(/class="min-w-0 truncate"/g) ?? []).length, 2);
  assert.equal((html.match(/>Open<\/button>/g) ?? []).length, 2);
  assert.equal((html.match(/[ "]shrink-0[ "]/g) ?? []).length, 2, 'the Open buttons never shrink away');
});
