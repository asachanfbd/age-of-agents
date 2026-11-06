#!/usr/bin/env node

// A minimal stdio MCP server that lets a session call capabilities of the Buildings its own Building is
// linked to — see src/terminal/capabilityTool.ts. It sends only a target Building, a capability id and the
// inputs: the daemon works out the calling Building, its permissions and whether the run is active.

import { createDaemonRelay, serveMcp } from './lib/mcp-stdio.mjs';

const daemon = createDaemonRelay({
  urlEnv: 'AGENT_VISUAL_OS_CAPABILITIES_URL',
  notConnected: 'This session is not connected to Agent Visual OS, so it cannot call other Buildings.',
  timeoutMs: 100_000,
});

const json = (value) => JSON.stringify(value, null, 2);

const TOOLS = [
  {
    name: 'list_linked_capabilities',
    description: 'List the capabilities of linked Buildings that this session may call: the target Building id, the capability id, what it does, whether it only reads or changes things, and its inputs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => daemon('GET', '/capabilities', null, json),
  },
  {
    name: 'call_capability',
    description: 'Call one capability of a linked Building and return its result. A call that changes things may wait for a person to approve it; a call that starts a run answers at once with a reference to it. Repeat a call with the same idempotencyKey to get the first result instead of changing things twice.',
    inputSchema: {
      type: 'object',
      properties: {
        targetBuildingId: { type: 'string', description: 'The target Building id, as list_linked_capabilities reports it.' },
        capabilityId: { type: 'string', description: 'The capability id.' },
        inputs: { type: 'object', description: "The capability's inputs." },
        idempotencyKey: { type: 'string', description: 'Optional. A key you choose; a repeat of the call within a short window returns the first result.' },
      },
      required: ['targetBuildingId', 'capabilityId'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/calls', { targetBuildingId: args?.targetBuildingId, capabilityId: args?.capabilityId, inputs: args?.inputs, idempotencyKey: args?.idempotencyKey }, json),
  },
];

await serveMcp({ name: 'agent-visual-os-connections', version: '1.0.0' }, TOOLS);
