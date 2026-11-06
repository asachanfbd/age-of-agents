import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { projectsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { cancelJob, checkStorageThreshold, exportBuilding, getJob, getStorageStatus, getStore, guardedWrite, NoStorageError, resumeIngestion, retentionPlanFor, startStorageJob, storageSpecOf } from '../buildings/buildingStorage.ts';
import type { StorageJob } from '../buildings/buildingStorage.ts';
import { getBuildingType, listBuildingTypes } from '../buildings/registry.ts';
import type { BuildingTypeDefinition } from '../buildings/contract.ts';
import { normalizeProject } from '../buildings/normalize.ts';
import { QueryError, toRowArray } from '../buildings/query.ts';
import type { AggregateRequest, Filter, FilterOp, ListRequest } from '../buildings/query.ts';
import { hasSyntheticData } from '../buildings/syntheticData.ts';
import { SecretsStore } from '../buildings/secrets.ts';
import { resetSlotConfig, resolveTypeConfig, setSlotConfig } from '../buildings/slotConfig.ts';
import { validateThreshold } from '../buildings/storageStatus.ts';
import { ProjectNotFoundError } from '../projects/projectService.ts';
import '../buildings/types/index.ts';

const MAX_INSERT_ROWS = 5000;
const MAX_SYNTHETIC_ROWS = 20_000_000;

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

/** The type as the browser sees it: no functions, nothing that could hold a secret. */
export function publicType(type: BuildingTypeDefinition) {
  return {
    id: type.id, name: type.name, description: type.description, category: type.category, version: type.version,
    repository: type.repository, look: type.look, workspace: type.workspace, devOnly: type.devOnly === true,
    slots: type.slots, agents: type.agents, scheduledJobs: type.scheduledJobs, capabilities: type.capabilities.map(({ handle: _handle, ...declaration }) => declaration), events: type.events,
    hasStorage: type.storage !== undefined,
    tables: type.storage?.tables.map((t) => ({ name: t.name, columns: t.columns, sortable: t.sortable, filterable: t.filterable, searchable: t.searchable ?? [] })) ?? [],
    rollups: type.storage?.rollups ?? [],
  };
}

const MUTATION_EXEMPT = [
  { method: 'PATCH', path: /^\/?$/ }, // moving the Building in the city
  { method: 'DELETE', path: /^\/?$/ }, // deleting it
  { method: 'POST', path: /^\/storage\/export$/ },
  { method: 'POST', path: /^\/crm\/import\/paste\/suggest$/ }, // detects columns of a pasted list; writes nothing
  { method: 'POST', path: /^\/content\/remotion\/studio\/(start|stop|heartbeat)$/ }, // viewing in Remotion Studio; its own route refuses an install
];

/** Reads of a read-only Building (type unavailable, or a failed migration) work; everything that would change it answers 409. */
export function readOnlyGuard(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || MUTATION_EXEMPT.some((e) => e.method === req.method && e.path.test(req.path))) return next();
      const project = await projectsDb.get(String(req.params.id));
      const view = project && normalizeProject(project);
      if (view?.readOnly) { res.status(409).json({ error: view.readOnlyReason }); return; }
      next();
    } catch (error) {
      next(error);
    }
  };
}

const FILTER_OPS = new Set<FilterOp>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'prefix']);

/** `filter=col:op:value`, repeatable. */
export function parseFilters(raw: unknown): Filter[] {
  return (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).map((entry) => {
    const [col, op, ...rest] = String(entry).split(':');
    if (!col || !FILTER_OPS.has(op as FilterOp) || !rest.length) throw new QueryError('filter must look like column:operator:value');
    return { col, op: op as FilterOp, value: rest.join(':') };
  });
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export function mountBuildingRoutes(router: Router, route: RouteWrapper, param: ParamReader): void {
  router.use('/projects/:id', readOnlyGuard());

  const storageProject = async (req: Request): Promise<ProjectRecord> => {
    const project = await projectsDb.get(param(req, 'id'));
    if (!project) throw new ProjectNotFoundError();
    if (!storageSpecOf(project)) throw new NoStorageError(getBuildingType(project.typeId ?? 'software')?.name ?? 'This');
    return project;
  };

  // Every registered type, dev-only ones flagged: the web needs them for a Building's tint and storage, and filters the create flow itself.
  router.get('/building-types', route(async (_req, res) => {
    res.json(listBuildingTypes().map(publicType));
  }));

  router.get('/building-types/:typeId/config', route(async (req, res) => {
    const type = getBuildingType(param(req, 'typeId'));
    const slots = await resolveTypeConfig(param(req, 'typeId'));
    res.json({ type: publicType(type!), slots });
  }));

  router.put('/building-types/:typeId/slots/:slotId', route(async (req, res) => {
    const { workflowId, stepAgents } = (req.body ?? {}) as { workflowId?: unknown; stepAgents?: unknown };
    if (workflowId !== undefined && workflowId !== null && typeof workflowId !== 'string') { res.status(400).json({ error: 'workflowId must be a string or null' }); return; }
    if (stepAgents !== undefined && (typeof stepAgents !== 'object' || stepAgents === null || Array.isArray(stepAgents))) { res.status(400).json({ error: 'stepAgents must be an object of step id to agent id' }); return; }
    const badAgent = Object.entries((stepAgents ?? {}) as Record<string, unknown>).find(([, agent]) => agent !== null && typeof agent !== 'string');
    if (badAgent) { res.status(400).json({ error: `stepAgents.${badAgent[0]} must be an agent id or null`, field: `stepAgents.${badAgent[0]}` }); return; }
    res.json({ slots: await setSlotConfig(param(req, 'typeId'), param(req, 'slotId'), { workflowId, stepAgents } as never) });
  }));

  router.delete('/building-types/:typeId/slots/:slotId', route(async (req, res) => {
    res.json({ slots: await resetSlotConfig(param(req, 'typeId'), param(req, 'slotId')) });
  }));

  router.get('/projects/:id/data/:table', route(async (req, res) => {
    const project = await storageProject(req);
    const { sort, dir, search, cursor, limit } = req.query;
    const request: ListRequest = { sort: text(sort), dir: text(dir), search: text(search), cursor: text(cursor), limit, filters: parseFilters(req.query.filter) };
    res.json(await (await getStore(project)).list(param(req, 'table'), request));
  }));

  router.get('/projects/:id/rollups/:rollup', route(async (req, res) => {
    const project = await storageProject(req);
    const { groupBy, rangeCol, from, to, orderBy, dir, limit } = req.query;
    const request: AggregateRequest = {
      groupBy: text(groupBy)?.split(',').filter(Boolean),
      range: text(rangeCol) ? { col: text(rangeCol)!, from: text(from), to: text(to) } : undefined,
      orderBy: text(orderBy), dir: text(dir), limit,
    };
    res.json(await (await getStore(project)).aggregate(param(req, 'rollup'), request));
  }));

  router.post('/projects/:id/data/:table', route(async (req, res) => {
    const project = await storageProject(req);
    const table = storageSpecOf(project)!.tables.find((t) => t.name === param(req, 'table'));
    const { rows } = (req.body ?? {}) as { rows?: unknown };
    if (!table) throw new QueryError(`unknown table "${param(req, 'table')}"`);
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_INSERT_ROWS) throw new QueryError(`rows must be an array of 1 to ${MAX_INSERT_ROWS} rows`);
    const arrays = rows.map((r) => toRowArray(table, r));
    res.status(201).json(await guardedWrite(project, (store) => store.insert(table.name, arrays)));
  }));

  router.post('/projects/:id/data/:table/synthetic', route(async (req, res) => {
    const project = await storageProject(req);
    const table = param(req, 'table');
    const { rows } = (req.body ?? {}) as { rows?: unknown };
    if (!storageSpecOf(project)!.tables.some((t) => t.name === table) || !hasSyntheticData(table)) throw new QueryError(`${table} has no synthetic data`);
    if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > MAX_SYNTHETIC_ROWS) throw new QueryError(`rows must be a whole number from 1 to ${MAX_SYNTHETIC_ROWS}`);
    res.status(202).json(await startStorageJob(project, 'ingest', 'ingestSynthetic', { table, rows }));
  }));

  router.get('/projects/:id/storage', route(async (req, res) => {
    res.json(await getStorageStatus(await storageProject(req)));
  }));

  router.patch('/projects/:id/storage', route(async (req, res) => {
    const project = await storageProject(req);
    let warningBytes: number;
    try { warningBytes = validateThreshold((req.body ?? {}).warningBytes); } catch (error) { throw new QueryError((error as Error).message); }
    await projectsDb.update(project.id, { storageWarningBytes: warningBytes, updatedAt: new Date().toISOString() });
    await checkStorageThreshold(project.id);
    res.json(await getStorageStatus((await projectsDb.get(project.id))!));
  }));

  router.post('/projects/:id/storage/retention', route(async (req, res) => {
    const project = await storageProject(req);
    if (!storageSpecOf(project)!.retention) throw new QueryError('This Building type has no retention rule');
    const plan = await retentionPlanFor(project);
    if (!plan.allowed) { res.status(409).json({ error: 'This Building needs the person to acknowledge what will be discarded before retention can run.' }); return; }
    res.status(202).json(await startStorageJob(project, 'retention', 'retention', { now: new Date().toISOString(), months: plan.months, compact: (req.body ?? {}).compact === true }));
  }));

  router.post('/projects/:id/storage/export', route(async (req, res) => {
    res.status(201).json({ file: await exportBuilding(await storageProject(req)) });
  }));

  router.post('/projects/:id/storage/resume', route(async (req, res) => {
    const project = await storageProject(req);
    await resumeIngestion(project.id);
    res.json(await getStorageStatus((await projectsDb.get(project.id))!));
  }));

  router.get('/projects/:id/storage/jobs/:jobId', route(async (req, res) => {
    const job: StorageJob | undefined = getJob(param(req, 'id'), param(req, 'jobId'));
    if (!job) { res.status(404).json({ error: 'No such job' }); return; }
    res.json(job);
  }));

  router.post('/projects/:id/storage/jobs/:jobId/cancel', route(async (req, res) => {
    const id = param(req, 'id');
    const jobId = param(req, 'jobId');
    const job = getJob(id, jobId);
    if (!job) { res.status(404).json({ error: 'No such job' }); return; }
    if (!cancelJob(id, jobId)) { res.status(409).json({ error: `This job already ${job.status === 'done' ? 'finished' : job.status}` }); return; }
    res.status(202).json(job);
  }));

  const existingProject = async (req: Request): Promise<ProjectRecord> => {
    const project = await projectsDb.get(param(req, 'id'));
    if (!project) throw new ProjectNotFoundError();
    return project;
  };

  router.get('/projects/:id/secrets', route(async (req, res) => {
    res.json(await new SecretsStore((await existingProject(req)).id).list());
  }));

  router.put('/projects/:id/secrets/:key', route(async (req, res) => {
    const project = await existingProject(req);
    try { await new SecretsStore(project.id).set(param(req, 'key'), (req.body ?? {}).value); } catch (error) {
      if (error instanceof TypeError) { res.status(400).json({ error: error.message }); return; }
      throw error;
    }
    res.json({ key: param(req, 'key'), hasSecret: true });
  }));

  router.delete('/projects/:id/secrets/:key', route(async (req, res) => {
    await new SecretsStore((await existingProject(req)).id).delete(param(req, 'key'));
    res.status(204).end();
  }));
}
