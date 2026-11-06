import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { projectsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { BulkStore, StorageCrashError, StorageOpError } from './bulkClient.ts';
import type { OpenOutcome, Progress } from './bulkClient.ts';
import type { RetentionPlan, StorageSpec } from './contract.ts';
import { describeRetention } from './retention.ts';
import { getBuildingType } from './registry.ts';
import { buildingDir, SecretsStore } from './secrets.ts';
import { DEFAULT_WARNING_BYTES, storageLevel } from './storageStatus.ts';
import './types/index.ts';

export class NoStorageError extends Error {
  constructor(typeName: string) {
    super(`${typeName} Buildings have no bulk data storage`);
    this.name = 'NoStorageError';
  }
}

/** Ingestion for this Building was stopped by a storage error and must be resumed by the person. */
export class IngestionStoppedError extends Error {
  readonly status = 409;
  constructor(reason: string) {
    super(`Ingestion is stopped for this Building: ${reason}`);
    this.name = 'IngestionStoppedError';
  }
}

/** A row the table's unique key (or another constraint) refuses: the caller's data, not a storage fault. */
export class RowConflictError extends Error {
  readonly status = 409;
  constructor(detail: string) {
    super(`Row refused by the table: ${detail}`);
    this.name = 'RowConflictError';
  }
}

/** Only these mean the disk or file is unhealthy; anything else a write throws is about the data sent. */
const STORAGE_FAULT = /^SQLITE_(FULL|IOERR|READONLY|CORRUPT|CANTOPEN|NOTADB|NOMEM)/;
export const isStorageFault = (error: StorageOpError) => error.status === undefined && STORAGE_FAULT.test(error.code ?? '');

/** Turns a failed write into the right error: a storage fault stops ingestion, a constraint is a 409, the rest passes through. */
async function classifyWriteError(project: ProjectRecord, error: unknown): Promise<unknown> {
  if (!(error instanceof StorageOpError)) return error;
  if (isStorageFault(error)) return new IngestionStoppedError(await stopIngestion(project, error));
  if (error.status === undefined && error.code?.startsWith('SQLITE_CONSTRAINT')) return new RowConflictError(error.message);
  return error;
}

const stores = new Map<string, Promise<BulkStore>>();
const faultInjection = () => process.env.AGENT_VISUAL_OS_TEST_FAULTS === '1';

export function storageSpecOf(project: Pick<ProjectRecord, 'typeId'>): StorageSpec | undefined {
  return getBuildingType(project.typeId ?? 'software')?.storage;
}

const dbFile = (id: string) => path.join(buildingDir(id), 'bulk.sqlite');
const backupDir = (id: string) => path.join(buildingDir(id), 'backups');

/** Applies what opening the database found (a migration ran, failed, or the data is newer than the code) to the Building's record. */
async function recordOpenOutcome(project: ProjectRecord, outcome: OpenOutcome, targetVersion: number): Promise<void> {
  const patch: Partial<ProjectRecord> = {};
  if (outcome.status === 'failed') patch.readOnlyReason = `Migration to version ${targetVersion} failed and was rolled back from backup: ${outcome.error}`;
  else if (outcome.status === 'newer') patch.readOnlyReason = `This Building's data is at version ${outcome.version}, newer than the version ${targetVersion} this app supports.`;
  else {
    patch.typeVersion = outcome.version;
    if (project.readOnlyReason) patch.readOnlyReason = null;
  }
  if (outcome.backupFile) patch.lastBackup = { file: outcome.backupFile, at: new Date().toISOString(), reason: 'migration' };
  await projectsDb.update(project.id, { ...patch, updatedAt: new Date().toISOString() });
}

/** The Building's database, opened (and migrated, with a backup first) on first use. */
export function getStore(project: ProjectRecord): Promise<BulkStore> {
  let pending = stores.get(project.id);
  if (!pending) {
    pending = (async () => {
      const type = getBuildingType(project.typeId ?? 'software');
      if (!type?.storage) throw new NoStorageError(type?.name ?? 'This');
      const store = new BulkStore({ file: dbFile(project.id), spec: type.storage, version: type.version, backupDir: backupDir(project.id), faultInjection: faultInjection() });
      await recordOpenOutcome(project, await store.open(), type.version);
      return store;
    })();
    stores.set(project.id, pending);
    pending.catch(() => stores.delete(project.id));
  }
  return pending;
}

export async function closeStore(buildingId: string): Promise<void> {
  const pending = stores.get(buildingId);
  stores.delete(buildingId);
  if (pending) await (await pending.catch(() => null))?.close();
}

/** Closes a Building's database and removes everything stored for it. A failed cleanup is logged and never blocks deletion. */
export async function deleteBuildingData(buildingId: string, remove: typeof rm = rm): Promise<void> {
  try {
    const typeId = (await projectsDb.get(buildingId))?.typeId;
    await (typeId ? getBuildingType(typeId)?.onDeleting?.(buildingId) : undefined);
  } catch (error) {
    console.error(`Couldn't stop the background work of building ${buildingId}:`, error);
  }
  try {
    await closeStore(buildingId);
    await remove(buildingDir(buildingId), { recursive: true, force: true });
  } catch (error) {
    console.error(`Couldn't delete the stored data of building ${buildingId}:`, error);
  }
}

export async function storageBytes(buildingId: string): Promise<number> {
  const sizes = await Promise.all(['', '-wal', '-shm'].map((suffix) => stat(dbFile(buildingId) + suffix).then((s) => s.size, () => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}

export interface StorageStatus {
  bytes: number;
  warningBytes: number;
  level: 'ok' | 'warning';
  retention: { rule: NonNullable<StorageSpec['retention']> | null; description: string };
  lastBackup: ProjectRecord['lastBackup'];
  readOnlyReason: string | null;
  ingestionStoppedReason: string | null;
  secrets: Array<{ key: string; hasSecret: true }>;
}

export async function getStorageStatus(project: ProjectRecord): Promise<StorageStatus> {
  const spec = storageSpecOf(project);
  await getStore(project);
  const bytes = await storageBytes(project.id);
  const warningBytes = project.storageWarningBytes ?? DEFAULT_WARNING_BYTES;
  return {
    bytes,
    warningBytes,
    level: storageLevel(bytes, warningBytes),
    retention: { rule: spec?.retention ?? null, description: describeRetention(spec?.retention) },
    lastBackup: project.lastBackup ?? null,
    readOnlyReason: project.readOnlyReason ?? null,
    ingestionStoppedReason: project.ingestionStoppedReason ?? null,
    secrets: await new SecretsStore(project.id).list(),
  };
}

/** Raises the size warning once per crossing, and clears it when the size drops back under the threshold. */
export async function checkStorageThreshold(buildingId: string): Promise<void> {
  const project = await projectsDb.get(buildingId);
  if (!project) return;
  const level = storageLevel(await storageBytes(buildingId), project.storageWarningBytes ?? DEFAULT_WARNING_BYTES);
  const subject = { type: 'project', projectId: buildingId } as const;
  if (level === 'warning' && !project.storageWarned) {
    await projectsDb.update(buildingId, { storageWarned: true });
    await raiseNotification({ kind: 'storage.problem', subject, title: `${project.name}: storage is over its warning size`, description: 'The Building\'s data has grown past its warning threshold. Review the retention rule or raise the threshold in Settings.' });
  } else if (level === 'ok' && project.storageWarned) {
    await projectsDb.update(buildingId, { storageWarned: false });
    await resolveNotifications(subject, ['storage.problem']);
  }
}

/** Stops ingestion for just this Building and tells the person; the data already written stays valid. */
async function stopIngestion(project: ProjectRecord, error: StorageOpError): Promise<string> {
  const reason = error.code === 'SQLITE_FULL' ? 'the disk is full' : error.message;
  await projectsDb.update(project.id, { ingestionStoppedReason: reason, updatedAt: new Date().toISOString() });
  await raiseNotification({ kind: 'storage.problem', subject: { type: 'project', projectId: project.id }, title: `${project.name}: storage error`, description: `Ingestion was stopped because ${reason}. Existing data is intact.` });
  return reason;
}

/** Runs a write against the Building's store; a disk-full or other write error stops ingestion for that Building only. */
export async function guardedWrite<T>(project: ProjectRecord, write: (store: BulkStore) => Promise<T>): Promise<T> {
  const current = (await projectsDb.get(project.id)) ?? project;
  if (current.ingestionStoppedReason) throw new IngestionStoppedError(current.ingestionStoppedReason);
  try {
    const result = await write(await getStore(project));
    void checkStorageThreshold(project.id).catch(() => undefined);
    return result;
  } catch (error) {
    throw await classifyWriteError(project, error);
  }
}

export async function resumeIngestion(buildingId: string): Promise<void> {
  await projectsDb.update(buildingId, { ingestionStoppedReason: null, updatedAt: new Date().toISOString() });
  await resolveNotifications({ type: 'project', projectId: buildingId }, ['storage.problem']);
}

export type JobStatus = 'running' | 'done' | 'cancelled' | 'failed';
export interface StorageJob {
  id: string;
  buildingId: string;
  kind: 'ingest' | 'retention';
  status: JobStatus;
  done: number;
  total: number;
  /** 'indexing' while a large load builds its indexes after the last row. */
  phase?: 'indexing';
  result?: unknown;
  error?: string;
  startedAt: string;
}

const jobs = new Map<string, { job: StorageJob; cancel: () => void; payload: string }>();
const FINISHED_JOBS_KEPT = 20;

/** Keeps the newest finished jobs of a Building; running ones are never dropped. */
function pruneFinishedJobs(buildingId: string): void {
  const finished = [...jobs.entries()].filter(([, e]) => e.job.buildingId === buildingId && e.job.status !== 'running');
  for (const [id] of finished.slice(0, Math.max(0, finished.length - FINISHED_JOBS_KEPT))) jobs.delete(id);
}

export function getJob(buildingId: string, jobId: string): StorageJob | undefined {
  const entry = jobs.get(jobId);
  return entry?.job.buildingId === buildingId ? entry.job : undefined;
}

/** Cancel stops the job between batches; returns false for an unknown or already finished job. */
export function cancelJob(buildingId: string, jobId: string): boolean {
  const entry = jobs.get(jobId);
  if (!entry || entry.job.buildingId !== buildingId || entry.job.status !== 'running') return false;
  entry.cancel();
  return true;
}

function runningEntryFor(buildingId: string, kind: StorageJob['kind']) {
  return [...jobs.values()].find((e) => e.job.buildingId === buildingId && e.job.kind === kind && e.job.status === 'running');
}

/** Whether a storage job of this kind is running for the Building. */
export function isJobRunning(buildingId: string, kind: StorageJob['kind']): boolean {
  return runningEntryFor(buildingId, kind) !== undefined;
}

/** A job of this kind is already running with different parameters; the caller must wait or cancel it. */
export class JobConflictError extends Error {
  readonly status = 409;
  constructor(kind: string) {
    super(`A ${kind} job is already running for this Building with different settings. Wait for it or cancel it first.`);
    this.name = 'JobConflictError';
  }
}

/** Starts a long operation off the request path. Returns at once; poll `getJob` for progress and the result. */
export async function startStorageJob(project: ProjectRecord, kind: StorageJob['kind'], op: string, payload: object): Promise<StorageJob> {
  // The start time differs on every call and is not a setting.
  const encoded = JSON.stringify(payload, (key, value) => (key === 'now' ? undefined : value));
  const running = runningEntryFor(project.id, kind);
  if (running) {
    if (running.payload !== encoded) throw new JobConflictError(kind);
    return running.job;
  }
  const store = await getStore(project);
  if (kind === 'ingest') {
    const current = (await projectsDb.get(project.id)) ?? project;
    if (current.ingestionStoppedReason) throw new IngestionStoppedError(current.ingestionStoppedReason);
  }
  const job: StorageJob = { id: randomUUID(), buildingId: project.id, kind, status: 'running', done: 0, total: 0, startedAt: new Date().toISOString() };
  const onProgress = (p: Progress) => { job.done = p.done; job.total = p.total; job.phase = p.phase; };
  const handle = store.startJob<{ cancelled: boolean }>(op, payload, onProgress);
  jobs.set(job.id, { job, cancel: handle.cancel, payload: encoded });
  pruneFinishedJobs(project.id);
  handle.result.then(
    (result) => {
      job.result = result;
      job.status = result.cancelled ? 'cancelled' : 'done';
      void checkStorageThreshold(project.id).catch(() => undefined);
    },
    async (error: Error) => {
      job.status = 'failed';
      job.error = error.message;
      if (kind === 'ingest' && error instanceof StorageOpError && isStorageFault(error)) await stopIngestion(project, error).catch(() => undefined);
      if (error instanceof StorageCrashError) stores.delete(project.id);
    },
  );
  return job;
}

/** Exports the Building's data as a standalone SQLite file. */
export async function exportBuilding(project: ProjectRecord): Promise<string> {
  const dest = path.join(buildingDir(project.id), 'exports', `${project.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  await (await getStore(project)).backup(dest);
  await projectsDb.update(project.id, { lastBackup: { file: dest, at: new Date().toISOString(), reason: 'export' } });
  return dest;
}

/** Opens every Building that has storage, so pending migrations run (with their backups) at startup rather than on first click. */
export async function migrateAllBuildings(): Promise<void> {
  for (const project of await projectsDb.all()) {
    if (!storageSpecOf(project)) continue;
    await getStore(project).catch((error) => console.error(`Couldn't open the storage of ${project.name}:`, error));
  }
}

/** Whether retention may discard now for this Building, and the window to use; types without a plan always run the rule as declared. */
export async function retentionPlanFor(project: ProjectRecord): Promise<RetentionPlan> {
  return (await getBuildingType(project.typeId ?? 'software')?.retentionPlan?.(project.id)) ?? { allowed: true };
}

/** Retention and size checks for every Building with storage; the platform timer and tests both call this. */
export async function runScheduledMaintenance(now: Date = new Date()): Promise<void> {
  for (const project of await projectsDb.all()) {
    const spec = storageSpecOf(project);
    if (!spec || project.readOnlyReason) continue;
    try {
      if (spec.retention) {
        const plan = await retentionPlanFor(project);
        if (plan.allowed) await startStorageJob(project, 'retention', 'retention', { now: now.toISOString(), months: plan.months });
      }
      await checkStorageThreshold(project.id);
    } catch (error) {
      console.error(`Scheduled maintenance failed for ${project.name}:`, error);
    }
  }
}

export function startStorageMaintenance(intervalMs = 6 * 60 * 60_000, clock: () => Date = () => new Date()): () => void {
  const timer = setInterval(() => void runScheduledMaintenance(clock()), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function closeAllStores(): Promise<void> {
  await Promise.all([...stores.keys()].map(closeStore));
}
