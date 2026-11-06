import type { BuildingTypeDefinition, CapabilityDeclaration, FieldSpec } from '../buildings/contract.ts';
import type { ActivityResult, BuildingLinkRecord, CallerKind } from './types.ts';

export const DEFAULTS = {
  maxDepth: 3,
  readTimeoutMs: 60_000,
  idempotencyWindowMs: 10 * 60_000,
  chainDepthRetentionMs: 7 * 24 * 60 * 60_000,
  eventsPerHour: 30,
  maxIdempotencyKeyLength: 128,
  summaryLength: 200,
  activityPageSize: 100,
  activityPageMax: 500,
} as const;

export const HOUR_MS = 3_600_000;

/** A refused or failed request: the HTTP status, a readable reason and, for a bad value, the field. */
export class ConnectionError extends Error {
  readonly status: number;
  readonly field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.name = 'ConnectionError';
    this.status = status;
    this.field = field;
  }
}

/** Thrown by a capability's code for a condition it knows: its target is busy, not ready, or the request cannot be served. */
export class CapabilityError extends ConnectionError {}

export function findCapability(type: BuildingTypeDefinition | undefined, capabilityId: string): CapabilityDeclaration | undefined {
  return type?.capabilities.find((capability) => capability.id === capabilityId);
}

/** Why a link no longer works against its target's current type; empty when it is whole. Computed on read, never stored. */
export function brokenReasons(link: Pick<BuildingLinkRecord, 'capabilities' | 'events'>, type: BuildingTypeDefinition | undefined): string[] {
  if (!type) return ['The target Building\'s type is no longer available'];
  return [
    ...link.capabilities.filter((grant) => !findCapability(type, grant.capabilityId)).map((grant) => `The target no longer offers "${grant.capabilityId}"`),
    ...link.events.filter((eventId) => !type.events.some((event) => event.id === eventId)).map((eventId) => `The target no longer publishes "${eventId}"`),
  ];
}

export const needsApproval = (capability: CapabilityDeclaration): boolean => capability.mode === 'write' && capability.requiresApproval !== false;

/** Whether a call waits for a person. A pre-approved grant waives it for a scheduled job only; agents, steps and people stay gated. */
export function approvalRequired(capability: CapabilityDeclaration, preApproved: boolean, callerKind: CallerKind): boolean {
  if (!needsApproval(capability)) return false;
  return !(preApproved && callerKind === 'job');
}

export const withinDepth = (depth: number, maxDepth: number): boolean => depth <= maxDepth;

/** Calls and events made while a recent delivery still counts toward the hourly limit. */
export function recentWithinHour(deliveries: readonly number[], now: number): number[] {
  return deliveries.filter((at) => now - at < HOUR_MS);
}

export type SessionKind = 'execute' | 'writable-step' | 'readonly-step' | 'planning';

/** Writes are offered only to sessions that may change things. */
export const modesFor = (session: SessionKind): ReadonlyArray<'read' | 'write'> => (session === 'execute' || session === 'writable-step' ? ['read', 'write'] : ['read']);

export interface ToolOffer {
  targetBuildingId: string;
  capabilityId: string;
  description: string;
  mode: 'read' | 'write';
  inputs: FieldSpec[];
}

/** The capabilities a session may call: granted by an outgoing link, still declared by the target's type, and allowed for the session's kind. */
export function toolOffers(session: SessionKind, links: readonly BuildingLinkRecord[], typeOf: (buildingId: string) => BuildingTypeDefinition | undefined): ToolOffer[] {
  const modes = modesFor(session);
  return links.flatMap((link) => {
    const type = typeOf(link.toBuildingId);
    return link.capabilities.flatMap((grant) => {
      const capability = findCapability(type, grant.capabilityId);
      return capability && modes.includes(capability.mode)
        ? [{ targetBuildingId: link.toBuildingId, capabilityId: capability.id, description: capability.description, mode: capability.mode, inputs: capability.inputs }]
        : [];
    });
  });
}

/** A short single-line summary of a call's inputs for the Activity log; `shortened` says it was cut. */
export function summarizeInputs(inputs: unknown, max: number = DEFAULTS.summaryLength): { text: string; shortened: boolean } {
  const json = JSON.stringify(inputs ?? {}) ?? '{}';
  const chars = [...json];
  return chars.length > max ? { text: chars.slice(0, max).join(''), shortened: true } : { text: json, shortened: false };
}

export interface ActivityFilter {
  caller?: string;
  capability?: string;
  result?: ActivityResult;
  from?: number;
  to?: number;
  limit: number;
}

export const ACTIVITY_RESULTS: readonly ActivityResult[] = ['ok', 'error', 'refused', 'awaiting-approval', 'changes-requested', 'stopped', 'rate-limited'];

/** Calendar dates and instants with an explicit offset or `Z`; digits-only epoch values and impossible dates are refused. */
export function parseWhen(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  const check = new Date(0);
  check.setUTCFullYear(y, m - 1, d);
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? parsed : null;
}

export function parseActivityFilter(query: Record<string, unknown>): ActivityFilter {
  const text = (name: string): string | undefined => {
    const value = query[name];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new ConnectionError(400, `${name} must be text`, name);
    return value;
  };
  const when = (name: string): number | undefined => {
    const raw = text(name);
    if (raw === undefined) return undefined;
    const parsed = parseWhen(raw);
    if (parsed === null) throw new ConnectionError(400, `${name} must be a date such as 2026-10-12 or 2026-10-12T09:30:00Z`, name);
    return parsed;
  };
  const result = text('result');
  if (result !== undefined && !ACTIVITY_RESULTS.includes(result as ActivityResult)) throw new ConnectionError(400, `result must be one of: ${ACTIVITY_RESULTS.join(', ')}`, 'result');
  const from = when('from');
  const to = when('to');
  if (from !== undefined && to !== undefined && from > to) throw new ConnectionError(400, 'from must not be later than to', 'from');
  const rawLimit = text('limit');
  if (rawLimit !== undefined && !/^[1-9]\d{0,5}$/.test(rawLimit)) throw new ConnectionError(400, 'limit must be a whole number above 0', 'limit');
  return {
    caller: text('caller'), capability: text('capability'), result: result as ActivityResult | undefined, from, to,
    limit: Math.min(DEFAULTS.activityPageMax, rawLimit === undefined ? DEFAULTS.activityPageSize : Number(rawLimit)),
  };
}
