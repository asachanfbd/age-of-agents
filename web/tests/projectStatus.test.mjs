import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const { summarizeProjectStatus } = await import('../src/lib/projectStatus.ts');

const project = (id, status, patch = {}) => ({
  id,
  name: id,
  position: [0, 0],
  status,
  activeTaskId: null,
  taskCount: 0,
  ...patch,
});

test('summarizeProjectStatus returns all zeroes for no projects', () => {
  assert.deepEqual(summarizeProjectStatus([]), { total: 0, working: 0, blocked: 0 });
});

test('summarizeProjectStatus counts a mix of idle/developing/blocked/done-like statuses', () => {
  // 'done'/'failed' are Task statuses, not BuildingStatus — a project itself is only ever
  // idle/developing/blocked, so idle is the only "neither working nor blocked" case to cover.
  const projects = [
    project('idle-1', 'idle'),
    project('working-1', 'developing'),
    project('blocked-1', 'blocked'),
    project('idle-2', 'idle'),
  ];

  assert.deepEqual(summarizeProjectStatus(projects), { total: 4, working: 1, blocked: 1 });
});

test('summarizeProjectStatus counts every project as working when all are developing', () => {
  const projects = [project('a', 'developing'), project('b', 'developing')];
  assert.deepEqual(summarizeProjectStatus(projects), { total: 2, working: 2, blocked: 0 });
});

test('summarizeProjectStatus counts every project as blocked when all are blocked', () => {
  const projects = [project('a', 'blocked'), project('b', 'blocked'), project('c', 'blocked')];
  assert.deepEqual(summarizeProjectStatus(projects), { total: 3, working: 0, blocked: 3 });
});

test('summarizeProjectStatus never double-counts a project as both working and blocked', () => {
  const projects = [project('a', 'developing'), project('b', 'blocked')];
  const summary = summarizeProjectStatus(projects);
  assert.equal(summary.working + summary.blocked, summary.total);
  assert.deepEqual(summary, { total: 2, working: 1, blocked: 1 });
});
