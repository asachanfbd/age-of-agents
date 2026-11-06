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
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { PROJECT_CAPACITY, LEGACY_PLOTS, PROJECT_PLOTS } = await import('../src/scene/townLayout.ts');
const nearestToCenter = PROJECT_PLOTS.map((p, index) => ({ p, index, d: Math.round((p.x ** 2 + p.z ** 2) * 1e6) })).sort((a, b) => a.d - b.d || a.index - b.index).map((e) => e.p);
const { plotOfSlot, slotOfPlot, buildStreets } = await import('../src/lib/townGroups.ts');
const { CLEAN_ERROR_STATE, reportedError } = await import('./errorHelpers.mjs');

const state = () => useWorldStore.getState();
const slotOf = (id) => slotOfPlot(state().projects.find((p) => p.id === id).position);
const noOverlap = () => {
  const keys = state().projects.map((p) => p.position.join());
  assert.equal(new Set(keys).size, keys.length, 'no two projects share a plot');
};

async function setup(count = 2) {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], selectedId: null, ...CLEAN_ERROR_STATE });
  for (let i = 0; i < count; i += 1) await state().addProject(`P${i}`);
  return stub;
}

/** Wraps fetch so PATCH /api/projects/:id requests are recorded and can be held or failed. */
function watchPatches({ hold = false } = {}) {
  const inner = globalThis.fetch;
  const seen = { bodies: [], release: null };
  const gate = hold ? new Promise((resolve) => { seen.release = resolve; }) : null;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PATCH' && /^\/api\/projects\/[^/]+$/.test(new URL(url, 'http://x').pathname)) {
      seen.bodies.push(JSON.parse(init.body));
      if (gate) await gate;
    }
    return inner(url, init);
  };
  return seen;
}

test('a 2D move is optimistic, then saved to the exact plot the user picked', async () => {
  await setup();
  const seen = watchPatches({ hold: true });
  const [a] = state().projects;
  const target = { street: 7, side: 'left', slot: 3 };
  const pending = state().moveProjectToSlot(a.id, target);
  assert.deepEqual(slotOf(a.id), target, 'applied before the server answers');
  assert.deepEqual(state().projects[0].position, plotOfSlot(target), '3D reads the same position');
  seen.release();
  assert.equal(await pending, true);
  assert.deepEqual(seen.bodies[0].position, plotOfSlot(target));
  assert.deepEqual(slotOf(a.id), target);
});

test('a 3D drop still snaps to the nearest free plot and shows in that 2D slot', async () => {
  await setup();
  const [a, b] = state().projects;
  state().moveProject(a.id, ...b.position);
  assert.notDeepEqual(slotOf(a.id), slotOf(b.id));
  assert.ok(buildStreets(state().projects).flatMap((s) => [...s.sides.left, ...s.sides.right]).some((s) => s.projectId === a.id));
});

test('a move onto an occupied slot is refused locally with no request', async () => {
  await setup();
  const seen = watchPatches();
  const [a, b] = state().projects;
  const before = slotOf(a.id);
  assert.equal(await state().moveProjectToSlot(a.id, slotOf(b.id)), false);
  assert.deepEqual(slotOf(a.id), before);
  assert.equal(seen.bodies.length, 0);
});

test('a server rejection (409) reverts the card and raises a notification', async () => {
  const stub = await setup();
  const [a, b] = state().projects;
  const before = slotOf(a.id);
  const target = { street: 10, side: 'left', slot: 4 };
  // Another tab took the slot on the server first; this tab has not heard about it yet.
  stub.projects.get(b.id).position = plotOfSlot(target);
  assert.equal(await state().moveProjectToSlot(a.id, target), false);
  assert.deepEqual(slotOf(a.id), before);
  assert.match(reportedError(), /already taken/);
  noOverlap();
});

test('a server rejection (400) and a network failure also revert and notify', async () => {
  await setup();
  const [a] = state().projects;
  const before = slotOf(a.id);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (init.method === 'PATCH'
    ? new Response(JSON.stringify({ error: 'position must be one of the 240 project plots' }), { status: 400, headers: { 'content-type': 'application/json' } })
    : inner(url, init));
  assert.equal(await state().moveProjectToSlot(a.id, { street: 8, side: 'left', slot: 1 }), false);
  assert.deepEqual(slotOf(a.id), before);
  assert.match(reportedError(), /240 project plots/);

  useWorldStore.setState({ ...CLEAN_ERROR_STATE });
  globalThis.fetch = async (url, init = {}) => { if (init.method === 'PATCH') throw new TypeError('network down'); return inner(url, init); };
  assert.equal(await state().moveProjectToSlot(a.id, { street: 8, side: 'left', slot: 1 }), false);
  assert.deepEqual(slotOf(a.id), before);
  assert.ok(reportedError());
});

test('a live update for the project is not undone by an older failed move', async () => {
  await setup();
  const [a] = state().projects;
  const inner = globalThis.fetch;
  let fail;
  globalThis.fetch = async (url, init = {}) => (init.method === 'PATCH' ? new Promise((_, reject) => { fail = reject; }) : inner(url, init));
  const pending = state().moveProjectToSlot(a.id, { street: 9, side: 'left', slot: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const live = plotOfSlot({ street: 4, side: 'left', slot: 2 });
  useWorldStore.setState((s) => ({ projects: s.projects.map((p) => (p.id === a.id ? { ...p, position: live } : p)) }));
  fail(new Error('boom'));
  assert.equal(await pending, false);
  assert.deepEqual(slotOf(a.id), { street: 4, side: 'left', slot: 2 });
});

test('a slot taken by a live update after pick-up is refused on drop, and a deleted project cancels quietly', async () => {
  await setup(3);
  const seen = watchPatches();
  const [a, b, c] = state().projects;
  const target = { street: 6, side: 'left', slot: 4 };
  useWorldStore.setState((s) => ({ projects: s.projects.map((p) => (p.id === b.id ? { ...p, position: plotOfSlot(target) } : p)) }));
  assert.equal(await state().moveProjectToSlot(a.id, target), false);
  assert.equal(seen.bodies.length, 0);
  useWorldStore.setState((s) => ({ projects: s.projects.filter((p) => p.id !== c.id) }));
  assert.equal(await state().moveProjectToSlot(c.id, { street: 6, side: 'left', slot: 1 }), false);
  assert.equal(seen.bodies.length, 0);
  assert.equal(reportedError(), null);
});

test('a project created mid-drag only blocks its own plot', async () => {
  await setup();
  const [a] = state().projects;
  await state().addProject('Late');
  const created = state().projects.at(-1);
  assert.equal(await state().moveProjectToSlot(a.id, slotOf(created.id)), false);
  const free = { street: 10, side: 'left', slot: 1 };
  assert.equal(await state().moveProjectToSlot(a.id, free), true);
});

test('two tabs picking the same slot: the first wins and the second snaps back', async () => {
  const stub = await setup();
  const [a, b] = state().projects;
  const target = { street: 5, side: 'left', slot: 3 };
  assert.equal(await state().moveProjectToSlot(a.id, target), true);
  const bBefore = slotOf(b.id);
  // This tab never saw a's move: simulate the other tab's view.
  useWorldStore.setState((s) => ({ projects: s.projects.map((p) => (p.id === a.id ? { ...p, position: plotOfSlot({ street: 10, side: 'left', slot: 2 }) } : p)) }));
  assert.equal(await state().moveProjectToSlot(b.id, target), false);
  assert.deepEqual(slotOf(b.id), bBefore);
  assert.deepEqual(stub.projects.get(a.id).position, plotOfSlot(target));
});

test('I01 with all 240 slots taken a 241st project and a move are refused', async () => {
  await setup(PROJECT_CAPACITY);
  const seen = watchPatches();
  assert.equal(state().projects.length, PROJECT_CAPACITY);
  noOverlap();
  assert.equal(await state().addProject('One too many'), false);
  const [a] = state().projects;
  assert.equal(await state().moveProjectToSlot(a.id, { street: 3, side: 'left', slot: 1 }), false);
  assert.equal(seen.bodies.length, 0);
});

test('loading repairs legacy overlaps and missing positions, and saves only the changed projects once', async () => {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], ...CLEAN_ERROR_STATE });
  const spot = plotOfSlot({ street: 3, side: 'left', slot: 1 });
  for (const [id, position] of [['one', spot], ['two', spot], ['three', null], ['four', plotOfSlot({ street: 4, side: 'left', slot: 1 })]]) {
    stub.projects.set(id, { id, name: id, typeId: 'software', typeVersion: 1, status: 'idle', position, activeTaskId: null, taskCount: 0, slug: id, relativePath: id, createdAt: '', updatedAt: '' });
  }
  const seen = watchPatches();
  await state().loadProjects();
  noOverlap();
  assert.ok(state().projects.every((p) => slotOfPlot(p.position)));
  assert.deepEqual(state().projects.find((p) => p.id === 'one').position, spot);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.bodies.length, 2, 'two and three were repaired');
  assert.deepEqual(state().projects.find((p) => p.id === 'four').position, plotOfSlot({ street: 4, side: 'left', slot: 1 }));
});

test('I04 loading projects saved on the block grid moves each onto its street plot: none lost, order kept, saved once', async () => {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], ...CLEAN_ERROR_STATE });
  LEGACY_PLOTS.forEach((plot, i) => {
    stub.projects.set(`l${i}`, { id: `l${i}`, name: `l${i}`, typeId: 'software', typeVersion: 1, status: 'idle', position: [plot.x, plot.z], activeTaskId: null, taskCount: 0, slug: `l${i}`, relativePath: `l${i}`, createdAt: '', updatedAt: '' });
  });
  const seen = watchPatches();
  await state().loadProjects();
  assert.equal(state().projects.length, 32);
  noOverlap();
  LEGACY_PLOTS.forEach((_, i) => {
    const position = state().projects.find((p) => p.id === `l${i}`).position;
    assert.deepEqual(position, [nearestToCenter[i].x, nearestToCenter[i].z]);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.bodies.length, 32);
  seen.bodies.length = 0;
  await state().loadProjects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.bodies.length, 0, 'a second load changes nothing');
});

test('a rejected repair save keeps the local view overlap-free and notifies', async () => {
  const stub = installServerStub();
  useWorldStore.setState({ projects: [], ...CLEAN_ERROR_STATE });
  const spot = plotOfSlot({ street: 3, side: 'left', slot: 1 });
  for (const id of ['one', 'two']) stub.projects.set(id, { id, name: id, typeId: 'software', typeVersion: 1, status: 'idle', position: spot, activeTaskId: null, taskCount: 0, slug: id, relativePath: id, createdAt: '', updatedAt: '' });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (init.method === 'PATCH'
    ? new Response(JSON.stringify({ error: 'That plot is already taken by another project' }), { status: 409, headers: { 'content-type': 'application/json' } })
    : inner(url, init));
  await state().loadProjects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  noOverlap();
  const messages = Object.values(state().errorNotificationsById).map((n) => n.description);
  assert.ok(messages.some((m) => /already taken/.test(m)), messages.join(' | '));
});

test('the stub mirrors the server position contract: 400 for non-plots, 409 for a taken plot', async () => {
  const stub = await setup();
  const [a, b] = state().projects;
  const patch = (id, position) => fetch(`http://localhost/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ position }) });
  assert.equal((await patch(a.id, [0, 0])).status, 400);
  assert.equal((await patch(a.id, 'x')).status, 400);
  const taken = await patch(a.id, stub.projects.get(b.id).position);
  assert.equal(taken.status, 409);
  assert.ok((await taken.json()).error);
  assert.equal((await patch(a.id, plotOfSlot({ street: 10, side: 'left', slot: 4 }))).status, 200);
});

test('two quick moves of one project: a rejected second move restores the last server-confirmed slot, not the first move\'s target', async () => {
  await setup();
  const [a] = state().projects;
  const original = slotOf(a.id);
  const inner = globalThis.fetch;
  let patches = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method !== 'PATCH') return inner(url, init);
    patches += 1;
    if (patches === 2) return new Response(JSON.stringify({ error: 'nope' }), { status: 409, headers: { 'content-type': 'application/json' } });
    return inner(url, init);
  };
  const first = state().moveProjectToSlot(a.id, { street: 4, side: 'left', slot: 1 });
  const second = state().moveProjectToSlot(a.id, { street: 5, side: 'left', slot: 1 });
  assert.deepEqual(slotOf(a.id), { street: 5, side: 'left', slot: 1 }, 'optimistic');
  assert.deepEqual([await first, await second], [true, false]);
  assert.deepEqual(slotOf(a.id), { street: 4, side: 'left', slot: 1 });
  assert.notDeepEqual(slotOf(a.id), original);
});

test('two quick moves where the first is rejected: the second still lands and nothing is reverted over it', async () => {
  await setup();
  const [a] = state().projects;
  const inner = globalThis.fetch;
  let patches = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method !== 'PATCH') return inner(url, init);
    patches += 1;
    return patches === 1 ? new Response(JSON.stringify({ error: 'nope' }), { status: 409, headers: { 'content-type': 'application/json' } }) : inner(url, init);
  };
  const first = state().moveProjectToSlot(a.id, { street: 4, side: 'left', slot: 1 });
  const second = state().moveProjectToSlot(a.id, { street: 5, side: 'left', slot: 1 });
  assert.deepEqual([await first, await second], [false, true]);
  assert.deepEqual(slotOf(a.id), { street: 5, side: 'left', slot: 1 });
});

const { mergeWorkerEvent } = await import('../src/store/worldStore.ts');
const { plotOfWorld, worldOfPlot } = await import('../src/lib/villageLayout.ts');

test('I02 moving a project to a free plot on the left and on the right of a street updates its position and frees the old plot', async () => {
  await setup();
  const [a] = state().projects;
  const before = slotOf(a.id);
  for (const side of ['left', 'right']) {
    const target = { street: 5, side, slot: 3 };
    assert.equal(await state().moveProjectToSlot(a.id, target), true);
    assert.deepEqual(slotOf(a.id), target);
    assert.ok(!buildStreets(state().projects).some((s) => s.sides.left.concat(s.sides.right).some((slot) => slot.projectId === a.id && slot.ref.slot !== 3)));
  }
  assert.notDeepEqual(slotOf(a.id), before);
  const freed = buildStreets(state().projects)[before.street - 1].sides[before.side][before.slot - 1];
  assert.equal(freed.projectId, null, 'the old plot is free');
});

test('I11 a 3D drag on a right-side plot: ground point -> nearest free plot -> stored position -> the same 2D slot', async () => {
  await setup(1);
  const [a] = state().projects;
  const target = plotOfSlot({ street: 6, side: 'right', slot: 5 });
  const [wx, wz] = worldOfPlot(target);
  state().moveProject(a.id, ...plotOfWorld(wx + 0.3, wz - 0.3));
  assert.deepEqual(slotOf(a.id), { street: 6, side: 'right', slot: 5 });
  assert.deepEqual(state().projects[0].position, target);
});

test('I05 a live project event with no position gets the nearest free plot; with every plot taken it falls back without throwing', async () => {
  const stub = await setup(0);
  const event = (id) => ({ type: 'project', project: { id, name: id, typeId: 'software', typeVersion: 1, status: 'idle', position: null, activeTaskId: null, taskCount: 0, slug: id, relativePath: id, createdAt: '', updatedAt: '' } });
  const patch = mergeWorkerEvent(state(), event('fresh'));
  assert.ok(slotOfPlot(patch.projects[0].position), 'placed on a project plot');
  const full = PROJECT_PLOTS.map((plot, i) => ({ ...patch.projects[0], id: `f${i}`, position: [plot.x, plot.z] }));
  useWorldStore.setState({ projects: full });
  assert.doesNotThrow(() => mergeWorkerEvent(state(), event('overflow')));
  assert.equal(mergeWorkerEvent(state(), event('overflow')).projects.length, 241);
  assert.ok(stub);
});
