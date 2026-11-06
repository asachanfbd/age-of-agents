import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';

/** 37.006: "Speaking speed (words per minute)" on GET/PATCH settings. Real daemon on temp folders. */

let t: ContentApi;
before(async () => { t = await startContentApi(); });
after(async () => { await t.stop(); });

const settings = async (id: string) => (await t.api(t.c(id, '/settings'))).body;
const patch = (id: string, body: unknown) => t.send('PATCH', t.c(id, '/settings'), body);
const patchRaw = (id: string, json: string) => t.api(t.c(id, '/settings'), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: json });

test('SI01 a new Building reads the default speed', async () => {
  const id = await t.createStudio();
  assert.deepEqual((await settings(id)).speakingSpeed, { speakingWpm: 150, source: 'default', sampleCount: 0 });
});

test('SI02/SI03/SI04 a valid speed saves as manual and stays after a reread; 150 on purpose is manual too', async () => {
  const id = await t.createStudio();
  const res = await patch(id, { speakingWpm: 180 });
  assert.deepEqual([res.status, res.body.speakingSpeed], [200, { speakingWpm: 180, source: 'manual', sampleCount: 0 }]);
  assert.deepEqual((await settings(id)).speakingSpeed, { speakingWpm: 180, source: 'manual', sampleCount: 0 });
  for (const n of [20, 400]) assert.equal((await patch(id, { speakingWpm: n })).status, 200, String(n));
  const fresh = await t.createStudio();
  assert.deepEqual((await patch(fresh, { speakingWpm: 150 })).body.speakingSpeed, { speakingWpm: 150, source: 'manual', sampleCount: 0 });
});

test('SI05 anything else is 400 field speakingWpm and saves nothing', async () => {
  const id = await t.createStudio();
  await patch(id, { speakingWpm: 180 });
  for (const bad of [19, 401, 0, -1, 150.5, 9007199254740993, 1e308, '150', null, true, [], {}]) {
    const res = await patch(id, { speakingWpm: bad });
    assert.deepEqual([res.status, res.body.field, typeof res.body.error], [400, 'speakingWpm', 'string'], JSON.stringify(bad));
  }
  assert.deepEqual((await settings(id)).speakingSpeed, { speakingWpm: 180, source: 'manual', sampleCount: 0 });
});

test('SI06 150.0 and 1.5e2 in the raw JSON body are the whole number 150', async () => {
  const id = await t.createStudio();
  for (const json of ['{"speakingWpm":150.0}', '{"speakingWpm":1.5e2}']) {
    const res = await patchRaw(id, json);
    assert.deepEqual([res.status, res.body.speakingSpeed], [200, { speakingWpm: 150, source: 'manual', sampleCount: 0 }], json);
  }
});

test('SI07 a bad speed beside a valid name and zone saves none of them', async () => {
  const id = await t.createStudio('Before', 'UTC');
  const res = await patch(id, { name: 'After', timezone: 'Asia/Kolkata', speakingWpm: 401 });
  assert.equal(res.status, 400);
  const now = await settings(id);
  assert.deepEqual([now.name, now.timezone, now.speakingSpeed], ['Before', 'UTC', { speakingWpm: 150, source: 'default', sampleCount: 0 }]);
});

test('SI08 a PATCH without speakingWpm leaves the source as it was', async () => {
  const id = await t.createStudio();
  assert.deepEqual((await patch(id, { name: 'Renamed' })).body.speakingSpeed, { speakingWpm: 150, source: 'default', sampleCount: 0 });
  await patch(id, { speakingWpm: 180 });
  assert.deepEqual((await patch(id, { autoApplyRetro: true })).body.speakingSpeed, { speakingWpm: 180, source: 'manual', sampleCount: 0 });
});

test('SI09 a read-only Building answers 409 and keeps its speed', async () => {
  const id = await t.createStudio();
  await t.projectsDb.update(id, { readOnlyReason: 'Frozen for the test' });
  assert.equal((await patch(id, { speakingWpm: 180 })).status, 409);
  const res = await t.api(t.c(id, '/settings'));
  assert.deepEqual([res.status, res.body.speakingSpeed], [200, { speakingWpm: 150, source: 'default', sampleCount: 0 }]);
});

test('SI10 two PATCHes sent together both succeed through the write queue; the later one wins', async () => {
  const id = await t.createStudio();
  const [a, b] = await Promise.all([patch(id, { speakingWpm: 180 }), patch(id, { speakingWpm: 200 })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual((await settings(id)).speakingSpeed, { speakingWpm: 200, source: 'manual', sampleCount: 0 });
});
