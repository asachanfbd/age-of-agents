import { projectsDb } from '../db/collections.ts';
import { seoDeps } from './deps.ts';
import { runInspectionPass } from './inspection.ts';
import { readSettings } from './settings.ts';
import { syncIfDue } from './sync.ts';
import { checkOverdue } from './tasks.ts';

/** An on-open sync is skipped when the last one finished this recently. */
export const ON_OPEN_FRESH_MS = 6 * 60 * 60_000;
/** The daily timer syncs a Building whose last success is older than this. */
const DAILY_STALE_MS = 20 * 60 * 60_000;

async function lastSuccess(buildingId: string): Promise<number | null> {
  const settings = await readSettings(buildingId);
  if (!settings) return null;
  const times = (['gsc', 'ga4'] as const).flatMap((s) => (settings.connections[s].connected && settings.connections[s].lastSyncAt ? [Date.parse(settings.connections[s].lastSyncAt!)] : []));
  return times.length ? Math.min(...times) : 0;
}

/** Starts a sync when the data is older than `maxAgeMs`. Also resumes a backfill a restart interrupted, because unfinished days stay pending. */
export async function syncBuildingIfStale(buildingId: string, maxAgeMs: number): Promise<boolean> {
  const last = await lastSuccess(buildingId);
  if (last === null) return false;
  if (last > 0 && seoDeps().now().getTime() - last < maxAgeMs) return false;
  return (await syncIfDue(buildingId)) !== null;
}

/** The daily refresh for every SEO Building. The platform scheduler runs agent workflows, not code, so SEO has its own timer. */
export async function runSeoMaintenance(): Promise<void> {
  for (const project of await projectsDb.all()) {
    if (project.typeId !== 'seo') continue;
    await syncBuildingIfStale(project.id, DAILY_STALE_MS).catch((error) => console.error(`SEO sync failed to start for ${project.name}:`, error));
    // Inspection runs in the background for a long time (it waits between calls), so the loop does not wait for it.
    await checkOverdue(project).catch((error) => console.error(`SEO overdue check failed for ${project.name}:`, error));
    void runInspectionPass(project).catch((error) => console.error(`SEO URL inspection failed for ${project.name}:`, error));
  }
}

/** Runs the loop now and then on a timer. The returned stop function ends the timer and resolves once any loop already running has finished. */
export function startSeoMaintenance(intervalMs = 60 * 60_000): () => Promise<void> {
  const running = new Set<Promise<void>>();
  const run = () => {
    const loop = runSeoMaintenance().finally(() => running.delete(loop));
    running.add(loop);
    loop.catch(() => undefined);
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await Promise.allSettled(running);
  };
}
