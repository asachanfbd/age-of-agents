import { useEffect } from 'react';
import type { ErrorScope } from '../lib/errorNotifications';
import { useWorldStore } from '../store/worldStore';

/**
 * Makes the calling form the place `scope`'s action failures are shown while it is mounted, and
 * returns the latest one. Mounting clears a stale failure; once every form on the scope has
 * closed, a failure becomes a notification instead.
 */
export function useErrorScope(scope: ErrorScope): string | null {
  useEffect(() => useWorldStore.getState().openErrorScope(scope), [scope]);
  return useWorldStore((s) => s.formErrors[scope]) ?? null;
}
