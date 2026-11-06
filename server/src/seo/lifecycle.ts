import type { CreateInput, RetentionPlan } from '../buildings/contract.ts';

/**
 * The Building type's hooks, loaded lazily: the type definition is imported by the storage layer, and the SEO runtime
 * imports the storage layer, so a direct import would be circular.
 */
export const seoLifecycle = {
  async created(buildingId: string, input: CreateInput): Promise<void> {
    const { createSettings } = await import('./settings.ts');
    await createSettings(buildingId, String(input.siteUrl));
    const { startFirstRun } = await import('./firstRun.ts');
    startFirstRun(buildingId);
  },
  async deleting(buildingId: string): Promise<void> {
    const { forgetFirstRun } = await import('./firstRun.ts');
    await forgetFirstRun(buildingId);
    const { stopSync } = await import('./sync.ts');
    await stopSync(buildingId);
    const [{ stopInspection }, { clearRuns }, { forgetSitemapState }, { forgetIndexNowState }, { forgetBingState }, { forgetKeywordRuns }, { forgetCrawl }, { forgetSnapshots }, { forgetTasks }, { forgetReports }] = await Promise.all([
      import('./inspection.ts'), import('./runCoalescer.ts'), import('./sitemaps.ts'), import('./indexNow.ts'), import('./sitemapUrls.ts'), import('./keywordRuns.ts'), import('./crawl/runner.ts'), import('./crawl/store.ts'), import('./taskStore.ts'), import('./reports.ts'),
    ]);
    await stopInspection(buildingId);
    clearRuns(buildingId);
    forgetSitemapState(buildingId);
    forgetIndexNowState(buildingId);
    forgetBingState(buildingId);
    forgetKeywordRuns(buildingId);
    await forgetCrawl(buildingId);
    forgetSnapshots(buildingId);
    forgetTasks(buildingId);
    forgetReports(buildingId);
  },
  async retentionPlan(buildingId: string): Promise<RetentionPlan> {
    const { retentionPlan } = await import('./dataStatus.ts');
    return retentionPlan(buildingId);
  },
};
