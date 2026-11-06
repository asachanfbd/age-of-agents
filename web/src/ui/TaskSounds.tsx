import { useEffect, useRef } from 'react';
import { useWorldStore } from '../store/worldStore';
import { getSoundsMuted } from '../lib/soundPreference';
import {
  TASK_SOUND_URLS,
  allWorkflowRuns,
  attentionAutoMergeItemIds,
  attentionTaskIds,
  attentionWorkflowRunIds,
  completedTaskIds,
  autoMergeOnItemIds,
  completedWorkflowRunIds,
  mergedAutoMergeItemIds,
  snapshotAutoMergeStates,
  snapshotRunStates,
  snapshotTaskStates,
  type StatusSnapshot,
  type TaskSound,
} from '../lib/taskSounds';

/**
 * Plays the "under attack" horn when a Task or WorkflowRun needs attention, and the "create" chime
 * when one completes (with Auto-merge on, when its PR is merged) — see `lib/taskSounds.ts` for exactly which status transitions count. Like the
 * toast stack, whatever is already loaded at mount is baselined silently; only a live transition
 * plays a sound.
 */
export function TaskSounds() {
  const tasksById = useWorldStore((s) => s.tasksById);
  const workflowRunsByProject = useWorldStore((s) => s.workflowRunsByProject);
  const planByProject = useWorldStore((s) => s.planByProject);
  const taskSnapshotRef = useRef<StatusSnapshot | null>(null);
  const runSnapshotRef = useRef<StatusSnapshot | null>(null);
  const autoMergeSnapshotRef = useRef<StatusSnapshot | null>(null);

  useEffect(() => {
    const runs = allWorkflowRuns(workflowRunsByProject);
    const previousTasks = taskSnapshotRef.current;
    const previousRuns = runSnapshotRef.current;
    taskSnapshotRef.current = snapshotTaskStates(tasksById);
    runSnapshotRef.current = snapshotRunStates(runs);
    const previousAutoMerge = autoMergeSnapshotRef.current;
    const autoMerge = snapshotAutoMergeStates(planByProject);
    autoMergeSnapshotRef.current = autoMerge;
    // First render for this session: nothing to compare against yet, so anything already sitting in
    // an attention/done state is history, not a live transition.
    if (!previousTasks || !previousRuns || !previousAutoMerge) return;

    // A run that ends with Auto-merge on is not "done" yet: the chime comes with the merge.
    const autoMergeItems = autoMergeOnItemIds(planByProject);
    const needsAttention = attentionTaskIds(previousTasks, tasksById).length > 0
      || attentionWorkflowRunIds(previousRuns, runs).length > 0
      || attentionAutoMergeItemIds(previousAutoMerge, autoMerge).length > 0;
    const completed = completedTaskIds(previousTasks, tasksById, autoMergeItems).length > 0
      || completedWorkflowRunIds(previousRuns, runs, autoMergeItems).length > 0
      || mergedAutoMergeItemIds(previousAutoMerge, autoMerge).length > 0;

    // Attention wins if both land in the same tick (e.g. a run needs a decision the same moment
    // another Task finishes) — it's the more actionable cue.
    if (needsAttention) playTaskSound('attention');
    else if (completed) playTaskSound('complete');
  }, [tasksById, workflowRunsByProject, planByProject]);

  return null;
}

function playTaskSound(sound: TaskSound): void {
  if (getSoundsMuted()) return;
  // Browsers reject autoplay until the page has had a user gesture; a missed cue is harmless.
  new Audio(TASK_SOUND_URLS[sound]).play().catch(() => {});
}
