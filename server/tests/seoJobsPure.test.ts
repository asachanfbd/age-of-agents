import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { configureSeo, defaultLimits, resetSeo } from '../src/seo/deps.ts';
import { beginJob, endJob, listRunningJobs, onSeoJobEvent, progressJob, PROGRESS_INTERVAL_MS, trackJob } from '../src/seo/jobs.ts';
import type { SeoJobEvent } from '../src/seo/jobs.ts';

let clock = 0;
let events: SeoJobEvent[];
let off: () => void;

beforeEach(() => {
  clock = Date.parse('2026-01-01T00:00:00Z');
  configureSeo({ now: () => new Date(clock), limits: defaultLimits() });
  events = [];
  off = onSeoJobEvent((e) => events.push(e));
});
afterEach(() => { off(); resetSeo(); });

test('progress is throttled to one event per second; the end event is never throttled', () => {
  const id = beginJob({ buildingId: 'b', kind: 'crawl', progress: { fetched: 0, queued: 0, failed: 0 } });
  progressJob(id, { fetched: 1, queued: 5, failed: 0 });
  progressJob(id, { fetched: 2, queued: 4, failed: 0 });
  assert.equal(events.length, 1, 'only the start event inside the window');
  clock += PROGRESS_INTERVAL_MS;
  progressJob(id, { fetched: 3, queued: 3, failed: 0 });
  progressJob(id, { fetched: 4, queued: 2, failed: 0 });
  assert.deepEqual(events.map((e) => e.job.progress?.fetched), [0, 3]);
  endJob(id, 'complete');
  assert.equal(events.at(-1)!.job.status, 'complete');
  assert.equal(events.at(-1)!.job.progress?.fetched, 4, 'the end event carries the latest progress');
});

test('an ended job leaves the list before its end event, and ending twice emits once', () => {
  const id = beginJob({ buildingId: 'b', kind: 'sitemaps' });
  let listedAtEnd = true;
  const stop = onSeoJobEvent((e) => { if (e.job.status !== 'running') listedAtEnd = listRunningJobs().length > 0; });
  endJob(id, 'stopped');
  endJob(id, 'failed');
  stop();
  assert.equal(listedAtEnd, false);
  assert.deepEqual(events.map((e) => e.job.status), ['running', 'stopped']);
  progressJob(id, { fetched: 1, queued: 1, failed: 0 });
  assert.equal(events.length, 2);
});

test('trackJob ends complete, or failed with the error when the work throws', async () => {
  assert.equal(await trackJob('b', 'inspection', async () => 7), 7);
  await assert.rejects(trackJob('b', 'inspection', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(events.map((e) => [e.job.status, e.job.error]), [['running', undefined], ['complete', undefined], ['running', undefined], ['failed', 'boom']]);
  assert.deepEqual(listRunningJobs(), []);
});
