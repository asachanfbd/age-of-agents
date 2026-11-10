#!/usr/bin/env node

// A minimal stdio MCP server (newline-delimited JSON-RPC 2.0) that lets an Agent Visual OS
// planning session list, create, edit, and delete its own Project's open Tasks — see
// src/terminal/planTaskTool.ts.

import { createDaemonRelay, serveMcp } from './lib/mcp-stdio.mjs';

/** Relays one call to the daemon's /api/agent-tasks, scoped to this session's Task. */
const daemon = createDaemonRelay({
  urlEnv: 'AGENT_VISUAL_OS_TASKS_URL',
  notConnected: 'This session is not connected to Agent Visual OS, so tasks cannot be managed.',
  timeoutMs: 10_000,
});

const TITLE = { type: 'string', description: 'Short task title, without a sequence number.' };
const DESCRIPTION = {
  type: 'string',
  description: 'The feature specification, self-contained for the coding agent that will run this task without seeing the planning conversation: the problem and goal, user-visible behaviour and flows, rules and states, every decision made with the user, edge and error cases, what is in and out of scope, what earlier tasks put in place, and acceptance criteria. Describe what and why, not how: no file paths, code names, data structures or coding steps.',
};
const ID = { type: 'string', description: 'The task id, as list_tasks or create_task reported it.' };
const WAITS = { type: 'boolean', description: '"UI planning waits for parent": true only when the task\'s UI builds on UI a parent task introduces (nothing runs until the parents are merged); false (the default) runs its UI Planning as soon as it is started.' };

const TOOLS = [
  {
    name: 'list_tasks',
    description: "List this project's tasks (id, title, description, status), in display order. Call it before editing or deleting a task you didn't just create. A \"done\" task is already completed.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => daemon('GET', '', null, (items) => JSON.stringify(items.map(({ id, title, description, status }) => ({ id, title, description, status })), null, 2)),
  },
  {
    name: 'create_task',
    description: "Create the next open task in this project's Tasks breakdown: one task per feature, covering all of that feature's work. Call it once per task, in the order the tasks should run; each title is prefixed with its sequence number (<session>.<task>, e.g. 3.002) automatically. The task appears in the project's task list immediately, ready for someone to assign and run.",
    inputSchema: { type: 'object', properties: { title: TITLE, description: DESCRIPTION }, required: ['title', 'description'], additionalProperties: false },
    call: (args) => daemon('POST', '', { title: args?.title, description: args?.description }, (item) => `Created task ${item.id}: ${item.title}`),
  },
  {
    name: 'update_task',
    description: "Change an existing task's title, description and/or its uiPlanningWaitsForParent setting. A numbered title keeps its <session>.<task> prefix. A task that is currently running, or already done, cannot be changed — create a new task for further work instead.",
    inputSchema: { type: 'object', properties: { id: ID, title: TITLE, description: DESCRIPTION, uiPlanningWaitsForParent: WAITS }, required: ['id'], additionalProperties: false },
    call: (args) => daemon('PATCH', `/${encodeURIComponent(args?.id ?? '')}`, { title: args?.title, description: args?.description, uiPlanningWaitsForParent: args?.uiPlanningWaitsForParent }, (item) => `Updated task ${item.id}: ${item.title}`),
  },
  {
    name: 'delete_task',
    description: 'Delete a task the user no longer wants. A task that is currently running cannot be deleted.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false },
    call: (args) => daemon('DELETE', `/${encodeURIComponent(args?.id ?? '')}`, null, () => `Deleted task ${args.id}`),
  },
];

await serveMcp({ name: 'agent-visual-os', version: '1.0.0' }, TOOLS);
