/**
 * Delivers async results in the order they were requested, however they resolve: each lookup starts at
 * once, but a slow earlier one can never land after (and overwrite) a newer one. A failed lookup is
 * skipped; the next one repairs the state.
 */
export function createOrderedDelivery<T>(deliver: (value: T) => void): (pending: Promise<T>) => void {
  let tail: Promise<void> = Promise.resolve();
  return (pending) => {
    // Handled now, so a rejection while an earlier lookup is still pending is not reported as unhandled.
    pending.catch(() => {});
    tail = tail.then(() => pending).then(deliver, () => { /* skipped: see above */ });
  };
}
