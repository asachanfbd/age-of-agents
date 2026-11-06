import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadModule, render } from './renderHelper.mjs';

/** Static markup of the import button, filter, session view and imported Concept (C01-C34, W07 in the Test Case Planning list). */

const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const LIST = 'src/ui/content/ConceptList.tsx', VIEW = 'src/ui/content/ImportViewBody.tsx', BODY = 'src/ui/content/ConceptView.tsx', PARTS = 'src/ui/content/ImportedConcept.tsx', RO = 'This Building is read-only';
const { importPaneModel, learnModel, LEARN_CONFLICT } = await loadModule('src/lib/contentImport.ts');

const noop = () => {};
const counts = (over = {}) => ({ impressions: null, reach: null, views: null, likes: null, comments: null, shares: null, saves: null, linkClicks: null, profileVisits: null, followersGained: null, ...over });
const asset = (id, kind, state = 'finalized', content = 'x', postId = null) => ({ id, kind, postId, state, content, finalizedAt: state === 'finalized' ? '2026-03-14T08:30:00Z' : null, round: 0 });
const post = (over = {}) => ({ id: 'p1', conceptId: 'c1', platform: 'linkedin', format: 'text', scheduledAt: '2026-03-14T08:30:00Z', status: 'published', note: null, createdAt: '2026-03-14T08:30:00Z', needs: [asset('pt1', 'post-text', 'finalized', 'We stopped standups.', 'p1')], publishedAt: '2026-03-14T08:30:00Z', liveUrl: 'https://example.com/standups', stats: { count: 1, delta: null, latest: { id: 's', capturedAt: '2026-03-16T09:00:00Z', enteredAt: '2026-03-16T09:00:00Z', counts: counts({ impressions: 12480 }), watchTime: null, note: '', sources: [] } }, result: null, externalAssets: null, ...over });
const concept = (over = {}) => ({
  id: 'c1', title: 'Why we stopped standups', brief: '', archived: false, imported: true, createdAt: '2026-10-29T10:00:00Z', updatedAt: '2026-10-29T10:00:00Z', progress: { finalized: 1, needed: 1 }, compositionId: null,
  posts: [post()], assets: [asset('a1', 'script', 'finalized', 'Hook: six months ago'), asset('a2', 'video', 'empty', null), asset('a3', 'thumbnail', 'empty', null)], ...over,
});
const session = (state) => ({ id: 'term-1', state, executorId: 'e', createdAt: 'x', updatedAt: 'x' });
const importView = (over = {}) => ({ rev: 1, session: null, saved: [], blockedReason: null, ...over });
const page = (rows) => ({ rows, total: rows.length, limit: 50, offset: 0, hasMore: false, summary: [] });
const session1 = (view, readOnly = false, starting = false) => render(VIEW, 'ImportViewBody', { view, model: importPaneModel(view, readOnly, starting), timeZone: 'UTC', busy: false, error: null, renderTerminal: (id) => `TERMINAL:${id}`, onBack: noop, onOpen: noop, onAction: noop });
const panes = (calls) => ({ renderStudio: (_c, id) => { calls.push(`studio:${id}`); return 'STUDIO'; }, renderVideo: (_c, id) => { calls.push(`video:${id}`); return 'VIDEO'; }, renderImages: (_c, id) => { calls.push(`images:${id}`); return 'IMAGES'; }, renderThumbnail: (_c, id) => { calls.push(`thumb:${id}`); return 'THUMB'; }, renderRemotion: () => { calls.push('remotion'); return 'REMOTION'; } });
const body = (c, tab, extra = {}) => render(BODY, 'ConceptBody', { projectId: 'b1', concept: c, missingByPost: {}, error: null, onSave: noop, timeZone: 'UTC', readOnly: false, tab, onTab: noop, onBack: noop, onChanged: noop, ...panes([]), ...extra });
const row = (c) => render(LIST, 'ConceptRow', { concept: c, timeZone: 'UTC', onOpen: noop });

test('C01 Import is outline beside the primary New', async () => {
  const html = await render(LIST, 'ImportButton', { running: false, readOnly: false, onClick: noop });
  assert.match(html, /Import past concept/);
  assert.match(html, /title="Give an agent your past content to import"/);
  assert.match(html, /border-input|outline/);
  const source = src('ui/content/ConceptList.tsx');
  assert.ok(source.indexOf('<ImportButton') < source.indexOf('<Plus />New'), 'Import sits before New');
});

test('C02 read-only: both are disabled with the read-only title', async () => {
  const html = await render(LIST, 'ImportButton', { running: false, readOnly: true, onClick: noop });
  assert.match(html, /disabled=""/);
  assert.ok(html.includes(`title="${RO}"`));
  assert.match(src('ui/content/ConceptList.tsx'), /<Plus \/>New/);
  assert.match(src('ui/content/ConceptList.tsx'), /controlsDisabled\(readOnly\)\} title=\{readOnly \? READ_ONLY_TITLE : undefined\}><Plus \/>New/);
});

test('C03 while running: Continue import with the live dot and no icon', async () => {
  const html = await render(LIST, 'ImportButton', { running: true, readOnly: false, onClick: noop });
  assert.match(html, /Continue import/);
  assert.match(html, /data-live-dot/);
  assert.doesNotMatch(html, /<svg/);
});

test('C04/C05 the row shows Imported with icon and text; a long unbroken title wraps and the badge does not shrink', async () => {
  const html = await row(concept({ title: 'X'.repeat(200) }));
  assert.match(html, /<svg[^>]*>.*<\/svg>Imported/s);
  assert.match(html, /\[overflow-wrap:anywhere\][^>]*>X{200}/);
  assert.match(html, /shrink-0[^>]*><svg/);
});

test('C06/W07 an imported row has no asset text; a normal row keeps it', async () => {
  const imported = await row(concept({ progress: { finalized: 1, needed: 3 } }));
  assert.doesNotMatch(imported, /assets finalized|No assets needed yet/);
  const normal = await row(concept({ imported: false, progress: { finalized: 1, needed: 3 } }));
  assert.match(normal, /1 of 3 assets finalized/);
  assert.doesNotMatch(normal, />Imported</);
  assert.match(await row(concept({ imported: false, progress: { finalized: 0, needed: 0 } })), /No assets needed yet/);
});

test('C07 the filter select has its label and three options', async () => {
  const html = await render(LIST, 'ListFiltersBar', { filters: { status: '', platform: '', result: '', imported: '', archived: false, search: '', sort: 'newest' }, onChange: noop });
  assert.match(html, /aria-label="Imported"/);
  for (const label of ['Imported or not', 'Imported only', 'Not imported']) assert.ok(html.includes(label), label);
});

test('C08 the Imported only empty state offers the import button, disabled when read-only', async () => {
  const rows = (imported, readOnly = false) => render(LIST, 'ConceptRows', { page: page([]), loading: false, error: null, timeZone: 'UTC', readOnly, imported, onOpen: noop, onNew: noop, onImport: noop });
  const html = await rows('true');
  assert.match(html, /No imported concepts yet/);
  assert.match(html, />Import past concept<\/button>/);
  assert.match(await rows('true', true), /disabled=""/);
  assert.match(await rows(''), /No concepts match/);
});

test('C09 the session header: back, title, status badge and facts', async () => {
  const html = await session1(importView({ session: session('running') }));
  assert.match(html, /aria-label="Back to Concepts"/);
  assert.match(html, />Import past concepts</);
  assert.match(html, />Agent working</);
  assert.match(html, /It works out the Concepts and saves them as imported and published/);
});

test('C10 running: the terminal gets the session id', async () => {
  const html = await session1(importView({ session: session('running') }));
  assert.match(html, /aria-label="Agent terminal"[^>]*>TERMINAL:term-1/);
});

test('C11 the starting state', async () => {
  const html = await session1(undefined, false, true);
  assert.match(html, />Starting</);
  assert.match(html, /Starting the agent…/);
  assert.doesNotMatch(html, /TERMINAL/);
});

test('C12 ended: Resume and Start a new session, no End session, and the kept line', async () => {
  const html = await session1(importView({ session: session('ended') }));
  for (const text of ['Session ended', 'Everything the agent saved is kept.', '>Resume<', '>Start a new session<']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /End session/);
});

test('C13 no agent: the reason and Start', async () => {
  const html = await session1(importView({ blockedReason: 'No default coding agent is set.' }));
  assert.match(html, /No default coding agent is set\./);
  assert.match(html, />Start</);
});

test('C14 read-only: text only, no buttons but Back', async () => {
  const html = await session1(importView(), true);
  assert.match(html, /This Building is read-only, so no session is started\./);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

test('C15 the empty right column has the four hints', async () => {
  const html = await session1(importView({ session: session('running') }));
  for (const hint of ['Nothing imported yet.', 'Post text, scripts and articles', 'Links to the live posts', 'Dates, and any stats you have', 'File paths to exports or notes']) assert.ok(html.includes(hint), hint);
});

test('C16/C17 saved rows show title, badge, chips and stats, open the Concept, and a long title wraps', async () => {
  const html = await session1(importView({ session: session('ended'), saved: [concept({ title: 'Y'.repeat(200) }), concept({ id: 'c2', title: 'Second', posts: [post({ id: 'p2', stats: null })] })] }));
  assert.match(html, /Imported in this session \(2\)/);
  assert.match(html, /<button[^>]*>.*Y{200}/s);
  assert.match(html, /\[overflow-wrap:anywhere\][^>]*>Y{200}/);
  assert.match(html, /LinkedIn text · 14 Mar 2026/);
  assert.match(html, /Impressions 12,480/);
  assert.match(html, /No stats/);
  assert.equal((html.match(/>Imported</g) ?? []).length + (html.match(/<\/svg>Imported/g) ?? []).length >= 2, true);
});

test('C18 the footer note and End session show only while working', async () => {
  const working = await session1(importView({ session: session('running') }));
  assert.match(working, /You can leave this page/);
  assert.match(working, />End session</);
  const ended = await session1(importView({ session: session('ended') }));
  assert.doesNotMatch(ended, /You can leave this page/);
});

test('C19 the Concept header shows the Imported badge and Published', async () => {
  const html = await body(concept(), 'overview');
  assert.match(html, /<\/svg>Imported/);
  assert.match(html, />Published</);
  assert.match(html, /Published · Imported /);
  assert.match(html, /1 post · Script/);
});

test('C20 the band has its text and the Learn button', async () => {
  const html = await body(concept(), 'overview');
  assert.match(html, /role="region" aria-label="Imported content"/);
  assert.match(html, /Imported from outside the system\./);
  assert.match(html, />Learn from this</);
});

test('C21 a normal Concept has no band', async () => {
  const html = await body(concept({ imported: false }), 'overview');
  assert.doesNotMatch(html, /Imported content|Learn from this/);
  assert.doesNotMatch(html, /<\/svg>Imported/);
});

test('C22 the Learn states', async () => {
  const band = (status, refusal = null) => render(PARTS, 'ImportedBandView', { model: learnModel(status, refusal, false), onLearn: noop });
  const running = await band({ status: 'running', at: 'x' });
  assert.match(running, /disabled=""[^>]*>Learning…</);
  assert.match(running, /role="status"/);
  assert.match(await band({ status: 'proposal', at: 'x' }), />Writing style › Pending proposals<\/button>/);
  const nothing = await band({ status: 'nothing', at: 'x' });
  assert.match(nothing, /nothing new/);
  assert.doesNotMatch(nothing, /Pending proposals/);
  assert.match(await band({ status: 'failed', at: 'x', reason: 'Boom' }), /role="alert"[^>]*>Learning failed: Boom/);
  assert.ok((await band(null, LEARN_CONFLICT)).includes('already going'));
});

test('C23 Learn is disabled with the title when read-only', async () => {
  const html = await render(PARTS, 'ImportedBandView', { model: learnModel(null, null, true), onLearn: noop });
  assert.match(html, /disabled=""/);
  assert.ok(html.includes(`title="${RO}"`));
});

test('C24 the Overview shows Published, the URL, stats and a target line', async () => {
  const html = await body(concept({ posts: [post({ result: { overall: 'on-target', fields: [], evaluatedAt: null, windowEnds: null, engagementRate: null, snapshotAt: null } })] }), 'overview');
  assert.match(html, /data-status="published"/);
  assert.match(html, /href="https:\/\/example\.com\/standups"/);
  assert.match(html, /12,480/);
});

test('C25 the Overview hides Finalize, Back to draft and Add post, shows the hint, and no missing text even with a missingByPost entry', async () => {
  const html = await body(concept(), 'overview', { missingByPost: { p1: ['video'] } });
  for (const gone of ['>Finalize post<', '>Back to draft<', 'aria-label="Add post"', 'Not ready:']) assert.ok(!html.includes(gone), gone);
  assert.match(html, /There&#x27;s no Add post, Finalize or Back to draft here/);
  assert.match(await body(concept({ imported: false, posts: [post({ status: 'draft' })] }), 'overview', { missingByPost: { p1: ['video'] } }), /Not ready:/);
});

test('C26 the Needs cell lists finalized assets and the Elsewhere note', async () => {
  const html = await body(concept({ posts: [post({ externalAssets: 'Drive › standups.mp4' })] }), 'overview');
  assert.match(html, /Elsewhere: Drive › standups\.mp4/);
  assert.match(html, />Finalized</);
});

test('C27 an unpublished imported post offers Publish, not Back to draft', async () => {
  const html = await body(concept({ posts: [post({ status: 'finalized', publishedAt: null, stats: null })] }), 'overview');
  assert.match(html, />Publish</);
  assert.doesNotMatch(html, />Back to draft</);
});

test('C27b re-publishing an imported video post asks for no thumbnail; a normal one does', async () => {
  const props = { post: post({ format: 'video', status: 'finalized' }), mode: 'publish', media: { text: 'x', images: null, video: null, thumbnail: null }, urls: { image: noop, zip: '', video: '', thumbnail: '' }, timeZone: 'UTC', url: '', at: '', errors: {}, error: null, pending: false, readOnly: false, onUrl: noop, onAt: noop, onCopy: noop, onSubmit: noop, onCancel: noop };
  assert.match(await render('src/ui/content/PublishDialog.tsx', 'PublishForm', props), /data-thumbnail-hint/);
  assert.doesNotMatch(await render('src/ui/content/PublishDialog.tsx', 'PublishForm', { ...props, imported: true }), /data-thumbnail-hint/);
});

test('C35 Delete Concept: shown on an imported Concept, disabled when read-only, absent on a normal one', async () => {
  assert.match(await body(concept(), 'overview'), />Delete Concept</);
  assert.ok((await body(concept(), 'overview', { readOnly: true })).includes(`disabled="" title="${RO}"`));
  assert.doesNotMatch(await body(concept({ imported: false }), 'overview'), /Delete Concept/);
});

test('C36 Delete Concept asks first and shows a refusal', async () => {
  const del = (over = {}) => render(PARTS, 'DeleteConceptView', { confirming: false, busy: false, error: null, readOnly: false, onAsk: noop, onCancel: noop, onConfirm: noop, ...over });
  const asked = await del({ confirming: true });
  assert.match(asked, /role="alertdialog"/);
  assert.match(asked, /Delete this Concept and its posts, stats and files\?/);
  assert.match(asked, />Delete</);
  assert.match(asked, />Keep</);
  assert.doesNotMatch(await del(), /alertdialog/);
  assert.match(await del({ error: 'Refused' }), /Refused/);
  assert.match(await del({ confirming: true, readOnly: true }), /disabled=""[^>]*>Delete</);
  assert.match(src('ui/content/ConceptView.tsx'), /onDeleted=\{onBack\}/);
});

test('C37 an imported tab scrolls in its own container, so long text keeps the header in place', async () => {
  for (const [tab, platform, format] of [['script', 'linkedin', 'text'], ['post-content', 'linkedin', 'text'], ['blog', 'blog', 'article'], ['video', 'linkedin', 'video'], ['images', 'linkedin', 'image'], ['thumbnail', 'linkedin', 'video']]) {
    assert.match(await body(concept({ posts: [post({ platform, format })] }), tab), /min-h-0 min-w-0 flex-1 overflow-y-auto p-4/, tab);
  }
  assert.match(await body(concept({ imported: false }), 'script'), /mt-3 flex min-h-64 min-w-0 flex-1 flex-col border-t border-border/);
});

test('C28 Concept assets show Finalized and Not imported', async () => {
  const html = await body(concept({ posts: [post({ format: 'video' })] }), 'overview');
  assert.match(html, /Not imported/);
  assert.match(html, />Finalized</);
});

test('C29 the Script tab shows the note and text; renderStudio is not called', async () => {
  const calls = [];
  const html = await body(concept(), 'script', panes(calls));
  assert.match(html, /Imported content is read-only\. Agents read it as reference\./);
  assert.match(html, /Hook: six months ago/);
  assert.deepEqual(calls, []);
});

test('C30 Post content, Captions and Blog show the note and text with the switcher; renderStudio is not called', async () => {
  for (const [tab, platform, format] of [['post-content', 'linkedin', 'text'], ['captions', 'instagram', 'image'], ['blog', 'blog', 'article']]) {
    const calls = [];
    const html = await body(concept({ posts: [post({ platform, format })] }), tab, panes(calls));
    assert.match(html, /Imported content is read-only/, tab);
    assert.match(html, /We stopped standups\./, tab);
    assert.match(html, /aria-label="Post switcher"/, tab);
    assert.deepEqual(calls, [], tab);
  }
});

test('C31 Video, Thumbnail and Images show the note; their render functions are not called', async () => {
  for (const [tab, format] of [['video', 'video'], ['thumbnail', 'video'], ['images', 'image']]) {
    const calls = [];
    const html = await body(concept({ posts: [post({ format, externalAssets: 'On Drive' })], assets: [asset('a1', 'script', 'empty', null), asset('a2', 'video', 'empty', null), asset('a3', 'thumbnail', 'empty', null)] }), tab, panes(calls));
    assert.match(html, /Imported content is read-only/, tab);
    assert.match(html, /Elsewhere: On Drive/, tab);
    assert.deepEqual(calls, [], tab);
  }
});

test('C32 the Remotion tab is disabled with the reason', async () => {
  const calls = [];
  const html = await body(concept({ posts: [post({ format: 'video' })] }), 'remotion', panes(calls));
  assert.match(html, /title="Imported content has no Remotion project"/);
  assert.deepEqual(calls, []);
});

test('C33 a read-only Building disables Edit publish details, Unpublish and Learn', async () => {
  const html = await body(concept(), 'overview', { readOnly: true });
  assert.match(html, /disabled=""[^>]*>Edit publish details</);
  assert.match(html, /disabled=""[^>]*>Unpublish</);
  assert.match(html, /disabled=""[^>]*>Learn from this</);
});

test('C34 the Writing style source reads Imported, the Concept link stays, and a normal Concept still mounts its panes', async () => {
  const source = src('ui/content/WritingStyleTab.tsx');
  assert.match(source, /sourceChips\(source\)\.map/);
  assert.match(source, /onOpenConcept\(source\.conceptId\)/);
  assert.match(source, /source\.kind !== 'imported'/);
  const calls = [];
  await body(concept({ imported: false }), 'script', panes(calls));
  assert.deepEqual(calls, ['studio:a1']);
});
