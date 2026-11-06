import type { BuildingStatus, TaskData } from '../types';
import type { NotificationSeverity, ProjectSyncState, ServerNotification } from './serverApi';
import { describeSync } from './gitSync';

export type BuildingVisualStatus = 'idle' | 'developing' | 'completed' | 'question' | 'error' | 'notice';

/**
 * Turns the project's coarse runtime state, its latest task outcome, whether its checked-out branch
 * has fallen behind its remote, and its highest open Notification severity (see
 * `worldStore.ts`'s `highestOpenSeverity`) into the six states shown by the project status dot.
 *
 * Precedence, extending the existing `outOfSync` precedent rather than inventing a new mechanism:
 *  1. `blocked`/`developing` project status always wins — an in-progress or stuck Task is the most
 *     actionable thing happening on a Building, and a merely `info`/`warning` Notification (a lower
 *     urgency signal than a Task actively needing a person) must not visually bump it aside.
 *  2. An unreviewed failed task, an out-of-sync branch, or a `critical` Notification all fold into the same red
 *     'error' glow — same reasoning as the existing `outOfSync` fold: all three are the same "something
 *     needs urgent attention" signal, and the dot has only one red state. Unlike `blocked`/`developing`,
 *     'completed' is a settled state, so `critical` *does* override it here (per the milestone doc's
 *     open question: only `critical` gets to override an otherwise-urgent/otherwise-notable task-derived
 *     state; blocked/developing already returned above and are unaffected).
 *  3. A completed-but-unreviewed task keeps its own 'completed' state.
 *  4. Otherwise, an open `info`/`warning` Notification still needs to read as visibly different from a
 *     plain idle Building (a silent dot would bury it) without claiming any of the more urgent tiers
 *     above — hence the 6th enum value, 'notice', rather than tinting 'idle' in place or reusing
 *     'question'/'error' for a non-urgent signal.
 *  5. Nothing open anywhere: 'idle', exactly as before `notificationSeverity` existed.
 */
export function buildingVisualStatus(
  projectStatus: BuildingStatus,
  latestTask: TaskData | undefined,
  latestTaskReviewed: boolean,
  outOfSync = false,
  notificationSeverity: NotificationSeverity | null = null,
): BuildingVisualStatus {
  if (projectStatus === 'blocked') return 'question';
  if (projectStatus === 'developing') return 'developing';
  if ((latestTask?.status === 'failed' && !latestTaskReviewed) || outOfSync || notificationSeverity === 'critical') return 'error';
  if (latestTask?.status === 'done' && !latestTaskReviewed) return 'completed';
  if (notificationSeverity === 'warning' || notificationSeverity === 'info') return 'notice';
  return 'idle';
}

/** Formats one Notification's title/description as a single explanatory sentence, shared by both branches of `describeAttention` below so the wording never drifts between the 'error' and 'notice' cases. */
function describeNotification(notification: ServerNotification): string {
  return notification.description ? `${notification.title}: ${notification.description}` : notification.title;
}

/**
 * The project status dot's red 'error' glow and its 'notice' tier both need explaining on hover, and this is
 * the one place that does it — see `buildingVisualStatus`'s own doc comment for how each condition maps
 * to a dot state. 'error' can stack up to three independent reasons (failed task, out-of-sync branch,
 * critical Notification); 'notice' only ever has a Notification behind it (that's the only thing that
 * produces the 'notice' tier). The Project Workspace popup's attention banner (ProjectWorkspaceModal.tsx)
 * uses this to explain *why* the dot is red without re-deriving that condition itself, so the two can
 * never drift apart. Returns null whenever `visualStatus` isn't `'error'` or `'notice'` (nothing to
 * explain), or when it is but no cause was actually passed in (defensive — shouldn't happen in practice).
 */
export function describeAttention(
  visualStatus: BuildingVisualStatus,
  latestTask: TaskData | undefined,
  outOfSync: boolean,
  sync: ProjectSyncState | null | undefined,
  notification: ServerNotification | null = null,
): string | null {
  if (visualStatus !== 'error' && visualStatus !== 'notice') return null;
  const reasons: string[] = [];
  if (visualStatus === 'error') {
    if (latestTask?.status === 'failed') {
      reasons.push(`Latest task failed${latestTask.failureReason ? `: ${latestTask.failureReason}` : ''}`);
    }
    if (outOfSync) reasons.push(describeSync(sync));
    if (notification?.severity === 'critical') reasons.push(describeNotification(notification));
  } else if (notification) {
    reasons.push(describeNotification(notification));
  }
  return reasons.length ? reasons.join(' — ') : null;
}

/**
 * Everything that varies with a project's visual status — the colour of the status dot shown
 * beside a project's name, on both the 3D building label and the cards view.
 */
export interface StatusStyle {
  /** Whether the dot should glow. */
  glowing: boolean;
  dotColor: string;
  dotGlowColor: string;
  accessibleLabel: string;
}

export const BUILDING_STATUS_STYLES: Record<BuildingVisualStatus, StatusStyle> = {
  idle: {
    glowing: false,
    dotColor: '#8b93a3',
    dotGlowColor: '#000000',
    accessibleLabel: 'Idle',
  },
  developing: {
    glowing: true,
    dotColor: '#45a3ff',
    dotGlowColor: '#1688ff',
    accessibleLabel: 'In development',
  },
  completed: {
    glowing: true,
    dotColor: '#41d878',
    dotGlowColor: '#22c55e',
    accessibleLabel: 'Development completed — awaiting review',
  },
  question: {
    glowing: true,
    dotColor: '#ff9f43',
    dotGlowColor: '#f97316',
    accessibleLabel: 'Waiting for input',
  },
  error: {
    glowing: true,
    dotColor: '#ff5656',
    dotGlowColor: '#ef3232',
    accessibleLabel: 'Error or issue',
  },
  // An open info/warning Notification with nothing more urgent going on (buildingVisualStatus.ts's
  // 'notice' tier) — a soft amber-gold, deliberately distinct from every other tier already on this
  // palette (idle gray, developing/completed blue/green, question orange, error red) so it never reads
  // as "the same as idle" or gets mistaken for the more urgent question/error tiers.
  notice: {
    glowing: true,
    dotColor: '#f2c94c',
    dotGlowColor: '#d9a416',
    accessibleLabel: 'Open notification',
  },
};
