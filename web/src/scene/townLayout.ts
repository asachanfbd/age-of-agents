/**
 * The town's plots. A plot is a (street, side, slot) triple: streets run north-south, a street's
 * left and right sides each hold SLOTS_PER_SIDE yards facing the road, and slots are numbered
 * outward from the cross road. Streets are numbered outward from City Center, alternating between
 * the north and south halves. Stored positions are plot coordinates; the scene draws plot (x, z) at
 * (x, z) × TOWN_SCALE. Import-free so the daemon's drift test can load it (server/src/projects/townPlots.ts).
 */
export const TOWN_SCALE = 3.2;
export const STREET_COUNT = 12;
export const SLOTS_PER_SIDE = 10;
export const SIDES = ['left', 'right'] as const;
export type Side = (typeof SIDES)[number];
export const PROJECT_CAPACITY = STREET_COUNT * SIDES.length * SLOTS_PER_SIDE;

// ---- World-unit geometry of the street grid (before conversion to plot units) ----
/** Distance between neighbouring street columns. */
export const STREET_PITCH = 12;
/** Columns left to right; streets are numbered through these from the middle outward. */
const COLUMN_ORDER = [2, 3, 1, 4, 0, 5];
const COLUMN_COUNT = COLUMN_ORDER.length;
export const ROAD_WIDTH = 1.6;
/** A yard's centre lies this far from its street's centre line. */
export const SIDE_OFFSET = 3.4;
/** Spacing of yards along a street: a yard is 4.5 deep once turned to face the road, plus a fence gap. */
export const SLOT_PITCH = 4.8;
/** Distance from the cross road to the first slot's centre. */
export const FIRST_SLOT = 4.2;
/** Half of a yard's width across the street, and its length along it, in world units. */
export const YARD_HALF_ACROSS = 1.875;
export const YARD_HALF_ALONG = 2.25;
/** Half the length of a street's road. */
export const STREET_HALF_LENGTH = FIRST_SLOT + (SLOTS_PER_SIDE - 1) * SLOT_PITCH + YARD_HALF_ALONG + 0.4;
/** Half the width of the cross road's reach. */
export const CROSS_ROAD_HALF_LENGTH = ((COLUMN_COUNT - 1) / 2) * STREET_PITCH + SIDE_OFFSET + YARD_HALF_ACROSS + 0.4;
/** How far the town's roads reach from City Center on either axis, in world units: the longest road's half-length. */
export const ROAD_REACH = Math.max(STREET_HALF_LENGTH, CROSS_ROAD_HALF_LENGTH);
/** The ground runs from -WORLD_BOUND to +WORLD_BOUND on both axes: streets, then room for trees and water. */
export const WORLD_BOUND = 60;
/** Trees, rocks and water stay inside this: the ground's texture fades to transparent beyond about 43% of its width (Ground.tsx), and nothing should stand on the faded edge. */
export const SCENERY_BOUND = 50;

const round = (value: number): number => Math.round(value * 10000) / 10000;

export interface OccupiedLot { x: number; z: number }
export interface PlotRef { street: number; side: Side; slot: number }

export const CITY_POSITION: [number, number] = [0, 0];

/** World x of a street's centre line. */
export function streetX(street: number): number {
  return (COLUMN_ORDER[Math.floor((street - 1) / 2)]! - (COLUMN_COUNT - 1) / 2) * STREET_PITCH;
}
/** -1 for a street in the north half, +1 for the south half (the sign of its slots' z). */
export const streetDirection = (street: number): -1 | 1 => ((street - 1) % 2 === 0 ? -1 : 1);

/** A plot's centre in world units. */
export function worldOfRef({ street, side, slot }: PlotRef): [number, number] {
  return [
    streetX(street) + (side === 'left' ? -SIDE_OFFSET : SIDE_OFFSET),
    streetDirection(street) * (FIRST_SLOT + (slot - 1) * SLOT_PITCH),
  ];
}

export const flatIndexOfRef = ({ street, side, slot }: PlotRef): number =>
  ((street - 1) * SIDES.length + SIDES.indexOf(side)) * SLOTS_PER_SIDE + (slot - 1);

export function refOfFlatIndex(index: number): PlotRef {
  const sideIndex = Math.floor(index / SLOTS_PER_SIDE);
  return { street: Math.floor(sideIndex / SIDES.length) + 1, side: SIDES[sideIndex % SIDES.length]!, slot: (index % SLOTS_PER_SIDE) + 1 };
}

export const PROJECT_PLOTS: readonly OccupiedLot[] = Array.from({ length: PROJECT_CAPACITY }, (_, index) => {
  const [x, z] = worldOfRef(refOfFlatIndex(index));
  return { x: round(x / TOWN_SCALE), z: round(z / TOWN_SCALE) };
});

export function samePlot(a: OccupiedLot, b: OccupiedLot): boolean {
  return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.z - b.z) < 0.001;
}

/** The flat index of the plot a position stands on (within the plot tolerance), or -1. */
export function plotIndexOf(position: readonly number[] | null | undefined): number {
  if (!position || position.length !== 2) return -1;
  const [x, z] = position;
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return -1;
  return PROJECT_PLOTS.findIndex((plot) => samePlot(plot, { x, z }));
}

/** Which side of its street a position is on, or null when it is not a project plot. */
export function sideOfPlot(position: readonly number[] | null | undefined): Side | null {
  const index = plotIndexOf(position);
  return index === -1 ? null : refOfFlatIndex(index).side;
}

/** Every creation and movement uses this same bounded placement rule. */
export function nearestFreePlot(x: number, z: number, occupied: readonly OccupiedLot[]): [number, number] | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  let best: OccupiedLot | undefined;
  let distance = Infinity;
  for (const plot of PROJECT_PLOTS) {
    if (occupied.some((other) => samePlot(plot, other))) continue;
    const next = (plot.x - x) ** 2 + (plot.z - z) ** 2;
    if (next < distance) { best = plot; distance = next; }
  }
  return best ? [best.x, best.z] : null;
}

// ---- Positions saved before streets existed ----

/**
 * The 32 plots of the earlier block grid (eight 2×2 blocks around City Center), in the order the 2D
 * view listed them. Saved positions on these are moved once to the street plots nearest City Center
 * (the nearest plot for the first, and so on), so saved projects keep their relative order and stay
 * close together. None of them coincides with a street plot.
 */
const LEGACY_BLOCK_PITCH = 3.6;
const LEGACY_PLOT_OFFSET = 0.78;
export const LEGACY_PLOTS: readonly OccupiedLot[] = [-1, 0, 1].flatMap((row) => [-1, 0, 1].flatMap((col) => {
  if (row === 0 && col === 0) return [];
  return [0, 1, 2, 3].map((slot) => ({
    x: round(col * LEGACY_BLOCK_PITCH + (slot % 2 === 0 ? -1 : 1) * LEGACY_PLOT_OFFSET),
    z: round(row * LEGACY_BLOCK_PITCH + (slot < 2 ? -1 : 1) * LEGACY_PLOT_OFFSET),
  }));
}));

const LEGACY_TARGETS: readonly OccupiedLot[] = PROJECT_PLOTS
  .map((plot, index) => ({ plot, index, distance: Math.round((plot.x ** 2 + plot.z ** 2) * 1e6) }))
  .sort((a, b) => a.distance - b.distance || a.index - b.index)
  .slice(0, LEGACY_PLOTS.length)
  .map(({ plot }) => plot);

/** The street plot a saved block-grid position moves to, or null when the position is not a block-grid plot. */
export function migrateLegacyPosition(position: readonly number[] | null | undefined): [number, number] | null {
  if (!position || position.length !== 2) return null;
  const [x, z] = position;
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const index = LEGACY_PLOTS.findIndex((plot) => samePlot(plot, { x, z }));
  const target = index === -1 ? undefined : LEGACY_TARGETS[index];
  return target ? [target.x, target.z] : null;
}