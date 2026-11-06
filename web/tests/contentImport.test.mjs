import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const imp = await import('../src/lib/contentImport.ts');
const view = await import('../src/lib/contentView.ts');
const workspace = await import('../src/lib/contentWorkspace.ts');
const stats = await import('../src/lib/contentStats.ts');
const retro = await import('../src/lib/contentRetro.ts');
const { contentQuery } = await import('../src/lib/contentApi.ts');

/** The pure rules of importing past Concepts (W01-W13, W25 in the Test Case Planning list). */

const counts = (over = {}) => ({ impressions: null, reach: null, views: null, likes: null, comments: null, shares: null, saves: null, linkClicks: null, profileVisits: null, followersGained: null, ...over });
const asset = (kind, state = 'finalized', content = 'x') => ({ id: `a-${kind}`, kind, postId: null, state, content, finalizedAt: null, round: 0 });
const post = (over = {}) => ({ id: 'p1', conceptId: 'c1', platform: 'linkedin', format: 'text', scheduledAt: '2026-03-14T08:30:00Z', status: 'published', note: null, createdAt: '2026-03-14T08:30:00Z', needs: [], publishedAt: '2026-03-14T08:30:00Z', liveUrl: null, stats: null, result: null, externalAssets: null, ...over });
const concept = (over = {}) => ({ id: 'c1', title: 'Standups', brief: '', archived: false, imported: true, createdAt: '2026-10-29T10:00:00Z', updatedAt: '2026-10-29T10:00:00Z', posts: [post()], assets: [asset('script', 'empty', null)], progress: { finalized: 0, needed: 0 }, compositionId: null, ...over });
const session = (state) => ({ id: 's1', state, executorId: 'e', createdAt: 'x', updatedAt: 'x' });
const importView = (over = {}) => ({ rev: 1, session: null, saved: [], blockedReason: null, ...over });

test('W01 the import view opens in the Content tab, leaving it resets, and a Concept opened from it returns to the list', () => {
  const opened = workspace.openImport(workspace.initialContentState());
  assert.equal(opened.importing, true);
  assert.equal(workspace.closeImport(opened).importing, false);
  assert.equal(workspace.selectTab(opened, 'style').importing, false);
  const concept1 = workspace.openConcept(opened, 'c1');
  assert.equal(concept1.conceptId, 'c1');
  assert.equal(concept1.importing, false);
  const back = workspace.closeConcept(concept1);
  assert.deepEqual([back.conceptId, back.importing, back.view], [null, false, 'list']);
});

test('W02 the button reads Continue import only while a session runs; its title follows read-only', () => {
  assert.equal(imp.importButtonLabel(false), 'Import past concept');
  assert.equal(imp.importButtonLabel(true), 'Continue import');
  assert.equal(imp.importSessionRunning(importView({ session: session('running') })), true);
  assert.equal(imp.importSessionRunning(importView({ session: session('ended') })), false);
  assert.equal(imp.importSessionRunning(undefined), false);
  assert.equal(imp.importButtonTitle(true), view.READ_ONLY_TITLE);
  assert.equal(imp.importButtonTitle(false), imp.IMPORT_IDLE_TITLE);
});

test('W03 the filter maps to the imported parameter: empty sends nothing', () => {
  const q = (imported) => contentQuery(view.listParams({ ...view.emptyFilters(), imported }));
  assert.doesNotMatch(q(''), /imported/);
  assert.match(q('true'), /imported=true/);
  assert.match(q('false'), /imported=false/);
  assert.equal(view.emptyFilters().imported, '');
});

test('W04 the filter labels', () => {
  assert.deepEqual(imp.IMPORTED_FILTERS.map((f) => imp.IMPORTED_FILTER_LABELS[f]), ['Imported or not', 'Imported only', 'Not imported']);
});

test('W05 conceptStatus: imported with a published post reads Published, with zero progress too; all unpublished reads Ready; normal unchanged', () => {
  assert.equal(view.conceptStatus(concept()), 'Published');
  assert.equal(view.conceptStatus(concept({ posts: [post({ status: 'finalized' })], progress: { finalized: 1, needed: 1 } })), 'Ready');
  assert.equal(view.conceptStatus(concept({ archived: true })), 'Archived');
  assert.equal(view.conceptStatus(concept({ imported: false })), 'Draft');
  assert.equal(view.conceptStatus(concept({ imported: false, progress: { finalized: 1, needed: 1 } })), 'Ready');
  assert.equal(view.CONCEPT_STATUS_VARIANT.Published, 'success');
});

test('W06 the facts: Imported, the post count and Script when finalized; never the texts progress', () => {
  assert.equal(view.createdWord(concept()), 'Imported');
  assert.equal(view.createdWord(concept({ imported: false })), 'Created');
  assert.deepEqual(view.conceptFactParts(concept({ progress: { finalized: 1, needed: 2 } })), ['1 post']);
  assert.deepEqual(view.conceptFactParts(concept({ posts: [post(), post({ id: 'p2' })], assets: [asset('script')] })), ['2 posts', 'Script']);
  assert.deepEqual(view.conceptFactParts(concept({ imported: false, progress: { finalized: 1, needed: 2 } })), ['1 of 2 texts finalized', '1 post']);
});

test('W08 the empty state: Imported only offers the import, every other filter the existing copy', () => {
  assert.equal(imp.listEmptyKind('true'), 'imported');
  assert.equal(imp.listEmptyKind('false'), 'any');
  assert.equal(imp.listEmptyKind(''), 'any');
});

test('W09 imported post actions: published gets edit, stats, unpublish; unpublished gets publish and delete; never finalize or Back to draft', () => {
  const published = stats.postActions('published', true), unpublished = stats.postActions('finalized', true);
  assert.deepEqual([published.editPublish, published.addStats, published.unpublish, published.delete], [true, true, true, false]);
  assert.deepEqual([unpublished.publish, unpublished.delete, unpublished.unfinalize, unpublished.finalize], [true, true, false, false]);
  assert.equal(stats.postActions('draft', true).finalize, false);
  assert.equal(stats.postActions('finalized').unfinalize, true);
  assert.equal(stats.postActions('draft').finalize, true);
});

test('W10 read-only tab content: note, script, the selected post, Elsewhere lines and the empty texts', () => {
  assert.equal(imp.IMPORTED_NOTE, 'Imported content is read-only. Agents read it as reference.');
  const c = concept({
    assets: [asset('script', 'finalized', 'Hook line')],
    posts: [
      post({ id: 'p1', needs: [{ ...asset('post-text', 'finalized', 'LinkedIn words'), postId: 'p1' }], externalAssets: 'A clip on Drive' }),
      post({ id: 'p2', platform: 'x', needs: [] }),
      post({ id: 'p3', platform: 'instagram', format: 'reel', needs: [], externalAssets: 'Reel in Dropbox' }),
    ],
  });
  assert.deepEqual(imp.importedTabContent(c, 'script', null), { note: imp.IMPORTED_NOTE, text: 'Hook line', elsewhere: [], empty: null });
  assert.equal(imp.importedTabContent(concept(), 'script', null).empty, 'No script was imported.');
  const text = imp.importedTabContent(c, 'post-content', c.posts[0]);
  assert.deepEqual([text.text, text.elsewhere], ['LinkedIn words', ['Elsewhere: A clip on Drive']]);
  assert.equal(imp.importedTabContent(c, 'post-content', c.posts[1]).empty, 'No text was imported.');
  assert.deepEqual(imp.importedTabContent(c, 'video', null).elsewhere, ['Elsewhere: Reel in Dropbox']);
  assert.deepEqual(imp.importedTabContent(c, 'thumbnail', null).elsewhere, ['Elsewhere: Reel in Dropbox']);
  assert.equal(imp.importedTabContent(c, 'images', null).empty, 'No images were described for this Concept.');
  assert.equal(imp.importedTabContent(concept(), 'video', null).empty, 'No video was described for this Concept.');
  assert.deepEqual(imp.importedTabPosts(c, 'post-content').map((p) => p.id), ['p1', 'p2']);
  assert.deepEqual(imp.importedTabPosts(c, 'video'), []);
});

test('W11 the Learn model: idle, Learning…, proposal link, nothing, failed and the 409 text', () => {
  const at = 'x';
  assert.deepEqual(imp.learnModel(null, null, false), { button: 'Learn from this', running: false, disabled: false, title: undefined, line: null });
  const running = imp.learnModel({ status: 'running', at }, null, false);
  assert.deepEqual([running.button, running.disabled], ['Learning…', true]);
  assert.match(running.line.text, /^Learning…/);
  assert.deepEqual(imp.learnModel({ status: 'proposal', at, proposalId: 'x' }, null, false).line, { text: 'Done. A style proposal is ready:', link: true, alert: false });
  assert.match(imp.learnModel({ status: 'nothing', at }, null, false).line.text, /nothing new/);
  assert.equal(imp.learnModel({ status: 'nothing', at }, null, false).line.link, false);
  assert.match(imp.learnModel({ status: 'applied', at }, null, false).line.text, /in your writing style/);
  assert.deepEqual(imp.learnModel({ status: 'failed', at, reason: 'No agent' }, null, false).line, { text: 'Learning failed: No agent', link: false, alert: true });
  assert.equal(imp.learnModel({ status: 'failed', at }, null, false).line.text, 'Learning failed: unknown reason');
  assert.deepEqual(imp.learnModel(null, imp.LEARN_CONFLICT, false).line, { text: imp.LEARN_CONFLICT, link: false, alert: true });
  assert.equal(imp.learnModel({ status: 'discarded', at }, null, false).line, null);
  const ro = imp.learnModel(null, null, true);
  assert.deepEqual([ro.disabled, ro.title], [true, view.READ_ONLY_TITLE]);
});

test('W12 the six session states give the exact badge, box, button and footer', () => {
  const working = imp.importPaneModel(importView({ session: session('running') }), false, false);
  assert.deepEqual(working, { badge: 'Agent working', live: true, showTerminal: true, box: null, foot: imp.IMPORT_FOOT, canEnd: true, canStartNew: false });
  const starting = imp.importPaneModel(undefined, false, true);
  assert.deepEqual([starting.badge, starting.box.lead, starting.box.action], ['Starting', 'Starting the agent…', null]);
  assert.equal(imp.importPaneModel(importView(), false, false).badge, 'Starting');
  const ended = imp.importPaneModel(importView({ session: session('ended') }), false, false);
  assert.deepEqual([ended.badge, ended.box.lead, ended.box.sub, ended.box.actionLabel, ended.canStartNew, ended.canEnd, ended.foot], ['Session ended', 'Session ended', 'Everything the agent saved is kept.', 'Resume', true, false, null]);
  const blocked = imp.importPaneModel(importView({ blockedReason: 'No default coding agent is set' }), false, false);
  assert.deepEqual([blocked.badge, blocked.box.lead, blocked.box.actionLabel], ['No session', 'No default coding agent is set', 'Start']);
  const ro = imp.importPaneModel(importView({ session: session('ended') }), true, false);
  assert.deepEqual([ro.badge, ro.box.lead, ro.box.action, ro.canStartNew], ['No session', 'This Building is read-only, so no session is started.', null, false]);
  assert.equal(imp.importPaneModel(importView({ session: session('running') }), true, false).canEnd, false);
});

test('W13 the saved row: chips, the count, and stats or No stats (never 0 for unknown)', () => {
  const withStats = post({ stats: { count: 1, delta: null, latest: { counts: counts({ impressions: 12480, likes: 312 }) } } });
  const row = imp.importedRowModel(concept({ posts: [withStats, post({ id: 'p2', platform: 'x' })] }), 'UTC');
  assert.deepEqual(row.chips, ['LinkedIn text · 14 Mar 2026', 'X (Twitter) text · 14 Mar 2026']);
  assert.equal(row.stats, 'Impressions 12,480 · Reactions 312');
  assert.equal(imp.importedRowModel(concept(), 'UTC').stats, 'No stats');
  assert.equal(imp.importCount(importView({ saved: [concept(), concept({ id: 'c2' })] })), '(2)');
  assert.equal(imp.importCount(importView()), '');
});

test('W14 a toast fires once for each new Concept, never on the first look', () => {
  const a = concept({ id: 'a' }), b = concept({ id: 'b', title: 'Pricing' });
  assert.deepEqual(imp.newlyImported(null, [a]), []);
  assert.deepEqual(imp.newlyImported(new Set(['a']), [a]), []);
  assert.deepEqual(imp.newlyImported(new Set(['a']), [a, b]), [b]);
  assert.equal(imp.importedToast('Pricing'), 'Imported: Pricing');
});

test('W14b a late older view never replaces a newer one', () => {
  const older = importView({ rev: 1 }), newer = importView({ rev: 2 });
  assert.equal(imp.newerImportView(newer, older), newer);
  assert.equal(imp.newerImportView(older, newer), newer);
  assert.equal(imp.newerImportView(undefined, older), older);
});

test('C34a a Learn proposal reads Imported, not Script, and names no drafts line source', () => {
  assert.deepEqual(retro.sourceChips({ kind: 'imported', assetKind: 'script', platform: null, format: null }), ['Imported']);
  assert.deepEqual(retro.sourceChips({ kind: 'asset', assetKind: 'script', platform: null, format: null }), ['Script', 'Video script']);
  assert.deepEqual(retro.sourceChips({ assetKind: 'post-text', platform: 'x', format: 'text' }), ['Post text', 'X (Twitter) · Text']);
});

test('W25 no import dialog file and no concepts/import path anywhere in the web app', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const walk = (dir) => readdirSync(dir).flatMap((name) => { const file = path.join(dir, name); return statSync(file).isDirectory() ? walk(file) : [file]; });
  const files = walk(src);
  assert.ok(!existsSync(path.join(src, 'ui/content/ImportConceptDialog.tsx')));
  assert.equal(files.filter((f) => /Import.*Dialog/.test(path.basename(f))).length, 0);
  for (const file of files) assert.ok(!readFileSync(file, 'utf8').includes('concepts/import'), file);
});

test('D01-D08 the product doc records the import session', () => {
  const doc = readFileSync(new URL('../../docs/content-studio-building.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('## Imported Concepts'), doc.indexOf('## Publish (manual) and stats'));
  assert.ok(section.length > 2000, 'D01');
  const routes = doc.slice(doc.indexOf('## Routes'), doc.indexOf('## Limits'));
  for (const route of ['import-session/resume', 'import-session/new', 'import-session/end', 'concepts/:cid/learn']) assert.ok(routes.includes(route), `D02 ${route}`);
  assert.ok(routes.includes('There is no `concepts/import` route'), 'D02');
  for (const tool of ['save_imported_concept', 'get_reference_content']) assert.ok(section.includes(tool), `D03 ${tool}`);
  assert.match(doc.slice(doc.indexOf('## Limits')), /20 posts per Concept, post note 1,000 characters/, 'D04');
  assert.match(doc, /Imported Concepts \(37\.009\): the task's Import dialog/, 'D05');
  assert.match(doc.slice(doc.indexOf('## Concept view'), doc.indexOf('## Content tab')), /read-only tabs/, 'D06');
  assert.match(doc.slice(doc.indexOf('## Content tab')), /Import past concept/, 'D06');
  for (let i = 1; i <= 8; i++) assert.ok(doc.includes(`(M${i})`), `D07 M${i}`);
  assert.match(doc.slice(doc.indexOf('### Session kind (server)')), /import session is separate/, 'D08');
});
