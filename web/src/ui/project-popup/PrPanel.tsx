import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AUTO_MERGE_TONE_CLASSES, prRowAutoMergeTag } from '../../lib/autoMerge';
import type { PrRowTag } from '../../lib/autoMerge';
import { EMPTY_PR_ACTIONS, conflictRunFor, mergeClickTarget, mergeRequestFor, prRowModel, withHeldRows } from '../../lib/pullRequestActions';
import type { MergeRequestOptions, PrActionState, PrRowModel, RowNote } from '../../lib/pullRequestActions';
import { prGoneNotice, resolveHighlight } from '../../lib/footerPullRequests';
import { branchLabel, moreThanShownNote, prRowLabel, prViewState, relativeCheckTime } from '../../lib/pullRequests';
import type { PullRequest } from '../../lib/pullRequests';
import type { ExecutorProfile, WorkflowRunRecord } from '../../lib/serverApi';
import { refreshPullRequests, usePrReading } from '../../lib/usePullRequests';
import { useWorldStore } from '../../store/worldStore';
import type { PlanItemData, ProjectData, TaskData } from '../../types';
import { MergeAnywayDialog, ResolveConflictsDialog } from './PrDialogs';

const EMPTY_RUNS: WorkflowRunRecord[] = [];
const EMPTY_ITEMS: PlanItemData[] = [];

type OpenDialog = { kind: 'confirm'; pr: PullRequest; blockers: string[] } | { kind: 'agent'; pr: PullRequest };

const NOTE_TONE: Record<RowNote['tone'], string> = {
  muted: 'text-muted-foreground',
  warning: 'text-warning-foreground',
  error: 'text-destructive',
};

/** The latest Task of a run: its step's CLI session, which says whether the agent is still starting or working. */
function latestRunTask(runId: string, tasksById: Record<string, TaskData>): TaskData | null {
  return Object.values(tasksById).reduce<TaskData | null>((latest, task) => {
    if (task.workflowRunId !== runId) return latest;
    return !latest || (task.createdAt ?? '') > (latest.createdAt ?? '') ? task : latest;
  }, null);
}

/**
 * The PR tab: the Project's open pull requests, newest first, from the same reading as the tab label.
 * Each row can be checked out into the Project's folder and merged; what each control shows and what
 * a click opens comes from `prRowModel` (lib/pullRequestActions.ts), never from conditions here.
 */
export function PrPanel({ project }: { project: ProjectData }) {
  const reading = usePrReading(project.id);
  const [clock] = useState(Date.now);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [goneNotice, setGoneNotice] = useState('');
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const highlightRequest = useWorldStore((s) => s.prHighlightRequest);
  const clearHighlightRequest = useWorldStore((s) => s.clearPrHighlightRequest);
  const actions = useWorldStore((s) => s.prActionsByProject[project.id]) ?? EMPTY_PR_ACTIONS;
  const runs = useWorldStore((s) => s.workflowRunsByProject[project.id]) ?? EMPTY_RUNS;
  const tasksById = useWorldStore((s) => s.tasksById);
  const planItems = useWorldStore((s) => s.planByProject[project.id]?.items) ?? EMPTY_ITEMS;
  const planLoaded = useWorldStore((s) => s.planByProject[project.id] !== undefined);
  const loadPlan = useWorldStore((s) => s.loadPlan);
  const executors = useWorldStore((s) => s.executors);
  const loadPrMergeStates = useWorldStore((s) => s.loadPrMergeStates);
  const mergePullRequest = useWorldStore((s) => s.mergePullRequest);
  const checkoutPullRequest = useWorldStore((s) => s.checkoutPullRequest);
  const returnFromPullRequest = useWorldStore((s) => s.returnFromPullRequest);
  const dismissPrNotice = useWorldStore((s) => s.dismissPrNotice);
  const openCardDetail = useWorldStore((s) => s.openWorkspaceCardDetail);

  const view = prViewState(reading);
  const note = moreThanShownNote(reading);
  const lastGood = reading.checkedAt ? relativeCheckTime(reading.checkedAt, Math.max(clock, Date.now())) : '';
  const status = reading.loading ? 'Checking open pull requests…'
    : reading.error ? `Couldn't refresh: ${reading.error}${lastGood ? ` Showing the reading from earlier. ${lastGood}.` : ''}`
    : '';
  const rows = useMemo(() => withHeldRows(reading.pullRequests, actions.held), [reading.pullRequests, actions.held]);

  // A footer click names a PR: bring it into view, or say it is gone once the reading can tell.
  useEffect(() => {
    if (!highlightRequest || highlightRequest.projectId !== project.id) return;
    const { number } = highlightRequest;
    const resolution = number === null ? { kind: 'unlisted' as const } : resolveHighlight(reading, number);
    if (resolution.kind === 'wait') return;
    clearHighlightRequest();
    setGoneNotice(resolution.kind === 'gone' && number !== null ? prGoneNotice(number) : '');
    setHighlighted(resolution.kind === 'found' ? number : null);
  }, [highlightRequest, project.id, reading, clearHighlightRequest]);

  useEffect(() => {
    if (highlighted === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-pr-number="${highlighted}"]`);
    row?.scrollIntoView({ block: 'center' });
    row?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [highlighted]);

  // The tasks whose Auto-merge owns a row come from the plan, which the PR tab may be the first to need.
  useEffect(() => { if (!planLoaded) void loadPlan(project.id); }, [planLoaded, loadPlan, project.id]);

  // Each successful list reading: read the merge state of rows that are new or changed.
  useEffect(() => {
    if (reading.checkedAt) void loadPrMergeStates(project.id, reading.pullRequests);
  }, [project.id, reading.checkedAt, reading.pullRequests, loadPrMergeStates]);

  // A conflict run changing state changes what its PR can do (and a merged one leaves the list).
  const conflictRunStates = runs.filter((run) => run.prConflict).map((run) => `${run.id}:${run.status}`).join(',');
  useEffect(() => {
    if (!conflictRunStates) return;
    refreshPullRequests(project);
    void loadPrMergeStates(project.id, reading.pullRequests, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when a run's status changes
  }, [conflictRunStates]);

  function refresh() {
    refreshPullRequests(project);
    void loadPrMergeStates(project.id, reading.pullRequests, true);
  }

  async function merge(pr: PullRequest, options: MergeRequestOptions = {}): Promise<string> {
    const response = await mergePullRequest(project.id, pr, options);
    if (!response) return useWorldStore.getState().prActionsByProject[project.id]?.rowErrors[pr.number]?.message ?? 'The merge could not be started.';
    // The daemon reads the PR afresh on every click: it may have gained blockers since the row was drawn.
    if (response.outcome === 'needs-confirmation') setDialog({ kind: 'confirm', pr, blockers: response.blockers });
    else setDialog(null);
    return '';
  }

  function onMergeClick(pr: PullRequest, model: PrRowModel) {
    const target = mergeClickTarget(model);
    if (target === 'merge') void merge(pr);
    if (target === 'confirm') setDialog({ kind: 'confirm', pr, blockers: actions.mergeStates[pr.number]?.state?.blockers ?? [] });
    if (target === 'agent') setDialog({ kind: 'agent', pr });
  }

  function retry(pr: PullRequest, model: PrRowModel) {
    if (model.error?.retry === 'checkout') void checkoutPullRequest(project.id, pr);
    else if (model.error?.retry === 'merge') onMergeClick(pr, model);
    else void loadPrMergeStates(project.id, [pr], true);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Open pull requests">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={refresh} aria-label="Refresh open pull requests">
            <RefreshCw className={reading.loading ? 'animate-spin' : ''} aria-hidden="true" />Refresh
          </Button>
          <span className="text-xs text-muted-foreground">{lastGood || 'Not checked yet'}</span>
        </div>
        {view === 'ready' || view === 'error-with-data' ? <span className="text-xs text-muted-foreground">Newest first</span> : null}
      </div>
      <p role="status" aria-live="polite" className={`shrink-0 px-4 sm:px-6 text-sm ${reading.error && !reading.loading ? 'py-2 text-destructive' : status ? 'py-2 text-muted-foreground' : ''}`}>{status}</p>
      {goneNotice && (
        <div role="status" className="flex shrink-0 items-start justify-between gap-3 border-b bg-warning/15 px-4 py-2 text-sm text-warning-foreground sm:px-6">
          <span>{goneNotice}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss notice" onClick={() => setGoneNotice('')}><X aria-hidden="true" /></Button>
        </div>
      )}
      {actions.notice && (
        <div role="status" className={`flex shrink-0 items-start justify-between gap-3 border-b px-4 py-2 text-sm sm:px-6 ${actions.notice.tone === 'warning' ? 'bg-warning/15 text-warning-foreground' : 'bg-success/15 text-success-foreground'}`}>
          <span>{actions.notice.text}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss merge notice" onClick={() => dismissPrNotice(project.id)}><X aria-hidden="true" /></Button>
        </div>
      )}

      {view === 'error-no-data' && <p className="px-4 py-3 text-sm text-destructive sm:px-6">{reading.error}</p>}
      {view === 'empty' && <p className="px-4 py-6 text-sm text-muted-foreground sm:px-6">No open pull requests</p>}
      {(view === 'ready' || view === 'error-with-data') && (
        <ul ref={listRef} className="min-h-0 flex-1 divide-y overflow-y-auto">
          {rows.map((pr) => (
            <PrRow
              key={pr.number}
              pr={pr}
              highlighted={pr.number === highlighted}
              model={rowModel(pr, project, actions, runs, tasksById, executors)}
              autoMergeTag={prRowAutoMergeTag(planItems, pr.number)}
              returning={actions.returning}
              onCheckout={() => void checkoutPullRequest(project.id, pr)}
              onReturn={(branch) => void returnFromPullRequest(project.id, branch)}
              onMerge={(model) => onMergeClick(pr, model)}
              onRetry={(model) => retry(pr, model)}
              onView={(runId) => openCardDetail(project.id, { kind: 'run', id: runId })}
            />
          ))}
        </ul>
      )}
      {note && <p className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground sm:px-6">{note}</p>}

      {dialog?.kind === 'confirm' && (
        <MergeAnywayDialog pr={dialog.pr} blockers={dialog.blockers} onCancel={() => setDialog(null)} onConfirm={() => { setDialog(null); void merge(dialog.pr, mergeRequestFor({ kind: 'confirm' })); }} />
      )}
      {dialog?.kind === 'agent' && (
        <ResolveConflictsDialog
          pr={dialog.pr}
          onCancel={() => setDialog(null)}
          onStart={(executorId) => merge(dialog.pr, mergeRequestFor({ kind: 'agent', executorId }))}
        />
      )}
    </section>
  );
}

function rowModel(pr: PullRequest, project: ProjectData, actions: PrActionState, runs: WorkflowRunRecord[], tasksById: Record<string, TaskData>, executors: ExecutorProfile[]): PrRowModel {
  const run = conflictRunFor(runs, pr.number);
  return prRowModel({
    pr,
    reading: actions.mergeStates[pr.number],
    run,
    runSession: run ? latestRunTask(run.id, tasksById) : null,
    agentLabel: run ? executors.find((executor) => executor.id === run.executorId)?.label ?? null : null,
    checkout: project.prCheckout,
    currentBranch: project.sync?.branch ?? null,
    busy: actions.busy[pr.number],
    rowError: actions.rowErrors[pr.number],
    returnError: actions.returnError,
  });
}

function PrRow({
  pr,
  highlighted,
  model,
  autoMergeTag,
  returning,
  onCheckout,
  onReturn,
  onMerge,
  onRetry,
  onView,
}: {
  pr: PullRequest;
  highlighted: boolean;
  model: PrRowModel;
  /** Set while a task's Auto-merge owns this pull request; Merge and Check out work as usual. */
  autoMergeTag: PrRowTag | null;
  returning: boolean;
  onCheckout: () => void;
  /** `branch` is the offered default branch when the previous one is gone; undefined returns to the previous branch. */
  onReturn: (branch?: string) => void;
  onMerge: (model: PrRowModel) => void;
  onRetry: (model: PrRowModel) => void;
  onView: (runId: string) => void;
}) {
  const { checkout, merge, run } = model;
  return (
    <li data-pr-number={pr.number} aria-current={highlighted ? 'true' : undefined} className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6 ${highlighted ? 'bg-accent' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span tabIndex={0} title={prRowLabel(pr)} className="truncate text-sm font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{prRowLabel(pr)}</span>
          {pr.isDraft && <Badge variant="secondary">Draft</Badge>}
          {checkout.kind === 'checked-out' && <Badge variant="outline">Checked out</Badge>}
          {model.badges.map((badge) => <Badge key={badge} variant="outline">{badge}</Badge>)}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {branchLabel(pr)}{pr.author ? ` · ${pr.author}` : ''}
        </div>
        {autoMergeTag && <p data-auto-merge-tag className={`mt-1 inline-block max-w-full truncate rounded-full border px-2 py-0.5 text-xs ${AUTO_MERGE_TONE_CLASSES[autoMergeTag.tone]}`}>{autoMergeTag.text}</p>}
        {model.notes.map((line) => <p key={line.text} className={`mt-1 text-xs ${NOTE_TONE[line.tone]}`}>{line.text}</p>)}
        {checkout.kind === 'button' && checkout.reason && <p className="mt-1 text-xs text-muted-foreground">{checkout.reason}</p>}
        {checkout.kind === 'checked-out' && checkout.returnError && <p className="mt-1 text-xs text-destructive" role="alert">{checkout.returnError}</p>}
        {run && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs" role="status">
            <span className={run.reason ? 'font-medium text-destructive' : 'font-medium'}>{run.label}</span>
            {run.reason && <span className="text-muted-foreground">{run.reason}</span>}
            <button type="button" className="rounded font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`View the conflict-resolution run for pull request #${pr.number}`} onClick={() => onView(run.runId)}>View</button>
          </p>
        )}
        {model.error && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-destructive" role="alert">
            <span>{model.error.message}</span>
            <button type="button" className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Retry for pull request #${pr.number}`} onClick={() => onRetry(model)}>Retry</button>
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {checkout.kind === 'checked-out' ? (
          <Button type="button" variant="outline" size="sm" disabled={returning} onClick={() => onReturn(checkout.returnBranch)} aria-label={`${checkout.returnLabel} from pull request #${pr.number}`}>
            {returning && <Loader2 className="animate-spin" aria-hidden="true" />}{checkout.returnLabel}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={checkout.disabled} title={checkout.reason ?? undefined} onClick={onCheckout} aria-label={`Check out pull request #${pr.number}`}>
            {checkout.pending && <Loader2 className="animate-spin" aria-hidden="true" />}Check out
          </Button>
        )}
        {merge.kind === 'button' && (
          <Button type="button" size="sm" onClick={() => onMerge(model)} aria-label={`${merge.label === 'Retry' ? 'Retry resolving conflicts for' : 'Merge'} pull request #${pr.number}`}>{merge.label}</Button>
        )}
        {(merge.kind === 'merging' || merge.kind === 'loading') && (
          <Button type="button" size="sm" disabled aria-label={`${merge.kind === 'merging' ? 'Merging' : 'Checking whether'} pull request #${pr.number}${merge.kind === 'loading' ? ' can be merged' : ''}`}>
            <Loader2 className="animate-spin" aria-hidden="true" />{merge.kind === 'merging' ? 'Merging…' : 'Merge'}
          </Button>
        )}
        {merge.kind === 'hidden' && merge.reason && <span className="max-w-48 text-xs text-muted-foreground">{merge.reason}</span>}
        <a href={pr.url} target="_blank" rel="noopener noreferrer" aria-label={`Open pull request #${pr.number} on GitHub in a new tab`} className="shrink-0 rounded text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open on GitHub</a>
      </div>
    </li>
  );
}
