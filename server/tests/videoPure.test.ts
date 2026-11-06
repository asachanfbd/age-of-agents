import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { ContentCtx } from '../src/content/context.ts';
import { openContentDb } from '../src/content/db.ts';
import type { ContentInputError } from '../src/content/errors.ts';
import { contentJobs, setContentJobsClock } from '../src/content/jobs.ts';
import type { ContentJobEvent } from '../src/content/jobs.ts';
import * as limits from '../src/content/limits.ts';
import { cleanUploadName, MEDIA_TYPES, parseRename, sniffMedia } from '../src/content/mediaTypes.ts';
import {
  archiveConceptCode, compositionIdFor, conceptIndexSource, ensureProject, REMOTION_PACKAGES, REMOTION_VERSION, registrySource, remotionDir, scaffoldConcept, scaffoldProject, setupView, writeRegistry, cancelSetup, removeConceptFromProject,
} from '../src/content/remotionProject.ts';
import { createRenderQueue, timeoutMessage } from '../src/content/renderQueue.ts';
import type { RenderOutcome } from '../src/content/renderQueue.ts';
import { STUDIO_TABS } from '../src/content/studioTabs.ts';
import { confirmBlocker, confirmMessage, formatDuration, formatSize, parseChecklist, replaceChecklist } from '../src/content/videoChecklist.ts';
import type { ChecklistItem } from '../src/content/videoChecklist.ts';
import { configureVideo, parseRenderProgress, resetVideo } from '../src/content/videoDeps.ts';
import { videoSystemPrompt } from '../src/content/videoInstructions.ts';
import { checkDeclaredLength } from '../src/content/videoMedia.ts';
import { renderFile } from '../src/content/videoStudio.ts';

/** The Video tab's pure rules and the Remotion project files, in a temp folder with an in-memory database; never a real install or render. */

const roots: string[] = [];
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });
afterEach(() => resetVideo());

async function tempCtx(): Promise<ContentCtx> {
  const dir = await mkdtemp(path.join(tmpdir(), 'video-pure-'));
  roots.push(dir);
  const db = openContentDb(':memory:');
  return { db, buildingId: `b-${path.basename(dir)}`, dir, now: () => Date.now(), timezone: () => 'UTC', exclusive: (w) => w() };
}

const status = (fn: () => unknown): number | 'ok' => { try { fn(); return 'ok'; } catch (e) { return (e as { status: number }).status; } };
const CID = '7f3a9c12-1111-4111-8111-111111111111';

// ---- media names and types -------------------------------------------------------------------

test('SU01 upload-name cleaning swaps unsafe characters for - and keeps the extension', () => {
  assert.equal(cleanUploadName('IMG (1)é/x\\y:z😀\u0001.JPG', []), 'IMG -1---x-y-z--.JPG');
});

test('SU02 cleaning strips leading dots and an empty base becomes file', () => {
  assert.equal(cleanUploadName('..hidden.png', []), 'hidden.png');
  assert.equal(cleanUploadName('😀.png', []), '-.png');
  assert.equal(cleanUploadName('...png', []), 'file.png');
});

test('SU03 a 300-character name is trimmed to 120 characters keeping the extension', () => {
  const name = cleanUploadName(`${'a'.repeat(300)}.mp4`, []);
  assert.equal(name.length, 120);
  assert.ok(name.endsWith('.mp4'));
});

test('SU04 a taken name gets -2 then -3, ignoring case, and still fits', () => {
  assert.equal(cleanUploadName('logo.png', ['Logo.png']), 'logo-2.png');
  assert.equal(cleanUploadName('logo.png', ['LOGO.png', 'logo-2.png']), 'logo-3.png');
  const long = `${'a'.repeat(116)}.png`;
  const suffixed = cleanUploadName(long, [long]);
  assert.equal(suffixed.length, 120);
  assert.ok(suffixed.endsWith('-2.png'));
});

test('SU05/SU06/SU07/SU08/SU09/SU10 rename rules', () => {
  const ok = (raw: unknown, current = 'a.png', others: string[] = []) => parseRename(raw, current, others);
  assert.equal(ok('My logo_v2-final.png'), 'My logo_v2-final.png');
  assert.equal(ok('a.png'), 'a.png');
  assert.equal(ok(`${'b'.repeat(116)}.png`).length, 120);
  assert.equal(status(() => ok(`${'b'.repeat(117)}.png`)), 400);
  for (const bad of ['', '   ', '.png']) assert.equal(status(() => ok(bad)), 400, bad);
  for (const bad of ['a/b.png', 'a\\b.png', 'a:b.png', 'é.png', '😀.png', 'a\u0001.png', '.a.png']) assert.equal(status(() => ok(bad)), 400, bad);
  assert.equal(status(() => ok('a.jpg')), 400);
  assert.equal(ok('a.PNG'), 'a.PNG');
  assert.equal(ok('  spaced.png  '), 'spaced.png');
  assert.equal(status(() => ok(5)), 400);
  assert.equal(status(() => ok('B.png', 'a.png', ['b.PNG'])), 409);
});

const sig: Record<string, Buffer> = {
  mp4: Buffer.from([0, 0, 0, 0x20, ...Buffer.from('ftypisom')]),
  mov: Buffer.from([0, 0, 0, 0x14, ...Buffer.from('ftypqt  ')]),
  m4a: Buffer.from([0, 0, 0, 0x20, ...Buffer.from('ftypM4A ')]),
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
  webp: Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'),
  gif: Buffer.from('GIF89a..'),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  mp3: Buffer.from('ID3\x04\x00', 'latin1'),
  wav: Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'),
  aac: Buffer.from([0xff, 0xf1, 0x50, 0x80]),
};
export const MEDIA_SIGNATURES = sig;

test('SU11 the extension allow-list, upper case too; anything else is Unsupported file type', () => {
  assert.deepEqual(Object.keys(MEDIA_TYPES).sort(), ['aac', 'gif', 'jpeg', 'jpg', 'm4a', 'mov', 'mp3', 'mp4', 'png', 'svg', 'wav', 'webm', 'webp']);
  assert.equal(sniffMedia('A.JPG', sig.jpg!), 'image');
  assert.equal(sniffMedia('A.JPEG', sig.jpeg!), 'image');
  for (const name of ['a.pdf', 'a.exe', 'a.txt', 'a.mkv', 'a.heic', 'noext', 'x.png.exe']) {
    assert.throws(() => sniffMedia(name, sig.png!), (e: ContentInputError) => e.status === 400 && e.message === 'Unsupported file type', name);
  }
});

test('SU12 every allowed type is recognised from its first bytes and maps to its kind', () => {
  const kinds: Record<string, string> = { mp4: 'video', mov: 'video', webm: 'video', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image', mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio' };
  for (const [ext, kind] of Object.entries(kinds)) assert.equal(sniffMedia(`f.${ext}`, sig[ext]!), kind, ext);
});

test('SU13 a sniffed type that does not match is 400; ISO-BMFF passes for mp4, mov and m4a', () => {
  assert.equal(status(() => sniffMedia('a.jpg', sig.png!)), 400);
  assert.equal(status(() => sniffMedia('a.mp3', sig.wav!)), 400);
  for (const ext of ['mp4', 'mov', 'm4a']) for (const from of ['mp4', 'mov', 'm4a']) assert.doesNotThrow(() => sniffMedia(`a.${ext}`, sig[from]!));
  assert.doesNotThrow(() => sniffMedia('a.mov', Buffer.from('\x00\x00\x00\x08moov', 'latin1')));
});

test('SU14 SVG: HTML or text is 400; an svg root after a declaration, BOM or comment passes', () => {
  assert.equal(status(() => sniffMedia('a.svg', Buffer.from('<html><body>hi</body></html>'))), 400);
  assert.equal(status(() => sniffMedia('a.svg', Buffer.from('just text'))), 400);
  assert.equal(sniffMedia('a.svg', Buffer.from('﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "x">\n<svg viewBox="0 0 1 1"></svg>')), 'image');
});

test('SU15 an empty file or one shorter than its signature is 400', () => {
  assert.throws(() => sniffMedia('a.png', Buffer.alloc(0)), /empty/);
  assert.equal(status(() => sniffMedia('a.png', sig.png!.subarray(0, 4))), 400);
  assert.equal(status(() => sniffMedia('a.webm', Buffer.from([0x1a]))), 400);
});

test('SU16 mp3 with ID3 or bare frame sync; aac with ADTS (not an MPEG layer header)', () => {
  assert.equal(sniffMedia('a.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x64])), 'audio');
  assert.equal(sniffMedia('a.aac', sig.aac!), 'audio');
  assert.equal(status(() => sniffMedia('a.aac', Buffer.from([0xff, 0xfb, 0x90]))), 400);
  assert.equal(status(() => sniffMedia('a.mp3', sig.aac!)), 400);
});

test('SU17 the named limits', () => {
  assert.equal(limits.MEDIA_MAX_BYTES, 2_147_483_648);
  assert.equal(limits.MEDIA_FILES_MAX, 200);
  assert.equal(limits.MEDIA_NAME_MAX, 120);
  assert.deepEqual([limits.CHECKLIST_ITEMS_MAX, limits.CHECKLIST_ID_MAX, limits.CHECKLIST_LABEL_MAX, limits.CHECKLIST_DETAIL_MAX], [30, 40, 200, 1000]);
  assert.equal(limits.RENDER_TIMEOUT_MS, 30 * 60_000);
});

test('declared Content-Length: absent passes, not a safe whole number or over the limit is 400', () => {
  assert.doesNotThrow(() => checkDeclaredLength(undefined, 10));
  assert.doesNotThrow(() => checkDeclaredLength('10', 10));
  for (const bad of ['11', '99999999999999999999', 'abc', '-1']) assert.equal(status(() => checkDeclaredLength(bad, 10)), 400, bad);
  assert.throws(() => checkDeclaredLength(String(2 ** 31 + 1), limits.MEDIA_MAX_BYTES), /2 GB/);
});

// ---- checklist ---------------------------------------------------------------------------------

const item = (id: string, extra: object = {}) => ({ id, label: `Label ${id}`, ...extra });

test('SU18 the accepted edges of a checklist', () => {
  assert.equal(parseChecklist([item('a')]).length, 1);
  assert.equal(parseChecklist(Array.from({ length: 30 }, (_, i) => item(`i${i}`))).length, 30);
  assert.equal(parseChecklist([item('x'.repeat(40))])[0]!.id.length, 40);
  assert.equal(parseChecklist([{ id: 'a', label: 'L' }])[0]!.label, 'L');
  assert.equal(parseChecklist([{ id: 'a', label: '😀'.repeat(200) }])[0]!.label.length, 400);
  assert.equal(parseChecklist([item('a', { detail: 'd'.repeat(1000) })])[0]!.detail!.length, 1000);
  assert.equal(parseChecklist([item('a', { detail: '' })])[0]!.detail, null);
  assert.equal(parseChecklist([item('a', { detail: null })])[0]!.detail, null);
});

test('SU19/SU20/SU21/SU22/SU23 refused checklists are 400', () => {
  const bad: unknown[] = [
    [], Array.from({ length: 31 }, (_, i) => item(`i${i}`)), 'x', { items: [] }, [5], [null],
    [item('')], [item('x'.repeat(41))], [item('Upper')], [item('a_b')], [item('a b')], [{ id: 5, label: 'x' }],
    [item('a'), item('a')],
    [{ id: 'a', label: '   ' }], [{ id: 'a', label: 'x'.repeat(201) }], [{ id: 'a', label: 5 }], [{ id: 'a', label: 'two\nlines' }], [{ id: 'a', label: 'tab\there' }],
    [item('a', { detail: 'd'.repeat(1001) })], [item('a', { detail: 5 })],
  ];
  for (const value of bad) assert.equal(status(() => parseChecklist(value)), 400, JSON.stringify(value).slice(0, 40));
});

test('SU24 replacing keeps ticks and links of ids that stay, in the new order', () => {
  const previous: ChecklistItem[] = [
    { id: 'a', label: 'A', detail: null, ticked: true, mediaIds: ['m1'] },
    { id: 'b', label: 'B', detail: null, ticked: true, mediaIds: [] },
  ];
  const next = replaceChecklist(previous, parseChecklist([item('c'), { id: 'a', label: 'A2' }]));
  assert.deepEqual(next.map((i) => [i.id, i.label, i.ticked, i.mediaIds]), [['c', 'Label c', false, []], ['a', 'A2', true, ['m1']]]);
});

// ---- confirm message -----------------------------------------------------------------------------

const media = [
  { id: 'm1', name: 'talking-head.mov', kind: 'video' as const, durationMs: 48_000, size: 1 },
  { id: 'm2', name: 'logo.svg', kind: 'image' as const, durationMs: null, size: 2048 },
  { id: 'm3', name: 'music.mp3', kind: 'audio' as const, durationMs: null, size: 5 * 1024 ** 2 },
];

test('SU25/SU26/SU27 the exact confirm message: files, then each item with its linked names', () => {
  const items: ChecklistItem[] = [
    { id: 'clip', label: 'Intro clip', detail: null, ticked: true, mediaIds: ['m1'] },
    { id: 'vo', label: 'Voice-over', detail: null, ticked: true, mediaIds: [] },
  ];
  const text = confirmMessage(`public/concepts/${CID}/media`, media, items);
  assert.equal(text, `All assets are provided. Media folder: public/concepts/${CID}/media. Files: talking-head.mov (video, 0:48); logo.svg (image, 2 KB); music.mp3 (audio, 5.0 MB). Checklist: Intro clip → talking-head.mov; Voice-over → (no file linked). Start building the video.`);
  assert.doesNotMatch(text, /Not needed/);
  assert.equal(formatSize(3 * 1024 ** 3), '3.0 GB');
  assert.equal(formatSize(10), '1 KB');
});

test('SU28/SU29 no media says Files: none., and the message is one line', () => {
  const text = confirmMessage('public/x', [], [{ id: 'a', label: 'A', detail: null, ticked: true, mediaIds: ['gone'] }]);
  assert.match(text, /Files: none\./);
  assert.match(text, /A → \(no file linked\)/);
  assert.doesNotMatch(text, /[\r\n]/);
});

test('SU30 durations: 0:00, rounding, and h:mm:ss from one hour', () => {
  assert.deepEqual([0, 499, 500, 48_000, 134_000, 3_605_000].map(formatDuration), ['0:00', '0:00', '0:01', '0:48', '2:14', '1:00:05']);
});

test('confirm blockers: confirmed, empty, unticked items left', () => {
  assert.match(confirmBlocker({ round: 1, items: [], confirmedAt: null })!, /not published/);
  assert.match(confirmBlocker({ round: 1, items: [{ id: 'a', label: 'A', detail: null, ticked: false, mediaIds: [] }], confirmedAt: null })!, /1 left/);
  assert.match(confirmBlocker({ round: 1, items: [], confirmedAt: 'x' })!, /already confirmed/);
  assert.equal(confirmBlocker({ round: 1, items: [{ id: 'a', label: 'A', detail: null, ticked: true, mediaIds: [] }], confirmedAt: null }), null);
});

// ---- Remotion project ------------------------------------------------------------------------------

test('SU31/SU32 composition ids are concept- plus 8 hex digits, longer when another Concept holds that one', async () => {
  const ctx = await tempCtx();
  assert.equal(compositionIdFor(ctx, CID), 'concept-7f3a9c12');
  assert.equal(compositionIdFor(ctx, CID), 'concept-7f3a9c12', 'kept once assigned');
  const twin = '7f3a9c12-2222-4222-8222-222222222222';
  assert.equal(compositionIdFor(ctx, twin), 'concept-7f3a9c122222');
});

test('SU33 the registry lists Concept folders sorted, each import has its export, and an empty registry is valid', async () => {
  const empty = registrySource([]);
  assert.match(empty, /export const compositions: ConceptComposition\[\] = \[\];/);
  const two = registrySource(['bbbbbbbb-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000000']);
  assert.ok(two.indexOf('aaaaaaaa') < two.indexOf('bbbbbbbb'));
  assert.match(two, /import \{ composition as c0 \} from '.\/aaaaaaaa-0000-4000-8000-000000000000\/index';/);
  assert.match(two, /= \[c0, c1\];/);
});

test('SU34/SU35/SU36/SU37 scaffold: pinned exact versions, Root imports the registry, brand kept, Concept at 1080x1920 30fps, registry rewritten only on change', async () => {
  const ctx = await tempCtx();
  await scaffoldProject(ctx);
  const root = remotionDir(ctx);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const deps of [pkg.dependencies, pkg.devDependencies]) for (const v of Object.values(deps)) assert.match(v as string, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.dependencies.remotion, REMOTION_VERSION);
  assert.equal(pkg.dependencies['@remotion/cli'], REMOTION_VERSION);
  assert.deepEqual(pkg.dependencies, REMOTION_PACKAGES.dependencies);
  assert.match(await readFile(path.join(root, 'src/Root.tsx'), 'utf8'), /from '.\/concepts\/registry'/);
  assert.ok(existsSync(path.join(root, 'src/brand/index.ts')));
  await writeFile(path.join(root, 'src/brand/index.ts'), 'export const Logo = 1;\n');
  await scaffoldConcept(ctx, CID);
  const index = path.join(root, 'src/concepts', CID, 'index.tsx');
  await writeFile(index, `${conceptIndexSource('concept-7f3a9c12')}// edited\n`);
  await scaffoldProject(ctx);
  await scaffoldConcept(ctx, CID);
  assert.equal(await readFile(path.join(root, 'src/brand/index.ts'), 'utf8'), 'export const Logo = 1;\n');
  const code = await readFile(index, 'utf8');
  assert.match(code, /\/\/ edited/);
  for (const field of ["id: 'concept-7f3a9c12'", 'fps: 30', 'width: 1080', 'height: 1920']) assert.ok(code.includes(field), field);
  const registry = path.join(root, 'src/concepts/registry.ts');
  assert.match(await readFile(registry, 'utf8'), new RegExp(CID));
  const before = (await stat(registry)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await writeRegistry(ctx);
  assert.equal((await stat(registry)).mtimeMs, before);
  assert.ok(existsSync(path.join(root, 'public/concepts', CID, 'media')));
});

test('SU38 a Concept id that is not a UUID is refused before any path is made', async () => {
  const ctx = await tempCtx();
  await assert.rejects(scaffoldConcept(ctx, '../escape'), (e: { status: number }) => e.status === 404);
  assert.throws(() => compositionIdFor(ctx, 'x'), (e: { status: number }) => e.status === 404);
  assert.equal(existsSync(path.join(ctx.dir, 'escape')), false);
});

test('archive moves the code and leaves an empty scaffold; removing a Concept clears code, media, archive and registry', async () => {
  const ctx = await tempCtx();
  await scaffoldProject(ctx);
  await scaffoldConcept(ctx, CID);
  const index = path.join(remotionDir(ctx), 'src/concepts', CID, 'index.tsx');
  await writeFile(index, 'changed');
  await archiveConceptCode(ctx, CID, 1);
  assert.equal(await readFile(path.join(remotionDir(ctx), 'archive', CID, 'round-1', 'index.tsx'), 'utf8'), 'changed');
  assert.match(await readFile(index, 'utf8'), /AbsoluteFill/);
  await removeConceptFromProject(ctx, CID);
  for (const gone of [`src/concepts/${CID}`, `public/concepts/${CID}`, `archive/${CID}`]) assert.equal(existsSync(path.join(remotionDir(ctx), gone)), false, gone);
  assert.doesNotMatch(await readFile(path.join(remotionDir(ctx), 'src/concepts/registry.ts'), 'utf8'), new RegExp(CID));
});

test('setup: one install for concurrent calls, a failure is reported and retried, a ready project is not reinstalled', async () => {
  const ctx = await tempCtx();
  let installs = 0;
  let fail = true;
  // Each install attempt signals `reached` once it reports progress, then waits on `release`.
  // Waiting on `reached` (not a fixed sleep) covers the time `ensureProject` spends scaffolding first.
  // The attempt also ends on abort, so `cancelSetup` in `finally` always settles it.
  let reached = deferred();
  let release = deferred();
  configureVideo({ installer: { install: async (_dir, onProgress, signal) => {
    installs++;
    onProgress(40);
    reached.resolve();
    await new Promise<void>((resolve, reject) => {
      release.promise.then(resolve);
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    if (fail) throw new Error('npm exited with code 1');
  } } });
  try {
    const a = ensureProject(ctx);
    const b = ensureProject(ctx);
    await reached.promise;
    assert.equal(setupView(ctx).status, 'running');
    assert.equal(setupView(ctx).percent, 40);
    release.resolve();
    assert.deepEqual(await Promise.all([a, b]), [false, false]);
    assert.equal(installs, 1);
    assert.deepEqual(setupView(ctx), { status: 'failed', error: 'Remotion setup failed: npm exited with code 1', percent: null });
    fail = false;
    reached = deferred();
    release = deferred();
    const c = ensureProject(ctx);
    await reached.promise;
    release.resolve();
    assert.equal(await c, true);
    assert.equal(setupView(ctx).status, 'ready');
    assert.equal(await ensureProject(ctx), true);
    assert.equal(installs, 2);
  } finally {
    // Ends the setup job even when an assertion fails, so it never leaks into later tests' contentJobs snapshots.
    await cancelSetup(ctx.buildingId);
  }
});

// ---- render queue ---------------------------------------------------------------------------------

function deferred() { let resolve!: () => void, reject!: (e: Error) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fakeQueue() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const queue = createRenderQueue({ timeoutMs: () => 1000, setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } });
  const runs: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const job = (id: string, buildingId = 'b1', conceptId = 'c1') => {
    const gate = deferred();
    gates.set(id, gate);
    return queue.enqueue({
      id, buildingId, conceptId, onStart() {}, onProgress() {},
      work: (signal) => { runs.push(id); signal.addEventListener('abort', () => gate.reject(new Error('aborted'))); return gate.promise; },
    });
  };
  return { queue, timers, runs, gates, job };
}
const tick = () => new Promise((r) => setImmediate(r));

test('SU39/SU40 one render at a time per Building, another Building in parallel', async () => {
  const q = fakeQueue();
  const first = q.job('r1');
  const second = q.job('r2');
  const other = q.job('r3', 'b2');
  await tick();
  assert.deepEqual(q.runs, ['r1', 'r3']);
  assert.equal(q.queue.position('r2'), 1);
  q.gates.get('r1')!.resolve();
  assert.deepEqual(await first, { status: 'done' });
  await tick();
  assert.deepEqual(q.runs, ['r1', 'r3', 'r2']);
  q.gates.get('r2')!.resolve(); q.gates.get('r3')!.resolve();
  assert.deepEqual([await second, await other], [{ status: 'done' }, { status: 'done' }]);
});

test('SU41/SU42 stopping a running render aborts it and starts the next; stopping a queued one never runs it', async () => {
  const q = fakeQueue();
  const first = q.job('r1');
  const second = q.job('r2');
  const third = q.job('r3');
  await tick();
  assert.equal(q.queue.stop('r2'), true);
  assert.deepEqual(await second, { status: 'stopped' });
  assert.equal(q.queue.stop('r1'), true);
  assert.deepEqual(await first, { status: 'stopped' });
  await tick();
  assert.deepEqual(q.runs, ['r1', 'r3']);
  assert.equal(q.queue.stop('nope'), false);
  q.queue.stopWhere('b1');
  assert.deepEqual(await third, { status: 'stopped' });
});

test('SU43/SU44 the timeout aborts and fails the render; a runner error fails it; the queue moves on', async () => {
  const q = fakeQueue();
  const first = q.job('r1');
  const second = q.job('r2');
  await tick();
  assert.equal(q.timers[0]!.ms, 1000);
  q.timers[0]!.fn();
  assert.deepEqual(await first, { status: 'failed', error: 'Render timed out after 1000 ms' } satisfies RenderOutcome);
  await tick();
  q.gates.get('r2')!.reject(new Error('Cannot find file'));
  assert.deepEqual(await second, { status: 'failed', error: 'Cannot find file' });
  assert.equal(timeoutMessage(30 * 60_000), 'Render timed out after 30 minutes');
});

test('SU45/SU47 content jobs begin, throttle progress, end, and a snapshot never lists an ended job', () => {
  assert.deepEqual(contentJobs.list(), [], 'an earlier test left a content job running');
  let clock = Date.parse('2026-01-01T00:00:00Z');
  setContentJobsClock(() => new Date(clock));
  const events: ContentJobEvent[] = [];
  const off = contentJobs.on((e) => events.push(e));
  const setup = contentJobs.begin({ buildingId: 'b', kind: 'remotion-setup', percent: null });
  const render = contentJobs.begin({ buildingId: 'b', kind: 'render', conceptId: 'c', renderId: 'r', percent: 0 });
  contentJobs.progress(render, { percent: 10 });
  contentJobs.progress(render, { percent: 20 });
  assert.equal(events.length, 2);
  clock += 1000;
  contentJobs.progress(render, { percent: 30 });
  assert.equal(events.at(-1)!.job.percent, 30);
  contentJobs.end(render, 'complete');
  assert.equal(events.at(-1)!.job.status, 'complete');
  assert.deepEqual(contentJobs.list().map((j) => j.id), [setup]);
  contentJobs.end(setup, 'failed', 'boom');
  assert.equal(events.at(-1)!.job.error, 'boom');
  assert.deepEqual(contentJobs.list(), []);
  off();
  setContentJobsClock(() => new Date());
});

test('SU46/SU51 the render output path', async () => {
  const ctx = await tempCtx();
  assert.equal(path.relative(ctx.dir, renderFile(ctx, CID, 2, 3)), path.join('concepts', CID, 'video', 'round-2', 'render-3.mp4'));
});

test('render progress is read from the CLI output', () => {
  assert.deepEqual(parseRenderProgress('Rendered 12/300\nRendered 581/1260'), { frame: 581, totalFrames: 1260 });
  assert.equal(parseRenderProgress('Bundling'), null);
  assert.equal(parseRenderProgress('10/0'), null);
});

// ---- tab and instructions -------------------------------------------------------------------------

test('SU48 the video tab: asset video and its three tools; the script tab unchanged', () => {
  assert.equal(STUDIO_TABS.video!.assetKind, 'video');
  assert.deepEqual(STUDIO_TABS.video!.tools, ['get_concept', 'get_performance', 'get_reference_content', 'set_checklist', 'report_speaking_rate', 'list_media']);
  assert.ok(!STUDIO_TABS.video!.tools.includes('render_video'));
  assert.deepEqual(STUDIO_TABS.script!.tools, ['save_draft', 'get_concept', 'get_performance', 'get_reference_content']);
});

test('SU49/SU50 video instructions carry the protocol and never the writing skill', () => {
  const text = videoSystemPrompt({
    concept: { id: CID, title: 'Launch', brief: 'Brief', posts: [{ platform: 'instagram', format: 'reel', scheduledAt: '2026-11-03T09:00:00.000Z' } as never] },
    buildingDir: '/data/b1', scriptFile: `/data/b1/concepts/${CID}/script/script.md`, compositionId: 'concept-7f3a9c12',
  });
  for (const needle of [
    `/data/b1/concepts/${CID}/script/script.md`, 'Instagram, reel', '/data/b1/knowledge', 'you may edit these files', 'colours.json', `public/concepts/${CID}/media`, 'list_media',
    'set_checklist', 'Do not start building the video yet', `src/concepts/${CID}/`, 'src/brand/', 'never break another Concept', 'live in Remotion Studio', 'Finalize', '1080x1920 at 30 fps', '1080x1080', '1920x1080', 'concept-7f3a9c12',
  ]) assert.ok(text.includes(needle), needle);
  assert.doesNotMatch(text, /Writing skill|human-content-writing|render_video/);
  assert.doesNotMatch(text, /Starting point/);
  assert.match(videoSystemPrompt({ concept: { id: CID, title: 'T', brief: '', posts: [] }, buildingDir: '/d', scriptFile: '/s', compositionId: 'c', reopened: true }), /Starting point/);
});

test('WU22 drift: the shared rename case table holds for the server rule', async () => {
  const table = JSON.parse(await readFile(new URL('./fixtures/mediaRenameCases.json', import.meta.url), 'utf8')) as { others: string[]; cases: { base: string; valid: boolean }[] };
  for (const c of table.cases) assert.equal(status(() => parseRename(`${c.base}.png`, 'current.png', table.others)) === 'ok', c.valid, JSON.stringify(c.base));
});

// ---- the real tool wrappers, against stand-in executables (never real npm or Remotion) ----------------------

test('the Remotion CLI wrappers: ffprobe, poster frame, render with progress, and a failure carries stderr', async () => {
  const { remotionProber, remotionCliRenderer, npmInstaller } = await import('../src/content/videoDeps.ts');
  const { chmod } = await import('node:fs/promises');
  const ctx = await tempCtx();
  const dir = path.join(ctx.dir, 'remotion');
  const bin = path.join(dir, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'remotion'), `#!/bin/sh
case "$1" in
  ffprobe) echo '{"format":{"duration":"2.5"},"streams":[{"codec_type":"audio"},{"codec_type":"video","width":1080,"height":1920}]}';;
  ffmpeg) for last; do :; done; echo jpg > "$last";;
  render) echo "Rendered 5/10"; echo "Rendered 10/10"; echo mp4 > "$4";;
  *) echo "unknown command $1" >&2; exit 3;;
esac
`);
  await chmod(path.join(bin, 'remotion'), 0o755);
  assert.deepEqual(await remotionProber.probe(dir, '/x.mp4', 'video'), { durationMs: 2500, width: 1080, height: 1920 });
  const out = path.join(ctx.dir, 'thumb.jpg');
  await remotionProber.thumbnail(dir, '/x.mp4', out);
  assert.equal(await readFile(out, 'utf8'), 'jpg\n');
  const progress: number[][] = [];
  const output = path.join(ctx.dir, 'out.mp4');
  await remotionCliRenderer.render({ dir, compositionId: 'concept-x', output, signal: new AbortController().signal, onProgress: (f, t) => progress.push([f, t]) });
  assert.equal(await readFile(output, 'utf8'), 'mp4\n');
  assert.deepEqual(progress.at(-1), [10, 10]);
  await assert.rejects(remotionProber.probe(path.join(ctx.dir, 'nowhere'), '/x', 'video'));
  const npmDir = path.join(ctx.dir, 'npm-bin');
  await mkdir(npmDir, { recursive: true });
  await writeFile(path.join(npmDir, 'npm'), '#!/bin/sh\nif [ -f fail ]; then echo "getaddrinfo ENOTFOUND registry.npmjs.org" >&2; exit 1; fi\ntouch installed\n');
  await chmod(path.join(npmDir, 'npm'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${npmDir}${path.delimiter}${oldPath}`;
  try {
    const percents: (number | null)[] = [];
    await npmInstaller.install(dir, (p) => percents.push(p), new AbortController().signal);
    assert.ok(existsSync(path.join(dir, 'installed')));
    assert.deepEqual(percents, [null]);
    await writeFile(path.join(dir, 'fail'), '');
    await assert.rejects(npmInstaller.install(dir, () => undefined, new AbortController().signal), /npm exited with code 1: getaddrinfo ENOTFOUND/);
  } finally { process.env.PATH = oldPath; }
});

test('the default timer runs and can be cancelled', async () => {
  const { videoDeps } = await import('../src/content/videoDeps.ts');
  let ran = 0;
  videoDeps().setTimer(() => { ran++; }, 1);
  const cancel = videoDeps().setTimer(() => { ran += 10; }, 1);
  cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran, 1);
});
