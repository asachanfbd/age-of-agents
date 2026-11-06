import { assertWritable } from '../buildings/normalize.ts';
import { jobHistoryDb, scheduledJobsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { notificationsDb } from '../db/collections.ts';
import type { JobHistoryEntry, ScheduledJobRecord } from '../scheduler/types.ts';
import { resolveTimezone } from '../scheduler/cron.ts';
import { agentRunState, agentStatus, settleAgent, slotLabel, patchAgentTask } from './agentTasks.ts';
import { seoDeps } from './deps.ts';
import { SeoConflictError, SeoInputError, SeoNotFoundError } from './errors.ts';
import { SCHEDULE_ACTION_LIST } from './scheduleActionList.ts';
import { linksInData } from './taskLinks.ts';
import { taskPorts } from './taskPorts.ts';
import { createManualRecord, readTask, readTasks, removeTask, saveTask, withTaskLock } from './taskStore.ts';
import type { AgentRecord, ManualRecord, TaskRecord } from './taskStore.ts';
import {
  dayIn, filterRows, groupCounts, manualStatusView, orderRows, overdueDays, parseLink, parseManualPatch, parseTaskQuery, requireTaskId, scheduleStatusView,
} from './taskRules.ts';
import type { LinkSnapshot, TaskRow } from './taskRules.ts';

export const actionLabel = (actionId: string): string => SCHEDULE_ACTION_LIST.find((a) => a.id === actionId)?.label ?? actionId;

/** Today's calendar day in the Building's timezone (the host's when it has none). */
export function todayFor(project: ProjectRecord): string {
  return dayIn(seoDeps().now(), resolveTimezone(project.timezone, taskPorts().hostTimezone()));
}

const withPresence = (links: LinkSnapshot[]) => links.map((l) => ({ ...l, inData: null as boolean | null }));

function manualRow(r: ManualRecord, today: string): TaskRow {
  const status = manualStatusView(r.status);
  const late = overdueDays(r, today);
  return {
    id: r.id, source: 'manual', title: r.title, subKind: r.kind, group: status.group, statusLabel: status.label, statusNote: null, owner: r.owner,
    dueDate: r.dueDate, overdue: late > 0, overdueDays: late, priority: r.priority, links: withPresence(r.link ? [r.link] : []),
    createdAt: r.createdAt, updatedAt: r.updatedAt, runId: null, jobId: null,
  };
}

async function agentRow(project: ProjectRecord, r: AgentRecord): Promise<TaskRow> {
  const settled = await settleAgent(project, r.id);
  const status = agentStatus(settled, await agentRunState(settled));
  return {
    id: settled.id, source: 'agent', title: settled.title, subKind: settled.slot, group: status.group, statusLabel: status.label, statusNote: status.note, owner: 'agent',
    dueDate: null, overdue: false, overdueDays: 0, priority: null, links: withPresence(settled.links), createdAt: settled.createdAt, updatedAt: settled.updatedAt, runId: settled.runId, jobId: null,
  };
}

const isSeoJob = (job: ScheduledJobRecord): boolean => job.target.kind === 'action';

async function jobsWithLast(project: ProjectRecord): Promise<Array<{ job: ScheduledJobRecord; last: JobHistoryEntry | null }>> {
  const jobs = (await scheduledJobsDb.find((j) => j.projectId === project.id)).filter(isSeoJob);
  const ids = new Set(jobs.map((j) => j.id));
  const entries = await jobHistoryDb.find((e) => ids.has(e.jobId));
  return jobs.map((job) => ({ job, last: entries.filter((e) => e.jobId === job.id).sort((a, b) => b.seq - a.seq)[0] ?? null }));
}

function scheduleRow({ job, last }: { job: ScheduledJobRecord; last: JobHistoryEntry | null }): TaskRow {
  const status = scheduleStatusView(job, last);
  const actionId = job.target.kind === 'action' ? job.target.actionId : '';
  return {
    id: job.id, source: 'scheduled', title: job.name, subKind: actionId, group: status.group, statusLabel: status.label, statusNote: status.note, owner: 'system',
    dueDate: null, overdue: false, overdueDays: 0, priority: null, links: [], createdAt: job.createdAt, updatedAt: job.updatedAt, runId: last?.runId ?? null, jobId: job.id,
  };
}

/** A scheduled fetch as the Schedules view shows it. */
export async function scheduleViews(project: ProjectRecord) {
  return (await jobsWithLast(project)).map(({ job, last }) => {
    const status = scheduleStatusView(job, last);
    const actionId = job.target.kind === 'action' ? job.target.actionId : '';
    return {
      id: job.id, name: job.name, actionId, actionLabel: actionLabel(actionId), cron: job.trigger.kind === 'cron' ? job.trigger.cron : null, enabled: job.enabled,
      autoDisabled: job.autoDisabled, consecutiveFailures: job.consecutiveFailures, failureThreshold: job.failureThreshold, nextRunAt: job.nextRunAt,
      group: status.group, statusLabel: status.label, statusNote: status.note,
      last: last ? { outcome: last.outcome, note: last.note, startedAt: last.startedAt, finishedAt: last.finishedAt, startedBy: last.startedBy } : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function allRows(project: ProjectRecord, today: string): Promise<TaskRow[]> {
  const stored = await readTasks(project);
  const rows: TaskRow[] = [];
  for (const record of stored) rows.push(record.source === 'manual' ? manualRow(record, today) : await agentRow(project, record));
  for (const entry of await jobsWithLast(project)) rows.push(scheduleRow(entry));
  return orderRows(rows);
}

/** The unified list: manual, scheduled and agent tasks, filtered and paged, with the counts per status group for the filtered set. */
export async function listTasks(project: ProjectRecord, query: Record<string, unknown>) {
  const { filter, limit, offset } = parseTaskQuery(query);
  const today = todayFor(project);
  const filtered = filterRows(await allRows(project, today), filter, today);
  return { today, total: filtered.length, limit, offset, counts: groupCounts(filtered), tasks: filtered.slice(offset, offset + limit) };
}

// ---- one task -------------------------------------------------------------------------------------------------------

async function withPresenceOf(project: ProjectRecord, links: LinkSnapshot[]) {
  const present = await linksInData(project, links);
  return links.map((l, i) => ({ ...l, inData: present[i]! }));
}

export async function taskDetail(project: ProjectRecord, rawId: string) {
  const id = requireTaskId(rawId);
  const today = todayFor(project);
  const record = await readTask(project, id);
  if (record?.source === 'manual') {
    const row = manualRow(record, today);
    return { ...row, links: await withPresenceOf(project, record.link ? [record.link] : []), notes: record.notes, evidence: record.evidence, status: record.status, kind: record.kind, createdBy: record.createdBy, completedAt: record.completedAt, fromAgentTaskId: record.fromAgentTaskId, hasCsv: record.csv !== null };
  }
  if (record?.source === 'agent') {
    const settled = await settleAgent(project, id);
    const row = await agentRow(project, settled);
    return {
      ...row, links: await withPresenceOf(project, settled.links), slot: settled.slot, slotLabel: slotLabel(settled.slot), inputs: { pages: settled.inputs.pages, competitors: settled.inputs.competitors },
      resultNote: settled.resultNote, proposalError: settled.proposalError, hasProposal: settled.proposal !== null, approved: settled.approvedAt !== null, handoff: settled.handoff,
    };
  }
  const entry = (await jobsWithLast(project)).find((e) => e.job.id === id);
  if (entry) return scheduleRow(entry);
  throw new SeoNotFoundError('There is no such task');
}

const refreshOverdue = (project: ProjectRecord) => checkOverdue(project).catch((error) => console.error('Could not update the overdue notification:', error));

export async function createTask(project: ProjectRecord, body: unknown): Promise<TaskRow> {
  const row = manualRow(await createManualRecord(project, body), todayFor(project));
  await refreshOverdue(project);
  return row;
}

export async function patchTask(project: ProjectRecord, rawId: string, body: unknown): Promise<TaskRow> {
  assertWritable(project);
  const id = requireTaskId(rawId);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SeoInputError('the change must be a JSON object');
  const record = await readTask(project, id);
  if (!record) {
    if ((await jobsWithLast(project)).some((e) => e.job.id === id)) throw new SeoInputError('the status of a scheduled fetch comes from its runs and cannot be set');
    throw new SeoNotFoundError('There is no such task');
  }
  if (record.source === 'agent') return agentRow(project, await patchAgentTask(project, id, body as Record<string, unknown>));
  const row = await withTaskLock(project.id, async () => {
    const current = (await readTask(project, id)) as ManualRecord | null;
    if (!current) throw new SeoNotFoundError('There is no such task');
    const fields = parseManualPatch(current, body);
    const now = seoDeps().now().toISOString();
    const completedAt = fields.status === 'done' ? (current.status === 'done' ? current.completedAt : now) : null;
    const saved = (await saveTask(project, { ...current, ...fields, completedAt })) as ManualRecord;
    return manualRow(saved, todayFor(project));
  });
  await refreshOverdue(project);
  return row;
}

/** Deletes a manual task. An agent task's run and a scheduled fetch keep their own history, so they are not deleted here. */
export async function deleteTask(project: ProjectRecord, rawId: string): Promise<void> {
  assertWritable(project);
  const id = requireTaskId(rawId);
  await withTaskLock(project.id, async () => {
    const record = await readTask(project, id);
    if (!record) {
      if ((await jobsWithLast(project)).some((e) => e.job.id === id)) throw new SeoConflictError('A scheduled fetch is removed from Schedules, not here');
      throw new SeoNotFoundError('There is no such task');
    }
    if (record.source !== 'manual') throw new SeoConflictError('An agent task keeps its run in the history and cannot be deleted here');
    await removeTask(project, id);
  });
  await refreshOverdue(project);
}

export async function manualCsv(project: ProjectRecord, rawId: string): Promise<string> {
  const record = await readTask(project, requireTaskId(rawId));
  if (record?.source !== 'manual' || record.csv === null) throw new SeoNotFoundError('That task has no CSV');
  return record.csv;
}

// ---- related tasks --------------------------------------------------------------------------------------------------

const hasLink = (record: TaskRecord, type: string, ref: string): boolean =>
  record.source === 'manual' ? record.link?.type === type && record.link.ref === ref : record.links.some((l) => l.type === type && l.ref === ref);

/** Every task that names an item, done ones included, newest first: the "tasks related to this page" block. */
export async function relatedTasks(project: ProjectRecord, query: Record<string, unknown>) {
  const link = parseLink({ type: query.type, ref: query.ref });
  if (!link) throw new SeoInputError('type and ref are required');
  const today = todayFor(project);
  const matches = (await readTasks(project)).filter((r) => hasLink(r, link.type, link.ref));
  const rows: TaskRow[] = [];
  for (const record of matches) rows.push(record.source === 'manual' ? manualRow(record, today) : await agentRow(project, record));
  const inData = (await linksInData(project, [{ type: link.type, ref: link.ref, label: link.ref, detail: '' }]))[0]!;
  return { inData, tasks: orderRows(rows).map((row) => ({ ...row, links: row.links.map((l) => ({ ...l, inData: l.type === link.type && l.ref === link.ref ? inData : null })) })) };
}

// ---- overdue notification -------------------------------------------------------------------------------------------

/**
 * Keeps one notification per Building for its overdue manual tasks. It is raised when the set of overdue tasks changes,
 * not on every check, and resolved once none is left.
 */
export async function checkOverdue(project: ProjectRecord): Promise<number> {
  const today = todayFor(project);
  const late = (await readTasks(project)).filter((r): r is ManualRecord => r.source === 'manual' && overdueDays(r, today) > 0).sort((a, b) => a.id.localeCompare(b.id));
  const subject = { type: 'project', projectId: project.id } as const;
  if (!late.length) {
    await resolveNotifications(subject, ['seo.tasks_overdue']);
    return 0;
  }
  const description = `${late.map((r) => `${r.title} (due ${r.dueDate})`).slice(0, 5).join('; ')}${late.length > 5 ? `; and ${late.length - 5} more` : ''}`;
  const open = (await notificationsDb.find((n) => n.kind === 'seo.tasks_overdue' && n.resolvedAt === null && n.projectId === project.id))[0];
  const title = `${project.name}: ${late.length} overdue SEO task${late.length === 1 ? '' : 's'}`;
  if (open?.title !== title || open.description !== description) await raiseNotification({ kind: 'seo.tasks_overdue', subject, title, description });
  return late.length;
}
