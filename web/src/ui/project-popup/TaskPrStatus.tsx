import type { MouseEvent } from 'react';
import { AUTO_MERGE_TONE_CLASSES, autoMergeToggle } from '../../lib/autoMerge';
import type { TaskPrView } from '../../lib/taskPullRequest';
import { useWorldStore } from '../../store/worldStore';

const PILL = 'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap';

/** The settled-PR badge ("Merged", "PR closed") shown with a Completed card's status. */
export function PrBadge({ pr }: { pr: TaskPrView | undefined }) {
  if (!pr?.badge) return null;
  return <span data-pr-badge className={`${PILL} ${AUTO_MERGE_TONE_CLASSES[pr.badge.tone]}`}>{pr.badge.label}</span>;
}

/** Shown on a Completed card whose pull request has never been read. */
export function PrHint({ pr }: { pr: TaskPrView | undefined }) {
  return pr?.hint ? <p data-pr-hint className="mt-1.5 text-xs text-muted-foreground">{pr.hint}</p> : null;
}

const stop = (event: MouseEvent) => event.stopPropagation();

/**
 * The "PR #N open" tag of a task waiting in "PR not merged yet", linking to that pull request in the PR
 * tab, and the quick Auto-merge switch-on (the task toggle's own action and disabled reasons).
 */
export function PrOpenTag({ pr, projectId, itemId }: { pr: TaskPrView; projectId: string; itemId: string }) {
  const repositoryUrl = useWorldStore((s) => s.projects.find((project) => project.id === projectId)?.repositoryUrl);
  const openPullRequest = useWorldStore((s) => s.openPullRequestFromFooter);
  const setAutoMerge = useWorldStore((s) => s.setAutoMerge);
  const toggle = autoMergeToggle({ repositoryUrl, run: null, autoMerge: undefined });
  if (!pr.tag) return null;
  const { tag } = pr;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1.5" data-pr-open-tag>
      <button type="button" className={`${PILL} ${AUTO_MERGE_TONE_CLASSES.info} focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`} title={tag.prNumber === null ? 'Open the PR tab' : `Open pull request #${tag.prNumber} in the PR tab`} onClick={(event) => { stop(event); openPullRequest(projectId, tag.prNumber); }}>{tag.text}</button>
      <button type="button" disabled={toggle.disabled} data-pr-auto-merge-offer className="rounded text-[10px] font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50" title={toggle.tooltip} onClick={(event) => { stop(event); void setAutoMerge(projectId, itemId, true); }}>Turn on Auto-merge</button>
    </p>
  );
}
