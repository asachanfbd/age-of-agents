import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContentInputError } from '../src/content/errors.ts';
import * as L from '../src/content/limits.ts';
import { buildZip, uniqueNames, zipEntryName } from '../src/content/zip.ts';
import { agentArgs, extractionPrompt, parseExtractionAnswer } from '../src/content/statsAgent.ts';
import { expired, imageKind, parseUpload } from '../src/content/extractions.ts';
import { PLATFORM_STAT_FIELDS, STAT_FIELDS, emptyCounts, hasWatchTime, parseCounts, parseLiveUrl, parseNote, parsePastInstant, parseSnapshot, parseWatchTime, statsDelta, viewsOf } from '../src/content/stats.ts';

const refuses = (fn: () => unknown, field?: string) => assert.throws(fn, (e: unknown) => e instanceof ContentInputError && (field === undefined || e.field === field), String(field));
const NOW = Date.parse('2026-10-26T10:00:00Z');

test('SU36 the new limits are pinned', () => {
  assert.deepEqual([L.COUNT_MAX, L.LIVE_URL_MAX, L.STATS_NOTE_MAX, L.EXTRACT_TEXT_MAX, L.EXTRACT_IMAGE_MAX_BYTES, L.EXTRACTION_TIMEOUT_MS, L.FUTURE_TOLERANCE_MS, L.EXTRACT_IMAGES_MAX, L.EXTRACTION_TTL_MS],
    [1e12, 2000, 1000, 20000, 10 * 1048576, 120000, 300000, 10, 86400000]);
  assert.ok(L.EXTRACT_BODY_WINDOW > L.EXTRACT_IMAGES_MAX * L.EXTRACT_IMAGE_MAX_BYTES);
});

test('SU01-SU04 live URL: absent is none, http(s) only, 2000 characters', () => {
  for (const v of [undefined, null, '', '  ']) assert.equal(parseLiveUrl(v), null);
  assert.equal(parseLiveUrl('HTTPS://example.com/a'), 'HTTPS://example.com/a');
  assert.equal(parseLiveUrl('http://example.com'), 'http://example.com');
  for (const v of ['ftp://x.com', 'javascript:alert(1)', '/relative', 'example.com', 'https://', 5]) refuses(() => parseLiveUrl(v), 'liveUrl');
  const long = (n: number) => `https://example.com/${'a'.repeat(n - 20)}`;
  assert.equal(parseLiveUrl(long(2000)), long(2000));
  refuses(() => parseLiveUrl(long(2001)), 'liveUrl');
  refuses(() => parseLiveUrl(`https://e.com/${'😀'.repeat(1990)}`), 'liveUrl');
});

test('SU06-SU08 past instants allow five minutes ahead and no more; bad shapes are refused', () => {
  assert.equal(parsePastInstant(new Date(NOW + 300000).toISOString(), 'capturedAt', NOW), NOW + 300000);
  refuses(() => parsePastInstant(new Date(NOW + 300001).toISOString(), 'capturedAt', NOW), 'capturedAt');
  for (const v of ['nope', 5, '2026-10-26', '2026-10-26T09:00', null]) refuses(() => parsePastInstant(v, 'publishedAt', NOW), 'publishedAt');
  assert.ok(parsePastInstant('0001-01-01T00:00:00Z', 'publishedAt', NOW) < 0);
  refuses(() => parsePastInstant('9999-12-31T23:59:59Z', 'publishedAt', NOW), 'publishedAt');
});

test('SU10-SU14 counts: whole numbers 0..10^12, null is unknown, unknown keys refused', () => {
  const ok = parseCounts({ views: 0, likes: 1e12, saves: null });
  assert.deepEqual([ok.views, ok.likes, ok.saves, ok.reach], [0, 1e12, null, null]);
  for (const v of [1e12 + 1, 2 ** 53, -1, 1.5, 1e-7, '5', true, [], {}]) refuses(() => parseCounts({ views: v }), 'counts.views');
  for (const k of ['nope', '__proto__', 'constructor']) refuses(() => parseCounts(JSON.parse(`{"${k}": 1}`)), `counts.${k}`);
  refuses(() => parseCounts([]), 'counts');
  assert.deepEqual(parseCounts({ views: null }, { ...emptyCounts(), views: 5, likes: 2 }).likes, 2, 'omitted keeps');
  assert.equal(parseCounts({ views: null }, { ...emptyCounts(), views: 5 }).views, null, 'null clears');
});

test('SU13/SU15/SU16/SU17 a snapshot needs a count; watch time is video only with one decimal; the note is trimmed and limited', () => {
  const ctx = { format: 'text', publishedAt: NOW - 1000, now: NOW };
  const at = new Date(NOW - 500).toISOString();
  for (const body of [{ capturedAt: at }, { capturedAt: at, counts: {} }, { capturedAt: at, counts: { views: null } }, { capturedAt: at, note: 'x' }]) refuses(() => parseSnapshot(body, ctx), 'counts');
  refuses(() => parseSnapshot({ capturedAt: at, counts: { views: 1 }, watchTime: 3 }, ctx), 'watchTime');
  const video = { ...ctx, format: 'reel' };
  assert.equal(parseSnapshot({ capturedAt: at, counts: { views: 1 }, watchTime: 12.3 }, video).watchTime, 12.3);
  for (const v of [12.34, -0.1, '5', L.WATCH_TIME_MAX + 1]) refuses(() => parseWatchTime(v, 'video'), 'watchTime');
  assert.equal(parseWatchTime(0, 'video'), 0);
  assert.equal(parseNote('  hi '), 'hi');
  assert.equal(parseNote('x'.repeat(1000)).length, 1000);
  assert.equal([...parseNote('😀'.repeat(1000))].length, 1000);
  refuses(() => parseNote('x'.repeat(1001)), 'note');
  refuses(() => parseNote(5), 'note');
  assert.deepEqual([hasWatchTime('video'), hasWatchTime('reel'), hasWatchTime('image'), hasWatchTime('article')], [true, true, false, false]);
});

test('SU09 captured at cannot precede the published time (equal is fine)', () => {
  const ctx = { format: 'text', publishedAt: NOW - 1000, now: NOW };
  assert.equal(parseSnapshot({ capturedAt: new Date(NOW - 1000).toISOString(), counts: { views: 1 } }, ctx).capturedAt, NOW - 1000);
  refuses(() => parseSnapshot({ capturedAt: new Date(NOW - 1001).toISOString(), counts: { views: 1 } }, ctx), 'capturedAt');
  refuses(() => parseSnapshot({ counts: { views: 1 } }, ctx), 'capturedAt');
});

test('SU19 delta (the order itself is the SQL ORDER BY, covered by I19/I20 in contentPublishApi)', () => {
  const a = { ...emptyCounts(), views: 10, likes: null, saves: 4, comments: 0 }, b = { ...emptyCounts(), views: 4, likes: 1, saves: 9, comments: 0 };
  const d = statsDelta(a, b)!;
  assert.deepEqual([d.views, d.likes, d.saves, d.comments, d.reach], [6, null, -5, 0, null]);
  assert.equal(statsDelta(a, null), null);
  assert.equal(viewsOf({ ...emptyCounts(), impressions: 7 }), 7);
  assert.equal(viewsOf({ ...emptyCounts(), views: 0, impressions: 7 }), 0);
});

test('platform field lists use each platform\'s labels and only known keys', () => {
  assert.deepEqual(PLATFORM_STAT_FIELDS.linkedin.map((f) => f.label), ['Impressions', 'Reactions', 'Comments', 'Reposts', 'Clicks', 'Followers gained']);
  assert.deepEqual(PLATFORM_STAT_FIELDS.x.map((f) => [f.key, f.label]).slice(0, 5), [['impressions', 'Views'], ['likes', 'Likes'], ['comments', 'Replies'], ['shares', 'Reposts'], ['saves', 'Bookmarks']]);
  for (const list of Object.values(PLATFORM_STAT_FIELDS)) for (const f of list) assert.ok((STAT_FIELDS as readonly string[]).includes(f.key));
  assert.equal(PLATFORM_STAT_FIELDS.blog.length, 3);
});

const answer = (over: object = {}) => JSON.stringify({ counts: { views: 10, likes: null }, capturedAt: null, unused: [], ...over });
test('SU20-SU23 the extraction answer parser is strict', () => {
  assert.deepEqual(parseExtractionAnswer(` ${answer({ capturedAt: '2026-10-25T08:00:00Z', unused: ['Hearts'] })} `, 'instagram'), { counts: { views: 10, likes: null }, capturedAt: '2026-10-25T08:00:00Z', unused: ['Hearts'] });
  assert.deepEqual(parseExtractionAnswer(answer({ counts: {} }), 'blog').counts, {});
  for (const bad of ['```json\n' + answer() + '\n```', 'Here: ' + answer(), '[]', '', 'null', answer({ extra: 1 }), JSON.stringify({ counts: {}, unused: [] }),
    answer({ counts: { nope: 1 } }), answer({ counts: { saves: 1 } }), answer({ counts: { views: 1.5 } }), answer({ counts: { views: -1 } }), answer({ counts: { views: '12' } }),
    answer({ counts: { views: 1e12 + 1 } }), answer({ counts: { views: '1.2K' } }), answer({ counts: { views: '3,4 M' } }), answer({ capturedAt: 'yesterday' }), answer({ capturedAt: 5 }),
    answer({ unused: [1] }), answer({ unused: 'x' }), answer({ counts: [] })]) {
    assert.throws(() => parseExtractionAnswer(bad, 'blog'), ContentInputError, bad);
  }
  assert.throws(() => parseExtractionAnswer(answer({ counts: { views: 1, likes: 1 } }), 'blog'), ContentInputError, 'likes is not a blog field');
});

test('SU24 the prompt names the platform, format, its fields, the shape and the text as data', () => {
  const p = extractionPrompt('linkedin', 'video', 'Reactions 5', ['a.png']);
  for (const part of ['LinkedIn', 'video', 'likes: the platform\'s "Reactions"', '"capturedAt"', 'Reactions 5', 'a.png', '<<<TEXT']) assert.ok(p.includes(part), part);
  assert.ok(!p.includes('saves'), 'only the platform\'s own fields');
  assert.ok(extractionPrompt('blog', 'article', '', []).includes('There are no screenshots'));
  assert.ok(extractionPrompt('blog', 'article', '', []).includes('There is no pasted text'));
});

test('SU25 agent arguments: Claude may only Read, Codex attaches images with -i in its read-only sandbox', () => {
  const claude = agentArgs({ kind: 'claude-cli', prompt: 'P', images: ['a.png'], cwd: '/x' });
  assert.deepEqual(claude.slice(0, 2), ['-p', 'P']);
  assert.ok(claude.includes('Read(./**)') && claude.join(' ').includes('--disallowed-tools Bash,Edit,Write'));
  const codex = agentArgs({ kind: 'codex-cli', prompt: 'P', images: ['a.png', 'b.webp'], cwd: '/x' });
  assert.deepEqual(codex.slice(0, 1), ['exec']);
  assert.deepEqual(codex.slice(codex.indexOf('-i'), codex.indexOf('--')), ['-i', 'a.png', '-i', 'b.webp']);
  assert.ok(codex.includes('read-only') && codex.at(-1) === 'P' && codex.includes('/x'));
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
test('SU27 image type is judged by magic bytes', () => {
  assert.deepEqual([imageKind(PNG)?.ext, imageKind(JPG)?.ext, imageKind(WEBP)?.ext], ['png', 'jpg', 'webp']);
  for (const b of [Buffer.from('GIF89a......'), Buffer.from('<svg></svg>'), Buffer.from('%PDF-1.4'), Buffer.alloc(0), Buffer.from('<html>')]) assert.equal(imageKind(b), null);
});

async function form(parts: Array<[string, string | Buffer]>): Promise<{ type: string; body: Buffer }> {
  const f = new FormData();
  for (const [k, v] of parts) { if (typeof v === 'string') f.append(k, v); else f.append(k, new Blob([new Uint8Array(v)]), 'x.bin'); }
  const r = new Response(f);
  return { type: r.headers.get('content-type')!, body: Buffer.from(await r.arrayBuffer()) };
}
test('SU26/SU28/SU29 uploads: 0..10 images, 10 MB each, 20,000 characters, something to read', async () => {
  const run = async (parts: Array<[string, string | Buffer]>) => { const { type, body } = await form(parts); return parseUpload(type, body); };
  assert.equal((await run([['text', 'hello']])).images.length, 0, 'text only');
  assert.equal((await run([['images', PNG]])).text, '', 'images only');
  assert.equal((await run(Array.from({ length: 10 }, () => ['images', PNG] as [string, Buffer]))).images.length, 10);
  await assert.rejects(run(Array.from({ length: 11 }, () => ['images', PNG] as [string, Buffer])), (e: any) => e.field === 'images');
  await assert.rejects(run([]), (e: any) => e.field === 'text');
  await assert.rejects(run([['text', '   ']]), (e: any) => e.field === 'text');
  await assert.rejects(run([['images', Buffer.from('<svg/>')]]), (e: any) => e.field === 'images');
  assert.equal((await run([['text', 'x'.repeat(20000)]])).text.length, 20000);
  assert.equal((await run([['text', '😀'.repeat(20000)]])).text.length, 40000, 'counted in code points');
  await assert.rejects(run([['text', 'x'.repeat(20001)]]), (e: any) => e.field === 'text');
  const big = Buffer.concat([PNG, Buffer.alloc(L.EXTRACT_IMAGE_MAX_BYTES - PNG.length)]);
  assert.equal((await run([['images', big]])).images.length, 1, '10 MB ok');
  await assert.rejects(run([['images', Buffer.concat([big, Buffer.alloc(1)])]]), (e: any) => e.field === 'images');
  await assert.rejects(parseUpload('application/json', Buffer.from('{}')), (e: any) => e.field === 'images');
  await assert.rejects(run([['images', 'not a file']]), (e: any) => e.field === 'images');
});

test('SU30/SU31 zip: exact bytes, unique and safe names, empty set', () => {
  assert.deepEqual(uniqueNames(['a.png', 'a.png', '../x/b.png', 'a.png', '']), ['a.png', 'a (2).png', 'b.png', 'a (3).png', 'file']);
  assert.equal(zipEntryName('..\\evil/..'), 'file');
  const zip = buildZip([{ name: 'a.txt', bytes: Buffer.from('hello') }, { name: 'a.txt', bytes: Buffer.from('world!') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 2, 'two entries');
  assert.ok(zip.includes(Buffer.from('hello')) && zip.includes(Buffer.from('world!')) && zip.includes(Buffer.from('a (2).txt')));
  assert.equal(buildZip([]).length, 22);
});

test('SU32 an unused extraction expires at exactly 24 hours', () => {
  assert.deepEqual([expired(0, L.EXTRACTION_TTL_MS - 1), expired(0, L.EXTRACTION_TTL_MS), expired(0, L.EXTRACTION_TTL_MS + 1)], [false, true, true]);
});
