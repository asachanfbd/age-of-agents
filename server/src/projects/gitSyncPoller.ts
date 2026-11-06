import { git, currentBranch, fetchOrigin } from './git.ts';
import { getProject, listProjects, projectAbsolutePath } from './projectService.ts';
import { listNotifications, raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { GithubAccountError } from '../github/context.ts';
import { withProjectGithub } from '../github/accounts.ts';
import { clearAccountFailure, reportAccountFailure } from '../github/accountNotifications.ts';
import type { AutoPuller } from './autoPull.ts';
import type { BlockingChanges } from './incomingOverlap.ts';
import { OUT_OF_SYNC_STATUSES } from '../domain/types.ts';
import type { NotificationSubject, ProjectRecord, ProjectSyncState, GitSyncStatus } from '../domain/types.ts';

/** How often the daemon re-fetches every git-backed Project's remote — see docs/architecture.md. */
export const GIT_SYNC_REFRESH_MS = 60_000;

export type GitSyncEvent = { type: 'projectSync'; sync: ProjectSyncState };
type Listener = (event: GitSyncEvent) => void;

/**
 * Compares one Project's checked-out branch against `origin/<branch>` after
 * a quiet `git fetch` — the only way to notice a branch moved on GitHub
 * while it's checked out locally (nothing else in this daemon watches the
 * remote). Never throws: any failure (detached HEAD, no network, branch
 * never pushed) collapses to a best-effort 'unknown' reading rather than
 * taking down the poller for every other Project.
 */
export async function computeProjectSync(project: ProjectRecord): Promise<ProjectSyncState> {
  const cwd = projectAbsolutePath(project);
  const checkedAt = new Date().toISOString();
  let branch = '';
  try {
    branch = await currentBranch(cwd);
    // The whole remote, not just this branch: a branch that was never pushed has no
    // `origin/<branch>` to fetch by name, and would otherwise fail the whole comparison.
    await withProjectGithub(project, 'check the branch sync status', () => fetchOrigin(cwd));
    await clearAccountFailure(project);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const hasRemote = (await git(cwd, ['for-each-ref', remoteRef])).length > 0;
    if (!hasRemote) return { projectId: project.id, branch, status: 'no-remote', aheadBy: 0, behindBy: 0, checkedAt };
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
    const [aheadBy = 0, behindBy = 0] = counts.split(/\s+/).map(Number);
    return { projectId: project.id, branch, status: syncStatus(aheadBy, behindBy), aheadBy, behindBy, checkedAt };
  } catch (error) {
    if (error instanceof GithubAccountError) await reportAccountFailure(project, error.message).catch(() => undefined);
    // A GitError (no network, no "origin" remote, etc.) or a detached HEAD (currentBranch throws) —
    // either way, the last-known branch (if we got that far) with 'unknown' is more useful than
    // dropping the reading entirely.
    return { projectId: project.id, branch, status: 'unknown', aheadBy: 0, behindBy: 0, checkedAt };
  }
}

/** The structured file list that accompanies a deferral caused by overlapping local changes; nothing when the deferral had another cause. */
function blockingFields(blocking: BlockingChanges | undefined): Pick<ProjectSyncState, 'blockingFiles' | 'blockingFilesTotal'> {
  return blocking && blocking.total > 0 ? { blockingFiles: blocking.files, blockingFilesTotal: blocking.total } : {};
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function syncStatus(aheadBy: number, behindBy: number): GitSyncStatus {
  if (aheadBy > 0 && behindBy > 0) return 'diverged';
  if (behindBy > 0) return 'behind';
  if (aheadBy > 0) return 'ahead';
  return 'synced';
}

/**
 * Owns the daemon's in-memory table of "last known sync state per Project"
 * plus the event bus that pushes fresh readings out over `/ws` — structurally
 * the same shape as `commands/commandRunner.ts`'s event bus (a `Set` of
 * listeners, one `emit`), and, like `executors/claudeUsage.ts`'s
 * `ClaudeUsagePoller`, an in-memory cache a GET route can read synchronously
 * (`get`) rather than recomputing on every request. Never persisted —
 * see ProjectSyncState's own doc comment.
 */
export function createGitSyncPoller() {
  const states = new Map<string, ProjectSyncState>();
  const listeners = new Set<Listener>();

  function onSyncEvent(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(sync: ProjectSyncState): void {
    for (const listener of listeners) listener({ type: 'projectSync', sync });
  }

  function get(projectId: string): ProjectSyncState | null {
    return states.get(projectId) ?? null;
  }

  let autoPuller: AutoPuller | null = null;
  /** Per Project: the refresh running now and whether another was asked for meanwhile, so a burst of triggers costs at most one extra refresh. */
  const refreshes = new Map<string, { running: Promise<void>; rerun: boolean; first: boolean }>();

  /** Turns automatic pulling on; without it the poller only reports. */
  function setAutoPuller(puller: AutoPuller | null): void {
    autoPuller = puller;
  }

  /**
   * Refreshes one Project, broadcasts the fresh reading and, when the branch is behind, lets the
   * auto-puller fast-forward it. Refreshes of one Project never overlap. Projects without a
   * repository have nothing to compare against, so they're skipped rather than recorded as 'no-remote'.
   */
  async function refreshOne(project: ProjectRecord, cached?: ProjectSyncState): Promise<void> {
    if (!project.repositoryUrl) return;
    const current = refreshes.get(project.id);
    if (current) { current.rerun = true; return current.running; }
    const entry = { running: Promise.resolve(), rerun: false, first: true };
    refreshes.set(project.id, entry);
    entry.running = (async () => {
      try {
        let target = project;
        do {
          entry.rerun = false;
          await refreshNow(target, entry.first ? cached : undefined);
          entry.first = false;
          if (entry.rerun) target = await getProject(project.id);
        } while (entry.rerun);
      } finally { refreshes.delete(project.id); }
    })();
    return entry.running;
  }

  async function refreshNow(project: ProjectRecord, cached?: ProjectSyncState): Promise<void> {
    const previous = states.get(project.id);
    let sync = cached ?? await computeProjectSync(project);
    if (autoPuller) {
      const outcome = await autoPuller.evaluate(project, sync);
      if (outcome.kind === 'pulled') {
        sync = { ...(await computeProjectSync(project)), lastAutoPull: { commits: outcome.commits, at: outcome.at } };
      } else if (outcome.kind === 'deferred') {
        sync = { ...sync, deferredReason: outcome.reason, ...blockingFields(outcome.blocking) };
      }
    }
    if (sync.status === 'synced' && !sync.lastAutoPull && previous?.branch === sync.branch && previous.lastAutoPull) {
      sync = { ...sync, lastAutoPull: previous.lastAutoPull };
    }
    states.set(project.id, sync);
    emit(sync);
    await syncOutOfSyncNotification(project, sync);
  }

  /**
   * Re-evaluates a Project whose pull was deferred, after something that may have lifted the reason
   * (a task or run releasing the folder). Works from the last reading without fetching, and does
   * nothing for a Project that isn't waiting, so the many unrelated events cost nothing.
   */
  async function reevaluate(projectId: string): Promise<void> {
    const cached = states.get(projectId);
    if (cached?.status !== 'behind' || !cached.deferredReason) return;
    const { deferredReason: _reason, blockingFiles: _files, blockingFilesTotal: _total, ...reading } = cached;
    await refreshOne(await getProject(projectId), reading);
  }

  /**
   * Keeps at most one unresolved `git.out_of_sync` Notification per Project in sync with the current
   * reading, checked every poll tick against the *persisted* Notification store — never against
   * `states` above, which is an in-memory-only cache (ProjectSyncState's own doc comment) that resets
   * on every daemon restart. An earlier version compared against `states` to avoid re-notifying on
   * every tick while a Project stayed out of sync; that broke under `npm run dev`'s `node --watch`,
   * where a single file save restarts the process and wipes that cache, making the very next tick
   * look like a fresh transition and fire a duplicate Notification for an already-known issue.
   * Checking the real Notification (resolved or not) instead of a poller-local memory is durable
   * across restarts and is the actual thing a duplicate should be judged against.
   *
   * Back in sync: `resolveNotifications` closes out any still-open one for this Project (the
   * condition that raised it no longer holds). Still out of sync: `raiseNotification` is the generic
   * upsert (it dedupes AND always re-nulls `readAt`, "a fresh occurrence" — see its own doc comment),
   * but this poller ticks every `GIT_SYNC_REFRESH_MS` regardless of whether anything actually
   * changed, and calling it unconditionally would re-unread an already-seen Notification on every
   * tick. So the existing unresolved one (if any) is diffed against the fresh title/description
   * first, and `raiseNotification` is only called when the text actually changed or there wasn't one
   * yet — same "only write if it changed" rule the old hand-rolled version had, just expressed against
   * the shared primitive instead of a bespoke find/update.
   */
  async function syncOutOfSyncNotification(project: ProjectRecord, current: ProjectSyncState): Promise<void> {
    const subject: NotificationSubject = { type: 'project', projectId: project.id };

    if (!OUT_OF_SYNC_STATUSES.includes(current.status)) {
      await resolveNotifications(subject, ['git.out_of_sync']);
      return;
    }

    const title = `"${project.name}" is ${current.status} with origin/${current.branch}`;
    const description = current.status === 'diverged'
      ? `${current.aheadBy} local commit(s) and ${current.behindBy} remote commit(s) have diverged.`
      : `${current.behindBy} commit(s) behind origin/${current.branch}.`;
    const explanation = current.deferredReason ? ` ${capitalize(current.deferredReason)}.` : '';

    const existing = (await listNotifications({ resolved: false, projectId: project.id }))
      .find((n) => n.kind === 'git.out_of_sync');
    if (existing && existing.title === title && existing.description === description + explanation) return;

    await raiseNotification({ kind: 'git.out_of_sync', subject, title, description: description + explanation });
  }

  async function refreshAll(projects: ProjectRecord[]): Promise<void> {
    await Promise.all(projects.map((project) => refreshOne(project)));
  }

  return { get, refreshOne, refreshAll, reevaluate, setAutoPuller, onSyncEvent };
}

export type GitSyncPoller = ReturnType<typeof createGitSyncPoller>;

/** The one instance the daemon actually runs against — see api/ws.ts, api/router.ts and index.ts. */
export const gitSyncPoller = createGitSyncPoller();

/**
 * Starts the recurring `git fetch` sweep: an immediate refresh, then one
 * every `GIT_SYNC_REFRESH_MS` — matches `executors/claudeUsage.ts`'s
 * `startClaudeUsagePolling`. `unref()`'d so it never keeps the process alive
 * on its own; returns a disposer for `server.on('close', ...)`.
 */
export function startGitSyncPolling(poller: GitSyncPoller = gitSyncPoller, intervalMs = GIT_SYNC_REFRESH_MS): () => void {
  const tick = async () => {
    try { await poller.refreshAll(await listProjects()); } catch { /* Retry on the next tick. */ }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
