import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import type { PlanItemRecord, ProjectRecord, TaskRecord } from '../src/domain/types.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';
import { startPullRequestHarness, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/**
 * The combined plan-and-bugs session: its kind, tools, instructions, task and bug filing, the
 * set_dependencies route and its refusals, and auto-completion with both kinds. The dependency
 * service runs for real on a fake git that reports no parent as merged.
 */

let h: PullRequestHarness;
let server: HttpServer;
let base: string;
let token: string;
let project: ProjectRecord;
let service: import('../src/projects/dependencyService.ts').DependencyService;
let sessionKinds: typeof import('../src/projects/sessionKinds.ts');
let dependenciesModule: typeof import('../src/projects/dependencies.ts');
let bugReportTool: typeof import('../src/terminal/bugReportTool.ts');
let workerManagerModule: typeof import('../src/worker/workerManager.ts');
let planModule: typeof import('../src/projects/plan.ts');

before(async () => {
  h = await startPullRequestHarness('plan-and-bugs-');
  sessionKinds = await import('../src/projects/sessionKinds.ts');
  dependenciesModule = await import('../src/projects/dependencies.ts');
  bugReportTool = await import('../src/terminal/bugReportTool.ts');
  workerManagerModule = await import('../src/worker/workerManager.ts');
  planModule = await import('../src/projects/plan.ts');
  token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
  const { createDependencyService } = await import('../src/projects/dependencyService.ts');
  const { createDaemonServer } = await import('../src/server.ts');
  const { createPlanItemTitler } = await import('../src/projects/planItemTitler.ts');
  service = createDependencyService({
    getProject: h.projectService.getProject,
    git: { checkedOutBranch: async () => 'main', branchHead: async () => null, isAncestor: async () => false, commitsAhead: async () => null, pullRequest: async () => null },
    syncOf: () => null,
    startPlanItem: async () => { throw new Error('no real runs in this test'); },
    enableAutoMerge: async (_projectId, id) => (await h.collections.planItemsDb.get(id))!,
    onWorkerEvent: () => () => undefined,
    onProjectSync: () => () => undefined,
    publish: () => undefined,
  });
  server = createDaemonServer({
    dependencies: service,
    planItemTitler: { ...createPlanItemTitler(), requestTitle: () => {}, requestSessionTitle: () => {} },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  base = `http://127.0.0.1:${address.port}`;
  project = await h.createProject('Plan and bugs');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
});

async function call(method: string, pathname: string, body?: unknown, auth: string | null = token) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let counter = 0;
let sessionNumber = 100;

async function insertSession(target: ProjectRecord, patch: Partial<TaskRecord> = {}): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const id = `pb-task-${++counter}`;
  const task = await h.collections.tasksDb.insert({
    id, projectId: target.id, templateId: 'builder', executorId: 'test-claude-cli', executionMode: 'terminal', description: 'A session',
    status: 'developing', autonomy: 'auto', manager: false, kind: 'plan', planningPurpose: 'plan-and-bugs', planItemId: null, sessionId: id,
    planningSessionNumber: ++sessionNumber, planningCreatedTaskCount: 0, planningAutoCompleteArmed: false,
    blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: null, ...patch,
  } as TaskRecord);
  const current = (await h.collections.projectsDb.get(target.id))!;
  await h.collections.projectsDb.update(target.id, { activeTaskIds: [...current.activeTaskIds, id] });
  return task;
}

async function manualItem(target: ProjectRecord, extra: Partial<PlanItemRecord> = {}): Promise<PlanItemRecord> {
  counter += 1;
  const now = new Date().toISOString();
  return h.collections.planItemsDb.insert({
    id: randomUUID(), projectId: target.id, title: `Manual ${counter}`, description: '', status: 'pending', order: counter,
    taskIds: [], milestoneId: null, workflowRunId: null, createdAt: now, updatedAt: now, ...extra,
  } as PlanItemRecord);
}

const query = (session: TaskRecord) => `?taskId=${session.id}`;
const fileTask = (session: TaskRecord, title = 'Add export', extra: Record<string, unknown> = {}) =>
  call('POST', `/api/agent-bugs/tasks${query(session)}`, { title, description: 'Brief', ...extra });
const fileBug = (session: TaskRecord, title = 'Crash on save') =>
  call('POST', `/api/agent-bugs${query(session)}`, { title, infoStatus: 'needs-more-info' });
const setDeps = (session: TaskRecord, itemId: string, dependsOn: unknown) =>
  call('PUT', `/api/agent-bugs/${encodeURIComponent(itemId)}/dependencies${query(session)}`, { dependsOn });

// ---- Kinds and pure rules ----

test('SU01 the kind predicates tell the three kinds apart; filing sessions are the two bug-capable ones', () => {
  const planning = { kind: 'plan' as const };
  const reporting = { kind: 'plan' as const, planningPurpose: 'bug-report' as const };
  const combined = { kind: 'plan' as const, planningPurpose: 'plan-and-bugs' as const };
  assert.deepEqual([planning, reporting, combined].map(sessionKinds.isPlanAndBugsSession), [false, false, true]);
  assert.deepEqual([planning, reporting, combined].map(sessionKinds.isBugReportSession), [false, true, false]);
  assert.deepEqual([planning, reporting, combined].map(sessionKinds.filesBugs), [false, true, true]);
  assert.equal(sessionKinds.isPlanAndBugsSession({ kind: 'execute', planningPurpose: 'plan-and-bugs' }), false);
});

test('SU04 SU05 the instructions state the merge-vs-separate rule with examples and name every tool', () => {
  const text = bugReportTool.PLAN_AND_BUGS_INSTRUCTIONS;
  assert.match(text, /both serve the same purpose \(the second is only a part of the first\), merge them into ONE task/);
  assert.match(text, /different purposes and one merely consumes the other, create two items and set the dependency so they run in order/);
  assert.match(text, /Example: "add the export button"/);
  assert.match(text, /Explain your choice to the user in the conversation/);
  for (const tool of Object.values(bugReportTool.PLAN_AND_BUGS_TOOLS)) assert.ok(text.includes(`\`${tool}\``), tool);
  assert.match(text, /Never turn a defect into a task/);
  assert.match(text, /read-only: it cannot write or change any project file/);
});

test('SU03 the tool names are exact and unique; the old set is unchanged', () => {
  assert.deepEqual(Object.values(bugReportTool.PLAN_AND_BUGS_TOOLS), [
    'list_tasks', 'create_bug', 'update_bug', 'delete_bug', 'create_task', 'update_task', 'delete_task', 'reopen_bug', 'set_dependencies',
  ]);
  assert.equal(new Set(Object.values(bugReportTool.PLAN_AND_BUGS_TOOLS)).size, 9);
  assert.equal(Object.values(bugReportTool.BUG_REPORT_TOOLS).includes('set_dependencies' as never), false);
});

test('SU10 SU36 a bug is eligible as a parent exactly as a task is', () => {
  const base = { taskIds: [], workflowRunId: null } as unknown as PlanItemRecord;
  const item = (patch: Partial<PlanItemRecord>) => ({ ...base, type: 'bug', status: 'pending', ...patch }) as PlanItemRecord;
  const eligible = dependenciesModule.isEligibleParent;
  assert.equal(eligible(item({})), true, 'ready');
  assert.equal(eligible(item({ status: 'developing' })), true);
  assert.equal(eligible(item({ status: 'blocked' })), true);
  assert.equal(eligible(item({ status: 'done' })), true, 'done, pull request not merged');
  assert.equal(eligible(item({ status: 'done', autoMerge: { enabled: true, state: 'merged' } as PlanItemRecord['autoMerge'] })), false);
  assert.equal(eligible(item({ status: 'done', pullRequest: { state: 'merged' } as PlanItemRecord['pullRequest'] })), false);
  for (const status of ['failed', 'stopped'] as const) assert.equal(eligible(item({ status })), false, status);
  assert.equal(eligible(item({ archived: true })), false);
  assert.equal(eligible(item({ prConflict: {} as PlanItemRecord['prConflict'] })), false);
  assert.equal(eligible(item({ testingSetup: { mode: 'x' } as unknown as PlanItemRecord['testingSetup'] })), false);
  assert.equal(eligible({ ...item({}), type: 'task' } as PlanItemRecord), true);
});

test('SU11 chainDependencies links ready tasks only and leaves a bug of the group alone', () => {
  const ready = (id: string, task: number, type: 'task' | 'bug') => ({
    id, type, status: 'pending', taskIds: [], workflowRunId: null, planningRef: { session: 1, task },
  }) as unknown as PlanItemRecord;
  const links = dependenciesModule.chainDependencies([ready('a', 1, 'task'), ready('bug', 2, 'bug'), ready('c', 3, 'task')]);
  assert.deepEqual(links, [{ itemId: 'c', dependsOn: ['a'] }]);
});

test('SU08 SU09 the existing parent list limits hold for mixed ids', () => {
  assert.equal(dependenciesModule.parseDependsOn(Array.from({ length: 20 }, (_, i) => `i${i}`))?.length, 20);
  assert.equal(dependenciesModule.parseDependsOn(Array.from({ length: 21 }, (_, i) => `i${i}`)), null);
  assert.deepEqual(dependenciesModule.parseDependsOn([' a ', 'a', 'A']), ['a', 'A']);
  const chain = (length: number) => new Map(Array.from({ length }, (_, i) => [`n${i}`, i === 0 ? [] : [`n${i - 1}`]] as [string, string[]]));
  assert.doesNotThrow(() => dependenciesModule.assertAcyclicAndShallow('top', ['n8'], chain(9)), 'a chain of exactly 10');
  assert.throws(() => dependenciesModule.assertAcyclicAndShallow('top', ['n9'], chain(10)), dependenciesModule.DependencyConflictError, '11 is too deep');
});

// ---- The session itself ----

test('SI01 SI02 SU07 the session is a numbered read-only CLI session; with no agent it is created without a CLI', async () => {
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  const own = await h.projectService.createProject({ name: 'Plan and bugs session', position: null });

  const session = await manager.startPlanAndBugsSession({ projectId: own.id, description: 'Export notes, and saving loses them', executorId: 'test-claude-cli' });
  assert.equal(session.kind, 'plan');
  assert.equal(session.planningPurpose, 'plan-and-bugs');
  assert.equal(session.planningSessionNumber, 1);
  assert.equal(session.branch, undefined);
  assert.equal(session.worktreePath, undefined);
  const start = terminal.starts[0]!;
  assert.deepEqual(start.disallowedTools, planModule.PLAN_DISALLOWED_TOOLS);
  assert.equal(start.readOnly, true);
  assert.deepEqual(start.mcpServers?.map((server) => server.name), [bugReportTool.BUG_REPORT_MCP_SERVER_NAME]);
  assert.deepEqual(start.mcpServers?.[0]?.tools, Object.values(bugReportTool.PLAN_AND_BUGS_TOOLS));
  assert.equal(start.mcpServers?.[0]?.env.AGENT_VISUAL_OS_DEPENDENCY_TOOL, '1');
  assert.equal(start.prompt, `Export notes, and saving loses them\n\n${bugReportTool.PLAN_AND_BUGS_INSTRUCTIONS}`);

  // A planning session beside it shares the number sequence and keeps its own instructions and tools.
  const planning = await manager.startTask({ projectId: own.id, description: 'Plan', executorId: 'test-claude-cli', kind: 'plan' });
  assert.equal(planning.planningSessionNumber, 2);
  assert.deepEqual(terminal.starts[1]!.mcpServers?.map((server) => server.name), ['agent_visual_os']);
  assert.doesNotMatch(terminal.starts[1]!.prompt, /set_dependencies/);

  const codex = await manager.startPlanAndBugsSession({ projectId: own.id, description: 'Codex', executorId: 'test-codex-cli' });
  assert.equal(codex.planningSessionNumber, 3);

  const deferred = await manager.startPlanAndBugsSession({ projectId: own.id, description: 'No agent yet' });
  assert.equal(deferred.cliNotStarted, true);
  assert.equal(deferred.status, 'stopped');
  assert.equal(deferred.planningPurpose, 'plan-and-bugs');
  assert.equal(deferred.description, 'No agent yet');
  assert.equal(terminal.starts.length, 3, 'no CLI for the deferred session');
});

test('IT02 IT03 IT04 both planning launches carry the interview, confirmation and checklist rules with an unchanged tool surface', async () => {
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  const own = await h.projectService.createProject({ name: 'Planning interview launch', position: null });
  const rules = [/Interview first\./, /one decision at a time/, /Confirm before filing\./, /explicit go-ahead/, /Specification completeness\./];

  await manager.startTask({ projectId: own.id, description: 'Add a CSV export', executorId: 'test-claude-cli', kind: 'plan' });
  const planning = terminal.starts[0]!;
  assert.ok(planning.prompt.startsWith('Add a CSV export\n\n'), 'the user message comes first');
  for (const rule of rules) assert.match(planning.prompt, rule);
  assert.match(planning.prompt, /workflow, in this order: .+\. Write each task's specification so those steps have what they need to do their jobs\.$/, 'the workflow step list is still appended');
  assert.deepEqual(planning.disallowedTools, planModule.PLAN_DISALLOWED_TOOLS);
  const { PLAN_TASK_TOOLS } = await import('../src/terminal/planTaskTool.ts');
  assert.deepEqual(PLAN_TASK_TOOLS, { create: 'create_task', list: 'list_tasks', update: 'update_task', delete: 'delete_task' });

  await manager.startPlanAndBugsSession({ projectId: own.id, description: 'Export, and a crash', executorId: 'test-claude-cli' });
  const combined = terminal.starts[1]!;
  for (const rule of rules) assert.match(combined.prompt, rule);
  assert.equal(combined.prompt, `Export, and a crash\n\n${bugReportTool.PLAN_AND_BUGS_INSTRUCTIONS}`);
  assert.deepEqual(combined.mcpServers?.[0]?.tools, ['list_tasks', 'create_bug', 'update_bug', 'delete_bug', 'create_task', 'update_task', 'delete_task', 'reopen_bug', 'set_dependencies']);
});

test('IT06 filing a task or bug still needs no confirmation field: only the prompt changed', async () => {
  const combined = await insertSession(project);
  assert.equal((await fileTask(combined, 'Plain task')).status, 201);
  assert.equal((await fileBug(combined, 'Plain bug')).status, 201);
  const planning = await insertSession(project, { planningPurpose: undefined });
  const created = await call('POST', `/api/agent-tasks?taskId=${planning.id}`, { title: 'Planned task', description: 'Brief' });
  assert.ok(created.status === 200 || created.status === 201, `status ${created.status}`);
});

test('SI07 SU16 a follow-up keeps the kind; the finished notification names it', async () => {
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  const own = await h.projectService.createProject({ name: 'Plan and bugs follow-up', position: null });
  const waitUntil = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 600 && !(await check()); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const session = await manager.startPlanAndBugsSession({ projectId: own.id, description: 'First', executorId: 'test-claude-cli' });
  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(session.id)).status === 'stopped');
  await waitUntil(async () => (await h.projectService.getProject(own.id)).status === 'idle');
  await manager.completeTerminalTask(session.id);
  const notifications = await import('../src/notifications/notificationService.ts');
  const titles = (await notifications.listNotifications()).filter((n) => n.subject.type === 'task' && n.subject.taskId === session.id).map((n) => n.title);
  assert.deepEqual(titles, ['Plan & bugs session #1 finished']);

  const followUp = await manager.followUpTask(session.id, 'One more bug');
  assert.equal(followUp.planningPurpose, 'plan-and-bugs');
  assert.equal(followUp.planningSessionNumber, session.planningSessionNumber);
  assert.equal(terminal.starts[1]!.prompt, `One more bug\n\n${bugReportTool.PLAN_AND_BUGS_INSTRUCTIONS}`);
  assert.deepEqual(terminal.starts[1]!.mcpServers?.[0]?.tools, Object.values(bugReportTool.PLAN_AND_BUGS_TOOLS));
});

test('SI05 the chat route starts a plan-and-bugs session, never an old-kind planning session', async () => {
  const own = await h.projectService.createProject({ name: 'Plan and bugs chat', position: null });
  const res = await call('POST', `/api/projects/${own.id}/chat`, { message: 'Draft it', executorId: 'test-unsupported' });
  assert.equal(res.status, 422, 'validated like any plan start');
  assert.equal((await call('POST', `/api/projects/${own.id}/bug-reports`, { description: 'x' }, token)).status, 404, 'the old create route is gone');
});

// ---- Filing tasks and bugs ----

test('SI08 SI09 SI13 SI39 tasks are numbered under the session, bugs follow their schemes, and both count', async () => {
  const session = await insertSession(project);
  const first = await fileTask(session, 'Add export');
  assert.equal(first.status, 201);
  assert.equal(first.body.title, `${session.planningSessionNumber}.001: Add export`);
  assert.equal(first.body.planningRef.session, session.planningSessionNumber);
  const second = await fileTask(session, 'Add import');
  assert.equal(second.body.title, `${session.planningSessionNumber}.002: Add import`);
  assert.equal((await fileTask(session, '  ')).status, 201, 'a blank title falls back to the description (as a bug report session does)');

  const bug = await fileBug(session);
  assert.equal(bug.status, 201);
  assert.match(bug.body.title, /^B\.\d{3}: Crash on save$/);
  assert.equal(bug.body.bug.reportSessionNumber, session.planningSessionNumber);

  const listed = await call('GET', `/api/agent-bugs${query(session)}`);
  assert.ok(listed.body.some((item: PlanItemRecord) => item.type === 'bug') && listed.body.some((item: PlanItemRecord) => item.type === 'task'));

  const stored = (await h.collections.tasksDb.get(session.id))!;
  assert.equal(stored.planningCreatedTaskCount, 4, 'tasks and bugs both count');
  assert.equal(stored.planningAutoCompleteArmed, true);
  assert.equal((await fileBug(session, '')).status, 400);
});

test('SI10 SI11 SI12 update and delete of tasks and bugs: own and unstarted, started 409, foreign 404, wrong kind 409', async () => {
  const session = await insertSession(project);
  const other = await insertSession(project);
  const task = (await fileTask(session, 'Mine')).body;
  const bug = (await fileBug(session)).body;
  const foreignTask = (await fileTask(other, 'Theirs')).body;
  const foreignBug = (await fileBug(other)).body;

  const renamed = await call('PATCH', `/api/agent-bugs/tasks/${task.id}${query(session)}`, { title: 'Renamed' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, `${session.planningSessionNumber}.001: Renamed`, 'the number stays');
  assert.equal((await call('PATCH', `/api/agent-bugs/${bug.id}${query(session)}`, { severity: 'low' })).status, 200);
  assert.equal((await call('PATCH', `/api/agent-bugs/tasks/${foreignTask.id}${query(session)}`, { title: 'x' })).status, 404);
  assert.equal((await call('PATCH', `/api/agent-bugs/${foreignBug.id}${query(session)}`, { severity: 'low' })).status, 404);
  assert.equal((await call('PATCH', `/api/agent-bugs/tasks/${bug.id}${query(session)}`, { title: 'x' })).status, 409, 'a bug id on a task tool');
  assert.equal((await call('PATCH', `/api/agent-bugs/${task.id}${query(session)}`, { severity: 'low' })).status, 409, 'a task id on a bug tool');
  const related = await call('PATCH', `/api/agent-bugs/tasks/${task.id}${query(session)}`, { relatedBugId: bug.id });
  assert.equal(related.status, 200);
  assert.equal(related.body.relatedBug.planItemId, bug.id);
  assert.equal((await call('PATCH', `/api/agent-bugs/tasks/${task.id}${query(session)}`, { relatedBugId: foreignBug.id })).status, 400);

  await h.collections.planItemsDb.update(task.id, { status: 'developing', workflowRunId: 'run' });
  assert.equal((await call('PATCH', `/api/agent-bugs/tasks/${task.id}${query(session)}`, { title: 'x' })).status, 409);
  assert.equal((await call('DELETE', `/api/agent-bugs/tasks/${task.id}${query(session)}`)).status, 409);
  assert.equal((await call('DELETE', `/api/agent-bugs/tasks/${foreignTask.id}${query(session)}`)).status, 404);
  assert.equal((await call('DELETE', `/api/agent-bugs/tasks/${bug.id}${query(session)}`)).status, 409);
  assert.equal((await call('DELETE', `/api/agent-bugs/${bug.id}${query(session)}`)).status, 204);
  assert.equal((await call('DELETE', `/api/agent-bugs/${foreignBug.id}${query(session)}`)).status, 404);
});

test('SI17 a wrong or missing token, an unknown session and a stopped session are refused', async () => {
  const session = await insertSession(project);
  assert.equal((await call('GET', `/api/agent-bugs${query(session)}`, undefined, 'wrong')).status, 401);
  assert.equal((await call('GET', `/api/agent-bugs${query(session)}`, undefined, null)).status, 401);
  assert.equal((await call('PUT', `/api/agent-bugs/x/dependencies${query(session)}`, { dependsOn: [] }, 'wrong')).status, 401);
  assert.equal((await call('PUT', `/api/agent-bugs/x/dependencies?taskId=nope`, { dependsOn: [] })).status, 404);
  assert.equal((await call('PUT', `/api/agent-bugs/x/dependencies`, { dependsOn: [] })).status, 400);
  const stopped = await insertSession(project, { status: 'stopped' });
  assert.equal((await setDeps(stopped, 'x', [])).status, 409);
});

// ---- set_dependencies ----

test('SI19 SI21 dependencies can be set between any pairing of tasks and bugs, and cleared', async () => {
  const session = await insertSession(project);
  const t1 = (await fileTask(session, 'One')).body;
  const t2 = (await fileTask(session, 'Two')).body;
  const b1 = (await fileBug(session, 'Bug one')).body;
  const b2 = (await fileBug(session, 'Bug two')).body;
  const pairings: [PlanItemRecord, PlanItemRecord][] = [[t2, t1], [b1, t1], [t2, b2], [b2, b1]];
  for (const [child, parent] of pairings) {
    const res = await setDeps(session, child.id, [parent.id]);
    assert.equal(res.status, 200, `${child.type} -> ${parent.type}`);
    assert.ok(res.body.dependsOn.includes(parent.id));
  }
  assert.deepEqual((await h.collections.planItemsDb.get(b2.id))!.dependsOn, [b1.id], 'persisted');
  const cleared = await setDeps(session, b2.id, []);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.dependsOn, []);
  const status = await call('GET', `/api/projects/${project.id}/plan-items/${t2.id}/dependencies`);
  assert.deepEqual(status.body.map((entry: { id: string }) => entry.id), [b2.id], 'the existing status route lists a bug parent');
});

test('SI20 a parent must be ready or started and not merged; others are 409', async () => {
  const session = await insertSession(project);
  const child = (await fileTask(session, 'Child')).body;
  const ok = [await manualItem(project), await manualItem(project, { status: 'developing' }), await manualItem(project, { status: 'blocked' }), await manualItem(project, { status: 'done', type: 'bug' })];
  assert.equal((await setDeps(session, child.id, ok.map((item) => item.id))).status, 200);
  const refused = [
    await manualItem(project, { status: 'done', pullRequest: { state: 'merged' } as PlanItemRecord['pullRequest'] }),
    await manualItem(project, { archived: true }),
    await manualItem(project, { status: 'failed' }),
    await manualItem(project, { status: 'stopped' }),
    await manualItem(project, { prConflict: {} as PlanItemRecord['prConflict'] }),
    await manualItem(project, { testingSetup: { mode: 'x' } as unknown as PlanItemRecord['testingSetup'] }),
  ];
  for (const parent of refused) assert.equal((await setDeps(session, child.id, [parent.id])).status, 409, JSON.stringify(parent.status));
});

test('SI22 a malformed list is 400', async () => {
  const session = await insertSession(project);
  const child = (await fileTask(session, 'Child')).body;
  for (const body of ['a', [1], [''], ['  '], Array.from({ length: 21 }, (_, i) => `t${i}`), undefined]) {
    assert.equal((await setDeps(session, child.id, body)).status, 400, JSON.stringify(body)?.slice(0, 30));
  }
});

test('SI23 SI25 an unknown, foreign, person-filed or other-project item or parent is 404', async () => {
  const session = await insertSession(project);
  const other = await insertSession(project);
  const mine = (await fileTask(session, 'Mine')).body;
  const theirs = (await fileTask(other, 'Theirs')).body;
  const theirBug = (await fileBug(other)).body;
  const byPerson = await manualItem(project);
  const elsewhere = await h.createProject('Plan and bugs elsewhere');
  const foreignProject = await manualItem(elsewhere);
  for (const id of ['missing', theirs.id, theirBug.id, byPerson.id, foreignProject.id]) assert.equal((await setDeps(session, id, [])).status, 404, id);
  assert.equal((await setDeps(session, mine.id, ['missing'])).status, 404);
  assert.equal((await setDeps(session, mine.id, [foreignProject.id])).status, 404);
  assert.equal((await setDeps(session, mine.id, [theirs.id, theirBug.id, byPerson.id])).status, 200, 'any task or bug of the project can be a parent');
});

test('SI24 SI26 a started item, a self-dependency, a cycle through a bug, too deep a chain and no repository are 409', async () => {
  const session = await insertSession(project);
  const a = (await fileTask(session, 'A')).body;
  const b = (await fileBug(session, 'B')).body;
  const c = (await fileTask(session, 'C')).body;
  assert.equal((await setDeps(session, b.id, [a.id])).status, 200);
  assert.equal((await setDeps(session, c.id, [b.id])).status, 200);
  assert.equal((await setDeps(session, a.id, [c.id])).status, 409, 'cycle through a bug');
  assert.equal((await setDeps(session, a.id, [a.id])).status, 409, 'self');

  await h.collections.planItemsDb.update(a.id, { status: 'developing', workflowRunId: 'run' });
  assert.equal((await setDeps(session, a.id, [])).status, 409, 'started task');
  const startedBug = (await fileBug(session, 'Started')).body;
  await h.collections.planItemsDb.update(startedBug.id, { status: 'developing', workflowRunId: 'run' });
  assert.equal((await setDeps(session, startedBug.id, [])).status, 409, 'started bug');

  const chain: PlanItemRecord[] = [];
  for (let i = 0; i < 11; i += 1) chain.push((await fileTask(session, `Chain ${i}`)).body);
  for (let i = 1; i < 10; i += 1) assert.equal((await setDeps(session, chain[i]!.id, [chain[i - 1]!.id])).status, 200, `a chain of ${i + 1}`);
  const eleventh = (await fileBug(session, 'Eleventh')).body;
  assert.equal((await setDeps(session, eleventh.id, [chain[9]!.id])).status, 409, 'a chain of 11');

  const bare = await h.projectService.createProject({ name: 'Plan and bugs bare', position: null });
  const bareSession = await insertSession(bare);
  const bareTask = (await fileTask(bareSession, 'Bare')).body;
  const bareOther = (await fileBug(bareSession, 'Bare bug')).body;
  const res = await setDeps(bareSession, bareTask.id, [bareOther.id]);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /linked repository/);
});

test('SI18 an old bug report session and a plain planning session cannot set dependencies', async () => {
  const reporting = await insertSession(project, { planningPurpose: 'bug-report' });
  const planning = await insertSession(project, { planningPurpose: undefined });
  const item = await manualItem(project);
  assert.equal((await setDeps(reporting, item.id, [])).status, 409);
  assert.equal((await setDeps(planning, item.id, [])).status, 409);
  assert.equal((await call('GET', `/api/agent-bugs${query(planning)}`)).status, 409, 'the filing routes refuse a plain planning session');
  assert.equal((await fileBug(reporting)).status, 201, 'the old kind keeps its tools');
});

test('SI37 SI38 completion: armed by the first task or bug, not while one is ready, done when idle; never when nothing was filed', async () => {
  const waitUntil = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 600 && !(await check()); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  const own = await h.projectService.createProject({ name: 'Plan and bugs completion', position: null });
  const settle = async (taskId: string, index: number) => {
    terminal.starts[index]!.onExit(0);
    await waitUntil(async () => (await manager.getTask(taskId)).status === 'stopped');
    await waitUntil(async () => (await h.projectService.getProject(own.id)).status === 'idle');
  };

  const empty = await manager.startPlanAndBugsSession({ projectId: own.id, description: 'Nothing comes of it', executorId: 'test-claude-cli' });
  await settle(empty.id, 0);
  assert.equal((await manager.getTask(empty.id)).archived, undefined, 'never complete when it filed nothing');

  const session = await manager.startPlanAndBugsSession({ projectId: own.id, description: 'Both kinds', executorId: 'test-claude-cli' });
  const task = await manager.createReportedTask(session.id, { title: 'A task', description: 'Brief' } as never);
  const bug = await manager.createReportedBug(session.id, (await import('../src/projects/bugs.ts')).parseBugReport({ title: 'A bug', infoStatus: 'enough' }));
  await manager.deleteReportedTask(session.id, task.id);
  assert.equal((await manager.getTask(session.id)).archived, undefined, 'the bug is still ready (and the session is live)');
  await h.collections.planItemsDb.update(bug.id, { status: 'developing', workflowRunId: 'run' });
  assert.equal((await manager.getTask(session.id)).planningCreatedTaskCount, 2, 'tasks and bugs both count');
  await settle(session.id, 1);
  await waitUntil(async () => (await manager.getTask(session.id)).archived === true);
  assert.equal((await manager.getTask(session.id)).archived, true, 'idle with none ready: complete');

  const open = await manager.startPlanAndBugsSession({ projectId: own.id, description: 'Stays open', executorId: 'test-claude-cli' });
  await manager.createReportedBug(open.id, (await import('../src/projects/bugs.ts')).parseBugReport({ title: 'Ready bug', infoStatus: 'enough' }));
  await settle(open.id, 2);
  assert.equal((await manager.getTask(open.id)).archived, undefined, 'a ready bug keeps it open');
});

test('SU02 SU15 the relay script lists set_dependencies only for the combined session, and relays it to the route', async () => {
  const list = async (launch: { command: string; args: string[]; env: Record<string, string> }, extraEnv: Record<string, string> = {}) => {
    const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const ask = async (message: object) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, ...message })}\n`);
      return JSON.parse((await lines.next()).value as string).result;
    };
    return { ask, close: () => { child.stdin.end(); child.kill(); } };
  };
  const old = await list(bugReportTool.bugReportMcpServer('t1'));
  const oldTools = (await old.ask({ method: 'tools/list' })).tools.map((tool: { name: string }) => tool.name);
  old.close();
  assert.deepEqual(oldTools, Object.values(bugReportTool.BUG_REPORT_TOOLS));

  const session = await insertSession(project);
  const a = (await fileTask(session, 'A')).body;
  const b = (await fileBug(session, 'B')).body;
  const launch = bugReportTool.planAndBugsMcpServer(session.id);
  const relay = await list(launch, { AGENT_VISUAL_OS_BUGS_URL: `${base}/api/agent-bugs`, AGENT_VISUAL_OS_HOOK_TOKEN: token });
  const tools = (await relay.ask({ method: 'tools/list' })).tools as { name: string; inputSchema: { required?: string[] } }[];
  assert.deepEqual(tools.map((tool) => tool.name), Object.values(bugReportTool.PLAN_AND_BUGS_TOOLS));
  assert.deepEqual(tools.find((tool) => tool.name === 'set_dependencies')!.inputSchema.required, ['itemId', 'dependsOn']);
  const ok = await relay.ask({ method: 'tools/call', params: { name: 'set_dependencies', arguments: { itemId: b.id, dependsOn: [a.id] } } });
  assert.equal(ok.isError, false);
  assert.deepEqual((await h.collections.planItemsDb.get(b.id))!.dependsOn, [a.id]);
  const refused = await relay.ask({ method: 'tools/call', params: { name: 'set_dependencies', arguments: { itemId: a.id, dependsOn: [b.id] } } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /cycle/, 'the daemon message comes back unchanged');
  relay.close();
});


test('SI44 the service re-checks parents inside its exclusive section, and a child that started meanwhile is refused', async () => {
  const child = await manualItem(project);
  const parent = await manualItem(project);
  const gone = await manualItem(project, { archived: true });
  await assert.rejects(() => service.setDependencies(project.id, child.id, [gone.id], { requireEligibleParents: true }), { name: 'DependencyConflictError' });
  assert.equal((await service.setDependencies(project.id, child.id, [gone.id])).dependsOn![0], gone.id, 'the person\'s own route keeps its looser rule');
  // Two calls queued together: the first start wins, the second sees a started child.
  const results = await Promise.allSettled([
    service.setDependencies(project.id, child.id, [parent.id], { requireEligibleParents: true }),
    h.collections.planItemsDb.update(child.id, { status: 'developing', workflowRunId: 'run' }).then(() => service.setDependencies(project.id, child.id, [], { requireEligibleParents: true })),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected', 'a started child is a conflict');
});

test('SI14 SI15 SI16 reopen_bug on the new kind: a bug that is not completed is 409, an unknown id 404, a task id 409', async () => {
  const session = await insertSession(project);
  const bug = (await fileBug(session)).body;
  const task = (await fileTask(session)).body;
  const reopen = (id: string) => call('POST', `/api/agent-bugs/${id}/reopen${query(session)}`, { reason: 'Still crashes' });
  assert.equal((await reopen(bug.id)).status, 409);
  assert.equal((await reopen('missing')).status, 404);
  assert.equal((await reopen(task.id)).status, 409);
});

test('SU06 SU14 SI41 the old instructions are unchanged, wide numbers keep their form, and the hook token is in no response', async () => {
  assert.match(bugReportTool.BUG_REPORT_INSTRUCTIONS, /This is a BUG REPORT session/);
  assert.doesNotMatch(bugReportTool.BUG_REPORT_INSTRUCTIONS, /set_dependencies/);
  const { bugNumber } = await import('../src/projects/bugs.ts');
  const { planningTaskTitle } = await import('../src/projects/planItemService.ts');
  assert.equal(bugNumber(null, 1000), 'B.1000');
  assert.equal(bugNumber('27.001', 1000), '27.001.1000');
  assert.equal(planningTaskTitle({ session: 27, task: 1000 }, 'x'), '27.1000: x');

  const session = await insertSession(project);
  const bodies = [
    await fileTask(session), await fileBug(session), await call('GET', `/api/agent-bugs${query(session)}`),
    await call('GET', `/api/projects/${project.id}/plan`), await call('GET', `/api/projects/${project.id}/tasks`),
  ];
  for (const res of bodies) assert.ok(!JSON.stringify(res.body).includes(token), 'no response carries the token');
});

test('SI38 manual complete releases the session\'s ready tasks and standalone bugs into its slot', async () => {
  const waitUntil = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 600 && !(await check()); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const terminal = fakeTerminalHost();
  const manager = workerManagerModule.createWorkerManager({ terminalSessions: terminal.host });
  const own = await h.projectService.createProject({ name: 'Plan and bugs release', position: null });
  const session = await manager.startPlanAndBugsSession({ projectId: own.id, description: 'Release', executorId: 'test-claude-cli' });
  const task = await manager.createReportedTask(session.id, { title: 'T', description: 'Brief' } as never);
  const bug = await manager.createReportedBug(session.id, (await import('../src/projects/bugs.ts')).parseBugReport({ title: 'B', infoStatus: 'enough' }));
  terminal.starts[0]!.onExit(0);
  await waitUntil(async () => (await manager.getTask(session.id)).status === 'stopped');
  await waitUntil(async () => (await h.projectService.getProject(own.id)).status === 'idle');
  await manager.completePlanningSession(session.id);
  assert.equal((await manager.getTask(session.id)).archived, true);
  const parentOrder = (await manager.getTask(session.id)).planningQueueOrder!;
  const released = await Promise.all([task, bug].map((item) => h.collections.planItemsDb.get(item.id)));
  for (const item of released) assert.equal(typeof item!.planningQueueOrder, 'number', `${item!.title} has a queue slot`);
  assert.ok(released.every((item) => item!.planningQueueOrder! > parentOrder), 'released after the session\'s own slot');
});

// ---- Task 38.002: "UI planning waits for parent" on set_dependencies ----

test('38.002 I28 set_dependencies saves uiPlanningWaitsForParent; a non-boolean is 400, omitting it keeps the value, and the usual refusals hold', async () => {
  const session = await insertSession(project);
  const parent = (await fileTask(session, 'Parent')).body;
  const child = (await fileTask(session, 'Child')).body;
  const put = (body: unknown, auth: string | null = token, target = session) =>
    call('PUT', `/api/agent-bugs/${encodeURIComponent(child.id)}/dependencies${query(target)}`, body, auth);
  const on = await put({ dependsOn: [parent.id], uiPlanningWaitsForParent: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.uiPlanningWaitsForParent, true);
  const bad = await put({ dependsOn: [parent.id], uiPlanningWaitsForParent: 'yes' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /uiPlanningWaitsForParent/);
  const kept = await put({ dependsOn: [parent.id] });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.uiPlanningWaitsForParent, true, 'omitted keeps the stored value');
  assert.equal((await put({ dependsOn: [parent.id], uiPlanningWaitsForParent: false }, 'wrong')).status, 401);
  assert.equal((await put({ dependsOn: [parent.id], uiPlanningWaitsForParent: false }, token, await insertSession(project, { planningPurpose: undefined }))).status, 409, 'wrong session kind');
  const other = await h.createProject('Plan and bugs waits other');
  const foreign = await manualItem(other);
  assert.equal((await call('PUT', `/api/agent-bugs/${encodeURIComponent(foreign.id)}/dependencies${query(session)}`, { dependsOn: [], uiPlanningWaitsForParent: true })).status, 404);
});

test('38.002 I30 the session instructions and relay scripts carry the setting', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const plan = await import('../src/projects/plan.ts');
  for (const text of [bugReportTool.PLAN_AND_BUGS_INSTRUCTIONS, plan.PLAN_INSTRUCTIONS]) {
    assert.match(text, /uiPlanningWaitsForParent/);
    assert.match(text, /off/);
    assert.match(text, /on only when the (task|item)'s UI genuinely builds on or reuses UI that the parent introduces/);
    assert.match(text, /confirm the value with the user for each dependent/);
  }
  const bin = path.join(import.meta.dirname, '..', 'bin');
  assert.match(await readFile(path.join(bin, 'bug-report-mcp.mjs'), 'utf8'), /uiPlanningWaitsForParent: \{ type: 'boolean'/);
  assert.match(await readFile(path.join(bin, 'plan-task-mcp.mjs'), 'utf8'), /const WAITS = \{ type: 'boolean'/);
});

test('38.002 I28 set_dependencies with [] and the setting refuses (409) without changing the parents', async () => {
  const session = await insertSession(project);
  const parent = (await fileTask(session, 'Parent')).body;
  const child = (await fileTask(session, 'Child')).body;
  const path = `/api/agent-bugs/${encodeURIComponent(child.id)}/dependencies${query(session)}`;
  assert.equal((await call('PUT', path, { dependsOn: [parent.id] })).status, 200);
  const refused = await call('PUT', path, { dependsOn: [], uiPlanningWaitsForParent: true });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no parent tasks/);
  const stored = (await h.collections.planItemsDb.get(child.id))!;
  assert.deepEqual(stored.dependsOn, [parent.id], 'the parents are unchanged');
  assert.equal(stored.uiPlanningWaitsForParent, undefined);
  const both = await call('PUT', path, { dependsOn: [parent.id], uiPlanningWaitsForParent: false });
  assert.equal(both.status, 200);
  assert.equal(both.body.uiPlanningWaitsForParent, false);
});
