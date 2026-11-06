import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AUTO_MERGE_RULE_TEXT, AUTO_MERGE_TONE_CLASSES, autoMergeChip, autoMergePanel, autoMergeToggle } from '../../lib/autoMerge';
import type { WorkflowRunRecord } from '../../lib/serverApi';
import { useNow } from '../../lib/useNow';
import { useWorldStore } from '../../store/worldStore';
import type { AutoMergeData, PlanItemData } from '../../types';

const CLOCK_TICK_MS = 30_000;

/**
 * The task details header's Auto-merge switch. Unavailable (and saying why, as its tooltip and as a
 * line under the header) where a pull request is impossible. It calls the store, which applies the
 * change at once and puts it back with the daemon's reason when refused.
 */
export function AutoMergeSwitch({ item, run }: { item: PlanItemData; run: WorkflowRunRecord | null }) {
  const repositoryUrl = useWorldStore((s) => s.projects.find((project) => project.id === item.projectId)?.repositoryUrl);
  const setAutoMerge = useWorldStore((s) => s.setAutoMerge);
  const view = autoMergeToggle({ repositoryUrl, run, autoMerge: item.autoMerge });
  const flip = () => { if (!view.disabled) void setAutoMerge(item.projectId, item.id, !view.checked); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); flip(); }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium" aria-disabled={view.disabled}>
          <span>Auto-merge</span>
          <Switch
            size="sm"
            checked={view.checked}
            aria-disabled={view.disabled}
            disabled={view.disabled}
            aria-label="Auto-merge"
            onCheckedChange={flip}
            onKeyDown={onKeyDown}
          />
        </label>
      </TooltipTrigger>
      <TooltipContent side="bottom">{view.tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** The line under the header that says why the switch is unavailable. */
export function AutoMergeUnavailable({ item, run }: { item: PlanItemData; run: WorkflowRunRecord | null }) {
  const repositoryUrl = useWorldStore((s) => s.projects.find((project) => project.id === item.projectId)?.repositoryUrl);
  const view = autoMergeToggle({ repositoryUrl, run, autoMerge: item.autoMerge });
  return view.reason && !view.checked ? <p className="pl-10.5 text-xs text-muted-foreground">Auto-merge is unavailable: {view.reason}</p> : null;
}

/** The status panel under the header: the merge state, its reasons, the conflict run and what the person can do. */
export function AutoMergePanel({ item }: { item: PlanItemData }) {
  const now = useNow(CLOCK_TICK_MS);
  const retryAutoMerge = useWorldStore((s) => s.retryAutoMerge);
  const setWorkspaceTab = useWorldStore((s) => s.setWorkspaceTab);
  const openCardDetail = useWorldStore((s) => s.openWorkspaceCardDetail);
  const [busy, setBusy] = useState(false);
  const panel = autoMergePanel(item.autoMerge, now);
  if (!panel) return <div style={{ display: 'none' }} data-auto-merge-panel />;
  async function retry() {
    setBusy(true);
    await retryAutoMerge(item.projectId, item.id);
    setBusy(false);
  }
  return (
    <section aria-label="Auto-merge status" data-auto-merge-panel data-state={panel.state} className={`mt-1 ml-10.5 flex flex-col gap-1 rounded-md border px-3 py-2 text-xs ${AUTO_MERGE_TONE_CLASSES[panel.tone]}`}>
      <p className="font-medium" role="status">Auto-merge: {panel.title}{panel.merged?.when ? ` · ${panel.merged.when}` : ''}</p>
      {panel.reasons.length > 0 && <ul className="list-disc pl-4">{panel.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      {panel.warnings.map((warning) => <p key={warning} data-auto-merge-warning className="text-warning-foreground">{warning}</p>)}
      {panel.merged && <p>{panel.merged.branch}</p>}
      {panel.state === 'blocked' && <p>Fix the cause and auto-merge continues by itself, or merge from the PR tab.</p>}
      {panel.note && <p>{panel.note}</p>}
      {panel.state === 'waiting' && <p>{AUTO_MERGE_RULE_TEXT}</p>}
      <div className="flex flex-wrap gap-2">
        {panel.runId && <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => openCardDetail(item.projectId, { kind: 'run', id: panel.runId! })}>View the conflict run</Button>}
        {panel.actions.includes('retry') && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>Retry</Button>}
        {panel.actions.includes('open-pr-tab') && <Button type="button" variant="outline" size="sm" onClick={() => setWorkspaceTab('pr')}>Open PR tab</Button>}
      </div>
    </section>
  );
}

/** The board card's small status beside the completion state; nothing while the toggle is off. */
export function AutoMergeChip({ autoMerge }: { autoMerge: AutoMergeData | undefined }) {
  const chip = autoMergeChip(autoMerge);
  if (!chip) return null;
  return (
    <span data-auto-merge-chip title={chip.title} className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap ${AUTO_MERGE_TONE_CLASSES[chip.tone]}`}>
      {chip.live && <span aria-hidden="true" className="mr-1 size-1.5 rounded-full bg-current" />}{chip.label}
    </span>
  );
}
