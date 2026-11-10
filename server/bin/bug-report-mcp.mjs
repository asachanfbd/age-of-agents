#!/usr/bin/env node

// A minimal stdio MCP server that lets an Agent Visual OS bug report session list its Project's
// tasks and file, correct or withdraw its own bugs and tasks — see src/terminal/bugReportTool.ts.

import { createDaemonRelay, serveMcp } from './lib/mcp-stdio.mjs';

/** Relays one call to the daemon's /api/agent-bugs, scoped to this session's Task. */
const daemon = createDaemonRelay({
  urlEnv: 'AGENT_VISUAL_OS_BUGS_URL',
  notConnected: 'This session is not connected to Agent Visual OS, so bugs cannot be filed.',
  timeoutMs: 10_000,
});

const ID = { type: 'string', description: 'The bug id, as create_bug reported it.' };
const FIELDS = {
  title: { type: 'string', description: 'One line that states the defect, without a number (at most 200 characters).' },
  summary: { type: 'string', description: 'What is wrong, self-contained for a coding agent that never sees this conversation.' },
  expectedVsActual: { type: 'string', description: 'What should happen and what happens instead.' },
  stepsToReproduce: { type: 'string', description: 'How to make it happen again.' },
  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'How bad it is. Leave out when unclear.' },
  suspectedLocation: { type: 'string', description: 'The files or areas the defect likely lives in (at most 500 characters).' },
  introducedByTaskId: { type: ['string', 'null'], description: 'The id (from list_tasks) of the task that introduced the bug. It must have started. Leave out, or pass null, when unknown.' },
  commit: { type: 'string', description: 'The commit that introduced the bug, when found (at most 64 characters).' },
  infoStatus: { type: 'string', enum: ['enough', 'needs-more-info'], description: '"enough" only when a coding agent could start on the fix from this report alone.' },
};

const TASK_ID = { type: 'string', description: 'The task id, as create_task reported it.' };
const TASK_FIELDS = {
  title: { type: 'string', description: 'One line that states the work, without a number (at most 200 characters).' },
  description: { type: 'string', description: 'The full brief, self-contained: the coding agent that picks the task up sees nothing else (at most 20,000 characters).' },
  relatedBugId: { type: ['string', 'null'], description: 'The id (from create_bug) of a bug filed in this session that this task is related to. Leave out, or pass null, for none.' },
};

const report = (args) => Object.fromEntries(Object.keys(FIELDS).map((field) => [field, args?.[field]]));
const taskBody = (args) => Object.fromEntries(Object.keys(TASK_FIELDS).map((field) => [field, args?.[field]]));
const describeTask = ({ id, type, title, status }) => ({ id, type, title, status });

const TOOLS = [
  {
    name: 'list_tasks',
    description: "List this project's tasks and bugs (id, type, title, status), in display order. Use it to find the task that introduced a bug: only one that has started (any status but \"pending\") can be named as the introducing task.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => daemon('GET', '', null, (items) => JSON.stringify(items.map(describeTask), null, 2)),
  },
  {
    name: 'create_bug',
    description: 'File one bug. It appears on the Tasks board at once, under the task that introduced it or on its own when that is unknown. Sections you leave out are written as "Unknown", so file even a thin report. The title gets its bug number automatically.',
    inputSchema: { type: 'object', properties: FIELDS, required: ['title', 'infoStatus'], additionalProperties: false },
    call: (args) => daemon('POST', '', report(args), (item) => `Filed bug ${item.id}: ${item.title}`),
  },
  {
    name: 'update_bug',
    description: 'Correct a bug this session filed: pass only the fields to change. Pass introducedByTaskId null to mark the introducing task unknown. A bug that has already started cannot be changed.',
    inputSchema: { type: 'object', properties: { id: ID, ...FIELDS }, required: ['id'], additionalProperties: false },
    call: (args) => daemon('PATCH', `/${encodeURIComponent(args?.id ?? '')}`, report(args), (item) => `Updated bug ${item.id}: ${item.title}`),
  },
  {
    name: 'delete_bug',
    description: 'Withdraw a bug this session filed. A bug that has already started cannot be deleted.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false },
    call: (args) => daemon('DELETE', `/${encodeURIComponent(args?.id ?? '')}`, null, () => `Deleted bug ${args.id}`),
  },
  {
    name: 'create_task',
    description: 'File one task for new capability or an improvement (never for a defect: file those with create_bug). It appears on the Tasks board unstarted and is never started automatically. Put the full brief in the description.',
    inputSchema: { type: 'object', properties: TASK_FIELDS, required: ['title', 'description'], additionalProperties: false },
    call: (args) => daemon('POST', '/tasks', taskBody(args), (item) => `Filed task ${item.id}: ${item.title}`),
  },
  {
    name: 'update_task',
    description: 'Correct a task this session filed: pass only the fields to change. Pass relatedBugId null to remove the link. A task that has already started cannot be changed.',
    inputSchema: { type: 'object', properties: { id: TASK_ID, ...TASK_FIELDS }, required: ['id'], additionalProperties: false },
    call: (args) => daemon('PATCH', `/tasks/${encodeURIComponent(args?.id ?? '')}`, taskBody(args), (item) => `Updated task ${item.id}: ${item.title}`),
  },
  {
    name: 'delete_task',
    description: 'Withdraw a task this session filed. A task that has already started cannot be deleted.',
    inputSchema: { type: 'object', properties: { id: TASK_ID }, required: ['id'], additionalProperties: false },
    call: (args) => daemon('DELETE', `/tasks/${encodeURIComponent(args?.id ?? '')}`, null, () => `Deleted task ${args.id}`),
  },
  {
    name: 'reopen_bug',
    description: "Report a regression on a COMPLETED bug of this project: its fix did not cure the problem. The same bug goes back to Running at once and every step of its workflow runs again as the next round on a fresh branch (each step continues its earlier conversation). Give the reason it still fails. A bug that is not completed, or a task, is refused.",
    inputSchema: {
      type: 'object',
      properties: { bugId: { type: 'string', description: 'The id of the completed bug, as list_tasks or create_bug reported it.' }, reason: { type: 'string', description: 'Why the fix did not work: what still goes wrong (at most 20,000 characters).' } },
      required: ['bugId', 'reason'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', `/${encodeURIComponent(args?.bugId ?? '')}/reopen`, { reason: args?.reason }, (result) => `Reopened bug ${result.item.id} as round 2: ${result.item.title}${result.workflowNote ? ` (${result.workflowNote})` : ''}`),
  },
];

// Only the combined plan-and-bugs session is launched with this set; the bug report session never sees the tool.
if (process.env.AGENT_VISUAL_OS_DEPENDENCY_TOOL === '1') {
  TOOLS.push({
    name: 'set_dependencies',
    description: "Set the parents a task or bug of this session waits for. dependsOn lists the ids (from list_tasks, create_task or create_bug) of tasks or bugs of this project that are ready or started but not yet merged; pass [] to clear. Only an item this session filed that has not started can change. A cycle, a chain of more than 10, more than 20 parents, or a project without a linked repository is refused.",
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The id of the task or bug whose parents to set.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of the parents. [] clears them.' },
        uiPlanningWaitsForParent: { type: 'boolean', description: '"UI planning waits for parent": true only when this item\'s UI builds on UI a parent introduces (nothing runs until the parents are merged); false (the default) runs its UI Planning as soon as it is started. Omit to keep the stored value.' },
      },
      required: ['itemId', 'dependsOn'],
      additionalProperties: false,
    },
    call: (args) => daemon('PUT', `/${encodeURIComponent(args?.itemId ?? '')}/dependencies`, { dependsOn: args?.dependsOn, ...(args?.uiPlanningWaitsForParent !== undefined ? { uiPlanningWaitsForParent: args.uiPlanningWaitsForParent } : {}) }, (item) => `Set ${item.id} to wait for ${item.dependsOn?.length ?? 0} parent(s)`),
  });
}

await serveMcp({ name: 'agent-visual-os-bugs', version: '1.0.0' }, TOOLS);
