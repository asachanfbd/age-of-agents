/**
 * One page-wide clock that moves once a minute, shared by every live relative-time label so a
 * page full of them runs a single interval. Shaped for `useSyncExternalStore`: `currentMinute`
 * keeps returning the same value until a tick, so subscribers only re-render when it changes.
 */
export const MINUTE_TICK_MS = 60_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

export const currentMinute = (): number => now;

export function subscribeMinute(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, MINUTE_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
