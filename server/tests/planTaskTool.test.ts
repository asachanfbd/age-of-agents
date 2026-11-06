import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { PLAN_TASK_MCP_SERVER_NAME, PLAN_TASK_TOOLS, planTaskMcpServer } from '../src/terminal/planTaskTool.ts';
import { CLI_HOOK_TOKEN } from '../src/terminal/projectCliHooks.ts';

/** Stands in for the daemon's `/api/agent-tasks` routes, answering each request with the next scripted response. */
let apiServer: Server;
let apiUrl: string;
const received: { method?: string; url?: string; authorization?: string; body: unknown }[] = [];
const responses: { status: number; body: string }[] = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

before(async () => {
  apiServer = createServer(async (req, res) => {
    const raw = await readBody(req);
    received.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const next = responses.shift() ?? { status: 500, body: '{}' };
    res.writeHead(next.status, { 'content-type': 'application/json' }).end(next.status === 204 ? undefined : next.body);
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  apiUrl = `http://127.0.0.1:${address.port}/api/agent-tasks`;
});

after(async () => {
  await new Promise((resolve) => apiServer.close(resolve));
});

/** Launches the real MCP script exactly as planTaskMcpServer describes it, and exchanges JSON-RPC lines with it. */
function startMcp(envOverrides: Record<string, string | undefined> = {}) {
  const launch = planTaskMcpServer('plan-task-1');
  const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env, AGENT_VISUAL_OS_TASKS_URL: apiUrl, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) if (value === undefined) delete env[key];
  const child = spawn(launch.command, launch.args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    write(message: unknown) { child.stdin.write(typeof message === 'string' ? `${message}\n` : `${JSON.stringify(message)}\n`); },
    async read() { return JSON.parse((await lines.next()).value as string); },
    async request(id: number, method: string, params?: unknown) {
      this.write({ jsonrpc: '2.0', id, method, params });
      return this.read();
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

test('planTaskMcpServer launches the bundled MCP script scoped to its Task, with the daemon token', () => {
  const launch = planTaskMcpServer('task-42');
  assert.equal(launch.name, PLAN_TASK_MCP_SERVER_NAME);
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0]!, /bin\/plan-task-mcp\.mjs$/);
  assert.equal(launch.env.AGENT_VISUAL_OS_TASK_ID, 'task-42');
  assert.equal(launch.env.AGENT_VISUAL_OS_HOOK_TOKEN, CLI_HOOK_TOKEN);
  assert.match(launch.env.AGENT_VISUAL_OS_TASKS_URL!, /^http:\/\/127\.0\.0\.1:\d+\/api\/agent-tasks$/);
  assert.deepEqual(launch.tools, ['list_tasks', 'create_task', 'update_task', 'delete_task']);
});

test('the MCP server completes the handshake and lists every task-management tool', async () => {
  const mcp = startMcp();
  try {
    const init = await mcp.request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, '2025-03-26', 'echoes the client protocol version');
    assert.deepEqual(init.result.capabilities, { tools: {} });

    mcp.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const ping = await mcp.request(2, 'ping');
    assert.deepEqual(ping, { jsonrpc: '2.0', id: 2, result: {} }, 'the notification got no reply, so the next line is the ping answer');

    const list = await mcp.request(3, 'tools/list');
    const tools = Object.fromEntries(list.result.tools.map((tool: { name: string; inputSchema: { required?: string[] } }) => [tool.name, tool.inputSchema.required]));
    const update = list.result.tools.find((tool: { name: string }) => tool.name === PLAN_TASK_TOOLS.update);
    assert.match(update.description, /already done, cannot be changed — create a new task/, 'steers the session away from repurposing a completed task');
    const create = list.result.tools.find((tool: { name: string }) => tool.name === PLAN_TASK_TOOLS.create);
    assert.match(create.description, /one task per feature/, 'one task covers a whole feature');
    const description = create.inputSchema.properties.description.description;
    assert.match(description, /feature specification, self-contained/);
    assert.match(description, /acceptance criteria/);
    assert.match(description, /not how: no file paths, code names, data structures or coding steps/);
    assert.deepEqual(tools, {
      [PLAN_TASK_TOOLS.list]: undefined,
      [PLAN_TASK_TOOLS.create]: ['title', 'description'],
      [PLAN_TASK_TOOLS.update]: ['id'],
      [PLAN_TASK_TOOLS.delete]: ['id'],
    });
  } finally {
    mcp.close();
  }
});

test('create_task relays title and description to the daemon with the session token and task id', async () => {
  responses.push({ status: 201, body: JSON.stringify({ id: 'item-1', title: 'Add login' }) });
  received.length = 0;
  const mcp = startMcp();
  try {
    const res = await mcp.request(1, 'tools/call', { name: PLAN_TASK_TOOLS.create, arguments: { title: 'Add login', description: 'Email + password' } });
    assert.deepEqual(res.result, { content: [{ type: 'text', text: 'Created task item-1: Add login' }], isError: false });
    assert.equal(received[0]?.authorization, `Bearer ${CLI_HOOK_TOKEN}`);
    assert.equal(received[0]?.method, 'POST');
    assert.equal(received[0]?.url, '/api/agent-tasks?taskId=plan-task-1');
    assert.deepEqual(received[0]?.body, { title: 'Add login', description: 'Email + password' });
  } finally {
    mcp.close();
  }
});

test('list_tasks relays a GET and returns the tasks as JSON', async () => {
  responses.push({ status: 200, body: JSON.stringify([{ id: 'item-1', title: '1.001: Add login', description: 'Email', status: 'pending', order: 0 }]) });
  received.length = 0;
  const mcp = startMcp();
  try {
    const res = await mcp.request(1, 'tools/call', { name: PLAN_TASK_TOOLS.list, arguments: {} });
    assert.equal(res.result.isError, false);
    assert.deepEqual(JSON.parse(res.result.content[0].text), [{ id: 'item-1', title: '1.001: Add login', description: 'Email', status: 'pending' }]);
    assert.equal(received[0]?.method, 'GET');
    assert.equal(received[0]?.url, '/api/agent-tasks?taskId=plan-task-1');
    assert.equal(received[0]?.body, null);
  } finally {
    mcp.close();
  }
});

test('update_task relays a PATCH for the named task with only the given fields', async () => {
  responses.push({ status: 200, body: JSON.stringify({ id: 'item 1', title: '1.001: Sign in' }) });
  received.length = 0;
  const mcp = startMcp();
  try {
    const res = await mcp.request(1, 'tools/call', { name: PLAN_TASK_TOOLS.update, arguments: { id: 'item 1', title: 'Sign in' } });
    assert.deepEqual(res.result, { content: [{ type: 'text', text: 'Updated task item 1: 1.001: Sign in' }], isError: false });
    assert.equal(received[0]?.method, 'PATCH');
    assert.equal(received[0]?.url, '/api/agent-tasks/item%201?taskId=plan-task-1');
    assert.deepEqual(received[0]?.body, { title: 'Sign in' });
  } finally {
    mcp.close();
  }
});

test('delete_task relays a DELETE for the named task', async () => {
  responses.push({ status: 204, body: '' });
  received.length = 0;
  const mcp = startMcp();
  try {
    const res = await mcp.request(1, 'tools/call', { name: PLAN_TASK_TOOLS.delete, arguments: { id: 'item-1' } });
    assert.deepEqual(res.result, { content: [{ type: 'text', text: 'Deleted task item-1' }], isError: false });
    assert.equal(received[0]?.method, 'DELETE');
    assert.equal(received[0]?.url, '/api/agent-tasks/item-1?taskId=plan-task-1');
  } finally {
    mcp.close();
  }
});

test('create_task reports a daemon rejection as a tool error instead of crashing', async () => {
  responses.push({ status: 409, body: JSON.stringify({ error: 'not a running planning session' }) });
  responses.push({ status: 502, body: 'not json' });
  const mcp = startMcp();
  try {
    const rejected = await mcp.request(1, 'tools/call', { name: PLAN_TASK_TOOLS.create, arguments: { title: 'X', description: '' } });
    assert.equal(rejected.result.isError, true);
    assert.match(rejected.result.content[0].text, /not a running planning session/);

    const opaque = await mcp.request(2, 'tools/call', { name: PLAN_TASK_TOOLS.create, arguments: { title: 'X', description: '' } });
    assert.equal(opaque.result.isError, true);
    assert.match(opaque.result.content[0].text, /HTTP 502/);
  } finally {
    mcp.close();
  }
});

test('create_task reports an unreachable daemon as a tool error', async () => {
  const mcp = startMcp({ AGENT_VISUAL_OS_TASKS_URL: 'http://127.0.0.1:1/api/agent-tasks' });
  try {
    const res = await mcp.request(1, 'tools/call', { name: PLAN_TASK_TOOLS.create, arguments: { title: 'X', description: '' } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /^Failed:/);
  } finally {
    mcp.close();
  }
});

test('create_task refuses outright when the session was not launched by the daemon', async () => {
  const mcp = startMcp({ AGENT_VISUAL_OS_HOOK_TOKEN: undefined });
  try {
    const res = await mcp.request(1, 'tools/call', { name: PLAN_TASK_TOOLS.create, arguments: { title: 'X', description: '' } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /not connected to Agent Visual OS/);
  } finally {
    mcp.close();
  }
});

test('the MCP server answers unknown tools, unknown methods, and malformed lines with errors', async () => {
  const mcp = startMcp();
  try {
    const unknownTool = await mcp.request(1, 'tools/call', { name: 'delete_everything', arguments: {} });
    assert.equal(unknownTool.result.isError, true);

    const unknownMethod = await mcp.request(2, 'resources/list');
    assert.equal(unknownMethod.error.code, -32601);

    mcp.write('');
    mcp.write('{not json');
    const parseError = await mcp.read();
    assert.deepEqual(parseError, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  } finally {
    mcp.close();
  }
});
