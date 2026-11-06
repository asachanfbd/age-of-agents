import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ContentCtx } from '../src/content/context.ts';
import { openContentDb } from '../src/content/db.ts';
import {
  callTimeoutMessage, defaultImageSize, finalizeImagesBlocker, IMAGE_SIZES, imageFileName, imageTimeoutMessage, parseAltText, parseCompositionIds, parseImageFileName, parseImageSize, requireOwnIds,
} from '../src/content/imageRules.ts';
import type { ImageCallState } from '../src/content/imageRules.ts';
import { countRuleText, imagesSystemPrompt } from '../src/content/imageInstructions.ts';
import { imageRef } from '../src/content/imageStudio.ts';
import { contentJobs } from '../src/content/jobs.ts';
import type { ContentJobEvent } from '../src/content/jobs.ts';
import { postStills, registrySource, stillPrefixFor, STILL_NAME, writeRegistry } from '../src/content/remotionProject.ts';
import { imageRange, FORMATS_BY_PLATFORM } from '../src/content/rules.ts';
import type { Platform } from '../src/content/rules.ts';
import { STUDIO_TABS, studioTabFor } from '../src/content/studioTabs.ts';

/** The Images tab's pure rules: sizes, the render_images input, alt text, file names, Finalize, still ids, the registry and the instructions. */

const roots: string[] = [];
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

async function tempCtx(): Promise<ContentCtx> {
  const dir = await mkdtemp(path.join(tmpdir(), 'images-pure-'));
  roots.push(dir);
  return { db: openContentDb(':memory:'), buildingId: `b-${path.basename(dir)}`, dir, now: () => Date.now(), timezone: () => 'UTC', exclusive: (w) => w() };
}

const fixture = JSON.parse(readFileSync(new URL('../../web/tests/fixtures/contentImageCases.json', import.meta.url), 'utf8')) as {
  sizes: { platform: Platform; format: string; size: { width: number; height: number } }[];
  noSize: { platform: Platform; format: string }[];
  sizeBounds: { min: number; max: number };
  finalize: { platform: Platform; format: string; state: ImageCallState; count: number; reason: string | null }[];
};

/** The status and field of a refusal, or 'ok'. */
const refusal = (fn: () => unknown): { status: number; field?: string; message: string } | 'ok' => {
  try { fn(); return 'ok'; } catch (e) { const x = e as { status: number; field?: string; message: string }; return { status: x.status, field: x.field, message: x.message }; }
};

const CID = '7f3a9c12-1111-4111-8111-111111111111';
const PID = 'a1b2c3d4-2222-4222-8222-222222222222';

test('U01/U02/U03 the size table: seven image pairs with their default, nothing for other formats, pinned to the shared fixture', () => {
  for (const { platform, format, size } of fixture.sizes) assert.deepEqual(defaultImageSize(platform, format), size, `${platform} ${format}`);
  const tablePairs = Object.entries(IMAGE_SIZES).flatMap(([p, formats]) => Object.keys(formats!).map((f) => `${p}/${f}`)).sort();
  assert.deepEqual(tablePairs, fixture.sizes.map((s) => `${s.platform}/${s.format}`).sort());
  for (const { platform, format } of fixture.noSize) assert.equal(defaultImageSize(platform, format), null, `${platform} ${format}`);
  // Every image or carousel format of every platform has a default.
  for (const [platform, formats] of Object.entries(FORMATS_BY_PLATFORM)) for (const format of formats) assert.equal(defaultImageSize(platform as Platform, format) !== null, imageRange(platform as Platform, format) !== null, `${platform} ${format}`);
});

test('U04 size bounds: 320 and 4,000 accepted; 319, 4,001, 0 and -1080 refused with the field and the range', () => {
  const fallback = { width: 1080, height: 1350 };
  assert.deepEqual(parseImageSize({ width: fixture.sizeBounds.min, height: fixture.sizeBounds.max }, fallback), { width: 320, height: 4000 });
  for (const [field, value] of [['width', 319], ['width', 4001], ['height', 0], ['height', -1080]] as const) {
    const r = refusal(() => parseImageSize({ [field]: value }, fallback));
    assert.notEqual(r, 'ok');
    if (r !== 'ok') { assert.equal(r.status, 400); assert.equal(r.field, field); assert.match(r.message, /320 to 4,000/); }
  }
});

test('U05 size types: fractions, strings, booleans, null, NaN, Infinity and huge values refused; each side falls back on its own', () => {
  const fallback = { width: 1080, height: 1350 };
  for (const value of [1080.5, '1080', true, null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 1e309]) {
    const r = refusal(() => parseImageSize({ width: value }, fallback));
    assert.ok(r !== 'ok' && r.status === 400 && r.field === 'width', String(value));
  }
  assert.deepEqual(parseImageSize({ width: 900 }, fallback), { width: 900, height: 1350 });
  assert.deepEqual(parseImageSize({ height: 900 }, fallback), { width: 1080, height: 900 });
  assert.deepEqual(parseImageSize({}, fallback), fallback);
});

test('U06 compositionIds: 1 to 20 distinct non-empty strings, else 400 field compositionIds', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `still-a-${i}`);
  assert.deepEqual(parseCompositionIds(ids(1)), ids(1));
  assert.deepEqual(parseCompositionIds(ids(20)), ids(20));
  for (const bad of [undefined, 'x', {}, [], ids(21), [5], [''], [null], ['a', 'a']]) {
    const r = refusal(() => parseCompositionIds(bad));
    assert.ok(r !== 'ok' && r.status === 400 && r.field === 'compositionIds', JSON.stringify(bad));
  }
  const dup = refusal(() => parseCompositionIds(['a', 'a']));
  assert.ok(dup !== 'ok' && /"a" is listed twice/.test(dup.message));
});

test('U07 ownership: another post, the video, an unknown id and a case variant are refused naming the id', () => {
  const own = ['still-1a2b3c4d-slide-01', 'still-1a2b3c4d-slide-02'];
  assert.equal(refusal(() => requireOwnIds([own[1]!, own[0]!], own)), 'ok');
  for (const id of ['still-99999999-slide-01', 'concept-7f3a9c12', 'nope', 'still-1a2b3c4d-Slide-01']) {
    const r = refusal(() => requireOwnIds([own[0]!, id], own));
    assert.ok(r !== 'ok' && r.status === 400 && r.field === 'compositionIds' && r.message.includes(`"${id}"`), id);
  }
  const none = refusal(() => requireOwnIds(['x'], []));
  assert.ok(none !== 'ok' && /none exist yet/.test(none.message));
});

test('U08/U09/U10 Finalize: the count per format and the newest call state decide; the reasons read as in the mockup', () => {
  for (const c of fixture.finalize) assert.equal(finalizeImagesBlocker(c.platform, c.format, c.state, c.count), c.reason, `${c.platform} ${c.format} ${c.state} ${c.count}`);
  assert.equal(finalizeImagesBlocker('linkedin', 'text', 'done', 1), 'This post takes no images.');
});

test('U11 output paths and file names: round folders, zero-padded so image 10 sorts after image 9', () => {
  assert.equal(imageRef(PID, 3, imageFileName(1)), `posts/${PID}/images/round-3/image-01.png`);
  const names = [10, 9, 2, 1, 20].map(imageFileName);
  assert.deepEqual([...names].sort(), ['image-01.png', 'image-02.png', 'image-09.png', 'image-10.png', 'image-20.png']);
});

test('U12 file-name safety: only image-01.png to image-20.png parse; traversal and other names are null', () => {
  assert.equal(parseImageFileName('image-01.png'), 1);
  assert.equal(parseImageFileName('image-20.png'), 20);
  for (const name of ['..', '../x.png', '/etc/passwd', 'a/b.png', 'a\\b.png', '%2e%2e', 'image-01.png\u0000', 'image-01.jpg', '', 'image-00.png', 'image-21.png', 'image-1.png', 'IMAGE-01.PNG', 'image-01.png/..']) {
    assert.equal(parseImageFileName(name), null, JSON.stringify(name));
  }
});

test('U13 alt text: lines split on \\n and \\r\\n, trimmed; 1,000 code points per line; 20 lines; empty refused', () => {
  assert.equal(parseAltText('  one  \r\n two \nthree '), 'one\ntwo\nthree');
  assert.equal(parseAltText('a'.repeat(1000)), 'a'.repeat(1000));
  const over = refusal(() => parseAltText(`first\n${'a'.repeat(1001)}`));
  assert.ok(over !== 'ok' && over.status === 400 && over.field === 'text' && /Line 2 .* 1,001 characters; the limit is 1,000/.test(over.message));
  const emoji = refusal(() => parseAltText(`${'a'.repeat(999)}🏘️`));
  assert.ok(emoji !== 'ok' && emoji.status === 400, '999 characters plus a 2 code point emoji is over');
  for (const empty of ['', '   ', '\n\n', 5]) assert.notEqual(refusal(() => parseAltText(empty)), 'ok', JSON.stringify(empty));
  assert.equal(parseAltText(Array(20).fill('x').join('\n')).split('\n').length, 20);
  const many = refusal(() => parseAltText(Array(21).fill('x').join('\n')));
  assert.ok(many !== 'ok' && /21 lines; at most 20/.test(many.message));
});

test('U14 timeout messages name the image and its id', () => {
  assert.equal(imageTimeoutMessage(5, 'still-a-five', 60_000), 'image 5 (still-a-five) timed out after 60 seconds');
  assert.equal(callTimeoutMessage(7, 'still-a-seven', 300_000), 'the render_images call ran over 5 minutes while rendering image 7 (still-a-seven)');
  assert.equal(imageTimeoutMessage(1, 'x', 40), 'image 1 (x) timed out after 40 ms');
});

test('U15 the registry lists stills as one-frame compositions after the videos; with none its text is unchanged', async () => {
  const before = `// Generated by Agent Visual OS. Do not edit: it is rewritten whenever a Concept's video folder is added or removed.\nimport type { ConceptComposition } from './types';\nimport { composition as c0 } from './${CID}/index';\n\nexport const compositions: ConceptComposition[] = [c0];\n`;
  assert.equal(registrySource([CID]), before, 'regression: no stills, same text as before the Images tab');
  assert.equal(registrySource([CID], []), before);
  const withStills = registrySource([CID], [{ conceptId: CID, postId: PID, name: 'slide-01', id: 'still-a1b2c3d4-slide-01' }, { conceptId: CID, postId: PID, name: 'slide-02', id: 'still-a1b2c3d4-slide-02' }]);
  assert.match(withStills, new RegExp(`import \\{ still as s0 \\} from './${CID}/images/${PID}/slide-01';`));
  assert.match(withStills, /durationInFrames: 1/);
  assert.match(withStills, /= \[c0, still\('still-a1b2c3d4-slide-01', s0\), still\('still-a1b2c3d4-slide-02', s1\)\];/);
  const ctx = await tempCtx();
  const dir = path.join(ctx.dir, 'remotion', 'src', 'concepts', CID, 'images', PID);
  await mkdir(dir, { recursive: true });
  for (const f of ['slide-02.tsx', 'slide-01.tsx', 'Bad.tsx', 'notes.md', '-x.tsx']) await writeFile(path.join(dir, f), '');
  await mkdir(path.join(ctx.dir, 'remotion', 'src', 'concepts', CID, 'images', 'not-a-post'), { recursive: true });
  await writeRegistry(ctx);
  const written = await readFile(path.join(ctx.dir, 'remotion', 'src', 'concepts', 'registry.ts'), 'utf8');
  assert.match(written, /still\('still-a1b2c3d4-slide-01', s0\), still\('still-a1b2c3d4-slide-02', s1\)/);
  assert.doesNotMatch(written, /Bad|notes|-x|not-a-post|c0/);
});

test('U16 still ids: still-<8 hex of the post> plus the file name, kept once assigned, longer on a collision', async () => {
  const ctx = await tempCtx();
  assert.equal(stillPrefixFor(ctx, PID), 'still-a1b2c3d4');
  assert.equal(stillPrefixFor(ctx, PID), 'still-a1b2c3d4');
  assert.equal(stillPrefixFor(ctx, 'a1b2c3d4-3333-4333-8333-333333333333'), 'still-a1b2c3d43333');
  assert.ok(STILL_NAME.test('slide-01') && !STILL_NAME.test('Slide-01') && !STILL_NAME.test('-a') && !STILL_NAME.test('a'.repeat(41)));
  const dir = path.join(ctx.dir, 'remotion', 'src', 'concepts', CID, 'images', PID);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'b.tsx'), '');
  await writeFile(path.join(dir, 'a.tsx'), '');
  assert.deepEqual((await postStills(ctx, CID, PID)).map((s) => s.id), ['still-a1b2c3d4-a', 'still-a1b2c3d4-b']);
});

test('U17/U18 the instructions name the post, size, count, text, script, brand, media and rules, and carry the skill', () => {
  const input = {
    concept: { id: CID, title: 'Launch', brief: 'Why' }, post: { id: PID, platform: 'instagram' as const, format: 'carousel', scheduledAt: '2026-11-03T09:00:00.000Z' },
    buildingDir: '/data/b', size: { width: 1080, height: 1350 }, stillPrefix: 'still-a1b2c3d4', postText: { text: 'Caption text', finalized: true }, scriptFile: '/data/b/concepts/x/script/script.md',
    brandFiles: ['logo.svg'], colours: [{ name: 'Ink', hex: '#112233' }], skillText: 'SKILL BODY',
  };
  const prompt = imagesSystemPrompt(input);
  for (const part of ['Platform: Instagram', 'Format: carousel', '2 to 20 images', '1080x1350', 'finalized text of this post', 'Caption text', '/data/b/concepts/x/script/script.md', '- logo.svg', 'Ink: #112233', 'src/brand/', 'list_media', 'Make no network requests', `src/concepts/${CID}/images/${PID}/`, '"still-a1b2c3d4-slide-01"', 'Render only with `render_images`', 'save_draft', '## Writing skill', 'SKILL BODY', '/data/b/knowledge/writing-style.md', 'its "Instagram" section']) {
    assert.ok(prompt.includes(part), part);
  }
  const bare = imagesSystemPrompt({ ...input, postText: { text: 'Draft', finalized: false }, scriptFile: null, brandFiles: [], colours: [], skillText: null });
  for (const part of ['latest draft of the text', 'No finalized script yet.', '(none uploaded yet)', '(none recorded yet)']) assert.ok(bare.includes(part), part);
  assert.doesNotMatch(bare, /Writing skill/);
  assert.match(imagesSystemPrompt({ ...input, postText: null }), /No post text yet\./);
  assert.match(imagesSystemPrompt({ ...input, reopened: true }), /reopened these images/);
  assert.equal(countRuleText('instagram', 'image'), 'exactly 1 image');
  assert.equal(countRuleText('x', 'image'), '1 to 4 images');
});

test('U19 every image platform resolves to the images tab with exactly its four tools', () => {
  for (const p of ['linkedin', 'instagram', 'x', 'facebook'] as const) assert.equal(studioTabFor('image-set', p)?.tab, 'images');
  assert.equal(studioTabFor('image-set', 'blog'), undefined);
  assert.deepEqual([...STUDIO_TABS.images!.tools], ['get_concept', 'get_performance', 'get_reference_content', 'save_draft', 'list_media', 'render_images']);
});

test('U20 an images job carries its kind, counts, Concept and asset, and each step can be sent at once', () => {
  const seen: ContentJobEvent[] = [];
  const off = contentJobs.on((e) => seen.push(e));
  const id = contentJobs.begin({ buildingId: 'b', kind: 'images', conceptId: CID, assetId: PID, renderId: 'r', done: 0, total: 3 });
  contentJobs.progress(id, { done: 1 }, true);
  contentJobs.progress(id, { done: 2 }, true);
  contentJobs.progress(id, { done: 3 });
  assert.deepEqual(contentJobs.list().find((j) => j.id === id), { ...seen[0]!.job, done: 3 });
  contentJobs.end(id, 'complete');
  off();
  assert.deepEqual(seen.map((e) => [e.job.kind, e.job.status, e.job.done, e.job.total]), [['images', 'running', 0, 3], ['images', 'running', 1, 3], ['images', 'running', 2, 3], ['images', 'complete', 3, 3]]);
  assert.deepEqual([seen[0]!.job.conceptId, seen[0]!.job.assetId], [CID, PID]);
});
