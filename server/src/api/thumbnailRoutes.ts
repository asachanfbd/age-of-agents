import type { Request, RequestHandler, Response, Router } from 'express';
import { ContentInputError } from '../content/errors.ts';
import { contentCtx } from '../content/runtime.ts';
import type { StudioSessions } from '../content/studioSessions.ts';
import type { ContentGuards } from './contentRoutes.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;

/**
 * The Thumbnail tab's own routes: the rendered PNGs, Stop for a running or waiting thumbnail render, and the token-protected
 * `render_thumbnails` tool route. The session, new round, resume, finalize (with the owner's pick) and reopen use the agent pane's
 * routes (`studioRoutes.ts`); the running list is the Video tab's `GET /content/jobs/running`.
 */
export function mountThumbnailRoutes(
  router: Router,
  route: RouteWrapper,
  guards: ContentGuards,
  studioSessions: StudioSessions,
  authorize: (req: Request, res: Response) => boolean,
): void {
  const base = '/projects/:id/content/assets/:aid/thumbnail';
  const thumbnails = studioSessions.thumbnails;
  const round = (req: Request): number => (/^\d{1,6}$/.test(String(req.params.round)) ? Number(req.params.round) : -1);

  router.get(`${base}/rounds/:round/:file`, route(async (req, res) => {
    const ctx = contentCtx(await guards.contentProject(req));
    const f = await thumbnails.thumbnailFile(ctx, guards.recordId(req, 'aid'), round(req), String(req.params.file));
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
    res.json(await ctx.exclusive(async () => thumbnails.stopRender(ctx, assetId, renderId)));
  }));

  // ---- the thumbnail session's tool: the CLI hook token plus `?taskId=<session id>` -------------------------
  router.post('/studio-session/thumbnails', route(async (req, res) => {
    if (!authorize(req, res)) return;
    const { taskId } = req.query;
    if (typeof taskId !== 'string' || !taskId) { res.status(400).json({ error: 'taskId is required' }); return; }
    const body = (req.body ?? {}) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ContentInputError('The request body must be a JSON object');
    res.json(await studioSessions.renderThumbnails(taskId, body as Record<string, unknown>));
  }));
}
