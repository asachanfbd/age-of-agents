import { useEffect, useMemo, useState } from 'react';
import { useWorldStore } from '../store/worldStore';
import { createFooterPrPoller, summarizeFooterPrs } from './footerPullRequests';
import type { FooterPrPoller, FooterPrSummary } from './footerPullRequests';
import { prReadings } from './pullRequestReadings';

let poller: FooterPrPoller | null = null;

/** The one app-wide poller over the shared readings; created on first use with the browser's clock and page visibility. */
function footerPoller(): FooterPrPoller {
  poller ??= createFooterPrPoller({
    fetch: prReadings.fetch,
    getProjects: () => useWorldStore.getState().projects,
    environment: {
      isVisible: () => document.visibilityState === 'visible',
      onVisibilityChange(listener) {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
  });
  return poller;
}

export function refreshAllPullRequests(): void {
  footerPoller().refreshAll();
}

/** Mount once (the status footer): keeps every linked project's reading fresh while the app is open. */
export function useFooterPrPolling(): void {
  const projects = useWorldStore((s) => s.projects);
  useEffect(() => footerPoller().start(), []);
  useEffect(() => footerPoller().sync(), [projects]);
}

/** The footer's cross-project summary, recomputed when a project changes or any reading does. */
export function useFooterPrSummary(): FooterPrSummary {
  const projects = useWorldStore((s) => s.projects);
  const [version, setVersion] = useState(0);
  useEffect(() => prReadings.subscribe(() => setVersion((value) => value + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the readings' change signal
  return useMemo(() => summarizeFooterPrs(projects, prReadings.get), [projects, version]);
}
