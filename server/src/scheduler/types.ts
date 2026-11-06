/** The stored shapes of the Building scheduler: a job, its history, and what a poll trigger last saw. */

export type OverlapRule = 'skip' | 'queue' | 'parallel';
export type MissedPolicy = 'skip' | 'once';
export type DetectMode = 'mtime' | 'hash';

export type JobTrigger =
  | { kind: 'cron'; cron: string }
  | { kind: 'file'; path: string; detect: DetectMode; intervalSeconds: number }
  | { kind: 'api'; url: string; jsonField: string | null; intervalSeconds: number };

export type JobTarget =
  /** A normal run of one of the Building type's workflow slots; `description` is the task the run works on. */
  | { kind: 'slot'; slotId: string; description: string }
  /** A single agent prompt; a null agent means the Catalog's default agent. */
  | { kind: 'prompt'; agentId: string | null; prompt: string }
  /** A call to a capability of a linked Building (`connections/service.ts`); the call is audited like any other. */
  | { kind: 'capability'; targetBuildingId: string; capabilityId: string; inputs: Record<string, unknown> }
  /** An in-process action the Building's type offers (`BuildingTypeDefinition.scheduledActions`), such as an SEO data fetch. */
  | { kind: 'action'; actionId: string }
  /** A saved command of the same Building (`commands/commandRunner.ts`); it runs as a command run, with no agent, PlanItem or worker slot. */
  | { kind: 'command'; commandId: string };

/** What a person (or a type declaration) can set on a job. */
export interface JobSettings {
  name: string;
  enabled: boolean;
  trigger: JobTrigger;
  target: JobTarget;
  overlap: OverlapRule;
  /** Cron jobs only: what to do about slots missed while the daemon was off. Null on a poll job. */
  missedPolicy: MissedPolicy | null;
  maxRunsPerDay: number | null;
  /** Do not start while the agent's 5-hour / weekly usage is above this percentage. */
  maxFiveHourPercent: number | null;
  maxWeeklyPercent: number | null;
  needsApproval: boolean;
  /** Consecutive failed runs after which the job turns itself off. */
  failureThreshold: number;
}

export interface ScheduledJobRecord extends JobSettings {
  id: string;
  projectId: string;
  /** The id of the type declaration this job was created from; null for a person's own job. */
  declaredJobId: string | null;
  consecutiveFailures: number;
  /** Set when the failure threshold turned the job off; cleared when a person turns it back on. */
  autoDisabled: boolean;
  /** The next cron slot or poll check; null while the job is off or its expression never matches. */
  nextRunAt: string | null;
  /** The latest poll check's error, shown on the job until a check succeeds. */
  pollError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StartedBy = 'schedule' | 'poll' | 'run-now' | 'catch-up' | 'event';

export type EntryOutcome =
  | 'queued' | 'deferred' | 'running' | 'awaiting-approval'
  | 'succeeded' | 'failed' | 'stopped' | 'skipped' | 'check-failed';

/** Outcomes of a start that has not finished: never pruned, and a queued or deferred one still has to start. */
export const PENDING_OUTCOMES: readonly EntryOutcome[] = ['queued', 'deferred'];
export const GOING_OUTCOMES: readonly EntryOutcome[] = ['running', 'awaiting-approval'];

export interface JobHistoryEntry {
  id: string;
  jobId: string;
  projectId: string;
  /** Increases with every entry of a job; orders the history and is its paging cursor. */
  seq: number;
  startedBy: StartedBy;
  outcome: EntryOutcome;
  /** The slot or check this entry answers, which orders queued starts. */
  dueAt: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Why it was skipped, deferred, queued or failed. */
  note: string | null;
  /** What a poll trigger saw change. */
  change: string | null;
  runId: string | null;
  /** When the run itself started; null for an entry that never started one. Counts toward the daily limit. */
  runStartedAt: string | null;
  /** A deferred start waits until this instant. */
  deferredUntil: string | null;
}

/** What a poll trigger compares its next reading against. A whole API response is kept only as a hash. */
export type PollBaseline =
  | { kind: 'files'; files: Record<string, string> }
  | { kind: 'value'; hash: string; display: string | null };

export interface PollBaselineRecord {
  /** The job's id. */
  id: string;
  /** The trigger the baseline was read for; a different trigger starts from a fresh baseline. */
  triggerKey: string;
  baseline: PollBaseline;
}
