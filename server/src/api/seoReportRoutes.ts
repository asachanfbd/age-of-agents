import type { Request, RequestHandler, Response, Router } from 'express';
import type { ProjectRecord } from '../domain/types.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import { liveReport } from '../seo/reportData.ts';
import { deleteReport, exportLive, exportSaved, generateSummary, getReport, listReports, saveReport } from '../seo/reports.ts';
import type { ExportFile } from '../seo/reports.ts';
import { scheduleViews } from '../seo/tasks.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

const REPORT_ACTIONS = { 'report-weekly': 'weekly', 'report-monthly': 'monthly' } as const;

const send = (res: Response, file: ExportFile): void => {
  res.type(file.contentType).set('content-disposition', `attachment; filename="${file.fileName}"`).send(file.body);
};

/** The Reports tab's API: the live report, the AI summary, saved reports with their exports, and the schedule state. */
export function mountSeoReportRoutes(router: Router, route: RouteWrapper, param: ParamReader, scheduler: Scheduler, seoProject: (req: Request) => Promise<ProjectRecord>): void {
  const base = '/projects/:id/seo/reports';

  router.get(`${base}/live`, route(async (req, res) => {
    res.json(await liveReport(await seoProject(req), req.query));
  }));

  router.get(`${base}/live/export`, route(async (req, res) => {
    send(res, await exportLive(await seoProject(req), req.query));
  }));

  router.post(`${base}/summary`, route(async (req, res) => {
    res.json(await generateSummary(await seoProject(req), req.body ?? {}));
  }));

  /** Whether reports can be saved on a schedule (the scheduler is running) and which schedules this Building has. */
  router.get(`${base}/schedule`, route(async (req, res) => {
    const schedules = (await scheduleViews(await seoProject(req))).filter((s) => s.actionId in REPORT_ACTIONS)
      .map((s) => ({ ...s, cadence: REPORT_ACTIONS[s.actionId as keyof typeof REPORT_ACTIONS] }));
    res.json({ available: scheduler.isRunning(), schedules });
  }));

  router.get(base, route(async (req, res) => {
    res.json({ reports: await listReports(await seoProject(req)) });
  }));

  router.post(base, route(async (req, res) => {
    res.status(201).json(await saveReport(await seoProject(req), req.body));
  }));

  router.get(`${base}/:reportId`, route(async (req, res) => {
    res.json(await getReport(await seoProject(req), param(req, 'reportId')));
  }));

  router.get(`${base}/:reportId/export`, route(async (req, res) => {
    send(res, await exportSaved(await seoProject(req), param(req, 'reportId'), req.query));
  }));

  router.delete(`${base}/:reportId`, route(async (req, res) => {
    await deleteReport(await seoProject(req), param(req, 'reportId'));
    res.status(204).end();
  }));
}
