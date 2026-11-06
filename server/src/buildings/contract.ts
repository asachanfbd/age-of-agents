/**
 * The contract every Building Type implements. Types are coded, not configured: each one is a TypeScript module that
 * fills in this shape and is registered in `registry.ts`. Only the clearly-bounded choices in `slots` and `agents`
 * can be changed from the Catalog (`slotConfig.ts`). Everything here is plain data so it can cross to the storage
 * worker thread and to the browser.
 */

export type ColumnType = 'integer' | 'real' | 'text';

export interface ColumnSpec {
  name: string;
  type: ColumnType;
}

export interface TableSpec {
  name: string;
  /** Every table gets an implicit `id INTEGER PRIMARY KEY` as its first column; do not list it. */
  columns: ColumnSpec[];
  /** Columns that may be used in `sort`; each gets an index so a sorted page never scans the table. */
  sortable: string[];
  /** Columns that may be used in `filters`. */
  filterable: string[];
  /** Text columns matched (case-insensitively, substring) by the `search` parameter. */
  searchable?: string[];
  /** Extra indexes (column lists) for filters that are not sorts. */
  indexes?: string[][];
  /** Optional unique key; a duplicate row in a batch follows `onConflict`. */
  uniqueKey?: string[];
  onConflict?: 'fail' | 'ignore';
}

/** A maintained roll-up: per-group sums of the source table's numeric columns, updated in the same transaction as the raw rows. */
export interface RollupSpec {
  name: string;
  table: string;
  groupBy: string[];
  measures: string[];
}

export interface RetentionRule {
  table: string;
  /** An ISO date (`YYYY-MM-DD`) or timestamp column; lexicographic order must equal time order. */
  timeColumn: string;
  months: number;
  /** Further tables pruned by the same cutoff; each needs the same `timeColumn`. */
  alsoTables?: string[];
  /** `discard` also removes the discarded rows from the roll-ups; `rollup` keeps the roll-ups, so totals still cover the discarded period. */
  mode: 'discard' | 'rollup';
}

/** Replace the rows of `table` that match every `where` column with `rows` (column order of the table). */
export interface ReplaceStep { table: string; where: Record<string, string | number>; rows: Array<Array<string | number>> }

export interface MigrationStep {
  /** The version this step produces; steps are applied in order from the Building's version to the type's. */
  toVersion: number;
  sql: string[];
}

export interface StorageSpec {
  tables: TableSpec[];
  rollups: RollupSpec[];
  retention?: RetentionRule;
  migrations: MigrationStep[];
}

export interface WorkflowSlot {
  id: string;
  label: string;
  /** Plain-language description of when the type uses this slot. */
  usedWhen: string;
  defaultWorkflowId: string;
}

export interface AgentRole {
  id: string;
  label: string;
  defaultAgentId: string;
}

/**
 * A job every Building of the type starts with (`scheduler/declarations.ts`). It runs one of the type's workflow slots
 * on a cron schedule; a person can edit, switch, delete and restore it per Building.
 */
export interface ScheduledJobDeclaration {
  id: string;
  description: string;
  cron: string;
  /** Shown as the job's name; defaults to `description`. */
  name?: string;
  /** Whether a new Building's copy starts switched on. Defaults to off. */
  enabled?: boolean;
  /** The workflow slot the job runs; defaults to the type's first slot. */
  slotId?: string;
  /** The task description each run works on; defaults to `description`. */
  task?: string;
  overlap?: 'skip' | 'queue' | 'parallel';
  missedPolicy?: 'skip' | 'once';
  maxRunsPerDay?: number;
  needsApproval?: boolean;
  failureThreshold?: number;
}
/** One declared input, output or event-payload field. Text length and array size caps count characters (not bytes) and are enforced by rejecting, never truncating. */
export interface FieldSpec {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'object';
  required?: boolean;
  description?: string;
  /** string: most characters; array: most items. */
  max?: number;
  /** number or integer bounds. */
  minValue?: number;
  maxValue?: number;
  /** enum: the allowed spellings, matched exactly. */
  values?: string[];
  /** array: the item shape. */
  items?: FieldSpec;
  /** object: its fields. */
  fields?: FieldSpec[];
}

/** What a running capability handler is told about the call. */
export interface CapabilityContext {
  /** The Building whose capability runs. */
  buildingId: string;
  callerBuildingId: string;
  /** 1 for a call from a person or job; one more for each call made inside a run a call started. */
  depth: number;
  /** Records a Task or run this call started, so calls made from it carry the chain depth. */
  noteStarted(id: string): Promise<void>;
}

export type CapabilityHandler = (context: CapabilityContext, inputs: Record<string, unknown>) => Promise<{ outputs: Record<string, unknown>; runRef?: string }>;

/**
 * A named operation the type's code exposes to linked Buildings. Reads never need approval; a write needs it unless
 * `requiresApproval` is false. `handle` is code and is never sent to the browser.
 */
export interface CapabilityDeclaration {
  id: string;
  description: string;
  mode: 'read' | 'write';
  requiresApproval?: boolean;
  /** The call starts a run or session and answers at once with a reference to it. */
  startsRun?: boolean;
  inputs: FieldSpec[];
  outputs: FieldSpec[];
  handle?: CapabilityHandler;
}

/** A named fact a Building publishes; subscribers in linked Buildings start a job when it happens. */
export interface EventDeclaration { id: string; description: string; payload?: FieldSpec[] }

/** Whether the type lets the platform discard data now, and the window it should use for this Building (default: the rule's own). */
export interface RetentionPlan { allowed: boolean; months?: number }

export interface CreateInput { name: string; [field: string]: unknown }

export type ValidationResult = { ok: true; value: CreateInput } | { ok: false; field: string; error: string };

export interface BuildingTypeDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  version: number;
  /** The 3D scene's look: a model id plus a tint. Software keeps the original building. */
  look: { model: 'software' | 'generic'; color: string };
  /** The id of the workspace the web opens for this type (`web/src/lib/buildingWorkspace.ts`). */
  workspace: string;
  /** Types that declare a repository get a clone/worktree/branch per run; the others run in the Building's own folder. */
  repository: boolean;
  /** Hidden from the create flow unless `AGENT_VISUAL_OS_DEV_TYPES=1`. */
  devOnly?: boolean;
  validateCreate(input: unknown): ValidationResult;
  /** Runs once after the Building is created, with the validated create input (e.g. to save type-specific settings). */
  onCreated?(buildingId: string, input: CreateInput): Promise<void>;
  /** Runs when the Building is about to be deleted, before its folder is removed (e.g. to stop background work). */
  onDeleting?(buildingId: string): Promise<void>;
  /** Gate and per-Building window for retention; absent means retention always runs with the rule's own months. */
  retentionPlan?(buildingId: string): Promise<RetentionPlan>;
  /** Absent for a type that keeps using the central store (Software). */
  storage?: StorageSpec;
  slots: WorkflowSlot[];
  agents: AgentRole[];
  scheduledJobs: ScheduledJobDeclaration[];
  /** In-process actions a person can schedule (`{ kind: 'action' }` job targets); the type's runtime implements them. */
  scheduledActions?: Array<{ id: string; label: string }>;
  capabilities: CapabilityDeclaration[];
  events: EventDeclaration[];
}
