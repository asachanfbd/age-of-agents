import { TAB_DECLARATIONS } from './workspaceLayout';
import type { WorkspaceTab, WorkspaceTabSpec } from './workspaceLayout';
import type { ProjectData } from '../types';
import { repositoryLinkOf } from './gitProvider';

export interface PullRequest {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  author: string | null;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/projects/:id/open-pull-requests`; `count` is null (with `error`) when the provider couldn't be read. */
export interface PullRequestsResponse {
  count: number | null;
  pullRequests: PullRequest[];
  truncated: boolean;
  checkedAt: string;
  error?: string;
}

/** What the tab label and the PR list both render, so they can't disagree. */
export interface PrReading {
  count: number | null;
  pullRequests: PullRequest[];
  /** More pull requests are open than `pullRequests` holds. */
  truncated: boolean;
  /** When the last successful check finished; '' until one has. A failed check never moves it. */
  checkedAt: string;
  error?: string;
  loading: boolean;
}

export const EMPTY_READING: PrReading = { count: null, pullRequests: [], truncated: false, checkedAt: '', loading: false };

export const POLL_INTERVAL_MS = 60_000;
const GENERIC_FAILURE = 'Could not check pull requests.';

export function sortNewestFirst(pullRequests: PullRequest[]): PullRequest[] {
  return [...pullRequests].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number);
}

/** A success replaces the reading; a failure keeps the previous list, count and last-good time and adds the error. */
export function applyResponse(previous: PrReading, response: PullRequestsResponse): PrReading {
  if (response.count === null || response.error) {
    return { ...previous, loading: false, error: response.error ?? GENERIC_FAILURE };
  }
  return { count: response.count, pullRequests: sortNewestFirst(response.pullRequests), truncated: response.truncated, checkedAt: response.checkedAt, loading: false };
}

export type PrViewState = 'loading' | 'ready' | 'empty' | 'error-with-data' | 'error-no-data';

export function prViewState(reading: PrReading): PrViewState {
  if (reading.count === null) return reading.error && !reading.loading ? 'error-no-data' : 'loading';
  if (reading.error) return 'error-with-data';
  return reading.count === 0 ? 'empty' : 'ready';
}

export function prTabLabel(reading: Pick<PrReading, 'count'>): string {
  return reading.count === null ? 'PR' : `PR ${reading.count}`;
}

export function prTabAccessibleName(reading: Pick<PrReading, 'count'>): string {
  return reading.count === null ? 'PR' : `PR, ${reading.count} open`;
}

export function prRowLabel(pr: Pick<PullRequest, 'number' | 'title'>): string {
  return `#${pr.number} ${pr.title}`;
}

export function branchLabel(pr: Pick<PullRequest, 'headBranch' | 'baseBranch'>): string {
  return `${pr.headBranch} → ${pr.baseBranch}`;
}

export function moreThanShownNote(reading: Pick<PrReading, 'truncated' | 'pullRequests'>): string | null {
  return reading.truncated ? `Showing newest ${reading.pullRequests.length} of more than ${reading.pullRequests.length}` : null;
}

export function relativeCheckTime(checkedAt: string, now = Date.now()): string {
  if (!checkedAt) return 'Not checked yet';
  const seconds = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 1000));
  if (seconds < 5) return 'Last checked just now';
  if (seconds < 60) return `Last checked ${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  return `Last checked ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

/** Tasks, Documents, Testing, Code, then PR (only for a Project whose repository the Git provider recognises), Settings, and Archived last. */
export function workspaceTabs(project: Pick<ProjectData, 'repositoryUrl' | 'gitProvider'>, options: { reading: PrReading; hasArchived: boolean }): WorkspaceTabSpec[] {
  const spec = (key: WorkspaceTab): WorkspaceTabSpec => ({ key, label: TAB_DECLARATIONS[key].label });
  return [
    spec('tasks'),
    spec('documents'),
    spec('testing'),
    spec('code'),
    ...(repositoryLinkOf(project) ? [{ key: 'pr' as const, label: prTabLabel(options.reading), ariaLabel: prTabAccessibleName(options.reading) }] : []),
    spec('settings'),
    ...(options.hasArchived ? [spec('archived')] : []),
  ];
}

export interface PrReadings {
  get(projectId: string): PrReading;
  subscribe(listener: () => void): () => void;
  /**
   * Resolves with the Project's reading after checking the Git provider. A request already in flight
   * is shared (a forced refresh joins it rather than starting a second one). Without `force`, a
   * successful reading under a minute old is reused. A different `provider` than the last fetch
   * clears the Project's reading first, and a response still in flight for the old provider is dropped.
   */
  fetch(projectId: string, options: { provider: string; force?: boolean }): Promise<PrReading>;
}

interface Entry {
  provider: string;
  reading: PrReading;
  fetchedAt: number | null;
  pending?: Promise<PrReading>;
}

export function createPrReadings(request: (projectId: string) => Promise<PullRequestsResponse>, now: () => number = Date.now): PrReadings {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  function startRequest(projectId: string, entry: Entry): Promise<PrReading> {
    entry.reading = { ...entry.reading, loading: true, error: undefined };
    notify();
    entry.pending = request(projectId)
      .catch((): PullRequestsResponse => ({ count: null, pullRequests: [], truncated: false, checkedAt: new Date(now()).toISOString(), error: GENERIC_FAILURE }))
      .then((response) => {
        if (entries.get(projectId) !== entry) return entry.reading;
        entry.reading = applyResponse(entry.reading, response);
        entry.fetchedAt = entry.reading.error ? null : now();
        entry.pending = undefined;
        notify();
        return entry.reading;
      });
    return entry.pending;
  }

  return {
    get: (projectId) => entries.get(projectId)?.reading ?? EMPTY_READING,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    fetch(projectId, { provider, force = false }) {
      let entry = entries.get(projectId);
      if (entry && entry.provider !== provider) {
        entry = undefined;
        entries.delete(projectId);
      }
      if (!entry) {
        entry = { provider, reading: EMPTY_READING, fetchedAt: null };
        entries.set(projectId, entry);
      }
      if (entry.pending) return entry.pending;
      if (!force && entry.fetchedAt !== null && now() - entry.fetchedAt < POLL_INTERVAL_MS) return Promise.resolve(entry.reading);
      return startRequest(projectId, entry);
    },
  };
}

export interface PollingEnvironment {
  isVisible(): boolean;
  /** Calls back whenever the page is shown or hidden; returns the unsubscribe. */
  onVisibilityChange(listener: () => void): () => void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * Checks once now (cache allowed), then every minute while the page is visible. Hiding the page
 * stops the timer; showing it checks immediately and restarts the minute. Returns the stop function.
 */
export function startPolling(refresh: (force: boolean) => void, environment: PollingEnvironment, intervalMs = POLL_INTERVAL_MS): () => void {
  let timer: unknown = null;
  const stopTimer = () => {
    if (timer !== null) environment.clearInterval(timer);
    timer = null;
  };
  const startTimer = () => {
    stopTimer();
    timer = environment.setInterval(() => refresh(true), intervalMs);
  };
  if (environment.isVisible()) {
    refresh(false);
    startTimer();
  }
  const unsubscribe = environment.onVisibilityChange(() => {
    if (environment.isVisible()) {
      refresh(true);
      startTimer();
    } else {
      stopTimer();
    }
  });
  return () => {
    stopTimer();
    unsubscribe();
  };
}
