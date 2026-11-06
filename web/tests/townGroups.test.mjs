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
const { PROJECT_PLOTS, PROJECT_CAPACITY, LEGACY_PLOTS } = await import('../src/scene/townLayout.ts');
const nearestToCenter = PROJECT_PLOTS.map((p, index) => ({ p, index, d: Math.round((p.x ** 2 + p.z ** 2) * 1e6) })).sort((a, b) => a.d - b.d || a.index - b.index).map((e) => e.p);
const g = await import('../src/lib/townGroups.ts');

const allSlots = g.buildStreets([]).flatMap((s) => g.SIDES.flatMap((side) => s.sides[side].map((slot) => slot.ref)));
const at = (ref) => g.plotOfSlot(ref);
const project = (id, ref) => ({ id, position: ref ? at(ref) : null });
const slot = (street, side, n) => ({ street, side, slot: n });
const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const fullTown = () => allSlots.map((ref, i) => project(`p${i}`, ref));

test('U20 the 240 plots map one-to-one onto 12 streets x 2 sides x 10 slots, and slotLabel names them', () => {
  assert.equal(allSlots.length, 240);
  assert.equal(g.STREET_COUNT * g.SIDES.length * g.SLOTS_PER_SIDE, PROJECT_CAPACITY);
  const seen = new Set();
  for (const plot of PROJECT_PLOTS) {
    const ref = g.slotOfPlot([plot.x, plot.z]);
    assert.ok(ref, `plot ${plot.x},${plot.z}`);
    seen.add(g.slotLabel(ref));
  }
  assert.equal(seen.size, 240);
  assert.equal(g.slotLabel(slot(3, 'left', 4)), 'Street 3, Left, slot 4');
  assert.equal(g.slotLabel(slot(12, 'right', 10)), 'Street 12, Right, slot 10');
});

test('U08 slot -> plot -> slot round-trips for every slot, and left sits at smaller x than right on the same street', () => {
  for (const ref of allSlots) assert.deepEqual(g.slotOfPlot(at(ref)), ref);
  for (let street = 1; street <= 12; street++) assert.ok(at(slot(street, 'left', 1))[0] < at(slot(street, 'right', 1))[0]);
});

test('U09 invalid positions belong to no slot; the plot tolerance is 0.001', () => {
  for (const bad of [[NaN, 0], [Infinity, 0], [-Infinity, 1], [1e308, 1e308], [-1e308, 0], [-0, 0], [0, 0], [1, 1], null, undefined, [1], [1, 2, 3], ['3', '4']]) assert.equal(g.slotOfPlot(bad), null, JSON.stringify(bad));
  const p = at(slot(3, 'right', 2));
  assert.deepEqual(g.slotOfPlot([p[0] + 0.0005, p[1]]), slot(3, 'right', 2));
  assert.equal(g.slotOfPlot([p[0] + 0.002, p[1]]), null);
});

test('plotOfSlot rejects slots that do not exist', () => {
  for (const bad of [slot(0, 'left', 1), slot(13, 'left', 1), slot(1, 'left', 0), slot(1, 'left', 11), slot(1, 'middle', 1), slot(1.5, 'left', 1), slot(NaN, 'left', 1)]) {
    assert.throws(() => g.plotOfSlot(bad), RangeError, JSON.stringify(bad));
  }
});

test('the 2D orientation follows the default camera: slot 1 is nearest the cross road and slots run outward', () => {
  for (let street = 1; street <= 12; street++) {
    const z = (n) => at(slot(street, 'left', n))[1];
    assert.ok(Math.abs(z(1)) < Math.abs(z(2)) && Math.abs(z(9)) < Math.abs(z(10)));
    assert.equal(Math.sign(z(1)), street % 2 === 1 ? -1 : 1, 'odd streets are north (-z), even streets south (+z)');
  }
});

test('U21 buildStreets assigns occupancy, lets the first owner keep a shared plot, and ignores off-plot projects', () => {
  const streets = g.buildStreets([project('a', slot(3, 'right', 2)), project('b', slot(1, 'left', 4)), project('dup', slot(3, 'right', 2)), { id: 'off', position: [0, 0] }]);
  assert.equal(streets.length, 12);
  assert.equal(streets[2].sides.right[1].projectId, 'a');
  assert.equal(streets[0].sides.left[3].projectId, 'b');
  const empty = (list) => list.flatMap((s) => g.SIDES.flatMap((side) => s.sides[side])).filter((s) => s.projectId === null).length;
  assert.equal(empty(streets), 238);
  assert.equal(empty(g.buildStreets([])), 240);
  assert.equal(empty(g.buildStreets(fullTown())), 0);
  assert.equal(g.streetProjectCount(streets[2]), 1);
});

test('U15-U17 repairPositions moves block-grid positions onto the 32 street plots nearest City Center, keeping order; it is idempotent', () => {
  const legacy = LEGACY_PLOTS.map((plot, i) => ({ id: `l${i}`, position: [plot.x, plot.z] }));
  const changes = g.repairPositions(legacy);
  assert.equal(changes.length, 32);
  assert.equal(new Set(changes.map((c) => c.position.join())).size, 32);
  changes.forEach((change, i) => assert.ok(near(change.position, [nearestToCenter[i].x, nearestToCenter[i].z]), `legacy ${i} keeps its place in reading order`));
  const applied = legacy.map((p, i) => ({ ...p, position: changes[i].position }));
  assert.deepEqual(g.repairPositions(applied), []);
});

test('repairPositions: missing, off-plot and duplicate positions move to the nearest free plot; the first duplicate keeps its place', () => {
  const kept = project('a', slot(1, 'left', 1));
  const dup = project('b', slot(1, 'left', 1));
  const changes = g.repairPositions([kept, dup, { id: 'c', position: null }, { id: 'd', position: [0, 0] }]);
  assert.deepEqual(changes.map((c) => c.id).sort(), ['b', 'c', 'd']);
  const refs = [kept, ...changes].map((p) => g.slotOfPlot(p.position));
  assert.ok(refs.every(Boolean));
  assert.equal(new Set(refs.map(g.slotLabel)).size, 4);
});

test('repairPositions never takes a plot a later project already owns, and a legacy project does not displace a street project', () => {
  const owner = project('y', slot(1, 'left', 1));
  const legacyFirst = { id: 'l0', position: [LEGACY_PLOTS[0].x, LEGACY_PLOTS[0].z] };
  const changes = g.repairPositions([{ id: 'x', position: null }, legacyFirst, owner]);
  assert.ok(!changes.some((c) => c.id === 'y'));
  assert.ok(changes.every((c) => !near(c.position, owner.position)));
  assert.equal(changes.length, 2);
});

test('U19 repairPositions leaves overflow beyond 240 projects unplaced, and 1000 projects finish', () => {
  const projects = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, position: null }));
  const changes = g.repairPositions(projects);
  assert.equal(changes.length, 240);
  assert.equal(new Set(changes.map((c) => c.position.join())).size, 240);
});

test('U22 canDrop allows only empty, existing slots for existing projects', () => {
  const projects = [project('a', slot(1, 'left', 1)), project('b', slot(1, 'left', 2))];
  assert.equal(g.canDrop(projects, 'a', slot(2, 'right', 1)), true);
  assert.equal(g.canDrop(projects, 'a', slot(1, 'left', 2)), false);
  assert.equal(g.canDrop(projects, 'a', slot(1, 'left', 1)), false);
  assert.equal(g.canDrop(projects, 'a', null), false);
  for (const bad of [slot(0, 'left', 1), slot(13, 'left', 1), slot(1, 'left', 0), slot(1, 'left', 11), slot(1, 'up', 1), slot(1, 'left', NaN), slot(1, 'left', 1.5)]) {
    assert.equal(g.canDrop(projects, 'a', bad), false, JSON.stringify(bad));
  }
  assert.equal(g.canDrop(projects, 'missing', slot(2, 'left', 1)), false);
  const target = slot(2, 'left', 1);
  assert.equal(g.canDrop([...projects, project('c', target)], 'a', target), false, 're-evaluated against fresh projects');
});

test('dropRefusal names why a hit is refused', () => {
  const projects = [project('a', slot(1, 'left', 1)), project('b', slot(1, 'right', 2))];
  assert.equal(g.dropRefusal(projects, 'a', { kind: 'catalog' }), 'catalog');
  assert.equal(g.dropRefusal(projects, 'a', { kind: 'slot', ref: slot(1, 'right', 2) }), 'occupied');
  assert.equal(g.dropRefusal(projects, 'a', null), 'none');
  assert.equal(g.dropRefusal(projects, 'a', { kind: 'slot', ref: slot(4, 'left', 4) }), null);
});

test('U23 keyboard targets skip occupied slots, cross side and street boundaries and stop at the ends', () => {
  const projects = [project('a', slot(1, 'left', 10)), project('b', slot(1, 'right', 1)), project('c', slot(1, 'right', 2))];
  assert.deepEqual(g.nextFreeSlot(projects, 'a', slot(1, 'left', 10), 1), slot(1, 'right', 3));
  assert.deepEqual(g.nextFreeSlot(projects, 'a', slot(1, 'right', 3), -1), slot(1, 'left', 10), 'the mover\'s own slot counts as free');
  assert.deepEqual(g.nextFreeSlot(projects, 'b', slot(1, 'right', 3), -1), slot(1, 'right', 1));
  const last = slot(12, 'right', 10);
  assert.deepEqual(g.nextFreeSlot(projects, 'a', last, 1), last);
  assert.deepEqual(g.nextFreeSlot(projects, 'a', slot(1, 'left', 1), -1), slot(1, 'left', 1));
  assert.deepEqual(g.nextFreeSlot([], 'a', slot(1, 'right', 10), 1), slot(2, 'left', 1), 'crosses to the next street');
});

test('U11 keyboard with all 240 taken stays on the origin; with 239 taken the last free slot is found', () => {
  const full = fullTown();
  const origin = slot(4, 'left', 2);
  const mover = full.find((p) => near(p.position, at(origin))).id;
  assert.deepEqual(g.nextFreeSlot(full, mover, origin, 1), origin);
  assert.deepEqual(g.nextFreeSlot(full, mover, origin, -1), origin);
  const nearlyFull = full.filter((p) => p.id !== 'p239');
  assert.deepEqual(g.nextFreeSlot(nearlyFull, 'p0', slot(1, 'left', 1), 1), slot(12, 'right', 10));
});

test('U24 "Move to..." lists free slots by street and is empty when full', () => {
  const projects = [project('a', slot(1, 'left', 1)), ...allSlots.filter((r) => r.street === 2).map((r, i) => project(`s2-${i}`, r))];
  const options = g.freeSlotOptions(projects);
  assert.equal(options[0].street, 1);
  assert.equal(options[0].slots.length, 19);
  assert.ok(!options.some((o) => o.street === 2));
  assert.equal(options.length, 11);
  assert.deepEqual(g.freeSlotOptions(fullTown()), []);
});

test('U28 announcements name the slot like "Street 3, Left, slot 2, empty"', () => {
  const target = slot(3, 'left', 2);
  assert.equal(g.announce.target(target, true), 'Street 3, Left, slot 2, empty');
  assert.match(g.announce.pickedUp('Alpha', target), /Picked up Alpha from Street 3, Left, slot 2/);
  assert.equal(g.announce.dropped('Alpha', target), 'Dropped Alpha in Street 3, Left, slot 2');
  assert.match(g.announce.cancelled('Alpha', target), /Move cancelled.*Street 3, Left, slot 2/);
  assert.match(g.announce.cancelled('Alpha', null), /Move cancelled/);
  assert.match(g.announce.refused(target), /not available/);
  assert.match(g.announce.refused(null), /not a project slot/);
  assert.equal(g.announce.noFreeSlot(), 'No free slots');
});

test('moveKeyAction: Space picks up, Enter opens, and in move mode arrows retarget, Enter/Space drop, Escape cancels', () => {
  assert.equal(g.moveKeyAction(' ', false), 'pickUp');
  assert.equal(g.moveKeyAction('Enter', false), 'open');
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Escape', 'a']) assert.equal(g.moveKeyAction(key, false), null);
  assert.equal(g.moveKeyAction('ArrowRight', true), 'next');
  assert.equal(g.moveKeyAction('ArrowDown', true), 'next');
  assert.equal(g.moveKeyAction('ArrowLeft', true), 'prev');
  assert.equal(g.moveKeyAction('ArrowUp', true), 'prev');
  assert.equal(g.moveKeyAction('Enter', true), 'drop');
  assert.equal(g.moveKeyAction(' ', true), 'drop');
  assert.equal(g.moveKeyAction('Escape', true), 'cancel');
  assert.equal(g.moveKeyAction('x', true), null);
});

test('U26 hitOfElement reads slots and the Catalog from the nearest marked ancestor, and ignores gaps and malformed values', () => {
  const el = (attrs, parent = null) => ({
    hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] ?? null,
    closest: function closest() { return Object.keys(attrs).some((k) => k === 'data-slot' || k === 'data-catalog') ? this : parent?.closest(); },
  });
  for (const ref of [slot(3, 'left', 2), slot(12, 'right', 10)]) {
    const marked = el({ 'data-slot': g.slotAttributeValue(ref) });
    assert.deepEqual(g.hitOfElement(el({}, marked)), { kind: 'slot', ref });
  }
  assert.equal(g.slotAttributeValue(slot(3, 'right', 4)), '3-R-4');
  assert.deepEqual(g.hitOfElement(el({ 'data-catalog': '' })), { kind: 'catalog' });
  assert.equal(g.hitOfElement(el({})), null);
  assert.equal(g.hitOfElement(null), null);
  for (const bad of ['bad', '', '0-L-0', 'a-b-c', '3-L', '3-X-4', '3-L-4-5']) assert.equal(g.hitOfElement(el({ 'data-slot': bad })), null, bad);
});

const pressKeys = (projects, p, keys, move = null) => keys.reduce((acc, key) => {
  const step = g.stepKeyboardMove(projects, acc.move, p, key);
  return { move: step.move, messages: [...acc.messages, ...(step.message ? [step.message] : [])], drop: step.drop ?? acc.drop, handled: [...acc.handled, step.handled] };
}, { move, messages: [], drop: null, handled: [] });

test('U25 keyboard flow: Space picks up, arrows retarget with announcements, Enter drops on the chosen empty slot', () => {
  const a = { id: 'a', name: 'Alpha', position: at(slot(1, 'left', 1)) };
  const projects = [{ id: 'a', position: a.position }, project('b', slot(1, 'left', 2))];
  const result = pressKeys(projects, a, [' ', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'Enter']);
  assert.match(result.messages[0], /Picked up Alpha from Street 1, Left, slot 1/);
  assert.equal(result.messages[1], 'Street 1, Left, slot 3, empty', 'the occupied slot is skipped');
  assert.equal(result.messages[2], 'Street 1, Left, slot 4, empty');
  assert.deepEqual(result.drop, slot(1, 'left', 4));
  assert.equal(result.move, null);
  assert.ok(result.handled.every(Boolean));
});

test('U25 keyboard flow: Escape cancels, Enter outside move mode is left to open the workspace, and a drop on the origin is a cancel', () => {
  const a = { id: 'a', name: 'Alpha', position: at(slot(2, 'right', 2)) };
  const projects = [{ id: 'a', position: a.position }];
  const cancelled = pressKeys(projects, a, [' ', 'ArrowDown', 'Escape']);
  assert.equal(cancelled.move, null);
  assert.equal(cancelled.drop, null);
  assert.match(cancelled.messages.at(-1), /Move cancelled.*Street 2, Right, slot 2/);
  const open = g.stepKeyboardMove(projects, null, a, 'Enter');
  assert.deepEqual([open.handled, open.move], [false, null]);
  assert.equal(g.stepKeyboardMove(projects, null, a, 'ArrowRight').handled, false);
  const sameSlot = pressKeys(projects, a, [' ', 'Enter']);
  assert.equal(sameSlot.drop, null);
  assert.match(sameSlot.messages.at(-1), /Move cancelled/);
});

test('U25 keyboard flow: with no free slot the target stays on the origin and says so; another card\'s move and an off-plot project are ignored', () => {
  const full = fullTown();
  const p = { id: 'p3', name: 'Three', position: full[3].position };
  const result = pressKeys(full, p, [' ', 'ArrowRight']);
  assert.equal(result.messages.at(-1), 'No free slots');
  assert.deepEqual(result.move.target, result.move.from);
  const other = { id: 'p4', name: 'Four', position: full[4].position };
  assert.equal(g.stepKeyboardMove(full, result.move, other, 'ArrowRight').handled, false);
  assert.deepEqual(g.stepKeyboardMove(full, null, { id: 'x', name: 'X', position: [0, 0] }, ' ').move, null);
  assert.equal(g.stepKeyboardMove(full, result.move, p, 'x').handled, false, 'an unrelated key in move mode is left alone');
});

test('U27 pointer drag end: a release on a slot drops, off any slot is refused, and a cancel ends cleanly with no drop', () => {
  assert.deepEqual(g.finishPointerDrag({ kind: 'slot', ref: slot(2, 'left', 3) }, false), { drop: slot(2, 'left', 3), message: null });
  assert.equal(g.finishPointerDrag(null, false).drop, null);
  assert.match(g.finishPointerDrag({ kind: 'catalog' }, false).message, /not a project slot/);
  assert.deepEqual(g.finishPointerDrag({ kind: 'slot', ref: slot(2, 'left', 3) }, true), { drop: null, message: g.CANCELLED_MESSAGE });
});

test('U29 the street filter matches a project name or street number, case-insensitively, and can show only streets with projects', () => {
  const projects = [{ ...project('a', slot(3, 'left', 1)), name: 'Alpha Shop' }, { ...project('b', slot(5, 'right', 2)), name: 'Beta' }];
  const streets = g.buildStreets(projects);
  const names = new Map([['a', 'Alpha Shop'], ['b', 'Beta']]);
  const numbers = (q, only = false) => g.filterStreets(streets, names, q, only).map((s) => s.street);
  assert.equal(numbers('').length, 12);
  assert.equal(numbers('   ').length, 12);
  assert.deepEqual(numbers('ALPHA'), [3]);
  assert.deepEqual(numbers('beta'), [5]);
  assert.deepEqual(numbers('street 3'), [3]);
  assert.deepEqual(numbers('Street3'), [3]);
  assert.deepEqual(numbers('1'), [1], 'a street number matches exactly, not "10" to "12"');
  assert.deepEqual(numbers('nothing'), []);
  assert.deepEqual(numbers('', true), [3, 5]);
  assert.deepEqual(numbers('alpha', true), [3]);
});

test('U30 empty streets default to collapsed; an explicit open state wins', () => {
  const [one, two] = g.buildStreets([project('a', slot(1, 'left', 1))]);
  assert.equal(g.isStreetCollapsed(one, new Set()), false);
  assert.equal(g.isStreetCollapsed(two, new Set()), true);
  assert.equal(g.isStreetCollapsed(two, new Set([2])), false);
});

test('U31 the summary reads "N projects · 12 streets", singular for one', () => {
  assert.equal(g.projectSummary(0), '0 projects · 12 streets');
  assert.equal(g.projectSummary(1), '1 project · 12 streets');
  assert.equal(g.projectSummary(240), '240 projects · 12 streets');
});

test('U32 capacity: no warning well below the threshold, a warning at it, full only at 240 and above', () => {
  assert.equal(g.CAPACITY_WARNING_AT, 216);
  for (const count of [0, 100, 215]) assert.equal(g.capacityState(count), 'ok');
  for (const count of [216, 239]) assert.equal(g.capacityState(count), 'nearly-full');
  for (const count of [240, 241]) assert.equal(g.capacityState(count), 'full');
});
