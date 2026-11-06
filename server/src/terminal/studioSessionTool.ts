import { fileURLToPath } from 'node:url';
import { PORT } from '../config.ts';
import { STUDIO_MCP_SERVER_NAME } from '../content/studioInstructions.ts';
import type { StudioTabDefinition } from '../content/studioTabs.ts';
import { CLI_HOOK_TOKEN } from './projectCliHooks.ts';
import type { McpServerLaunch } from './mcpServers.ts';

const STUDIO_MCP_PATH = fileURLToPath(new URL('../../bin/studio-session-mcp.mjs', import.meta.url));

/**
 * The tools a Content Studio writing session uses (`/api/studio-session`, reached through
 * bin/studio-session-mcp.mjs), authenticated like the other agent-facing tools: the CLI hook token
 * plus the session's own id. The tab's definition names which tools this session gets (an import
 * session passes its own list); it never gets task, testing or bug tools.
 */
export function studioMcpServer(sessionId: string, tab: Pick<StudioTabDefinition, 'tools'>): McpServerLaunch {
  return {
    name: STUDIO_MCP_SERVER_NAME,
    command: process.execPath,
    args: [STUDIO_MCP_PATH],
    env: {
      AGENT_VISUAL_OS_TASK_ID: sessionId,
      AGENT_VISUAL_OS_STUDIO_URL: `http://127.0.0.1:${PORT}/api/studio-session`,
      AGENT_VISUAL_OS_STUDIO_TOOLS: tab.tools.join(','),
      AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
    },
    tools: [...tab.tools],
  };
}
