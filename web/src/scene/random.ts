/**
 * Deterministic, seedable PRNG (mulberry32) used to lay out the procedural
 * terrain texture and scenery scatter (trees, rocks) the same way on
 * every mount, without pulling in an external dependency.
 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks a random element from `list` using `rand` (0-1). */
export function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)];
}
