/** A score as a whole-number percentage: anything out of range clamps to 0..100 and a non-number reads 0. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** The stroke offset of a ring of the given radius that shows `value` percent. */
export function ringDashOffset(value: number, radius: number): number {
  const circumference = 2 * Math.PI * radius;
  return circumference * (1 - clampScore(value) / 100);
}
