import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { useContentStore } = await import('../src/store/contentStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const view = await import('../src/lib/contentView.ts');
const { LEARN_CONFLICT } = await import('../src/lib/contentImport.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CONTENT_ROUTES } = await import('./contentStudioStub.mjs');

/** The import session and Learn against the daemon stand-in (W15-W24 in the Test Case Planning list). */

const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ listByProject: {}, conceptsById: {}, importByProject: {}, learnByConcept: {}, proposalsByProject: {} });
});
const store = () => useContentStore.getState();
const building = () => stub.content.byBuilding.get(B);
const posts = (id) => stub.content.requests.filter((r) => r.method === 'POST' && r.path.includes(id));
async function importedConcept() {
  const c = await contentApi.createConcept(B, { title: 'Past', brief: '', posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-03-14T09:00:00Z' }] });
  building().concepts.find((x) => x.id === c.id).imported = true;
  return c;
}

test('W15 the client calls the five import-session routes, the two learn routes and sends imported', async () => {
  const seen = () => stub.content.requests.map((r) => `${r.method} ${r.path}`);
  const c = await importedConcept();
  await contentApi.importSession(B);
  await contentApi.startImportSession(B);
  await contentApi.importSessionAction(B, 'end');
  await contentApi.importSessionAction(B, 'resume');
  await contentApi.importSessionAction(B, 'end');
  await contentApi.importSessionAction(B, 'new');
  await contentApi.learnStatus(B, c.id);
  await contentApi.startLearn(B, c.id);
  for (const route of ['GET import-session', 'POST import-session', 'POST import-session/end', 'POST import-session/resume', 'POST import-session/new', `GET concepts/${c.id}/learn`, `POST concepts/${c.id}/learn`]) assert.ok(seen().includes(route), route);
  await contentApi.concepts(B, view.listParams({ ...view.emptyFilters(), imported: 'false' }));
  assert.match(stub.content.requests.at(-1).query, /imported=false/);
});

test('W16 load, start, resume, new and end follow the server', async () => {
  await store().openImport(B, false);
  assert.equal(store().importByProject[B].session, null);
  await store().openImport(B, true);
  const first = store().importByProject[B].session.id;
  assert.equal(store().importByProject[B].session.state, 'running');
  await store().importAction(B, 'end');
  assert.equal(store().importByProject[B].session.state, 'ended');
  await store().importAction(B, 'resume');
  assert.deepEqual([store().importByProject[B].session.id, store().importByProject[B].session.state], [first, 'running']);
  await store().importAction(B, 'end');
  await store().importAction(B, 'new');
  assert.notEqual(store().importByProject[B].session.id, first);
});

test('W17 a start with no agent keeps the reason; an "already running" refusal shows the running session', async () => {
  stub.content.byBuilding.delete(B);
  await contentApi.importSession(B);
  building().imports.agent = false;
  const opened = await store().openImport(B, true);
  assert.equal(opened.ok, true);
  assert.equal(store().importByProject[B].blockedReason, 'No default coding agent is set');
  assert.equal(store().importByProject[B].session, null);
  // Blocked: a reopen does not try again by itself.
  const before = stub.content.requests.length;
  await store().openImport(B, true);
  assert.equal(stub.content.requests.slice(before).filter((r) => r.method === 'POST').length, 0);
  building().imports.agent = true;
  await store().importAction(B, 'start');
  useContentStore.setState({ importByProject: {} });
  const second = await store().importAction(B, 'start');
  assert.deepEqual([second.ok, second.status], [false, 409]);
  assert.equal(store().importByProject[B].session.state, 'running');
});

test('W18 a live event updates the view; an older one is dropped; another Building is ignored', async () => {
  await store().openImport(B, true);
  const current = store().importByProject[B];
  const event = (buildingId, rev, state) => ({ type: 'contentImportSession', buildingId, view: { ...current, rev, session: { ...current.session, state } } });
  store().applyStudioEvent(event(B, current.rev + 5, 'ended'));
  assert.equal(store().importByProject[B].session.state, 'ended');
  store().applyStudioEvent(event(B, current.rev + 1, 'running'));
  assert.equal(store().importByProject[B].session.state, 'ended');
  store().applyStudioEvent(event('other', 999, 'running'));
  assert.equal(store().importByProject.other, undefined);
});

test('W19 the session event changes no world state, so the 3D scene never redraws for it', () => {
  const src = readFileSync(new URL('../src/store/worldStore.ts', import.meta.url), 'utf8');
  assert.match(src, /event\.type === 'contentImportSession' \|\| event\.type === 'remotionStudio'\) return \{\};/);
  assert.match(src, /event\.type === 'contentImportSession'\) useContentStore\.getState\(\)\.applyStudioEvent\(event\)/);
});

test('W20 a save refreshes the Concept list that is shown, at its page and filters', async () => {
  const filters = { ...view.emptyFilters(), search: 'past' };
  await store().loadList(B, filters, 0);
  await store().openImport(B, true);
  const c = await importedConcept();
  const before = stub.content.requests.filter((r) => r.path === 'concepts' && r.method === 'GET').length;
  const current = store().importByProject[B];
  store().applyStudioEvent({ type: 'contentImportSession', buildingId: B, view: { ...current, rev: current.rev + 1, saved: [{ ...c, imported: true }] } });
  store().applyStudioEvent({ type: 'contentImportSession', buildingId: B, view: { ...current, rev: current.rev + 2, saved: [{ ...c, imported: true }] } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const list = stub.content.requests.filter((r) => r.path === 'concepts' && r.method === 'GET');
  assert.equal(list.length, before + 1, 'only a new save reloads');
  assert.match(list.at(-1).query, /q=past/);
});

test('W21 Learn sets running at once; a second start is refused with the conflict text', async () => {
  const c = await importedConcept();
  assert.equal((await store().startLearn(B, c.id)).ok, true);
  assert.equal(store().learnByConcept[c.id].status.status, 'running');
  const second = await store().startLearn(B, c.id);
  assert.deepEqual([second.ok, second.status], [false, 409]);
  assert.equal(store().learnByConcept[c.id].refusal, LEARN_CONFLICT);
  assert.equal(store().learnByConcept[c.id].status.status, 'running');
  const normal = await contentApi.createConcept(B, { title: 'N', brief: '', posts: [] });
  await store().startLearn(B, normal.id);
  assert.match(store().learnByConcept[normal.id].refusal, /only on an imported Concept/);
});

test('W21b a run that already ended when the start answers shows its result, not Learning…', async () => {
  const c = await importedConcept();
  stub.content.answers[`POST concepts/${c.id}/learn`] = () => {
    building().learn.set(c.id, { status: 'failed', reason: 'No agent', at: 'x' });
    return { status: 202, body: { status: 'running' } };
  };
  assert.equal((await store().startLearn(B, c.id)).ok, true);
  assert.equal(store().learnByConcept[c.id].status.status, 'failed');
});

test('W21c deleting an imported Concept removes it from the store', async () => {
  const c = await importedConcept();
  await store().loadConcept(B, c.id);
  assert.equal((await store().deleteConcept(B, c.id)).ok, true);
  assert.equal(store().conceptsById[c.id], undefined);
  assert.equal(stub.content.requests.at(-1).method, 'DELETE');
});

test('W22 contentRetro for a shown Concept refreshes its learn state and the proposals; another Concept is left alone', async () => {
  const c = await importedConcept();
  await store().startLearn(B, c.id);
  await store().loadProposals(B);
  building().learn.set(c.id, { status: 'proposal', proposalId: 'p9', at: 'x' });
  const before = stub.content.requests.length;
  store().applyStudioEvent({ type: 'contentRetro', buildingId: B, conceptId: 'someone-else', assetId: 'a' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!stub.content.requests.slice(before).some((r) => r.path.endsWith('/learn')));
  assert.equal(store().learnByConcept[c.id].status.status, 'running');
  store().applyStudioEvent({ type: 'contentRetro', buildingId: B, conceptId: c.id, assetId: 'a' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store().learnByConcept[c.id].status.status, 'proposal');
});

test('W23 opening an imported Concept makes no POST to any session route', async () => {
  const c = await importedConcept();
  await store().loadConcept(B, c.id);
  await store().loadLearn(B, c.id);
  assert.equal(store().conceptsById[c.id].imported, true);
  assert.equal(posts('/session').length, 0);
  // The Concept view draws ImportedTab, the only path that reaches a session is the agent panes it replaces.
  const src = readFileSync(new URL('../src/ui/content/ConceptView.tsx', import.meta.url), 'utf8');
  assert.match(src, /importedTab\s*\n\s*\? <ImportedTab/);
});

test('W24 the stand-ins answer the import-session and learn routes', async () => {
  const routes = CONTENT_ROUTES.map(([m, r]) => `${m} ${r}`);
  for (const route of ['GET import-session', 'POST import-session', 'POST import-session/resume', 'POST import-session/new', 'POST import-session/end', 'GET concepts/:cid/learn', 'POST concepts/:cid/learn']) assert.ok(routes.includes(route), route);
  const res = await fetch(`http://localhost:4500/api/projects/${B}/content/import-session`);
  assert.equal(res.status, 200);
});
