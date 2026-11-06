import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import {
  git, addWorktree, addWorktreeForBranch, removeWorktree,
  diffStat, diffNameStatus, diffForFile,
  gh, GhError, ghPrViewForBranch,
} from '../src/projects/git.ts';

/**
 * Real-git coverage (no daemon/project machinery, unlike gitProjects.test.ts) for task 3.012's new
 * git.ts helpers: the WorkflowRun diff-paging functions and the `gh`-backed PR/stacking helpers.
 * `origin` is a local bare repo, never github.com — `gh` itself still runs for real (it's installed
 * on this machine), but every call here is expected to fail cleanly (this repo isn't hosted on
 * GitHub), which is exactly the "no PR to report" / "gh unavailable" path these helpers are built
 * to tolerate. Nothing here ever reaches the network.
 */

let root: string;
let repo: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'git-workflow-test-'));
  const bare = path.join(root, 'origin.git');
  await git(root, ['init', '--bare', '--initial-branch=main', bare]);
  await git(root, ['clone', bare, 'repo']);
  repo = path.join(root, 'repo');
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  await git(repo, ['push', 'origin', 'main']);
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('diffStat/diffNameStatus/diffForFile report a branch\'s changes against its base', async () => {
  const worktreePath = path.join(root, 'wt-diff');
  await addWorktree(repo, worktreePath, 'feature-diff', 'main');
  await writeFile(path.join(worktreePath, 'new-file.txt'), 'added content\n');
  await writeFile(path.join(worktreePath, 'README.md'), 'hello\nchanged\n');
  await git(worktreePath, ['add', '.']);
  await git(worktreePath, ['commit', '-m', 'add and change']);

  const stat = await diffStat(worktreePath, 'main');
  assert.match(stat, /new-file\.txt/);
  assert.match(stat, /README\.md/);

  const nameStatus = await diffNameStatus(worktreePath, 'main');
  assert.equal(nameStatus.length, 2);
  assert.ok(nameStatus.some((f) => f.status === 'M' && f.path === 'README.md'));
  assert.ok(nameStatus.some((f) => f.status === 'A' && f.path === 'new-file.txt'));

  const fileDiff = await diffForFile(worktreePath, 'main', 'new-file.txt');
  assert.match(fileDiff, /\+added content/);
  assert.equal(await diffForFile(worktreePath, 'main', 'does-not-exist.txt'), '', 'a path with no changes has an empty diff, not an error');

  await removeWorktree(repo, worktreePath);
});

test('addWorktreeForBranch creates a new branch normally, then reuses it on a retry instead of failing', async () => {
  const worktreePath1 = path.join(root, 'wt-retry-1');
  await addWorktreeForBranch(repo, worktreePath1, 'task/retry-me', 'main');
  assert.equal(await git(worktreePath1, ['symbolic-ref', '--short', 'HEAD']), 'task/retry-me');
  await removeWorktree(repo, worktreePath1);

  // The branch now already exists — a plain `addWorktree` would fail on `-b`, but this falls back
  // to checking it out as-is, exactly what a retried WorkflowRun for the same PlanItem needs.
  const worktreePath2 = path.join(root, 'wt-retry-2');
  await addWorktreeForBranch(repo, worktreePath2, 'task/retry-me', 'main');
  assert.equal(await git(worktreePath2, ['symbolic-ref', '--short', 'HEAD']), 'task/retry-me');
  await removeWorktree(repo, worktreePath2);
});

test('gh() runs the real CLI and throws GhError (not a raw child_process error) when the command fails', async () => {
  await assert.rejects(() => gh(repo, ['pr', 'view', 'no-such-branch', '--json', 'url,state']), GhError);
});

test('ghPrViewForBranch never throws — it resolves null when gh has no repository/PR to report', async () => {
  assert.equal(await ghPrViewForBranch(repo, 'main'), null);
});
