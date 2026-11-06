const BASE_MS = 1000;
const CAP_MS = 15 * 60_000;

/** Exponential back-off for quota errors: doubles on each failure up to a cap and starts over after a success. */
export class Backoff {
  #failures = 0;
  next(retryAfterMs?: number): number {
    const own = Math.min(BASE_MS * 2 ** this.#failures, CAP_MS);
    this.#failures += 1;
    return Math.max(own, retryAfterMs ?? 0);
  }
  reset(): void { this.#failures = 0; }
  get failures(): number { return this.#failures; }
}
