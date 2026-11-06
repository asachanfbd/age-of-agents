/** The stored shapes of cross-Building connections (docs/connections.md): links, event subscriptions, the event outbox and the Activity log. */

/** Every Building belongs to the one local tenant today; the check that keeps tenants apart still runs on every call. */
export const LOCAL_TENANT = 'local';

export interface LinkGrant {
  capabilityId: string;
  /** A scheduled job may run this approval-requiring capability without asking each time. Only a person sets it. */
  preApproved: boolean;
}

/** `fromBuildingId` may use the listed capabilities and events of `toBuildingId`, and nothing in the other direction. */
export interface BuildingLinkRecord {
  id: string;
  fromBuildingId: string;
  toBuildingId: string;
  capabilities: LinkGrant[];
  events: string[];
  /** The last default-on capability set (`grantsMigration.ts`) this link has been brought to. Absent on links from before it existed, which read as 0. */
  grantsVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventSubscriptionRecord {
  id: string;
  /** The Building that starts a job when the event happens. */
  subscriberBuildingId: string;
  sourceBuildingId: string;
  eventId: string;
  /** The subscriber's scheduled job the event starts. */
  jobId: string;
  enabled: boolean;
  /** Turned off by the hourly rate limit, not by a person. */
  autoDisabled: boolean;
  /** Delivery times (ms) inside the current rate-limit window. */
  recentDeliveries: number[];
  createdAt: string;
}

/** One event waiting to start one subscriber's job. Kept until delivered so a subscriber that is down gets it once on return. */
export interface PendingEventRecord {
  /** Doubles as the delivery id: stamped on the job start so a retry never starts a second run. */
  id: string;
  eventPublicationId: string;
  eventId: string;
  sourceBuildingId: string;
  subscriptionId: string;
  subscriberBuildingId: string;
  jobId: string;
  depth: number;
  chainId: string;
  status: 'pending' | 'delivered' | 'dropped';
  createdAt: string;
}

export type CallerKind = 'person' | 'job' | 'step' | 'agent' | 'event';

export interface CallerRef {
  kind: CallerKind;
  buildingId: string;
  /** The job, run or task making the call. */
  refId?: string;
}

export type ActivityResult = 'ok' | 'error' | 'refused' | 'awaiting-approval' | 'changes-requested' | 'stopped' | 'rate-limited';

export interface ActivityRecord {
  id: string;
  at: string;
  kind: 'call' | 'event';
  callerKind: CallerKind;
  callerBuildingId: string;
  callerRefId: string | null;
  /** The Building a call goes to, or the Building an event comes from. */
  targetBuildingId: string;
  /** Capability id for a call; event id for an event. */
  name: string;
  inputsSummary: string;
  inputsShortened: boolean;
  result: ActivityResult;
  /** The HTTP status the call answered with. */
  status: number;
  message: string | null;
  runRef: string | null;
  depth: number;
  chainId: string;
}

/** A write call held for a person's decision. The id is the Activity entry's. */
export interface CapabilityApprovalRecord {
  id: string;
  caller: CallerRef;
  targetBuildingId: string;
  capabilityId: string;
  inputs: Record<string, unknown>;
  depth: number;
  chainId: string;
  state: 'pending' | 'deciding' | 'approved' | 'refused' | 'changes-requested' | 'stopped';
  createdAt: string;
}

/** How deep the chain of calls is for a run or task that a capability or event started. */
export interface ChainDepthRecord {
  id: string;
  depth: number;
  chainId: string;
  /** The Building the run belongs to, so deleting it removes the row. Absent on rows from before this field. */
  buildingId?: string;
  createdAt?: string;
}
