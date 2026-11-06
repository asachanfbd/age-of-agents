import type { Request, RequestHandler, Response, Router } from 'express';
import { ScheduleError } from '../scheduler/scheduler.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

/**
 * A Building's Schedules area (docs/scheduler.md). Mounted after `readOnlyGuard`, so every route here that changes
 * something answers 409 on a read-only Building while the reads keep working.
 */
export function mountScheduleRoutes(router: Router, route: RouteWrapper, param: ParamReader, scheduler: Scheduler): void {
  /** A refused request answers with its status and `{ error, field? }`; anything else goes to the router's error handler. */
  const scheduleRoute = (handler: (req: Request, res: Response) => Promise<void>) => route(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) });
    }
  });
  const ids = (req: Request) => [param(req, 'id'), param(req, 'jobId')] as const;

  router.get('/projects/:id/schedules', scheduleRoute(async (req, res) => {
    res.json(await scheduler.getSchedules(param(req, 'id')));
  }));

  router.patch('/projects/:id/schedules', scheduleRoute(async (req, res) => {
    const { timezone } = (req.body ?? {}) as { timezone?: unknown };
    res.json(await scheduler.setTimezone(param(req, 'id'), timezone));
  }));

  router.get('/projects/:id/schedules/cron-preview', scheduleRoute(async (req, res) => {
    res.json(await scheduler.previewCron(param(req, 'id'), req.query.cron));
  }));

  router.post('/projects/:id/schedules/restore-defaults', scheduleRoute(async (req, res) => {
    res.json(await scheduler.restoreDefaults(param(req, 'id')));
  }));

  router.post('/projects/:id/schedules/jobs', scheduleRoute(async (req, res) => {
    res.status(201).json(await scheduler.createJob(param(req, 'id'), req.body));
  }));

  router.patch('/projects/:id/schedules/jobs/:jobId', scheduleRoute(async (req, res) => {
    res.json(await scheduler.updateJob(...ids(req), req.body));
  }));

  router.delete('/projects/:id/schedules/jobs/:jobId', scheduleRoute(async (req, res) => {
    await scheduler.deleteJob(...ids(req));
    res.status(204).end();
  }));

  // 201 when the run started, 202 when it waits as queued, 409 when the overlap rule forbids it.
  router.post('/projects/:id/schedules/jobs/:jobId/run', scheduleRoute(async (req, res) => {
    const { status, entry, job } = await scheduler.runNow(...ids(req));
    res.status(status === 'queued' ? 202 : 201).json({ entry, job });
  }));

  router.get('/projects/:id/schedules/jobs/:jobId/history', scheduleRoute(async (req, res) => {
    res.json(await scheduler.listHistory(...ids(req), { cursor: req.query.cursor, limit: req.query.limit }));
  }));
}
