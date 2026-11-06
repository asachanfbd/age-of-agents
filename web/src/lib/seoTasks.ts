/**
 * Pure view-models for the SEO Tasks panel: labels, filters, the quick-action prefills, the proposal review rules and the
 * cron presets. Kept free of React so the rules are testable without a DOM.
 */

export const GROUPS = ['not-started', 'running', 'needs-approval', 'done', 'failed-blocked'] as const;
export type Group = (typeof GROUPS)[number];
export type SourceKind = 'manual' | 'scheduled' | 'agent';
export type LinkType = 'page' | 'keyword' | 'cluster' | 'backlink' | 'sitemap';
export type Owner = 'me' | 'agent' | 'system';
export type DueFilter = 'overdue' | 'today' | 'week' | 'none';

export const GROUP_LABEL: Record<Group, string> = {
  'not-started': 'Not started', running: 'Running', 'needs-approval': 'Needs approval', done: 'Done', 'failed-blocked': 'Failed / Blocked',
};
export const GROUP_TONE: Record<Group, string> = {
  'not-started': 'text-muted-foreground', running: 'text-info-foreground', 'needs-approval': 'text-warning-foreground',
  done: 'text-success-foreground', 'failed-blocked': 'text-destructive',
};
export const SOURCE_LABEL: Record<SourceKind, string> = { manual: 'Manual', scheduled: 'Scheduled', agent: 'Agent' };
export const OWNER_LABEL: Record<Owner, string> = { me: 'Me', agent: 'Agent', system: 'System' };
export const DUE_LABEL: Record<DueFilter, string> = { overdue: 'Overdue', today: 'Due today', week: 'Due this week', none: 'No due date' };
export const LINK_TYPE_LABEL: Record<LinkType, string> = { page: 'Page', keyword: 'Keyword', cluster: 'Cluster', backlink: 'Backlink', sitemap: 'Sitemap' };

export const TASK_KINDS = [
  { key: 'outreach', label: 'Outreach' }, { key: 'content', label: 'Content' }, { key: 'technical-fix', label: 'Technical fix' },
  { key: 'link-building', label: 'Link building' }, { key: 'review', label: 'Review' }, { key: 'other', label: 'Other' },
] as const;
export const MANUAL_STATUSES = [
  { key: 'todo', label: 'To do' }, { key: 'in-progress', label: 'In progress' }, { key: 'blocked', label: 'Blocked' }, { key: 'done', label: 'Done' }, { key: 'cancelled', label: 'Cancelled' },
] as const;
export const PRIORITIES = ['low', 'medium', 'high'] as const;

export const AGENT_SLOTS = [
  { key: 'research', label: 'Keyword research', needsPages: false },
  { key: 'clustering', label: 'Keyword clustering', needsPages: false },
  { key: 'title-meta', label: 'Title and meta proposals', needsPages: true },
  { key: 'content', label: 'Content brief proposals', needsPages: true },
  { key: 'audit', label: 'Site audit from crawl data', needsPages: false },
] as const;
export type AgentSlotKey = (typeof AGENT_SLOTS)[number]['key'];
export const MAX_PAGES_PER_RUN = 100;

export const CRON_PRESETS = [
  { label: 'Every day at 06:00', cron: '0 6 * * *' }, { label: 'Every Monday at 09:00', cron: '0 9 * * 1' },
  { label: 'Every hour', cron: '0 * * * *' }, { label: 'First of the month at 07:00', cron: '0 7 1 * *' },
] as const;

export interface LinkDto { type: LinkType; ref: string; label: string; detail: string; inData: boolean | null }

export interface TaskRowDto {
  id: string; source: SourceKind; title: string; subKind: string; group: Group; statusLabel: string; statusNote: string | null; owner: Owner;
  dueDate: string | null; overdue: boolean; overdueDays: number; priority: 'low' | 'medium' | 'high' | null; links: LinkDto[];
  createdAt: string; updatedAt: string; runId: string | null; jobId: string | null;
}

export interface TaskListDto { today: string; total: number; limit: number; offset: number; counts: Record<Group, number>; tasks: TaskRowDto[] }

export interface HandoffDto {
  path: 'software' | 'manual'; state: 'awaiting-approval' | 'handing-off' | 'handed-off' | 'failed'; targetName: string | null; sessionId: string | null;
  sessionStatus: string | null; error: string | null; manualTaskId: string | null; followUpTaskId: string | null;
}

export interface TaskDetailDto extends TaskRowDto {
  notes?: string; evidence?: string[]; status?: string; kind?: string; slot?: AgentSlotKey; slotLabel?: string; resultNote?: string | null;
  proposalError?: string | null; hasProposal?: boolean; approved?: boolean; handoff?: HandoffDto | null; hasCsv?: boolean;
}

export interface ProposalRowDto {
  id: string; url: string; currentTitle: string; currentMeta: string; proposedTitle: string; proposedMeta: string; notes: string;
  decision: 'pending' | 'accepted' | 'rejected'; editedTitle: string | null; editedMeta: string | null;
}
export interface ProposalDto { rows: ProposalRowDto[]; summary: { accepted: number; rejected: number; pending: number; canApprove: boolean }; error: string | null; skipped: number; approved: boolean }

export interface ScheduleDto {
  id: string; name: string; actionId: string; actionLabel: string; cron: string | null; enabled: boolean; autoDisabled: boolean; consecutiveFailures: number; failureThreshold: number;
  nextRunAt: string | null; group: Group; statusLabel: string; statusNote: string | null; last: { outcome: string; note: string | null; startedAt: string; finishedAt: string | null; startedBy: string } | null;
}

// ---- list filters --------------------------------------------------------------------------------------------------

export interface TaskFilters { kind: SourceKind | ''; group: Group | ''; owner: Owner | ''; due: DueFilter | ''; linkType: LinkType | ''; search: string }
export const NO_FILTERS: TaskFilters = { kind: '', group: '', owner: '', due: '', linkType: '', search: '' };

export const hasFilters = (f: TaskFilters): boolean => Object.values(f).some((v) => v !== '');

export function listParams(f: TaskFilters, limit = 200): URLSearchParams {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries(f)) if (value !== '') params.set(key, value.trim());
  return params;
}

/** The five board columns, in order, each with its tasks. */
export function boardColumns(tasks: readonly TaskRowDto[]): Array<{ group: Group; label: string; tasks: TaskRowDto[] }> {
  return GROUPS.map((group) => ({ group, label: GROUP_LABEL[group], tasks: tasks.filter((t) => t.group === group) }));
}

export const overdueText = (task: Pick<TaskRowDto, 'overdue' | 'overdueDays'>): string | null => (task.overdue ? `Overdue ${task.overdueDays}d` : null);

// ---- creating tasks ------------------------------------------------------------------------------------------------

export interface NewTaskDraft { title: string; kind: string; notes: string; dueDate: string; priority: string; evidence: string[]; link: { type: LinkType; ref: string } | null }
export const EMPTY_DRAFT: NewTaskDraft = { title: '', kind: 'other', notes: '', dueDate: '', priority: '', evidence: [], link: null };

export function draftError(d: NewTaskDraft): string | null {
  if (!d.title.trim()) return 'Give the task a title.';
  if (d.title.trim().length > 500) return 'The title can be at most 500 characters.';
  if (d.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate)) return 'Write the due date as YYYY-MM-DD.';
  const bad = d.evidence.find((e) => !/^https?:\/\/\S+$/i.test(e));
  return bad ? 'Each evidence link must start with http:// or https://.' : null;
}

export function draftRequest(d: NewTaskDraft): Record<string, unknown> {
  return {
    title: d.title.trim(), kind: d.kind, notes: d.notes, dueDate: d.dueDate || null, priority: d.priority || null, evidence: d.evidence, link: d.link,
  };
}

/** Prefilled new-task drafts for the "Create task" shortcuts on the other tabs. */
export const prefill = {
  backlink: (l: { uid: string; sourceUrl: string; targetUrl: string; anchor: string; status: string }): NewTaskDraft => ({
    ...EMPTY_DRAFT, title: `Follow up on backlink from ${hostOf(l.sourceUrl)}`.slice(0, 120), kind: 'link-building',
    notes: [`Source: ${l.sourceUrl}`, `Target: ${l.targetUrl}`, `Anchor: ${l.anchor || '(none)'}`, `Status: ${l.status}`].join('\n'), link: { type: 'backlink', ref: l.uid },
  }),
  unindexedPage: (url: string, reason: string): NewTaskDraft => ({ ...EMPTY_DRAFT, title: `Get ${pathOf(url)} indexed`, kind: 'technical-fix', notes: reason, link: { type: 'page', ref: url } }),
  page: (url: string): NewTaskDraft => ({ ...EMPTY_DRAFT, title: `Work on ${pathOf(url)}`, kind: 'content', link: { type: 'page', ref: url } }),
  keyword: (key: string): NewTaskDraft => ({ ...EMPTY_DRAFT, title: `Work on keyword "${key}"`.slice(0, 120), kind: 'content', link: { type: 'keyword', ref: key } }),
  cluster: (id: string, name: string): NewTaskDraft => ({ ...EMPTY_DRAFT, title: `Work on cluster "${name}"`.slice(0, 120), kind: 'content', link: { type: 'cluster', ref: id } }),
};

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
function pathOf(url: string): string { try { const u = new URL(url); return `${u.pathname}${u.search}` || '/'; } catch { return url; } }

// ---- agent dialog --------------------------------------------------------------------------------------------------

export function agentRequestError(slot: AgentSlotKey, pages: readonly string[], crawlExists: boolean): string | null {
  const def = AGENT_SLOTS.find((s) => s.key === slot)!;
  if (def.needsPages && pages.length === 0) return 'Choose at least one page.';
  if (pages.length > MAX_PAGES_PER_RUN) return `Choose at most ${MAX_PAGES_PER_RUN} pages.`;
  if (slot === 'audit' && !crawlExists) return 'Run a crawl in the Internal links tab first: the audit works from crawl data.';
  return null;
}

/** Splits pasted text (one page address per line or comma) into a unique list. */
export const parsePages = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

// ---- proposal review -----------------------------------------------------------------------------------------------

export const GUIDANCE = { title: { min: 30, max: 60 }, meta: { min: 70, max: 160 } } as const;

export function guidance(field: 'title' | 'meta', text: string): { count: number; state: 'empty' | 'short' | 'good' | 'long'; text: string } {
  const count = [...text].length;
  const { min, max } = GUIDANCE[field];
  const state = count === 0 ? 'empty' : count < min ? 'short' : count > max ? 'long' : 'good';
  return { count, state, text: `${count} characters${state === 'good' ? '' : state === 'empty' ? '' : state === 'short' ? `, aim for ${min} to ${max}` : `, over ${max}`}` };
}

/** Clicking Accept on an accepted row clears it; the same for Reject. */
export function toggledDecision(current: ProposalRowDto['decision'], clicked: 'accepted' | 'rejected'): ProposalRowDto['decision'] {
  return current === clicked ? 'pending' : clicked;
}

export const effectiveTitle = (r: ProposalRowDto): string => r.editedTitle ?? r.proposedTitle;
export const effectiveMeta = (r: ProposalRowDto): string => r.editedMeta ?? r.proposedMeta;

export type DecisionFilter = 'all' | ProposalRowDto['decision'];
export const filterProposal = (rows: readonly ProposalRowDto[], f: DecisionFilter): ProposalRowDto[] => (f === 'all' ? [...rows] : rows.filter((r) => r.decision === f));

export function approveSummary(summary: ProposalDto['summary']): { disabled: boolean; text: string } {
  if (!summary.canApprove) return { disabled: true, text: 'Accept at least one row to approve.' };
  return { disabled: false, text: summary.pending > 0 ? `${summary.accepted} accepted. ${summary.pending} pending will not be included.` : `${summary.accepted} accepted.` };
}

export type HandoffView = { tone: 'good' | 'bad' | 'wait'; title: string; body: string; retry: boolean; fallback: boolean };

export function handoffView(h: HandoffDto): HandoffView {
  if (h.state === 'failed') return { tone: 'bad', title: 'Handoff failed', body: h.error ?? 'The handoff did not complete.', retry: h.path === 'software', fallback: h.manualTaskId === null };
  if (h.state === 'handing-off') return { tone: 'wait', title: 'Handing off…', body: 'Starting a planning session.', retry: false, fallback: false };
  if (h.state === 'awaiting-approval') return { tone: 'wait', title: 'Waiting for approval in Connections', body: 'The Software building asks you to approve the call first.', retry: false, fallback: false };
  if (h.path === 'manual') return { tone: 'good', title: 'Saved as a manual task', body: h.error ?? 'The Building is not linked to a Software building, so the changes are in a manual task with a CSV.', retry: false, fallback: false };
  const status = h.sessionStatus === 'unavailable' ? 'status unavailable' : h.sessionStatus ?? 'started';
  return { tone: 'good', title: `Planning session started in ${h.targetName ?? 'the Software building'}`, body: `Session status: ${status}.`, retry: false, fallback: false };
}

// ---- schedules -----------------------------------------------------------------------------------------------------

export function scheduleError(name: string, actionId: string, cron: string): string | null {
  if (!name.trim()) return 'Give the schedule a name.';
  if (name.trim().length > 120) return 'The name can be at most 120 characters.';
  if (!actionId) return 'Choose what to fetch.';
  return cron.trim().split(/\s+/).length === 5 ? null : 'A cron expression has five fields, for example 0 6 * * *.';
}

export const triggerLabel = (s: Pick<ScheduleDto, 'enabled' | 'autoDisabled'>): string => (s.autoDisabled ? 'Turned off after failures' : s.enabled ? 'On' : 'Paused');

export const canRunNow = (s: Pick<ScheduleDto, 'last'>): boolean => s.last?.outcome !== 'running' && s.last?.outcome !== 'queued';
