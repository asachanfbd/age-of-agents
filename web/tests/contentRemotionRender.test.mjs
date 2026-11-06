import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { render } from './renderHelper.mjs';

/** Static markup of each Remotion tab state, the disabled tab and the footer row (RW-C01…RW-C13 in the Test Case Planning list). */

const VIEW = 'src/ui/content/RemotionTabView.tsx';
const URL_BASE = 'http://127.0.0.1:3047';
const COMP = 'concept-3f9a1c2e';
const studio = (over = {}) => ({ state: 'stopped', url: null, error: null, log: [], waitingForSetup: false, ...over });
const tab = (pane, view, extra = {}) => render(VIEW, 'RemotionTabView', { view, pane, compositionId: COMP, setupPercent: null, narrow: false, busy: false, error: null, onStart() {}, onStop() {}, ...extra });
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const running = studio({ state: 'running', url: URL_BASE, log: ['Server ready - Local: http://localhost:3047'] });

const concept = (compositionId) => ({
  id: 'c1', title: 'Spring menu', brief: '', archived: false, createdAt: '2026-10-26T10:00:00Z', updatedAt: '2026-10-26T10:00:00Z', progress: { finalized: 0, needed: 2 }, compositionId,
  posts: [{ id: 'p1', conceptId: 'c1', platform: 'instagram', format: 'reel', scheduledAt: '2026-10-27T09:00:00Z', status: 'draft', note: null, createdAt: '2026-10-26T10:00:00Z', needs: [], publishedAt: null, liveUrl: null, stats: null }],
  assets: [{ id: 'a1', kind: 'script', postId: null, state: 'finalized', content: 'x', finalizedAt: '2026-10-26T10:00:00Z', round: 1 }, { id: 'a2', kind: 'video', postId: null, state: 'drafting', content: null, finalizedAt: null, round: 1 }],
});
const body = (c, tabKey = 'remotion') => render('src/ui/content/ConceptView.tsx', 'ConceptBody', {
  projectId: 'b1', concept: c, missingByPost: {}, error: null, onSave() {}, timeZone: 'UTC', readOnly: false, tab: tabKey, onTab() {}, onBack() {}, onChanged() {},
  renderStudio: () => 'STUDIO', renderVideo: () => 'VIDEO', renderRemotion: (cid, vid, comp) => `REMOTION:${cid}:${vid}:${comp}`,
});

test('RW-C01 disabled: the reason as the tooltip and in place of the body, with no list under the tab bar', async () => {
  const html = await body(concept(null));
  assert.match(html, /title="Start the video in the Video tab first"[^>]*>Remotion</);
  assert.doesNotMatch(html, /aria-label="Disabled tabs"|<li>Remotion:/);
  assert.match(html, /<p[^>]*>Start the video in the Video tab first<\/p>/);
  assert.doesNotMatch(html, /REMOTION:/);
  const enabled = await body(concept(COMP));
  assert.match(enabled, new RegExp(`REMOTION:c1:a2:${COMP}`));
  assert.doesNotMatch(enabled, /Remotion: /);
});

test('RW-C02 waiting: the message, the setup percent and that Studio starts by itself', async () => {
  const html = await tab('waiting', studio({ state: 'starting', waitingForSetup: true }), { setupPercent: 62 });
  assert.match(html, /Waiting for Remotion setup to finish…/);
  assert.match(html, /width:62%/);
  assert.match(html, /Studio starts by itself once it is done\./);
  assert.match(html, />Waiting for setup</);
});

test('RW-C03 starting: the message, an indeterminate bar, and the log wrapping long paths', async () => {
  const long = `/Users/owner/${'very-long-folder-name/'.repeat(10)}main.bundle.js.map`;
  const html = await tab('starting', studio({ state: 'starting', log: ['Building... 34%', long] }));
  assert.match(html, /Starting Remotion Studio…/);
  assert.match(html, /w-1\/3 opacity-60/);
  assert.match(html, /<pre aria-label="Studio log" class="[^"]*\[overflow-wrap:anywhere\][^"]*">Building\.\.\. 34%\n\/Users\/owner/);
  assert.doesNotMatch(html, /<iframe/);
});

test('RW-C04 running: an iframe at the composition, full width, viewport tall with a 32rem minimum; no agent pane', async () => {
  const html = await tab('running', running);
  assert.match(html, new RegExp(`<iframe title="Remotion Studio: ${COMP}" src="${URL_BASE}/${COMP}" class="[^"]*w-full[^"]*h-\\[calc\\(100vh-300px\\)\\] min-h-\\[32rem\\]`));
  assert.doesNotMatch(html, /Agent/);
  assert.match(html, />Running · 127\.0\.0\.1:3047</);
});

test('RW-C05 failed: the error as an alert, the log tail and Retry', async () => {
  const html = await tab('failed', studio({ state: 'failed', error: 'Remotion Studio exited with code 1 before it was ready', log: ["Error: Cannot find module './concepts/registry'"] }));
  assert.match(html, /role="alert"[^>]*>Remotion Studio exited with code 1 before it was ready</);
  assert.match(html, /Cannot find module/);
  assert.match(html, />Retry<\/button>/);
  assert.doesNotMatch(html, />(<svg[^>]*>.*?<\/svg>)?Stop<\/button>/);
});

test('RW-C06 stopped: not running, why it stops, and Start Studio', async () => {
  const html = await tab('stopped', studio({ log: ['x'] }));
  assert.match(html, /Remotion Studio is not running\./);
  assert.match(html, /after 10 minutes with no Remotion tab open in this Building/);
  assert.match(html, />Start Studio<\/button>/);
});

test('RW-C07 fallback: no iframe, the url as text and a primary link opening a new tab', async () => {
  const html = await tab('fallback', running);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /Studio can(&#x27;|')t be shown inside this app/);
  assert.match(html, new RegExp(`<span class="font-mono[^"]*">${URL_BASE}/${COMP}</span>`));
  assert.equal((html.match(new RegExp(`href="${URL_BASE}/${COMP}" target="_blank" rel="noopener"`, 'g')) ?? []).length, 2, 'the header link and the primary one');
});

test('RW-C08 read-only running: the banner text and the iframe', async () => {
  const html = await tab('ro-running', running);
  assert.match(html, /This Building is read-only\. You can view Studio here; prop changes you save in Studio still write to the project(&#x27;|')s files\. Renders happen only in the Video tab\./);
  assert.match(html, /<iframe/);
});

test('RW-C09 read-only, install needed: the alert and no Retry or Start', async () => {
  const html = await tab('ro-refused', studio());
  assert.match(html, /role="alert"[^>]*>Studio can(&#x27;|')t start: this Building is read-only and the Remotion project still needs its packages installed\.</);
  assert.doesNotMatch(html, />Retry</);
  assert.doesNotMatch(html, />Start Studio</);
  assert.match(html, />Not started</);
});

test('RW-C10 the header: title, chip, composition, the shared note, the new-tab link and Stop per state', async () => {
  const html = await tab('running', running);
  assert.match(html, /<h2[^>]*>Remotion Studio<span[^>]*role="status"[^>]*>Running · 127\.0\.0\.1:3047<\/span><\/h2>/);
  assert.match(html, new RegExp(`Composition <code>${COMP}</code> · shared by every Concept in this Building`));
  assert.match(html, new RegExp(`<a href="${URL_BASE}/${COMP}" target="_blank" rel="noopener"[^>]*>Open in a new browser tab`));
  assert.match(html, />(<svg[^>]*>.*?<\/svg>)?Stop<\/button>/);
  const starting = await tab('starting', studio({ state: 'starting' }));
  assert.match(starting, /<button(?=[^>]*disabled="")(?=[^>]*title="Available while Studio is running")[^>]*><span>Open in a new browser tab/);
  assert.match(starting, />(<svg[^>]*>.*?<\/svg>)?Stop<\/button>/);
  const stopped = await tab('stopped', studio());
  assert.doesNotMatch(stopped, />(<svg[^>]*>.*?<\/svg>)?Stop<\/button>/);
});

test('RW-C11 the narrow hint', async () => {
  assert.match(await tab('running', running, { narrow: true }), /Studio needs a wide window\. Open it in a new browser tab for more room\./);
  assert.doesNotMatch(await tab('running', running), /Studio needs a wide window/);
});

test('RW-C12 the footer row: its name, where, starting… and the Stop label', () => {
  const lists = src('ui/FooterListPopovers.tsx');
  assert.match(lists, /aria-label=\{runningStopLabel\(row, group\.projectName\)\}/);
  assert.match(lists, /\{row\.progress && <span className="flex-none tabular-nums">\{row\.progress\}<\/span>\}/);
  const running = src('lib/runningCommands.ts');
  assert.match(running, /'remotion-studio': 'Remotion Studio'/);
  assert.match(running, /job\.phase === 'starting' \? 'starting…' : undefined/);
});

test('RW-C13 a log line or an error holding <script> renders as text', async () => {
  const html = await tab('failed', studio({ state: 'failed', error: '<script>alert(1)</script>', log: ['<script>alert(2)</script>'] }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});
