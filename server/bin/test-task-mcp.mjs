#!/usr/bin/env node

// A minimal stdio MCP server that lets a coding session list and run its Project's configured Test
// Actions, so each run is recorded in the Testing tab like a manual one — see
// src/terminal/testTaskTool.ts. It takes only suite/action/run ids: the daemon resolves the
// Project, working tree and command from the launching Task, never from anything the model sends.

import { createDaemonRelay, serveMcp } from './lib/mcp-stdio.mjs';

/** Relays one call to the daemon's /api/agent-testing, scoped to this session's Task. */
const daemon = createDaemonRelay({
  urlEnv: 'AGENT_VISUAL_OS_TESTING_URL',
  notConnected: 'This session is not connected to Agent Visual OS, so its configured tests cannot be run.',
  timeoutMs: 30_000,
});

/** The daemon blocks up to `waitSeconds` (capped at 240) for runs to settle; the request gets that long plus a margin. */
const DEFAULT_WAIT_SECONDS = 120;
const waitTimeout = (waitSeconds) => ({ timeoutMs: (Math.min(Math.max(Number(waitSeconds ?? DEFAULT_WAIT_SECONDS) || 0, 0), 240) + 30) * 1000 });

const WAIT = {
  type: 'number',
  minimum: 0,
  maximum: 240,
  description: `How long to wait for the run to finish before answering, in seconds (default ${DEFAULT_WAIT_SECONDS}, max 240). If it is still queued or running then, call get_test_run with the run id to keep waiting.`,
};
const ID = (what) => ({ type: 'string', description: `The ${what} id, as list_test_actions reports it.` });

const json = (value) => JSON.stringify(value, null, 2);

const TOOLS = [
  {
    name: 'list_test_actions',
    description: "List this project's registered test suites and their actions (ids, labels, whether enabled, each suite's primary action), read from the testing config in your working tree. Call this first. If the config is absent or invalid it says why and lists nothing.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => daemon('GET', '/actions', null, json),
  },
  {
    name: 'run_test_action',
    description: "Run one registered test action in your working tree and wait for its result. Returns the run id, status, counts, failing tests, diagnostics and the end of the output. The run is recorded in the project's Testing tab. If the same action is already queued or running for your working tree, this waits on that run instead of starting another.",
    inputSchema: {
      type: 'object',
      properties: { suiteId: ID('suite'), actionId: ID('action'), waitSeconds: WAIT },
      required: ['suiteId', 'actionId'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/runs', { suiteId: args?.suiteId, actionId: args?.actionId, waitSeconds: args?.waitSeconds }, json, waitTimeout(args?.waitSeconds)),
  },
  {
    name: 'get_test_run',
    description: "Get a test run's current status, result summary, diagnostics and the end of its output, waiting up to waitSeconds for it to finish. Use it for a run that run_test_action or run_all_tests reported as still queued or running.",
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'The run id a previous tool call returned.' }, waitSeconds: WAIT },
      required: ['runId'],
      additionalProperties: false,
    },
    call: (args) => {
      const query = args?.waitSeconds === undefined ? '' : `?waitSeconds=${encodeURIComponent(args.waitSeconds)}`;
      return daemon('GET', `/runs/${encodeURIComponent(args?.runId ?? '')}${query}`, null, json, waitTimeout(args?.waitSeconds));
    },
  },
  {
    name: 'run_all_tests',
    description: "Run every enabled suite's primary action in your working tree, one after another, and wait for all of them. Returns one compact result per run; any run still queued or running when the wait ends can be followed with get_test_run.",
    inputSchema: { type: 'object', properties: { waitSeconds: WAIT }, additionalProperties: false },
    call: (args) => daemon('POST', '/run-all', { waitSeconds: args?.waitSeconds }, json, waitTimeout(args?.waitSeconds)),
  },
  {
    name: 'report_unrelated_test_failure',
    description: 'File a bug for a failing test that is unrelated to your current task. Use it only when a test you ran failed and your own changes did not cause it; a failure you caused is yours to fix. The bug is created needing more info, as a standalone card on the Tasks board. If an open bug already exists for the same test case, that bug is returned and nothing is created.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line that states the defect (at most 200 characters).' },
        suiteId: ID('suite'),
        actionId: ID('action'),
        caseId: { type: 'string', description: 'The failing test case or test identifier, exactly as the run reported it (at most 500 characters).' },
        description: { type: 'string', description: 'What failed and why you judge it unrelated to your task, with an excerpt of the failure output (at most 18,000 characters).' },
      },
      required: ['title', 'suiteId', 'actionId', 'caseId', 'description'],
      additionalProperties: false,
    },
    call: (args) => daemon(
      'POST', '/bugs',
      { title: args?.title, suiteId: args?.suiteId, actionId: args?.actionId, caseId: args?.caseId, description: args?.description },
      ({ existing, bug }) => `${existing ? 'An open bug already exists for this test case' : 'Filed bug'} ${bug.id}: ${bug.title}`,
    ),
  },
];

await serveMcp({ name: 'agent-visual-os-tests', version: '1.0.0' }, TOOLS);
