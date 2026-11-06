import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import type { ContentCtx } from '../src/content/context.ts';
import { openContentDb } from '../src/content/db.ts';
import { NO_COMPLETE_SET_REASON, parseAltText, parseImageSize, RENDER_RUNNING_REASON, requireOwnIds } from '../src/content/imageRules.ts';
import * as limits from '../src/content/limits.ts';
import { isWrittenKind } from '../src/content/retroRules.ts';
import { registrySource, thumbnailStills, thumbPrefixFor, writeRegistry } from '../src/content/remotionProject.ts';
import { STUDIO_TABS, STUDIO_TOOLS, studioTabFor, styleSectionFor } from '../src/content/studioTabs.ts';
import { thumbnailSystemPrompt } from '../src/content/thumbnailInstructions.ts';
import {
  finalizeThumbnailBlocker, NO_THUMBNAIL_REASON, parseChosenThumbnail, parseThumbnailFileName, parseThumbnailIds, THUMBNAIL_SIZE, thumbnailCallTimeoutMessage, thumbnailFileName, thumbnailTimeoutMessage,
} from '../src/content/thumbnailRules.ts';
import { videoSystemPrompt } from '../src/content/videoInstructions.ts';

/** The Thumbnail tab's pure rules: size, the render_thumbnails input, file names, Finalize and the pick, ids, the registry, the tab and the instructions; and the migration that adds the asset. */

const roots: string[] = [];
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

async function tempCtx(): Promise<ContentCtx> {
  const dir = await mkdtemp(path.join(tmpdir(), 'thumbs-pure-'));
  roots.push(dir);
  return { db: openContentDb(':memory:'), buildingId: `b-${path.basename(dir)}`, dir, now: () => Date.now(), timezone: () => 'UTC', exclusive: (w) => w() };
}

/** The field of a refusal, or 'ok'. */
const refusal = (fn: () => unknown): { field?: string; message: string } | 'ok' => {
  try { fn(); return 'ok'; } catch (e) { const x = e as { field?: string; message: string }; return { field: x.field, message: x.message }; }
};
const fieldOf = (fn: () => unknown) => { const r = refusal(fn); return r === 'ok' ? 'ok' : r.field; };

const CID = '7f3a9c12-1111-4111-8111-111111111111';
const OTHER = '7f3a9c12-9999-4999-8999-999999999999';

test('TU05/TU07 the default canvas is 1280x720; a side left out falls back on its own', () => {
  assert.deepEqual(THUMBNAIL_SIZE, { width: 1280, height: 720 });
  assert.deepEqual(parseImageSize({}, THUMBNAIL_SIZE), { width: 1280, height: 720 });
  assert.deepEqual(parseImageSize({ width: 1920 }, THUMBNAIL_SIZE), { width: 1920, height: 720 });
  assert.deepEqual(parseImageSize({ height: 1080 }, THUMBNAIL_SIZE), { width: 1280, height: 1080 });
});

test('TU06 sizes: whole pixels from 320 to 4,000; anything else is a 400 naming the side', () => {
  assert.deepEqual(parseImageSize({ width: 320, height: 4000 }, THUMBNAIL_SIZE), { width: 320, height: 4000 });
  for (const value of [319, 4001, 1280.5, '1280', -1, Number.NaN, null, 2 ** 53, 1e10]) {
    assert.equal(fieldOf(() => parseImageSize({ width: value }, THUMBNAIL_SIZE)), 'width', String(value));
    assert.equal(fieldOf(() => parseImageSize({ height: value }, THUMBNAIL_SIZE)), 'height', String(value));
  }
});

test('TU08 ids: 1 to 5 distinct non-empty strings', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `thumb-x-${i}`);
  assert.deepEqual(parseThumbnailIds(ids(1)), ids(1));
  assert.deepEqual(parseThumbnailIds(ids(5)), ids(5));
  for (const bad of [[], ids(6), ['a', 'a'], 'thumb-x-0', { a: 1 }, null, [''], [1]]) assert.equal(fieldOf(() => parseThumbnailIds(bad)), 'compositionIds', JSON.stringify(bad));
  const six = refusal(() => parseThumbnailIds(ids(6)));
  assert.ok(six !== 'ok' && /1 to 5 ids; it has 6/.test(six.message));
});

test('TU09 only the Concept\'s own thumbnail stills, case-sensitive; the refusal names the id', () => {
  const own = ['thumb-7f3a9c12-bold', 'thumb-7f3a9c12-calm'];
  assert.equal(refusal(() => requireOwnIds([own[1]!], own, "this Concept's thumbnail stills")), 'ok');
  for (const id of ['THUMB-7f3a9c12-bold', 'thumb-aaaaaaaa-bold', 'still-7f3a9c12-slide-01', 'concept-7f3a9c12']) {
    const r = refusal(() => requireOwnIds([id], own, "this Concept's thumbnail stills"));
    assert.ok(r !== 'ok' && r.field === 'compositionIds' && r.message.includes(`"${id}" is not one of this Concept's thumbnail stills`), id);
  }
  const none = refusal(() => requireOwnIds(['x'], [], "this Concept's thumbnail stills"));
  assert.ok(none !== 'ok' && /none exist yet/.test(none.message));
});

test('TU10 file names: thumb-01.png to thumb-05.png only', () => {
  assert.equal(thumbnailFileName(2), 'thumb-02.png');
  for (let i = 1; i <= 5; i++) assert.equal(parseThumbnailFileName(`thumb-0${i}.png`), i);
  for (const name of ['thumb-00.png', 'thumb-06.png', 'thumb-1.png', 'THUMB-01.png', 'thumb-01.PNG', '../thumb-01.png', 'thumb-01.png/x', 'image-01.png']) assert.equal(parseThumbnailFileName(name), null, name);
});

test('TU11 alt text keeps the images\' rule: 20 lines of 1,000 code points, trimmed', () => {
  assert.equal(parseAltText(' one \r\n two '), 'one\ntwo');
  assert.equal(refusal(() => parseAltText(Array(20).fill('x').join('\n'))), 'ok');
  assert.equal(fieldOf(() => parseAltText(Array(21).fill('x').join('\n'))), 'text');
  assert.equal(refusal(() => parseAltText('😀'.repeat(1000))), 'ok');
  const long = refusal(() => parseAltText(`ok\n${'a'.repeat(1001)}`));
  assert.ok(long !== 'ok' && /Line 2/.test(long.message));
  for (const bad of ['', '   ', 5]) assert.equal(fieldOf(() => parseAltText(bad)), 'text');
});

test('TU12 timeout messages name the thumbnail and the tool', () => {
  assert.equal(thumbnailTimeoutMessage(2, 'thumb-a-b', 60_000), 'thumbnail 2 (thumb-a-b) timed out after 60 seconds');
  assert.equal(thumbnailCallTimeoutMessage(2, 'thumb-a-b', 300_000), 'the render_thumbnails call ran over 5 minutes while rendering thumbnail 2 (thumb-a-b)');
});

test('TU13 Finalize blocker: no call, a running or queued call, a failed or stopped call, and a finished one', () => {
  assert.equal(finalizeThumbnailBlocker('none', 0), NO_THUMBNAIL_REASON);
  assert.equal(finalizeThumbnailBlocker('queued', 3), RENDER_RUNNING_REASON);
  assert.equal(finalizeThumbnailBlocker('running', 3), RENDER_RUNNING_REASON);
  assert.equal(finalizeThumbnailBlocker('failed', 3), NO_COMPLETE_SET_REASON);
  assert.equal(finalizeThumbnailBlocker('stopped', 3), NO_COMPLETE_SET_REASON);
  assert.equal(finalizeThumbnailBlocker('done', 1), null);
  assert.equal(finalizeThumbnailBlocker('done', 5), null);
});

test('TU14 the pick: a name from the call; left out only with one thumbnail; never trimmed', () => {
  assert.equal(parseChosenThumbnail('thumb-02.png', 3), 'thumb-02.png');
  assert.equal(parseChosenThumbnail(undefined, 1), 'thumb-01.png');
  for (const [value, count] of [[undefined, 2], ['thumb-04.png', 3], ['thumb-2.png', 3], [' thumb-02.png', 3], [2, 3], [null, 3], [[], 3], ['../x', 3]] as const) {
    assert.equal(fieldOf(() => parseChosenThumbnail(value, count)), 'file', JSON.stringify(value));
  }
});

test('TU15 ids: thumb-<8 hex of the Concept>, kept once assigned, longer on a clash', async () => {
  const ctx = await tempCtx();
  assert.equal(thumbPrefixFor(ctx, CID), 'thumb-7f3a9c12');
  assert.equal(thumbPrefixFor(ctx, CID), 'thumb-7f3a9c12');
  assert.equal(thumbPrefixFor(ctx, OTHER), 'thumb-7f3a9c129999');
  assert.equal(thumbPrefixFor(ctx, OTHER), 'thumb-7f3a9c129999', 'stable on the next call');
});

test('TU16 thumbnail stills follow the still name rule, sorted', async () => {
  const ctx = await tempCtx();
  const dir = path.join(ctx.dir, 'remotion', 'src', 'concepts', CID, 'thumbnail');
  await mkdir(dir, { recursive: true });
  const forty = 'a'.repeat(40);
  for (const f of ['b.tsx', `${forty}.tsx`, `${'a'.repeat(41)}.tsx`, 'Bad_Name.tsx', 'x.ts', 'a.tsx']) await writeFile(path.join(dir, f), '');
  assert.deepEqual((await thumbnailStills(ctx, CID)).map((s) => s.name), ['a', forty, 'b']);
  assert.deepEqual((await thumbnailStills(ctx, OTHER)), []);
});

test('TU17/TU18 the registry lists thumbnails after videos and image stills; without them the text is unchanged and an unchanged registry is not rewritten', async () => {
  const before = `// Generated by Agent Visual OS. Do not edit: it is rewritten whenever a Concept's video folder is added or removed.\nimport type { ConceptComposition } from './types';\nimport { composition as c0 } from './${CID}/index';\n\nexport const compositions: ConceptComposition[] = [c0];\n`;
  assert.equal(registrySource([CID], [], []), before);
  const pid = 'a1b2c3d4-2222-4222-8222-222222222222';
  const both = registrySource([CID], [{ conceptId: CID, postId: pid, name: 's', id: 'still-a1b2c3d4-s' }], [{ conceptId: CID, name: 'bold', id: 'thumb-7f3a9c12-bold' }]);
  assert.match(both, new RegExp(`import \\{ still as t0 \\} from './${CID}/thumbnail/bold';`));
  assert.match(both, /= \[c0, still\('still-a1b2c3d4-s', s0\), still\('thumb-7f3a9c12-bold', t0\)\];/);
  const onlyThumbs = registrySource([], [], [{ conceptId: CID, name: 'bold', id: 'thumb-7f3a9c12-bold' }]);
  assert.match(onlyThumbs, /const still = /, 'the still helper is there for thumbnails alone');

  const ctx = await tempCtx();
  const dir = path.join(ctx.dir, 'remotion', 'src', 'concepts', CID, 'thumbnail');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'bold.tsx'), '');
  await writeRegistry(ctx);
  const file = path.join(ctx.dir, 'remotion', 'src', 'concepts', 'registry.ts');
  const text = await readFile(file, 'utf8');
  assert.match(text, /still\('thumb-7f3a9c12-bold', t0\)/);
  const mtime = (await stat(file)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await writeRegistry(ctx);
  assert.equal(await readFile(file, 'utf8'), text);
  assert.equal((await stat(file)).mtimeMs, mtime);
});

test('TU22/TU23 the thumbnail tab: Concept-level, its five tools, the General style section', () => {
  const tab = STUDIO_TABS.thumbnail!;
  assert.deepEqual([tab.tab, tab.assetKind, [...tab.platforms]], ['thumbnail', 'thumbnail', []]);
  assert.deepEqual([...tab.tools], ['get_concept', 'get_performance', 'get_reference_content', 'save_draft', 'list_media', 'render_thumbnails']);
  assert.equal(studioTabFor('thumbnail', null)?.tab, 'thumbnail');
  assert.equal(studioTabFor('video', null)?.tab, 'video');
  assert.equal(studioTabFor('thumbnail', 'linkedin'), undefined);
  assert.equal(styleSectionFor(tab, null), 'General');
  assert.equal(STUDIO_TOOLS.renderThumbnails, 'render_thumbnails');
});

test('TU24 a thumbnail starts no writing-style retro', () => {
  assert.equal(isWrittenKind('thumbnail'), false);
});

const PROMPT_INPUT = {
  concept: {
    id: CID, title: 'Launch day', brief: 'Why it matters',
    posts: [
      { platform: 'linkedin', format: 'video', scheduledAt: '2026-11-03T09:00:00.000Z' },
      { platform: 'instagram', format: 'reel', scheduledAt: '2026-11-04T09:00:00.000Z' },
      { platform: 'x', format: 'text', scheduledAt: '2026-11-05T09:00:00.000Z' },
    ],
  } as never,
  buildingDir: '/data/b', size: THUMBNAIL_SIZE, stillPrefix: 'thumb-7f3a9c12', scriptFile: '/data/b/concepts/c/script/script.md',
  video: { file: '/data/b/concepts/c/video/round-1/render-1.mp4', durationMs: 31_500, size: 2_048_000 },
  brandFiles: ['logo.svg'], colours: [{ name: 'Ink', hex: '#112233' }], skillText: 'SKILL BODY', performance: '## Targets and Insights\n\nTARGETS',
};

test('TU25 the instructions: Concept, video posts, script, video, brand, style, skill, targets, variants and the rules', () => {
  const prompt = thumbnailSystemPrompt(PROMPT_INPUT);
  for (const part of [
    'Launch day', 'Why it matters', '- LinkedIn, video, scheduled 2026-11-03T09:00:00.000Z', '- Instagram, reel, scheduled 2026-11-04T09:00:00.000Z',
    '/data/b/concepts/c/script/script.md', '/data/b/concepts/c/video/round-1/render-1.mp4', '31.5 seconds long', '2,048,000 bytes',
    '/data/b/knowledge', '- logo.svg', 'Ink: #112233', '/data/b/knowledge/writing-style.md', 'its General section', '## Writing skill', 'SKILL BODY',
    '## Targets and Insights', 'TARGETS', 'Offer 2 to 4 variants', `src/concepts/${CID}/thumbnail/`, 'export const still', '"thumb-7f3a9c12-<file name without .tsx>"',
    '1280x720', 'from 320 to 4,000 px', 'Render only with `render_thumbnails`', '`save_draft`', `Never edit the video's code in src/concepts/${CID}/`, `src/concepts/${CID}/images/`, 'Make no network requests',
  ]) assert.ok(prompt.includes(part), part);
  assert.ok(!prompt.includes('X (Twitter), text'), 'only video posts are listed');
  const bare = thumbnailSystemPrompt({ ...PROMPT_INPUT, scriptFile: null, video: null, skillText: null, brandFiles: [], colours: [] });
  for (const part of ['No finalized script yet.', 'No finalized video yet.', '(none uploaded yet)', '(none recorded yet)']) assert.ok(bare.includes(part), part);
  assert.doesNotMatch(bare, /Writing skill/);
});

test('TU26/TU27 a reopened prompt continues from the kept code; the video prompt keeps off thumbnail/', () => {
  assert.match(thumbnailSystemPrompt({ ...PROMPT_INPUT, reopened: true }), /reopened this thumbnail[\s\S]*continue from it/);
  assert.doesNotMatch(thumbnailSystemPrompt(PROMPT_INPUT), /reopened/);
  assert.match(videoSystemPrompt({ concept: PROMPT_INPUT.concept, buildingDir: '/data/b', scriptFile: '/s.md', compositionId: 'concept-x' }), /except its images\/ and thumbnail\/ folders/);
});

test('TU28 the limits: 5 thumbnails per call; sides and timeouts shared with images', () => {
  assert.equal(limits.THUMBNAILS_PER_CALL_MAX, 5);
  assert.deepEqual([limits.IMAGE_SIZE_MIN, limits.IMAGE_SIZE_MAX], [320, 4000]);
  assert.deepEqual([limits.STILL_TIMEOUT_MS, limits.IMAGES_CALL_TIMEOUT_MS], [60_000, 300_000]);
});

// ---- the migration ---------------------------------------------------------------------------------

/** A database as an older daemon left it: concepts, posts and assets with no thumbnail. */
async function oldDb(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'thumbs-migrate-'));
  roots.push(dir);
  const file = path.join(dir, 'content.sqlite');
  openContentDb(file).close();
  const db = new Database(file);
  // Undo what opening just added, so the seeded rows look like a database from before thumbnails.
  db.prepare("DELETE FROM assets WHERE kind = 'thumbnail'").run();
  const concept = (id: string) => db.prepare('INSERT INTO concepts (id, title, createdAt, updatedAt, seq) VALUES (?, ?, 1, 1, 1)').run(id, id);
  const post = (id: string, cid: string, format: string, status = 'draft', note: string | null = null) =>
    db.prepare('INSERT INTO posts (id, conceptId, platform, format, scheduledAt, status, note, createdAt) VALUES (?, ?, ?, ?, 1, ?, ?, 1)').run(id, cid, format === 'reel' ? 'instagram' : 'linkedin', format, status, note);
  const asset = (cid: string, kind: string, state = 'empty') => db.prepare('INSERT INTO assets (id, conceptId, postId, kind, state) VALUES (?, ?, NULL, ?, ?)').run(`${cid}-${kind}`, cid, kind, state);
  concept('video-c'); post('p1', 'video-c', 'video', 'published'); post('p2', 'video-c', 'reel', 'finalized', 'kept note'); asset('video-c', 'video', 'finalized');
  concept('text-c'); post('p3', 'text-c', 'text');
  concept('has-c'); post('p4', 'has-c', 'video'); asset('has-c', 'thumbnail', 'drafting');
  db.close();
  return file;
}

const thumbs = (file: string) => {
  const db = new Database(file);
  try { return db.prepare("SELECT conceptId, state, postId FROM assets WHERE kind = 'thumbnail' ORDER BY conceptId").all() as { conceptId: string; state: string; postId: string | null }[]; } finally { db.close(); }
};

test('TI05 the migration adds one empty thumbnail to each video Concept without one, once, and leaves post statuses alone', async () => {
  const file = await oldDb();
  assert.deepEqual(thumbs(file).map((r) => r.conceptId), ['has-c']);
  openContentDb(file).close();
  assert.deepEqual(thumbs(file), [{ conceptId: 'has-c', state: 'drafting', postId: null }, { conceptId: 'video-c', state: 'empty', postId: null }]);
  openContentDb(file).close();
  assert.equal(thumbs(file).length, 2, 'opening again adds nothing');
  const db = new Database(file);
  assert.deepEqual(db.prepare('SELECT id, status, note FROM posts ORDER BY id').all(), [
    { id: 'p1', status: 'published', note: null }, { id: 'p2', status: 'finalized', note: 'kept note' }, { id: 'p3', status: 'draft', note: null }, { id: 'p4', status: 'draft', note: null },
  ]);
  db.close();
});

test('TI06 the migration does nothing on a fresh database', () => {
  const db = openContentDb(':memory:');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n, 0);
  db.close();
});
