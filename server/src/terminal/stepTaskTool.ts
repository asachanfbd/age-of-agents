import { fileURLToPath } from 'node:url';
import { PORT } from '../config.ts';
import { CLI_HOOK_TOKEN } from './projectCliHooks.ts';
import type { McpServerLaunch } from './mcpServers.ts';

/**
 * The internal step-completion API (`/api/workflow-steps`, reached through a tiny stdio MCP server —
 * bin/step-task-mcp.mjs) a WorkflowRun step session uses to report its result, post its live progress
 * (`report_progress` — task 5.017), and page through the branch's diff. The same server also relays
 * `update_workflow_step`/`update_skill` to the existing
 * `/api/catalog` routes, so Docs & Retro can apply a shared Workflow/Skill fix the person approved in
 * the live session (approval is enforced by instruction only — no proposal record). The same
 * "shell tools are denied, so an MCP tool is the one channel both Claude and
 * Codex CLIs expose" pattern as terminal/planTaskTool.ts's planning-session tools. Both a structured
 * `claude -p`/`codex exec` turn and an interactive CLI Task get this server — see
 * workerManager.ts's `startStepTask`.
 */
export const STEP_TASK_MCP_SERVER_NAME = 'agent_visual_os_step';
export const STEP_TASK_TOOLS = {
  complete: 'complete_step',
  skip: 'skip_step',
  diffSummary: 'diff_summary',
  diffFile: 'diff_file',
  reportProgress: 'report_progress',
  updateWorkflowStep: 'update_workflow_step',
  updateSkill: 'update_skill',
} as const;

const STEP_TASK_MCP_PATH = fileURLToPath(new URL('../../bin/step-task-mcp.mjs', import.meta.url));

/** One stdio MCP server to register for a single step Task's session — see planTaskTool.ts's identical shape for planning. */
export function stepTaskMcpServer(taskId: string, readOnly = false): McpServerLaunch {
  return {
    name: STEP_TASK_MCP_SERVER_NAME,
    command: process.execPath,
    args: [STEP_TASK_MCP_PATH],
    env: {
      AGENT_VISUAL_OS_TASK_ID: taskId,
      AGENT_VISUAL_OS_STEP_URL: `http://127.0.0.1:${PORT}/api/workflow-steps`,
      AGENT_VISUAL_OS_CATALOG_URL: `http://127.0.0.1:${PORT}/api/catalog`,
      AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
      ...(readOnly ? { AGENT_VISUAL_OS_STEP_READ_ONLY: '1' } : {}),
    },
    tools: readOnly ? [STEP_TASK_TOOLS.diffSummary, STEP_TASK_TOOLS.diffFile] : Object.values(STEP_TASK_TOOLS),
  };
}
