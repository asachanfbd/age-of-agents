import { useMemo, useRef, useState } from 'react';
import { useWorldStore } from '../store/worldStore';
import type { WorldState } from '../store/worldStore';
import { buildYardModel, projectRuns, sameYardCommandRuns, sameYardTestRuns, workspaceTotals } from './villageYard';
import type { WorkspaceTotals, YardCommandRun, YardModel, YardTestRun } from './villageYard';

const NO_RUNS: never[] = [];

type YardSlices = Pick<WorldState, 'planByProject' | 'tasksById' | 'taskIdsByProject' | 'workflowRunsByProject'> & {
  commandRuns: readonly YardCommandRun[];
  testRuns: readonly YardTestRun[];
};

/** One Project's yard model from the store's slices (see `buildYardModel`). */
export function yardModelFor(projectId: string, slices: YardSlices): YardModel {
  return buildYardModel({
    projectId,
    items: slices.planByProject[projectId]?.items,
    tasksById: slices.tasksById,
    taskIds: slices.taskIdsByProject[projectId],
    workflowRuns: slices.workflowRunsByProject[projectId] ?? NO_RUNS,
    commandRuns: slices.commandRuns,
    testRuns: slices.testRuns,
  });
}

/**
 * Selects a list from the store, handing back the previous list while `same` holds. Command runs are
 * replaced on every streamed log chunk; comparing only what the yard reads keeps those chunks from
 * re-deriving any yard.
 */
export function useHeldList<T>(select: (state: WorldState) => T[], same: (a: readonly T[], b: readonly T[]) => boolean): T[] {
  const held = useRef<T[] | null>(null);
  return useWorldStore((state) => {
    const next = select(state);
    if (held.current && same(held.current, next)) return held.current;
    held.current = next;
    return next;
  });
}

/** The store's slices one yard reads; `projectId` null reads every Project's runs (the totals strip). */
function useYardSlices(projectId: string | null): YardSlices {
  const planByProject = useWorldStore((s) => s.planByProject);
  const tasksById = useWorldStore((s) => s.tasksById);
  const taskIdsByProject = useWorldStore((s) => s.taskIdsByProject);
  const workflowRunsByProject = useWorldStore((s) => s.workflowRunsByProject);
  const commandRuns = useHeldList((s) => projectRuns(s.commandRunsById, projectId), sameYardCommandRuns);
  const testRuns = useHeldList((s) => projectRuns(s.testRunsById, projectId), sameYardTestRuns);
  return useMemo(
    () => ({ planByProject, tasksById, taskIdsByProject, workflowRunsByProject, commandRuns, testRuns }),
    [planByProject, tasksById, taskIdsByProject, workflowRunsByProject, commandRuns, testRuns],
  );
}

/**
 * Hands back the previous value while its content is unchanged. The store's slices change for
 * reasons the yard doesn't show (an unrelated Project's task, a plan item's description), so this
 * keeps the scene from re-rendering — and re-diffing its yard — on every such update.
 */
function useStable<T>(value: T): T {
  const signature = JSON.stringify(value);
  const [held, setHeld] = useState({ value, signature });
  if (held.signature === signature) return held.value;
  setHeld({ value, signature });
  return value;
}

/** A Project's yard model, live from the store; the same object while nothing it shows changes. */
export function useYardModel(projectId: string): YardModel {
  const slices = useYardSlices(projectId);
  return useStable(useMemo(() => yardModelFor(projectId, slices), [projectId, slices]));
}

/** The workspace totals strip's exact counts, from every Project's yard model. */
export function useWorkspaceTotals(): WorkspaceTotals {
  const projects = useWorldStore((s) => s.projects);
  const slices = useYardSlices(null);
  return useStable(useMemo(() => workspaceTotals(projects.map((project) => yardModelFor(project.id, slices))), [projects, slices]));
}
