import assert from 'node:assert/strict';
import { settledEnqueue } from './helpers/startRun.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { git } from '../src/projects/git.ts';
import type { ProjectRecord, TaskRecord, WorkflowRunRecord } from '../src/domain/types.ts';
import type { StepAction } from './helpers/terminalStepFakes.ts';
import { startPullRequestHarness, waitUntil, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/**
 * Integration cases SI42 to SI52: the conflict-resolution run the PR tab's Merge starts for a
 * conflicting pull request, driven through the real workflow engine with real git (a local bare
 * remote), a scripted `gh` and scripted terminal sessions standing in for the agent.
 */

const STEP = 'resolve-conflicts';
const AGENT = 'test-claude-cli';

let h: PullRequestHarness;

before(async () => { h = await startPullRequestHarness('pr-conflict-run-'); });
after(async () => { await h.close(); });

const merge = (project: ProjectRecord, number: number, body: object = {}) =>
  h.api(`/api/projects/${project.id}/pull-requests/${number}/merge`, { method: 'POST', body: JSON.stringify(body) });
const cwdOf = (project: ProjectRecord) => h.projectService.projectAbsolutePath(project);
const latestRun = (project: ProjectRecord, number: number) => h.manager.latestConflictRun(project.id, number);
const remoteSha = (ref: string, remote = h.remote) => git(remote, ['rev-parse', ref]);
const sessionFor = (taskId: string) => h.terminal.starts.find((start) => start.taskId === taskId)!;
const mergeCallsFor = async (number: number) => (await h.gh.callsTo('pr', 'merge')).filter((args) => args[2] === String(number));

/** A pull request whose branch and the base both added the same file with different content, so merging conflicts. */
async function conflictingPullRequest(number: number, options: { fork?: boolean; pullRequest?: Record<string, unknown> } = {}): Promise<{ file: string; branch: string; sha: string }> {
  const file = `conflict-${number}.txt`;
  const branch = `feature/conflict-${number}`;
  const sha = await h.publishPullRequest({
    number, branch, files: { [file]: 'from the pull request\n' }, fork: options.fork,
    pullRequest: { title: `Conflicting ${number}`, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', ...options.pullRequest },
  });
  await git(h.seed, ['pull', '--quiet', 'origin', 'main']);
  await writeFile(path.join(h.seed, file), 'from the base branch\n');
  await git(h.seed, ['add', '.']);
  await git(h.seed, ['commit', '-m', `base change conflicting with PR ${number}`]);
  await git(h.seed, ['push', '--quiet', 'origin', 'main']);
  return { file, branch, sha };
}

/**
 * The scripted agent: merges the base into the worktree, resolves the conflict and commits, then
 * tells the fake provider what it will report once the push lands and calls complete_step.
 */
function resolvingAgent(
  number: number,
  file: string,
  afterPush: Record<string, unknown> = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
  beforeComplete: () => Promise<void> = async () => undefined,
): StepAction {
  return async (taskId) => {
    const cwd = sessionFor(taskId).cwd;
    await git(cwd, ['fetch', '--quiet', 'origin', 'main']);
    await assert.rejects(() => git(cwd, ['merge', 'origin/main']), 'the merge really conflicts');
    await writeFile(path.join(cwd, file), 'resolved: both sides\n');
    await git(cwd, ['add', '.']);
    await git(cwd, ['commit', '--no-edit']);
    const resolved = await git(cwd, ['rev-parse', 'HEAD']);
    await h.gh.setPull(number, { ...(await currentPull(number)), headRefOid: resolved, ...afterPush });
    await beforeComplete();
    await h.manager.completeStep(taskId, { summary: `Kept both sides of ${file}.` });
  };
}

/** The PR fields the fake `gh` currently holds, so a test can change a few and keep the rest. */
async function currentPull(number: number): Promise<Record<string, unknown>> {
  const state = JSON.parse(await readFile(path.join(h.root, 'fake-gh-bin', 'state.json'), 'utf8')) as { pulls: Record<string, { pullRequest: Record<string, unknown> }> };
  return state.pulls[String(number)]!.pullRequest;
}

async function settled(project: ProjectRecord, number: number, statuses: WorkflowRunRecord['status'][]): Promise<WorkflowRunRecord> {
  await waitUntil(async () => statuses.includes((await latestRun(project, number))?.status as WorkflowRunRecord['status']), `run for #${number} to be ${statuses.join('/')}`);
  await waitUntil(async () => (await h.projectService.getProject(project.id)).status === 'idle', 'the project to go idle');
  return (await latestRun(project, number))!;
}

async function insertLiveFolderTask(project: ProjectRecord): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), projectId: project.id, templateId: 'software-engineer', executorId: AGENT, executionMode: 'terminal', description: 'other work',
    status: 'developing', autonomy: 'auto', manager: false, kind: 'execute', planItemId: null, sessionId: null, branch: 'main',
    runtimeStatus: 'starting', runtimeWaitingReason: null, runtimeStatusChangedAt: now, blockedQuestion: null, failureReason: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, createdAt: now, updatedAt: now, completedAt: null,
  } as unknown as TaskRecord;
  await h.collections.tasksDb.insert(task);
  await h.projectService.patchProject(project.id, { activeTaskIds: [task.id], activeTaskId: task.id });
  return task;
}

test('SI42 a conflicting PR with a chosen agent starts a run on the built-in conflict workflow, in its own worktree', async () => {
  const project = await h.createProject('SI42');
  const pr = await conflictingPullRequest(301);
  h.stepActions[STEP] = () => undefined; // the agent keeps working

  const res = await merge(project, 301, { executorId: AGENT });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'resolving');
  assert.equal(res.body.existing, false);
  assert.equal(res.body.run.status, 'starting', 'accepted before the worktree and agent are set up');
  await h.manager.whenStartupSettled(res.body.run.id);
  const run = (await h.collections.workflowRunsDb.get(res.body.run.id))!;
  assert.equal(run.workflowId, 'pr-conflict-resolution');
  assert.notEqual(run.workflowId, (await h.projectService.getProject(project.id)).workflowId ?? 'software-development');
  assert.equal(run.workflowSnapshot.steps.length, 1);
  assert.equal(run.workflowSnapshot.steps[0]!.canEditCode, true);
  assert.equal(run.workflowSnapshot.steps[0]!.requiresApproval, false);
  assert.equal(run.status, 'running');
  assert.equal(run.executorId, AGENT);
  assert.deepEqual(run.prConflict, { number: 301, title: 'Conflicting 301', headBranch: pr.branch, baseBranch: 'main', pushRemote: 'origin', outcome: null, detail: null });
  assert.equal(run.baseBranch, 'origin/main');
  assert.match(run.branch!, /^pr-conflicts\/301-[0-9a-f]{8}$/);

  assert.ok(run.worktreePath && run.worktreePath !== cwdOf(project) && existsSync(run.worktreePath));
  assert.equal(await git(run.worktreePath, ['rev-parse', 'HEAD']), pr.sha, 'the worktree starts at the PR head');
  assert.equal(await git(run.worktreePath, ['symbolic-ref', '--short', 'HEAD']), run.branch);

  const item = await h.collections.planItemsDb.get(run.planItemId);
  assert.equal(item!.title, 'Resolve conflicts: #301 Conflicting 301');
  assert.equal(item!.status, 'developing');
  assert.equal(item!.prConflict!.number, 301);

  const session = h.terminal.starts.at(-1)!;
  assert.equal(session.cwd, run.worktreePath);
  assert.equal(session.readOnly, false, 'the step is write-capable');
  assert.match(session.prompt, /git merge origin\/main/);
  assert.match(session.prompt, /Never force push/);
  assert.doesNotMatch(session.systemPrompt ?? '', /force/i);

  await h.manager.stopWorkflowRun(run.id);
  await settled(project, 301, ['stopped']);
});

test('SI43 a conflicting PR with no agent chosen is a 400, and no run or plan item is created', async () => {
  const project = await h.createProject('SI43');
  await conflictingPullRequest(302);
  const res = await merge(project, 302, { confirmBlockers: true });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Choose a coding agent/);
  assert.equal(await latestRun(project, 302), null);
  assert.deepEqual(await h.collections.planItemsDb.find((item) => item.projectId === project.id), []);
});

test('SI44 an unknown or unusable agent is refused and leaves no run or plan item behind', async () => {
  const project = await h.createProject('SI44');
  await conflictingPullRequest(303);
  const unknown = await merge(project, 303, { executorId: 'no-such-agent' });
  assert.equal(unknown.status, 404);
  const unsupported = await merge(project, 303, { executorId: 'test-unsupported' });
  assert.equal(unsupported.status, 422);
  assert.equal(await latestRun(project, 303), null);
  assert.deepEqual(await h.collections.planItemsDb.find((item) => item.projectId === project.id), []);
  assert.deepEqual(await h.collections.workflowRunsDb.find((run) => run.projectId === project.id), []);
});

test('SI44 a run whose workspace can\'t be created fails at its worktree step, leaving no worktree', async () => {
  const project = await h.createProject('SI44b');
  // The provider reports a conflicting PR whose head ref can't be fetched.
  await h.gh.setPull(304, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  const res = await merge(project, 304, { executorId: AGENT });
  assert.equal(res.status, 200);
  await h.manager.whenStartupSettled(res.body.run.id);
  const run = (await latestRun(project, 304))!;
  assert.equal(run.status, 'failed');
  const failed = run.startup!.steps.find((step) => step.state === 'failed')!;
  assert.equal(failed.id, 'worktree');
  assert.match(failed.reason!, /no longer exists/);
  assert.ok(!run.worktreePath || !existsSync(run.worktreePath));
});

test('SI45 the run starts at once while another task holds the Project folder and the queue', async () => {
  const project = await h.createProject('SI45');
  await conflictingPullRequest(305);
  const other = await insertLiveFolderTask(project);
  h.stepActions[STEP] = () => undefined;

  const res = await merge(project, 305, { executorId: AGENT });
  assert.equal(res.status, 200);
  await h.manager.whenStartupSettled(res.body.run.id);
  assert.equal((await h.collections.workflowRunsDb.get(res.body.run.id))!.status, 'running');
  assert.deepEqual(await h.manager.listPlanItemQueue(project.id), [], 'it never joined the queue');

  await h.manager.stopWorkflowRun(res.body.run.id);
  await waitUntil(async () => !(await h.projectService.getProject(project.id)).activeTaskIds.some((id) => id !== other.id), 'the step session to settle');
  await h.collections.tasksDb.delete(other.id);
  await h.projectService.patchProject(project.id, { activeTaskIds: [], activeTaskId: null, status: 'idle' });

  // A stopped ordinary run would hold the plan-item queue; a conflict run's item never does.
  const { createPlanItem } = await import('../src/projects/planItemService.ts');
  const next = await createPlanItem({ projectId: project.id, title: 'Unrelated task', description: 'x' });
  const queued = await settledEnqueue(h.manager)(next.id, { executorId: AGENT, createBranch: false });
  assert.equal(queued.started, true, 'started at once instead of queueing behind the conflict run');
  await h.manager.deletePlanItem(next.id);
});

test('SI46 and SI49 with the PR branch checked out in the Project folder, the run resolves, pushes and merges, and the checkout is untouched', async () => {
  const project = await h.createProject('SI46');
  const pr = await conflictingPullRequest(306);
  assert.equal((await h.api(`/api/projects/${project.id}/pull-requests/306/checkout`, { method: 'POST' })).status, 200);
  const cwd = cwdOf(project);
  assert.equal(await git(cwd, ['symbolic-ref', '--short', 'HEAD']), pr.branch);
  await h.gh.clearCalls();
  h.stepActions[STEP] = resolvingAgent(306, pr.file);

  const res = await merge(project, 306, { executorId: AGENT });
  assert.equal(res.status, 200);
  const run = await settled(project, 306, ['completed', 'failed']);

  assert.equal(run.status, 'completed', run.attentionReason ?? '');
  assert.equal(run.prConflict!.outcome, 'merged');
  assert.match(run.prConflict!.detail!, /Merged, and the branch "feature\/conflict-306" was deleted/);
  assert.equal((await h.collections.planItemsDb.get(run.planItemId))!.status, 'done');
  assert.ok(run.completedAt);

  // The resolution reached the PR's head branch as a merge commit on top of the old head, never forced.
  const pushed = await remoteSha(`refs/heads/${pr.branch}`);
  assert.notEqual(pushed, pr.sha);
  assert.equal(await git(h.remote, ['rev-list', '--parents', '-n', '1', pushed]).then((line) => line.split(' ').length), 3, 'a merge commit with two parents');
  assert.equal(await git(h.remote, ['merge-base', '--is-ancestor', pr.sha, pushed]).then(() => true), true);
  assert.equal(await git(h.remote, ['show', `${pushed}:${pr.file}`]), 'resolved: both sides');
  assert.deepEqual(await mergeCallsFor(306), [['pr', 'merge', '306', '--repo', 'test/repo', '--merge']], 'the automatic merge never bypasses protection');
  assert.ok((await h.gh.calls()).some((args) => args.join(' ') === `api -X DELETE repos/test/repo/git/refs/heads/${pr.branch}`));
  assert.equal(await git(h.remote, ['for-each-ref', 'refs/heads/pr-conflicts']), '', 'the run-local branch was never pushed');

  // The Project's own checkout: same branch, same commit, same files, simply behind now.
  assert.equal(await git(cwd, ['symbolic-ref', '--short', 'HEAD']), pr.branch);
  assert.equal(await git(cwd, ['rev-parse', 'HEAD']), pr.sha);
  assert.equal(await readFile(path.join(cwd, pr.file), 'utf8'), 'from the pull request\n');
  assert.equal(await git(cwd, ['status', '--porcelain', '--untracked-files=no']), '');
  const sync = await h.poller.computeProjectSync(await h.projectService.getProject(project.id));
  assert.deepEqual([sync.branch, sync.status], [pr.branch, 'behind']);

  // The run's worktree and its run-local branch are gone.
  assert.ok(!existsSync(run.worktreePath!));
  assert.equal(await git(cwd, ['for-each-ref', `refs/heads/${run.branch}`]), '');
});

test('SI47 a second Merge click during an active run returns that run; two simultaneous clicks create exactly one', async () => {
  const project = await h.createProject('SI47');
  await conflictingPullRequest(307);
  h.stepActions[STEP] = () => undefined;

  const [first, second] = await Promise.all([merge(project, 307, { executorId: AGENT }), merge(project, 307, { executorId: AGENT })]);
  assert.ok([first.status, second.status].includes(200));
  assert.equal((await h.collections.workflowRunsDb.find((run) => run.projectId === project.id)).length, 1, 'exactly one run');
  const run = (await latestRun(project, 307))!;

  const again = await merge(project, 307);
  assert.equal(again.status, 200, 'no agent is needed to be shown the run already working');
  assert.deepEqual([again.body.outcome, again.body.existing, again.body.run.id], ['resolving', true, run.id]);
  assert.equal((await h.collections.workflowRunsDb.find((r) => r.projectId === project.id)).length, 1);
  assert.equal((await h.collections.planItemsDb.find((item) => item.projectId === project.id)).length, 1);
  assert.equal((await h.manager.activeConflictRun(project.id, 307))!.id, run.id);

  await h.manager.stopWorkflowRun(run.id);
  await settled(project, 307, ['stopped']);
  assert.equal(await h.manager.activeConflictRun(project.id, 307), null);
});

test('SI48 runs for two different PRs are active together', async () => {
  const project = await h.createProject('SI48');
  await conflictingPullRequest(308);
  await conflictingPullRequest(309);
  h.stepActions[STEP] = () => undefined;
  const a = await merge(project, 308, { executorId: AGENT });
  const b = await merge(project, 309, { executorId: AGENT });
  await h.manager.whenStartupSettled(a.body.run.id);
  await h.manager.whenStartupSettled(b.body.run.id);
  const statuses = await Promise.all([a, b].map(async (res) => (await h.collections.workflowRunsDb.get(res.body.run.id))!.status));
  assert.deepEqual(statuses, ['running', 'running']);
  assert.notEqual(a.body.run.worktreePath, b.body.run.worktreePath);
  assert.ok(await h.manager.activeConflictRun(project.id, 308) && await h.manager.activeConflictRun(project.id, 309));
  await h.manager.stopWorkflowRun(a.body.run.id);
  await h.manager.stopWorkflowRun(b.body.run.id);
});

test('SI49 the re-check waits out the provider\'s stale "unknown" reading before merging', async () => {
  const project = await h.createProject('SI49');
  const pr = await conflictingPullRequest(310);
  // Right after the push the provider still answers "unknown" twice before its real reading shows.
  h.stepActions[STEP] = resolvingAgent(310, pr.file, undefined, () => h.gh.patch({ staleReads: 2 }));
  assert.equal((await merge(project, 310, { executorId: AGENT })).status, 200);
  const run = await settled(project, 310, ['completed', 'failed']);
  assert.equal(run.prConflict!.outcome, 'merged', run.attentionReason ?? '');
  assert.equal((await mergeCallsFor(310)).length, 1);
});

test('SI49 a provider that never settles leaves the PR unmerged and waiting, never merged on an unknown state', async () => {
  const project = await h.createProject('SI49b');
  const pr = await conflictingPullRequest(323);
  h.stepActions[STEP] = resolvingAgent(323, pr.file, undefined, () => h.gh.patch({ staleReads: 50 }));
  await merge(project, 323, { executorId: AGENT });
  const run = await settled(project, 323, ['completed', 'failed']);
  await h.gh.patch({ staleReads: 0 });
  assert.equal(run.prConflict!.outcome, 'resolved');
  assert.match(run.prConflict!.detail!, /Merge state is not known yet/);
  assert.deepEqual(await mergeCallsFor(323), []);
});

test('SI50 resolved with other blockers left: not merged, the run reads "resolved", and a confirmed merge then succeeds', async () => {
  const project = await h.createProject('SI50');
  const pr = await conflictingPullRequest(311, { pullRequest: { isDraft: true } });
  h.stepActions[STEP] = resolvingAgent(311, pr.file, { mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' });

  await merge(project, 311, { executorId: AGENT });
  const run = await settled(project, 311, ['completed', 'failed']);
  assert.equal(run.status, 'completed');
  assert.equal(run.prConflict!.outcome, 'resolved');
  assert.match(run.prConflict!.detail!, /Conflicts resolved\. Merging still needs your confirmation: This PR is a draft\./);
  assert.deepEqual(await mergeCallsFor(311), [], 'nothing merges without the person confirming');
  assert.equal(await h.manager.activeConflictRun(project.id, 311), null);

  const unconfirmed = await merge(project, 311);
  assert.deepEqual(unconfirmed.body, { outcome: 'needs-confirmation', blockers: ['This PR is a draft'] });
  const confirmed = await merge(project, 311, { confirmBlockers: true });
  assert.equal(confirmed.body.outcome, 'merged');
  assert.equal((await mergeCallsFor(311)).length, 1);
});

test('SI51 resolved but the re-check still conflicts: the run is reported failed with that reason and the PR stays unmerged', async () => {
  const project = await h.createProject('SI51');
  const pr = await conflictingPullRequest(312);
  h.stepActions[STEP] = resolvingAgent(312, pr.file, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  await merge(project, 312, { executorId: AGENT });
  const run = await settled(project, 312, ['completed', 'failed']);
  assert.equal(run.status, 'failed');
  assert.equal(run.prConflict!.outcome, 'failed');
  assert.match(run.attentionReason!, /still conflicts with its base/);
  assert.equal((await h.collections.planItemsDb.get(run.planItemId))!.status, 'failed');
  assert.deepEqual(await mergeCallsFor(312), []);
  assert.ok(!existsSync(run.worktreePath!), 'a Retry starts from a fresh worktree');
});

test('SI52 an agent session that ends without finishing merges nothing, and Retry starts a fresh run with the newly chosen agent', async () => {
  const project = await h.createProject('SI52a');
  const pr = await conflictingPullRequest(313);
  h.stepActions[STEP] = (_taskId, exit) => exit();
  const first = await merge(project, 313, { executorId: AGENT });
  const failed = await settled(project, 313, ['needs-attention']);
  assert.equal(failed.id, first.body.run.id);
  assert.match(failed.attentionReason!, /Resolve conflicts step ended without completing/);
  assert.deepEqual(await mergeCallsFor(313), []);
  assert.equal(await remoteSha(`refs/heads/${pr.branch}`), pr.sha, 'nothing was pushed');
  assert.equal(await h.manager.activeConflictRun(project.id, 313), null, 'a failed run does not block a retry');

  h.stepActions[STEP] = resolvingAgent(313, pr.file);
  const retry = await merge(project, 313, { executorId: 'test-claude-cli-alt' });
  assert.equal(retry.status, 200);
  assert.deepEqual([retry.body.outcome, retry.body.existing], ['resolving', false]);
  assert.notEqual(retry.body.run.id, failed.id);
  assert.equal(retry.body.run.executorId, 'test-claude-cli-alt');
  const merged = await settled(project, 313, ['completed', 'failed']);
  assert.equal(merged.prConflict!.outcome, 'merged', merged.attentionReason ?? '');

  const retired = await h.collections.workflowRunsDb.get(failed.id);
  assert.equal(retired!.status, 'stopped');
  assert.equal((await h.collections.planItemsDb.get(failed.planItemId))!.archived, true, 'the failed card leaves the board');
  assert.notEqual(merged.planItemId, failed.planItemId);
  assert.equal((await latestRun(project, 313))!.id, merged.id, 'the PR re-associates with its newest run');
});

test('SI52 stopping the run merges nothing and keeps what the agent already pushed', async () => {
  const project = await h.createProject('SI52b');
  const pr = await conflictingPullRequest(314);
  let agentPushed = '';
  h.stepActions[STEP] = async (taskId) => {
    // The agent pushed a commit itself, then kept working.
    const cwd = sessionFor(taskId).cwd;
    await writeFile(path.join(cwd, 'partial.txt'), 'partial work');
    await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'partial']);
    await git(cwd, ['push', '--quiet', 'origin', `HEAD:refs/heads/${pr.branch}`]);
    agentPushed = await git(cwd, ['rev-parse', 'HEAD']);
  };
  const started = await merge(project, 314, { executorId: AGENT });
  await waitUntil(() => agentPushed !== '', 'the agent to push');

  await h.manager.stopWorkflowRun(started.body.run.id);
  const run = await settled(project, 314, ['stopped']);
  assert.equal(run.prConflict!.outcome, null);
  assert.deepEqual(await mergeCallsFor(314), []);
  assert.equal(await remoteSha(`refs/heads/${pr.branch}`), agentPushed, 'pushed commits stay on the PR branch');
  assert.equal((await h.collections.planItemsDb.get(run.planItemId))!.status, 'blocked', 'shown under Needs you');
});

test('SI52 a PR closed or merged while the agent worked is not merged: the run fails with the provider\'s reason', async () => {
  const project = await h.createProject('SI52c');
  for (const [number, state, reason] of [[315, 'CLOSED', 'This PR is closed'], [316, 'MERGED', 'This PR is already merged']] as const) {
    const pr = await conflictingPullRequest(number);
    h.stepActions[STEP] = resolvingAgent(number, pr.file, { state, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    await merge(project, number, { executorId: AGENT });
    const run = await settled(project, number, ['completed', 'failed']);
    assert.equal(run.status, 'failed');
    assert.equal(run.attentionReason, reason);
    assert.deepEqual(await mergeCallsFor(number), []);
    const refused = await merge(project, number, { executorId: AGENT });
    assert.deepEqual([refused.status, refused.body.error], [409, reason]);
  }
});

test('SI52 a merge the provider refuses after the resolution fails the run with that reason', async () => {
  const project = await h.createProject('SI52d');
  const pr = await conflictingPullRequest(317);
  h.stepActions[STEP] = resolvingAgent(317, pr.file);
  await h.gh.patch({ fail: { merge: 'GraphQL: Base branch was modified. Review and try the merge again.' } });
  await merge(project, 317, { executorId: AGENT });
  const run = await settled(project, 317, ['completed', 'failed']);
  await h.gh.patch({ fail: {} });
  assert.equal(run.status, 'failed');
  assert.equal(run.attentionReason, 'Conflicts were resolved, but the merge failed: Base branch was modified. Review and try the merge again.');
  // The conflicts are gone, so the PR now merges from its row without another run.
  assert.equal((await merge(project, 317)).body.outcome, 'merged');
});

test('SI52 a fork PR is pushed to the fork, not to origin; a fork that refuses the push fails the run with the reason', async () => {
  const project = await h.createProject('SI52e');
  await git(h.root, ['clone', '--quiet', '--bare', h.remote, 'fork.git']);
  const pr = await conflictingPullRequest(318, { fork: true });
  await git(h.seed, ['push', '--quiet', path.join(h.root, 'fork.git'), `${pr.sha}:refs/heads/${pr.branch}`]);
  h.stepActions[STEP] = resolvingAgent(318, pr.file);

  const started = await merge(project, 318, { executorId: AGENT });
  assert.equal(started.body.run.prConflict.pushRemote, 'https://github.com/test/fork.git');
  const run = await settled(project, 318, ['completed', 'failed']);
  assert.equal(run.prConflict!.outcome, 'merged', run.attentionReason ?? '');
  assert.match(run.prConflict!.detail!, /lives in a fork, so it was left in place/);
  assert.notEqual(await remoteSha(`refs/heads/${pr.branch}`, path.join(h.root, 'fork.git')), pr.sha, 'the fork branch moved');
  assert.equal(await git(h.remote, ['for-each-ref', `refs/heads/${pr.branch}`]), '', 'origin got no branch of that name');

  const unreachable = await conflictingPullRequest(319, { fork: true, pullRequest: { headRepository: { url: 'https://github.com/test/no-such-fork' } } });
  h.stepActions[STEP] = resolvingAgent(319, unreachable.file);
  await merge(project, 319, { executorId: AGENT });
  const failed = await settled(project, 319, ['completed', 'failed']);
  assert.equal(failed.status, 'failed');
  assert.match(failed.attentionReason!, /The resolution could not be pushed to "feature\/conflict-319"/);
  assert.deepEqual(await mergeCallsFor(319), []);
});

test('SI52 after a daemon restart a PR re-associates with its run by number, and interrupted runs are settled', async () => {
  const project = await h.createProject('SI52f');
  await conflictingPullRequest(320);
  await conflictingPullRequest(321);
  h.stepActions[STEP] = () => undefined;
  const running = (await merge(project, 320, { executorId: AGENT })).body.run as WorkflowRunRecord;
  const merging = (await merge(project, 321, { executorId: AGENT })).body.run as WorkflowRunRecord;
  // The previous process died while #321 was between its push and its merge.
  await h.collections.workflowRunsDb.update(merging.id, { status: 'completing', currentStepId: null });

  const { createWorkerManager } = await import('../src/worker/workerManager.ts');
  const restarted = createWorkerManager({ terminalSessions: { ...sessionHost(), has: () => false } });
  assert.equal((await restarted.latestConflictRun(project.id, 320))!.id, running.id);
  assert.equal(await restarted.latestConflictRun(project.id, 999), null);
  await restarted.resumeInterruptedTasks();

  const orphaned = (await restarted.latestConflictRun(project.id, 320))!;
  assert.equal(orphaned.status, 'needs-attention');
  assert.match(orphaned.attentionReason!, /daemon restarted/);
  const interrupted = (await restarted.latestConflictRun(project.id, 321))!;
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.attentionReason, 'The daemon restarted while the pull request was being merged.');
  assert.equal(interrupted.prConflict!.outcome, 'failed');
  assert.equal(await restarted.activeConflictRun(project.id, 320), null);
  assert.equal(await restarted.activeConflictRun(project.id, 321), null);
});

/** A terminal host that starts nothing — the restarted manager only needs to see that no session survived. */
function sessionHost() {
  return {
    start() {}, attach: () => () => undefined, write() {}, resize() {}, stop: () => false, has: () => false, isAttached: () => false, count: () => 0,
  };
}

test('a conflict run can\'t be skipped, interim-committed or pushed by marking its card complete', async () => {
  const project = await h.createProject('Guards');
  const pr = await conflictingPullRequest(322);
  let taskId = '';
  h.stepActions[STEP] = (id) => { taskId = id; };
  const run = (await merge(project, 322, { executorId: AGENT })).body.run as WorkflowRunRecord;
  await waitUntil(() => taskId !== '', 'the step session to start');

  await assert.rejects(() => h.manager.skipStep(taskId, { reason: 'no' }), /can't be skipped/);
  await assert.rejects(() => h.manager.interimCommitTask(taskId), /interim/i);

  await writeFile(path.join(run.worktreePath!, 'unfinished.txt'), 'half done');
  await h.manager.completePlanItem(run.planItemId);
  assert.equal(await remoteSha(`refs/heads/${pr.branch}`), pr.sha, 'marking complete pushed nothing to the PR branch');
  assert.equal(await git(h.remote, ['for-each-ref', 'refs/heads/pr-conflicts']), '');
  assert.deepEqual(await mergeCallsFor(322), []);
});
