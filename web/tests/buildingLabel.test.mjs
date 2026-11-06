import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// Source/CSS contract for the 3D scene's glass-badge building labels: there is no DOM here, so these
// check the markup structure in the components and the scoped rules in index.css.
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const building = await read('../src/scene/ProjectYard.tsx');
const home = await read('../src/scene/HomeBuilding.tsx');
const dot = await read('../src/ui/ProjectStatusDot.tsx');
const bar = await read('../src/ui/TaskProgressBar.tsx');
const cards = await read('../src/ui/ProjectCardsView.tsx');
const css = await read('../src/index.css');

/** The body of the first CSS rule whose selector is exactly `selector`. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}

const projectLabel = building.slice(building.indexOf('<div className={`building-label'), building.lastIndexOf('</Html>'));

test('U1: the project label stacks the dot, then a body holding the name badge and the bar', () => {
  assert.match(
    projectLabel,
    /<ProjectStatusDot style=\{statusStyle\} label=\{dotLabel\} \/>\s*<div className="building-label-body">\s*<div className="building-badge">\s*<span className="building-name">\{project\.name\}<\/span>\s*<\/div>\s*\{progress && <TaskProgressBar[^>]*\/>\}\s*<\/div>/,
  );
});

test('U2: the status dot sits above the pill, not inside it', () => {
  assert.ok(projectLabel.indexOf('<ProjectStatusDot') < projectLabel.indexOf('building-badge'));
  const badge = projectLabel.match(/<div className="building-badge">([\s\S]*?)<\/div>/)[1];
  assert.doesNotMatch(badge, /ProjectStatusDot/);
});

test('U3: the progress bar sits outside the pill, inside the label body', () => {
  const badge = projectLabel.match(/<div className="building-badge">[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(badge, /TaskProgressBar/);
  const body = projectLabel.slice(projectLabel.indexOf('building-label-body'));
  assert.ok(body.indexOf(badge) < body.indexOf('<TaskProgressBar'));
});

test('U4: the bar only renders once the project has plan items', () => {
  assert.match(projectLabel, /\{progress && <TaskProgressBar progress=\{progress\}/);
});

test('U5: the building bar is 6px tall, 70% of the pill width and centred under it', () => {
  const call = projectLabel.match(/<TaskProgressBar[^>]*className="([^"]*)"/)[1].split(' ');
  assert.ok(call.includes('h-[6px]'));
  assert.ok(call.includes('w-[70%]'));
  assert.ok(call.includes('self-center'));
  assert.ok(!call.includes('h-1'));
});

test('U6: the City Center label is a badge with no status dot or bar', () => {
  assert.match(home, /<div className="building-badge">\s*<span className="building-name">City Center<\/span>\s*<\/div>/);
  assert.doesNotMatch(home, /ProjectStatusDot|TaskProgressBar/);
});

test('U7: selecting a building puts the cyan border and halo on its pill', () => {
  for (const source of [building, home]) {
    assert.match(source, /`building-label\$\{selected \? ' building-label--selected' : ''\}`/);
  }
  const selected = rule('.building-label--selected .building-badge');
  assert.match(selected, /border-color: #62ddff;/);
  assert.match(selected, /box-shadow: 0 0 0 2px #62ddff30/);
});

test('U8: the pill is a rounded, translucent, blurred glass badge', () => {
  const badge = rule('.building-badge');
  assert.match(badge, /border-radius: 999px;/);
  assert.match(badge, /background: rgba\(15, 30, 50, 0\.32\);/);
  assert.match(badge, /-webkit-backdrop-filter: blur\(8px\) saturate\(160%\);/);
  assert.match(badge, /\n\s+backdrop-filter: blur\(8px\) saturate\(160%\);/);
  assert.match(badge, /border: 1px solid rgba\(255, 255, 255, 0\.32\);/);
  assert.match(badge, /padding: 3px 9px;/);
});

test('U8b: the pill centres the name without the inherited line strut', () => {
  const badge = rule('.building-badge');
  assert.match(badge, /display: flex;/);
  assert.match(badge, /align-items: center;/);
  assert.match(rule('.building-name'), /line-height: 1;/);
});

test('U9: the name is 10px semibold text with a readability shadow', () => {
  const name = rule('.building-name');
  assert.match(name, /font-size: 10px;/);
  assert.doesNotMatch(name, /12px/);
  assert.match(name, /font-weight: 600;/);
  assert.match(name, /text-shadow:/);
});

test('U10: the outer label is a transparent, centred column nudged up 4px', () => {
  const label = rule('.building-label');
  assert.match(label, /flex-direction: column;/);
  assert.match(label, /align-items: center;/);
  assert.doesNotMatch(label, /background|rgba\(12, 27, 48, 0\.95\)/);
  assert.match(label, /transform: translateY\(-4px\);/);
  assert.doesNotMatch(label, /-8px/);
  assert.match(label, /pointer-events: none;/);
});

test('U11: the label body stretches the bar to the pill width', () => {
  const body = rule('.building-label-body');
  assert.match(body, /flex-direction: column;/);
  assert.match(body, /align-items: stretch;/);
});

test('U12: only the building label shrinks and rings the dot; the global dot keeps 11px', () => {
  const scoped = rule('.building-label .building-status-dot');
  assert.match(scoped, /width: 7px;/);
  assert.match(scoped, /height: 7px;/);
  assert.match(scoped, /0 0 0 1\.5px rgba\(255, 255, 255/);
  assert.match(scoped, /0 0 6px 2px var\(--dot-glow\)/);
  const global = rule('.building-status-dot');
  assert.match(global, /width: 11px;/);
  assert.match(global, /box-shadow: 0 0 8px 3px var\(--dot-glow\);/);
  // The glow colour comes in as a variable (transparent when idle) so CSS can size it per view.
  assert.match(dot, /'--dot-glow': style\.glowing \? style\.dotGlowColor : 'transparent'/);
  assert.doesNotMatch(dot, /boxShadow/);
});

test('U13: the bar glass track is scoped to the building; TaskProgressBar defaults are unchanged', () => {
  assert.match(projectLabel, /className="building-progress /);
  const track = rule('.building-progress');
  assert.match(track, /background: rgba\(15, 30, 50, 0\.32\);/);
  assert.match(track, /0 0 0 1px rgba\(255, 255, 255, 0\.3\)/);
  assert.match(bar, /'flex h-1\.5 w-full gap-px overflow-hidden rounded-full bg-muted-foreground\/25'/);
});

test('U14: the old row and stacked label classes are gone everywhere', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) await walk(url);
      else if (/\.(tsx?|css)$/.test(entry.name)) files.push(url);
    }
  };
  await walk(new URL('../src/', import.meta.url));
  for (const file of files) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /building-label-row|building-label--stacked/, file.pathname);
  }
});

test('U15: the LABEL_Y comment describes the dot, pill and bar rows and the -4px offset', () => {
  const comment = building.match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*const LABEL_Y/)[1];
  assert.match(comment, /translateY\(-4px\)/);
  assert.match(comment, /dot, pill and bar rows/);
  assert.doesNotMatch(comment, /-8px|name \+ pill rows/);
});

test('I1: the cards view keeps its own dot and bar, untouched by the building label classes', () => {
  assert.match(cards, /<ProjectStatusDot style=\{statusStyle\} label=\{dotLabel\} \/>/);
  assert.match(cards, /<TaskProgressBar/);
  assert.doesNotMatch(cards, /building-badge|building-label|building-progress/);
});
