import { getBuildingType } from '../buildings/registry.ts';
import { resolveTypeConfig, withStepAgents } from '../buildings/slotConfig.ts';
import { CommandAlreadyRunningError, CommandRunNotFoundError } from '../commands/commandRunner.ts';
import type { CommandRunner } from '../commands/commandRunner.ts';
import { getAgent, getDefaultAgent } from '../catalog/catalogService.ts';
import { getWorkflow } from '../catalog/workflowService.ts';
import { stepRunsDb, workflowRunsDb } from '../db/collections.ts';
import type { CommandRunRecord, ProjectRecord, WorkflowRecord, WorkflowRunRecord } from '../domain/types.ts';
import { createPlanItem, deletePlanItem } from '../projects/planItemService.ts';
import { ProjectFolderBusyError, TaskConflictError } from '../worker/workerManager.ts';
import type { WorkerManager } from '../worker/workerManager.ts';
import type { Connections } from '../connections/service.ts';
import { withApprovalGate } from './guardrails.ts';
import { NoFreeSlotError, SkipStartError } from './scheduler.ts';
import type { RunListener, RunStarter, RunState } from './scheduler.ts';
import type { ScheduledJobRecord } from './types.ts';

/**
 * Starts a scheduled job's run as an ordinary WorkflowRun through the worker manager, so it appears on the Tasks
 * board, raises the usual notifications and takes the usual approve / request changes / stop actions. Each run gets
 * its own PlanItem, marked with the job's id.
 */

export const SCHEDULED_PROMPT_WORKFLOW_ID = 'scheduled-prompt';

/** A single agent prompt as a one-step workflow: the prompt is the task, and the step ends when the agent reports it done. */
async function promptWorkflow(job: ScheduledJobRecord, agentId: string | null): Promise<WorkflowRecord> {
  const agent = agentId ? await getAgent(agentId) : await getDefaultAgent();
  if (!agent) throw new Error(`Agent "${agentId}" is no longer in the Catalog`);
  return {
    id: SCHEDULED_PROMPT_WORKFLOW_ID,
    name: job.name,
    description: 'A scheduled job\'s single agent prompt.',
    enabled: true,
    steps: [{
      id: 'prompt', name: job.name, agentId: agent.id, canEditCode: true, requiresApproval: false, quickLook: 'none',
      instructions: 'Carry out the task described above. When it is done, complete the step with a short summary of what you did.',
    }],
  };
}

export async function slotWorkflow(project: ProjectRecord, slotId: string): Promise<WorkflowRecord> {
  const typeId = project.typeId ?? 'software';
  const type = getBuildingType(typeId);
  if (!type?.slots.some((slot) => slot.id === slotId)) throw new Error(`This Building's type no longer has the workflow slot "${slotId}"`);
  const resolved = (await resolveTypeConfig(typeId)).find((slot) => slot.slot.id === slotId)!;
  const workflow = await getWorkflow(resolved.effectiveWorkflowId);
  if (!workflow?.enabled) throw new Error(`The workflow for "${resolved.slot.label}" is missing or disabled in the Catalog`);
  return withStepAgents(typeId, workflow);
}

type WorkflowJob = ScheduledJobRecord & { target: Exclude<ScheduledJobRecord['target'], { kind: 'capability' | 'action' | 'command' }> };

async function workflowFor(project: ProjectRecord, job: WorkflowJob): Promise<WorkflowRecord> {
  const workflow = job.target.kind === 'slot' ? await slotWorkflow(project, job.target.slotId) : await promptWorkflow(job, job.target.agentId);
  return job.needsApproval ? { ...workflow, steps: withApprovalGate(workflow.steps) } : workflow;
}

/**
 * A run as the scheduler sees it. A run that needs attention because its step ended without completing has failed
 * (or was stopped, when that is how the step ended); one that is only waiting for an answer is still going.
 */
export async function runStateOf(run: WorkflowRunRecord): Promise<RunState> {
  switch (run.status) {
    case 'completed': return { status: 'succeeded', note: null };
    case 'stopped': return { status: 'stopped', note: 'Stopped by a person' };
    case 'awaiting-approval': return { status: 'awaiting-approval', note: 'Waiting for approval' };
    case 'failed':
      return { status: 'failed', note: run.startup?.steps.find((step) => step.state === 'failed')?.reason ?? run.attentionReason ?? 'The run failed' };
    case 'needs-attention': {
      const rounds = await stepRunsDb.find((stepRun) => stepRun.runId === run.id && stepRun.stepId === run.currentStepId);
      const latest = rounds.sort((a, b) => a.round - b.round).at(-1)?.status;
      const status = latest === 'failed' ? 'failed' : latest === 'stopped' ? 'stopped' : 'running';
      return { status, note: run.attentionReason };
    }
    default: return { status: 'running', note: null };
  }
}

/**
 * Runs a Building type's in-process actions (an SEO data fetch). `start` throws `SkipStartError` for a conflict that is not
 * a failure; `onChanged` fires with a run id when that run's state changes.
 */
export interface ActionRunner {
  start(request: { project: ProjectRecord; actionId: string }): Promise<{ runId: string }>;
  state(runId: string): RunState | null;
  onChanged(listener: (runId: string) => void): () => void;
}

/** The part of the command runner a command job uses. */
export type CommandRunPort = Pick<CommandRunner, 'runCommand' | 'getCommandRun' | 'onCommandEvent'>;

/** A command job's run is tracked as `command:<command run id>`. */
const COMMAND_RUN_PREFIX = 'command:';

const SPAWN_FAILURE = /Failed to start: .*$/m;

/** A command run as the scheduler sees it. A run that never started has no exit code; its spawn error is in the output. */
export function commandRunStateOf(run: CommandRunRecord): RunState {
  switch (run.status) {
    case 'success': return { status: 'succeeded', note: null };
    case 'stopped': return { status: 'stopped', note: 'Stopped by a person' };
    case 'failed': return { status: 'failed', note: run.exitCode !== null ? `Exited with code ${run.exitCode}` : (SPAWN_FAILURE.exec(run.output)?.[0] ?? 'The command failed') };
    default: return { status: 'running', note: null };
  }
}

const ACTION_RUN_PREFIX = 'action:';

/** A capability job's call is tracked as `call:<call id>`; every other run id is a WorkflowRun's. */
const CALL_RUN_PREFIX = 'call:';

async function commandStateOf(commands: CommandRunPort | undefined, runId: string): Promise<RunState | null> {
  if (!commands) return null;
  try {
    return commandRunStateOf(await commands.getCommandRun(runId.slice(COMMAND_RUN_PREFIX.length)));
  } catch (error) {
    if (error instanceof CommandRunNotFoundError) return null;
    throw error;
  }
}

export function createManagerRunStarter(
  manager: Pick<WorkerManager, 'executePlanItem' | 'hasFreeSlot' | 'onWorkerEvent'>,
  connections: Pick<Connections, 'callFromJob' | 'callState' | 'onCallChanged'>,
  actions?: ActionRunner,
  commands?: CommandRunPort,
): RunStarter {
  return {
    async start({ project, job, chainDepth }) {
      if (job.target.kind === 'action') {
        if (!actions) throw new Error('This daemon has no runner for the Building\'s actions');
        return actions.start({ project, actionId: job.target.actionId });
      }
      if (job.target.kind === 'command') {
        if (!commands) throw new Error('This daemon has no runner for saved commands');
        try {
          return { runId: `${COMMAND_RUN_PREFIX}${(await commands.runCommand(job.target.commandId, { automatic: true })).id}` };
        } catch (error) {
          if (error instanceof CommandAlreadyRunningError) throw new SkipStartError(error.message);
          throw error;
        }
      }
      if (job.target.kind === 'capability') {
        const { targetBuildingId, capabilityId, inputs } = job.target;
        return connections.callFromJob({ buildingId: project.id, jobId: job.id, targetBuildingId, capabilityId, inputs, depth: (chainDepth ?? 0) + 1 });
      }
      const workflowJob = job as WorkflowJob;
      const workflow = await workflowFor(project, workflowJob);
      if (!(await manager.hasFreeSlot(project.id))) throw new NoFreeSlotError();
      const item = await createPlanItem({
        projectId: project.id,
        title: workflowJob.name,
        description: workflowJob.target.kind === 'slot' ? workflowJob.target.description : workflowJob.target.prompt,
        scheduledJobId: workflowJob.id,
      });
      try {
        return { runId: (await manager.executePlanItem(item.id, { workflow })).id };
      } catch (error) {
        await deletePlanItem(item.id);
        // Lost the slot, or the Building's folder, to a start that got there first.
        if (error instanceof TaskConflictError || error instanceof ProjectFolderBusyError) throw new NoFreeSlotError();
        throw error;
      }
    },

    async state(runId) {
      if (runId.startsWith(ACTION_RUN_PREFIX)) return actions?.state(runId) ?? null;
      if (runId.startsWith(CALL_RUN_PREFIX)) return connections.callState(runId);
      if (runId.startsWith(COMMAND_RUN_PREFIX)) return commandStateOf(commands, runId);
      const run = await workflowRunsDb.get(runId);
      return run ? runStateOf(run) : null;
    },

    subscribe(listener: RunListener) {
      // Reading a run's state takes a varying number of steps, so the reads are chained: states reach the scheduler in
      // the order their events were emitted, and a run that failed and was retried never ends up recorded as failed.
      let delivered: Promise<void> = Promise.resolve();
      const deliver = (runId: string, read: () => Promise<RunState | null>) => {
        delivered = delivered.then(read).then((state) => listener.runChanged(runId, state))
          .catch((error) => console.error(`Scheduler could not read run ${runId}:`, error));
      };
      const offCalls = connections.onCallChanged((callId) => deliver(`${CALL_RUN_PREFIX}${callId}`, () => connections.callState(`${CALL_RUN_PREFIX}${callId}`)));
      const offWorker = manager.onWorkerEvent((event) => {
        if (event.type === 'workflowRunDeleted') deliver(event.runId, async () => null);
        if (event.type === 'workflowRun') deliver(event.run.id, () => runStateOf(event.run));
        if (event.type === 'task' && ['done', 'failed', 'stopped'].includes(event.task.status)) listener.slotFreed(event.task.projectId);
      });
      // Only runs the scheduler started are marked automatic; a person's run of the same command is none of its business.
      const offCommands = commands?.onCommandEvent((event) => {
        if (event.type === 'commandRun' && event.run.automatic && event.run.origin === 'saved') {
          deliver(`${COMMAND_RUN_PREFIX}${event.run.id}`, async () => commandRunStateOf(event.run));
        }
      }) ?? (() => undefined);
      const offActions = actions?.onChanged((runId) => deliver(runId, async () => actions.state(runId))) ?? (() => undefined);
      return () => { offCalls(); offWorker(); offActions(); offCommands(); };
    },
  };
}
