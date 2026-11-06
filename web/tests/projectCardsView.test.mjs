import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const app = await read('../src/App.tsx');
const cards = await read('../src/ui/ProjectCardsView.tsx');
const building = await read('../src/scene/ProjectYard.tsx');
const topBar = await read('../src/ui/TopBar.tsx');

test('the 3D view is lazy-loaded so cards mode never downloads three.js', () => {
  assert.match(app, /lazy\(\(\) => import\('\.\/ui\/WorldView'\)\)/);
  assert.doesNotMatch(app, /@react-three|from '\.\/scene\//);
});

test('the Canvas is only mounted in world mode; cards mode renders the cards view instead', () => {
  assert.match(app, /viewMode === 'world' \?[\s\S]*<WorldView \/>[\s\S]*: \([\s\S]*<ProjectCardsView \/>/);
});

test('cards view pulls in nothing from the 3D scene', () => {
  assert.doesNotMatch(cards, /@react-three|three'|\.\.\/scene\//);
  assert.match(cards, /\.\.\/lib\/townGroups/);
});

test('cards and 3D buildings share the same status dot and progress source', () => {
  for (const source of [cards, building]) {
    assert.match(source, /useProjectIndicators\(project\)/);
    assert.match(source, /<ProjectStatusDot style=\{statusStyle\} label=\{dotLabel\} \/>/);
    assert.match(source, /<TaskProgressBar/);
  }
});

test('each card opens its project workspace, and the Catalog stays reachable', () => {
  assert.match(cards, /openWorkspace\(project\.id\)/);
  assert.match(cards, /onClick=\{openCatalog\}/);
});

test('C04 a pinned Catalog card, then one card per street with Left, Road and Right columns; slots carry street, side and index', () => {
  assert.match(cards, /<div \{\.\.\.\{ \[slotDataAttributes\.catalog\]: '' \}\}/);
  assert.match(cards, /border-dashed/);
  assert.match(cards, /streets\.map\(\(view\) => \(\s*<StreetCard key=\{view\.street\}/);
  assert.match(cards, /aria-label=\{`Street \$\{view\.street\}`\}/);
  assert.match(cards, /grid-cols-\[1fr_auto_1fr\]/, 'left side, road, right side');
  assert.match(cards, /SIDES\.map\(\(side\) =>/);
  assert.match(cards, /slotAttributeValue\(ref\)/);
  assert.doesNotMatch(cards, /NARROW_PANELS|WIDE_PANELS|Group \{/);
});

test('C05 the search box and the occupied-streets checkbox feed the filter helper; empty streets collapse and open on click (C07)', () => {
  assert.match(cards, /filterStreets\(buildStreets\(positioned\), new Map\(projects\.map\(\(p\) => \[p\.id, p\.name\]\)\), query, onlyOccupied\)/);
  assert.match(cards, /type="search"/);
  assert.match(cards, /onChange=\{\(event\) => setOnlyOccupied\(event\.target\.checked\)\}/);
  assert.match(cards, /Only streets with projects/);
  assert.match(cards, /isStreetCollapsed\(view, expanded\)/);
  assert.match(cards, /onClick=\{onToggle\}/);
  assert.match(cards, /aria-expanded=\{!collapsed\}/);
});

test('C06 the move menu, keyboard move and pointer drop all go through canDrop', () => {
  assert.match(cards, /canDrop\(current, projectId, target\)/);
  assert.match(cards, /stepKeyboardMove\(positioned, keyboardMove, project, key\)/);
  assert.match(cards, /onMoveTo: \(project, slot\) => drop\(project\.id, slot\)/);
  assert.match(cards, /freeSlotOptions\(/);
});

test('the Catalog cell is a refused drop target and not draggable', () => {
  assert.match(cards, /slotDataAttributes\.catalog/);
  assert.match(cards, /cursor-not-allowed/);
  assert.doesNotMatch(cards, /draggable|onDragStart|onDrop/);
});

test('dragging uses pointer events with capture and cancel handling, and shows a preview', () => {
  assert.match(cards, /setPointerCapture/);
  assert.match(cards, /addEventListener\('pointercancel', cancel\)/);
  assert.match(cards, /addEventListener\('pointerup'/);
  assert.match(cards, /pointerType === 'touch'/);
  assert.match(cards, /fixed z-50[^`]*aria-hidden/);
});

test('Escape and window resize cancel a pointer drag, and their listeners are removed afterwards', () => {
  assert.match(cards, /addEventListener\('keydown', onKey\)/);
  assert.match(cards, /addEventListener\('resize', cancel\)/);
  assert.match(cards, /removeEventListener\('keydown', onKey\)/);
  assert.match(cards, /removeEventListener\('resize', cancel\)/);
  assert.match(cards, /const cancel = \(\) => finish\(null, true\)/, 'cancelling ends the drag at once');
  assert.match(cards, /useEffect\(\(\) => \(\) => dragCleanup\.current\?\.\(\), \[\]\)/, 'listeners are released on unmount');
});

test('focus returns to the moved card after a drop, a refusal or a cancel, and the menu does not steal it back', () => {
  assert.match(cards, /focusCard\(projectId\)/);
  assert.match(cards, /data-project-card=\"\$\{focusRequest\.id\}\"\] button`\)\?\.focus\(\)/);
  assert.match(cards, /onCloseAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/);
});

test('keyboard moves are announced through an aria-live region, and every slot has an accessible name', () => {
  assert.match(cards, /role="status" aria-live="polite"/);
  assert.match(cards, /stepKeyboardMove\(/, 'the keyboard flow runs through the tested reducer');
  assert.match(cards, /announce\.dropped/);
  assert.match(cards, /\$\{slotLabel\(ref\)\}, empty/);
});

test('each card has a keyboard-reachable "Move to…" menu listing free slots, with "No free slots" when full', () => {
  assert.match(cards, /aria-label=\{`Move \$\{project\.name\} to…`\}/);
  assert.match(cards, /freeSlotOptions/);
  assert.match(cards, /No free slots/);
});

test('the view moves projects only through the store action, never the server directly, and adds no looping animation', () => {
  assert.match(cards, /moveProjectToSlot/);
  assert.doesNotMatch(cards, /fetch\(|serverApi/);
  assert.doesNotMatch(cards, /animate-|@keyframes/);
});

test('the top bar toggles between the two modes', () => {
  assert.match(topBar, /setViewMode\(viewMode === 'world' \? 'cards' : 'world'\)/);
});
