import { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { ACTION_LABELS, dependsOnSection, waitingView } from '../../lib/dependencies';
import type { PickerOption, WaitingView } from '../../lib/dependencies';
import { KindTag, ParentOptionGroups, StateBadge } from './ParentOptionGroups';
import { useWorldStore } from '../../store/worldStore';
import {
  CANCEL_AND_DISCARD_LABEL, CANCEL_CONFIRM_TEXT, earlyPhaseLine, earlyPhaseOf, earlyWaitingActions, KEEP_WAITING_LABEL, REVIEW_UI_PLAN_LABEL,
} from '../../lib/earlyUiPlanning';
import { UiPlanningWaitsSwitch } from './UiPlanningWaitsSwitch';
import type { DependencyReasonData, PlanItemData } from '../../types';

const EMPTY_ITEMS: PlanItemData[] = [];

/**
 * One reason a task waits, with the one-click fix when there is one. The fix acts on the parent the
 * reason names (turn its auto-merge on, retry it), on the project (sync) or on this task (drop the dependency).
 */
function ReasonLine({ item, reason }: { item: PlanItemData; reason: DependencyReasonData }) {
  const items = useWorldStore((s) => s.planByProject[item.projectId]?.items ?? EMPTY_ITEMS);
  const setAutoMerge = useWorldStore((s) => s.setAutoMerge);
  const setDependencies = useWorldStore((s) => s.setDependencies);
  const syncProjectBranch = useWorldStore((s) => s.syncProjectBranch);
  const resumeWorkflowRun = useWorldStore((s) => s.resumeWorkflowRun);
  const retryWorkflowStep = useWorldStore((s) => s.retryWorkflowStep);
  const parent = items.find((entry) => entry.id === reason.parentId);
  const run = useWorldStore((s) => (parent?.workflowRunId ? s.workflowRunsByProject[item.projectId]?.find((entry) => entry.id === parent.workflowRunId) : undefined));

  function act() {
    switch (reason.action) {
      case 'toggle-auto-merge': if (parent) void setAutoMerge(item.projectId, parent.id, true); break;
      case 'sync': void syncProjectBranch(item.projectId); break;
      case 'remove-dependency': void setDependencies(item.projectId, item.id, (item.dependsOn ?? []).filter((id) => id !== reason.parentId)); break;
      case 'retry-parent':
        if (run) void (run.status === 'failed' ? retryWorkflowStep(run.id) : resumeWorkflowRun(run.id));
        break;
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 text-xs" data-reason-blocked={reason.blocked || undefined}>
      <span className={reason.blocked ? 'text-destructive' : 'text-muted-foreground'}>{reason.text}</span>
      {reason.action && <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={act}>{ACTION_LABELS[reason.action]}</Button>}
    </li>
  );
}

/**
 * The live waiting state of a started-but-waiting task: its badge, how far an early UI Planning has got, why it
 * waits, and Cancel waiting — which asks first once a UI plan exists, since cancelling discards it.
 */
export function WaitingPanel({ item, view }: { item: PlanItemData; view: WaitingView }) {
  const cancelWaiting = useWorldStore((s) => s.cancelWaiting);
  const openCardDetail = useWorldStore((s) => s.openWorkspaceCardDetail);
  const run = useWorldStore((s) => (item.workflowRunId ? s.workflowRunsByProject[item.projectId]?.find((entry) => entry.id === item.workflowRunId) : undefined));
  const queue = useWorldStore((s) => s.planItemQueueByProject[item.projectId]);
  const [confirming, setConfirming] = useState(false);
  const phase = earlyPhaseOf(item, run, queue);
  const phaseLine = earlyPhaseLine(phase);
  const actions = earlyWaitingActions(phase);
  const openRun = () => { if (item.workflowRunId) openCardDetail(item.projectId, { kind: 'run', id: item.workflowRunId }); };
  const cancel = () => { setConfirming(false); void cancelWaiting(item.projectId, item.id); };
  return (
    <div className="grid gap-1.5 rounded-md border px-3 py-2" data-waiting-panel={view.kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant={view.kind === 'blocked' ? 'soft-destructive' : 'warning'}>{view.badge}</Badge>
          {phaseLine && <span className="text-xs font-medium" data-early-phase>{phaseLine}</span>}
          {actions.openRun && <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={openRun}>Open run</Button>}
        </span>
        {!confirming && (
          <span className="flex gap-2">
            {actions.reviewUiPlan && <Button type="button" size="sm" onClick={openRun}>{REVIEW_UI_PLAN_LABEL}</Button>}
            {view.canCancel && <Button type="button" variant="outline" size="sm" onClick={() => (actions.confirmCancel ? setConfirming(true) : cancel())}>Cancel waiting</Button>}
          </span>
        )}
      </div>
      {confirming && (
        <div role="group" aria-label="Confirm cancel waiting" className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5" data-cancel-confirm>
          <span className="text-xs">{CANCEL_CONFIRM_TEXT}</span>
          <span className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>{KEEP_WAITING_LABEL}</Button>
            <Button type="button" variant="destructive" size="sm" onClick={cancel}>{CANCEL_AND_DISCARD_LABEL}</Button>
          </span>
        </div>
      )}
      <ul className="grid gap-1">{view.reasons.map((reason) => <ReasonLine key={`${reason.parentId ?? 'start'}:${reason.text}`} item={item} reason={reason} />)}</ul>
    </div>
  );
}

/** A searchable parent picker: type to filter by number or title; the list scrolls inside a popover capped to the viewport. */
function ParentPicker({ options, value, onChange }: { options: PickerOption[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value);
  // `modal`: the popover is portalled outside the popup dialog, whose scroll lock would otherwise swallow wheel scrolling in the list.
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" role="combobox" aria-expanded={open} aria-label="Add a parent task" className="min-w-0 flex-1 justify-between text-xs font-normal">
          <span className={`truncate ${selected ? '' : 'text-muted-foreground'}`}>{selected?.title ?? 'Add a parent task…'}</span>
          <ChevronsUpDown className="!size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tasks and bugs…" />
          <CommandList className="max-h-[min(18rem,40vh)]">
            <CommandEmpty>No tasks or bugs to depend on.</CommandEmpty>
            <ParentOptionGroups options={options} renderOption={(option) => (
              <CommandItem key={option.id} value={`${option.id} ${option.label} ${option.title}`} disabled={option.flag !== null} onSelect={() => { onChange(option.id); setOpen(false); }}>
                <span className="min-w-0 flex-1 truncate">{option.title}{option.flag ? ` — ${option.flag}` : ''}</span>
                <KindTag kind={option.kind} />
                <StateBadge state={option.state} />
              </CommandItem>
            )} />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The details panel's "Depends on" section: edit the parents of a ready task, read them once it started, and see why it waits. */
export function DependsOnSection({ item }: { item: PlanItemData }) {
  const items = useWorldStore((s) => s.planByProject[item.projectId]?.items ?? EMPTY_ITEMS);
  const repositoryUrl = useWorldStore((s) => s.projects.find((project) => project.id === item.projectId)?.repositoryUrl);
  const setDependencies = useWorldStore((s) => s.setDependencies);
  const [choice, setChoice] = useState('');
  const section = dependsOnSection(item, items, repositoryUrl);
  const waiting = waitingView(item.waiting);
  if (section.mode === 'hidden') return waiting ? <WaitingPanel item={item} view={waiting} /> : null;
  if (section.mode === 'unavailable') {
    return <p className="text-xs text-muted-foreground" data-depends-on="unavailable">Depends on: unavailable. {section.reason}</p>;
  }
  const editable = section.mode === 'editable';
  const current = item.dependsOn ?? [];
  return (
    <section aria-label="Depends on" className="grid gap-2" data-depends-on={section.mode}>
      <h4 className="text-xs font-semibold">Depends on</h4>
      {section.parents.length === 0 && <p className="text-xs text-muted-foreground">No parent tasks. This task starts as soon as it is started.</p>}
      <ul className="grid gap-1">
        {section.parents.map((parent) => (
          <li key={parent.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate" title={parent.title}>{parent.label}{parent.title && parent.label !== parent.title ? ` ${parent.title.replace(/^[^:]*:\s*/, '')}` : ''}</span>
            {editable && <Button type="button" variant="ghost" size="sm" aria-label={`Remove dependency ${parent.label}`} onClick={() => void setDependencies(item.projectId, item.id, current.filter((id) => id !== parent.id))}>Remove</Button>}
          </li>
        ))}
      </ul>
      {editable && (
        <div className="flex items-center gap-2">
          <ParentPicker options={section.options} value={choice} onChange={setChoice} />
          <Button type="button" size="sm" variant="outline" disabled={!choice} onClick={() => { void setDependencies(item.projectId, item.id, [...current, choice]); setChoice(''); }}>Add</Button>
        </div>
      )}
      <UiPlanningWaitsSwitch item={item} surface="detail" />
      {waiting && <WaitingPanel item={item} view={waiting} />}
    </section>
  );
}

/** The card's one-line waiting state: the badge and the first reason. */
export function WaitingBanner({ waiting }: { waiting: NonNullable<ReturnType<typeof waitingView>> }) {
  const first = waiting.reasons[0];
  return (
    <p className={`mt-1.5 truncate text-xs ${waiting.kind === 'blocked' ? 'text-destructive' : 'text-muted-foreground'}`} data-waiting-banner={waiting.kind} title={first?.text}>
      <span className="font-medium">{waiting.badge}</span>{first ? ` · ${first.text}` : ''}
    </p>
  );
}
