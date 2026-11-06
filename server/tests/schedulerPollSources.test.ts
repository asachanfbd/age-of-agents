import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { MAX_RESPONSE_BYTES, fetchApiResponse, readWatchedFiles } from '../src/scheduler/pollSources.ts';

/** The real poll sources: a temp folder, and a loopback HTTP server that answers what each test asks for. */

let root: string;
let server: Server;
let baseUrl: string;
let respond: (res: ServerResponse) => void = (res) => res.end('ok');
const live = () => new AbortController().signal;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'scheduler-sources-'));
  await mkdir(path.join(root, 'watched', 'deep'), { recursive: true });
  await writeFile(path.join(root, 'watched', 'a.md'), 'alpha');
  await writeFile(path.join(root, 'watched', 'deep', 'b.md'), 'beta');
  await utimes(path.join(root, 'watched', 'a.md'), 1_000, 1_000);
  server = createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

test('a watched folder is read with its nested folders; content is hashed only in hash mode', async () => {
  const byTime = (await readWatchedFiles(path.join(root, 'watched'), 'mtime', live())).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(byTime.map((entry) => [entry.path, entry.size, entry.hash]), [['a.md', 5, undefined], ['deep/b.md', 4, undefined]]);
  assert.equal(byTime[0]!.mtimeMs, 1_000_000);
  const byHash = await readWatchedFiles(path.join(root, 'watched'), 'hash', live());
  assert.ok(byHash.every((entry) => /^[0-9a-f]{64}$/.test(entry.hash ?? '')));
  assert.notEqual(byHash[0]!.hash, byHash[1]!.hash);
});

test('a single watched file is its own entry, and a missing path rejects', async () => {
  assert.deepEqual((await readWatchedFiles(path.join(root, 'watched', 'a.md'), 'mtime', live())).map((entry) => entry.path), ['a.md']);
  await assert.rejects(readWatchedFiles(path.join(root, 'nowhere'), 'mtime', live()), { code: 'ENOENT' });
});

test('a folder read whose check has timed out stops instead of walking on', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(readWatchedFiles(path.join(root, 'watched'), 'hash', abort.signal), { name: 'AbortError' });
});

test('an API response is returned with its status and body', async () => {
  respond = (res) => { res.statusCode = 503; res.end('down for maintenance'); };
  assert.deepEqual(await fetchApiResponse(`${baseUrl}/x`, live()), { status: 503, body: 'down for maintenance' });
  respond = (res) => res.end('x'.repeat(MAX_RESPONSE_BYTES));
  assert.equal((await fetchApiResponse(`${baseUrl}/x`, live())).body.length, MAX_RESPONSE_BYTES, 'a body exactly at the cap is accepted');
  respond = (res) => { res.statusCode = 204; res.end(); };
  assert.deepEqual(await fetchApiResponse(`${baseUrl}/x`, live()), { status: 204, body: '' });
});

test('a response that declares more than the cap is refused before its body is read', async () => {
  let sent = 0;
  respond = (res) => {
    res.setHeader('content-length', String(50 * MAX_RESPONSE_BYTES));
    // Only a little is ever written: reading the declared body would hang, so a prompt refusal shows nothing waited for it.
    res.write('x'.repeat(1024), () => { sent += 1024; });
  };
  await assert.rejects(fetchApiResponse(`${baseUrl}/x`, live()), /larger than 1 MB/);
  assert.ok(sent <= 1024);
});

test('a response of unknown length is dropped as soon as it passes the cap, not downloaded whole', async () => {
  let written = 0;
  let closedEarly = false;
  const chunk = 'x'.repeat(256 * 1024);
  respond = (res) => {
    res.on('close', () => { closedEarly = written < 400; });
    // An endless chunked body: only cutting the download off can end this request.
    const pump = () => { written += 1; if (res.write(chunk)) setImmediate(pump); else res.once('drain', pump); };
    pump();
  };
  await assert.rejects(fetchApiResponse(`${baseUrl}/x`, live()), /larger than 1 MB/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closedEarly, true, `the connection was dropped after ${written} chunks`);
});

test('an API read whose check has timed out is abandoned', async () => {
  respond = () => undefined; // never answers
  const abort = new AbortController();
  const reading = fetchApiResponse(`${baseUrl}/x`, abort.signal);
  abort.abort();
  await assert.rejects(reading, { name: 'AbortError' });
});
