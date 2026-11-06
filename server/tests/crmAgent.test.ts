import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCrmAgent } from '../src/crm/crmAgent.ts';
import { tick } from '../src/crm/engine.ts';
import { createContact } from '../src/crm/contacts.ts';
import { approveItem } from '../src/crm/email.ts';
import { createReachout } from '../src/crm/followups.ts';
import { harness } from './helpers/crmFakes.ts';

type Opts = { prompt: string; appendSystemPrompt: string; disallowedTools: string[]; cwd: string };
const deps = (result: { status: string; message: string; extra?: Record<string, unknown> }, executor: unknown = {}) => {
  const seen: Opts[] = [];
  return { seen, deps: { selectExecutor: async () => executor, runTurn: async (_e: unknown, o: Opts) => { seen.push(o); return result; } } };
};

test('the CRM agent gives a drafting turn no tools and a MOM turn all tools, in the Building folder', async () => {
  const ok = deps({ status: 'done', message: 'ok', extra: { text: 'the text' } });
  const agent = createCrmAgent(() => 'b1', async () => '/work', ok.deps as never);
  assert.equal(await agent.run({ kind: 'message', prompt: 'p1' }), 'the text');
  assert.equal(await agent.run({ kind: 'mom', prompt: 'p2' }), 'the text');
  assert.ok(ok.seen[0]!.disallowedTools.includes('Bash'));
  assert.deepEqual(ok.seen[1]!.disallowedTools, []);
  assert.deepEqual(ok.seen.map((s) => s.cwd), ['/work', '/work']);
  assert.match(ok.seen[1]!.appendSystemPrompt, /any tool available/);
});

test('the CRM agent fails with a clear message when no agent is usable or the answer is not done', async () => {
  const none = createCrmAgent(() => 'b1', async () => '/w', { selectExecutor: async () => null, runTurn: async () => ({ status: 'done', message: '' }) } as never);
  await assert.rejects(none.run({ kind: 'message', prompt: 'x' }), /No agent is available/);
  const bad = createCrmAgent(() => 'b1', async () => '/w', deps({ status: 'failed', message: 'it broke' }).deps as never);
  await assert.rejects(bad.run({ kind: 'mom', prompt: 'x' }), /did not answer: it broke/);
  const noText = createCrmAgent(() => 'b1', async () => '/w', deps({ status: 'done', message: 'm', extra: {} }).deps as never);
  await assert.rejects(noText.run({ kind: 'mom', prompt: 'x' }), /did not answer/);
});

test('an approved email that became do-not-contact before it was sent is cancelled by the tick instead of retried forever', async () => {
  const h = harness();
  h.ctx.saveSettings({ ...h.ctx.settings(), smtp: { host: 'h', port: 25, security: 'none', user: '', from: 'me@x.com' } });
  await h.ctx.secrets.set('crm.smtp.password', 'pw');
  const c = createContact(h.ctx, { channels: [{ type: 'email', handle: 'a@x.com' }] });
  const f = createReachout(h.ctx, c.id, { channelId: c.channels[0]!.id, message: 'hi' }).followup;
  approveItem(h.ctx, f.id);
  h.ctx.db.prepare('UPDATE contacts SET dnc = 1 WHERE id = ?').run(c.id);
  await tick(h.ctx);
  assert.equal((h.ctx.db.prepare('SELECT state FROM followups WHERE id = ?').get(f.id) as { state: string }).state, 'cancelled');
  assert.equal(h.transport.sent.length, 0);
});
