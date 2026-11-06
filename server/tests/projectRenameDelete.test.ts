import { createQuietProject } from './helpers/quietProject.ts';
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';
import { PROJECT_PLOTS } from '../src/projects/townPlots.ts';

let t: ContentApi;
let db: typeof import('../src/db/collections.ts');
let workerManager: typeof import('../src/worker/workerManager.ts').workerManager;
let parseProjectName: typeof import('../src/projects/projectService.ts').parseProjectName;
const events: Array<{ type: string; [key: string]: any }> = [];

before(async () => {
  t = await startContentApi();
  db = await import('../src/db/collections.ts');
  ({ workerManager } = await import('../src/worker/workerManager.ts'));
  ({ parseProjectName } = await import('../src/projects/projectService.ts'));
  workerManager.onWorkerEvent((event) => events.push(event));
});
after(async () => { await t.stop(); });

const exists = (p: string) => access(p).then(() => true, () => false);
const create = async (name: string) => (await createQuietProject(name)).body;
const rename = (id: string, name: unknown) => t.send('PATCH', `/api/projects/${id}`, { name });

test('U1-U8 parseProjectName trims and enforces 1 to 80 characters, counting characters', () => {
  assert.equal(parseProjectName('  My app  '), 'My app');
  assert.equal(parseProjectName('a'), 'a');
  assert.equal(parseProjectName('x'.repeat(80)), 'x'.repeat(80));
  assert.equal(parseProjectName(` ${'x'.repeat(80)} `), 'x'.repeat(80));
  assert.equal(parseProjectName('😀'.repeat(80)), '😀'.repeat(80));
  assert.equal(parseProjectName('項目'), '項目');
  for (const bad of ['x'.repeat(81), '😀'.repeat(81), '', '   ', undefined, null, 5, [], {}]) assert.throws(() => parseProjectName(bad), /1 to 80/, String(bad));
});

test('I1/I2/I10 rename changes only the name and updatedAt, and broadcasts a project event', async () => {
  const project = await create('Old name');
  const before = (await t.api(`/api/projects/${project.id}`)).body;
  const folder = path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, project.slug);
  events.length = 0;
  const res = await rename(project.id, '  New name  ');
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'New name');
  assert.equal(res.body.slug, before.slug);
  assert.equal(res.body.repositoryUrl, before.repositoryUrl);
  assert.ok(res.body.updatedAt >= before.updatedAt);
  assert.ok(await exists(folder), 'folder keeps its name');
  assert.equal((await t.api(`/api/projects/${project.id}`)).body.name, 'New name');
  assert.ok(events.some((e) => e.type === 'project' && e.project.id === project.id && e.project.name === 'New name'));
});

test('I3/I4/I5 an invalid name answers 400 with field name and changes nothing', async () => {
  const project = await create('Keeper');
  for (const bad of ['', '   ', 'x'.repeat(81), 5, null, ['a'], {}]) {
    const res = await rename(project.id, bad);
    assert.deepEqual([res.status, res.body.field], [400, 'name'], JSON.stringify(bad));
    assert.match(res.body.error, /1 to 80/);
  }
  assert.equal((await t.api(`/api/projects/${project.id}`)).body.name, 'Keeper');
});

test('I6/I32 renaming an unknown or already deleted project answers 404', async () => {
  assert.equal((await rename('no-such-project', 'x')).status, 404);
  const project = await create('Gone');
  assert.equal((await t.send('DELETE', `/api/projects/${project.id}`)).status, 204);
  assert.equal((await rename(project.id, 'Back')).status, 404);
});

test('I7 two projects may share a name', async () => {
  const a = await create('Twin A');
  const b = await create('Twin B');
  assert.equal((await rename(a.id, 'Twin')).status, 200);
  assert.equal((await rename(b.id, 'Twin')).status, 200);
});

test('I8/I9 a body with neither field is 400, and name plus position applies both', async () => {
  const project = await create('Both');
  const empty = await t.send('PATCH', `/api/projects/${project.id}`, {});
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /name or position is required/);
  const res = await t.send('PATCH', `/api/projects/${project.id}`, { name: 'Both moved', position: PROJECT_PLOTS[70] });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Both moved');
  assert.ok(Math.abs(res.body.position[0] - PROJECT_PLOTS[70]![0]) < 1e-9);
});

test('I11/I12 Content Studio settings rename goes through the same rule and announces the change', async () => {
  const id = await t.createStudio('Studio');
  const before = (await t.projectsDb.get(id))!;
  events.length = 0;
  const res = await t.send('PATCH', t.c(id, '/settings'), { name: ' Renamed studio ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed studio');
  const after = (await t.projectsDb.get(id))!;
  assert.equal(after.name, 'Renamed studio');
  assert.ok(after.updatedAt >= before.updatedAt);
  assert.ok(events.some((e) => e.type === 'project' && e.project.id === id && e.project.name === 'Renamed studio'));
  for (const bad of ['', 'x'.repeat(81)]) {
    const refused = await t.send('PATCH', t.c(id, '/settings'), { name: bad });
    assert.deepEqual([refused.status, refused.body.field], [400, 'name']);
  }
  events.length = 0;
  await t.send('PATCH', t.c(id, '/settings'), { timezone: 'UTC' });
  assert.equal(events.filter((e) => e.type === 'project').length, 0, 'no announcement without a name change');
});

test('I13/I31 deleting an idle project answers 204, removes record and folder, and a second delete is 404', async () => {
  const project = await create('Idle');
  const folder = path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, project.slug);
  await mkdir(path.join(folder, '.worktrees'), { recursive: true });
  assert.equal((await t.send('DELETE', `/api/projects/${project.id}`)).status, 204);
  assert.equal(await exists(folder), false);
  assert.equal((await t.api(`/api/projects/${project.id}`)).status, 404);
  assert.equal((await t.send('DELETE', `/api/projects/${project.id}`)).status, 404);
  assert.equal((await t.send('DELETE', '/api/projects/no-such-project')).status, 404);
});

test('I14/I30 a project with an active task answers 409 with the reason and keeps every record', async () => {
  const project = await create('Busy');
  await db.projectsDb.update(project.id, { activeTaskId: 'active-task' } as never);
  await db.notificationsDb.insert({ id: 'busy-n', projectId: project.id } as never);
  const res = await t.send('DELETE', `/api/projects/${project.id}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already has an active task/);
  assert.ok(await db.projectsDb.get(project.id));
  assert.ok(await db.notificationsDb.get('busy-n'));
  await db.projectsDb.update(project.id, { activeTaskId: undefined } as never);
});

test('I16-I19/I21/I27 delete removes the project\'s tasks, plan items, runs, notifications, agent sessions and links, and nothing of another project', async () => {
  const doomed = await create('Doomed');
  const other = await create('Other');
  events.length = 0;
  for (const [pid, tag] of [[doomed.id, 'd'], [other.id, 'o']] as const) {
    await db.tasksDb.insert({ id: `task-${tag}`, projectId: pid } as never);
    await db.taskContextsDb.insert({ id: `task-${tag}`, taskId: `task-${tag}` } as never);
    await db.planItemsDb.insert({ id: `item-${tag}`, projectId: pid } as never);
    await db.planItemQueueDb.insert({ id: `queue-${tag}`, projectId: pid } as never);
    await db.workflowRunsDb.insert({ id: `run-${tag}`, projectId: pid } as never);
    await db.stepRunsDb.insert({ id: `step-${tag}`, runId: `run-${tag}` } as never);
    await db.notificationsDb.insert({ id: `note-${tag}`, projectId: pid, subject: { type: 'project', projectId: pid } } as never);
    await db.agentSessionsDb.insert({ id: `agent-${tag}`, projectId: pid, state: 'ended' } as never);
    await db.agentSessionCountersDb.insert({ id: pid, last: 2 } as never);
  }
  await db.notificationsDb.insert({ id: 'note-skill', projectId: null } as never);
  const stopped: string[] = [];
  const sessions = (await import('../src/terminal/terminalSessionManager.ts')).terminalSessionManager;
  const originalStop = sessions.stop.bind(sessions);
  sessions.stop = (id: string) => { stopped.push(id); return originalStop(id); };
  try {
    assert.equal((await t.send('DELETE', `/api/projects/${doomed.id}`)).status, 204);
  } finally { sessions.stop = originalStop; }
  const gone = [[db.tasksDb, 'task-d'], [db.taskContextsDb, 'task-d'], [db.planItemsDb, 'item-d'], [db.planItemQueueDb, 'queue-d'], [db.workflowRunsDb, 'run-d'], [db.stepRunsDb, 'step-d'], [db.notificationsDb, 'note-d'], [db.agentSessionsDb, 'agent-d'], [db.agentSessionCountersDb, doomed.id]] as const;
  for (const [collection, id] of gone) assert.equal(await (collection as any).get(id), undefined, id);
  const kept = [[db.tasksDb, 'task-o'], [db.taskContextsDb, 'task-o'], [db.planItemsDb, 'item-o'], [db.planItemQueueDb, 'queue-o'], [db.workflowRunsDb, 'run-o'], [db.stepRunsDb, 'step-o'], [db.notificationsDb, 'note-o'], [db.notificationsDb, 'note-skill'], [db.agentSessionsDb, 'agent-o'], [db.agentSessionCountersDb, other.id]] as const;
  for (const [collection, id] of kept) assert.ok(await (collection as any).get(id), id);
  assert.ok(stopped.includes('task-d') && stopped.includes('agent-d'), 'terminals of tasks and agent sessions are closed');
  assert.ok(!stopped.includes('task-o') && !stopped.includes('agent-o'));
  assert.ok(events.some((e) => e.type === 'projectDeleted' && e.projectId === doomed.id));
  assert.ok(await db.projectsDb.get(other.id));
});

test('I20/I24 delete removes the scheduler jobs and the building data of a Content Studio Building', async () => {
  const id = await t.createStudio('Scheduled');
  const dir = path.join(t.dataDir, 'buildings', id);
  assert.ok(await exists(dir));
  await db.scheduledJobsDb.insert({ id: 'job-s', projectId: id } as never);
  assert.equal((await t.send('DELETE', `/api/projects/${id}`)).status, 204);
  assert.equal(await exists(dir), false);
  assert.equal((await db.scheduledJobsDb.find((job) => job.projectId === id)).length, 0);
  assert.equal(await db.projectsDb.get(id), undefined);
});

test('agentSessions.stopAllForProject stops each terminal of the project and announces the removal', async () => {
  const stopped: string[] = [];
  const emitted: unknown[] = [];
  const records = [{ id: 'a1', projectId: 'p' }, { id: 'a2', projectId: 'p' }, { id: 'a3', projectId: 'q' }];
  const { createAgentSessions } = await import('../src/terminal/agentSessions.ts');
  const fake = createAgentSessions({
    host: { stop: (id: string) => { stopped.push(id); return true; }, has: () => false } as never,
    sessions: { find: async (predicate: (r: never) => boolean) => records.filter(predicate as never) } as never,
  });
  fake.onEvent((event) => emitted.push(event));
  await fake.stopAllForProject('p');
  assert.deepEqual(stopped, ['a1', 'a2']);
  assert.deepEqual(emitted, [{ type: 'agentSessionDeleted', id: 'a1', projectId: 'p' }, { type: 'agentSessionDeleted', id: 'a2', projectId: 'p' }]);
});

test('a valid name with an invalid position answers 400 and renames nothing', async () => {
  const project = await create('Mixed');
  events.length = 0;
  const res = await t.send('PATCH', `/api/projects/${project.id}`, { name: 'Mixed renamed', position: [1, 1] });
  assert.equal(res.status, 400);
  assert.equal((await t.api(`/api/projects/${project.id}`)).body.name, 'Mixed');
  assert.equal(events.filter((e) => e.type === 'project').length, 0);
});

test('delete removes saved commands and command runs, and stopProjectRuns settles only that project\'s running runs', async () => {
  const doomed = await create('Commands doomed');
  const other = await create('Commands other');
  for (const [pid, tag] of [[doomed.id, 'd'], [other.id, 'o']] as const) {
    await db.projectCommandsDb.insert({ id: `cmd-${tag}`, projectId: pid } as never);
    await db.commandRunsDb.insert({ id: `crun-${tag}`, projectId: pid, commandId: `cmd-${tag}`, status: 'running' } as never);
  }
  const { commandRunner } = await import('../src/commands/commandRunner.ts');
  await commandRunner.stopProjectRuns(doomed.id);
  assert.equal((await db.commandRunsDb.get('crun-d'))!.status, 'stopped');
  assert.equal((await db.commandRunsDb.get('crun-o'))!.status, 'running');
  assert.equal((await t.send('DELETE', `/api/projects/${doomed.id}`)).status, 204);
  assert.equal(await db.projectCommandsDb.get('cmd-d'), undefined);
  assert.equal(await db.commandRunsDb.get('crun-d'), undefined);
  assert.ok(await db.projectCommandsDb.get('cmd-o'));
  assert.ok(await db.commandRunsDb.get('crun-o'));
});

test('I29 a failing beforeRemove leaves the record and folder intact', async () => {
  const project = await create('Survivor');
  const { deleteProject } = await import('../src/projects/projectService.ts');
  await assert.rejects(deleteProject(project.id, { beforeRemove: async () => { throw new Error('cannot stop terminals'); } }), /cannot stop terminals/);
  assert.ok(await db.projectsDb.get(project.id));
  assert.ok(await exists(path.join(process.env.AGENT_VISUAL_OS_PROJECTS_DIR!, project.slug)));
});

test('I22 delete sweeps up a leftover worktrees directory', async () => {
  const project = await create('Leftovers');
  const { projectWorktreesRoot } = await import('../src/projects/projectService.ts');
  const root = projectWorktreesRoot(project as never);
  await mkdir(path.join(root, 'run-1'), { recursive: true });
  assert.equal((await t.send('DELETE', `/api/projects/${project.id}`)).status, 204);
  assert.equal(await exists(root), false);
});
