import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// Keeps the project popup from pegging the GPU. Two things did that together: forever-looping
// animations, which make the browser redraw every frame, and the popup overlay's full-screen backdrop
// blur, which is recomputed on each of those frames. Brief spinners (e.g. while a request is pending)
// are fine. Show running/waiting state with a static colour or a text label instead of a loop, and
// dim behind a popup with a plain scrim instead of a blur.
const SRC = new URL('../src/', import.meta.url);

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(tsx?|css)$/.test(entry.name))
    .map((entry) => new URL(`${entry.parentPath ?? entry.path}/${entry.name}`, 'file://'));
}

test('no UI source uses Tailwind\'s forever-looping animate-pulse or animate-ping', async () => {
  const offenders = [];
  for (const file of await sourceFiles(SRC)) {
    if (/animate-(pulse|ping)\b/.test(await readFile(file, 'utf8'))) offenders.push(file.pathname);
  }
  assert.deepEqual(offenders, []);
});

test('no stylesheet declares an infinite CSS animation', async () => {
  const offenders = [];
  for (const file of await sourceFiles(SRC)) {
    if (file.pathname.endsWith('.css') && /animation[^;]*\binfinite\b/.test(await readFile(file, 'utf8'))) offenders.push(file.pathname);
  }
  assert.deepEqual(offenders, []);
});

test('popup overlays dim with a plain scrim, not a full-screen backdrop blur', async () => {
  for (const name of ['dialog.tsx', 'sheet.tsx']) {
    const source = await readFile(new URL(`components/ui/${name}`, SRC), 'utf8');
    const overlay = source.slice(source.indexOf('Overlay'), source.indexOf('Content'));
    assert.doesNotMatch(overlay, /backdrop-blur|backdrop-filter/, `${name} overlay must not blur`);
  }
});

test('the dialog scrim is tuned for both themes', async () => {
  const source = await readFile(new URL('components/ui/dialog.tsx', SRC), 'utf8');
  assert.match(source, /bg-scrim/);
});
