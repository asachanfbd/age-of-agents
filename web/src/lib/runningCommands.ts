import { formatCompactDuration } from './sessionTiming';
import type { CommandRun, ContentJobDto, SeoJobDto, SeoJobKind, TestRun } from './serverApi';
import type { ProjectData } from '../types';

/**
 * The status footer's Commands group: every running command run (branch sync included), every queued or
 * running test run, and the running SEO and content jobs, across every project. One selector feeds both the
 * footer number and its list, so they always agree. Command and test runs match what blocks an app update
 * (`computeBlockingCounts`). Anything settled, and runs of a project that is no longer listed, are never included.
 */

export type RunningRowKind = 'command' | 'test' | 'seo' | 'content';

export interface RunningRow {
  /** Unique across both kinds. */
  key: string;
  kind: RunningRowKind;
  runId: string;
  projectId: string;
  name: string;
  /** "Main checkout", the task's number, its branch, or "Task working copy". */
  where: string;
  startedAt: string | null;
  startedByAgent: boolean;
  /** A test run still waiting for its turn: it shows "Queued" instead of an elapsed time and cannot be stopped from here. */
  queued?: boolean;
  /** SEO rows only: which job this is, for the tab it opens on. */
  jobKind?: SeoJobKind;
  /** SEO crawl rows only: "42 fetched, 120 queued". */
  progress?: string;
  /** A crawl, a video, image or thumbnail render or Remotion Studio can be stopped from the footer. */
  stoppable?: boolean;
  /** Content rows only: which job this is, for its Stop route. */
  contentKind?: ContentJobDto['kind'];
  /** Content render rows only: the Concept, for the video render's Stop route. */
  conceptId?: string;
  /** Image and thumbnail render rows only: their asset, for their Stop route. */
  assetId?: string;
}

export interface RunningGroup {
  projectId: string;
  projectName: string;
  rows: RunningRow[];
}

export interface RunningSources {
  projects: Pick<ProjectData, 'id' | 'name'>[];
  commandRunsById: Record<string, CommandRun>;
  testRunsById: Record<string, TestRun>;
  seoJobsById?: Record<string, SeoJobDto>;
  contentJobsById?: Record<string, ContentJobDto>;
}

export const EMPTY_RUNNING_MESSAGE = 'No running commands';
export const MAIN_CHECKOUT = 'Main checkout';
export const TASK_WORKING_COPY = 'Task working copy';

export function commandWhere(run: Pick<CommandRun, 'location'>): string {
  const location = run.location;
  if (!location || location.kind === 'main') return MAIN_CHECKOUT;
  return location.taskRef || location.branch || TASK_WORKING_COPY;
}

export function testWhere(run: Pick<TestRun, 'taskId' | 'branch'>): string {
  return run.taskId ? run.branch || TASK_WORKING_COPY : MAIN_CHECKOUT;
}

const SEO_JOB_NAMES: Record<SeoJobKind, string> = {
  crawl: 'Internal links crawl',
  sitemaps: 'Sitemap fetch',
  inspection: 'URL inspection',
  'keywords-research': 'Keyword research',
  'keywords-cluster': 'Keyword clustering',
};

export const seoJobName = (kind: SeoJobKind) => SEO_JOB_NAMES[kind];

const seoProgress = (job: SeoJobDto) => (job.progress ? `${job.progress.fetched} fetched, ${job.progress.queued} queued` : undefined);

/** Spoken and tooltip wording of the footer number. */
export const runningCommandsLabel = (count: number) => `${count} running commands`;

const startMs = (iso: string | null) => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Every running row (SEO rows included), grouped by project A–Z (ties by id), longest-running first within a project (ties by name, then id). */
const isStillRender = (job: ContentJobDto): boolean => job.kind === 'images' || job.kind === 'thumbnail';

export const CONTENT_JOB_NAMES: Record<ContentJobDto['kind'], string> = { 'remotion-setup': 'Remotion setup', render: 'Video render', images: 'Image render', thumbnail: 'Thumbnail render', 'remotion-studio': 'Remotion Studio', insights: 'Insights' };

/** "46%" for a video render, "3 of 7 images" or "2 of 3 thumbnails" for a still render, "starting…" while Remotion Studio starts. */
function contentProgress(job: ContentJobDto): string | undefined {
  if (isStillRender(job) && typeof job.done === 'number' && typeof job.total === 'number') return `${job.done} of ${job.total} ${job.kind === 'images' ? 'images' : 'thumbnails'}`;
  if (job.kind === 'remotion-studio') return job.phase === 'starting' ? 'starting…' : undefined;
  return typeof job.percent === 'number' ? `${job.percent}%` : undefined;
}

/** The Stop button's accessible name: Remotion Studio and the Insights refresh are one per Building, so they name the Building. */
export const runningStopLabel = (row: Pick<RunningRow, 'name' | 'contentKind'>, projectName: string): string => (row.contentKind === 'remotion-studio' || row.contentKind === 'insights' ? `Stop ${row.name} for ${projectName}` : `Stop ${row.name}`);

export function buildRunningGroups({ projects, commandRunsById, testRunsById, seoJobsById = {}, contentJobsById = {} }: RunningSources): RunningGroup[] {
  const rowsByProject = new Map<string, RunningRow[]>();
  const add = (row: RunningRow) => rowsByProject.set(row.projectId, [...(rowsByProject.get(row.projectId) ?? []), row]);
  for (const run of Object.values(commandRunsById)) {
    if (run.status !== 'running') continue;
    add({ key: `command:${run.id}`, kind: 'command', runId: run.id, projectId: run.projectId, name: run.commandName, where: commandWhere(run), startedAt: run.startedAt, startedByAgent: false });
  }
  for (const run of Object.values(testRunsById)) {
    if (run.status !== 'running' && run.status !== 'queued') continue;
    add({ key: `test:${run.id}`, kind: 'test', runId: run.id, projectId: run.projectId, name: `${run.suite.label}: ${run.action.label}`, where: testWhere(run), startedAt: run.startedAt, startedByAgent: run.trigger === 'agent', ...(run.status === 'queued' && { queued: true }) });
  }
  for (const job of Object.values(seoJobsById)) {
    if (job.status !== 'running') continue;
    add({ key: `seo:${job.id}`, kind: 'seo', runId: job.id, projectId: job.buildingId, name: seoJobName(job.kind), where: 'SEO Building', startedAt: job.startedAt, startedByAgent: false, jobKind: job.kind, progress: seoProgress(job), stoppable: job.kind === 'crawl' });
  }
  for (const job of Object.values(contentJobsById)) {
    if (job.status !== 'running') continue;
    const render = job.kind === 'render' || isStillRender(job);
    add({
      key: `content:${job.id}`, kind: 'content', runId: job.renderId ?? job.id, projectId: job.buildingId, name: CONTENT_JOB_NAMES[job.kind], where: 'Content Studio', startedAt: job.startedAt,
      startedByAgent: render, progress: contentProgress(job), stoppable: job.kind !== 'remotion-setup', contentKind: job.kind, conceptId: job.conceptId, ...(isStillRender(job) && { assetId: job.assetId }),
    });
  }
  return projects
    .filter((project) => rowsByProject.has(project.id))
    .sort((a, b) => compare(a.name, b.name) || a.id.localeCompare(b.id))
    .map((project) => ({
      projectId: project.id,
      projectName: project.name,
      rows: rowsByProject.get(project.id)!.sort((a, b) => startMs(a.startedAt) - startMs(b.startedAt) || compare(a.name, b.name) || a.runId.localeCompare(b.runId)),
    }));
}

export const countRunningRows = (groups: RunningGroup[]) => groups.reduce((total, group) => total + group.rows.length, 0);

/** "12s", "2m 5s", "1h 3m" since the run started; 0s for a start in the future (clock skew) or an unreadable one. */
export function runningElapsed(startedAt: string | null, now: number): string {
  const started = startMs(startedAt);
  const ms = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  return ms < 1_000 ? '0s' : formatCompactDuration(ms, { seconds: true });
}

const IN_FLIGHT = new Set(['queued', 'running']);

/**
 * Folds one project's freshly listed queued and running runs into the store's runs. A run the store already
 * knows to be settled stays settled (a late list response must not resurrect it), and a stored run
 * still marked queued or running that the daemon no longer lists is returned in `staleIds` so its real
 * outcome can be fetched (it finished while the app was disconnected).
 */
export function mergeRunningLoad<T extends { id: string; projectId: string; status: string }>(
  existing: Record<string, T>,
  listed: T[],
  projectId: string,
): { merged: Record<string, T>; staleIds: string[] } {
  const merged = { ...existing };
  for (const run of listed) {
    const known = existing[run.id];
    if (!known || IN_FLIGHT.has(known.status)) merged[run.id] = run;
  }
  const listedIds = new Set(listed.map((run) => run.id));
  const staleIds = Object.values(existing)
    .filter((run) => run.projectId === projectId && IN_FLIGHT.has(run.status) && !listedIds.has(run.id))
    .map((run) => run.id);
  return { merged, staleIds };
}

/**
 * Folds one project's listed unopened failures (the 3D village's red machines) into the store's runs.
 * A run the store already knows as settled without the flag was opened meanwhile, so a late list
 * response must not bring its red machine back; anything else takes the listed record.
 */
export function mergeUnopenedLoad<T extends { id: string; status: string; failureUnopened?: true }>(existing: Record<string, T>, listed: T[]): Record<string, T> {
  const merged = { ...existing };
  for (const run of listed) {
    const known = existing[run.id];
    if (known && known.status !== 'running' && known.status !== 'queued' && !known.failureUnopened) continue;
    merged[run.id] = run;
  }
  return merged;
}

export function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
