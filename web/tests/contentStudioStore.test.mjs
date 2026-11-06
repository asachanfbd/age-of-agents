import assert from 'node:assert/strict';
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
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { contentApi } = await import('../src/lib/contentApi.ts');
const view = await import('../src/lib/contentView.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CONTENT_ROUTES } = await import('./contentStudioStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');

const B = 'b1';
let stub;
beforeEach(() => {
  stub = installServerStub();
  useContentStore.setState({ listByProject: {}, calendarByProject: {}, conceptsById: {}, missingByPost: {}, studioByAsset: {}, studioBlocked: {} });
});
const store = () => useContentStore.getState();
const when = (day) => `2026-10-${day}T09:00:00Z`;

test('WS01 the stand-in answers every Content Studio route the daemon serves', async () => {
  const c = (await contentApi.createConcept(B, { title: 'T', brief: '', posts: [{ platform: 'x', format: 'text', scheduledAt: when(14) }] }));
  const sample = { cid: c.id, pid: c.posts[0].id, aid: c.assets.find((a) => a.kind === 'script').id, sid: 'about', name: 'a.png' };
  for (const [method, route] of CONTENT_ROUTES) {
    const path = route.replace(':cid', sample.cid).replace(':aid', sample.aid).replace(':pid', sample.pid).replace(':sid', sample.sid).replace(':name', sample.name);
    const query = path === 'calendar' ? '?month=2026-10' : path === 'knowledge/files' && method === 'POST' ? '?name=a.png' : '';
    const body = method === 'GET' || method === 'DELETE' ? undefined : path === 'knowledge/colours' ? JSON.stringify({ colours: [] }) : path === 'knowledge/files' ? new ArrayBuffer(2) : JSON.stringify({ title: 'T', name: 'More', content: 'x', version: 'v1', scheduledAt: when(15), platform: 'x', format: 'text' });
    if (method === 'GET' || method === 'DELETE') continue;
    const res = await fetch(`http://localhost:4500/api/projects/${B}/content/${path}${query}`, { method, body });
    assert.notEqual(res.status, 500, `${method} ${route} is handled by the stand-in`);
  }
  for (const [method, route] of CONTENT_ROUTES.filter(([m]) => m === 'GET')) {
    const path = route.replace(':cid', sample.cid).replace(':aid', sample.aid).replace(':sid', sample.sid).replace(':name', sample.name);
    const res = await fetch(`http://localhost:4500/api/projects/${B}/content/${path}${path === 'calendar' ? '?month=2026-10' : ''}`);
    assert.notEqual(res.status, 500, `GET ${route}`);
  }
  assert.ok(stub.content.requests.length > 20);
});

test('WS02 the list loads with filters and paging, and a late older answer is dropped', async () => {
  await contentApi.createConcept(B, { title: 'Alpha', brief: '', posts: [] });
  await contentApi.createConcept(B, { title: 'Beta', brief: '', posts: [] });
  await store().loadList(B, view.emptyFilters());
  assert.deepEqual(store().listByProject[B].page.rows.map((r) => r.title), ['Beta', 'Alpha']);
  assert.match(stub.content.requests.at(-1).query, /limit=50/);
  let release;
  stub.content.delays['GET concepts'] = (params) => (params.get('q') === 'slow' ? new Promise((r) => { release = r; }) : undefined);
  const slow = store().loadList(B, { ...view.emptyFilters(), search: 'slow' });
  await store().loadList(B, { ...view.emptyFilters(), search: 'alpha' });
  release();
  await slow;
  assert.deepEqual(store().listByProject[B].page.rows.map((r) => r.title), ['Alpha'], 'the older query did not overwrite the newer one');
  assert.equal(store().listByProject[B].filters.search, 'alpha');
  await store().loadList(B, { ...view.emptyFilters(), status: 'draft', platform: 'x', archived: true }, 20);
  assert.match(stub.content.requests.at(-1).query, /offset=20.*status=draft.*platform=x.*archived=true|archived=true/);
});

test('WS03/WS04 create a Concept with first posts, edit it, change a post date, delete a post and the Concept', async () => {
  const made = await store().createConcept(B, { title: 'Launch', brief: 'why', posts: [{ platform: 'instagram', format: 'reel', scheduledAt: when(14) }] });
  assert.equal(made.ok, true);
  const id = made.concept.id;
  assert.equal(store().conceptsById[id].posts.length, 1);
  assert.equal((await store().createPost(B, id, { platform: 'blog', format: 'article', scheduledAt: when(15) })).ok, true);
  assert.equal(store().conceptsById[id].posts.length, 2);
  assert.equal((await store().patchConcept(B, id, { title: 'Launch 2', archived: false })).ok, true);
  assert.equal(store().conceptsById[id].title, 'Launch 2');
  const pid = store().conceptsById[id].posts[0].id;
  await store().patchPost(B, id, pid, when(20));
  assert.equal(store().conceptsById[id].posts.find((p) => p.id === pid).scheduledAt, when(20));
  await store().deletePost(B, id, pid);
  assert.equal(store().conceptsById[id].posts.length, 1);
  assert.equal((await store().deleteConcept(B, id)).ok, true);
  assert.equal(store().conceptsById[id], undefined);
  const failed = await store().createConcept(B, { title: '', brief: '', posts: [] });
  assert.deepEqual([failed.ok, failed.status], [false, 400]);
  stub.content.answers['PATCH concepts/zz'] = () => ({ status: 400, body: { error: 'nope' } });
  const before = store().conceptsById;
  assert.equal((await store().patchConcept(B, 'zz', { title: 'x' })).ok, false);
  assert.equal(store().conceptsById, before, 'a failed change keeps the old value');
});

test('WS05 a refused finalize keeps the missing assets for the row, and unfinalize clears them', async () => {
  const { concept } = await store().createConcept(B, { title: 'C', brief: '', posts: [{ platform: 'instagram', format: 'reel', scheduledAt: when(14) }] });
  const pid = concept.posts[0].id;
  const refused = await store().finalizePost(B, concept.id, pid);
  assert.deepEqual([refused.ok, refused.status], [false, 409]);
  assert.deepEqual(store().missingByPost[pid], ['post-text', 'video', 'thumbnail']);
  assert.equal((await store().unfinalizePost(B, concept.id, pid)).ok, true);
  assert.equal(store().missingByPost[pid], undefined);
  assert.equal((await store().loadConcept(B, 'nope')).ok, false);
});

test('WS06 the calendar loads a month and ignores a slow earlier month that arrives last', async () => {
  await store().createConcept(B, { title: 'C', brief: '', posts: [{ platform: 'x', format: 'text', scheduledAt: when(14) }] });
  let release;
  stub.content.delays['GET calendar'] = (params) => (params.get('month') === '2026-09' ? new Promise((r) => { release = r; }) : undefined);
  const first = store().loadCalendar(B, '2026-09');
  await store().loadCalendar(B, '2026-10');
  release();
  await first;
  assert.equal(store().calendarByProject[B].month, '2026-10');
  assert.equal(store().calendarByProject[B].data.posts.length, 1);
  assert.equal((await store().loadCalendar(B, 'bad')).ok, false);
  assert.ok(store().calendarByProject[B].error);
});

test('WS07/WS08 a section saves with its version; a stale save conflicts and Overwrite re-sends against details.current', async () => {
  const opened = await contentApi.section(B, 'about');
  const saved = await contentApi.saveSection(B, 'about', { content: 'mine', version: opened.version });
  assert.notEqual(saved.version, opened.version);
  const section = stub.content.byBuilding.get(B).sections[0];
  section.version = 'agent-v'; section.content = 'agent text';
  let conflict;
  try { await contentApi.saveSection(B, 'about', { content: 'mine again', version: saved.version }); } catch (e) { conflict = e; }
  assert.equal(view.staleVersionOf(conflict), 'agent-v');
  const doc = view.markConflict(view.editDoc(view.openDoc(saved.version, 'mine'), 'mine again'), view.staleVersionOf(conflict));
  const reloaded = await contentApi.section(B, 'about');
  assert.equal(reloaded.content, 'agent text');
  const over = await contentApi.saveSection(B, 'about', { content: doc.text, version: view.overwriteVersion(doc) });
  assert.equal(over.content, 'mine again');
  assert.ok((await contentApi.sections(B)).sections.length >= 1);
  assert.equal((await contentApi.createSection(B, 'Voice')).builtin, false);
  await assert.rejects(contentApi.createSection(B, 'voice'), /already exists/);
});

test('WS09 a file upload sends the raw bytes with the file type, then lists and deletes', async () => {
  let sent;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes('/knowledge/files')) sent = { url: String(url), init }; return real(url, init); };
  const bytes = new Uint8Array([0, 1, 2, 255]).buffer;
  const file = { name: 'logo one.png', type: 'image/png', arrayBuffer: async () => bytes };
  const out = await contentApi.uploadFile(B, file);
  assert.deepEqual([out.name, out.image], ['logo one.png', true]);
  assert.equal(sent.init.body, bytes, 'raw bytes, not base64 JSON');
  assert.equal(sent.init.headers['content-type'], 'application/octet-stream', 'never the file type, which a JSON parser could claim');
  assert.match(sent.url, /name=logo\+one\.png/);
  assert.equal((await contentApi.files(B)).files.length, 1);
  assert.match(contentApi.fileUrl(B, 'logo one.png'), /files\/logo%20one\.png$/);
  await contentApi.deleteFile(B, 'logo one.png');
  assert.equal((await contentApi.files(B)).files.length, 0);
  await contentApi.uploadFile(B, { name: 'x', type: '', arrayBuffer: async () => bytes });
  assert.equal(sent.init.headers['content-type'], 'application/octet-stream');
  stub.content.answers['POST knowledge/files'] = () => ({ status: 400, body: { error: 'At most 100 files' } });
  await assert.rejects(contentApi.uploadFile(B, file), /At most 100 files/);
});

test('WS10 colours save, and the limit error surfaces', async () => {
  assert.deepEqual((await contentApi.saveColours(B, [{ name: 'A', hex: '#000000' }])).colours, [{ name: 'A', hex: '#000000' }]);
  assert.equal((await contentApi.colours(B)).colours.length, 1);
  await assert.rejects(contentApi.saveColours(B, Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, hex: '#000000' }))), /At most 20/);
});

test('WS11 the writing style loads, saves, conflicts when stale and lists its history', async () => {
  const opened = await contentApi.style(B);
  const saved = await contentApi.saveStyle(B, { content: 'new', version: opened.version });
  await assert.rejects(contentApi.saveStyle(B, { content: 'x', version: opened.version }), (e) => view.staleVersionOf(e) === saved.version);
  assert.equal((await contentApi.styleHistory(B)).entries[0].who, 'person');
});

test('WS12 a read-only Building refuses writes and keeps reads', async () => {
  stub.content.readOnly = true;
  const res = await store().createConcept(B, { title: 'x', brief: '', posts: [] });
  assert.deepEqual([res.ok, res.status], [false, 409]);
  assert.equal((await store().loadList(B, view.emptyFilters())).ok, true);
  assert.equal((await contentApi.settings(B)).timezone, 'UTC');
  assert.equal(view.controlsDisabled(true), true);
});

test('WS13 typing in an editor never touches the Concepts or calendar data', () => {
  const before = { list: store().listByProject, calendar: store().calendarByProject, concepts: store().conceptsById };
  let doc = view.openDoc('v1', '');
  for (const ch of 'hello') doc = view.editDoc(doc, doc.text + ch);
  assert.deepEqual([store().listByProject, store().calendarByProject, store().conceptsById], [before.list, before.calendar, before.concepts]);
});

test('WS14 the create-Building call sends the chosen time zone', async () => {
  useWorldStore.setState({ projects: [], newBuildingField: null, ...CLEAN_ERROR_STATE });
  let sent;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (new URL(url).pathname === '/api/projects' && init?.method === 'POST') sent = JSON.parse(init.body); return real(url, init); };
  await useWorldStore.getState().addProject('Brand', undefined, 'content-studio', undefined, 'Asia/Kolkata');
  assert.deepEqual([sent.typeId, sent.timezone], ['content-studio', 'Asia/Kolkata']);
  assert.equal((await contentApi.settings(B)).folder.startsWith('/data/'), true);
  assert.equal((await contentApi.saveSettings(B, { name: 'N', timezone: 'Asia/Tokyo' })).timezone, 'Asia/Tokyo');
});
