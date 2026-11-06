/**
 * Connections between Buildings as the browser sees them (served by the daemon's link, capability-call, subscription
 * and Activity routes; see docs/connections.md). The pure view-models live here so the Connections view, the Activity
 * log and the 3D link lines are testable without a DOM or WebGL.
 */

export interface FieldSpec {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'object';
  required?: boolean;
  description?: string;
  max?: number;
  minValue?: number;
  maxValue?: number;
  values?: string[];
  items?: FieldSpec;
  fields?: FieldSpec[];
}

export interface CapabilityInfo {
  id: string;
  description: string;
  mode: 'read' | 'write';
  requiresApproval?: boolean;
  startsRun?: boolean;
  inputs: FieldSpec[];
  outputs: FieldSpec[];
}

export interface EventInfo { id: string; description: string; payload?: FieldSpec[] }

export interface LinkGrant { capabilityId: string; preApproved: boolean }

export interface LinkView {
  id: string;
  fromBuildingId: string;
  toBuildingId: string;
  fromName: string | null;
  toName: string | null;
  capabilities: LinkGrant[];
  events: string[];
  broken: boolean;
  brokenReasons: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LinksResponse { outgoing: LinkView[]; incoming: LinkView[] }

export interface LinkRequest { fromBuildingId?: string; toBuildingId?: string; capabilities?: LinkGrant[]; events?: string[] }

export interface SubscriptionView {
  id: string;
  subscriberBuildingId: string;
  sourceBuildingId: string;
  eventId: string;
  jobId: string;
  enabled: boolean;
  autoDisabled: boolean;
}

export type ActivityResult = 'ok' | 'error' | 'refused' | 'awaiting-approval' | 'changes-requested' | 'stopped' | 'rate-limited';
export const ACTIVITY_RESULTS: readonly ActivityResult[] = ['ok', 'error', 'refused', 'awaiting-approval', 'changes-requested', 'stopped', 'rate-limited'];

export interface ActivityEntry {
  id: string;
  at: string;
  kind: 'call' | 'event';
  callerKind: 'person' | 'job' | 'step' | 'agent' | 'event';
  callerBuildingId: string;
  callerName: string;
  callerRefId: string | null;
  targetBuildingId: string;
  targetName: string;
  name: string;
  inputsSummary: string;
  inputsShortened: boolean;
  result: ActivityResult;
  status: number;
  message: string | null;
  runRef: string | null;
  role: 'caller' | 'target' | 'self';
}

export interface CallOutcome {
  callId: string;
  state: 'done' | 'awaiting-approval';
  outputs?: Record<string, unknown>;
  runRef?: string;
}

export const DELETED_BUILDING = 'Building deleted';

/** A name for a Building a log row mentions; a Building that has since been deleted reads "Building deleted". */
export const buildingLabel = (name: string | null | undefined): string => (name?.trim() ? name : DELETED_BUILDING);

const REFUSAL_REASONS: Record<number, string> = {
  400: 'A value was not accepted',
  403: 'The link does not allow this',
  404: 'Not found',
  409: 'Not possible right now',
  504: 'The other Building did not answer in time',
};

/** What a failed call, link or subscription says, led by the reason for its status so a refusal is readable at a glance. */
export function describeConnectionError(status: number, message: string | null | undefined): string {
  const lead = REFUSAL_REASONS[status];
  const detail = message?.trim();
  if (lead && detail) return `${lead}: ${detail}`;
  return detail || lead || 'The request failed';
}

// ---- Connections view ----

export interface LinkRow {
  id: string;
  direction: 'outgoing' | 'incoming';
  otherBuildingId: string;
  otherName: string;
  summary: string;
  broken: boolean;
  brokenReasons: string[];
}

const countOf = (count: number, noun: 'capability' | 'event') => `${count} ${count === 1 ? noun : noun === 'capability' ? 'capabilities' : 'events'}`;

/** One row per link for a Building: the links it uses first, then the ones other Buildings use on it. */
export function linkRows(links: LinksResponse): LinkRow[] {
  const row = (link: LinkView, direction: LinkRow['direction']): LinkRow => ({
    id: link.id,
    direction,
    otherBuildingId: direction === 'outgoing' ? link.toBuildingId : link.fromBuildingId,
    otherName: buildingLabel(direction === 'outgoing' ? link.toName : link.fromName),
    summary: `${countOf(link.capabilities.length, 'capability')}, ${countOf(link.events.length, 'event')}`,
    broken: link.broken,
    brokenReasons: link.brokenReasons,
  });
  return [...links.outgoing.map((l) => row(l, 'outgoing')), ...links.incoming.map((l) => row(l, 'incoming'))];
}

/** A grant is only offered pre-approval when the call would otherwise wait for a person. */
export const canPreApprove = (capability: Pick<CapabilityInfo, 'mode' | 'requiresApproval'>): boolean => capability.mode === 'write' && capability.requiresApproval !== false;

/** What a link to this type may grant: exactly the capabilities and events the type declares. */
export function grantChoices(type: { capabilities?: CapabilityInfo[]; events?: EventInfo[] } | undefined): { capabilities: CapabilityInfo[]; events: EventInfo[] } {
  return { capabilities: type?.capabilities ?? [], events: type?.events ?? [] };
}

/** A new link starts with every capability of the target granted; pre-approval is never on by default. */
export const defaultGrants = (capabilities: readonly Pick<CapabilityInfo, 'id'>[]): LinkGrant[] => capabilities.map((capability) => ({ capabilityId: capability.id, preApproved: false }));

/** Unchecks a granted capability or checks one that is off; no other grant changes. */
export const toggleGrant = (grants: readonly LinkGrant[], capabilityId: string): LinkGrant[] => (grants.some((grant) => grant.capabilityId === capabilityId)
  ? grants.filter((grant) => grant.capabilityId !== capabilityId) : [...grants, { capabilityId, preApproved: false }]);

export const togglePreApproved = (grants: readonly LinkGrant[], capabilityId: string): LinkGrant[] => grants.map((grant) => (grant.capabilityId === capabilityId ? { ...grant, preApproved: !grant.preApproved } : grant));

// ---- Manual call form ----

export interface CallField {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'checkbox' | 'select' | 'json';
  required: boolean;
  /** Most characters (text) or items (list); the field refuses more rather than shortening it. */
  max: number | null;
  options: string[];
  hint: string | null;
}

const KIND_OF: Record<FieldSpec['type'], CallField['kind']> = { string: 'text', number: 'number', integer: 'number', boolean: 'checkbox', enum: 'select', array: 'json', object: 'json' };

export function callFields(capability: Pick<CapabilityInfo, 'inputs'>): CallField[] {
  return capability.inputs.map((spec) => ({
    name: spec.name,
    label: spec.name,
    kind: KIND_OF[spec.type],
    required: spec.required === true,
    max: spec.max ?? null,
    options: spec.values ?? [],
    hint: spec.description ?? null,
  }));
}

export type CallValues = Record<string, string | boolean | undefined>;

const characters = (text: string) => [...text].length;

/** The first reason the form cannot be sent yet, naming the field; null when it can. */
export function callProblem(capability: Pick<CapabilityInfo, 'inputs'>, values: CallValues): { field: string; message: string } | null {
  for (const field of callFields(capability)) {
    const value = values[field.name];
    const text = typeof value === 'string' ? value : '';
    if (field.required && field.kind !== 'checkbox' && !text.trim()) return { field: field.name, message: `${field.label} is required` };
    if (field.kind === 'text' && field.max !== null && characters(text) > field.max) return { field: field.name, message: `${field.label} must be at most ${field.max} characters` };
    if (field.kind === 'number' && text && !Number.isFinite(Number(text))) return { field: field.name, message: `${field.label} must be a number` };
    if (field.kind === 'json' && text) {
      try { JSON.parse(text); } catch { return { field: field.name, message: `${field.label} must be valid JSON` }; }
    }
  }
  return null;
}

/** The inputs to send: only fields with a value, typed, and never shortened. */
export function buildCallInputs(capability: Pick<CapabilityInfo, 'inputs'>, values: CallValues): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const field of callFields(capability)) {
    const value = values[field.name];
    if (field.kind === 'checkbox') { if (typeof value === 'boolean') inputs[field.name] = value; continue; }
    if (typeof value !== 'string' || value === '') continue;
    inputs[field.name] = field.kind === 'number' ? Number(value) : field.kind === 'json' ? JSON.parse(value) : value;
  }
  return inputs;
}

// ---- Activity log ----

export interface ActivityFilters { caller?: string; capability?: string; result?: ActivityResult | ''; from?: string; to?: string }

/** The query string for the log's filters; an empty filter is left out. */
export function activityQuery(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** A filter range that ends before it starts is blocked before it is sent. */
export function activityRangeProblem(filters: Pick<ActivityFilters, 'from' | 'to'>): string | null {
  if (!filters.from || !filters.to) return null;
  const from = Date.parse(filters.from);
  const to = Date.parse(filters.to);
  return Number.isNaN(from) || Number.isNaN(to) || from <= to ? null : 'The start must not be later than the end';
}

const RESULT_LABELS: Record<ActivityResult, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  ok: { label: 'Done', tone: 'ok' },
  error: { label: 'Failed', tone: 'bad' },
  refused: { label: 'Refused', tone: 'bad' },
  'awaiting-approval': { label: 'Waiting for approval', tone: 'warn' },
  'changes-requested': { label: 'Changes requested', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  'rate-limited': { label: 'Rate limited', tone: 'warn' },
};

const CALLER_LABELS: Record<ActivityEntry['callerKind'], string> = { person: 'Person', job: 'Scheduled job', step: 'Workflow step', agent: 'Agent', event: 'Event' };

export interface ActivityRow {
  id: string;
  time: string;
  caller: string;
  target: string;
  what: string;
  summary: string;
  resultLabel: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  message: string | null;
  runRef: string | null;
}

export function activityRow(entry: ActivityEntry): ActivityRow {
  const result = RESULT_LABELS[entry.result];
  const how = entry.kind === 'event' ? 'Event' : CALLER_LABELS[entry.callerKind];
  return {
    id: entry.id,
    time: entry.at,
    caller: `${buildingLabel(entry.callerName)} (${how})`,
    target: buildingLabel(entry.targetName),
    what: entry.name,
    summary: entry.inputsShortened ? `${entry.inputsSummary}…` : entry.inputsSummary,
    resultLabel: result.label,
    tone: result.tone,
    message: entry.message,
    runRef: entry.runRef,
  };
}

// ---- 3D scene link lines ----

export interface LinkLine {
  id: string;
  from: [number, number];
  to: [number, number];
  broken: boolean;
  fromName: string;
  toName: string;
}

export const MAX_LINK_LINES = 200;
/** How far apart the two lines of a two-way pair sit, in scene units. */
const PAIR_OFFSET = 0.18;
const MIN_LENGTH = 1e-6;

/**
 * A line per link between two Buildings that both exist in the scene. A pair linked both ways gets two lines pushed to
 * either side of the straight path so they never overlap; Buildings standing in the same place make no line, never NaN.
 */
export function linkLines(links: readonly LinkView[], positions: ReadonlyMap<string, readonly [number, number]>): LinkLine[] {
  const ids = new Set(links.map((l) => l.id));
  const pairKey = (a: string, b: string) => `${a}->${b}`;
  const lines: LinkLine[] = [];
  for (const link of [...links].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_LINK_LINES)) {
    const from = positions.get(link.fromBuildingId);
    const to = positions.get(link.toBuildingId);
    if (!from || !to || !ids.has(link.id)) continue;
    const dx = to[0] - from[0];
    const dz = to[1] - from[1];
    const length = Math.hypot(dx, dz);
    if (!(length > MIN_LENGTH)) continue;
    const twoWay = links.some((other) => pairKey(other.fromBuildingId, other.toBuildingId) === pairKey(link.toBuildingId, link.fromBuildingId));
    // Perpendicular to the path; the link from the lower id sits on one side, the reverse on the other.
    const side = twoWay ? (link.fromBuildingId < link.toBuildingId ? 1 : -1) * PAIR_OFFSET : 0;
    const nx = (-dz / length) * side;
    const nz = (dx / length) * side;
    lines.push({
      id: link.id, from: [from[0] + nx, from[1] + nz], to: [to[0] + nx, to[1] + nz], broken: link.broken,
      fromName: buildingLabel(link.fromName), toName: buildingLabel(link.toName),
    });
  }
  return lines;
}

/** The hover text of a link line. */
export function linkTooltip(link: Pick<LinkView, 'fromName' | 'toName' | 'capabilities' | 'events' | 'broken'>): string {
  const base = `${buildingLabel(link.fromName)} → ${buildingLabel(link.toName)}: ${countOf(link.capabilities.length, 'capability')}, ${countOf(link.events.length, 'event')}`;
  return link.broken ? `${base} (broken)` : base;
}
