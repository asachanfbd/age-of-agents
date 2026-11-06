import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATA_DIR, TEST_RUN_RETENTION } from '../config.ts';
import { tasksDb, testRunsDb } from '../db/collections.ts';
import type { NormalizedTestResult, ProjectRecord, TestResultSummary, TestRunDiagnostic, TestRunRecord, TestRunStatus, TestRunTrigger } from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { isRunWatched, ranLongEnough } from '../notifications/runWatch.ts';
import { namedAtStart } from '../domain/displayName.ts';
import { resolveSafePath } from '../projects/fileTree.ts';
import { git } from '../projects/git.ts';
import { getProject, projectAbsolutePath, taskWorkingDirectory } from '../projects/projectService.ts';
import { resolveCollectorArtifactPath } from './artifacts.ts';
import { collectArtifacts } from './collectors.ts';
import { loadTestingConfig } from './config.ts';
import { spawnInProcessGroup, STOP_GRACE_MS } from '../commands/processGroup.ts';
import type { GroupProcess } from '../commands/processGroup.ts';
import { createRunFiles } from './runFiles.ts';
import type { RunFiles } from './runFiles.ts';
import { admitChunk, closingLog, EMPTY_LOG_BUDGET } from './runLog.ts';
import type { LogBudget } from './runLog.ts';
import { FINDING_SEVERITIES, TEST_ARTIFACTS_DIR_ENV } from './types.ts';
import type { TestActionConfig, TestingConfigState, TestSuiteConfig } from './types.ts';

/**
 * The Test Run engine: executes a Project's configured Test Actions (see docs/testing-contract.md)
 * as shell subprocesses, one at a time per Project, and keeps a persistent, normalized history.
 * Structurally parallel to commands/commandRunner.ts (its own event bus, same shell semantics),
 * plus what testing needs on top: a per-Project queue so heavy suites never overlap, a per-run
 * artifact directory parsed by the declared Collectors, and "latest result" rules for the UI.
 * The run record stays small (it lives in `test-runs.json` with every other run); each run's log
 * and full result go to their own files — see runFiles.ts.
 * Every side effect (spawn, artifact directory, report reads, git) is injectable so tests never
 * start a real process — see TestRunnerDeps.
 */

// ---- Errors ----

/** "Unit tests / Run" — how a user-facing message names one suite's action (never by its ids). */
function testActionLabel(suite: { label: string }, action: { label: string }): string {
  return `${suite.label} / ${action.label}`;
}

export class TestRunNotFoundError extends Error {
  constructor() {
    super('This test run no longer exists');
    this.name = 'TestRunNotFoundError';
  }
}

export class TestingConfigUnavailableError extends Error {
  constructor(state: TestingConfigState['state']) {
    super(state === 'absent' ? 'This project has no testing config yet (.docs/testing/config.json)' : 'The testing config is invalid — repair it before running tests');
    this.name = 'TestingConfigUnavailableError';
  }
}

export class TestActionNotFoundError extends Error {
  constructor(suite?: Pick<TestSuiteConfig, 'label'>) {
    super(suite ? `${namedAtStart('test suite', suite.label)} has no such test action in the testing config` : 'This test suite is not in the testing config');
    this.name = 'TestActionNotFoundError';
  }
}

export class TestActionDisabledError extends Error {
  constructor(label: string) {
    super(`${namedAtStart('test action', label)} (or its suite) is disabled`);
    this.name = 'TestActionDisabledError';
  }
}

export class TestRunAlreadyActiveError extends Error {
  constructor(label: string) {
    super(`${namedAtStart('test action', label)} is already queued or running for this working tree`);
    this.name = 'TestRunAlreadyActiveError';
  }
}

export class NoRunnableSuitesError extends Error {
  constructor() {
    super('No enabled test suite could be queued — none are enabled, or every one is already queued or running');
    this.name = 'NoRunnableSuitesError';
  }
}

export class TestRunNotQueuedError extends Error {
  constructor(run: TestRunRecord) {
    super(`${namedAtStart('test run', testActionLabel(run.suite, run.action))} is not queued — only a queued run can be removed (stop a running one instead)`);
    this.name = 'TestRunNotQueuedError';
  }
}

export class TestRunNotRunningError extends Error {
  constructor(run: TestRunRecord) {
    super(`${namedAtStart('test run', testActionLabel(run.suite, run.action))} is still queued — remove it instead of stopping it`);
    this.name = 'TestRunNotRunningError';
  }
}

export class TestRunTaskError extends Error {
  constructor(project: Pick<ProjectRecord, 'name'>) {
    super(`This task does not exist in project "${project.name}"`);
    this.name = 'TestRunTaskError';
  }
}

// ---- Events and wire shapes ----

export type TestRunEvent =
  | { type: 'testRun'; run: TestRunRecord }
  | { type: 'testRunLog'; runId: string; projectId: string; chunk: string }
  | { type: 'testRunRemoved'; runId: string; projectId: string };

/** One run with its log and full result, read from its own files — what GET /test-runs/:runId returns. */
export type TestRunDetail = TestRunRecord & { output: string; result: NormalizedTestResult | null };

export interface TestActionOverview {
  id: string;
  label: string;
  purpose: TestActionConfig['purpose'];
  enabled: boolean;
  /** Latest passed/failed/error run of a result action on the primary working tree; always null for a utility action. */
  latestResult: TestRunRecord | null;
  /** Latest finished run of any status (incl. stopped) on the primary working tree — a utility action's "last run". */
  latestRun: TestRunRecord | null;
  /** The queued or running copy of this action on the primary working tree, if any. */
  activeRun: TestRunRecord | null;
}

export interface TestSuiteOverview {
  id: string;
  label: string;
  kind: TestSuiteConfig['kind'];
  enabled: boolean;
  primaryActionId: string;
  /** Latest passed/failed/error run of any result action in this suite, on the primary working tree. */
  latestResult: TestRunRecord | null;
  actions: TestActionOverview[];
}

export interface TestingOverview {
  config: TestingConfigState;
  /** Empty unless the config is valid. */
  suites: TestSuiteOverview[];
  /** Running run first, then the queue in execution order. */
  queue: TestRunRecord[];
}

export interface TestRunPage {
  runs: TestRunRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface TestRunFilter {
  suiteId?: string;
  actionId?: string;
  status?: TestRunStatus;
  /** Only runs whose failure nobody has opened yet (`TestRunRecord.failureUnopened`). */
  failureUnopened?: boolean;
  limit?: number;
  offset?: number;
}

export interface EnqueueOptions {
  /** Present for an agent-triggered run: it executes in that Task's cwd/worktree and links to it. */
  taskId?: string;
  /** Return the action's already queued/running copy on the same working tree instead of refusing a duplicate. */
  joinActive?: boolean;
}

export interface RunAllResult {
  batchId: string;
  runs: TestRunRecord[];
  /** Suites whose primary action was already queued/running (as `runId`) and so weren't queued again. */
  skipped: { suiteId: string; actionId: string; runId: string }[];
}

// ---- Dependencies ----

/** The slice of a child process the runner uses — a fake in tests. */
export type TestProcess = GroupProcess;

export interface TestRunnerDeps {
  spawnProcess(command: string, options: { cwd: string; env: NodeJS.ProcessEnv }): TestProcess;
  createArtifactDir(): Promise<string>;
  removeArtifactDir(dir: string): Promise<void>;
  /** Reads one Collector's report; must refuse anything outside `artifactDir`. */
  readArtifact(artifactDir: string, relativePath: string): Promise<string>;
  gitInfo(cwd: string): Promise<{ branch: string | null; commit: string | null }>;
  /** Completed runs kept per Project. */
  retention: number;
  /** Where each run's log and full result are stored. */
  runFiles: RunFiles;
  /**
   * How long to wait for stdio to close after the command exits before stopping whatever still
   * holds it (a background `server &` the command started) and settling the run anyway.
   */
  closeGraceMs: number;
  /**
   * Runs executing at once across every Project. Several agents each running a full suite at the
   * same time overloads the machine and turns timing-sensitive tests into failures, so extra runs
   * wait in their Project's queue (still `queued`) until a slot frees.
   */
  maxConcurrentRuns: number;
  /** A run still going after this long is stopped and settles as an `error` (a hung suite would otherwise hold its slot forever). */
  runTimeoutMs: number;
}

const positiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** How long deleting a Project waits for its running test to stop before removing its files. */
const DISCARD_WAIT_MS = STOP_GRACE_MS + 1_000;

async function gitInfoDefault(cwd: string): Promise<{ branch: string | null; commit: string | null }> {
  const read = (args: string[]) => git(cwd, args).catch(() => null);
  const [branch, commit] = await Promise.all([read(['rev-parse', '--abbrev-ref', 'HEAD']), read(['rev-parse', 'HEAD'])]);
  return { branch: branch && branch !== 'HEAD' ? branch : null, commit: commit || null };
}

export const defaultTestRunnerDeps: TestRunnerDeps = {
  spawnProcess: spawnInProcessGroup,
  createArtifactDir: () => mkdtemp(path.join(tmpdir(), 'avos-test-run-')),
  removeArtifactDir: (dir) => rm(dir, { recursive: true, force: true }),
  readArtifact: async (artifactDir, relativePath) => readFile(await resolveCollectorArtifactPath(artifactDir, relativePath), 'utf-8'),
  gitInfo: gitInfoDefault,
  retention: TEST_RUN_RETENTION,
  runFiles: createRunFiles(path.join(DATA_DIR, 'test-runs')),
  closeGraceMs: 2_000,
  maxConcurrentRuns: positiveInt(process.env.AGENT_VISUAL_OS_TEST_MAX_CONCURRENT_RUNS, 2),
  runTimeoutMs: positiveInt(process.env.AGENT_VISUAL_OS_TEST_RUN_TIMEOUT_MS, 15 * 60_000),
};

// ---- Pure rules ----

const ACTIVE_STATUSES: TestRunStatus[] = ['queued', 'running'];
const RESULT_STATUSES: TestRunStatus[] = ['passed', 'failed', 'error'];

export const isActive = (run: Pick<TestRunRecord, 'status'>) => ACTIVE_STATUSES.includes(run.status);

/** The small part of a result kept on the run record itself. */
export function summarizeResult(result: NormalizedTestResult): TestResultSummary {
  const { cases: _cases, findings, ...rest } = result;
  const findingCounts = Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, 0])) as TestResultSummary['findingCounts'];
  for (const finding of findings) findingCounts[finding.severity] += 1;
  return { ...rest, findingCounts };
}

/** Newest first; ties (same millisecond) broken by insertion order, newest first. */
function newestFirst(runs: TestRunRecord[]): TestRunRecord[] {
  return [...runs].reverse().sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
}

/**
 * The run that represents "the latest result" for a suite (or one action of it): the newest
 * *finished* run of a result-producing action that produced a verdict. Utility runs never count,
 * nor do stopped runs (no verdict) or active ones.
 */
export function latestResultRun(runs: TestRunRecord[], suiteId: string, actionId?: string): TestRunRecord | null {
  return newestFirst(runs).find((run) => run.action.purpose === 'result' && run.suite.id === suiteId
    && (actionId === undefined || run.action.id === actionId) && RESULT_STATUSES.includes(run.status)) ?? null;
}

/**
 * Turns a finished process into a run status. `result` actions with Collectors trust the report
 * (a failing report with a nonzero exit is `failed`, not `error`); a report that says passed while
 * the command exited nonzero is `failed` with an `exit-code-mismatch` note, since something the
 * report didn't capture went wrong. Missing/malformed artifacts make the run `error`.
 */
export function decideStatus(input: {
  purpose: TestActionConfig['purpose'];
  exitCode: number | null;
  hasCollectors: boolean;
  collection: { result: NormalizedTestResult | null; complete: boolean } | null;
}): { status: TestRunStatus; diagnostics: TestRunDiagnostic[] } {
  const exitOk = input.exitCode === 0;
  if (input.purpose === 'utility' || !input.hasCollectors || !input.collection) return { status: exitOk ? 'passed' : 'failed', diagnostics: [] };
  const { result, complete } = input.collection;
  if (!complete || !result) return { status: 'error', diagnostics: [] };
  if (result.outcome === 'error') return { status: 'error', diagnostics: [] };
  if (result.outcome === 'failed') return { status: 'failed', diagnostics: [] };
  if (exitOk) return { status: 'passed', diagnostics: [] };
  return {
    status: 'failed',
    diagnostics: [{ code: 'exit-code-mismatch', message: `The report says ${result.outcome}, but the command exited with code ${input.exitCode}` }],
  };
}

/** "15 minutes" for whole-minute limits, otherwise milliseconds (only tests use a short one). */
export function describeTimeout(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${ms} ms`;
}

// ---- The runner ----

interface ActiveRun {
  runId: string;
  process: TestProcess | null;
  artifactDir: string | null;
  log: LogBudget;
  /** Log appends, chained so they land in order; awaited before the log is read or closed. */
  writes: Promise<void>;
  logWriteError: string | null;
  /** The closing tail has been queued to the log file, so reads must not add it again. */
  logClosed: boolean;
  stopRequested: boolean;
  /** The run hit `runTimeoutMs` and its process was signalled. */
  timedOut: boolean;
  /** The process has ended (or finalize has begun): Stop no longer applies and late output is ignored. */
  ended: boolean;
  /** finalize runs once per run, whichever path reaches it first. */
  finalized: boolean;
  /** Set when the Project is being deleted: finalize only cleans up, there's no record to update. */
  discarded: boolean;
  /** Resolves once finalize has completely finished. */
  done: Promise<void>;
  resolveDone: () => void;
}

type RunOutcome = { status: TestRunStatus; exitCode: number | null; result?: NormalizedTestResult | null; diagnostics: TestRunDiagnostic[] };

function newActiveRun(runId: string): ActiveRun {
  let resolveDone = () => undefined as void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  return {
    runId, process: null, artifactDir: null, log: EMPTY_LOG_BUDGET, writes: Promise.resolve(), logWriteError: null,
    logClosed: false, stopRequested: false, timedOut: false, ended: false, finalized: false, discarded: false, done, resolveDone,
  };
}

function internalError(exitCode: number | null, error: unknown): RunOutcome {
  return { status: 'error', exitCode, diagnostics: [{ code: 'internal-error', message: (error as Error).message }] };
}

export function createTestRunner(overrides: Partial<TestRunnerDeps> = {}) {
  const deps: TestRunnerDeps = { ...defaultTestRunnerDeps, ...overrides };
  const listeners = new Set<(event: TestRunEvent) => void>();
  /** Queued run ids per Project, in execution order. */
  const queues = new Map<string, string[]>();
  /** The one run per Project currently starting or running. */
  const active = new Map<string, ActiveRun>();
  /** Serializes enqueue/remove per Project so the duplicate check can't race. */
  const locks = new Map<string, Promise<unknown>>();

  function onTestEvent(listener: (event: TestRunEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(event: TestRunEvent): void {
    for (const listener of listeners) listener(event);
  }

  function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(projectId) ?? Promise.resolve()).then(fn);
    locks.set(projectId, run.catch(() => undefined));
    return run;
  }

  async function update(runId: string, patch: Partial<TestRunRecord>): Promise<TestRunRecord | undefined> {
    const updated = await testRunsDb.update(runId, patch);
    if (updated) emit({ type: 'testRun', run: updated });
    return updated;
  }

  // ---- Enqueueing ----

  async function executionRootFor(project: ProjectRecord, taskId: string | undefined): Promise<{ root: string; trigger: TestRunTrigger; taskId: string | null }> {
    if (!taskId) return { root: projectAbsolutePath(project), trigger: 'manual', taskId: null };
    const task = await tasksDb.get(taskId);
    if (!task || task.projectId !== project.id) throw new TestRunTaskError(project);
    return { root: taskWorkingDirectory(project, task), trigger: 'agent', taskId };
  }

  async function validConfig(root: string) {
    const state = await loadTestingConfig(root);
    if (state.state !== 'valid') throw new TestingConfigUnavailableError(state.state);
    return state.config;
  }

  function findAction(suites: TestSuiteConfig[], suiteId: string, actionId: string) {
    const suite = suites.find((s) => s.id === suiteId);
    if (!suite) throw new TestActionNotFoundError();
    const action = suite.actions.find((a) => a.id === actionId);
    if (!action) throw new TestActionNotFoundError(suite);
    if (!suite.enabled || !action.enabled) throw new TestActionDisabledError(testActionLabel(suite, action));
    return { suite, action };
  }

  /** One queued/running copy per action per working tree: an agent's worktree run doesn't block a manual one. */
  async function activeDuplicate(projectId: string, root: string, suiteId: string, actionId: string): Promise<TestRunRecord | undefined> {
    const existing = await testRunsDb.find((run) => run.projectId === projectId && isActive(run)
      && run.executionRoot === root && run.suite.id === suiteId && run.action.id === actionId);
    return existing[0];
  }

  async function insertQueued(
    projectId: string, where: { root: string; trigger: TestRunTrigger; taskId: string | null },
    suite: TestSuiteConfig, action: TestActionConfig, batchId: string | null,
  ): Promise<TestRunRecord> {
    const run: TestRunRecord = {
      id: randomUUID(),
      projectId,
      batchId,
      suite: { id: suite.id, label: suite.label, kind: suite.kind },
      action: snapshotAction(action),
      trigger: where.trigger,
      taskId: where.taskId,
      executionRoot: where.root,
      cwd: null,
      branch: null,
      commit: null,
      status: 'queued',
      exitCode: null,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      outputTruncated: false,
      summary: null,
      diagnostics: [],
      artifactDir: null,
    };
    await testRunsDb.insert(run);
    queueFor(projectId).push(run.id);
    emit({ type: 'testRun', run });
    return run;
  }

  function queueFor(projectId: string): string[] {
    let queue = queues.get(projectId);
    if (!queue) queues.set(projectId, (queue = []));
    return queue;
  }

  async function enqueueAction(projectId: string, suiteId: string, actionId: string, options: EnqueueOptions = {}): Promise<TestRunRecord> {
    const run = await withLock(projectId, async () => {
      const project = await getProject(projectId);
      const where = await executionRootFor(project, options.taskId);
      const { suite, action } = findAction((await validConfig(where.root)).suites, suiteId, actionId);
      const duplicate = await activeDuplicate(project.id, where.root, suiteId, actionId);
      if (duplicate && options.joinActive) return duplicate;
      if (duplicate) throw new TestRunAlreadyActiveError(testActionLabel(suite, action));
      return insertQueued(project.id, where, suite, action, null);
    });
    pump(projectId);
    return run;
  }

  /** Queues every enabled suite's primary action, in config order, as one batch. Later runs still go ahead after one fails. */
  async function enqueueRunAll(projectId: string, options: EnqueueOptions = {}): Promise<RunAllResult> {
    const result = await withLock(projectId, async () => {
      const project = await getProject(projectId);
      const where = await executionRootFor(project, options.taskId);
      const config = await validConfig(where.root);
      const batch: RunAllResult = { batchId: randomUUID(), runs: [], skipped: [] };
      for (const suite of config.suites.filter((s) => s.enabled)) {
        const action = suite.actions.find((a) => a.id === suite.primaryActionId)!;
        const duplicate = await activeDuplicate(project.id, where.root, suite.id, action.id);
        if (duplicate) batch.skipped.push({ suiteId: suite.id, actionId: action.id, runId: duplicate.id });
        else batch.runs.push(await insertQueued(project.id, where, suite, action, batch.batchId));
      }
      if (!batch.runs.length) throw new NoRunnableSuitesError();
      return batch;
    });
    pump(projectId);
    return result;
  }

  // ---- Executing ----

  function pump(projectId: string): void {
    if (active.has(projectId) || active.size >= deps.maxConcurrentRuns) return;
    const runId = queues.get(projectId)?.shift();
    if (!runId) return;
    const entry = newActiveRun(runId);
    active.set(projectId, entry);
    void execute(projectId, entry).catch((error) => finalize(projectId, entry, internalError(null, error)));
  }

  /** A slot freed: give it to the Projects that have been waiting, oldest queue first. */
  function pumpWaiting(): void {
    for (const projectId of [...queues.keys()]) pump(projectId);
  }

  async function execute(projectId: string, entry: ActiveRun): Promise<void> {
    const queued = await requireRun(entry.runId);
    // Config is re-read at start: the action may have changed or vanished while this run waited.
    const state = await loadTestingConfig(queued.executionRoot);
    let suite: TestSuiteConfig; let action: TestActionConfig;
    try {
      if (state.state !== 'valid') throw new TestingConfigUnavailableError(state.state);
      ({ suite, action } = findAction(state.config.suites, queued.suite.id, queued.action.id));
    } catch (error) {
      await finalize(projectId, entry, { status: 'error', exitCode: null, diagnostics: [{ code: 'config-unavailable', message: (error as Error).message }] });
      return;
    }

    let cwd: string;
    try {
      cwd = await resolveSafePath(queued.executionRoot, action.workingDirectory);
    } catch (error) {
      await finalize(projectId, entry, { status: 'error', exitCode: null, diagnostics: [{ code: 'unsafe-working-directory', message: (error as Error).message }] });
      return;
    }

    const { branch, commit } = await deps.gitInfo(queued.executionRoot);
    const artifactDir = await deps.createArtifactDir();
    entry.artifactDir = artifactDir;
    // Checked with no await before the update below: a stop that lands later queues its own
    // 'stopped' write after this one, so it's never overwritten.
    if (entry.stopRequested) {
      await finalize(projectId, entry, { status: 'stopped', exitCode: null, diagnostics: [] });
      return;
    }
    await update(entry.runId, {
      status: 'running', startedAt: new Date().toISOString(), cwd, branch, commit, artifactDir,
      suite: { id: suite.id, label: suite.label, kind: suite.kind }, action: snapshotAction(action),
    });
    if (entry.stopRequested) {
      await finalize(projectId, entry, { status: 'stopped', exitCode: null, diagnostics: [] });
      return;
    }

    const child = deps.spawnProcess(action.command, { cwd, env: { ...process.env, [TEST_ARTIFACTS_DIR_ENV]: artifactDir } });
    entry.process = child;
    const onChunk = (chunk: Buffer | string) => appendLog(projectId, entry, chunk.toString());
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    let closeTimer: NodeJS.Timeout | null = null;
    const timeoutTimer = setTimeout(() => {
      if (entry.ended) return;
      entry.timedOut = true;
      child.kill();
    }, deps.runTimeoutMs);
    timeoutTimer.unref();
    const settleOnce = (exitCode: number | null, spawnError: Error | null, extra: TestRunDiagnostic[] = []) => {
      if (entry.ended) return;
      entry.ended = true;
      clearTimeout(timeoutTimer);
      if (closeTimer) clearTimeout(closeTimer);
      void settleProcess(projectId, entry, action, exitCode, spawnError, extra).catch((error) => finalize(projectId, entry, internalError(exitCode, error)));
    };
    child.on('error', (error) => settleOnce(null, error));
    child.on('close', (code) => settleOnce(code, null));
    // 'close' waits for every stdio pipe, which a background child (`node server.js & npm test`)
    // can hold open forever — that would block the Project's whole queue. Give it a moment, then
    // stop the rest of the tree and settle on the command's own exit code.
    child.on('exit', (code) => {
      if (entry.ended || closeTimer) return;
      closeTimer = setTimeout(() => {
        child.kill();
        settleOnce(code, null, [{ code: 'background-processes-stopped', message: 'The command exited but left background processes holding its output open; they were stopped' }]);
      }, deps.closeGraceMs);
    });
  }

  function appendLog(projectId: string, entry: ActiveRun, chunk: string): void {
    if (entry.ended) return;
    const { write, budget } = admitChunk(entry.log, chunk);
    entry.log = budget;
    emit({ type: 'testRunLog', runId: entry.runId, projectId, chunk });
    if (write) writeLog(entry, write);
  }

  /** A failed append is remembered (and reported as a diagnostic) rather than breaking the chain. */
  function writeLog(entry: ActiveRun, text: string): void {
    entry.writes = entry.writes.then(() => deps.runFiles.appendLog(entry.runId, text)).catch((error: Error) => {
      entry.logWriteError ??= error.message;
    });
  }

  async function settleProcess(
    projectId: string, entry: ActiveRun, action: TestActionConfig, exitCode: number | null, spawnError: Error | null, extra: TestRunDiagnostic[],
  ): Promise<void> {
    if (entry.stopRequested) return finalize(projectId, entry, { status: 'stopped', exitCode, diagnostics: extra });
    if (entry.timedOut) {
      return finalize(projectId, entry, {
        status: 'error', exitCode, diagnostics: [{ code: 'timed-out', message: `The run was stopped after ${describeTimeout(deps.runTimeoutMs)} without finishing` }, ...extra],
      });
    }
    if (spawnError) {
      return finalize(projectId, entry, { status: 'error', exitCode, diagnostics: [{ code: 'spawn-failed', message: `Failed to start: ${spawnError.message}` }] });
    }
    const hasCollectors = action.purpose === 'result' && action.collectors.length > 0;
    const collection = hasCollectors ? await collectArtifacts(action.collectors, (p) => deps.readArtifact(entry.artifactDir!, p)) : null;
    const decided = decideStatus({ purpose: action.purpose, exitCode, hasCollectors, collection });
    return finalize(projectId, entry, {
      status: decided.status,
      exitCode,
      result: collection?.result ?? null,
      diagnostics: [...(collection?.diagnostics ?? []), ...decided.diagnostics, ...extra],
    });
  }

  /**
   * The one exit path for every run that got off the queue. Runs once per run and never rejects,
   * so a failure anywhere in it can't leave the queue stuck, start a second run alongside the next
   * one, or crash the daemon: whatever happens, this run's slot is released and the queue moves on.
   */
  async function finalize(projectId: string, entry: ActiveRun, outcome: RunOutcome): Promise<void> {
    if (entry.finalized) return;
    entry.finalized = true;
    entry.ended = true;
    try {
      if (entry.discarded) await discardFiles(entry);
      else await recordOutcome(projectId, entry, outcome);
    } catch (error) {
      console.error(`Test run ${entry.runId} could not be finalized:`, error);
    } finally {
      if (active.get(projectId) === entry) active.delete(projectId);
      entry.resolveDone();
      pumpWaiting();
    }
  }

  /**
   * Closes the log file, writes the result file (before the record flips, so a finished run's
   * result is always readable), removes the artifact directory and saves the verdict. Notifying
   * and pruning come after the verdict is saved and can never change it. The final `testRun`
   * event goes out only once notifying is done: that event is the observable "this run has
   * settled" signal, so a listener must never see it before the Notification it implies exists.
   */
  async function recordOutcome(projectId: string, entry: ActiveRun, outcome: RunOutcome): Promise<void> {
    const diagnostics = [...outcome.diagnostics];
    const tail = closingLog(entry.log);
    if (tail) writeLog(entry, tail);
    entry.logClosed = true;
    await entry.writes;
    if (entry.logWriteError) diagnostics.push({ code: 'log-write-failed', message: `Some output could not be saved: ${entry.logWriteError}` });
    if (outcome.result) {
      await deps.runFiles.writeResult(entry.runId, outcome.result).catch((error: Error) => {
        diagnostics.push({ code: 'internal-error', message: `The full result could not be saved: ${error.message}` });
      });
    }
    await removeArtifacts(entry, diagnostics);

    const completedAt = new Date();
    // Read inside the DB's own queue: a Stop that landed before this keeps the run 'stopped'.
    const finished = await testRunsDb.updateWith(entry.runId, (live) => ({
      status: live.status === 'stopped' ? 'stopped' : outcome.status,
      ...(live.status !== 'stopped' && (outcome.status === 'failed' || outcome.status === 'error') ? { failureUnopened: true as const } : {}),
      exitCode: outcome.exitCode,
      completedAt: live.completedAt ?? completedAt.toISOString(),
      durationMs: live.startedAt ? completedAt.getTime() - Date.parse(live.startedAt) : null,
      outputTruncated: entry.log.dropped > 0,
      summary: outcome.result ? summarizeResult(outcome.result) : null,
      diagnostics,
      artifactDir: null,
    }));
    if (!finished) return;
    await notifyIfNeeded(finished).catch((error) => console.error(`Test run ${entry.runId}: notification failed:`, error));
    emit({ type: 'testRun', run: finished });
    await prune(projectId).catch((error) => console.error(`Test runs for ${projectId}: pruning failed:`, error));
  }

  async function removeArtifacts(entry: ActiveRun, diagnostics: TestRunDiagnostic[]): Promise<void> {
    if (!entry.artifactDir) return;
    const dir = entry.artifactDir;
    await deps.removeArtifactDir(dir).catch((error: Error) => {
      diagnostics.push({ code: 'artifact-cleanup-failed', message: `Could not remove ${dir}: ${error.message}` });
    });
  }

  /** A discarded run's record is already gone; only its files and artifacts are left to remove. */
  async function discardFiles(entry: ActiveRun): Promise<void> {
    await entry.writes;
    await removeArtifacts(entry, []);
    await deps.runFiles.remove(entry.runId);
  }

  /**
   * Fits the existing Notification model: a person who asked for a run hears about a failure, or about a pass that took 10 seconds or more (unless they have its run drawer open). Agent
   * runs (often mid-TDD) don't raise or resolve one.
   *
   * Not part of this milestone's own kind/subject table (see domain/types.ts's `NotificationKind`
   * doc comment) — there's no per-Project-but-not-per-action subject shape in the spec's closed
   * union to key this by the specific suite/action that failed, so it's raised against the whole
   * Project instead (subject `{type:'project'}`, kind `testing.failed`). That's coarser than ideal:
   * two different manual actions failing back to back in the same Project collapse into one
   * Notification describing only the latest, and it resolves on ANY later manual run in that Project
   * succeeding, not specifically a re-run of the one that failed. Acceptable for a producer this
   * milestone's own spec never named.
   */
  async function notifyIfNeeded(run: TestRunRecord): Promise<void> {
    if (run.trigger !== 'manual') return;
    const subject = { type: 'project' as const, projectId: run.projectId };
    if (run.status !== 'failed' && run.status !== 'error') {
      if (run.status === 'passed') {
        await resolveNotifications(subject, ['testing.failed']);
        // Measured from when it began executing (startedAt), not from when it was queued.
        if (ranLongEnough(run.startedAt, Date.parse(run.completedAt ?? '')) && !isRunWatched('test', run.id)) {
          await raiseNotification({
            kind: 'testing.passed',
            subject: { type: 'testRun', projectId: run.projectId, runId: run.id },
            title: `${run.suite.label}: ${run.action.label} passed`,
            description: 'The test run completed successfully',
          });
        }
      }
      return;
    }
    await raiseNotification({
      kind: 'testing.failed',
      subject,
      title: `${run.suite.label}: ${run.action.label} ${run.status === 'failed' ? 'failed' : 'errored'}`,
      description: run.diagnostics[0]?.message ?? (run.exitCode === null ? 'The test run did not complete' : `Exited with code ${run.exitCode}`),
    });
  }

  /** Keeps the newest `retention` finished runs per Project, files included; active runs are never touched. */
  async function prune(projectId: string): Promise<void> {
    const finished = newestFirst(await testRunsDb.find((run) => run.projectId === projectId && !isActive(run)));
    for (const run of finished.slice(deps.retention)) {
      await testRunsDb.delete(run.id);
      await deps.runFiles.remove(run.id).catch(() => undefined);
    }
  }

  // ---- Stop / remove / discard ----

  /**
   * Stops a running run (its process tree is signalled; the queue moves on once it exits). A run
   * that already ended, even if it's still being finalized, is returned as-is: its verdict stands.
   */
  async function stopTestRun(runId: string): Promise<TestRunRecord> {
    const run = await requireRun(runId);
    const entry = active.get(run.projectId);
    if (!entry || entry.runId !== runId) {
      if (run.status === 'queued') throw new TestRunNotRunningError(run);
      return run;
    }
    if (entry.ended) return run;
    entry.stopRequested = true;
    entry.process?.kill();
    const stopped = await testRunsDb.updateWith(runId, (live) => (isActive(live) ? { status: 'stopped', completedAt: new Date().toISOString() } : {}));
    if (stopped) emit({ type: 'testRun', run: stopped });
    return stopped ?? run;
  }

  /**
   * Called before a Project is deleted: drops its queue, stops its running test and waits (bounded)
   * for it to exit so nothing is still running in the directory about to be removed, then deletes
   * every run record and file the Project had.
   */
  async function discardProjectRuns(projectId: string): Promise<void> {
    await withLock(projectId, async () => {
      queues.delete(projectId);
      const entry = active.get(projectId);
      if (entry) {
        entry.discarded = true;
        entry.stopRequested = true;
        if (!entry.ended) entry.process?.kill();
        await Promise.race([entry.done, new Promise((resolve) => setTimeout(resolve, DISCARD_WAIT_MS).unref())]);
      }
      for (const run of await testRunsDb.find((r) => r.projectId === projectId)) {
        await testRunsDb.delete(run.id);
        await deps.runFiles.remove(run.id).catch(() => undefined);
        emit({ type: 'testRunRemoved', runId: run.id, projectId });
      }
    });
  }

  /**
   * Test commands run in their own process groups (so Stop reaches everything they fork), which
   * also means a Ctrl-C to the daemon never reaches them. index.ts calls this on the way out.
   */
  function killActiveProcesses(): void {
    for (const entry of active.values()) if (!entry.ended) entry.process?.kill();
  }

  /** Removes a run that hasn't started yet; it never ran, so it leaves no history behind. */
  async function removeQueuedRun(runId: string): Promise<void> {
    const run = await requireRun(runId);
    await withLock(run.projectId, async () => {
      const queue = queueFor(run.projectId);
      const index = queue.indexOf(runId);
      if (index === -1) throw new TestRunNotQueuedError(run);
      queue.splice(index, 1);
      await testRunsDb.delete(runId);
    });
    emit({ type: 'testRunRemoved', runId, projectId: run.projectId });
  }

  // ---- Restart recovery ----

  /**
   * Called once at daemon startup: any run still queued/running belonged to the previous process.
   * Its in-memory queue is gone and, on a normal shutdown, so are its processes (see
   * killActiveProcesses); after a hard crash one may still be running, but its result can no longer
   * be collected either way. They're closed out as `error` (with an `interrupted` diagnostic)
   * rather than left looking alive, and their artifact directories removed.
   */
  async function recoverInterruptedRuns(): Promise<number> {
    const orphans = await testRunsDb.find(isActive);
    for (const run of orphans) {
      if (run.artifactDir) await deps.removeArtifactDir(run.artifactDir).catch(() => undefined);
      await testRunsDb.update(run.id, {
        status: 'error',
        completedAt: new Date().toISOString(),
        artifactDir: null,
        diagnostics: [...run.diagnostics, { code: 'interrupted', message: `The daemon restarted while this run was ${run.status}; it did not finish` }],
      });
    }
    return orphans.length;
  }

  // ---- Reads ----

  async function requireRun(runId: string): Promise<TestRunRecord> {
    const run = await testRunsDb.get(runId);
    if (!run) throw new TestRunNotFoundError();
    return run;
  }

  /** The record plus its log and full result. A running run's log includes the tail not yet written out. */
  async function getTestRun(runId: string): Promise<TestRunDetail> {
    const run = await requireRun(runId);
    const entry = active.get(run.projectId);
    const live = entry?.runId === run.id ? entry : null;
    if (live) await live.writes;
    const [log, result] = await Promise.all([deps.runFiles.readLog(runId), deps.runFiles.readResult(runId)]);
    return {
      ...run,
      output: live && !live.logClosed ? log + closingLog(live.log) : log,
      outputTruncated: live ? live.log.dropped > 0 : run.outputTruncated,
      result,
    };
  }

  async function listTestRuns(projectId: string, filter: TestRunFilter = {}): Promise<TestRunPage> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;
    const matching = newestFirst(await testRunsDb.find((run) => run.projectId === projectId
      && (filter.suiteId === undefined || run.suite.id === filter.suiteId)
      && (filter.actionId === undefined || run.action.id === filter.actionId)
      && (filter.status === undefined || run.status === filter.status)
      && (!filter.failureUnopened || run.failureUnopened === true)));
    return { runs: matching.slice(offset, offset + limit), total: matching.length, limit, offset };
  }

  /** Records that someone opened a failed run — see commandRunner.ts's `markCommandRunOpened`, which this mirrors. */
  async function markTestRunOpened(runId: string): Promise<TestRunRecord> {
    const run = await requireRun(runId);
    await getProject(run.projectId);
    if (!run.failureUnopened) return run;
    const updated = await testRunsDb.update(runId, { failureUnopened: undefined });
    if (!updated) return run;
    emit({ type: 'testRun', run: updated });
    return updated;
  }

  async function getOverview(projectId: string): Promise<TestingOverview> {
    const project = await getProject(projectId);
    const root = projectAbsolutePath(project);
    const config = await loadTestingConfig(root);
    const runs = await testRunsDb.find((run) => run.projectId === projectId);
    const queueOrder = [active.get(projectId)?.runId, ...(queues.get(projectId) ?? [])];
    const queue = runs.filter(isActive).sort((a, b) => rank(queueOrder, a.id) - rank(queueOrder, b.id));
    if (config.state !== 'valid') return { config, suites: [], queue };

    // Latest results describe the Project's own working tree: an agent's worktree run (often red
    // mid-change) shows up in History and the queue, but never as the suite's current status.
    const primary = runs.filter((run) => run.executionRoot === root);
    const ordered = newestFirst(primary);
    const suites = config.config.suites.map((suite): TestSuiteOverview => ({
      id: suite.id,
      label: suite.label,
      kind: suite.kind,
      enabled: suite.enabled,
      primaryActionId: suite.primaryActionId,
      latestResult: latestResultRun(primary, suite.id),
      actions: suite.actions.map((action) => {
        const ofAction = ordered.filter((run) => run.suite.id === suite.id && run.action.id === action.id);
        return {
          id: action.id,
          label: action.label,
          purpose: action.purpose,
          enabled: action.enabled,
          latestResult: action.purpose === 'result' ? latestResultRun(primary, suite.id, action.id) : null,
          latestRun: ofAction.find((run) => !isActive(run)) ?? null,
          activeRun: ofAction.find(isActive) ?? null,
        };
      }),
    }));
    return { config, suites, queue };
  }

  return {
    enqueueAction,
    enqueueRunAll,
    stopTestRun,
    removeQueuedRun,
    discardProjectRuns,
    killActiveProcesses,
    recoverInterruptedRuns,
    getTestRun,
    listTestRuns,
    markTestRunOpened,
    getOverview,
    onTestEvent,
  };
}

function rank(order: (string | undefined)[], id: string): number {
  const index = order.indexOf(id);
  return index === -1 ? order.length : index;
}

function snapshotAction(action: TestActionConfig): TestRunRecord['action'] {
  const { id, label, purpose, command, workingDirectory, collectors } = action;
  return { id, label, purpose, command, workingDirectory, collectors };
}

export type TestRunner = ReturnType<typeof createTestRunner>;

/** The one instance the daemon runs against — see index.ts / api/router.ts / api/ws.ts. */
export const testRunner = createTestRunner();
