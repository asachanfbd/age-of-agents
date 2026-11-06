import { randomUUID } from 'node:crypto';
import { getStore, guardedWrite } from '../buildings/buildingStorage.ts';
import { assertWritable } from '../buildings/normalize.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { seoDeps } from './deps.ts';
import { SeoInputError } from './errors.ts';
import type { ProposalRow } from './proposalRules.ts';
import { resolveNewLink } from './taskLinks.ts';
import type { HandoffState, LinkSnapshot, ManualFields, Owner } from './taskRules.ts';
import { parseManualCreate } from './taskRules.ts';
import type { TaskRowStored } from './taskTables.ts';

export const AGENT_SLOTS = ['research', 'clustering', 'title-meta', 'content', 'audit'] as const;
export type AgentSlot = (typeof AGENT_SLOTS)[number];

/** The workflow slot each kind of agent task runs; the Catalog decides which workflow fills it. */
export const SLOT_IDS: Record<AgentSlot, string> = {
  research: 'seo-keyword-research', clustering: 'seo-keyword-clustering', 'title-meta': 'seo-title-meta', content: 'seo-content', audit: 'seo-audit',
};
/** Slots whose run ends at approval because they propose changes to the site. */
export const PROPOSING_SLOTS: readonly AgentSlot[] = ['title-meta', 'content', 'audit'];

export interface ManualRecord extends ManualFields {
  id: string;
  source: 'manual';
  owner: Owner;
  createdBy: 'person' | 'agent';
  link: LinkSnapshot | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** The agent task this task was made from (a follow-up or a handoff fallback). */
  fromAgentTaskId: string | null;
  /** The downloadable proposal a handoff fallback task carries. */
  csv: string | null;
}

export interface HandoffRecord {
  path: 'software' | 'manual';
  state: HandoffState;
  targetBuildingId: string | null;
  targetName: string | null;
  callId: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  error: string | null;
  manualTaskId: string | null;
  /** The manual task left behind to publish the changes once the planning session has applied them. */
  followUpTaskId: string | null;
  at: string;
}

export interface AgentInputs {
  pages: string[];
  competitors: string[];
  /** Keywords a clustering run sent, so the answer is applied against exactly those. */
  sentKeys: string[];
  /** The title and meta description each selected page had when the run started. */
  current: Record<string, { title: string; meta: string }>;
}

export interface AgentRecord {
  id: string;
  source: 'agent';
  slot: AgentSlot;
  title: string;
  createdAt: string;
  updatedAt: string;
  inputs: AgentInputs;
  links: LinkSnapshot[];
  runId: string | null;
  planItemId: string | null;
  startError: string | null;
  proposal: ProposalRow[] | null;
  proposalError: string | null;
  /** Rows the agent returned that were unusable. */
  proposalSkipped: number;
  /** A research or clustering answer was applied to the Keywords tab. */
  ingested: boolean;
  resultNote: string | null;
  approvedAt: string | null;
  handoff: HandoffRecord | null;
}

export type TaskRecord = ManualRecord | AgentRecord;

const toRow = (record: TaskRecord): TaskRowStored => ({ uid: record.id, source: record.source, updatedAt: record.updatedAt, data: JSON.stringify(record) });
const rowArray = (row: TaskRowStored): string[] => [row.uid, row.source, row.updatedAt, row.data];

const locks = new Map<string, Promise<unknown>>();

/** One change to a Building's tasks at a time, so an edit and a finishing run never overwrite each other. */
export function withTaskLock<T>(buildingId: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(buildingId) ?? Promise.resolve()).then(work, work);
  locks.set(buildingId, next.catch(() => undefined));
  return next;
}

export function forgetTasks(buildingId: string): void {
  locks.delete(buildingId);
}

export async function readTasks(project: ProjectRecord): Promise<TaskRecord[]> {
  const store = await getStore(project);
  const { rows } = await store.groupSums({ source: 'seo_tasks', groupBy: ['uid', 'source', 'updatedAt', 'data'] });
  return rows.map((r) => JSON.parse(String(r.data)) as TaskRecord);
}

export async function readTask(project: ProjectRecord, id: string): Promise<TaskRecord | null> {
  const store = await getStore(project);
  const { rows } = await store.groupSums({ source: 'seo_tasks', groupBy: ['uid', 'data'], where: { uid: id }, limit: 1 });
  return rows[0] ? (JSON.parse(String(rows[0].data)) as TaskRecord) : null;
}

export async function saveTask(project: ProjectRecord, record: TaskRecord): Promise<TaskRecord> {
  const stamped = { ...record, updatedAt: seoDeps().now().toISOString() } as TaskRecord;
  await guardedWrite(project, (store) => store.replaceRows([{ table: 'seo_tasks', where: { uid: stamped.id }, rows: [rowArray(toRow(stamped))] }]));
  return stamped;
}

export async function removeTask(project: ProjectRecord, id: string): Promise<void> {
  await guardedWrite(project, (store) => store.replaceRows([{ table: 'seo_tasks', where: { uid: id }, rows: [] }]));
}

export interface ManualOrigin { /** The caller already holds the task lock. */ locked?: boolean; createdBy: 'person' | 'agent'; fromAgentTaskId?: string | null; csv?: string | null; link?: LinkSnapshot | null }

/** Builds and stores a manual task from a validated body. Fields only an agent or the handoff may set come through `origin`. */
export async function createManualRecord(project: ProjectRecord, body: unknown, origin: ManualOrigin = { createdBy: 'person' }): Promise<ManualRecord> {
  assertWritable(project);
  const input = parseManualCreate(body);
  const link = origin.link ?? (input.link ? await resolveNewLink(project, input.link) : null);
  const now = seoDeps().now().toISOString();
  const { link: _ignored, ...fields } = input;
  if (origin.createdBy === 'agent' && fields.status === 'done') throw new SeoInputError('an agent cannot mark a task done');
  const record: ManualRecord = {
    ...fields, id: randomUUID(), source: 'manual', owner: origin.createdBy === 'agent' ? 'agent' : 'me', createdBy: origin.createdBy, link,
    createdAt: now, updatedAt: now, completedAt: fields.status === 'done' ? now : null, fromAgentTaskId: origin.fromAgentTaskId ?? null, csv: origin.csv ?? null,
  };
  const save = async () => (await saveTask(project, record)) as ManualRecord;
  return origin.locked ? save() : withTaskLock(project.id, save);
}
