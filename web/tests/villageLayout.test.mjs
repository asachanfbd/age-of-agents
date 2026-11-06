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

const layout = await import('../src/lib/villageLayout.ts');
const {
  AREAS, SLOTS, WAREHOUSE, WAREHOUSE_RIDGE_HEIGHT, BUILDING, BUILDING_CENTER, DOOR, DOOR_FRONT, YARD_RECT, WORK_CAP, COMMANDS_CAP, MERGE_CAP, PLANNING_CAP, workRobotSpot, workBoxSpot, pathFromDoor, pathToDoorFront,
  APRON, CRATE_CAP, CRATE_HEIGHT, PALLET, PALLET_HEIGHT, PALLET_RECT, PICK, crateSpot, pickUpPath, carryToMergePath,
  worldOfPlot, plotOfWorld, yardWorldRect, CITY_CENTER_RECT, buildingWorldPoint, yardFacing, inRect, rectsOverlap, growRect, distanceToSegment,
} = layout;
const { PROJECT_PLOTS, TOWN_SCALE, nearestFreePlot, flatIndexOfRef } = await import('../src/scene/townLayout.ts');
const { repairPositions } = await import('../src/lib/townGroups.ts');
const { DEFAULT_VIEW } = await import('../src/scene/defaultView.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');

const orient = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const segmentsCross = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;

const ZONES = ['pending', 'planning', 'work', 'commands', 'merge'];
const slotAreas = ['work', 'commands', 'merge', 'planning'];
const walkAreas = ['work', 'merge', 'planning'];
const FOOTPRINT = 0.6;
const caps = { work: WORK_CAP, commands: COMMANDS_CAP, merge: MERGE_CAP, planning: PLANNING_CAP };
const crateSpots = Array.from({ length: CRATE_CAP }, (_, i) => crateSpot(i));
/** Every leg of `path` stays out of the warehouse: no leg crosses a wall and no leg lies inside it. */
function clearOfRect(path, rect) {
  const corners = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]].map(([x, z]) => ({ x, z }));
  for (let i = 0; i < path.length - 1; i++) {
    if (inRect(path[i], rect) && inRect(path[i + 1], rect)) return false;
    for (let k = 0; k < 4; k++) if (segmentsCross(path[i], path[i + 1], corners[k], corners[(k + 1) % 4])) return false;
  }
  return true;
}
const legs = (path) => path.slice(0, -1).map((point, i) => [point, path[i + 1]]);

test('L01 the zones are exactly pending, planning, work, commands and merge: inside the yard, disjoint, clear of the warehouse', () => {
  assert.deepEqual(Object.keys(AREAS).sort(), [...ZONES].sort());
  for (const zone of ZONES) {
    const r = AREAS[zone];
    assert.ok(inRect({ x: r[0], z: r[1] }, YARD_RECT) && inRect({ x: r[2], z: r[3] }, YARD_RECT), `${zone} inside the yard`);
    assert.ok(!rectsOverlap(growRect(BUILDING, FOOTPRINT), r), `${zone} a footprint clear of the warehouse`);
  }
  for (let i = 0; i < ZONES.length; i++) for (let j = i + 1; j < ZONES.length; j++) assert.ok(!rectsOverlap(AREAS[ZONES[i]], AREAS[ZONES[j]]), `${ZONES[i]} / ${ZONES[j]}`);
  assert.ok(inRect({ x: BUILDING[0], z: BUILDING[1] }, YARD_RECT) && inRect({ x: BUILDING[2], z: BUILDING[3] }, YARD_RECT), 'the warehouse is inside the yard');
});

test('L02 the warehouse is centred on the back edge and keeps its footprint (5.2 × 4.6)', () => {
  assert.equal(BUILDING_CENTER.x, 0);
  assert.ok(BUILDING_CENTER.z < 0 && BUILDING[1] - YARD_RECT[1] < 1, 'against the back edge');
  assert.ok(Math.abs(BUILDING[2] - BUILDING[0] - 5.2) < 1e-9 && Math.abs(BUILDING[3] - BUILDING[1] - 4.6) < 1e-9);
});

test('L03 the apron runs full width straight in front of the warehouse, with no slot or crate inside it', () => {
  assert.equal(APRON[1], BUILDING[3]);
  assert.ok(APRON[0] <= AREAS.planning[0] && APRON[2] >= AREAS.pending[2], 'full width');
  for (const area of slotAreas) for (const slot of SLOTS[area]) assert.ok(!inRect(slot, APRON), `${area} slot in the apron`);
  for (const spot of crateSpots) assert.ok(!inRect(spot, APRON));
  for (const zone of ZONES) assert.ok(!rectsOverlap(AREAS[zone], APRON), `${zone} overlaps the apron`);
});

test('L04 the apron is at least as deep as the ground the roof can hide at the Home view', () => {
  const [px, py, pz] = DEFAULT_VIEW.position;
  const [tx, ty, tz] = DEFAULT_VIEW.target;
  const horizontal = Math.hypot(px - tx, pz - tz);
  const pitch = Math.atan2(py - ty, horizontal);
  const shadowAlongZ = (WAREHOUSE_RIDGE_HEIGHT / Math.tan(pitch)) * ((pz - tz) / horizontal);
  assert.ok(APRON[3] - BUILDING_CENTER.z >= shadowAlongZ, 'from the ridge line to the apron\'s front edge');
});

test('L05 planning sits left (−x) of the warehouse and the pending dock right (+x), both behind the apron', () => {
  assert.ok(AREAS.planning[2] < BUILDING[0] && AREAS.pending[0] > BUILDING[2]);
  assert.ok(AREAS.planning[3] <= APRON[1] && AREAS.pending[3] <= APRON[1]);
});

test('L06 work is the middle band, commands its right column, and the PR queue the front strip', () => {
  assert.ok(AREAS.work[1] >= APRON[3] && AREAS.commands[1] >= APRON[3]);
  assert.ok(AREAS.commands[0] >= AREAS.work[2], 'commands right of work');
  const frontOfWork = Math.max(...[...SLOTS.work, ...SLOTS.commands].map((slot) => slot.z));
  for (const slot of SLOTS.merge) assert.ok(slot.z > frontOfWork);
});

test('L07 caps: work 6, commands 3, merge 6, planning 8, crates 12; each slot list has cap + 1 entries', () => {
  assert.deepEqual([WORK_CAP, COMMANDS_CAP, MERGE_CAP, PLANNING_CAP, CRATE_CAP], [6, 3, 6, 8, 12]);
  for (const area of slotAreas) assert.equal(SLOTS[area].length, caps[area] + 1, area);
});

test('L08 work bays keep their tags apart; machines, queue robots and desks are at least a footprint apart', () => {
  const minimum = { work: 2.4, commands: 1.2, merge: 1.2, planning: 1.2 };
  for (const area of slotAreas) {
    const slots = SLOTS[area];
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
      const apart = Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z);
      assert.ok(apart >= minimum[area], `${area} ${i}/${j}: ${apart}`);
    }
  }
  const rowOf = (z) => SLOTS.work.slice(0, -1).filter((slot) => slot.z === z).map((slot) => slot.x);
  for (const z of new Set(SLOTS.work.slice(0, -1).map((slot) => slot.z))) {
    const xs = rowOf(z);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 3.6, 'tag spacing in a row');
  }
});

test('L09 every slot is inside its own zone, and a work bay\'s robot and box too', () => {
  for (const area of slotAreas) for (const slot of SLOTS[area]) assert.ok(inRect(slot, AREAS[area]), `${area} ${JSON.stringify(slot)}`);
  for (const slot of SLOTS.work) assert.ok(inRect(workRobotSpot(slot), AREAS.work) && inRect(workBoxSpot(slot), AREAS.work));
  assert.ok(inRect(PALLET, AREAS.pending) && inRect(PICK, AREAS.pending));
});

test('L10 every walk from the door starts at DOOR, passes DOOR_FRONT, stays clear of the warehouse and crosses no other slot', () => {
  assert.ok(inRect(DOOR, BUILDING) && !inRect(DOOR_FRONT, BUILDING) && DOOR.x === BUILDING_CENTER.x);
  const others = (area, slot) => slotAreas.flatMap((a) => SLOTS[a].filter((other) => !(a === area && other === slot)));
  for (const area of walkAreas) {
    for (const slot of SLOTS[area]) {
      const path = pathFromDoor(area, slot);
      assert.deepEqual([path[0], path[1]], [DOOR, DOOR_FRONT]);
      assert.ok(clearOfRect(path.slice(1), BUILDING), `${area} walk crosses the warehouse`);
      for (const [a, b] of legs(path.slice(1, -1))) for (const other of others(area, slot)) {
        assert.ok(distanceToSegment(other, a, b) >= FOOTPRINT, `${area} (${slot.x}, ${slot.z}) passes (${other.x}, ${other.z})`);
      }
      assert.deepEqual(pathToDoorFront(area, slot).at(-1), DOOR_FRONT, 'the walk back ends outside the door');
    }
  }
});

test('L11 a pick-up walk goes door → door front → the dock → the lane → the bay, clear of the warehouse and the pallet', () => {
  for (const slot of SLOTS.work.slice(0, WORK_CAP)) {
    const { toPick, toBay } = pickUpPath(slot);
    assert.deepEqual([toPick[0], toPick[1], toPick.at(-1), toBay.at(-1)], [DOOR, DOOR_FRONT, PICK, workRobotSpot(slot)]);
    const whole = [...toPick, ...toBay];
    assert.ok(clearOfRect(whole.slice(1), BUILDING));
    assert.ok(clearOfRect(whole, PALLET_RECT), 'never walks over the pallet');
    assert.ok(!inRect(PICK, PALLET_RECT) && PICK.z - PALLET_RECT[3] <= 1, 'it stands just in front of the stack');
  }
});

test('L12 every work bay → PR-queue carry walk keeps a footprint from the other bays and queue robots', () => {
  const bays = SLOTS.work.slice(0, WORK_CAP);
  for (const bay of bays) for (const slot of SLOTS.merge.slice(0, MERGE_CAP)) {
    const from = workRobotSpot(bay);
    const path = [from, ...carryToMergePath(from, slot)];
    for (const [a, b] of legs(path)) {
      for (const other of bays.filter((o) => o !== bay)) for (const spot of [workRobotSpot(other), workBoxSpot(other)]) assert.ok(distanceToSegment(spot, a, b) >= 1, `bay (${bay.x}, ${bay.z}) → (${slot.x}) passes a bay`);
      for (const other of SLOTS.merge.filter((o) => o !== slot)) assert.ok(distanceToSegment(other, a, b) >= 1.2, `passes queue robot (${other.x})`);
      for (const machine of SLOTS.commands) assert.ok(distanceToSegment(machine, a, b) >= 1.2);
    }
  }
});

test('S10 crate spots: 12 unique places, 3 × 2 × 2, inside the pending zone, below the walls; bottom first, top crate last', () => {
  assert.equal(new Set(crateSpots.map((c) => `${c.x}:${c.z}:${c.y}`)).size, 12);
  assert.equal(new Set(crateSpots.map((c) => c.x)).size, 3);
  assert.equal(new Set(crateSpots.map((c) => c.z)).size, 2);
  assert.equal(new Set(crateSpots.map((c) => c.y)).size, 2);
  for (const c of crateSpots) assert.ok(inRect(c, AREAS.pending) && inRect(c, PALLET_RECT));
  assert.ok(Math.max(...crateSpots.map((c) => c.y)) + CRATE_HEIGHT < WAREHOUSE.plinthHeight + WAREHOUSE.wallHeight, 'below the wall height');
  assert.ok(crateSpots.slice(0, 6).every((c) => c.y === PALLET_HEIGHT), 'the bottom layer fills first');
  assert.equal(crateSpots.at(-1).y, Math.max(...crateSpots.map((c) => c.y)));
});

test('L14 at the Home view, on both street sides, no work, command or queue slot is hidden behind the warehouse', () => {
  const [px, py, pz] = DEFAULT_VIEW.position;
  const [tx, ty, tz] = DEFAULT_VIEW.target;
  const horizontal = Math.hypot(px - tx, pz - tz);
  const toCamera = { x: (px - tx) / horizontal, z: (pz - tz) / horizontal, slope: (py - ty) / horizontal };
  const eave = WAREHOUSE.plinthHeight + WAREHOUSE.wallHeight;
  const halfSpan = (BUILDING[3] - BUILDING[1]) / 2 + WAREHOUSE.roofOverhang;
  const solidHeight = (x, z) => {
    if (x < BUILDING[0] - WAREHOUSE.roofOverhang || x > BUILDING[2] + WAREHOUSE.roofOverhang) return 0;
    const across = Math.abs(z - BUILDING_CENTER.z);
    if (across > halfSpan) return 0;
    return eave + WAREHOUSE.roofRise * (1 - across / halfSpan);
  };
  // A point half a robot up is hidden when the sight line from it toward the camera passes under the roof or walls.
  const hidden = (point, dir) => {
    for (let d = 0; d < 20; d += 0.05) if (solidHeight(point.x + dir.x * d, point.z + dir.z * d) >= 0.5 + toCamera.slope * d) return true;
    return false;
  };
  const sides = ['left', 'right'].map((side) => {
    const plot = PROJECT_PLOTS[flatIndexOfRef({ street: 1, side, slot: 1 })];
    const t = yardFacing([plot.x, plot.z]);
    // The camera's ground direction in yard coordinates (the inverse of the yard's turn).
    return { side, dir: { x: toCamera.x * Math.cos(t) - toCamera.z * Math.sin(t), z: toCamera.x * Math.sin(t) + toCamera.z * Math.cos(t) } };
  });
  for (const { side, dir } of sides) {
    for (const area of ['work', 'commands', 'merge']) for (const slot of SLOTS[area]) assert.ok(!hidden(slot, dir), `${side} ${area} (${slot.x}, ${slot.z}) hidden by the roof`);
  }
  const hugging = [{ x: 0, z: BUILDING[3] + 0.2 }, { x: BUILDING[2] + 0.2, z: BUILDING_CENTER.z }, { x: 0, z: BUILDING[1] - 0.2 }];
  assert.ok(sides.some(({ dir }) => hugging.some((point) => hidden(point, dir))), 'the check does find ground the warehouse hides');
});

test('U105 all 240 plots map to world yards that never overlap each other or City Center', () => {
  assert.equal(PROJECT_PLOTS.length, 240);
  const rects = PROJECT_PLOTS.map((plot) => yardWorldRect([plot.x, plot.z]));
  for (let i = 0; i < rects.length; i++) {
    assert.ok(!rectsOverlap(growRect(rects[i], 0.2), CITY_CENTER_RECT), `plot ${i} vs City Center`);
    for (let j = i + 1; j < rects.length; j++) assert.ok(!rectsOverlap(growRect(rects[i], 0.2), rects[j]), `plots ${i}/${j}`);
  }
  PROJECT_PLOTS.forEach((plot, i) => {
    const [bx, bz] = buildingWorldPoint([plot.x, plot.z]);
    assert.ok(inRect({ x: bx, z: bz }, rects[i]), `connection lines join warehouses inside their yards (plot ${i})`);
  });
});

test('L13 (U13/U14) a yard faces its street: a quarter turn east for left plots and west for right plots, the warehouse door pointing at the road', () => {
  const left = PROJECT_PLOTS[flatIndexOfRef({ street: 1, side: 'left', slot: 1 })];
  const right = PROJECT_PLOTS[flatIndexOfRef({ street: 1, side: 'right', slot: 1 })];
  assert.ok(Math.abs(yardFacing([left.x, left.z]) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(yardFacing([right.x, right.z]) + Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(yardFacing([left.x, left.z]) - yardFacing([right.x, right.z])) - Math.PI) < 1e-9, 'a half turn apart');
  // The door front (yard +z) turned by the facing points at the street: east of a left plot, west of a right plot.
  const turned = (plot, point) => {
    const t = yardFacing([plot.x, plot.z]);
    return [point.x * Math.cos(t) + point.z * Math.sin(t), -point.x * Math.sin(t) + point.z * Math.cos(t)];
  };
  assert.ok(turned(left, DOOR_FRONT)[0] > turned(left, BUILDING_CENTER)[0]);
  assert.ok(turned(right, DOOR_FRONT)[0] < turned(right, BUILDING_CENTER)[0]);
  assert.equal(yardFacing([0, 0]), Math.PI / 2, 'a position that is not a plot faces east');
  const [wx, wz] = worldOfPlot([left.x, left.z]);
  const [bx, bz] = buildingWorldPoint([left.x, left.z]);
  assert.ok(Number.isFinite(bx) && Number.isFinite(bz) && Math.hypot(bx - wx, bz - wz) < 2.5, 'the warehouse stands in the yard corner');
});

test('U106 a plot maps to its world origin and back, so the stored plot (and the cards view slot) is unchanged', () => {
  for (const plot of PROJECT_PLOTS) {
    const world = worldOfPlot([plot.x, plot.z]);
    assert.deepEqual(world, [plot.x * TOWN_SCALE, plot.z * TOWN_SCALE]);
    const back = plotOfWorld(...world);
    assert.ok(Math.abs(back[0] - plot.x) < 1e-9 && Math.abs(back[1] - plot.z) < 1e-9, 'the stored plot (and so the cards view slot) is unchanged');
  }
});

test('U107 an off-grid or invalid saved position is repaired to the nearest free plot', () => {
  const projects = [
    { id: 'a', position: [0.1, 4.0] },
    { id: 'b', position: [Number.NaN, 1] },
    { id: 'c', position: [Number.POSITIVE_INFINITY, 0] },
    { id: 'd', position: [1e308, 1e308] },
    { id: 'e', position: null },
  ];
  const repairs = repairPositions(projects);
  const plots = new Set(PROJECT_PLOTS.map((p) => `${p.x}:${p.z}`));
  assert.ok(repairs.length >= 4);
  for (const { position } of repairs) assert.ok(plots.has(`${position[0]}:${position[1]}`), JSON.stringify(position));
});

test('U108 dragging: a world point snaps to the nearest free plot; past the edge is clamped; occupied plots are skipped', () => {
  const target = PROJECT_PLOTS[5];
  const [wx, wz] = worldOfPlot([target.x, target.z]);
  assert.deepEqual(nearestFreePlot(...plotOfWorld(wx + 0.3, wz - 0.2), []), [target.x, target.z]);
  const far = nearestFreePlot(...plotOfWorld(1000, 1000), []);
  assert.ok(PROJECT_PLOTS.some((p) => p.x === far[0] && p.z === far[1]), 'beyond the world edge lands on an edge plot');
  const skipped = nearestFreePlot(target.x, target.z, [{ x: target.x, z: target.z }]);
  assert.notDeepEqual(skipped, [target.x, target.z]);
});

test('U108 the store\'s moveProject snaps a dragged yard to the nearest free plot', async () => {
  installServerStub();
  useWorldStore.setState({ projects: [] });
  await useWorldStore.getState().addProject('Drag me');
  const project = useWorldStore.getState().projects.at(-1);
  const target = PROJECT_PLOTS.find((p) => p.x !== project.position[0] || p.z !== project.position[1]);
  const [wx, wz] = worldOfPlot([target.x, target.z]);
  useWorldStore.getState().moveProject(project.id, ...plotOfWorld(wx + 0.4, wz + 0.4));
  assert.deepEqual(useWorldStore.getState().projects.find((p) => p.id === project.id).position, [target.x, target.z]);
});

test('U109 two saved positions on the same plot: the second is repaired, so no two yards overlap', () => {
  const plot = PROJECT_PLOTS[3];
  const repairs = repairPositions([{ id: 'a', position: [plot.x, plot.z] }, { id: 'b', position: [plot.x, plot.z] }]);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].id, 'b');
  assert.notDeepEqual(repairs[0].position, [plot.x, plot.z]);
});

test('U35 the warehouse roof: positive dimensions, the ridge above the eaves, and a roof that overhangs the walls symmetrically', () => {
  for (const [name, value] of Object.entries(WAREHOUSE)) assert.ok(value > 0, name);
  assert.ok(WAREHOUSE.roofRise > 0);
  assert.equal(WAREHOUSE_RIDGE_HEIGHT, WAREHOUSE.plinthHeight + WAREHOUSE.wallHeight + WAREHOUSE.roofRise);
  assert.ok(WAREHOUSE_RIDGE_HEIGHT > WAREHOUSE.plinthHeight + WAREHOUSE.wallHeight, 'the ridge is higher than the walls');
  const [x0, z0, x1, z1] = BUILDING;
  assert.ok(x1 - x0 > 0 && z1 - z0 > 0);
  assert.ok(WAREHOUSE.roofOverhang < (z1 - z0) / 2, 'the overhang is smaller than the half-depth, so the pitch stays steep');
});
