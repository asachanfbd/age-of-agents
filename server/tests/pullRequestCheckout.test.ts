import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import type { ProjectRecord, TaskRecord } from '../src/domain/types.ts';
import { startPullRequestHarness, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/**
 * Integration cases SI1 to SI27: the PR tab's Check out and Return, over HTTP, with real git against
 * a local bare remote and a scripted `gh`. Each test uses its own Project (its own clone) and its own
 * PR number, so the shared remote never needs resetting.
 */

let h: PullRequestHarness;

before(async () => { h = await startPullRequestHarness('pr-checkout-'); });
after(async () => { await h.close(); });

const cwdOf = (project: ProjectRecord) => h.projectService.projectAbsolutePath(project);
const head = (project: ProjectRecord, ref = 'HEAD') => git(cwdOf(project), ['rev-parse', ref]);
const branchOf = (project: ProjectRecord) => git(cwdOf(project), ['symbolic-ref', '--short', 'HEAD']);
const checkout = (project: ProjectRecord, number: number | string) => h.api(`/api/projects/${project.id}/pull-requests/${number}/checkout`, { method: 'POST' });
const goBack = (project: ProjectRecord, body: object = {}) => h.api(`/api/projects/${project.id}/pull-requests/return`, { method: 'POST', body: JSON.stringify(body) });

/** A Task record as the folder guard reads it — see `.docs/testing.md` ("Simulating a genuinely-live folder Task"). */
async function insertTask(project: ProjectRecord, overrides: Partial<TaskRecord>): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), projectId: project.id, templateId: 'software-engineer', executorId: 'test-claude-cli', executionMode: 'terminal',
    description: 'work', status: 'developing', autonomy: 'auto', manager: false, kind: 'execute', planItemId: null, sessionId: null,
    runtimeStatus: 'starting', runtimeWaitingReason: null, runtimeStatusChangedAt: now, blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  } as unknown as TaskRecord;
  await h.collections.tasksDb.insert(task);
  const ids = [...((await h.projectService.getProject(project.id)).activeTaskIds ?? []), task.id];
  await h.projectService.patchProject(project.id, { activeTaskIds: ids, activeTaskId: task.id });
  return task;
}

async function releaseTask(project: ProjectRecord, task: TaskRecord): Promise<void> {
  await h.collections.tasksDb.delete(task.id);
  await h.projectService.patchProject(project.id, { activeTaskIds: [], activeTaskId: null });
}

test('SI1 a branch not present locally is fetched, created and switched to at the PR head', async () => {
  const project = await h.createProject('SI1');
  const sha = await h.publishPullRequest({ number: 101, branch: 'feature/si1', files: { 'si1.txt': 'one' } });
  const res = await checkout(project, 101);
  assert.equal(res.status, 200);
  assert.equal(await branchOf(project), 'feature/si1');
  assert.equal(await head(project), sha);
  assert.equal(await readFile(path.join(cwdOf(project), 'si1.txt'), 'utf8'), 'one');
});

test('SI2 an existing local branch that is behind is switched to and fast-forwarded to the PR head', async () => {
  const project = await h.createProject('SI2');
  const first = await h.publishPullRequest({ number: 102, branch: 'feature/si2', files: { 'si2.txt': 'one' } });
  await git(cwdOf(project), ['fetch', '--quiet', 'origin']);
  await git(cwdOf(project), ['branch', 'feature/si2', first]);
  const second = await h.publishPullRequest({ number: 102, branch: 'feature/si2', files: { 'si2.txt': 'one', 'si2b.txt': 'two' }, from: 'feature/si2' });
  await h.gh.setPull(102, { headRefName: 'feature/si2', headRef: { name: 'feature/si2' }, headRefOid: second });
  assert.notEqual(first, second);
  assert.equal((await checkout(project, 102)).status, 200);
  assert.equal(await branchOf(project), 'feature/si2');
  assert.equal(await head(project), second);
});

test('SI3 an existing local branch already at the PR head is just switched to', async () => {
  const project = await h.createProject('SI3');
  const sha = await h.publishPullRequest({ number: 103, branch: 'feature/si3', files: { 'si3.txt': 'one' } });
  await git(cwdOf(project), ['fetch', '--quiet', 'origin']);
  await git(cwdOf(project), ['branch', 'feature/si3', sha]);
  assert.equal((await checkout(project, 103)).status, 200);
  assert.equal(await branchOf(project), 'feature/si3');
  assert.equal(await head(project), sha);
});

test('SI4 a diverged local branch is refused with 409, and the current branch, the local branch and the files are untouched', async () => {
  const project = await h.createProject('SI4');
  await h.publishPullRequest({ number: 104, branch: 'feature/si4', files: { 'si4.txt': 'theirs' } });
  const cwd = cwdOf(project);
  await git(cwd, ['switch', '-c', 'feature/si4']);
  await writeFile(path.join(cwd, 'mine.txt'), 'mine');
  await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'local work']);
  const localTip = await head(project);
  await git(cwd, ['switch', 'main']);
  const mainTip = await head(project);

  const res = await checkout(project, 104);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /local branch "feature\/si4" has commits that pull request #104 doesn't have/);
  assert.match(res.body.error, /Nothing was changed/);
  assert.equal(await branchOf(project), 'main');
  assert.equal(await head(project), mainTip);
  assert.equal(await head(project, 'refs/heads/feature/si4'), localTip);
  assert.equal(await git(cwd, ['status', '--porcelain', '--untracked-files=no']), '');
  assert.equal((await h.projectService.getProject(project.id)).prCheckout ?? null, null);
});

test('SI5 a local branch that is only ahead is switched to with its unpushed commits kept', async () => {
  const project = await h.createProject('SI5');
  const sha = await h.publishPullRequest({ number: 105, branch: 'feature/si5', files: { 'si5.txt': 'one' } });
  const cwd = cwdOf(project);
  await git(cwd, ['fetch', '--quiet', 'origin']);
  await git(cwd, ['switch', '-c', 'feature/si5', sha]);
  await writeFile(path.join(cwd, 'unpushed.txt'), 'mine');
  await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'unpushed']);
  const localTip = await head(project);
  await git(cwd, ['switch', 'main']);

  assert.equal((await checkout(project, 105)).status, 200);
  assert.equal(await branchOf(project), 'feature/si5');
  assert.equal(await head(project), localTip);
  assert.equal(await readFile(path.join(cwd, 'unpushed.txt'), 'utf8'), 'mine');
});

test('SI6 uncommitted tracked changes refuse the checkout with "commit or discard", and nothing is switched', async () => {
  const project = await h.createProject('SI6');
  await h.publishPullRequest({ number: 106, branch: 'feature/si6', files: { 'si6.txt': 'one' } });
  await writeFile(path.join(cwdOf(project), 'README.md'), 'edited locally');
  await h.gh.clearCalls();
  const res = await checkout(project, 106);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Commit or discard local changes/);
  assert.equal(await branchOf(project), 'main');
  assert.equal(await readFile(path.join(cwdOf(project), 'README.md'), 'utf8'), 'edited locally');
  assert.deepEqual(await h.gh.calls(), [], 'refused before asking the provider anything');
});

test('SI7 untracked files alone do not block the checkout, as with the branch switcher', async () => {
  const project = await h.createProject('SI7');
  await h.publishPullRequest({ number: 107, branch: 'feature/si7', files: { 'si7.txt': 'one' } });
  await writeFile(path.join(cwdOf(project), 'scratch.txt'), 'untracked');
  assert.equal((await checkout(project, 107)).status, 200);
  assert.equal(await branchOf(project), 'feature/si7');
  assert.equal(await readFile(path.join(cwdOf(project), 'scratch.txt'), 'utf8'), 'untracked');
});

test('SI8 a live coding task in the Project folder refuses the checkout with the folder-busy 409', async () => {
  const project = await h.createProject('SI8');
  await h.publishPullRequest({ number: 108, branch: 'feature/si8', files: { 'si8.txt': 'one' } });
  const task = await insertTask(project, { branch: 'main' });
  const res = await checkout(project, 108);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Work is already running in project "SI8"'s own folder/);
  assert.equal(await branchOf(project), 'main');
  await releaseTask(project, task);
});

test('SI9 a planning session, or a task isolated in its own worktree, does not block the checkout', async () => {
  const project = await h.createProject('SI9');
  await h.publishPullRequest({ number: 109, branch: 'feature/si9', files: { 'si9.txt': 'one' } });
  const planning = await insertTask(project, { kind: 'plan' });
  const isolated = await insertTask(project, { worktreePath: path.join(h.root, 'elsewhere'), branch: 'task/x' });
  assert.equal((await checkout(project, 109)).status, 200);
  assert.equal(await branchOf(project), 'feature/si9');
  await h.collections.tasksDb.delete(planning.id);
  await releaseTask(project, isolated);
});

test('SI10 a fork PR checks out the fork\'s commit under a PR-specific local name, not a same-named branch on origin', async () => {
  const project = await h.createProject('SI10');
  // The fork's head branch is called "main", like origin's own default branch, but holds other commits.
  const forkSha = await h.publishPullRequest({ number: 110, branch: 'main', files: { 'fork.txt': 'from the fork' }, fork: true });
  const originMain = await git(h.remote, ['rev-parse', 'refs/heads/main']);
  assert.notEqual(forkSha, originMain);

  const res = await checkout(project, 110);
  assert.equal(res.status, 200);
  assert.equal(await branchOf(project), 'pr-110/main');
  assert.equal(await head(project), forkSha);
  assert.equal(await readFile(path.join(cwdOf(project), 'fork.txt'), 'utf8'), 'from the fork');
  assert.equal(await head(project, 'refs/heads/main'), originMain, 'the local main was not overwritten');
  assert.equal(res.body.prCheckout.branch, 'pr-110/main');
});

test('SI11 a deleted head branch or an unavailable fork refuses the checkout with the reason, and the merge state says so', async () => {
  const project = await h.createProject('SI11');
  await h.publishPullRequest({ number: 111, branch: 'feature/si11', files: { 'si11.txt': 'one' }, pullRequest: { headRef: null } });
  const deleted = await checkout(project, 111);
  assert.equal(deleted.status, 409);
  assert.match(deleted.body.error, /The branch of pull request #111 no longer exists/);
  assert.equal(await branchOf(project), 'main');
  const state = await h.api(`/api/projects/${project.id}/pull-requests/111/merge-state`);
  assert.equal(state.body.mergeState.headBranchExists, false);
  assert.equal(state.body.mergeState.status, 'unmergeable');

  await h.publishPullRequest({ number: 112, branch: 'patch-1', files: { 'gone.txt': 'x' }, fork: true, pullRequest: { headRepository: null } });
  assert.equal((await checkout(project, 112)).status, 409);
  assert.equal((await h.api(`/api/projects/${project.id}/pull-requests/112/merge-state`)).body.mergeState.headBranchExists, false);

  // The provider says the branch exists but its head ref can't be fetched any more.
  await h.gh.setPull(113, { headRefName: 'vanished', headRef: { name: 'vanished' } });
  const vanished = await checkout(project, 113);
  assert.equal(vanished.status, 409);
  assert.match(vanished.body.error, /no longer exists/);
});

test('SI12 a conflicting PR is checked out exactly at its head: clean tree, no conflict markers', async () => {
  const project = await h.createProject('SI12');
  const sha = await h.publishPullRequest({
    number: 114, branch: 'feature/si12', files: { 'shared.txt': 'the PR changed this line\n' },
    pullRequest: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
  });
  assert.equal((await checkout(project, 114)).status, 200);
  assert.equal(await head(project), sha);
  assert.equal(await git(cwdOf(project), ['status', '--porcelain', '--untracked-files=no']), '');
  assert.equal(await readFile(path.join(cwdOf(project), 'shared.txt'), 'utf8'), 'the PR changed this line\n', 'the PR\'s own content, with no conflict markers');
});

test('SI13 and SI14 checkout only reads and fetches: no push, no merge commit, no provider write, no task and no run', async () => {
  const project = await h.createProject('SI13');
  const sha = await h.publishPullRequest({ number: 115, branch: 'feature/si13', files: { 'si13.txt': 'one' } });
  const remoteBefore = await git(h.remote, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const tasksBefore = (await h.collections.tasksDb.all()).length;
  const runsBefore = (await h.collections.workflowRunsDb.all()).length;
  const itemsBefore = (await h.collections.planItemsDb.all()).length;
  await h.gh.clearCalls();

  assert.equal((await checkout(project, 115)).status, 200);

  assert.equal(await git(h.remote, ['for-each-ref', '--format=%(refname) %(objectname)']), remoteBefore, 'nothing was pushed');
  assert.equal(await head(project), sha, 'no merge commit was made');
  const calls = await h.gh.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(0, 2), ['api', 'graphql'], 'the only provider call is the merge-state read');
  assert.equal((await h.collections.tasksDb.all()).length, tasksBefore);
  assert.equal((await h.collections.workflowRunsDb.all()).length, runsBefore);
  assert.equal((await h.collections.planItemsDb.all()).length, itemsBefore);
  assert.equal(h.terminal.starts.length, 0, 'no agent session was started');
});

test('SI15 paused primary-folder tasks keep their own branch through Check out and Return, as with any switch to an existing branch', async () => {
  const project = await h.createProject('SI15');
  await h.publishPullRequest({ number: 116, branch: 'feature/si15', files: { 'si15.txt': 'one' } });
  // A paused in-folder task: not live (so the folder is free), but still unsettled and on `main`.
  const paused = await insertTask(project, { status: 'stopped', runtimeStatus: 'paused' as TaskRecord['runtimeStatus'], branch: 'main' });
  await h.projectService.patchProject(project.id, { activeTaskIds: [], activeTaskId: null });
  const isolated = await insertTask(project, { status: 'stopped', worktreePath: path.join(h.root, 'wt'), branch: 'main' });
  await h.projectService.patchProject(project.id, { activeTaskIds: [], activeTaskId: null });

  assert.equal((await checkout(project, 116)).status, 200);
  assert.equal(await branchOf(project), 'feature/si15');
  // Moving it would let a later resume commit and push its work onto the pull request's branch.
  assert.equal((await h.collections.tasksDb.get(paused.id))!.branch, 'main');
  assert.equal((await h.collections.tasksDb.get(isolated.id))!.branch, 'main');

  assert.equal((await goBack(project)).status, 200);
  assert.equal((await h.collections.tasksDb.get(paused.id))!.branch, 'main');
  assert.equal((await h.collections.tasksDb.get(isolated.id))!.branch, 'main');
});

test('SI16 and SI17 the response and the Project record carry the PR, the previous branch and a fresh sync reading', async () => {
  const project = await h.createProject('SI16');
  await h.publishPullRequest({ number: 117, branch: 'feature/si16', files: { 'si16.txt': 'one' } });
  const res = await checkout(project, 117);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.prCheckout, { number: 117, branch: 'feature/si16', previousBranch: 'main' });
  assert.equal(res.body.sync.branch, 'feature/si16');
  assert.equal(res.body.sync.status, 'synced');

  const read = await h.api(`/api/projects/${project.id}`);
  assert.deepEqual(read.body.prCheckout, { number: 117, branch: 'feature/si16', previousBranch: 'main' });
  assert.equal(read.body.sync.branch, 'feature/si16');
  assert.equal((await h.api(`/api/projects/${project.id}/branches`)).body.current, 'feature/si16');
});

test('SI18 network, auth and git failures answer with the reason and leave the branch alone', async () => {
  const project = await h.createProject('SI18');
  await h.publishPullRequest({ number: 118, branch: 'feature/si18', files: { 'si18.txt': 'one' } });

  await h.gh.patch({ fail: { read: 'error connecting to api.github.com: dial tcp: i/o timeout' } });
  const network = await checkout(project, 118);
  assert.equal(network.status, 502);
  assert.equal(network.body.error, 'Could not reach GitHub.');

  await h.gh.patch({ fail: { read: 'To get started with GitHub CLI, please run:  gh auth login' } });
  const auth = await checkout(project, 118);
  assert.equal(auth.status, 502);
  assert.equal(auth.body.error, 'GitHub CLI is not signed in.');
  await h.gh.patch({ fail: {} });

  // The remote disappears between the read and the fetch.
  await git(cwdOf(project), ['remote', 'set-url', 'origin', path.join(h.root, 'no-such-remote')]);
  const gitFailure = await checkout(project, 118);
  assert.equal(gitFailure.status, 502);
  assert.match(gitFailure.body.error, /no-such-remote|not appear to be a git repository|does not exist/);

  assert.equal(await branchOf(project), 'main');
  assert.equal((await h.projectService.getProject(project.id)).prCheckout ?? null, null);
});

test('SI19 a second checkout while one is in flight for the same Project is refused as busy (409)', async () => {
  const project = await h.createProject('SI19');
  await h.publishPullRequest({ number: 119, branch: 'feature/si19', files: { 'si19.txt': 'one' } });
  const [first, second] = await Promise.all([checkout(project, 119), checkout(project, 119)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const refused = first.status === 409 ? first : second;
  assert.match(refused.body.error, /Another merge or checkout is in progress/);
  assert.equal(await branchOf(project), 'feature/si19');
});

test('SI20 a checkout while a merge of any PR in the same Project is in flight is refused as busy (409)', async () => {
  const project = await h.createProject('SI20');
  await h.publishPullRequest({ number: 120, branch: 'feature/si20', files: { 'si20.txt': 'one' } });
  await h.publishPullRequest({ number: 121, branch: 'feature/si20b', files: { 'si20b.txt': 'one' } });
  await h.gh.patch({ mergeDelayMs: 400 });
  const merging = h.api(`/api/projects/${project.id}/pull-requests/121/merge`, { method: 'POST', body: '{}' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const res = await checkout(project, 120);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Another merge or checkout is in progress/);
  assert.equal((await merging).status, 200);
  await h.gh.patch({ mergeDelayMs: 0 });
  assert.equal((await checkout(project, 120)).status, 200, 'free again once the merge has finished');
});

test('SI21 unknown Project or PR is 404, a Project with no repository 400, and a closed or merged PR is refused saying so', async () => {
  assert.equal((await h.api('/api/projects/nope/pull-requests/1/checkout', { method: 'POST' })).status, 404);
  const bare = await h.projectService.createProject({ name: 'SI21 bare', position: null });
  const noRepo = await checkout(bare, 1);
  assert.equal(noRepo.status, 400);
  assert.match(noRepo.body.error, /no linked repository/);
  assert.equal((await goBack(bare)).status, 400);
  assert.equal((await h.api(`/api/projects/${bare.id}/pull-requests/1/merge-state`)).status, 400);
  assert.equal((await h.api(`/api/projects/${bare.id}/pull-requests/1/merge`, { method: 'POST', body: '{}' })).status, 400);

  const project = await h.createProject('SI21');
  assert.equal((await checkout(project, 99999)).status, 404, 'no such pull request');
  await h.publishPullRequest({ number: 122, branch: 'feature/si21', files: { 'si21.txt': 'one' }, pullRequest: { state: 'CLOSED' } });
  const closed = await checkout(project, 122);
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, 'This PR is closed, so it can\'t be checked out.');
  await h.gh.setPull(122, { state: 'MERGED' });
  const merged = await checkout(project, 122);
  assert.deepEqual([merged.status, merged.body.error], [409, 'This PR is already merged, so it can\'t be checked out.']);
  assert.equal(await branchOf(project), 'main');
});

test('SI22 a non-numeric, zero or negative PR number is a 400 that never reaches git or gh', async () => {
  const project = await h.createProject('SI22');
  await h.gh.clearCalls();
  for (const bad of ['abc', '-3', '0', '1.5', '12;rm', '99999999999']) {
    for (const action of ['checkout', 'merge']) {
      const res = await h.api(`/api/projects/${project.id}/pull-requests/${encodeURIComponent(bad)}/${action}`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 400, `${action} ${bad}`);
      assert.match(res.body.error, /positive whole number/);
    }
    assert.equal((await h.api(`/api/projects/${project.id}/pull-requests/${encodeURIComponent(bad)}/merge-state`)).status, 400);
  }
  assert.deepEqual(await h.gh.calls(), []);
  assert.equal(await branchOf(project), 'main');
});

// ---- Return ----

test('SI23 Return switches back to the remembered branch and clears the checked-out state', async () => {
  const project = await h.createProject('SI23');
  await h.publishPullRequest({ number: 123, branch: 'feature/si23', files: { 'si23.txt': 'one' } });
  await checkout(project, 123);
  const res = await goBack(project);
  assert.equal(res.status, 200);
  assert.equal(await branchOf(project), 'main');
  assert.equal(res.body.prCheckout, null);
  assert.equal(res.body.sync.branch, 'main');
  assert.equal((await h.projectService.getProject(project.id)).prCheckout, null);

  const again = await goBack(project);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /no pull request checked out/);
});

test('SI24 Return with a dirty tree or a busy folder gets the same refusals, and stays on the PR branch', async () => {
  const project = await h.createProject('SI24');
  await h.publishPullRequest({ number: 124, branch: 'feature/si24', files: { 'si24.txt': 'one' } });
  await checkout(project, 124);

  await writeFile(path.join(cwdOf(project), 'si24.txt'), 'edited');
  const dirty = await goBack(project);
  assert.equal(dirty.status, 409);
  assert.match(dirty.body.error, /Commit or discard local changes/);
  await git(cwdOf(project), ['checkout', '--', 'si24.txt']);

  const task = await insertTask(project, { branch: 'feature/si24' });
  const busy = await goBack(project);
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /Work is already running/);
  await releaseTask(project, task);

  assert.equal(await branchOf(project), 'feature/si24');
  assert.equal((await h.projectService.getProject(project.id)).prCheckout?.number, 124);
  assert.equal((await goBack(project)).status, 200);
});

test('SI25 a previous branch that no longer exists is a 409 naming it and offering the default branch, which then works', async () => {
  const project = await h.createProject('SI25');
  const cwd = cwdOf(project);
  await git(cwd, ['switch', '-c', 'scratch']);
  await h.publishPullRequest({ number: 125, branch: 'feature/si25', files: { 'si25.txt': 'one' } });
  assert.equal((await checkout(project, 125)).body.prCheckout.previousBranch, 'scratch');
  await git(cwd, ['branch', '-D', 'scratch']);

  const gone = await goBack(project);
  assert.equal(gone.status, 409);
  assert.match(gone.body.error, /The branch "scratch" you were on before no longer exists\. Return to "main" instead\./);
  assert.equal(gone.body.defaultBranch, 'main');
  assert.equal(await branchOf(project), 'feature/si25');

  const elsewhere = await goBack(project, { branch: 'feature/si25' });
  assert.equal(elsewhere.status, 409, 'Return only goes to the previous or the default branch');
  assert.equal((await goBack(project, { branch: 42 })).status, 400);

  const viaDefault = await goBack(project, { branch: 'main' });
  assert.equal(viaDefault.status, 200);
  assert.equal(await branchOf(project), 'main');
  assert.equal(viaDefault.body.prCheckout, null);
});

test('SI25 with no local record of origin/HEAD the default branch is asked of the remote, not assumed to be main', async () => {
  // A second remote whose default branch is "trunk", used by a Project that was not cloned from it.
  await git(h.root, ['clone', '--quiet', '--bare', h.remote, 'trunk-repo']);
  const trunkRemote = path.join(h.root, 'trunk-repo');
  await git(trunkRemote, ['branch', '-m', 'main', 'trunk']);
  await git(trunkRemote, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  const trunkSha = await git(trunkRemote, ['rev-parse', 'refs/heads/trunk']);
  await git(trunkRemote, ['update-ref', 'refs/heads/feature/trunk-pr', trunkSha]);
  await git(trunkRemote, ['update-ref', 'refs/pull/130/head', trunkSha]);

  const project = await h.createProject('SI25b');
  const cwd = cwdOf(project);
  await git(cwd, ['remote', 'set-url', 'origin', trunkRemote]);
  await git(cwd, ['fetch', '--quiet', 'origin']);
  await git(cwd, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
  await git(cwd, ['switch', '-c', 'scratch', 'origin/trunk']);
  await git(cwd, ['branch', '-D', 'main']);
  await h.gh.setPull(130, { headRefName: 'feature/trunk-pr', headRef: { name: 'feature/trunk-pr' }, headRefOid: trunkSha, baseRefName: 'trunk' }, { defaultBranchRef: { name: 'trunk' } });

  assert.equal((await checkout(project, 130)).body.prCheckout.previousBranch, 'scratch');
  await git(cwd, ['branch', '-D', 'scratch']);
  const gone = await goBack(project);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.defaultBranch, 'trunk');
  assert.match(gone.body.error, /Return to "trunk" instead/);
  const back = await goBack(project, { branch: 'trunk' });
  assert.equal(back.status, 200);
  assert.equal(await branchOf(project), 'trunk');
});

test('SI26 after checking out PR A and then PR B, Return goes to A\'s branch', async () => {
  const project = await h.createProject('SI26');
  await h.publishPullRequest({ number: 126, branch: 'feature/a', files: { 'a.txt': 'a' } });
  await h.publishPullRequest({ number: 127, branch: 'feature/b', files: { 'b.txt': 'b' } });
  await checkout(project, 126);
  const second = await checkout(project, 127);
  assert.deepEqual(second.body.prCheckout, { number: 127, branch: 'feature/b', previousBranch: 'feature/a' });
  assert.equal((await goBack(project)).status, 200);
  assert.equal(await branchOf(project), 'feature/a');
});

test('SI26 checking out the PR whose branch is already current keeps the earlier previous branch', async () => {
  const project = await h.createProject('SI26b');
  await h.publishPullRequest({ number: 128, branch: 'feature/same', files: { 'same.txt': 'x' } });
  await checkout(project, 128);
  const again = await checkout(project, 128);
  assert.deepEqual(again.body.prCheckout, { number: 128, branch: 'feature/same', previousBranch: 'main' });

  // Already on the PR's branch with nothing remembered: Return falls back to the default branch.
  const fresh = await h.createProject('SI26c');
  await git(cwdOf(fresh), ['fetch', '--quiet', 'origin']);
  await git(cwdOf(fresh), ['switch', '-c', 'feature/same', '--track', 'origin/feature/same']);
  assert.deepEqual((await checkout(fresh, 128)).body.prCheckout, { number: 128, branch: 'feature/same', previousBranch: 'main' });
});

test('SI27 switching or creating a branch through the ordinary branch switcher clears the checked-out state', async () => {
  const project = await h.createProject('SI27');
  await h.publishPullRequest({ number: 129, branch: 'feature/si27', files: { 'si27.txt': 'one' } });
  await checkout(project, 129);
  const switched = await h.api(`/api/projects/${project.id}/branches`, { method: 'POST', body: JSON.stringify({ branch: 'main' }) });
  assert.equal(switched.status, 200);
  assert.equal((await h.projectService.getProject(project.id)).prCheckout, null);

  await checkout(project, 129);
  const created = await h.api(`/api/projects/${project.id}/branches`, { method: 'POST', body: JSON.stringify({ branch: 'spin-off', create: true }) });
  assert.equal(created.status, 200);
  assert.equal((await h.projectService.getProject(project.id)).prCheckout, null);
});
