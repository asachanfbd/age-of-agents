import { fileURLToPath } from 'node:url';
import { PORT } from '../config.ts';
import { CLI_HOOK_TOKEN } from './projectCliHooks.ts';
import type { McpServerLaunch } from './mcpServers.ts';

/**
 * The internal task-management API a planning session reaches through a tiny stdio MCP server
 * (bin/plan-task-mcp.mjs). A planning session has its shell tools denied, so it cannot call the
 * daemon over HTTP itself — an MCP tool is the one channel both Claude and Codex CLIs expose.
 * The server only relays its tool calls to `/api/agent-tasks`, authenticated with the same
 * per-daemon token the CLI lifecycle hooks use and scoped to the launching Task's Project.
 */
export const PLAN_TASK_MCP_SERVER_NAME = 'agent_visual_os';
export const PLAN_TASK_TOOLS = {
  list: 'list_tasks',
  create: 'create_task',
  update: 'update_task',
  delete: 'delete_task',
} as const;

const PLAN_TASK_MCP_PATH = fileURLToPath(new URL('../../bin/plan-task-mcp.mjs', import.meta.url));

export function planTaskMcpServer(taskId: string): McpServerLaunch {
  return {
    name: PLAN_TASK_MCP_SERVER_NAME,
    command: process.execPath,
    args: [PLAN_TASK_MCP_PATH],
    env: {
      AGENT_VISUAL_OS_TASK_ID: taskId,
      AGENT_VISUAL_OS_TASKS_URL: `http://127.0.0.1:${PORT}/api/agent-tasks`,
      AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
    },
    tools: Object.values(PLAN_TASK_TOOLS),
  };
}
