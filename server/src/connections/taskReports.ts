import type { PlanItemRecord, StepRunRecord, StepRunStatus, WorkflowRunRecord } from '../domain/types.ts';
import { splitNumberedTitle } from '../projects/bugs.ts';
import { CapabilityError, parseWhen } from './rules.ts';

/**
 * What the Software Building tells a linked Building about its tasks (`get-task-details`, `list-completed-tasks`).
 * Pure: the capability handlers load the stored records and hand them in, so the status words, step states, cuts
 * and paging are decided here from fixed data.
 */

/** Long text is cut at these many characters and flagged; each limit is documented in the blueprint. */
export const TASK_REPORT_LIMITS = {
  description: 20_000,
  stepSummary: 2_000,
  outcome: 5_000,
  steps: 100,
  snippet: 160,
  /** Longest accepted task id, board number, search text or cursor. */
  input: 200,
  pageDefault: 20,
  pageMax: 100,
} as const;

export const TASK_NOT_FOUND = 'Task not found';

export type TaskStatus = 'ready' | 'waiting' | 'running' | 'waiting-for-input' | 'awaiting-approval' | 'needs-attention' | 'failed' | 'stopped' | 'completed' | 'archived';
export type TaskPhase = 'not-started' | 'in-progress' | 'completed';
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'stopped';

export interface TaskRecords {
  item: PlanItemRecord;
  /** Every run of the item, any order. */
  runs: WorkflowRunRecord[];
  /** The step rounds of the run that is reported. */
  stepRuns: StepRunRecord[];
}

/** Auto-merge states in which a finished task is still waiting for its pull request (the board holds it out of Completed). */
const MERGE_PENDING = new Set(['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent', 'failed', 'cannot-merge', 'no-pr']);

/** The run the board shows for the item: the one it points at, else the newest. */
export function latestRun(item: PlanItemRecord, runs: readonly WorkflowRunRecord[]): WorkflowRunRecord | undefined {
  return runs.find((run) => run.id === item.workflowRunId) ?? [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

const isFinished = (item: PlanItemRecord, run: WorkflowRunRecord | undefined): boolean => item.status === 'done' || run?.status === 'completed';

/** A finished task with Auto-merge on is not completed until its pull request is merged (the Tasks board's rule). */
function awaitsMerge(item: PlanItemRecord, run: WorkflowRunRecord | undefined): boolean {
  if (item.prConflict || item.testingSetup || !item.workflowRunId || !item.autoMerge?.enabled) return false;
  return isFinished(item, run) && MERGE_PENDING.has(item.autoMerge.state);
}

/** Done work counts as completed even after archiving; work held for its merge does not. */
export function isCompletedTask(item: PlanItemRecord, run: WorkflowRunRecord | undefined): boolean {
  return isFinished(item, run) && !awaitsMerge(item, run);
}

export function completedAtOf(item: PlanItemRecord, run: WorkflowRunRecord | undefined): string {
  return run?.completedAt ?? item.updatedAt;
}

/** `10.017` for a planned task, the number a bug carries in its title, or null. */
export function boardNumber(item: PlanItemRecord): string | null {
  return splitNumberedTitle(item.title).number ?? (item.planningRef ? `${item.planningRef.session}.${String(item.planningRef.task).padStart(3, '0')}` : null);
}

const RUN_STATUS: Partial<Record<WorkflowRunRecord['status'], TaskStatus>> = {
  starting: 'running', running: 'running', completing: 'running', 'awaiting-approval': 'awaiting-approval', 'needs-attention': 'needs-attention', failed: 'failed', stopped: 'stopped',
};

export function statusOf(item: PlanItemRecord, run: WorkflowRunRecord | undefined): TaskStatus {
  if (item.archived) return 'archived';
  if (awaitsMerge(item, run)) return 'waiting';
  if (isFinished(item, run)) return 'completed';
  const fromRun = run && RUN_STATUS[run.status];
  if (fromRun) return fromRun;
  if (item.status === 'failed' || item.status === 'stopped') return item.status;
  if (item.waiting) return 'waiting';
  if (item.status === 'blocked') return 'waiting-for-input';
  return item.status === 'developing' ? 'running' : 'ready';
}

export function phaseOf(item: PlanItemRecord, run: WorkflowRunRecord | undefined): TaskPhase {
  if (isCompletedTask(item, run)) return 'completed';
  if (item.archived) return run ? 'in-progress' : 'not-started';
  const status = statusOf(item, run);
  if (status === 'ready') return 'not-started';
  return status === 'waiting' && !awaitsMerge(item, run) ? 'not-started' : 'in-progress';
}

/** Cuts to `max` characters without splitting a surrogate pair. */
export function cut(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text];
  return chars.length > max ? { text: chars.slice(0, max).join(''), truncated: true } : { text, truncated: false };
}

const STEP_STATE: Record<StepRunStatus, StepState> = {
  running: 'running', 'awaiting-approval': 'running', 'changes-requested': 'running', done: 'done', skipped: 'skipped', failed: 'failed', stopped: 'stopped',
};

function stepsOf(run: WorkflowRunRecord | undefined, stepRuns: readonly StepRunRecord[]) {
  const steps = (run?.workflowSnapshot?.steps ?? []).map((step) => {
    const rounds = stepRuns.filter((round) => round.stepId === step.id).sort((a, b) => a.round - b.round);
    const first = rounds[0];
    const latest = rounds[rounds.length - 1];
    const summary = latest ? cut((latest.status === 'skipped' ? latest.skippedReason : latest.summary) ?? '', TASK_REPORT_LIMITS.stepSummary) : null;
    return {
      name: step.name,
      state: latest ? STEP_STATE[latest.status] : 'pending' as StepState,
      rounds: rounds.length,
      ...(first ? { startedAt: first.createdAt } : {}),
      ...(latest?.completedAt ? { finishedAt: latest.completedAt } : {}),
      ...(summary?.text ? { summary: summary.text } : {}),
      summaryTruncated: summary?.truncated ?? false,
    };
  });
  return { steps: steps.slice(0, TASK_REPORT_LIMITS.steps), stepsTotal: steps.length, omitted: steps.length > TASK_REPORT_LIMITS.steps };
}

function activityOf(run: WorkflowRunRecord | undefined, phase: TaskPhase) {
  const step = run?.workflowSnapshot?.steps.find((candidate) => candidate.id === run.currentStepId);
  if (phase !== 'in-progress' || !step) return undefined;
  const progress = run?.currentStepProgress;
  return { step: step.name, ...(progress && progress.total > 0 ? { progress: `${progress.done} of ${progress.total} done` } : {}) };
}

function deliveryOf(item: PlanItemRecord, run: WorkflowRunRecord | undefined) {
  const merged = item.autoMerge?.state === 'merged' || Boolean(item.autoMerge?.mergedAt);
  return {
    ...(run?.branch ? { branch: run.branch } : {}),
    ...(run?.prUrl ? { prUrl: run.prUrl, prState: merged ? 'merged' : 'open' } : {}),
    autoMerge: item.autoMerge ? (item.autoMerge.enabled ? 'on' : 'off') : 'none',
  };
}

/** The full picture of one task. */
export function describeTask({ item, runs, stepRuns }: TaskRecords) {
  const run = latestRun(item, runs);
  const phase = phaseOf(item, run);
  const description = cut(item.description, TASK_REPORT_LIMITS.description);
  const outcome = isCompletedTask(item, run) && run?.completionReport ? cut(run.completionReport, TASK_REPORT_LIMITS.outcome) : null;
  const { steps, stepsTotal, omitted } = stepsOf(run, stepRuns);
  const number = boardNumber(item);
  const activity = activityOf(run, phase);
  return {
    id: item.id,
    ...(number ? { number } : {}),
    title: item.title,
    type: item.type ?? 'task',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    description: description.text,
    status: statusOf(item, run),
    phase,
    ...(phase === 'completed' ? { completedAt: completedAtOf(item, run) } : {}),
    ...(activity ? { activity } : {}),
    runs: runs.length,
    steps,
    stepsTotal,
    delivery: deliveryOf(item, run),
    ...(outcome ? { outcome: outcome.text } : {}),
    truncated: description.truncated || omitted || outcome?.truncated === true || steps.some((step) => step.summaryTruncated),
    descriptionTruncated: description.truncated,
    outcomeTruncated: outcome?.truncated ?? false,
  };
}

// ---- Input checks and the completed list ----

/** Exactly one of the task's id and board number, as trimmed text. */
export function parseTaskRef(inputs: Record<string, unknown>): { id: string } | { number: string } {
  const given = (['id', 'number'] as const).filter((name) => inputs[name] !== undefined);
  if (given.length !== 1) throw new CapabilityError(400, 'Give exactly one of "id" and "number"');
  const name = given[0]!;
  const value = String(inputs[name]).trim();
  if (!value) throw new CapabilityError(400, `"${name}" must not be empty`);
  return name === 'id' ? { id: value } : { number: value };
}

export interface CompletedFilter { limit: number; since?: number; search?: string; cursor?: { at: number; id: string } }

interface CursorPayload { at: number; id: string; since: number | null; search: string }

const encodeCursor = (payload: CursorPayload): string => Buffer.from(JSON.stringify(payload)).toString('base64url');

function decodeCursor(raw: string, since: number | undefined, search: string): { at: number; id: string } {
  const bad = new CapabilityError(400, 'cursor is not valid for these filters');
  let payload: Partial<CursorPayload>;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<CursorPayload>;
  } catch {
    throw bad;
  }
  if (typeof payload?.at !== 'number' || typeof payload.id !== 'string' || payload.since !== (since ?? null) || payload.search !== search) throw bad;
  return { at: payload.at, id: payload.id };
}

export function parseCompletedFilter(inputs: Record<string, unknown>): CompletedFilter {
  const limit = typeof inputs.limit === 'number' ? inputs.limit : TASK_REPORT_LIMITS.pageDefault;
  let since: number | undefined;
  if (typeof inputs.since === 'string') {
    const parsed = parseWhen(inputs.since);
    if (parsed === null) throw new CapabilityError(400, 'since must be a date such as 2026-10-12 or 2026-10-12T09:30:00Z');
    since = parsed;
  }
  const search = typeof inputs.search === 'string' ? inputs.search.trim().toLowerCase() : '';
  const cursor = typeof inputs.cursor === 'string' && inputs.cursor ? decodeCursor(inputs.cursor, since, search) : undefined;
  return { limit, since, search: search || undefined, cursor };
}

/** One line, cut short: the start of the completion report. */
const snippetOf = (report: string): string => cut(report.replace(/\s+/g, ' ').trim(), TASK_REPORT_LIMITS.snippet).text;

/** Completed tasks, newest first, ties by id; `total` counts the filters without the page. */
export function listCompleted(items: readonly PlanItemRecord[], runOf: (item: PlanItemRecord) => WorkflowRunRecord | undefined, filter: CompletedFilter) {
  const rows = items.flatMap((item) => {
    const run = runOf(item);
    if (!isCompletedTask(item, run)) return [];
    const at = Date.parse(completedAtOf(item, run));
    if (filter.since !== undefined && at < filter.since) return [];
    if (filter.search && !item.title.toLowerCase().includes(filter.search)) return [];
    return [{ item, run, at: Number.isNaN(at) ? 0 : at }];
  }).sort((a, b) => b.at - a.at || a.item.id.localeCompare(b.item.id));
  const after = filter.cursor;
  const rest = after ? rows.filter((row) => row.at < after.at || (row.at === after.at && row.item.id.localeCompare(after.id) > 0)) : rows;
  const page = rest.slice(0, filter.limit);
  const last = page[page.length - 1];
  return {
    tasks: page.map(({ item, run }) => {
      const number = boardNumber(item);
      const report = run?.completionReport ? snippetOf(run.completionReport) : '';
      return {
        id: item.id, ...(number ? { number } : {}), title: item.title, type: item.type ?? 'task', completedAt: completedAtOf(item, run),
        hasPr: Boolean(run?.prUrl), prMerged: Boolean(run?.prUrl) && (item.autoMerge?.state === 'merged' || Boolean(item.autoMerge?.mergedAt)),
        ...(report ? { outcome: report } : {}),
      };
    }),
    total: rows.length,
    ...(rest.length > page.length && last ? { nextCursor: encodeCursor({ at: last.at, id: last.item.id, since: filter.since ?? null, search: filter.search ?? '' }) } : {}),
  };
}
