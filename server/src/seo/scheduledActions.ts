import { randomUUID } from 'node:crypto';
import type { ProjectRecord } from '../domain/types.ts';
import type { ActionRunner } from '../scheduler/runStarter.ts';
import type { RunState } from '../scheduler/scheduler.ts';
import { SkipStartError } from '../scheduler/scheduler.ts';
import { currentRun, startCrawl } from './crawl/service.ts';
import { waitForCrawl } from './crawl/runner.ts';
import { SeoConflictError, SeoInputError, SeoRateLimitError } from './errors.ts';
import { indexNowRetryAt, NOTHING_NEW, submitToIndexNow } from './indexNow.ts';
import { runInspectionPass } from './inspection.ts';
import { SCHEDULE_ACTION_LIST } from './scheduleActionList.ts';
import { prepareScheduledReport, saveScheduledReport } from './reports.ts';
import type { Cadence } from './reports.ts';
import { trackJob } from './jobs.ts';
import { refreshSitemaps } from './sitemaps.ts';
import { latestSync, startSync, waitForSync } from './sync.ts';

/**
 * The data fetches and report saves a person can put on a schedule. `begin` is the part that can refuse (a sync already running, the
 * IndexNow limit): a refusal is a skipped run, not a failure. `begin` returns what waits for the work to finish and
 * answers with a short result note.
 */
interface ScheduleAction {
  id: string;
  begin(project: ProjectRecord): Promise<() => Promise<string>>;
}

/** Saving a report is a schedule action too: a run with nothing to report, or a period already saved, is skipped rather than failed. */
const reportAction = (id: string, cadence: Cadence): ScheduleAction => ({
  id,
  async begin(project) {
    const prepared = await prepareScheduledReport(project, cadence);
    return async () => `Saved "${(await saveScheduledReport(project, prepared)).name}"`;
  },
});

const ACTIONS: ScheduleAction[] = [
  reportAction('report-weekly', 'weekly'),
  reportAction('report-monthly', 'monthly'),
  {
    id: 'sync',
    async begin(project) {
      await startSync(project);
      return async () => {
        await waitForSync(project.id);
        const job = latestSync(project.id);
        if (job?.status === 'failed') throw new Error(job.error ?? 'The sync failed');
        return job?.status === 'cancelled' ? 'The sync was stopped' : `Synced ${job?.done ?? 0} of ${job?.total ?? 0} days`;
      };
    },
  },
  {
    id: 'sitemaps',
    async begin(project) {
      return async () => {
        const run = await trackJob(project.id, 'sitemaps', () => refreshSitemaps(project));
        const pass = await runInspectionPass(project);
        return `Read ${run.read} sitemap${run.read === 1 ? '' : 's'}; inspected ${pass.inspected} page${pass.inspected === 1 ? '' : 's'}`;
      };
    },
  },
  {
    id: 'crawl',
    async begin(project) {
      const started = await startCrawl(project);
      return async () => {
        await waitForCrawl(project.id);
        const run = await currentRun(project.id);
        if (run?.status === 'failed') throw new Error(run.error ?? 'The crawl failed');
        return run?.status === 'stopped' ? 'The crawl was stopped' : `Crawled ${run?.fetched ?? started.fetched} pages`;
      };
    },
  },
  {
    id: 'indexnow',
    async begin(project) {
      if (await indexNowRetryAt(project)) throw new SeoRateLimitError('IndexNow submissions are limited to one per minute', (await indexNowRetryAt(project))!);
      return async () => {
        try {
          const outcome = await submitToIndexNow(project, { mode: 'new-or-changed' });
          return `Sent ${outcome.total} address${outcome.total === 1 ? '' : 'es'}: ${outcome.accepted} accepted`;
        } catch (error) {
          if (error instanceof SeoInputError && error.message === NOTHING_NEW) return 'Nothing new to submit';
          throw error;
        }
      };
    },
  },
];

export const isScheduleAction = (id: unknown): id is string => typeof id === 'string' && SCHEDULE_ACTION_LIST.some((a) => a.id === id);

type Listener = (runId: string) => void;

/** Runs the actions as scheduler runs: the run id is kept in memory, and its state flows back through `onChanged`. */
export function createActionRunner(): ActionRunner {
  const states = new Map<string, RunState>();
  const listeners = new Set<Listener>();
  const set = (runId: string, state: RunState) => { states.set(runId, state); for (const l of listeners) l(runId); };
  return {
    async start({ project, actionId }) {
      const action = ACTIONS.find((a) => a.id === actionId);
      if (!action) throw new Error(`There is no scheduled action "${actionId}"`);
      let finish: () => Promise<string>;
      try {
        finish = await action.begin(project);
      } catch (error) {
        if (error instanceof SeoConflictError || error instanceof SeoRateLimitError) throw new SkipStartError(error.message);
        throw error;
      }
      const runId = `action:${randomUUID()}`;
      states.set(runId, { status: 'running', note: null });
      // The scheduler reads the state once the start returns; the work settles it afterwards.
      void finish().then(
        (note) => set(runId, { status: 'succeeded', note }),
        (error: Error) => set(runId, { status: 'failed', note: error.message }),
      );
      return { runId };
    },
    state: (runId) => states.get(runId) ?? null,
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const actionRunner = createActionRunner();
