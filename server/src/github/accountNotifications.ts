import { listNotifications, raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import type { NotificationSubject, ProjectRecord } from '../domain/types.ts';

const KIND = 'github.account_failed';

const subjectOf = (project: ProjectRecord): NotificationSubject => ({ type: 'project', projectId: project.id });

/** Shows a background GitHub failure under its project. An unchanged message does not re-notify on every poll. */
export async function reportAccountFailure(project: ProjectRecord, message: string): Promise<void> {
  const title = `GitHub account problem in "${project.name}"`;
  const existing = (await listNotifications({ resolved: false, projectId: project.id })).find((n) => n.kind === KIND);
  if (existing && existing.title === title && existing.description === message) return;
  await raiseNotification({ kind: KIND, subject: subjectOf(project), title, description: message });
}

export async function clearAccountFailure(project: ProjectRecord): Promise<void> {
  await resolveNotifications(subjectOf(project), [KIND]);
}
