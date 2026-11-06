import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import cors from 'cors';
import { createApiRouter, type ApiRouterOptions } from './api/router.ts';
import { attachWebSocketServer } from './api/ws.ts';
import { MEDIA_UPLOAD_PATH } from './api/videoRoutes.ts';

/** Builds the daemon's HTTP+WS server without starting it — kept separate from index.ts so tests can spin up an instance on an ephemeral port. */
export function createDaemonServer(options: ApiRouterOptions = {}): HttpServer {
  const app = express();
  app.use(cors());
  // Bumped from Express's 100kb default: the Catalog's upload routes (an agent's .md, a skill's zip,
  // a skill support file — see api/router.ts) travel as base64 inside this same JSON body.
  const json = express.json({ limit: '25mb' });
  // A Content Studio brand file is raw bytes whatever its type: a `.json` file must reach its own raw parser unparsed. A Video tab
  // media upload is streamed to disk by its route, so nothing may read its body first.
  const isRawUpload = (req: Request) => req.method === 'POST' && (/^\/api\/projects\/[^/]+\/content\/knowledge\/files\/?$/.test(req.path) || MEDIA_UPLOAD_PATH.test(req.path));
  app.use((req, res, next) => (isRawUpload(req) ? next() : json(req, res, next)));
  app.use('/api', createApiRouter(options));
  // A body the JSON parser rejects never reaches the router, so it gets the API's `{ error }` shape here.
  app.use((error: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (error.type !== 'entity.parse.failed') { next(error); return; }
    res.status(400).json({ error: 'The request body is not valid JSON' });
  });

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer, options.testRunner, options.scheduler, options.defaultExecutor, options.agentSessions, options.studioSessions, options.liveTerminalSessions);
  return httpServer;
}
