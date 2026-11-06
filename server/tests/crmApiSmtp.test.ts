import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { WebSocket } from 'ws';
import { setSmtpTimeout, smtpTransport } from '../src/crm/smtpClient.ts';
import { startCrmApi } from './helpers/crmApi.ts';
import type { CrmApi } from './helpers/crmApi.ts';
import { fakeSmtpServer } from './helpers/crmFakes.ts';
import type { SmtpMode } from './helpers/crmFakes.ts';

const PASSWORD = 'Tr0ub4dor&3-unique-password';
let t: CrmApi;
let id: string;
let smtp: Awaited<ReturnType<typeof fakeSmtpServer>>;
const logs: string[] = [];
const wsMessages: string[] = [];
let ws: WebSocket;
const realConsole = { log: console.log, error: console.error, warn: console.warn };

before(async () => {
  t = await startCrmApi();
  setSmtpTimeout(400);
  for (const level of ['log', 'error', 'warn'] as const) console[level] = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(' ')); };
  ws = new WebSocket(`${t.baseUrl.replace('http', 'ws')}/ws`);
  ws.on('message', (m) => wsMessages.push(String(m)));
  await new Promise((r) => ws.once('open', r));
});
after(async () => { Object.assign(console, realConsole); ws.terminate(); await new Promise((r) => setTimeout(r, 50)); await t.stop(); });
beforeEach(async () => {
  t.reset();
  t.overrides({ transport: smtpTransport });
  smtp = await fakeSmtpServer('ok');
  id = await t.createCrm();
  await configure();
});

afterEach(async () => { await smtp.close(); });

const post = (suffix: string, body: unknown = {}) => t.send('POST', t.crm(id, suffix), body);
const get = (suffix: string) => t.api(t.crm(id, suffix));
const configure = (extra: Record<string, unknown> = {}) => t.send('PATCH', t.crm(id, '/settings'), { smtp: { host: '127.0.0.1', port: smtp.port, security: 'none', user: 'me@sales.test', from: 'me@sales.test', password: PASSWORD, ...extra } });
const mk = async (email: string) => (await post('/contacts', { name: 'Ann', channels: [{ type: 'email', handle: email }] })).body;
const reach = async (c: { id: number; channels: Array<{ id: number }> }, message = 'Hello there') => (await post(`/contacts/${c.id}/reachouts`, { channelId: c.channels[0]!.id, message })).body;
const send = async (email: string, message?: string) => { const c = await mk(email); const r = await reach(c, message); return { c, r, res: await post(`/followups/${r.id}/approve`, {}) }; };
const close = async () => { await smtp.close(); };
const status = async () => (await get('/settings')).body.smtp.status;

test('I068 the fake SMTP server receives from, to, subject, body and the opt-out footer exactly once, with a real login', async () => {
  const { res, r } = await send('ann@x.com', 'Hi Ann');
  assert.deepEqual([res.body.delivery, res.body.followup.state], [{ sent: true }, 'sent']);
  assert.equal(smtp.received.length, 1);
  const m = smtp.received[0]!;
  assert.deepEqual([m.from, m.to, m.auth], ['me@sales.test', 'ann@x.com', `\0me@sales.test\0${PASSWORD}`]);
  const raw = m.data.replace(/\r\n/g, '\n');
  const body = Buffer.from(raw.split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8');
  assert.match(raw, /Subject: Hello/);
  assert.ok(body.startsWith('Hi Ann'));
  assert.equal(body.split('unsubscribe').length - 1, 1, 'the footer appears once');
  await patchFooter('');
  t.clock.now += 61_000;
  await send('b@x.com', 'No footer');
  const plain = Buffer.from(smtp.received[1]!.data.replace(/\r\n/g, '\n').split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8');
  assert.equal(plain, 'No footer', 'an empty footer appends nothing');
  assert.ok(r.id);
  await close();
});
const patchFooter = (emailFooter: string) => t.send('PATCH', t.crm(id, '/settings'), { emailFooter });

test('I069 a do-not-contact contact or channel, or an invalid channel, is refused with 409 and nothing reaches the server', async () => {
  const a = await mk('a@x.com'), b = await mk('b@x.com');
  const ra = await reach(a), rb = await reach(b);
  await t.send('PUT', t.crm(id, `/contacts/${a.id}/dnc`), { dnc: true });
  assert.equal((await post(`/followups/${ra.id}/approve`, {})).status, 409);
  await t.send('PATCH', t.crm(id, `/contacts/${b.id}/channels/${b.channels[0].id}`), { dnc: true });
  assert.equal((await post(`/followups/${rb.id}/approve`, {})).status, 409);
  const c = await mk('c@x.com');
  assert.equal((await post(`/contacts/${c.id}/reachouts`, { channelId: c.channels[0].id, message: 'x' })).status, 201);
  await t.send('PATCH', t.crm(id, `/contacts/${c.id}/channels/${c.channels[0].id}`), { invalid: true });
  assert.equal(smtp.received.length, 0);
  await close();
});

test('I070 the 51st email of the day is held as "delayed by daily cap" and goes out the next day; sends are at least 60 seconds apart', async () => {
  for (let i = 0; i < 50; i++) { t.clock.now += 61_000; const { res } = await send(`u${i}@x.com`); assert.equal(res.body.delivery.sent, true, `email ${i + 1}`); }
  assert.equal(smtp.received.length, 50);
  t.clock.now += 61_000;
  const c = await mk('last@x.com'); const r = await reach(c);
  const held = await post(`/followups/${r.id}/approve`, {});
  assert.deepEqual([held.body.delivery, held.body.followup.state, held.body.followup.delayReason], [{ sent: false, delayed: 'delayed by daily cap' }, 'approved', 'delayed by daily cap']);
  assert.ok((await get(`/contacts/${c.id}/timeline`)).body.rows.some((e: { kind: string; text: string }) => e.kind === 'reachout_delayed' && /daily cap/.test(e.text)));
  await post('/tick');
  assert.equal(smtp.received.length, 50, 'still held the same day');
  t.clock.now = Date.parse('2026-03-17T00:30:00Z'); await post('/tick');
  assert.equal(smtp.received.length, 51);
  assert.equal((await get(`/followups/${r.id}`)).body.state, 'sent');
  await close();
});

test('I071 SMTP down: the item fails with a reason, the retry rules apply, and a notification is raised that the connection needs attention', async () => {
  await close();
  const runtime = await import('../src/crm/runtime.ts');
  runtime.setCrmOverrides({ now: () => t.clock.now, deps: { transport: smtpTransport, agent: t.agent, buildings: t.buildings } });
  const c = await mk('down@x.com'); const r = await reach(c);
  const res = await post(`/followups/${r.id}/approve`, {});
  assert.equal(res.status, 200);
  assert.match(res.body.delivery.failed, /could not be reached/);
  const item = (await get(`/followups/${r.id}`)).body;
  assert.deepEqual([item.state, item.tries, item.retryAt], ['failed', 1, t.clock.now + 2 * 3_600_000]);
  let notes = await t.notificationsDb.find((n) => n.kind === 'crm.connection_needs_attention');
  for (let i = 0; i < 50 && notes.length === 0; i++) { await new Promise((w) => setTimeout(w, 20)); notes = await t.notificationsDb.find((n) => n.kind === 'crm.connection_needs_attention'); }
  assert.deepEqual([notes.length, notes[0]!.severity, notes[0]!.subject, notes[0]!.resolvedAt], [1, 'warning', { type: 'project', projectId: id }, null]);
  assert.equal((await status()).state, 'needs_attention');
  t.clock.now += 2 * 3_600_000 - 1; await post('/tick');
  assert.equal((await get(`/followups/${r.id}`)).body.state, 'failed', 'not before the retry delay');
  t.clock.now += 1; await post('/tick');
  assert.equal((await get(`/followups/${r.id}`)).body.state, 'pending', 'back for approval after 2 hours');
  t.overrides({ transport: smtpTransport });
});

test('I072 each failure kind gives a distinct reason and none contains the password', async () => {
  const reasons = new Map<string, string>();
  const attempt = async (label: string, mode: SmtpMode, extra: Record<string, unknown> = {}) => {
    smtp.state.mode = mode; await configure(extra);
    const { res } = await send(`${label}@x.com`);
    reasons.set(label, res.body.delivery?.failed ?? res.text);
  };
  await attempt('auth', 'auth-fail');
  await attempt('rejected', 'reject-rcpt');
  await attempt('server5xx', 'server-5xx');
  await attempt('drop', 'drop');
  await attempt('timeout', 'hang');
  await attempt('tls', 'ok', { security: 'ssl' });
  await close();
  await attempt('refused', 'ok');
  assert.match(reasons.get('auth')!, /refused the login/);
  assert.match(reasons.get('rejected')!, /rejected the message: 550/);
  assert.match(reasons.get('server5xx')!, /rejected the message: 554/);
  assert.match(reasons.get('timeout')!, /did not answer in time/);
  assert.match(reasons.get('tls')!, /secure connection failed|TLS/);
  assert.match(reasons.get('refused')!, /could not be reached/);
  assert.equal(new Set(reasons.values()).size, reasons.size, 'every kind reads differently');
  for (const reason of reasons.values()) assert.ok(!reason.includes(PASSWORD));
});

test('I073 the status is not connected before saving, connected after a successful test, needs attention after a failed send, and clears after a success', async () => {
  const fresh = await t.createCrm('Fresh');
  assert.equal((await t.api(t.crm(fresh, '/settings'))).body.smtp.status.state, 'not_connected');
  assert.equal((await status()).state, 'not_connected', 'saved but never tested');
  assert.equal((await post('/settings/smtp/test', { to: 'me@x.com' })).status, 200);
  assert.deepEqual([(await status()).state, (await status()).reason], ['connected', null]);
  smtp.state.mode = 'auth-fail';
  await send('fail@x.com');
  const bad = await status();
  assert.deepEqual([bad.state, /refused the login/.test(bad.reason)], ['needs_attention', true]);
  smtp.state.mode = 'ok'; t.clock.now += 120_000;
  await send('ok@x.com');
  assert.equal((await status()).state, 'connected');
  assert.ok(t.resolved.n >= 0);
  await close();
});

test('I074 a test send to a valid address sends one message; a missing or invalid address is 400; a refused SMTP answers 502 { error }', async () => {
  assert.equal((await post('/settings/smtp/test', { to: 'me@x.com' })).status, 200);
  assert.equal(smtp.received.length, 1);
  for (const bad of [undefined, '', 'nope', 5]) assert.equal((await post('/settings/smtp/test', { to: bad })).status, 400);
  smtp.state.mode = 'auth-fail';
  const refused = await post('/settings/smtp/test', { to: 'me@x.com' });
  assert.deepEqual([refused.status, typeof refused.body.error], [502, 'string']);
  assert.ok(!refused.text.includes(PASSWORD));
  const unset = await t.createCrm('Unset');
  assert.equal((await t.send('POST', t.crm(unset, '/settings/smtp/test'), { to: 'me@x.com' })).status, 409);
  await close();
});

test('I075 the password is write-only: GET returns only passwordSaved; a PATCH without it keeps it; an empty string clears it', async () => {
  let read = (await get('/settings')).body.smtp;
  assert.equal(read.status.passwordSaved, true);
  assert.ok(!('password' in read));
  await t.send('PATCH', t.crm(id, '/settings'), { smtp: { host: 'other.host' } });
  assert.equal((await get('/settings')).body.smtp.status.passwordSaved, true);
  await t.send('PATCH', t.crm(id, '/settings'), { smtp: { password: '' } });
  read = (await get('/settings')).body.smtp;
  assert.deepEqual([read.status.passwordSaved, read.host], [false, 'other.host']);
  assert.equal((await t.send('PATCH', t.crm(id, '/settings'), { smtp: { password: 5 } })).status, 400);
  await close();
});

test('I076 the password value appears nowhere: responses, error bodies, logs, WebSocket events, notifications, timelines, the database file', async () => {
  const bodies: string[] = [];
  const grab = async (res: Promise<{ text: string }>) => { bodies.push((await res).text); };
  await grab(get('/settings'));
  await grab(t.send('PATCH', t.crm(id, '/settings'), { smtp: { password: PASSWORD } }));
  await grab(post('/settings/smtp/test', { to: 'me@x.com' }));
  smtp.state.mode = 'auth-fail';
  await grab(post('/settings/smtp/test', { to: 'me@x.com' }));
  const { c, r } = await send('leak@x.com'); await grab(Promise.resolve({ text: JSON.stringify(r) }));
  await grab(get(`/followups/${r.id}`)); await grab(get(`/contacts/${c.id}/timeline?limit=200`)); await grab(get('/contacts?search=leak')); await grab(get('/calendar')); await grab(get('/expand-today'));
  await grab(t.api('/api/notifications'));
  const notes = JSON.stringify(await t.notificationsDb.find(() => true));
  await new Promise((res) => setTimeout(res, 100));
  const db = (await readFile(path.join(t.dataDir, 'buildings', id, 'crm.sqlite'))).toString('latin1');
  const wal = await readFile(path.join(t.dataDir, 'buildings', id, 'crm.sqlite-wal')).then((b) => b.toString('latin1'), () => '');
  for (const [where, text] of [['responses', bodies.join('\n')], ['logs', logs.join('\n')], ['websocket', wsMessages.join('\n')], ['notifications', notes], ['database', db + wal]] as const) {
    assert.ok(!text.includes(PASSWORD), `the password leaked into ${where}`);
  }
  await close();
});

test('I109 across this whole file no captured log line contains the password', () => {
  assert.ok(!logs.join('\n').includes(PASSWORD));
  assert.ok(!wsMessages.join('\n').includes(PASSWORD));
});

test('a GET of the calendar or Expand Today never sends mail or writes; only POST /tick does', async () => {
  const first = await send('first@x.com');
  assert.equal(first.res.body.delivery.sent, true);
  const c = await mk('second@x.com'); const r = await reach(c);
  const held = await post(`/followups/${r.id}/approve`, {});
  assert.equal(held.body.delivery.delayed, 'waiting between sends');
  t.clock.now += 61_000;
  const before = (await get(`/contacts/${c.id}/timeline`)).body.total;
  await get('/calendar'); await get('/expand-today');
  assert.equal(smtp.received.length, 1, 'reads send nothing');
  assert.equal((await get(`/contacts/${c.id}/timeline`)).body.total, before, 'reads write nothing');
  const out = await post('/tick');
  assert.deepEqual([out.status, out.body.sent], [200, 1]);
  assert.equal(smtp.received.length, 2);
});
