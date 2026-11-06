/**
 * The 240 plots Projects can stand on. Mirrors web/src/scene/townLayout.ts (a drift test keeps the
 * two equal): twelve north-south streets, each with ten yards on its left and on its right, plus the
 * 32 block-grid plots of earlier versions, which `migrateLegacyPlot` maps onto the street plots nearest City Center.
 */
const TOWN_SCALE = 3.2;
const STREET_COUNT = 12;
const SIDE_COUNT = 2;
const SLOTS_PER_SIDE = 10;
const STREET_PITCH = 12;
const COLUMN_ORDER = [2, 3, 1, 4, 0, 5];
const SIDE_OFFSET = 3.4;
const SLOT_PITCH = 4.8;
const FIRST_SLOT = 4.2;
const LEGACY_BLOCK_PITCH = 3.6;
const LEGACY_PLOT_OFFSET = 0.78;
const PLOT_TOLERANCE = 0.001;

export type Plot = [number, number];

const round = (value: number): number => Math.round(value * 10000) / 10000;

export const PROJECT_PLOTS: readonly Plot[] = Array.from({ length: STREET_COUNT * SIDE_COUNT * SLOTS_PER_SIDE }, (_, index): Plot => {
  const sideIndex = Math.floor(index / SLOTS_PER_SIDE);
  const street = Math.floor(sideIndex / SIDE_COUNT);
  const slot = index % SLOTS_PER_SIDE;
  const column = COLUMN_ORDER[Math.floor(street / 2)]! - (COLUMN_ORDER.length - 1) / 2;
  const x = column * STREET_PITCH + (sideIndex % SIDE_COUNT === 0 ? -SIDE_OFFSET : SIDE_OFFSET);
  const z = (street % 2 === 0 ? -1 : 1) * (FIRST_SLOT + slot * SLOT_PITCH);
  return [round(x / TOWN_SCALE), round(z / TOWN_SCALE)];
});

const LEGACY_PLOTS: readonly Plot[] = [-1, 0, 1].flatMap((row) => [-1, 0, 1].flatMap((col) => {
  if (row === 0 && col === 0) return [];
  return [0, 1, 2, 3].map((slot): Plot => [
    round(col * LEGACY_BLOCK_PITCH + (slot % 2 === 0 ? -1 : 1) * LEGACY_PLOT_OFFSET),
    round(row * LEGACY_BLOCK_PITCH + (slot < 2 ? -1 : 1) * LEGACY_PLOT_OFFSET),
  ]);
}));

/** The plots a block-grid position moves to: the 32 nearest City Center, nearest first (ties by plot order). */
const LEGACY_TARGETS: readonly Plot[] = PROJECT_PLOTS
  .map((plot, index) => ({ plot, index, distance: Math.round((plot[0] ** 2 + plot[1] ** 2) * 1e6) }))
  .sort((a, b) => a.distance - b.distance || a.index - b.index)
  .slice(0, LEGACY_PLOTS.length)
  .map(({ plot }) => plot);

export function samePlot(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < PLOT_TOLERANCE && Math.abs(a[1] - b[1]) < PLOT_TOLERANCE;
}

const isPair = (position: unknown): position is [number, number] =>
  Array.isArray(position) && position.length === 2 && position.every((value) => typeof value === 'number' && Number.isFinite(value));

/** The exact project plot a client-sent position refers to, or null when it is malformed or not a project plot. */
export function resolveProjectPlot(position: unknown): Plot | null {
  if (!isPair(position)) return null;
  return PROJECT_PLOTS.find((plot) => samePlot(plot, position)) ?? null;
}

/** The street plot standing in for a block-grid position saved by an earlier version, or null for any other position. */
export function migrateLegacyPlot(position: unknown): Plot | null {
  if (!isPair(position)) return null;
  const index = LEGACY_PLOTS.findIndex((plot) => samePlot(plot, position));
  return index === -1 ? null : LEGACY_TARGETS[index] ?? null;
}
