import { useEffect, useState } from 'react';

/** The current time in epoch seconds, refreshed every 30 seconds so quota resets take effect without a reload. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
