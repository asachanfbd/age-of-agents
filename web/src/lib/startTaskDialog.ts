import type { ExecutePlanItemOptions } from './serverApi';

/** The Start task dialog's fields, top to bottom. The bug warning and the workflow's fallback note belong to the first two. */
export const START_FIELD_ORDER = ['workflow', 'steps', 'createBranch', 'autoMerge', 'codingAgent'] as const;

export const AUTO_MERGE_NEEDS_BRANCH = 'Auto-merge needs a separate branch';

/** The Steps section is collapsed on open and expands itself while no step is selected, so the error is never hidden. */
export function stepsAreExpanded(expandedByPerson: boolean, selectedCount: number, stepCount: number): boolean {
  return expandedByPerson || (stepCount > 0 && selectedCount === 0);
}

export interface AutoMergeSwitch {
  /** Shown only with a linked repository. */
  visible: boolean;
  checked: boolean;
  disabled: boolean;
  /** Why it is disabled, when it is. */
  reason: string | null;
}

/** The Auto-merge switch's state: off and disabled while "Create a separate branch" is unchecked. */
export function autoMergeSwitch(input: { hasRepository: boolean; createBranch: boolean; value: boolean }): AutoMergeSwitch {
  if (!input.createBranch) return { visible: input.hasRepository, checked: false, disabled: true, reason: AUTO_MERGE_NEEDS_BRANCH };
  return { visible: input.hasRepository, checked: input.value, disabled: false, reason: null };
}

/** The switch's stored value after the branch box changes: unchecking turns it off, and checking again does not turn it back on. */
export function autoMergeAfterBranchChange(createBranch: boolean, value: boolean): boolean {
  return createBranch ? value : false;
}

/** The start request's options. `autoMerge` is sent only with a linked repository, and is false without a separate branch. */
export function startOptions(input: {
  executorId: string;
  createBranch: boolean;
  hasRepository: boolean;
  autoMerge: boolean;
  workflowId: string;
  skippedStepIds: string[];
}): Required<Pick<ExecutePlanItemOptions, 'executorId' | 'createBranch'>> & Pick<ExecutePlanItemOptions, 'workflowId' | 'skippedStepIds' | 'autoMerge'> {
  return {
    executorId: input.executorId,
    createBranch: input.createBranch,
    ...(input.hasRepository ? { autoMerge: input.createBranch && input.autoMerge } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.skippedStepIds.length ? { skippedStepIds: input.skippedStepIds } : {}),
  };
}
