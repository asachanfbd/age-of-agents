/**
 * Where everything stands in the 3D village: each Project's yard (warehouse, pending dock, planning,
 * work, commands and merge-wait zones, and their slots) and how a yard stands on its street plot in
 * the world. Pure numbers, so the "never overlap" rules are unit-tested (tests/villageLayout.test.mjs).
 *
 * Yard coordinates are local to one Project, in yard units: x to the right and z toward the yard's
 * front. The +z edge faces the street: the scene turns the yard a quarter turn so its front faces
 * the road (`yardFacing`), so the same plan serves both sides of a street. The warehouse, the only
 * tall thing, stands centred on the back edge with an empty apron in front of it (the ground its
 * roof can hide); the low pending dock and planning desks flank it, the work bays and command
 * machines fill the middle, and the PR queue lines the front fence nearest the road. The scene
 * draws a yard at `YARD_SCALE` world units per yard unit.
 */

import { TOWN_SCALE, YARD_HALF_ACROSS, YARD_HALF_ALONG, sideOfPlot } from '../scene/townLayout';

export interface YardPoint { x: number; z: number }
/** An axis-aligned rectangle: [x0, z0, x1, z1] with x0 < x1 and z0 < z1. */
export type YardRect = readonly [number, number, number, number];

export const YARD_WIDTH = 18;
export const YARD_DEPTH = 15;
export const YARD_RECT: YardRect = [-YARD_WIDTH / 2, -YARD_DEPTH / 2, YARD_WIDTH / 2, YARD_DEPTH / 2];
export const YARD_SCALE = 0.25;

/** The warehouse: centred on the back edge, its front wall (+z) holding the double door. */
export const BUILDING: YardRect = [-2.6, -6.8, 2.6, -2.2];
export const BUILDING_CENTER: YardPoint = { x: (BUILDING[0] + BUILDING[2]) / 2, z: (BUILDING[1] + BUILDING[3]) / 2 };
/** The warehouse's heights in yard units: the walls stand on a plinth, and the pitched roof overhangs them and rises to a ridge along the building's width. */
export const WAREHOUSE = { plinthHeight: 0.26, wallHeight: 1.9, roofOverhang: 0.3, roofRise: 1.6 } as const;
/** The ridge's height above the ground. */
export const WAREHOUSE_RIDGE_HEIGHT = WAREHOUSE.plinthHeight + WAREHOUSE.wallHeight + WAREHOUSE.roofRise;
/** Inside the doorway, where a robot appears and disappears. */
export const DOOR: YardPoint = { x: BUILDING_CENTER.x, z: BUILDING[3] - 0.3 };
/** Just outside the doorway: every walk to or from a zone passes through here. */
export const DOOR_FRONT: YardPoint = { x: BUILDING_CENTER.x, z: -1.0 };

/** The empty walkway in front of the warehouse, full width: robots cross it, nothing stands on it. */
export const APRON: YardRect = [-8.7, BUILDING[3], 8.7, 0];
/** The walkway along the apron's front edge that every lane leaves from. */
const LANE_Z = -0.5;

export const AREAS = {
  pending: [3.4, -7.2, 8.7, -2.2],
  planning: [-8.7, -7.2, -3.4, -2.2],
  work: [-8.7, 0.2, 4.6, 5.0],
  commands: [5.0, 0.2, 8.7, 5.0],
  merge: [-8.7, 5.4, 8.7, 7.3],
} as const satisfies Record<string, YardRect>;
export type YardArea = keyof typeof AREAS;
/** The zones whose items take slots; the pending dock shows a crate stack instead. */
export type SlotArea = Exclude<YardArea, 'pending'>;
/** The zones robots walk to. */
export type WalkArea = 'work' | 'merge' | 'planning';

export const WORK_CAP = 6;
export const COMMANDS_CAP = 3;
export const MERGE_CAP = 6;
export const PLANNING_CAP = 8;

const grid = (xs: number[], zs: number[]): YardPoint[] => zs.flatMap((z) => xs.map((x) => ({ x, z })));

/**
 * Each zone's slots, cap + 1 of them: the last one is kept for the "+N more" marker. Work bays are
 * 3.8 units apart so their always-visible tags don't overlap; command machines stand staggered in
 * one column; robots in the PR queue stand 1.6 apart in one row; planning desks sit 1.7 apart.
 */
export const SLOTS: Record<SlotArea, readonly YardPoint[]> = {
  work: [...grid([-6.6, -2.8, 1.0], [1.3, 3.9]), { x: 3.5, z: 3.9 }],
  commands: [{ x: 6.2, z: 1.0 }, { x: 7.4, z: 2.6 }, { x: 6.2, z: 4.2 }, { x: 7.6, z: 4.4 }],
  merge: Array.from({ length: MERGE_CAP + 1 }, (_, i) => ({ x: -7.6 + 1.6 * i, z: 6.6 })),
  planning: grid([-8.0, -6.3, -4.6], [-6.3, -4.5, -2.7]).slice(0, PLANNING_CAP + 1),
};

/** A tag's position relative to its slot: `dx` along x, `dy` above the ground. */
export interface TagAnchor { dx: number; dy: number }

/** Estimated world width of a work-bay tag at the Home zoom (the badge is about 92px wide; see `.yard-tag` in index.css). */
export const TAG_WIDTH_UNITS = 1.4;
/** A work-bay tag floats at the robot's head height, beside it and never above it. */
const TAG_HEAD_HEIGHT = 1.1;
/** Keeps a tag placed right of the box clear of the crate. */
const TAG_BOX_CLEARANCE = 0.6;
/**
 * A work bay's tag floats right of its box, in the free space before the next bay's lane (it ends at
 * the lane), so the robot and its box stay visible. The last bay's tag ends where the "+N more" stack begins.
 */
export const WORK_TAG_ANCHOR: TagAnchor = { dx: TAG_BOX_CLEARANCE + TAG_WIDTH_UNITS / 2, dy: TAG_HEAD_HEIGHT };

/** The PR-queue tag floats above its robot. */
export const MERGE_TAG_ANCHOR: TagAnchor = { dx: 0, dy: 2.1 };

/** A command machine's tag floats above it; neighbouring machines alternate heights so their tags never overlap. */
export const machineTagLift = (slotIndex: number): number => 1.9 + (slotIndex % 2) * 0.9;

/** In a work bay the robot stands left of the box it works on, and its lane runs further left, between the bay and its neighbour. */
const ROBOT_FROM_BAY = 0.55;
const LANE_FROM_BAY = 1.8;
export const workRobotSpot = (slot: YardPoint): YardPoint => ({ x: slot.x - ROBOT_FROM_BAY, z: slot.z });
export const workBoxSpot = (slot: YardPoint): YardPoint => ({ x: slot.x + 0.3, z: slot.z });
const workLaneX = (slot: YardPoint): number => slot.x - LANE_FROM_BAY;

/** The walkway between the planning desks and the warehouse's side wall. */
const PLANNING_LANE_X = -3.2;
/** The gap between the work bays and the command machines, down to the PR queue. */
const MERGE_GAP_X = 4.8;
/** The walkway behind the PR queue, between it and the front row of work bays. */
const MERGE_LANE_Z = 5.2;

/** The walk from the doorway to a slot (the walk back is the same, reversed), along the apron and lanes and never through the warehouse. */
export function pathFromDoor(area: WalkArea, slot: YardPoint): YardPoint[] {
  if (area === 'work') {
    const lane = workLaneX(slot);
    return [DOOR, DOOR_FRONT, { x: lane, z: LANE_Z }, { x: lane, z: slot.z }, workRobotSpot(slot)];
  }
  if (area === 'merge') return [DOOR, DOOR_FRONT, { x: MERGE_GAP_X, z: LANE_Z }, { x: MERGE_GAP_X, z: MERGE_LANE_Z }, { x: slot.x, z: MERGE_LANE_Z }, slot];
  // A desk is reached from the aisle in front of its row.
  const aisle = slot.z + 0.9;
  return [DOOR, DOOR_FRONT, { x: PLANNING_LANE_X, z: DOOR_FRONT.z }, { x: PLANNING_LANE_X, z: aisle }, { x: slot.x, z: aisle }, slot];
}

/** The walk from a slot back to just outside the door: `pathFromDoor` reversed, without the doorway itself. */
export const pathToDoorFront = (area: WalkArea, slot: YardPoint): YardPoint[] => pathFromDoor(area, slot).slice(1, -1).reverse();

/** A robot standing at its work bay (`workRobotSpot`) carrying its finished box to a PR-queue slot: down the bay's lane, along behind the queue, then in. */
export function carryToMergePath(from: YardPoint, mergeSlot: YardPoint): YardPoint[] {
  const lane = from.x + ROBOT_FROM_BAY - LANE_FROM_BAY;
  return [{ x: lane, z: from.z }, { x: lane, z: MERGE_LANE_Z }, { x: mergeSlot.x, z: MERGE_LANE_Z }, mergeSlot];
}

// ---- The pending dock: a pallet stacked with one crate per pending task ----

/** Crates drawn at most: 3 wide, 2 deep, 2 layers. The badge carries the exact count. */
export const CRATE_CAP = 12;
const CRATES_PER_LAYER = 6;
const CRATES_PER_ROW = 3;
/** Centre-to-centre spacing of crates on the pallet, and one crate's height. */
const CRATE_PITCH = 0.62;
export const CRATE_HEIGHT = 0.5;
export const PALLET_HEIGHT = 0.12;
/** The pallet's centre, in the middle of the pending zone. */
export const PALLET: YardPoint = { x: 6.0, z: -4.6 };
/** The pallet's footprint. */
export const PALLET_RECT: YardRect = [
  PALLET.x - (CRATES_PER_ROW / 2) * CRATE_PITCH, PALLET.z - CRATE_PITCH, PALLET.x + (CRATES_PER_ROW / 2) * CRATE_PITCH, PALLET.z + CRATE_PITCH,
];
/** Where a robot stands to lift a crate off the stack: in front of the pallet. */
export const PICK: YardPoint = { x: PALLET.x, z: PALLET_RECT[3] + 0.8 };

/** Crate `index`'s place on the pallet: the bottom layer fills first, back row then front, so the highest index is the top crate. */
export function crateSpot(index: number): YardPoint & { y: number } {
  const layer = Math.floor(index / CRATES_PER_LAYER);
  const inLayer = index % CRATES_PER_LAYER;
  const row = Math.floor(inLayer / CRATES_PER_ROW);
  const col = inLayer % CRATES_PER_ROW;
  return {
    x: PALLET.x + (col - (CRATES_PER_ROW - 1) / 2) * CRATE_PITCH,
    z: PALLET.z + (row - 0.5) * CRATE_PITCH,
    y: PALLET_HEIGHT + layer * CRATE_HEIGHT,
  };
}

/**
 * A robot fetching a pending task's crate for a work bay: out of the door and along the apron to the
 * front of the dock (`toPick`, ending at `PICK` where it lifts the crate), then back along the apron
 * and down the bay's lane to its work spot (`toBay`).
 */
export function pickUpPath(slot: YardPoint): { toPick: YardPoint[]; toBay: YardPoint[] } {
  const lane = workLaneX(slot);
  return {
    toPick: [DOOR, DOOR_FRONT, { x: PICK.x, z: DOOR_FRONT.z }, PICK],
    toBay: [{ x: PICK.x, z: LANE_Z }, { x: lane, z: LANE_Z }, { x: lane, z: slot.z }, workRobotSpot(slot)],
  };
}

// ---- The town: street plots, each yard turned to face its street ----

export const worldOfPlot = (position: readonly [number, number]): [number, number] => [position[0] * TOWN_SCALE, position[1] * TOWN_SCALE];
/** A world ground point back in plot coordinates, for dragging (the store snaps it to the nearest free plot). */
export const plotOfWorld = (x: number, z: number): [number, number] => [x / TOWN_SCALE, z / TOWN_SCALE];

/**
 * The yard's turn about the vertical axis: a quarter turn that points its front (+z) at the street,
 * east for a left-side plot and west for a right-side one. A position that is not a plot faces east.
 */
export const yardFacing = (position: readonly [number, number]): number => (sideOfPlot(position) === 'right' ? -Math.PI / 2 : Math.PI / 2);

/** A yard-unit point as a world offset from its plot centre, after the yard's turn. */
function worldOffset(position: readonly [number, number], point: YardPoint): [number, number] {
  const turn = yardFacing(position);
  return [(point.x * Math.cos(turn) + point.z * Math.sin(turn)) * YARD_SCALE, (-point.x * Math.sin(turn) + point.z * Math.cos(turn)) * YARD_SCALE];
}

/** A Project's yard as a world rectangle around its plot: turned, so it is deeper along the street than across it. */
export function yardWorldRect(position: readonly [number, number]): YardRect {
  const [cx, cz] = worldOfPlot(position);
  return [cx - YARD_HALF_ACROSS, cz - YARD_HALF_ALONG, cx + YARD_HALF_ACROSS, cz + YARD_HALF_ALONG];
}

/** Where a Project's warehouse stands in the world: what connection lines join. */
export function buildingWorldPoint(position: readonly [number, number]): [number, number] {
  const [cx, cz] = worldOfPlot(position);
  const [dx, dz] = worldOffset(position, BUILDING_CENTER);
  return [cx + dx, cz + dz];
}

/** City Center's footprint in the world (its pavilion is 2.62 units across, scaled 1.1). */
export const CITY_CENTER_RECT: YardRect = [-1.45, -1.45, 1.45, 1.45];

// ---- Geometry helpers shared by the rules above and their tests ----

export const inRect = (p: YardPoint, r: YardRect): boolean => p.x >= r[0] && p.x <= r[2] && p.z >= r[1] && p.z <= r[3];
export const rectsOverlap = (a: YardRect, b: YardRect): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
export const growRect = (r: YardRect, by: number): YardRect => [r[0] - by, r[1] - by, r[2] + by, r[3] + by];

/** Shortest distance from `p` to the segment a–b. */
export function distanceToSegment(p: YardPoint, a: YardPoint, b: YardPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}
