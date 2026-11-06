import type { BuildingTypeDefinition, CapabilityDeclaration, CapabilityContext } from '../../src/buildings/contract.ts';
import { gate } from './schedulerFakes.ts';

// Imports only types from src: loading a src module here would run before a test file sets its data directory.

/** What the fixture capabilities do, and gates a test uses to hold a call at a chosen point. */
export function makeProbe() {
  return {
    sends: [] as Record<string, unknown>[],
    latchRuns: 0,
    /** Resolved by a test to let `read-slow` answer. */
    slow: gate(),
    /** `write-latch` waits here after announcing it started. */
    latch: gate(),
    latchEntered: gate(),
    /** `read-nested` calls this, so a test can make the capability call another one. */
    nested: null as ((context: CapabilityContext) => Promise<void>) | null,
    reads: 0,
    contexts: [] as CapabilityContext[],
  };
}
export type Probe = ReturnType<typeof makeProbe>;

/** Builds a capability error class lookup lazily so this file never loads `src` before the test sets its environment. */
export function fixtureCapabilities(probe: Probe, CapabilityError: new (status: number, message: string) => Error): CapabilityDeclaration[] {
  return [
    {
      id: 'read-echo', description: 'Echo the text back', mode: 'read',
      inputs: [
        { name: 'text', type: 'string', required: true, max: 10 },
        { name: 'count', type: 'integer', minValue: 0, maxValue: 100 },
        { name: 'ratio', type: 'number', minValue: 0, maxValue: 1 },
        { name: 'kind', type: 'enum', values: ['read', 'write'] },
        { name: 'flag', type: 'boolean' },
        { name: 'items', type: 'array', max: 3, items: { name: 'item', type: 'object', fields: [{ name: 'name', type: 'string', required: true }] } },
      ],
      outputs: [{ name: 'echo', type: 'string' }],
      async handle(context, inputs) { probe.reads += 1; probe.contexts.push(context); return { outputs: { echo: String(inputs.text) } }; },
    },
    {
      id: 'read-slow', description: 'Answers when the test says so', mode: 'read', inputs: [], outputs: [{ name: 'echo', type: 'string' }],
      async handle() { await probe.slow.opened; return { outputs: { echo: 'late' } }; },
    },
    {
      id: 'read-badout', description: 'Returns something it did not declare', mode: 'read', inputs: [], outputs: [{ name: 'echo', type: 'string' }],
      async handle() { return { outputs: { echo: 5 } }; },
    },
    {
      id: 'read-busy', description: 'Is always busy', mode: 'read', inputs: [], outputs: [],
      async handle() { throw new CapabilityError(409, 'The Building is busy'); },
    },
    {
      id: 'read-throw', description: 'Fails', mode: 'read', inputs: [], outputs: [],
      async handle() { throw new Error('boom'); },
    },
    {
      id: 'read-nested', description: 'Lets a test make a nested call', mode: 'read', inputs: [], outputs: [],
      async handle(context) { await probe.nested?.(context); return { outputs: {} }; },
    },
    {
      id: 'write-send', description: 'Sends something outward', mode: 'write', inputs: [{ name: 'to', type: 'string', required: true, max: 50 }], outputs: [{ name: 'sent', type: 'integer' }],
      async handle(_context, inputs) { probe.sends.push(inputs); return { outputs: { sent: probe.sends.length } }; },
    },
    {
      id: 'write-open', description: 'Changes things without asking', mode: 'write', requiresApproval: false, inputs: [], outputs: [{ name: 'ok', type: 'boolean' }],
      async handle() { return { outputs: { ok: true } }; },
    },
    {
      id: 'write-latch', description: 'Waits at a latch', mode: 'write', requiresApproval: false, inputs: [], outputs: [{ name: 'n', type: 'integer' }],
      async handle() { probe.latchRuns += 1; probe.latchEntered.open(); await probe.latch.opened; return { outputs: { n: probe.latchRuns } }; },
    },
    {
      id: 'write-held', description: 'Needs approval and waits at a latch', mode: 'write', inputs: [], outputs: [{ name: 'n', type: 'integer' }],
      async handle() { probe.latchRuns += 1; probe.latchEntered.open(); await probe.latch.opened; return { outputs: { n: probe.latchRuns } }; },
    },
    {
      id: 'write-run', description: 'Starts a run', mode: 'write', requiresApproval: false, startsRun: true, inputs: [], outputs: [],
      async handle(context) { await context.noteStarted('fixture-run-1'); return { outputs: {}, runRef: 'fixture-run-1' }; },
    },
  ];
}

export function fixtureType(id: string, probe: Probe, CapabilityError: new (status: number, message: string) => Error, patch: Partial<BuildingTypeDefinition> = {}): BuildingTypeDefinition {
  return {
    id, name: `Fixture ${id}`, description: 'A type with capabilities and events for tests.', category: 'Test', version: 1,
    look: { model: 'generic', color: '#fff' }, workspace: 'notes', repository: false,
    validateCreate: (input) => ({ ok: true, value: { name: String((input as { name?: unknown }).name ?? 'x') } }),
    slots: [{ id: 'review', label: 'Review', usedWhen: 'x', defaultWorkflowId: 'software-development' }],
    agents: [], scheduledJobs: [],
    capabilities: fixtureCapabilities(probe, CapabilityError),
    events: [
      { id: 'report-published', description: 'A report was published', payload: [{ name: 'title', type: 'string', required: true, max: 20 }] },
      { id: 'deal-won', description: 'A deal was won' },
    ],
    ...patch,
  };
}
