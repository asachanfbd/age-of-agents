import { highestOpenSeverity, openNotificationsForProject, useWorldStore, type WorldState } from '../store/worldStore';
import type { ProjectData, TaskData } from '../types';
import { BUILDING_STATUS_STYLES, buildingVisualStatus, describeAttention, type BuildingVisualStatus, type StatusStyle } from './buildingVisualStatus';
import { isOutOfSync } from './gitSync';
import { taskProgress, type TaskProgress } from './projectTasks';

export interface ProjectIndicators {
  statusStyle: StatusStyle;
  /** Why the dot looks the way it does — its accessible label and hover text. */
  dotLabel: string;
  /** Null until the project has at least one plan item. */
  progress: TaskProgress | null;
}

/**
 * The status dot and task progress shown next to a project's name — shared by the 3D warehouse label
 * (scene/ProjectYard.tsx) and the non-3D cards view (ui/ProjectCardsView.tsx) so both always agree.
 */
export function useProjectIndicators(project: ProjectData): ProjectIndicators {
  const latestTaskId = useWorldStore((s) => s.lastTaskIdByProject[project.id]);
  const latestTask = useWorldStore((s) => latestTaskId ? s.tasksById[latestTaskId] : undefined);
  const latestTaskReviewed = useWorldStore((s) => latestTaskId ? !!s.reviewedTaskIds[latestTaskId] : false);
  const notificationsById = useWorldStore((s) => s.notificationsById);
  const planItems = useWorldStore((s) => s.planByProject[project.id]?.items);

  const visualStatus = projectVisualStatus(project, latestTask, latestTaskReviewed, notificationsById);
  // There can be several open Notifications for a Project; the dot only has room to explain one, so
  // pick whichever is at the highest severity (first match).
  const notificationSeverity = highestOpenSeverity(notificationsById, project.id);
  const primaryNotification = openNotificationsForProject(notificationsById, project.id)
    .find((n) => n.severity === notificationSeverity) ?? null;
  const outOfSync = isOutOfSync(project.sync);
  const statusStyle = BUILDING_STATUS_STYLES[visualStatus];
  // describeAttention explains both the 'error' and 'notice' tiers — ProjectWorkspaceModal.tsx's
  // attention banner is the other consumer, so the "why" text can never drift apart.
  const dotLabel = describeAttention(visualStatus, latestTaskReviewed ? undefined : latestTask, outOfSync, project.sync, primaryNotification)
    ?? statusStyle.accessibleLabel;

  return {
    statusStyle,
    dotLabel,
    progress: planItems && planItems.length > 0 ? taskProgress(planItems) : null,
  };
}

/** A Project's visual status from its latest Task and open Notifications: the one rule behind every status dot. */
export function projectVisualStatus(
  project: ProjectData,
  latestTask: TaskData | undefined,
  latestTaskReviewed: boolean,
  notificationsById: WorldState['notificationsById'],
): BuildingVisualStatus {
  return buildingVisualStatus(project.status, latestTask, latestTaskReviewed, isOutOfSync(project.sync), highestOpenSeverity(notificationsById, project.id));
}

type StatusState = Pick<WorldState, 'lastTaskIdByProject' | 'tasksById' | 'reviewedTaskIds' | 'notificationsById'>;

/** A Project's status dot colour, for many Projects at once (the minimap). */
export function projectDotColor(project: ProjectData, state: StatusState): string {
  const latestTaskId = state.lastTaskIdByProject[project.id];
  const latestTask = latestTaskId ? state.tasksById[latestTaskId] : undefined;
  const reviewed = latestTaskId ? !!state.reviewedTaskIds[latestTaskId] : false;
  return BUILDING_STATUS_STYLES[projectVisualStatus(project, latestTask, reviewed, state.notificationsById)].dotColor;
}
