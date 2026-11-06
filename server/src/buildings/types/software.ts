import type { BuildingTypeDefinition, CapabilityDeclaration, FieldSpec, ValidationResult } from '../contract.ts';
import { CapabilityError } from '../../connections/rules.ts';
import { planItemsDb, stepRunsDb, workflowRunsDb } from '../../db/collections.ts';
import { describeTask, latestRun, listCompleted, parseCompletedFilter, parseTaskRef, boardNumber, TASK_NOT_FOUND, TASK_REPORT_LIMITS } from '../../connections/taskReports.ts';
import { GitError, validateRepository } from '../../projects/git.ts';

function validateCreate(input: unknown): ValidationResult {
  const { name, repositoryUrl } = (input ?? {}) as { name?: unknown; repositoryUrl?: unknown };
  if (typeof name !== 'string' || !name.trim()) return { ok: false, field: 'name', error: 'name is required' };
  if (typeof repositoryUrl !== 'string' || !repositoryUrl) return { ok: true, value: { name: name.trim() } };
  try {
    return { ok: true, value: { name: name.trim(), repositoryUrl: validateRepository(repositoryUrl) } };
  } catch (error) {
    if (error instanceof GitError) return { ok: false, field: 'repositoryUrl', error: error.message };
    throw error;
  }
}

const PLANNING_PROMPT_MAX = 10_000;

/** The Tasks that are not done, in board order, for a linked Building to read. */
const getOpenTasks: CapabilityDeclaration = {
  id: 'get-open-tasks',
  description: 'List the Tasks on this Building\'s board that are not done yet.',
  mode: 'read',
  inputs: [],
  outputs: [{
    name: 'tasks', type: 'array',
    items: { name: 'task', type: 'object', fields: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }, { name: 'status', type: 'string' }, { name: 'type', type: 'string' }] },
  }],
  async handle({ buildingId }) {
    const items = (await planItemsDb.find((item) => item.projectId === buildingId && item.status !== 'done')).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return { outputs: { tasks: items.map((item) => ({ id: item.id, title: item.title, status: item.status, type: item.type ?? 'task' })) } };
  },
};

const text = (name: string, description: string, max?: number): FieldSpec => ({ name, type: 'string', description, ...(max ? { max } : {}) });
const flag = (name: string): FieldSpec => ({ name, type: 'boolean' });
const stepFields: FieldSpec[] = [
  text('name', 'The step\'s name.'), text('state', 'pending, running, done, skipped, failed or stopped.'), { name: 'rounds', type: 'integer' },
  text('startedAt', 'When the first round started.'), text('finishedAt', 'When the latest round ended.'), text('summary', 'The agent\'s summary of the latest round, or the skip reason.'), flag('summaryTruncated'),
];

/** One task of this Building, by id or board number, with its description, status and step-by-step summary. */
const getTaskDetails: CapabilityDeclaration = {
  id: 'get-task-details',
  description: 'Read one task\'s description, status and step-by-step summary.',
  mode: 'read',
  inputs: [
    { name: 'id', type: 'string', max: TASK_REPORT_LIMITS.input, description: 'The task\'s id, as the task lists return it.' },
    { name: 'number', type: 'string', max: TASK_REPORT_LIMITS.input, description: 'The task\'s board number, such as 10.017.' },
  ],
  outputs: [
    text('id', ''), text('number', ''), text('title', ''), text('type', ''), text('createdAt', ''), text('updatedAt', ''),
    text('description', 'The description as written, cut at 20,000 characters.'), flag('descriptionTruncated'),
    text('status', 'ready, waiting, running, waiting-for-input, awaiting-approval, needs-attention, failed, stopped, completed or archived.'),
    text('phase', 'not-started, in-progress or completed.'), text('completedAt', ''),
    { name: 'activity', type: 'object', fields: [text('step', ''), text('progress', 'For example "2 of 5 done".')] },
    { name: 'runs', type: 'integer' },
    { name: 'steps', type: 'array', items: { name: 'step', type: 'object', fields: stepFields } }, { name: 'stepsTotal', type: 'integer' },
    { name: 'delivery', type: 'object', fields: [text('branch', ''), text('prUrl', ''), text('prState', 'open or merged.'), text('autoMerge', 'on, off or none.')] },
    text('outcome', 'A completed task\'s completion report, cut at 5,000 characters.'), flag('outcomeTruncated'), flag('truncated'),
  ],
  async handle({ buildingId }, inputs) {
    const ref = parseTaskRef(inputs);
    const item = 'id' in ref
      ? await planItemsDb.get(ref.id)
      : (await planItemsDb.find((candidate) => candidate.projectId === buildingId && boardNumber(candidate) === ref.number)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (!item || item.projectId !== buildingId) throw new CapabilityError(404, TASK_NOT_FOUND);
    const runs = await workflowRunsDb.find((run) => run.planItemId === item.id);
    const run = latestRun(item, runs);
    const stepRuns = run ? await stepRunsDb.find((round) => round.runId === run.id) : [];
    return { outputs: describeTask({ item, runs, stepRuns }) };
  },
};

/** Finished tasks, newest first, including those archived after being done. */
const listCompletedTasks: CapabilityDeclaration = {
  id: 'list-completed-tasks',
  description: 'List finished tasks.',
  mode: 'read',
  inputs: [
    { name: 'limit', type: 'integer', minValue: 1, maxValue: TASK_REPORT_LIMITS.pageMax, description: 'Tasks per page; 20 when omitted.' },
    text('cursor', 'The nextCursor of the previous page.', TASK_REPORT_LIMITS.input), text('since', 'Only tasks completed at or after this date or time.', TASK_REPORT_LIMITS.input),
    text('search', 'Only tasks whose title contains this text, ignoring case.', TASK_REPORT_LIMITS.input),
  ],
  outputs: [
    {
      name: 'tasks', type: 'array',
      items: { name: 'task', type: 'object', fields: [text('id', ''), text('number', ''), text('title', ''), text('type', ''), text('completedAt', ''), flag('hasPr'), flag('prMerged'), text('outcome', 'The start of the completion report on one line.')] },
    },
    { name: 'total', type: 'integer' }, text('nextCursor', 'Absent on the last page.'),
  ],
  async handle({ buildingId }, inputs) {
    const filter = parseCompletedFilter(inputs);
    const items = await planItemsDb.find((item) => item.projectId === buildingId);
    const runs = new Map((await workflowRunsDb.find((run) => run.projectId === buildingId)).map((run) => [run.id, run]));
    return { outputs: listCompleted(items, (item) => (item.workflowRunId ? runs.get(item.workflowRunId) : undefined), filter) };
  },
};

/** Starts a planning session exactly as the person would from the Building's chat, so the concurrency and folder rules apply unchanged. */
const startPlanningSession: CapabilityDeclaration = {
  id: 'start-planning-session',
  description: 'Start a planning session in this Building with the given prompt. Answers at once with the session\'s id.',
  mode: 'write',
  startsRun: true,
  inputs: [{ name: 'prompt', type: 'string', required: true, max: PLANNING_PROMPT_MAX, description: 'What the planning session should work on.' }],
  outputs: [{ name: 'sessionId', type: 'string' }],
  async handle({ buildingId, noteStarted }, inputs) {
    // Imported on use: the worker manager imports the connections service.
    const { workerManager, TaskConflictError, ProjectFolderBusyError } = await import('../../worker/workerManager.ts');
    const { planItemTitler } = await import('../../projects/planItemTitler.ts');
    try {
      const task = await workerManager.startTask({ projectId: buildingId, description: String(inputs.prompt).trim(), kind: 'plan' });
      await noteStarted(task.id);
      if (task.kind === 'plan') planItemTitler.requestSessionTitle(task);
      return { outputs: { sessionId: task.id }, runRef: task.id };
    } catch (error) {
      if (error instanceof TaskConflictError || error instanceof ProjectFolderBusyError || error instanceof GitError) throw new CapabilityError(409, (error as Error).message);
      throw error;
    }
  },
};

/** The software-development Project, unchanged: it keeps the central store and its own workflow engine. */
export const softwareType: BuildingTypeDefinition = {
  id: 'software',
  name: 'Software',
  description: 'Build and fix software in a Git repository: planned tasks, workflows, code, tests and pull requests.',
  category: 'Engineering',
  version: 1,
  look: { model: 'software', color: '#7295ad' },
  workspace: 'software',
  repository: true,
  validateCreate,
  slots: [
    { id: 'feature', label: 'Build a feature or change', usedWhen: 'A Task is started on a planned feature or change.', defaultWorkflowId: 'software-development' },
    { id: 'bug', label: 'Fix a bug', usedWhen: 'A Task is started to fix a reported bug.', defaultWorkflowId: 'bug-fix' },
  ],
  agents: [
    { id: 'engineer', label: 'Engineer', defaultAgentId: 'software-engineer' },
    { id: 'docs', label: 'Documentation and retro', defaultAgentId: 'documentation-n-retro-agent' },
  ],
  scheduledJobs: [],
  capabilities: [getOpenTasks, getTaskDetails, listCompletedTasks, startPlanningSession],
  events: [],
};
