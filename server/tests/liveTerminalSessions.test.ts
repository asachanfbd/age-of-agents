import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { LiveTerminalSessionDto, TaskRecord } from '../src/domain/types.ts';

/**
 * The footer lists exactly what the app-update blocker counts: every live PTY, once. Real PTYs run a
 * script that just sleeps; records live in a temp data dir.
 */

let tempRoot: string;
let sleeper: string;
let collections: typeof import('../src/db/collections.ts');
let terminalModule: typeof import('../src/terminal/terminalSessionManager.ts');
let liveModule: typeof import('../src/terminal/liveTerminalSessions.ts');
let blocking: typeof import('../src/appUpdate/appUpdateBlocking.ts');
let server: HttpServer;
let baseUrl: string;
const hosts: Array<InstanceType<typeof import('../src/terminal/terminalSessionManager.ts').TerminalSessionManager>> = [];

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'live-terminal-sessions-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  sleeper = path.join(tempRoot, 'sleeper.sh');
  await writeFile(sleeper, '#!/bin/sh\nsleep 30\n');
  await chmod(sleeper, 0o755);
  collections = await import('../src/db/collections.ts');
  terminalModule = await import('../src/terminal/terminalSessionManager.ts');
  liveModule = await import('../src/terminal/liveTerminalSessions.ts');
  blocking = await import('../src/appUpdate/appUpdateBlocking.ts');
  const { createDaemonServer } = await import('../src/server.ts');
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `127.0.0.1:${address.port}`;
});

after(async () => {
  for (const host of hosts) for (const id of host.liveIds()) host.stop(id);
  for (const id of terminalModule.terminalSessionManager.liveIds()) terminalModule.terminalSessionManager.stop(id);
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

function startSleeper(host: { start: (input: never) => void }, taskId: string): void {
  host.start({
    taskId, kind: 'claude-cli', bin: sleeper, cwd: tempRoot, env: {}, prompt: '', systemPrompt: '', autonomy: 'approval', onExit: () => undefined,
  } as never);
}

function newHost() {
  const host = new terminalModule.TerminalSessionManager();
  hosts.push(host);
  return host;
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(condition(), 'condition was not met in time');
}

function fakeTask(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  const now = new Date().toISOString();
  return {
    projectId: 'p-live', templateId: 'builder', executorId: 'test-claude-cli', description: 'Task', autonomy: 'auto', manager: false,
    kind: 'execute', status: 'developing', planItemId: null, sessionId: null, blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
    createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

test('liveIds lists live sessions only, and its length is count()', async () => {
  const host = newHost();
  startSleeper(host, 'a');
  startSleeper(host, 'b');
  assert.deepEqual(host.liveIds().sort(), ['a', 'b']);
  assert.equal(host.count(), host.liveIds().length);
  host.stop('a');
  await until(() => host.count() === 1);
  assert.deepEqual(host.liveIds(), ['b']);
});

test('onChange fires on start and on exit, stops after unsubscribe, and a throwing listener does not break either', async () => {
  const host = newHost();
  let calls = 0;
  const unsubscribe = host.onChange(() => { calls += 1; });
  host.onChange(() => { throw new Error('broken listener'); });
  startSleeper(host, 'c');
  assert.equal(calls, 1);
  host.stop('c');
  await until(() => calls === 2);
  unsubscribe();
  startSleeper(host, 'd');
  assert.equal(calls, 2, 'an unsubscribed listener is not called');
  assert.equal(host.count(), 1, 'the throwing listener did not stop the start');
});

test('every live PTY is one row, resolved to its Agent session, Content Studio session or task, and the list matches the blocker count', async () => {
  const host = newHost();
  const now = new Date().toISOString();
  await collections.agentSessionsDb.insert({ id: 'agent-1', projectId: 'p-live', executorId: 'e', number: 2, name: null, agentSessionId: null, setup: {} as never, state: 'running', createdAt: now, updatedAt: now });
  await collections.studioSessionsDb.insert({ id: 'studio-1', buildingId: 'b-live' } as never);
  await collections.tasksDb.insert(fakeTask({ id: 'task-exec', description: 'Build the thing' }));
  await collections.tasksDb.insert(fakeTask({ id: 'task-plan', kind: 'plan', title: 'Plan a launch' }));
  await collections.tasksDb.insert(fakeTask({ id: 'task-bugs', kind: 'plan', planningPurpose: 'bug-report', description: 'Report bugs' }));
  const ids = ['agent-1', 'studio-1', 'task-exec', 'task-plan', 'task-bugs', 'orphan', 'ended'];
  for (const id of ids) startSleeper(host, id);
  host.stop('ended');
  await until(() => host.count() === ids.length - 1);

  const list = await liveModule.createLiveTerminalSessions(host).list();
  const byId = new Map(list.map((row) => [row.id, row]));
  assert.deepEqual(byId.get('agent-1'), { id: 'agent-1', kind: 'agent', projectId: 'p-live', title: 'Terminal 2' });
  assert.equal(byId.get('studio-1')?.kind, 'content-studio');
  assert.equal(byId.get('studio-1')?.projectId, 'b-live');
  assert.deepEqual(byId.get('task-exec'), { id: 'task-exec', kind: 'task', projectId: 'p-live', title: 'Build the thing' });
  assert.deepEqual(byId.get('task-plan'), { id: 'task-plan', kind: 'planning', projectId: 'p-live', title: 'Plan a launch' });
  assert.equal(byId.get('task-bugs')?.kind, 'bug-report');
  assert.deepEqual(byId.get('orphan'), { id: 'orphan', kind: 'task', projectId: null, title: 'orphan' }, 'an unresolvable PTY still gets a row');
  assert.equal(byId.has('ended'), false, 'an ended PTY is in neither the list nor the count');

  // Parity: the footer's Sessions list is the blocker's terminal-session count.
  const counts = await blocking.computeBlockingCounts(host);
  assert.equal(list.length, counts.terminalSessions);
});

test('GET /api/terminal-sessions answers with the live list', async () => {
  startSleeper(terminalModule.terminalSessionManager, 'route-session');
  const res = await fetch(`http://${baseUrl}/api/terminal-sessions`);
  assert.equal(res.status, 200);
  const list = await res.json() as LiveTerminalSessionDto[];
  assert.ok(list.some((row) => row.id === 'route-session'));
  terminalModule.terminalSessionManager.stop('route-session');
  await until(() => !terminalModule.terminalSessionManager.has('route-session'));
});

test('the websocket sends a terminalSessions snapshot on connect and another on each start and exit', async () => {
  const snapshots: LiveTerminalSessionDto[][] = [];
  const socket = new WebSocket(`ws://${baseUrl}/ws`);
  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'terminalSessions') snapshots.push(event.sessions);
  });
  try {
    await until(() => snapshots.length >= 1);
    const hasSession = () => snapshots.at(-1)?.some((row) => row.id === 'ws-session');
    startSleeper(terminalModule.terminalSessionManager, 'ws-session');
    await until(() => hasSession() === true);
    terminalModule.terminalSessionManager.stop('ws-session');
    await until(() => hasSession() === false);
  } finally {
    socket.close();
  }
});
