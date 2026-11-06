import { randomUUID } from 'node:crypto';
import type { BuildingTypeDefinition, CapabilityDeclaration } from '../buildings/contract.ts';
import { getBuildingType } from '../buildings/registry.ts';
import { activityLogDb, buildingLinksDb, capabilityApprovalsDb, chainDepthsDb, eventSubscriptionsDb, pendingEventsDb, projectsDb, scheduledJobsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { validateFields } from './fields.ts';
import { CURRENT_GRANTS_VERSION, migrateLinkGrants } from './grantsMigration.ts';
import {
  approvalRequired, brokenReasons, ConnectionError, DEFAULTS, findCapability, parseActivityFilter, recentWithinHour, summarizeInputs, toolOffers, withinDepth,
} from './rules.ts';
import type { SessionKind, ToolOffer } from './rules.ts';
import { LOCAL_TENANT } from './types.ts';
import type {
  ActivityRecord, ActivityResult, BuildingLinkRecord, CallerRef, CapabilityApprovalRecord, EventSubscriptionRecord, LinkGrant, PendingEventRecord,
} from './types.ts';

/**
 * Capabilities, events and links between Buildings (docs/connections.md). Every call and event is checked against the
 * links a person made, and audited in the Activity log. The service has no timers of its own: a call's timeout and the
 * clock are injected, and event delivery is driven by `publishEvent` and `deliverPending`.
 */

/** The subscriber could not take the event right now (it is down or restarting); the event stays pending. */
export class SubscriberUnavailableError extends Error {}

export interface JobStartResult {
  state: 'started' | 'skipped' | 'failed';
  runId: string | null;
  note: string | null;
}

export interface ConnectionsDeps {
  now?: () => number;
  /** How long a call may take before it answers 504. */
  timeoutMs?: number;
  idempotencyWindowMs?: number;
  eventsPerHour?: number;
  maxDepth?: number;
  newId?: () => string;
  getProject?: (id: string) => Promise<ProjectRecord | undefined>;
  typeOf?: (project: ProjectRecord) => BuildingTypeDefinition | undefined;
  tenantOf?: (project: ProjectRecord) => string;
  /** Starts the subscriber's job for one event; throws `SubscriberUnavailableError` while the subscriber is down. */
  startJob: (request: { subscription: EventSubscriptionRecord; deliveryId: string; eventId: string; depth: number; chainId: string }) => Promise<JobStartResult>;
  /** Whether a job start already carries this delivery id, so a retry after a crash starts nothing twice. */
  hasStarted: (deliveryId: string) => Promise<boolean>;
  notify: (notice: { kind: 'connection.awaiting_approval' | 'connection.subscription_disabled'; projectId: string; title: string; description: string }) => Promise<void>;
  /** Clears the approval notice of a Building once nothing is waiting on it. */
  resolveApprovalNotice: (projectId: string) => Promise<void>;
}

export interface CallRequest {
  caller: CallerRef;
  targetBuildingId: string;
  capabilityId: string;
  inputs?: unknown;
  idempotencyKey?: unknown;
  /** The depth of this call: 1 for a call a person or job makes. */
  depth?: number;
  chainId?: string;
  /** The kinds of capability the caller may use; a read-only session lists only `read`. */
  allowedModes?: ReadonlyArray<'read' | 'write'>;
}

export interface CallOutcome {
  status: 200 | 202;
  body: { callId: string; state: 'done' | 'awaiting-approval'; outputs?: Record<string, unknown>; runRef?: string };
}

export type ApprovalDecision = 'approve' | 'request-changes' | 'stop';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

export function createConnections(deps: ConnectionsDeps) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULTS.readTimeoutMs;
  const idempotencyWindowMs = deps.idempotencyWindowMs ?? DEFAULTS.idempotencyWindowMs;
  const eventsPerHour = deps.eventsPerHour ?? DEFAULTS.eventsPerHour;
  const maxDepth = deps.maxDepth ?? DEFAULTS.maxDepth;
  const newId = deps.newId ?? randomUUID;
  const getProject = deps.getProject ?? ((id: string) => projectsDb.get(id));
  const typeOf = deps.typeOf ?? ((project: ProjectRecord) => getBuildingType(project.typeId ?? 'software'));
  const tenantOf = deps.tenantOf ?? (() => LOCAL_TENANT);
  const iso = () => new Date(now()).toISOString();

  const callListeners = new Set<(callId: string) => void>();
  const onCallChanged = (listener: (callId: string) => void) => { callListeners.add(listener); return () => { callListeners.delete(listener); }; };
  const emitCall = (callId: string) => { for (const listener of callListeners) listener(callId); };

  /** Event fan-out and delivery run one at a time, so the hourly counters never race. */
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(fn);
    chain = result.catch(() => undefined);
    return result;
  }

  // ---- Activity log ----

  async function record(entry: Omit<ActivityRecord, 'id' | 'at' | 'inputsSummary' | 'inputsShortened'> & { inputs?: unknown }): Promise<ActivityRecord> {
    const { inputs, ...rest } = entry;
    const summary = summarizeInputs(inputs);
    return activityLogDb.insert({ id: newId(), at: iso(), inputsSummary: summary.text, inputsShortened: summary.shortened, ...rest });
  }

  async function requireBuilding(id: unknown, label = 'Building'): Promise<ProjectRecord> {
    const project = typeof id === 'string' && id ? await getProject(id) : undefined;
    if (!project) throw new ConnectionError(404, `${label} not found`);
    return project;
  }

  // ---- Links ----

  function parseGrants(value: unknown, target: BuildingTypeDefinition | undefined): LinkGrant[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ConnectionError(400, 'capabilities must be a list', 'capabilities');
    const grants = new Map<string, LinkGrant>();
    value.forEach((entry, index) => {
      const grant = typeof entry === 'string' ? { capabilityId: entry, preApproved: false } : entry;
      const field = `capabilities[${index}]`;
      if (!isObject(grant) || typeof grant.capabilityId !== 'string') throw new ConnectionError(400, `${field} must name a capability`, field);
      const capability = findCapability(target, grant.capabilityId);
      if (!capability) throw new ConnectionError(400, `The target does not offer "${grant.capabilityId}"`, `${field}.capabilityId`);
      if (grant.preApproved !== undefined && typeof grant.preApproved !== 'boolean') throw new ConnectionError(400, `${field}.preApproved must be true or false`, `${field}.preApproved`);
      const preApproved = grant.preApproved === true;
      if (preApproved && !approvalRequired(capability, false, 'person')) throw new ConnectionError(400, `"${capability.id}" does not need approval, so it cannot be pre-approved`, `${field}.preApproved`);
      grants.set(capability.id, { capabilityId: capability.id, preApproved });
    });
    return [...grants.values()];
  }

  function parseEvents(value: unknown, target: BuildingTypeDefinition | undefined): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ConnectionError(400, 'events must be a list', 'events');
    const ids = new Set<string>();
    value.forEach((eventId, index) => {
      if (typeof eventId !== 'string' || !target?.events.some((event) => event.id === eventId)) throw new ConnectionError(400, `The target does not publish "${String(eventId)}"`, `events[${index}]`);
      ids.add(eventId);
    });
    return [...ids];
  }

  async function sameTenantBuildings(fromId: unknown, toId: unknown): Promise<{ from: ProjectRecord; to: ProjectRecord }> {
    const from = await requireBuilding(fromId, 'The linking Building');
    const to = await requireBuilding(toId, 'The target Building');
    if (tenantOf(from) !== tenantOf(to)) throw new ConnectionError(404, 'The target Building not found');
    return { from, to };
  }

  async function createLink(body: unknown): Promise<BuildingLinkRecord> {
    if (!isObject(body)) throw new ConnectionError(400, 'The link must be a JSON object', 'body');
    const { from, to } = await sameTenantBuildings(body.fromBuildingId, body.toBuildingId);
    if (from.id === to.id) throw new ConnectionError(400, 'A Building cannot be linked to itself', 'toBuildingId');
    if ((await buildingLinksDb.find((link) => link.fromBuildingId === from.id && link.toBuildingId === to.id)).length) throw new ConnectionError(409, 'These Buildings are already linked');
    const target = typeOf(to);
    const stamp = iso();
    return buildingLinksDb.insert({
      id: newId(), fromBuildingId: from.id, toBuildingId: to.id,
      capabilities: parseGrants(body.capabilities, target), events: parseEvents(body.events, target), grantsVersion: CURRENT_GRANTS_VERSION, createdAt: stamp, updatedAt: stamp,
    });
  }

  async function requireLink(id: string): Promise<BuildingLinkRecord> {
    const link = await buildingLinksDb.get(id);
    if (!link) throw new ConnectionError(404, 'Link not found');
    return link;
  }

  async function updateLink(id: string, body: unknown): Promise<BuildingLinkRecord> {
    const link = await requireLink(id);
    if (!isObject(body)) throw new ConnectionError(400, 'The change must be a JSON object', 'body');
    const target = typeOf(await requireBuilding(link.toBuildingId));
    const capabilities = body.capabilities === undefined ? link.capabilities : parseGrants(body.capabilities, target);
    const events = body.events === undefined ? link.events : parseEvents(body.events, target);
    for (const eventId of link.events.filter((e) => !events.includes(e))) {
      await removeSubscriptions((s) => s.subscriberBuildingId === link.fromBuildingId && s.sourceBuildingId === link.toBuildingId && s.eventId === eventId);
    }
    return (await buildingLinksDb.update(id, { capabilities, events, updatedAt: iso() }))!;
  }

  /** Brings every stored link up to the current default-on capabilities; run once at startup, safe to repeat. */
  async function migrateLinkGrantsOnStartup(): Promise<void> {
    for (const link of await buildingLinksDb.all()) {
      const target = await getProject(link.toBuildingId);
      if (!target) continue;
      const migrated = migrateLinkGrants(link, typeOf(target));
      if (migrated) await buildingLinksDb.update(link.id, { capabilities: migrated.capabilities, grantsVersion: migrated.grantsVersion });
    }
  }

  async function removeSubscriptions(match: (s: EventSubscriptionRecord) => boolean): Promise<void> {
    for (const subscription of await eventSubscriptionsDb.find(match)) {
      await eventSubscriptionsDb.delete(subscription.id);
      for (const row of await pendingEventsDb.find((p) => p.subscriptionId === subscription.id)) await pendingEventsDb.delete(row.id);
    }
  }

  async function deleteLink(id: string): Promise<void> {
    const link = await requireLink(id);
    await removeSubscriptions((s) => s.subscriberBuildingId === link.fromBuildingId && s.sourceBuildingId === link.toBuildingId);
    await buildingLinksDb.delete(id);
  }

  async function linkView(link: BuildingLinkRecord) {
    const [from, to] = await Promise.all([getProject(link.fromBuildingId), getProject(link.toBuildingId)]);
    const reasons = brokenReasons(link, to ? typeOf(to) : undefined);
    return { ...link, fromName: from?.name ?? null, toName: to?.name ?? null, broken: reasons.length > 0, brokenReasons: reasons };
  }

  async function listLinks(buildingId: string) {
    await requireBuilding(buildingId);
    const links = await buildingLinksDb.find((link) => link.fromBuildingId === buildingId || link.toBuildingId === buildingId);
    const views = await Promise.all(links.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(linkView));
    return { outgoing: views.filter((view) => view.fromBuildingId === buildingId), incoming: views.filter((view) => view.toBuildingId === buildingId) };
  }

  /** Every link, for the 3D scene's connection lines. */
  async function listAllLinks() {
    return Promise.all((await buildingLinksDb.all()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(linkView));
  }

  // ---- Capability calls ----

  interface Authorized { target: ProjectRecord; type: BuildingTypeDefinition | undefined; capability: CapabilityDeclaration; link: BuildingLinkRecord; grant: LinkGrant }

  /** The checks every call passes, in order: building 404, capability 404, link 403, grant 403, broken 409. Throws without writing the Activity log. */
  async function authorize(request: Pick<CallRequest, 'caller' | 'targetBuildingId' | 'capabilityId'>): Promise<Authorized> {
    const caller = await requireBuilding(request.caller.buildingId, 'The calling Building');
    const target = await requireBuilding(request.targetBuildingId);
    if (tenantOf(caller) !== tenantOf(target)) throw new ConnectionError(404, 'Building not found');
    const type = typeOf(target);
    const capability = findCapability(type, request.capabilityId);
    const link = (await buildingLinksDb.find((l) => l.fromBuildingId === caller.id && l.toBuildingId === target.id))[0];
    const grant = link?.capabilities.find((g) => g.capabilityId === request.capabilityId);
    if (!capability && !grant) throw new ConnectionError(404, `"${target.name}" has no capability "${request.capabilityId}"`);
    if (!link) throw new ConnectionError(403, `"${caller.name}" is not linked to "${target.name}". Link them in Connections first.`);
    if (!grant) throw new ConnectionError(403, `The link from "${caller.name}" to "${target.name}" does not grant "${request.capabilityId}".`);
    if (!capability) throw new ConnectionError(409, `The link is broken: "${target.name}" no longer offers "${request.capabilityId}".`);
    return { target, type, capability, link, grant };
  }

  /**
   * Calls remembered by idempotency key for the window. A call held for approval is remembered too, but a retry
   * answers with the approval's current state (`currentHeldOutcome`), never the stale "awaiting approval" body.
   */
  const settledKeys = new Map<string, { inputs: string; promise: Promise<CallOutcome>; settledAt: number | null; held: boolean }>();

  function pruneSettledKeys(): void {
    for (const [scope, entry] of settledKeys) if (entry.settledAt !== null && now() - entry.settledAt >= idempotencyWindowMs) settledKeys.delete(scope);
  }

  async function currentHeldOutcome(promise: Promise<CallOutcome>): Promise<CallOutcome> {
    const outcome = await promise;
    if (outcome.status !== 202) return outcome;
    const entry = await activityLogDb.get(outcome.body.callId);
    if (!entry || entry.result === 'awaiting-approval') return outcome;
    if (entry.result === 'ok') return { status: 200, body: { callId: entry.id, state: 'done', ...(entry.runRef ? { runRef: entry.runRef } : {}) } };
    throw new ConnectionError(409, `This call was already settled (${entry.result.replace('-', ' ')}); see the Activity log.`, 'idempotencyKey');
  }

  /** Depth rows only matter while a run can still call out, so rows past the retention are dropped on each insert. */
  async function noteChainDepth(id: string, depth: number, chainId: string, buildingId: string): Promise<void> {
    for (const old of await chainDepthsDb.find((row) => row.createdAt !== undefined && now() - Date.parse(row.createdAt) >= DEFAULTS.chainDepthRetentionMs)) await chainDepthsDb.delete(old.id);
    await chainDepthsDb.insert({ id, depth, chainId, buildingId, createdAt: iso() }).catch(() => undefined);
  }

  /** A call that timed out keeps running; when it finishes anyway its outcome is added to the Activity log so a late change is visible. */
  async function recordLateFinish(auth: Authorized, request: CallRequest, inputs: Record<string, unknown>, depth: number, running: Promise<{ runRef?: string }>): Promise<void> {
    const base = { kind: 'call' as const, callerKind: request.caller.kind, callerBuildingId: request.caller.buildingId, callerRefId: request.caller.refId ?? null, targetBuildingId: auth.target.id, name: auth.capability.id, depth, chainId: request.chainId ?? '', inputs };
    await running.then(
      (done) => record({ ...base, result: 'ok', status: 200, message: 'Finished after the call had timed out', runRef: done.runRef ?? null }),
      (error: unknown) => record({ ...base, result: 'error', status: 500, message: `Failed after the call had timed out: ${(error as Error).message}`, runRef: null }),
    ).catch(() => undefined);
  }

  async function runHandler(auth: Authorized, request: CallRequest, inputs: Record<string, unknown>, depth: number): Promise<{ outputs: Record<string, unknown>; runRef?: string }> {
    const { capability, target } = auth;
    if (!capability.handle) throw new ConnectionError(409, `"${target.name}" declares "${capability.id}" but does not implement it yet.`);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ConnectionError(504, `"${capability.id}" did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
      timer.unref();
    });
    try {
      const context = {
        buildingId: target.id, callerBuildingId: request.caller.buildingId, depth,
        noteStarted: (id: string) => noteChainDepth(id, depth, request.chainId ?? '', target.id),
      };
      const running = capability.handle(context, inputs);
      const result = await Promise.race([running, timeout]).catch((error: unknown) => {
        if (error instanceof ConnectionError && error.status === 504) void recordLateFinish(auth, request, inputs, depth, running);
        throw error;
      });
      const outputs = validateFields(capability.outputs, result.outputs);
      if (!outputs.ok) throw new ConnectionError(502, `"${capability.id}" returned something that does not match its declared outputs (${outputs.field}).`);
      return { outputs: outputs.value, runRef: result.runRef };
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError(500, `"${capability.id}" failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const resultOf = (status: number, fromHandler: boolean): ActivityResult => (status >= 500 || fromHandler ? 'error' : 'refused');

  async function call(request: CallRequest): Promise<CallOutcome> {
    const depth = request.depth ?? 1;
    const chainId = request.chainId ?? newId();
    const entryBase = { kind: 'call' as const, callerKind: request.caller.kind, callerBuildingId: request.caller.buildingId, callerRefId: request.caller.refId ?? null, targetBuildingId: request.targetBuildingId, name: request.capabilityId, depth, chainId, runRef: null };
    const refuse = async (error: ConnectionError, fromHandler = false): Promise<never> => {
      await record({ ...entryBase, inputs: request.inputs, result: resultOf(error.status, fromHandler), status: error.status, message: error.message });
      throw error;
    };

    const key = request.idempotencyKey;
    if (key !== undefined && key !== null && (typeof key !== 'string' || !key || key.length > DEFAULTS.maxIdempotencyKeyLength)) {
      return refuse(new ConnectionError(400, `idempotencyKey must be text of 1 to ${DEFAULTS.maxIdempotencyKeyLength} characters`, 'idempotencyKey'));
    }
    let auth: Authorized;
    try { auth = await authorize(request); } catch (error) { return refuse(error as ConnectionError); }
    if (request.allowedModes && !request.allowedModes.includes(auth.capability.mode)) {
      return refuse(new ConnectionError(403, `This session may only read, and "${auth.capability.id}" changes things.`));
    }
    if (!withinDepth(depth, maxDepth)) return refuse(new ConnectionError(409, `This chain of calls is already ${maxDepth} deep, which is the limit.`));
    const inputs = validateFields(auth.capability.inputs, request.inputs);
    if (!inputs.ok) return refuse(new ConnectionError(400, inputs.error, inputs.field));

    const execute = async (): Promise<CallOutcome> => {
      if (approvalRequired(auth.capability, auth.grant.preApproved, request.caller.kind)) {
        const held = await record({ ...entryBase, inputs: inputs.value, result: 'awaiting-approval', status: 202, message: 'Waiting for approval' });
        await capabilityApprovalsDb.insert({
          id: held.id, caller: request.caller, targetBuildingId: auth.target.id, capabilityId: auth.capability.id, inputs: inputs.value, depth, chainId, state: 'pending', createdAt: iso(),
        });
        await deps.notify({
          kind: 'connection.awaiting_approval', projectId: auth.target.id,
          title: `Approval needed: ${auth.capability.id}`, description: `A call to "${auth.target.name}" is waiting for you to approve it in Connections.`,
        });
        return { status: 202, body: { callId: held.id, state: 'awaiting-approval' } };
      }
      try {
        const done = await runHandler(auth, request, inputs.value, depth);
        const entry = await record({ ...entryBase, inputs: inputs.value, result: 'ok', status: 200, message: null, runRef: done.runRef ?? null });
        return { status: 200, body: { callId: entry.id, state: 'done', outputs: done.outputs, ...(done.runRef ? { runRef: done.runRef } : {}) } };
      } catch (error) {
        return refuse(error as ConnectionError, true);
      }
    };

    if (typeof key !== 'string') return execute();
    const scope = `${request.caller.buildingId}|${auth.target.id}|${auth.capability.id}|${key}`;
    const fingerprint = stable(inputs.value);
    pruneSettledKeys();
    const kept = settledKeys.get(scope);
    if (kept) {
      if (kept.inputs !== fingerprint) return refuse(new ConnectionError(409, 'This idempotency key was already used with different inputs.', 'idempotencyKey'));
      return kept.held ? currentHeldOutcome(kept.promise) : kept.promise;
    }
    const entry = { inputs: fingerprint, settledAt: null as number | null, held: false, promise: Promise.resolve(undefined as unknown as CallOutcome) };
    entry.promise = execute().then(
      (outcome) => { entry.settledAt = now(); entry.held = outcome.status === 202; return outcome; },
      (error) => { settledKeys.delete(scope); throw error; },
    );
    settledKeys.set(scope, entry);
    return entry.promise;
  }

  /** Once no call is left waiting for a Building, its approval notification is done. */
  async function clearApprovalNoticeIfIdle(buildingId: string): Promise<void> {
    if (!(await capabilityApprovalsDb.find((a) => a.state === 'pending' && a.targetBuildingId === buildingId)).length) await deps.resolveApprovalNotice(buildingId);
  }

  /** Calls whose approval decision is being carried out right now. */
  const deciding = new Set<string>();

  async function decide(callId: string, decision: unknown): Promise<{ state: CapabilityApprovalRecord['state']; outcome?: CallOutcome }> {
    if (decision !== 'approve' && decision !== 'request-changes' && decision !== 'stop') throw new ConnectionError(400, 'decision must be approve, request-changes or stop', 'decision');
    const held = await capabilityApprovalsDb.get(callId);
    if (!held) throw new ConnectionError(404, 'Call not found');
    // Claimed before anything is awaited, so a second decision for the same call (a double click, another client) gets 409.
    if (held.state !== 'pending' || deciding.has(callId)) throw new ConnectionError(409, `This call was already ${held.state === 'pending' ? 'being decided' : held.state.replace('-', ' ')}.`);
    deciding.add(callId);
    try { return await decideClaimed(held, callId, decision); } finally { deciding.delete(callId); }
  }

  async function decideClaimed(held: CapabilityApprovalRecord, callId: string, decision: ApprovalDecision): Promise<{ state: CapabilityApprovalRecord['state']; outcome?: CallOutcome }> {
    const settle = async (state: CapabilityApprovalRecord['state'], result: ActivityResult, status: number, message: string | null, extra: Partial<ActivityRecord> = {}) => {
      await capabilityApprovalsDb.update(callId, { state });
      await activityLogDb.update(callId, { result, status, message, ...extra });
      await clearApprovalNoticeIfIdle(held.targetBuildingId);
      emitCall(callId);
    };
    if (decision === 'request-changes') { await settle('changes-requested', 'changes-requested', 409, 'A person asked for changes'); return { state: 'changes-requested' }; }
    if (decision === 'stop') { await settle('stopped', 'stopped', 409, 'A person stopped the call'); return { state: 'stopped' }; }
    const request: CallRequest = { caller: held.caller, targetBuildingId: held.targetBuildingId, capabilityId: held.capabilityId, inputs: held.inputs, depth: held.depth, chainId: held.chainId };
    let auth: Authorized;
    try { auth = await authorize(request); } catch (error) {
      const failure = error as ConnectionError;
      await settle('refused', 'refused', failure.status, failure.message);
      throw failure;
    }
    try {
      const done = await runHandler(auth, request, held.inputs, held.depth);
      await settle('approved', 'ok', 200, null, { runRef: done.runRef ?? null });
      return { state: 'approved', outcome: { status: 200, body: { callId, state: 'done', outputs: done.outputs, ...(done.runRef ? { runRef: done.runRef } : {}) } } };
    } catch (error) {
      const failure = error instanceof ConnectionError ? error : new ConnectionError(500, (error as Error).message);
      await settle('approved', resultOf(failure.status, true), failure.status, failure.message);
      throw failure;
    }
  }

  /** A scheduled job's call as the scheduler tracks it: a reference to the call, whose state `callState` reads back. */
  async function callFromJob(request: { buildingId: string; jobId: string; targetBuildingId: string; capabilityId: string; inputs: unknown; depth?: number; chainId?: string }): Promise<{ runId: string }> {
    try {
      const outcome = await call({
        caller: { kind: 'job', buildingId: request.buildingId, refId: request.jobId }, targetBuildingId: request.targetBuildingId, capabilityId: request.capabilityId,
        inputs: request.inputs, depth: request.depth ?? 1, chainId: request.chainId,
      });
      emitCall(outcome.body.callId);
      return { runId: `call:${outcome.body.callId}` };
    } catch (error) {
      throw new Error((error as Error).message);
    }
  }

  async function callState(runId: string): Promise<{ status: 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'stopped'; note: string | null } | null> {
    const entry = runId.startsWith('call:') ? await activityLogDb.get(runId.slice(5)) : undefined;
    if (!entry) return null;
    switch (entry.result) {
      case 'ok': return { status: 'succeeded', note: null };
      case 'awaiting-approval': return { status: 'awaiting-approval', note: 'Waiting for approval' };
      case 'changes-requested': return { status: 'stopped', note: entry.message };
      case 'stopped': return { status: 'stopped', note: entry.message };
      default: return { status: 'failed', note: entry.message };
    }
  }

  // ---- Event subscriptions, publishing and delivery ----

  async function createSubscription(body: unknown): Promise<EventSubscriptionRecord> {
    if (!isObject(body)) throw new ConnectionError(400, 'The subscription must be a JSON object', 'body');
    const { from: subscriber, to: source } = await sameTenantBuildings(body.subscriberBuildingId, body.sourceBuildingId);
    if (typeof body.eventId !== 'string' || !body.eventId) throw new ConnectionError(400, 'eventId is required', 'eventId');
    if (typeof body.jobId !== 'string' || !body.jobId) throw new ConnectionError(400, 'jobId is required', 'jobId');
    if (!typeOf(source)?.events.some((event) => event.id === body.eventId)) throw new ConnectionError(404, `"${source.name}" does not publish "${body.eventId}"`, 'eventId');
    const link = (await buildingLinksDb.find((l) => l.fromBuildingId === subscriber.id && l.toBuildingId === source.id))[0];
    if (!link) throw new ConnectionError(403, `"${subscriber.name}" is not linked to "${source.name}". Link them in Connections first.`);
    if (!link.events.includes(body.eventId)) throw new ConnectionError(403, `The link from "${subscriber.name}" to "${source.name}" does not grant the event "${body.eventId}".`);
    const job = await scheduledJobsDb.get(body.jobId);
    if (!job || job.projectId !== subscriber.id) throw new ConnectionError(404, 'That job does not exist in the subscribing Building', 'jobId');
    if ((await eventSubscriptionsDb.find((s) => s.subscriberBuildingId === subscriber.id && s.sourceBuildingId === source.id && s.eventId === body.eventId && s.jobId === job.id)).length) {
      throw new ConnectionError(409, 'This subscription already exists');
    }
    return eventSubscriptionsDb.insert({
      id: newId(), subscriberBuildingId: subscriber.id, sourceBuildingId: source.id, eventId: body.eventId, jobId: job.id,
      enabled: true, autoDisabled: false, recentDeliveries: [], createdAt: iso(),
    });
  }

  async function updateSubscription(id: string, body: unknown): Promise<EventSubscriptionRecord> {
    const subscription = await eventSubscriptionsDb.get(id);
    if (!subscription) throw new ConnectionError(404, 'Subscription not found');
    if (!isObject(body) || typeof body.enabled !== 'boolean') throw new ConnectionError(400, 'enabled must be true or false', 'enabled');
    return (await eventSubscriptionsDb.update(id, body.enabled ? { enabled: true, autoDisabled: false, recentDeliveries: [] } : { enabled: false }))!;
  }

  async function deleteSubscription(id: string): Promise<void> {
    if (!(await eventSubscriptionsDb.get(id))) throw new ConnectionError(404, 'Subscription not found');
    await removeSubscriptions((s) => s.id === id);
  }

  async function listSubscriptions(buildingId: string): Promise<EventSubscriptionRecord[]> {
    await requireBuilding(buildingId);
    return (await eventSubscriptionsDb.find((s) => s.subscriberBuildingId === buildingId || s.sourceBuildingId === buildingId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function publishEvent(request: { sourceBuildingId: string; eventId: string; payload?: unknown; depth?: number; chainId?: string }): Promise<{ eventPublicationId: string; queued: number }> {
    const source = await requireBuilding(request.sourceBuildingId);
    const event = typeOf(source)?.events.find((e) => e.id === request.eventId);
    if (!event) throw new ConnectionError(404, `"${source.name}" does not publish "${request.eventId}"`, 'eventId');
    const payload = validateFields(event.payload ?? [], request.payload);
    if (!payload.ok) throw new ConnectionError(400, payload.error, payload.field);
    const depth = request.depth ?? 0;
    const chainId = request.chainId ?? newId();
    const published = await record({
      kind: 'event', callerKind: 'event', callerBuildingId: source.id, callerRefId: null, targetBuildingId: source.id, name: event.id,
      inputs: payload.value, result: 'ok', status: 200, message: null, runRef: null, depth, chainId,
    });
    const queued = await serial(async () => {
      let count = 0;
      const subscriptions = (await eventSubscriptionsDb.find((s) => s.sourceBuildingId === source.id && s.eventId === event.id && s.enabled)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const subscription of subscriptions) {
        const link = (await buildingLinksDb.find((l) => l.fromBuildingId === subscription.subscriberBuildingId && l.toBuildingId === source.id))[0];
        if (!link?.events.includes(event.id)) continue;
        const recent = recentWithinHour(subscription.recentDeliveries, now());
        if (recent.length >= eventsPerHour) {
          await eventSubscriptionsDb.update(subscription.id, { enabled: false, autoDisabled: true, recentDeliveries: recent });
          await record({
            kind: 'event', callerKind: 'event', callerBuildingId: source.id, callerRefId: null, targetBuildingId: subscription.subscriberBuildingId, name: event.id,
            result: 'rate-limited', status: 429, message: `More than ${eventsPerHour} events in an hour; the subscription was turned off`, runRef: null, depth, chainId,
          });
          await deps.notify({
            kind: 'connection.subscription_disabled', projectId: subscription.subscriberBuildingId,
            title: `Subscription turned off: ${event.id}`, description: `"${source.name}" published more than ${eventsPerHour} "${event.id}" events in an hour, so the subscription was turned off. Switch it back on in Connections once the cause is fixed.`,
          });
          continue;
        }
        await eventSubscriptionsDb.update(subscription.id, { recentDeliveries: [...recent, now()] });
        await pendingEventsDb.insert({
          id: newId(), eventPublicationId: published.id, eventId: event.id, sourceBuildingId: source.id, subscriptionId: subscription.id,
          subscriberBuildingId: subscription.subscriberBuildingId, jobId: subscription.jobId, depth: depth + 1, chainId, status: 'pending', createdAt: iso(),
        });
        count += 1;
      }
      return count;
    });
    await deliverPending();
    return { eventPublicationId: published.id, queued };
  }

  /** Starts each waiting subscriber's job once. Safe to call at any time; a subscriber that is down keeps its events pending. */
  function deliverPending(): Promise<void> {
    return serial(async () => {
      const rows = (await pendingEventsDb.find((row) => row.status === 'pending')).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const row of rows) {
        const subscription = await eventSubscriptionsDb.get(row.subscriptionId);
        const entryBase = { kind: 'event' as const, callerKind: 'event' as const, callerBuildingId: row.sourceBuildingId, callerRefId: null, targetBuildingId: row.subscriberBuildingId, name: row.eventId, depth: row.depth, chainId: row.chainId };
        if (!subscription || !subscription.enabled) { await pendingEventsDb.update(row.id, { status: 'dropped' }); continue; }
        if (!withinDepth(row.depth, maxDepth)) {
          await record({ ...entryBase, result: 'refused', status: 409, message: `This chain is already ${maxDepth} deep, which is the limit.`, runRef: null });
          await pendingEventsDb.update(row.id, { status: 'dropped' });
          continue;
        }
        if (await deps.hasStarted(row.id)) { await pendingEventsDb.update(row.id, { status: 'delivered' }); continue; }
        let started: JobStartResult;
        try {
          started = await deps.startJob({ subscription, deliveryId: row.id, eventId: row.eventId, depth: row.depth, chainId: row.chainId });
        } catch (error) {
          if (error instanceof SubscriberUnavailableError) break;
          started = { state: 'failed', runId: null, note: (error as Error).message };
        }
        if (started.runId) await noteChainDepth(started.runId, row.depth, row.chainId, row.subscriberBuildingId);
        await record({
          ...entryBase, result: started.state === 'started' ? 'ok' : started.state === 'skipped' ? 'refused' : 'error', status: started.state === 'failed' ? 500 : 200,
          message: started.note, runRef: started.runId,
        });
        await pendingEventsDb.update(row.id, { status: 'delivered' });
      }
    });
  }

  // ---- Activity log ----

  async function activityFor(buildingId: string, query: Record<string, unknown>) {
    await requireBuilding(buildingId);
    const filter = parseActivityFilter(query);
    const rows = (await activityLogDb.find((e) => e.callerBuildingId === buildingId || e.targetBuildingId === buildingId))
      .filter((e) => (filter.caller === undefined || e.callerBuildingId === filter.caller)
        && (filter.capability === undefined || e.name === filter.capability)
        && (filter.result === undefined || e.result === filter.result)
        && (filter.from === undefined || Date.parse(e.at) >= filter.from)
        && (filter.to === undefined || Date.parse(e.at) <= filter.to))
      // Entries are stored in the order they happened, so a tie on the clock keeps the later one first.
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.at.localeCompare(a.entry.at) || b.index - a.index)
      .slice(0, filter.limit)
      .map(({ entry }) => entry);
    const names = new Map<string, string | null>();
    const nameOf = async (id: string) => {
      if (!names.has(id)) names.set(id, (await getProject(id))?.name ?? null);
      return names.get(id)!;
    };
    const entries = await Promise.all(rows.map(async (e) => ({
      ...e,
      callerName: await nameOf(e.callerBuildingId) ?? 'Building deleted',
      targetName: await nameOf(e.targetBuildingId) ?? 'Building deleted',
      role: e.callerBuildingId === buildingId && e.targetBuildingId !== buildingId ? 'caller' : e.targetBuildingId === buildingId && e.callerBuildingId !== buildingId ? 'target' : 'self',
    })));
    return { entries };
  }

  // ---- Sessions ----

  async function offersFor(buildingId: string, session: SessionKind): Promise<ToolOffer[]> {
    const links = await buildingLinksDb.find((link) => link.fromBuildingId === buildingId);
    const projects = new Map<string, ProjectRecord | undefined>();
    for (const link of links) projects.set(link.toBuildingId, await getProject(link.toBuildingId));
    return toolOffers(session, links, (id) => { const project = projects.get(id); return project ? typeOf(project) : undefined; });
  }

  async function hasOutgoingLinks(buildingId: string): Promise<boolean> {
    return (await buildingLinksDb.find((link) => link.fromBuildingId === buildingId)).length > 0;
  }

  // ---- Building deletion ----

  async function removeBuilding(buildingId: string): Promise<void> {
    for (const link of await buildingLinksDb.find((l) => l.fromBuildingId === buildingId || l.toBuildingId === buildingId)) await buildingLinksDb.delete(link.id);
    await removeSubscriptions((s) => s.subscriberBuildingId === buildingId || s.sourceBuildingId === buildingId);
    for (const row of await chainDepthsDb.find((r) => r.buildingId === buildingId)) await chainDepthsDb.delete(row.id);
    for (const row of await pendingEventsDb.find((p) => p.subscriberBuildingId === buildingId || p.sourceBuildingId === buildingId)) await pendingEventsDb.delete(row.id);
    for (const held of await capabilityApprovalsDb.find((a) => a.state === 'pending' && (a.targetBuildingId === buildingId || a.caller.buildingId === buildingId))) {
      await capabilityApprovalsDb.update(held.id, { state: 'stopped' });
      await activityLogDb.update(held.id, { result: 'stopped', status: 409, message: 'A Building in this call was deleted' });
      await clearApprovalNoticeIfIdle(held.targetBuildingId);
      emitCall(held.id);
    }
  }

  return {
    createLink, updateLink, deleteLink, listLinks, listAllLinks, migrateLinkGrantsOnStartup,
    call, decide, callFromJob, callState, onCallChanged,
    createSubscription, updateSubscription, deleteSubscription, listSubscriptions, publishEvent, deliverPending,
    activityFor, offersFor, hasOutgoingLinks, removeBuilding,
  };
}

export type Connections = ReturnType<typeof createConnections>;
