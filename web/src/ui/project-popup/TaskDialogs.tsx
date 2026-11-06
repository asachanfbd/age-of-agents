import { completeStageLabel } from '../../lib/buildingTypes';
import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { isRegressionReasonValid, regressionCounterLabel, REGRESSION_REASON_MAX } from '../../lib/bugs';
import { initialStepSelection, skippedStepIds, stepSelectionCount, stepTag, toggleStepSelection, type StepSelection } from '../../lib/stepSelection';
import type { WorkflowRecord, WorkflowStep } from '../../lib/serverApi';
import { autoMergeAfterBranchChange, autoMergeSwitch, startOptions, stepsAreExpanded } from '../../lib/startTaskDialog';
import { START_WHEN_MERGED_LABEL } from '../../lib/dependencies';
import type { StartConfirmParent } from '../../lib/dependencies';
import { taskConflictOf, type TaskConflict } from '../../lib/taskConflicts';
import { fullProjectNote, slotCap } from '../../lib/waitingList';
import { TaskConflictAlert } from './TaskConflictAlert';
import { CodingAgentPicker } from '../CodingAgentPicker';
import { useExecutorChoice } from '../useExecutorChoice';
import type { ConflictRow } from '../../lib/taskConflicts';

/**
 * An in-app confirmation — "Delete this task?", "Archive 3 completed tasks?" — before a bulk or
 * irreversible action. The confirm button is destructive unless `destructive` is false.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
/**
 * The reopen dialog for a completed bug whose fix did not work: only the reason is asked. Every step
 * runs again as its next round with the agent and conversation it had before, so there is no agent
 * choice. `onSubmit` resolves the failure message ('' on success); a refusal
 * (task limit reached, folder busy) is shown here and keeps the dialog open.
 */
export function ReportRegressionDialog({ archived, onSubmit, onCancel }: { archived: boolean; onSubmit: (reason: string) => Promise<string>; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const tooLong = reason.trim().length > REGRESSION_REASON_MAX;

  async function submit() {
    setPending(true);
    setError('');
    const message = await onSubmit(reason.trim());
    if (message) {
      setError(message);
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent className="sm:max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>Report a regression?</DialogTitle>
          <DialogDescription>Say why the fix did not work. Every step runs again as its next round with your reason.</DialogDescription>
        </DialogHeader>
        {archived && <p className="rounded-md bg-warning/15 px-3 py-2 text-xs">This bug is archived. Reporting a regression returns it to the board.</p>}
        <Label htmlFor="report-regression-reason" className="sr-only">Reason</Label>
        <Textarea
          id="report-regression-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (required)"
          rows={4}
          aria-invalid={tooLong}
          autoFocus
        />
        <div className="flex justify-between gap-2 text-xs text-muted-foreground">
          <span className="text-destructive">{tooLong ? `Too long: shorten it by ${(reason.trim().length - REGRESSION_REASON_MAX).toLocaleString('en-US')} characters (nothing is cut).` : ''}</span>
          <span>{regressionCounterLabel(reason)}</span>
        </div>
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Each step resumes its earlier conversation with the same agent. Round 2 starts on a new branch from the base branch, so an earlier fix that was not merged is not on it.
        </p>
        {error && (
          <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
        )}
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancel</Button>
          <Button type="button" disabled={pending || !isRegressionReasonValid(reason)} onClick={() => void submit()}>
            {pending ? 'Submitting…' : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The options a task starts with, asked every time it is dropped into Running or started from its
 * menu — nothing starts until they're confirmed. `onStart` rejects with the daemon's reason (bad
 * options, task limit reached, project folder busy), which is shown here and keeps the dialog open.
 */
export function StartTaskDialog({
  title,
  workflows,
  initialWorkflowId,
  fallbackNote = null,
  infoWarning = null,
  parents = [],
  hasRepository,
  slotsInUse = 0,
  initialAutoMerge = false,
  onStart,
  onCancel,
  onOpenTask,
}: {
  title: string;
  /** Enabled Catalog workflows only. */
  workflows: Pick<WorkflowRecord, 'id' | 'name' | 'steps'>[];
  initialWorkflowId: string;
  /** Shown under the workflow picker when a bug could not preselect its Bug Fix workflow. */
  fallbackNote?: string | null;
  /** A bug's "Needs more info" warning. Advisory only: it never disables Start. */
  infoWarning?: string | null;
  /** Parent tasks that are not satisfied yet; null while they load (nothing is shown until they are known). When there are any, Start asks to confirm waiting for them before anything is sent. */
  parents?: StartConfirmParent[] | null;
  /** A separate branch needs a linked repository; without one the choice isn't offered. */
  hasRepository: boolean;
  /** Writing tasks holding a slot right now; when they fill the Project's cap a line under Start says the task will wait. */
  slotsInUse?: number;
  /** The task's current Auto-merge setting, which the switch opens in. */
  initialAutoMerge?: boolean;
  onStart: (options: ReturnType<typeof startOptions>) => Promise<void>;
  onCancel: () => void;
  /** Opens a task the limit message lists; the dialog closes first. */
  onOpenTask?: (target: ConflictRow['target']) => void;
}) {
  const { executors, executorId, choose } = useExecutorChoice();
  const [workflowId, setWorkflowId] = useState(initialWorkflowId);
  const steps = workflows.find((workflow) => workflow.id === workflowId)?.steps ?? [];
  const [selection, setSelection] = useState<StepSelection>(() => initialStepSelection(steps));
  const [createBranch, setCreateBranch] = useState(hasRepository);
  const [autoMerge, setAutoMerge] = useState(initialAutoMerge && hasRepository);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<TaskConflict | null>(null);
  const fullNote = fullProjectNote(slotsInUse, slotCap(hasRepository));
  const needsWorkflow = workflows.length > 0 && !workflowId;
  const noStepSelected = steps.length > 0 && selection.selected.length === 0;

  function changeBranch(checked: boolean) {
    setCreateBranch(checked);
    setAutoMerge((current) => autoMergeAfterBranchChange(checked, current));
  }

  function changeWorkflow(id: string) {
    setWorkflowId(id);
    setSelection(initialStepSelection(workflows.find((workflow) => workflow.id === id)?.steps ?? []));
  }

  async function start() {
    setStarting(true);
    setError('');
    setConflict(null);
    const skipped = skippedStepIds(steps, selection);
    try {
      await onStart(startOptions({ executorId, createBranch, hasRepository, autoMerge, workflowId, skippedStepIds: skipped }));
    } catch (failure) {
      const refused = taskConflictOf(failure);
      if (refused) setConflict(refused);
      else setError((failure as Error).message);
      setStarting(false);
    }
  }

  if (parents === null) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>Start task</DialogTitle>
          <DialogDescription className="break-words">Choose how &ldquo;{title}&rdquo; runs.</DialogDescription>
        </DialogHeader>
        {confirming ? <ParentsConfirmation parents={parents} /> : <>
        {infoWarning && <p role="status" className="rounded-md bg-warning/15 px-3 py-2 text-xs text-warning-foreground">{infoWarning}</p>}
        {workflows.length > 0 && (
          <div className="grid gap-2">
            <Label htmlFor="start-workflow">Workflow</Label>
            <Select value={workflowId} onValueChange={changeWorkflow}>
              <SelectTrigger id="start-workflow" className="w-full"><SelectValue placeholder="Choose a workflow" /></SelectTrigger>
              <SelectContent>
                {workflows.map((workflow) => <SelectItem key={workflow.id} value={workflow.id}>{workflow.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {fallbackNote && <p className="text-xs text-muted-foreground">{fallbackNote}</p>}
          </div>
        )}
        {steps.length > 0 && (
          <StepChecklist
            steps={steps}
            selection={selection}
            expanded={stepsAreExpanded(stepsOpen, selection.selected.length, steps.length)}
            onToggleExpanded={() => setStepsOpen((open) => !open)}
            invalid={noStepSelected}
            onToggle={(stepId) => setSelection((current) => toggleStepSelection(steps, current, stepId))}
            hasRepository={hasRepository}
          />
        )}
        {hasRepository && (
          <div className="grid gap-1">
            <Label htmlFor="start-create-branch" className="flex cursor-pointer items-center gap-3 font-normal">
              <Checkbox id="start-create-branch" checked={createBranch} onCheckedChange={(checked) => changeBranch(checked === true)} />
              Create a separate branch
            </Label>
            <p className="pl-7 text-xs text-muted-foreground">Off runs it in the project folder, on the current branch.</p>
          </div>
        )}
        {hasRepository && <AutoMergeField state={autoMergeSwitch({ hasRepository, createBranch, value: autoMerge })} onChange={setAutoMerge} />}
        <CodingAgentPicker executors={executors} value={executorId} onChange={choose} id="start-agent" />
        </>}
        {conflict && <TaskConflictAlert conflict={conflict} onOpen={onOpenTask && ((target) => { onCancel(); onOpenTask(target); })} />}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" onClick={confirming ? () => setConfirming(false) : onCancel}>{confirming ? 'Back' : 'Cancel'}</Button>
          {confirming
            ? <Button type="button" disabled={starting} onClick={() => void start()}>{START_WHEN_MERGED_LABEL}</Button>
            : parents.length > 0
              ? <Button type="button" disabled={!executorId || needsWorkflow || noStepSelected} onClick={() => setConfirming(true)}>Next</Button>
              : <Button type="button" disabled={!executorId || needsWorkflow || noStepSelected || starting} onClick={() => void start()}>Start</Button>}
        </DialogFooter>
        {fullNote && !confirming && <p className="text-xs text-muted-foreground" data-full-note>{fullNote}</p>}
      </DialogContent>
    </Dialog>
  );
}

/** The second step of starting a dependent task: it waits, staying in Planning, until these parents are merged. */
function ParentsConfirmation({ parents }: { parents: StartConfirmParent[] }) {
  return (
    <div className="grid gap-2" data-start-confirm>
      <p className="text-sm">This task starts by itself once these parent tasks are merged into the checked-out branch. Until then it shows in Running as Waiting, and you can cancel waiting at any time.</p>
      <ul className="grid gap-1 rounded-md border px-3 py-2 text-xs">
        {parents.map((parent) => <li key={parent.id}><span className="font-medium">{parent.label}</span> <span className="text-muted-foreground">{parent.status}</span></li>)}
      </ul>
    </div>
  );
}

/**
 * Makes every ready task of a planning group depend on the previous one, optionally with Auto-merge
 * on. The summary says what changes and that the group's order, numbers, titles and branches do not.
 */
export function ChainTasksDialog({ titles, onConfirm, onCancel }: { titles: string[]; onConfirm: (autoMerge: boolean) => Promise<void>; onCancel: () => void }) {
  const [autoMerge, setAutoMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    setBusy(true);
    setError('');
    try { await onConfirm(autoMerge); } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>Chain tasks</DialogTitle>
          <DialogDescription>Each ready task will wait for the one before it to be merged. Only ready tasks are chained; the order, numbers, titles and branches stay as they are.</DialogDescription>
        </DialogHeader>
        <ol className="grid list-decimal gap-1 pl-5 text-xs">{titles.map((title, index) => <li key={`${index}:${title}`}>{title}</li>)}</ol>
        <Label htmlFor="chain-auto-merge" className="flex cursor-pointer items-center gap-3 font-normal">
          <Checkbox id="chain-auto-merge" checked={autoMerge} onCheckedChange={(checked) => setAutoMerge(checked === true)} />
          Turn on auto-merge for all of them
        </Label>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="button" disabled={busy || titles.length < 2} onClick={() => void confirm()}>Chain tasks</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The chosen workflow's steps as checkboxes, for leaving some out of this one run. The dependency
 * rules live in lib/stepSelection.ts; a row they changed shows why. The built-in Complete stage is
 * a fixed footer row with no checkbox, since it always runs.
 */
function StepChecklist({
  steps,
  selection,
  expanded,
  onToggleExpanded,
  invalid,
  onToggle,
  hasRepository,
}: {
  steps: WorkflowStep[];
  selection: StepSelection;
  expanded: boolean;
  onToggleExpanded: () => void;
  invalid: boolean;
  onToggle: (stepId: string) => void;
  hasRepository: boolean;
}) {
  const panelId = useId();
  return (
    <div className="grid gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onToggleExpanded}
      >
        <ChevronRight aria-hidden="true" className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span id="start-steps-label" className="text-sm font-medium">Steps</span>
        <span className="ml-auto text-xs text-muted-foreground">{stepSelectionCount(steps, selection)}</span>
      </button>
      {expanded && <div
        id={panelId}
        role="group"
        aria-labelledby="start-steps-label"
        className={`max-h-72 overflow-y-auto rounded-md border ${invalid ? 'border-destructive' : ''}`}
      >
        {steps.map((step, index) => {
          const checked = selection.selected.includes(step.id);
          const tag = stepTag(step, steps);
          const note = selection.notes[step.id];
          return (
            <Label
              key={step.id}
              htmlFor={`start-step-${step.id}`}
              className="flex cursor-pointer items-center gap-2.5 border-b px-2.5 py-1.5 font-normal last:border-b-0 hover:bg-muted/50"
            >
              <span className="w-3.5 shrink-0 text-right text-xs text-muted-foreground">{index + 1}</span>
              <Checkbox id={`start-step-${step.id}`} checked={checked} onCheckedChange={() => onToggle(step.id)} />
              <span className={`min-w-0 flex-1 ${checked ? '' : 'text-muted-foreground'}`}>
                {step.name}
                {note && <span className="block text-[11px] text-info-foreground">{note}</span>}
              </span>
              {tag && (
                <span className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-px text-[11px] ${step.loopBack ? 'bg-info/15 text-info-foreground' : 'bg-warning/15 text-warning-foreground'}`}>
                  {tag}
                </span>
              )}
            </Label>
          );
        })}
        <div className="flex items-center gap-2.5 border-t border-dashed bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
          <span className="flex-1 pl-11">{completeStageLabel(hasRepository)}</span>
          <span>always runs</span>
        </div>
      </div>}
      {invalid && <p role="alert" className="text-xs text-destructive">Pick at least one step to run.</p>}
    </div>
  );
}

/** The Auto-merge switch: off and disabled, with its reason, while the task would not get a branch of its own. */
function AutoMergeField({ state, onChange }: { state: ReturnType<typeof autoMergeSwitch>; onChange: (next: boolean) => void }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="start-auto-merge" className="font-normal">Auto-merge</Label>
        <Switch id="start-auto-merge" checked={state.checked} disabled={state.disabled} onCheckedChange={onChange} aria-describedby={state.reason ? 'start-auto-merge-note' : undefined} />
      </div>
      <p id={state.reason ? 'start-auto-merge-note' : undefined} className="text-xs text-muted-foreground">{state.reason ?? 'Merges its pull request once the task completes.'}</p>
    </div>
  );
}
