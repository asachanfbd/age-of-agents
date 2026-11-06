import { getProject } from '../projects/projectService.ts';
import { seoDeps } from './deps.ts';
import { startCrawl } from './crawl/runner.ts';
import { trackJob } from './jobs.ts';
import { refreshSitemaps } from './sitemaps.ts';

const inFlight = new Map<string, Promise<void>>();
/** Buildings being deleted; a bootstrap that sees its Building here stops before it touches the Building's storage again. */
const forgotten = new Set<string>();

async function bootstrap(buildingId: string): Promise<void> {
  try {
    if (forgotten.has(buildingId)) return;
    const project = await getProject(buildingId);
    // Sitemaps come first and independently of the crawl, so they are stored even when robots.txt later refuses the crawl.
    await trackJob(buildingId, 'sitemaps', () => refreshSitemaps(project)).catch(() => undefined);
    if (forgotten.has(buildingId)) return;
    await startCrawl(project, { sitemapsChecked: true });
  } catch (error) {
    console.error(`First SEO run for ${buildingId} did not start:`, error);
  }
}

/** Fetches the new Building's sitemaps, then starts its first internal-links crawl. Never throws; callers must not await it on a request path. */
export function startFirstRun(buildingId: string): void {
  if (!seoDeps().firstRun) return;
  const run = bootstrap(buildingId).finally(() => inFlight.delete(buildingId));
  inFlight.set(buildingId, run);
}

/** Resolves when the Building's first run has fetched its sitemaps and started (or given up on) the crawl. */
export async function waitForFirstRun(buildingId: string): Promise<void> {
  await inFlight.get(buildingId);
}

/** Called first when a Building is deleted: blocks further steps of its first run and waits for the one in progress. */
export async function forgetFirstRun(buildingId: string): Promise<void> {
  forgotten.add(buildingId);
  await inFlight.get(buildingId);
}
