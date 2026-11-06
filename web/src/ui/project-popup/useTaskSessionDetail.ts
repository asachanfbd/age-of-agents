import { useMemo } from 'react';
import { chainFor, chainHistoryIds, groupTaskChains } from '../../lib/taskChain';
import { useWorldStore } from '../../store/worldStore';

/**
 * Which Task's session is open in a list pane. A follow-up creates a new linked Task per turn rather
 * than mutating one, so the open Task is grouped back into its conversation chain: the session opens
 * on the chain's latest Task (`activeTaskId`) with the earlier turns as `historyIds`.
 *
 * `detailTaskId` lives in the store (`workspaceDetailTaskId`), not local state, so
 * `openNotificationTarget` can deep-link into a task's session from outside this component's tree
 * (the notifications drawer, a toast). `openWorkspace` resets it on every call — see its own doc
 * comment in `store/worldStore.ts`.
 */
export function useTaskSessionDetail(taskIds: string[]) {
  const tasksById = useWorldStore((s) => s.tasksById);
  const detailTaskId = useWorldStore((s) => s.workspaceDetailTaskId);
  const setDetailTaskId = useWorldStore((s) => s.setWorkspaceDetailTaskId);
  const detailTask = detailTaskId ? tasksById[detailTaskId] : undefined;
  const chains = useMemo(() => (detailTask ? groupTaskChains(taskIds, tasksById, detailTask.kind) : []), [detailTask, taskIds, tasksById]);
  const chain = detailTaskId ? chainFor(detailTaskId, chains) : undefined;
  return {
    detailTaskId,
    setDetailTaskId,
    activeTaskId: chain ? chain[0]!.id : detailTaskId,
    historyIds: chainHistoryIds(chain),
  };
}
