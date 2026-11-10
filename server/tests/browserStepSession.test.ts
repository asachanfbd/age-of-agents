import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ClaudeTurnResult } from '../src/worker/claudeProcess.ts';
import type { TaskRecord } from '../src/domain/types.ts';
import { settledExecute } from './helpers/startRun.ts';
import { autoAdvanceTerminalSteps } from './helpers/terminalStepFakes.ts';

/** A workflow step with `canUseBrowser` launches its session with the headless browser (or, when it isn't installed, without it and with a prompt saying so). */

let tempRoot: string;
let projectService: typeof import('../src/projects/projectService.ts');
let planItemService: typeof import('../src/projects/planItemService.ts');
let workflowService: typeof import('../src/catalog/workflowService.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let browserTool: typeof import('../src/terminal/browserTool.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'browser-step-session-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  projectService = await import('../src/projects/projectService.ts');
  planItemService = await import('../src/projects/planItemService.ts');
  workflowService = await import('../src/catalog/workflowService.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  browserTool = await import('../src/terminal/browserTool.ts');
  await workflowService.updateWorkflow('software-development', {
    name: 'Browser Test Workflow',
    description: 'One browser step.',
    steps: [
      { id: 'review', name: 'Review', agentId: 'builder', canEditCode: false, canRunCommands: true, canUseBrowser: true, requiresApproval: false, instructions: 'Review it.' },
    ],
  });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fakeSummarizerTurn(): Promise<ClaudeTurnResult> {
  return { sessionId: 's', status: 'done', message: 'ok', extra: { tldr: 'Done.', requirement: 'r', whatWasDeveloped: 'd', reviewHighlights: 'n', docsUpdated: 'n', retroUpdates: 'n' }, raw: { type: 'result' } };
}

async function launch(name: string, availability: ReturnType<typeof browserTool.checkBrowserAvailability>) {
  const project = await projectService.createProject({ name, position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: `${name} item`, description: 'A UI task.' });
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {});
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host, checkBrowserAvailability: () => availability });
  managerRef.current = manager;
  const first = await settledExecute(manager)(item.id);
  const run = (await manager.getWorkflowRunDetail(first.workflowRunId!)).run;
  const task: TaskRecord = await manager.getTask(first.id);
  return { run, task, start: starts.find((s) => s.taskId === first.id)! };
}

test('an available browser: the snapshot and session setup keep the flag and the session registers the browser server', async () => {
  const { run, task, start } = await launch('Browser Available', { available: true, cliPath: '/pkg/cli.js' });
  assert.equal(run.workflowSnapshot.steps[0]?.canUseBrowser, true);
  assert.equal(task.sessionSetup?.browser, true);
  assert.equal(start.killProcessGroupOnExit, true);
  assert.deepEqual(start.mcpServers?.map((s) => s.name), ['agent_visual_os_step', 'agent_visual_os_tests', browserTool.BROWSER_MCP_SERVER_NAME]);
  assert.equal(start.mcpServers?.at(-1)?.args[0], '/pkg/cli.js');
  assert.match(start.prompt, /browser_navigate/);
  assert.doesNotMatch(start.prompt, /headless browser is NOT available/);
});

test('an unavailable browser: the session still starts without the browser server, the prompt says so and a warning is logged', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const { task, start } = await launch('Browser Missing', { available: false, reason: 'Chromium is not installed' });
  assert.equal(task.sessionSetup?.browser, true);
  assert.deepEqual(start.mcpServers?.map((s) => s.name), ['agent_visual_os_step', 'agent_visual_os_tests']);
  assert.match(start.prompt, /headless browser is NOT available/);
  assert.doesNotMatch(start.prompt, /browser_navigate/);
  assert.equal(warn.mock.calls.some((call) => /Browser unavailable.*Chromium is not installed/.test(String(call.arguments[0]))), true);
});

test('the availability reading taken for the prompt is the one used for the servers, even if the install changes in between', async () => {
  const readings = [{ available: true as const, cliPath: '/pkg/cli.js' }, { available: false as const, reason: 'gone' }];
  const project = await projectService.createProject({ name: 'Browser Single Probe', position: null });
  const item = await planItemService.createPlanItem({ projectId: project.id, title: 'Probe item', description: 'x' });
  const managerRef: { current?: ReturnType<typeof workerManagerModule.createWorkerManager> } = {};
  const { host, starts } = autoAdvanceTerminalSteps(managerRef, {});
  let calls = 0;
  const manager = workerManagerModule.createWorkerManager({ runClaudeTurn: fakeSummarizerTurn, terminalSessions: host, checkBrowserAvailability: () => readings[Math.min(calls++, 1)]! });
  managerRef.current = manager;
  const first = await settledExecute(manager)(item.id);
  const start = starts.find((s) => s.taskId === first.id)!;
  assert.equal(calls, 1, 'probed once per launch');
  assert.ok(start.mcpServers?.some((s) => s.name === browserTool.BROWSER_MCP_SERVER_NAME));
  assert.match(start.prompt, /browser_navigate/);
});

test('step permissions: a command-capable read-only step keeps its command list and gets the browser; a testing-setup run never does', async () => {
  const { workflowRunsDb } = await import('../src/db/collections.ts');
  const now = new Date().toISOString();
  const step = { id: 'review', name: 'Review', agentId: 'builder', canEditCode: false, canRunCommands: true, canUseBrowser: true, requiresApproval: false, instructions: 'x' };
  const insertRun = (id: string, testingSetup?: { mode: 'setup'; evidence: null }) => workflowRunsDb.insert({
    id, projectId: 'p-perm', planItemId: 'item', workflowId: 'w', workflowSnapshot: { id: 'w', name: 'w', description: 'w', enabled: true, steps: [step] },
    status: 'running', currentStepId: 'review', executorId: 'test-claude-cli', prUrl: null, completionReport: null, attentionReason: null, loopRoundAllowance: 0,
    createdAt: now, updatedAt: now, completedAt: null, ...(testingSetup ? { testingSetup } : {}),
  } as unknown as Parameters<typeof workflowRunsDb.insert>[0]);
  const taskFor = (runId: string) => ({ id: `${runId}-task`, workflowRunId: runId, workflowStepId: 'review' }) as TaskRecord;
  await insertRun('perm-run');
  await insertRun('perm-setup-run', { mode: 'setup', evidence: null });

  const normal = await workerManagerModule.resolveStepPermissions(taskFor('perm-run'), false);
  assert.equal(normal.canRunCommands, true);
  assert.equal(normal.canUseBrowser, true);
  assert.equal(normal.disallowedTools?.includes('Bash'), false, 'the shell stays allowed');
  assert.ok(normal.disallowedTools?.includes('Edit'));

  const setup = await workerManagerModule.resolveStepPermissions(taskFor('perm-setup-run'), false);
  assert.equal(setup.canUseBrowser, undefined);
  assert.equal(setup.canRunCommands, undefined);
  assert.ok(setup.disallowedTools?.includes('Bash'), 'a testing setup stays fully read-only');
  await workflowRunsDb.delete('perm-run');
  await workflowRunsDb.delete('perm-setup-run');
});

test('sessionMcpServers adds the browser only when asked and available; a missing install leaves it out and keeps the others', async () => {
  const task = { id: 'task-x', projectId: 'p-none', workflowRunId: 'run-x' } as TaskRecord;
  const available = () => ({ available: true as const, cliPath: '/pkg/cli.js' });
  const missing = () => ({ available: false as const, reason: 'not installed' });
  const names = async (browser: boolean, probe: () => ReturnType<typeof browserTool.checkBrowserAvailability> = available) => (await workerManagerModule.sessionMcpServers(task, true, browser, probe)).map((s) => s.name);
  assert.deepEqual(await names(true), ['agent_visual_os_step', 'agent_visual_os_tests', browserTool.BROWSER_MCP_SERVER_NAME]);
  assert.deepEqual(await names(false), ['agent_visual_os_step', 'agent_visual_os_tests']);
  const warn = (await import('node:test')).mock.method(console, 'warn', () => undefined);
  assert.deepEqual(await names(true, missing), ['agent_visual_os_step', 'agent_visual_os_tests']);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /Browser unavailable for task task-x: not installed/);
  warn.mock.restore();
  const planTask = { id: 'task-y', projectId: 'p-none', kind: 'plan' } as TaskRecord;
  assert.ok(!(await workerManagerModule.sessionMcpServers(planTask, false, false, available)).some((s) => s.name === browserTool.BROWSER_MCP_SERVER_NAME));
});
