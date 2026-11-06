import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';

// The settings panel's add/edit/remove flow (POST/PATCH/DELETE /api/executors)
// writes real changes to server/executors.json, so — unlike api.test.ts's
// read-only executor tests — this file owns its own throwaway copy of that
// file rather than the fixture other test files share. node's test runner
// isolates each file in its own process, so this never leaks into another
// test file, and a failed test here never leaves the committed fixture dirty.

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'executor-settings-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(tempRoot, 'executors.json');
  await writeFile(process.env.AGENT_VISUAL_OS_EXECUTORS_PATH, JSON.stringify({
    executors: [
      { id: 'seed-claude', label: 'Seed Claude', kind: 'claude-cli', bin: 'claude', env: {} },
      { id: 'seed-codex', label: 'Seed Codex', kind: 'codex-cli', bin: 'codex', env: {} },
    ],
  }));

  const { createDaemonServer } = await import('../src/server.ts');
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  return { status: res.status, body };
}

test('POST /api/executors creates a new coding agent with a slugified id, persisted for later GETs', async () => {
  const res = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Claude (Work)', kind: 'claude-cli', bin: 'claude-work' }) });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'claude-work');
  assert.equal(res.body.label, 'Claude (Work)');
  assert.equal(res.body.kind, 'claude-cli');
  assert.equal(res.body.bin, 'claude-work');
  assert.deepEqual(res.body.env, {});

  const list = await api('/api/executors');
  assert.ok(list.body.some((e: { id: string }) => e.id === 'claude-work'));
});

test('POST /api/executors dedupes ids that would collide by appending a numeric suffix', async () => {
  const first = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Duplicate', kind: 'codex-cli', bin: 'codex' }) });
  const second = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Duplicate', kind: 'codex-cli', bin: 'codex' }) });
  assert.equal(first.body.id, 'duplicate');
  assert.equal(second.body.id, 'duplicate-2');
});

test('POST /api/executors requires a label, a bin/command, and a supported kind', async () => {
  const noLabel = await api('/api/executors', { method: 'POST', body: JSON.stringify({ kind: 'claude-cli', bin: 'claude' }) });
  assert.equal(noLabel.status, 400);

  const noBin = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'No bin', kind: 'claude-cli' }) });
  assert.equal(noBin.status, 400);

  const badKind = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Bad kind', kind: 'gpt', bin: 'gpt' }) });
  assert.equal(badKind.status, 400);
});

test('POST /api/executors rejects the removed non-interactive "claude"/"codex" executor kinds', async () => {
  // Only interactive-CLI executors are configurable now — see docs/architecture.md and
  // server/README.md's "Executors" section: a headless/structured coding-agent executor is no
  // longer a supported way to run a Task.
  const claude = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Old Claude', kind: 'claude', bin: 'claude' }) });
  assert.equal(claude.status, 400);
  assert.match(claude.body.error, /claude-cli, codex-cli/);

  const codex = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Old Codex', kind: 'codex', bin: 'codex' }) });
  assert.equal(codex.status, 400);
});

test('POST /api/executors accepts an optional env map for account-specific overrides', async () => {
  const res = await api('/api/executors', {
    method: 'POST',
    body: JSON.stringify({ label: 'Claude (alt account)', kind: 'claude-cli', bin: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/alt' } }),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.env, { CLAUDE_CONFIG_DIR: '/tmp/alt' });
});

test('POST /api/executors accepts Claude CLI and Codex CLI interactive agent types', async () => {
  const claude = await api('/api/executors', {
    method: 'POST',
    body: JSON.stringify({ label: 'Claude Interactive', kind: 'claude-cli', bin: 'claude' }),
  });
  const codex = await api('/api/executors', {
    method: 'POST',
    body: JSON.stringify({ label: 'Codex Interactive', kind: 'codex-cli', bin: 'codex' }),
  });
  assert.equal(claude.status, 201);
  assert.equal(claude.body.kind, 'claude-cli');
  assert.equal(codex.status, 201);
  assert.equal(codex.body.kind, 'codex-cli');
});

test('PATCH /api/executors/:id edits an existing agent in place, without changing its id', async () => {
  const created = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Renameable', kind: 'claude-cli', bin: 'claude' }) });
  const patched = await api(`/api/executors/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ label: 'Renamed', bin: 'claude-renamed' }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.id, created.body.id);
  assert.equal(patched.body.label, 'Renamed');
  assert.equal(patched.body.bin, 'claude-renamed');
  assert.equal(patched.body.kind, 'claude-cli');
});

test('PATCH /api/executors/:id 404s for an unknown id', async () => {
  const res = await api('/api/executors/does-not-exist', { method: 'PATCH', body: JSON.stringify({ label: 'x' }) });
  assert.equal(res.status, 404);
});

test('PATCH /api/executors/:id rejects an unsupported kind', async () => {
  const created = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Kind check', kind: 'claude-cli', bin: 'claude' }) });
  const res = await api(`/api/executors/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ kind: 'gpt' }) });
  assert.equal(res.status, 400);
});

test('DELETE /api/executors/:id removes a configured agent', async () => {
  const created = await api('/api/executors', { method: 'POST', body: JSON.stringify({ label: 'Removable', kind: 'codex-cli', bin: 'codex' }) });
  const res = await api(`/api/executors/${created.body.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);

  const list = await api('/api/executors');
  assert.ok(!list.body.some((e: { id: string }) => e.id === created.body.id));
});

test('DELETE /api/executors/:id 404s for an unknown id', async () => {
  const res = await api('/api/executors/does-not-exist', { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('DELETE /api/executors/:id refuses to remove the last remaining executor', async () => {
  // Drain every executor down to one, then confirm the last one is protected —
  // this permanently empties the list, so it runs last in this file.
  let list = (await api('/api/executors')).body as { id: string }[];
  while (list.length > 1) {
    const victim = list[0];
    if (!victim) break;
    await api(`/api/executors/${victim.id}`, { method: 'DELETE' });
    list = (await api('/api/executors')).body as { id: string }[];
  }
  assert.equal(list.length, 1);
  const last = list[0];
  assert.ok(last);
  const res = await api(`/api/executors/${last.id}`, { method: 'DELETE' });
  assert.equal(res.status, 409);
});
