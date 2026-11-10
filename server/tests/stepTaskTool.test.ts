import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { after, before, beforeEach, test } from 'node:test';
import { STEP_TASK_MCP_SERVER_NAME, STEP_TASK_TOOLS, stepTaskMcpServer } from '../src/terminal/stepTaskTool.ts';
import { CLI_HOOK_TOKEN } from '../src/terminal/projectCliHooks.ts';

/** Stands in for the daemon's `/api/workflow-steps` and `/api/catalog` routes, answering each request with the next scripted response. */
let apiServer: Server;
let apiBase: string;
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
  apiBase = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  await new Promise((resolve) => apiServer.close(resolve));
});

beforeEach(() => {
  received.length = 0;
  responses.length = 0;
});

/** Launches the real MCP script exactly as stepTaskMcpServer describes it, pointed at the fake daemon. */
function startMcp(envOverrides: Record<string, string | undefined> = {}) {
  const launch = stepTaskMcpServer('step-task-1');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launch.env,
    AGENT_VISUAL_OS_STEP_URL: `${apiBase}/workflow-steps`,
    AGENT_VISUAL_OS_CATALOG_URL: `${apiBase}/catalog`,
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(envOverrides)) if (value === undefined) delete env[key];
  const child = spawn(launch.command, launch.args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let nextId = 1;
  return {
    async call(name: string, args: unknown) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })}\n`);
      return JSON.parse((await lines.next()).value as string).result as { content: { text: string }[]; isError: boolean };
    },
    async listTools() {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' })}\n`);
      return JSON.parse((await lines.next()).value as string).result.tools as { name: string; description: string; inputSchema: { required?: string[] } }[];
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

const WORKFLOW = {
  id: 'software-development',
  name: 'Software Development',
  steps: [
    { id: 'development', agentId: 'builder', instructions: 'Build it.', agent: { id: 'builder', name: 'Builder' } },
    { id: 'docs-and-retro', agentId: 'builder', instructions: 'Retro.', agent: { id: 'builder', name: 'Builder' } },
  ],
};

test('stepTaskMcpServer points the MCP script at both the step and catalog APIs, and pre-approves every tool', () => {
  const launch = stepTaskMcpServer('task-7');
  assert.equal(launch.name, STEP_TASK_MCP_SERVER_NAME);
  assert.match(launch.args[0]!, /bin\/step-task-mcp\.mjs$/);
  assert.equal(launch.env.AGENT_VISUAL_OS_TASK_ID, 'task-7');
  assert.equal(launch.env.AGENT_VISUAL_OS_HOOK_TOKEN, CLI_HOOK_TOKEN);
  assert.match(launch.env.AGENT_VISUAL_OS_STEP_URL!, /^http:\/\/127\.0\.0\.1:\d+\/api\/workflow-steps$/);
  assert.match(launch.env.AGENT_VISUAL_OS_CATALOG_URL!, /^http:\/\/127\.0\.0\.1:\d+\/api\/catalog$/);
  assert.deepEqual(launch.tools, ['complete_step', 'skip_step', 'diff_summary', 'diff_file', 'report_progress', 'update_workflow_step', 'update_skill']);
});

test('the shared-Catalog tools are listed with an explicit-yes-only rule in their descriptions', async () => {
  const mcp = startMcp();
  try {
    const tools = await mcp.listTools();
    for (const name of [STEP_TASK_TOOLS.updateWorkflowStep, STEP_TASK_TOOLS.updateSkill]) {
      const tool = tools.find((t) => t.name === name)!;
      assert.match(tool.description, /ONLY after .* asked them directly, and received an explicit "yes"/);
    }
    assert.deepEqual(tools.find((t) => t.name === STEP_TASK_TOOLS.updateWorkflowStep)!.inputSchema.required, ['workflowId', 'stepId', 'instructions']);
    assert.deepEqual(tools.find((t) => t.name === STEP_TASK_TOOLS.updateSkill)!.inputSchema.required, ['skillId', 'body']);
  } finally {
    mcp.close();
  }
});

test('complete_step and skip_step describe their summary, outputs and reason in the house style for readable summaries', async () => {
  const mcp = startMcp();
  try {
    type Schema = { properties: Record<string, { description?: string; items?: { properties: Record<string, { description?: string }> } }> };
    const tools = await mcp.listTools() as unknown as { name: string; inputSchema: Schema }[];
    const complete = tools.find((t) => t.name === STEP_TASK_TOOLS.complete)!.inputSchema.properties;
    assert.match(complete.summary!.description!, /Markdown summary .* house style .* TL;DR first/);
    assert.match(complete.summary!.description!, /never drop anything they rely on/);
    assert.match(complete.outputs!.items!.properties.content!.description!, /Markdown output follows the same house style/);
    const skip = tools.find((t) => t.name === STEP_TASK_TOOLS.skip)!.inputSchema.properties;
    assert.match(skip.reason!.description!, /plain language .* one sentence; no headings/);
  } finally {
    mcp.close();
  }
});

test('B036 complete_step says outputs are inline strings that need no file-write permission', async () => {
  const mcp = startMcp();
  try {
    const tools = await mcp.listTools() as unknown as { name: string; description: string; inputSchema: { properties: Record<string, { type?: string; description?: string }> } }[];
    const complete = tools.find((t) => t.name === STEP_TASK_TOOLS.complete)!;
    assert.match(complete.description, /passed inline as strings, not written as files/);
    const outputs = complete.inputSchema.properties.outputs!;
    assert.equal(outputs.type, 'array');
    assert.match(outputs.description!, /passed inline as a string in `content`; outputs are not files and need no file-write permission/);
  } finally {
    mcp.close();
  }
});

test('update_workflow_step reads the workflow, then PUTs every step back with only the named step\'s instructions changed', async () => {
  responses.push({ status: 200, body: JSON.stringify(WORKFLOW) }, { status: 200, body: JSON.stringify(WORKFLOW) });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.updateWorkflowStep, { workflowId: 'software-development', stepId: 'docs-and-retro', instructions: 'Retro, better.' });
    assert.deepEqual(res, { content: [{ type: 'text', text: 'Updated the instructions of step "docs-and-retro" in workflow "software-development".' }], isError: false });
    assert.deepEqual(received.map((r) => [r.method, r.url]), [
      ['GET', '/api/catalog/workflows/software-development'],
      ['PUT', '/api/catalog/workflows/software-development'],
    ]);
    assert.equal(received[1]?.authorization, `Bearer ${CLI_HOOK_TOKEN}`);
    assert.deepEqual(received[1]?.body, {
      steps: [
        { id: 'development', agentId: 'builder', instructions: 'Build it.' },
        { id: 'docs-and-retro', agentId: 'builder', instructions: 'Retro, better.' },
      ],
    }, 'the display-only `agent` decoration is stripped and nothing else is sent');
  } finally {
    mcp.close();
  }
});

test('update_workflow_step reports an unknown workflow without writing anything', async () => {
  responses.push({ status: 404, body: JSON.stringify({ error: 'No workflow "nope" in the Catalog' }) });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.updateWorkflowStep, { workflowId: 'nope', stepId: 'development', instructions: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /No workflow "nope"/);
    assert.deepEqual(received.map((r) => r.method), ['GET']);
  } finally {
    mcp.close();
  }
});

test('update_workflow_step reports an unknown step without writing anything', async () => {
  responses.push({ status: 200, body: JSON.stringify(WORKFLOW) });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.updateWorkflowStep, { workflowId: 'software-development', stepId: 'ghost', instructions: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /has no step "ghost"/);
    assert.deepEqual(received.map((r) => r.method), ['GET']);
  } finally {
    mcp.close();
  }
});

test('update_workflow_step surfaces the Catalog\'s own validation rejection', async () => {
  responses.push({ status: 200, body: JSON.stringify(WORKFLOW) }, { status: 400, body: JSON.stringify({ error: 'step "development" instructions is required' }) });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.updateWorkflowStep, { workflowId: 'software-development', stepId: 'development', instructions: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /instructions is required/);
  } finally {
    mcp.close();
  }
});

test('update_workflow_step and update_skill reject blank or missing input before calling the daemon', async () => {
  const mcp = startMcp();
  try {
    const step = await mcp.call(STEP_TASK_TOOLS.updateWorkflowStep, { workflowId: 'software-development', stepId: 'development', instructions: '   ' });
    assert.equal(step.isError, true);
    assert.match(step.content[0]!.text, /are all required/);
    const skill = await mcp.call(STEP_TASK_TOOLS.updateSkill, { skillId: 'tdd' });
    assert.equal(skill.isError, true);
    assert.match(skill.content[0]!.text, /skillId and body are required/);
    const noArgs = await mcp.call(STEP_TASK_TOOLS.updateSkill, undefined);
    assert.equal(noArgs.isError, true);
    assert.equal(received.length, 0);
  } finally {
    mcp.close();
  }
});

test('update_skill relays the new body and description to the existing skill PUT route', async () => {
  responses.push({ status: 200, body: JSON.stringify({ id: 'tdd' }) });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.updateSkill, { skillId: 'tdd', body: '# TDD\nWrite the test first.', description: 'Test first' });
    assert.deepEqual(res, { content: [{ type: 'text', text: 'Updated skill "tdd".' }], isError: false });
    assert.equal(received[0]?.method, 'PUT');
    assert.equal(received[0]?.url, '/api/catalog/skills/tdd');
    assert.deepEqual(received[0]?.body, { body: '# TDD\nWrite the test first.', description: 'Test first' });
  } finally {
    mcp.close();
  }
});

test('update_skill reports an unknown skill', async () => {
  responses.push({ status: 404, body: JSON.stringify({ error: 'No skill "ghost" in the Catalog' }) });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.updateSkill, { skillId: 'ghost', body: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /No skill "ghost"/);
  } finally {
    mcp.close();
  }
});

test('the Catalog tools refuse when the session was not launched by the daemon, and report an unreachable daemon', async () => {
  const detached = startMcp({ AGENT_VISUAL_OS_CATALOG_URL: undefined });
  try {
    const res = await detached.call(STEP_TASK_TOOLS.updateSkill, { skillId: 'tdd', body: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /not connected to a workflow step/);
  } finally {
    detached.close();
  }
  const unreachable = startMcp({ AGENT_VISUAL_OS_CATALOG_URL: 'http://127.0.0.1:1/api/catalog' });
  try {
    const res = await unreachable.call(STEP_TASK_TOOLS.updateWorkflowStep, { workflowId: 'w', stepId: 's', instructions: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /^Failed:/);
  } finally {
    unreachable.close();
  }
});

test('the step-reporting tools still relay to /api/workflow-steps scoped to the session\'s task', async () => {
  responses.push({ status: 201, body: '{}' });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.skip, { reason: 'No UI' });
    assert.deepEqual(res, { content: [{ type: 'text', text: 'Step skipped.' }], isError: false });
    assert.equal(received[0]?.url, '/api/workflow-steps/skip?taskId=step-task-1');
  } finally {
    mcp.close();
  }
  const detached = startMcp({ AGENT_VISUAL_OS_TASK_ID: undefined });
  try {
    const res = await detached.call(STEP_TASK_TOOLS.skip, { reason: 'No UI' });
    assert.equal(res.isError, true);
  } finally {
    detached.close();
  }
});

test('report_progress is listed with a schema capping the checklist length and every text field', async () => {
  const mcp = startMcp();
  try {
    const tools = await mcp.listTools();
    const tool = tools.find((t) => t.name === STEP_TASK_TOOLS.reportProgress)! as unknown as { inputSchema: { properties: Record<string, { maxItems?: number; maxLength?: number; items?: { properties: Record<string, { maxLength?: number }> } }> } };
    assert.equal(tool.inputSchema.properties.checklist!.maxItems, 20);
    assert.equal(tool.inputSchema.properties.checklist!.items!.properties.text!.maxLength, 200);
    assert.equal(tool.inputSchema.properties.checklist!.items!.properties.note!.maxLength, 200);
    assert.equal(tool.inputSchema.properties.currentActivity!.maxLength, 200);
    assert.equal(tool.inputSchema.properties.estimate!.maxLength, 60);
  } finally {
    mcp.close();
  }
});

test('report_progress relays a full checklist/currentActivity/estimate call to /api/workflow-steps/progress scoped to the session\'s task', async () => {
  responses.push({ status: 201, body: '{}' });
  const mcp = startMcp();
  try {
    const args = {
      checklist: [{ text: 'Build the picker', state: 'done' }, { text: 'Write tests', state: 'in-progress', note: 'almost there' }],
      currentActivity: 'Writing unit tests for the picker',
      estimate: '~10 min left',
    };
    const res = await mcp.call(STEP_TASK_TOOLS.reportProgress, args);
    assert.deepEqual(res, { content: [{ type: 'text', text: 'Progress reported.' }], isError: false });
    assert.equal(received[0]?.url, '/api/workflow-steps/progress?taskId=step-task-1');
    assert.deepEqual(received[0]?.body, args);
  } finally {
    mcp.close();
  }
});

test('IS06 report_progress declares an optional 1-2 word short label on each checklist item', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../bin/step-task-mcp.mjs', import.meta.url), 'utf8');
  assert.match(source, /short: \{ type: 'string', description: 'A 1-2 word label/);
  assert.match(source, /required: \['text', 'state'\]/, 'short stays optional');
});

test('report_progress relays a call with only currentActivity (no checklist/estimate)', async () => {
  responses.push({ status: 201, body: '{}' });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.reportProgress, { currentActivity: 'Running the web test suite' });
    assert.equal(res.isError, false);
    assert.deepEqual(received[0]?.body, { currentActivity: 'Running the web test suite' });
  } finally {
    mcp.close();
  }
});

test('report_progress relays an empty call too — the daemon\'s own validation rejects it, surfaced as a plain tool error (the MCP relay itself does no business validation, same as complete_step/skip_step)', async () => {
  responses.push({ status: 400, body: JSON.stringify({ error: 'at least one of checklist, currentActivity or estimate is required' }) });
  const mcp = startMcp();
  try {
    const res = await mcp.call(STEP_TASK_TOOLS.reportProgress, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /^Failed: at least one of checklist, currentActivity or estimate is required$/);
    assert.deepEqual(received[0]?.body, {});
  } finally {
    mcp.close();
  }
});

test('report_progress reports a detached session and an unreachable daemon', async () => {
  const detached = startMcp({ AGENT_VISUAL_OS_TASK_ID: undefined });
  try {
    const res = await detached.call(STEP_TASK_TOOLS.reportProgress, { currentActivity: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /not connected to a workflow step/);
  } finally {
    detached.close();
  }
  const unreachable = startMcp({ AGENT_VISUAL_OS_STEP_URL: 'http://127.0.0.1:1/api/workflow-steps' });
  try {
    const res = await unreachable.call(STEP_TASK_TOOLS.reportProgress, { currentActivity: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /^Failed:/);
  } finally {
    unreachable.close();
  }
});
