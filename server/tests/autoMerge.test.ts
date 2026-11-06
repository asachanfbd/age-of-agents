import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_MERGE_NOTIFICATION_KINDS, autoMergeConflictTitle, autoMergeIneligibleReason, conflictExecutorFor, createKeyedQueue, decideAutoMerge,
  isProviderUnreachable, newAutoMerge, notificationKindFor, parseAutoMergeToggle, pullRequestNumberOf, readAutoMerge, safeReason,
} from '../src/projects/autoMerge.ts';
import { MERGE_BLOCKERS, UNMERGEABLE_REASONS } from '../src/projects/pullRequestMerge.ts';
import type { PullRequestReading } from '../src/projects/pullRequestMerge.ts';
import type { AutoMergeState, WorkflowStep } from '../src/domain/types.ts';
import { rememberSecret } from '../src/redaction.ts';

/** Unit cases U1 to U30 of task 10.017: the pure Auto-merge rules. */

function reading(overrides: Partial<PullRequestReading> = {}): PullRequestReading {
  return {
    number: 12, title: 'Add login', state: 'open', isDraft: false, mergeable: 'mergeable', checks: [], review: 'approved',
    protectionBlocked: false, behindBase: false, canMerge: true, headBranch: 'feature', baseBranch: 'main', headSha: 'abc',
    headBranchExists: true, isFork: false, headRepositoryUrl: null, defaultBranch: 'main', refusal: null,
    ...overrides,
  };
}

function step(id: string, canEditCode: boolean, executorId?: string): WorkflowStep {
  return { id, name: id, canEditCode, requiresApproval: false, agentId: 'software-engineer', instructions: '', ...(executorId ? { executorId } : {}) };
}

const run = (steps: WorkflowStep[], executorId = 'primary') => ({ executorId, workflowSnapshot: { id: 'w', name: 'w', description: '', enabled: true, steps } });

// ---- The agent that resolves conflicts ----

test('U1 the Development step\'s agent is chosen', () => {
  assert.equal(conflictExecutorFor(run([step('planning', false, 'planner'), step('development', true, 'dev-agent')])), 'dev-agent');
});

test('U2 the Development agent wins over other write-capable steps with different agents', () => {
  assert.equal(conflictExecutorFor(run([step('fix', true, 'first-writer'), step('development', true, 'dev-agent'), step('docs-and-retro', true, 'docs')])), 'dev-agent');
});

test('U3 without a Development step the first write-capable step\'s agent is used, skipping read-only steps before it', () => {
  assert.equal(conflictExecutorFor(run([step('rca', false, 'reader'), step('fix', true, 'fixer'), step('docs-and-retro', true, 'docs')])), 'fixer');
});

test('U4 steps without their own agents fall back to the task\'s assigned agent', () => {
  assert.equal(conflictExecutorFor(run([step('rca', false), step('review', false)], 'assigned')), 'assigned');
  assert.equal(conflictExecutorFor(run([], 'assigned')), 'assigned');
});

test('U5 a Development step without an agent of its own defers to the task\'s agent, not to a later step\'s', () => {
  assert.equal(conflictExecutorFor(run([step('development', true), step('docs-and-retro', true, 'docs')], 'assigned')), 'assigned');
});

test('U6 no agent anywhere gives none', () => {
  assert.equal(conflictExecutorFor(run([step('development', true)], '')), null);
});

test('U7 the Development step is recognised by its id, not its title', () => {
  const titled = { ...step('implementation', true, 'writer'), name: 'Development' };
  assert.equal(conflictExecutorFor(run([titled, { ...step('development', true, 'dev-agent'), name: 'development' }])), 'dev-agent');
  assert.equal(conflictExecutorFor(run([titled])), 'writer');
});

// ---- What a pull request reading means ----

test('U8 a clean reading merges', () => {
  assert.deepEqual(decideAutoMerge(reading()), { action: 'merge', warnings: [] });
});

test('U9 a conflicting reading is resolved', () => {
  assert.deepEqual(decideAutoMerge(reading({ mergeable: 'conflicting' })), { action: 'resolve', warnings: [] });
});

test('U10 conflicts plus blockers resolve first and are not reported as blocked', () => {
  assert.deepEqual(decideAutoMerge(reading({ mergeable: 'conflicting', checks: [{ name: 'build', outcome: 'failing', required: true }], isDraft: true })), { action: 'resolve', warnings: [] });
});

for (const [name, overrides, line] of [
  ['draft', { isDraft: true }, MERGE_BLOCKERS.draft],
  ['failing checks', { checks: [{ name: 'build', outcome: 'failing', required: true }] }, `${MERGE_BLOCKERS.checksFailing}: build`],
  ['pending checks', { checks: [{ name: 'build', outcome: 'pending', required: true }] }, `${MERGE_BLOCKERS.checksPending}: build`],
  ['changes requested', { review: 'changes-requested' }, MERGE_BLOCKERS.changesRequested],
  ['review required', { review: 'review-required' }, MERGE_BLOCKERS.reviewRequired],
  ['behind base', { behindBase: true }, MERGE_BLOCKERS.behindBase],
  ['protection only', { protectionBlocked: true }, MERGE_BLOCKERS.protection],
  ['unknown mergeable', { mergeable: 'unknown' }, MERGE_BLOCKERS.unknown],
] as const) {
  test(`U11 ${name} is blocked with the classifier's text and is never bypassed`, () => {
    assert.deepEqual(decideAutoMerge(reading(overrides as Partial<PullRequestReading>)), { action: 'blocked', reasons: [line], warnings: [] });
  });
}

test('U12 several blockers are all listed, in the classifier\'s order', () => {
  const decision = decideAutoMerge(reading({ isDraft: true, checks: [{ name: 'build', outcome: 'failing', required: true }], review: 'changes-requested' }));
  assert.deepEqual(decision, { action: 'blocked', reasons: [MERGE_BLOCKERS.draft, `${MERGE_BLOCKERS.checksFailing}: build`, MERGE_BLOCKERS.changesRequested], warnings: [] });
});

for (const [name, overrides, reason] of [
  ['closed', { state: 'closed' }, UNMERGEABLE_REASONS.closed],
  ['no permission', { canMerge: false }, UNMERGEABLE_REASONS.noPermission],
  ['head branch gone', { headBranchExists: false }, UNMERGEABLE_REASONS.headGone],
  ['provider refusal', { refusal: 'Repository rules forbid merge commits' }, 'Repository rules forbid merge commits'],
] as const) {
  test(`U13 ${name} cannot be merged, with that reason`, () => {
    assert.deepEqual(decideAutoMerge(reading(overrides as Partial<PullRequestReading>)), { action: 'cannot-merge', reason });
  });
}

test('U14 a merged reading is merged', () => {
  assert.deepEqual(decideAutoMerge(reading({ state: 'merged' })), { action: 'merged' });
});

// ---- Eligibility ----

test('U15 a project without a linked repository is refused with a reason', () => {
  assert.match(autoMergeIneligibleReason({ repositoryUrl: undefined }, null) ?? '', /no linked repository/);
});

test('U16 a run without its own branch is refused with a reason', () => {
  const project = { repositoryUrl: 'https://github.com/test/repo' };
  assert.match(autoMergeIneligibleReason(project, { branch: 'main', baseBranch: undefined }) ?? '', /own branch/);
  assert.match(autoMergeIneligibleReason(project, { branch: undefined, baseBranch: 'main' }) ?? '', /own branch/);
});

test('U17 a repository with a run on its own branch, or a task not started yet, is eligible', () => {
  const project = { repositoryUrl: 'https://github.com/test/repo' };
  assert.equal(autoMergeIneligibleReason(project, { branch: 'feature/x', baseBranch: 'main' }), null);
  assert.equal(autoMergeIneligibleReason(project, null), null);
});

test('the PR number is read from the run\'s URL', () => {
  assert.equal(pullRequestNumberOf('https://github.com/test/repo/pull/42'), 42);
  assert.equal(pullRequestNumberOf('https://github.com/test/repo/pull/42/files'), 42);
  assert.equal(pullRequestNumberOf('https://github.com/test/repo/pulls'), null);
  assert.equal(pullRequestNumberOf(null), null);
});

// ---- Toggle body and stored shape ----

for (const [name, body, expected] of [
  ['true', { enabled: true }, true],
  ['false', { enabled: false }, false],
  ['missing', {}, null],
  ['a string', { enabled: 'true' }, null],
  ['a number', { enabled: 1 }, null],
  ['null', null, null],
  ['an array', [true], null],
  ['an extra key', { enabled: true, other: 1 }, null],
  ['a string body', 'yes', null],
] as const) {
  test(`U18 toggle body ${name} reads as ${expected}`, () => {
    assert.equal(parseAutoMergeToggle(body), expected);
  });
}

test('U19 a task record without the field reads as off', () => {
  assert.equal(readAutoMerge(undefined), null);
});

test('U20 an unknown state falls back to waiting, a corrupt shape reads as off', () => {
  assert.equal(readAutoMerge({ enabled: true, state: 'nonsense', reasons: ['a', 3] })?.state, 'waiting');
  assert.deepEqual(readAutoMerge({ enabled: true, state: 'nonsense', reasons: ['a', 3] })?.reasons, ['a']);
  assert.equal(readAutoMerge({ state: 'merged' }), null);
  assert.equal(readAutoMerge('merged'), null);
  const stored = { ...newAutoMerge(true, '2026-01-01T00:00:00.000Z'), state: 'merged' as const, prNumber: 5, mergedAt: '2026-01-02T00:00:00.000Z' };
  assert.deepEqual(readAutoMerge(stored), stored);
});

test('U23 gh missing, signed out and network failures are the provider being unreachable; a refusal is not', () => {
  for (const text of ['gh is not installed', 'spawn gh ENOENT', 'You are not logged in to any GitHub hosts. Run gh auth login', 'Could not reach GitHub.', 'dial tcp: lookup api.github.com: no such host', 'connect ECONNREFUSED 127.0.0.1:443', 'request timed out']) {
    assert.equal(isProviderUnreachable(text), true, text);
  }
  assert.equal(isProviderUnreachable('Pull request is not mergeable'), false);
});

test('U24 a token, or a URL carrying one, is redacted from a stored reason', () => {
  rememberSecret('ghp_exampleTokenValue123');
  assert.doesNotMatch(safeReason('push to https://x-access-token:ghp_exampleTokenValue123@github.com/o/r failed'), /ghp_example/);
  assert.doesNotMatch(safeReason('clone https://user:pass@github.com/o/r failed'), /user:pass/);
  assert.equal(safeReason('  plain reason  '), 'plain reason');
});

test('U25 the conflict run is titled for the task\'s auto-merge', () => {
  assert.equal(autoMergeConflictTitle('Add login'), 'Auto-merge conflicts · Add login');
  assert.equal(autoMergeConflictTitle('  Add login  '), 'Auto-merge conflicts · Add login');
  assert.equal(autoMergeConflictTitle(''), 'Auto-merge conflicts');
  assert.equal(autoMergeConflictTitle('x'.repeat(500)).length, 'Auto-merge conflicts · '.length + 200);
});

test('U26 only blocked, a failed conflict run, a failure and an unmergeable or missing PR raise a notification', () => {
  const states: AutoMergeState[] = ['waiting', 'merging', 'resolving', 'blocked', 'provider', 'agent', 'merged', 'failed', 'no-pr', 'cannot-merge'];
  const kinds = Object.fromEntries(states.map((state) => [state, notificationKindFor(state)]));
  assert.deepEqual(kinds, {
    waiting: null, merging: null, resolving: null, blocked: 'automerge.blocked', provider: null, agent: null, merged: null,
    failed: 'automerge.failed', 'no-pr': 'automerge.failed', 'cannot-merge': 'automerge.failed',
  });
  assert.equal(notificationKindFor('failed', true), 'automerge.conflict_failed');
  assert.deepEqual(AUTO_MERGE_NOTIFICATION_KINDS, ['automerge.blocked', 'automerge.conflict_failed', 'automerge.failed']);
});

// ---- The per-project queue ----

const gate = () => { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; };

test('U27 jobs of one project run one at a time in order; another project is not held up', async () => {
  const queue = createKeyedQueue();
  const log: string[] = [];
  const first = gate();
  const a = queue.enqueue('p1', 'a', async () => { log.push('a start'); await first.promise; log.push('a end'); });
  const b = queue.enqueue('p1', 'b', async () => { log.push('b'); });
  await queue.enqueue('p2', 'c', async () => { log.push('c'); });
  assert.deepEqual(log, ['a start', 'c'], 'p2 ran while p1 waited on its first job');
  first.open();
  await Promise.all([a, b]);
  assert.deepEqual(log, ['a start', 'c', 'a end', 'b']);
});

test('U28 the same job queued twice before it starts runs once', async () => {
  const queue = createKeyedQueue();
  const first = gate();
  let runs = 0;
  const blocker = queue.enqueue('p', 'blocker', () => first.promise);
  const one = queue.enqueue('p', 'x', async () => { runs += 1; });
  const two = queue.enqueue('p', 'x', async () => { runs += 1; });
  first.open();
  await Promise.all([blocker, one, two]);
  assert.equal(runs, 1);
});

test('U29 a throwing job does not stall the next', async () => {
  const queue = createKeyedQueue();
  const originalError = console.error;
  console.error = () => undefined;
  try {
    let ran = false;
    const failing = queue.enqueue('p', 'bad', async () => { throw new Error('boom'); });
    const next = queue.enqueue('p', 'good', async () => { ran = true; });
    await Promise.all([failing, next]);
    assert.equal(ran, true);
  } finally { console.error = originalError; }
});

test('U30 a job queued again while it runs is queued once more, so it sees what changed meanwhile', async () => {
  const queue = createKeyedQueue();
  const first = gate();
  const seen: number[] = [];
  const one = queue.enqueue('p', 'x', async () => { seen.push(1); await first.promise; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const two = queue.enqueue('p', 'x', async () => { seen.push(2); });
  first.open();
  await Promise.all([one, two]);
  assert.deepEqual(seen, [1, 2]);
});
