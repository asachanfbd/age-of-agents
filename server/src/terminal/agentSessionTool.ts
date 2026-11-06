import { fileURLToPath } from 'node:url';
import { PORT } from '../config.ts';
import { CLI_HOOK_TOKEN } from './projectCliHooks.ts';
import type { McpServerLaunch } from './mcpServers.ts';

/**
 * The tool an Agent terminal session uses to name its own conversation (`/api/agent-session`,
 * reached through bin/agent-session-mcp.mjs). Authenticated and scoped like the other agent-facing
 * tools: the CLI hook token plus the session's own id.
 */
export const AGENT_SESSION_MCP_SERVER_NAME = 'agent_visual_os_session';
export const AGENT_SESSION_TOOLS = { rename: 'rename_session' } as const;

const AGENT_SESSION_MCP_PATH = fileURLToPath(new URL('../../bin/agent-session-mcp.mjs', import.meta.url));

export function agentSessionMcpServer(sessionId: string): McpServerLaunch {
  return {
    name: AGENT_SESSION_MCP_SERVER_NAME,
    command: process.execPath,
    args: [AGENT_SESSION_MCP_PATH],
    env: {
      AGENT_VISUAL_OS_TASK_ID: sessionId,
      AGENT_VISUAL_OS_AGENT_SESSION_URL: `http://127.0.0.1:${PORT}/api/agent-session`,
      AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
    },
    tools: Object.values(AGENT_SESSION_TOOLS),
  };
}

/** Appended to the system prompt of every Agent terminal session, first start and resume alike. */
export const AGENT_SESSION_INSTRUCTIONS = `## Naming this conversation

After two or three exchanges with the user, once you know what the conversation is about, call \`${AGENT_SESSION_TOOLS.rename}\` (from the \`${AGENT_SESSION_MCP_SERVER_NAME}\` tools) once with a short name of a few words, for example "Fix login redirect". Do it quietly, without announcing it. The name appears in the app's session list. Do not rename again unless the topic changes completely.

## Managing this project's tasks

The \`agent_visual_os\` tools list, create, edit and delete this project's open tasks. Use them when the user asks you to turn the work into tasks.`;
