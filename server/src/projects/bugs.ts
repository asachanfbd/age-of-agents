import type {
  BugAttributes, BugInfoStatus, BugIntroducedBy, BugRegression, BugRegressionReporter, BugSeverity, BugTaskRef, BugTestRef, PlanItemRecord, PlanItemType,
  StepRunRecord, WorkflowRunRecord,
} from '../domain/types.ts';

/**
 * The bug tracker's pure rules: reading a stored bug, validating what a report session or a coding
 * agent sends, numbering, the structured description and the test-case dedupe key. A bug is a
 * PlanItem of type 'bug' — everything that needs the database or live sessions is in
 * worker/bugTracker.ts.
 */

export const BUG_SEVERITIES: BugSeverity[] = ['critical', 'high', 'medium', 'low'];
export const BUG_INFO_STATUSES: BugInfoStatus[] = ['enough', 'needs-more-info'];

/**
 * Lengths in characters after trimming. A value one over is refused, never truncated. `description`
 * is the composed five-section text. `agentDescription` is what a coding agent may send: smaller, so
 * that with the headings and the longest allowed test ids added it always fits `description`.
 */
export const BUG_LIMITS = { title: 200, description: 20_000, agentDescription: 18_000, suspectedLocation: 500, commit: 64, caseId: 500, testId: 200, regressionReason: 20_000 } as const;

/** A report or bug-filing call the caller got wrong: always a 400. */
export class BugValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BugValidationError';
  }
}

/** The named introducing task has never started, so it cannot have introduced anything. */
export class BugIntroducerNotStartedError extends Error {
  constructor(item: Pick<PlanItemRecord, 'title'>) {
    super(`"${item.title}" has not started yet, so it cannot have introduced a bug — name a task that is running or completed, or leave the introducing task out`);
    this.name = 'BugIntroducerNotStartedError';
  }
}

/** A bug's report can only change while it waits in Planning. */
export class BugStartedError extends Error {
  constructor(item: Pick<PlanItemRecord, 'title'>) {
    super(`"${item.title}" has already started, so its report can no longer be changed`);
    this.name = 'BugStartedError';
  }
}

/** A task a report session filed can only change while it waits in Planning. */
export class ReportedTaskStartedError extends Error {
  constructor(item: Pick<PlanItemRecord, 'title'>) {
    super(`"${item.title}" has already started, so it can no longer be changed or deleted`);
    this.name = 'ReportedTaskStartedError';
  }
}

/** A task tool was pointed at a bug, or a bug tool at a task. */
export class ReportedItemKindError extends Error {
  constructor(item: Pick<PlanItemRecord, 'title'>, expected: 'bug' | 'task') {
    super(`"${item.title}" is not a ${expected}, so this tool cannot change or delete it`);
    this.name = 'ReportedItemKindError';
  }
}

/** A planning session's task tools were pointed at a bug, which only its report session or the person may change. */
export class BugNotPlanningTaskError extends Error {
  constructor(item: Pick<PlanItemRecord, 'title'>) {
    super(`"${item.title}" is a bug, not a planning task — a planning session cannot change or delete it`);
    this.name = 'BugNotPlanningTaskError';
  }
}

/** Only a completed bug can be reported as a regression. */
export class BugNotCompletedError extends Error {
  constructor(item: Pick<PlanItemRecord, 'title'>) {
    super(`"${item.title}" is not completed, so a regression cannot be reported on it`);
    this.name = 'BugNotCompletedError';
  }
}

/** A regression was reported on a task; only a bug can regress. */
export class RegressionNotBugError extends Error {
  constructor(item: Pick<PlanItemRecord, 'title'>) {
    super(`"${item.title}" is a task, not a bug, so a regression cannot be reported on it`);
    this.name = 'RegressionNotBugError';
  }
}

const UNKNOWN = 'Unknown';

export function planItemType(item: Pick<PlanItemRecord, 'type'>): PlanItemType {
  return item.type === 'bug' ? 'bug' : 'task';
}

export const isBug = (item: Pick<PlanItemRecord, 'type'>): boolean => planItemType(item) === 'bug';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

function readTaskRef(value: unknown): BugTaskRef | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.planItemId !== 'string' || !raw.planItemId) return null;
  return { planItemId: raw.planItemId, number: textOrNull(raw.number), title: typeof raw.title === 'string' ? raw.title : '' };
}

function readIntroducedBy(value: unknown): BugIntroducedBy | null {
  const ref = readTaskRef(value);
  return ref ? { ...ref, commit: textOrNull(asRecord(value)!.commit) } : null;
}

function readTestRef(value: unknown): BugTestRef | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.suiteId !== 'string' || typeof raw.actionId !== 'string' || typeof raw.caseId !== 'string') return null;
  return { suiteId: raw.suiteId, actionId: raw.actionId, caseId: raw.caseId };
}

function readRegressionReporter(value: unknown): BugRegressionReporter | null {
  const raw = asRecord(value);
  if (raw?.kind === 'person') return { kind: 'person' };
  if (raw?.kind === 'report-session' && typeof raw.sessionNumber === 'number' && Number.isInteger(raw.sessionNumber)) {
    return { kind: 'report-session', sessionNumber: raw.sessionNumber };
  }
  return null;
}

/** A stored regressions list; a missing or mistyped value reads as empty and an unreadable entry is dropped. */
export function readRegressions(value: unknown): BugRegression[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): BugRegression[] => {
    const raw = asRecord(entry);
    const reporter = readRegressionReporter(raw?.reporter);
    if (!raw || typeof raw.reason !== 'string' || typeof raw.reportedAt !== 'string' || !reporter) return [];
    return [{ reason: raw.reason, reportedAt: raw.reportedAt, reporter }];
  });
}

/** A stored bug's attributes; anything missing, mistyped or unknown reads as null and never throws. */
export function readBugAttributes(value: unknown): BugAttributes {
  const raw = asRecord(value) ?? {};
  return {
    severity: BUG_SEVERITIES.includes(raw.severity as BugSeverity) ? raw.severity as BugSeverity : null,
    infoStatus: BUG_INFO_STATUSES.includes(raw.infoStatus as BugInfoStatus) ? raw.infoStatus as BugInfoStatus : null,
    introducedBy: readIntroducedBy(raw.introducedBy),
    suspectedLocation: textOrNull(raw.suspectedLocation),
    foundWhileWorkingOn: readTaskRef(raw.foundWhileWorkingOn),
    reportSessionNumber: typeof raw.reportSessionNumber === 'number' && Number.isInteger(raw.reportSessionNumber) ? raw.reportSessionNumber : null,
    testRef: readTestRef(raw.testRef),
    groupOrder: typeof raw.groupOrder === 'number' && Number.isFinite(raw.groupOrder) ? raw.groupOrder : null,
    summary: textOrNull(raw.summary),
    expectedVsActual: textOrNull(raw.expectedVsActual),
    stepsToReproduce: textOrNull(raw.stepsToReproduce),
    regressions: readRegressions(raw.regressions),
  };
}

/** A stored task's link to the bug it was filed with; anything missing or mistyped reads as null and never throws. */
export const readRelatedBug = readTaskRef;

/** The item as every caller sees it: a known `type`, `bug` attributes on a bug only, and a readable `relatedBug` on a task. */
export function withPlanItemType<T extends PlanItemRecord>(item: T): T {
  const { bug: storedBug, relatedBug: storedRelated, ...rest } = item;
  const type = planItemType(item);
  if (type === 'bug') return { ...rest, type, bug: readBugAttributes(storedBug) } as T;
  const relatedBug = readRelatedBug(storedRelated);
  return { ...rest, type, ...(relatedBug ? { relatedBug } : {}) } as T;
}

/** The planning session a task belongs to, or the report session that filed a bug or task: all draw on one number sequence per Project. */
export function linkedSessionNumber(item: Pick<PlanItemRecord, 'planningRef' | 'type' | 'bug' | 'reportSessionNumber'>): number | undefined {
  return item.planningRef?.session ?? (isBug(item) ? readBugAttributes(item.bug).reportSessionNumber ?? undefined : item.reportSessionNumber);
}

/** A ready bug waits in Planning: not started, not archived. */
export const isReadyBug = (item: PlanItemRecord): boolean => isBug(item) && item.status === 'pending' && !item.archived;

/** The id of the task a ready bug is grouped under, or null for a standalone bug. */
export function bugGroupId(item: PlanItemRecord): string | null {
  return isBug(item) ? readBugAttributes(item.bug).introducedBy?.planItemId ?? null : null;
}

/** A group's order: saved positions first, then unpositioned bugs in creation order, ties by id. */
export function compareBugGroupOrder(a: PlanItemRecord, b: PlanItemRecord): number {
  const rank = (item: PlanItemRecord) => readBugAttributes(item.bug).groupOrder ?? Number.POSITIVE_INFINITY;
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** A task that has never started cannot have introduced a bug. */
export const hasStarted = (item: Pick<PlanItemRecord, 'status' | 'taskIds' | 'workflowRunId'>): boolean =>
  item.status !== 'pending' || item.taskIds.length > 0 || !!item.workflowRunId;

const TASK_NUMBER = /^\s*(\d+(?:\.\d+)+|B\.\d+):\s*/;

/** "4.002: Add login" → number "4.002" and title "Add login"; a title with no number keeps it whole. */
export function splitNumberedTitle(title: string): { number: string | null; title: string } {
  const match = TASK_NUMBER.exec(title);
  return match ? { number: match[1]!, title: title.slice(match[0].length) } : { number: null, title };
}

export function taskRefOf(item: Pick<PlanItemRecord, 'id' | 'title'>): BugTaskRef {
  return { planItemId: item.id, ...splitNumberedTitle(item.title) };
}

/** `<introducing task number>.<NNN>`, or `B.<NNN>` when there is no numbered introducing task. At least three digits, never wrapped. */
export function bugNumber(introducerNumber: string | null, sequence: number): string {
  return `${introducerNumber ?? 'B'}.${String(sequence).padStart(3, '0')}`;
}

/** "4.002.001: Title" — replaces any number the title already carries. */
export function bugTitle(number: string, title: string): string {
  return `${number}: ${splitNumberedTitle(title).title}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new BugValidationError(`${field} must be text`);
  return value.trim();
}

function withinLimit(value: string, field: string, limit: number): string {
  if (value.length > limit) throw new BugValidationError(`${field} must be at most ${limit.toLocaleString('en-US')} characters (got ${value.length.toLocaleString('en-US')})`);
  return value;
}

/** A required one-line field: text, non-blank after trimming, within its limit. */
function requiredText(value: unknown, field: string, limit: number): string {
  if (value === undefined || value === null) throw new BugValidationError(`${field} is required`);
  const text = requireString(value, field);
  if (!text) throw new BugValidationError(`${field} is required`);
  return withinLimit(text, field, limit);
}

/** An optional field: absent, null or blank is null. */
function optionalText(value: unknown, field: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  return text ? withinLimit(text, field, limit) : null;
}

export const parseBugTitle = (value: unknown): string => requiredText(value, 'title', BUG_LIMITS.title);
export const parseSuspectedLocation = (value: unknown): string | null => optionalText(value, 'suspectedLocation', BUG_LIMITS.suspectedLocation);
export const parseCommit = (value: unknown): string | null => optionalText(value, 'commit', BUG_LIMITS.commit);
/** A description section. Only the composed description has a limit, so a section is checked for type alone. */
export const parseSection = (value: unknown, field: string): string | null => optionalText(value, field, Number.POSITIVE_INFINITY);

export function parseSeverity(value: unknown): BugSeverity | null {
  if (value === undefined || value === null) return null;
  if (!BUG_SEVERITIES.includes(value as BugSeverity)) throw new BugValidationError(`severity must be one of: ${BUG_SEVERITIES.join(', ')}`);
  return value as BugSeverity;
}

export function parseInfoStatus(value: unknown): BugInfoStatus {
  if (!BUG_INFO_STATUSES.includes(value as BugInfoStatus)) throw new BugValidationError(`infoStatus must be one of: ${BUG_INFO_STATUSES.join(', ')}`);
  return value as BugInfoStatus;
}

/** `undefined` leaves the introducing task alone, `null` clears it, a string names it. */
function parseIntroducerId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim()) throw new BugValidationError('introducedByTaskId must be a task id, or null for unknown');
  return value.trim();
}

/** What a report session sends to file a bug, validated. */
export interface BugReportDraft {
  title: string;
  severity: BugSeverity | null;
  infoStatus: BugInfoStatus;
  suspectedLocation: string | null;
  introducedByTaskId: string | null;
  commit: string | null;
  summary: string | null;
  expectedVsActual: string | null;
  stepsToReproduce: string | null;
}

export function parseBugReport(body: unknown): BugReportDraft {
  const raw = asRecord(body) ?? {};
  return {
    title: parseBugTitle(raw.title),
    severity: parseSeverity(raw.severity),
    infoStatus: parseInfoStatus(raw.infoStatus),
    suspectedLocation: parseSuspectedLocation(raw.suspectedLocation),
    introducedByTaskId: parseIntroducerId(raw.introducedByTaskId) ?? null,
    commit: parseCommit(raw.commit),
    summary: parseSection(raw.summary, 'summary'),
    expectedVsActual: parseSection(raw.expectedVsActual, 'expectedVsActual'),
    stepsToReproduce: parseSection(raw.stepsToReproduce, 'stepsToReproduce'),
  };
}

/** A report session's change to a bug it filed: only the fields it sent. `introducedByTaskId: null` makes the bug standalone. */
export type BugReportPatch = Partial<BugReportDraft>;

const PATCH_PARSERS: { [K in keyof BugReportDraft]: (value: unknown) => BugReportDraft[K] | undefined } = {
  title: parseBugTitle,
  severity: parseSeverity,
  infoStatus: parseInfoStatus,
  suspectedLocation: parseSuspectedLocation,
  introducedByTaskId: (value) => parseIntroducerId(value),
  commit: parseCommit,
  summary: (value) => parseSection(value, 'summary'),
  expectedVsActual: (value) => parseSection(value, 'expectedVsActual'),
  stepsToReproduce: (value) => parseSection(value, 'stepsToReproduce'),
};

export function parseBugReportPatch(body: unknown): BugReportPatch {
  const raw = asRecord(body) ?? {};
  const patch: Record<string, unknown> = {};
  for (const field of Object.keys(PATCH_PARSERS) as (keyof BugReportDraft)[]) {
    if (raw[field] !== undefined) patch[field] = PATCH_PARSERS[field](raw[field]);
  }
  if (Object.keys(patch).length === 0) throw new BugValidationError('give at least one field to change');
  return patch as BugReportPatch;
}

/** What a report session sends to file a task: the full brief, and optionally the bug it was filed with. */
export interface ReportedTaskDraft {
  title: string;
  description: string;
  relatedBugId: string | null;
}

/** A report session's change to a task it filed. `relatedBugId: null` clears the link; absent leaves it. */
export type ReportedTaskPatch = Partial<ReportedTaskDraft>;

/** `undefined` leaves the related bug alone, `null` clears it, a string names it. */
function parseRelatedBugId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim()) throw new BugValidationError('relatedBugId must be the id of a bug filed in this session, or null for none');
  return value.trim();
}

/** The task's title: blank is allowed only when a description can stand in (the caller then asks for a generated title). */
function parseTaskTitle(value: unknown): string {
  if (value === undefined || value === null) return '';
  return withinLimit(requireString(value, 'title'), 'title', BUG_LIMITS.title);
}

const parseTaskDescription = (value: unknown): string => requiredText(value, 'description', BUG_LIMITS.description);

export function parseReportedTask(body: unknown): ReportedTaskDraft {
  const raw = asRecord(body) ?? {};
  return {
    title: parseTaskTitle(raw.title),
    description: parseTaskDescription(raw.description),
    relatedBugId: parseRelatedBugId(raw.relatedBugId) ?? null,
  };
}

export function parseReportedTaskPatch(body: unknown): ReportedTaskPatch {
  const raw = asRecord(body) ?? {};
  const patch: ReportedTaskPatch = {};
  if (raw.title !== undefined) patch.title = parseBugTitle(raw.title);
  if (raw.description !== undefined) patch.description = parseTaskDescription(raw.description);
  if (raw.relatedBugId !== undefined) patch.relatedBugId = parseRelatedBugId(raw.relatedBugId);
  if (Object.keys(patch).length === 0) throw new BugValidationError('give at least one field to change');
  return patch;
}

/** What a coding agent sends for a failing test it judges unrelated to its task, validated. Anything else it sends is ignored. */
export interface AgentBugDraft {
  title: string;
  description: string;
  testRef: BugTestRef;
}

export function parseAgentBug(body: unknown): AgentBugDraft {
  const raw = asRecord(body) ?? {};
  return {
    title: parseBugTitle(raw.title),
    testRef: {
      suiteId: requiredText(raw.suiteId, 'suiteId', BUG_LIMITS.testId),
      actionId: requiredText(raw.actionId, 'actionId', BUG_LIMITS.testId),
      caseId: requiredText(raw.caseId, 'caseId', BUG_LIMITS.caseId),
    },
    description: requiredText(raw.description, 'description', BUG_LIMITS.agentDescription),
  };
}

export interface BugDescriptionSections {
  summary: string | null;
  expectedVsActual: string | null;
  stepsToReproduce: string | null;
  suspectedLocation: string | null;
  introducedBy: BugIntroducedBy | null;
}

function introducedByText(ref: BugIntroducedBy | null): string | null {
  if (!ref) return null;
  const task = [ref.number, ref.title].filter(Boolean).join(': ');
  return ref.commit ? `${task} (commit ${ref.commit})` : task;
}

/**
 * The bug's description, always in the same five sections so a coding agent finds each in the same
 * place. A section nobody filled in reads "Unknown". Refused (never cut) when it is over the limit.
 */
export function buildBugDescription(sections: BugDescriptionSections): string {
  const parts: [string, string | null][] = [
    ['Summary', sections.summary],
    ['Expected vs actual', sections.expectedVsActual],
    ['Steps to reproduce', sections.stepsToReproduce],
    ['Suspected location', sections.suspectedLocation],
    ['Introduced by', introducedByText(sections.introducedBy)],
  ];
  const description = parts.map(([heading, text]) => `## ${heading}\n\n${text?.trim() || UNKNOWN}`).join('\n\n');
  return withinLimit(description, 'description', BUG_LIMITS.description);
}

/** An agent-found bug's sections: the failure as the summary, and the failing test as the way to reproduce it. */
export function agentBugSections(draft: AgentBugDraft): Pick<BugAttributes, 'summary' | 'expectedVsActual' | 'stepsToReproduce'> {
  const { suiteId, actionId, caseId } = draft.testRef;
  return {
    summary: draft.description,
    expectedVsActual: null,
    stepsToReproduce: `Run the "${actionId}" action of the "${suiteId}" test suite. Failing case: ${caseId}`,
  };
}

/** Exact and case-sensitive on all three ids; the case id is compared after trimming. */
export function sameTestRef(a: BugTestRef | null, b: BugTestRef): boolean {
  return !!a && a.suiteId === b.suiteId && a.actionId === b.actionId && a.caseId.trim() === b.caseId.trim();
}

/** An open bug still stands for its failing test: anything not completed and not archived. */
export const isOpenBug = (item: PlanItemRecord): boolean => isBug(item) && item.status !== 'done' && !item.archived;

/** A regression reason: text, non-blank after trimming, at most 20,000 characters (refused, never cut). */
export const parseRegressionReason = (value: unknown): string => requiredText(value, 'reason', BUG_LIMITS.regressionReason);

/** A regression request's body, `{ reason }`: anything else sent with it is ignored. */
export function parseRegressionBody(body: unknown): string {
  const raw = asRecord(body);
  if (!raw) throw new BugValidationError('the body must be { "reason": text }');
  return parseRegressionReason(raw.reason);
}

/** A bug can be reported as a regression only once completed, whether or not it is archived. A task never can. */
export const canReportRegression = (item: Pick<PlanItemRecord, 'type' | 'status'>): boolean => isBug(item) && item.status === 'done';

/** Throws the error naming why `item` cannot be reported as a regression; returns when it can. */
export function assertRegressionReportable(item: PlanItemRecord): void {
  if (!isBug(item)) throw new RegressionNotBugError(item);
  if (item.status !== 'done') throw new BugNotCompletedError(item);
}

/** The bug's attributes with one more regression at the end of the list; earlier entries are untouched. */
export function appendRegression(bug: BugAttributes | undefined, entry: BugRegression): BugAttributes {
  const current = readBugAttributes(bug);
  return { ...current, regressions: [...current.regressions, entry] };
}

/** How a regression's reporter reads in an agent's prompt: "The person", else "Bug report session N". */
export function regressionReporterLabel(reporter: BugRegressionReporter): string {
  return reporter.kind === 'person' ? 'The person' : `Bug report session ${reporter.sessionNumber}`;
}

/**
 * Per step, the highest round it reached in the bug's earlier runs (counting the rounds those runs
 * themselves continued from), so a regression run shows its first round of that step as the next one.
 * A step left out at start never ran and does not count.
 */
export function regressionRoundOffsets(earlier: { run: Pick<WorkflowRunRecord, 'regression'>; stepRuns: Pick<StepRunRecord, 'stepId' | 'round' | 'status'>[] }[]): Record<string, number> {
  const offsets: Record<string, number> = {};
  for (const { run, stepRuns } of earlier) {
    for (const { stepId, round, status } of stepRuns) {
      if (status === 'skipped') continue;
      offsets[stepId] = Math.max(offsets[stepId] ?? 0, (run.regression?.roundOffsets[stepId] ?? 0) + round);
    }
  }
  return offsets;
}
