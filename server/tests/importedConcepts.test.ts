import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as web from '../../web/src/lib/contentRules.ts';
import { parseImportedConcept } from '../src/content/importedConcepts.ts';
import { importSystemPrompt } from '../src/content/importInstructions.ts';
import { insightsInstructions } from '../src/content/insightsInstructions.ts';
import { imagesSystemPrompt } from '../src/content/imageInstructions.ts';
import { parseReferenceQuery } from '../src/content/performance.ts';
import { PLATFORM_RULE_TEXT } from '../src/content/platformLimits.ts';
import { learnInstructions, learnPrompt, parseRetroAnswer } from '../src/content/retroRules.ts';
import * as rules from '../src/content/rules.ts';
import { studioSystemPrompt } from '../src/content/studioInstructions.ts';
import { IMPORT_SESSION_TOOLS, STUDIO_TABS } from '../src/content/studioTabs.ts';
import { thumbnailSystemPrompt } from '../src/content/thumbnailInstructions.ts';
import { videoSystemPrompt } from '../src/content/videoInstructions.ts';
import { rememberSecret } from '../src/redaction.ts';
import { studioMcpServer } from '../src/terminal/studioSessionTool.ts';

/** The pure rules of importing past Concepts: U01-U45 in the Test Case Planning list. Reference content's list needs a database, so U35-U38 run in importedConceptsApi.test.ts. */

const NOW = Date.parse('2026-10-26T10:00:00Z');
const parse = (body: unknown) => parseImportedConcept(body, NOW);
const refused = (body: unknown, field: string) => assert.throws(() => parse(body), (e: { status: number; field?: string; message: string }) => {
  assert.equal(e.status, 400, field); assert.equal(e.field, field); assert.ok(e.message.includes(field), e.message); return true;
}, field);
const onePost = (post: Record<string, unknown>) => ({ title: 'T', posts: [{ platform: 'linkedin', format: 'text', ...post }] });
const textOf = (platform: string, format: string, text: unknown) => ({ title: 'T', posts: [{ platform, format, text }] });
const blog = (n: number) => `# Title\n\n${'x'.repeat(n - 9)}`;
const postField = (name: string) => `posts[0].${name}`;
const stat = (over: Record<string, unknown>, post: Record<string, unknown> = {}) => onePost({ publishedAt: '2026-10-01T09:00:00Z', stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 1 }, ...over }], ...post });

test('U01 a normal post lists every asset it needs, whatever their state', () => {
  for (const [p, fs] of Object.entries(rules.FORMATS_BY_PLATFORM)) for (const f of fs) {
    assert.deepEqual(rules.postNeeds(p as rules.Platform, f, false, () => 'empty'), rules.assetsNeeded(p as rules.Platform, f), `${p}/${f}`);
  }
});

test('U02 an imported post lists only what was finalized', () => {
  const state = (finalized: rules.AssetKind[]) => (kind: rules.AssetKind) => (finalized.includes(kind) ? 'finalized' as const : 'empty' as const);
  assert.deepEqual(rules.postNeeds('linkedin', 'video', true, state(['post-text'])), ['post-text']);
  assert.deepEqual(rules.postNeeds('linkedin', 'video', true, state([])), []);
  assert.deepEqual(rules.postNeeds('blog', 'article', true, state(['article'])), ['article']);
});

test('U03 an imported post never reports a missing asset, for every platform and format', () => {
  for (const [p, fs] of Object.entries(rules.FORMATS_BY_PLATFORM)) for (const f of fs) {
    for (const state of ['empty', 'drafting', 'finalized'] as const) {
      const needs = rules.postNeeds(p as rules.Platform, f, true, () => state);
      assert.deepEqual(rules.finalizeCheck(needs, () => state), { ok: true, missing: [] }, `${p}/${f}/${state}`);
    }
  }
});

test('U04 the web mirror of the exemption and the tab rules match the server', () => {
  assert.equal(web.IMPORTED_READ_ONLY, rules.IMPORTED_READ_ONLY);
  for (const [p, fs] of Object.entries(rules.FORMATS_BY_PLATFORM)) for (const f of fs) {
    const platform = p as rules.Platform, posts = [{ platform, format: f }];
    for (const imported of [true, false]) for (const state of ['empty', 'finalized'] as const) {
      assert.deepEqual(web.postNeeds(platform, f, imported, () => state), rules.postNeeds(platform, f, imported, () => state));
    }
    assert.deepEqual(web.conceptTabStates(posts, { scriptFinalized: false, imported: true }), rules.conceptTabStates(posts, { scriptFinalized: false, imported: true }));
  }
});

test('U05 imported tabs: Video and Thumbnail open without a script, Remotion is off with its reason, the rest follow the posts', () => {
  const tabs = (posts: rules.PostShape[], imported: boolean, compositionReady = false) => Object.fromEntries(rules.conceptTabStates(posts, { scriptFinalized: false, compositionReady, imported }).map((t) => [t.key, t]));
  const video = tabs([{ platform: 'linkedin', format: 'video' }], true, true);
  assert.deepEqual([video.video!.enabled, video.thumbnail!.enabled, video.remotion!.enabled], [true, true, false]);
  assert.equal(video.remotion!.reason, 'Imported content has no Remotion project');
  const image = tabs([{ platform: 'instagram', format: 'image' }], true);
  assert.deepEqual([image.images!.enabled, image.captions!.enabled, image['post-content']!.enabled, image.video!.enabled], [true, true, false, false]);
  const normal = tabs([{ platform: 'linkedin', format: 'video' }], false);
  assert.deepEqual([normal.video!.enabled, normal.remotion!.reason], [false, 'Start the video in the Video tab first']);
});

test('U06 the read-only message', () => {
  assert.equal(rules.IMPORTED_READ_ONLY, 'Imported content is read-only; delete and import again');
});

test('U07 a title and one post are enough', () => {
  const out = parse(onePost({}));
  assert.deepEqual([out.brief, out.script], ['', null]);
  assert.deepEqual([out.posts[0]!.text, out.posts[0]!.liveUrl, out.posts[0]!.note, out.posts[0]!.externalAssets, out.posts[0]!.stats], [null, null, null, null, []]);
});

test('U08 title: 200 code points pass and are trimmed; 201, blank, missing and a number are refused', () => {
  assert.equal(parse({ ...onePost({}), title: '  ok  ' }).title, 'ok');
  assert.equal(parse({ ...onePost({}), title: 'x'.repeat(200) }).title.length, 200);
  assert.equal([...parse({ ...onePost({}), title: '😀'.repeat(200) }).title].length, 200);
  for (const title of ['x'.repeat(201), '   ', undefined, 5]) refused({ ...onePost({}), title }, 'title');
});

test('U09 brief: 5,000 passes, omitted or null is empty; 5,001 and a number are refused', () => {
  assert.equal(parse({ ...onePost({}), brief: 'x'.repeat(5000) }).brief.length, 5000);
  assert.equal(parse({ ...onePost({}), brief: null }).brief, '');
  for (const brief of ['x'.repeat(5001), 5]) refused({ ...onePost({}), brief }, 'brief');
});

test('U10 script: 1 and 50,000 pass, trimmed, omitted or null is none; 50,001, blank and a non-string are refused', () => {
  assert.equal(parse({ ...onePost({}), script: ' a ' }).script, 'a');
  assert.equal(parse({ ...onePost({}), script: 'x'.repeat(50_000) }).script!.length, 50_000);
  assert.equal(parse({ ...onePost({}), script: null }).script, null);
  for (const script of ['x'.repeat(50_001), '  ', 5]) refused({ ...onePost({}), script }, 'script');
});

test('U11 posts: 1 and 20 pass; missing, not a list, 0 and 21 are refused', () => {
  const list = (n: number) => Array.from({ length: n }, () => ({ platform: 'x', format: 'text' }));
  assert.equal(parse({ title: 'T', posts: list(20) }).posts.length, 20);
  for (const posts of [undefined, 'x', {}, [], list(21)]) refused({ title: 'T', posts }, 'posts');
  refused({ title: 'T', posts: ['x'] }, 'posts[0]');
});

test('U12 every valid pair passes; a wrong pair or platform is refused', () => {
  for (const [p, fs] of Object.entries(rules.FORMATS_BY_PLATFORM)) for (const f of fs) assert.equal(parse({ title: 'T', posts: [{ platform: p, format: f }] }).posts[0]!.format, f);
  for (const [platform, format] of [['linkedin', 'reel'], ['instagram', 'text'], ['blog', 'text'], ['x', 'carousel']]) refused({ title: 'T', posts: [{ platform, format }] }, postField('format'));
  for (const platform of ['LinkedIn', 'twitter', 5]) refused({ title: 'T', posts: [{ platform, format: 'text' }] }, postField('platform'));
});

test('U13 LinkedIn text limit', () => {
  assert.equal(parse(textOf('linkedin', 'text', 'x'.repeat(3000))).posts[0]!.text!.length, 3000);
  refused(textOf('linkedin', 'text', 'x'.repeat(3001)), postField('text'));
});

test('U14 Facebook text limit', () => {
  assert.equal(parse(textOf('facebook', 'text', 'x'.repeat(63_206))).posts[0]!.text!.length, 63_206);
  refused(textOf('facebook', 'text', 'x'.repeat(63_207)), postField('text'));
});

test('U15 X: 280 and 25 tweets pass; 281 and 26 are refused, a long tweet is named, separators add no tweet', () => {
  const thread = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join('\n---\n');
  parse(textOf('x', 'text', 'x'.repeat(280)));
  parse(textOf('x', 'text', thread(25)));
  refused(textOf('x', 'text', 'x'.repeat(281)), postField('text'));
  refused(textOf('x', 'text', thread(26)), postField('text'));
  assert.throws(() => parse(textOf('x', 'text', `a\n---\nb\n---\n${'x'.repeat(281)}`)), /Tweet 3 of 3/);
  parse(textOf('x', 'text', `---\n${thread(25)}\n  ---  \n---\n`));
});

test('U16 Instagram: 2,200 and 30 hashtags pass; 2,201 and 31 hashtags are refused', () => {
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `#t${i}`).join(' ');
  parse(textOf('instagram', 'image', 'x'.repeat(2200)));
  parse(textOf('instagram', 'image', tags(30)));
  refused(textOf('instagram', 'image', 'x'.repeat(2201)), postField('text'));
  refused(textOf('instagram', 'image', tags(31)), postField('text'));
});

test('U17 blog: 300 and 50,000 pass; 299, 50,001 and a missing title are refused; leading blanks are trimmed first', () => {
  parse(textOf('blog', 'article', blog(300)));
  parse(textOf('blog', 'article', blog(50_000)));
  assert.ok(parse(textOf('blog', 'article', `\n\n${blog(300)}`)).posts[0]!.text!.startsWith('# Title'));
  for (const text of [blog(299), blog(50_001), 'x'.repeat(400), `#title ${'x'.repeat(400)}`]) refused(textOf('blog', 'article', text), postField('text'));
});

test('U18 image, carousel, video and reel text follows the same platform limits as a caption', () => {
  for (const [platform, format, max] of [['linkedin', 'image', 3000], ['linkedin', 'carousel', 3000], ['linkedin', 'video', 3000], ['instagram', 'reel', 2200], ['x', 'video', 280]] as const) {
    parse(textOf(platform, format, 'x'.repeat(max)));
    refused(textOf(platform, format, 'x'.repeat(max + 1)), postField('text'));
  }
});

test('U19 text omitted, empty or blank is no text, even on a blog; a non-string is refused', () => {
  for (const text of [undefined, null, '', '   \n']) assert.equal(parse(textOf('blog', 'article', text)).posts[0]!.text, null);
  for (const text of [5, {}, ['x']]) refused(textOf('linkedin', 'text', text), postField('text'));
});

test('U20 the time defaults', () => {
  const times = (post: Record<string, unknown>) => { const p = parse(onePost(post)).posts[0]!; return [p.scheduledAt, p.publishedAt]; };
  const a = Date.parse('2026-10-01T09:00:00Z'), b = Date.parse('2026-10-02T09:00:00Z');
  assert.deepEqual(times({}), [NOW, NOW]);
  assert.deepEqual(times({ scheduledAt: '2026-10-01T09:00:00Z' }), [a, a]);
  assert.deepEqual(times({ publishedAt: '2026-10-02T09:00:00Z' }), [b, b]);
  assert.deepEqual(times({ scheduledAt: '2026-10-01T09:00:00Z', publishedAt: '2026-10-02T09:00:00Z' }), [a, b]);
});

test('U21 a published time may be 5 minutes ahead, no more; a future scheduled time alone is refused on publishedAt', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  assert.equal(parse(onePost({ publishedAt: at(NOW + 300_000) })).posts[0]!.publishedAt, NOW + 300_000);
  refused(onePost({ publishedAt: at(NOW + 300_001) }), postField('publishedAt'));
  refused(onePost({ scheduledAt: at(NOW + 3_600_000) }), postField('publishedAt'));
  assert.equal(parse(onePost({ scheduledAt: at(NOW + 3_600_000), publishedAt: '2026-10-01T09:00:00Z' })).posts[0]!.scheduledAt, NOW + 3_600_000);
});

test('U22 instants need Z or an offset', () => {
  for (const at of ['2026-10-01T09:00:00Z', '2026-10-01T09:00:00+05:30', '2026-10-01T09:00Z', '2026-10-01T09:00:00.123Z']) parse(onePost({ publishedAt: at }));
  for (const at of ['2026-10-01', '2026-10-01T09:00:00', '2026-10-01T09:00:00z', 5, '2026-13-01T09:00:00Z']) refused(onePost({ publishedAt: at }), postField('publishedAt'));
  refused(onePost({ scheduledAt: 'soon', publishedAt: '2026-10-01T09:00:00Z' }), postField('scheduledAt'));
});

test('U23 extreme dates: year 1 passes and round-trips, year 9999 is refused, 30 February pins the existing parser', () => {
  const old = parse(onePost({ publishedAt: '0001-01-01T00:00:00Z' })).posts[0]!.publishedAt;
  assert.equal(new Date(old).toISOString(), '0001-01-01T00:00:00.000Z');
  refused(onePost({ publishedAt: '9999-12-31T23:59:59Z' }), postField('publishedAt'));
  assert.equal(new Date(parse(onePost({ publishedAt: '2026-02-30T00:00:00Z' })).posts[0]!.publishedAt).toISOString(), '2026-03-02T00:00:00.000Z');
});

test('U24 liveUrl: http and https, trimmed; blank and null clear it; anything else is refused', () => {
  const url = (liveUrl: unknown) => parse(onePost({ liveUrl })).posts[0]!.liveUrl;
  assert.equal(url(' https://a.example/x '), 'https://a.example/x');
  assert.equal(url('http://a.example'), 'http://a.example');
  assert.equal(url('HTTP://a.example'), 'HTTP://a.example');
  assert.equal(url(`https://a.example/${'x'.repeat(1982)}`)!.length, 2000);
  for (const blank of ['', null]) assert.equal(url(blank), null);
  for (const bad of [`https://a.example/${'x'.repeat(2000)}`, 'ftp://a.example', 'javascript:alert(1)', 'plain text', 5]) refused(onePost({ liveUrl: bad }), postField('liveUrl'));
});

test('U25 note: 1,000 passes, blank is none; 1,001 and a non-string are refused', () => {
  assert.equal(parse(onePost({ note: 'x'.repeat(1000) })).posts[0]!.note!.length, 1000);
  assert.equal(parse(onePost({ note: '  ' })).posts[0]!.note, null);
  for (const note of ['x'.repeat(1001), 5]) refused(onePost({ note }), postField('note'));
});

test('U26 externalAssets: empty is none, 2,000 passes; 2,001 and a non-string are refused', () => {
  assert.equal(parse(onePost({ externalAssets: 'x'.repeat(2000) })).posts[0]!.externalAssets!.length, 2000);
  assert.equal(parse(onePost({ externalAssets: ' ' })).posts[0]!.externalAssets, null);
  for (const externalAssets of ['x'.repeat(2001), 5]) refused(onePost({ externalAssets }), postField('externalAssets'));
});

test('U27 stats: an empty list passes; a non-list is refused', () => {
  assert.deepEqual(parse(onePost({ stats: [] })).posts[0]!.stats, []);
  for (const stats of ['x', {}, 5]) refused(onePost({ stats }), postField('stats'));
  refused(onePost({ stats: ['x'] }), 'posts[0].stats[0]');
});

test('U28 capturedAt: equal to publishedAt passes; before it, omitted and past the tolerance are refused', () => {
  const field = 'posts[0].stats[0].capturedAt';
  assert.equal(parse(stat({ capturedAt: '2026-10-01T09:00:00Z' })).posts[0]!.stats.length, 1);
  refused(stat({ capturedAt: '2026-10-01T08:59:59.999Z' }), field);
  refused(stat({ capturedAt: undefined }), field);
  refused(stat({ capturedAt: new Date(NOW + 300_001).toISOString() }), field);
});

test('U29 counts: 0 and the maximum pass, null stays null; out of range, unknown keys and empty counts are refused', () => {
  const counts = (over: unknown) => stat({ counts: over });
  const out = parse(counts({ likes: 0, views: 1_000_000_000_000, shares: null })).posts[0]!.stats[0]!.counts;
  assert.deepEqual([out.likes, out.views, out.shares, out.saves], [0, 1_000_000_000_000, null, null]);
  for (const bad of [1_000_000_000_001, -1, 1.5, '5', 2 ** 53]) refused(counts({ likes: bad }), 'posts[0].stats[0].counts.likes');
  refused(counts({ nope: 1 }), 'posts[0].stats[0].counts.nope');
  for (const empty of [{ likes: null }, {}]) refused(counts(empty), 'posts[0].stats[0].counts');
});

test('U30 watchTime: on video and reel only, seconds with one decimal up to a day', () => {
  const video = { format: 'video' };
  for (const watchTime of [0, 12.5, 86_400]) assert.equal(parse(stat({ watchTime }, video)).posts[0]!.stats[0]!.watchTime, watchTime);
  parse({ title: 'T', posts: [{ platform: 'instagram', format: 'reel', publishedAt: '2026-10-01T09:00:00Z', stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { likes: 1 }, watchTime: 3 }] }] });
  for (const watchTime of [86_401, 12.55]) refused(stat({ watchTime }, video), 'posts[0].stats[0].watchTime');
  refused(stat({ watchTime: 1 }), 'posts[0].stats[0].watchTime');
  refused(stat({ watchTime: 1 }, { format: 'image' }), 'posts[0].stats[0].watchTime');
  refused({ title: 'T', posts: [{ platform: 'blog', format: 'article', publishedAt: '2026-10-01T09:00:00Z', stats: [{ capturedAt: '2026-10-02T09:00:00Z', counts: { views: 1 }, watchTime: 1 }] }] }, 'posts[0].stats[0].watchTime');
});

test('U31 a stat note takes 1,000 characters', () => {
  assert.equal(parse(stat({ note: 'x'.repeat(1000) })).posts[0]!.stats[0]!.note.length, 1000);
  refused(stat({ note: 'x'.repeat(1001) }), 'posts[0].stats[0].note');
});

test('U32 a fault in the second post is named', () => {
  refused({ title: 'T', posts: [{ platform: 'x', format: 'text' }, { platform: 'linkedin', format: 'text', text: 'x'.repeat(3001) }] }, 'posts[1].text');
});

test('U33 unknown body keys change nothing', () => {
  const out = parse({ ...onePost({ status: 'draft' }), imported: false, status: 'draft', id: 'x' });
  assert.deepEqual(Object.keys(out).sort(), ['brief', 'posts', 'script', 'title']);
  assert.ok(!('status' in out.posts[0]!));
});

const concept = { id: 'c1', title: 'T', brief: '', posts: [] };
const REFERENCE = '## Reference content\n\nthe section';
test('U39 the section reaches every prompt: script, post content, captions, blog, images, video, thumbnail', () => {
  for (const tab of ['script', 'post-content', 'captions', 'blog'] as const) {
    assert.ok(studioSystemPrompt({ tab: STUDIO_TABS[tab]!, concept, buildingDir: '/b', skillText: null, reference: REFERENCE }).includes(REFERENCE), tab);
  }
  const shared = { concept, buildingDir: '/b', skillText: null, brandFiles: [], colours: [], scriptFile: null, reference: REFERENCE };
  assert.ok(imagesSystemPrompt({ ...shared, post: { id: 'p', platform: 'x', format: 'image', scheduledAt: 'now' }, size: { width: 1, height: 1 }, stillPrefix: 's', postText: null }).includes(REFERENCE));
  assert.ok(thumbnailSystemPrompt({ ...shared, size: { width: 1, height: 1 }, stillPrefix: 's', video: null }).includes(REFERENCE));
  assert.ok(videoSystemPrompt({ concept, buildingDir: '/b', scriptFile: '/s', compositionId: 'c', reference: REFERENCE }).includes(REFERENCE));
});

test('U40 the reference query: limit 1 to 50, default 10, refused outside; closed platform and format', () => {
  assert.equal(parseReferenceQuery({}).limit, 10);
  for (const [limit, n] of [['1', 1], ['50', 50], ['007', 7], [50, 50]] as const) assert.equal(parseReferenceQuery({ limit }).limit, n);
  for (const limit of ['0', '51', '-1', '1.5', 'abc', '1e1', '', '1234567890123456789012345', 51, 1.5]) {
    assert.throws(() => parseReferenceQuery({ limit }), (e: { field?: string }) => e.field === 'limit', String(limit));
  }
  assert.deepEqual(parseReferenceQuery({ platform: 'x', format: 'text' }), { platform: 'x', format: 'text', limit: 10 });
  for (const platform of ['myspace', 'LinkedIn']) assert.throws(() => parseReferenceQuery({ platform }), (e: { field?: string }) => e.field === 'platform');
  assert.throws(() => parseReferenceQuery({ format: 'gif' }), (e: { field?: string }) => e.field === 'format');
});

test('U41 every tab has get_reference_content; the import session has exactly its two tools', () => {
  for (const tab of Object.values(STUDIO_TABS)) assert.ok(tab.tools.includes('get_reference_content'), tab.tab);
  assert.deepEqual([...IMPORT_SESSION_TOOLS], ['save_imported_concept', 'get_reference_content']);
  const server = studioMcpServer('sid', { tools: IMPORT_SESSION_TOOLS });
  assert.equal(server.env.AGENT_VISUAL_OS_STUDIO_TOOLS, 'save_imported_concept,get_reference_content');
  assert.equal(server.env.AGENT_VISUAL_OS_TASK_ID, 'sid');
});

test('U42 the Learn prompt holds the title, script, each text and the style; no folder or id; secrets are redacted', () => {
  rememberSecret('sekret-token-123456');
  const prompt = learnPrompt({ title: 'Standups', script: 'Hook sekret-token-123456', posts: [{ label: 'LinkedIn · text', text: 'One' }, { label: 'X (Twitter) · text', text: 'Two' }], style: '# Style' });
  for (const text of ['Standups', 'Hook', 'One', 'Two', 'LinkedIn · text', '# Style']) assert.ok(prompt.includes(text), text);
  assert.ok(!prompt.includes('sekret-token-123456'));
  assert.doesNotMatch(prompt, /\/data\/|concepts\//);
  assert.ok(!learnPrompt({ title: 'T', script: null, posts: [], style: 's' }).includes('Its script'));
});

test('U43 the Learn instructions keep the retro answer shape and say there are no drafts', () => {
  const text = learnInstructions('Skill body', 'PERF');
  assert.match(text, /no drafts/);
  assert.match(text, /only finished text/);
  assert.match(text, /"summary": string, "changes"/);
  for (const part of ['Skill body', 'PERF']) assert.ok(text.includes(part));
  const style = '## General\n\nBe plain.\n';
  assert.equal(parseRetroAnswer('{"summary":"s","changes":[]}', style).changes.length, 0);
});

test('U44 the import instructions: list, ask, state what was inferred, avoid duplicates, every platform rule, no token', () => {
  const text = importSystemPrompt('/data/buildings/b1');
  assert.match(text, /List what you found/);
  assert.match(text, /Ask the owner before saving/);
  assert.match(text, /State everything you inferred/);
  assert.match(text, /`get_reference_content`[^.]*avoid duplicates/);
  for (const rule of Object.values(PLATFORM_RULE_TEXT)) assert.ok(text.includes(rule), rule);
  assert.doesNotMatch(text, /Bearer|HOOK_TOKEN|token/i);
});

test('U45 the Insights instructions say imported posts appear, possibly without stats', () => {
  assert.match(insightsInstructions(), /"imported": true/);
  assert.match(insightsInstructions(), /may have no stats/);
});
