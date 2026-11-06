import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { SmtpError } from '../src/crm/context.ts';
import { formatMessage, setSmtpTimeout, setSmtpTlsOptions, smtpTransport } from '../src/crm/smtpClient.ts';
import { fakeSmtpServer } from './helpers/crmFakes.ts';
import type { TlsPair } from './helpers/crmFakes.ts';

let pair: TlsPair;
let servers: Array<{ close(): Promise<void> }> = [];
before(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crm-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  pair = { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'c.pem'), 'utf8') };
  setSmtpTimeout(1500);
});
after(() => { setSmtpTlsOptions({}); });
afterEach(async () => { setSmtpTlsOptions({}); for (const s of servers) await s.close(); servers = []; });

const account = (port: number) => ({ host: '127.0.0.1', port, security: 'starttls' as const, user: 'me', password: 'pw-starttls-1' });
const message = { from: 'me@x.com', to: 'you@x.com', subject: 'Hello', text: 'Body' };
const start = async (mode: Parameters<typeof fakeSmtpServer>[0], tlsPair?: TlsPair) => { const s = await fakeSmtpServer(mode, tlsPair); servers.push(s); return s; };
const kindOf = async (work: Promise<unknown>) => { try { await work; return 'sent'; } catch (e) { assert.ok(e instanceof SmtpError); return e.kind; } };

test('STARTTLS: the client upgrades, logs in over TLS and sends the message', async () => {
  setSmtpTlsOptions({ ca: pair.cert });
  const s = await start('ok', pair);
  await smtpTransport.send(account(s.port), message);
  assert.deepEqual([s.received.length, s.received[0]!.auth, s.received[0]!.to], [1, '\0me\0pw-starttls-1', 'you@x.com']);
});

test('STARTTLS: a certificate the client does not trust fails as a TLS error and nothing is sent', async () => {
  const s = await start('ok', pair);
  assert.equal(await kindOf(smtpTransport.send(account(s.port), message)), 'tls');
  assert.equal(s.received.length, 0);
});

test('STARTTLS: a server that answers 220 and then breaks the handshake fails as a TLS error', async () => {
  const s = await start('broken-tls', pair);
  assert.equal(await kindOf(smtpTransport.send(account(s.port), message)), 'tls');
});

test('STARTTLS: a server that does not offer it is refused without sending the password', async () => {
  const s = await start('ok');
  const error = await smtpTransport.send(account(s.port), message).catch((e: SmtpError) => e);
  assert.ok(error instanceof SmtpError);
  assert.deepEqual([error.kind, /does not offer STARTTLS/.test(error.message)], ['tls', true]);
  assert.equal(s.received.length, 0);
});

test('the message formatter encodes a non-ASCII subject and dot-stuffs nothing into headers', () => {
  const text = formatMessage({ ...message, subject: 'Grüße' }, new Date('2026-03-16T09:00:00Z'));
  assert.match(text, /Subject: =\?UTF-8\?B\?/);
  assert.match(text, /Content-Transfer-Encoding: base64/);
});
