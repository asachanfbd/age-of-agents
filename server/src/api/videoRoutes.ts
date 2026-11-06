import type { Request, RequestHandler, Response, Router } from 'express';
import type { ProjectRecord } from '../domain/types.ts';
import type { ContentCtx } from '../content/context.ts';
import { contentJobs } from '../content/jobs.ts';
import { contentCtx } from '../content/runtime.ts';
import type { StudioSessions } from '../content/studioSessions.ts';
import { ContentInputError } from '../content/errors.ts';
import { refuseImported } from '../content/concepts.ts';
import { deleteMedia, listMedia, mediaFileOf, renameMedia, thumbnailOf } from '../content/videoMedia.ts';
import { videoAssetOf } from '../content/videoStudio.ts';
import type { ContentGuards } from './contentRoutes.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;

/** The media upload route reads the request stream itself, so no body parser may consume it first (see server.ts). */
export const MEDIA_UPLOAD_PATH = /^\/api\/projects\/[^/]+\/content\/concepts\/[^/]+\/media\/?$/;

/**
 * The Video tab of a Concept: its media (raw streamed uploads, rename, delete, files with Range support), the checklist, Confirm,
 * the renders (listing, files, Stop; Finalize queues the one final render), and the token-protected routes of the video session's tools. The session itself, new round, finalize and reopen
 * use the agent pane's routes (`studioRoutes.ts`). Writes are refused on a read-only Building.
 */
export function mountVideoRoutes(
  router: Router,
  route: RouteWrapper,
  guards: ContentGuards,
  studioSessions: StudioSessions,
  authorize: (req: Request, res: Response) => boolean,
): void {
  const base = '/projects/:id/content/concepts/:cid';
  const video = studioSessions.video;

  const read = <T>(handler: (ctx: ContentCtx, conceptId: string, req: Request) => T | Promise<T>): RequestHandler => route(async (req, res) => {
    const project = await guards.contentProject(req);
    res.json(await handler(contentCtx(project), guards.recordId(req, 'cid'), req));
  });
  const write = <T>(handler: (ctx: ContentCtx, conceptId: string, req: Request, body: unknown) => Promise<T>, status = 200): RequestHandler => route(async (req, res) => {
    const project: ProjectRecord = await guards.contentProject(req);
    guards.refuseIfReadOnly(project);
    const body = guards.bodyOf(req);
    const ctx = contentCtx(project);
    const conceptId = guards.recordId(req, 'cid');
    const out = await ctx.exclusive(() => handler(ctx, conceptId, req, body));
    if (status === 204) { res.status(204).end(); return; }
    res.status(status).json(out);
  });
  /** Sends a stored file; `sendFile` answers Range requests (206, 416) for the players. */
  const sendStored = (res: Response, file: string, mime: string, extra: Record<string, string> = {}) => new Promise<void>((resolve, reject) => {
    res.sendFile(file, { headers: { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra }, acceptRanges: true, dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) reject(error); else resolve();
    });
  });
  // A stored SVG is shown as an image only: scripts in it never run on the app's origin.
  const svgSafe = (mime: string): Record<string, string> => (mime === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {});
  const mid = (req: Request) => guards.recordId(req, 'mid');
  const rid = (req: Request) => guards.recordId(req, 'rid');

  // ---- media ---------------------------------------------------------------------------------
  router.get(`${base}/media`, read((ctx, cid) => { videoAssetOf(ctx, cid); return { media: listMedia(ctx, cid) }; }));
  router.post(`${base}/media`, route(async (req, res) => {
    const project = await guards.contentProject(req);
    guards.refuseIfReadOnly(project);
    const item = await studioSessions.uploadMedia(contentCtx(project), guards.recordId(req, 'cid'), { rawName: req.query.name, body: req, declaredLength: req.headers['content-length'] });
    res.status(201).json(item);
  }));
  router.patch(`${base}/media/:mid`, write(async (ctx, cid, req, body) => {
    refuseImported(ctx, cid);
    const item = await renameMedia(ctx, cid, mid(req), body);
    await video.publishVideo(ctx, cid);
    return item;
  }));
  router.delete(`${base}/media/:mid`, write(async (ctx, cid, req) => {
    refuseImported(ctx, cid);
    await deleteMedia(ctx, cid, mid(req));
    await video.publishVideo(ctx, cid);
  }, 204));
  router.get(`${base}/media/:mid/file`, route(async (req, res) => {
    const ctx = contentCtx(await guards.contentProject(req));
    const f = await mediaFileOf(ctx, guards.recordId(req, 'cid'), mid(req));
    await sendStored(res, f.file, f.mime, { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`, ...svgSafe(f.mime) });
  }));
  router.get(`${base}/media/:mid/thumbnail`, route(async (req, res) => {
    const ctx = contentCtx(await guards.contentProject(req));
    const f = await thumbnailOf(ctx, guards.recordId(req, 'cid'), mid(req));
    await sendStored(res, f.file, f.mime, svgSafe(f.mime));
  }));

  // ---- checklist and confirm --------------------------------------------------------------------
  router.get(`${base}/video/checklist`, read((ctx, cid) => video.checklist(ctx, cid)));
  router.patch(`${base}/video/checklist/:itemId`, write((ctx, cid, req, body) => video.patchItem(ctx, cid, String(req.params.itemId), body)));
  router.post(`${base}/video/confirm`, write((ctx, cid) => video.confirm(ctx, cid)));

  // ---- renders ---------------------------------------------------------------------------------
  router.get(`${base}/video/renders`, read((ctx, cid) => video.renders(ctx, cid)));
  router.get(`${base}/video/renders/:rid/file`, route(async (req, res) => {
    const ctx = contentCtx(await guards.contentProject(req));
    const f = await video.renderFileOf(ctx, guards.recordId(req, 'cid'), rid(req));
    const download = req.query.download === '1';
    await sendStored(res, f.file, 'video/mp4', { 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${f.name}"` });
  }));
  router.post(`${base}/video/renders/:rid/stop`, write((ctx, cid, req) => video.stopRender(ctx, cid, rid(req))));

  // ---- running jobs, for the status footer -------------------------------------------------------
  router.get('/content/jobs/running', route(async (_req, res) => { res.json({ jobs: contentJobs.list() }); }));

  // ---- the video session's tools: the CLI hook token plus `?taskId=<session id>` -------------------------
  const toolSession = (req: Request, res: Response): string | null => {
    if (!authorize(req, res)) return null;
    const { taskId } = req.query;
    if (typeof taskId !== 'string' || !taskId) { res.status(400).json({ error: 'taskId is required' }); return null; }
    return taskId;
  };
  const objectBody = (req: Request): Record<string, unknown> => {
    const body = (req.body ?? {}) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ContentInputError('The request body must be a JSON object');
    return body as Record<string, unknown>;
  };
  router.post('/studio-session/checklist', route(async (req, res) => {
    const sessionId = toolSession(req, res);
    if (!sessionId) return;
    res.json(await studioSessions.setChecklist(sessionId, objectBody(req).items));
  }));
  router.post('/studio-session/speaking-rate', route(async (req, res) => {
    const sessionId = toolSession(req, res);
    if (!sessionId) return;
    res.json(await studioSessions.reportSpeakingRate(sessionId, objectBody(req)));
  }));
  router.get('/studio-session/media', route(async (req, res) => {
    const sessionId = toolSession(req, res);
    if (!sessionId) return;
    res.json(await studioSessions.listMedia(sessionId));
  }));
}
