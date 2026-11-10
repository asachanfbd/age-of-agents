import { fileURLToPath } from 'node:url';
import { PORT } from '../config.ts';
import { CLI_HOOK_TOKEN } from './projectCliHooks.ts';
import type { McpServerLaunch } from './mcpServers.ts';
import { planningInterviewRules, specCompletenessChecklist } from '../projects/planningInterview.ts';
import type { PlanningFilingTerms } from '../projects/planningInterview.ts';

/**
 * The bug- and task-filing API a bug report session reaches through a stdio MCP server
 * (bin/bug-report-mcp.mjs → `/api/agent-bugs` and `/api/agent-bugs/tasks`). Like a planning session
 * it has its shell and editing tools denied, so these tools are its only output: it lists the
 * Project's tasks to find the one that introduced a defect, then files, corrects or withdraws its
 * own bugs and tasks.
 */
export const BUG_REPORT_MCP_SERVER_NAME = 'agent_visual_os_bugs';
export const BUG_REPORT_TOOLS = {
  list: 'list_tasks',
  create: 'create_bug',
  update: 'update_bug',
  delete: 'delete_bug',
  createTask: 'create_task',
  updateTask: 'update_task',
  deleteTask: 'delete_task',
  reopen: 'reopen_bug',
} as const;

const BUG_REPORT_MCP_PATH = fileURLToPath(new URL('../../bin/bug-report-mcp.mjs', import.meta.url));

export function bugReportMcpServer(taskId: string): McpServerLaunch {
  return {
    name: BUG_REPORT_MCP_SERVER_NAME,
    command: process.execPath,
    args: [BUG_REPORT_MCP_PATH],
    env: {
      AGENT_VISUAL_OS_TASK_ID: taskId,
      AGENT_VISUAL_OS_BUGS_URL: `http://127.0.0.1:${PORT}/api/agent-bugs`,
      AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
    },
    tools: Object.values(BUG_REPORT_TOOLS),
  };
}

/** What a bug report session is for and how it files bugs; appended to the person's first description. */
export const BUG_REPORT_INSTRUCTIONS = `This is a BUG REPORT session. Your job is to turn the defect the user describes above into one or more well-investigated bug reports. You do not fix anything.
1. Discuss with the user what the bug is: what they expected, what happened instead, and how to make it happen again.
2. Understand it from the code and the git history, and locate where in the system it lives.
3. Identify which task introduced it: relate the suspect code and commits to this project's tasks (\`${BUG_REPORT_TOOLS.list}\` shows them with their ids, numbers and status). Only a task that has started can have introduced a bug. Leave the introducing task out when you cannot tell.
4. Gather as much detail as you can, but never refuse to file for lack of it. A thin report is still filed, with the parts you could not establish left out; they are written as "Unknown".
5. Set the info status honestly: "enough" only when a coding agent could start on the fix from the report alone, otherwise "needs-more-info".
6. File the bug. One session may file several bugs, one per distinct defect.
7. Investigating a defect sometimes shows that part of the work is new capability or an improvement rather than a defect (for example a missing diagnostic view or a missing automatic setup step). File that part as a task with \`${BUG_REPORT_TOOLS.createTask}\`. File every defect as a bug, and use a task only for new capability or improvement: never turn a defect into a task to avoid reporting it. When you file something, say whether you chose a bug or a task and why. A task may name a bug filed in this session as the one it is related to.

Each bug or task is picked up later by a coding agent that sees only its title and description, never this conversation. Make every report and task brief self-contained. A bug's title is one line that states the defect; a task's title is one line that states the work.

This session is read-only: it cannot write or change any project file. Its only output is the bugs and tasks you file with the tools below. A task you file waits in Planning like any other task and is never started automatically.

Manage this session's bugs and tasks with these tools:
- \`${BUG_REPORT_TOOLS.list}\` shows the project's tasks and bugs with their ids, type and status.
- \`${BUG_REPORT_TOOLS.create}\` files a bug: a title, the report sections (summary, expected vs actual, steps to reproduce), a severity, the suspected location, the introducing task's id and commit when found, and the info status.
- \`${BUG_REPORT_TOOLS.update}\` corrects a bug this session filed, and \`${BUG_REPORT_TOOLS.delete}\` withdraws one. Both work only until the bug has been started.
- \`${BUG_REPORT_TOOLS.createTask}\` files a task: a title, a description that is the full brief (the coding agent sees nothing else), and optionally \`relatedBugId\`, the id of a bug filed in this session.
- \`${BUG_REPORT_TOOLS.reopen}\` reports a regression on a completed bug of this project whose fix did not cure the problem: pass the bug's id and the reason. The same bug goes back to Running at once and every step of its workflow runs again as the next round on a fresh branch, each step continuing its earlier conversation. Use it only when the user tells you a fixed bug still happens; a bug that is not completed cannot be reopened.
- \`${BUG_REPORT_TOOLS.updateTask}\` corrects a task this session filed, and \`${BUG_REPORT_TOOLS.deleteTask}\` withdraws one. Both work only until the task has been started.`;

/** The dependency tool only the combined session has; the bug report session's tool set is unchanged. */
export const PLAN_AND_BUGS_TOOLS = { ...BUG_REPORT_TOOLS, setDependencies: 'set_dependencies' } as const;

/** The combined session's MCP server: the bug report tools plus `set_dependencies`, served by the same script. */
export function planAndBugsMcpServer(taskId: string): McpServerLaunch {
  const launch = bugReportMcpServer(taskId);
  return { ...launch, env: { ...launch.env, AGENT_VISUAL_OS_DEPENDENCY_TOOL: '1' }, tools: Object.values(PLAN_AND_BUGS_TOOLS) };
}

const PLAN_AND_BUGS_FILING_TERMS: PlanningFilingTerms = {
  items: 'task, bug or dependency',
  filingTools: `\`${PLAN_AND_BUGS_TOOLS.create}\`, \`${PLAN_AND_BUGS_TOOLS.createTask}\` or \`${PLAN_AND_BUGS_TOOLS.setDependencies}\``,
  specTarget: "each task's description and, wherever it applies, each bug report",
};

/** What a combined planning and bug report session is for and how it files tasks, bugs and their dependencies; appended to the person's first description. */
export const PLAN_AND_BUGS_INSTRUCTIONS = `This is a PLAN AND BUGS session. Your job is to analyse the request above and turn it into the right set of bugs and tasks, in the right order. You do not implement anything.
1. Discuss the request with the user until you understand what they want, following the interview rules below. A feature discussion often uncovers defects, and a defect report often turns out to need new work first: handle both in this one conversation.
2. Understand it from the code and the git history (\`${PLAN_AND_BUGS_TOOLS.list}\` shows the project's tasks and bugs with their ids, type and status).
3. Once the user has confirmed your summary, file every defect as a bug with \`${PLAN_AND_BUGS_TOOLS.create}\`, and every piece of new capability or improvement as a task with \`${PLAN_AND_BUGS_TOOLS.createTask}\`. Never turn a defect into a task to avoid reporting it. When you file something, say whether you chose a bug or a task and why.
4. For a bug, identify which task introduced it when you can (only a task that has started can have), gather as much detail as you can, and set the info status honestly: "enough" only when a coding agent could start on the fix from the report alone. A thin report is still filed, with the parts you could not establish written as "Unknown": it goes through the same confirmation round, and is filed after it, never refused.
5. Set the order with \`${PLAN_AND_BUGS_TOOLS.setDependencies}\` whenever one piece of work needs another's changes in the code before it can start.
6. For each dependent item, propose its "UI planning waits for parent" setting (\`uiPlanningWaitsForParent\` on \`${PLAN_AND_BUGS_TOOLS.setDependencies}\`). It defaults to off: the item's UI Planning runs as soon as it is started, so its UI plan reaches the user for approval right away, while every later step still waits for the parents. Propose on only when the item's UI genuinely builds on or reuses UI that the parent introduces; otherwise leave it off. Briefly confirm the value with the user for each dependent item before you set it.

Merge or separate. When one piece of work needs another's changes, decide by purpose:
- If both serve the same purpose (the second is only a part of the first), merge them into ONE task. Example: "add the export button" and "wire the export button to the download endpoint" are one feature, so file one task.
- If they serve different purposes and one merely consumes the other, create two items and set the dependency so they run in order. Examples: a bug fix that needs a helper task's new function to exist first (file the helper task, then the bug, and make the bug depend on the task); a new task that should only start after a bug is fixed (make the task depend on the bug).
Explain your choice to the user in the conversation: say which you chose, why, and, when you made two items, which one waits for which.

${planningInterviewRules(PLAN_AND_BUGS_FILING_TERMS)}

${specCompletenessChecklist(PLAN_AND_BUGS_FILING_TERMS)}

Each bug or task is picked up later by a coding agent that sees only its title and description, never this conversation. Make every one self-contained. A bug's title is one line that states the defect; a task's title is one line that states the work.

This session is read-only: it cannot write or change any project file. Its only output is the bugs, tasks and dependencies you file with the tools below. What you file waits in Planning and is never started by you.

Manage this session's bugs and tasks with these tools:
- \`${PLAN_AND_BUGS_TOOLS.list}\` shows the project's tasks and bugs with their ids, type and status.
- \`${PLAN_AND_BUGS_TOOLS.create}\` files a bug: a title, the report sections (summary, expected vs actual, steps to reproduce), a severity, the suspected location, the introducing task's id and commit when found, and the info status.
- \`${PLAN_AND_BUGS_TOOLS.update}\` corrects a bug this session filed, and \`${PLAN_AND_BUGS_TOOLS.delete}\` withdraws one. Both work only until the bug has been started.
- \`${PLAN_AND_BUGS_TOOLS.createTask}\` files a task: a title, a description that is the full brief (the coding agent sees nothing else), and optionally \`relatedBugId\`, the id of a bug filed in this session.
- \`${PLAN_AND_BUGS_TOOLS.updateTask}\` corrects a task this session filed, and \`${PLAN_AND_BUGS_TOOLS.deleteTask}\` withdraws one. Both work only until the task has been started.
- \`${PLAN_AND_BUGS_TOOLS.setDependencies}\` sets the parents (\`dependsOn\`: ids of tasks or bugs) a task or bug of this session waits for; an empty list clears them. Parents may be any task or bug of the project that is ready or started but not yet merged. It works only on items this session filed that have not started, and refuses a cycle, a chain of more than 10, more than 20 parents, or a project without a linked repository. Its optional \`uiPlanningWaitsForParent\` (true or false) saves the item's "UI planning waits for parent" setting; leave it out to keep the stored value.
- \`${PLAN_AND_BUGS_TOOLS.reopen}\` reports a regression on a completed bug of this project whose fix did not cure the problem: pass the bug's id and the reason. Use it only when the user tells you a fixed bug still happens.`;
