import assert from 'node:assert/strict';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startContentApi } from './helpers/contentApi.ts';
import type { ContentApi } from './helpers/contentApi.ts';

let t: ContentApi;
before(async () => { t = await startContentApi(); });
after(async () => { await t.stop(); });

const exists = (p: string) => access(p).then(() => true, () => false);
const upload = (id: string, name: string, body: Buffer | string) => t.api(t.c(id, `/knowledge/files?name=${encodeURIComponent(name)}`), { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });

test('SI31 the section list has the six built-in sections and a README naming every file', async () => {
  const id = await t.createStudio();
  const { sections } = (await t.api(t.c(id, '/knowledge/sections'))).body;
  assert.deepEqual(sections.map((s: { id: string }) => s.id), ['about', 'audience', 'products', 'facts', 'links', 'dos-donts']);
  assert.ok(sections.every((s: { version: string; changedAt: string }) => s.version && s.changedAt));
  const readme = await readFile(path.join(t.dataDir, 'buildings', id, 'knowledge', 'README.md'), 'utf8');
  for (const file of ['about.md', 'dos-donts.md', 'writing-style.md', 'colours.json', 'files/']) assert.ok(readme.includes(file), file);
  assert.equal((await t.api(t.c(id, '/knowledge/sections/README'))).status, 404);
  assert.equal((await t.send('PUT', t.c(id, '/knowledge/sections/README'), { content: 'x', version: 'v' })).status, 404);
});

test('SI32/SI33/SI34 a save with the current version writes the file; a stale one is 409 and writes nothing', async () => {
  const id = await t.createStudio();
  const file = path.join(t.dataDir, 'buildings', id, 'knowledge', 'about.md');
  const opened = (await t.api(t.c(id, '/knowledge/sections/about'))).body;
  const saved = await t.send('PUT', t.c(id, '/knowledge/sections/about'), { content: 'We sell tea', version: opened.version });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(file, 'utf8'), 'We sell tea');
  assert.notEqual(saved.body.version, opened.version);
  // An agent edits the file on disk after the web read it.
  await writeFile(file, 'Agent edit');
  const stale = await t.send('PUT', t.c(id, '/knowledge/sections/about'), { content: 'Mine', version: saved.body.version });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'Changed by an agent since you opened it');
  assert.equal(typeof stale.body.details.current, 'string');
  assert.equal(await readFile(file, 'utf8'), 'Agent edit');
  const overwrite = await t.send('PUT', t.c(id, '/knowledge/sections/about'), { content: 'Mine', version: stale.body.details.current });
  assert.equal(overwrite.status, 200);
  const version = overwrite.body.version;
  assert.equal((await t.send('PUT', t.c(id, '/knowledge/sections/about'), { content: 'x'.repeat(50_000), version })).status, 200);
  const current = (await t.api(t.c(id, '/knowledge/sections/about'))).body.version;
  for (const body of [{ content: 'x'.repeat(50_001), version: current }, { content: 5, version: current }, { content: 'x' }, { version: current }]) assert.equal((await t.send('PUT', t.c(id, '/knowledge/sections/about'), body)).status, 400);
});

test('SI35/SI36 custom sections: unique ignoring case, at most 20, deletable; built-in ones are not', async () => {
  const id = await t.createStudio();
  const create = (name: unknown) => t.send('POST', t.c(id, '/knowledge/sections'), { name });
  const made = await create('Brand voice');
  assert.deepEqual([made.status, made.body.id, made.body.builtin], [201, 'custom-brand-voice', false]);
  assert.ok(await exists(path.join(t.dataDir, 'buildings', id, 'knowledge', 'custom-brand-voice.md')));
  assert.equal((await create('BRAND VOICE')).status, 409);
  assert.equal((await create('about the business')).status, 409, 'built-in names count too');
  assert.equal((await create('Brand-voice')).body.id, 'custom-brand-voice-2', 'the same slug never collides');
  for (const bad of ['', '  ', 'x'.repeat(81), 3]) assert.equal((await create(bad)).status, 400);
  assert.equal((await create('../../etc')).body.id, 'custom-etc');
  assert.equal((await create('???')).body.id, 'custom-section');
  for (let i = 0; i < 16; i++) assert.equal((await create(`Extra ${i}`)).status, 201);
  assert.equal((await create('One too many')).status, 400);
  assert.match(await readFile(path.join(t.dataDir, 'buildings', id, 'knowledge', 'README.md'), 'utf8'), /custom-brand-voice\.md/);
  assert.equal((await t.send('DELETE', t.c(id, '/knowledge/sections/custom-brand-voice'))).status, 204);
  assert.equal(await exists(path.join(t.dataDir, 'buildings', id, 'knowledge', 'custom-brand-voice.md')), false);
  assert.equal((await t.send('DELETE', t.c(id, '/knowledge/sections/about'))).status, 400);
  assert.equal((await t.send('DELETE', t.c(id, '/knowledge/sections/nothing'))).status, 404);
});

test('SI37/SI38/SI39/SI40 raw upload keeps every byte, enforces its limits, and downloads as an attachment', async () => {
  const id = await t.createStudio();
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const up = await upload(id, 'logo bytes.png', bytes);
  assert.deepEqual([up.status, up.body.name, up.body.size, up.body.image], [201, 'logo bytes.png', 256, true]);
  const dl = await fetch(`${t.baseUrl}${t.c(id, '/knowledge/files/logo%20bytes.png')}`);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes);
  assert.match(dl.headers.get('content-disposition')!, /^attachment/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await upload(id, 'logo bytes.png', 'again')).status, 409);
  assert.equal((await upload(id, 'empty.txt', Buffer.alloc(0))).status, 400);
  for (const bad of ['../x', 'a/../../b', '.hidden', '']) {
    assert.equal((await upload(id, bad, 'x')).status, 400, bad);
  }
  assert.deepEqual((await readdir(path.join(t.dataDir, 'buildings', id, 'knowledge', 'files'))), ['logo bytes.png']);
  assert.equal((await upload(id, 'exact.bin', Buffer.alloc(50 * 1_048_576))).status, 201);
  assert.equal((await upload(id, 'over.bin', Buffer.alloc(50 * 1_048_576 + 1))).status, 400);
  assert.equal((await upload(id, 'huge.bin', Buffer.alloc(51 * 1_048_576 + 1))).status, 413);
  const files = (await t.api(t.c(id, '/knowledge/files'))).body.files;
  assert.deepEqual(files.map((f: { name: string }) => f.name), ['exact.bin', 'logo bytes.png']);
  assert.equal((await t.send('DELETE', t.c(id, '/knowledge/files/exact.bin'))).status, 204);
  assert.equal((await t.send('DELETE', t.c(id, '/knowledge/files/exact.bin'))).status, 404);
  assert.equal((await t.api(t.c(id, '/knowledge/files/..%2Fabout.md'))).status, 404);
});

test('SI39 the 101st file is refused', async () => {
  const id = await t.createStudio();
  for (let i = 0; i < 100; i++) assert.equal((await upload(id, `f${i}.txt`, 'x')).status, 201, `file ${i}`);
  assert.equal((await upload(id, 'f100.txt', 'x')).status, 400);
});

test('SI41 colours: at most 20, valid hex, unique names; an agent hand-edit reads back; a corrupt file reads as empty', async () => {
  const id = await t.createStudio();
  const put = (colours: unknown) => t.send('PUT', t.c(id, '/knowledge/colours'), { colours });
  assert.deepEqual((await put([{ name: 'Brand', hex: '#aabbcc' }])).body.colours, [{ name: 'Brand', hex: '#AABBCC' }]);
  assert.deepEqual((await t.api(t.c(id, '/knowledge/colours'))).body.colours, [{ name: 'Brand', hex: '#AABBCC' }]);
  assert.equal((await put(Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, hex: '#000000' })))).status, 200);
  assert.equal((await put(Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, hex: '#000000' })))).status, 400);
  for (const bad of [[{ name: 'x', hex: '#GGG' }], [{ name: 'x', hex: 'red' }], [{ name: 'x', hex: '#12345' }], [{ name: '', hex: '#000000' }], [{ name: 'a', hex: '#000000' }, { name: 'A', hex: '#111111' }], 'nope']) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  const file = path.join(t.dataDir, 'buildings', id, 'knowledge', 'colours.json');
  await writeFile(file, JSON.stringify([{ name: 'By agent', hex: '#010101' }, 5]));
  assert.deepEqual((await t.api(t.c(id, '/knowledge/colours'))).body.colours, [{ name: 'By agent', hex: '#010101' }]);
  await writeFile(file, '{not json');
  assert.deepEqual((await t.api(t.c(id, '/knowledge/colours'))).body.colours, []);
  await writeFile(file, '{"a":1}');
  assert.deepEqual((await t.api(t.c(id, '/knowledge/colours'))).body.colours, []);
});

test('SI42/SI43 writing style: starter headings, versioned save, size limit, history newest first and capped at 50', async () => {
  const id = await t.createStudio();
  const read = async () => (await t.api(t.c(id, '/writing-style'))).body;
  const first = await read();
  assert.deepEqual(first.sections, ['General', 'LinkedIn', 'Instagram', 'X', 'Facebook', 'Blog', 'Video script']);
  assert.deepEqual(first.proposals, []);
  const save = (content: string, version: string) => t.send('PUT', t.c(id, '/writing-style'), { content, version });
  const one = await save(`${first.content}Short and warm.\n`, first.version);
  assert.equal(one.status, 200);
  const stale = await save('Other', first.version);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.current, one.body.version);
  assert.equal((await save('x'.repeat(50_001), one.body.version)).status, 400);
  // An agent edits the file; the next web save records it as an agent entry first.
  await writeFile(path.join(t.dataDir, 'buildings', id, 'knowledge', 'writing-style.md'), 'Agent rewrite\n');
  const current = (await read()).version;
  assert.equal((await save('Mine\n', current)).status, 200);
  const history = (await t.api(t.c(id, '/writing-style/history'))).body.entries;
  assert.deepEqual(history.map((h: { who: string }) => h.who), ['person', 'agent', 'person']);
  assert.equal(history[2].summary, '+1 line');
  assert.ok(history[0].at >= history[2].at);
  let version = (await read()).version;
  for (let i = 0; i < 52; i++) version = (await save(`v${i}\n`, version)).body.version;
  assert.equal((await t.api(t.c(id, '/writing-style/history'))).body.entries.length, 50);
});

test('SI46 a Building keeps its Concepts and knowledge across a restart of the runtime', async () => {
  const id = await t.createStudio();
  await t.send('POST', t.c(id, '/concepts'), { title: 'Persisted' });
  await t.send('PUT', t.c(id, '/knowledge/colours'), { colours: [{ name: 'A', hex: '#000000' }] });
  const runtime = await import('../src/content/runtime.ts');
  runtime.forgetContent(id);
  assert.equal((await t.api(t.c(id, '/concepts'))).body.rows[0].title, 'Persisted');
  assert.equal((await t.api(t.c(id, '/settings'))).body.timezone, 'Europe/Berlin');
  assert.equal((await t.api(t.c(id, '/knowledge/colours'))).body.colours.length, 1);
});

test('SI37b a file typed application/json is stored byte for byte, valid or not, and past the JSON window', async () => {
  const id = await t.createStudio();
  const typed = (name: string, body: Buffer | string) => t.api(t.c(id, `/knowledge/files?name=${name}`), { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  const valid = Buffer.from('{"brand":"tea"}');
  assert.equal((await typed('tokens.json', valid)).status, 201);
  assert.equal((await typed('broken.json', '{nope')).status, 201);
  assert.equal((await typed('big.json', Buffer.alloc(26 * 1_048_576, 0x20))).status, 201);
  const dl = await fetch(`${t.baseUrl}${t.c(id, '/knowledge/files/tokens.json')}`);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), valid);
  assert.equal((await t.api(t.c(id, '/knowledge/files/broken.json'))).text, '{nope');
});

test('SI49b a JSON body over the 25 MB window is 413', async () => {
  const id = await t.createStudio();
  const res = await t.api(t.c(id, '/concepts'), { method: 'POST', body: JSON.stringify({ title: 'x', brief: 'b'.repeat(26 * 1_048_576) }) });
  assert.equal(res.status, 413);
});
