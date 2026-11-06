import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { CommandRunRecord, ProjectRecord, WorkflowRunRecord } from '../src/domain/types.ts';

/**
 * The Quick look endpoints (task 5.008) against real git repositories: a Project with a worktree
 * run, a run without a separate branch, removed and tampered worktrees, and commands run from a
 * run's working copy under the one-running-instance rule.
 */

let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let projectService: typeof import('../src/projects/projectService.ts');
let collections: typeof import('../src/db/collections.ts');
let commandService: typeof import('../src/commands/commandService.ts');

let project: ProjectRecord;
let projectDir: string;
let worktree: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const post = (pathname: string, body: unknown) => api(pathname, { method: 'POST', body: JSON.stringify(body) });

let runCounter = 0;
async function insertRun(target: ProjectRecord, fields: Partial<WorkflowRunRecord>): Promise<WorkflowRunRecord> {
  runCounter += 1;
  const now = new Date().toISOString();
  const run = {
    id: `run-${runCounter}`,
    projectId: target.id,
    planItemId: 'item-5-008',
    workflowId: 'software-development',
    workflowSnapshot: { id: 'software-development', name: 'Flow', description: 'd', enabled: true, steps: [] },
    status: 'running',
    currentStepId: null,
    executorId: 'test-claude-cli',
    prUrl: null,
    completionReport: null,
    attentionReason: null,
    attentionNotificationId: null,
    loopRoundAllowance: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...fields,
  } as WorkflowRunRecord;
  await collections.workflowRunsDb.insert(run);
  return run;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function settledRun(runId: string): Promise<CommandRunRecord> {
  await waitUntil(async () => (await api(`/api/command-runs/${runId}`)).body.status !== 'running');
  return (await api(`/api/command-runs/${runId}`)).body;
}

let worktreeRun: WorkflowRunRecord;
let folderRun: WorkflowRunRecord;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'quick-look-api-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });

  projectService = await import('../src/projects/projectService.ts');
  collections = await import('../src/db/collections.ts');
  commandService = await import('../src/commands/commandService.ts');
  const { createDaemonServer } = await import('../src/server.ts');
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}`;

  project = await projectService.createProject({ name: 'Quick Look', position: null });
  projectDir = projectService.projectAbsolutePath(project);
  git(projectDir, 'init', '-q', '-b', 'main');
  git(projectDir, 'config', 'user.email', 'test@example.com');
  git(projectDir, 'config', 'user.name', 'Test');
  await writeFile(path.join(projectDir, 'a.ts'), 'one\n');
  await writeFile(path.join(projectDir, 'main-secret.txt'), 'only in the main checkout\n');
  await writeFile(path.join(projectDir, '.docs', 'blueprint.md'), '# Main blueprint\n');
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-qm', 'base');

  worktree = path.join(projectService.projectWorktreesRoot(project), 'run-item-5-008');
  await mkdir(path.dirname(worktree), { recursive: true });
  git(projectDir, 'worktree', 'add', '-q', '-b', 'task/5-008', worktree, 'main');
  await writeFile(path.join(worktree, 'a.ts'), 'one\ntwo\n');
  await writeFile(path.join(worktree, 'worktree-only.ts'), 'task work\n');
  await writeFile(path.join(worktree, '.docs', 'task-notes.md'), '# Task notes\n');
  await writeFile(path.join(worktree, 'logo.png'), Buffer.from([0, 1, 2]));
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'task work');
  await writeFile(path.join(worktree, 'uncommitted.ts'), 'draft\n');
  await mkdir(path.join(tempRoot, 'outside'), { recursive: true });
  await writeFile(path.join(tempRoot, 'outside', 'secret.txt'), 'outside the project\n');
  await symlink(path.join(tempRoot, 'outside'), path.join(worktree, 'escape'));
  // A file only in the main checkout, uncommitted, for the project-folder diff.
  await writeFile(path.join(projectDir, 'folder-draft.ts'), 'draft in folder\n');

  await collections.planItemsDb.insert({ id: 'item-5-008', projectId: project.id, title: '5.008: Quick look', planningRef: { session: 5, task: 8 } } as never);
  worktreeRun = await insertRun(project, { worktreePath: worktree, branch: 'task/5-008', baseBranch: 'main' });
  folderRun = await insertRun(project, { branch: 'main' });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---- Location ----

test('GET quick-look reports a worktree run\'s own working copy with its branch and base, never the path on disk', async () => {
  const res = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { kind: 'worktree', branch: 'task/5-008', baseBranch: 'main' });
});

test('GET quick-look reports a run without a separate branch as the project folder', async () => {
  const res = await api(`/api/workflow-runs/${folderRun.id}/quick-look`);
  assert.deepEqual(res.body, { kind: 'project-folder', branch: 'main', baseBranch: null });
});

test('GET quick-look reports removed for a cleared worktree and for one whose directory is gone', async () => {
  const cleared = await insertRun(project, { branch: 'task/5-008', baseBranch: 'main', status: 'completed' });
  assert.deepEqual((await api(`/api/workflow-runs/${cleared.id}/quick-look`)).body, { kind: 'removed', branch: 'task/5-008', baseBranch: 'main' });
  const gone = await insertRun(project, { worktreePath: path.join(projectService.projectWorktreesRoot(project), 'gone'), branch: 'task/5-008', baseBranch: 'main' });
  const res = await api(`/api/workflow-runs/${gone.id}/quick-look`);
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'removed');
});

test('GET quick-look 404s an unknown run and refuses a worktree path outside the project', async () => {
  assert.equal((await api('/api/workflow-runs/nope/quick-look')).status, 404);
  const tampered = await insertRun(project, { worktreePath: path.join(tempRoot, 'outside'), branch: 'x', baseBranch: 'main' });
  for (const route of ['', '/code/tree', '/docs/tree', '/diff']) {
    assert.equal((await api(`/api/workflow-runs/${tampered.id}/quick-look${route}`)).status, 400, route);
  }
});

// ---- Code ----

test('the code tree lists the worktree\'s files, not the main checkout\'s, without .git', async () => {
  const res = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/tree`);
  assert.equal(res.status, 200);
  assert.ok(res.body.files.includes('worktree-only.ts'));
  assert.ok(res.body.files.includes('uncommitted.ts'), 'untracked files are listed');
  assert.ok(!res.body.files.includes('folder-draft.ts'), 'an uncommitted file in the main checkout is not in the worktree');
  assert.ok(!res.body.files.some((file: string) => file === '.git' || file.startsWith('.git/')));
});

test('a code file is read from the worktree; a missing file 404s and a blank path 400s', async () => {
  const res = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/file?path=a.ts`);
  assert.deepEqual(res.body, { path: 'a.ts', kind: 'text', content: 'one\ntwo\n' });
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/file?path=logo.png`)).body.kind, 'binary');
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/file?path=missing.ts`)).status, 404);
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/file?path=`)).status, 400);
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/file`)).status, 400);
});

test('code reads refuse every path that escapes the worktree, including into the main checkout and through a symlink', async () => {
  const escapes = [
    '../x',
    '../../etc/passwd',
    '/etc/passwd',
    '..%2F..%2Fetc%2Fpasswd',
    `../../${project.slug}/main-secret.txt`,
    'escape/secret.txt',
  ];
  for (const requested of escapes) {
    const res = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/file?path=${requested.includes('%') ? requested : encodeURIComponent(requested)}`);
    assert.equal(res.status, 400, requested);
    assert.equal(res.body.content, undefined, 'no file content is returned');
  }
});

test('code reads refuse anything under .git, whatever its case or depth', async () => {
  for (const requested of ['.git', '.git/config', '.GIT/HEAD', 'sub/.git/x', 'sub\\.Git\\x']) {
    const res = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/file?path=${encodeURIComponent(requested)}`);
    assert.equal(res.status, 400, requested);
  }
});

test('quick look has no write routes', async () => {
  for (const [method, route] of [['POST', 'code/entries'], ['PUT', 'code/file'], ['DELETE', 'code/file'], ['PUT', 'docs/file'], ['POST', 'docs/entries']] as const) {
    const res = await fetch(`${baseUrl}/api/workflow-runs/${worktreeRun.id}/quick-look/${route}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'new.ts', type: 'file', content: 'x' }) });
    assert.equal(res.status, 404, `${method} ${route}`);
  }
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/code/file?path=new.ts`)).status, 404);
});

test('a run without a separate branch reads code and docs from the project folder', async () => {
  const tree = await api(`/api/workflow-runs/${folderRun.id}/quick-look/code/tree`);
  assert.ok(tree.body.files.includes('folder-draft.ts'));
  assert.ok(!tree.body.files.includes('worktree-only.ts'));
  const doc = await api(`/api/workflow-runs/${folderRun.id}/quick-look/docs/file?path=blueprint.md`);
  assert.equal(doc.body.content, '# Main blueprint\n');
});

// ---- Documents ----

test('the docs tree and a docs file come from the worktree\'s .docs folder', async () => {
  const tree = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/docs/tree`);
  assert.ok(tree.body.files.includes('task-notes.md'));
  assert.ok(tree.body.files.includes('blueprint.md'));
  const file = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/docs/file?path=task-notes.md`);
  assert.deepEqual(file.body, { path: 'task-notes.md', kind: 'text', content: '# Task notes\n' });
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/docs/file?path=nope.md`)).status, 404);
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/docs/file?path=`)).status, 400);
});

test('docs reads stay inside .docs: escaping to the worktree root or further is refused', async () => {
  for (const requested of ['../a.ts', '../../../etc/passwd', '/etc/passwd']) {
    assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/docs/file?path=${encodeURIComponent(requested)}`)).status, 400, requested);
  }
});

test('a worktree without a .docs folder has an empty docs tree', async () => {
  const bare = path.join(projectService.projectWorktreesRoot(project), 'bare');
  await mkdir(bare, { recursive: true });
  const run = await insertRun(project, { worktreePath: bare, branch: 'task/bare', baseBranch: 'main' });
  assert.deepEqual((await api(`/api/workflow-runs/${run.id}/quick-look/docs/tree`)).body, { files: [], folders: [] });
});

// ---- Diff ----

test('the diff of a worktree run lists the branch\'s changes since its base, uncommitted work included', async () => {
  const res = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/diff`);
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'worktree');
  assert.equal(res.body.base, 'main');
  assert.equal(res.body.branch, 'task/5-008');
  const byPath = Object.fromEntries(res.body.files.map((file: { path: string }) => [file.path, file]));
  assert.equal(byPath['a.ts'].status, 'modified');
  assert.equal(byPath['a.ts'].additions, 1);
  assert.equal(byPath['worktree-only.ts'].status, 'added');
  assert.equal(byPath['logo.png'].binary, true);
  assert.equal(byPath['uncommitted.ts'].untracked, true);
  assert.equal(byPath['main-secret.txt'], undefined);
  assert.deepEqual(res.body.files.map((file: { path: string }) => file.path), [...res.body.files.map((file: { path: string }) => file.path)].sort((a: string, b: string) => a.localeCompare(b)));
});

test('one file\'s diff is its unified diff; binary files, unchanged paths and blank paths are handled', async () => {
  const text = await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/diff/file?path=a.ts`);
  assert.equal(text.body.kind, 'text');
  assert.match(text.body.diff, /^\+two$/m);
  assert.deepEqual((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/diff/file?path=logo.png`)).body, { path: 'logo.png', kind: 'binary' });
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/diff/file?path=${encodeURIComponent('../main-secret.txt')}`)).status, 404);
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/diff/file?path=${encodeURIComponent('--output=/tmp/x')}`)).status, 404);
  assert.equal((await api(`/api/workflow-runs/${worktreeRun.id}/quick-look/diff/file?path=`)).status, 400);
});

test('a run without a separate branch diffs uncommitted changes in the project folder against HEAD', async () => {
  const res = await api(`/api/workflow-runs/${folderRun.id}/quick-look/diff`);
  assert.equal(res.body.source, 'project-folder');
  assert.equal(res.body.base, null);
  assert.deepEqual(res.body.files.map((file: { path: string }) => file.path), ['folder-draft.ts']);
});

test('a repository-less project\'s diff is a clear 409, not a 500', async () => {
  const bare = await projectService.createProject({ name: 'No Repo', position: null });
  const run = await insertRun(bare, {});
  const res = await api(`/api/workflow-runs/${run.id}/quick-look/diff`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no git repository/);
});

test('after the worktree is removed, code and docs answer 410 while the diff still works from the kept branch', async () => {
  const removed = await insertRun(project, { branch: 'task/5-008', baseBranch: 'main', status: 'completed' });
  for (const route of ['code/tree', 'code/file?path=a.ts', 'docs/tree', 'docs/file?path=blueprint.md']) {
    const res = await api(`/api/workflow-runs/${removed.id}/quick-look/${route}`);
    assert.equal(res.status, 410, route);
    assert.equal(res.body.error, 'The task\'s working copy has been removed');
  }
  const diff = await api(`/api/workflow-runs/${removed.id}/quick-look/diff`);
  assert.equal(diff.body.source, 'branch');
  assert.deepEqual(diff.body.files.map((file: { path: string }) => file.path), ['.docs/task-notes.md', 'a.ts', 'logo.png', 'worktree-only.ts'], 'the committed branch, without the worktree\'s uncommitted file');
  const file = await api(`/api/workflow-runs/${removed.id}/quick-look/diff/file?path=worktree-only.ts`);
  assert.match(file.body.diff, /^\+task work$/m);
});

test('a removed worktree whose branch is gone too answers 410 for the diff', async () => {
  const run = await insertRun(project, { branch: 'task/deleted', baseBranch: 'main', status: 'completed' });
  assert.equal((await api(`/api/workflow-runs/${run.id}/quick-look/diff`)).status, 410);
  const noBase = await insertRun(project, { branch: 'task/5-008', baseBranch: 'deleted-base', status: 'completed' });
  assert.equal((await api(`/api/workflow-runs/${noBase.id}/quick-look/diff`)).status, 410);
});

// ---- Commands ----

test('a saved command run with a workflowRunId runs in the worktree and records a task location', async () => {
  const command = await commandService.createCommand({ projectId: project.id, name: 'Where', command: 'pwd -P' });
  const started = await post(`/api/commands/${command.id}/run`, { workflowRunId: worktreeRun.id });
  assert.equal(started.status, 201);
  assert.deepEqual(started.body.location, { kind: 'task', workflowRunId: worktreeRun.id, planItemId: 'item-5-008', branch: 'task/5-008', taskRef: '5.008' });
  const settled = await settledRun(started.body.id);
  assert.equal(settled.output.trim(), await realpath(worktree));
  assert.deepEqual(settled.location, started.body.location);
});

test('without a workflowRunId a command still runs in the project folder with a main location', async () => {
  const command = await commandService.createCommand({ projectId: project.id, name: 'Where main', command: 'pwd -P' });
  const started = await post(`/api/commands/${command.id}/run`, {});
  assert.deepEqual(started.body.location, { kind: 'main' });
  assert.equal((await settledRun(started.body.id)).output.trim(), await realpath(projectDir));
});

test('a custom command with a workflowRunId runs in the worktree too', async () => {
  const started = await post(`/api/projects/${project.id}/commands/run-adhoc`, { command: 'pwd -P', workflowRunId: worktreeRun.id });
  assert.equal(started.status, 201);
  assert.equal(started.body.origin, 'adhoc');
  assert.equal(started.body.location.kind, 'task');
  assert.equal((await settledRun(started.body.id)).output.trim(), await realpath(worktree));
  assert.equal((await post(`/api/projects/${project.id}/commands/run-adhoc`, { workflowRunId: worktreeRun.id })).status, 400);
});

test('a run without a separate branch runs commands in the project folder, recorded as main', async () => {
  const command = await commandService.createCommand({ projectId: project.id, name: 'Where folder', command: 'pwd -P' });
  const started = await post(`/api/commands/${command.id}/run`, { workflowRunId: folderRun.id });
  assert.deepEqual(started.body.location, { kind: 'main' });
  assert.equal((await settledRun(started.body.id)).output.trim(), await realpath(projectDir));
});

test('a saved command runs one instance at a time wherever it runs; after a stop it can run in the task', async () => {
  const command = await commandService.createCommand({ projectId: project.id, name: 'Server', command: 'sleep 30' });
  const inMain = await post(`/api/commands/${command.id}/run`, {});
  assert.equal(inMain.status, 201);
  const refused = await post(`/api/commands/${command.id}/run`, { workflowRunId: worktreeRun.id });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already running/);
  await post(`/api/command-runs/${inMain.body.id}/stop`, {});

  const inTask = await post(`/api/commands/${command.id}/run`, { workflowRunId: worktreeRun.id });
  assert.equal(inTask.status, 201);
  assert.equal((await post(`/api/commands/${command.id}/run`, {})).status, 409, 'the reverse order is refused the same way');
  const running = await api(`/api/projects/${project.id}/command-runs?status=running`);
  assert.ok(running.body.some((run: CommandRunRecord) => run.id === inTask.body.id && run.location?.kind === 'task'));
  await post(`/api/command-runs/${inTask.body.id}/stop`, {});
});

test('two different saved commands can run at once, one in main and one in the task', async () => {
  const first = await commandService.createCommand({ projectId: project.id, name: 'Watch A', command: 'sleep 30' });
  const second = await commandService.createCommand({ projectId: project.id, name: 'Watch B', command: 'sleep 30' });
  const a = await post(`/api/commands/${first.id}/run`, {});
  const b = await post(`/api/commands/${second.id}/run`, { workflowRunId: worktreeRun.id });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  await post(`/api/command-runs/${a.body.id}/stop`, {});
  await post(`/api/command-runs/${b.body.id}/stop`, {});
});

test('a removed working copy refuses a command with 410 and records no run', async () => {
  const removed = await insertRun(project, { branch: 'task/5-008', baseBranch: 'main', status: 'completed' });
  const command = await commandService.createCommand({ projectId: project.id, name: 'Never', command: 'echo never' });
  const before = (await api(`/api/projects/${project.id}/command-runs`)).body.length;
  const res = await post(`/api/commands/${command.id}/run`, { workflowRunId: removed.id });
  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'The task\'s working copy has been removed');
  assert.equal((await post(`/api/projects/${project.id}/commands/run-adhoc`, { command: 'echo never', workflowRunId: removed.id })).status, 410);
  assert.equal((await api(`/api/projects/${project.id}/command-runs`)).body.length, before);
});

test('an unknown, malformed or other-project workflowRunId is refused and nothing runs', async () => {
  const command = await commandService.createCommand({ projectId: project.id, name: 'Guarded', command: 'echo guarded' });
  const before = (await api(`/api/projects/${project.id}/command-runs`)).body.length;
  assert.equal((await post(`/api/commands/${command.id}/run`, { workflowRunId: 'nope' })).status, 404);
  assert.equal((await post(`/api/commands/${command.id}/run`, { workflowRunId: 42 })).status, 400);
  const other = await projectService.createProject({ name: 'Other', position: null });
  const otherRun = await insertRun(other, {});
  assert.equal((await post(`/api/commands/${command.id}/run`, { workflowRunId: otherRun.id })).status, 400);
  assert.equal((await post(`/api/projects/${project.id}/commands/run-adhoc`, { command: 'echo x', workflowRunId: otherRun.id })).status, 400);
  assert.equal((await api(`/api/projects/${project.id}/command-runs`)).body.length, before);
});
