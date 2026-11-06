import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

const accent = await import('../src/lib/accent.ts');
const score = await import('../src/lib/score.ts');
const people = await import('../src/lib/people.ts');
const sort = await import('../src/lib/tableSort.ts');
const kpi = await import('../src/lib/kpi.ts');
const tab = await import('../src/lib/tabIndicator.ts');
const undo = await import('../src/lib/undoToast.ts');
const rules = await import('../src/lib/themeRules.ts');
const colour = await import('../src/lib/themeColour.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const css = src('styles/shadcn.css');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The custom properties of the first `selector { ... }` block that defines --sc-* values. */
const tokens = (selector) => {
  const start = css.indexOf(`\n${selector} {\n  --sc-background`);
  assert.ok(start >= 0, `${selector} token block`);
  const block = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries([...block.matchAll(/--sc-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const light = tokens(':root');
const dark = tokens('.dark');

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const REQUIRED = ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'primary', 'primary-foreground', 'muted', 'muted-foreground', 'border', 'ring',
  'success', 'success-foreground', 'warning', 'warning-foreground', 'destructive', 'destructive-foreground', 'info', 'info-foreground', 'brand',
  'stage-yellow', 'stage-yellow-foreground', 'stage-green', 'stage-green-foreground', 'stage-orange', 'stage-orange-foreground', 'stage-charcoal', 'stage-charcoal-foreground',
  'glass', 'glass-border', 'toast', 'toast-foreground', 'radius', 'radius-card', 'shadow-soft', 'shadow-lift', 'scrim'];

test('U01 every semantic token is defined in both light and dark', () => {
  for (const name of REQUIRED) {
    assert.ok(light[name], `light --sc-${name}`);
    assert.ok(dark[name] || ['radius', 'radius-card', 'radius-item'].includes(name), `dark --sc-${name}`);
  }
  assert.equal((css.match(/^:root \{\n  --sc-background/gm) ?? []).length, 1, 'defined once');
});

test('U02 each of the four accents has a foreground in both modes', () => {
  for (const name of ['yellow', 'green', 'orange', 'charcoal']) {
    for (const set of [light, dark]) { assert.ok(set[`stage-${name}`]); assert.ok(set[`stage-${name}-foreground`]); }
  }
});

test('U03 the HUD variables alias the tokens and the app font comes from them', () => {
  const index = src('index.css');
  for (const alias of ['--bg: var(--sc-background)', '--text: var(--sc-foreground)', '--text-dim: var(--sc-muted-foreground)', '--panel-border: var(--sc-border)', '--accent-strong: var(--sc-brand)']) assert.ok(index.includes(alias), alias);
  assert.ok(index.includes('font-family: var(--font-sans)'));
  assert.deepEqual(rules.rawColours(src('components/ui/button.tsx')), []);
});

test('U04 @theme inline maps the utilities the app uses', () => {
  for (const util of ['--color-card', '--color-primary', '--color-muted-foreground', '--color-destructive', '--color-success', '--color-warning', '--color-info', '--color-stage-yellow', '--color-glass', '--color-toast', '--color-scrim', '--radius-card', '--shadow-soft']) assert.ok(css.includes(util), util);
});

test('U05 text and accent pairs reach WCAG AA (4.5:1) in light and dark', () => {
  const pairs = [['foreground', 'background'], ['card-foreground', 'card'], ['muted-foreground', 'card'], ['muted-foreground', 'background'], ['primary-foreground', 'primary'], ['popover-foreground', 'popover'],
    ['stage-yellow-foreground', 'stage-yellow'], ['stage-green-foreground', 'stage-green'], ['stage-orange-foreground', 'stage-orange'], ['stage-charcoal-foreground', 'stage-charcoal'], ['toast-foreground', 'toast'],
    ['success-foreground', 'card'], ['warning-foreground', 'card'], ['info-foreground', 'card'], ['destructive-foreground', 'destructive']];
  for (const [mode, set] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of pairs) {
      const ratio = contrast(set[fg], set[bg]);
      assert.ok(ratio >= 4.5, `${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(contrast(light['destructive'], light['card']) >= 4.5, 'destructive text on a card');
  assert.ok(contrast(dark['destructive'], dark['card']) >= 4.5);
});

test('U06 yellow takes dark text: white on yellow would fail AA', () => {
  assert.ok(contrast('#ffffff', light['stage-yellow']) < 4.5);
  assert.ok(contrast(light['stage-yellow-foreground'], light['stage-yellow']) >= 4.5);
  assert.match(accent.ACCENT_FILL.yellow, /text-stage-yellow-foreground/);
});

test('U07 radius, shadow and glass tokens exist: cards 24px, controls fully rounded, a translucent glass', () => {
  assert.equal(light['radius-card'], '1.5rem');
  assert.match(css, /--radius-control: 9999px/);
  assert.match(light['shadow-soft'], /rgb/);
  assert.match(light.glass, /\/ 0\.\d+\)/, 'translucent');
  assert.match(css, /\.glass \{[^}]*backdrop-filter: blur/);
});

test('U08 Outfit is bundled locally and pinned; monospace stays for code', () => {
  assert.match(pkg.dependencies['@fontsource/outfit'], /^\d+\.\d+\.\d+$/);
  assert.ok(css.includes('@fontsource/outfit/400.css'));
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(css + src('index.css') + readFileSync(new URL('../index.html', import.meta.url), 'utf8')));
  assert.match(css, /--font-sans: 'Outfit'/);
  assert.match(css, /--font-mono:/);
  assert.match(css, /code, kbd, pre, samp \{ font-family: var\(--font-mono\)/);
});

test('U09 every dependency added by this work is pinned exactly', () => {
  assert.match(pkg.dependencies['@fontsource/outfit'], /^\d/);
  assert.equal(Object.keys(pkg.dependencies).filter((name) => /recharts|chart\.js|d3/.test(name)).length, 0, 'charts are hand-built SVG, no chart dependency');
});

test('U10 the raw-colour rule rejects palette classes, arbitrary colours and literals', () => {
  for (const bad of ['bg-red-500', 'text-[#fff]', 'border-slate-200', 'dark:bg-gray-900', 'hover:bg-black', 'bg-[rgb(0,0,0)]', 'style={{ color: \'#ff0000\' }}', 'style={{ color: "rgb(1,2,3)" }}', 'text-white', 'ring-amber-500/40', 'var(--color-violet-400)', 'color: #abc;']) {
    assert.ok(rules.rawColours(bad).length > 0, bad);
  }
});

test('U11 the rule accepts theme tokens', () => {
  for (const good of ['bg-card', 'bg-primary/10', 'text-muted-foreground', 'style={{ background: \'var(--sc-info)\' }}', 'bg-stage-green text-stage-green-foreground', 'bg-current/20', 'href="#section"', 'var(--color-info)']) assert.deepEqual(rules.rawColours(good), [], good);
});

const walk = (dir) => readdirSync(dir).flatMap((name) => { const full = `${dir}/${name}`; return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : []; });

test('U12 src/ui and the shared components have no raw colour, and the old surface rule is gone', () => {
  const files = [...walk(new URL('../src/ui', import.meta.url).pathname), ...walk(new URL('../src/components', import.meta.url).pathname)];
  assert.ok(files.length > 100);
  for (const file of files) assert.deepEqual(rules.rawColours(readFileSync(file, 'utf8')), [], file);
  assert.ok(!src('lib/crmWorkspace.ts').includes('FORBIDDEN_SURFACE'));
});

test('U13 the canvas colour helpers read tokens and add alpha only to six-digit hex', () => {
  assert.equal(colour.withAlpha('#8b949e', 0.4), '#8b949e66');
  assert.equal(colour.withAlpha('#8b949e', 2), '#8b949eff');
  assert.equal(colour.withAlpha('rgb(1 2 3)', 0.5), 'rgb(1 2 3)');
  const root = { };
  const restore = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => ` ${name}-value ` });
  assert.equal(colour.readToken('--sc-x', root), '--sc-x-value');
  globalThis.getComputedStyle = restore;
});

test('U13b onThemeChange observes the class attribute and unsubscribes', () => {
  const seen = [];
  const restore = globalThis.MutationObserver;
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; } observe(el, options) { seen.push(options); } disconnect() { seen.push('off'); } };
  const off = colour.onThemeChange(() => undefined, {});
  off();
  globalThis.MutationObserver = restore;
  assert.deepEqual(seen, [{ attributes: true, attributeFilter: ['class'] }, 'off']);
});

test('U15 accent classes: dark text on yellow, theme foregrounds elsewhere', () => {
  assert.equal(Object.keys(accent.ACCENT_FILL).length, 5);
  assert.equal(accent.accentVar('orange'), 'var(--sc-stage-orange)');
  assert.equal(accent.accentVar('neutral'), 'var(--sc-secondary)');
  assert.equal(accent.ACCENT_SOLID.charcoal, 'bg-stage-charcoal');
});

test('U17 the tab pill sits on the active tab; nothing measurable gives no pill', () => {
  assert.deepEqual(tab.indicatorBox({ left: 100, width: 600 }, { left: 250, width: 80 }), { x: 150, width: 80 });
  assert.equal(tab.indicatorBox(null, { left: 1, width: 1 }), null);
  assert.equal(tab.indicatorBox({ left: 0, width: 10 }, null), null);
  assert.equal(tab.indicatorBox({ left: 0, width: 10 }, { left: 0, width: 0 }), null);
});

test('U19-U21 KPIs: missing values are left out, a real 0 stays, deltas need a usable comparison', () => {
  const items = [{ key: 'a', label: 'A', value: 0 }, { key: 'b', label: 'B', value: null }, { key: 'c', label: 'C', value: undefined }, { key: 'd', label: 'D', value: Number.NaN }, { key: 'e', label: 'E', value: 5 }];
  assert.deepEqual(kpi.presentKpis(items).map((i) => i.key), ['a', 'e']);
  assert.deepEqual(kpi.deltaBadge(7, 4), { tone: 'positive', text: '+3' });
  assert.deepEqual(kpi.deltaBadge(2, 5, '%'), { tone: 'negative', text: '−3%' });
  assert.deepEqual(kpi.deltaBadge(4, 4), { tone: 'neutral', text: 'no change' });
  for (const [a, b] of [[null, 1], [1, null], [undefined, 1], [1, undefined], [1, Number.NaN], [Infinity, 1]]) assert.equal(kpi.deltaBadge(a, b), null);
});

test('U22 KPI numbers use thousands separators and "—" for nothing', () => {
  assert.equal(kpi.formatKpi(1e12), '1,000,000,000,000');
  assert.equal(kpi.formatKpi(-1234), '-1,234');
  assert.equal(kpi.formatKpi(0), '0');
  for (const none of [null, undefined, Number.NaN, Infinity]) assert.equal(kpi.formatKpi(none), '—');
});

test('U42 score clamps to 0..100 and reads 0 for a non-number', () => {
  assert.deepEqual([-5, 0, 49.6, 100, 140, Number.NaN, Infinity].map(score.clampScore), [0, 0, 50, 100, 100, 0, 0]);
});

test('U43 ring offset: full ring at 100, empty at 0', () => {
  const c = 2 * Math.PI * 44;
  assert.equal(score.ringDashOffset(100, 44), 0);
  assert.ok(Math.abs(score.ringDashOffset(0, 44) - c) < 1e-9);
  assert.ok(Math.abs(score.ringDashOffset(50, 44) - c / 2) < 1e-9);
  assert.equal(score.ringDashOffset(900, 44), 0);
});

test('U39 initials: two words, one word, empty, null, unicode, long', () => {
  assert.equal(people.initials('Ava Thompson'), 'AT');
  assert.equal(people.initials('  ava  b  thompson '), 'AT');
  assert.equal(people.initials('Madonna'), 'M');
  assert.equal(people.initials(''), '?');
  assert.equal(people.initials(null), '?');
  assert.equal(people.initials(undefined), '?');
  assert.equal(people.initials('😀 Émile'), '😀É');
  assert.equal(people.initials('x'.repeat(500)), 'X');
});

test('U56 avatar overflow: shows up to max and counts the rest; empty and max 0', () => {
  assert.deepEqual(people.avatarOverflow(['a', 'b', 'c', 'd'], 3), { shown: ['a', 'b', 'c'], more: 1 });
  assert.deepEqual(people.avatarOverflow([], 3), { shown: [], more: 0 });
  assert.deepEqual(people.avatarOverflow(['a', 'b'], 0), { shown: [], more: 2 });
  assert.deepEqual(people.avatarOverflow(['a'], 5), { shown: ['a'], more: 0 });
});

test('U57 sort cycles asc, desc, none; nulls last; stable', () => {
  let state = sort.nextSort(null, 'n');
  assert.deepEqual(state, { key: 'n', direction: 'asc' });
  state = sort.nextSort(state, 'n');
  assert.deepEqual(state, { key: 'n', direction: 'desc' });
  assert.equal(sort.nextSort(state, 'n'), null);
  assert.deepEqual(sort.nextSort(state, 'other'), { key: 'other', direction: 'asc' });
  const rows = [{ id: 1, v: 3 }, { id: 2, v: null }, { id: 3, v: 1 }, { id: 4, v: 3 }, { id: 5, v: undefined }];
  const by = (r) => r.v;
  assert.deepEqual(sort.sortRows(rows, { key: 'v', direction: 'asc' }, by).map((r) => r.id), [3, 1, 4, 2, 5]);
  assert.deepEqual(sort.sortRows(rows, { key: 'v', direction: 'desc' }, by).map((r) => r.id), [1, 4, 3, 2, 5]);
  assert.deepEqual(sort.sortRows(rows, null, by).map((r) => r.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(sort.sortRows([{ s: 'b' }, { s: 'a' }], { key: 's', direction: 'asc' }, (r) => r.s).map((r) => r.s), ['a', 'b']);
  assert.deepEqual(sort.sortRows([{ v: null, id: 1 }, { v: null, id: 2 }], { key: 'v', direction: 'asc' }, by).map((r) => r.id), [1, 2], 'two empties keep order');
});

test('U58 "Show all N" appears only when rows exceed the limit', () => {
  const rows = [1, 2, 3, 4, 5];
  assert.deepEqual(sort.visibleRows(rows, 3, false), { rows: [1, 2, 3], hidden: 2 });
  assert.deepEqual(sort.visibleRows(rows, 5, false), { rows, hidden: 0 });
  assert.deepEqual(sort.visibleRows(rows, 3, true), { rows, hidden: 0 });
  assert.deepEqual(sort.visibleRows(rows, undefined, false), { rows, hidden: 0 });
  assert.deepEqual(sort.visibleRows(rows, 0, false), { rows: [], hidden: 5 });
});

test('U59 the undo toast offers one "Undo" that fires its callback once', () => {
  const calls = [];
  let options;
  undo.showUndoToast('Moved', () => calls.push('undo'), (message, o) => { calls.push(message); options = o; });
  assert.equal(options.action.label, 'Undo');
  assert.equal(options.duration, undo.UNDO_TOAST_MS);
  options.action.onClick(); options.action.onClick();
  assert.deepEqual(calls, ['Moved', 'undo']);
});

test('U60 reduced motion switches off every animation and transition', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
});

test('C03 the tab list slides a charcoal pill under the active trigger', () => {
  const tabs = src('components/ui/tabs.tsx');
  assert.match(tabs, /data-slot="tab-indicator"/);
  assert.match(tabs, /bg-primary transition-\[transform,width\]/);
  assert.match(tabs, /data-\[state=active\]:text-primary-foreground/);
  assert.match(tabs, /querySelector<HTMLElement>\('\[data-state="active"\]'\)/);
});

test('C01 C02 C04 C05 C06 C07 the shared components use the pill, card and glass vocabulary', () => {
  const read = (n) => src(`components/ui/${n}.tsx`);
  assert.match(read('button'), /rounded-control/);
  assert.match(read('button'), /size-9 p-0/);
  assert.match(read('badge'), /dot\?: boolean/);
  assert.match(read('badge'), /success: "bg-success\/15 text-success-foreground"/);
  assert.match(read('input'), /icon\?: React\.ReactNode/);
  assert.match(read('input'), /rounded-control/);
  assert.match(read('textarea'), /rounded-2xl/);
  assert.match(read('native-select'), /rounded-control/);
  assert.match(read('native-select'), /relative inline-flex w-fit items-center/);
  assert.match(read('native-select'), /wrapperClassName/);
  assert.match(read('native-select'), /"h-9 w-full cursor-pointer/);
  const importTab = src('ui/crm/ImportTab.tsx');
  assert.match(importTab, /wrapperClassName="w-full"/);
  assert.match(importTab, /disabled=\{disabled \|\| busy\} title=\{disabledTitle\(readOnly\)\} onClick=\{\(\) => void commit\(\)\}/);
  assert.doesNotMatch(importTab, /Preview the file first|canCommit/);
  assert.match(read('select'), /rounded-control/);
  assert.match(read('card'), /rounded-card bg-card/);
  assert.doesNotMatch(read('card'), /border bg-card/);
  for (const name of ['dialog', 'sheet', 'popover', 'dropdown-menu']) assert.match(read(name), /shadow-lift/, name);
  assert.match(read('dialog'), /rounded-card/);
  assert.match(read('dialog'), /bg-scrim/);
  assert.match(read('tooltip'), /bg-toast/);
  assert.match(read('sonner'), /!bg-toast/);
  assert.match(read('sonner'), /!bg-stage-yellow/);
});

test('floating text panels use the shared card radius, controls stay pill', () => {
  const read = (n) => src(`components/ui/${n}.tsx`);
  assert.match(read('tooltip'), /rounded-card/);
  assert.doesNotMatch(read('tooltip'), /rounded-control|rounded-full/);
  const sonner = read('sonner');
  assert.match(sonner, /toast: "[^"]*!rounded-card/);
  assert.doesNotMatch(sonner, /toast: "[^"]*!rounded-control/);
  assert.match(sonner, /actionButton: "!rounded-control/);
  for (const name of ['tooltip', 'sonner']) {
    assert.doesNotMatch(read(name), /rounded-\[|24px|1\.5rem/, `${name} hard-codes a radius`);
    assert.doesNotMatch(read(name), /animate-spin|animate-pulse|infinite/, name);
  }
  const css = src('styles/shadcn.css');
  assert.match(css, /--radius-card: var\(--sc-radius-card\)/);
  assert.match(css, /--sc-radius-card: 1\.5rem/);
  assert.equal((css.match(/--sc-radius-card:/g) ?? []).length, 1, 'dark theme must not override it');
  assert.match(src('ui/design/Charts.tsx'), /rounded-2xl[^"]*bg-toast|bg-toast[^"]*rounded-2xl/);
  for (const name of ['dropdown-menu', 'select', 'popover']) assert.match(read(name), /rounded-xl/, name);
  for (const name of ['button', 'input', 'native-select', 'badge', 'tabs']) {
    assert.match(read(name), /rounded-control|rounded-full/, name);
  }
});

const design = (n) => src(`ui/design/${n}.tsx`);

test('C08-C18 the design components expose their accessible roles', () => {
  assert.match(design('Header'), /export function PageHeader/);
  assert.match(design('Header'), /lines\.map/);
  assert.match(design('Header'), /export function KpiStat/);
  assert.match(design('Header'), /export function KpiRow/);
  assert.match(design('Header'), /presentKpis/);
  assert.match(design('Header'), /export function CardHeading/);
  assert.match(design('Header'), /onMore &&/);
  assert.match(design('Segmented'), /aria-pressed=\{option\.value === value\}/);
  assert.match(design('Segmented'), /role="group" aria-label=\{label\}/);
  assert.match(design('Buttons'), /'aria-label': string/);
  assert.match(design('Buttons'), /focus-visible:ring-\[3px\]/);
  assert.match(design('Cards'), /aria-current=\{i === index \? 'step' : undefined\}/);
  assert.match(design('Cards'), /font-bold/);
  assert.match(design('Cards'), /role="progressbar"/);
  assert.match(design('Cards'), /aria-valuenow=\{score\}/);
  assert.match(design('Cards'), /export function ItemCard/);
  assert.match(design('Cards'), /ACCENT_FILL\[accent\]/);
  assert.match(design('Cards'), /avatarOverflow/);
  assert.match(design('DataTable'), /aria-sort=/);
  assert.match(design('DataTable'), /Show all \{rows\.length\}/);
  assert.match(design('DataTable'), /rowMenu/);
  assert.match(design('DataTable'), /TwoLine/);
  assert.match(design('DataTable'), /StatusDot/);
});

test('C19 the old Pill and Panel are gone from shared.tsx and nothing imports them', () => {
  const shared = src('ui/crm/shared.tsx');
  assert.ok(!/Pill|Panel/.test(shared));
  for (const file of walk(new URL('../src/ui', import.meta.url).pathname)) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/import \{[^}]*\b(Pill|Panel)\b[^}]*\} from '\.\/shared'/.test(text), file);
    assert.ok(!/<Pill\b|<Panel\b/.test(text), file);
  }
});

test('C39 C40 the top bar, footer, popovers and notification drawer use the glass surface', () => {
  assert.match(src('ui/TopBar.tsx'), /glass rounded-card/);
  assert.match(src('ui/StatusFooter.tsx'), /items-stretch glass/);
  for (const file of ['ui/TasksPopover.tsx', 'ui/PlanningSessionsPopover.tsx', 'ui/NotificationCenter.tsx', 'ui/FooterCountPopover.tsx']) assert.match(src(file), /\bglass\b/, file);
  assert.match(src('ui/ProjectWorkspaceModal.tsx'), /canvas-warm/);
});

test('C41 board and status colours come from the status and stage tokens', () => {
  const board = src('ui/project-popup/TaskBoard.tsx');
  assert.match(board, /bg-warning/);
  assert.match(board, /bg-info\/|border-info/);
  assert.match(src('lib/projectTasks.ts'), /bg-success/);
  assert.match(src('ui/TaskProgressBar.tsx'), /bg-info/);
});

test('C42 dense views keep their small type', () => {
  assert.match(src('ui/TaskTerminal.tsx'), /fontSize: 13/);
  assert.match(src('ui/project-popup/TaskBoard.tsx'), /text-xs|text-\[11px\]/);
});

test('C43 no component relies on a dark: palette variant', () => {
  for (const file of walk(new URL('../src/ui', import.meta.url).pathname)) assert.ok(!/dark:(bg|text|border)-(red|amber|green|emerald|blue|slate|gray|zinc|violet|sky|rose|black|white)/.test(readFileSync(file, 'utf8')), file);
});
