/**
 * Pure view-model logic for the app-update footer item/popover and the open-tab reload/reconnect
 * banners (task 7.001's idle-aware update). Kept out of the components so it's testable without
 * rendering anything, same as `lib/notificationCenter.ts`/`lib/projectStatus.ts`.
 *
 * The daemon is the only source of truth: everything here is a pure function of one
 * `AppUpdateStatus` (plus, where noted, an injected clock or a couple of browser-only values the
 * store tracks). See `lib/serverApi.ts` for the status shape and `docs/architecture.md` for why the
 * daemon, not this tab, decides whether an update applies immediately or waits for idle.
 */
import { relativeCheckTime } from './pullRequests';
import { BLOCKING_KIND_LABEL } from './gitSync';
import type { AppUpdateBlockingCounts, AppUpdatePhase, AppUpdateStatus } from './serverApi';

/** A footer dot/text color, matched to the literal Tailwind classes `StatusCount`'s `dot` prop already uses (`bg-warning`/`bg-destructive`/`bg-success`/`bg-muted-foreground`), plus `progress` for "in progress, no particular urgency" (`bg-primary`). */
export type AppUpdateTone = 'muted' | 'warning' | 'destructive' | 'success' | 'progress';

export const APP_UPDATE_TONE_DOT_CLASS: Record<AppUpdateTone, string> = {
  muted: 'bg-muted-foreground',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  success: 'bg-success',
  progress: 'bg-primary',
};

/** "1 commit" / "3 commits" — singular/plural wording. */
export function pluralCommits(count: number): string {
  return `${count} commit${count === 1 ? '' : 's'}`;
}

/** The footer item's text + color, covering every state the daemon can report (see `AppUpdateStatus`). Never hidden — "up to date" is a real, always-visible state so "Check now" always has an entry point (task 7.001's #69). */
export function describeAppUpdateFooterLabel(status: AppUpdateStatus): { text: string; tone: AppUpdateTone } {
  const base = describeAppUpdateFooterLabelBase(status);
  if (status.mode !== 'dev') return base;
  return { text: `${base.text} · read only`, tone: base.tone };
}

function describeAppUpdateFooterLabelBase(status: AppUpdateStatus): { text: string; tone: AppUpdateTone } {
  switch (status.phase) {
    case 'held':
      return { text: 'Update waiting for idle…', tone: 'warning' };
    case 'updating':
      return { text: 'Updating…', tone: 'progress' };
    case 'updated':
      return { text: `Updated to ${status.updatedToCommit ?? 'latest'}`, tone: 'success' };
    case 'failed':
      return { text: 'Update failed', tone: 'destructive' };
    case 'idle':
      break;
  }
  switch (status.availability) {
    case 'up-to-date':
      return { text: 'Up to date', tone: 'muted' };
    case 'available':
      return { text: `Update available (${status.behindBy})`, tone: 'warning' };
    case 'cant-auto-update':
      return { text: `Can't auto-update (${status.behindBy})`, tone: 'warning' };
    case 'could-not-check':
      return status.lastSuccessfulCheckAt === null
        ? { text: "Couldn't check", tone: 'muted' }
        : { text: "Couldn't check (showing last known)", tone: 'muted' };
  }
}

/** One row of the "currently blocking a restart" breakdown, in the mockup's fixed display order. */
export interface AppUpdateBlockingRow {
  key: keyof AppUpdateBlockingCounts;
  label: string;
  count: number;
}

const BLOCKING_ROW_LABELS: { key: keyof AppUpdateBlockingCounts; label: string }[] = [
  { key: 'testRuns', label: 'Running test runs' },
  { key: 'commands', label: 'Running commands' },
  { key: 'terminalSessions', label: 'Open terminal sessions' },
];

function blockingRows(blocking: AppUpdateBlockingCounts): AppUpdateBlockingRow[] {
  return BLOCKING_ROW_LABELS.map(({ key, label }) => ({ key, label, count: blocking[key] }));
}

/** Most blocking files the popover lists; the rest collapse into "+N more". */
export const MAX_LISTED_BLOCKING_FILES = 10;

export interface BlockingFilesView {
  /** e.g. "Local changes block this update (2 files)". */
  title: string;
  files: { path: string; kindLabel: string }[];
  /** Files beyond the ones listed, counted from the server's exact total. */
  moreCount: number;
  explanation: string;
  /** One path per line, for the "Copy file list" button. */
  copyText: string;
}

/** The "these files block the update" panel, or null when no local change overlaps the update. */
export function describeBlockingFiles(status: Pick<AppUpdateStatus, 'blockingFiles' | 'blockingFilesTotal'>): BlockingFilesView | null {
  const all = status.blockingFiles ?? [];
  const total = Math.max(status.blockingFilesTotal ?? 0, all.length);
  if (total === 0) return null;
  const listed = all.slice(0, MAX_LISTED_BLOCKING_FILES);
  return {
    title: `Local changes block this update (${total} file${total === 1 ? '' : 's'})`,
    files: listed.map((file) => ({ path: file.path, kindLabel: BLOCKING_KIND_LABEL[file.kind] })),
    moreCount: total - listed.length,
    explanation: 'The incoming update changes these same files. Commit, stash or move them yourself, then check again. Nothing is changed for you.',
    copyText: listed.map((file) => file.path).join('\n'),
  };
}

/** Everything the popover renders, read from one `AppUpdateStatus` plus an injected clock — nothing here is re-derived ad hoc by the component. */
export interface AppUpdatePopoverContent {
  branch: string;
  behindBy: number;
  /** e.g. "3 commits behind origin/main" — empty when `behindBy` is 0. */
  behindByText: string;
  /** "Web only — …" / "Includes server changes — …" / "Dev mode — read only" (overrides the classification badge in dev mode) / null when there's nothing to classify (e.g. up to date). */
  classificationLabel: string | null;
  commits: AppUpdateStatus['incomingCommits'];
  /** How many more commits than `commits` lists, when the server's own list was capped; 0 otherwise. */
  commitsTruncatedCount: number;
  blocking: AppUpdateBlockingRow[];
  lastCheckedText: string;
  checkErrorText: string | null;
  /** True when a failed check still has an earlier successful one to fall back on (see `AppUpdateStatus.lastSuccessfulCheckAt`'s doc comment) — the popover shows the stale data instead of nothing. */
  showingStaleResult: boolean;
  cantUpdateReasonText: string | null;
  blockingFiles: BlockingFilesView | null;
  /** Why `canApply` is false (e.g. "This is a dev run…") — always surfaced when set, dev mode included. */
  applyBlockedReasonText: string | null;
  failureMessage: string | null;
  failureLogPath: string | null;
  updatedToCommit: string | null;
}

export function describeAppUpdatePopover(status: AppUpdateStatus, now: number): AppUpdatePopoverContent {
  const classificationLabel = status.mode === 'dev'
    ? 'Dev mode — read only'
    : status.classification === 'web-only'
      ? "Web only — won't interrupt any work"
      : status.classification === 'server'
        ? 'Includes server changes — needs the daemon to restart'
        : null;

  return {
    branch: status.branch,
    behindBy: status.behindBy,
    behindByText: status.behindBy > 0 ? `${pluralCommits(status.behindBy)} behind origin/${status.branch}` : '',
    classificationLabel,
    commits: status.incomingCommits,
    commitsTruncatedCount: status.incomingCommitsTruncated ? Math.max(0, status.behindBy - status.incomingCommits.length) : 0,
    blocking: blockingRows(status.blocking),
    lastCheckedText: relativeCheckTime(status.checkedAt ?? '', now),
    checkErrorText: status.checkError,
    showingStaleResult: status.checkError !== null && status.lastSuccessfulCheckAt !== null,
    cantUpdateReasonText: status.cantUpdateReason,
    blockingFiles: describeBlockingFiles(status),
    applyBlockedReasonText: status.applyBlockedReason,
    failureMessage: status.failureMessage,
    failureLogPath: status.failureLogPath,
    updatedToCommit: status.updatedToCommit,
  };
}

export type AppUpdateAction = 'update' | 'updateWhenIdle' | 'cancel' | 'check' | 'retry';

/**
 * Which actions the popover offers, by state — see task 7.001's spec table. Dev mode and
 * "can't auto-update" never offer anything that could apply a change; only `check`/`cancel`/`retry`
 * route through this (the "Update"/"Update when idle" buttons are availability-gated separately).
 */
export function appUpdateActions(status: AppUpdateStatus): AppUpdateAction[] {
  if (status.mode === 'dev') return ['check'];
  switch (status.phase) {
    case 'held':
      return ['cancel', 'check'];
    case 'updating':
      return [];
    case 'updated':
      // Not just cosmetic: the server eventually reverts this phase back to 'idle' on its own
      // (Code Review round 1, issue 2), but only once it's had a moment to be seen — "Check now"
      // must stay reachable the whole time, per planning gap #1's "always has an entry point".
      return ['check'];
    case 'failed':
      return ['retry', 'check'];
    case 'idle':
      break;
  }
  switch (status.availability) {
    case 'up-to-date':
    case 'cant-auto-update':
    case 'could-not-check':
      return ['check'];
    case 'available':
      return status.classification === 'server' ? ['updateWhenIdle', 'check'] : ['update', 'check'];
  }
}

/**
 * The reload banner's visibility: a pure derivation, not a state machine with memory — "dismissed"
 * is tracked by which `servingCommit` was last dismissed (`dismissedCommit`, owned by the store), so
 * a later, distinct commit re-shows the banner even though the previous one was dismissed. `null`
 * `servingCommit` means "no status loaded yet" (nothing to compare against).
 */
export function nextReloadBannerVisibility(input: {
  ownBuildCommit: string;
  servingCommit: string | null;
  dismissedCommit: string | null;
}): 'hidden' | 'shown' {
  if (input.servingCommit === null || input.servingCommit === input.ownBuildCommit) return 'hidden';
  if (input.dismissedCommit === input.servingCommit) return 'hidden';
  return 'shown';
}

/**
 * The reconnect banner's visibility: shown only while the WS is down AND the last status this tab
 * saw before disconnecting was mid-update (`'updating'`) — the one case where a disconnect is
 * expected and reconnecting resolves it on its own, rather than signalling a real problem.
 */
export function reconnectBannerVisible(input: { wsConnected: boolean; lastKnownPhase: AppUpdatePhase | null }): boolean {
  return !input.wsConnected && input.lastKnownPhase === 'updating';
}

/**
 * The reload banner's actual on-screen visibility: `nextReloadBannerVisibility` plus one more rule
 * (Code Review round 1, issue 3) — it never shows at the same time as the reconnect banner. Both are
 * fixed to the same spot above the footer, and a reconnect in progress is the more urgent, active
 * state; once reconnected, the reconnect banner hides and this one takes back over (`currentCommit`
 * has typically already moved by then, so there's a build to reload to anyway).
 */
export function reloadBannerVisible(input: {
  ownBuildCommit: string;
  servingCommit: string | null;
  dismissedCommit: string | null;
  wsConnected: boolean;
  lastKnownPhase: AppUpdatePhase | null;
}): boolean {
  if (reconnectBannerVisible({ wsConnected: input.wsConnected, lastKnownPhase: input.lastKnownPhase })) return false;
  return nextReloadBannerVisibility(input) === 'shown';
}
