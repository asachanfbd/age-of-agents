import type { BlockingFile, ProjectSyncState } from './serverApi';

export const BLOCKING_KIND_LABEL: Record<BlockingFile['kind'], string> = {
  modified: 'modified',
  deleted: 'deleted',
  untracked: 'untracked, would be overwritten',
};

/** Most files the sync detail lists; the rest collapse into "and N more". */
export const MAX_SYNC_BLOCKING_FILES = 3;

export interface SyncBlockingView {
  /** e.g. "Not pulled: local changes in Alpha block 2 files". */
  title: string;
  files: { path: string; kindLabel: string }[];
  /** "and N more" text, or null when everything is listed. */
  moreText: string | null;
  hint: string;
}

/** What the branch menu shows when local changes overlapping the incoming commits deferred the pull; null when nothing overlaps (or the reading is from an older daemon). */
export function describeSyncBlocking(sync: ProjectSyncState | null | undefined, projectName: string): SyncBlockingView | null {
  const all = sync?.blockingFiles ?? [];
  const total = Math.max(sync?.blockingFilesTotal ?? 0, all.length);
  if (!sync || total === 0) return null;
  const listed = all.slice(0, MAX_SYNC_BLOCKING_FILES);
  const more = total - listed.length;
  return {
    title: `Not pulled: local changes in ${projectName} block ${total} file${total === 1 ? '' : 's'}`,
    files: listed.map((file) => ({ path: file.path, kindLabel: BLOCKING_KIND_LABEL[file.kind] })),
    moreText: more > 0 ? `and ${more} more` : null,
    hint: 'Commit, stash or move these files yourself, then check again. Nothing is changed for you.',
  };
}

/**
 * Whether a Project's git-sync reading means the remote has moved somewhere
 * this checkout hasn't caught up with — the "needs attention" case the sync
 * poller exists to surface (docs/architecture.md; server/src/projects/gitSyncPoller.ts).
 * 'ahead' (unpushed local work) and 'no-remote' are not out of sync by this
 * definition — nothing on the remote is being missed in either case.
 */
export function isOutOfSync(sync: ProjectSyncState | null | undefined): boolean {
  return sync?.status === 'behind' || sync?.status === 'diverged';
}

/** One-line human description of a sync reading, used as the branch picker's sync icon title and the project status dot's tooltip. */
export function describeSync(sync: ProjectSyncState | null | undefined): string {
  if (!sync) return 'Checking for remote updates…';
  switch (sync.status) {
    case 'synced': return sync.lastAutoPull ? describeAutoPull(sync.lastAutoPull) : `Up to date with origin/${sync.branch}`;
    case 'ahead': return `${sync.aheadBy} commit${sync.aheadBy === 1 ? '' : 's'} ahead of origin/${sync.branch}`;
    case 'behind': return `${sync.behindBy} commit${sync.behindBy === 1 ? '' : 's'} behind origin/${sync.branch} — ${sync.deferredReason ?? 'fetch and pull to catch up'}`;
    case 'diverged': return `Diverged from origin/${sync.branch}: ${sync.aheadBy} ahead, ${sync.behindBy} behind${sync.deferredReason ? ` — ${sync.deferredReason}` : ''}`;
    case 'no-remote': return `origin/${sync.branch} does not exist yet — this branch hasn't been pushed`;
    case 'unknown': return 'Could not check the remote for updates';
  }
}

/** "Pulled 3 commits automatically at 10:42" — the tooltip after an automatic pull; the time is shown in the viewer's locale. */
function describeAutoPull({ commits, at }: { commits: number; at: string }): string {
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Pulled ${commits} commit${commits === 1 ? '' : 's'} automatically at ${time}`;
}

/** Changes whenever an automatic pull brings new content into the main folder, so views of it (the Code tab) know to reload. */
export function mainFolderReloadKey(sync: ProjectSyncState | null | undefined): string {
  return sync?.lastAutoPull?.at ?? '';
}

/** The Project's auto-pull setting; a record from before the setting existed reads as on. */
export function isAutoPullOn(project: { autoPullEnabled?: boolean }): boolean {
  return project.autoPullEnabled !== false;
}
