import type { AutoMergeTone } from './autoMerge';
import type { PlanItemData } from '../types';
import type { WorkflowRunRecord } from './serverApi';

/**
 * What a finished task without Auto-merge shows about its own pull request, from the daemon's last
 * reading (`PlanItemData.pullRequest`). Pure, so the board card, the details header and the PR tab
 * word it the same way. Tasks with Auto-merge on are described by their auto-merge state instead.
 */

export const PR_STATUS_UNKNOWN_HINT = 'PR status unknown';
export const WAITING_FOR_PR_LABEL = 'Waiting for PR merge';

export interface TaskPrView {
  /** The neutral "PR #N open" tag (open pull request only). */
  tag: { text: string; prNumber: number | null } | null;
  /** The settled PR's badge on a Completed card. */
  badge: { label: string; tone: AutoMergeTone } | null;
  /** Said only when no reading has ever succeeded for a task that should have one. */
  hint: string | null;
}

type PrViewItem = Pick<PlanItemData, 'autoMerge' | 'pullRequest' | 'workflowRunId' | 'prConflict' | 'testingSetup'>;

const NONE: TaskPrView = { tag: null, badge: null, hint: null };

/** The view for a task whose work is finished; null when nothing about its pull request is worth saying. `run` is the task's own run, when known. */
export function taskPrView(item: PrViewItem, run?: Pick<WorkflowRunRecord, 'status' | 'branch' | 'baseBranch' | 'prConflict'> | null): TaskPrView | null {
  if (item.autoMerge?.enabled || item.prConflict || item.testingSetup || !item.workflowRunId) return null;
  const reading = item.pullRequest;
  if (!reading) {
    const ownBranch = run?.status === 'completed' && !run.prConflict && !!run.branch && !!run.baseBranch;
    return ownBranch ? { ...NONE, hint: PR_STATUS_UNKNOWN_HINT } : null;
  }
  switch (reading.state) {
    case 'open': return { ...NONE, tag: { text: reading.prNumber === null ? 'PR open' : `PR #${reading.prNumber} open`, prNumber: reading.prNumber } };
    case 'merged': return { ...NONE, badge: { label: 'Merged', tone: 'ok' } };
    case 'closed': return { ...NONE, badge: { label: 'PR closed', tone: 'warn' } };
    default: return null;
  }
}

/** True while the task is finished but its own pull request is open and Auto-merge is off. */
export const waitsForPrMerge = (item: PrViewItem): boolean => !item.autoMerge?.enabled && item.pullRequest?.state === 'open';

/** The details header's status badge: a finished task whose PR is open reads as waiting for it, not as plainly completed. */
export function detailStatus<T extends { label: string }>(status: T, item: PrViewItem | undefined, finished: boolean): T {
  return item && finished && waitsForPrMerge(item) ? { ...status, label: WAITING_FOR_PR_LABEL, variant: 'warning' } : status;
}
