import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// A browser zone far ahead of UTC and different from every Building zone below: the helpers must use the Building's zone.
process.env.TZ = 'Pacific/Auckland';

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
const cal = await import('../src/lib/contentCalendar.ts');
const zone = await import('../src/lib/contentZone.ts');
const defaults = await import('../src/lib/contentDefaults.ts');
const view = await import('../src/lib/contentView.ts');
const workspace = await import('../src/lib/contentWorkspace.ts');
const buildingTypes = await import('../src/lib/buildingTypes.ts');
const { ApiError } = await import('../src/lib/serverApi.ts');

const post = (id, scheduledAt, extra = {}) => ({ id, conceptId: 'c1', conceptTitle: `T${id}`, platform: 'x', format: 'text', scheduledAt, status: 'draft', note: null, createdAt: scheduledAt, needs: [], ...extra });
const cell = (weeks, day) => weeks.flat().find((c) => c.day === day);

test('WU01/WU03 the Concept tab bar order, labels and a reason for every conditional tab', () => {
  assert.deepEqual(rules.CONCEPT_TABS.map((t) => t.label), ['Overview', 'Script', 'Video', 'Thumbnail', 'Remotion', 'Images', 'Post content', 'Captions', 'Blog']);
  const none = rules.conceptTabStates([]);
  assert.deepEqual(none.filter((t) => t.enabled).map((t) => t.key), ['overview', 'script']);
  for (const t of none.filter((x) => !x.enabled)) assert.ok(t.reason.length > 0, t.key);
});

test('WU02 each conditional tab flips with one post added or removed', () => {
  const on = (posts, key) => rules.conceptTabStates(posts, { scriptFinalized: true, compositionReady: true }).find((t) => t.key === key).enabled;
  const cases = { captions: ['instagram', 'image'], blog: ['blog', 'article'], 'post-content': ['facebook', 'text'], images: ['x', 'image'], video: ['linkedin', 'video'], remotion: ['instagram', 'reel'] };
  for (const [key, [platform, format]] of Object.entries(cases)) {
    assert.equal(on([], key), false, `${key} off without posts`);
    assert.equal(on([{ platform, format }], key), true, `${key} on with ${platform} ${format}`);
  }
  assert.equal(on([{ platform: 'x', format: 'text' }], 'images'), false);
  assert.equal(on([{ platform: 'instagram', format: 'reel' }], 'post-content'), false);
  assert.equal(on([{ platform: 'linkedin', format: 'carousel' }], 'images'), true);
});

test('WU04 month grids are whole Monday-first weeks, including a leap February', () => {
  const shape = (month) => cal.monthGrid(month, [], 'UTC').map((w) => w.length);
  assert.deepEqual(shape('2026-10'), [7, 7, 7, 7, 7]);
  assert.equal(cal.monthGrid('2026-10', [], 'UTC')[0][0].day, '2026-09-28');
  assert.equal(cal.monthGrid('2028-02', [], 'UTC').flat().filter((c) => c.inMonth).length, 29);
  assert.equal(cal.monthGrid('2027-02', [], 'UTC').length, 4);
  assert.equal(cal.monthGrid('2026-08', [], 'UTC').length, 6);
});

test('WU05/WU06 posts land on their day in the Building zone, not the browser zone', () => {
  const instants = { late: '2026-10-26T23:30:00Z', early: '2026-10-27T00:00:00Z' };
  // Berlin (UTC+1 after the clock change): 23:30Z is 00:30 on the 27th; Auckland (the browser) would say the 27th too, so also check a zone behind UTC.
  const berlin = cal.monthGrid('2026-10', [post('a', instants.late)], 'Europe/Berlin');
  assert.equal(cell(berlin, '2026-10-27').posts.length, 1);
  const la = cal.monthGrid('2026-10', [post('a', instants.late)], 'America/Los_Angeles');
  assert.equal(cell(la, '2026-10-26').posts.length, 1);
  const kolkata = cal.monthGrid('2026-10', [post('a', '2026-10-26T18:30:00Z'), post('b', '2026-10-26T18:29:00Z')], 'Asia/Kolkata');
  assert.deepEqual([cell(kolkata, '2026-10-27').posts.map((p) => p.id), cell(kolkata, '2026-10-26').posts.map((p) => p.id)], [['a'], ['b']], '00:00 and 23:59 local');
  // The clock change day (Berlin, 25 October) still holds posts at both ends.
  const dst = cal.monthGrid('2026-10', [post('a', '2026-10-24T22:00:00Z'), post('b', '2026-10-25T22:59:00Z')], 'Europe/Berlin');
  assert.deepEqual(cell(dst, '2026-10-25').posts.map((p) => p.id), ['a', 'b']);
});

test('WU07 month navigation crosses year ends and Today uses the Building zone', () => {
  assert.equal(cal.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(cal.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(cal.shiftMonth('2026-05', 0), '2026-05');
  const instant = Date.parse('2026-12-31T23:30:00Z');
  assert.equal(cal.monthOf(instant, 'Pacific/Auckland'), '2027-01');
  assert.equal(cal.monthOf(instant, 'America/Los_Angeles'), '2026-12');
});

test('WU08 a day shows three chips and "+N more" for the rest, in time order', () => {
  const day = (n) => Array.from({ length: n }, (_, i) => post(`p${i}`, `2026-10-14T${String(10 + n - i).padStart(2, '0')}:00:00Z`));
  const three = cell(cal.monthGrid('2026-10', day(3), 'UTC'), '2026-10-14');
  assert.deepEqual([three.shown.length, three.more], [3, 0]);
  const four = cell(cal.monthGrid('2026-10', day(4), 'UTC'), '2026-10-14');
  assert.deepEqual([four.shown.length, four.more, cal.moreLabel(four.more)], [3, 1, '+1 more']);
  assert.deepEqual(four.posts.map((p) => p.scheduledAt), [...four.posts.map((p) => p.scheduledAt)].sort());
});

test('WU09 asset states read Not started / Drafting / Finalized and never the raw word empty', () => {
  assert.deepEqual(['empty', 'drafting', 'finalized'].map(view.assetStateLabel), ['Not started', 'Drafting', 'Finalized']);
  assert.equal(view.assetStateLabel('mystery'), 'Not started');
  assert.equal(view.assetLabel('post-text', 'instagram'), 'Caption');
  assert.equal(view.assetLabel('post-text', 'x'), 'Tweet');
  assert.equal(view.assetLabel('post-text'), 'Post text');
  assert.equal(view.assetLabel('image-set'), 'Images');
  assert.equal(view.formatLabel('reel'), 'Reel');
  assert.equal(view.formatLabel('odd'), 'odd');
});

test('WU11/WU12 remembered choices: round trip, bad data dropped, throwing storage ignored', () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(defaults.loadChoices(store), defaults.emptyChoices());
  const picked = defaults.toggleFormat(defaults.toggleFormat(defaults.emptyChoices(), 'linkedin', 'video'), 'linkedin', 'text');
  defaults.saveChoices(picked, store);
  assert.deepEqual(defaults.loadChoices(store).linkedin, { on: true, formats: ['video', 'text'] });
  mem.set(defaults.DEFAULTS_KEY, '{not json');
  assert.deepEqual(defaults.loadChoices(store), defaults.emptyChoices());
  mem.set(defaults.DEFAULTS_KEY, JSON.stringify({ linkedin: { on: true, formats: ['reel', 'text', 4] }, myspace: { on: true, formats: ['text'] }, x: 'bad', instagram: null }));
  const cleaned = defaults.loadChoices(store);
  assert.deepEqual([cleaned.linkedin, cleaned.x, cleaned.instagram], [{ on: true, formats: ['text'] }, { on: false, formats: [] }, { on: false, formats: [] }]);
  mem.set(defaults.DEFAULTS_KEY, '[1]');
  assert.deepEqual(defaults.loadChoices(store), defaults.emptyChoices());
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
  assert.deepEqual(defaults.loadChoices(broken), defaults.emptyChoices());
  assert.doesNotThrow(() => defaults.saveChoices(picked, broken));
  assert.deepEqual(defaults.loadChoices(null), defaults.emptyChoices());
});

test('WU13 "Will create N posts" counts every ticked format and ignores an unticked platform', () => {
  let c = defaults.emptyChoices();
  assert.equal(defaults.willCreateLabel(c), 'Will create 0 posts');
  c = defaults.toggleFormat(c, 'linkedin', 'text');
  assert.equal(defaults.willCreateLabel(c), 'Will create 1 post');
  c = defaults.toggleFormat(defaults.toggleFormat(c, 'instagram', 'reel'), 'instagram', 'image');
  assert.equal(defaults.willCreateLabel(c), 'Will create 3 posts');
  c = defaults.togglePlatform(c, 'instagram');
  assert.equal(defaults.willCreateLabel(c), 'Will create 1 post', 'an unticked platform ignores its formats');
  assert.deepEqual(defaults.postsToCreate(defaults.togglePlatform(defaults.emptyChoices(), 'blog')), [{ platform: 'blog', format: 'article' }], 'a one-format platform ticks its format');
  assert.equal(defaults.willCreateLabel(defaults.clearChoices()), 'Will create 0 posts');
});

test('WU14 Apply to all copies the date into ticked platforms only and leaves each editable', () => {
  let form = defaults.newConceptForm(defaults.toggleFormat(defaults.emptyChoices(), 'linkedin', 'text'));
  assert.equal(defaults.applyDateToAll(form), form, 'an empty source is a no-op');
  form = { ...form, allAt: '2026-11-03T09:00' };
  const applied = defaults.applyDateToAll(form);
  assert.deepEqual([applied.at.linkedin, applied.at.x], ['2026-11-03T09:00', '']);
  assert.equal({ ...applied, at: { ...applied.at, linkedin: '2026-11-04T10:00' } }.at.linkedin, '2026-11-04T10:00');
});

test('WU15 the dialog checks title, brief and dates before any request; zero posts is allowed', () => {
  const base = defaults.newConceptForm();
  assert.deepEqual(defaults.checkNewConcept(base, 'UTC').errors, ['Give the concept a title']);
  assert.deepEqual(defaults.checkNewConcept({ ...base, title: 'Ok' }, 'UTC'), { errors: [], title: 'Ok', posts: [] });
  assert.match(defaults.checkNewConcept({ ...base, title: 'x'.repeat(201) }, 'UTC').errors[0], /200/);
  assert.match(defaults.checkNewConcept({ ...base, title: 'ok', brief: 'b'.repeat(5001) }, 'UTC').errors[0], /5000/);
  const ticked = { ...base, title: 'Ok', choices: defaults.toggleFormat(defaults.emptyChoices(), 'x', 'text') };
  assert.match(defaults.checkNewConcept(ticked, 'UTC').errors[0], /date and time for x/);
  const dated = defaults.checkNewConcept({ ...ticked, at: { ...ticked.at, x: '2026-11-03T09:00' } }, 'Europe/Berlin');
  assert.deepEqual(dated.posts, [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T08:00:00.000Z' }]);
});

test('WU16 datetime-local text and instants convert in the Building zone, including a DST gap and overlap', () => {
  assert.equal(zone.localTextToInstant('2026-11-03T09:00', 'Asia/Kolkata'), '2026-11-03T03:30:00.000Z');
  assert.equal(zone.instantToLocalText('2026-11-03T03:30:00.000Z', 'Asia/Kolkata'), '2026-11-03T09:00');
  assert.equal(zone.localTextToInstant('2026-03-29T02:30', 'Europe/Berlin'), '2026-03-29T01:30:00.000Z', 'a skipped hour lands just after the gap');
  assert.equal(zone.localTextToInstant('2026-10-25T02:30', 'Europe/Berlin'), '2026-10-25T01:30:00.000Z', 'the repeated hour reads as its second (standard-time) occurrence');
  for (const bad of ['', '2026-11-03', '2026-11-03T25:00', 'nope']) assert.equal(zone.localTextToInstant(bad, 'UTC'), null, bad);
  assert.equal(zone.instantToLocalText(Date.parse('2026-01-01T00:00:00Z'), 'Pacific/Auckland'), '2026-01-01T13:00');
});

test('WU17 timezone options: the browser zone first, the Building zone kept, a fallback list without the API', () => {
  assert.deepEqual(zone.timezoneOptions('Asia/Tokyo', ['UTC', 'Asia/Tokyo', 'Europe/Berlin'], 'Europe/Berlin'), ['Asia/Tokyo', 'Europe/Berlin', 'UTC']);
  assert.equal(zone.timezoneOptions('Mars/Base', ['UTC'])[0], 'Mars/Base');
  assert.ok(zone.timezoneOptions('UTC', null).includes('Europe/Berlin'));
  assert.ok(zone.timezoneOptions('UTC', [], 'Africa/Cairo').includes('Africa/Cairo'));
  assert.equal(zone.browserTimezone(), 'Pacific/Auckland');
  assert.ok(zone.supportedTimezones().includes('Europe/Berlin'));
});

test('WU18 list filters become a query with empty ones left out', () => {
  assert.deepEqual(view.listParams(view.emptyFilters()), { limit: 50, offset: undefined, status: '', platform: '', result: '', imported: '', archived: false, q: '' });
  assert.deepEqual(view.listParams({ status: 'draft', platform: 'x', result: 'partly', archived: true, search: ' 100% ' }, 50, 20), { limit: 20, offset: 50, status: 'draft', platform: 'x', result: 'partly', imported: undefined, archived: true, q: '100%' });
});

test('WU19 the stale-version banner: opened, conflict, then Reload or Overwrite', () => {
  const opened = view.openDoc('v1', 'mine');
  const typed = view.editDoc(opened, 'mine!');
  assert.equal(view.isDirty(typed), true);
  assert.equal(view.isDirty(opened), false);
  const conflict = view.markConflict(typed, 'v2');
  assert.equal(view.overwriteVersion(conflict), 'v2');
  assert.equal(view.overwriteVersion(typed), 'v1');
  assert.deepEqual(view.savedDoc(conflict, 'v3'), { version: 'v3', saved: 'mine!', text: 'mine!', conflictVersion: null });
  assert.deepEqual(view.openDoc('v2', 'agent text'), { version: 'v2', saved: 'agent text', text: 'agent text', conflictVersion: null });
  assert.equal(view.staleVersionOf(new ApiError('x', 409, { details: { current: 'v9' } })), 'v9');
  assert.equal(view.staleVersionOf(new ApiError('x', 409, {})), null);
  assert.equal(view.staleVersionOf(new ApiError('x', 400, { details: { current: 'v9' } })), null);
  assert.equal(view.staleVersionOf(new Error('x')), null);
  assert.deepEqual(view.missingFrom(new ApiError('x', 409, { details: { missing: ['post-text', 'video'] } })), ['post-text', 'video']);
  assert.equal(view.missingFrom(new ApiError('x', 409, {})), null);
  assert.equal(view.missingMessage(['post-text', 'video'], 'instagram'), 'Not ready: Caption, Video not finalized');
});

test('WU20 a read-only Building disables every write control', () => {
  assert.equal(view.controlsDisabled(true), true);
  assert.equal(view.controlsDisabled(false), false);
});

test('WU21/WU22 platform labels and status colours', () => {
  assert.equal(rules.PLATFORM_LABELS.x, 'X (Twitter)');
  assert.deepEqual(Object.keys(view.STATUS_TONE), ['draft', 'finalized', 'published']);
  assert.equal(new Set(Object.values(view.STATUS_TONE)).size, 3);
  assert.deepEqual(Object.values(view.STATUS_LABELS), ['Draft', 'Finalized', 'Published']);
});

test('the workspace state: opens on the Content list, a Concept replaces it, switching tabs resets', () => {
  assert.deepEqual(workspace.CONTENT_TABS.map((t) => t.label), ['Content', 'Knowledge', 'Writing style', 'Targets', 'Insights', 'Settings']);
  let s = workspace.initialContentState();
  assert.deepEqual([s.tab, s.view, s.conceptId, s.conceptTab], ['content', 'list', null, 'overview']);
  s = workspace.setView(s, 'calendar');
  s = workspace.openConcept(s, 'c1');
  assert.deepEqual([s.view, s.conceptId], ['calendar', 'c1']);
  assert.equal(workspace.selectConceptTab(s, 'images').conceptTab, 'images');
  assert.equal(workspace.openConcept(workspace.selectConceptTab(s, 'images'), 'c2').conceptTab, 'overview');
  assert.equal(workspace.closeConcept(s).conceptId, null);
  assert.equal(workspace.selectTab(s, 'content'), s);
  assert.deepEqual(workspace.selectTab(s, 'knowledge'), { tab: 'knowledge', view: 'list', conceptId: null, conceptTab: 'overview', importing: false });
});

test('the type has its own workspace kind', () => {
  assert.equal(buildingTypes.workspaceFor({ typeId: 'content-studio' }), 'content-studio');
  assert.equal(buildingTypes.workspaceFor({ typeId: 'content-studio', typeUnavailable: true }), 'unavailable');
  assert.equal(buildingTypes.lookFor({ typeId: 'content-studio' }, [{ id: 'content-studio', look: { color: '#8e6bbf' } }]).color, '#8e6bbf');
});

test('36.001 conceptStatus: Archived wins, then Draft / In progress / Ready from posts and progress', () => {
  const c = (posts, finalized, needed, archived = false) => ({ archived, posts: Array(posts).fill({}), progress: { finalized, needed } });
  assert.equal(view.conceptStatus(c(2, 4, 4, true)), 'Archived');
  assert.equal(view.conceptStatus(c(0, 0, 0)), 'Draft');
  assert.equal(view.conceptStatus(c(2, 0, 4)), 'Draft');
  assert.equal(view.conceptStatus(c(2, 1, 4)), 'In progress');
  assert.equal(view.conceptStatus(c(2, 4, 4)), 'Ready');
  assert.equal(view.conceptStatus(c(2, 3, 2)), 'Ready', 'more finalized than needed is still Ready');
  assert.equal(view.conceptStatus(c(1, 1, 0)), 'In progress', 'nothing needed is never Ready');
  assert.deepEqual(Object.fromEntries(['Draft', 'In progress', 'Ready', 'Archived'].map((l) => [l, view.CONCEPT_STATUS_VARIANT[l]])), { Draft: 'secondary', 'In progress': 'warning', Ready: 'success', Archived: 'secondary' });
});

test('36.001 conceptFactParts: progress (left out when nothing is needed) and a pluralised post count', () => {
  const c = (posts, finalized, needed) => ({ posts: Array(posts).fill({}), progress: { finalized, needed } });
  assert.deepEqual(view.conceptFactParts(c(3, 2, 4)), ['2 of 4 texts finalized', '3 posts']);
  assert.deepEqual(view.conceptFactParts(c(1, 0, 1)), ['0 of 1 texts finalized', '1 post']);
  assert.deepEqual(view.conceptFactParts(c(0, 0, 0)), ['0 posts']);
});
