import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { ContentCtx } from '../src/content/context.ts';
import { openContentDb, writeMeta } from '../src/content/db.ts';
import { clearManualSpeakingWpm, deleteSpeakingRateSample, recordSpeakingRate, saveSpeakingWpm, speakingRateSamples, speakingSpeed, SPEAKING_WPM_KEY } from '../src/content/speakingSpeed.ts';
import { videoSystemPrompt } from '../src/content/videoInstructions.ts';
import { STUDIO_TABS } from '../src/content/studioTabs.ts';

/** 37.007: speaking rate samples and the effective speed. Pure; in-memory db. */

let clock = 1000;
function setup() {
  const db = openContentDb(':memory:');
  const ctx = { db, now: () => (clock += 1) } as unknown as ContentCtx;
  db.prepare("INSERT INTO concepts (id, title, createdAt, updatedAt, seq) VALUES ('c1', 'C', 1, 1, 1), ('c2', 'D', 1, 1, 2)").run();
  const media = (id: string, conceptId: string, kind: string, name = id) => db.prepare('INSERT INTO media (id, conceptId, name, kind, size, createdAt, seq) VALUES (?, ?, ?, ?, 1, 1, 1)').run(id, conceptId, name, kind);
  media('v1', 'c1', 'video'); media('a1', 'c1', 'audio'); media('i1', 'c1', 'image'); media('v2', 'c2', 'video');
  return { db, ctx };
}
const report = (ctx: ContentCtx, mediaId: string, words: number, durationSeconds: number) => recordSpeakingRate(ctx, 'c1', { mediaId, words, durationSeconds });
const field = (fn: () => unknown) => { try { fn(); } catch (e: any) { return [e.status, e.field]; } return 'no error'; };

test('SR-U1 wpm is words per minute, exactly', () => {
  const { ctx } = setup();
  assert.equal(report(ctx, 'v1', 300, 120).wordsPerMinute, 150);
});

test('SR-U2/U3/U18 the average is total words over total minutes, rounded; one sample is its own rate', () => {
  const { ctx } = setup();
  report(ctx, 'v1', 300, 120);
  assert.equal(speakingSpeed(ctx).speakingWpm, 150);
  report(ctx, 'a1', 100, 60);
  assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 133, source: 'detected', sampleCount: 2 });
  const half = setup();
  report(half.ctx, 'v1', 125, 60); report(half.ctx, 'a1', 126, 60);
  assert.equal(speakingSpeed(half.ctx).speakingWpm, 126); // 125.5 rounds up
});

test('SR-U4..U12 limits: edges accepted, the rest refused naming the field', () => {
  const { ctx } = setup();
  assert.deepEqual(field(() => report(ctx, 'v1', 4, 3)), [400, 'words']);
  for (const [w, s] of [[5, 3], [40, 60], [400, 60], [14_400, 7200]]) assert.equal(field(() => report(ctx, 'v1', w!, s!)), 'no error', `${w}/${s}`);
  for (const w of [5.5, NaN, -1, 0, 2 ** 53 + 1, 1e308, '10' as never]) assert.deepEqual(field(() => report(ctx, 'v1', w as number, 60)), [400, 'words'], String(w));
  for (const s of [2.99, 7200.01, 0, -3, NaN, Infinity, '60' as never]) assert.deepEqual(field(() => report(ctx, 'v1', 100, s as number)), [400, 'durationSeconds'], String(s));
  assert.deepEqual(field(() => report(ctx, 'v1', 39, 60)), [400, 'wordsPerMinute']);
  assert.deepEqual(field(() => report(ctx, 'v1', 401, 60)), [400, 'wordsPerMinute']);
  assert.deepEqual(field(() => report(ctx, 'v1', 2 ** 53, 3)), [400, 'words']);
  for (const id of [undefined, '', 5, 'x'.repeat(10_000), 'nope', 'i1', 'v2']) assert.deepEqual(field(() => report(ctx, id as string, 100, 60)), [400, 'mediaId'], String(id).slice(0, 20));
});

test('SR-U13..U17 effective speed by source', () => {
  const { ctx } = setup();
  assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 150, source: 'default', sampleCount: 0 });
  saveSpeakingWpm(ctx, 180);
  assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 180, source: 'manual', sampleCount: 0 });
  report(ctx, 'v1', 100, 60);
  assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 180, source: 'manual', sampleCount: 1 });
  clearManualSpeakingWpm(ctx);
  assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 100, source: 'detected', sampleCount: 1 });
  writeMeta(ctx.db, SPEAKING_WPM_KEY, 'abc');
  assert.deepEqual(speakingSpeed(ctx), { speakingWpm: 100, source: 'detected', sampleCount: 1 });
  clearManualSpeakingWpm(ctx);
  clearManualSpeakingWpm(ctx);
});

test('SR-U19 replacing keeps the id and the list is oldest first with names; delete 404s on an unknown id', () => {
  const { ctx } = setup();
  const first = report(ctx, 'v1', 100, 60);
  report(ctx, 'a1', 120, 60);
  assert.equal(report(ctx, 'v1', 90, 60).id, first.id);
  assert.deepEqual(speakingRateSamples(ctx).map((s) => [s.mediaName, s.wordsPerMinute]), [['a1', 120], ['v1', 90]]);
  deleteSpeakingRateSample(ctx, first.id);
  assert.equal(speakingRateSamples(ctx).length, 1);
  assert.deepEqual(field(() => deleteSpeakingRateSample(ctx, first.id)), [404, undefined]);
});

test('SR-I1 migration: a database from before the table gets it on open and keeps its rows; reopening is idempotent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sr-mig-'));
  try {
    const file = path.join(dir, 'content.sqlite');
    const first = openContentDb(file);
    writeMeta(first, SPEAKING_WPM_KEY, '170');
    first.exec('DROP TABLE speaking_rate_samples');
    first.close();
    const raw = new Database(file);
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'speaking_rate_samples'").get() as { n: number }).n, 0);
    raw.close();
    for (let i = 0; i < 2; i += 1) {
      const db = openContentDb(file);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM speaking_rate_samples').get() as { n: number }).n, 0);
      assert.equal(speakingSpeed({ db } as unknown as ContentCtx).source, 'manual');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SR-I2 foreign keys: deleting the media or the Concept removes the sample', () => {
  const { ctx, db } = setup();
  report(ctx, 'v1', 100, 60); report(ctx, 'a1', 100, 60);
  db.prepare("DELETE FROM media WHERE id = 'v1'").run();
  assert.equal(speakingRateSamples(ctx).length, 1);
  db.prepare("DELETE FROM concepts WHERE id = 'c1'").run();
  assert.equal(speakingRateSamples(ctx).length, 0);
});

test('SR-I3 video instructions name the tool, once per file, no guessing, the speech-only rule and the checklist; other tabs do not', () => {
  const text = videoSystemPrompt({ concept: { id: 'c1', title: 'T', brief: '', posts: [] }, buildingDir: '/b', scriptFile: '/b/s.md', compositionId: 'x' });
  for (const needle of ['report_speaking_rate', 'once per such file', 'do not guess', 'not music', 'does not touch the checklist']) assert.ok(text.includes(needle), needle);
  assert.ok(STUDIO_TABS.video!.tools.includes('report_speaking_rate'));
  for (const tab of ['script', 'images', 'thumbnail'] as const) assert.ok(!STUDIO_TABS[tab]!.tools.includes('report_speaking_rate'), tab);
});
