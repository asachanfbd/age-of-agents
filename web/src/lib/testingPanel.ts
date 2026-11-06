import { startupView } from './runStartup';
import { formatRelativeTime } from './sessionTiming';
import type {
  FindingSeverity, MetricDisplayConfig, NormalizedTestResult, TestingConfigState, TestingSetupEvidence, TestingSetupMode,
  TestingSetupState, TestResultSummary, TestRun, TestRunStatus, TestSuiteOverview, WorkflowRunRecord, WorkflowStep,
} from './serverApi';

/**
 * Pure view-model helpers for the Testing tab (TestingPanel.tsx) and the testing-setup additions to
 * the run detail view — kept apart from the components so every state they render is unit-testable
 * without a DOM. The server is the source of truth for all of it: this only decides wording and
 * which controls apply.
 */

type BadgeVariant = 'secondary' | 'success' | 'warning' | 'soft-destructive';

/** The proposal step's id in the built-in testing-setup workflow — see server/src/testing/setup.ts. */
export const SETUP_PROPOSAL_STEP_ID = 'proposal';

export const SETUP_CTA_LABELS: Record<TestingSetupMode, string> = {
  setup: 'Set up testing',
  reconfigure: 'Reconfigure testing',
  repair: 'Repair testing',
};

/** "<step> failed: <reason>" for a setup run whose start-up failed, else null. */
function startupFailureText(run: TestingSetupState['run']): string | null {
  const failure = run ? startupView(run)?.failure : null;
  return failure ? `${failure.name} failed: ${failure.reason}` : null;
}

/** Where a testing setup is, from its PlanItem, run and queue entry. */
export type SetupStage =
  | 'queued' | 'starting' | 'discovery' | 'awaiting-approval' | 'implementing' | 'needs-attention' | 'completing' | 'completed' | 'failed' | 'stopped';

export function setupStage(setup: Pick<TestingSetupState, 'run'>): SetupStage {
  const { run } = setup;
  if (!run) return 'queued';
  if (run.status === 'running') return run.currentStepId === SETUP_PROPOSAL_STEP_ID ? 'discovery' : 'implementing';
  return run.status;
}

/** Which entry point the config's state offers: absent → set up, valid → reconfigure, invalid → repair. */
export function setupModeFor(config: TestingConfigState): TestingSetupMode {
  if (config.state === 'valid') return 'reconfigure';
  if (config.state === 'invalid') return 'repair';
  return 'setup';
}

export interface SetupStatusLine {
  tone: 'info' | 'warning' | 'danger' | 'success';
  badge: string;
  text: string;
  linkLabel: string;
  /** The run to open from the link — null while the setup is still queued (the link opens the Tasks tab). */
  runId: string | null;
  /** Set once a completed setup raised a PR. */
  prUrl: string | null;
  /** Only a completed setup's line can be dismissed. */
  dismissible: boolean;
}

export interface SetupHeaderModel {
  /** The start/reconfigure/repair button, hidden while a setup line shows so a click can't race the existing one. */
  cta: { label: string; mode: TestingSetupMode } | null;
  status: SetupStatusLine | null;
}

function statusLine(setup: TestingSetupState): SetupStatusLine | null {
  const { run } = setup;
  const runId = run?.id ?? null;
  const base = { runId, prUrl: null, dismissible: false };
  switch (setupStage(setup)) {
    case 'queued':
      return { ...base, tone: 'info', badge: 'Queued', text: `${setup.planItem.title} is waiting for its turn in this project's task queue.`, linkLabel: 'Open task' };
    case 'starting':
      return { ...base, tone: 'info', badge: 'Starting', text: 'Setting up the working copy for the setup task.', linkLabel: 'Open task' };
    case 'discovery':
      return { ...base, tone: 'info', badge: 'Read-only discovery', text: 'Inspecting the repository and writing a setup proposal. Nothing can be changed yet.', linkLabel: 'Open task' };
    case 'awaiting-approval':
      return { ...base, tone: 'warning', badge: 'Needs your approval', text: 'The setup proposal is ready. Nothing has been changed yet.', linkLabel: 'Review proposal' };
    case 'implementing':
    case 'completing':
      return { ...base, tone: 'info', badge: 'In progress', text: 'Carrying out the approved setup and validating every suite with the test tools.', linkLabel: 'Open task' };
    case 'needs-attention':
    case 'failed':
      return { ...base, tone: 'danger', badge: 'Needs attention', text: run?.attentionReason ?? startupFailureText(run) ?? 'The setup stopped before it finished.', linkLabel: 'Open task' };
    case 'completed':
      return {
        ...base,
        tone: 'success',
        badge: 'Done',
        text: run?.branch
          ? `Testing setup pushed to ${run.branch}. It shows here once that branch is merged or checked out.`
          : 'Testing setup finished.',
        linkLabel: 'Open task',
        prUrl: run?.prUrl ?? null,
        dismissible: true,
      };
    case 'stopped':
      return null;
  }
}

/**
 * The Testing tab header's setup controls: the entry-point button for the config's state, or — while
 * a setup is active, or completed and not yet dismissed — a status line linking to its task instead.
 */
export function setupHeader(config: TestingConfigState | null, setup: TestingSetupState | null, dismissedRunId: string | null = null): SetupHeaderModel {
  const dismissed = setup && !setup.active && setup.run?.id === dismissedRunId;
  const status = setup && !dismissed ? statusLine(setup) : null;
  if (status) return { cta: null, status };
  if (!config) return { cta: null, status: null };
  const mode = setupModeFor(config);
  return { cta: { label: SETUP_CTA_LABELS[mode], mode }, status: null };
}

const RUN_STATUS: Record<TestRunStatus, { label: string; variant: BadgeVariant }> = {
  queued: { label: 'Queued', variant: 'secondary' },
  running: { label: 'Running', variant: 'success' },
  passed: { label: 'Passed', variant: 'success' },
  failed: { label: 'Failed', variant: 'soft-destructive' },
  error: { label: 'Error', variant: 'warning' },
  stopped: { label: 'Stopped', variant: 'secondary' },
};

/** A Test Run's badge. `error` (no trustworthy result, e.g. a missing report) is never shown as a pass. */
export function testRunBadge(run: Pick<TestRun, 'status' | 'action'>): { label: string; variant: BadgeVariant } {
  if (run.action.purpose === 'utility' && run.status === 'passed') return { label: 'Log only', variant: 'secondary' };
  return RUN_STATUS[run.status];
}

/** `1.2s`, `41s`, `2m 05s`; null when unknown. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function countsText(counts: NormalizedTestResult['counts'] | null | undefined): string | null {
  if (!counts) return null;
  const parts = [
    counts.passed !== undefined ? `${counts.passed} passed` : null,
    counts.failed !== undefined ? `${counts.failed} failed` : null,
    counts.errored ? `${counts.errored} errored` : null,
    counts.skipped ? `${counts.skipped} skipped` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0 && counts.total !== undefined) return `${counts.total} total`;
  return parts.length ? parts.join(' · ') : null;
}

export interface SuiteCardModel {
  badge: { label: string; variant: BadgeVariant };
  counts: string | null;
  duration: string | null;
  /** `branch@commit` the shown result ran on. */
  where: string | null;
  trigger: 'manual' | 'agent' | null;
  /** The primary action is already queued or running, so Run is disabled and says so. */
  runLabel: 'Run' | 'Queued' | 'Running';
  canRun: boolean;
  resultActions: { id: string; label: string; primary: boolean; enabled: boolean }[];
  utilityActions: { id: string; label: string; enabled: boolean }[];
}

/** One suite card: its latest outcome (or live state), result summary, and which actions it offers. */
export function suiteCardModel(suite: TestSuiteOverview): SuiteCardModel {
  const primary = suite.actions.find((action) => action.id === suite.primaryActionId);
  const active = primary?.activeRun ?? null;
  const latest = suite.latestResult;
  const shown = active ?? latest;
  let badge: SuiteCardModel['badge'];
  if (!suite.enabled) badge = { label: 'Disabled in config', variant: 'secondary' };
  else if (shown) badge = testRunBadge(shown);
  else badge = { label: 'No results yet', variant: 'secondary' };
  const runLabel = active ? (active.status === 'running' ? 'Running' : 'Queued') : 'Run';
  return {
    badge,
    counts: countsText(latest?.summary?.counts),
    duration: formatDuration(latest?.durationMs),
    where: latest?.branch ? `${latest.branch}${latest.commit ? `@${latest.commit.slice(0, 7)}` : ''}` : null,
    trigger: latest?.trigger ?? null,
    runLabel,
    canRun: suite.enabled && Boolean(primary?.enabled) && !active,
    resultActions: suite.actions
      .filter((action) => action.purpose === 'result')
      .map((action) => ({ id: action.id, label: action.label, primary: action.id === suite.primaryActionId, enabled: suite.enabled && action.enabled && !action.activeRun })),
    utilityActions: suite.actions
      .filter((action) => action.purpose === 'utility')
      .map((action) => ({ id: action.id, label: action.label, enabled: suite.enabled && action.enabled && !action.activeRun })),
  };
}

export interface OverviewStats {
  passed: number;
  failed: number;
  total: number;
  failingSuites: number;
  /** True once at least one enabled suite's latest result reported `counts` — distinguishes a real "0" from nothing having run yet. */
  countsReported: boolean;
  /** The first coverage-looking metric among the latest results, or null when none is configured. */
  coverage: { value: number; unit?: string; suiteLabel: string } | null;
  findings: Record<FindingSeverity, number>;
}

const SEVERITIES: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** A suite's latest result as the stat cards read it. */
export interface SuiteResult {
  suiteLabel: string;
  summary: TestResultSummary;
}

/** The enabled suites' latest results that carry a summary — the selection behind the stat cards and the 3D village's test-health wall. */
export function suiteResults<S extends { label: string; enabled: boolean }>(suites: readonly S[], latestOf: (suite: S) => { summary: TestResultSummary | null } | null): SuiteResult[] {
  return suites.flatMap((suite) => {
    const summary = suite.enabled ? latestOf(suite)?.summary : null;
    return summary ? [{ suiteLabel: suite.label, summary }] : [];
  });
}

/** The stat cards' numbers, from each enabled suite's latest result. */
export function overviewStats(suites: TestSuiteOverview[]): OverviewStats {
  return tallyResults(suiteResults(suites, (suite) => suite.latestResult));
}

/** Sums suites' latest results into the numbers the stat cards (and the 3D village's test-health wall) show. */
export function tallyResults(results: readonly SuiteResult[]): OverviewStats {
  const stats: OverviewStats = {
    passed: 0, failed: 0, total: 0, failingSuites: 0, countsReported: false, coverage: null,
    findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };
  for (const { suiteLabel, summary } of results) {
    if (summary.counts) {
      stats.countsReported = true;
      const counts = summary.counts;
      stats.passed += counts.passed ?? 0;
      stats.failed += (counts.failed ?? 0) + (counts.errored ?? 0);
      stats.total += counts.total ?? 0;
      if ((counts.failed ?? 0) + (counts.errored ?? 0) > 0) stats.failingSuites += 1;
    }
    const coverage = summary.metrics.find((metric) => /coverage/i.test(`${metric.key} ${metric.label ?? ''}`));
    if (coverage && !stats.coverage) stats.coverage = { value: coverage.value, unit: coverage.unit, suiteLabel };
    for (const severity of SEVERITIES) stats.findings[severity] += summary.findingCounts[severity] ?? 0;
  }
  return stats;
}

export interface StatCardModel {
  label: 'Passed' | 'Failed' | 'Coverage';
  /** "Not reported" — never "0" — until a suite has actually reported a number for this card. */
  value: string;
  note: string;
}

/**
 * The tab's three stat cards, computed only from latest result-producing primary actions (spec:
 * exactly Passed/Failed/Coverage — findings surface on suite rows and the detail view instead, never
 * as a 4th card here, since a security/performance finding is not a test case).
 */
export function statCards(suites: TestSuiteOverview[]): StatCardModel[] {
  const stats = overviewStats(suites);
  return [
    {
      label: 'Passed',
      value: stats.countsReported ? String(stats.passed) : 'Not reported',
      note: stats.countsReported ? (stats.total ? `of ${stats.total}` : 'No cases reported') : 'No results yet',
    },
    {
      label: 'Failed',
      value: stats.countsReported ? String(stats.failed) : 'Not reported',
      note: stats.countsReported ? (stats.failingSuites ? `in ${stats.failingSuites} suite(s)` : 'No failures') : 'No results yet',
    },
    {
      label: 'Coverage',
      value: stats.coverage ? `${stats.coverage.value}${stats.coverage.unit ?? ''}` : 'Not reported',
      note: stats.coverage ? stats.coverage.suiteLabel : 'No coverage configured',
    },
  ];
}

/** Failed and errored cases first (in their original order), then the rest. */
export function sortCasesFailedFirst<T extends { outcome: string }>(cases: T[]): T[] {
  const failing = (c: T) => c.outcome === 'failed' || c.outcome === 'error';
  return [...cases.filter(failing), ...cases.filter((c) => !failing(c))];
}

export interface EvidenceRow {
  label: string;
  state: 'ok' | 'problem' | 'pending';
  detail: string;
}

/** The setup's validation evidence as rows: the config contract, then each enabled suite's primary action. */
export function evidenceRows(evidence: TestingSetupEvidence | null): EvidenceRow[] {
  if (!evidence) return [{ label: 'Validation', state: 'pending', detail: 'Not checked yet — the setup is checked when it reports it is done.' }];
  const configRow: EvidenceRow = evidence.config.state === 'valid'
    ? { label: 'config.json contract', state: 'ok', detail: `valid · ${evidence.config.suiteCount} suite(s)` }
    : { label: 'config.json contract', state: 'problem', detail: evidence.problems[0] ?? `config is ${evidence.config.state}` };
  const actionRows = evidence.actions.map((action): EvidenceRow => ({
    label: `${action.suiteId}/${action.actionId}`,
    state: action.problem ? 'problem' : 'ok',
    detail: action.problem ?? [action.status, countsText(action.counts)].filter(Boolean).join(' · '),
  }));
  if (evidence.config.state === 'valid' && actionRows.length === 0) {
    actionRows.push({ label: 'Suites', state: 'ok', detail: 'No suites configured.' });
  }
  return [configRow, ...actionRows];
}

/**
 * Whether the run detail view is showing a testing setup paused at its proposal gate: the only place
 * the read-only notice, the round-specific approval and "Reject setup" apply.
 */
export function isSetupProposalGate(
  run: Pick<WorkflowRunRecord, 'testingSetup' | 'status' | 'currentStepId'>,
  step: Pick<WorkflowStep, 'id' | 'canEditCode' | 'requiresApproval'> | undefined,
): boolean {
  return Boolean(run.testingSetup)
    && run.status === 'awaiting-approval'
    && step !== undefined
    && step.id === run.currentStepId
    && !step.canEditCode
    && step.requiresApproval;
}

/** A Project's Test Runs from the live feed, reduced to a key that changes whenever any of them does. */
export function testRunsSignature(runs: Record<string, Pick<TestRun, 'id' | 'projectId' | 'status'>>, projectId: string): string {
  return Object.values(runs)
    .filter((run) => run.projectId === projectId)
    .map((run) => `${run.id}:${run.status}`)
    .sort()
    .join(',');
}

/** A changing key for the Project's most recent Task — refreshing the Testing tab when an ordinary (non-setup) Task that may have edited `.docs/testing/config.json` finishes, without a dedicated WS event for it. */
export function lastTaskSignature(
  tasksById: Record<string, { status: string; updatedAt: string }>,
  lastTaskIdByProject: Record<string, string>,
  projectId: string,
): string {
  const id = lastTaskIdByProject[projectId];
  if (!id) return '';
  const task = tasksById[id];
  return task ? `${id}:${task.status}:${task.updatedAt}` : '';
}

/**
 * Leave blank to approve the round shown; any other text asks for a revised, still read-only
 * proposal instead. Shared by the run detail view's `SetupProposalDecision` and the Testing tab's own
 * inline gate card, so both read the same blank-vs-not rule.
 */
export type ApprovalDecision = { kind: 'approve'; round: number } | { kind: 'request-changes'; comment: string };

export function approvalDecision(feedback: string, round: number): ApprovalDecision {
  const trimmed = feedback.trim();
  return trimmed.length === 0 ? { kind: 'approve', round } : { kind: 'request-changes', comment: trimmed };
}

export interface RunStaleness {
  stale: boolean;
  /** Why the run can't be re-run from here, e.g. its suite or action no longer exists — null when not stale. */
  reason: string | null;
}

/**
 * Whether a TestRun's suite/action still exists in the *current* valid config — a run kept in history
 * or a detail view can outlive the config entry that produced it (the suite was removed, or the
 * action id was renamed/dropped). Distinct from a suite/action that still exists but is merely
 * `enabled: false` (that's "Disabled in config", not stale).
 */
export function runStaleness(run: Pick<TestRun, 'suite' | 'action'>, config: TestingConfigState): RunStaleness {
  if (config.state !== 'valid') return { stale: true, reason: 'The testing config is not currently valid.' };
  const suite = config.config.suites.find((s) => s.id === run.suite.id);
  if (!suite) return { stale: true, reason: 'This suite is no longer configured.' };
  const action = suite.actions.find((a) => a.id === run.action.id);
  if (!action) return { stale: true, reason: 'This action is no longer configured on this suite.' };
  return { stale: false, reason: null };
}

export interface ResultSections {
  hasCases: boolean;
  hasMetrics: boolean;
  hasFindings: boolean;
  /** The run reported a result with nothing in it — distinct from "never run" (`result === null`). */
  isEmpty: boolean;
}

/** Which of a NormalizedTestResult's sections actually have data — the detail view renders by what's present, not by the suite's `kind`, since one result can carry more than one kind of data (e.g. coverage reporting both `metrics` and `cases`). */
export function resultSections(result: NormalizedTestResult | null): ResultSections {
  if (!result) return { hasCases: false, hasMetrics: false, hasFindings: false, isEmpty: false };
  const hasCases = result.cases.length > 0;
  const hasMetrics = result.metrics.length > 0;
  const hasFindings = result.findings.length > 0;
  return { hasCases, hasMetrics, hasFindings, isEmpty: !hasCases && !hasMetrics && !hasFindings };
}

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Findings grouped worst-first — never folded into the case pass/fail counts. */
export function sortFindingsBySeverity<T extends { severity: FindingSeverity }>(findings: T[]): T[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/** A metric's displayed label/unit: its own (from the Collector) first, else the config's declared display for that key, else the raw key. */
export function metricDisplay(
  metric: Pick<NormalizedTestResult['metrics'][number], 'key' | 'label' | 'unit'>,
  configMetrics: MetricDisplayConfig[],
): { label: string; unit?: string } {
  const declared = configMetrics.find((m) => m.key === metric.key);
  return { label: metric.label ?? declared?.label ?? metric.key, unit: metric.unit ?? declared?.unit };
}

export interface DiagnosticsBannerEntry {
  suiteId: string;
  suiteLabel: string;
  runId: string;
  message: string;
}

/** Enabled suites whose latest run has something worth flagging prominently — a missing/unreadable report, or an output cut off at its size limit. Excludes disabled suites, since those aren't "currently live". */
export function diagnosticsBanner(suites: TestSuiteOverview[]): DiagnosticsBannerEntry[] {
  const entries: DiagnosticsBannerEntry[] = [];
  for (const suite of suites) {
    if (!suite.enabled) continue;
    const run = suite.latestResult;
    if (!run) continue;
    if (run.diagnostics.length > 0) {
      for (const diagnostic of run.diagnostics) {
        entries.push({ suiteId: suite.id, suiteLabel: suite.label, runId: run.id, message: diagnostic.message });
      }
    } else if (run.outputTruncated) {
      entries.push({ suiteId: suite.id, suiteLabel: suite.label, runId: run.id, message: 'The log was cut off at its size limit.' });
    }
  }
  return entries;
}

export type RunAllGuard = { enabled: true } | { enabled: false; reason: string };

/**
 * Whether "Run all" may be clicked: disabled with no runnable suite, or once every runnable suite's
 * primary action is already queued/running (the whole batch is already in flight). A *partial*
 * overlap — some primary actions already active from individual runs, others idle — still allows the
 * click; the still-idle ones are what it enqueues (see planningGap: the spec leaves this split case
 * open, this is the rule Development picked).
 */
export function runAllGuard(suites: TestSuiteOverview[]): RunAllGuard {
  const runnable = suites.filter((suite) => suite.enabled && suite.actions.some((action) => action.id === suite.primaryActionId && action.enabled));
  if (runnable.length === 0) return { enabled: false, reason: 'No runnable suites are configured' };
  const allActive = runnable.every((suite) => suite.actions.find((action) => action.id === suite.primaryActionId)?.activeRun);
  if (allActive) return { enabled: false, reason: 'Every suite is already queued or running' };
  return { enabled: true };
}

export interface RunHistoryRow {
  id: string;
  suiteLabel: string;
  actionLabel: string;
  badge: { label: string; variant: BadgeVariant };
  /** Counts/metric summary for the run that produced it, or null (queued/no normalized result). */
  result: string | null;
  startedLabel: string;
  duration: string | null;
  triggerLabel: 'you' | 'agent';
  /** `branch@commit`, a branch alone, or null when the run has no git context at all. */
  context: string | null;
  taskId: string | null;
  isUtility: boolean;
  stale: RunStaleness;
}

/** One run history row's display fields, from the raw TestRun plus the current config (for staleness). */
export function runHistoryRow(run: TestRun, config: TestingConfigState, now: Date = new Date()): RunHistoryRow {
  return {
    id: run.id,
    suiteLabel: run.suite.label,
    actionLabel: run.action.label,
    badge: testRunBadge(run),
    result: countsText(run.summary?.counts),
    startedLabel: run.startedAt ? formatRelativeTime(run.startedAt, now) : formatRelativeTime(run.queuedAt, now),
    duration: formatDuration(run.durationMs),
    triggerLabel: run.trigger === 'agent' ? 'agent' : 'you',
    context: run.branch ? `${run.branch}${run.commit ? `@${run.commit.slice(0, 7)}` : ''}` : null,
    taskId: run.taskId,
    isUtility: run.action.purpose === 'utility',
    stale: runStaleness(run, config),
  };
}
