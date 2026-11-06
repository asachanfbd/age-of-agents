import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import type { ProjectRecord } from '../src/domain/types.ts';
import { checksPayload, startPullRequestHarness, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/** Integration cases SI28 to SI41: the PR tab's merge-state and Merge routes over HTTP, with a scripted `gh` and real git. */

let h: PullRequestHarness;
let project: ProjectRecord;

before(async () => {
  h = await startPullRequestHarness('pr-merge-api-');
  project = await h.createProject('Merge');
});
after(async () => { await h.close(); });

const merge = (number: number, body: object = {}, target: ProjectRecord = project) =>
  h.api(`/api/projects/${target.id}/pull-requests/${number}/merge`, { method: 'POST', body: JSON.stringify(body) });
const mergeState = (number: number) => h.api(`/api/projects/${project.id}/pull-requests/${number}/merge-state`);
const list = () => h.api(`/api/projects/${project.id}/open-pull-requests`);
const mergeCalls = () => h.gh.callsTo('pr', 'merge');
const deleteCalls = async () => (await h.gh.calls()).filter((args) => args.includes('DELETE'));

test('the merge-state route answers each class, and an unknown PR is 404', async () => {
  await h.gh.setPull(201);
  await h.gh.setPull(202, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', isDraft: true });
  await h.gh.setPull(203, { state: 'CLOSED' });
  const clean = await mergeState(201);
  assert.equal(clean.status, 200);
  assert.equal(clean.body.number, 201);
  assert.ok(Date.parse(clean.body.checkedAt));
  assert.deepEqual(clean.body.mergeState, {
    number: 201, title: 'Change 201', status: 'clean', blockers: [], warnings: [], reason: null,
    headBranch: 'feature-201', baseBranch: 'main', headBranchExists: true, isFork: false,
  });
  const conflicting = (await mergeState(202)).body.mergeState;
  assert.deepEqual([conflicting.status, conflicting.blockers], ['conflicts', ['This PR is a draft']]);
  assert.deepEqual([(await mergeState(203)).body.mergeState.status, (await mergeState(203)).body.mergeState.reason], ['unmergeable', 'This PR is closed']);
  assert.equal((await mergeState(99999)).status, 404);
  assert.equal((await h.api('/api/projects/nope/pull-requests/201/merge-state')).status, 404);
});

test('SI28 a clean PR merges in one request with a merge commit, and its remote head branch is deleted', async () => {
  await h.gh.setPull(210);
  await h.gh.clearCalls();
  const res = await merge(210);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { outcome: 'merged', branchDeleted: true, branchWarning: null, branchNote: null });
  assert.deepEqual(await mergeCalls(), [['pr', 'merge', '210', '--repo', 'test/repo', '--merge']]);
  assert.deepEqual(await deleteCalls(), [['api', '-X', 'DELETE', 'repos/test/repo/git/refs/heads/feature-210']]);
});

test('SI29 after a merge the list and count no longer include the PR, and the sync reading is refreshed', async () => {
  await h.gh.setPull(211);
  const before = await list();
  assert.ok(before.body.pullRequests.some((pr: { number: number }) => pr.number === 211));
  const syncBefore = h.poller.gitSyncPoller.get(project.id)?.checkedAt ?? '';
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal((await merge(211)).status, 200);

  const afterMerge = await list();
  assert.ok(!afterMerge.body.pullRequests.some((pr: { number: number }) => pr.number === 211));
  assert.equal(afterMerge.body.count, before.body.count - 1);
  const sync = h.poller.gitSyncPoller.get(project.id);
  assert.ok(sync && sync.checkedAt > syncBefore, 'the sync reading was taken again');
  assert.equal((await h.api(`/api/projects/${project.id}`)).body.sync.checkedAt, sync.checkedAt);
});

test('SI30 a blocked PR without confirmation merges nothing and lists each blocker', async () => {
  await h.gh.setPull(212, { isDraft: true, reviewDecision: 'CHANGES_REQUESTED', ...checksPayload([{ name: 'build', state: 'FAILURE', required: true }]) });
  await h.gh.clearCalls();
  const res = await merge(212);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { outcome: 'needs-confirmation', blockers: ['This PR is a draft', 'Checks are failing: build', 'Changes were requested'] });
  assert.deepEqual(await mergeCalls(), []);
  assert.deepEqual((await merge(212, { confirmBlockers: false })).body.outcome, 'needs-confirmation');
});

test('SI31 a blocked PR with confirmation is merged anyway', async () => {
  await h.gh.setPull(213, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual((await merge(213)).body, { outcome: 'needs-confirmation', blockers: ['Merge state is not known yet'] });
  await h.gh.clearCalls();
  const res = await merge(213, { confirmBlockers: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'merged');
  assert.equal((await mergeCalls()).length, 1);
});

test('SI31 "Merge anyway" on a PR the base branch protection blocks merges with the account\'s bypass; a clean merge never asks for it', async () => {
  await h.gh.setPull(232, { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' });
  await h.gh.setPull(233);
  await h.gh.patch({ protectedPulls: [232, 233] });
  await h.gh.clearCalls();

  assert.deepEqual((await merge(232)).body, { outcome: 'needs-confirmation', blockers: ['A review is required'] });
  const confirmed = await merge(232, { confirmBlockers: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.outcome, 'merged');
  assert.deepEqual(await mergeCalls(), [['pr', 'merge', '232', '--repo', 'test/repo', '--merge', '--admin']]);

  // A PR that reads clean is merged plainly even if the caller sends the confirmation flag.
  await h.gh.clearCalls();
  const clean = await merge(233, { confirmBlockers: true });
  assert.equal(clean.status, 502, 'the fake refuses it without --admin, which a clean merge must not send');
  assert.deepEqual(await mergeCalls(), [['pr', 'merge', '233', '--repo', 'test/repo', '--merge']]);
  await h.gh.patch({ protectedPulls: [] });
});

test('SI32 a confirmed merge the provider still refuses answers with its reason, and the PR stays listed', async () => {
  await h.gh.setPull(214, { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' });
  await h.gh.patch({ fail: { merge: 'GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)' } });
  const res = await merge(214, { confirmBlockers: true });
  await h.gh.patch({ fail: {} });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'At least 1 approving review is required by reviewers with write access. (mergePullRequest)');
  assert.ok((await list()).body.pullRequests.some((pr: { number: number }) => pr.number === 214));
  assert.deepEqual(await deleteCalls().then((calls) => calls.filter((args) => args.join(' ').includes('feature-214'))), []);
});

test('SI33 an unmergeable PR is refused with its reason and gh merge is never called', async () => {
  await h.gh.setPull(215, { state: 'CLOSED' });
  await h.gh.setPull(216, { state: 'MERGED' });
  await h.gh.setPull(217, {}, { viewerPermission: 'READ' });
  await h.gh.setPull(218, { headRef: null });
  await h.gh.clearCalls();
  for (const [number, reason] of [[215, 'This PR is closed'], [216, 'This PR is already merged'], [217, 'Your account can\'t merge in this repository'], [218, 'The head branch no longer exists']] as const) {
    const res = await merge(number, { confirmBlockers: true, executorId: 'test-claude-cli' });
    assert.equal(res.status, 409, String(number));
    assert.equal(res.body.error, reason);
  }
  assert.deepEqual(await mergeCalls(), []);
  assert.equal((await merge(99999)).status, 404);
});

test('SI34 a merge whose branch deletion fails is still a 200 merge, with a warning and no error status', async () => {
  await h.gh.setPull(219);
  await h.gh.patch({ fail: { delete: 'HTTP 422: Cannot delete a protected branch (https://api.github.com/repos/test/repo/git/refs/heads/feature-219)' } });
  const res = await merge(219);
  await h.gh.patch({ fail: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'merged');
  assert.equal(res.body.branchDeleted, false);
  assert.match(res.body.branchWarning, /The branch "feature-219" was not deleted: .*Cannot delete a protected branch/);
  assert.equal(res.body.error, undefined);
});

test('SI34 a merge whose head branch is already gone when the delete runs is a plain success, with no warning', async () => {
  await h.gh.setPull(234);
  await h.gh.patch({ fail: { delete: 'gh: Reference does not exist (HTTP 404)' } });
  const res = await merge(234);
  await h.gh.patch({ fail: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'merged');
  assert.equal(res.body.branchDeleted, true);
  assert.equal(res.body.branchWarning, null);
  assert.equal(res.body.error, undefined);
});

test('SI35 a PR whose head is the base or the default branch is merged and the branch is kept', async () => {
  await h.gh.setPull(220, { headRefName: 'main', headRef: { name: 'main' }, baseRefName: 'release' });
  await h.gh.setPull(221, { headRefName: 'develop', headRef: { name: 'develop' }, baseRefName: 'main' }, { defaultBranchRef: { name: 'develop' } });
  await h.gh.clearCalls();
  for (const number of [220, 221]) {
    const res = await merge(number);
    assert.equal(res.status, 200);
    assert.equal(res.body.branchDeleted, false);
    assert.match(res.body.branchNote, /is the base or default branch, so it was kept/);
    assert.equal(res.body.branchWarning, null);
  }
  assert.equal((await mergeCalls()).length, 2);
  assert.deepEqual(await deleteCalls(), []);
});

test('SI36 two merges of the same PR at once make exactly one gh merge call, and the second gets 409', async () => {
  await h.gh.setPull(222);
  await h.gh.patch({ mergeDelayMs: 300 });
  await h.gh.clearCalls();
  const [first, second] = await Promise.all([merge(222), merge(222)]);
  await h.gh.patch({ mergeDelayMs: 0 });
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.match((first.status === 409 ? first : second).body.error, /#222 is already being merged/);
  assert.equal((await mergeCalls()).length, 1);
});

test('SI37 merges of two different PRs at once both succeed', async () => {
  await h.gh.setPull(223);
  await h.gh.setPull(224);
  await h.gh.patch({ mergeDelayMs: 200 });
  const [first, second] = await Promise.all([merge(223), merge(224)]);
  await h.gh.patch({ mergeDelayMs: 0 });
  assert.deepEqual([first.body.outcome, second.body.outcome], ['merged', 'merged']);
});

test('SI38 the merge state is read again at click time: a PR that turned conflicting since the list was read does not merge', async () => {
  await h.gh.setPull(225);
  assert.equal((await mergeState(225)).body.mergeState.status, 'clean');
  await h.gh.setPull(225, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  await h.gh.clearCalls();
  const res = await merge(225);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Choose a coding agent/);
  assert.deepEqual(await mergeCalls(), []);
});

test('SI39 gh not signed in or unreachable answers with the mapped reason, and the list route still answers', async () => {
  await h.gh.setPull(226);
  for (const [stderr, reason] of [
    ['To get started with GitHub CLI, please run:  gh auth login', 'GitHub CLI is not signed in.'],
    ['error connecting to api.github.com: dial tcp: lookup api.github.com: no such host (network is unreachable)', 'Could not reach GitHub.'],
    ['HTTP 403: API rate limit exceeded for user ID 1.', 'GitHub rate limit reached.'],
  ] as const) {
    await h.gh.patch({ fail: { read: stderr } });
    const res = await merge(226);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, reason);
    const state = await mergeState(226);
    assert.equal(state.status, 200, 'an unreadable merge state is reported on the row, not as a failed request');
    assert.deepEqual([state.body.mergeState, state.body.error], [null, reason]);
    const listed = await list();
    assert.equal(listed.status, 200);
    assert.ok(listed.body.pullRequests.some((pr: { number: number }) => pr.number === 226));
  }
  await h.gh.patch({ fail: {} });
  assert.deepEqual(await h.gh.callsTo('pr', 'merge').then((calls) => calls.filter((args) => args[2] === '226')), []);
});

test('the merge route rejects a malformed body', async () => {
  await h.gh.setPull(227);
  assert.equal((await merge(227, { confirmBlockers: 'yes' })).status, 400);
  assert.equal((await merge(227, { executorId: 7 })).status, 400);
});

test('SI40 merging while the PR branch is checked out in the Project folder leaves the local branch and checkout untouched, and Return still works', async () => {
  const own = await h.createProject('SI40');
  const cwd = h.projectService.projectAbsolutePath(own);
  const sha = await h.publishPullRequest({ number: 228, branch: 'feature/si40', files: { 'si40.txt': 'one' } });
  assert.equal((await h.api(`/api/projects/${own.id}/pull-requests/228/checkout`, { method: 'POST' })).status, 200);

  const res = await merge(228, {}, own);
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'merged');
  assert.equal(await git(cwd, ['symbolic-ref', '--short', 'HEAD']), 'feature/si40');
  assert.equal(await git(cwd, ['rev-parse', 'HEAD']), sha);
  assert.equal(await git(cwd, ['rev-parse', 'refs/heads/feature/si40']), sha);
  const after = await h.projectService.getProject(own.id);
  assert.deepEqual(after.prCheckout, { number: 228, branch: 'feature/si40', previousBranch: 'main' });
  assert.equal(h.poller.gitSyncPoller.get(own.id)?.branch, 'feature/si40');

  const back = await h.api(`/api/projects/${own.id}/pull-requests/return`, { method: 'POST', body: '{}' });
  assert.equal(back.status, 200);
  assert.equal(await git(cwd, ['symbolic-ref', '--short', 'HEAD']), 'main');
});

test('SI41 a PR stacked on the merged branch is moved to the new base; one the provider closed reads as unmergeable (closed)', async () => {
  await h.gh.setPull(229, { headRefName: 'stack-base', headRef: { name: 'stack-base' } });
  await h.gh.setPull(230, { headRefName: 'stack-top', headRef: { name: 'stack-top' }, baseRefName: 'stack-base' });
  await h.gh.patch({ stacked: { 'stack-base': [230] } });
  assert.equal((await list()).body.pullRequests.find((pr: { number: number }) => pr.number === 230).baseBranch, 'stack-base');

  const res = await merge(229);
  assert.equal(res.body.branchDeleted, true);
  const calls = (await h.gh.calls()).map((args) => args.join(' '));
  const retarget = calls.findIndex((line) => line === 'api -X PATCH repos/test/repo/pulls/230 -f base=main');
  const removal = calls.findIndex((line) => line === 'api -X DELETE repos/test/repo/git/refs/heads/stack-base');
  assert.ok(retarget !== -1 && removal > retarget, 'retargeted before the branch was deleted');
  assert.equal((await list()).body.pullRequests.find((pr: { number: number }) => pr.number === 230).baseBranch, 'main');

  await h.gh.setPull(231, { state: 'CLOSED' });
  const closed = (await mergeState(231)).body.mergeState;
  assert.deepEqual([closed.status, closed.reason], ['unmergeable', 'This PR is closed']);
  assert.ok(!(await list()).body.pullRequests.some((pr: { number: number }) => pr.number === 231));
});

test('SI18 only an optional check failing: the route reports clean with the warning, and Merge goes through with no confirmation and no bypass', async () => {
  await h.gh.setPull(240, checksPayload([{ name: 'build', state: 'SUCCESS', required: true }, { name: 'Vercel', state: 'FAILURE', required: false }]));
  const state = (await mergeState(240)).body.mergeState;
  assert.deepEqual([state.status, state.blockers, state.warnings], ['clean', [], ['Optional checks failing: Vercel']]);
  await h.gh.clearCalls();
  const res = await merge(240);
  assert.equal(res.body.outcome, 'merged');
  assert.deepEqual(await mergeCalls(), [['pr', 'merge', '240', '--repo', 'test/repo', '--merge']]);
});

test('SI19 a required check failing still asks for confirmation, naming it, and confirming uses the bypass', async () => {
  await h.gh.setPull(241, { mergeStateStatus: 'BLOCKED', ...checksPayload([{ name: 'build', state: 'FAILURE', required: true }]) });
  await h.gh.patch({ protectedPulls: [241] });
  assert.deepEqual((await merge(241)).body, { outcome: 'needs-confirmation', blockers: ['Checks are failing: build'] });
  await h.gh.clearCalls();
  assert.equal((await merge(241, { confirmBlockers: true })).body.outcome, 'merged');
  assert.ok((await mergeCalls())[0]!.includes('--admin'));
  await h.gh.patch({ protectedPulls: [] });
});
