#!/usr/bin/env node

// A minimal stdio MCP server (newline-delimited JSON-RPC 2.0) that lets a WorkflowRun step session
// report its result (complete_step/skip_step), page through its branch's diff against its base
// (diff_summary/diff_file), and — only after the person explicitly says yes in the live session —
// apply a retro fix to a shared Catalog Workflow step or Skill (update_workflow_step/update_skill,
// relayed to the daemon's existing /api/catalog routes) — see src/terminal/stepTaskTool.ts.
// Structurally identical to bin/plan-task-mcp.mjs, just relaying to different daemon routes.

import { createDaemonRelay, requestDaemon, serveMcp, toolResult } from './lib/mcp-stdio.mjs';

const NOT_CONNECTED = 'This session is not connected to a workflow step, so it cannot be reported.';

/** Relays one call to the daemon's /api/workflow-steps, scoped to this session's Task. */
const daemon = createDaemonRelay({
  urlEnv: 'AGENT_VISUAL_OS_STEP_URL',
  notConnected: NOT_CONNECTED,
  timeoutMs: 30_000,
});

const SUMMARY = { type: 'string', description: 'A self-contained GitHub-flavoured Markdown summary of what this step produced/decided, in the house style from your briefing: a TL;DR first, then short `###` sections, lists, tables and blockquotes as they fit. The next steps and the human reviewer see this, not your full transcript, so never drop anything they rely on.' };
const OUTPUT = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'A short label for this output (e.g. a screen name for a UI mockup).' },
    format: { type: 'string', enum: ['markdown', 'html'] },
    content: { type: 'string', description: 'The output itself. A Markdown output follows the same house style as the summary.' },
  },
  required: ['name', 'format', 'content'],
  additionalProperties: false,
};

const APPROVAL_RULE = 'This edits a shared Catalog definition used by every project, so call it ONLY after you have described the exact proposed change and its rationale to the person in this session, asked them directly, and received an explicit "yes". Never call it on your own judgement, on silence, or on an ambiguous reply.';

const TOOLS = [
  {
    name: 'complete_step',
    description: 'Finish this workflow step. Call this once, when you are done. `verdict` is REQUIRED (either "pass" or "issues") when this step reviews earlier work and can send it back for revision; otherwise omit it. Set `planningGap` only when you hit an ambiguity that should have been resolved during planning, before this step started.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: SUMMARY,
        outputs: { type: 'array', items: OUTPUT, description: 'This step\'s own artifacts (e.g. one HTML mockup per screen), if it produces any.' },
        verdict: { type: 'string', enum: ['pass', 'issues'] },
        planningGap: { type: 'string', description: 'Optional. An ambiguity or missing decision in the task\'s specification that planning should have resolved before you started — what was unclear and what you decided. The retro step uses it to improve future planning. Omit it when there was none.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/complete', { summary: args?.summary, outputs: args?.outputs, verdict: args?.verdict, planningGap: args?.planningGap }, () => 'Step completed.'),
  },
  {
    name: 'skip_step',
    description: 'Skip this step because it genuinely does not apply to this task (e.g. no UI to plan). No approval is needed even if this step normally requires one.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'Why this step does not apply, in plain language a reader new to the code understands. Usually one sentence; no headings.' } }, required: ['reason'], additionalProperties: false },
    call: (args) => daemon('POST', '/skip', { reason: args?.reason }, () => 'Step skipped.'),
  },
  {
    name: 'report_progress',
    description: 'Report this step\'s live progress so a person watching the run can see what you\'re doing without reading the raw session. Call it at the start with your planned checklist, then again whenever an item starts/finishes or the plan changes. Each call REPLACES the round\'s whole progress — always resend every field you want to keep showing, not just what changed. Not kept as history: only the latest call is shown.',
    inputSchema: {
      type: 'object',
      properties: {
        checklist: {
          type: 'array',
          maxItems: 20,
          description: 'Your plan as short items, in order. Omit to clear/leave out the checklist.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', maxLength: 200 },
              state: { type: 'string', enum: ['pending', 'in-progress', 'done', 'skipped'] },
              note: { type: 'string', maxLength: 200, description: 'Optional one-line note, e.g. why an item was skipped.' },
              short: { type: 'string', description: 'A 1-2 word label for what this item is doing, e.g. "writing code" or "running tests". Shown in the 3D village while the item is in progress; longer labels are trimmed to 2 words.' },
            },
            required: ['text', 'state'],
            additionalProperties: false,
          },
        },
        currentActivity: { type: 'string', maxLength: 200, description: 'One line saying what you are doing right now, e.g. "Running the web test suite".' },
        estimate: { type: 'string', maxLength: 60, description: 'Optional, your own estimate of the time remaining, e.g. "~10 min left".' },
      },
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/progress', { checklist: args?.checklist, currentActivity: args?.currentActivity, estimate: args?.estimate }, () => 'Progress reported.'),
  },
  {
    name: 'diff_summary',
    description: "An overview of the current branch's diff against its base: file list and a stat summary. Use this before diff_file so you know what changed without pulling the whole diff into context.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => daemon('GET', '/diff-summary', null, (body) => body.summary),
  },
  {
    name: 'diff_file',
    description: 'The diff for one changed file against the branch\'s base — use diff_summary first to see which files changed.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    call: (args) => daemon('GET', `/diff-file?path=${encodeURIComponent(args?.path ?? '')}`, null, (body) => body.diff),
  },
  {
    name: 'update_workflow_step',
    description: `Replace the instructions of one step of a shared Catalog Workflow (other steps and fields stay unchanged; runs already in progress keep their own snapshot). ${APPROVAL_RULE}`,
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The Catalog Workflow id (e.g. "software-development").' },
        stepId: { type: 'string', description: 'The id of the step within that Workflow whose instructions change.' },
        instructions: { type: 'string', description: 'The step\'s complete new instructions (replaces the old text entirely).' },
      },
      required: ['workflowId', 'stepId', 'instructions'],
      additionalProperties: false,
    },
    call: updateWorkflowStep,
  },
  {
    name: 'update_skill',
    description: `Replace the SKILL.md body (and optionally the description) of a shared Catalog Skill. ${APPROVAL_RULE}`,
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'The Catalog Skill id.' },
        body: { type: 'string', description: 'The skill\'s complete new SKILL.md body, without frontmatter (replaces the old body entirely).' },
        description: { type: 'string', description: 'Optional. A new one-line description for the skill.' },
      },
      required: ['skillId', 'body'],
      additionalProperties: false,
    },
    call: updateSkill,
  },
];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Reads the Workflow through the existing GET route, swaps one step's instructions, and saves every step back through the existing PUT route (which runs the Catalog's own validation). */
async function updateWorkflowStep(args) {
  const { workflowId, stepId, instructions } = args ?? {};
  if (!nonEmpty(workflowId) || !nonEmpty(stepId) || !nonEmpty(instructions)) return toolResult('workflowId, stepId and instructions are all required.', true);
  const path = `/workflows/${encodeURIComponent(workflowId)}`;
  const read = await catalog('GET', path);
  if (read.error) return read.error;
  // The GET route decorates each step with a resolved `agent` for display; strip it so only stored fields are written back.
  const steps = read.body.steps.map(({ agent: _agent, ...step }) => step);
  const step = steps.find(({ id }) => id === stepId);
  if (!step) return toolResult(`Failed: workflow "${workflowId}" has no step "${stepId}".`, true);
  step.instructions = instructions;
  const saved = await catalog('PUT', path, { steps });
  return saved.error ?? toolResult(`Updated the instructions of step "${stepId}" in workflow "${workflowId}".`);
}

async function updateSkill(args) {
  const { skillId, body, description } = args ?? {};
  if (!nonEmpty(skillId) || !nonEmpty(body)) return toolResult('skillId and body are required.', true);
  const saved = await catalog('PUT', `/skills/${encodeURIComponent(skillId)}`, { body, description });
  return saved.error ?? toolResult(`Updated skill "${skillId}".`);
}

/** Relays one call to the daemon's existing /api/catalog routes (the same ones the Catalog UI uses): `{ body }` or `{ error }`. */
async function catalog(method, path, body) {
  const url = process.env.AGENT_VISUAL_OS_CATALOG_URL;
  if (!url || !process.env.AGENT_VISUAL_OS_HOOK_TOKEN) return { error: toolResult(NOT_CONNECTED, true) };
  return requestDaemon(method, `${url}${path}`, body, 30_000);
}

await serveMcp({ name: 'agent-visual-os-step', version: '1.0.0' }, process.env.AGENT_VISUAL_OS_STEP_READ_ONLY === '1'
  ? TOOLS.filter(({ name }) => name === 'diff_summary' || name === 'diff_file')
  : TOOLS);
