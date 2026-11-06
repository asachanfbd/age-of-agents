import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Clock, ExternalLink, FlaskConical, GitBranch, MoreHorizontal, Play, Square, TriangleAlert, User, Wrench, X,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { parseAnsi } from '../../lib/ansi';
import { serverApi, watchRun } from '../../lib/serverApi';
import type {
  FindingSeverity, NormalizedTestResult, TestingConfigState, TestingOverview, TestingSetupState, TestRun, TestRunDetail,
  TestSuiteOverview,
} from '../../lib/serverApi';
import {
  SETUP_PROPOSAL_STEP_ID, diagnosticsBanner, formatDuration, lastTaskSignature, metricDisplay, resultSections,
  runAllGuard, runHistoryRow, runStaleness, setupHeader, setupStage, sortCasesFailedFirst, sortFindingsBySeverity, statCards,
  suiteCardModel, testRunBadge, testRunsSignature,
} from '../../lib/testingPanel';
import type { RunHistoryRow, SetupStatusLine } from '../../lib/testingPanel';
import { buildRunStages } from '../../lib/workflowRunView';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData, TaskData } from '../../types';
import { SetupProposalDecision } from './SetupProposalDecision';
import { ConfirmDialog } from './TaskDialogs';
import { useErrorScope } from '../useErrorScope';

const EMPTY_RUNS: never[] = [];
const EMPTY_SUITES: TestSuiteOverview[] = [];
const RECENT_RUN_COUNT = 10;

const TONE_STYLES: Record<SetupStatusLine['tone'], string> = {
  info: 'border-border',
  warning: 'border-warning/50 bg-warning/10',
  danger: 'border-destructive/40 bg-destructive/10',
  success: 'border-success/40 bg-success/10',
};

const TONE_BADGES: Record<SetupStatusLine['tone'], 'secondary' | 'warning' | 'soft-destructive' | 'success'> = {
  info: 'secondary',
  warning: 'warning',
  danger: 'soft-destructive',
  success: 'success',
};

const METRIC_STATUS_LABEL: Record<'pass' | 'warn' | 'fail', string> = { pass: 'pass', warn: 'warn', fail: 'fail' };
const METRIC_STATUS_STYLE: Record<'pass' | 'warn' | 'fail', string> = {
  pass: 'text-success-foreground',
  warn: 'text-warning-foreground',
  fail: 'text-destructive',
};

/** Per-browser memory of which completed setup's "Done" line was dismissed — a convenience only, so every read/write tolerates storage being unavailable. */
function dismissedKey(projectId: string): string {
  return `agent-visual-os:testing-setup-dismissed:${projectId}`;
}

function readDismissed(projectId: string): string | null {
  try { return window.localStorage.getItem(dismissedKey(projectId)); } catch { return null; }
}

function writeDismissed(projectId: string, runId: string): void {
  try { window.localStorage.setItem(dismissedKey(projectId), runId); } catch { /* storage unavailable: dismissal lasts this session only */ }
}

interface TestingSnapshot {
  overview: TestingOverview;
  setup: TestingSetupState | null;
  recentRuns: TestRun[];
}

async function loadTestingSnapshot(projectId: string): Promise<TestingSnapshot> {
  const [overview, setup, page] = await Promise.all([
    serverApi.getTestingOverview(projectId),
    serverApi.getTestingSetup(projectId),
    serverApi.listTestRuns(projectId, RECENT_RUN_COUNT),
  ]);
  return { overview, setup, recentRuns: page.runs };
}

/**
 * The Testing tab: the Project's testing setup entry point (set up / reconfigure / repair, or a line
 * — and, at the approval gate, a full inline decision card — linking to the setup Task already under
 * way), then the configured suites' latest results, the run queue, recent runs, and a drawer for one
 * run's log and result. Everything comes from the daemon's normalized testing model; it refreshes
 * whenever one of this Project's Test Runs or its setup run changes on the live feed, or its most
 * recent Task settles (an agent task may have just edited `.docs/testing/config.json`).
 */
export function TestingPanel({ project, onOpenSetupTask }: { project: ProjectData; onOpenSetupTask: (runId: string | null) => void }) {
  const startTestingSetup = useWorldStore((s) => s.startTestingSetup);
  useErrorScope('testing');
  const runsSignature = useWorldStore((s) => testRunsSignature(s.testRunsById, project.id));
  const workflowRuns = useWorldStore((s) => s.workflowRunsByProject[project.id]) ?? EMPTY_RUNS;
  const setupSignature = useMemo(
    () => workflowRuns.filter((run) => run.testingSetup).map((run) => `${run.id}:${run.status}:${run.currentStepId}`).join(','),
    [workflowRuns],
  );
  const taskSignature = useWorldStore((s) => lastTaskSignature(s.tasksById, s.lastTaskIdByProject, project.id));
  const tasksById = useWorldStore((s) => s.tasksById);

  const [overview, setOverview] = useState<TestingOverview | null>(null);
  const [setup, setSetup] = useState<TestingSetupState | null>(null);
  const [recentRuns, setRecentRuns] = useState<TestRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [dismissedRunId, setDismissedRunId] = useState(() => readDismissed(project.id));
  const [drawerRunId, setDrawerRunId] = useState<string | null>(null);
  const runRequest = useWorldStore((s) => s.workspaceTestRunRequest);
  const clearRunRequest = useWorldStore((s) => s.clearWorkspaceTestRunRequest);
  // A footer list row or notification asked for one run's drawer (or just this tab): apply it once.
  useEffect(() => {
    if (!runRequest) return;
    setDrawerRunId(runRequest.runId);
    clearRunRequest();
  }, [runRequest, clearRunRequest]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [queueConfirm, setQueueConfirm] = useState<{ kind: 'stop' | 'remove'; run: TestRun } | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const prevBadgesRef = useRef<Record<string, string> | null>(null);

  const apply = useCallback((loaded: TestingSnapshot) => {
    setOverview(loaded.overview);
    setSetup(loaded.setup);
    setRecentRuns(loaded.recentRuns);
    setError(null);
  }, []);

  const refresh = useCallback(
    () => loadTestingSnapshot(project.id).then(apply, (err: Error) => setError(err.message)),
    [project.id, apply],
  );

  useEffect(() => {
    let cancelled = false;
    loadTestingSnapshot(project.id).then(
      (loaded) => { if (!cancelled) apply(loaded); },
      (err: Error) => { if (!cancelled) setError(err.message); },
    );
    return () => { cancelled = true; };
  }, [project.id, apply, runsSignature, setupSignature, taskSignature]);

  const suites = useMemo(() => overview?.suites ?? EMPTY_SUITES, [overview]);

  // Announces a suite's status change to assistive tech once it's actually known (skips the very
  // first render, which is "nothing changed", just "nothing known yet").
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const suite of suites) next[suite.id] = suiteCardModel(suite).badge.label;
    const prev = prevBadgesRef.current;
    if (prev) {
      const changedId = Object.keys(next).find((id) => prev[id] !== undefined && prev[id] !== next[id]);
      if (changedId) {
        const suite = suites.find((s) => s.id === changedId);
        setLiveMessage(`${suite?.label ?? 'Suite'} is now ${next[changedId]}.`);
      }
    }
    prevBadgesRef.current = next;
  }, [suites]);

  async function act(key: string, action: () => Promise<unknown>) {
    setPendingAction(key);
    try {
      await action();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
    // Stays pending through the refresh too — otherwise the button re-enables against the
    // pre-refresh (stale) suites snapshot for the rest of this round-trip, long enough for a fast
    // second click to fire a second request before the fresh "already active" state lands.
    await refresh();
    setPendingAction(null);
  }

  async function startSetup() {
    setStarting(true);
    const result = await startTestingSetup(project.id);
    setStarting(false);
    if (!result) { setError(useWorldStore.getState().formErrors.testing ?? 'Could not start the testing setup'); return; }
    onOpenSetupTask(result.run?.id ?? null);
  }

  const header = setupHeader(overview?.config ?? null, setup, dismissedRunId);
  const config = overview?.config;
  const runAll = runAllGuard(suites);
  const runAllDisabled = !runAll.enabled || pendingAction === 'run-all';
  const diagnostics = diagnosticsBanner(suites);
  const atProposalGate = Boolean(setup?.active && setup.run && setupStage(setup) === 'awaiting-approval');

  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <p aria-live="polite" className="sr-only">{liveMessage}</p>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight">Testing</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {config?.state === 'valid' ? `${suites.length} suite(s) · ${config.path}` : config?.state === 'invalid' ? "The testing config can't be used until it's fixed." : 'Latest results from the test suites.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {header.cta && header.cta.mode !== 'setup' && (
            <Button type="button" variant={header.cta.mode === 'repair' ? 'default' : 'outline'} size="sm" disabled={starting} onClick={() => void startSetup()}>
              <Wrench aria-hidden="true" /> {starting ? 'Starting…' : header.cta.label}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={runAllDisabled}
            title={runAll.enabled ? undefined : runAll.reason}
            onClick={() => void act('run-all', () => serverApi.runAllTests(project.id))}
          >
            <Play aria-hidden="true" /> {pendingAction === 'run-all' ? 'Queuing…' : 'Run all'}
          </Button>
        </div>
      </div>

      {error && <Alert variant="destructive" role="alert" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert>}

      {atProposalGate && setup?.run ? (
        <SetupApprovalGate runId={setup.run.id} onOpenSetupTask={onOpenSetupTask} />
      ) : header.status ? (
        <SetupStatus
          line={header.status}
          onOpen={() => onOpenSetupTask(header.status!.runId)}
          onDismiss={() => {
            if (!header.status!.runId) return;
            writeDismissed(project.id, header.status!.runId);
            setDismissedRunId(header.status!.runId);
          }}
        />
      ) : null}

      {diagnostics.length > 0 && (
        <Alert variant="destructive" role="alert" className="mt-4">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            <ul className="space-y-1">
              {diagnostics.map((entry, index) => (
                <li key={`${entry.runId}-${index}`}>
                  <span className="font-medium">{entry.suiteLabel}</span>: {entry.message}{' '}
                  <button type="button" className="underline" onClick={() => setDrawerRunId(entry.runId)}>View log</button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {config?.state === 'invalid' && (
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <Badge variant="soft-destructive">{config.issues.length} problem(s) in config.json</Badge>
          <ul className="mt-2 divide-y text-xs">
            {config.issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`} className="py-1.5"><code className="font-mono">{issue.path || '(document)'}</code> · {issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {config?.state === 'absent' && (
        <div className="mt-5 rounded-xl border border-dashed p-6 text-center">
          <FlaskConical className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
          <h4 className="mt-2 text-sm font-semibold">Testing isn't set up for this project</h4>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            An agent looks through the repository read-only and proposes how tests should run and report here. You see every change and its cost, and nothing changes until you approve the proposal.
          </p>
          {header.cta?.mode === 'setup' && (
            <Button type="button" className="mt-4" disabled={starting} onClick={() => void startSetup()}>
              <FlaskConical aria-hidden="true" /> {starting ? 'Starting…' : header.cta.label}
            </Button>
          )}
        </div>
      )}

      {config?.state === 'valid' && suites.length === 0 && (
        <p className="mt-5 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No test suites are configured for this project.</p>
      )}

      {suites.length > 0 && (
        <>
          <StatCards suites={suites} />
          <div className="mt-5 rounded-lg border">
            <h4 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suites</h4>
            <ul>
              {suites.map((suite) => (
                <SuiteRow
                  key={suite.id}
                  suite={suite}
                  pending={pendingAction}
                  tasksById={tasksById}
                  onRun={(actionId) => void act(`${suite.id}:${actionId}`, () => serverApi.runTestAction(project.id, suite.id, actionId))}
                  onOpenRun={setDrawerRunId}
                  onOpenTask={onOpenSetupTask}
                />
              ))}
            </ul>
          </div>
        </>
      )}

      {overview && overview.queue.length > 0 && (
        <div className="mt-5 rounded-lg border">
          <h4 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Queue</h4>
          <ul className="divide-y text-sm">
            {overview.queue.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => setDrawerRunId(run.id)}>
                  <Badge variant={testRunBadge(run).variant}>{testRunBadge(run).label}</Badge>
                  <span className="truncate">{run.suite.label} · {run.action.label} · {run.trigger === 'agent' ? 'agent' : 'you'}</span>
                </button>
                {run.status === 'running' ? (
                  <Button type="button" variant="outline" size="sm" disabled={pendingAction === `stop:${run.id}`} onClick={() => setQueueConfirm({ kind: 'stop', run })}>
                    <Square aria-hidden="true" /> Stop
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" disabled={pendingAction === `remove:${run.id}`} onClick={() => setQueueConfirm({ kind: 'remove', run })}>Cancel</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recentRuns.length > 0 && config && (
        <RunHistoryTable runs={recentRuns} config={config} onOpen={setDrawerRunId} tasksById={tasksById} onOpenTask={onOpenSetupTask} />
      )}

      {queueConfirm && (
        <ConfirmDialog
          title={queueConfirm.kind === 'stop' ? 'Stop this run?' : 'Remove this queued run?'}
          description={
            queueConfirm.kind === 'stop'
              ? 'The process will be sent a stop signal. Output captured so far is kept and the run is marked Stopped.'
              : 'It will be removed from the queue before it starts.'
          }
          confirmLabel={queueConfirm.kind === 'stop' ? 'Stop run' : 'Remove'}
          onCancel={() => setQueueConfirm(null)}
          onConfirm={() => {
            const { kind, run } = queueConfirm;
            setQueueConfirm(null);
            void act(`${kind}:${run.id}`, () => (kind === 'stop' ? serverApi.stopTestRun(run.id) : serverApi.removeQueuedTestRun(run.id)));
          }}
        />
      )}

      {drawerRunId && (
        <TestRunDrawer
          key={drawerRunId}
          runId={drawerRunId}
          config={config ?? null}
          tasksById={tasksById}
          onOpenTask={onOpenSetupTask}
          onClose={() => setDrawerRunId(null)}
          onChanged={refresh}
        />
      )}
    </section>
  );
}

/** The approval gate, shown inline in the tab itself (not only via a link-out): the proposal's latest round summary plus Approve/Send feedback/Reject, same copy and rule as the run detail view's own gate. */
function SetupApprovalGate({ runId, onOpenSetupTask }: { runId: string; onOpenSetupTask: (runId: string | null) => void }) {
  const loadWorkflowRunDetail = useWorldStore((s) => s.loadWorkflowRunDetail);
  const detail = useWorldStore((s) => s.workflowRunDetails[runId]);

  useEffect(() => { void loadWorkflowRunDetail(runId); }, [runId, loadWorkflowRunDetail]);

  const proposalStage = detail ? buildRunStages(detail).find((stage) => stage.id === SETUP_PROPOSAL_STEP_ID) : undefined;
  const latestRound = proposalStage?.rounds.at(-1);
  const round = latestRound?.round ?? 1;

  return (
    <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-4" role="region" aria-label="Testing setup approval">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Badge variant="warning">Needs your approval</Badge>
          <p className="mt-1 text-sm">The setup proposal is ready. Nothing has been changed yet.</p>
        </div>
        <Button type="button" variant="link" size="sm" className="h-auto shrink-0 p-0" onClick={() => onOpenSetupTask(runId)}>Open task →</Button>
      </div>
      <div className="mt-3">
        <SetupProposalDecision runId={runId} round={round} proposalSummary={latestRound?.summary ?? null} />
      </div>
    </div>
  );
}

function SetupStatus({ line, onOpen, onDismiss }: { line: SetupStatusLine; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className={`mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm ${TONE_STYLES[line.tone]}`} role="status">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={TONE_BADGES[line.tone]}>{line.badge}</Badge>
        <span>{line.text}</span>
      </span>
      <span className="flex items-center gap-2">
        {line.prUrl && (
          <a href={line.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary"><ExternalLink className="size-3.5" aria-hidden="true" /> View PR</a>
        )}
        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onOpen}>{line.linkLabel} →</Button>
        {line.dismissible && (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></Button>
        )}
      </span>
    </div>
  );
}

function StatCards({ suites }: { suites: TestSuiteOverview[] }) {
  const cards = statCards(suites);
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-3">
      {cards.map((card) => (
        <div key={card.label} className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
          <p className="text-sm text-muted-foreground">{card.label}</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${card.value === 'Not reported' ? 'text-muted-foreground' : ''}`}>{card.value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{card.note}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Which Task triggered an agent run, as a link into the Tasks tab when that Task's own WorkflowRun id
 * is already known client-side (`tasksById`), else as plain, non-interactive text. Never renders for a
 * manual run (`taskId` null).
 */
function TaskContextLink({ taskId, tasksById, onOpenTask }: { taskId: string | null; tasksById: Record<string, TaskData>; onOpenTask: (runId: string | null) => void }) {
  if (!taskId) return null;
  const workflowRunId = tasksById[taskId]?.workflowRunId;
  if (workflowRunId) {
    return (
      <button type="button" className="underline" onClick={(event) => { event.stopPropagation(); onOpenTask(workflowRunId); }}>
        Task {taskId.slice(0, 8)}
      </button>
    );
  }
  return <span>Task {taskId.slice(0, 8)}</span>;
}

/** One configured suite's row: its latest outcome (or live state), result summary, and which actions it offers. A suite is only ever listed here from the *current* config, so it can never be "stale" — only a kept run in history/detail can be. */
function SuiteRow({ suite, onRun, onOpenRun, onOpenTask, pending, tasksById }: {
  suite: TestSuiteOverview;
  onRun: (actionId: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenTask: (runId: string | null) => void;
  pending: string | null;
  tasksById: Record<string, TaskData>;
}) {
  const model = suiteCardModel(suite);
  const latest = suite.latestResult;
  const shown = suite.actions.find((a) => a.id === suite.primaryActionId)?.activeRun ?? latest;
  const runPending = pending === `${suite.id}:${suite.primaryActionId}`;
  return (
    <li className={`flex flex-wrap items-center gap-3 border-b px-3 py-3 last:border-b-0 ${suite.enabled ? '' : 'opacity-60'}`}>
      <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{suite.kind}</span>
      <div className="min-w-0 flex-1">
        <button type="button" className="text-left disabled:cursor-default" disabled={!shown} onClick={() => shown && onOpenRun(shown.id)}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{suite.label}</span>
            <Badge variant={model.badge.variant}>{model.badge.label}</Badge>
          </span>
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{[model.counts, model.duration].filter(Boolean).join(' · ') || 'No result yet'}</span>
          {latest && (
            <>
              <span className="flex items-center gap-1"><Clock className="size-3" aria-hidden="true" /> {new Date(latest.completedAt ?? latest.startedAt ?? latest.queuedAt).toLocaleString()}</span>
              <span className="flex items-center gap-1">
                {latest.trigger === 'agent' ? <Bot className="size-3" aria-hidden="true" /> : <User className="size-3" aria-hidden="true" />} {latest.trigger === 'agent' ? 'agent' : 'you'}
              </span>
              {model.where && <span className="flex items-center gap-1"><GitBranch className="size-3" aria-hidden="true" /> {model.where}</span>}
              {latest.taskId && <TaskContextLink taskId={latest.taskId} tasksById={tasksById} onOpenTask={onOpenTask} />}
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!suite.enabled ? (
          <span className="text-xs text-muted-foreground">Disabled in config</span>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" disabled={!model.canRun || runPending} onClick={() => onRun(suite.primaryActionId)}>
              <Play aria-hidden="true" /> {runPending ? 'Queuing…' : model.runLabel}
            </Button>
            {(model.resultActions.length > 1 || model.utilityActions.length > 0) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`More ${suite.label} actions`}><MoreHorizontal aria-hidden="true" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Result actions</DropdownMenuLabel>
                  {model.resultActions.map((action) => (
                    <DropdownMenuItem key={action.id} disabled={!action.enabled || pending === `${suite.id}:${action.id}`} onSelect={() => onRun(action.id)}>
                      {action.label}{action.primary ? ' (primary)' : ''}
                    </DropdownMenuItem>
                  ))}
                  {model.utilityActions.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Utility (log only)</DropdownMenuLabel>
                      {model.utilityActions.map((action) => (
                        <DropdownMenuItem key={action.id} disabled={!action.enabled || pending === `${suite.id}:${action.id}`} onSelect={() => onRun(action.id)}>{action.label}</DropdownMenuItem>
                      ))}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** Run history: status, action, time, duration, trigger, Task/branch/commit, and a stale-config warning when a kept run's suite/action no longer exists. Horizontally scrollable so dense columns don't force the popup wider on a narrow screen. */
function RunHistoryTable({ runs, config, onOpen, tasksById, onOpenTask }: {
  runs: TestRun[];
  config: TestingConfigState;
  onOpen: (runId: string) => void;
  tasksById: Record<string, TaskData>;
  onOpenTask: (runId: string | null) => void;
}) {
  const rows: RunHistoryRow[] = runs.map((run) => runHistoryRow(run, config));
  return (
    <div className="mt-5 overflow-x-auto">
      <h4 className="text-sm font-semibold">Recent runs</h4>
      <table className="mt-2 w-full min-w-[640px] text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Suite · action</th>
            <th className="pr-3 font-medium">Status</th>
            <th className="pr-3 font-medium">Result</th>
            <th className="pr-3 font-medium">Started</th>
            <th className="pr-3 font-medium">Duration</th>
            <th className="pr-3 font-medium">Trigger</th>
            <th className="font-medium">Branch / Task</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-accent/40">
              <td className="py-1.5 pr-3">
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onOpen(row.id)}>
                  {row.suiteLabel} · {row.actionLabel}
                </button>
                {row.stale.stale && (
                  <span className="ml-1.5 inline-flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-foreground" title={row.stale.reason ?? undefined}>
                    <TriangleAlert className="size-3" aria-hidden="true" /> stale
                  </span>
                )}
              </td>
              <td className="pr-3"><Badge variant={row.badge.variant}>{row.badge.label}</Badge></td>
              <td className="pr-3 tabular-nums text-muted-foreground">{row.result ?? '—'}</td>
              <td className="pr-3 text-muted-foreground">{row.startedLabel}</td>
              <td className="pr-3 text-muted-foreground">{row.duration ?? '—'}</td>
              <td className="pr-3 text-muted-foreground">
                <span className="flex items-center gap-1">{row.triggerLabel === 'agent' ? <Bot className="size-3" aria-hidden="true" /> : <User className="size-3" aria-hidden="true" />} {row.triggerLabel}</span>
              </td>
              <td className="text-muted-foreground">
                <span className="flex items-center gap-2">
                  {row.context && <code className="text-xs">{row.context}</code>}
                  {row.taskId && <TaskContextLink taskId={row.taskId} tasksById={tasksById} onOpenTask={onOpenTask} />}
                  {!row.context && !row.taskId && '—'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One run's log and normalized result. The log streams live over `/ws` (no polling); the result tab refetches once when the run settles, to pick up the full cases/metrics/findings a status-only event doesn't carry. */
function TestRunDrawer({ runId, config, tasksById, onOpenTask, onClose, onChanged }: {
  runId: string;
  config: TestingConfigState | null;
  tasksById: Record<string, TaskData>;
  onOpenTask: (runId: string | null) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const loadTestRunDetail = useWorldStore((s) => s.loadTestRunDetail);
  const markTestRunOpened = useWorldStore((s) => s.markTestRunOpened);
  const liveRun = useWorldStore((s) => s.testRunsById[runId]);
  const detail = useWorldStore((s) => s.testRunDetailsById[runId]);
  const output = useWorldStore((s) => s.testRunLogsById[runId]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const lastFetchedStatus = useRef<string | null>(null);

  useEffect(() => watchRun('test', runId), [runId]);
  useEffect(() => { void loadTestRunDetail(runId).then((d) => { lastFetchedStatus.current = d?.status ?? null; }); }, [runId, loadTestRunDetail]);

  const liveStatus = liveRun?.status ?? detail?.status;
  useEffect(() => {
    if (!liveStatus || liveStatus === lastFetchedStatus.current) return;
    lastFetchedStatus.current = liveStatus;
    void loadTestRunDetail(runId);
  }, [liveStatus, runId, loadTestRunDetail]);

  const run: TestRunDetail | undefined = detail ? { ...detail, ...liveRun } : undefined;
  // Showing a failed run counts as opening it: its red machine in the village clears.
  const failureUnopened = !!liveRun?.failureUnopened;
  useEffect(() => { if (failureUnopened) void markTestRunOpened(runId); }, [failureUnopened, runId, markTestRunOpened]);
  const cases = sortCasesFailedFirst(run?.result?.cases ?? []);
  const failing = cases.filter((c) => c.outcome === 'failed' || c.outcome === 'error');
  const sections = resultSections(run?.result ?? null);
  const stale = run && config ? runStaleness(run, config) : null;
  const segments = parseAnsi(output ?? '');
  const configMetrics = config?.state === 'valid' ? config.config.suites.find((s) => s.id === run?.suite.id)?.metrics ?? [] : [];

  return (
    <div className="mt-5 rounded-xl border bg-card text-card-foreground shadow-sm" role="region" aria-label="Test run">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="font-medium">{run ? `${run.suite.label} · ${run.action.label}` : 'Loading…'}</p>
          {run && (
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span><code>{run.action.command}</code> · {run.branch ?? 'no branch'}{run.commit ? `@${run.commit.slice(0, 7)}` : ''} · {run.trigger === 'agent' ? 'agent' : 'you'}
              {run.exitCode !== null ? ` · exit code ${run.exitCode}` : ''}{run.durationMs !== null ? ` · ${formatDuration(run.durationMs)}` : ''}</span>
              {run.taskId && <>· <TaskContextLink taskId={run.taskId} tasksById={tasksById} onOpenTask={onOpenTask} /></>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {run && <Badge variant={testRunBadge(run).variant}>{testRunBadge(run).label}</Badge>}
          {run?.status === 'running' && (
            <Button type="button" variant="outline" size="sm" disabled={stopping} onClick={() => setConfirmStop(true)}><Square aria-hidden="true" /> Stop</Button>
          )}
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close run" onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
      </div>
      {error && <Alert variant="destructive" role="alert" className="m-4"><AlertDescription>{error}</AlertDescription></Alert>}
      {stale?.stale && (
        <Alert variant="destructive" role="alert" className="m-4">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{stale.reason} This result is kept for reference; the suite can't be re-run from here until it's reconfigured.</AlertDescription>
        </Alert>
      )}
      {run && (
        <Tabs defaultValue={run.result ? 'result' : 'log'} className="p-4">
          <TabsList>
            <TabsTrigger value="log">Log</TabsTrigger>
            <TabsTrigger value="result">Result</TabsTrigger>
          </TabsList>
          <TabsContent value="log">
            {run.outputTruncated && <p className="mb-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground">The log was cut off at its size limit.</p>}
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">
              {!output ? 'No output yet.' : segments.map((segment, index) => <span key={index} style={segment.style}>{segment.text}</span>)}
            </pre>
          </TabsContent>
          <TabsContent value="result" className="space-y-3 text-sm">
            {run.diagnostics.map((d, index) => (
              <p key={`${d.code}-${index}`} className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">{d.message}</p>
            ))}
            {run.action.purpose === 'utility' && (
              <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">Utility actions keep a log only — they never produce a normalized result or change the suite's latest status.</p>
            )}
            {!run.result ? (
              <p className="text-muted-foreground">{run.status === 'queued' || run.status === 'running' ? 'No result yet — still in progress.' : 'No normalized result for this run.'}</p>
            ) : (
              <>
                {sections.hasCases && (
                  <div>
                    {failing.length > 0 && (
                      <>
                        <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Failed ({failing.length})</h5>
                        <ul className="mt-1 divide-y">
                          {failing.map((c, index) => (
                            <li key={`${c.name}-${index}`} className="py-1.5">
                              <p className="font-medium">{c.group ? `${c.group} › ` : ''}{c.name}</p>
                              {c.message && <p className="font-mono text-xs text-destructive">{c.message}</p>}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {cases.length > failing.length && <p className="text-xs text-muted-foreground">{cases.length - failing.length} other case(s) passed or were skipped.</p>}
                  </div>
                )}
                {sections.hasMetrics && (
                  <div>
                    <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Metrics</h5>
                    <div className="mt-1 overflow-x-auto rounded-md border">
                      <table className="w-full min-w-[420px] text-xs">
                        <thead className="text-left text-muted-foreground">
                          <tr><th className="px-2 py-1">Metric</th><th className="px-2 py-1">Value</th><th className="px-2 py-1">Threshold</th><th className="px-2 py-1">Status</th></tr>
                        </thead>
                        <tbody className="divide-y">
                          {run.result.metrics.map((metric, index) => {
                            const display = metricDisplay(metric, configMetrics);
                            return (
                              <tr key={`${metric.key}-${index}`}>
                                <td className="px-2 py-1">{display.label}</td>
                                <td className="px-2 py-1 tabular-nums">{metric.value}{display.unit ?? ''}</td>
                                <td className="px-2 py-1 text-muted-foreground">{metric.threshold ? `${metric.threshold.operator} ${metric.threshold.value}` : '—'}</td>
                                <td className={`px-2 py-1 font-medium ${metric.status ? METRIC_STATUS_STYLE[metric.status] : ''}`}>{metric.status ? METRIC_STATUS_LABEL[metric.status] : 'reported'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {sections.hasFindings && <FindingsList findings={run.result.findings} />}
                {sections.isEmpty && <p className="text-muted-foreground">This run reported no cases, metrics, or findings.</p>}
              </>
            )}
          </TabsContent>
        </Tabs>
      )}
      {confirmStop && (
        <ConfirmDialog
          title="Stop this run?"
          description="The process will be sent a stop signal. Output captured so far is kept and the run is marked Stopped."
          confirmLabel="Stop run"
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            setStopping(true);
            void serverApi.stopTestRun(runId).then(onChanged, (err: Error) => setError(err.message)).finally(() => setStopping(false));
          }}
        />
      )}
    </div>
  );
}

const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  critical: 'bg-destructive/20 text-destructive',
  high: 'bg-destructive/15 text-destructive',
  medium: 'bg-warning/15 text-warning-foreground',
  low: 'bg-info/15 text-info-foreground',
  info: 'bg-muted text-muted-foreground',
};

/** Security/accessibility findings by severity and location — never counted into the Passed/Failed case totals. */
function FindingsList({ findings }: { findings: NormalizedTestResult['findings'] }) {
  const sorted = sortFindingsBySeverity(findings);
  return (
    <div>
      <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Findings ({sorted.length})</h5>
      <ul className="mt-1 divide-y">
        {sorted.map((finding, index) => (
          <li key={finding.id ?? `${finding.title}-${index}`} className="flex items-start gap-2 py-1.5">
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${SEVERITY_STYLE[finding.severity]}`}>{finding.severity}</span>
            <span className="min-w-0">
              <span className="block">{finding.title}</span>
              {finding.location?.path && <span className="text-xs text-muted-foreground">{finding.location.path}{finding.location.line ? `:${finding.location.line}` : ''}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
