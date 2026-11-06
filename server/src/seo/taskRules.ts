import { isIsoDay } from './dates.ts';
import { SeoInputError } from './errors.ts';
import { normalizeKeyword } from './keywordRules.ts';
import { normalizePageUrl } from './urls.ts';

/** Limits on what the Tasks panel accepts. The spec gave none, so these are named here. */
export const TASK_LIMITS = {
  title: 500,
  notes: 20_000,
  evidenceLinks: 20,
  evidenceUrl: 2048,
  pageRef: 2048,
  textRef: 500,
  /** The scheduler's own limit on a job name. */
  scheduleName: 120,
  proposedTitle: 500,
  proposedMeta: 1000,
  pagesPerRun: 100,
  /** The Software building's `start-planning-session` prompt limit. */
  handoffPrompt: 10_000,
  idLength: 100,
} as const;
export const MIN_DUE_DAY = '2000-01-01';
export const MAX_DUE_DAY = '2100-12-31';
export const MAX_TASK_PAGE_SIZE = 500;
export const DEFAULT_TASK_PAGE_SIZE = 100;
export const MAX_TASK_OFFSET = 10_000_000;

export const TASK_KINDS = ['outreach', 'content', 'technical-fix', 'link-building', 'review', 'other'] as const;
export const MANUAL_STATUSES = ['todo', 'in-progress', 'blocked', 'done', 'cancelled'] as const;
export const PRIORITIES = ['low', 'medium', 'high'] as const;
export const LINK_TYPES = ['page', 'keyword', 'cluster', 'backlink', 'sitemap'] as const;
export const OWNERS = ['me', 'agent', 'system'] as const;
export const SOURCE_KINDS = ['manual', 'scheduled', 'agent'] as const;
export const GROUPS = ['not-started', 'running', 'needs-approval', 'done', 'failed-blocked'] as const;
export const DUE_FILTERS = ['overdue', 'today', 'week', 'none'] as const;

export type TaskKind = (typeof TASK_KINDS)[number];
export type ManualStatus = (typeof MANUAL_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type LinkType = (typeof LINK_TYPES)[number];
export type Owner = (typeof OWNERS)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type Group = (typeof GROUPS)[number];

// ---- field validation -----------------------------------------------------------------------------------------------

export function requireTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new SeoInputError('title is required');
  if (title.length > TASK_LIMITS.title) throw new SeoInputError(`title must be at most ${TASK_LIMITS.title} characters`);
  return title;
}

export function optionalNotes(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new SeoInputError('notes must be text');
  if (value.length > TASK_LIMITS.notes) throw new SeoInputError(`notes must be at most ${TASK_LIMITS.notes.toLocaleString('en-US')} characters`);
  return value;
}

export function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new SeoInputError(`${field} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

export function optionalPriority(value: unknown): Priority | null {
  return value === undefined || value === null ? null : requireOneOf(value, PRIORITIES, 'priority');
}

/** A due date is a plain calendar day, never a moment in time. */
export function optionalDueDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isIsoDay(value)) throw new SeoInputError('dueDate must be a real calendar date written YYYY-MM-DD');
  if (value < MIN_DUE_DAY || value > MAX_DUE_DAY) throw new SeoInputError(`dueDate must be between ${MIN_DUE_DAY} and ${MAX_DUE_DAY}`);
  return value;
}

export function evidenceLinks(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SeoInputError('evidence must be a list of links');
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new SeoInputError('each evidence link must be text');
    const text = entry.trim();
    if (text.length > TASK_LIMITS.evidenceUrl) throw new SeoInputError(`an evidence link must be at most ${TASK_LIMITS.evidenceUrl.toLocaleString('en-US')} characters`);
    let url: URL;
    try { url = new URL(text); } catch { throw new SeoInputError('each evidence link must be a full http or https address'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SeoInputError('each evidence link must start with http:// or https://');
    if (url.username || url.password) throw new SeoInputError('an evidence link must not contain a user name or password');
    seen.add(text);
  }
  if (seen.size > TASK_LIMITS.evidenceLinks) throw new SeoInputError(`at most ${TASK_LIMITS.evidenceLinks} evidence links are allowed`);
  return [...seen];
}

// ---- linked items ---------------------------------------------------------------------------------------------------

export interface LinkInput { type: LinkType; ref: string }

/** Normalises what the person named: a page address or keyword is brought to its one spelling; other references are ids. */
export function parseLink(value: unknown): LinkInput | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new SeoInputError('link must be an object with a type and a ref');
  const { type, ref } = value as { type?: unknown; ref?: unknown };
  const linkType = requireOneOf(type, LINK_TYPES, 'link.type');
  if (typeof ref !== 'string' || !ref.trim()) throw new SeoInputError('link.ref is required');
  const limit = linkType === 'page' || linkType === 'sitemap' ? TASK_LIMITS.pageRef : TASK_LIMITS.textRef;
  if (ref.length > limit) throw new SeoInputError(`link.ref must be at most ${limit.toLocaleString('en-US')} characters`);
  if (linkType === 'page' || linkType === 'sitemap') {
    const url = normalizePageUrl(ref);
    if (!url) throw new SeoInputError('link.ref must be a full http or https address');
    return { type: linkType, ref: url };
  }
  if (linkType === 'keyword') {
    const key = normalizeKeyword(ref);
    if (!key) throw new SeoInputError('link.ref must be a keyword');
    return { type: linkType, ref: key };
  }
  return { type: linkType, ref: ref.trim() };
}

/** What the task remembers about its target, so it still reads sensibly after the target leaves the data. */
export interface LinkSnapshot { type: LinkType; ref: string; label: string; detail: string }

export function snapshotOf(type: LinkType, ref: string, facts: { label?: string; detail?: string } = {}): LinkSnapshot {
  const fallback: Record<LinkType, string> = { page: ref, keyword: ref, cluster: ref, backlink: ref, sitemap: ref };
  return { type, ref, label: (facts.label ?? fallback[type]).slice(0, TASK_LIMITS.pageRef), detail: (facts.detail ?? '').slice(0, TASK_LIMITS.textRef) };
}

// ---- patching -------------------------------------------------------------------------------------------------------

export interface ManualFields {
  title: string; kind: TaskKind; notes: string; status: ManualStatus; priority: Priority | null; dueDate: string | null; evidence: string[];
}

/** Checks a create body. Unknown fields are ignored; optional fields are null when empty. */
export function parseManualCreate(body: unknown): ManualFields & { link: LinkInput | null } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SeoInputError('the task must be a JSON object');
  const b = body as Record<string, unknown>;
  return {
    title: requireTitle(b.title),
    kind: b.kind === undefined ? 'other' : requireOneOf(b.kind, TASK_KINDS, 'kind'),
    notes: optionalNotes(b.notes),
    status: b.status === undefined ? 'todo' : requireOneOf(b.status, MANUAL_STATUSES, 'status'),
    priority: optionalPriority(b.priority),
    dueDate: optionalDueDate(b.dueDate),
    evidence: evidenceLinks(b.evidence),
    link: parseLink(b.link),
  };
}

/** Merges an edit over a task's fields. Present fields are checked; absent ones stay. */
export function parseManualPatch(current: ManualFields, body: unknown): ManualFields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SeoInputError('the change must be a JSON object');
  const b = body as Record<string, unknown>;
  return {
    title: b.title === undefined ? current.title : requireTitle(b.title),
    kind: b.kind === undefined ? current.kind : requireOneOf(b.kind, TASK_KINDS, 'kind'),
    notes: b.notes === undefined ? current.notes : optionalNotes(b.notes),
    status: b.status === undefined ? current.status : requireOneOf(b.status, MANUAL_STATUSES, 'status'),
    priority: b.priority === undefined ? current.priority : optionalPriority(b.priority),
    dueDate: b.dueDate === undefined ? current.dueDate : optionalDueDate(b.dueDate),
    evidence: b.evidence === undefined ? current.evidence : evidenceLinks(b.evidence),
  };
}

// ---- status groups --------------------------------------------------------------------------------------------------

export interface StatusView { group: Group; label: string }

export const GROUP_LABELS: Record<Group, string> = {
  'not-started': 'Not started', running: 'Running', 'needs-approval': 'Needs approval', done: 'Done', 'failed-blocked': 'Failed / Blocked',
};

export function manualStatusView(status: ManualStatus): StatusView {
  switch (status) {
    case 'todo': return { group: 'not-started', label: 'To do' };
    case 'in-progress': return { group: 'running', label: 'In progress' };
    case 'blocked': return { group: 'failed-blocked', label: 'Blocked' };
    case 'done': return { group: 'done', label: 'Done' };
    case 'cancelled': return { group: 'done', label: 'Cancelled' };
  }
}

export type RunStatus = 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'stopped';
export interface RunSnapshot { status: RunStatus; note: string | null }

export type HandoffState = 'awaiting-approval' | 'handing-off' | 'handed-off' | 'failed';

const LIMIT_NOTE = /usage limit|limit reached|resets? at/i;

/** An agent task's status comes from its run, then from what happened to the approved proposal. */
export function agentStatusView(input: { run: RunSnapshot | null; startError?: string | null; approved?: boolean; handoff?: HandoffState | null }): StatusView & { note: string | null } {
  if (input.handoff === 'handed-off') return { group: 'done', label: 'Handed off', note: null };
  if (input.handoff === 'failed') return { group: 'failed-blocked', label: 'Handoff failed', note: null };
  if (input.handoff === 'handing-off' || input.handoff === 'awaiting-approval') return { group: 'running', label: input.handoff === 'handing-off' ? 'Handing off' : 'Handoff waiting for approval', note: null };
  if (input.approved) return { group: 'done', label: 'Approved', note: null };
  if (input.startError) return { group: 'failed-blocked', label: 'Could not start', note: input.startError };
  const run = input.run;
  if (!run) return { group: 'not-started', label: 'Queued', note: null };
  switch (run.status) {
    case 'running': return LIMIT_NOTE.test(run.note ?? '') ? { group: 'not-started', label: 'Deferred (usage limit)', note: run.note } : { group: 'running', label: 'Running', note: run.note };
    case 'awaiting-approval': return { group: 'needs-approval', label: 'Needs approval', note: run.note };
    case 'succeeded': return { group: 'done', label: 'Done', note: run.note };
    case 'failed': return { group: 'failed-blocked', label: 'Failed', note: run.note };
    case 'stopped': return { group: 'failed-blocked', label: 'Stopped', note: run.note };
  }
}

/** A scheduled fetch's status from its job and the newest history entry. */
export function scheduleStatusView(job: { enabled: boolean; autoDisabled: boolean }, last: { outcome: string; note: string | null } | null): StatusView & { note: string | null } {
  if (job.autoDisabled) return { group: 'failed-blocked', label: 'Turned off after failures', note: last?.note ?? null };
  if (last && (last.outcome === 'running' || last.outcome === 'queued')) return { group: 'running', label: last.outcome === 'queued' ? 'Queued' : 'Running', note: last.note };
  if (!job.enabled) return { group: 'not-started', label: 'Paused', note: null };
  if (!last) return { group: 'not-started', label: 'Scheduled', note: null };
  if (last.outcome === 'failed' || last.outcome === 'check-failed') return { group: 'failed-blocked', label: 'Last run failed', note: last.note };
  if (last.outcome === 'succeeded') return { group: 'done', label: 'Last run OK', note: last.note };
  if (last.outcome === 'skipped') return { group: 'not-started', label: 'Last run skipped', note: last.note };
  return { group: 'not-started', label: 'Scheduled', note: last.note };
}

// ---- dates ----------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/** The calendar day an instant falls on in a timezone. */
export function dayIn(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export const addDay = (day: string, days: number): string => new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10);

/** Only a manual task that is still open can be overdue, and only after its due day has passed. Returns the days late, or 0. */
export function overdueDays(task: { dueDate: string | null; status: ManualStatus }, today: string): number {
  if (!task.dueDate || task.status === 'done' || task.status === 'cancelled') return 0;
  return Math.max(0, dayNumber(today) - dayNumber(task.dueDate));
}

export type DueFilter = (typeof DUE_FILTERS)[number];

/** `week` is today through today + 7, inclusive. */
export function matchesDue(dueDate: string | null, filter: DueFilter, today: string): boolean {
  if (filter === 'none') return dueDate === null;
  if (dueDate === null) return false;
  if (filter === 'overdue') return dueDate < today;
  if (filter === 'today') return dueDate === today;
  return dueDate >= today && dueDate <= addDay(today, 7);
}

// ---- unified rows and filtering -------------------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  source: SourceKind;
  title: string;
  /** The manual kind, the agent slot or the schedule action. */
  subKind: string;
  group: Group;
  statusLabel: string;
  statusNote: string | null;
  owner: Owner;
  dueDate: string | null;
  overdue: boolean;
  overdueDays: number;
  priority: Priority | null;
  links: Array<LinkSnapshot & { inData: boolean | null }>;
  createdAt: string;
  updatedAt: string;
  runId: string | null;
  jobId: string | null;
}

export interface TaskFilter { source?: SourceKind; group?: Group; owner?: Owner; due?: DueFilter; linkType?: LinkType; search?: string }

export function filterRows(rows: TaskRow[], filter: TaskFilter, today: string): TaskRow[] {
  const search = filter.search?.trim().toLowerCase();
  return rows.filter((row) =>
    (!filter.source || row.source === filter.source)
    && (!filter.group || row.group === filter.group)
    && (!filter.owner || row.owner === filter.owner)
    && (!filter.due || matchesDue(row.dueDate, filter.due, today))
    && (!filter.linkType || row.links.some((l) => l.type === filter.linkType))
    && (!search || row.title.toLowerCase().includes(search) || row.links.some((l) => l.label.toLowerCase().includes(search))));
}

/** Newest update first; ties keep a stable order by id. */
export function orderRows(rows: TaskRow[]): TaskRow[] {
  return [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function groupCounts(rows: TaskRow[]): Record<Group, number> {
  const counts = Object.fromEntries(GROUPS.map((g) => [g, 0])) as Record<Group, number>;
  for (const row of rows) counts[row.group]++;
  return counts;
}

export function requireTaskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > TASK_LIMITS.idLength) throw new SeoInputError('that is not a task id');
  return value;
}

// ---- list query -----------------------------------------------------------------------------------------------------

const optionalEnum = <T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined => (value === undefined || value === '' ? undefined : requireOneOf(value, allowed, field));

function wholeQuery(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new SeoInputError(`${field} must be a whole number from ${min} to ${max}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new SeoInputError(`${field} must be a whole number from ${min} to ${max}`);
  return n;
}

export function parseTaskQuery(query: Record<string, unknown>): { filter: TaskFilter; limit: number; offset: number } {
  const search = typeof query.search === 'string' ? query.search : undefined;
  if (search !== undefined && search.length > TASK_LIMITS.title) throw new SeoInputError(`search must be at most ${TASK_LIMITS.title} characters`);
  return {
    filter: {
      source: optionalEnum(query.kind, SOURCE_KINDS, 'kind'), group: optionalEnum(query.group, GROUPS, 'group'), owner: optionalEnum(query.owner, OWNERS, 'owner'),
      due: optionalEnum(query.due, DUE_FILTERS, 'due'), linkType: optionalEnum(query.linkType, LINK_TYPES, 'linkType'), search,
    },
    limit: wholeQuery(query.limit, 'limit', 1, MAX_TASK_PAGE_SIZE, DEFAULT_TASK_PAGE_SIZE),
    offset: wholeQuery(query.offset, 'offset', 0, MAX_TASK_OFFSET, 0),
  };
}
