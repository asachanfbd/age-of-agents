import { createJobRegistry, PROGRESS_INTERVAL_MS } from '../jobs/jobRegistry.ts';
import type { TrackedJob } from '../jobs/jobRegistry.ts';
import { seoDeps } from './deps.ts';

/** The long-running SEO jobs, published so the status footer can list them without the SEO Building being open (see `jobs/jobRegistry.ts`). */
export type SeoJobKind = 'crawl' | 'sitemaps' | 'inspection' | 'keywords-research' | 'keywords-cluster';
export type SeoJobStatus = TrackedJob['status'];

export interface SeoJob extends TrackedJob {
  kind: SeoJobKind;
  /** Crawl only. */
  progress?: { fetched: number; queued: number; failed: number };
}

export interface SeoJobEvent { type: 'seoJob'; job: SeoJob }

export { PROGRESS_INTERVAL_MS };

const registry = createJobRegistry<SeoJob, SeoJobEvent>({ now: () => seoDeps().now(), event: (job) => ({ type: 'seoJob', job }) });

export const onSeoJobEvent = registry.on;
export const listRunningJobs = registry.list;

export function beginJob(input: { id?: string; buildingId: string; kind: SeoJobKind; startedAt?: string; progress?: SeoJob['progress'] }): string {
  const { progress, ...rest } = input;
  return registry.begin({ ...rest, ...(progress && { progress }) });
}

export const progressJob = (id: string, progress: NonNullable<SeoJob['progress']>): void => registry.progress(id, { progress });

export const endJob = registry.end;

/** Runs `work` as a job that ends `complete`, or `failed` when it throws. */
export async function trackJob<T>(buildingId: string, kind: SeoJobKind, work: () => Promise<T>): Promise<T> {
  const id = beginJob({ buildingId, kind });
  try {
    const result = await work();
    endJob(id, 'complete');
    return result;
  } catch (error) {
    endJob(id, 'failed', (error as Error).message);
    throw error;
  }
}
