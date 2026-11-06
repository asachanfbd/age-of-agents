import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MERGE_BLOCKERS, PullRequestHeadGoneError, PullRequestNotFoundError, UNMERGEABLE_REASONS, classifyMergeState, ghActionFailure,
  ghFetchPullRequestHead, ghMergePullRequest, ghReadPullRequest, pullRequestHeadRef,
} from '../src/projects/pullRequestMerge.ts';
import type { PullRequestCheck, PullRequestReading } from '../src/projects/pullRequestMerge.ts';
import { gitProviderFor } from '../src/projects/gitProvider.ts';
import {
  CONFLICT_RESOLUTION_STEP_ID, CONFLICT_RESOLUTION_WORKFLOW_ID, conflictPlanItemDescription, conflictResolutionWorkflow, conflictRunBranch,
  conflictRunTitle,
} from '../src/worker/conflictResolution.ts';
import { repositoryPayload } from './helpers/pullRequestHarness.ts';

/** Unit cases SU1 to SU30: the merge-state classification, the GitHub provider operations over an injected `gh`/`git`, and the conflict workflow definition. */

function reading(overrides: Partial<PullRequestReading> = {}): PullRequestReading {
  return {
    number: 12, title: 'Add login', state: 'open', isDraft: false, mergeable: 'mergeable', checks: [], review: 'approved',
    protectionBlocked: false, behindBase: false, canMerge: true, headBranch: 'feature', baseBranch: 'main', headSha: 'abc',
    headBranchExists: true, isFork: false, headRepositoryUrl: null, defaultBranch: 'main', refusal: null,
    ...overrides,
  };
}

const requiredCheck = (name: string, outcome: PullRequestCheck['outcome']): PullRequestCheck => ({ name, outcome, required: true });

// ---- Merge-state classification ----

test('SU1 mergeable with nothing flagged is clean, with no blockers', () => {
  const state = classifyMergeState(reading());
  assert.equal(state.status, 'clean');
  assert.deepEqual(state.blockers, []);
  assert.equal(state.reason, null);
  assert.deepEqual([state.number, state.title, state.headBranch, state.baseBranch], [12, 'Add login', 'feature', 'main']);
});

test('SU1 a PR with no checks and no review requirement is clean too', () => {
  assert.equal(classifyMergeState(reading({ checks: [], review: 'none' })).status, 'clean');
});

test('SU2 a PR that conflicts with its base is conflicts', () => {
  assert.equal(classifyMergeState(reading({ mergeable: 'conflicting' })).status, 'conflicts');
});

for (const [id, overrides, line] of [
  ['SU3', { checks: [requiredCheck('build', 'failing')] }, 'Checks are failing: build'],
  ['SU4', { checks: [requiredCheck('build', 'pending')] }, 'Checks are still running: build'],
  ['SU5', { review: 'changes-requested' }, 'Changes were requested'],
  ['SU6', { review: 'review-required' }, 'A review is required'],
  ['SU7', { isDraft: true }, 'This PR is a draft'],
  ['SU8', { protectionBlocked: true }, MERGE_BLOCKERS.protection],
  ['SU8', { behindBase: true }, MERGE_BLOCKERS.behindBase],
  ['SU9', { mergeable: 'unknown' }, 'Merge state is not known yet'],
] as const) {
  test(`${id} ${JSON.stringify(overrides)} is blocked with "${line}"`, () => {
    const state = classifyMergeState(reading(overrides as Partial<PullRequestReading>));
    assert.equal(state.status, 'blocked');
    assert.deepEqual(state.blockers, [line]);
    assert.equal(state.reason, null);
  });
}

test('SU8 protection gets its own line only when no review or check blocker already explains it', () => {
  const explained = classifyMergeState(reading({ protectionBlocked: true, review: 'review-required' }));
  assert.deepEqual(explained.blockers, [MERGE_BLOCKERS.reviewRequired]);
  const draftOnly = classifyMergeState(reading({ protectionBlocked: true, isDraft: true }));
  assert.deepEqual(draftOnly.blockers, [MERGE_BLOCKERS.draft, MERGE_BLOCKERS.protection]);
});

test('SU10 several blockers are all listed once, in a stable order', () => {
  const all: Partial<PullRequestReading> = { isDraft: true, checks: [requiredCheck('build', 'failing')], review: 'changes-requested', behindBase: true, protectionBlocked: true, mergeable: 'unknown' };
  const expected = [MERGE_BLOCKERS.draft, `${MERGE_BLOCKERS.checksFailing}: build`, MERGE_BLOCKERS.changesRequested, MERGE_BLOCKERS.behindBase, MERGE_BLOCKERS.unknown];
  const state = classifyMergeState(reading(all));
  assert.equal(state.status, 'blocked');
  assert.deepEqual(state.blockers, expected);
  assert.equal(new Set(state.blockers).size, state.blockers.length);
  assert.deepEqual(classifyMergeState(reading(Object.fromEntries(Object.entries(all).reverse()))).blockers, expected);
});

test('SU11 conflicts plus blockers is conflicts with the blockers still attached', () => {
  const state = classifyMergeState(reading({ mergeable: 'conflicting', checks: [requiredCheck('build', 'failing')], isDraft: true }));
  assert.equal(state.status, 'conflicts');
  assert.deepEqual(state.blockers, [MERGE_BLOCKERS.draft, `${MERGE_BLOCKERS.checksFailing}: build`]);
});

for (const [id, overrides, reason] of [
  ['SU12', { state: 'closed' }, 'This PR is closed'],
  ['SU13', { state: 'merged' }, 'This PR is already merged'],
  ['SU14', { canMerge: false }, UNMERGEABLE_REASONS.noPermission],
  ['SU15', { headBranchExists: false }, 'The head branch no longer exists'],
  ['SU16', { refusal: 'Merging is blocked by an organisation rule' }, 'Merging is blocked by an organisation rule'],
] as const) {
  test(`${id} ${JSON.stringify(overrides)} is unmergeable: "${reason}"`, () => {
    const state = classifyMergeState(reading(overrides as Partial<PullRequestReading>));
    assert.equal(state.status, 'unmergeable');
    assert.equal(state.reason, reason);
    assert.deepEqual(state.blockers, []);
  });
}

test('SU15 a missing head branch is reported on the state itself', () => {
  assert.equal(classifyMergeState(reading({ headBranchExists: false })).headBranchExists, false);
  assert.equal(classifyMergeState(reading()).headBranchExists, true);
});

test('SU17 unmergeable wins over conflicts and blockers, and merged/closed win over every other reason', () => {
  const state = classifyMergeState(reading({ state: 'closed', mergeable: 'conflicting', checks: [requiredCheck('build', 'failing')], canMerge: false, headBranchExists: false }));
  assert.equal(state.status, 'unmergeable');
  assert.equal(state.reason, UNMERGEABLE_REASONS.closed);
  assert.deepEqual(state.blockers, []);
  assert.equal(classifyMergeState(reading({ canMerge: false, headBranchExists: false, mergeable: 'conflicting' })).reason, UNMERGEABLE_REASONS.noPermission);
});

// ---- GitHub provider operations ----

type Call = { cwd: string; args: string[] };

function recorder(answer: (args: string[]) => string | Promise<string> = () => '') {
  const calls: Call[] = [];
  const run = async (cwd: string, args: string[]) => { calls.push({ cwd, args }); return answer(args); };
  return { calls, run };
}

const graphql = (pullRequest: Record<string, unknown> = {}, repository: Record<string, unknown> = {}) =>
  JSON.stringify({ data: { repository: repositoryPayload(12, pullRequest, repository) } });

test('SU18 read PR merge state asks gh for the PR by number and repository', async () => {
  const { calls, run } = recorder(() => graphql());
  const result = await ghReadPullRequest('/repo', 'Owner/name', 12, run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cwd, '/repo');
  assert.deepEqual(calls[0]!.args.slice(0, 2), ['api', 'graphql']);
  assert.ok(calls[0]!.args.includes('owner=Owner') && calls[0]!.args.includes('name=name') && calls[0]!.args.includes('number=12'));
  assert.match(calls[0]!.args.find((arg) => arg.startsWith('query='))!, /pullRequest\(number: \$number\)/);
  assert.deepEqual(result, {
    number: 12, title: 'Change 12', state: 'open', isDraft: false, mergeable: 'mergeable', checks: [], review: 'none',
    protectionBlocked: false, behindBase: false, canMerge: true, headBranch: 'feature-12', baseBranch: 'main', headSha: 'a'.repeat(40),
    headBranchExists: true, isFork: false, headRepositoryUrl: null, defaultBranch: 'main', refusal: null,
  });
});

const rollup = (contexts: Record<string, unknown>[], hasNextPage = false) =>
  ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes: contexts } } } }] } });

test('SU18 read parses every raw value the classification uses', async () => {
  const read = (pullRequest: Record<string, unknown>, repository: Record<string, unknown> = {}) =>
    ghReadPullRequest('/repo', 'o/n', 12, async () => graphql(pullRequest, repository));
  const outcomes = async (...contexts: Record<string, unknown>[]) => (await read(rollup(contexts))).checks.map((check) => check.outcome);
  const statusContext = (state: string) => ({ __typename: 'StatusContext', context: 'ci', state, isRequired: true });
  const checkRun = (status: string, conclusion: string | null) => ({ __typename: 'CheckRun', name: 'run', status, conclusion, isRequired: true });

  assert.equal((await read({ state: 'CLOSED' })).state, 'closed');
  assert.equal((await read({ state: 'MERGED' })).state, 'merged');
  assert.equal((await read({ isDraft: true, mergeStateStatus: 'DRAFT' })).isDraft, true);
  assert.equal((await read({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).mergeable, 'conflicting');
  assert.equal((await read({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).mergeable, 'unknown');
  for (const [state, outcome] of [['SUCCESS', 'passing'], ['FAILURE', 'failing'], ['ERROR', 'failing'], ['PENDING', 'pending'], ['EXPECTED', 'pending']] as const) {
    assert.deepEqual(await outcomes(statusContext(state)), [outcome], `status ${state}`);
  }
  for (const [conclusion, outcome] of [
    ['SUCCESS', 'passing'], ['SKIPPED', 'passing'], ['NEUTRAL', 'passing'], ['FAILURE', 'failing'], ['TIMED_OUT', 'failing'],
    ['CANCELLED', 'failing'], ['ACTION_REQUIRED', 'failing'], ['STARTUP_FAILURE', 'failing'],
  ] as const) assert.deepEqual(await outcomes(checkRun('COMPLETED', conclusion)), [outcome], `conclusion ${conclusion}`);
  assert.deepEqual(await outcomes(checkRun('IN_PROGRESS', null)), ['pending']);
  assert.deepEqual((await read({ commits: { nodes: [] } })).checks, []);
  assert.deepEqual((await read({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).checks, []);
  assert.equal((await read({ reviewDecision: 'APPROVED' })).review, 'approved');
  assert.equal((await read({ reviewDecision: 'CHANGES_REQUESTED' })).review, 'changes-requested');
  assert.equal((await read({ reviewDecision: 'REVIEW_REQUIRED' })).review, 'review-required');
  assert.equal((await read({ mergeStateStatus: 'BLOCKED' })).protectionBlocked, true);
  assert.equal((await read({ mergeStateStatus: 'BEHIND' })).behindBase, true);
  for (const status of ['UNSTABLE', 'HAS_HOOKS']) assert.equal((await read({ mergeStateStatus: status })).protectionBlocked, false);
  for (const permission of ['ADMIN', 'MAINTAIN', 'WRITE']) assert.equal((await read({}, { viewerPermission: permission })).canMerge, true);
  for (const permission of ['TRIAGE', 'READ', null]) assert.equal((await read({}, { viewerPermission: permission })).canMerge, false);
  assert.equal((await read({ headRef: null })).headBranchExists, false);
  assert.equal((await read({}, { defaultBranchRef: { name: 'develop' } })).defaultBranch, 'develop');
  assert.equal((await read({}, { defaultBranchRef: null })).defaultBranch, '');

  const fork = await read({ isCrossRepository: true, headRepository: { url: 'https://github.com/someone/fork' } });
  assert.deepEqual([fork.isFork, fork.headRepositoryUrl, fork.headBranchExists], [true, 'https://github.com/someone/fork.git', true]);
  const deletedFork = await read({ isCrossRepository: true, headRepository: null });
  assert.deepEqual([deletedFork.isFork, deletedFork.headRepositoryUrl, deletedFork.headBranchExists], [true, null, false]);
});

test('SU18 an unknown PR number is a not-found error, and other gh failures pass through', async () => {
  const notFound = async () => { throw new Error('gh command failed: Command failed: gh api graphql\nGraphQL: Could not resolve to a PullRequest with the number of 99.'); };
  await assert.rejects(() => ghReadPullRequest('/repo', 'o/n', 99, notFound), PullRequestNotFoundError);
  await assert.rejects(() => ghReadPullRequest('/repo', 'o/n', 12, async () => { throw new Error('HTTP 502'); }), /HTTP 502/);
});

test('SU19 malformed or partial gh output throws and never reads as clean', async () => {
  const outputs = [
    'not json', '{}', '{"data":{"repository":null}}', '{"data":{"repository":{"pullRequest":null}}}',
    graphql({ number: 'twelve' }), graphql({ title: undefined }), graphql({ headRefName: null }), graphql({ isDraft: 'no' }),
    graphql({ state: 'WEIRD' }), graphql({ mergeable: undefined }), graphql({ mergeStateStatus: 'NEW_VALUE' }),
    graphql({ reviewDecision: 'SOMETHING' }), graphql(rollup([{ __typename: 'StatusContext', context: 'ci', state: 'ODD', isRequired: true }])), graphql(rollup([{ __typename: 'Other' }])),
    graphql(rollup([{ __typename: 'CheckRun', name: 'run', status: 'COMPLETED', conclusion: 'NEW', isRequired: true }])),
  ];
  for (const out of outputs) {
    await assert.rejects(() => ghReadPullRequest('/repo', 'o/n', 12, async () => out), /invalid pull request/, out.slice(0, 60));
  }
});

const mergeTarget = (overrides: Partial<PullRequestReading> = {}) => reading({ number: 12, headBranch: 'feature/login', baseBranch: 'main', ...overrides });

test('SU20 merge PR always uses a merge commit and never squash, rebase or gh\'s own branch deletion', async () => {
  for (const options of [{}, { bypassProtection: false }, { bypassProtection: true }]) {
    const { calls, run } = recorder();
    await ghMergePullRequest('/repo', 'o/n', mergeTarget(), options, run);
    assert.deepEqual(calls[0]!.args.slice(0, 6), ['pr', 'merge', '12', '--repo', 'o/n', '--merge']);
    const flags = calls.flatMap((call) => call.args);
    for (const banned of ['--squash', '--rebase', '--delete-branch', '-d', '--auto']) assert.ok(!flags.includes(banned), banned);
  }
});

test('SU20 --admin is passed only for a merge confirmed over its blockers, never for an unconfirmed one', async () => {
  const mergeArgs = async (options?: { bypassProtection?: boolean }) => {
    const { calls, run } = recorder();
    await ghMergePullRequest('/repo', 'o/n', mergeTarget(), options, run);
    return calls[0]!.args;
  };
  assert.deepEqual(await mergeArgs(), ['pr', 'merge', '12', '--repo', 'o/n', '--merge']);
  assert.deepEqual(await mergeArgs({}), ['pr', 'merge', '12', '--repo', 'o/n', '--merge']);
  assert.deepEqual(await mergeArgs({ bypassProtection: false }), ['pr', 'merge', '12', '--repo', 'o/n', '--merge']);
  assert.deepEqual(await mergeArgs({ bypassProtection: true }), ['pr', 'merge', '12', '--repo', 'o/n', '--merge', '--admin']);
});

test('SU21 a head branch name with URL-significant characters is encoded per path segment in the delete call', async () => {
  const { calls, run } = recorder();
  await ghMergePullRequest('/repo', 'o/n', mergeTarget({ headBranch: 'fix/100%-done#2?x' }), {}, run);
  assert.deepEqual(calls.at(-1)!.args, ['api', '-X', 'DELETE', 'repos/o/n/git/refs/heads/fix/100%25-done%232%3Fx']);
  assert.match(calls[1]!.args.at(-1)!, /base=fix%2F100%25-done%232%3Fx&/);
});

test('SU21 merge PR deletes the remote head branch after the merge, reported as its own field', async () => {
  const { calls, run } = recorder();
  const result = await ghMergePullRequest('/repo', 'o/n', mergeTarget(), {}, run);
  assert.deepEqual(result, { branchDeleted: true, branchWarning: null, branchNote: null });
  assert.deepEqual(calls.map((call) => call.args), [
    ['pr', 'merge', '12', '--repo', 'o/n', '--merge'],
    ['api', '--paginate', '--jq', '.[].number', 'repos/o/n/pulls?state=open&base=feature%2Flogin&per_page=100'],
    ['api', '-X', 'DELETE', 'repos/o/n/git/refs/heads/feature/login'],
  ]);
});

test('SU21 open PRs stacked on the head branch are moved to the merged PR\'s base before the branch goes', async () => {
  const { calls, run } = recorder((args) => (args.includes('--paginate') ? '31\n32\n' : ''));
  await ghMergePullRequest('/repo', 'o/n', mergeTarget(), {}, run);
  assert.deepEqual(calls.slice(2).map((call) => call.args), [
    ['api', '-X', 'PATCH', 'repos/o/n/pulls/31', '-f', 'base=main'],
    ['api', '-X', 'PATCH', 'repos/o/n/pulls/32', '-f', 'base=main'],
    ['api', '-X', 'DELETE', 'repos/o/n/git/refs/heads/feature/login'],
  ]);
});

for (const [why, stderr, expected] of [
  ['permission', 'HTTP 403: Must have admin rights to Repository.', /Must have admin rights/],
  ['protected', 'HTTP 422: Cannot delete a protected branch', /Cannot delete a protected branch/],
  ['repository not visible', 'gh: Not Found (HTTP 404)', /Not Found/],
] as const) {
  test(`SU22 merge succeeds and the delete fails (${why}): merged, with a warning carrying the reason`, async () => {
    const run = async (_cwd: string, args: string[]) => {
      if (args.includes('DELETE')) throw new Error(`gh command failed: Command failed: gh api -X DELETE\n${stderr}`);
      return '';
    };
    const result = await ghMergePullRequest('/repo', 'o/n', mergeTarget(), {}, run);
    assert.equal(result.branchDeleted, false);
    assert.match(result.branchWarning!, /The branch "feature\/login" was not deleted: /);
    assert.match(result.branchWarning!, expected);
    assert.equal(result.branchNote, null);
  });
}

for (const stderr of ['gh: Reference does not exist (HTTP 404)', 'HTTP 422: Reference does not exist']) {
  test(`SU22 a head branch already gone when the delete runs counts as deleted, with no warning (${stderr})`, async () => {
    const run = async (_cwd: string, args: string[]) => {
      if (args.includes('DELETE')) throw new Error(`gh command failed: Command failed: gh api -X DELETE\n${stderr}`);
      return '';
    };
    const result = await ghMergePullRequest('/repo', 'o/n', mergeTarget(), {}, run);
    assert.deepEqual(result, { branchDeleted: true, branchWarning: null, branchNote: null });
  });
}

for (const [call, flag] of [['stacked-PR list', '--paginate'], ['retarget', 'PATCH']] as const) {
  test(`SU22 "Reference does not exist" from the ${call} call still warns and attempts no delete`, async () => {
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args.includes(flag)) throw new Error('gh command failed: Command failed\ngh: Reference does not exist (HTTP 404)');
      return args.includes('--paginate') ? '31' : '';
    };
    const result = await ghMergePullRequest('/repo', 'o/n', mergeTarget(), {}, run);
    assert.equal(result.branchDeleted, false);
    assert.match(result.branchWarning!, /The branch "feature\/login" was not deleted: .*Reference does not exist/);
    assert.ok(!calls.some((args) => args.includes('DELETE')));
  });
}

test('SU22 a stacked PR that can\'t be retargeted keeps the branch, with a warning, rather than closing that PR', async () => {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args.includes('--paginate')) return '31';
    if (args.includes('PATCH')) throw new Error('gh command failed: Command failed\nHTTP 422: Validation Failed');
    return '';
  };
  const result = await ghMergePullRequest('/repo', 'o/n', mergeTarget(), {}, run);
  assert.equal(result.branchDeleted, false);
  assert.match(result.branchWarning!, /Validation Failed/);
  assert.ok(!calls.some((args) => args.includes('DELETE')));
});

test('SU23 a merge the provider refuses throws its reason and attempts no delete', async () => {
  const { calls, run } = recorder((args) => {
    if (args[1] === 'merge') throw new Error('gh command failed: Command failed: gh pr merge 12\nGraphQL: Pull request is not mergeable: the base branch policy prohibits the merge.');
    return '';
  });
  const error = await ghMergePullRequest('/repo', 'o/n', mergeTarget(), {}, run).then(() => null, (thrown: Error) => thrown);
  assert.ok(error);
  assert.equal(ghActionFailure(error), 'Pull request is not mergeable: the base branch policy prohibits the merge.');
  assert.equal(calls.length, 1);
});

for (const [why, overrides, note] of [
  ['the base branch', { headBranch: 'main', baseBranch: 'main', defaultBranch: 'develop' }, /is the base or default branch/],
  ['the default branch', { headBranch: 'develop', baseBranch: 'release', defaultBranch: 'develop' }, /is the base or default branch/],
  ['in a fork', { isFork: true, headBranch: 'patch-1' }, /lives in a fork/],
] as const) {
  test(`SU24 a head that is ${why} is merged and kept, with a note and no delete`, async () => {
    const { calls, run } = recorder();
    const result = await ghMergePullRequest('/repo', 'o/n', mergeTarget(overrides), {}, run);
    assert.equal(result.branchDeleted, false);
    assert.equal(result.branchWarning, null);
    assert.match(result.branchNote!, note);
    assert.deepEqual(calls.map((call) => call.args[1]), ['merge']);
  });
}

test('SU25 fetch PR head fetches the pull request\'s own head ref, not a same-named branch', async () => {
  const { calls, run } = recorder((args) => (args[0] === 'rev-parse' ? 'f00d' : ''));
  assert.equal(await ghFetchPullRequestHead('/repo', 7, run), 'f00d');
  assert.equal(pullRequestHeadRef(7), 'refs/agent-visual-os/pull/7');
  assert.deepEqual(calls.map((call) => call.args), [
    ['fetch', '--quiet', 'origin', '+refs/pull/7/head:refs/agent-visual-os/pull/7'],
    ['rev-parse', '--verify', 'refs/agent-visual-os/pull/7'],
  ]);
});

test('SU26 fetching a PR whose head is gone throws a recognisable "branch no longer exists" error', async () => {
  const gone = async () => { throw new Error('Git operation failed: Command failed: git fetch\nfatal: couldn\'t find remote ref refs/pull/7/head'); };
  await assert.rejects(() => ghFetchPullRequestHead('/repo', 7, gone), (error: Error) => error instanceof PullRequestHeadGoneError && /no longer exists/.test(error.message));
  await assert.rejects(() => ghFetchPullRequestHead('/repo', 7, async () => { throw new Error('Could not resolve host: github.com'); }), /resolve host/);
});

test('SU27 describeActionFailure names gh missing, signed out, rate limit and network, and otherwise gives the provider\'s own text', () => {
  const describe = gitProviderFor('github').describeActionFailure;
  assert.equal(describe(new Error('spawn gh ENOENT')), 'GitHub CLI is not installed.');
  assert.equal(describe(new Error('gh command failed: Command failed\nTo get started with GitHub CLI, please run:  gh auth login')), 'GitHub CLI is not signed in.');
  assert.equal(describe(new Error('HTTP 401: Bad credentials')), 'GitHub CLI is not signed in.');
  assert.equal(describe(new Error('API rate limit exceeded for user')), 'GitHub rate limit reached.');
  assert.equal(describe(new Error('Git operation failed: Command failed: git fetch\nfatal: unable to access: Could not resolve host: github.com')), 'Could not reach GitHub.');
  assert.equal(describe(new Error('dial tcp: i/o timeout')), 'Could not reach GitHub.');
  assert.equal(describe(new Error('gh command failed: Command failed: gh pr merge 3\nGraphQL: Base branch was modified. Review and try the merge again.')), 'Base branch was modified. Review and try the merge again.');
  assert.equal(describe(new Error('single line reason')), 'single line reason');
  assert.equal(describe(new Error('')), 'GitHub refused the request.');
  assert.equal(describe('not an error'), 'GitHub refused the request.');
  // The list keeps its own wording for the same environment cases.
  assert.equal(gitProviderFor('github').describeFailure(new Error('spawn gh ENOENT')), 'GitHub CLI is not installed.');
});

test('SU28 the registry still resolves GitHub for a legacy Project, and the new operations exist on it', () => {
  const provider = gitProviderFor(undefined);
  assert.equal(provider.id, 'github');
  for (const operation of ['readPullRequest', 'mergePullRequest', 'fetchPullRequestHead', 'describeActionFailure', 'listOpenPullRequests'] as const) {
    assert.equal(typeof provider[operation], 'function', operation);
  }
});

// ---- Conflict workflow definition ----

const pr = { number: 12, title: 'Add login', headBranch: 'feature/login', baseBranch: 'develop' };

test('SU29 the conflict workflow is one write-capable step with no approval gate and a fixed, non-Catalog id', () => {
  const workflow = conflictResolutionWorkflow(pr);
  assert.equal(workflow.id, CONFLICT_RESOLUTION_WORKFLOW_ID);
  assert.equal(workflow.id, 'pr-conflict-resolution');
  assert.equal(workflow.enabled, true);
  assert.equal(workflow.steps.length, 1);
  const [step] = workflow.steps;
  assert.equal(step!.id, CONFLICT_RESOLUTION_STEP_ID);
  assert.equal(step!.canEditCode, true);
  assert.equal(step!.requiresApproval, false);
  assert.equal(step!.loopBack ?? null, null);
});

test('SU30 its instructions name both branches, say to merge base into head, and forbid force push, history rewrite and the main checkout', () => {
  const text = conflictResolutionWorkflow(pr).steps[0]!.instructions;
  assert.match(text, /head branch "feature\/login"/);
  assert.match(text, /base branch "develop"/);
  assert.match(text, /git merge origin\/develop/);
  assert.match(text, /Never force push/);
  assert.match(text, /Never rebase, amend, reset or otherwise rewrite existing commits/);
  assert.match(text, /Never touch the project's main checkout/);
  assert.match(text, /Do not call skip_step/);
});

test('SU30 the run is titled "Resolve conflicts: #<n> <title>", on a run-local branch unique to the run', () => {
  assert.equal(conflictRunTitle(pr), 'Resolve conflicts: #12 Add login');
  assert.equal(conflictRunBranch(pr, '0123456789abcdef'), 'pr-conflicts/12-01234567');
  assert.notEqual(conflictRunBranch(pr, 'aaaaaaaa1'), conflictRunBranch(pr, 'bbbbbbbb1'));
  assert.match(conflictPlanItemDescription(pr), /#12 "Add login" \(feature\/login → develop\) conflicts with its base branch/);
});
