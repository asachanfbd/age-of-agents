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

const { monthGrid } = await import('../src/lib/contentCalendar.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-26T10:00:00Z');
const counts = (over = {}) => ({ impressions: null, reach: null, views: null, likes: null, comments: null, shares: null, saves: null, linkClicks: null, profileVisits: null, followersGained: null, ...over });
const stat = (id, over = {}) => ({ id, capturedAt: '2026-10-26T08:00:00.000Z', enteredAt: '2026-10-26T08:05:00.000Z', counts: counts({ impressions: 1200 }), watchTime: null, note: '', sources: [], ...over });
const post = (over = {}) => ({ id: 'p1', conceptId: 'c1', platform: 'linkedin', format: 'text', scheduledAt: '2026-10-27T09:00:00.000Z', status: 'published', note: null, createdAt: '2026-10-26T09:00:00.000Z', needs: [], publishedAt: '2026-10-26T07:00:00.000Z', liveUrl: 'https://example.com/p', stats: null, ...over });
const urls = { image: (i) => `/img/${i}`, zip: '/zip', video: '/video' };
const noop = () => {};
const formProps = (over = {}) => ({ post: post({ status: 'finalized', publishedAt: null, liveUrl: null }), mode: 'publish', media: { text: 'Hello <world>', images: null, video: null }, urls, timeZone: 'Europe/Berlin', url: '', at: '2026-10-26T11:00', errors: {}, error: null, pending: false, readOnly: false, onUrl: noop, onAt: noop, onCopy: noop, onSubmit: noop, onCancel: noop, ...over });
const publishForm = (over) => render('src/ui/content/PublishDialog.tsx', 'PublishForm', formProps(over));
const listProps = (over = {}) => ({ platform: 'linkedin', format: 'text', snapshots: [stat('s1')], timeZone: 'UTC', readOnly: false, confirmingId: null, error: null, now: NOW, sourceUrl: (a, b) => `/src/${a}/${b}`, onEdit: noop, onAskDelete: noop, onConfirmDelete: noop, onCancelDelete: noop, ...over });
const formView = (over = {}) => ({ platform: 'linkedin', format: 'text', timeZone: 'UTC', form: { capturedAt: '2026-10-26T09:00:00.000Z', counts: {}, watchTime: '', note: '', fromAgent: [] }, errors: {}, saveError: null, pending: false, readOnly: false, editing: false, extractText: '', files: [], extracting: false, uploadError: null, failure: null, unused: null, onField: noop, onCaptured: noop, onWatch: noop, onNote: noop, onText: noop, onFiles: noop, onRemoveFile: noop, onExtract: noop, onSave: noop, onCancel: noop, ...over });

test('C01 the Publish dialog shows the platform, format, the finalized text (escaped) with Copy, and Mark as published', async () => {
  const html = await publishForm();
  assert.match(html, /LinkedIn/); assert.match(html, /Text/);
  assert.match(html, /Hello &lt;world&gt;/);
  assert.match(html, />Copy</);
  assert.match(html, /Live post URL/); assert.match(html, /Published at/); assert.match(html, /in Europe\/Berlin/);
  assert.match(html, />Mark as published</);
});

test('C02 an image set has a download link per image and Download all as a zip', async () => {
  const html = await publishForm({ media: { text: 'T', images: [{ index: 0, name: 'a.png', missing: false }, { index: 1, name: 'b.png', missing: false }], video: null } });
  assert.match(html, /href="\/img\/0"[^>]*download/); assert.match(html, /href="\/img\/1"/);
  assert.match(html, /href="\/zip"[^>]*download|download[^>]*href="\/zip"/); assert.match(html, /Download all \(zip\)/);
});

test('C03/C04 a video downloads; a missing file says so and Mark as published stays enabled', async () => {
  const video = await publishForm({ media: { text: 'T', images: null, video: { name: 'cut.mp4', missing: false } } });
  assert.match(video, /href="\/video"/); assert.match(video, /cut\.mp4/);
  const missing = await publishForm({ media: { text: 'T', images: [{ index: 0, name: 'a.png', missing: true }], video: { name: 'v.mp4', missing: true } } });
  assert.equal((missing.match(/File missing/g) ?? []).length, 2);
  assert.ok(!/href="\/img\/0"/.test(missing) && !/href="\/video"/.test(missing));
  assert.ok(!/<button[^>]*disabled=""[^>]*>Mark as published/.test(missing));
});

test('C05/C06 validation errors are announced; the edit mode has only URL and time', async () => {
  const bad = await publishForm({ errors: { liveUrl: 'Enter an http or https URL', publishedAt: 'The time cannot be in the future' }, url: 'nope' });
  assert.match(bad, /id="publish-url"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="publish-url"/);
  assert.match(bad, /role="alert"[^>]*>Enter an http or https URL/);
  assert.match(bad, /The time cannot be in the future/);
  const edit = await publishForm({ mode: 'edit', post: post(), url: 'https://example.com/p' });
  assert.match(edit, /Edit publish details/); assert.match(edit, /value="https:\/\/example.com\/p"/);
  assert.ok(!/Download all/.test(edit) && !/>Copy</.test(edit));
  assert.match(edit, />Save</);
  assert.match(await publishForm({ pending: true }), /Saving…/);
  assert.match(await publishForm({ readOnly: true }), /disabled/);
});

test('C07/C08/C09 the Overview offers Publish on finalized only; a published row has the link, time, edit and unpublish', () => {
  const overview = src('ui/content/OverviewTab.tsx');
  assert.match(overview, /can\.publish && <Button[\s\S]*?>Publish<\/Button>/);
  assert.match(overview, /postActions\(post\.status, concept\.imported\)/);
  assert.match(overview, /Edit publish details/);
  assert.match(overview, /Confirm unpublish/);
  assert.match(overview, /disabled=\{disabled \|\| !can\.delete\}/);
});
test('C08/C09 a published post shows its link (http only, safe rel) and RelativeTime; a long URL is truncated with the full text in its title', async () => {
  const html = await render('src/ui/content/OverviewTab.tsx', 'PublishedInfo', { post: post(), timeZone: 'UTC', now: NOW });
  assert.match(html, /<a href="https:\/\/example.com\/p" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<time/);
  assert.match(html, /No stats yet/);
  const long = `https://example.com/${'a'.repeat(1980)}`;
  const longHtml = await render('src/ui/content/OverviewTab.tsx', 'PublishedInfo', { post: post({ liveUrl: long }), timeZone: 'UTC', now: NOW });
  assert.match(longHtml, /truncate/); assert.match(longHtml, /overflow-wrap:anywhere/); assert.ok(longHtml.includes(`title="${long}"`));
  const unsafe = await render('src/ui/content/OverviewTab.tsx', 'PublishedInfo', { post: post({ liveUrl: 'javascript:alert(1)' }), timeZone: 'UTC', now: NOW });
  assert.ok(!/<a /.test(unsafe));
  assert.equal(await render('src/ui/content/OverviewTab.tsx', 'PublishedInfo', { post: post({ status: 'finalized', publishedAt: null }), timeZone: 'UTC' }), '');
});

test('C10 the stats summary and list: none, one, many, unknown as a dash, signs and 10^12', async () => {
  assert.match(await render('src/ui/content/StatsView.tsx', 'StatsList', listProps({ snapshots: [] })), /No stats yet/);
  const one = await render('src/ui/content/StatsView.tsx', 'StatsList', listProps({ snapshots: [stat('s1', { counts: counts({ impressions: 1_000_000_000_000, likes: 0 }) })] }));
  assert.match(one, /1,000,000,000,000/); assert.match(one, />0</); assert.match(one, /Reactions/);
  assert.match(one, /<dd class="m-0 break-words tabular-nums">—<\/dd>/);
  const many = await render('src/ui/content/StatsView.tsx', 'StatsList', listProps({ snapshots: [stat('s1'), stat('s2'), stat('s3')] }));
  assert.equal((many.match(/<li class="grid gap-2/g) ?? []).length, 3);
  const summary = (stats) => render('src/ui/content/StatsView.tsx', 'StatsSummaryLine', { platform: 'linkedin', stats, timeZone: 'UTC', now: NOW });
  assert.match(await summary(null), /No stats yet/);
  const line = await summary({ count: 2, latest: stat('s2', { counts: counts({ impressions: 1500, likes: 0, comments: 4 }) }), delta: counts({ impressions: 300, likes: 0, comments: -2 }) });
  assert.match(line, /\+300/); assert.match(line, /−2/); assert.match(line, /Impressions/);
  assert.ok(!/Clicks/.test(line), 'an unknown count is left out, not shown as 0');
  const noDelta = await summary({ count: 1, latest: stat('s1'), delta: null });
  assert.ok(!/\+|−/.test(noDelta));
  const dash = await summary({ count: 2, latest: stat('s2'), delta: counts({ impressions: null }) });
  assert.match(dash, /—/);
});

test('C11 kept sources show as thumbnails and links; delete asks inline first', async () => {
  const sources = [{ id: 'src1', kind: 'image', name: 'screenshot-1.png', size: 5, contentType: 'image/png' }, { id: 'src2', kind: 'text', name: 'pasted-text.txt', size: 5, contentType: 'text/plain' }];
  const html = await render('src/ui/content/StatsView.tsx', 'StatsList', listProps({ snapshots: [stat('s1', { sources })] }));
  assert.match(html, /<img src="\/src\/s1\/src1" alt="screenshot-1.png"/); assert.match(html, /pasted-text\.txt/); assert.match(html, /rel="noopener noreferrer"/);
  const confirming = await render('src/ui/content/StatsView.tsx', 'StatsList', listProps({ confirmingId: 's1' }));
  assert.match(confirming, /Delete this snapshot\?/); assert.match(confirming, />Keep</);
  assert.ok(!/Delete this snapshot/.test(html));
});

test('C12 Add stats shows each platform\'s own counts and watch time only on video and reel', async () => {
  const labels = { linkedin: ['Impressions', 'Reactions', 'Reposts', 'Clicks'], instagram: ['Reach', 'Saves', 'Profile visits'], x: ['Views', 'Replies', 'Bookmarks'], facebook: ['Reach', 'Reactions', 'Link clicks'], blog: ['Views', 'Link clicks', 'Comments'] };
  for (const [platform, list] of Object.entries(labels)) {
    const html = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ platform }));
    for (const label of list) assert.ok(html.includes(label), `${platform} ${label}`);
    assert.ok(!html.includes('Average watch time'), `${platform} text`);
  }
  assert.match(await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ platform: 'instagram', format: 'reel' })), /Average watch time/);
  const html = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView());
  assert.match(html, /Captured at/); assert.match(html, /in UTC/); assert.match(html, /Note/); assert.match(html, /Fill from text or screenshots/); assert.match(html, />Extract</); assert.match(html, /placeholder="—"/);
});

test('C13/C14/C15 the pre-filled form marks agent values and lists what was not used; a failure keeps the form usable; extracting disables only Extract', async () => {
  const pre = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ form: { capturedAt: '2026-10-26T09:00:00.000Z', counts: { impressions: '1200', likes: '3' }, watchTime: '', note: '', fromAgent: ['impressions', 'capturedAt'] }, unused: 'Not used: Hearts' }));
  assert.equal((pre.match(/data-from-agent/g) ?? []).length, 2);
  assert.match(pre, /value="1200"/); assert.match(pre, /Not used: Hearts/);
  const failed = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ failure: 'Could not read the stats: the agent took longer than 120 seconds' }));
  assert.match(failed, /Could not read the stats: the agent took longer/);
  assert.ok(!/<input[^>]*id="stat-impressions"[^>]*disabled=""/.test(failed) && !/<button[^>]*disabled=""[^>]*>Save/.test(failed));
  const busy = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ extracting: true }));
  assert.match(busy, /motion-reduce:animate-none/); assert.match(busy, /disabled=""[^>]*>[^<]*<svg[^>]*animate-spin|Reading…/);
  assert.ok(!/<input[^>]*id="stat-impressions"[^>]*disabled=""/.test(busy), 'fields stay usable while extracting');
});

test('C16/C17 the drop zone states its limits and lists files; editing an existing snapshot hides the extraction area', async () => {
  const html = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ files: [{ name: 'a.png', size: 2048 }], uploadError: 'At most 10 images' }));
  assert.match(html, /1 to 10, PNG, JPEG or WebP, up to 10 MB each/); assert.match(html, /a\.png \(2 KB\)/); assert.match(html, /aria-label="Remove a\.png"/); assert.match(html, /At most 10 images/);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
  const edit = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ editing: true, form: { capturedAt: '2026-10-26T09:00:00.000Z', counts: { impressions: '5' }, watchTime: '', note: 'n', fromAgent: [] } }));
  assert.match(edit, /aria-label="Edit stats"/); assert.ok(!/Fill from text/.test(edit));
  const errs = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ errors: { capturedAt: 'The time cannot be in the future', counts: 'Enter at least one count', impressions: 'Whole number from 0 to 1,000,000,000,000' } }));
  assert.match(errs, /The time cannot be in the future/); assert.match(errs, /Enter at least one count/); assert.match(errs, /aria-invalid="true"/);
});

test('C18 the list has the Most views sort and shows a dash for a Concept with no stats; Publish sits on finalized posts', async () => {
  const bar = await render('src/ui/content/ConceptList.tsx', 'ListFiltersBar', { filters: { status: '', platform: '', archived: false, search: '', sort: 'views' }, onChange: noop });
  assert.match(bar, /Most views/); assert.match(bar, /Newest first/); assert.match(bar, /<option value="views" selected/);
  const concept = (posts) => ({ id: 'c1', title: 'Launch', brief: '', archived: false, createdAt: '', updatedAt: '', posts, assets: [], progress: { finalized: 0, needed: 0 } });
  const rows = (cs, extra = {}) => render('src/ui/content/ConceptList.tsx', 'ConceptRows', { page: { rows: cs, total: cs.length, limit: 50, offset: 0, hasMore: false }, loading: false, error: null, timeZone: 'UTC', now: NOW, onOpen: noop, onNew: noop, ...extra });
  assert.match(await rows([concept([post({ stats: { count: 1, latest: stat('s1', { counts: counts({ views: 1234 }) }), delta: null } })])], { showViews: true }), /Views 1,234/);
  assert.match(await rows([concept([])], { showViews: true }), /Views —/);
  assert.ok(!/Views/.test(await rows([concept([])])));
  const publish = await rows([concept([post({ status: 'finalized', publishedAt: null, liveUrl: null }), post({ id: 'p2', status: 'draft' })])], { onPublish: noop });
  assert.equal((publish.match(/>Publish LinkedIn text</g) ?? []).length, 1);
  assert.match(await rows([concept([post({ status: 'finalized' })])], { onPublish: noop, readOnly: true }), /disabled=""[^>]*>Publish/);
  assert.ok(!/Publish LinkedIn/.test(await rows([concept([post({ status: 'published' })])], { onPublish: noop })));
});

test('C19 the calendar chip sits on the published day and opens its Concept', async () => {
  const p = { ...post({ publishedAt: '2026-10-25T19:00:00.000Z', scheduledAt: '2026-11-03T09:00:00.000Z' }), conceptTitle: 'Launch' };
  const weeks = monthGrid('2026-10', [p], 'Asia/Kolkata');
  const html = await render('src/ui/content/CalendarView.tsx', 'MonthGrid', { weeks, timeZone: 'Asia/Kolkata', onOpen: noop });
  assert.match(html, /data-day="2026-10-26"[^>]*>(?:(?!data-day).)*Launch/s);
  assert.ok(!/data-day="2026-11-03"[^>]*>(?:(?!data-day).)*Launch/s.test(html));
});

const paneView = () => ({ rev: 1, conceptId: 'c1', assetId: 'a1', asset: { state: 'finalized', round: 1, finalizedAt: '2026-10-26T08:00:00.000Z', content: 'Final' }, session: null, rounds: [], skillWarning: null });
const paneProps = (over = {}) => ({ view: paneView(), blocked: null, readOnly: false, error: null, busy: false, confirmOpen: false, onAction: noop, onAskNewSession: noop, onCancelNewSession: noop, renderTerminal: () => null, now: NOW, ...over });
test('C20 Reopen is disabled with the reason when a published post uses the asset, and enabled otherwise', async () => {
  const blocked = await render('src/ui/content/StudioPaneView.tsx', 'StudioPaneView', paneProps({ reopenBlocked: 'Used by a published post' }));
  assert.match(blocked, /<button[^>]*disabled=""[^>]*title="Used by a published post"[^>]*>Reopen<\/button>|<button[^>]*title="Used by a published post"[^>]*disabled=""[^>]*>Reopen/);
  const free = await render('src/ui/content/StudioPaneView.tsx', 'StudioPaneView', paneProps());
  assert.ok(!/<button[^>]*disabled=""[^>]*>Reopen/.test(free));
});

test('C21 read-only disables every new control', async () => {
  const form = await render('src/ui/content/StatsView.tsx', 'StatsForm', formView({ readOnly: true }));
  for (const id of ['stat-captured', 'stat-impressions', 'stat-note']) assert.ok(new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*disabled=""`).test(form), id);
  assert.match(form, /disabled=""[^>]*>Save/); assert.match(form, /disabled=""[^>]*>Extract/);
  const list = await render('src/ui/content/StatsView.tsx', 'StatsList', listProps({ readOnly: true }));
  assert.match(list, /disabled=""[^>]*>Edit/); assert.match(list, /disabled=""[^>]*aria-label="Delete snapshot"|aria-label="Delete snapshot"[^>]*disabled=""/);
  const dialog = await publishForm({ readOnly: true });
  for (const id of ['publish-url', 'publish-at']) assert.ok(new RegExp(`<input[^>]*id="${id}"[^>]*disabled=""`).test(dialog), id);
});

test('C22 the wiring is pinned by name: Publish dialog, Stats section, Reopen reason and the calendar day', () => {
  assert.match(src('ui/content/OverviewTab.tsx'), /<PublishDialog /); assert.match(src('ui/content/OverviewTab.tsx'), /<StatsSection /);
  assert.match(src('ui/content/ConceptList.tsx'), /<PublishDialog /);
  assert.match(src('ui/content/StatsSection.tsx'), /shouldDiscard|discardExtraction/);
  assert.match(src('ui/content/StatsSection.tsx'), /Add stats/);
  assert.match(src('ui/content/StudioPane.tsx'), /reopenBlockReason/);
  assert.match(src('lib/contentCalendar.ts'), /placedDay/);
  assert.match(src('lib/contentApi.ts'), /form\.append\('images', file\)/);
});
