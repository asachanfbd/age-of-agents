import net from 'node:net';
import tls from 'node:tls';
import { SmtpError } from './context.ts';
import type { MailMessage, MailTransport, SmtpAccount } from './context.ts';

let TIMEOUT_MS = 15_000;
let tlsExtra: tls.ConnectionOptions = {};
/** Test seam: extra TLS options, such as a CA for a self-signed test server. */
export function setSmtpTlsOptions(options: tls.ConnectionOptions): void { tlsExtra = options; }
/** Test seam: how long the mail server may stay silent. */
export function setSmtpTimeout(ms: number): void { TIMEOUT_MS = ms; }

interface Reply { code: number; lines: string[] }

/** A minimal SMTP client (EHLO, STARTTLS, AUTH PLAIN, one message). Errors carry a kind but never the password. */
class Session {
  #socket: net.Socket | tls.TLSSocket;
  #buffer = '';
  #waiter: ((r: Reply) => void) | null = null;
  #fail: ((e: Error) => void) | null = null;
  #replyLines: string[] = [];
  #queue: Reply[] = [];
  #failed: Error | null = null;

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.#socket = socket;
    this.#attach(socket);
  }

  #attach(socket: net.Socket): void {
    socket.setTimeout(TIMEOUT_MS, () => this.#error(new SmtpError('timeout', 'The mail server did not answer in time')));
    socket.on('data', (d) => this.#onData(d.toString('utf8')));
    socket.on('error', (e) => this.#error(classify(e)));
    socket.on('close', () => this.#error(new SmtpError('refused', 'The mail server closed the connection')));
  }

  #error(e: Error): void {
    this.#failed ??= e;
    const fail = this.#fail;
    this.#fail = null; this.#waiter = null;
    fail?.(e);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let i: number;
    while ((i = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, i).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(i + 1);
      this.#replyLines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.#replyLines };
        this.#replyLines = [];
        const w = this.#waiter;
        if (w) { this.#waiter = null; this.#fail = null; w(reply); } else this.#queue.push(reply);
      }
    }
  }

  read(): Promise<Reply> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#failed) return Promise.reject(this.#failed);
    return new Promise((resolve, reject) => { this.#waiter = resolve; this.#fail = reject; });
  }

  async command(text: string, expect: number[]): Promise<Reply> {
    this.#socket.write(`${text}\r\n`);
    return this.expect(await this.read(), expect);
  }

  expect(reply: Reply, expect: number[]): Reply {
    if (!expect.includes(reply.code)) throw new SmtpError(reply.code === 535 || reply.code === 534 || reply.code === 530 ? 'auth' : 'rejected', `${reply.code} ${reply.lines.at(-1)?.slice(4) ?? ''}`.trim());
    return reply;
  }

  write(text: string): void { this.#socket.write(text); }

  async upgrade(host: string): Promise<void> {
    const old = this.#socket;
    old.removeAllListeners();
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ ...tlsExtra, socket: old, host, servername: net.isIP(host) ? undefined : host }, () => resolve(s));
      s.once('error', (e) => reject(new SmtpError('tls', `TLS failed: ${e.message}`)));
      s.setTimeout(TIMEOUT_MS, () => { s.destroy(); reject(new SmtpError('timeout', 'The mail server did not answer in time')); });
    });
    this.#socket = secure;
    this.#attach(secure);
  }

  close(): void { this.#socket.removeAllListeners('close'); this.#socket.destroy(); }
}

function classify(e: Error): SmtpError {
  const code = (e as NodeJS.ErrnoException).code ?? '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') return new SmtpError('refused', `Could not reach the mail server (${code})`);
  if (code === 'ETIMEDOUT') return new SmtpError('timeout', 'The mail server did not answer in time');
  if (/tls|ssl|certificate|handshake|wrong version/i.test(e.message)) return new SmtpError('tls', `TLS failed: ${e.message}`);
  return new SmtpError('other', e.message);
}

const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export function formatMessage(m: MailMessage, now = new Date()): string {
  const body = Buffer.from(m.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${m.from}`, `To: ${m.to}`, `Subject: ${encodeWord(m.subject)}`, `Date: ${now.toUTCString()}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n');
}

async function connect(account: SmtpAccount): Promise<Session> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = account.security === 'ssl'
      ? tls.connect({ ...tlsExtra, host: account.host, port: account.port, servername: net.isIP(account.host) ? undefined : account.host }, () => resolve(s))
      : net.connect({ host: account.host, port: account.port }, () => resolve(s));
    s.once('error', (e) => reject(account.security === 'ssl' && (e as NodeJS.ErrnoException).code === undefined ? new SmtpError('tls', `TLS failed: ${e.message}`) : classify(e)));
    s.setTimeout(TIMEOUT_MS, () => { s.destroy(); reject(new SmtpError('timeout', 'The mail server did not answer in time')); });
  });
  return new Session(socket);
}

export const smtpTransport: MailTransport = {
  async send(account, message) {
    const session = await connect(account);
    try {
      session.expect(await session.read(), [220]);
      let ehlo = await session.command('EHLO crm.local', [250]);
      if (account.security === 'starttls') {
        if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) throw new SmtpError('tls', 'The mail server does not offer STARTTLS');
        await session.command('STARTTLS', [220]);
        await session.upgrade(account.host);
        ehlo = await session.command('EHLO crm.local', [250]);
      }
      if (account.user) {
        const plain = Buffer.from(`\0${account.user}\0${account.password}`).toString('base64');
        await session.command(`AUTH PLAIN ${plain}`, [235]);
      }
      await session.command(`MAIL FROM:<${message.from}>`, [250]);
      await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await session.command('DATA', [354]);
      session.write(`${formatMessage(message).replace(/^\./gm, '..')}\r\n.\r\n`);
      session.expect(await session.read(), [250]);
      await session.command('QUIT', [221]).catch(() => undefined);
    } finally { session.close(); }
  },
};
