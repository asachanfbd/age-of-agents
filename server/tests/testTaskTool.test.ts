import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { PLAN_TASK_MCP_SERVER_NAME } from '../src/terminal/planTaskTool.ts';
import { CLI_HOOK_TOKEN } from '../src/terminal/projectCliHooks.ts';
import { STEP_TASK_MCP_SERVER_NAME } from '../src/terminal/stepTaskTool.ts';
import { TEST_TASK_MCP_SERVER_NAME, TEST_TASK_TOOLS, TESTING_TOOL_INSTRUCTIONS, testTaskMcpServer } from '../src/terminal/testTaskTool.ts';

/** Stands in for the daemon's `/api/agent-testing` routes, answering each request with the next scripted response. */
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
    res.writeHead(next.status, { 'content-type': 'application/json' }).end(next.body);
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  apiUrl = `http://127.0.0.1:${address.port}/api/agent-testing`;
});

after(async () => {
  await new Promise((resolve) => apiServer.close(resolve));
});

/** Launches the real MCP script exactly as testTaskMcpServer describes it, pointed at the stub daemon. */
function startMcp(envOverrides: Record<string, string | undefined> = {}) {
  const launch = testTaskMcpServer('code-task-1');
  const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env, AGENT_VISUAL_OS_TESTING_URL: apiUrl, ...envOverrides };
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
    async call(name: string, args: unknown = {}) {
      return (await this.request(1, 'tools/call', { name, arguments: args })).result as { content: { text: string }[]; isError: boolean };
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

function reply(status: number, body: unknown) {
  received.length = 0;
  responses.push({ status, body: JSON.stringify(body) });
}

test('testTaskMcpServer launches the bundled script scoped to its Task only, with the daemon token', () => {
  const launch = testTaskMcpServer('task-42');
  assert.equal(launch.name, TEST_TASK_MCP_SERVER_NAME);
  assert.notEqual(launch.name, PLAN_TASK_MCP_SERVER_NAME);
  assert.notEqual(launch.name, STEP_TASK_MCP_SERVER_NAME);
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0]!, /bin\/test-task-mcp\.mjs$/);
  assert.deepEqual(launch.env, {
    AGENT_VISUAL_OS_TASK_ID: 'task-42',
    AGENT_VISUAL_OS_TESTING_URL: launch.env.AGENT_VISUAL_OS_TESTING_URL,
    AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
  }, 'no project path, cwd or command: the daemon resolves them from the Task');
  assert.match(launch.env.AGENT_VISUAL_OS_TESTING_URL!, /^http:\/\/127\.0\.0\.1:\d+\/api\/agent-testing$/);
  assert.deepEqual(launch.tools, ['list_test_actions', 'run_test_action', 'get_test_run', 'run_all_tests', 'report_unrelated_test_failure']);
  assert.equal(launch.toolTimeoutSec, 300, 'outlasts the longest server-side wait');
});

test('the instructions steer agents to the registered suites without claiming shell runs are detected', () => {
  assert.match(TESTING_TOOL_INSTRUCTIONS, /Call `list_test_actions` first/);
  assert.match(TESTING_TOOL_INSTRUCTIONS, /Only these runs are recorded as test evidence in the project's Testing tab/);
  assert.match(TESTING_TOOL_INSTRUCTIONS, /targeted tests in the shell while debugging, but those are not recorded/);
  assert.doesNotMatch(TESTING_TOOL_INSTRUCTIONS, /automatically (detected|captured|recorded)/i);
});

test('the handshake lists every testing tool, each taking ids only — never a command or directory', async () => {
  const mcp = startMcp();
  try {
    const init = await mcp.request(1, 'initialize', { protocolVersion: '2025-03-26' });
    assert.equal(init.result.serverInfo.name, 'agent-visual-os-tests');
    const list = await mcp.request(2, 'tools/list');
    const schemas = Object.fromEntries(list.result.tools.map((tool: { name: string; inputSchema: { properties: object; required?: string[]; additionalProperties: boolean } }) => [tool.name, tool.inputSchema]));
    assert.deepEqual(Object.keys(schemas), Object.values(TEST_TASK_TOOLS));
    assert.deepEqual(Object.keys(schemas.list_test_actions.properties), []);
    assert.deepEqual(Object.keys(schemas.run_test_action.properties), ['suiteId', 'actionId', 'waitSeconds']);
    assert.deepEqual(schemas.run_test_action.required, ['suiteId', 'actionId']);
    assert.deepEqual(Object.keys(schemas.get_test_run.properties), ['runId', 'waitSeconds']);
    assert.deepEqual(Object.keys(schemas.run_all_tests.properties), ['waitSeconds']);
    for (const schema of Object.values(schemas) as { additionalProperties: boolean }[]) assert.equal(schema.additionalProperties, false);
  } finally {
    mcp.close();
  }
});

test('list_test_actions relays a GET with the token and task id and returns the daemon JSON', async () => {
  const listing = { config: { state: 'absent', path: '.docs/testing/config.json' }, suites: [], diagnostic: 'No testing config' };
  reply(200, listing);
  const mcp = startMcp();
  try {
    const result = await mcp.call('list_test_actions');
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0]!.text), listing);
    assert.equal(received[0]?.method, 'GET');
    assert.equal(received[0]?.url, '/api/agent-testing/actions?taskId=code-task-1');
    assert.equal(received[0]?.authorization, `Bearer ${CLI_HOOK_TOKEN}`);
  } finally {
    mcp.close();
  }
});

test('run_test_action sends only the suite/action ids and wait, dropping anything else the model adds', async () => {
  reply(201, { runId: 'run-1', status: 'passed', settled: true });
  const mcp = startMcp();
  try {
    const result = await mcp.call('run_test_action', { suiteId: 'unit', actionId: 'run', waitSeconds: 5, command: 'rm -rf /', cwd: '/' });
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0]!.text).runId, 'run-1');
    assert.equal(received[0]?.method, 'POST');
    assert.equal(received[0]?.url, '/api/agent-testing/runs?taskId=code-task-1');
    assert.deepEqual(received[0]?.body, { suiteId: 'unit', actionId: 'run', waitSeconds: 5 });
  } finally {
    mcp.close();
  }
});

test('get_test_run relays the run id and wait; a still-running reply comes back as-is for another call', async () => {
  reply(200, { runId: 'run/2', status: 'running', settled: false, outputTail: 'partial' });
  const mcp = startMcp();
  try {
    const result = await mcp.call('get_test_run', { runId: 'run/2', waitSeconds: 0 });
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0]!.text).settled, false);
    assert.equal(received[0]?.url, '/api/agent-testing/runs/run%2F2?waitSeconds=0&taskId=code-task-1');

    reply(200, { runId: 'run-3', status: 'passed', settled: true });
    await mcp.call('get_test_run', { runId: 'run-3' });
    assert.equal(received[0]?.url, '/api/agent-testing/runs/run-3?taskId=code-task-1', 'no wait given: the daemon default applies');
  } finally {
    mcp.close();
  }
});

test('run_all_tests relays a POST with the wait', async () => {
  reply(201, { batchId: 'b1', settled: true, runs: [], joined: [] });
  const mcp = startMcp();
  try {
    const result = await mcp.call('run_all_tests', { waitSeconds: 30 });
    assert.equal(JSON.parse(result.content[0]!.text).batchId, 'b1');
    assert.equal(received[0]?.url, '/api/agent-testing/run-all?taskId=code-task-1');
    assert.deepEqual(received[0]?.body, { waitSeconds: 30 });
  } finally {
    mcp.close();
  }
});

test('a daemon rejection, an opaque error and an unreachable daemon are tool errors, not crashes', async () => {
  reply(409, { error: 'Task "code-task-1" is not an active coding session, so it cannot run tests' });
  responses.push({ status: 502, body: 'not json' });
  const mcp = startMcp();
  try {
    const stale = await mcp.call('run_test_action', { suiteId: 'unit', actionId: 'run' });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0]!.text, /not an active coding session/);
    const opaque = await mcp.call('list_test_actions');
    assert.equal(opaque.isError, true);
    assert.match(opaque.content[0]!.text, /HTTP 502/);
  } finally {
    mcp.close();
  }

  const offline = startMcp({ AGENT_VISUAL_OS_TESTING_URL: 'http://127.0.0.1:1/api/agent-testing' });
  try {
    const result = await offline.call('list_test_actions');
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /^Failed:/);
  } finally {
    offline.close();
  }
});

test('a session the daemon did not launch is refused without any request', async () => {
  for (const missing of ['AGENT_VISUAL_OS_HOOK_TOKEN', 'AGENT_VISUAL_OS_TASK_ID']) {
    received.length = 0;
    const mcp = startMcp({ [missing]: undefined });
    try {
      const result = await mcp.call('run_test_action', { suiteId: 'unit', actionId: 'run' });
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /not connected to Agent Visual OS/);
      assert.equal(received.length, 0);
    } finally {
      mcp.close();
    }
  }
});

test('unknown tools, unknown methods and malformed lines get errors and the server keeps running', async () => {
  const mcp = startMcp();
  try {
    assert.equal((await mcp.call('run_shell', { command: 'npm test' })).isError, true);
    assert.equal((await mcp.request(2, 'resources/list')).error.code, -32601);
    mcp.write('{not json');
    assert.deepEqual(await mcp.read(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    assert.deepEqual(await mcp.request(3, 'ping'), { jsonrpc: '2.0', id: 3, result: {} });
  } finally {
    mcp.close();
  }
});
