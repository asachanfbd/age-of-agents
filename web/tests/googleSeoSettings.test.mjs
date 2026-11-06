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

/** Global Settings > Google (SEO), the app-wide Google OAuth client, and the SEO Building's notice in place of its old fields. */

const lib = await import('../src/lib/googleOAuthClient.ts');
const { serverApi } = await import('../src/lib/serverApi.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE, reportedError } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const ROUTE = '/api/settings/google-oauth-client';
const MISSING = 'Google client not set up yet. Add it in Settings &gt; Google (SEO).';
const noop = () => {};
const reset = () => useWorldStore.setState({ googleOAuthClientSaved: null, settingsSection: null, ...CLEAN_ERROR_STATE });
const button = (html, label) => new RegExp(`<button[^>]*>${label}</button>`).test(html);
const disabledButton = (html, label) => new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`).test(html);
const buttonTag = (html, label) => html.match(new RegExp(`<button([^>]*)>${label}</button>`))?.[1] ?? '';

/* ----- serverApi ----- */

test('W1 W2 W3 the client calls GET, PUT with both values, and DELETE on the global route', async () => {
  const stub = installServerStub();
  assert.deepEqual(await serverApi.googleOAuthClient(), { saved: false });
  assert.deepEqual(await serverApi.saveGoogleOAuthClient('the-id', 'the-secret'), { saved: true });
  assert.equal(await serverApi.removeGoogleOAuthClient(), undefined);
  assert.deepEqual(stub.googleClient.requests, [
    { method: 'GET', body: undefined },
    { method: 'PUT', body: { clientId: 'the-id', clientSecret: 'the-secret' } },
    { method: 'DELETE', body: undefined },
  ]);
});

/* ----- Store ----- */

test('W4 load sets the saved flag; a failed load surfaces the error and keeps the state', async () => {
  const stub = installServerStub();
  reset();
  stub.googleClient.saved = true;
  await useWorldStore.getState().loadGoogleOAuthClient();
  assert.equal(useWorldStore.getState().googleOAuthClientSaved, true);
  stub.googleClient.fail = 500;
  await useWorldStore.getState().loadGoogleOAuthClient();
  assert.equal(useWorldStore.getState().googleOAuthClientSaved, true);
  assert.match(reportedError(), /refused/);
});

test('W5 a save sends the trimmed values, reloads and marks the client saved', async () => {
  const stub = installServerStub();
  reset();
  assert.equal(await useWorldStore.getState().saveGoogleOAuthClient('  id  ', ' secret '), null);
  assert.deepEqual(stub.googleClient.requests.map((r) => r.method), ['PUT', 'GET']);
  assert.deepEqual(stub.googleClient.requests[0].body, { clientId: 'id', clientSecret: 'secret' });
  assert.equal(useWorldStore.getState().googleOAuthClientSaved, true);
});

test('W6 a save answered with 400 returns the daemon text and leaves the saved state', async () => {
  installServerStub();
  reset();
  useWorldStore.setState({ googleOAuthClientSaved: false });
  assert.equal(await useWorldStore.getState().saveGoogleOAuthClient('id', '   '), 'clientId and clientSecret are required');
  assert.equal(useWorldStore.getState().googleOAuthClientSaved, false);
});

test('W7 a remove marks the client not saved; a failed remove reports and changes nothing', async () => {
  const stub = installServerStub();
  reset();
  stub.googleClient.saved = true;
  useWorldStore.setState({ googleOAuthClientSaved: true });
  stub.googleClient.fail = 500;
  assert.match(await useWorldStore.getState().removeGoogleOAuthClient(), /refused/);
  assert.equal(useWorldStore.getState().googleOAuthClientSaved, true);
  assert.equal(await useWorldStore.getState().removeGoogleOAuthClient(), null);
  assert.equal(useWorldStore.getState().googleOAuthClientSaved, false);
  assert.equal(stub.googleClient.saved, false);
});

test('W8 openSettings opens the panel on a tab (Coding agents by default) and closeSettings closes it', () => {
  reset();
  useWorldStore.getState().openSettings('google-seo');
  assert.equal(useWorldStore.getState().settingsSection, 'google-seo');
  useWorldStore.getState().openSettings();
  assert.equal(useWorldStore.getState().settingsSection, 'agents');
  useWorldStore.getState().closeSettings();
  assert.equal(useWorldStore.getState().settingsSection, null);
});

/* ----- Pure helpers ----- */

test('W9 the SEO notice points to Settings until a client is saved', () => {
  assert.deepEqual(lib.googleClientNotice(false), { text: 'Google client not set up yet. Add it in Settings > Google (SEO).', showOpenSettings: true });
  assert.deepEqual(lib.googleClientNotice(true), { text: 'Using the Google client from Settings.', showOpenSettings: false });
});

test('W10 Connect is disabled with the notice as its reason until a client is saved', () => {
  assert.equal(lib.connectDisabledReason(false), 'Google client not set up yet. Add it in Settings > Google (SEO).');
  assert.equal(lib.connectDisabledReason(true), undefined);
});

test('W11 a save needs both values non-empty after trimming', () => {
  assert.equal(lib.canSaveGoogleClient('a', 'b'), true);
  assert.equal(lib.canSaveGoogleClient(' a ', '\tb'), true);
  for (const [id, secret] of [['', 'b'], ['a', ''], ['   ', 'b'], ['a', '\n\t']]) assert.equal(lib.canSaveGoogleClient(id, secret), false, JSON.stringify([id, secret]));
});

test('W12 the stub has the global routes and no per-Building client route', () => {
  const stub = readFileSync(new URL('./serverStub.mjs', import.meta.url), 'utf8');
  assert.ok(stub.includes("'/api/settings/google-oauth-client'"));
  assert.ok(!stub.includes("rest === 'google-client'"));
  assert.ok(!readFileSync(new URL('./seoWorkspace.test.mjs', import.meta.url), 'utf8').includes('saveGoogleClient('));
});

/* ----- Global Settings section ----- */

const SETTINGS = 'src/ui/GoogleSeoSettings.tsx';
const view = (extra = {}) => render(SETTINGS, 'GoogleSeoSettingsView', {
  saved: false, clientId: '', clientSecret: '', message: null, busy: false, confirmRemove: false,
  onClientId: noop, onClientSecret: noop, onSave: noop, onAskRemove: noop, onCancelRemove: noop, onRemove: noop, ...extra,
});

test('C1 C3 not saved: two password fields, no Saved badge, Save disabled until both are filled, no Remove', async () => {
  const html = await view();
  assert.equal((html.match(/type="password"/g) ?? []).length, 2);
  assert.match(html, /aria-label="Client id"/);
  assert.match(html, /aria-label="Client secret"/);
  assert.ok(!html.includes('>Saved<'));
  assert.ok(disabledButton(html, 'Save'));
  assert.ok(!button(html, 'Remove'));
  assert.ok(disabledButton(await view({ clientId: 'id', clientSecret: '   ' }), 'Save'));
  assert.ok(disabledButton(await view({ clientId: '  ', clientSecret: 'secret' }), 'Save'));
  const ready = await view({ clientId: 'id', clientSecret: 'secret' });
  assert.ok(button(ready, 'Save') && !disabledButton(ready, 'Save'));
});

test('C2 saved: Saved badges, the replace placeholder, Replace and Remove', async () => {
  const html = await view({ saved: true });
  assert.equal((html.match(/>Saved</g) ?? []).length, 2);
  assert.equal((html.match(/placeholder="Saved\. Type to replace"/g) ?? []).length, 2);
  assert.ok(button(html, 'Replace'));
  assert.ok(button(html, 'Remove') && !disabledButton(html, 'Remove'));
});

test('C4 Remove asks first, saying Connect will be disabled in SEO Buildings, with Cancel and Remove', () => {
  const ui = src('ui/GoogleSeoSettings.tsx');
  assert.match(ui, /<Dialog open=\{confirmRemove\}/);
  assert.match(ui, /Connect will be disabled in SEO Buildings/);
  assert.match(ui, />Cancel<\/Button>/);
  assert.match(ui, /onClick=\{props\.onRemove\}>Remove<\/Button>/);
  assert.match(ui, /onClick=\{props\.onAskRemove\}>Remove<\/Button>/);
});

test('C5 the Desktop app help is in the global section and no longer in the SEO Building', async () => {
  assert.match(await view(), /Desktop app/);
  assert.ok(!src('ui/SeoConnections.tsx').includes('Desktop app'));
});

test('C6 the fields are never filled from the server and nothing reads a client value back', () => {
  const ui = src('ui/GoogleSeoSettings.tsx');
  assert.match(ui, /value=\{clientId\}/);
  assert.match(ui, /value=\{clientSecret\}/);
  assert.match(ui, /const \[clientId, setClientId\] = useState\(''\)/);
  for (const file of ['ui/GoogleSeoSettings.tsx', 'lib/googleOAuthClient.ts', 'store/worldStore.ts']) {
    assert.doesNotMatch(src(file), /\)\.clientId|\)\.clientSecret|\.saved\.client/, file);
  }
  assert.match(src('ui/SecretInput.tsx'), /type="password"/);
});

test('C7 C8 the Settings panel lists Google (SEO) last and opens on the store tab', async () => {
  const panel = src('ui/SettingsPanel.tsx');
  const labels = [...panel.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Coding agents', 'Preferences', 'GitHub accounts', 'Google (SEO)']);
  assert.match(panel, /<TabsContent value="google-seo" className="mt-0">\s*<GoogleSeoSettings \/>/);
  assert.match(panel, /const section = useWorldStore\(\(s\) => s\.settingsSection\)/);
  assert.match(panel, /value=\{section\}/);
  assert.match(panel, /if \(section === null\) return null;/);
});

test('C9 the top bar opens Settings through the store, with no local open state', () => {
  const bar = src('ui/TopBar.tsx');
  assert.ok(!bar.includes('settingsOpen'));
  assert.match(bar, /onClick=\{\(\) => openSettings\(\)\} aria-label="Open settings"/);
  assert.match(bar, /<SettingsPanel \/>/);
});

/* ----- SEO Building > Settings > Connections ----- */

const CONNECTIONS = 'src/ui/SeoConnections.tsx';

test('C10 not saved: the notice with Open Settings, and no client fields', async () => {
  const html = await render(CONNECTIONS, 'GoogleClientNotice', { saved: false, onOpenSettings: noop });
  assert.ok(html.includes(MISSING));
  assert.ok(button(html, 'Open Settings'));
  const ui = src('ui/SeoConnections.tsx');
  assert.ok(!ui.includes('label="Client id"') && !ui.includes('label="Client secret"'));
});

test('C11 not saved: Connect and Reconnect are disabled with the notice as their title', async () => {
  const html = await render(CONNECTIONS, 'GoogleConnectButtons', { actions: ['connect', 'reconnect'], saved: false, onConnect: noop });
  for (const label of ['Connect', 'Reconnect']) {
    assert.ok(disabledButton(html, label), label);
    assert.ok(buttonTag(html, label).includes(`title="${MISSING}"`), label);
  }
});

test('C12 saved: the in-use notice without a button, and Connect enabled', async () => {
  const html = await render(CONNECTIONS, 'GoogleClientNotice', { saved: true, onOpenSettings: noop });
  assert.ok(html.includes('Using the Google client from Settings.'));
  assert.ok(!html.includes('<button'));
  const buttons = await render(CONNECTIONS, 'GoogleConnectButtons', { actions: ['connect'], saved: true, onConnect: noop });
  assert.ok(button(buttons, 'Connect') && !disabledButton(buttons, 'Connect'));
  assert.ok(!buttonTag(buttons, 'Connect').includes('title='));
  assert.equal(await render(CONNECTIONS, 'GoogleConnectButtons', { actions: ['sync-now'], saved: true, onConnect: noop }), '');
});

test('C13 the Ads developer token, Bing key and IndexNow key stay per Building', () => {
  const ui = src('ui/SeoConnections.tsx');
  assert.ok(ui.includes('<SecretInput label="Developer token" saved={view.adsDeveloperTokenSaved}'));
  assert.ok(ui.includes('<SecretInput label="Bing Webmaster API key" saved={view.bingKeySaved}'));
  assert.ok(ui.includes('<SecretInput label="IndexNow key" saved={view.indexNowKeySaved}'));
});

test('C14 Open Settings opens the Google (SEO) tab, and the screen reloads when the global client changes', () => {
  const ui = src('ui/SeoConnections.tsx');
  assert.ok(ui.includes("onOpenSettings={() => openSettings('google-seo')}"));
  assert.ok(ui.includes('<GoogleConnectButtons actions={card.actions} saved={googleSaved}'));
  assert.match(ui, /useEffect\(\(\) => \{ if \(globalClientSaved !== null\) void store\(\)\.loadConnections\(id\); \}, \[globalClientSaved, id, store\]\);/);
});
