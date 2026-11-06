import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Archive, ArchiveRestore, ChevronDown, ChevronUp, CircleCheck, Pencil, Play, Square, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CopyButton } from '../CopyButton';
import { MessageList } from '../chat/MessageList';
import { TranscriptSegmentList } from '../chat/TranscriptSegmentList';
import { TaskTerminal } from '../TaskTerminal';
import { canResumeSession, completesViaSession, firstLine, planningSessionName, planningSessionTitle, taskDescriptionText, workerLabel } from '../../lib/projectTasks';
import { serverApi } from '../../lib/serverApi';
import { useSessionTaskPanelState } from './useSessionTaskPanelState';
import { reopenStepSession, stepSessionAction, stopStepSession, type TerminalSessionState } from '../../lib/stepSessionReopen';
import { DetailBackButton, DetailLabel, DetailRow, HeaderIconButton, TITLE_INDENT } from './DetailHeader';
import { FloatingControls } from './FloatingControls';
import { PlanningTaskPanel } from './PlanningTaskPanel';
import type { SessionTaskHandlers } from './PlanningTaskPanel';
import { ConfirmDialog } from './TaskDialogs';
import type { TaskActions } from './useTaskActions';
import { formatSessionDuration, formatSessionTimespan, formatSessionTokensCompact } from '../../lib/sessionTiming';
import { groupTranscriptSegments } from '../../lib/taskTranscript';
import { DEFAULT_TASK_PANEL_ARRANGEMENT, sessionHistoryView, sessionPanelWording, taskPanelLayout } from '../../lib/planningTaskPanel';
import { BUG_REPORT_LABEL, PLAN_AND_BUGS_LABEL, bugReportStatusLabel, planAndBugsStatusLabel, sessionKindOf, type SessionKind } from '../../lib/bugs';
import { DeferredSessionForm } from './DeferredSessionForm';
import type { TaskPanelSwap } from '../../lib/planningTaskPanel';
import { useWideViewport } from '../../lib/useWideViewport';
import { useWorldStore } from '../../store/worldStore';
import type { TaskData } from '../../types';

function terminalRuntimePresentation(task: TaskData): { label: string; variant: 'secondary' | 'warning' | 'success' | 'soft-destructive' } | null {
  const status = task.runtimeStatus;
  if (!status) return null;
  if (status === 'starting') return { label: 'Starting', variant: 'secondary' };
  if (status === 'running') return { label: 'Running', variant: 'success' };
  if (status === 'waiting_input') return { label: 'Waiting for input', variant: 'warning' };
  if (status === 'completed') return { label: 'Completed', variant: 'success' };
  if (status === 'stopped') return { label: 'Stopped', variant: 'secondary' };
  if (status === 'disconnected') return { label: 'Disconnected', variant: 'warning' };
  return { label: 'Failed', variant: 'soft-destructive' };
}

/**
 * A Task's settled end for the session-timing summary: `completedAt` once it's actually set (only
 * `'done'` gets one — see server/src/worker/workerManager.ts's settleDone), `updatedAt` as the next
 * best proxy for when a `'blocked'`/`'failed'`/`'stopped'` Task ended, or null while still `'developing'` so
 * `formatSessionTimespan`/`formatSessionDuration` read it as open-ended ("now"/"so far").
 */
function sessionEnd(task: TaskData): string | null {
  return task.status === 'developing' ? null : (task.completedAt ?? task.updatedAt);
}

/** The session-timing + token summary segments shown under a session's title. */
function sessionSummaryParts(task: TaskData): string[] {
  const end = sessionEnd(task);
  const parts = [formatSessionTimespan(task.createdAt, end), formatSessionDuration(task.createdAt, end)];
  const tokens = formatSessionTokensCompact(task.tokenUsage);
  if (tokens) parts.push(tokens);
  return parts;
}

/**
 * Earlier linked Tasks' turns (the follow-up chain's history) above the current Task's own thread —
 * rendered through the same `groupTranscriptSegments` + `TranscriptSegmentList` path `TaskDetailsView`
 * uses for its own turns, so the whole chain reads as one uniform conversation: same bubble styling,
 * same `CHAT_LABEL` author labels, same interleaved `AgentEvents` tool-activity blocks, no seam
 * between "past" and "current".
 */
function PastSessionTurns({ ids }: { ids: string[] }) {
  const transcripts = useWorldStore(s => s.transcriptsByTask);
  const loadTranscript = useWorldStore(s => s.loadTranscript);
  const key = ids.join(',');
  useEffect(() => { for (const id of key.split(',').filter(Boolean)) void loadTranscript(id); }, [key, loadTranscript]);
  return <>{ids.map(id => <TranscriptSegmentList key={id} keyPrefix={id} segments={groupTranscriptSegments(transcripts[id] ?? [])} />)}</>;
}

/**
 * A workflow step session's Resume/Stop control, in the floating top-right cluster beside whatever
 * `controls` the caller adds (the run view's Summary ⇄ Session toggle). Resume reopens the settled
 * step's own CLI conversation in the same terminal, to scroll back through it and chat; Stop ends
 * that reopened session, after which Resume returns. Neither ever changes the run. A refusal shows
 * under the buttons while its action is still on offer; the worktree-fallback note while the
 * reopened session it describes is live.
 */
function StepSessionControls({ task, state, controls, onReopened }: {
  task: TaskData;
  state: TerminalSessionState;
  controls?: ReactNode;
  onReopened: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const startBusy = () => { if (busyRef.current) return false; busyRef.current = true; setBusy(true); return true; };
  const finishBusy = () => { busyRef.current = false; setBusy(false); };
  const [choice, setChoice] = useState<{ permissionsAvailable: boolean; reason?: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean; action: 'resume' | 'stop' } | null>(null);
  const action = stepSessionAction(task, state);
  const shownMessage = message && message.action === action ? message : null;
  if (!action && !controls) return null;

  const openSession = async (mode?: 'permissions' | 'read-only') => {
    const outcome = await reopenStepSession(task.id, serverApi.reopenStepSession, mode);
    finishBusy();
    if (!outcome.ok) { setMessage({ text: outcome.error, failed: true, action: 'resume' }); return; }
    setChoice(null);
    if (outcome.note) setMessage({ text: outcome.note, failed: false, action: 'stop' });
    onReopened();
  };
  const run = async () => {
    if (!action) return;
    if (!startBusy()) return;
    setMessage(null);
    if (action === 'resume') {
      try {
        const options = await serverApi.stepReopenOptions(task.id);
        if (options.choiceRequired) { setChoice(options); finishBusy(); return; }
        await openSession();
      } catch (error) { finishBusy(); setMessage({ text: (error as Error).message, failed: true, action }); }
      return;
    }
    const outcome = await stopStepSession(task.id, serverApi.closeStepSession);
    finishBusy();
    if (!outcome.ok) { setMessage({ text: outcome.error, failed: true, action }); return; }
    if (outcome.note) setMessage({ text: outcome.note, failed: false, action: 'stop' });
  };

  const below = shownMessage && (
    <p role={shownMessage.failed ? 'alert' : 'status'} className={`rounded px-2 py-1 text-right text-[11px] shadow-sm ${shownMessage.failed ? 'bg-destructive text-destructive-foreground' : 'bg-muted-foreground text-muted-foreground'}`}>
      {shownMessage.text}
    </p>
  );
  const resume = action === 'resume';
  return (
    <FloatingControls below={below}>
      <Dialog open={!!choice} onOpenChange={(open) => { if (!open && !busy) setChoice(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resume session</DialogTitle>
            <DialogDescription>The task branch may already be merged. Choose whether this completed step can edit its working copy.</DialogDescription>
          </DialogHeader>
          {choice?.reason && <p role="status" className="text-sm text-muted-foreground">{choice.reason}</p>}
          {message?.failed && <p role="alert" className="text-sm text-destructive">{message.text}</p>}
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setChoice(null)}>Cancel</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => { if (startBusy()) void openSession('read-only'); }}>Read-only</Button>
            {choice?.permissionsAvailable && <Button type="button" disabled={busy} onClick={() => { if (startBusy()) void openSession('permissions'); }}>With permissions</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {action && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shadow-sm"
          disabled={busy}
          onClick={() => void run()}
          title={resume ? "Reopen this step's CLI session to look back through it and chat — the run is not changed" : 'End this reopened session — the run is not changed'}
        >
          {resume ? <Play aria-hidden="true" /> : <Square aria-hidden="true" />}
          {busy ? (resume ? 'Resuming…' : 'Stopping…') : (resume ? 'Resume session' : 'Stop session')}
        </Button>
      )}
      {controls}
    </FloatingControls>
  );
}

/**
 * A Task's session itself — the embedded CLI terminal, or the chat transcript for a non-terminal
 * Task — with its unreviewed failure notice, and nothing around it. `TaskDetailsView` frames it with
 * its header and reply footer; the run view's Session tab shows it bare (the run's own header already
 * carries the task's name, description and Stop/Resume).
 */
export function TaskSessionBody({ taskId, historyIds = [], controls }: { taskId: string; historyIds?: string[]; controls?: ReactNode }) {
  const task = useWorldStore((s) => s.tasksById[taskId]);
  const turns = useWorldStore((s) => s.transcriptsByTask[taskId]);
  const loadTranscript = useWorldStore((s) => s.loadTranscript);
  const taskReviewed = useWorldStore((s) => !!s.reviewedTaskIds[taskId]);
  const reviewTask = useWorldStore((s) => s.reviewTask);
  const markSubjectRead = useWorldStore((s) => s.markSubjectRead);
  const [sessionState, setSessionState] = useState<TerminalSessionState>('unknown');

  useEffect(() => {
    if (task?.executionMode !== 'terminal') void loadTranscript(taskId);
  }, [taskId, task?.executionMode, loadTranscript]);

  // Showing a task's session — however the user got here, not just via a notification — counts as
  // reviewing its conversation. `markSubjectRead` itself only calls the server when the store
  // actually holds a matching unread Notification.
  const taskProjectId = task?.projectId;
  const taskConversationId = task?.conversationId ?? taskId;
  useEffect(() => {
    if (!taskProjectId) return;
    void markSubjectRead({ type: 'task', projectId: taskProjectId, conversationId: taskConversationId, taskId });
  }, [taskId, taskProjectId, taskConversationId, markSubjectRead]);

  const segments = useMemo(() => groupTranscriptSegments(turns ?? []), [turns]);

  // Outside a step's live terminal only the caller's own controls float (a terminal adds Resume/Stop).
  const floating = controls ? <FloatingControls>{controls}</FloatingControls> : null;
  if (!task) return <>{floating}<p className="p-5 text-sm italic text-muted-foreground">Loading…</p></>;

  const failure = task.failureReason && !taskReviewed ? (
    <Alert variant="destructive" role="alert" className={`flex items-center justify-between gap-3 pr-3 ${task.executionMode === 'terminal' ? 'rounded-none border-x-0 border-t-0' : ''}`}>
      <AlertDescription>{task.failureReason}</AlertDescription>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => reviewTask(task.id)} aria-label="Dismiss task error" title="Dismiss">
        <X aria-hidden="true" />
      </Button>
    </Alert>
  ) : null;

  if (task.executionMode === 'terminal') {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {failure}
        <TaskTerminal taskId={taskId} onSessionState={setSessionState} />
        <StepSessionControls task={task} state={sessionState} controls={controls} onReopened={() => setSessionState('unknown')} />
      </div>
    );
  }

  return (
    /* Only the conversation scrolls; whatever frames it stays fixed. */
    <>
    {floating}
    <MessageList active>
      <p className="text-xs text-muted-foreground">Mode: {task.autonomy === 'auto' ? 'Auto (no approval prompts)' : 'Approval (asked before tool use)'}</p>
      {task.branch && <p className="flex items-center gap-1 text-xs text-muted-foreground"><span>Task branch: {task.branch}</span><CopyButton text={task.branch} label="Copy branch name" className="size-6" /></p>}
      {failure}
      <PastSessionTurns ids={historyIds} />
      <TranscriptSegmentList keyPrefix={taskId} segments={segments} />
    </MessageList>
    </>
  );
}

/**
 * A Task's session view (a planning session's, a pre-workflow Task's), laid out like the Tasks tab's
 * task detail (`DetailHeader`): a fixed `SessionHeader`, then only the session itself — no footer. Stop
 * (while live) or Resume (once paused) floats over the session's top-right corner (`SessionRunButton`).
 * `actions`/`alerts` are the panel's `useTaskActions` and its outcome alerts.
 *
 * A planning session given `sessionTasks` (the Tasks tab) shows the tasks it created in a
 * `PlanningTaskPanel` on the right (30% wide, or 70% once the swap control is used), while the viewport is wide enough for it; otherwise the
 * `PlanningHistory` strip sits above the session instead. The session keeps its place in the tree
 * either way, so crossing the breakpoint never remounts its CLI.
 */
export function TaskDetailsView({
  taskId,
  historyIds = [],
  actions,
  alerts,
  onBack,
  sessionTasks,
  taskPanelSwap,
}: {
  taskId: string;
  historyIds?: string[];
  actions: TaskActions;
  alerts: ReactNode;
  onBack: () => void;
  sessionTasks?: SessionTaskHandlers;
  /** The width swap held by the project popup, so it outlives this view; absent without `sessionTasks`. */
  taskPanelSwap?: TaskPanelSwap;
}) {
  const task = useWorldStore((s) => s.tasksById[taskId]);
  const wideViewport = useWideViewport();
  const taskPanelState = useSessionTaskPanelState();
  const planning = task?.kind === 'plan';
  const showTaskPanel = planning && wideViewport && !!sessionTasks && !!taskPanelSwap;
  const layout = taskPanelLayout(taskPanelSwap?.arrangement ?? DEFAULT_TASK_PANEL_ARRANGEMENT);
  const active = task?.status === 'developing' || task?.status === 'blocked';
  const controls = task && (active || canResumeSession(task))
    ? <SessionRunButton key={active ? 'stop' : 'resume'} taskId={task.id} stop={active} actions={actions} />
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {task ? (
        <SessionHeader task={task} historyIds={historyIds} actions={actions} alerts={alerts} onBack={onBack} />
      ) : (
        <header className="shrink-0 border-b px-4 py-3 sm:px-6"><DetailBackButton onBack={onBack} /></header>
      )}
      {planning && !showTaskPanel && <PlanningHistory task={task} />}
      <div className="flex min-h-0 flex-1">
        {/* Positioned, so the floating Stop/Resume stays over the session and never over the task panel. */}
        <div className={`relative flex min-h-0 min-w-0 ${layout.cliClass} flex-col`}>
          {/* A session created without a coding agent has no CLI to show: its description and agent picker stand in for it. */}
          {task?.cliNotStarted ? <DeferredSessionForm key={task.id} task={task} actions={actions} /> : <TaskSessionBody taskId={taskId} historyIds={historyIds} controls={controls} />}
        </div>
        {showTaskPanel && (
          <PlanningTaskPanel task={task} state={taskPanelState} handlers={sessionTasks} swap={taskPanelSwap} />
        )}
      </div>
    </div>
  );
}

/** The narrow-viewport strip above a session: a planning conversation's tasks, or a bug report session's bugs, by the same history categories. */
function PlanningHistory({ task }: { task: TaskData }) {
  const items = useWorldStore((state) => state.planByProject[task.projectId]?.items);
  const kind = sessionKindOf(task);
  const { history, countsLabel: counts } = sessionHistoryView({ items: items ?? [], sessionNumber: task.planningSessionNumber ?? null, createdTaskCount: task.planningCreatedTaskCount ?? 0, kind });
  const heading = sessionPanelWording(kind).historyHeading;
  return (
    <section aria-label={heading} className="shrink-0 border-b bg-info/10 px-4 py-2 text-xs sm:px-6">
      <p className="font-medium text-info-foreground">{heading} · {counts}</p>
      {history.ready.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          {history.ready.map((item) => <li key={item.id}>{item.title}</li>)}
        </ul>
      )}
    </section>
  );
}

/**
 * Stop while the session's CLI is live, Resume once it's paused — floated over the CLI panel's top-right
 * corner. Resume reopens it as its next linked Task and lands there; failures show under the header.
 * Keyed by mode by the caller, so a finished Stop's busy state doesn't leak into Resume.
 */
function SessionRunButton({ taskId, stop, actions }: { taskId: string; stop: boolean; actions: TaskActions }) {
  const [busy, setBusy] = useState(false);

  async function act() {
    setBusy(true);
    const ok = await (stop ? actions.stopSession(taskId) : actions.resumeSession(taskId));
    // A Stop stays busy until the CLI exits and the session settles (this button then remounts as Resume).
    if (!ok || !stop) setBusy(false);
  }

  return (
    <Button type="button" variant={stop ? 'destructive' : 'default'} size="sm" className="h-7 shadow-sm" disabled={busy} onClick={() => void act()}>
      {stop ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
      {stop ? (busy ? 'Stopping…' : 'Stop session') : (busy ? 'Resuming…' : 'Resume session')}
    </Button>
  );
}

/** Mirrors the daemon's TITLE_MAX_LENGTH (server/src/projects/planItemTitler.ts). */
const SESSION_TITLE_MAX_LENGTH = 80;

/** A planning session's name, in place of its title while it's being edited — Enter saves, Escape cancels. */
function SessionTitleForm({ name, onSave, onCancel }: { name: string; onSave: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(name);
  const trimmed = title.trim();
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSave(trimmed);
      }}
    >
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}
        maxLength={SESSION_TITLE_MAX_LENGTH}
        aria-label="Session title"
        className="h-8"
        autoFocus
      />
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
      <Button type="submit" size="sm" disabled={!trimmed}>Save</Button>
    </form>
  );
}

/** A planning-style session's status badge: "Planning" for a conversation, the words of `planAndBugsStatusLabel` or `bugReportStatusLabel` for the bug-filing kinds, "Needs you" while any waits. */
function planningRuntime(task: TaskData, kind: SessionKind): { label: string; variant: 'secondary' | 'warning' | 'success' } | null {
  const live: 'running' | 'blocked' | 'idle' = task.runtimeStatus === 'waiting_input' ? 'blocked' : task.status === 'developing' ? 'running' : 'idle';
  const status = { live, cliNotStarted: !!task.cliNotStarted };
  const label = kind === 'plan-and-bugs' ? planAndBugsStatusLabel(status) : kind === 'bug-report' ? bugReportStatusLabel(status) : live === 'blocked' ? 'Needs you' : live === 'running' ? 'Planning' : null;
  if (!label) return null;
  return { label, variant: label === 'Needs you' ? 'warning' : label === 'CLI not started' ? 'secondary' : 'success' };
}

/**
 * Top row: Back, the session's title (a planning session's generated one, editable in place), the CLI's live status,
 * and the chevron that expands the rest (`SessionMore`, collapsed
 * by default). Second row: when it ran, time spent, tokens and the coding agent. The action alerts
 * sit right under it.
 */
function SessionHeader({ task, historyIds, actions, alerts, onBack }: {
  task: TaskData;
  historyIds: string[];
  actions: TaskActions;
  alerts: ReactNode;
  onBack: () => void;
}) {
  const tasksById = useWorldStore((s) => s.tasksById);
  const executors = useWorldStore((s) => s.executors);
  const planItem = useWorldStore((s) => (task.planItemId ? s.planByProject[task.projectId]?.items.find((item) => item.id === task.planItemId) : undefined));
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);

  const planning = task.kind === 'plan';
  const chain = [task, ...historyIds.map((id) => tasksById[id]).filter((earlier): earlier is TaskData => !!earlier)];
  const title = planning ? planningSessionTitle(chain) : firstLine(task.description);
  const kind = sessionKindOf(task);
  const runtime = planning ? planningRuntime(task, kind) : task.executionMode === 'terminal' ? terminalRuntimePresentation(task) : null;
  const facts = sessionSummaryParts(task).concat(workerLabel(executors, task.executorId));

  async function rename(title: string) {
    if (await actions.renameSession(task.id, title)) setEditingTitle(false);
  }

  return (
    <header className="shrink-0 border-b">
      <div className="flex flex-col gap-1 px-4 py-3 sm:px-6">
        <div className="flex items-start gap-2.5">
          <DetailBackButton onBack={onBack} label="Back to tasks" />
          {editingTitle ? (
            <SessionTitleForm name={planningSessionName(chain)} onSave={(next) => void rename(next)} onCancel={() => setEditingTitle(false)} />
          ) : (
            <h3 className="min-w-0 flex-1 pt-1.5 text-sm font-semibold leading-snug">{title}</h3>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {kind !== 'planning' && <Badge variant="secondary">{kind === 'plan-and-bugs' ? PLAN_AND_BUGS_LABEL : BUG_REPORT_LABEL}</Badge>}
            {runtime && <Badge variant={runtime.variant} title={task.runtimeWaitingReason ?? runtime.label}>{runtime.label}</Badge>}
            <HeaderIconButton label={expanded ? 'Hide session details' : 'Show session details'} icon={expanded ? ChevronUp : ChevronDown} expanded={expanded} onClick={() => setExpanded(!expanded)} />
          </div>
        </div>
        <p className="truncate pl-10.5 text-xs text-muted-foreground">{facts.join(' · ')}</p>
      </div>
      {expanded && (
        <SessionMore
          task={task}
          description={taskDescriptionText(task, planItem)}
          actions={actions}
          onEditTitle={planning && !editingTitle ? () => setEditingTitle(true) : undefined}
          onBack={onBack}
        />
      )}
      <div className="empty:hidden">{alerts}</div>
    </header>
  );
}

/**
 * The header's expanded section, on the title's column like `DetailHeader`'s: the session id, the
 * description (copy on its label's row, in the one tinted scroll box), then Edit title (a planning
 * session's, via `onEditTitle`) / Stop / Mark complete / Archive / Delete under a divider. A live session can only be stopped; Delete asks first.
 */
function SessionMore({ task, description, actions, onEditTitle, onBack }: {
  task: TaskData;
  description: string;
  actions: TaskActions;
  /** Given only while the title can be edited — puts it in edit mode in the top row. */
  onEditTitle?: () => void;
  onBack: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = task.status === 'developing' || task.status === 'blocked';
  const idleHint = active ? 'Stop or allow the session to become idle first' : undefined;
  // A Task that ran a plan item is deleted with its item; any other session on its own.
  const remove = () => (task.planItemId ? actions.deleteItems([task.planItemId]) : actions.deleteSession(task.id));

  return (
    <div id="task-detail-more">
      <div className={`flex flex-col gap-3 pb-4 pr-4 sm:pr-6 ${TITLE_INDENT}`}>
        {task.sessionId && (
          <DetailRow label="Session ID">
            <code className="min-w-0 truncate font-mono text-xs select-text">{task.sessionId}</code>
            <CopyButton text={task.sessionId} label="Copy session ID" className="size-6" />
          </DetailRow>
        )}
        <section aria-label="Description" className="flex flex-col gap-1.5">
          <div className="flex h-6 items-center justify-between gap-2">
            <DetailLabel>Description</DetailLabel>
            <CopyButton text={description} label="Copy description" className="size-6" disabled={!description} />
          </div>
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-sm select-text">{description}</p>
        </section>
      </div>
      <Separator />
      <div className={`flex flex-wrap items-center gap-2 py-3 pr-4 sm:pr-6 ${TITLE_INDENT}`}>
        {onEditTitle && (
          <Button type="button" variant="secondary" size="sm" onClick={onEditTitle}>
            <Pencil aria-hidden="true" /> Edit title
          </Button>
        )}
        {active && (
          <Button type="button" variant="secondary" size="sm" onClick={() => void actions.stopSession(task.id)}>
            <Square aria-hidden="true" /> Stop task
          </Button>
        )}
        {task.kind !== 'plan' && !task.archived && completesViaSession(task) && (
          <Button type="button" variant="secondary" size="sm" onClick={() => void actions.completeSession(task.id)}>
            <CircleCheck aria-hidden="true" /> Mark complete
          </Button>
        )}
        {task.kind === 'plan' && !task.archived && !active && (
          <Button type="button" variant="secondary" size="sm" onClick={() => void actions.completePlanning(task.id).then((ok) => ok && onBack())}>
            <CircleCheck aria-hidden="true" /> {sessionKindOf(task) === 'bug-report' ? 'Mark session complete' : 'Mark planning complete'}
          </Button>
        )}
        {(task.kind !== 'plan' || task.archived) && (
          <Button type="button" variant="secondary" size="sm" disabled={active} title={idleHint} onClick={() => void actions.archiveTasks([task.id], !task.archived).then((ok) => ok && onBack())}>
            {task.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
            {task.archived ? (sessionKindOf(task) === 'bug-report' ? 'Restore session' : task.kind === 'plan' ? 'Restore planning' : 'Unarchive') : 'Archive'}
          </Button>
        )}
        <Button type="button" variant="destructive" size="sm" className="ml-auto" disabled={active} title={idleHint} onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden="true" /> Delete
        </Button>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={task.planItemId ? 'Delete this task?' : 'Delete this session?'}
          description="This can't be undone."
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void remove().then((ok) => ok && onBack());
          }}
        />
      )}
    </div>
  );
}
