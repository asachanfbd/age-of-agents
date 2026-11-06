import { useMemo } from 'react';
import { useWorldStore } from '../store/worldStore';
import type { FooterBoards } from '../lib/footerPopovers';

/** The store slices every footer list is built from, memoised so a list rebuilds only when one changes. */
export function useFooterBoards(): FooterBoards {
  const projects = useWorldStore((s) => s.projects);
  const planByProject = useWorldStore((s) => s.planByProject);
  const taskIdsByProject = useWorldStore((s) => s.taskIdsByProject);
  const workflowRunsByProject = useWorldStore((s) => s.workflowRunsByProject);
  const tasksById = useWorldStore((s) => s.tasksById);
  const executors = useWorldStore((s) => s.executors);
  const planItemQueueByProject = useWorldStore((s) => s.planItemQueueByProject);
  return useMemo(
    () => ({ projects, planByProject, taskIdsByProject, workflowRunsByProject, tasksById, executors, planItemQueueByProject }),
    [projects, planByProject, taskIdsByProject, workflowRunsByProject, tasksById, executors, planItemQueueByProject],
  );
}
