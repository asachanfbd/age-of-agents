import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  BookOpen, CheckCircle2, Circle, Clock, Code2, ExternalLink, FileText, GitCompare, Loader2, Maximize2, Minimize2, MinusCircle, SquareTerminal,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { AutoGrowTextarea } from '../AutoGrowTextarea';
import { CopyButton } from '../CopyButton';
import type { RunFocus } from '../../lib/taskBoard';
import { MarkdownDocument } from '../MarkdownDocument';
import {
  buildRunStages,
  canSendRejection,
  checklistCounts,
  checklistPercent,
  defaultRoundIndex,
  followRoundIndex,
  followRoundMode,
  roundEntries,
  defaultSelectedStageId,
  embeddedHtmlOutput,
  estimateStalenessLabel,
  hasPrCreationError,
  hasProgress,
  hasRejectDraft,
  hasRoundSummary,
  isRejectDraftStale,
  rejectKeyAction,
  roundPanes,
  roundStartMode,
  runActionError,
  runStatusBadge,
  sendApprovalDecision,
  showsSkipReasonLine,
  stageSelectionFor,
  stageSpentMs,
  stepRoundOffset,
  visibleRunActions,
} from '../../lib/workflowRunView';
import type { RoundViewMode, RunStage } from '../../lib/workflowRunView';
import { clearRejectDraft, readRejectDraft, saveRejectDraft } from '../../lib/rejectDraft';
import { hasQuickLookCommands, QUICK_LOOK_VIEW_LABELS, quickLookViewFor } from '../../lib/quickLook';
import type { QuickLookView } from '../../lib/quickLook';
import { evidenceRows, isSetupProposalGate } from '../../lib/testingPanel';
import { formatCompactDuration } from '../../lib/sessionTiming';
import { useNow } from '../../lib/useNow';
import {
  serverApi,
  type StepProgressItem,
  type StepRunOutput,
  type StepRunProgress,
  type StepRunRecord,
  type WorkflowRunRecord,
} from '../../lib/serverApi';
import { useWorldStore } from '../../store/worldStore';
import type { PlanItemData } from '../../types';
import { DetailBackButton, DetailHeader } from './DetailHeader';
import { StepNoteControl } from './StepNoteControl';
import { SetupProposalDecision } from './SetupProposalDecision';
import { FloatingControls } from './FloatingControls';
import { TaskSessionBody } from './TaskDetailsView';
import type { TaskActions } from './useTaskActions';
import { RunStartupSteps } from './RunStartupSteps';
import { WorkflowRunStepper } from './WorkflowRunStepper';
import { QuickLookCommands } from './quick-look/QuickLookCommands';
import { QuickLookPane } from './quick-look/QuickLookPane';
import { useErrorScope } from '../useErrorScope';

const EMPTY_PLAN_ITEMS: PlanItemData[] = [];

/**
 * The run detail view (task 3.012): the shared task details header (with Stop/Resume and the
 * expandable description/actions), the full Stepper, and the selected stage's Summary/Output/Session
 * tabs, with the Approve/Reject/loop/retry actions that apply to it. Opened from `TasksPanel`'s
 * cards via `openRow`; `actions`/`alerts` are that panel's `useTaskActions` and its outcome alerts.
 * `focus` opens it on one step round (Agent Analytics' activity links) in place of the current step.
 * With no stage pinned (`selectedStageId` null) the view follows the run's current stage live; clicking
 * another stage pins it, and clicking the current stage goes back to following.
 */
export function WorkflowRunView({ runId, focus = null, actions, alerts, onBack }: { runId: string; focus?: RunFocus | null; actions: TaskActions; alerts: ReactNode; onBack: () => void }) {
  const loadWorkflowRunDetail = useWorldStore((s) => s.loadWorkflowRunDetail);
  const detail = useWorldStore((s) => s.workflowRunDetails[runId]);
  const planItems = useWorldStore((s) => (detail ? s.planByProject[detail.run.projectId]?.items : undefined)) ?? EMPTY_PLAN_ITEMS;

  const [selectedStageId, setSelectedStageId] = useState<string | null>(focus?.stepId ?? null);

  useEffect(() => {
    void loadWorkflowRunDetail(runId);
  }, [runId, loadWorkflowRunDetail]);

  if (!detail) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2.5 border-b px-4 py-3 sm:px-6">
          <DetailBackButton onBack={onBack} />
          <p className="text-sm italic text-muted-foreground">Loading…</p>
        </header>
      </div>
    );
  }

  const { run } = detail;
  const stages = buildRunStages(detail);
  const activeStageId = selectedStageId ?? defaultSelectedStageId(detail);
  const activeStage = stages.find((stage) => stage.id === activeStageId) ?? stages[0]!;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <DetailHeader
        item={planItems.find((item) => item.id === run.planItemId)}
        run={run}
        status={runStatusBadge(run.status)}
        actions={actions}
        alerts={alerts}
        onBack={onBack}
        links={(
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {run.branch ? <><code className="font-mono text-foreground">{run.branch}</code><CopyButton text={run.branch} label="Copy branch name" className="size-6" /></> : 'Not created yet'}
            </span>
            {run.prUrl && (
              <a href={run.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary">
                <ExternalLink className="size-3" aria-hidden="true" /> View PR
              </a>
            )}
          </p>
        )}
      />

      {run.pendingInspectChanges && <PendingInspectChanges run={run} onResolved={() => void loadWorkflowRunDetail(runId)} />}

      <RunStartupSteps run={run} />

      <WorkflowRunStepper stages={stages} run={run} selectedStageId={activeStage.id} onSelect={(id) => setSelectedStageId(stageSelectionFor(id, defaultSelectedStageId(detail)))} notedStepIds={Object.keys(detail.stepNotes ?? {})} />

      {activeStage.kind === 'step' && (
        <StepNoteControl
          key={activeStage.id}
          planItemId={run.planItemId}
          stepId={activeStage.id}
          latestStatus={activeStage.rounds.at(-1)?.status}
          saved={detail.stepNotes?.[activeStage.id]}
          onSaved={() => void loadWorkflowRunDetail(runId)}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <StageDetail key={activeStage.id} stage={activeStage} run={run} focusRound={focus?.stepId === activeStage.id ? focus.round : null} />
        {run.testingSetup && !activeStage.step?.requiresApproval && (
          <div className="max-h-[35%] shrink-0 overflow-y-auto border-t px-4 py-3 sm:px-6"><SetupEvidence run={run} /></div>
        )}
        <RunActions key={runId} runId={runId} run={run} stage={activeStage} />
      </div>
    </div>
  );
}

function PendingInspectChanges({ run, onResolved }: { run: WorkflowRunRecord; onResolved: () => void }) {
  const pending = run.pendingInspectChanges;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'commit-push' | 'discard') => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await serverApi.resolveStepInspectChanges(run.id, decision); onResolved(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="shrink-0 border-b px-4 py-3 sm:px-6">
      <p className="text-sm">{pending?.hasChanges ? 'The reopened session changed the task branch’s working copy. Keep those edits?' : 'The reopened session ended, but its working copy could not be removed.'}</p>
      <div className="mt-2 flex gap-2">
        {pending?.hasChanges && <Button type="button" size="sm" disabled={busy} onClick={() => void decide('commit-push')}>{busy ? 'Working…' : 'Commit & push'}</Button>}
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decide('discard')}>{pending?.hasChanges ? 'Discard' : 'Retry cleanup'}</Button>
      </div>
      {(error || pending?.error) && <p role="alert" className="mt-2 text-sm text-destructive">{error ?? pending?.error}</p>}
    </div>
  );
}

/** A scrolling region of a stage's detail; everything around it (stepper, round list, mode toggle, actions) stays put. */
const SCROLL_PANE = 'min-h-0 flex-1 overflow-y-auto p-4 sm:p-6';

/** Dispatches to the right per-kind detail panel for the selected stage. */
function StageDetail({ stage, run, focusRound }: { stage: RunStage; run: WorkflowRunRecord; focusRound: number | null }) {
  if (stage.kind === 'complete') return <div className={SCROLL_PANE}><CompleteStageDetail run={run} /></div>;
  return <StepStageDetail stage={stage} run={run} focusRound={focusRound} />;
}

/**
 * One WorkflowStep's selected round: a narrow vertical round list on the left (only with more than one
 * round), and `RoundDetail` for the selected one. When a new round starts while the stage is open, the
 * selection moves to it (`followRoundIndex`) unless the owner pinned an earlier round, by clicking it or
 * by opening on a `focusRound`; clicking the latest round goes back to following. `RoundDetail` is
 * `key`-ed by round id so a newly-selected round starts on its own mode, never one carried over.
 */
function StepStageDetail({ stage, run, focusRound }: { stage: RunStage; run: WorkflowRunRecord; focusRound: number | null }) {
  const roundOffset = stepRoundOffset(run, stage.id);
  const entries = roundEntries(stage, roundOffset);
  const earlierCount = stage.earlierRounds?.length ?? 0;
  const [roundIndex, setRoundIndex] = useState(() => earlierCount + defaultRoundIndex(stage.rounds, focusRound));
  const [manualRound, setManualRound] = useState(focusRound !== null);
  const [seenCount, setSeenCount] = useState(entries.length);
  // Adjusts the selection during render (rather than in an effect) so a new round never shows a stale frame.
  if (seenCount !== entries.length) {
    setSeenCount(entries.length);
    setRoundIndex(followRoundIndex({ prevCount: seenCount, nextCount: entries.length, index: roundIndex, manual: manualRound }));
  }
  const chooseRound = (index: number) => {
    setManualRound(index !== entries.length - 1);
    setRoundIndex(index);
  };
  const selected = entries[roundIndex];

  if (!selected) return <p className="p-4 text-sm italic text-muted-foreground sm:p-6">Not started yet.</p>;

  return (
    <div className="flex min-h-0 flex-1">
      {(entries.length > 1 || roundOffset > 0) && (
        <nav aria-label="Rounds" className="w-28 shrink-0 space-y-1 overflow-y-auto border-r p-2">
          {entries.map(({ round: r, label }, index) => (
            <Button
              key={r.id}
              type="button"
              size="sm"
              variant={index === roundIndex ? 'secondary' : 'ghost'}
              aria-current={index === roundIndex ? 'true' : undefined}
              className="w-full justify-start"
              onClick={() => chooseRound(index)}
            >
              {label}
            </Button>
          ))}
        </nav>
      )}
      <RoundDetail key={selected.round.id} round={selected.round} stage={stage} run={run} earlier={selected.earlier} />
    </div>
  );
}

/**
 * One round's content area: Summary mode (summary and output side by side), Session mode (the CLI
 * session edge to edge), or, for a step with a Code/Diff/Documents Quick look, that live view of the
 * run's working copy. Session mode shows the 40/60 progress-and-session split (task 5.017) whenever the
 * round is still running (always, even before its first report — `RoundProgressPanel`'s placeholder) or
 * — a finished round opened straight on Session because it has no summary content — it has any reported
 * progress to show beside its session; otherwise Session is the bare terminal, exactly as before. Modes
 * are switched by controls floating in the top-right corner: today's Summary ⇄ Session toggle, or a
 * segmented switch when the step has a Quick look view; a Commands step adds its Commands menu beside
 * them. `roundStartMode` decides which mode this round opens on; while it stays open, each change of
 * its status re-derives the mode (`followRoundMode`), so a round that finishes or awaits approval moves
 * to its Summary by itself. Once the owner picks a mode with the controls, it is kept for this round.
 */
function RoundDetail({ round, stage, run, earlier }: { round: StepRunRecord; stage: RunStage; run: WorkflowRunRecord; earlier: boolean }) {
  const [mode, setMode] = useState<RoundViewMode>(() => roundStartMode(round, earlier));
  const [manualMode, setManualMode] = useState(false);
  const [seenStatus, setSeenStatus] = useState(round.status);
  // Adjusts the mode during render (rather than in an effect) so a status change never shows a stale frame.
  if (seenStatus !== round.status) {
    setSeenStatus(round.status);
    setMode(followRoundMode({ prevStatus: seenStatus, round, earlier, current: mode, manual: manualMode }));
  }
  const chooseMode = (next: RoundViewMode) => {
    setManualMode(true);
    setMode(next);
  };
  // An earlier run's round has no live working copy to look at or run commands in.
  const view = earlier ? null : quickLookViewFor(stage.step);
  const withCommands = !earlier && hasQuickLookCommands(stage.step);

  const sessionTaskId = mode === 'session' ? round.taskId : null;
  const showQuickLook = mode === 'quickLook' && view !== null;
  const shownMode: RoundViewMode = sessionTaskId ? 'session' : showQuickLook ? 'quickLook' : 'summary';
  const controls = (
    <>
      {view
        ? <StepViewSwitch mode={shownMode} view={view} hasSession={!!round.taskId} onChange={chooseMode} />
        : round.taskId && <RoundModeToggle mode={shownMode === 'session' ? 'session' : 'summary'} onChange={chooseMode} />}
      {withCommands && <QuickLookCommands run={run} compact={shownMode === 'session'} />}
    </>
  );
  const hasControls = !!(view || withCommands || round.taskId);
  const showSplit = !!sessionTaskId && (round.status === 'running' || hasProgress(round));

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      {sessionTaskId
        ? (showSplit
          ? <RoundProgressSplit round={round} sessionTaskId={sessionTaskId} controls={controls} />
          : <TaskSessionBody key={sessionTaskId} taskId={sessionTaskId} controls={controls} />)
        : <>
          {hasControls && <FloatingControls>{controls}</FloatingControls>}
          {showQuickLook ? <QuickLookPane run={run} view={view} roundNumber={round.round} /> : <RoundSummaryMode round={round} />}
        </>}
    </div>
  );
}

/**
 * The 40/60 split (task 5.017, Part 2): the progress panel (left) beside the live session (right),
 * edge to edge like plain Session mode. A floating expand/collapse control — beside the step's own
 * `controls` in the session's floating cluster — takes the session full width and back; this is purely
 * a width toggle, not a mode change, so it never affects `RoundDetail`'s own Summary ⇄ Session state.
 */
function RoundProgressSplit({ round, sessionTaskId, controls }: { round: StepRunRecord; sessionTaskId: string; controls: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const label = expanded ? 'Show progress' : 'Full-width session';
  const widthToggle = (
    <Button type="button" variant="outline" size="icon-sm" className="size-7 shadow-sm" aria-label={label} title={label} onClick={() => setExpanded((value) => !value)}>
      {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
    </Button>
  );
  const session = <TaskSessionBody key={sessionTaskId} taskId={sessionTaskId} controls={<>{controls}{widthToggle}</>} />;
  if (expanded) return session;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[40%_60%]">
      <RoundProgressPanel round={round} />
      {session}
    </div>
  );
}

/** How often the split's elapsed-time line re-renders while a round is still running. */
const PROGRESS_TICK_MS = 15_000;

/** The split's left column: the checklist, counts, current activity and estimate — see `RoundProgressContent` — or, before the agent's first report, a placeholder. */
function RoundProgressPanel({ round }: { round: StepRunRecord }) {
  const now = useNow(PROGRESS_TICK_MS);
  return (
    <section aria-label="Progress" className="flex min-h-0 flex-col border-r">
      <h4 className="flex h-10 shrink-0 items-center px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase sm:px-6">Progress</h4>
      <div className={PANE_SCROLL}>
        {hasProgress(round)
          ? <RoundProgressContent round={round} progress={round.progress!} elapsedMs={stageSpentMs([round], now)} />
          : <p className="flex h-full items-center justify-center px-4 text-center text-sm italic text-muted-foreground">Waiting for the agent to post its plan…</p>}
      </div>
    </section>
  );
}

/** The populated progress panel: an ended-round note (only once the round has settled), the done/total counts and progress bar, current activity, the estimate with its staleness, and the checklist itself. */
function RoundProgressContent({ round, progress, elapsedMs }: { round: StepRunRecord; progress: StepRunProgress; elapsedMs: number }) {
  const counts = checklistCounts(progress.checklist);
  const percent = checklistPercent(counts);
  const staleness = estimateStalenessLabel(progress.estimatedAt);
  return (
    <div className="space-y-3 pb-2 text-sm">
      {round.status !== 'running' && (
        <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">This is the agent's last reported progress — its session ended before finishing.</p>
      )}
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold">{counts.done} of {counts.total} done{counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ''}</p>
        <p className="shrink-0 font-mono text-xs text-muted-foreground">{formatCompactDuration(elapsedMs, { seconds: true })} elapsed</p>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} /></div>
      {progress.currentActivity && (
        <div className="rounded-md border bg-warning/10 p-2">
          <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Current activity</p>
          <p>{progress.currentActivity}</p>
        </div>
      )}
      {progress.estimate && (
        <p className="flex flex-wrap items-center gap-1.5">
          <Clock className="size-3.5 text-muted-foreground" aria-hidden="true" /> {progress.estimate}
          {staleness && <span className="text-xs text-muted-foreground">· {staleness}</span>}
        </p>
      )}
      {progress.checklist.length > 0 && (
        <ol className="divide-y">
          {progress.checklist.map((item, index) => <ChecklistRow key={index} item={item} />)}
        </ol>
      )}
    </div>
  );
}

const CHECKLIST_STATE_ICON: Record<StepProgressItem['state'], typeof Circle> = { pending: Circle, 'in-progress': Loader2, done: CheckCircle2, skipped: MinusCircle };

/** One checklist row: state icon, the item's text (struck through when skipped), and its optional note. */
function ChecklistRow({ item }: { item: StepProgressItem }) {
  const Icon = CHECKLIST_STATE_ICON[item.state];
  return (
    <li className="flex items-start gap-2 py-2">
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 ${item.state === 'done' ? 'text-success-foreground' : item.state === 'in-progress' ? 'animate-spin text-warning-foreground' : 'text-muted-foreground'}`}
      />
      <div className="min-w-0">
        <p className={item.state === 'skipped' ? 'text-muted-foreground line-through' : item.state === 'in-progress' ? 'font-medium' : ''}>{item.text}</p>
        {item.note && <p className="text-xs text-muted-foreground">{item.note}</p>}
      </div>
    </li>
  );
}

/**
 * The floating Summary ⇄ Session switch, in the content area's top-right `FloatingControls` cluster
 * (in Session mode, beside the step session's Resume/Stop). In Session mode it shrinks to an icon so
 * it covers as little of the terminal as possible; in Summary mode it sits in the columns' label
 * row, above the scrolling content.
 */
function RoundModeToggle({ mode, onChange }: { mode: 'summary' | 'session'; onChange: (mode: RoundViewMode) => void }) {
  const next: RoundViewMode = mode === 'summary' ? 'session' : 'summary';
  const label = next === 'session' ? 'Show session' : 'Show summary';
  const Icon = next === 'session' ? SquareTerminal : FileText;
  return (
    <Button
      type="button"
      variant="outline"
      size={mode === 'session' ? 'icon-sm' : 'sm'}
      className={`shadow-sm ${mode === 'session' ? 'size-7' : 'h-7'}`}
      aria-label={label}
      title={label}
      onClick={() => onChange(next)}
    >
      <Icon aria-hidden="true" />
      {mode === 'summary' && 'Session'}
    </Button>
  );
}

const QUICK_LOOK_ICONS: Record<QuickLookView, typeof FileText> = { code: Code2, diff: GitCompare, documents: BookOpen };

/**
 * The segmented Summary | Session | Code/Diff/Docs switch for a step with a Quick look view, in the
 * same floating corner as `RoundModeToggle`. Session is left out for a round with no session (a
 * skipped step). Over the terminal it shrinks to icons; each segment keeps its name as tooltip and label.
 */
function StepViewSwitch({ mode, view, hasSession, onChange }: { mode: RoundViewMode; view: QuickLookView; hasSession: boolean; onChange: (mode: RoundViewMode) => void }) {
  const compact = mode === 'session';
  const segments: { key: RoundViewMode; label: string; Icon: typeof FileText }[] = [
    { key: 'summary', label: 'Summary', Icon: FileText },
    ...(hasSession ? [{ key: 'session' as const, label: 'Session', Icon: SquareTerminal }] : []),
    { key: 'quickLook', label: QUICK_LOOK_VIEW_LABELS[view], Icon: QUICK_LOOK_ICONS[view] },
  ];
  return (
    <div role="group" aria-label="Step view" className="flex h-7 items-center gap-0.5 rounded-md border bg-background p-0.5 shadow-sm">
      {segments.map(({ key, label, Icon }) => (
        <Button
          key={key}
          type="button"
          variant={mode === key ? 'secondary' : 'ghost'}
          size="sm"
          className={`shadow-none ${compact ? 'size-6 p-0' : 'h-6 px-2'}`}
          aria-pressed={mode === key}
          aria-label={label}
          title={label}
          onClick={() => onChange(key)}
        >
          <Icon aria-hidden="true" />
          {!compact && label}
        </Button>
      ))}
    </div>
  );
}

/** Summary mode: the summary (left 35%) and output (right 65%) columns, each scrolling on its own — or whichever one the round has, full width. */
function RoundSummaryMode({ round }: { round: StepRunRecord }) {
  const panes = roundPanes(round);
  return (
    <div className="flex min-h-0 flex-1">
      {panes.summary && (
        <RoundPane label="Summary" className={panes.output ? 'w-[35%] shrink-0 border-r' : 'flex-1'}>
          <div className={PANE_SCROLL}><RoundSummary round={round} /></div>
        </RoundPane>
      )}
      {panes.output && (
        <RoundPane label="Output" className="flex-1">
          <RoundOutputs key={round.id} outputs={round.outputs} />
        </RoundPane>
      )}
    </div>
  );
}

/** The single scrolling body of a Summary-mode column — the one scrollbar that column shows. */
const PANE_SCROLL = 'min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6';

/** One Summary-mode column: a small fixed label row (tall enough to hold the mode toggle) over its content, which owns its own scrolling. */
function RoundPane({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={`flex min-h-0 min-w-0 flex-col ${className}`}>
      <h4 className="flex h-10 shrink-0 items-center px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase sm:px-6">{label}</h4>
      {children}
    </section>
  );
}

function RoundSummary({ round }: { round: StepRunRecord }) {
  return (
    <div className="space-y-2 text-sm">
      {hasProgress(round) && <FinalProgressDisclosure progress={round.progress!} />}
      {round.verdict && <p><span className="font-medium">Verdict:</span> {round.verdict === 'pass' ? 'Pass' : 'Issues found'}</p>}
      {showsSkipReasonLine(round) && <p><span className="font-medium">Skipped:</span> {round.skippedReason}</p>}
      {round.summary && <MarkdownDocument content={round.summary} className="doc-content" />}
      {round.approval && (
        <div className="rounded-md border bg-muted/40 p-2">
          <p className="font-medium">{round.approval.decision === 'approved' ? 'Approved' : 'Changes requested'}</p>
          {round.approval.comment && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{round.approval.comment}</p>}
        </div>
      )}
      {!hasRoundSummary(round) && <p className="italic text-muted-foreground">No summary yet.</p>}
    </div>
  );
}

/** A finished round's final checklist, collapsed by default — task 5.017's "compact, collapsible Progress section" under the Summary. Reuses `ChecklistRow` for its items; drops the current-activity/estimate lines, which stop meaning anything once the round has settled. */
function FinalProgressDisclosure({ progress }: { progress: StepRunProgress }) {
  const counts = checklistCounts(progress.checklist);
  return (
    <details className="rounded-md border">
      <summary className="flex cursor-pointer items-center gap-2 bg-muted/60 px-3 py-1.5 text-xs font-medium">
        Progress <span className="font-normal text-muted-foreground">· {counts.done} of {counts.total} done{counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ''}</span>
      </summary>
      {progress.checklist.length > 0 && <ol className="divide-y px-3">{progress.checklist.map((item, index) => <ChecklistRow key={index} item={item} />)}</ol>}
    </details>
  );
}

/**
 * A round's outputs — a tab-strip pinned at the top to switch between several, over the selected
 * one's content (rendered by its own `format`), which fills the rest of the column and is its only
 * scroller: markdown scrolls in `PANE_SCROLL`, an HTML output scrolls inside its own full-height iframe.
 * "Full screen" expands the outputs over the browser window (not the OS screen), tabs included.
 */
function RoundOutputs({ outputs }: { outputs: StepRunOutput[] }) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const output = outputs[index]!;
  const isHtml = output.format !== 'markdown';
  return (
    <>
      {(outputs.length > 1 || isHtml) && (
        <OutputTabStrip outputs={outputs} index={index} onSelect={setIndex}>
          {isHtml && (
            <Button type="button" size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Maximize2 className="h-4 w-4" /> Full screen
            </Button>
          )}
        </OutputTabStrip>
      )}
      <OutputContent output={output} />
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          hideClose
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="left-0 top-0 flex h-[calc(100dvh-var(--status-footer-height))] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-none p-0 pt-4 data-[state=closed]:animate-none data-[state=open]:animate-none sm:rounded-none [&>[data-popup-resize-handle]]:hidden"
        >
          <DialogTitle className="sr-only">{output.name}</DialogTitle>
          <OutputTabStrip outputs={outputs} index={index} onSelect={setIndex}>
            <Button type="button" size="sm" variant="outline" onClick={() => setExpanded(false)}>
              <Minimize2 className="h-4 w-4" /> Exit full screen
            </Button>
          </OutputTabStrip>
          <OutputContent output={output} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The outputs' tab-strip (only when there are several), with `children` as trailing controls on the right. */
function OutputTabStrip({ outputs, index, onSelect, children }: { outputs: StepRunOutput[]; index: number; onSelect: (index: number) => void; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-start gap-3 px-4 pb-3 sm:px-6">
      <div className="flex flex-1 flex-wrap gap-1.5" role="tablist" aria-label="Output">
        {outputs.length > 1 && outputs.map((item, i) => (
          <Button key={`${item.name}-${i}`} type="button" size="sm" variant={i === index ? 'default' : 'outline'} onClick={() => onSelect(i)}>
            {item.name}
          </Button>
        ))}
      </div>
      {children}
    </div>
  );
}

/** One output's content, filling the rest of its column: markdown in `PANE_SCROLL`, HTML in a full-height sandboxed iframe. */
function OutputContent({ output }: { output: StepRunOutput }) {
  if (output.format === 'markdown') {
    return <div className={PANE_SCROLL}><MarkdownDocument content={output.content} className="doc-content" /></div>;
  }
  return (
    <div className="min-h-0 flex-1 px-4 pb-4 sm:px-6">
      {/* No `allow-same-origin` — deliberate, so a step's own HTML mockup can't read/manipulate this page. */}
      <iframe title={output.name} srcDoc={embeddedHtmlOutput(output.content)} sandbox="allow-scripts" className="h-full w-full" />
    </div>
  );
}

/** Complete: the stitched completion report, the PR link again, and (only after a failed PR creation) a copy button for the whole report — see `hasPrCreationError`'s doc comment for why it can't isolate just the PR body. */
function CompleteStageDetail({ run }: { run: WorkflowRunRecord }) {
  const showCopy = hasPrCreationError(run.completionReport);
  return (
    <div className="space-y-3">
      {run.completionReport ? <MarkdownDocument content={run.completionReport} className="doc-content" /> : <p className="text-sm italic text-muted-foreground">Not completed yet.</p>}
      <div className="flex flex-wrap items-center gap-3">
        {run.prUrl && (
          <a href={run.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sm text-primary">
            <ExternalLink className="size-3.5" aria-hidden="true" /> View PR
          </a>
        )}
        {showCopy && run.completionReport && (
          <CopyButton text={run.completionReport} label="Copy completion report" variant="outline" size="sm">Copy report</CopyButton>
        )}
      </div>
    </div>
  );
}

const EVIDENCE_STYLES = {
  ok: 'border-success/30 bg-success/10 text-success-foreground',
  problem: 'border-destructive/30 bg-destructive/10 text-destructive',
  pending: 'border-border bg-muted text-muted-foreground',
} as const;

/** A testing setup's validation evidence: the config contract and every enabled suite's primary action, as the daemon last checked them. */
function SetupEvidence({ run }: { run: WorkflowRunRecord }) {
  const rows = evidenceRows(run.testingSetup?.evidence ?? null);
  return (
    <div className="rounded-lg border">
      <h4 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Validation evidence</h4>
      <ul className="divide-y text-sm">
        {rows.map((row) => (
          <li key={row.label} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <code className="text-xs">{row.label}</code>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`rounded-full border px-2 py-0.5 ${EVIDENCE_STYLES[row.state]}`}>{row.state === 'ok' ? 'valid' : row.state}</span>
              {row.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The approval bar (Approve/Reject), loop-exhaustion, and Retry-step — whichever the selected stage/run status make relevant — pinned under the stage detail. */
function RunActions({ runId, run, stage }: { runId: string; run: WorkflowRunRecord; stage: RunStage }) {
  const approveWorkflowRun = useWorldStore((s) => s.approveWorkflowRun);
  const requestChangesWorkflowRun = useWorldStore((s) => s.requestChangesWorkflowRun);
  const decideWorkflowRunLoop = useWorldStore((s) => s.decideWorkflowRunLoop);
  const retryWorkflowStep = useWorldStore((s) => s.retryWorkflowStep);
  useErrorScope('workflowRun');
  /** Only this panel's own actions' failures — a stop/resume failure shows once, under the header (`DetailHeader`'s alerts). */
  const [error, setError] = useState('');
  const [loopComment, setLoopComment] = useState('');
  const [pending, setPending] = useState<'approve' | 'loop' | 'retry' | 'reject' | null>(null);
  const [rejectReason, setRejectReason] = useState(() => readRejectDraft(runId));
  const [rejecting, setRejecting] = useState(() => hasRejectDraft(readRejectDraft(runId)));
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const focusTarget = useRef<'reason' | 'reject' | null>(null);

  useEffect(() => {
    if (!isRejectDraftStale(run.status)) return;
    clearRejectDraft(runId);
    setRejectReason('');
    setRejecting(false);
  }, [runId, run.status]);

  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    (target === 'reason' ? reasonRef : target === 'reject' ? rejectButtonRef : null)?.current?.focus();
  }, [rejecting]);

  const visibility = visibleRunActions(run, stage);
  if (!visibility.approveRequestChanges && !visibility.loopDecision && !visibility.retryStep) return null;

  const lastError = () => useWorldStore.getState().formErrors.workflowRun ?? null;
  const approvalCalls = { approve: (id: string) => approveWorkflowRun(id), requestChanges: requestChangesWorkflowRun };

  async function submit(kind: 'approve' | 'loop' | 'retry' | 'reject', action: () => Promise<boolean>): Promise<string> {
    setPending(kind);
    setError('');
    const message = await runActionError(action, lastError);
    setError(message);
    setPending(null);
    return message;
  }

  function changeRejectReason(reason: string) {
    setRejectReason(reason);
    saveRejectDraft(runId, reason);
  }

  function openRejectReason() {
    focusTarget.current = 'reason';
    setRejecting(true);
  }

  function collapseRejectReason() {
    focusTarget.current = 'reject';
    setRejecting(false);
  }

  async function sendRejection() {
    if (!canSendRejection(rejectReason, pending !== null)) return;
    const message = await submit('reject', () => sendApprovalDecision(runId, rejectReason, approvalCalls));
    if (message) return;
    clearRejectDraft(runId);
    setRejectReason('');
    collapseRejectReason();
  }

  function onRejectKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const action = rejectKeyAction({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing }, { reason: rejectReason, sending: pending !== null });
    if (!action) return;
    event.preventDefault();
    if (action === 'send') void sendRejection();
    else collapseRejectReason();
  }

  return (
    <div className="max-h-[45%] shrink-0 space-y-2 overflow-y-auto border-t bg-card px-4 py-2 text-card-foreground sm:px-6">
      {error && (
        <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
      )}

      {visibility.approveRequestChanges && (
        isSetupProposalGate(run, stage.step)
          ? <SetupProposalDecision runId={runId} round={stage.rounds.at(-1)?.round ?? 1} />
          : <div className="space-y-2">
            {rejecting && (
              <div className="space-y-1">
                <label htmlFor="run-reject-reason" className="text-xs font-medium text-muted-foreground">Rejection reason</label>
                <AutoGrowTextarea
                  ref={reasonRef}
                  id="run-reject-reason"
                  value={rejectReason}
                  onChange={(event) => changeRejectReason(event.target.value)}
                  onKeyDown={onRejectKeyDown}
                  placeholder="Reason (required)"
                  disabled={pending === 'reject'}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="truncate text-sm text-muted-foreground">Waiting for your approval</p>
              <div className="flex shrink-0 flex-wrap gap-2">
                {rejecting ? (
                  <>
                    <Button type="button" size="sm" disabled={!canSendRejection(rejectReason, pending !== null)} onClick={() => void sendRejection()}>
                      {pending === 'reject' ? 'Sending…' : 'Send rejection'}
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={collapseRejectReason}>Cancel</Button>
                  </>
                ) : (
                  <Button ref={rejectButtonRef} type="button" variant="outline" size="sm" disabled={pending !== null} onClick={openRejectReason}>Reject</Button>
                )}
                <Button type="button" size="sm" disabled={pending !== null} onClick={() => void submit('approve', () => sendApprovalDecision(runId, null, approvalCalls))}>
                  {pending === 'approve' ? 'Approving…' : 'Approve'}
                </Button>
              </div>
            </div>
          </div>
      )}

      {visibility.loopDecision && (
        <div className="space-y-2">
          <label htmlFor="run-loop-comment" className="text-sm font-medium">This step's review loop ran out of rounds</label>
          <AutoGrowTextarea id="run-loop-comment" value={loopComment} onChange={(event) => setLoopComment(event.target.value)} placeholder="Optional comment" minLines={2} />
          <div className="flex justify-end gap-2">
            {/* A testing setup can only complete with validation evidence, so it has no "continue anyway". */}
            {!run.testingSetup && (
              <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => void submit('loop', () => decideWorkflowRunLoop(runId, 'continue', loopComment.trim() || undefined))}>
                {pending === 'loop' ? 'Submitting…' : 'Continue anyway'}
              </Button>
            )}
            <Button type="button" size="sm" disabled={pending !== null} onClick={() => void submit('loop', () => decideWorkflowRunLoop(runId, 'another-round', loopComment.trim() || undefined))}>
              {pending === 'loop' ? 'Submitting…' : 'Run another round'}
            </Button>
          </div>
        </div>
      )}

      {visibility.retryStep && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">This run needs attention — retry the step that stopped.</p>
          <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => void submit('retry', () => retryWorkflowStep(runId))}>
            {pending === 'retry' ? 'Retrying…' : 'Retry step'}
          </Button>
        </div>
      )}
    </div>
  );
}
