import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BuildingPeek, BuildingTaskReader, CrmAgent, CrmCtx, CrmDeps, DraftRequest, MailMessage, MailTransport, SmtpAccount, WorkTask } from '../../src/crm/context.ts';
import { SmtpError } from '../../src/crm/context.ts';
import { openCrmDb } from '../../src/crm/db.ts';
import { defaultSettings } from '../../src/crm/settings.ts';
import type { CrmSettings } from '../../src/crm/settings.ts';

export const T0 = Date.parse('2026-03-16T09:00:00Z'); // a Monday, 09:00 UTC

export class FakeTransport implements MailTransport {
  sent: Array<{ account: SmtpAccount; message: MailMessage }> = [];
  failWith: SmtpError | null = null;
  async send(account: SmtpAccount, message: MailMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ account, message });
  }
}

export class FakeAgent implements CrmAgent {
  requests: DraftRequest[] = [];
  reply: string | Error = 'Hello from the agent';
  async run(request: DraftRequest): Promise<string> {
    this.requests.push(request);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

export class FakeBuildings {
  rows = [{ id: 'b-seo', name: 'Site', typeId: 'seo', status: 'idle' }, { id: 'b-sw', name: 'App', typeId: 'software', status: 'idle' }];
  peeks = new Map<string, BuildingPeek | Error>();
  list = async () => this.rows;
  peek = async (id: string): Promise<BuildingPeek> => {
    const p = this.peeks.get(id);
    if (p instanceof Error) throw p;
    if (p) return p;
    const row = this.rows.find((r) => r.id === id);
    return row ? { state: 'ok', name: row.name, typeId: row.typeId, status: row.status, summary: null } : { state: 'unavailable' };
  };
}

export class FakeTasks implements BuildingTaskReader {
  byBuilding = new Map<string, WorkTask[]>();
  failWith: Error | null = null;
  async finishedSince(buildingId: string, sinceMs: number): Promise<WorkTask[]> {
    if (this.failWith) throw this.failWith;
    return (this.byBuilding.get(buildingId) ?? []).filter((t) => t.finishedAt !== null && t.finishedAt >= sinceMs);
  }
}

export interface Harness {
  ctx: CrmCtx; clock: { now: number }; transport: FakeTransport; agent: FakeAgent; buildings: FakeBuildings; tasks: FakeTasks;
  attention: string[]; resolved: number; secrets: Map<string, string>; settings: CrmSettings;
  advance(ms: number): void;
}

/** A CRM context over an in-memory database, an injected clock and fakes for SMTP, the agent and other Buildings. */
export function harness(patch: Partial<CrmSettings> = {}): Harness {
  const clock = { now: T0 };
  const transport = new FakeTransport(), agent = new FakeAgent(), buildings = new FakeBuildings(), tasks = new FakeTasks();
  const secrets = new Map<string, string>();
  const h = { attention: [] as string[], resolved: 0 };
  let settings: CrmSettings = { ...defaultSettings('UTC'), ...patch };
  const deps: CrmDeps = {
    transport, agent, buildings, tasks,
    notifyAttention: (_id, reason) => { h.attention.push(reason); },
    resolveAttention: () => { h.resolved++; },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const ctx: CrmCtx = {
    db: openCrmDb(':memory:'), buildingId: 'crm-test', now: () => clock.now, deps,
    secrets: { get: async (k) => secrets.get(k), set: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    filesDir: mkdtempSync(path.join(tmpdir(), 'crm-files-')),
    settings: () => settings, saveSettings: (s) => { settings = s; out.settings = s; },
    exclusive: (work) => { const run = queue.then(work, work); queue = run.catch(() => undefined); return run as never; },
  };
  const out: Harness = { ctx, clock, transport, agent, buildings, tasks, attention: h.attention, get resolved() { return h.resolved; }, secrets, settings, advance: (ms) => { clock.now += ms; } };
  return out;
}

export interface TlsPair { key: string; cert: string }
export type SmtpMode = 'ok' | 'auth-fail' | 'reject-rcpt' | 'server-5xx' | 'drop' | 'hang' | 'broken-tls';

/** A real TCP server that speaks enough SMTP for the daemon's client (plain, AUTH PLAIN). Stores what it receives. */
/** `starttls` makes the server offer STARTTLS and upgrade with that key pair; `broken-tls` answers 220 and then sends garbage instead of a handshake. */
export async function fakeSmtpServer(mode: SmtpMode = 'ok', starttls?: TlsPair) {
  const received: Array<{ from: string; to: string; data: string; auth: string | null }> = [];
  const sockets = new Set<net.Socket>();
  const state = { mode };
  const server = net.createServer((raw) => {
    let socket: net.Socket = raw;
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => undefined);
    if (state.mode === 'drop') { raw.destroy(); return; }
    if (state.mode === 'hang') return;
    let buffer = '', inData = false, data = '', from = '', to = '', auth: string | null = null;
    const say = (s: string) => socket.write(`${s}\r\n`);
    say('220 fake ESMTP');
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; received.push({ from, to, data, auth }); data = ''; say('250 queued'); } else data += `${line.replace(/^\.\./, '.')}\r\n`;
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) say(starttls && !(socket instanceof tls.TLSSocket) ? '250-fake\r\n250 STARTTLS' : '250 fake');
        else if (cmd === 'STARTTLS') {
          say('220 go ahead');
          raw.removeListener('data', onData);
          if (state.mode === 'broken-tls') { raw.once('data', () => raw.write('this is not a TLS handshake\r\n')); continue; }
          const secure = new tls.TLSSocket(raw, { isServer: true, key: starttls!.key, cert: starttls!.cert });
          secure.on('error', () => undefined);
          secure.on('data', onData);
          socket = secure; buffer = '';
        }
        else if (cmd.startsWith('AUTH PLAIN')) { if (state.mode === 'auth-fail') say('535 5.7.8 bad credentials'); else { auth = Buffer.from(line.slice(11), 'base64').toString('utf8'); say('235 ok'); } }
        else if (cmd.startsWith('MAIL FROM')) { from = line.slice(10).replace(/[<>]/g, ''); say('250 ok'); }
        else if (cmd.startsWith('RCPT TO')) { if (state.mode === 'reject-rcpt') say('550 no such user'); else if (state.mode === 'server-5xx') say('554 transaction failed'); else { to = line.slice(8).replace(/[<>]/g, ''); say('250 ok'); } }
        else if (cmd === 'DATA') { inData = true; say('354 go'); }
        else if (cmd === 'QUIT') { say('221 bye'); socket.end(); }
        else say('250 ok');
      }
    };
    raw.on('data', onData);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, received, state,
    async close() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  };
}

export function addProspect(ctx: CrmCtx, email: string, extra: Record<string, unknown> = {}) {
  return import('../../src/crm/contacts.ts').then((m) => m.createContact(ctx, { name: 'Person', channels: [{ type: 'email', handle: email }], ...extra }));
}
