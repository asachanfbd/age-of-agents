import type { ExecutorProfile, StepRunStatus } from '../domain/types.ts';
import type { UsageFailureReason } from '../executors/usagePoller.ts';

/** Readings, activity and profile links are kept this long, then pruned. */
export const RETENTION_MS = 90 * 24 * 60 * 60_000;

export type QuotaWindowKey = 'fiveHour' | 'sevenDay';
export const QUOTA_WINDOWS: readonly QuotaWindowKey[] = ['fiveHour', 'sevenDay'];

/** One quota window as the provider reported it. All analytics times are epoch milliseconds. */
export interface StoredWindow {
  usedPercentage: number;
  resetsAt: number | null;
}

/** One provider observation of an account. A window the provider did not report is null, never 0. */
export interface QuotaReading {
  /** When the provider observed the quota, not when it was fetched or saved. */
  at: number;
  fiveHour: StoredWindow | null;
  sevenDay: StoredWindow | null;
}

/** A check that produced no reading. It breaks the line between the readings around it. */
export interface QuotaFailure {
  at: number;
  reason: UsageFailureReason;
}

/**
 * A configured coding agent profile tied to the provider account it used. A profile that is removed,
 * or re-pointed at another account, is retired; a later profile never takes over a retired link, even
 * with the same id, so it cannot inherit another account's history.
 */
export interface AgentLink {
  id: string;
  executorId: string;
  label: string;
  kind: ExecutorProfile['kind'];
  /** A hash identifying the provider account. Never a credential, path or environment value. */
  account: string;
  firstSeenAt: number;
  retiredAt: number | null;
}

export type ActivityKind = 'planning' | 'coding' | 'background';

/** A stretch of one session: `active` while the agent works, `waiting` while it waits for a person. */
export interface ActivitySegment {
  state: 'active' | 'waiting';
  start: number;
  /** Null while the segment is still running. */
  end: number | null;
}

/** Token counts exactly as a CLI reported them. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** The WorkflowRun step round a coding session ran, with its names as they were at the time. */
export interface ActivityWorkflow {
  id: string;
  name: string;
  runId: string;
  stepId: string;
  stepName: string;
  /** Null until the round's own record is seen. */
  round: number | null;
  status: StepRunStatus | null;
}

/**
 * One app-tracked session on a provider account: a planning session, a coding Task (a step round when
 * `workflow` is set), or a background turn such as naming or summarizing. Names are snapshots, so a
 * later rename or deletion never rewrites history. Holds metadata only: no prompt or transcript text.
 */
export interface ActivityRecord {
  /** The Task id, or a generated id for a background turn. */
  id: string;
  account: string;
  executorId: string;
  agentLabel: string;
  kind: ActivityKind;
  projectId: string | null;
  projectName: string | null;
  /** The Task whose session this is; null for a background turn. */
  taskId: string | null;
  planItemId: string | null;
  label: string;
  workflow: ActivityWorkflow | null;
  segments: ActivitySegment[];
  startedAt: number;
  /** Null while the session is live. */
  endedAt: number | null;
  /** The last moment the daemon knew this session's state. A restart closes an open session here. */
  lastSeenAt: number;
  /** True when a boundary was not observed: the session was already running when first seen, or the daemon stopped while it ran. */
  approximate: boolean;
  /** Null until the CLI reports usage for this session. */
  tokens: TokenCounts | null;
}
