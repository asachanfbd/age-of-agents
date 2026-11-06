import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTIFICATION_KINDS, NOTIFICATION_SEVERITY_BY_KIND } from '../src/domain/types.ts';
import { AUTO_MERGE_NOTIFICATION_KINDS, autoMergeMergedDescription, decideAutoMerge, newAutoMerge, notificationKindFor, readAutoMerge, safeReason } from '../src/projects/autoMerge.ts';
import { classifyMergeState, ghReadPullRequest } from '../src/projects/pullRequestMerge.ts';
import type { PullRequestCheck, PullRequestReading } from '../src/projects/pullRequestMerge.ts';
import { githubRepository } from '../src/projects/git.ts';
import { repositoryPayload } from './helpers/pullRequestHarness.ts';

/** Which checks block a merge: only the ones the base branch requires, all of them when that is unknown. */

const check = (name: string, outcome: PullRequestCheck['outcome'], required: boolean | null): PullRequestCheck => ({ name, outcome, required });

function reading(checks: PullRequestCheck[], overrides: Partial<PullRequestReading> = {}): PullRequestReading {
  return {
    number: 12, title: 'Add login', state: 'open', isDraft: false, mergeable: 'mergeable', checks, review: 'approved',
    protectionBlocked: false, behindBase: false, canMerge: true, headBranch: 'feature', baseBranch: 'main', headSha: 'abc',
    headBranchExists: true, isFork: false, headRepositoryUrl: null, defaultBranch: 'main', refusal: null, ...overrides,
  };
}

// ---- Classification ----

test('SU1 required failing checks block and are named', () => {
  const state = classifyMergeState(reading([check('build', 'failing', true), check('lint', 'failing', true)]));
  assert.equal(state.status, 'blocked');
  assert.deepEqual(state.blockers, ['Checks are failing: build, lint']);
});

test('SU3/SU4 required pending (or expected) checks block as still running', () => {
  assert.deepEqual(classifyMergeState(reading([check('build', 'pending', true)])).blockers, ['Checks are still running: build']);
});

test('SU5 required failing and required pending are both reported', () => {
  const state = classifyMergeState(reading([check('build', 'failing', true), check('e2e', 'pending', true)]));
  assert.deepEqual(state.blockers, ['Checks are failing: build', 'Checks are still running: e2e']);
});

test('SU6 only optional checks failing is clean, with a named warning', () => {
  const state = classifyMergeState(reading([check('build', 'passing', true), check('Vercel', 'failing', false)]));
  assert.equal(state.status, 'clean');
  assert.deepEqual(state.blockers, []);
  assert.deepEqual(state.warnings, ['Optional checks failing: Vercel']);
});

test('SU7/SU8 optional pending checks warn as running, alongside failing ones', () => {
  const state = classifyMergeState(reading([check('Vercel', 'failing', false), check('docs', 'pending', false)]));
  assert.equal(state.status, 'clean');
  assert.deepEqual(state.warnings, ['Optional checks failing: Vercel', 'Optional checks running: docs']);
});

test('SU9 no required checks at all: failing checks never block', () => {
  const state = classifyMergeState(reading([check('a', 'failing', false), check('b', 'pending', false)]));
  assert.equal(state.status, 'clean');
});

test('SU10 all checks passing: no blocker, no warning', () => {
  const state = classifyMergeState(reading([check('a', 'passing', true), check('b', 'passing', false)]));
  assert.deepEqual([state.status, state.blockers, state.warnings], ['clean', [], []]);
});

test('SU11 mixed: the blocker names only required checks and the warning only optional ones', () => {
  const state = classifyMergeState(reading([check('build', 'failing', true), check('Vercel', 'failing', false)]));
  assert.deepEqual(state.blockers, ['Checks are failing: build']);
  assert.deepEqual(state.warnings, ['Optional checks failing: Vercel']);
});

test('SU13/SU14 unknown required-ness: every non-passing check blocks, with the suffix', () => {
  const failing = classifyMergeState(reading([check('Vercel', 'failing', null)]));
  assert.deepEqual(failing.blockers, ['Checks are failing: Vercel (could not tell which checks are required)']);
  assert.deepEqual(failing.warnings, []);
  assert.deepEqual(classifyMergeState(reading([check('Vercel', 'pending', null)])).blockers, ['Checks are still running: Vercel (could not tell which checks are required)']);
});

test('SU15 unknown required-ness with everything passing is clean, without the suffix', () => {
  const state = classifyMergeState(reading([check('a', 'passing', null)]));
  assert.deepEqual([state.status, state.blockers], ['clean', []]);
});

test('SU17 a warning never changes the class: draft, conflicts and unmergeable keep theirs', () => {
  const optional = [check('Vercel', 'failing', false)];
  assert.equal(classifyMergeState(reading(optional, { isDraft: true })).status, 'blocked');
  assert.equal(classifyMergeState(reading(optional, { mergeable: 'conflicting' })).status, 'conflicts');
  const closed = classifyMergeState(reading(optional, { state: 'closed' }));
  assert.equal(closed.status, 'unmergeable');
  assert.deepEqual(closed.warnings, ['Optional checks failing: Vercel']);
});

test('SU18 base protection that only optional checks explain is no blocker; one nothing explains keeps its line', () => {
  assert.equal(classifyMergeState(reading([check('Vercel', 'failing', false)], { protectionBlocked: false })).status, 'clean');
  const explained = classifyMergeState(reading([check('build', 'failing', true)], { protectionBlocked: true }));
  assert.deepEqual(explained.blockers, ['Checks are failing: build']);
  assert.deepEqual(classifyMergeState(reading([], { protectionBlocked: true })).blockers, ['The base branch\'s protection rules are not satisfied']);
});

test('SU19 names are distinct, ordered, shortened to three with a count, and an empty name is still shown', () => {
  const many = ['a', 'b', 'a', 'c', 'd', 'e'].map((name) => check(name, 'failing', true));
  assert.deepEqual(classifyMergeState(reading(many)).blockers, ['Checks are failing: a, b, c +2 more']);
  assert.deepEqual(classifyMergeState(reading([check('  ', 'failing', true)])).blockers, ['Checks are failing: unnamed check']);
  const long = classifyMergeState(reading([check('x'.repeat(500), 'failing', true)])).blockers[0]!;
  assert.ok(long.length < 260);
  const hundreds = Array.from({ length: 250 }, (_, index) => check(`job-${index}`, 'failing', true));
  assert.equal(classifyMergeState(reading(hundreds)).blockers[0], 'Checks are failing: job-0, job-1, job-2 +247 more');
});

test('SU16 the Auto-merge decision: only optional checks failing merges; a required one blocks; unknown never merges', () => {
  assert.deepEqual(decideAutoMerge(reading([check('Vercel', 'failing', false)])), { action: 'merge', warnings: ['Optional checks failing: Vercel'] });
  assert.deepEqual(decideAutoMerge(reading([check('build', 'failing', true)])), { action: 'blocked', reasons: ['Checks are failing: build'], warnings: [] });
  for (const outcome of ['failing', 'pending'] as const) assert.equal(decideAutoMerge(reading([check('x', outcome, null)])).action, 'blocked');
});

// ---- Parsing GitHub's answer ----

const read = (pullRequest: Record<string, unknown>, calls: string[][] = []) =>
  ghReadPullRequest('/repo', 'o/n', 12, async (_cwd, args) => { calls.push(args); return JSON.stringify({ data: { repository: repositoryPayload(12, pullRequest) } }); });
const rollup = (nodes: unknown[], hasNextPage: boolean | null = false) =>
  ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes } } } }] } });
const status = (context: string, state: string, isRequired?: unknown) => ({ __typename: 'StatusContext', context, state, ...(isRequired === undefined ? {} : { isRequired }) });

test('SU20 isRequired true and false split the checks', async () => {
  const { checks } = await read(rollup([status('build', 'SUCCESS', true), status('Vercel', 'FAILURE', false)]));
  assert.deepEqual(checks, [check('build', 'passing', true), check('Vercel', 'failing', false)]);
});

test('SU21 a missing or null isRequired on any check makes every check unknown', async () => {
  for (const missing of [undefined, null, 'yes']) {
    const { checks } = await read(rollup([status('a', 'SUCCESS', true), status('b', 'FAILURE', missing)]));
    assert.deepEqual(checks.map((entry) => entry.required), [null, null]);
  }
});

test('SU22 more checks than one page holds make required-ness unknown', async () => {
  for (const hasNextPage of [true, null]) {
    assert.equal((await read(rollup([status('a', 'FAILURE', false)], hasNextPage))).checks[0]!.required, null);
  }
});

test('SU23 no rollup or no contexts means no checks', async () => {
  assert.deepEqual((await read({})).checks, []);
  assert.deepEqual((await read(rollup([]))).checks, []);
});

test('SU28 the query asks for isRequired of this PR number and still passes the number as a variable', async () => {
  const calls: string[][] = [];
  await read({}, calls);
  assert.match(calls[0]!.find((arg) => arg.startsWith('query='))!, /isRequired\(pullRequestNumber: \$number\)/);
  assert.ok(calls[0]!.includes('number=12'));
});

test('SU27 when GitHub refuses the isRequired field the PR is read again without it, every check unknown', async () => {
  const queries: string[] = [];
  const result = await ghReadPullRequest('/repo', 'o/n', 12, async (_cwd, args) => {
    const query = args.find((arg) => arg.startsWith('query='))!;
    queries.push(query);
    if (/isRequired/.test(query)) throw new Error('gh command failed: GraphQL: Field \'isRequired\' doesn\'t exist on type \'StatusContext\'');
    return JSON.stringify({ data: { repository: repositoryPayload(12, rollup([status('Vercel', 'FAILURE')])) } });
  });
  assert.equal(queries.length, 2);
  assert.deepEqual(result.checks, [check('Vercel', 'failing', null)]);
  await assert.rejects(() => ghReadPullRequest('/repo', 'o/n', 12, async () => { throw new Error('HTTP 502'); }), /HTTP 502/);
});

// ---- Records and notification kinds ----

test('SU29 the stored warnings read back; absent or malformed ones read as none', () => {
  const base = newAutoMerge(true, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(readAutoMerge({ ...base, warnings: ['Optional checks failing: Vercel'] })!.warnings, ['Optional checks failing: Vercel']);
  const { warnings: _omitted, ...legacy } = base;
  assert.deepEqual(readAutoMerge(legacy)!.warnings, []);
  assert.deepEqual(readAutoMerge({ ...base, warnings: 'nope' })!.warnings, []);
  assert.deepEqual(readAutoMerge({ ...base, warnings: ['ok', 3, null] })!.warnings, ['ok']);
});

test('SU30 a credential in a check name is redacted in stored text', () => {
  assert.equal(safeReason('Optional checks failing: https://user:pw@example.com/x'), 'Optional checks failing: https://[secret]@example.com/x');
});

test('SU31 automerge.merged is an info kind, listed, and not one the state change resolves', () => {
  assert.ok(NOTIFICATION_KINDS.includes('automerge.merged'));
  assert.equal(NOTIFICATION_SEVERITY_BY_KIND['automerge.merged'], 'info');
  assert.ok(!AUTO_MERGE_NOTIFICATION_KINDS.includes('automerge.merged'));
});

test('SU32 the states that raise a notification are unchanged and merged raises none through the kind table', () => {
  assert.equal(notificationKindFor('merged'), null);
  assert.equal(notificationKindFor('blocked'), 'automerge.blocked');
  assert.equal(notificationKindFor('failed'), 'automerge.failed');
  assert.equal(notificationKindFor('failed', true), 'automerge.conflict_failed');
  assert.equal(notificationKindFor('no-pr'), 'automerge.failed');
  assert.equal(notificationKindFor('waiting'), null);
});

test('the merged description names the PR, then the branch note and warning when there are any', () => {
  assert.equal(autoMergeMergedDescription({ prNumber: 7, branchNote: null, branchWarning: null }), 'PR #7 merged.');
  assert.equal(autoMergeMergedDescription({ prNumber: 7, branchNote: 'kept.', branchWarning: 'not deleted.' }), 'PR #7 merged. kept. not deleted.');
  assert.equal(autoMergeMergedDescription({ prNumber: null, branchNote: null, branchWarning: null }), 'Pull request merged.');
});

test('SU33/SU34 the repository slug of an SSH alias remote, and no slug for one that is not a GitHub remote', () => {
  for (const url of ['git@github-loki:hrfinpay/hr-fin-pay.git', 'git@github-loki:hrfinpay/hr-fin-pay', 'git@github-loki:hrfinpay/hr-fin-pay.git/']) {
    assert.equal(githubRepository(url)?.slug, 'hrfinpay/hr-fin-pay', url);
  }
  assert.equal(githubRepository('git@github-loki:HRFinPay/Repo.git')?.slug, 'HRFinPay/Repo');
  assert.equal(githubRepository('not a url'), null);
});
