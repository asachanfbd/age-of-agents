import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs`, so "12m ago"-style labels keep moving while a view stays open. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
