import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLATFORM_RULE_TEXT } from '../src/content/platformLimits.ts';
import { PLATFORMS } from '../src/content/rules.ts';
import type { Platform } from '../src/content/rules.ts';
import { scheduledText, studioSystemPrompt } from '../src/content/studioInstructions.ts';
import type { PostBrief } from '../src/content/studioInstructions.ts';
import { STUDIO_TABS, studioTabFor, styleSectionFor } from '../src/content/studioTabs.ts';

/** What a post tab's session is told (content/studioInstructions.ts): its post, the platform rules, the script and the other posts. */

const concept = { title: 'Launch', brief: 'Big news', posts: [] };
const FORMAT: Record<Platform, string> = { linkedin: 'text', x: 'text', facebook: 'image', instagram: 'reel', blog: 'article' };
const brief = (platform: Platform, over: Partial<PostBrief> = {}): PostBrief => ({
  platform, format: FORMAT[platform], scheduledAt: '2026-11-03T09:00:00.000Z', timeZone: 'Europe/Berlin', scriptFile: null, others: [], ...over,
});
const promptFor = (platform: Platform, over: Partial<PostBrief> = {}, skillText: string | null = 'SKILL') =>
  studioSystemPrompt({ tab: studioTabFor(platform === 'blog' ? 'article' : 'post-text', platform)!, concept, buildingDir: '/b', skillText, post: brief(platform, over) });

test('U29 the prompt names the platform, the format and the scheduled date (ISO plus Building-zone time)', () => {
  const prompt = promptFor('linkedin');
  assert.match(prompt, /Platform: LinkedIn\nFormat: text/);
  assert.match(prompt, /Scheduled: 2026-11-03T09:00:00\.000Z \(Tuesday,? 3 November 2026 at 10:00, Europe\/Berlin\)/);
});

test('U30 the prompt holds its own platform rule and no other platform rule', () => {
  for (const platform of PLATFORMS) {
    const prompt = promptFor(platform);
    assert.ok(prompt.includes(PLATFORM_RULE_TEXT[platform]), platform);
    for (const other of PLATFORMS.filter((p) => p !== platform)) assert.equal(prompt.includes(PLATFORM_RULE_TEXT[other]), false, `${platform} without ${other}`);
    assert.match(prompt, /refuses a draft that breaks these rules with a message naming the limit; shorten it and save again/);
  }
});

test('U31 the tab and the writing-style section follow the post platform', () => {
  const cases: [Platform, string, string][] = [['linkedin', 'post-content', 'LinkedIn'], ['x', 'post-content', 'X'], ['facebook', 'post-content', 'Facebook'], ['instagram', 'captions', 'Instagram'], ['blog', 'blog', 'Blog']];
  for (const [platform, tab, section] of cases) {
    const def = studioTabFor(platform === 'blog' ? 'article' : 'post-text', platform)!;
    assert.equal(def.tab, tab, platform);
    assert.equal(styleSectionFor(def, platform), section);
    assert.match(promptFor(platform), new RegExp(`General section and its "${section}" section`));
    assert.ok(promptFor(platform).includes(def.job));
  }
  assert.match(STUDIO_TABS.captions!.job, /Instagram caption/);
  assert.match(STUDIO_TABS.blog!.job, /Markdown/);
  assert.equal(styleSectionFor(STUDIO_TABS.script!, null), 'Video script');
  assert.equal(styleSectionFor(STUDIO_TABS['post-content']!, null), 'General');
});

test('U32 a finalized script gives its file path to read', () => {
  const prompt = promptFor('x', { scriptFile: '/b/concepts/c1/script/script.md' });
  assert.match(prompt, /finalized script is in \/b\/concepts\/c1\/script\/script\.md\. Read it so this text matches the video/);
});

test('U33 no finalized script is not an error: no path, a line saying so', () => {
  const prompt = promptFor('linkedin');
  assert.match(prompt, /No finalized script yet, so write from the brief/);
  assert.equal(prompt.includes('script.md'), false);
});

test('U34 the other posts are listed with platform, format, date and text state; a single post says there are none', () => {
  const prompt = promptFor('linkedin', {
    others: [
      { platform: 'x', format: 'text', scheduledAt: '2026-11-04T09:00:00.000Z', textState: 'drafting' },
      { platform: 'instagram', format: 'reel', scheduledAt: '2026-11-05T09:00:00.000Z', textState: 'finalized' },
      { platform: 'blog', format: 'article', scheduledAt: '2026-11-06T09:00:00.000Z', textState: 'empty' },
      { platform: 'facebook', format: 'video', scheduledAt: '2026-11-07T09:00:00.000Z', textState: null },
    ],
  });
  assert.match(prompt, /- X \(Twitter\), text, scheduled 2026-11-04T09:00:00\.000Z, text: Drafting/);
  assert.match(prompt, /- Instagram, reel, scheduled 2026-11-05T09:00:00\.000Z, text: Finalized/);
  assert.match(prompt, /- Blog, article, scheduled 2026-11-06T09:00:00\.000Z, text: Not started/);
  assert.match(prompt, /- Facebook, video, scheduled 2026-11-07T09:00:00\.000Z, text: none needed/);
  assert.match(promptFor('linkedin'), /\(none: this is the only post\)/);
});

test('U35 the shared 32.002 sections stay: knowledge, writing style, skill text, save_draft; no skill omits it', () => {
  const prompt = promptFor('instagram');
  assert.match(prompt, /\/b\/knowledge\//);
  assert.match(prompt, /writing-style\.md/);
  assert.match(prompt, /## Writing skill\n\nFollow this skill for all text you write\.\n\nSKILL/);
  assert.match(prompt, /Every complete draft must be saved with the `save_draft` tool/);
  assert.equal(promptFor('instagram', {}, null).includes('## Writing skill'), false);
});

test('U36 the Script prompt is unchanged: posts listed, no platform rules, no script path', () => {
  const prompt = studioSystemPrompt({ tab: STUDIO_TABS.script!, concept: { ...concept, posts: [{ platform: 'x', format: 'text', scheduledAt: '2026-11-03T09:00:00.000Z' } as never] }, buildingDir: '/b', skillText: null });
  assert.match(prompt, /Posts:\n- X \(Twitter\), text, scheduled 2026-11-03T09:00:00\.000Z/);
  for (const text of Object.values(PLATFORM_RULE_TEXT)) assert.equal(prompt.includes(text), false);
  assert.equal(prompt.includes('## Platform rules'), false);
  assert.equal(prompt.includes('## The video script'), false);
});

test('U37 the X prompt explains the thread format', () => {
  assert.match(promptFor('x'), /put a line containing only `---` between tweets\. Each tweet may have at most 280 characters, and a thread at most 25 tweets/);
  assert.equal(promptFor('linkedin').includes('A thread is allowed'), false);
});

test('U38 tab resolution by asset kind and post platform', () => {
  assert.equal(studioTabFor('post-text', 'instagram')?.tab, 'captions');
  for (const p of ['linkedin', 'x', 'facebook'] as const) assert.equal(studioTabFor('post-text', p)?.tab, 'post-content');
  assert.equal(studioTabFor('article', 'blog')?.tab, 'blog');
  assert.equal(studioTabFor('script')?.tab, 'script');
  assert.equal(studioTabFor('image-set', 'linkedin')?.tab, 'images');
  assert.equal(studioTabFor('image-set', 'blog'), undefined);
  assert.equal(studioTabFor('video')?.tab, 'video');
  assert.equal(studioTabFor('post-text'), undefined, 'a post text always has its post');
});

test('U39 extreme dates render without throwing', () => {
  assert.match(scheduledText('1970-01-01T00:00:00.000Z', 'UTC'), /Thursday,? 1 January 1970/);
  assert.match(scheduledText('9999-12-31T23:59:59.000Z', 'UTC'), /9999/);
  assert.match(promptFor('blog', { scheduledAt: '9999-12-31T23:59:59.000Z', timeZone: 'Pacific/Kiritimati' }), /Scheduled: 9999-12-31T23:59:59\.000Z/);
});
