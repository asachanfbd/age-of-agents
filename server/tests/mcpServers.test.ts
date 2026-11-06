import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeMcpArgs, codexMcpArgs } from '../src/terminal/mcpServers.ts';
import { stepTaskMcpServer } from '../src/terminal/stepTaskTool.ts';
import { testTaskMcpServer } from '../src/terminal/testTaskTool.ts';

const STEP = { name: 'step', command: '/bin/node', args: ['/srv/step.mjs'], env: { TOKEN: 'a' }, tools: ['complete_step'] };
const TESTS = { name: 'tests', command: '/bin/node', args: ['/srv/tests.mjs'], env: { TOKEN: 'b' }, tools: ['list_test_actions', 'run_test_action'], toolTimeoutSec: 300 };

test('no servers register nothing with either CLI', () => {
  assert.deepEqual(claudeMcpArgs([]), []);
  assert.deepEqual(codexMcpArgs([]), []);
});

test('Claude gets one --mcp-config holding every server and one --allowed-tools listing every tool once', () => {
  const args = claudeMcpArgs([STEP, TESTS]);
  assert.deepEqual(args, [
    '--mcp-config', JSON.stringify({ mcpServers: {
      step: { type: 'stdio', command: '/bin/node', args: ['/srv/step.mjs'], env: { TOKEN: 'a' } },
      tests: { type: 'stdio', command: '/bin/node', args: ['/srv/tests.mjs'], env: { TOKEN: 'b' } },
    } }),
    '--allowed-tools', 'mcp__step__complete_step,mcp__tests__list_test_actions,mcp__tests__run_test_action',
  ]);
});

test('Codex registers each server with its own overrides, tool timeout and per-tool approvals', () => {
  assert.deepEqual(codexMcpArgs([STEP, TESTS]), [
    '-c', 'mcp_servers.step.command="/bin/node"', '-c', 'mcp_servers.step.args=["/srv/step.mjs"]', '-c', 'mcp_servers.step.env={ TOKEN = "a" }',
    '-c', 'mcp_servers.step.tools.complete_step.approval_mode="approve"',
    '-c', 'mcp_servers.tests.command="/bin/node"', '-c', 'mcp_servers.tests.args=["/srv/tests.mjs"]', '-c', 'mcp_servers.tests.env={ TOKEN = "b" }',
    '-c', 'mcp_servers.tests.tool_timeout_sec=300',
    '-c', 'mcp_servers.tests.tools.list_test_actions.approval_mode="approve"',
    '-c', 'mcp_servers.tests.tools.run_test_action.approval_mode="approve"',
  ]);
});

test('the real step and testing servers can be registered side by side under distinct names', () => {
  const servers = [stepTaskMcpServer('t1'), testTaskMcpServer('t1')];
  const config = JSON.parse(claudeMcpArgs(servers)[1]!) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(config.mcpServers), ['agent_visual_os_step', 'agent_visual_os_tests']);
  assert.ok(codexMcpArgs(servers).includes('mcp_servers.agent_visual_os_tests.tool_timeout_sec=300'));
});
