import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AgentSessionDto, AgentSessions } from '../src/terminal/agentSessions.ts';
import type { TerminalSessionHost, TerminalSessionStart } from '../src/terminal/terminalSessionManager.ts';
import { fakeTerminalHost } from './helpers/terminalStepFakes.ts';

/**
 * Agent terminal sessions (terminal/agentSessions.ts): launch arguments, numbering, the naming tool,
 * persistence and resume. The terminal host is fake, so no CLI is ever started, and every record lives
 * in a temp data dir.
 */

let tempRoot: string;
let server: HttpServer;
let baseUrl: string;
let token: string;
let terminal: ReturnType<typeof fakeTerminalHost>;
let sessionExistsAnswer = true;
let service: AgentSessions;
let agentSessionsModule: typeof import('../src/terminal/agentSessions.ts');
let terminalModule: typeof import('../src/terminal/terminalSessionManager.ts');
let projectService: typeof import('../src/projects/projectService.ts');
let collections: typeof import('../src/db/collections.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-sessions-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.resolve('tests/fixtures/executors.json');
  agentSessionsModule = await import('../src/terminal/agentSessions.ts');
  terminalModule = await import('../src/terminal/terminalSessionManager.ts');
  projectService = await import('../src/projects/projectService.ts');
  collections = await import('../src/db/collections.ts');
  token = (await import('../src/terminal/projectCliHooks.ts')).CLI_HOOK_TOKEN;
  terminal = fakeTerminalHost();
  const host: TerminalSessionHost = { ...terminal.host, sessionExists: () => sessionExistsAnswer };
  service = agentSessionsModule.createAgentSessions({ host });
  const { createDaemonServer } = await import('../src/server.ts');
  server = createDaemonServer({ agentSessions: service });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

async function api(pathname: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...rest.headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

let count = 0;
async function createProject() {
  return projectService.createProject({ name: `Agent Terminals ${(count += 1)}`, position: null });
}

async function startSession(projectId: string, executorId = 'test-claude-cli') {
  return api(`/api/projects/${projectId}/agent-sessions`, { method: 'POST', json: { executorId } });
}

/** The naming tool call as the session itself makes it. */
function nameTool(sessionId: string, name: unknown, auth: string | null = `Bearer ${token}`) {
  return api(`/api/agent-session/name?taskId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
    json: { name },
  });
}

/** Waits for a stored change: the terminal's callbacks write the record after the test's own call returns. */
async function waitForRecord(id: string, done: (record: import('../src/terminal/agentSessions.ts').AgentSessionRecord) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const record = await collections.agentSessionsDb.get(id);
    if (record && done(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the stored session never reached the expected state');
}

const lastStart = (): TerminalSessionStart => terminal.starts.at(-1)!;

// ---- Pure helpers ----

test('U6-U10: default names count up per project and never come from the list length', () => {
  const { defaultSessionName, sessionDisplayName } = agentSessionsModule;
  assert.equal(defaultSessionName(1), 'Terminal 1');
  assert.equal(defaultSessionName(10_000), 'Terminal 10000');
  assert.equal(defaultSessionName(Number.MAX_SAFE_INTEGER), `Terminal ${Number.MAX_SAFE_INTEGER}`);
  assert.equal(sessionDisplayName({ name: null, number: 4 }), 'Terminal 4');
  assert.equal(sessionDisplayName({ name: 'Fix login', number: 4 }), 'Fix login');
});

test('U11-U14: a name is trimmed, must be non-empty, at most 80 characters, and loses control characters', () => {
  const { normalizeSessionName, MAX_SESSION_NAME_LENGTH } = agentSessionsModule;
  assert.equal(normalizeSessionName('  Fix login  '), 'Fix login');
  assert.equal(normalizeSessionName('a'.repeat(MAX_SESSION_NAME_LENGTH)).length, MAX_SESSION_NAME_LENGTH);
  assert.throws(() => normalizeSessionName('a'.repeat(MAX_SESSION_NAME_LENGTH + 1)), /at most 80/);
  assert.throws(() => normalizeSessionName('a'.repeat(10_000)), /at most 80/);
  assert.throws(() => normalizeSessionName('   '), /must not be empty/);
  assert.throws(() => normalizeSessionName('\n\t'), /must not be empty/);
  assert.throws(() => normalizeSessionName(42), /must be a string/);
  assert.equal(normalizeSessionName('Fix\nlogin\u0007 now'), 'Fix login now');
  assert.equal(normalizeSessionName('Café 🚀 日本語'), 'Café 🚀 日本語');
});

// ---- Launch ----

test('I1/U1/U4/I6: starting a session launches a permissive, app-tooled CLI in the project folder', async () => {
  const project = await createProject();
  const { status, body } = await startSession(project.id);
  assert.equal(status, 201);
  assert.equal(body.name, 'Terminal 1');
  assert.equal(body.state, 'running');
  assert.equal(body.executorId, 'test-claude-cli');

  const start = lastStart();
  assert.equal(start.taskId, body.id);
  assert.equal(start.cwd, projectService.projectAbsolutePath(project));
  assert.equal(start.autonomy, 'auto');
  assert.equal(start.reportHooks, false);
  assert.equal(start.resume, false);
  assert.equal(start.readOnly, undefined);
  assert.equal(start.disallowedTools, undefined);
  assert.equal(start.readOnlyDirs, undefined);
  assert.match(start.systemPrompt, /rename_session/);
  assert.match(start.systemPrompt, /two or three exchanges/);
  assert.deepEqual(start.mcpServers?.map((server) => server.name), ['agent_visual_os_session', 'agent_visual_os', 'agent_visual_os_tests']);
  assert.ok(start.mcpServers?.every((server) => server.env.AGENT_VISUAL_OS_TASK_ID === body.id));

  const args = terminalModule.interactiveCliArgs(start);
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2), ['--session-id', start.sessionId]);
  assert.ok(start.sessionId, 'Claude gets its conversation id up front');
});

test('U3: Codex launches without its sandbox and resumes by the discovered conversation id', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id, 'test-codex-cli');
  const start = lastStart();
  assert.equal(start.sessionId, null);
  assert.ok(terminalModule.interactiveCliArgs(start).includes('--dangerously-bypass-approvals-and-sandbox'));

  start.onSessionId?.('codex-conversation-1');
  start.onExit(0, undefined, 'codex-conversation-1');
  await waitForRecord(body.id, (record) => record.state === 'ended' && record.agentSessionId === 'codex-conversation-1');
  await api(`/api/agent-sessions/${body.id}/resume`, { method: 'POST' });
  const resumed = lastStart();
  assert.equal(resumed.resume, true);
  const args = terminalModule.interactiveCliArgs(resumed);
  assert.equal(args[0], 'resume');
  assert.ok(args.includes('codex-conversation-1'));
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('I2/U8: numbers count per project and are not reused after a delete', async () => {
  const a = await createProject();
  const b = await createProject();
  const first = (await startSession(a.id)).body;
  const second = (await startSession(a.id)).body;
  assert.deepEqual([first.name, second.name], ['Terminal 1', 'Terminal 2']);
  assert.equal((await startSession(b.id)).body.name, 'Terminal 1');

  assert.equal((await api(`/api/agent-sessions/${first.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await startSession(a.id)).body.name, 'Terminal 3');
  const listed = (await api(`/api/projects/${a.id}/agent-sessions`)).body as AgentSessionDto[];
  assert.deepEqual(listed.map((s) => s.name).sort(), ['Terminal 2', 'Terminal 3']);
});

test('I2: two simultaneous starts get different numbers', async () => {
  const project = await createProject();
  const [x, y] = await Promise.all([startSession(project.id), startSession(project.id)]);
  assert.deepEqual([x.body.name, y.body.name].sort(), ['Terminal 1', 'Terminal 2']);
});

test('I3-I5: a start needs a known project and a known CLI agent', async () => {
  const project = await createProject();
  assert.equal((await startSession('no-such-project')).status, 404);
  assert.equal((await startSession(project.id, 'no-such-executor')).status, 404);
  assert.equal((await startSession(project.id, 'test-unsupported')).status, 422);
  assert.equal((await api(`/api/projects/${project.id}/agent-sessions`, { method: 'POST', json: {} })).status, 400);
  assert.deepEqual((await api(`/api/projects/${project.id}/agent-sessions`)).body, []);
});

test('privacy: the web record carries no conversation id, environment, token or folder', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  const text = JSON.stringify(body);
  assert.deepEqual(Object.keys(body).sort(), ['createdAt', 'executorId', 'id', 'name', 'projectId', 'state', 'updatedAt']);
  assert.ok(!text.includes(token));
  assert.ok(!text.includes(String(lastStart().sessionId)));
  assert.ok(!text.includes(projectService.projectAbsolutePath(project)));
});

test('I7: other session types gain no Agent permissions or tools', async () => {
  const planning = terminalModule.interactiveCliArgs({
    kind: 'claude-cli', prompt: '', systemPrompt: 'plan', autonomy: 'approval', disallowedTools: ['Edit'], readOnly: true, mcpServers: [],
  });
  assert.ok(!planning.includes('--dangerously-skip-permissions'));
  assert.ok(!planning.join(' ').includes('rename_session'));
});

// ---- Naming ----

test('I8/I12: the session names itself through the tool and the person can rename over it', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  const events: unknown[] = [];
  const off = service.onEvent((event) => events.push(event));

  const named = await nameTool(body.id, '  Fix login redirect ');
  assert.equal(named.status, 200);
  assert.equal(named.body.name, 'Fix login redirect');
  assert.deepEqual(events.at(-1), { type: 'agentSession', session: named.body });

  const manual = await api(`/api/agent-sessions/${body.id}`, { method: 'PATCH', json: { name: 'My name' } });
  assert.equal(manual.body.name, 'My name');
  off();
  assert.equal(((await api(`/api/projects/${project.id}/agent-sessions`)).body as AgentSessionDto[])[0]!.name, 'My name');
});

test('I9: the naming tool refuses a missing or wrong token and leaves the name alone', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  assert.equal((await nameTool(body.id, 'x', null)).status, 401);
  assert.equal((await nameTool(body.id, 'x', 'Bearer wrong')).status, 401);
  assert.equal(((await api(`/api/projects/${project.id}/agent-sessions`)).body as AgentSessionDto[])[0]!.name, 'Terminal 1');
});

test('I10: the naming tool answers 404 for an unknown session and 400 without a session id', async () => {
  assert.equal((await nameTool('no-such-session', 'x')).status, 404);
  const res = await api('/api/agent-session/name', { method: 'POST', headers: { authorization: `Bearer ${token}` }, json: { name: 'x' } });
  assert.equal(res.status, 400);
});

test('I11: an empty or overlong name is refused and the name stays', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  assert.equal((await nameTool(body.id, '   ')).status, 400);
  assert.equal((await nameTool(body.id, 'a'.repeat(81))).status, 400);
  assert.equal((await api(`/api/agent-sessions/${body.id}`, { method: 'PATCH', json: { name: '' } })).status, 400);
  assert.equal(((await api(`/api/projects/${project.id}/agent-sessions`)).body as AgentSessionDto[])[0]!.name, 'Terminal 1');
});

// ---- Resume, end, delete, persistence ----

test('I14/U2: resume relaunches the stored conversation with the same permissions and name', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  await nameTool(body.id, 'Keep me');
  const first = lastStart();
  first.onExit(0);
  await waitForRecord(body.id, (record) => record.state === 'ended');
  assert.equal(((await api(`/api/projects/${project.id}/agent-sessions`)).body as AgentSessionDto[])[0]!.state, 'ended');

  const resumed = await api(`/api/agent-sessions/${body.id}/resume`, { method: 'POST' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.state, 'running');
  assert.equal(resumed.body.name, 'Keep me');
  const start = lastStart();
  assert.equal(start.resume, true);
  assert.equal(start.sessionId, first.sessionId);
  assert.equal(start.autonomy, 'auto');
  assert.equal(start.systemPrompt, first.systemPrompt);
  const args = terminalModule.interactiveCliArgs(start);
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', first.sessionId]);
  assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('I15: resuming a running session starts nothing, a lost conversation starts afresh, a deleted session is 404', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  const before = terminal.starts.length;
  assert.equal((await api(`/api/agent-sessions/${body.id}/resume`, { method: 'POST' })).status, 200);
  assert.equal(terminal.starts.length, before);

  const original = lastStart();
  original.onExit(0);
  await waitForRecord(body.id, (record) => record.state === 'ended');
  sessionExistsAnswer = false;
  try {
    assert.equal((await api(`/api/agent-sessions/${body.id}/resume`, { method: 'POST' })).status, 200);
  } finally {
    sessionExistsAnswer = true;
  }
  const fresh = lastStart();
  assert.equal(fresh.resume, false);
  assert.notEqual(fresh.sessionId, original.sessionId);

  await api(`/api/agent-sessions/${body.id}`, { method: 'DELETE' });
  assert.equal((await api(`/api/agent-sessions/${body.id}/resume`, { method: 'POST' })).status, 404);
});

test('I16: end keeps the record; delete removes it, stops a live terminal and keeps the counter', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  const ended = await api(`/api/agent-sessions/${body.id}/end`, { method: 'POST' });
  assert.equal(ended.body.state, 'ended');
  assert.ok(terminal.stops.includes(body.id));
  assert.equal(((await api(`/api/projects/${project.id}/agent-sessions`)).body as AgentSessionDto[]).length, 1);

  const events: unknown[] = [];
  const off = service.onEvent((event) => events.push(event));
  assert.equal((await api(`/api/agent-sessions/${body.id}`, { method: 'DELETE' })).status, 204);
  off();
  assert.deepEqual(events.at(-1), { type: 'agentSessionDeleted', id: body.id, projectId: project.id });
  assert.equal((await api(`/api/agent-sessions/${body.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await startSession(project.id)).body.name, 'Terminal 2');
});

test('I16: the terminal exiting marks the session ended', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  lastStart().onExit(0);
  await waitForRecord(body.id, (record) => record.state === 'ended');
  assert.equal(((await api(`/api/projects/${project.id}/agent-sessions`)).body as AgentSessionDto[])[0]!.state, 'ended');
});

test('I13: sessions, names and the counter outlive the process; a session left running is marked ended', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  await nameTool(body.id, 'Survivor');

  const restarted = fakeTerminalHost();
  const afterRestart = agentSessionsModule.createAgentSessions({ host: restarted.host });
  assert.equal((await collections.agentSessionsDb.get(body.id))?.state, 'running');
  await afterRestart.markInterruptedEnded();
  const [kept] = await afterRestart.list(project.id);
  assert.equal(kept!.name, 'Survivor');
  assert.equal(kept!.state, 'ended');
  assert.equal((await collections.agentSessionsDb.get(body.id))?.state, 'ended');
  assert.equal((await afterRestart.create(project.id, 'test-claude-cli')).name, 'Terminal 2');
});

// ---- Tools ----

test('the task tools reach the session\'s own project, and refuse a session that is not running', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  const call = (method: string, route: string, json?: unknown) =>
    api(`/api/agent-tasks${route}${route.includes('?') ? '&' : '?'}taskId=${body.id}`, { method, headers: { authorization: `Bearer ${token}` }, json });
  const created = await call('POST', '', { title: 'Add search', description: 'A search box' });
  assert.equal(created.status, 201);
  assert.equal(created.body.projectId, project.id);
  assert.deepEqual((await call('GET', '')).body.map((item: { id: string }) => item.id), [created.body.id]);
  assert.equal((await call('PATCH', `/${created.body.id}`, { title: 'Add search box' })).body.title, 'Add search box');
  assert.equal((await call('DELETE', `/${created.body.id}`)).status, 204);

  await api(`/api/agent-sessions/${body.id}/end`, { method: 'POST' });
  terminal.live.delete(body.id);
  assert.equal((await call('GET', '')).status, 409);
});

test('the testing tools answer for an Agent session in its project folder; filing bugs is refused', async () => {
  const project = await createProject();
  const { body } = await startSession(project.id);
  const headers = { authorization: `Bearer ${token}` };
  const actions = await api(`/api/agent-testing/actions?taskId=${body.id}`, { headers });
  assert.equal(actions.status, 200);
  assert.equal(actions.body.config.state, 'absent');
  const bug = await api(`/api/agent-testing/bugs?taskId=${body.id}`, { method: 'POST', headers, json: {} });
  assert.equal(bug.status, 409);
});
