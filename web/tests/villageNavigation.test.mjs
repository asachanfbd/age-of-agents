import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

// The bottom-left navigation card (Home button + minimap). The card is props-only, so it renders to
// static markup here; the pointer and focus behaviour is a manual browser check (.docs/testing.md).
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const CARD = 'src/ui/VillageNavigationCard.tsx';
const cardSource = await read(`../${CARD}`);
const scene = await read('../src/scene/Scene.tsx');
const worldView = await read('../src/ui/WorldView.tsx');
const cards = await read('../src/ui/ProjectCardsView.tsx');
const app = await read('../src/App.tsx');

const baseProps = {
  disabled: false,
  dots: [
    { id: 'p1', name: 'notes-app', color: '#45a3ff', x: 20, y: 30 },
    { id: 'p2', name: 'billing', color: '#ff5656', x: 70, y: 60 },
  ],
  footprint: [{ x: 40, y: 60 }, { x: 60, y: 60 }, { x: 80, y: 20 }, { x: 20, y: 20 }],
  target: { x: 50, y: 45 },
  onHome() {},
  onPick() {},
  onKey: () => false,
};
const renderCard = (props = {}) => render(CARD, 'VillageNavigationCard', { ...baseProps, ...props });

test('C01 the card is labelled, and the Home button is named "Return to the home view" with the text Home', async () => {
  const html = await renderCard();
  assert.match(html, /<section aria-label="Village navigation"/);
  assert.match(html, /<button type="button"[^>]*title="Return to the home view"[^>]*aria-label="Return to the home view"/);
  assert.match(html, />Home<\/span><\/button>/);
});

test('C02 while a Project is dragged the Home button is disabled and the minimap is dimmed and aria-disabled', async () => {
  const enabled = await renderCard();
  assert.doesNotMatch(enabled, /disabled=""/);
  assert.match(enabled, /aria-disabled="false"/);
  const html = await renderCard({ disabled: true });
  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, /<svg[^>]*aria-disabled="true"[^>]*class="[^"]*cursor-not-allowed opacity-50/);
});

test('C03 the minimap is a focusable application that explains click, drag and arrow keys', async () => {
  const html = await renderCard();
  const svg = html.match(/<svg role="application"[^>]*>/)?.[0] ?? '';
  assert.match(svg, /tabindex="0"/);
  assert.match(svg, /aria-label="[^"]*[Cc]lick[^"]*drag[^"]*arrow keys[^"]*"/);
});

test('C04 one titled, status-coloured dot per Project plus the Home square; no Projects shows Home only', async () => {
  const html = await renderCard();
  assert.match(html, /<circle cx="20" cy="30" r="2.6" fill="#45a3ff"[^>]*><title>notes-app<\/title><\/circle>/);
  assert.match(html, /<circle cx="70" cy="60" r="2.6" fill="#ff5656"[^>]*><title>billing<\/title><\/circle>/);
  assert.match(html, /<rect[^>]*><title>Home<\/title><\/rect>/);
  const empty = await renderCard({ dots: [] });
  assert.equal((empty.match(/<title>/g) ?? []).length, 1);
  assert.match(empty, /<title>Home<\/title>/);
});

test('C05 the footprint polygon and target dot come from props, and the N marker is drawn', async () => {
  const html = await renderCard();
  assert.match(html, /<polygon points="40,60 60,60 80,20 20,20"/);
  assert.match(html, /<circle cx="50" cy="45" r="1.3"/);
  assert.match(html, /<text[^>]*>N<\/text>/);
});

test('C06 the card sits 16px above the status footer at the left, with a 200px (140px on phones) minimap', async () => {
  assert.match(cardSource, /style=\{\{ bottom: STATUS_FOOTER_HEIGHT \+ FOOTER_GAP \}\}/);
  assert.match(cardSource, /const FOOTER_GAP = 16;/);
  assert.doesNotMatch(cardSource, /\b62\b/);
  const html = await renderCard();
  assert.match(html, /style="bottom:62px"/);
  assert.match(html, /<section[^>]*class="absolute left-6 [^"]*max-sm:left-3/);
  assert.match(html, /<svg[^>]*class="[^"]*size-\[200px\][^"]*max-sm:size-\[140px\]/);
});

test('C07 the Scene pans, zooms and rotates within the camera limits and still pauses for a Project drag', () => {
  assert.doesNotMatch(scene, /enableRotate=\{false\}|enableZoom=\{false\}|PAN_ONLY_MOUSE_BUTTONS/);
  const controls = scene.match(/<MapControls[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(controls, /enabled=\{controlsEnabled\}/);
  assert.match(controls, /minDistance=\{MIN_DISTANCE\}/);
  assert.match(controls, /maxDistance=\{MAX_DISTANCE\}/);
  assert.match(controls, /minPolarAngle=\{Math\.PI \/ 2 - MAX_ELEVATION\}/);
  assert.match(controls, /maxPolarAngle=\{Math\.PI \/ 2 - MIN_ELEVATION\}/);
  assert.match(scene, /LEFT: THREE\.MOUSE\.PAN,/);
  assert.match(scene, /RIGHT: THREE\.MOUSE\.ROTATE,/);
  assert.match(scene, /villageCamera\.attach\(controls, invalidate\)/);
  assert.match(scene, /villageCamera\.followControlsEnabled\(useWorldStore\)/);
  assert.match(scene, /useFrame\(\(\) => \{\s*villageCamera\.tick\(\);/);
});

test('C08 the Scene still takes the camera position, target and fov from DEFAULT_VIEW', () => {
  assert.match(scene, /<PerspectiveCamera[^>]*position=\{\[\.\.\.DEFAULT_VIEW\.position\]\}[^>]*fov=\{DEFAULT_VIEW\.fov\}/);
  assert.match(scene, /target=\{\[\.\.\.DEFAULT_VIEW\.target\]\}/);
});

test('C09 the card is mounted outside the Canvas in the lazy 3D view, never in the cards view', () => {
  assert.match(worldView, /<\/Canvas>\s*<VillageOverlay \/>\s*<VillageNavigation \/>/);
  assert.match(app, /lazy\(\(\) => import\('\.\/ui\/WorldView'\)\)/);
  assert.doesNotMatch(cards + app, /VillageNavigation/);
});

test('C10 the card adds no legend box', async () => {
  const html = await renderCard();
  assert.doesNotMatch(html, /<dl|legend/i);
  assert.doesNotMatch(cardSource, /LEGEND|<dl/);
});

test('C11 camera numbers live only in defaultView.ts and the camera constants', async () => {
  const entries = await readdir(new URL('../src', import.meta.url), { withFileTypes: true, recursive: true });
  const files = entries.filter((e) => e.isFile() && /\.tsx?$/.test(e.name)).map((e) => `${e.parentPath ?? e.path}/${e.name}`);
  const offenders = [];
  for (const file of files) {
    if (file.endsWith('scene/defaultView.ts')) continue;
    const text = await readFile(file, 'utf8');
    if (/28\.2,\s*57,\s*28\.2|\[2,\s*0,\s*2\]/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
  assert.match(cardSource + scene, /DEFAULT_VIEW|MIN_DISTANCE/);
});

test('C12 phones show the Home icon only, and the button keeps its accessible name', async () => {
  const html = await renderCard();
  assert.match(html, /<span class="max-sm:hidden">Home<\/span>/);
  assert.match(html, /<button[^>]*aria-label="Return to the home view"[^>]*><svg[^>]*class="lucide lucide-house[^"]*"[^>]*aria-hidden="true"/);
});

test('the card sends the press helpers\' actions to its callbacks', () => {
  assert.match(cardSource, /onClick=\{onHome\}/);
  assert.match(cardSource, /press\.current = pressStart\(\{ x: e\.clientX, y: e\.clientY \}, e\.button, disabled\);/);
  assert.match(cardSource, /pressMove\(press\.current, \{ x: e\.clientX, y: e\.clientY \}, disabled\)/);
  assert.match(cardSource, /pressEnd\(press\.current, disabled, e\.type === 'pointercancel'\)/);
  assert.match(cardSource, /onPick\(point, 'follow'\)/);
  assert.match(cardSource, /onPick\(point, 'fly'\)/);
  assert.match(cardSource, /if \(minimapKey\(e\.key, disabled, onKey\)\) e\.preventDefault\(\);/);
  assert.match(cardSource, /onPointerUp=\{handlePointerEnd\}\s*onPointerCancel=\{handlePointerEnd\}/);
});

test('the wired card starts at the Home view footprint with only the Home square', async () => {
  const { HOME_ORBIT } = await import('../src/scene/cameraMath.ts');
  const { MINIMAP_VIEWBOX, groundFootprint, worldToMinimap } = await import('../src/scene/minimapMath.ts');
  const { DEFAULT_VIEW } = await import('../src/scene/defaultView.ts');
  const html = await render('src/ui/VillageNavigation.tsx', 'VillageNavigation');
  const points = groundFootprint(HOME_ORBIT, 16 / 9, DEFAULT_VIEW.fov).map((p) => worldToMinimap(p, MINIMAP_VIEWBOX)).map((p) => `${p.x},${p.y}`).join(' ');
  assert.ok(html.includes(`<polygon points="${points}"`));
  assert.match(html, /aria-disabled="false"/);
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
});

test('a minimap dot takes the same status colour as the Project\'s dot in the village', async () => {
  const { projectDotColor, projectVisualStatus } = await import('../src/lib/useProjectIndicators.ts');
  const { BUILDING_STATUS_STYLES } = await import('../src/lib/buildingVisualStatus.ts');
  const project = { id: 'p', name: 'p', position: [1, 1], status: 'idle', activeTaskId: null, taskCount: 1, sync: null };
  const empty = { lastTaskIdByProject: {}, tasksById: {}, reviewedTaskIds: {}, notificationsById: {} };
  assert.equal(projectDotColor(project, empty), BUILDING_STATUS_STYLES.idle.dotColor);
  assert.equal(projectDotColor({ ...project, status: 'developing' }, empty), BUILDING_STATUS_STYLES.developing.dotColor);
  const failed = { ...empty, lastTaskIdByProject: { p: 't' }, tasksById: { t: { id: 't', status: 'failed' } } };
  assert.equal(projectDotColor(project, failed), BUILDING_STATUS_STYLES.error.dotColor);
  assert.equal(projectDotColor(project, { ...failed, reviewedTaskIds: { t: true } }), BUILDING_STATUS_STYLES.idle.dotColor);
  // The village dot (useProjectIndicators) and the minimap dot share one rule.
  assert.equal(projectVisualStatus(project, { id: 't', status: 'failed' }, false, {}), 'error');
  assert.equal(projectVisualStatus({ ...project, status: 'blocked' }, undefined, false, {}), 'question');
});
