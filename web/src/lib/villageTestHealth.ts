import { suiteResults, tallyResults } from './testingPanel';
import { formatRelativeTime } from './sessionTiming';
import type { TestResultSummary, TestRun, TestSuiteOverview } from './serverApi';

/**
 * The 3D village's test-health wall: what a Project's latest test results on its checked-out branch
 * say, as the three numbers the wall draws — coverage (length), passed/failed split (colour) and age
 * of the last run (intensity). Pure, so every rule is unit-testable without a scene.
 */

/** The parts of a test run the health reads. */
export type HealthRun = Pick<TestRun, 'id' | 'projectId' | 'status' | 'branch' | 'executionRoot' | 'completedAt' | 'summary'> & {
  suite: Pick<TestRun['suite'], 'id'>;
  action: Pick<TestRun['action'], 'id' | 'purpose'>;
};

/**
 * What the Testing tab's overview says about the Project: its suites (enabled flag, primary action)
 * and its own working folder, read from the `executionRoot` of the overview's own-tree results.
 */
export interface HealthConfig {
  root: string;
  suites: Pick<TestSuiteOverview, 'id' | 'label' | 'enabled' | 'primaryActionId'>[];
}

/** The config the overview gives, or null while no result exists in the Project's own tree (so no wall is possible). */
export function healthConfigOf(suites: readonly TestSuiteOverview[]): HealthConfig | null {
  const root = suites.find((suite) => suite.latestResult)?.latestResult?.executionRoot;
  return root ? { root, suites: suites.map(({ id, label, enabled, primaryActionId }) => ({ id, label, enabled, primaryActionId })) } : null;
}

export interface TestHealth {
  branch: string;
  /** Coverage as a 0–1 share of the wall's perimeter; null when no suite reports coverage (no wall). */
  coverageFraction: number | null;
  /** The coverage percent as reported, clamped to 0–100; null with `coverageFraction`. */
  coveragePercent: number | null;
  passed: number;
  failed: number;
  /** Shares of the wall that are green and red; both null while no suite reported counts (and when nothing passed or failed). */
  passedShare: number | null;
  failedShare: number | null;
  /** 1 within a day of the last run, fading to `INTENSITY_FLOOR` at two days. */
  ageIntensity: number;
  /** The newest completion among the runs read; null when none has a valid time. */
  lastRunAt: string | null;
}

const HOUR_MS = 3_600_000;
const FULL_INTENSITY_MS = 24 * HOUR_MS;
const FADED_INTENSITY_MS = 48 * HOUR_MS;
/** An aged wall stays visible rather than vanishing. */
export const INTENSITY_FLOOR = 0.3;
/** How often the wall re-reads the clock so its intensity follows the run's age without a reload. */
export const HEALTH_REFRESH_MS = 5 * 60_000;
/** Intensity is compared (and a frame requested) in steps this fine. */
const INTENSITY_STEP = 0.01;

const LINE_COVERAGE_KEY = 'line-coverage';

/** 1 for a run within 24h, `INTENSITY_FLOOR` beyond 48h, linear between; a missing or invalid time reads as aged. */
export function ageIntensity(completedAt: string | null, now: number): number {
  const at = completedAt ? Date.parse(completedAt) : NaN;
  if (Number.isNaN(at)) return INTENSITY_FLOOR;
  const age = now - at;
  if (age <= FULL_INTENSITY_MS) return 1;
  if (age >= FADED_INTENSITY_MS) return INTENSITY_FLOOR;
  return 1 - (1 - INTENSITY_FLOOR) * ((age - FULL_INTENSITY_MS) / (FADED_INTENSITY_MS - FULL_INTENSITY_MS));
}

const RESULT_STATUSES: readonly HealthRun['status'][] = ['passed', 'failed', 'error'];
const completedMs = (run: HealthRun) => (run.completedAt ? Date.parse(run.completedAt) : NaN) || 0;

/**
 * Each suite's newest finished run of its primary action on `branch` in the Project's own working
 * tree (a task-worktree run never counts) — the Testing tab's "latest result" rule, narrowed to a branch.
 */
export function latestBranchResult(runs: readonly HealthRun[], config: HealthConfig, suiteId: string, primaryActionId: string, branch: string): HealthRun | null {
  let newest: HealthRun | null = null;
  for (const run of runs) {
    if (run.suite.id !== suiteId || run.action.id !== primaryActionId || run.action.purpose !== 'result') continue;
    if (run.branch !== branch || run.executionRoot !== config.root) continue;
    if (!RESULT_STATUSES.includes(run.status) || !run.summary) continue;
    if (!newest || completedMs(run) > completedMs(newest)) newest = run;
  }
  return newest;
}

const validPercent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;

function coveragePercentOf(results: readonly { summary: TestResultSummary }[], fallback: number | undefined): number | null {
  for (const { summary } of results) {
    const line = summary.metrics.find((metric) => metric.key === LINE_COVERAGE_KEY);
    const percent = validPercent(line?.value);
    if (percent !== null) return percent;
  }
  return validPercent(fallback);
}

/** The Project's test health on `branch` at time `now`, or null when that branch has no result to show. */
export function testHealth(runs: readonly HealthRun[], config: HealthConfig | null, branch: string | null, now: number): TestHealth | null {
  if (!config || !branch) return null;
  const picked = new Map<string, HealthRun>();
  const results = suiteResults(config.suites, (suite) => {
    const run = latestBranchResult(runs, config, suite.id, suite.primaryActionId, branch);
    if (run) picked.set(suite.id, run);
    return run;
  });
  if (results.length === 0) return null;
  const latest = [...picked.values()];
  const stats = tallyResults(results);
  const coveragePercent = coveragePercentOf(results, stats.coverage?.value);
  const judged = stats.passed + stats.failed;
  const split = stats.countsReported && judged > 0;
  const lastRunMs = Math.max(...latest.map(completedMs));
  return {
    branch,
    coverageFraction: coveragePercent === null ? null : coveragePercent / 100,
    coveragePercent,
    passed: stats.passed,
    failed: stats.failed,
    passedShare: split ? stats.passed / judged : null,
    failedShare: split ? stats.failed / judged : null,
    ageIntensity: ageIntensity(lastRunMs > 0 ? new Date(lastRunMs).toISOString() : null, now),
    lastRunAt: lastRunMs > 0 ? new Date(lastRunMs).toISOString() : null,
  };
}

/** True when two healths draw and say the same thing, ignoring sub-step intensity drift. */
export function sameTestHealth(a: TestHealth | null, b: TestHealth | null): boolean {
  if (!a || !b) return a === b;
  return a.branch === b.branch && a.coveragePercent === b.coveragePercent && a.passed === b.passed && a.failed === b.failed
    && a.passedShare === b.passedShare && a.lastRunAt === b.lastRunAt
    && Math.round(a.ageIntensity / INTENSITY_STEP) === Math.round(b.ageIntensity / INTENSITY_STEP);
}

/** The warehouse tag's lines: the branch, then whichever of counts, coverage and last-run age are known. */
export function testHealthTooltip(health: TestHealth, now: number): { title: string; lines: string[] } {
  const lines: string[] = [];
  if (health.passedShare !== null) lines.push(`${health.passed} passed / ${health.failed} failed`);
  if (health.coveragePercent !== null) lines.push(`${Math.round(health.coveragePercent * 10) / 10}% coverage`);
  if (health.lastRunAt) lines.push(`last run ${formatRelativeTime(health.lastRunAt, new Date(now))}`);
  return { title: health.branch, lines };
}

/** Where an intensity sits between the faded tone (0) and the full colour (1). */
export const intensityWeight = (intensity: number): number => (intensity - INTENSITY_FLOOR) / (1 - INTENSITY_FLOOR);

const sameHealthRun = (a: HealthRun, b: HealthRun) =>
  a.id === b.id && a.status === b.status && a.branch === b.branch && a.executionRoot === b.executionRoot && a.completedAt === b.completedAt;

/** True when two run lists match on what the health reads (a finished run's summary never changes), so a streamed log chunk changes nothing. */
export const sameHealthRuns = (a: readonly HealthRun[], b: readonly HealthRun[]): boolean =>
  a.length === b.length && a.every((run, i) => sameHealthRun(run, b[i]!));

/** The health after a clock tick: the new value only when it differs from `current`, else null (no state change, no frame). */
export function healthAfterTick(current: TestHealth | null, runs: readonly HealthRun[], config: HealthConfig | null, branch: string | null, now: number): { next: TestHealth | null } | null {
  const next = testHealth(runs, config, branch, now);
  return sameTestHealth(current, next) ? null : { next };
}
