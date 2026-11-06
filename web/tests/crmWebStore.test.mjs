import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { afterEach, beforeEach, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { useCrmStore, crmFailure } = await import('../src/store/crmStore.ts');
const { crmApi } = await import('../src/lib/crmApi.ts');
const { ApiError } = await import('../src/lib/serverApi.ts');
const prospects = await import('../src/lib/crmProspects.ts');

const realFetch = globalThis.fetch;
let calls;
let handler;
beforeEach(() => {
  calls = [];
  handler = () => ({ status: 200, body: { rows: [], total: 0, limit: 50, offset: 0, hasMore: false } });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    const out = await handler(String(url), init);
    return new Response(out.status === 204 ? null : JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  };
  useCrmStore.setState({ contactsByProject: {}, settingsByProject: {} });
});
afterEach(() => { globalThis.fetch = realFetch; });

test('C007 a filter or search change starts at page 1, and a late answer for an old query is ignored', async () => {
  const q0 = prospects.initialQuery();
  const paged = prospects.withOffset(q0, 100);
  const filtered = prospects.withFilter(paged, { search: 'rossi' });
  assert.equal(filtered.offset, 0);
  assert.equal(prospects.withFilter(paged, { stage: 'New' }).offset, 0);
  assert.equal(prospects.withOffset(filtered, -5).offset, 0);
  let release;
  const gate = new Promise((r) => { release = r; });
  handler = async (url) => {
    if (url.includes('search=old')) { await gate; return { status: 200, body: { rows: [{ id: 1 }], total: 1, limit: 50, offset: 0, hasMore: false } }; }
    return { status: 200, body: { rows: [{ id: 2 }], total: 1, limit: 50, offset: 0, hasMore: false } };
  };
  const slow = useCrmStore.getState().loadContacts('p', { ...q0, search: 'old' });
  await new Promise((r) => setTimeout(r, 10));
  await useCrmStore.getState().loadContacts('p', { ...q0, search: 'new' });
  release();
  await slow;
  const view = useCrmStore.getState().contactsByProject.p;
  assert.deepEqual([view.page.rows[0].id, view.query.search, view.loading], [2, 'new', false], 'the old query resolved last and was dropped');
});

test('C027 the client sends limit and offset, maps { error } to a result, handles 404 and 409, and keeps no secret in state', async () => {
  await useCrmStore.getState().loadContacts('proj', { ...prospects.initialQuery(), offset: 100, search: ' ann ', segment: 'prospect' });
  assert.equal(calls[0].url.endsWith('/api/projects/proj/crm/contacts?search=ann&segment=prospect&limit=50&offset=100'), true, calls[0].url);
  handler = () => ({ status: 404, body: { error: 'That contact does not exist' } });
  const missing = await useCrmStore.getState().loadContacts('proj', prospects.initialQuery());
  assert.deepEqual([missing.ok, missing.status, missing.error], [false, 404, 'That contact does not exist']);
  assert.equal(useCrmStore.getState().contactsByProject.proj.error, 'That contact does not exist');
  handler = () => ({ status: 409, body: { error: 'Cannot undo', code: 'crm-conflict', details: { reason: 'handle in use' } } });
  await assert.rejects(crmApi.undoMerge('proj', 3), (e) => e instanceof ApiError && e.status === 409 && e.details.details.reason === 'handle in use');
  assert.deepEqual(crmFailure(new Error('boom')), { ok: false, status: 0, error: 'boom', details: {} });
  handler = () => ({ status: 200, body: { smtp: { host: 'h', port: 587, security: 'starttls', user: 'u', from: 'f@x', status: { state: 'connected', reason: null, passwordSaved: true, configured: true } } } });
  await useCrmStore.getState().saveSettings('proj', { smtp: { password: 'super-secret-pw' } });
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.ok(!JSON.stringify(useCrmStore.getState()).includes('super-secret-pw'), 'the password is only sent, never kept');
  await crmApi.deleteComment('proj', 1, 2).catch(() => undefined);
  await crmApi.uploadMomFile('proj', 4, 'audio', new File([new Uint8Array(3)], 'voice note.m4a'));
  assert.equal(calls.at(-1).method, 'POST');
  assert.match(calls.at(-1).url, /\/moms\/4\/files\?kind=audio&name=voice\+note\.m4a$/);
  assert.match(crmApi.momFileUrl('p', 1, 2), /^https?:\/\/.+\/api\/projects\/p\/crm\/moms\/1\/files\/2$/);
  assert.match(crmApi.reportExportUrl('p', { period: 'week', table: 'summary' }), /\/api\/projects\/p\/crm\/reports\/export\?period=week&table=summary$/);
});
