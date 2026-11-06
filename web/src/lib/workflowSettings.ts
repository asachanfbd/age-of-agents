import { workerLabel } from './projectTasks';
import type { ExecutorProfile, WorkflowAgentConfig, WorkflowRecord, WorkflowStep } from './serverApi';
import type { ProjectData } from '../types';

/**
 * The Catalog Workflow a Project falls back to when it has no `workflowId` of its own — mirrors
 * server/src/catalog/workflowService.ts's default. There is no client-side way to know the server's
 * exact default-resolution rule, so this is a "good enough" guess for the "Default" badge only.
 */
export const DEFAULT_WORKFLOW_ID = 'software-development';

/**
 * Which badge (if any) a Workflow card should show for this Project: "current" when it's the
 * Project's explicit choice, "default" when the Project has none set and this is the Catalog's
 * presumed fallback, or null for every other Workflow in the list.
 */
export function workflowBadge(project: Pick<ProjectData, 'workflowId'>, workflow: Pick<WorkflowRecord, 'id'>): 'current' | 'default' | null {
  if (project.workflowId) return workflow.id === project.workflowId ? 'current' : null;
  return workflow.id === DEFAULT_WORKFLOW_ID ? 'default' : null;
}

/** The Workflows a Project or a new task may use — a disabled one is never offered. */
export const enabledWorkflows = <T extends Pick<WorkflowRecord, 'enabled'>>(workflows: T[]): T[] => workflows.filter((workflow) => workflow.enabled);

/**
 * The Workflow the start dialog pre-selects from `enabled`: the Project's own, else the Catalog's
 * default, else the only one there is — or '' when there's no obvious pick.
 */
export function initialStartWorkflowId(project: Pick<ProjectData, 'workflowId'>, enabled: Pick<WorkflowRecord, 'id'>[]): string {
  const ids = enabled.map((workflow) => workflow.id);
  const preferred = [project.workflowId, DEFAULT_WORKFLOW_ID].find((id) => !!id && ids.includes(id));
  return preferred ?? (ids.length === 1 ? ids[0]! : '');
}

/** A stage's agent display name — the resolved Catalog agent's name, or its raw id when the agent no longer resolves (deleted from the Catalog since the Workflow was saved). */
export function stageAgentLabel(config: Pick<WorkflowAgentConfig, 'agentId' | 'agent'>): string {
  return config.agent?.name ?? config.agentId;
}

/**
 * "Loops back to <step name> up to N times" for a loop-origin step, resolving the target step's
 * name from the same Workflow's `steps`; null for a step that isn't a loop origin. Falls back to
 * the raw target id if it isn't found in `steps` (shouldn't happen for a valid Workflow, but keeps
 * this from throwing on a stale/edited-elsewhere snapshot).
 */
export function loopBackLabel(step: Pick<WorkflowStep, 'loopBack'>, steps: Pick<WorkflowStep, 'id' | 'name'>[]): string | null {
  const loopBack = step.loopBack;
  if (!loopBack) return null;
  const target = steps.find((candidate) => candidate.id === loopBack.toStepId);
  const times = loopBack.maxRounds === 1 ? 'time' : 'times';
  return `Loops back to ${target?.name ?? loopBack.toStepId} up to ${loopBack.maxRounds} ${times}`;
}

/** A stage's executor override display name, or null when it runs on the Workflow run's own executor. */
export function stageExecutorLabel(config: Pick<WorkflowAgentConfig, 'executorId'>, executors: Pick<ExecutorProfile, 'id' | 'label'>[]): string | null {
  return config.executorId ? workerLabel(executors, config.executorId) : null;
}
