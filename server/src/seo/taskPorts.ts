import type { ProjectRecord } from '../domain/types.ts';
import type { RunSnapshot } from './taskRules.ts';

/** A start that could not happen (no workflow for the slot, the workflow is disabled). Shown on the task. */
export class TaskStartError extends Error {}

/** The workflow runs behind agent tasks. The real one uses the worker manager; tests script it. */
export interface AgentRuns {
  start(input: { project: ProjectRecord; slotId: string; title: string; description: string }): Promise<{ runId: string; planItemId: string }>;
  /** The run's state, or null when it no longer exists. */
  state(runId: string): Promise<RunSnapshot | null>;
  /** The text of the outputs the run's steps produced, newest first. */
  outputs(runId: string): Promise<string[]>;
  /** Approves the run's waiting approval step. */
  approve(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
}

export interface SoftwareTarget { id: string; name: string }

/** Where the Building's link to a Software building stands. */
export type LinkLookup =
  | { state: 'linked'; target: SoftwareTarget }
  | { state: 'not-linked' }
  | { state: 'wrong-type'; name: string }
  | { state: 'no-capability'; name: string }
  | { state: 'missing' };

export type PlanningCall =
  | { state: 'done'; sessionId: string }
  | { state: 'awaiting-approval'; callId: string };

export type SessionStatus = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';

/** The Software building's "Start planning session" capability, reached through the Connections service. */
export interface Handoff {
  lookup(buildingId: string): Promise<LinkLookup>;
  /** Throws an Error whose message is the refusal shown to the person (busy folder, missing capability, timeout). */
  startPlanning(input: { buildingId: string; target: SoftwareTarget; prompt: string }): Promise<PlanningCall>;
  /** Where a call that waited for approval stands. */
  callResult(callId: string): Promise<{ state: 'waiting' | 'done' | 'failed'; sessionId: string | null; note: string | null }>;
  /** The planning session's present status; 'unknown' when the building or session is gone. */
  sessionStatus(targetBuildingId: string, sessionId: string): Promise<SessionStatus>;
}

export interface TaskPorts {
  runs: AgentRuns;
  handoff: Handoff;
  /** The host timezone, used for "today" when the Building sets none. */
  hostTimezone: () => string;
}

const defaults = (): TaskPorts => ({
  runs: daemonRuns,
  handoff: daemonHandoff,
  hostTimezone: () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
});

/** Workflow runs through the worker manager, loaded on use: the worker manager imports the SEO code through its lifecycle hooks. */
const daemonRuns: AgentRuns = {
  async start({ project, slotId, title, description }) {
    const [{ slotWorkflow }, { workerManager }, { createPlanItem, deletePlanItem }] = await Promise.all([
      import('../scheduler/runStarter.ts'), import('../worker/workerManager.ts'), import('../projects/planItemService.ts'),
    ]);
    let workflow;
    try { workflow = await slotWorkflow(project, slotId); } catch (error) { throw new TaskStartError((error as Error).message); }
    const item = await createPlanItem({ projectId: project.id, title, description });
    try {
      const run = await workerManager.executePlanItem(item.id, { workflow });
      return { runId: run.id, planItemId: item.id };
    } catch (error) {
      await deletePlanItem(item.id);
      throw new TaskStartError((error as Error).message);
    }
  },
  async state(runId) {
    const [{ workflowRunsDb }, { runStateOf }] = await Promise.all([import('../db/collections.ts'), import('../scheduler/runStarter.ts')]);
    const run = await workflowRunsDb.get(runId);
    return run ? runStateOf(run) : null;
  },
  async outputs(runId) {
    const { stepRunsDb } = await import('../db/collections.ts');
    const rounds = (await stepRunsDb.find((s) => s.runId === runId)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return rounds.flatMap((round) => round.outputs.map((o) => o.content));
  },
  async approve(runId) {
    const { workerManager } = await import('../worker/workerManager.ts');
    await workerManager.approveWorkflowRun(runId);
  },
  async stop(runId) {
    const { workerManager } = await import('../worker/workerManager.ts');
    await workerManager.stopWorkflowRun(runId);
  },
};

const CAPABILITY = 'start-planning-session';

const daemonHandoff: Handoff = {
  async lookup(buildingId) {
    const [{ buildingLinksDb, projectsDb }, { getBuildingType }] = await Promise.all([import('../db/collections.ts'), import('../buildings/registry.ts')]);
    const links = await buildingLinksDb.find((l) => l.fromBuildingId === buildingId);
    if (!links.length) return { state: 'not-linked' };
    let sawOther: string | null = null;
    let sawSoftware: string | null = null;
    for (const link of links) {
      const target = await projectsDb.get(link.toBuildingId);
      if (!target) continue;
      const type = getBuildingType(target.typeId ?? 'software');
      if (type?.id !== 'software') { sawOther = target.name; continue; }
      if (link.capabilities.some((g) => g.capabilityId === CAPABILITY)) return { state: 'linked', target: { id: target.id, name: target.name } };
      sawSoftware = target.name;
    }
    if (sawSoftware) return { state: 'no-capability', name: sawSoftware };
    if (sawOther) return { state: 'wrong-type', name: sawOther };
    return { state: 'missing' };
  },
  async startPlanning({ buildingId, target, prompt }) {
    const { connections } = await import('../connections/index.ts');
    const outcome = await connections.call({ caller: { kind: 'person', buildingId }, targetBuildingId: target.id, capabilityId: CAPABILITY, inputs: { prompt } });
    if (outcome.status === 202) return { state: 'awaiting-approval', callId: outcome.body.callId };
    return { state: 'done', sessionId: String(outcome.body.outputs?.sessionId ?? outcome.body.runRef ?? '') };
  },
  async callResult(callId) {
    const { activityLogDb } = await import('../db/collections.ts');
    const entry = await activityLogDb.get(callId);
    if (!entry) return { state: 'failed', sessionId: null, note: 'The call is no longer in the Activity log' };
    if (entry.result === 'awaiting-approval') return { state: 'waiting', sessionId: null, note: 'Waiting for approval in Connections' };
    return entry.result === 'ok' ? { state: 'done', sessionId: entry.runRef, note: null } : { state: 'failed', sessionId: null, note: entry.message };
  },
  async sessionStatus(targetBuildingId, sessionId) {
    const { projectsDb, tasksDb } = await import('../db/collections.ts');
    if (!(await projectsDb.get(targetBuildingId))) return 'unknown';
    const task = await tasksDb.get(sessionId);
    if (!task) return 'unknown';
    switch (task.status) {
      case 'developing': case 'blocked': return 'running';
      case 'done': return 'done';
      case 'failed': return 'failed';
      case 'stopped': return 'stopped';
      default: return 'unknown';
    }
  },
};

let current = defaults();
export const taskPorts = (): TaskPorts => current;

/** Test seam: replaces some ports. */
export function configureTaskPorts(patch: Partial<TaskPorts>): void {
  current = { ...current, ...patch };
}

export function resetTaskPorts(): void {
  current = defaults();
}
