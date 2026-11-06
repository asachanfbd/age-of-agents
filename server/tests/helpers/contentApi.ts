import { mkdtemp, rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ContentApi {
  baseUrl: string;
  clock: { now: number };
  dataDir: string;
  api(pathname: string, init?: RequestInit): Promise<{ status: number; body: any; text: string; headers: Headers }>;
  send(method: string, pathname: string, payload?: unknown): ReturnType<ContentApi['api']>;
  createStudio(name?: string, timezone?: string): Promise<string>;
  c(id: string, suffix: string): string;
  projectsDb: typeof import('../../src/db/collections.ts').projectsDb;
  stop(): Promise<void>;
}

/** Boots the real daemon server on temp folders with an injected clock; never touches the real data folder. `makeOptions` runs after the temp folders are in place, so a test can build its own injected services. */
export async function startContentApi(makeOptions?: () => Promise<import('../../src/api/router.ts').ApiRouterOptions> | import('../../src/api/router.ts').ApiRouterOptions): Promise<ContentApi> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'content-api-'));
  const dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, '..', 'fixtures', 'executors.json');
  const { createDaemonServer } = await import('../../src/server.ts');
  const runtime = await import('../../src/content/runtime.ts');
  // A finalized script starts a video session, whose Remotion setup must never run a real npm install, render or still in a test.
  const refuse = async () => { throw new Error('Not available in tests'); };
  (await import('../../src/content/videoDeps.ts')).configureVideo({ installer: { install: refuse }, renderer: { render: refuse }, stillRenderer: { still: refuse }, prober: { probe: refuse, thumbnail: refuse } });
  const { projectsDb } = await import('../../src/db/collections.ts');
  const storage = await import('../../src/buildings/buildingStorage.ts');
  const server: HttpServer = createDaemonServer(makeOptions ? await makeOptions() : {});
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const clock = { now: Date.parse('2026-10-26T10:00:00Z') };
  runtime.setContentClock(() => (clock.now += 1000));

  async function api(pathname: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    return { status: res.status, body, text, headers: res.headers };
  }
  const out: ContentApi = {
    baseUrl, clock, dataDir, api, projectsDb,
    send: (method, pathname, payload) => api(pathname, { method, body: payload === undefined ? undefined : JSON.stringify(payload) }),
    async createStudio(name = 'Brand', timezone = 'Europe/Berlin') {
      const res = await out.send('POST', '/api/projects', { typeId: 'content-studio', name, timezone });
      if (res.status !== 201) throw new Error(`create failed: ${res.status} ${res.text}`);
      return res.body.id as string;
    },
    c: (id, suffix) => `/api/projects/${id}/content${suffix}`,
    async stop() {
      await storage.closeAllStores();
      await new Promise((resolve) => server.close(resolve));
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return out;
}
