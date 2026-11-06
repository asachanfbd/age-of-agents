import type { Request, RequestHandler, Response, Router } from 'express';
import { ContentInputError } from '../content/errors.ts';
import { contentCtx } from '../content/runtime.ts';
import type { StudioSessions } from '../content/studioSessions.ts';
import type { ContentGuards } from './contentRoutes.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;

/**
 * The Images tab's own routes: the rendered PNGs and a round's zip, Stop for a running or waiting image render, and the
 * token-protected `render_images` tool route. The session, new round, resume, finalize and reopen use the agent pane's routes
 * (`studioRoutes.ts`); the running list is the Video tab's `GET /content/jobs/running`.
 */
export function mountImageRoutes(
  router: Router,
  route: RouteWrapper,
  guards: ContentGuards,
  studioSessions: StudioSessions,
  authorize: (req: Request, res: Response) => boolean,
): void {
  const base = '/projects/:id/content/assets/:aid/images';
  const images = studioSessions.images;
  const round = (req: Request): number => (/^\d{1,6}$/.test(String(req.params.round)) ? Number(req.params.round) : -1);
  const ctxOf = async (req: Request) => contentCtx(await guards.contentProject(req));

  router.get(`${base}/rounds/:round/images.zip`, route(async (req, res) => {
    const zip = await images.roundZip(await ctxOf(req), guards.recordId(req, 'aid'), round(req));
    res.setHeader('Content-Disposition', `attachment; filename="round-${round(req)}-images.zip"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('application/zip').send(zip);
  }));
  router.get(`${base}/rounds/:round/:file`, route(async (req, res) => {
    const f = await images.imageFile(await ctxOf(req), guards.recordId(req, 'aid'), round(req), String(req.params.file));
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    await new Promise<void>((resolve, reject) => {
      res.sendFile(f.file, { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Disposition': `${disposition}; filename="${f.name}"` } }, (error) => {
        if (error && !res.headersSent) reject(error); else resolve();
      });
    });
  }));
  router.post(`${base}/renders/:rid/stop`, route(async (req, res) => {
    const project = await guards.contentProject(req);
    guards.refuseIfReadOnly(project);
    const ctx = contentCtx(project);
    const assetId = guards.recordId(req, 'aid');
    const renderId = guards.recordId(req, 'rid');
    res.json(await ctx.exclusive(() => images.stopRender(ctx, assetId, renderId)));
  }));

  // ---- the images session's tool: the CLI hook token plus `?taskId=<session id>` -------------------------
  router.post('/studio-session/images', route(async (req, res) => {
    if (!authorize(req, res)) return;
    const { taskId } = req.query;
    if (typeof taskId !== 'string' || !taskId) { res.status(400).json({ error: 'taskId is required' }); return; }
    const body = (req.body ?? {}) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ContentInputError('The request body must be a JSON object');
    res.json(await studioSessions.renderImages(taskId, body as Record<string, unknown>));
  }));
}
