import type { Request, RequestHandler, Response, Router } from 'express';
import type { AgentSessions } from '../terminal/agentSessions.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

/**
 * A Project's Agent terminal sessions (terminal/agentSessions.ts): the web's list/start/resume/rename/end/delete
 * routes, and the one tool route the session itself calls to name its conversation. A refused request
 * answers with its `AgentSessionError` status through the router's error handler.
 */
export function mountAgentSessionRoutes(
  router: Router,
  route: RouteWrapper,
  param: ParamReader,
  agentSessions: AgentSessions,
  authorize: (req: Request, res: Response) => boolean,
): void {
  router.get('/projects/:id/agent-sessions', route(async (req, res) => {
    res.json(await agentSessions.list(param(req, 'id')));
  }));

  router.post('/projects/:id/agent-sessions', route(async (req, res) => {
    res.status(201).json(await agentSessions.create(param(req, 'id'), req.body?.executorId));
  }));

  router.post('/agent-sessions/:sessionId/resume', route(async (req, res) => {
    res.json(await agentSessions.resume(param(req, 'sessionId')));
  }));

  router.patch('/agent-sessions/:sessionId', route(async (req, res) => {
    res.json(await agentSessions.rename(param(req, 'sessionId'), req.body?.name));
  }));

  router.post('/agent-sessions/:sessionId/end', route(async (req, res) => {
    res.json(await agentSessions.end(param(req, 'sessionId')));
  }));

  router.delete('/agent-sessions/:sessionId', route(async (req, res) => {
    await agentSessions.remove(param(req, 'sessionId'));
    res.status(204).end();
  }));

  // The session's own naming tool (terminal/agentSessionTool.ts): the CLI hook token plus `?taskId=<session id>`.
  router.post('/agent-session/name', route(async (req, res) => {
    if (!authorize(req, res)) return;
    const { taskId } = req.query;
    if (typeof taskId !== 'string' || !taskId) { res.status(400).json({ error: 'taskId is required' }); return; }
    res.json(await agentSessions.rename(taskId, req.body?.name));
  }));
}
