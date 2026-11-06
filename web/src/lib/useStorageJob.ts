import { useCallback, useEffect, useState } from 'react';
import { JOB_POLL_MS } from './notesWorkspace';
import { serverApi } from './serverApi';
import type { StorageJobDto } from './buildingStorage';

/** Tracks one background storage job (ingest or retention): start it, poll it every ~500 ms until it settles, cancel it. */
export function useStorageJob(projectId: string, onSettled?: () => void) {
  const [job, setJob] = useState<StorageJobDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = job?.status === 'running';
  const jobId = job?.id;

  useEffect(() => {
    if (!running || !jobId) return;
    let cancelled = false;
    const timer = setInterval(() => {
      serverApi.getStorageJob(projectId, jobId).then((next) => {
        if (cancelled) return;
        setJob(next);
        if (next.status !== 'running') onSettled?.();
      }).catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read the job'); });
    }, JOB_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [running, jobId, projectId, onSettled]);

  const start = useCallback(async (begin: () => Promise<StorageJobDto>) => {
    setError(null);
    try { setJob(await begin()); } catch (e) { setError(e instanceof Error ? e.message : 'Could not start the job'); }
  }, []);

  const cancel = useCallback(async () => {
    if (!jobId) return;
    try { setJob(await serverApi.cancelStorageJob(projectId, jobId)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not cancel the job'); }
  }, [projectId, jobId]);

  return { job, error, start, cancel };
}
