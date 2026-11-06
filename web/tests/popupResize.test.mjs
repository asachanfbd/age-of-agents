import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const {
  POPUP_LAYOUT_CSS_VARS, POPUP_MIN_SIZE, POPUP_VIEWPORT_MARGIN, applyPopupLayoutCssVars, clampPopupSize, maxPopupSize, resizedPopupSize,
} = await import('../src/lib/popupResize.ts');
const { STATUS_FOOTER_HEIGHT } = await import('../src/lib/statusFooter.ts');
const { matchPopupSize } = await import('../src/lib/popupSizeMemory.ts');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const dialog = await read('../src/components/ui/dialog.tsx');
const sheet = await read('../src/components/ui/sheet.tsx');
const hook = await read('../src/lib/useResizablePopup.ts');
const main = await read('../src/main.tsx');
const workspace = await read('../src/ui/ProjectWorkspaceModal.tsx');
const catalog = await read('../src/ui/CatalogModal.tsx');
const commandLog = await read('../src/ui/project-popup/commands/CommandLogPopup.tsx');

const viewport = { width: 1920, height: 1080 };
/** The space popups are sized in: the window above the status footer. */
const availableHeight = viewport.height - STATUS_FOOTER_HEIGHT;

test('the status footer height is one compact constant', () => {
  assert.equal(STATUS_FOOTER_HEIGHT, 46);
});

test('a popup can grow to 100px short of the window width, and 100px short of the space above the footer', () => {
  assert.equal(POPUP_VIEWPORT_MARGIN, 100);
  assert.deepEqual(maxPopupSize(viewport), { width: 1820, height: 1080 - STATUS_FOOTER_HEIGHT - 100 });
});

test('the max size never goes negative in a tiny viewport, even one shorter than the footer plus margin', () => {
  assert.deepEqual(maxPopupSize({ width: 50, height: 80 }), { width: 0, height: 0 });
  assert.deepEqual(maxPopupSize({ width: 400, height: STATUS_FOOTER_HEIGHT + 99 }), { width: 300, height: 0 });
});

test('a requested size within bounds is kept, rounded to whole pixels', () => {
  assert.deepEqual(clampPopupSize({ width: 800.4, height: 600.6 }, viewport), { width: 800, height: 601 });
});

test('a requested size past the viewport is capped at the footer-aware maximum', () => {
  assert.deepEqual(clampPopupSize({ width: 5000, height: 5000 }, viewport), { width: 1820, height: 934 });
});

test('a requested size below the minimum is raised to the minimum', () => {
  assert.deepEqual(clampPopupSize({ width: 10, height: 10 }, viewport), POPUP_MIN_SIZE);
});

test('the footer-aware cap wins over the minimum when the viewport is too small for both', () => {
  assert.deepEqual(clampPopupSize({ width: 10, height: 10 }, { width: 300, height: 250 }), { width: 200, height: 250 - STATUS_FOOTER_HEIGHT - 100 });
});

test('dragging the corner grows a centred popup by twice the pointer delta', () => {
  assert.deepEqual(resizedPopupSize({ width: 1000, height: 700 }, { x: 50, y: 20 }, viewport), { width: 1100, height: 740 });
  assert.deepEqual(resizedPopupSize({ width: 1000, height: 700 }, { x: -100, y: -100 }, viewport), { width: 800, height: 500 });
});

test('dragging past the edge stops at the footer-aware cap', () => {
  assert.deepEqual(resizedPopupSize({ width: 1000, height: 700 }, { x: 900, y: 900 }, viewport), { width: 1820, height: 934 });
});

test('a remembered size taller than the footer-aware cap is clamped on restore', () => {
  assert.deepEqual(matchPopupSize({ '1920x1080': { width: 1000, height: 1000 } }, viewport), { width: 1000, height: 934 });
});

test('any popup up to the max size, centred above the footer, keeps 50px clear of the top and the footer', () => {
  const centreY = availableHeight / 2;
  for (const height of [POPUP_MIN_SIZE.height, 500, maxPopupSize(viewport).height]) {
    const top = centreY - height / 2;
    const bottom = centreY + height / 2;
    assert.ok(top >= 50, `top gap for height ${height}`);
    assert.ok(availableHeight - bottom >= 50, `gap above the footer for height ${height}`);
  }
});

test('the layout CSS variables carry the same footer and margin rules to stylesheets', () => {
  assert.deepEqual(POPUP_LAYOUT_CSS_VARS, {
    '--status-footer-height': '46px',
    '--popup-max-height': 'calc(100dvh - 146px)',
    '--popup-center-y': 'calc((100dvh - 46px) / 2)',
  });
  const set = {};
  applyPopupLayoutCssVars({ style: { setProperty: (name, value) => { set[name] = value; } } });
  assert.deepEqual(set, POPUP_LAYOUT_CSS_VARS);
  assert.match(main, /applyPopupLayoutCssVars\(document\.documentElement\)/, 'set on :root so portalled popups see them');
});

test('every dialog renders the resize grip and applies the dragged size', () => {
  assert.match(dialog, /const resize = useResizablePopup\(sizeMemoryKey\)/);
  assert.match(dialog, /style=\{\{ \.\.\.style, \.\.\.resize\.style \}\}/);
  assert.match(dialog, /data-popup-resize-handle[\s\S]*cursor-nwse-resize[\s\S]*\{\.\.\.resize\.handleProps\}/);
});

test('a resized popup is capped by CSS so shrinking the window keeps it inside and above the footer', () => {
  assert.match(hook, /maxWidth: `calc\(100vw - \$\{POPUP_VIEWPORT_MARGIN\}px\)`/);
  assert.match(hook, /maxHeight: 'var\(--popup-max-height\)'/);
});

test('dialogs are centred in the space above the footer and no taller than it allows', () => {
  assert.match(dialog, /top-\[var\(--popup-center-y\)\][^"]*max-h-\[var\(--popup-max-height\)\][^"]*translate-y-\[-50%\]/);
  assert.doesNotMatch(dialog, /top-\[50%\]/);
});

test('the workspace, catalog and command-log popups default to a size that fits above the footer', () => {
  assert.match(workspace, /h-\[min\(780px,var\(--popup-max-height\)\)\]/);
  assert.match(catalog, /h-\[min\(900px,var\(--popup-max-height\)\)\]/);
  assert.match(catalog, /h-\[min\(880px,var\(--popup-max-height\)\)\]/);
  assert.match(commandLog, /max-h-\[min\(85vh,var\(--popup-max-height\)\)\]/);
  for (const source of [workspace, catalog]) assert.doesNotMatch(source, /94dvh/);
});

test('side sheets end at the footer\'s top edge rather than running full height', () => {
  const variants = sheet.slice(sheet.indexOf('const sheetVariants'), sheet.indexOf('interface SheetContentProps'));
  assert.equal(variants.match(/bottom-\[var\(--status-footer-height\)\]/g)?.length, 3, 'left, right and bottom sheets');
  assert.doesNotMatch(variants, /inset-y-0|h-full/);
});
