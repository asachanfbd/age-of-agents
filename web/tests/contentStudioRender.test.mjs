import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { render } from './renderHelper.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const rules = await import('../src/lib/contentRules.ts');
const { monthGrid } = await import('../src/lib/contentCalendar.ts');
const { formatExactTime } = await import('../src/lib/sessionTiming.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const NOW = Date.parse('2026-10-26T10:00:00Z');
const asset = (kind, state = 'empty', postId = null) => ({ id: `a-${kind}-${postId}`, kind, postId, state, content: null, finalizedAt: null, round: 0 });
const post = (id, platform, format, extra = {}) => ({
  id, conceptId: 'c1', platform, format, scheduledAt: '2026-10-27T09:00:00.000Z', status: 'draft', note: null, createdAt: '2026-10-26T09:00:00.000Z',
  needs: rules.assetsNeeded(platform, format).map((kind) => asset(kind, 'empty', id)), ...extra,
});
const concept = (posts, extra = {}) => ({ id: 'c1', title: 'Launch week', brief: 'Why now', archived: false, createdAt: '2026-10-26T09:00:00.000Z', updatedAt: '2026-10-26T09:00:00.000Z', posts, assets: [asset('script'), asset('video')], progress: { finalized: 0, needed: posts.reduce((n, p) => n + p.needs.length, 0) }, ...extra });
const page = (rows) => ({ rows, total: rows.length, limit: 50, offset: 0, hasMore: false });

test('CC01/CC02/CC03 the list: rows with chips and progress; loading, empty and error states; filters and New', async () => {
  const rows = await render('src/ui/content/ConceptList.tsx', 'ConceptRows', { page: page([concept([post('p1', 'instagram', 'reel'), post('p2', 'x', 'text', { status: 'finalized' })])]), loading: false, error: null, timeZone: 'UTC', now: NOW, onOpen() {}, onNew() {} });
  assert.match(rows, /Launch week/);
  assert.match(rows, /0 of 4 assets finalized/, 'a reel needs its text, the video and the thumbnail');
  assert.match(rows, /aria-label="Instagram"/);
  assert.match(rows, /Reel/);
  assert.match(rows, /data-status="finalized"/);
  assert.match(rows, /<time/);
  const none = await render('src/ui/content/ConceptList.tsx', 'ConceptRows', { page: page([]), loading: false, error: null, timeZone: 'UTC', onOpen() {}, onNew() {} });
  assert.match(none, /No concepts match/);
  assert.match(await render('src/ui/content/ConceptList.tsx', 'ConceptRows', { page: null, loading: true, error: null, timeZone: 'UTC', onOpen() {}, onNew() {} }), /Loading concepts/);
  assert.match(await render('src/ui/content/ConceptList.tsx', 'ConceptRows', { page: null, loading: false, error: 'Boom', timeZone: 'UTC', onOpen() {}, onNew() {} }), /Boom/);
  const filters = await render('src/ui/content/ConceptList.tsx', 'ListFiltersBar', { filters: { status: '', platform: '', archived: false, search: '' }, onChange() {} });
  for (const text of ['Search concepts', 'Any status', 'Any platform', 'Archived', 'X (Twitter)']) assert.ok(filters.includes(text), text);
  const list = await render('src/ui/content/ConceptList.tsx', 'ConceptList', { projectId: 'b1', timeZone: 'UTC', readOnly: false, version: 0, onOpen() {}, onNew() {} });
  assert.match(list, /New<\/button>/);
  assert.doesNotMatch(list, /disabled=""[^>]*>[^<]*<svg[^>]*><[^>]*><\/svg>New/);
  assert.match(await render('src/ui/content/ConceptList.tsx', 'ConceptList', { projectId: 'b1', timeZone: 'UTC', readOnly: true, version: 0, onOpen() {}, onNew() {} }), /disabled=""[^>]*title="This Building is read-only"/);
});

test('CC04/CC05/CC06 the workspace opens on List; the calendar shows chips and "+N more" in the Building zone', async () => {
  const workspace = src('ui/ContentStudioWorkspace.tsx');
  assert.match(workspace, /useState\(initialContentState\)/);
  assert.doesNotMatch(workspace, /localStorage/);
  const posts = Array.from({ length: 5 }, (_, i) => ({ ...post(`p${i}`, i === 0 ? 'linkedin' : 'x', 'text'), conceptTitle: `Concept ${i}`, scheduledAt: `2026-10-14T0${i}:00:00.000Z` }));
  const html = await render('src/ui/content/CalendarView.tsx', 'MonthGrid', { weeks: monthGrid('2026-10', posts, 'UTC'), timeZone: 'UTC', onOpen() {} });
  assert.match(html, /data-day="2026-10-14"/);
  assert.match(html, /\+2 more/);
  assert.match(html, /Concept 0/);
  assert.match(html, /aria-label="LinkedIn"/);
  assert.doesNotMatch(html, /Concept 4/, 'the fifth chip is behind "+2 more"');
  for (const day of ['Mon', 'Sun']) assert.ok(html.includes(day));
  const view = await render('src/ui/content/CalendarView.tsx', 'CalendarView', { projectId: 'b1', timeZone: 'Asia/Kolkata', version: 0, onOpen() {} });
  for (const text of ['Previous month', 'Next month', 'Today', 'Days in Asia/Kolkata']) assert.ok(view.includes(text), text);
});

test('CC07/CC08 the New dialog: platform and format checkboxes, count, Apply to all, Clear, the zone and limits', async () => {
  const html = await render('src/ui/content/NewConceptDialog.tsx', 'NewConceptDialog', { projectId: 'b1', timeZone: 'Europe/Berlin', onCreated() {}, onCancel() {} });
  // The dialog renders in a portal, which static markup omits; the source holds the rest of the contract.
  assert.equal(typeof html, 'string');
  const source = src('ui/content/NewConceptDialog.tsx');
  for (const text of ['Apply to all platforms', 'Clear selection', 'willCreateLabel', 'datetime-local', 'Dates are in {timeZone}', 'up to {TITLE_MAX} characters', 'up to {BRIEF_MAX} characters', 'type="checkbox"', 'saveChoices(form.choices)', 'loadChoices()']) assert.ok(source.includes(text), text);
  assert.ok(source.lastIndexOf('saveChoices') > source.indexOf('createConcept(projectId'), 'choices are saved only after a successful create');
  assert.match(source, /if \(!result\.ok\) \{ setErrors\(\[result\.error\]\); return; \}\n\s+saveChoices/);
});

test('CC09/CC10/CC11 the Concept view: title, tab bar with reasons; the Images tab draws its pane (32.006)', async () => {
  const c = concept([post('p1', 'linkedin', 'text')]);
  const html = await render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: c, missingByPost: {}, error: null, onSave() {}, timeZone: 'UTC', readOnly: false, tab: 'overview', onTab() {}, onBack() {}, onChanged() {} });
  assert.match(html, /<h3[^>]*>Launch week<\/h3>/);
  assert.match(html, /aria-label="Back to Concepts"/);
  for (const label of ['Overview', 'Script', 'Video', 'Thumbnail', 'Remotion', 'Images', 'Post content', 'Captions', 'Blog']) assert.ok(html.includes(`>${label}</button>`), label);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 9);
  assert.match(html, /title="Add a blog post to use this tab"[^>]*>Blog/);
  assert.match(html, /title="Add an Instagram post to use this tab"[^>]*>Captions/);
  const coming = await render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: c, missingByPost: {}, error: null, onSave() {}, timeZone: 'UTC', readOnly: false, tab: 'blog', onTab() {}, onBack() {}, onChanged() {} });
  assert.match(coming, /<p[^>]*>Add a blog post to use this tab<\/p>/, 'a disabled tab that is open says why');
  const images = concept([post('p1', 'linkedin', 'image')]);
  const pane = await render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: images, missingByPost: {}, error: null, onSave() {}, timeZone: 'UTC', readOnly: false, tab: 'images', onTab() {}, onBack() {}, onChanged() {}, renderImages: (_c, aid) => `IMAGES:${aid}` });
  assert.doesNotMatch(pane, /<p[^>]*>Coming soon<\/p>/);
  assert.match(pane, /Image and carousel posts · 1 post/);
  assert.match(pane, /IMAGES:/);
  const frozen = await render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: c, missingByPost: {}, error: null, onSave() {}, timeZone: 'UTC', readOnly: true, tab: 'overview', onTab() {}, onBack() {}, onChanged() {} });
  const frozenOpen = await render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: c, missingByPost: {}, error: null, onSave() {}, timeZone: 'UTC', readOnly: true, tab: 'overview', onTab() {}, onBack() {}, onChanged() {}, initialExpanded: true });
  assert.match(frozenOpen, /aria-label="Concept title"[^>]*disabled=""/);
  assert.match(frozenOpen, /aria-label="Concept brief"[^>]*disabled=""/);
  assert.match(frozenOpen, /title="This Building is read-only"/);
});

const body = (c, extra = {}) => render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: c, missingByPost: {}, error: null, onSave() {}, timeZone: 'UTC', readOnly: false, tab: 'overview', onTab() {}, onBack() {}, onChanged() {}, renderStudio: () => 'STUDIO', renderImages: () => 'IMG', ...extra });

test('36.001 the Concept header: name, status badge and facts; the brief is collapsed by default', async () => {
  const c = concept([post('p1', 'linkedin', 'text')], { progress: { finalized: 1, needed: 2 } });
  const EXACT = formatExactTime('2026-10-26T09:00:00.000Z', 'UTC');
  const html = await body(c);
  assert.match(html, /<h3[^>]*>Launch week<\/h3>/);
  assert.match(html, /aria-expanded="false"[^>]*aria-label="Show Concept brief"|aria-label="Show Concept brief"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /aria-label="Concept title"|aria-label="Concept brief"|<textarea/, 'title and brief are behind the chevron');
  assert.match(html, /In progress/);
  assert.ok(html.includes(`Created <time dateTime="2026-10-26T09:00:00.000Z" title="${EXACT}"`), 'creation date with the local time on hover');
  assert.match(html, /1 of 2 texts finalized · 1 post/);
  assert.ok(html.includes(`title="In progress · Created ${EXACT} · 1 of 2 texts finalized · 1 post"`), 'the full facts, creation date included, are in the title');
  const long = await body(concept([], { title: 'x'.repeat(240) }));
  assert.match(long, /<h3 class="[^"]*line-clamp-2[^"]*min-w-0[^"]*flex-1[^"]*break-words/);
  assert.match(long, /<div class="flex shrink-0 items-center gap-2">/, 'badge and chevron never shrink');
});

test('36.001 the expanded brief section: title and brief inputs with the current values and Edit title', async () => {
  const html = await body(concept([]), { initialExpanded: true });
  assert.match(html, /aria-label="Hide Concept brief"/);
  assert.match(html, /aria-label="Concept title" value="Launch week"/);
  assert.match(html, /aria-label="Concept brief"[^>]*>Why now<\/textarea>/);
  assert.match(html, /Edit title/);
  const archived = await body(concept([], { archived: true }), { initialExpanded: true });
  assert.match(archived, />Archived<\/div>/);
});

test('36.001 the disabled-tabs help list is gone; the reason stays on the tab', async () => {
  const reasonOutsideTooltip = /to use this tab|Start the video in the Video tab first/;
  const withoutTooltips = (html) => html.replace(/ title="[^"]*"/g, '');
  const text = await body(concept([post('p1', 'linkedin', 'text')]));
  assert.doesNotMatch(text, /aria-label="Disabled tabs"/);
  assert.doesNotMatch(withoutTooltips(text), reasonOutsideTooltip, 'no reason text outside a tab tooltip');
  assert.match(text, /title="Add a video or reel post and finalize the script to use this tab"[^>]*>Video/);
  assert.match(text, /title="Add an image or carousel post to use this tab"[^>]*>Images/);
  const reel = await body(concept([post('p1', 'instagram', 'reel')]));
  assert.doesNotMatch(reel, /aria-label="Disabled tabs"/);
  assert.doesNotMatch(withoutTooltips(reel), reasonOutsideTooltip, 'no reason text outside a tab tooltip');
  assert.match(reel, /title="Finalize the script to use this tab"[^>]*>Video/);
  assert.match(reel, /title="Start the video in the Video tab first"[^>]*>Remotion/);
});

test('36.001 the not-loaded Concept still shows Back and the error', async () => {
  const html = await render('src/ui/content/ConceptView.tsx', 'ConceptBody', { projectId: 'b1', concept: undefined, missingByPost: {}, error: 'Could not load', timeZone: 'UTC', readOnly: false, tab: 'overview', onTab() {}, onBack() {}, onChanged() {}, onSave() {} });
  assert.match(html, /aria-label="Back to Concepts"/);
  assert.match(html, /Could not load/);
});

test('36.001/37.006 layout: agent tabs fill the popup height edge to edge; Overview scrolls; the result pane pins its footer', async () => {
  const c = concept([post('p1', 'linkedin', 'text'), post('p2', 'linkedin', 'image')]);
  const overview = await body(c);
  assert.match(overview, /class="flex h-full min-h-0 flex-col" aria-label="Concept"/);
  assert.match(overview, /<div class="min-h-0 min-w-0 flex-1 overflow-y-auto/);
  const reel = concept([post('p1', 'linkedin', 'text'), post('p2', 'linkedin', 'image'), post('p3', 'instagram', 'reel')], { assets: [asset('script', 'finalized'), asset('video')] });
  for (const tab of ['script', 'post-content', 'images', 'video']) {
    const html = await body(reel, { tab, renderVideo: () => 'VIDEO' });
    assert.match(html, /<header class="shrink-0 border-b">/, tab);
    assert.match(html, /class="shrink-0 overflow-x-auto/, tab);
    assert.match(html, tab === 'video' ? /<div class="flex min-h-64 min-w-0 flex-1 flex-col p-4 sm:px-6">/ : /<div class="mt-3 flex min-h-64 min-w-0 flex-1 flex-col border-t border-border">/, tab);
    assert.doesNotMatch(html, /overflow-y-auto p-4/, `${tab} has no outer scroller`);
  }
  const view = src('ui/content/StudioPaneView.tsx');
  assert.doesNotMatch(view, /min-h-\[24rem\]|max-h-\[32rem\]/);
  assert.match(view, /className="flex min-h-0 flex-1 flex-col" aria-label="Agent pane"/);
  assert.match(view, /grid min-h-0 flex-1 overflow-y-auto lg:overflow-hidden/);
  assert.match(view, /flex min-h-0 min-w-0 flex-col bg-card" aria-label="Result column"/);
  assert.match(view, /grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 pb-4 sm:px-6', custom && 'pt-3'\)\} aria-label="Result body"/);
  assert.match(view, /grid shrink-0 gap-2 border-t border-border px-4 py-3 sm:px-6" aria-label="Pane footer"/);
  assert.ok(view.indexOf('<PreviousRounds') < view.indexOf('Pane footer'), 'Previous rounds scrolls with the Result body, above the pinned footer');
  const conceptSource = src('ui/content/ConceptView.tsx');
  assert.match(conceptSource, /<ConceptBody key=\{conceptId\}/, 'each Concept opens collapsed');
  assert.doesNotMatch(conceptSource, /text-2xl/, 'the big editable title is gone');
  assert.match(view, /finalized \? 'grid-cols-1 grid-rows-\[minmax\(0,1fr\)\]'/, 'finalized single column keeps the flex chain');
  for (const file of ['ui/content/PostTextTab.tsx', 'ui/content/ImagesTab.tsx']) assert.match(src(file), /flex min-h-0 flex-1 flex-col">/, file);
});

test('CC12-CC16 the Overview: posts table, assets with states, finalize reason, delete and add controls, concept assets', async () => {
  const posts = [post('p1', 'instagram', 'reel'), post('p2', 'linkedin', 'text', { status: 'finalized', needs: [asset('post-text', 'finalized', 'p2')] }), post('p3', 'x', 'image', { note: 'Back to draft: the post-text for this X (Twitter) post is being redrafted' })];
  const html = await render('src/ui/content/OverviewTab.tsx', 'OverviewTab', { projectId: 'b1', concept: concept(posts), missingByPost: { p1: ['post-text', 'video'] }, timeZone: 'Europe/Berlin', readOnly: false, onChanged() {} });
  assert.match(html, /times in Europe\/Berlin/);
  assert.match(html, /type="datetime-local"[^>]*value="2026-10-27T10:00"/, 'shown in the Building zone');
  for (const text of ['Caption', 'Tweet', 'Post', 'Video', 'Images', 'Finalize post', 'Back to draft', 'Add post', 'Concept assets', 'Script']) assert.ok(html.includes(text), text);
  assert.match(html, /role="alert"[^>]*>Not ready: Caption, Video not finalized/);
  assert.match(html, /Back to draft: the post-text/);
  assert.equal((html.match(/aria-label="Delete post"/g) ?? []).length, 3);
  assert.match(html, /Not started/);
  assert.match(html, /Finalized/);
  assert.doesNotMatch(html.replace(/Back to draft: the post-text[^<]*/, ''), /\bempty\b/i, 'the raw word empty never shows');
  const published = await render('src/ui/content/OverviewTab.tsx', 'OverviewTab', { projectId: 'b1', concept: concept([post('p9', 'x', 'text', { status: 'published' })]), missingByPost: {}, timeZone: 'UTC', readOnly: false, onChanged() {} });
  assert.match(published, /aria-label="Delete post" disabled=""/, 'a published post cannot be deleted');
  const none = await render('src/ui/content/OverviewTab.tsx', 'OverviewTab', { projectId: 'b1', concept: concept([]), missingByPost: {}, timeZone: 'UTC', readOnly: true, onChanged() {} });
  assert.match(none, /No posts yet/);
  assert.match(none, /Add post<\/button>/);
  assert.match(none, /disabled=""[^>]*>Add post/);
});

test('CC17-CC22 Knowledge, Writing style and Settings contents are declared in source and guard read-only', () => {
  const knowledge = src('ui/content/KnowledgeTab.tsx');
  for (const text of ['Knowledge sections', 'FILES_LIMIT_TEXT', 'Up to 100 files, 50 MB each', 'Brand colours', 'Add colour', 'img src={contentApi.fileUrl', 'f.image &&', '!current.builtin &&', 'Download']) assert.ok(knowledge.includes(text), text);
  const editor = src('ui/content/VersionedEditor.tsx');
  for (const text of ['Changed by an agent since you opened it', 'Reload', 'Overwrite', 'Last changed', 'max {max.toLocaleString']) assert.ok(editor.includes(text), text);
  const style = src('ui/content/WritingStyleTab.tsx');
  for (const text of ['No pending proposals', 'Change history', 'Who', 'When', 'Pending proposals']) assert.ok(style.includes(text), text);
  const settings = src('ui/content/SettingsTab.tsx');
  for (const text of ['Time zone', 'NativeSelect', 'Folder for agents', 'controlsDisabled(readOnly)']) assert.ok(settings.includes(text), text);
});

test('CC23/CC24 the type has its workspace and tab declaration; the layout rules hold for the new shell', () => {
  const modal = src('ui/ProjectWorkspaceModal.tsx');
  assert.match(modal, /kind === 'content-studio'\) return <ContentStudioShell/);
  assert.match(modal, /<ContentStudioWorkspace project=\{project\} readOnly=\{isBuildingReadOnly\(project\)\}/);
  assert.doesNotMatch(modal, /<fieldset|ReadOnlyFieldset/);
  assert.equal((modal.match(/<WorkspaceTabBar /g) ?? []).length, 2, 'the new shell keeps its own tab bar like CRM and SEO');
  const top = src('ui/TopBar.tsx');
  assert.match(top, /isContentStudio &&/);
  assert.match(top, /timezoneOptions\(browserTimezone\(\), supportedTimezones\(\)\)/);
});

test('CC25/CC26 localStorage is used only by the remembered choices, and the Concept tab declaration lives in one place', () => {
  const uses = ['ui/content/ConceptList.tsx', 'ui/content/CalendarView.tsx', 'ui/content/NewConceptDialog.tsx', 'ui/ContentStudioWorkspace.tsx', 'lib/contentView.ts', 'lib/contentWorkspace.ts', 'lib/contentDefaults.ts'].filter((f) => /localStorage/.test(src(f)));
  assert.deepEqual(uses, ['lib/contentDefaults.ts']);
  const d = src('lib/contentDefaults.ts');
  assert.match(d, /try \{ return globalThis\.localStorage \?\? null; \} catch/);
  assert.match(d, /try \{ store\?\.setItem\(DEFAULTS_KEY[^\n]*catch/);
  const declarations = ['lib/contentRules.ts', 'lib/contentWorkspace.ts', 'ui/content/ConceptView.tsx'].filter((f) => /key: 'post-content'/.test(src(f)));
  assert.deepEqual(declarations, ['lib/contentRules.ts']);
});
