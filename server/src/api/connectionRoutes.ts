import type { Request, RequestHandler, Response, Router } from 'express';
import { ConnectionError, modesFor } from '../connections/rules.ts';
import { resolveConnectionSession } from '../connections/sessions.ts';
import type { Connections } from '../connections/service.ts';
import type { TaskRecord } from '../domain/types.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

interface SessionAccess {
  /** Answers 401 and returns false unless the request carries the daemon's CLI token. */
  authorize: (req: Request, res: Response) => boolean;
  stepCanEditCode: (task: TaskRecord) => Promise<boolean>;
}

/**
 * Links, capability calls, event subscriptions and the Activity log (docs/connections.md). A refusal answers with its
 * status and `{ error, field? }`. Mounted after the Building read-only guard, so a read-only Building refuses changes.
 */
export function mountConnectionRoutes(router: Router, route: RouteWrapper, param: ParamReader, connections: Connections, sessions: SessionAccess): void {
  const connectionRoute = (handler: (req: Request, res: Response) => Promise<void>) => route(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!(error instanceof ConnectionError)) throw error;
      res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) });
    }
  });
  const body = (req: Request): Record<string, unknown> => (typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body) ? req.body : {});

  router.get('/links', connectionRoute(async (_req, res) => { res.json(await connections.listAllLinks()); }));
  router.get('/projects/:id/links', connectionRoute(async (req, res) => { res.json(await connections.listLinks(param(req, 'id'))); }));
  router.post('/links', connectionRoute(async (req, res) => { res.status(201).json(await connections.createLink(req.body)); }));
  router.patch('/links/:linkId', connectionRoute(async (req, res) => { res.json(await connections.updateLink(param(req, 'linkId'), req.body)); }));
  router.delete('/links/:linkId', connectionRoute(async (req, res) => { await connections.deleteLink(param(req, 'linkId')); res.status(204).end(); }));

  router.get('/projects/:id/subscriptions', connectionRoute(async (req, res) => { res.json(await connections.listSubscriptions(param(req, 'id'))); }));
  router.post('/subscriptions', connectionRoute(async (req, res) => { res.status(201).json(await connections.createSubscription(req.body)); }));
  router.patch('/subscriptions/:subscriptionId', connectionRoute(async (req, res) => { res.json(await connections.updateSubscription(param(req, 'subscriptionId'), req.body)); }));
  router.delete('/subscriptions/:subscriptionId', connectionRoute(async (req, res) => { await connections.deleteSubscription(param(req, 'subscriptionId')); res.status(204).end(); }));

  router.get('/projects/:id/activity', connectionRoute(async (req, res) => { res.json(await connections.activityFor(param(req, 'id'), req.query)); }));

  /** A person's manual call from this Building. 202 means the call waits for approval. */
  router.post('/projects/:id/capability-calls', connectionRoute(async (req, res) => {
    const { targetBuildingId, capabilityId, inputs, idempotencyKey } = body(req);
    const outcome = await connections.call({
      caller: { kind: 'person', buildingId: param(req, 'id') }, targetBuildingId: String(targetBuildingId ?? ''), capabilityId: String(capabilityId ?? ''), inputs, idempotencyKey,
    });
    res.status(outcome.status).json(outcome.body);
  }));

  router.post('/capability-calls/:callId/decision', connectionRoute(async (req, res) => {
    const result = await connections.decide(param(req, 'callId'), body(req).decision);
    res.status(result.outcome?.status ?? 200).json(result.outcome?.body ?? { callId: param(req, 'callId'), state: result.state });
  }));

  /** Publishes one of the Building's declared events to the Buildings subscribed to it. */
  router.post('/projects/:id/events', connectionRoute(async (req, res) => {
    const { eventId, payload } = body(req);
    res.status(202).json(await connections.publishEvent({ sourceBuildingId: param(req, 'id'), eventId: String(eventId ?? ''), payload }));
  }));

  // A session's capability tools — see terminal/capabilityTool.ts. Each call names its Task with `?taskId=` and carries the CLI token.
  const session = async (req: Request, res: Response) => {
    if (!sessions.authorize(req, res)) return null;
    const { taskId } = req.query;
    if (typeof taskId !== 'string' || !taskId) { res.status(400).json({ error: 'taskId is required', field: 'taskId' }); return null; }
    return resolveConnectionSession(taskId, sessions.stepCanEditCode);
  };

  router.get('/agent-capabilities/capabilities', connectionRoute(async (req, res) => {
    const found = await session(req, res);
    if (found) res.json({ capabilities: await connections.offersFor(found.caller.buildingId, found.session) });
  }));

  router.post('/agent-capabilities/calls', connectionRoute(async (req, res) => {
    const found = await session(req, res);
    if (!found) return;
    const { targetBuildingId, capabilityId, inputs, idempotencyKey } = body(req);
    const outcome = await connections.call({
      caller: found.caller, targetBuildingId: String(targetBuildingId ?? ''), capabilityId: String(capabilityId ?? ''), inputs, idempotencyKey,
      depth: found.depth + 1, chainId: found.chainId, allowedModes: modesFor(found.session),
    });
    res.status(outcome.status).json(outcome.body);
  }));
}
