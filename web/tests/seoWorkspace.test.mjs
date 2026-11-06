import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const seo = await import('../src/lib/seoWorkspace.ts');
const types = await import('../src/lib/buildingTypes.ts');
const { settingsSectionsFor } = await import('../src/lib/settingsSections.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { useSeoStore } = await import('../src/store/seoStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('W1 the tab order is Keywords, Sitemaps, Pages, Reports, Backlinks, Internal links, Tasks, Settings', () => {
  assert.deepEqual(seo.SEO_TABS.map((t) => t.label), ['Keywords', 'Sitemaps', 'Pages', 'Reports', 'Backlinks', 'Internal links', 'Tasks', 'Settings']);
});

test('W2 every tab has its own panel, so the workspace keeps no placeholder', () => {
  const shell = src('ui/SeoWorkspace.tsx');
  assert.equal(shell.includes('EmptyTab'), false);
  assert.equal('emptyStateFor' in seo, false);
  for (const panel of ['SeoKeywords', 'SeoPages', 'SeoSitemaps', 'SeoBacklinks', 'SeoTasks', 'SeoInternalLinks', 'SeoReports']) assert.ok(shell.includes(`<${panel} `), panel);
});

test('W3 a gap shows an em dash with "no data" and a stored zero shows 0', () => {
  assert.deepEqual(seo.formatMetric(null), { text: '—', title: 'no data' });
  assert.deepEqual(seo.formatMetric(undefined), { text: '—', title: 'no data' });
  assert.equal(seo.formatMetric(0).text, '0');
  assert.equal(seo.formatMetric(1234567).text, '1,234,567');
  assert.equal(seo.formatMetric(2.456, { digits: 1 }).text, '2.5');
});

test('W4 a missing optional connection shows Not connected, never zero', () => {
  assert.equal(seo.formatMetric(0, { connected: false }).text, 'Not connected');
  assert.equal(seo.formatMetric(null, { connected: false }).text, 'Not connected');
  assert.deepEqual(seo.OPTIONAL_SERVICES, ['ads', 'bing']);
});

test('W5 the connection card has the right label and actions for each of the four states', () => {
  const card = (state, extra = {}) => seo.connectionCard({ service: 'gsc', state, ...extra });
  assert.deepEqual([card('not-connected').statusLabel, card('not-connected').actions], ['Not connected', ['connect']]);
  assert.deepEqual(card('connected', { account: 'me@x.com', property: 'sc-domain:x.com' }).actions, ['choose-property', 'sync-now', 'disconnect']);
  assert.equal(card('connected', { account: 'me@x.com', property: 'p' }).detail, 'me@x.com · p');
  const attention = card('needs-attention', { reason: 'Sign-in expired' });
  assert.deepEqual([attention.statusLabel, attention.detail, attention.actions.includes('reconnect')], ['Needs attention', 'Sign-in expired', true]);
  assert.equal(card('syncing', { progress: { done: 5, total: 10 } }).detail, 'Syncing 50%');
  assert.deepEqual(seo.connectionCard({ service: 'bing', state: 'connected' }).actions, ['disconnect']);
});

test('W6 Sync now is disabled while syncing', () => {
  assert.equal(seo.connectionCard({ service: 'gsc', state: 'syncing' }).syncNowDisabled, true);
  assert.equal(seo.connectionCard({ service: 'gsc', state: 'connected' }).syncNowDisabled, false);
});

test('W7 the retention notice lists counts, the cutoff, the window and the year-over-year limit', () => {
  const notice = seo.retentionNotice({ months: 12, cutoff: '2025-03-15', total: 3, acknowledged: false, note: 'Comparisons older than 12 months are not available.', tables: [{ table: 'gsc_rows', label: 'Search Console rows', count: 3 }, { table: 'fetch_ledger', label: 'Fetch records', count: 9 }] });
  assert.match(notice.title, /12 months/);
  assert.ok(notice.lines[0].includes('3 search console rows dated before 2025-03-15'));
  assert.ok(!notice.lines.some((l) => l.includes('fetch records')));
  assert.match(notice.lines.at(-1), /not available/);
  assert.equal(notice.discardLabel, 'Discard 3 rows now');
  const none = seo.retentionNotice({ months: 1, cutoff: null, total: 0, acknowledged: true, note: 'n', tables: [] });
  assert.equal(none.discardLabel, 'Nothing to discard');
  assert.match(none.title, /1 month\?/);
});

test('W8 the create form accepts and refuses the same addresses as the daemon', () => {
  assert.equal(seo.validateSiteUrlInput('HTTPS://Example.COM:443/').normalized, 'https://example.com');
  assert.equal(seo.validateSiteUrlInput('https://example.com/blog/#top').normalized, 'https://example.com/blog');
  for (const bad of ['ftp://example.com', 'javascript:alert(1)', '', '   ', 'example.com', 'https://u:p@example.com', 'https://exa mple.com', `https://example.com/${'a'.repeat(2048)}`]) {
    assert.equal(seo.validateSiteUrlInput(bad).ok, false, bad);
  }
  const exact = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  assert.equal(seo.validateSiteUrlInput(exact).ok, true);
});

test('W9 bytes and counts format, including very large numbers', () => {
  assert.equal(seo.formatBytes(0), '0 B');
  assert.equal(seo.formatBytes(1536), '1.5 KB');
  assert.equal(seo.formatBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(seo.formatBytes(-1), '—');
  assert.equal(seo.formatBytes(2 ** 60), '1048576 TB');
  assert.equal(seo.formatCount(10_000_000), '10,000,000');
  assert.equal(seo.formatCount(Number.NaN), '—');
});

test('W10 volumes are labelled exact or range', () => {
  assert.match(seo.volumeLabel('exact'), /Exact/);
  assert.match(seo.volumeLabel('range'), /ranges/);
  assert.match(seo.volumeLabel(undefined), /not checked/);
});

test('W11 a secret field never carries a value, only Saved', () => {
  assert.deepEqual(seo.secretField(true), { value: '', placeholder: 'Saved. Type to replace', badge: 'Saved' });
  assert.deepEqual(seo.secretField(false), { value: '', placeholder: '', badge: null });
});

test('W12 the wording differs without and with the scheduler', () => {
  assert.match(seo.syncWording(false), /Sync now/);
  assert.match(seo.syncWording(false), /no daily schedule/);
  assert.match(seo.syncWording(true), /daily on the schedule/);
});

test('W13 progress is clamped to 0-100 and an unknown total reads as 0', () => {
  assert.equal(seo.progressPercent(5, 10), 50);
  assert.equal(seo.progressPercent(20, 10), 100);
  assert.equal(seo.progressPercent(-3, 10), 0);
  assert.equal(seo.progressPercent(3, 0), 0);
  assert.equal(seo.progressPercent(3, Number.NaN), 0);
});

test('W14 the Connections and Data sections belong to the SEO workspace only', () => {
  assert.deepEqual(seo.SEO_SETTINGS_SECTIONS.map((s) => s.label), ['Connections', 'Data']);
  assert.equal(types.workspaceFor({ typeId: 'seo' }), 'seo');
  assert.equal(types.workspaceFor({ typeId: 'software' }), 'software');
  assert.equal(types.workspaceFor({ typeId: 'notes' }), 'notes');
  assert.ok(!settingsSectionsFor({ repository: false, hasStorage: true }).includes('data'));
});

test('W15 the New Building picker offers every type the daemon lists, SEO included, others unchanged', () => {
  const list = [{ id: 'software', devOnly: false }, { id: 'seo', devOnly: false }, { id: 'notes', devOnly: true }];
  assert.deepEqual(types.selectableTypes(list, false).map((t) => t.id), ['software', 'seo']);
  assert.deepEqual(types.selectableTypes(list, true).map((t) => t.id), ['software', 'seo', 'notes']);
});

test('W16 the SEO 3D tint differs from every other type and a Building takes it', () => {
  const server = readFileSync(new URL('../../server/src/buildings/types/seo.ts', import.meta.url), 'utf8');
  const color = /look: \{ model: 'generic', color: '(#[0-9a-f]{6})' \}/.exec(server)[1];
  const others = ['#7295ad', '#e0a030', types.GENERIC_LOOK_COLOR];
  assert.ok(!others.includes(color));
  assert.equal(types.lookFor({ typeId: 'seo' }, [{ id: 'seo', look: { model: 'generic', color } }]).color, color);
});

test('shouldPoll runs only while something syncs or discards (C13)', () => {
  const idle = { sync: null, retention: { discarding: false } };
  assert.equal(seo.shouldPoll([{ state: 'connected' }], idle), false);
  assert.equal(seo.shouldPoll(undefined, null), false);
  assert.equal(seo.shouldPoll([{ state: 'syncing' }], idle), true);
  assert.equal(seo.shouldPoll([], { sync: { status: 'running' }, retention: { discarding: false } }), true);
  assert.equal(seo.shouldPoll([], { sync: null, retention: { discarding: true } }), true);
});

/* ----- store through the stub ----- */

async function seoBuilding(stub) {
  useWorldStore.setState({ projects: [], newBuildingField: null, ...CLEAN_ERROR_STATE });
  assert.equal(await useWorldStore.getState().addProject('', undefined, 'seo', 'https://Example.com/'), true);
  return useWorldStore.getState().projects.at(-1);
}

test('C1 and C2 the store creates an SEO Building from a site URL; a bad URL surfaces as a 400 on siteUrl', async () => {
  const stub = installServerStub();
  const building = await seoBuilding(stub);
  assert.equal(building.typeId, 'seo');
  assert.equal(building.name, 'example.com');
  useSeoStore.setState({ connectionsByProject: {}, dataByProject: {}, syncRequesting: {} });
  assert.equal((await useSeoStore.getState().loadConnections(building.id)).ok, true);
  assert.equal(useSeoStore.getState().connectionsByProject[building.id].siteUrl, 'https://example.com');
  assert.equal(await useWorldStore.getState().addProject('', undefined, 'seo', 'ftp://example.com'), false);
  assert.equal(useWorldStore.getState().newBuildingField, 'siteUrl');
  assert.equal(useWorldStore.getState().projects.length, 1);
});

test('C3 Sync now surfaces a 409 and a double click sends one request', async () => {
  const stub = installServerStub();
  const building = await seoBuilding(stub);
  const store = useSeoStore.getState();
  assert.equal(await useWorldStore.getState().saveGoogleOAuthClient('id-value', 'secret-value'), null);
  await store.selectProperty(building.id, 'gsc', 'https://example.com/', false);
  stub.seo.requests.length = 0;
  const [a, b] = await Promise.all([store.syncNow(building.id), store.syncNow(building.id)]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.equal(stub.seo.requests.filter((r) => r.rest === 'sync').length, 1);
  const again = await useSeoStore.getState().syncNow(building.id);
  assert.deepEqual([again.ok, again.status], [false, 409]);
  assert.match(again.error, /already running/);
});

test('C4 changing the property needs the confirm step before it is applied', async () => {
  const stub = installServerStub();
  const building = await seoBuilding(stub);
  const store = useSeoStore.getState();
  await store.selectProperty(building.id, 'gsc', 'https://example.com/', false);
  const refused = await store.selectProperty(building.id, 'gsc', 'sc-domain:example.com', false);
  assert.deepEqual([refused.ok, refused.status, refused.requiresConfirmation], [false, 409, true]);
  assert.equal(useSeoStore.getState().connectionsByProject[building.id].connections[0].property, 'https://example.com/');
  assert.equal((await store.selectProperty(building.id, 'gsc', 'sc-domain:example.com', true)).ok, true);
  const view = useSeoStore.getState().connectionsByProject[building.id];
  assert.equal(view.connections[0].property, 'sc-domain:example.com');
  assert.equal(view.previousProperties[0].property, 'https://example.com/');
});

test('C5 discarding needs the notice acknowledged and sends the acknowledgement before the discard', async () => {
  const stub = installServerStub();
  const building = await seoBuilding(stub);
  const store = useSeoStore.getState();
  stub.seo.requests.length = 0;
  const refused = await store.acknowledgeAndDiscard(building.id, false);
  assert.equal(refused.ok, false);
  assert.equal(stub.seo.requests.length, 0, 'nothing is sent without the confirmation');
  assert.equal((await store.acknowledgeAndDiscard(building.id, true)).ok, true);
  assert.deepEqual(stub.seo.requests.map((r) => r.rest).slice(0, 2), ['data/discard/acknowledge', 'data/discard']);
  const bad = await store.setRetentionMonths(building.id, 37);
  assert.deepEqual([bad.ok, bad.status], [false, 400]);
});

test('C10 the stub answers 404 for a Building that is not an SEO Building, like the daemon', async () => {
  installServerStub();
  const result = await useSeoStore.getState().loadConnections('no-such-building');
  assert.deepEqual([result.ok, result.status], [false, 404]);
});

/* ----- source checks ----- */

test('C6 the popup draws its tabs from the single SEO_TABS constant', () => {
  const ui = src('ui/SeoWorkspace.tsx');
  assert.ok(ui.includes('SEO_TABS.map'));
  for (const label of ['Keywords', 'Sitemaps', 'Backlinks', 'Internal links']) assert.ok(!ui.includes(`>${label}<`), `${label} is hard coded`);
});

test('C7 secret inputs are password fields and never bound to a server value', () => {
  const ui = src('ui/SeoConnections.tsx');
  const input = src('ui/SecretInput.tsx');
  assert.ok(input.includes('type="password"'));
  assert.ok(input.includes('secretField(saved)'));
  assert.ok(ui.includes("import { SecretInput } from './SecretInput';"));
  assert.ok(!/value=\{view\.[a-zA-Z]*(Key|Token|Secret)/.test(ui));
});

test('C8 the SEO workspace is chosen by type and has its own Settings sections', () => {
  assert.match(src('ui/ProjectWorkspaceModal.tsx'), /kind === 'seo'\) return <SeoShell/);
  assert.ok(src('ui/SeoWorkspace.tsx').includes('SEO_SETTINGS_SECTIONS.map'));
});

test('C9 the Sync now button has a disabled binding', () => {
  const ui = src('ui/SeoConnections.tsx');
  assert.ok(ui.includes('disabled={card.syncNowDisabled || syncRequesting}'));
  assert.ok(ui.includes('>Sync now</Button>'));
});

test('C11 the Data screen shows the retention rule and the oldest data held', () => {
  const ui = src('ui/SeoData.tsx');
  assert.ok(ui.includes('data.retention.description'));
  assert.ok(ui.includes('oldestDataLabel(d.oldestDay)'));
  assert.ok(ui.includes('formatCount(d.rows)'));
});

test('C12 Connect opens the consent link the daemon returns', () => {
  const ui = src('ui/SeoConnections.tsx');
  assert.ok(ui.includes('startConsent(id, service)'));
  assert.ok(ui.includes('window.open(result.authUrl'));
});

test('C14 non-SEO workspaces keep their own tab lists', () => {
  const layout = src('lib/workspaceLayout.ts');
  assert.ok(layout.includes("export const WORKSPACE_TABS = ['tasks', 'documents', 'testing', 'code', 'pr', 'settings', 'archived']"));
  assert.ok(!layout.includes('keywords'));
});

test('C15 the discard dialog and the year-over-year note are present', () => {
  const ui = src('ui/SeoData.tsx');
  assert.ok(ui.includes('notice?.lines.map'));
  assert.ok(ui.includes('This cannot be undone.'));
  assert.ok(src('ui/SeoData.tsx').includes('Nothing is discarded automatically until you have reviewed the notice once.'));
});
