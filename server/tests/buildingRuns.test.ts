import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import { autoAdvanceTerminalSteps } from './helpers/terminalStepFakes.ts';

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let slotConfig: typeof import('../src/buildings/slotConfig.ts');
let collections: typeof import('../src/db/collections.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'building-runs-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  // The Notes type's default workflow comes from a fixture copy, so the real Catalog can be edited freely.
  await cp(path.join(import.meta.dirname, 'fixtures', 'notes-workflows', 'notes-review.json'), path.join(process.env.AGENT_VISUAL_OS_CATALOG_DIR, 'workflows', 'notes-review.json'));
  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  slotConfig = await import('../src/buildings/slotConfig.ts');
  collections = await import('../src/db/collections.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function summarizerTurn(): Promise<ClaudeTurnResult> {
  return { sessionId: 's', status: 'done', message: 'ok', extra: { tldr: 'Done.', requirement: 'r', whatWasDeveloped: 'd', reviewHighlights: 'none', docsUpdated: 'none', retroUpdates: 'none' }, raw: { type: 'result' } };
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 15_000) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runNotesItem(name: string) {
  const project = await projectService.createProject({ name, position: null, typeId: 'notes' });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Review', description: 'Review the notes.' });
  const ref: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(ref, { 'review-notes': (id) => ref.current!.completeStep(id, { summary: 'Reviewed.' }) });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: summarizerTurn, terminalSessions: host });
  ref.current = manager;
  const first = await manager.executePlanItem(item.id);
  await waitUntil(async () => (await planItemService.getPlanItem(item.id)).status === 'done');
  return { project, item, manager, runId: first.id, first };
}

test('I54 a Notes run uses the type\'s default workflow in the Building\'s own folder: no branch, no worktree, no pull request, same steps and completion', async () => {
  const { project, manager, runId } = await runNotesItem('Notes Run');
  const detail = await manager.getWorkflowRunDetail(runId);
  assert.equal(detail.run.workflowId, 'notes-review');
  assert.equal(detail.run.status, 'completed');
  assert.deepEqual([detail.run.branch, detail.run.worktreePath, detail.run.prUrl], [undefined, undefined, null]);
  assert.deepEqual(detail.steps.map((s) => [s.step.id, s.rounds.at(-1)?.status]), [['review-notes', 'done']]);
  await assert.rejects(stat(path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, '.worktrees', project.slug)), /ENOENT/);
});

test('I59 every Task of a run carries the single local owner and tenant', async () => {
  const { project } = await runNotesItem('Owned Run');
  const tasks = await collections.tasksDb.find((t) => t.projectId === project.id);
  assert.ok(tasks.length > 0);
  for (const task of tasks) assert.deepEqual([task.ownerId, task.tenantId], ['local-user', 'local-tenant']);
});

test('I53/I56 a run uses the workflow and per-step agent configured for its type, and a later change leaves a started run\'s snapshot alone', async () => {
  await slotConfig.setSlotConfig('notes', 'review', { stepAgents: { 'review-notes': 'builder' } });
  const { runId, manager } = await runNotesItem('Configured Run');
  const detail = await manager.getWorkflowRunDetail(runId);
  assert.equal(detail.run.workflowSnapshot.steps[0]?.agentId, 'builder', 'the snapshot holds the configured agent');

  await slotConfig.resetSlotConfig('notes', 'review');
  assert.equal((await manager.getWorkflowRunDetail(runId)).run.workflowSnapshot.steps[0]?.agentId, 'builder', 'resetting the configuration does not rewrite a started run');
  const next = await runNotesItem('Default Run');
  assert.equal((await next.manager.getWorkflowRunDetail(next.runId)).run.workflowSnapshot.steps[0]?.agentId, 'manager');
});

test('a Software Building with no configuration still runs the Catalog default, as before Building Types', async () => {
  const project = await projectService.createProject({ name: 'Soft Run', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Do', description: 'Do it.' });
  const ref: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host } = autoAdvanceTerminalSteps(ref, { development: (id) => ref.current!.completeStep(id, { summary: 'Done.' }) });
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: summarizerTurn, terminalSessions: host });
  ref.current = manager;
  const first = await manager.executePlanItem(item.id);
  assert.equal((await manager.getWorkflowRunDetail(first.id)).run.workflowId, 'software-development');
});
