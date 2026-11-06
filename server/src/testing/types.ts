/**
 * The Project testing contract, version 1: the framework-neutral model every Testing-tab feature
 * consumes. A Project declares its Test Suites in `<project>/.docs/testing/config.json` (committed
 * project knowledge, read fresh on every request); run history and logs stay in the daemon's
 * central data directory. See docs/architecture.md's "Project testing contract" decision and
 * docs/testing-contract.md for the full schema with examples.
 *
 * Nothing in this contract knows about a specific language or test framework: a suite runs a shell
 * command, and results come back only through the declared Collectors' machine-readable artifacts.
 */

export const TESTING_CONFIG_SCHEMA_VERSION = 1;

/** Where a Project's testing config lives, relative to the Project root. */
export const TESTING_CONFIG_RELATIVE_PATH = '.docs/testing/config.json';

/**
 * The daemon creates one empty artifact directory per Test Run and passes its absolute path to the
 * command through this environment variable. Collector paths are relative to that directory.
 */
export const TEST_ARTIFACTS_DIR_ENV = 'AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR';

/** How long a coding session's testing tool blocks for runs to settle by default (see testing/agentTesting.ts). */
export const DEFAULT_AGENT_TEST_WAIT_SECONDS = 120;
/** Kept under Node fetch's 300s headers timeout, so the MCP relay never gives up before the daemon answers. */
export const MAX_AGENT_TEST_WAIT_SECONDS = 240;

export const TEST_SUITE_KINDS = ['unit', 'integration', 'e2e', 'performance', 'security', 'accessibility', 'contract', 'custom'] as const;
export type TestSuiteKind = (typeof TEST_SUITE_KINDS)[number];

/**
 * `result` actions produce a test outcome that may replace that suite/action's latest result.
 * `utility` actions (e.g. "Update snapshots") keep a log but never change test status.
 */
export const TEST_ACTION_PURPOSES = ['result', 'utility'] as const;
export type TestActionPurpose = (typeof TEST_ACTION_PURPOSES)[number];

/** Machine-readable artifact formats a Collector can parse in v1. */
export const COLLECTOR_FORMATS = ['junit-xml', 'lcov', 'cobertura-xml', 'sarif', 'avos-result'] as const;
export type CollectorFormat = (typeof COLLECTOR_FORMATS)[number];

export const METRIC_DIRECTIONS = ['lower-is-better', 'higher-is-better', 'neutral'] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export interface CollectorConfig {
  id: string;
  format: CollectorFormat;
  /** Relative to the Test Run's artifact directory; never absolute, never escaping it. */
  path: string;
}

export interface TestActionConfig {
  id: string;
  label: string;
  purpose: TestActionPurpose;
  /** Run through the shell, from `workingDirectory`. */
  command: string;
  /** Relative to the Project root, POSIX-separated; `.` when omitted. */
  workingDirectory: string;
  enabled: boolean;
  /** Always empty for a `utility` action. */
  collectors: CollectorConfig[];
}

/** How the UI should label and judge a normalized metric a Collector reports under `key`. */
export interface MetricDisplayConfig {
  key: string;
  label: string;
  unit?: string;
  direction: MetricDirection;
}

export interface TestSuiteConfig {
  id: string;
  label: string;
  kind: TestSuiteKind;
  description?: string;
  enabled: boolean;
  /** The `result` action "Run all" executes for this suite. */
  primaryActionId: string;
  actions: TestActionConfig[];
  metrics: MetricDisplayConfig[];
}

/** A validated config with every default filled in, so consumers never re-apply them. */
export interface TestingConfig {
  schemaVersion: typeof TESTING_CONFIG_SCHEMA_VERSION;
  suites: TestSuiteConfig[];
}

export type ContractIssueCode =
  | 'unreadable'
  | 'malformed-json'
  | 'unsupported-schema-version'
  | 'unsupported-format'
  | 'invalid-value'
  | 'invalid-id'
  | 'duplicate-id'
  | 'unsafe-path'
  | 'missing-primary-action';

/** One problem found in a config or result document; `path` locates it (e.g. `suites[0].actions[1].id`). */
export interface ContractIssue {
  code: ContractIssueCode;
  path: string;
  message: string;
}

/**
 * What GET /api/projects/:id/testing/config returns. Absence is a normal state (the Project just
 * hasn't set up testing yet); `invalid` carries every issue found so a "Repair testing" flow can act.
 */
export type TestingConfigState =
  | { state: 'absent'; path: string }
  | { state: 'valid'; path: string; config: TestingConfig }
  | { state: 'invalid'; path: string; issues: ContractIssue[] };

// ---- Agent Visual OS result JSON, v1 (the `avos-result` Collector format) ----

export const AVOS_RESULT_FORMAT = 'agent-visual-os.test-result';
export const AVOS_RESULT_SCHEMA_VERSION = 1;

export const TEST_OUTCOMES = ['passed', 'failed', 'error', 'skipped'] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

export const THRESHOLD_OPERATORS = ['lt', 'lte', 'gt', 'gte', 'eq'] as const;
export type ThresholdOperator = (typeof THRESHOLD_OPERATORS)[number];

export const THRESHOLD_STATUSES = ['pass', 'warn', 'fail'] as const;
export type ThresholdStatus = (typeof THRESHOLD_STATUSES)[number];

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface ResultCounts {
  total?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  skipped?: number;
}

export interface ResultMetric {
  /** Matches a suite's `metrics[].key` when the suite declares display metadata for it. */
  key: string;
  label?: string;
  value: number;
  unit?: string;
  threshold?: { operator: ThresholdOperator; value: number };
  /** The producer's own verdict against its threshold. */
  status?: ThresholdStatus;
}

export interface ResultFinding {
  id?: string;
  ruleId?: string;
  severity: FindingSeverity;
  title: string;
  description?: string;
  location?: { path?: string; line?: number };
}

export interface ResultCase {
  id?: string;
  name: string;
  group?: string;
  outcome: TestOutcome;
  durationMs?: number;
  message?: string;
}

export interface AvosTestResult {
  format: typeof AVOS_RESULT_FORMAT;
  schemaVersion: typeof AVOS_RESULT_SCHEMA_VERSION;
  outcome: TestOutcome;
  durationMs?: number;
  counts?: ResultCounts;
  metrics: ResultMetric[];
  findings: ResultFinding[];
  cases: ResultCase[];
}

export type AvosResultParse = { ok: true; result: AvosTestResult } | { ok: false; issues: ContractIssue[] };
