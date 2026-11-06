import type { Accent } from './accent';

/** One series of a bar chart; a null value is "no data" (drawn as no bar, never as zero). */
export interface BarSeries { key: string; label: string; accent: Accent; dashed?: boolean }
export interface BarGroup { label: string; values: Array<number | null> }

/** The top of the value axis: the largest value rounded up to 1, 2, 5 or 10 times a power of ten; 1 for an empty or all-zero chart. */
export function niceMax(values: ReadonlyArray<number | null>): number {
  const top = Math.max(0, ...values.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (top <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(top));
  const step = [1, 2, 5, 10].find((m) => top <= m * power)!;
  return step * power;
}

/** Evenly spaced axis ticks from 0 to `max`. */
export const axisTicks = (max: number, count = 4): number[] => Array.from({ length: count + 1 }, (_, i) => (max / count) * i);

export interface BarRect { group: number; series: number; x: number; y: number; width: number; height: number; value: number }

export interface BarLayout { rects: BarRect[]; groupWidth: number; max: number }

/** Positions every bar inside a plot of the given size: groups share the width equally, bars within a group sit side by side, heights scale to `max`. */
export function barLayout(groups: readonly BarGroup[], seriesCount: number, plot: { width: number; height: number }): BarLayout {
  const max = niceMax(groups.flatMap((g) => g.values));
  const groupWidth = groups.length === 0 ? 0 : plot.width / groups.length;
  const inner = groupWidth * 0.7;
  const barWidth = seriesCount === 0 ? 0 : inner / seriesCount;
  const rects: BarRect[] = [];
  groups.forEach((group, g) => {
    group.values.forEach((value, s) => {
      if (value === null || !Number.isFinite(value)) return;
      const height = (Math.max(0, value) / max) * plot.height;
      rects.push({ group: g, series: s, x: g * groupWidth + (groupWidth - inner) / 2 + s * barWidth, y: plot.height - height, width: Math.max(0, barWidth - 4), height, value });
    });
  });
  return { rects, groupWidth, max };
}

/** The group whose column holds x (clamped to the first and last group), or null when there are none. */
export function groupAt(x: number, groupWidth: number, groupCount: number): number | null {
  if (groupCount === 0 || groupWidth <= 0) return null;
  return Math.min(groupCount - 1, Math.max(0, Math.floor(x / groupWidth)));
}

/** Groups ordered by their combined value, largest first; groups with no data at all sort last. */
export function sortByTotal(groups: readonly BarGroup[]): BarGroup[] {
  const total = (g: BarGroup) => (g.values.every((v) => v === null) ? -1 : g.values.reduce<number>((sum, v) => sum + (v ?? 0), 0));
  return [...groups].sort((a, b) => total(b) - total(a));
}

export interface Point { x: number; y: number }

/** One series as runs of consecutive points: a null value ends the run, so a gap is drawn as a gap and never as zero. Points sit at the middle of their group's column. */
export function linePoints(groups: readonly BarGroup[], series: number, plot: { width: number; height: number }, max: number): Point[][] {
  const column = groups.length === 0 ? 0 : plot.width / groups.length;
  const runs: Point[][] = [];
  let run: Point[] = [];
  groups.forEach((group, g) => {
    const value = group.values[series];
    if (value === null || value === undefined || !Number.isFinite(value)) { if (run.length) runs.push(run); run = []; return; }
    run.push({ x: g * column + column / 2, y: plot.height - (Math.max(0, value) / max) * plot.height });
  });
  if (run.length) runs.push(run);
  return runs;
}

/** A smooth SVG path through the points (Catmull-Rom turned into Béziers); one point is just a move, none is empty. */
export function smoothPath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const at = (i: number) => points[Math.min(points.length - 1, Math.max(0, i))]!;
  let d = `M${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += ` C${(p1.x + (p2.x - p0.x) / 6).toFixed(2)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(2)} ${(p2.x - (p3.x - p1.x) / 6).toFixed(2)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/** The path closed down to the baseline, for a light area fill. */
export function areaPath(points: readonly Point[], baseline: number): string {
  if (points.length < 2) return '';
  return `${smoothPath(points)} L${points[points.length - 1]!.x.toFixed(2)} ${baseline} L${points[0]!.x.toFixed(2)} ${baseline} Z`;
}
