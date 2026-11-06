import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const fp = await import('../src/lib/footerPopovers.ts');
const { footerPopoverReducer } = await import('../src/lib/footerPopoverState.ts');
const { summarizeWorkspaceCounts } = await import('../src/lib/workspaceCounts.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const { readFile } = await import('node:fs/promises');

const T = '2026-10-04T10:00:00.000Z';
const usage = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });
const task = (id, pid, patch = {}) => ({
  id, projectId: pid, executorId: 'e', executionMode: 'terminal', description: id, status: 'developing', kind: 'execute', planItemId: null,
  sessionId: `s-${id}`, blockedQuestion: null, failureReason: null, tokenUsage: usage(), createdAt: T, updatedAt: T, completedAt: null, ...patch,
});
const item = (id, pid, patch = {}) => ({ id, projectId: pid, title: `Item ${id}`, description: '', status: 'pending', order: 0, taskIds: [], executorId: null, createdAt: T, updatedAt: T, ...patch });
const run = (id, pid, status) => ({
  id, projectId: pid, planItemId: 'i', workflowId: 'w', workflowSnapshot: { id: 'w', name: 'W', description: '', enabled: true, steps: [{ id: 's1', name: 'S' }] },
  status, currentStepId: 's1', executorId: 'e', prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0, createdAt: T, updatedAt: T, completedAt: null,
});

/** A project with `a` active, `b` blocked and `p` pending tasks; `loaded: false` leaves its runs unloaded. */
function projectBoard(pid, { a = 0, b = 0, p = 0 }, loaded = true) {
  const items = []; const runs = []; const tasks = [];
  const ran = (kind, n, status) => {
    for (let i = 0; i < n; i++) {
      const id = `${pid}-${kind}${i}`;
      items.push(item(id, pid, { status: 'developing', workflowRunId: `r-${id}`, taskIds: [`t-${id}`] }));
      runs.push(run(`r-${id}`, pid, status));
      tasks.push(task(`t-${id}`, pid));
    }
  };
  ran('a', a, 'running');
  ran('b', b, 'failed');
  for (let i = 0; i < p; i++) items.push(item(`${pid}-p${i}`, pid));
  return { items, taskIds: tasks.map((t) => t.id), runs: loaded ? runs : undefined, tasks };
}
function world(specs) {
  const boards = { projects: [], executors: [{ id: 'e', label: 'E' }], tasksById: {}, planByProject: {}, taskIdsByProject: {}, workflowRunsByProject: {} };
  for (const { id, name, counts, loaded } of specs) {
    const pb = projectBoard(id, counts, loaded);
    boards.projects.push({ id, name: name ?? id, position: [0, 0], status: 'idle', activeTaskId: null, taskCount: 0, sync: null });
    boards.planByProject[id] = { items: pb.items };
    boards.taskIdsByProject[id] = pb.taskIds;
    boards.workflowRunsByProject[id] = pb.runs;
    for (const t of pb.tasks) boards.tasksById[t.id] = t;
  }
  return boards;
}
const order = (b) => fp.buildTasksPopupGroups(b).map((g) => g.projectId);
const spec = (id, a, b, p, name) => ({ id, name, counts: { a, b, p } });

test('rank covers every combination of active, blocked and pending being zero or non-zero', () => {
  const rank = (active, blocked, pending) => fp.projectRank({ active, blocked, pending });
  assert.equal(rank(0, 0, 0), null);
  assert.equal(rank(2, 0, 0), 1);
  assert.equal(rank(0, 2, 0), 2);
  assert.equal(rank(1, 1, 0), 3);
  assert.equal(rank(1, 0, 1), 4);
  assert.equal(rank(0, 1, 1), 4);
  assert.equal(rank(1, 1, 1), 4);
  assert.equal(rank(0, 0, 3), 5);
});

test('a project with no tasks is not listed, and a lone project is listed whatever its rank', () => {
  assert.deepEqual(order(world([spec('x', 0, 0, 0)])), []);
  assert.deepEqual(order(world([spec('x', 0, 0, 4), spec('y', 0, 0, 0)])), ['x']);
});

test('within each rank: fewer active, fewer blocked, higher active share, higher live share, fewer pending', () => {
  assert.deepEqual(order(world([spec('b', 3, 0, 0), spec('a', 1, 0, 0)])), ['a', 'b']);
  assert.deepEqual(order(world([spec('b', 0, 3, 0), spec('a', 0, 1, 0)])), ['a', 'b']);
  assert.deepEqual(order(world([spec('a', 1, 3, 0), spec('b', 3, 1, 0)])), ['b', 'a']);
  assert.deepEqual(order(world([spec('a', 1, 0, 3), spec('b', 1, 1, 1)])), ['b', 'a']);
  assert.deepEqual(order(world([spec('a', 0, 0, 5), spec('b', 0, 0, 2)])), ['b', 'a']);
});

test('rank beats ratio', () => {
  assert.deepEqual(order(world([spec('hi', 5, 0, 1), spec('lo', 1, 5, 0)])), ['lo', 'hi']);
});

test('equal ratios tie (1 of 2 equals 2 of 4) and fall to name ignoring case, then id', () => {
  assert.deepEqual(order(world([spec('p1', 1, 1, 0, 'beta'), spec('p2', 2, 2, 0, 'Alpha')])), ['p2', 'p1']);
  assert.deepEqual(order(world([spec('p1', 1, 0, 1, 'beta'), spec('p2', 2, 0, 2, 'alpha')])), ['p2', 'p1']);
  assert.deepEqual(order(world([spec('p9', 1, 0, 0, 'Same'), spec('p2', 1, 0, 0, 'same'), spec('p5', 1, 0, 0, 'ALPHA')])), ['p5', 'p2', 'p9']);
});

test('ratios are compared exactly, not as rounded percentages or floats', () => {
  const c = (active, blocked) => ({ active, blocked, pending: 0 });
  assert.equal(fp.compareProjectCounts(c(1, 1), c(2, 2)), 0);
  assert.ok(fp.compareProjectCounts(c(1_000_000_000, 2_000_000_000), c(333_333_333, 666_666_667)) < 0);
  assert.ok(fp.compareProjectCounts(c(333_333, 666_667), c(1_000_000, 2_000_000)) > 0);
  assert.equal(fp.compareProjectCounts(c(1_000_000_000, 2_000_000_000), c(2_000_000_000, 4_000_000_000)), 0);
});

test('the worked example orders Shop API, Blog, Docs, Site, Age of Agents, Tools', () => {
  const b = world([
    spec('aoa', 1, 1, 5, 'Age of Agents'), spec('tools', 0, 0, 3, 'Tools'), spec('docs', 2, 1, 0, 'Docs'),
    spec('blog', 0, 1, 0, 'Blog'), spec('site', 1, 0, 1, 'Site'), spec('shop', 1, 0, 0, 'Shop API'),
  ]);
  assert.deepEqual(fp.buildTasksPopupGroups(b).map((g) => g.projectName), ['Shop API', 'Blog', 'Docs', 'Site', 'Age of Agents', 'Tools']);
});

test('rows under a project run active, then blocked, then pending; counts match rows; each task appears once', () => {
  const b = world([spec('p', 2, 1, 2)]);
  const [group] = fp.buildTasksPopupGroups(b);
  assert.deepEqual(group.rows.map((r) => r.kind), ['active', 'active', 'blocked', 'pending', 'pending']);
  assert.deepEqual(group.counts, { active: 2, blocked: 1, pending: 2 });
  assert.equal(new Set(group.rows.map((r) => r.id)).size, group.rows.length);
});

test('the total equals the three footer numbers; a loading project and archived items add nothing', () => {
  const b = world([spec('p', 2, 1, 2), spec('q', 1, 1, 1, 'loading')]);
  b.workflowRunsByProject.q = undefined;
  b.planByProject.p.items.push(item('arch', 'p', { archived: true }));
  const total = fp.buildTasksPopupGroups(b).reduce((n, g) => n + g.rows.length, 0);
  const { tasks } = summarizeWorkspaceCounts(b);
  assert.equal(total, tasks.active + tasks.blocked + tasks.pending);
  assert.deepEqual(order(b), ['p']);
});

test('a task changing state moves its row and re-ranks the project; the last task leaving removes the project', () => {
  const b = world([spec('a', 1, 0, 0), spec('b', 0, 0, 2)]);
  assert.deepEqual(order(b), ['a', 'b']);
  b.workflowRunsByProject.a[0] = run('r-a-a0', 'a', 'failed');
  assert.deepEqual(fp.buildTasksPopupGroups(b)[0].counts, { active: 0, blocked: 1, pending: 0 });
  b.planByProject.b.items = [];
  assert.deepEqual(order(b), ['a']);
  b.workflowRunsByProject.a[0] = run('r-a-a0', 'a', 'completed');
  assert.deepEqual(order(b), []);
});

test('heading counts read in words, omitting zeros', () => {
  assert.equal(fp.taskCountsLabel({ active: 1, blocked: 1, pending: 5 }), '1 active, 1 blocked, 5 pending');
  assert.equal(fp.taskCountsLabel({ active: 0, blocked: 0, pending: 3 }), '3 pending');
  assert.equal(fp.taskCountsLabel({ active: 0, blocked: 2, pending: 0 }), '2 blocked');
  assert.equal(fp.taskCountsLabel({ active: 0, blocked: 0, pending: 0 }), '');
});

test('each row kind has its own state word, so colour is not the only cue', () => {
  assert.deepEqual(fp.TASK_KIND_WORD, { active: 'Active', blocked: 'Needs you', pending: 'Pending' });
});

test('long, empty and accented names pass through untouched', () => {
  const long = 'N'.repeat(500);
  const b = world([spec('a', 0, 0, 1, long), spec('b', 0, 0, 1, ''), spec('c', 0, 0, 1, 'Éclair')]);
  assert.equal(fp.buildTasksPopupGroups(b).find((g) => g.projectId === 'a').projectName, long);
  assert.deepEqual(order(b), ['b', 'c', 'a']);
});

test('one shared Tasks id: moving between counts keeps it open, a click pins, a click while pinned closes', () => {
  const r = footerPopoverReducer;
  let s = r(null, { type: 'preview', id: 'tasks' });
  assert.deepEqual(s, { id: 'tasks', pinned: false });
  assert.equal(r(s, { type: 'preview', id: 'tasks' }), s);
  s = r(s, { type: 'toggle', id: 'tasks' });
  assert.deepEqual(s, { id: 'tasks', pinned: true });
  assert.deepEqual(r(s, { type: 'unpreview', id: 'tasks' }), s);
  assert.equal(r(s, { type: 'toggle', id: 'tasks' }), null);
  assert.deepEqual(r({ id: 'commands-running', pinned: true }, { type: 'preview', id: 'tasks' }), { id: 'tasks', pinned: false });
  assert.deepEqual(r({ id: 'tasks', pinned: true }, { type: 'preview', id: 'projects-working' }), { id: 'projects-working', pinned: false });
  assert.equal(r({ id: 'tasks', pinned: true }, { type: 'close' }), null);
});

test('a row click opens its card and closes the popup; a vanished record falls back to the board', () => {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], planByProject: {}, workflowRunsByProject: {}, tasksById: {}, workspaceProjectId: null, catalogOpen: true, notificationCenterOpen: true, ...CLEAN_ERROR_STATE });
  stub.projects.set('p', { id: 'p', name: 'p', slug: 'p', relativePath: 'projects/p', status: 'idle', position: null, activeTaskId: null, taskCount: 0, createdAt: T, updatedAt: T });
  useWorldStore.setState({ planByProject: { p: { items: [item('p-p0', 'p')] } }, workflowRunsByProject: { p: [] } });
  const [row] = fp.buildTasksPopupGroups(world([spec('p', 0, 0, 1)])).flatMap((g) => g.rows);
  useWorldStore.getState().openWorkspaceCardDetail('p', row.open);
  const s = useWorldStore.getState();
  assert.equal(s.workspaceProjectId, 'p');
  assert.deepEqual(s.workspaceCardDetailRequest, { detail: { kind: 'item', id: 'p-p0' } });
  assert.equal(s.catalogOpen, false);
  assert.equal(s.notificationCenterOpen, false);
});

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the popup source: one trigger wrapper, Radix shell like the planning popover, header, no old lists or looping animation', async () => {
  const popup = await read('../src/ui/TasksPopover.tsx');
  const footer = await read('../src/ui/StatusFooter.tsx');
  const lists = await read('../src/ui/FooterListPopovers.tsx');
  assert.equal(popup.match(/aria-haspopup="dialog"/g)?.length, 1, 'one button template, rendered per count');
  assert.match(popup, /aria-controls=\{open \? TASKS_POPOVER_ID : undefined\}/);
  assert.match(popup, /side="top"[\s\S]*align="start"[\s\S]*sideOffset=\{8\}/);
  assert.match(popup, /w-\[min\(380px,calc\(100vw-24px\)\)\]/);
  assert.match(popup, /max-h-\[min\(440px,calc\(100dvh-var\(--status-footer-height\)-16px\)\)\]/);
  assert.match(popup, /isolateScroll/);
  assert.match(popup, /data-status-footer/);
  assert.match(popup, /z-\[165\]/);
  assert.match(popup, /Across all projects/);
  assert.match(popup, /bg-foreground\/10/);
  assert.match(popup, /openCard\(row\.projectId, row\.open\); onDone\(\)/);
  assert.match(popup, /<PopoverAnchor asChild>\s*<span[\s\S]*onMouseLeave=\{leave\}/, 'leave is handled on the wrapper');
  assert.doesNotMatch(popup, /animate-(pulse|ping|spin|bounce)|infinite/);
  assert.equal(footer.match(/<TasksCountPopover/g)?.length, 1);
  assert.doesNotMatch(footer + lists, /TaskListPopover|tasks-active|tasks-blocked|tasks-pending|buildTaskGroupsForFooter|EMPTY_TASK_MESSAGES/);
});
