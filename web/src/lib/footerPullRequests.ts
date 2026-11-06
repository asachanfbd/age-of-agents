import type { ProjectData } from '../types';
import { gitProviderOf, repositoryLinkOf } from './gitProvider';
import { POLL_INTERVAL_MS, branchLabel, prViewState, relativeCheckTime } from './pullRequests';
import type { PrReading, PullRequest } from './pullRequests';

/**
 * The status footer's PRs group: open pull requests across every Project with a linked repository,
 * read from the same per-Project readings the PR tab uses. Pure, so the footer number, its list and
 * the tests share one selector; `createFooterPrPoller` keeps the readings fresh.
 */

export const EMPTY_PRS_MESSAGE = 'No open pull requests';
/** Rows shown per project before a "+N more" row. */
export const MAX_ROWS_PER_PROJECT = 50;
/** The popover notes a "last checked" time older than this. */
export const STALE_AFTER_MS = 5 * 60_000;

export type FooterPrProject = Pick<ProjectData, 'id' | 'name' | 'repositoryUrl' | 'gitProvider'>;

/** Projects whose open PRs can be listed: a recognised repository on their Git provider. */
export function eligibleProjects<T extends FooterPrProject>(projects: T[]): T[] {
  return projects.filter((project) => repositoryLinkOf(project) !== null);
}

export interface FooterPrRow {
  number: number;
  title: string;
  head: string;
  author: string | null;
  createdAt: string;
  isDraft: boolean;
  /** "head → base". */
  branches: string;
}

export interface FooterPrGroup {
  projectId: string;
  projectName: string;
  state: 'ready' | 'checking' | 'unavailable';
  /** Open PRs of the project (ready only); may exceed `rows` when the reading is truncated or capped. */
  count: number;
  rows: FooterPrRow[];
  /** Open PRs not listed in `rows`. */
  hiddenCount: number;
  reason?: string;
}

export interface FooterPrSummary {
  /** The item is shown only when some project has a linked repository. */
  visible: boolean;
  /** Open PRs over projects whose last reading succeeded; unavailable and unread projects add nothing. */
  total: number;
  unavailable: number;
  checking: number;
  groups: FooterPrGroup[];
  /** Oldest successful check among the eligible projects, or null when none has succeeded yet. */
  oldestCheckedAt: string | null;
}

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

const createdMs = (createdAt: string) => {
  const ms = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

/** Newest created first; PRs without a usable created time go last, then by number descending. */
export function sortRows(pullRequests: PullRequest[]): PullRequest[] {
  return [...pullRequests].sort((a, b) => {
    const left = createdMs(a.createdAt);
    const right = createdMs(b.createdAt);
    if (left !== null && right !== null && left !== right) return right - left;
    if ((left === null) !== (right === null)) return left === null ? 1 : -1;
    return b.number - a.number;
  });
}

function toRow(pr: PullRequest): FooterPrRow {
  return { number: pr.number, title: pr.title, head: pr.headBranch, author: pr.author, createdAt: pr.createdAt, isDraft: pr.isDraft, branches: branchLabel(pr) };
}

function groupOf(project: FooterPrProject, reading: PrReading): FooterPrGroup | null {
  const base = { projectId: project.id, projectName: project.name, count: 0, rows: [], hiddenCount: 0 };
  const view = prViewState(reading);
  if (view === 'loading') return { ...base, state: 'checking' };
  // A failed latest check is unavailable even when an older list is kept: its numbers may be stale.
  if (view === 'error-no-data' || view === 'error-with-data') return { ...base, state: 'unavailable', reason: reading.error };
  if (view === 'empty') return null;
  const rows = sortRows(reading.pullRequests).slice(0, MAX_ROWS_PER_PROJECT).map(toRow);
  const count = reading.count ?? 0;
  return { ...base, state: 'ready', count, rows, hiddenCount: Math.max(0, count - rows.length) };
}

export function summarizeFooterPrs(projects: FooterPrProject[], readingOf: (projectId: string) => PrReading): FooterPrSummary {
  const eligible = eligibleProjects(projects);
  const groups: FooterPrGroup[] = [];
  let total = 0;
  let unavailable = 0;
  let checking = 0;
  let oldest: string | null = null;
  for (const project of eligible) {
    const reading = readingOf(project.id);
    if (reading.checkedAt && (oldest === null || Date.parse(reading.checkedAt) < Date.parse(oldest))) oldest = reading.checkedAt;
    const group = groupOf(project, reading);
    if (!group) continue;
    if (group.state === 'ready') total += group.count;
    else if (group.state === 'unavailable') unavailable += 1;
    else checking += 1;
    groups.push(group);
  }
  groups.sort((a, b) => compareText(a.projectName, b.projectName) || a.projectId.localeCompare(b.projectId));
  return { visible: eligible.length > 0, total, unavailable, checking, groups, oldestCheckedAt: oldest };
}

/** Spoken and tooltip wording of the footer item. */
export function prsTriggerLabel(summary: Pick<FooterPrSummary, 'total' | 'unavailable' | 'checking'>): string {
  const parts = [`${summary.total} open pull requests`];
  if (summary.unavailable > 0) parts.push(`${summary.unavailable} ${summary.unavailable === 1 ? 'project' : 'projects'} unavailable`);
  if (summary.checking > 0) parts.push(`${summary.checking} ${summary.checking === 1 ? 'project' : 'projects'} checking`);
  return parts.join(', ');
}

export function prRowAccessibleName(row: Pick<FooterPrRow, 'number' | 'title' | 'isDraft'>, projectName: string): string {
  return `#${row.number} ${row.title}, project ${projectName}${row.isDraft ? ', draft' : ''}`;
}

export function unavailableRowText(reason: string | undefined): string {
  return `unavailable: ${reason ?? 'Could not check pull requests.'}`;
}

export function moreRowText(hiddenCount: number): string {
  return `+${hiddenCount} more, open the PR tab`;
}

/** Compact age of a PR: "now", "5m", "3h", "3d", "2w", "4mo", "2y"; '' when the time is unusable. */
export function ageLabel(createdAt: string, now: number): string {
  const created = createdMs(createdAt);
  if (created === null) return '';
  const seconds = Math.max(0, Math.floor((now - created) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function lastCheckedText(oldestCheckedAt: string | null, now: number): { text: string; stale: boolean } {
  const text = relativeCheckTime(oldestCheckedAt ?? '', now);
  const stale = oldestCheckedAt !== null && now - Date.parse(oldestCheckedAt) > STALE_AFTER_MS;
  return { text, stale };
}

export type ListKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/** Index of the row to focus after `key`, wrapping at both ends; -1 for an empty list. */
export function nextRowIndex(current: number, count: number, key: ListKey): number {
  if (count === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = key === 'ArrowDown' ? 1 : -1;
  return current < 0 ? (step > 0 ? 0 : count - 1) : (current + step + count) % count;
}

export type HighlightResolution = { kind: 'wait' } | { kind: 'found' } | { kind: 'gone' } | { kind: 'unlisted' };

/**
 * Where a footer click on PR `number` lands once the PR tab has a reading: the row to highlight, a
 * "gone" notice when a complete list no longer holds it, or nothing to show when the list was cut
 * short. While the reading is loading or has no data the answer waits.
 */
export function resolveHighlight(reading: PrReading, number: number): HighlightResolution {
  if (reading.loading || reading.count === null) return { kind: 'wait' };
  if (reading.pullRequests.some((pr) => pr.number === number)) return { kind: 'found' };
  return reading.truncated ? { kind: 'unlisted' } : { kind: 'gone' };
}

export const prGoneNotice = (number: number) => `Pull request #${number} is no longer open.`;

/* ---------- background polling ---------- */

export interface FooterPollerEnvironment {
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FooterPollerOptions {
  fetch: (projectId: string, options: { provider: string; force: boolean }) => Promise<unknown>;
  getProjects: () => FooterPrProject[];
  environment: FooterPollerEnvironment;
  intervalMs?: number;
  /** Requests started at once, however many projects are due. */
  maxInFlight?: number;
  /** Gap between project starts on load, on becoming visible and on Refresh all. */
  burstSpacingMs?: number;
}

export interface FooterPrPoller {
  /** Fetches every eligible project now (staggered), then about once a minute while visible. Returns stop. */
  start(): () => void;
  /** Call when projects change: fetches new or repository/provider-changed projects at once. */
  sync(): void;
  /** Forced, staggered refresh of every eligible project; one failure never stops the rest. */
  refreshAll(): void;
}

const signatureOf = (project: FooterPrProject) => `${project.repositoryUrl ?? ''}|${gitProviderOf(project)}`;

export function createFooterPrPoller({ fetch, getProjects, environment, intervalMs = POLL_INTERVAL_MS, maxInFlight = 4, burstSpacingMs = 250 }: FooterPollerOptions): FooterPrPoller {
  const timers = new Set<unknown>();
  const queue: Array<() => Promise<unknown>> = [];
  const known = new Map<string, string>();
  let inFlight = 0;
  let running = false;

  const pump = () => {
    while (inFlight < maxInFlight && queue.length > 0) {
      const job = queue.shift()!;
      inFlight += 1;
      void job().catch(() => undefined).finally(() => { inFlight -= 1; pump(); });
    }
  };
  const later = (ms: number, callback: () => void) => {
    const handle = environment.setTimeout(() => { timers.delete(handle); callback(); }, ms);
    timers.add(handle);
  };
  const clearTimers = () => {
    timers.forEach((handle) => environment.clearTimeout(handle));
    timers.clear();
    queue.length = 0;
  };
  const fetchNow = (projectId: string, force: boolean) => {
    // The project may have been deleted or lost its repository while this was waiting.
    const project = eligibleProjects(getProjects()).find((candidate) => candidate.id === projectId);
    if (!project) return;
    queue.push(() => fetch(project.id, { provider: gitProviderOf(project), force }));
    pump();
  };
  const remember = () => {
    known.clear();
    eligibleProjects(getProjects()).forEach((project) => known.set(project.id, signatureOf(project)));
  };
  const stagger = (force: boolean, spacingMs: (count: number) => number) => {
    const eligible = eligibleProjects(getProjects());
    const spacing = spacingMs(eligible.length);
    eligible.forEach((project, index) => {
      if (index === 0) fetchNow(project.id, force);
      else later(index * spacing, () => fetchNow(project.id, force));
    });
  };
  const burst = (force: boolean) => stagger(force, (count) => Math.min(burstSpacingMs, Math.floor(intervalMs / Math.max(count, 1))));
  const steadyCycle = () => {
    stagger(true, (count) => Math.floor(intervalMs / Math.max(count, 1)));
    later(intervalMs, steadyCycle);
  };
  const begin = (force: boolean) => {
    clearTimers();
    remember();
    burst(force);
    later(intervalMs, steadyCycle);
  };

  return {
    start() {
      running = true;
      if (environment.isVisible()) begin(false);
      const unsubscribe = environment.onVisibilityChange(() => {
        if (environment.isVisible()) begin(true);
        else clearTimers();
      });
      return () => {
        running = false;
        clearTimers();
        unsubscribe();
      };
    },
    sync() {
      if (!running || !environment.isVisible()) return;
      const eligible = eligibleProjects(getProjects());
      const present = new Set(eligible.map((project) => project.id));
      for (const id of [...known.keys()]) if (!present.has(id)) known.delete(id);
      for (const project of eligible) {
        const before = known.get(project.id);
        const signature = signatureOf(project);
        if (before === signature) continue;
        known.set(project.id, signature);
        fetchNow(project.id, before !== undefined);
      }
    },
    refreshAll() {
      stagger(true, () => burstSpacingMs);
    },
  };
}
