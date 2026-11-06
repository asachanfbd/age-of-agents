import type { Request, RequestHandler, Response, Router } from 'express';
import type { ProjectRecord } from '../domain/types.ts';
import type { ContentCtx } from '../content/context.ts';
import { contentCtx } from '../content/runtime.ts';
import type { StudioSessions } from '../content/studioSessions.ts';
import { ContentInputError } from '../content/errors.ts';
import type { ContentGuards } from './contentRoutes.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;

/**
 * The agent pane of a Concept's asset (content/studioSessions.ts): the web's session, round, finalize, reopen and
 * drafts routes, the line comment typed into the live session, and the token-protected routes the session's own tools call. Writes are refused on a
 * read-only Building and run one at a time per Building, like every other Content Studio write.
 */
export function mountStudioRoutes(
  router: Router,
  route: RouteWrapper,
  guards: ContentGuards,
  studioSessions: StudioSessions,
  authorize: (req: Request, res: Response) => boolean,
): void {
  const base = '/projects/:id/content/concepts/:cid/assets/:aid';
  const ids = (req: Request) => ({ conceptId: guards.recordId(req, 'cid'), assetId: guards.recordId(req, 'aid') });

  const read = <T>(handler: (ctx: ContentCtx, conceptId: string, assetId: string) => Promise<T>): RequestHandler => route(async (req, res) => {
    const project = await guards.contentProject(req);
    const { conceptId, assetId } = ids(req);
    res.json(await handler(contentCtx(project), conceptId, assetId));
  });
  const write = <T>(handler: (ctx: ContentCtx, conceptId: string, assetId: string, body: unknown) => Promise<T>, status = 200): RequestHandler => route(async (req, res) => {
    const project: ProjectRecord = await guards.contentProject(req);
    guards.refuseIfReadOnly(project);
    const body = guards.bodyOf(req);
    const { conceptId, assetId } = ids(req);
    const ctx = contentCtx(project);
    res.status(status).json(await ctx.exclusive(() => handler(ctx, conceptId, assetId, body)));
  });

  router.get(`${base}/session`, read((ctx, c, a) => studioSessions.get(ctx, c, a)));
  router.post(`${base}/session`, write((ctx, c, a) => studioSessions.start(ctx, c, a), 201));
  router.post(`${base}/session/new-round`, write((ctx, c, a) => studioSessions.newRound(ctx, c, a)));
  router.post(`${base}/session/resume`, write((ctx, c, a) => studioSessions.resume(ctx, c, a)));
  router.post(`${base}/session/comment`, write((ctx, c, a, body) => studioSessions.comment(ctx, c, a, body)));
  router.post(`${base}/finalize`, write((ctx, c, a, body) => studioSessions.finalize(ctx, c, a, body as { file?: unknown })));
  router.post(`${base}/reopen`, write((ctx, c, a) => studioSessions.reopen(ctx, c, a)));
  router.get(`${base}/drafts`, read((ctx, c, a) => studioSessions.drafts(ctx, c, a)));

  // The session's own tools (terminal/studioSessionTool.ts): the CLI hook token plus `?taskId=<session id>`.
  const toolSession = (req: Request, res: Response): string | null => {
    if (!authorize(req, res)) return null;
    const { taskId } = req.query;
    if (typeof taskId !== 'string' || !taskId) { res.status(400).json({ error: 'taskId is required' }); return null; }
    return taskId;
  };
  router.post('/studio-session/draft', route(async (req, res) => {
    const sessionId = toolSession(req, res);
    if (!sessionId) return;
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ContentInputError('The request body must be a JSON object');
    res.json(await studioSessions.saveDraft(sessionId, (body as { text?: unknown }).text));
  }));
  router.get('/studio-session/concept', route(async (req, res) => {
    const sessionId = toolSession(req, res);
    if (!sessionId) return;
    res.json(await studioSessions.conceptOf(sessionId));
  }));
  router.get('/studio-session/reference-content', route(async (req, res) => {
    const sessionId = toolSession(req, res);
    if (!sessionId) return;
    const { taskId: _taskId, ...query } = req.query;
    res.json(await studioSessions.reference(sessionId, query));
  }));
  router.post('/studio-session/imported-concept', route(async (req, res) => {
    const sessionId = toolSession(req, res);
    if (!sessionId) return;
    res.status(201).json(await studioSessions.imports.save(sessionId, req.body));
  }));
  router.get('/studio-session/performance', route(async (req, res) => {
    const sessionId = toolSession(req, res);
    if (!sessionId) return;
    const { taskId: _taskId, ...query } = req.query;
    res.json(await studioSessions.performance(sessionId, query));
  }));
}
