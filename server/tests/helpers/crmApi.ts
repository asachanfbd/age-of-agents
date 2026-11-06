import { cp, mkdtemp, rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeAgent, FakeBuildings, FakeTransport, T0 } from './crmFakes.ts';
import type { CrmDeps } from '../../src/crm/context.ts';

export interface CrmApi {
  baseUrl: string; clock: { now: number }; transport: FakeTransport; agent: FakeAgent; buildings: FakeBuildings; attention: string[]; resolved: { n: number };
  api(pathname: string, init?: RequestInit): Promise<{ status: number; body: any; text: string; headers: Headers }>;
  send(method: string, pathname: string, payload?: unknown): ReturnType<CrmApi['api']>;
  createCrm(name?: string): Promise<string>;
  crm(id: string, suffix: string): string;
  reset(): void;
  projectsDb: typeof import('../../src/db/collections.ts').projectsDb;
  notificationsDb: typeof import('../../src/db/collections.ts').notificationsDb;
  dataDir: string;
  stop(): Promise<void>;
  overrides(extra?: Partial<CrmDeps>): void;
}

/** Boots the real daemon server on temp folders with an injected CRM clock and fakes for SMTP, the agent and other Buildings. */
export async function startCrmApi(): Promise<CrmApi> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'crm-api-'));
  const dataDir = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = dataDir;
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, '..', 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  await cp(path.join(import.meta.dirname, '..', 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../../src/server.ts');
  const runtime = await import('../../src/crm/runtime.ts');
  const { projectsDb, notificationsDb } = await import('../../src/db/collections.ts');
  const storage = await import('../../src/buildings/buildingStorage.ts');
  const server: HttpServer = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const clock = { now: T0 };
  const transport = new FakeTransport(), agent = new FakeAgent(), buildings = new FakeBuildings();
  const attention: string[] = [];
  const resolved = { n: 0 };
  const install = (extra: Partial<CrmDeps> = {}) => runtime.setCrmOverrides({
    now: () => clock.now,
    deps: { transport, agent, buildings, notifyAttention: (_id, reason) => { attention.push(reason); }, resolveAttention: () => { resolved.n++; }, ...extra },
  });
  install();

  async function api(pathname: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    return { status: res.status, body, text, headers: res.headers };
  }
  const out: CrmApi = {
    baseUrl, clock, transport, agent, buildings, attention, resolved, api, projectsDb, notificationsDb, dataDir,
    send: (method, pathname, payload) => api(pathname, { method, body: payload === undefined ? undefined : JSON.stringify(payload) }),
    async createCrm(name = 'Sales') {
      const res = await out.send('POST', '/api/projects', { typeId: 'crm', name });
      if (res.status !== 201) throw new Error(`create failed: ${res.status} ${res.text}`);
      return res.body.id as string;
    },
    crm: (id, suffix) => `/api/projects/${id}/crm${suffix}`,
    reset() { clock.now = T0; transport.sent = []; transport.failWith = null; agent.requests = []; agent.reply = 'Hello from the agent'; attention.length = 0; resolved.n = 0; install(); },
    overrides: install,
    async stop() {
      await storage.closeAllStores();
      await new Promise((resolve) => server.close(resolve));
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return out;
}
