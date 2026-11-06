import { useState } from 'react';
import type { CardDetail, RunFocus } from '../../lib/taskBoard';
import { useTaskSessionDetail } from './useTaskSessionDetail';

/**
 * Which detail a clicked task card has open (`lib/taskBoard.ts#cardDetail`): its WorkflowRun, its
 * Task's session (grouped into its conversation chain, `useTaskSessionDetail`), or the plan item's own
 * details. At most one is set; `show(null)` goes back to the list. `runFocus` is the step round a run
 * was asked to open on, if any. Shared by the Tasks board and the Archived tab.
 */
export function useCardDetail(taskIds: string[], initialRunId: string | null = null) {
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [runFocus, setRunFocus] = useState<RunFocus | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const { setDetailTaskId, activeTaskId, historyIds } = useTaskSessionDetail(taskIds);

  function show(detail: CardDetail | null) {
    setRunId(detail?.kind === 'run' ? detail.id : null);
    setDetailTaskId(detail?.kind === 'task' ? detail.id : null);
    setItemId(detail?.kind === 'item' ? detail.id : null);
    setRunFocus(detail?.kind === 'run' ? detail.focus ?? null : null);
  }

  return { runId, runFocus, taskId: activeTaskId, historyIds, itemId, show };
}
