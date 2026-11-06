import { fileURLToPath } from 'node:url';
import { PORT } from '../config.ts';
import { CLI_HOOK_TOKEN } from './projectCliHooks.ts';
import type { McpServerLaunch } from './mcpServers.ts';

/**
 * The tools a session uses to call capabilities of Buildings its own Building is linked to
 * (`/api/agent-capabilities`, reached through bin/capability-mcp.mjs). The daemon works out the calling
 * Building, whether the session may write, and whether its run is still active from the Task itself.
 */
export const CAPABILITY_MCP_SERVER_NAME = 'agent_visual_os_connections';
export const CAPABILITY_TOOLS = {
  list: 'list_linked_capabilities',
  call: 'call_capability',
} as const;

const CAPABILITY_MCP_PATH = fileURLToPath(new URL('../../bin/capability-mcp.mjs', import.meta.url));

/** A write call may wait for a person's approval, so the tool call is allowed to take long. */
const TOOL_TIMEOUT_SEC = 120;

export function capabilityMcpServer(taskId: string): McpServerLaunch {
  return {
    name: CAPABILITY_MCP_SERVER_NAME,
    command: process.execPath,
    args: [CAPABILITY_MCP_PATH],
    env: {
      AGENT_VISUAL_OS_TASK_ID: taskId,
      AGENT_VISUAL_OS_CAPABILITIES_URL: `http://127.0.0.1:${PORT}/api/agent-capabilities`,
      AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
    },
    tools: Object.values(CAPABILITY_TOOLS),
    toolTimeoutSec: TOOL_TIMEOUT_SEC,
  };
}
