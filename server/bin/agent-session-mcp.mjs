#!/usr/bin/env node

// A minimal stdio MCP server that lets an Agent Visual OS Agent terminal session name its own
// conversation — see src/terminal/agentSessionTool.ts.

import { createDaemonRelay, serveMcp } from './lib/mcp-stdio.mjs';

/** Relays one call to the daemon's /api/agent-session, scoped to this session. */
const daemon = createDaemonRelay({
  urlEnv: 'AGENT_VISUAL_OS_AGENT_SESSION_URL',
  notConnected: 'This session is not connected to Agent Visual OS, so it cannot be renamed.',
  timeoutMs: 10_000,
});

const TOOLS = [
  {
    name: 'rename_session',
    description: 'Give this conversation a short name (a few words, at most 80 characters) that says what it is about. It replaces the default "Terminal N" name in the app\'s session list.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The short conversation name.' } },
      required: ['name'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/name', { name: args?.name }, (session) => `Session renamed to "${session.name}"`),
  },
];

await serveMcp({ name: 'agent-visual-os-session', version: '1.0.0' }, TOOLS);
