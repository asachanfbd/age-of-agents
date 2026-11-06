import { testRunsDb } from '../db/collections.ts';
import type { NormalizedTestResult, TaskRecord, TestRunRecord } from '../domain/types.ts';
import { getProject, taskWorkingDirectory } from '../projects/projectService.ts';
import { loadTestingConfig } from './config.ts';
import { isActive, TestRunNotFoundError } from './testRunner.ts';
import type { TestRunDetail, TestRunner } from './testRunner.ts';
import { DEFAULT_AGENT_TEST_WAIT_SECONDS, FINDING_SEVERITIES, MAX_AGENT_TEST_WAIT_SECONDS } from './types.ts';

/**
 * What a coding session's testing tools (terminal/testTaskTool.ts) do on the daemon side. A run is
 * queued through the same Test Run engine the Testing tab uses, as an agent run for the calling
 * Task, so it lands in the same history, events and latest results. Callers must already have
 * checked that the Task may run tests (workerManager's `requireTestingSession`).
 *
 * Replies are sized for an agent's context: counts, a capped list of failures and findings, capped
 * diagnostics and the tail of the log, never the whole log.
 */


const MAX_FAILURES = 20;
const MAX_FINDINGS = 10;
const MAX_DIAGNOSTICS = 10;
const MAX_MESSAGE_CHARS = 500;
const TAIL_LINES = 60;
const TAIL_CHARS = 6_000;
/** Run all reports several runs at once, so each failing run gets a shorter tail and a passing one none. */
const BATCH_TAIL_LINES = 25;

export interface AgentTestAction {
  id: string;
  label: string;
  purpose: 'result' | 'utility';
  enabled: boolean;
}

export interface AgentTestSuite {
  id: string;
  label: string;
  kind: string;
  description?: string;
  enabled: boolean;
  primaryActionId: string;
  actions: AgentTestAction[];
}

export interface AgentTestActionList {
  config: { state: 'absent' | 'valid' | 'invalid'; path: string; issues?: { path: string; message: string }[] };
  suites: AgentTestSuite[];
  /** Why nothing can run, when the config is absent or invalid. */
  diagnostic?: string;
}

export interface AgentTestRunReport {
  runId: string;
  status: TestRunRecord['status'];
  /** False while the run is queued or running: call get_test_run again with `runId`. */
  settled: boolean;
  suite: { id: string; label: string };
  action: { id: string; label: string; purpose: string };
  trigger: TestRunRecord['trigger'];
  taskId: string | null;
  branch: string | null;
  commit: string | null;
  cwd: string | null;
  exitCode: number | null;
  durationMs: number | null;
  result: {
    outcome: string;
    counts?: NormalizedTestResult['counts'];
    findingCounts?: Record<string, number>;
    metrics?: { key: string; value: number; unit?: string; status?: string }[];
  } | null;
  failures: { name: string; group?: string; outcome: string; message?: string }[];
  failuresOmitted: number;
  findings: { severity: string; title: string; location?: string }[];
  findingsOmitted: number;
  diagnostics: { code: string; message: string }[];
  outputTail: string;
  /** Output exists beyond `outputTail` (earlier lines, or output the run log itself dropped). */
  outputTruncated: boolean;
}

export interface AgentRunAllReport {
  batchId: string;
  settled: boolean;
  runs: AgentTestRunReport[];
  /** Suites already queued or running for this working tree; their existing runs are reported in `runs`. */
  joined: { suiteId: string; actionId: string; runId: string }[];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}

/** The last `lines` lines of `output`, capped at TAIL_CHARS. */
export function outputTail(output: string, lines: number): { tail: string; truncated: boolean } {
  if (lines <= 0) return { tail: '', truncated: output.length > 0 };
  const allLines = output.replace(/\n$/, '').split('\n');
  let tail = allLines.slice(-lines).join('\n');
  if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
  return { tail, truncated: tail.length < output.replace(/\n$/, '').length };
}

/** A run's compact, agent-facing report — see this module's doc comment for what's kept. */
export function agentRunReport(detail: TestRunDetail, tailLines = TAIL_LINES): AgentTestRunReport {
  const cases = detail.result?.cases ?? [];
  const failed = cases.filter((c) => c.outcome === 'failed' || c.outcome === 'error');
  const findings = [...(detail.result?.findings ?? [])]
    .sort((a, b) => FINDING_SEVERITIES.indexOf(a.severity) - FINDING_SEVERITIES.indexOf(b.severity));
  const { tail, truncated } = outputTail(detail.output, tailLines);
  const summary = detail.summary;
  return {
    runId: detail.id,
    status: detail.status,
    settled: !isActive(detail),
    suite: { id: detail.suite.id, label: detail.suite.label },
    action: { id: detail.action.id, label: detail.action.label, purpose: detail.action.purpose },
    trigger: detail.trigger,
    taskId: detail.taskId,
    branch: detail.branch,
    commit: detail.commit,
    cwd: detail.cwd,
    exitCode: detail.exitCode,
    durationMs: detail.durationMs,
    result: summary
      ? {
        outcome: summary.outcome,
        counts: summary.counts,
        ...(Object.values(summary.findingCounts).some((n) => n > 0) ? { findingCounts: summary.findingCounts } : {}),
        ...(summary.metrics.length
          ? { metrics: summary.metrics.slice(0, MAX_FINDINGS).map(({ key, value, unit, status }) => ({ key, value, unit, status })) }
          : {}),
      }
      : null,
    failures: failed.slice(0, MAX_FAILURES).map((c) => ({
      name: c.name,
      group: c.group,
      outcome: c.outcome,
      message: c.message === undefined ? undefined : truncate(c.message, MAX_MESSAGE_CHARS),
    })),
    failuresOmitted: Math.max(0, failed.length - MAX_FAILURES),
    findings: findings.slice(0, MAX_FINDINGS).map((f) => ({
      severity: f.severity,
      title: truncate(f.title, MAX_MESSAGE_CHARS),
      location: f.location?.path ? `${f.location.path}${f.location.line ? `:${f.location.line}` : ''}` : undefined,
    })),
    findingsOmitted: Math.max(0, findings.length - MAX_FINDINGS),
    diagnostics: detail.diagnostics.slice(0, MAX_DIAGNOSTICS).map((d) => ({ code: d.code, message: truncate(d.message, MAX_MESSAGE_CHARS) })),
    outputTail: tail,
    outputTruncated: truncated || detail.outputTruncated,
  };
}

/** Clamps a requested wait to [0, MAX_AGENT_TEST_WAIT_SECONDS], defaulting when absent; `null` when it isn't a number. */
export function parseWaitSeconds(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return DEFAULT_AGENT_TEST_WAIT_SECONDS;
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return Math.min(MAX_AGENT_TEST_WAIT_SECONDS, Math.max(0, seconds));
}

/**
 * Whose working tree a call runs in: a Task (its own worktree, runs recorded against it), or, with no
 * `id`, a Project's own folder (an Agent terminal session, which is not a Task).
 */
export type TestScope = Pick<TaskRecord, 'projectId'> & Partial<Pick<TaskRecord, 'id' | 'worktreePath'>>;

/**
 * `recordAwaited` notes which runs a Task's call is about to block on, so the daemon can tell the
 * Task ending its turn to wait for them from one waiting on a person (see workerManager's
 * `isTurnEndCoveredByTestRun`). Only calls that wait are recorded.
 */
export function createAgentTesting(testRunner: TestRunner, recordAwaited?: (taskId: string, runIds: string[]) => Promise<void>) {
  async function noteAwaited(task: TestScope, runIds: string[], waitSeconds: number): Promise<void> {
    if (task.id && waitSeconds > 0 && runIds.length) await recordAwaited?.(task.id, runIds);
  }

  /** Resolves once every run has left queued/running (or was removed), or after `waitSeconds`, whichever is first. */
  function waitForSettled(runIds: string[], waitSeconds: number): Promise<void> {
    const pending = new Set(runIds);
    if (!pending.size || waitSeconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      const settle = (runId: string) => {
        pending.delete(runId);
        if (!pending.size) finish();
      };
      const unsubscribe = testRunner.onTestEvent((event) => {
        if (event.type === 'testRun' && !isActive(event.run)) settle(event.run.id);
        if (event.type === 'testRunRemoved') settle(event.runId);
      });
      const timer = setTimeout(finish, waitSeconds * 1000);
      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
      // Subscribed first, so a run that settles between the enqueue and here is still seen.
      void Promise.all([...pending].map(async (id) => {
        const run = await testRunsDb.get(id);
        if (!run || !isActive(run)) settle(id);
      }));
    });
  }

  async function report(runId: string, tailLines?: number): Promise<AgentTestRunReport> {
    return agentRunReport(await testRunner.getTestRun(runId), tailLines);
  }

  /** The config as read from the Task's own working tree, which is where its runs read it too. */
  async function listActions(task: TestScope): Promise<AgentTestActionList> {
    const project = await getProject(task.projectId);
    const state = await loadTestingConfig(taskWorkingDirectory(project, task));
    if (state.state === 'absent') {
      return {
        config: state,
        suites: [],
        diagnostic: `No testing config at ${state.path} in this working tree, so no test suites are registered and there is nothing to run.`,
      };
    }
    if (state.state === 'invalid') {
      return {
        config: { state: 'invalid', path: state.path, issues: state.issues.map(({ path, message }) => ({ path, message })) },
        suites: [],
        diagnostic: `The testing config at ${state.path} is invalid, so nothing can run until it is fixed. See config.issues.`,
      };
    }
    return {
      config: { state: 'valid', path: state.path },
      suites: state.config.suites.map((suite) => ({
        id: suite.id,
        label: suite.label,
        kind: suite.kind,
        description: suite.description,
        enabled: suite.enabled,
        primaryActionId: suite.primaryActionId,
        actions: suite.actions.map(({ id, label, purpose, enabled }) => ({ id, label, purpose, enabled })),
      })),
    };
  }

  /** Queues one action for the Task (joining its copy already queued/running on that tree) and waits up to `waitSeconds` for it. */
  async function runAction(task: TestScope, suiteId: string, actionId: string, waitSeconds: number): Promise<AgentTestRunReport> {
    const run = await testRunner.enqueueAction(task.projectId, suiteId, actionId, { taskId: task.id, joinActive: true });
    await noteAwaited(task, [run.id], waitSeconds);
    await waitForSettled([run.id], waitSeconds);
    return report(run.id);
  }

  /** Every enabled suite's primary action as one batch, reported together once all settle or the wait ends. */
  async function runAll(task: TestScope, waitSeconds: number): Promise<AgentRunAllReport> {
    const batch = await testRunner.enqueueRunAll(task.projectId, { taskId: task.id });
    const runIds = [...batch.runs.map((run) => run.id), ...batch.skipped.map((skipped) => skipped.runId)];
    await noteAwaited(task, runIds, waitSeconds);
    await waitForSettled(runIds, waitSeconds);
    const runs = await Promise.all(runIds.map(async (id) => {
      const detail = await testRunner.getTestRun(id);
      return agentRunReport(detail, detail.status === 'passed' ? 0 : BATCH_TAIL_LINES);
    }));
    return { batchId: batch.batchId, settled: runs.every((run) => run.settled), runs, joined: batch.skipped };
  }

  /** Any run of the Task's own Project, including manual runs and other Tasks' runs; another Project's run is "not found". */
  async function getRun(task: TestScope, runId: string, waitSeconds: number): Promise<AgentTestRunReport> {
    const run = await testRunsDb.get(runId);
    if (!run || run.projectId !== task.projectId) throw new TestRunNotFoundError();
    await noteAwaited(task, [runId], waitSeconds);
    await waitForSettled([runId], waitSeconds);
    return report(runId);
  }

  return { listActions, runAction, runAll, getRun };
}

export type AgentTesting = ReturnType<typeof createAgentTesting>;
