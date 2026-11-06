import { fileURLToPath } from 'node:url';
import { PORT } from '../config.ts';
import { CLI_HOOK_TOKEN } from './projectCliHooks.ts';
import type { McpServerLaunch } from './mcpServers.ts';
import { MAX_AGENT_TEST_WAIT_SECONDS } from '../testing/types.ts';

/**
 * The testing tools a coding session uses to run its Project's configured Test Actions
 * (`/api/agent-testing`, reached through bin/test-task-mcp.mjs). Runs go through the same Test Run
 * engine as the Testing tab, in the calling Task's own working tree, so their records, events and
 * results are the Testing tab's too. The session names only suite/action ids; the daemon resolves
 * the Project, working tree and command from the Task itself. The same server carries the one
 * bug-filing tool a coding session has (`reportBug`, see worker/bugTracker.ts's `fileAgentBug`).
 */
export const TEST_TASK_MCP_SERVER_NAME = 'agent_visual_os_tests';
export const TEST_TASK_TOOLS = {
  list: 'list_test_actions',
  run: 'run_test_action',
  get: 'get_test_run',
  runAll: 'run_all_tests',
  reportBug: 'report_unrelated_test_failure',
} as const;

const TEST_TASK_MCP_PATH = fileURLToPath(new URL('../../bin/test-task-mcp.mjs', import.meta.url));

/** Leaves room past the longest server-side wait for the HTTP round trip. */
const TOOL_TIMEOUT_SEC = MAX_AGENT_TEST_WAIT_SECONDS + 60;

export function testTaskMcpServer(taskId: string): McpServerLaunch {
  return {
    name: TEST_TASK_MCP_SERVER_NAME,
    command: process.execPath,
    args: [TEST_TASK_MCP_PATH],
    env: {
      AGENT_VISUAL_OS_TASK_ID: taskId,
      AGENT_VISUAL_OS_TESTING_URL: `http://127.0.0.1:${PORT}/api/agent-testing`,
      AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
    },
    tools: Object.values(TEST_TASK_TOOLS),
    toolTimeoutSec: TOOL_TIMEOUT_SEC,
  };
}

/** Appended to the system prompt / developer instructions of every session that gets the testing tools. */
export const TESTING_TOOL_INSTRUCTIONS = `## Running this project's tests

This project's registered test suites run through the \`${TEST_TASK_MCP_SERVER_NAME}\` tools, in your own working tree:
- Call \`${TEST_TASK_TOOLS.list}\` first to see which suites and actions are registered. If it reports no config or an invalid one, say so rather than guessing a command.
- For a full run of a registered suite, use \`${TEST_TASK_TOOLS.run}\` (one action) or \`${TEST_TASK_TOOLS.runAll}\` (every enabled suite). Only these runs are recorded as test evidence in the project's Testing tab.
- If a tool answers that a run is still queued or running, call \`${TEST_TASK_TOOLS.get}\` with its run id to wait for the result.
- You may still run targeted tests in the shell while debugging, but those are not recorded as suite runs. Before you report tests as passing, run the registered suite through these tools.
- \`${TEST_TASK_TOOLS.reportBug}\` files a bug for a failing test, and only for one that is unrelated to your current task. A failure caused by your own changes is yours to fix, not to report. Filing the same test case again returns the bug that already exists.`;
