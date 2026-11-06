import type { Request, RequestHandler, Response, Router } from 'express';
import { scheduledJobsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { ScheduleError } from '../scheduler/scheduler.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import { approveProposal, changeProposalRow, decideAllPending, proposalCsvOf, proposalOf, retryHandoff, settleAgent, startAgentTask, stopAgentTask, useManualFallback } from '../seo/agentTasks.ts';
import { SeoInputError, SeoNotFoundError } from '../seo/errors.ts';
import { SCHEDULE_ACTION_LIST } from '../seo/scheduleActionList.ts';
import { createTask, deleteTask, listTasks, manualCsv, patchTask, relatedTasks, scheduleViews, taskDetail } from '../seo/tasks.ts';
import { TASK_LIMITS } from '../seo/taskRules.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The Tasks panel's API: the unified list, manual tasks, agent tasks with proposal review and handoff, and scheduled fetches. */
export function mountSeoTaskRoutes(router: Router, route: RouteWrapper, param: ParamReader, scheduler: Scheduler, seoProject: (req: Request) => Promise<ProjectRecord>): void {
  const base = '/projects/:id/seo';
  const task = (req: Request) => param(req, 'taskId');
  const body = (req: Request): Record<string, unknown> => (isObject(req.body) ? req.body : {});

  router.get(`${base}/tasks`, route(async (req, res) => {
    res.json(await listTasks(await seoProject(req), req.query));
  }));

  router.post(`${base}/tasks`, route(async (req, res) => {
    res.status(201).json(await createTask(await seoProject(req), req.body));
  }));

  router.get(`${base}/tasks/related`, route(async (req, res) => {
    res.json(await relatedTasks(await seoProject(req), req.query));
  }));

  router.get(`${base}/tasks/:taskId`, route(async (req, res) => {
    res.json(await taskDetail(await seoProject(req), task(req)));
  }));

  router.patch(`${base}/tasks/:taskId`, route(async (req, res) => {
    res.json(await patchTask(await seoProject(req), task(req), req.body));
  }));

  router.delete(`${base}/tasks/:taskId`, route(async (req, res) => {
    await deleteTask(await seoProject(req), task(req));
    res.status(204).end();
  }));

  router.get(`${base}/tasks/:taskId/csv`, route(async (req, res) => {
    res.type('text/csv').set('content-disposition', 'attachment; filename="seo-task.csv"').send(await manualCsv(await seoProject(req), task(req)));
  }));

  // ---- agent tasks ----

  router.post(`${base}/agent-tasks`, route(async (req, res) => {
    const record = await startAgentTask(await seoProject(req), req.body);
    res.status(202).json(await taskDetail(await seoProject(req), record.id));
  }));

  router.post(`${base}/agent-tasks/:taskId/stop`, route(async (req, res) => {
    const project = await seoProject(req);
    await stopAgentTask(project, task(req));
    res.json(await taskDetail(project, task(req)));
  }));

  router.get(`${base}/agent-tasks/:taskId/proposal`, route(async (req, res) => {
    res.json(await proposalOf(await seoProject(req), task(req)));
  }));

  router.put(`${base}/agent-tasks/:taskId/proposal/rows/:rowId`, route(async (req, res) => {
    res.json(await changeProposalRow(await seoProject(req), task(req), param(req, 'rowId'), req.body));
  }));

  router.post(`${base}/agent-tasks/:taskId/proposal/decide-all`, route(async (req, res) => {
    res.json({ changed: await decideAllPending(await seoProject(req), task(req), body(req).decision) });
  }));

  router.get(`${base}/agent-tasks/:taskId/proposal.csv`, route(async (req, res) => {
    const { fileName, csv } = await proposalCsvOf(await seoProject(req), task(req));
    res.type('text/csv').set('content-disposition', `attachment; filename="${fileName}"`).send(csv);
  }));

  router.post(`${base}/agent-tasks/:taskId/approve`, route(async (req, res) => {
    const project = await seoProject(req);
    await approveProposal(project, task(req));
    res.json(await taskDetail(project, task(req)));
  }));

  router.post(`${base}/agent-tasks/:taskId/handoff/retry`, route(async (req, res) => {
    const project = await seoProject(req);
    await retryHandoff(project, task(req));
    res.json(await taskDetail(project, task(req)));
  }));

  router.post(`${base}/agent-tasks/:taskId/handoff/manual`, route(async (req, res) => {
    const project = await seoProject(req);
    await useManualFallback(project, task(req));
    res.json(await taskDetail(project, task(req)));
  }));

  router.post(`${base}/agent-tasks/:taskId/refresh`, route(async (req, res) => {
    const project = await seoProject(req);
    await settleAgent(project, task(req));
    res.json(await taskDetail(project, task(req)));
  }));

  // ---- scheduled fetches: the scheduler owns cron, history, failures and ordering ----

  /** A refused scheduler request answers with its status and `{ error, field? }`. */
  const scheduleRoute = (handler: (req: Request, res: Response) => Promise<void>) => route(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) });
    }
  });

  /** The job is one of this Building's scheduled fetches, or it is a 404. */
  const ownJob = async (req: Request) => {
    const project = await seoProject(req);
    const job = await scheduledJobsDb.get(param(req, 'jobId'));
    if (!job || job.projectId !== project.id || job.target.kind !== 'action') throw new SeoNotFoundError('There is no such scheduled fetch');
    return { project, job };
  };

  const jobBody = (input: Record<string, unknown>, current?: { actionId: string; cron: string }) => {
    const name = input.name === undefined ? undefined : input.name;
    if (typeof name === 'string' && name.trim().length > TASK_LIMITS.scheduleName) throw new SeoInputError(`name must be at most ${TASK_LIMITS.scheduleName} characters`);
    return {
      ...(name === undefined ? {} : { name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.cron === undefined && !current ? {} : { trigger: { kind: 'cron', cron: input.cron ?? current?.cron } }),
      ...(input.actionId === undefined && !current ? {} : { target: { kind: 'action', actionId: input.actionId ?? current?.actionId } }),
      ...(input.missedPolicy === undefined ? {} : { missedPolicy: input.missedPolicy }),
    };
  };

  router.get(`${base}/schedules`, scheduleRoute(async (req, res) => {
    const project = await seoProject(req);
    res.json({ actions: SCHEDULE_ACTION_LIST, schedules: await scheduleViews(project) });
  }));

  router.get(`${base}/schedules/cron-preview`, scheduleRoute(async (req, res) => {
    res.json(await scheduler.previewCron((await seoProject(req)).id, req.query.cron));
  }));

  router.post(`${base}/schedules`, scheduleRoute(async (req, res) => {
    const project = await seoProject(req);
    const input = body(req);
    const job = await scheduler.createJob(project.id, { ...jobBody(input), overlap: 'skip', missedPolicy: input.missedPolicy ?? 'skip', enabled: input.enabled ?? true });
    res.status(201).json((await scheduleViews(project)).find((s) => s.id === job.id));
  }));

  router.patch(`${base}/schedules/:jobId`, scheduleRoute(async (req, res) => {
    const { project, job } = await ownJob(req);
    const current = { actionId: job.target.kind === 'action' ? job.target.actionId : '', cron: job.trigger.kind === 'cron' ? job.trigger.cron : '' };
    const input = body(req);
    const patch = jobBody(input, input.cron !== undefined || input.actionId !== undefined ? current : undefined);
    await scheduler.updateJob(project.id, job.id, patch);
    res.json((await scheduleViews(project)).find((s) => s.id === job.id));
  }));

  router.delete(`${base}/schedules/:jobId`, scheduleRoute(async (req, res) => {
    const { project, job } = await ownJob(req);
    await scheduler.deleteJob(project.id, job.id);
    res.status(204).end();
  }));

  router.post(`${base}/schedules/:jobId/run`, scheduleRoute(async (req, res) => {
    const { project, job } = await ownJob(req);
    const { status, entry } = await scheduler.runNow(project.id, job.id);
    res.status(status === 'queued' ? 202 : 201).json({ entry, schedule: (await scheduleViews(project)).find((s) => s.id === job.id) });
  }));

  router.get(`${base}/schedules/:jobId/history`, scheduleRoute(async (req, res) => {
    const { project, job } = await ownJob(req);
    res.json(await scheduler.listHistory(project.id, job.id, { cursor: req.query.cursor, limit: req.query.limit }));
  }));
}
