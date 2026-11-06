import type { Request, RequestHandler, Response, Router } from 'express';
import { normalizeProject } from '../buildings/normalize.ts';
import { remotionStudios } from '../content/remotionStudio.ts';
import type { StudioView } from '../content/remotionStudio.ts';
import { contentCtx } from '../content/runtime.ts';
import type { ContentGuards } from './contentRoutes.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;

/**
 * The Remotion tab's Studio process, one per Building. No route reads the request body. Viewing changes no data, so
 * a read-only Building may start, stop and heartbeat Studio too; only an install it would need is refused (409).
 */
export function mountRemotionStudioRoutes(router: Router, route: RouteWrapper, guards: ContentGuards): void {
  const base = '/projects/:id/content/remotion/studio';
  const handle = (work: (req: Request) => Promise<StudioView>): RequestHandler => route(async (req, res) => { res.json(await work(req)); });

  router.get(base, handle(async (req) => remotionStudios.view((await guards.contentProject(req)).id)));
  router.post(`${base}/start`, handle(async (req) => {
    const project = await guards.contentProject(req);
    return remotionStudios.start(contentCtx(project), { readOnly: normalizeProject(project).readOnly });
  }));
  router.post(`${base}/stop`, handle(async (req) => remotionStudios.stop((await guards.contentProject(req)).id)));
  router.post(`${base}/heartbeat`, handle(async (req) => remotionStudios.heartbeat((await guards.contentProject(req)).id)));
}
