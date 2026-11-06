import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeProject } from '../buildings/normalize.ts';
import { getBuildingType } from '../buildings/registry.ts';
import { buildingDir, SecretsStore } from '../buildings/secrets.ts';
import { planItemsDb, projectsDb, workflowRunsDb } from '../db/collections.ts';
import type { ProjectRecord, WorkflowRunRecord } from '../domain/types.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { createCrmAgent } from './crmAgent.ts';
import type { BuildingPeek, BuildingReader, BuildingTaskReader, CrmCtx, CrmDeps, WorkTask } from './context.ts';
import { openCrmDb, readSettings, writeSettings } from './db.ts';
import type { Db } from './db.ts';
import { tick } from './engine.ts';
import { smtpTransport } from './smtpClient.ts';
import { summaryFor } from './customers.ts';
import { postFinished, postStarted } from './workUpdates.ts';

const crmFile = (buildingId: string) => path.join(buildingDir(buildingId), 'crm.sqlite');

const open = new Map<string, Db>();
/** The Building's CRM database, opened on first use. It lives in the Building's folder, so deleting the Building deletes it. */
function crmDbFor(buildingId: string): Db {
  let db = open.get(buildingId);
  if (!db) { db = openCrmDb(crmFile(buildingId)); open.set(buildingId, db); }
  return db;
}
function closeCrmDb(buildingId: string): void {
  open.get(buildingId)?.close();
  open.delete(buildingId);
}

const subject = (buildingId: string) => ({ type: 'project', projectId: buildingId }) as const;

/** Reads another Building's basics, and a short summary through the read capability the other type already offers. */
export const daemonBuildings: BuildingReader = {
  async list() {
    return (await projectsDb.find(() => true)).map((p) => ({ id: p.id, name: p.name, typeId: p.typeId ?? 'software', status: p.status }));
  },
  async peek(id): Promise<BuildingPeek> {
    const project = await projectsDb.get(id);
    if (!project) return { state: 'unavailable' };
    const view = normalizeProject(project);
    if (view.typeUnavailable) return { state: 'unavailable' };
    const base = { name: project.name, typeId: view.typeId, status: view.readOnly ? 'read-only' : project.status };
    const type = getBuildingType(view.typeId);
    const capId = view.typeId === 'seo' ? 'get-latest-report' : view.typeId === 'software' ? 'get-open-tasks' : null;
    const cap = capId ? type?.capabilities.find((c) => c.id === capId && c.mode === 'read') : undefined;
    if (!cap?.handle) return { state: 'ok', ...base, summary: null };
    try {
      const { outputs } = await cap.handle({ buildingId: id, callerBuildingId: 'crm', depth: 1, noteStarted: async () => undefined }, {});
      const summary = view.typeId === 'seo'
        ? (outputs.found ? summaryFor('seo', { latestReport: { savedAt: String(outputs.savedAt ?? ''), name: String(outputs.period ?? 'saved report') } }) : 'No report saved yet')
        : summaryFor('software', { openTasks: Array.isArray(outputs.tasks) ? outputs.tasks.length : null });
      return { state: 'ok', ...base, summary };
    } catch (e) {
      return { state: 'read_failed', reason: e instanceof Error ? e.message : 'The read failed' };
    }
  },
};

const epochMs = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

async function workTaskOf(run: WorkflowRunRecord, startedAt: number | null): Promise<WorkTask> {
  const item = await planItemsDb.get(run.planItemId);
  return { planItemId: run.planItemId, title: item?.title ?? null, runSummary: run.completionReport, startedAt, finishedAt: epochMs(run.completedAt) };
}

/** Testing-setup and PR-conflict runs are housekeeping, not customer work; live posting and backfill both skip them. */
const isCustomerWorkRun = (run: WorkflowRunRecord): boolean => !run.prConflict && !run.testingSetup;

/** Tasks (plan items) on a Building with a completed run; a task run more than once counts once, by its latest completion. */
export const daemonTasks: BuildingTaskReader = {
  async finishedSince(buildingId, sinceMs) {
    const runs = await workflowRunsDb.find((r) => r.projectId === buildingId && r.status === 'completed' && isCustomerWorkRun(r) && (epochMs(r.completedAt) ?? 0) >= sinceMs);
    const latest = new Map<string, WorkflowRunRecord>();
    for (const r of runs) if ((epochMs(r.completedAt) ?? 0) >= (epochMs(latest.get(r.planItemId)?.completedAt) ?? 0)) latest.set(r.planItemId, r);
    return Promise.all([...latest.values()].map((r) => workTaskOf(r, null)));
  },
};

interface Overrides { now?: () => number; deps?: Partial<CrmDeps> }
let overrides: Overrides = {};
/** Test seam: an injected clock and fake SMTP, agent and Building reader. */
export function setCrmOverrides(next: Overrides): void { overrides = next; cache.clear(); }

const cache = new Map<string, CrmCtx>();
const queues = new Map<string, Promise<unknown>>();

export function crmFilesDir(buildingId: string): string { return path.join(buildingDir(buildingId), 'crm-files'); }

async function buildCtx(project: ProjectRecord): Promise<CrmCtx> {
  const id = project.id;
  const db = crmDbFor(id);
  const secrets = new SecretsStore(id);
  let settings = readSettings(db, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const deps: CrmDeps = {
    transport: smtpTransport,
    agent: createCrmAgent(() => id, async () => { await mkdir(crmFilesDir(id), { recursive: true }); return crmFilesDir(id); }),
    buildings: daemonBuildings,
    tasks: daemonTasks,
    notifyAttention: (buildingId, reason) => {
      void raiseNotification({ kind: 'crm.connection_needs_attention', subject: subject(buildingId), title: `${project.name}: Email needs attention`, description: reason }).catch(() => undefined);
    },
    resolveAttention: (buildingId) => { void resolveNotifications(subject(buildingId), ['crm.connection_needs_attention']).catch(() => undefined); },
    ...overrides.deps,
  };
  return {
    db, buildingId: id, now: overrides.now ?? Date.now, deps,
    secrets: { get: (k) => secrets.get(k), set: (k, v) => secrets.set(k, v), delete: (k) => secrets.delete(k) },
    filesDir: crmFilesDir(id),
    settings: () => settings,
    saveSettings: (next) => { settings = next; writeSettings(db, next); },
    exclusive: <T>(work: () => Promise<T>) => {
      const run = (queues.get(id) ?? Promise.resolve()).then(work, work);
      queues.set(id, run.catch(() => undefined));
      return run;
    },
  };
}

export async function crmCtx(project: ProjectRecord): Promise<CrmCtx> {
  let ctx = cache.get(project.id);
  if (!ctx) { ctx = await buildCtx(project); cache.set(project.id, ctx); }
  return ctx;
}

/** Stops using a Building's database (it is about to be deleted). */
export function forgetCrm(buildingId: string): void {
  cache.delete(buildingId);
  queues.delete(buildingId);
  closeCrmDb(buildingId);
}

/** Advances time-driven work for every writable CRM Building; one Building's failure never stops the others. */
export async function tickAll(): Promise<void> {
  for (const project of await projectsDb.find((p) => p.typeId === 'crm')) {
    if (normalizeProject(project).readOnly) continue;
    try { const ctx = await crmCtx(project); await ctx.exclusive(() => tick(ctx)); } catch (e) { console.error(`CRM tick failed for ${project.id}:`, e); }
  }
}

export const TICK_INTERVAL_MS = 60_000;
/** Starts the minute timer. The timer is unref'd and the returned function stops it. */
export function startCrmTicker(): () => void {
  const timer = setInterval(() => { void tickAll(); }, TICK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Posts the start or finish of a task run on a Building to every writable CRM Building where a customer has it attached.
 * "Started" is posted only for the first run of a task, so a retry or resume never posts a second one.
 * Failures are logged and never reach the run.
 */
export async function recordRunWork(run: WorkflowRunRecord): Promise<void> {
  if (run.status !== 'running' && run.status !== 'completed') return;
  if (!isCustomerWorkRun(run)) return;
  try {
    const building = await projectsDb.get(run.projectId);
    if (!building || building.typeId === 'crm') return;
    const target = { buildingId: building.id, buildingName: building.name };
    const earlier = await workflowRunsDb.find((r) => r.planItemId === run.planItemId && r.id !== run.id && r.createdAt < run.createdAt);
    const task = await workTaskOf(run, earlier.length ? null : epochMs(run.createdAt));
    for (const crm of await projectsDb.find((p) => p.typeId === 'crm')) {
      if (normalizeProject(crm).readOnly) continue;
      try {
        const ctx = await crmCtx(crm);
        if (run.status === 'running') postStarted(ctx, target, task);
        else await postFinished(ctx, target, task);
      } catch (e) { console.error(`CRM work update failed for ${crm.id}:`, e); }
    }
  } catch (e) { console.error('CRM work update failed:', e); }
}
