import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';

let root: string;
let server: Server;
let baseUrl: string;
let projectsDb: typeof import('../src/db/collections.ts').projectsDb;
let git: typeof import('../src/projects/git.ts');
let providers: typeof import('../src/projects/gitProvider.ts');

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'open-pr-test-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(root, 'projects');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(root, 'catalog');
  await mkdir(process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  git = await import('../src/projects/git.ts');
  providers = await import('../src/projects/gitProvider.ts');
  ({ projectsDb } = await import('../src/db/collections.ts'));
  const { createDaemonServer } = await import('../src/server.ts');
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function project(id: string, repositoryUrl?: string, gitProvider?: string) {
  const now = new Date().toISOString();
  await projectsDb.insert({ id, name: id, slug: id, relativePath: `projects/${id}`, repositoryUrl, ...(gitProvider ? { gitProvider: gitProvider as 'github' } : {}), status: 'idle', position: null, activeTaskId: null, activeTaskIds: [], taskCount: 0, createdAt: now, updatedAt: now });
  await mkdir(path.join(root, 'projects', id), { recursive: true });
}

type Body = { count?: number | null; pullRequests?: Array<Record<string, unknown>>; truncated?: boolean; checkedAt?: string; error?: string };

async function api(id: string) {
  const response = await fetch(`${baseUrl}/api/projects/${id}/open-pull-requests`);
  return { status: response.status, body: await response.json() as Body };
}

function ghLine(number: number, createdAt: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ number, title: `PR ${number}`, headBranch: `feature/${number}`, baseBranch: 'main', author: 'octo', url: `https://github.com/Owner/repo/pull/${number}`, isDraft: false, createdAt, updatedAt: createdAt, ...extra });
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

test('GitHub repository conversion accepts every remote form and rejects unsafe ones', () => {
  for (const remote of ['https://github.com/Owner/repo', 'https://github.com/Owner/repo/', 'https://github.com/Owner/repo.git', 'git@github.com:Owner/repo.git', 'git@github.com:Owner/repo/', 'git@github.com-work:Owner/repo.git', 'git@ssh.github.com:Owner/repo.git']) {
    assert.deepEqual(git.githubRepository(remote), { slug: 'Owner/repo', url: 'https://github.com/Owner/repo' });
  }
  for (const remote of ['', 'https://evil.com/a/b', 'https://github.com/a/b/extra', 'https://github.com/./repo', 'https://github.com/a/.git', 'git@host:a/b;touch x']) assert.equal(git.githubRepository(remote), null);
});

test('provider registry: GitHub by id, GitHub for a legacy Project, a clear error otherwise', () => {
  assert.equal(providers.gitProviderFor('github').id, 'github');
  assert.equal(providers.gitProviderFor(undefined).id, 'github');
  assert.equal(providers.gitProviderFor(null).id, 'github');
  assert.throws(() => providers.gitProviderFor('gitlab'), /Unsupported Git provider: gitlab/);
  assert.equal(providers.isGitProviderId('github'), true);
  assert.equal(providers.isGitProviderId('gitlab'), false);
  assert.equal(providers.isGitProviderId(undefined), false);
  assert.deepEqual(providers.gitProviderFor('github').repositoryLink('git@github.com:Owner/repo.git'), { slug: 'Owner/repo', url: 'https://github.com/Owner/repo' });
});

test('gh list call is open-only, one JSON object per PR, parsed, sorted newest first with number tie-break', async () => {
  const calls: string[][] = [];
  const out = [ghLine(1, day(1)), ghLine(3, day(3)), ghLine(2, day(3), { isDraft: true, author: null }), ''].join('\n');
  const result = await git.ghOpenPullRequests(root, 'Owner/repo', async (_cwd, args) => { calls.push(args); return out; });
  assert.deepEqual(calls[0]!.slice(0, 3), ['api', '--paginate', '--jq']);
  assert.equal(calls[0]!.at(-1), 'repos/Owner/repo/pulls?state=open&per_page=100');
  assert.deepEqual(result.pullRequests.map((pr) => pr.number), [3, 2, 1]);
  assert.equal(result.count, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.pullRequests[0]!, { number: 3, title: 'PR 3', headBranch: 'feature/3', baseBranch: 'main', author: 'octo', url: 'https://github.com/Owner/repo/pull/3', isDraft: false, createdAt: day(3), updatedAt: day(3) });
  assert.equal(result.pullRequests[1]!.author, null);
  assert.equal(result.pullRequests[1]!.isDraft, true);
});

test('gh list: zero is a result, the cap truncates with the true total, exactly the cap does not', async () => {
  assert.deepEqual(await git.ghOpenPullRequests(root, 'Owner/repo', async () => ''), { count: 0, pullRequests: [], truncated: false });
  const many = (n: number) => Array.from({ length: n }, (_, i) => ghLine(i + 1, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString())).join('\n');
  const over = await git.ghOpenPullRequests(root, 'Owner/repo', async () => many(103));
  assert.equal(over.count, 103);
  assert.equal(over.pullRequests.length, git.MAX_LISTED_PULL_REQUESTS);
  assert.equal(over.truncated, true);
  assert.equal(over.pullRequests[0]!.number, 103);
  const exact = await git.ghOpenPullRequests(root, 'Owner/repo', async () => many(100));
  assert.equal(exact.truncated, false);
  assert.equal(exact.pullRequests.length, 100);
});

test('gh list: malformed output throws and maps to a generic failure', async () => {
  await assert.rejects(() => git.ghOpenPullRequests(root, 'Owner/repo', async () => 'not-json'));
  await assert.rejects(() => git.ghOpenPullRequests(root, 'Owner/repo', async () => '{"number":1}'), /invalid pull request/);
  assert.match(git.ghCountFailure(new Error('request timed out')), /reach GitHub/);
  assert.match(git.ghCountFailure(new Error('spawn gh ENOENT')), /not installed/);
  assert.match(git.ghCountFailure(new Error('weird')), /Could not check/);
});

async function withFakeGh(script: string | null, action: (write: (script: string | null) => Promise<void>, argsFile: string) => Promise<void>) {
  const bin = path.join(root, `bin-${Math.random().toString(36).slice(2)}`);
  await mkdir(bin);
  const fake = path.join(bin, 'gh');
  const argsFile = path.join(bin, 'gh-args');
  const write = async (next: string | null) => {
    if (next === null) await rm(fake, { force: true });
    else { await writeFile(fake, next); await chmod(fake, 0o755); }
  };
  await write(script);
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  try { await action(write, argsFile); } finally { process.env.PATH = oldPath; }
}

test('route: 404 for an unknown project, 400 without a linked repository or with an unrecognised one', async () => {
  await project('no-repo');
  await project('other-host', 'https://gitlab.com/Owner/repo');
  const missing = await api('missing');
  assert.equal(missing.status, 404);
  assert.ok(missing.body.error);
  const noRepo = await api('no-repo');
  assert.equal(noRepo.status, 400);
  assert.match(noRepo.body.error!, /no linked repository/);
  assert.equal((await api('other-host')).status, 400);
});

test('route returns the PR list with the exact gh args, for legacy and explicit-provider Projects', async () => {
  await project('legacy', 'git@github.com-work:Owner/repo.git');
  await project('explicit', 'https://github.com/Owner/repo', 'github');
  await withFakeGh(null, async (write, _args) => {
    const bin = process.env.PATH!;
    const argsFile = path.join(bin, 'gh-args');
    await write(`#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nwhile IFS= read -r line; do printf '%s\\n' "$line"; done <<'EOF'\n${ghLine(1, day(1))}\n${ghLine(2, day(2), { isDraft: true })}\n${ghLine(3, day(3))}\nEOF\n`);
    for (const id of ['legacy', 'explicit']) {
      const { status, body } = await api(id);
      assert.equal(status, 200);
      assert.equal(body.count, 3);
      assert.equal(body.truncated, false);
      assert.equal(body.error, undefined);
      assert.ok(!Number.isNaN(Date.parse(body.checkedAt!)));
      assert.deepEqual(body.pullRequests!.map((pr) => pr.number), [3, 2, 1]);
      assert.equal(body.pullRequests![1]!.isDraft, true);
      assert.match(await readFile(argsFile, 'utf8'), /repos\/Owner\/repo\/pulls\?state=open&per_page=100/);
    }
  });
});

test('route: zero is a real zero, many PRs are capped and flagged', async () => {
  await project('counts', 'https://github.com/Owner/repo');
  await withFakeGh('#!/bin/sh\n:\n', async (write) => {
    const zero = await api('counts');
    assert.equal(zero.status, 200);
    assert.equal(zero.body.count, 0);
    assert.deepEqual(zero.body.pullRequests, []);
    assert.equal(zero.body.error, undefined);
    const lines = Array.from({ length: 120 }, (_, i) => ghLine(i + 1, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString())).join('\n');
    await write(`#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' "$line"; done <<'EOF'\n${lines}\nEOF\n`);
    const many = await api('counts');
    assert.equal(many.body.count, 120);
    assert.equal(many.body.pullRequests!.length, 100);
    assert.equal(many.body.truncated, true);
    assert.equal(many.body.pullRequests![0]!.number, 120);
  });
});

test('route: every failure is unavailable (count null, empty list), never a zero', async () => {
  await project('failing', 'https://github.com/Owner/repo');
  const cases: Array<[string, RegExp]> = [
    ['authentication required', /not signed in/],
    ['HTTP 401: Bad credentials', /not signed in/],
    ['HTTP 403: API rate limit exceeded', /rate limit/],
    ['HTTP 403: Resource not accessible by integration', /denied access/],
    ['HTTP 403', /denied access/],
    ['HTTP 403: Requires authentication', /not signed in/],
    ['network timeout', /reach GitHub/],
  ];
  await withFakeGh('#!/bin/sh\n', async (write) => {
    for (const [stderr, expected] of cases) {
      await write(`#!/bin/sh\necho "${stderr}" >&2\nexit 1\n`);
      const { status, body } = await api('failing');
      assert.equal(status, 200, stderr);
      assert.equal(body.count, null, stderr);
      assert.deepEqual(body.pullRequests, []);
      assert.equal(body.truncated, false);
      assert.match(body.error!, expected, stderr);
    }
    await write('#!/bin/sh\necho "partial response"\n');
    const malformed = await api('failing');
    assert.equal(malformed.body.count, null);
    assert.match(malformed.body.error!, /Could not check/);
    await write(null);
    const missing = await api('failing');
    assert.equal(missing.body.count, null);
    assert.match(missing.body.error!, /not installed/);
  });
});

test('git provider setting: created Projects default to GitHub, legacy ones read as GitHub, PATCH validates', async () => {
  await project('legacy-setting', 'https://github.com/Owner/repo');
  const list = await (await fetch(`${baseUrl}/api/projects`)).json() as Array<{ id: string; gitProvider: string }>;
  assert.equal(list.find((p) => p.id === 'legacy-setting')!.gitProvider, 'github');
  const ok = await fetch(`${baseUrl}/api/projects/legacy-setting/git-provider`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gitProvider: 'github' }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { gitProvider: string }).gitProvider, 'github');
  assert.equal((await projectsDb.get('legacy-setting'))!.gitProvider, 'github');
  const bad = await fetch(`${baseUrl}/api/projects/legacy-setting/git-provider`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gitProvider: 'gitlab' }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json() as { error: string }).error, /Unsupported Git provider/);
  const missing = await fetch(`${baseUrl}/api/projects/nope/git-provider`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gitProvider: 'github' }) });
  assert.equal(missing.status, 404);
});

test('a newly created Project stores GitHub as its Git provider', async () => {
  const { createProject } = await import('../src/projects/projectService.ts');
  const created = await createProject({ name: 'Provider Default', position: null });
  assert.equal(created.gitProvider, 'github');
});
