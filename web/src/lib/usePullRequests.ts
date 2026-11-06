import { useEffect, useSyncExternalStore } from 'react';
import type { ProjectData } from '../types';
import { gitProviderOf, repositoryLinkOf } from './gitProvider';
import { startPolling } from './pullRequests';
import type { PollingEnvironment, PrReading } from './pullRequests';
import { prReadings as readings } from './pullRequestReadings';

const browserEnvironment: PollingEnvironment = {
  isVisible: () => document.visibilityState === 'visible',
  onVisibilityChange(listener) {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
};

export function usePrReading(projectId: string): PrReading {
  return useSyncExternalStore(readings.subscribe, () => readings.get(projectId));
}

/** Keeps the Project's reading fresh while the workspace is open: see `startPolling`. A Project without a recognised repository isn't fetched. */
export function usePrPolling(project: Pick<ProjectData, 'id' | 'repositoryUrl' | 'gitProvider'> | undefined): void {
  const id = project?.id;
  const provider = project ? gitProviderOf(project) : undefined;
  const hasRepository = !!project && repositoryLinkOf(project) !== null;
  useEffect(() => {
    if (!id || !provider || !hasRepository) return;
    return startPolling((force) => { void readings.fetch(id, { provider, force }); }, browserEnvironment);
  }, [id, provider, hasRepository]);
}

/** The Refresh button: bypasses the cache and shows the previous list while loading. */
export function refreshPullRequests(project: Pick<ProjectData, 'id' | 'gitProvider'>): void {
  void readings.fetch(project.id, { provider: gitProviderOf(project), force: true });
}
