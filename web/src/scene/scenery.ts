import { yardWorldRect, type YardRect } from '../lib/villageLayout';
import {
  CROSS_ROAD_HALF_LENGTH, PROJECT_PLOTS, ROAD_WIDTH, SIDE_OFFSET, SLOT_PITCH, FIRST_SLOT, SLOTS_PER_SIDE, STREET_COUNT,
  SCENERY_BOUND, STREET_HALF_LENGTH, TOWN_SCALE, YARD_HALF_ACROSS, sideOfPlot, streetDirection, streetX,
} from './townLayout';
import { mulberry32 } from './random';

/**
 * The static scenery of the village in world units: roads, gate paths, fences, lamps, water, trees
 * and rocks. Everything is a pure function of the street layout and fixed seeds, generated once, so
 * it never changes with Projects; the scene draws each kind as one instanced mesh.
 */

const CITY_CENTER_CLEARANCE: YardRect = [-3, -3, 3, 3];
/** How far the fence stands outside the yard's rectangle, in world units. */
export const FENCE_MARGIN = 0.12;
/** The gap in the street-facing fence side, in world units. */
export const GATE_WIDTH = 1.2;
const GATE_PATH_WIDTH = 0.9;
export const FENCE_HEIGHT = 0.16;
/** Props keep this far from yards, roads and water. */
const PROP_CLEARANCE = 0.8;

const STREET_NUMBERS = Array.from({ length: STREET_COUNT }, (_, i) => i + 1);

/** Each street's road, running from the cross road to the street's end. */
export const STREET_ROADS: readonly YardRect[] = STREET_NUMBERS.map((street) => {
  const x = streetX(street);
  const end = streetDirection(street) * STREET_HALF_LENGTH;
  return [x - ROAD_WIDTH / 2, Math.min(0, end), x + ROAD_WIDTH / 2, Math.max(0, end)];
});
export const CROSS_ROAD: YardRect = [-CROSS_ROAD_HALF_LENGTH, -ROAD_WIDTH / 2, CROSS_ROAD_HALF_LENGTH, ROAD_WIDTH / 2];
export const ROADS: readonly YardRect[] = [...STREET_ROADS, CROSS_ROAD];

/** A short path from a yard's gate to the road in front of it. */
export const GATE_PATHS: readonly YardRect[] = PROJECT_PLOTS.map((plot) => {
  const x = plot.x * TOWN_SCALE;
  const z = plot.z * TOWN_SCALE;
  const towardRoad = sideOfPlot([plot.x, plot.z]) === 'left' ? 1 : -1;
  const from = x + towardRoad * (YARD_HALF_ACROSS - 0.05);
  const to = x + towardRoad * (SIDE_OFFSET - ROAD_WIDTH / 2);
  return [Math.min(from, to), z - GATE_PATH_WIDTH / 2, Math.max(from, to), z + GATE_PATH_WIDTH / 2];
});

/** A straight fence piece: its centre, its length along `alongX` (else along z) and its height. */
export interface FenceSegment { x: number; z: number; length: number; alongX: boolean; height: number }

/** The fence around every plot: four sides, the one facing the street split around a gate. */
export const FENCES: readonly FenceSegment[] = PROJECT_PLOTS.flatMap((plot) => {
  const [x0, z0, x1, z1] = yardWorldRect([plot.x, plot.z]).map((v, i) => v + (i < 2 ? -FENCE_MARGIN : FENCE_MARGIN)) as unknown as YardRect;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const segments: FenceSegment[] = [
    { x: cx, z: z0, length: x1 - x0, alongX: true, height: FENCE_HEIGHT },
    { x: cx, z: z1, length: x1 - x0, alongX: true, height: FENCE_HEIGHT },
  ];
  const sideLength = (z1 - z0 - GATE_WIDTH) / 2;
  const gateSide = sideOfPlot([plot.x, plot.z]) === 'left' ? x1 : x0;
  const backSide = sideOfPlot([plot.x, plot.z]) === 'left' ? x0 : x1;
  segments.push({ x: backSide, z: cz, length: z1 - z0, alongX: false, height: FENCE_HEIGHT });
  segments.push({ x: gateSide, z: z0 + sideLength / 2, length: sideLength, alongX: false, height: FENCE_HEIGHT });
  segments.push({ x: gateSide, z: z1 - sideLength / 2, length: sideLength, alongX: false, height: FENCE_HEIGHT });
  return segments;
});

/** Street lamps on the road's edge between yards, alternating sides every second yard boundary. */
export const LAMPS: readonly { x: number; z: number }[] = STREET_NUMBERS.flatMap((street) =>
  Array.from({ length: SLOTS_PER_SIDE / 2 }, (_, k) => ({
    x: streetX(street) + (k % 2 === 0 ? -1 : 1) * (ROAD_WIDTH / 2 + 0.12),
    z: streetDirection(street) * (FIRST_SLOT + (2 * k + 1.5) * SLOT_PITCH),
  })),
);

export interface Pond { x: number; z: number; radius: number }
/** Water in the corners of the map, clear of every street and inside the scenery bound. */
export const PONDS: readonly Pond[] = [
  { x: -43, z: 43, radius: 5.5 },
  { x: 43, z: -43, radius: 4.5 },
  { x: 44, z: 44, radius: 3 },
];

const inside = (x: number, z: number, [x0, z0, x1, z1]: YardRect, margin: number): boolean =>
  x > x0 - margin && x < x1 + margin && z > z0 - margin && z < z1 + margin;

/** The band around a street that holds its roads, yards and fences. */
const STREET_BANDS: readonly YardRect[] = STREET_NUMBERS.map((street) => {
  const x = streetX(street);
  const reach = SIDE_OFFSET + YARD_HALF_ACROSS + FENCE_MARGIN;
  return [x - reach, -STREET_HALF_LENGTH, x + reach, STREET_HALF_LENGTH];
});

/** Whether a prop at (x, z) would sit on a road, yard, fence, City Center or water. */
export function isBuiltOn(x: number, z: number): boolean {
  return STREET_BANDS.some((band) => inside(x, z, band, PROP_CLEARANCE))
    || inside(x, z, CROSS_ROAD, PROP_CLEARANCE)
    || inside(x, z, CITY_CENTER_CLEARANCE, PROP_CLEARANCE)
    || PONDS.some((pond) => Math.hypot(x - pond.x, z - pond.z) < pond.radius + 1.6 + PROP_CLEARANCE);
}

export interface Tree { x: number; z: number; scale: number; pine: boolean; tone: number }
export interface Rock { x: number; z: number; scale: number; turn: number; tone: number }

const TREE_ATTEMPTS = 3000;
const ROCK_ATTEMPTS = 500;
const SCENERY_SEED = 4242;

/** Smooth 0–1 density that gathers trees into groves instead of an even sprinkle. */
const grove = (x: number, z: number): number => 0.5 + 0.5 * Math.sin(x * 0.11 + Math.cos(z * 0.07) * 2) * Math.cos(z * 0.13 - x * 0.05);

function scatter<T>(attempts: number, seed: number, make: (x: number, z: number, rand: () => number) => T, accept: (x: number, z: number, rand: () => number) => boolean): T[] {
  const rand = mulberry32(seed);
  const out: T[] = [];
  for (let i = 0; i < attempts; i++) {
    const x = (rand() * 2 - 1) * SCENERY_BOUND;
    const z = (rand() * 2 - 1) * SCENERY_BOUND;
    if (isBuiltOn(x, z) || !accept(x, z, rand)) continue;
    out.push(make(x, z, rand));
  }
  return out;
}

export const TREES: readonly Tree[] = scatter(
  TREE_ATTEMPTS, SCENERY_SEED,
  (x, z, rand) => ({ x, z, scale: 0.8 + rand() * 0.7, pine: rand() < 0.35, tone: Math.floor(rand() * 4) }),
  (x, z, rand) => rand() < grove(x, z) ** 2,
);

export const ROCKS: readonly Rock[] = scatter(
  ROCK_ATTEMPTS, SCENERY_SEED + 1,
  (x, z, rand) => ({ x, z, scale: 0.25 + rand() * 0.45, turn: rand() * Math.PI, tone: Math.floor(rand() * 3) }),
  (_x, _z, rand) => rand() < 0.3,
);
