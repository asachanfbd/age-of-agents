import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ProjectRecord } from '../src/domain/types.ts';
import { startPullRequestHarness, type PullRequestHarness } from './helpers/pullRequestHarness.ts';

/** I26 of task 10.018: the real git readers against a project clone of a local bare remote. */

// Value imports from src/ must wait until the harness has pointed config.ts at its temp folders.
let realDependencyGit: typeof import('../src/projects/dependencyGit.ts').realDependencyGit;
let git: typeof import('../src/projects/git.ts').git;
let h: PullRequestHarness;
let project: ProjectRecord;
let dir: string;

before(async () => {
  h = await startPullRequestHarness('dependency-git-');
  ({ realDependencyGit } = await import('../src/projects/dependencyGit.ts'));
  ({ git } = await import('../src/projects/git.ts'));
  project = await h.createProject('Dependency git');
  dir = h.projectService.projectAbsolutePath(project);
});
after(async () => { await h.close(); });

async function branchWithCommit(name: string): Promise<string> {
  await git(dir, ['switch', '--quiet', '-c', name, 'main']);
  await writeFile(path.join(dir, `${name.replaceAll('/', '-')}.txt`), `${name}\n`);
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', name]);
  const head = await git(dir, ['rev-parse', 'HEAD']);
  await git(dir, ['switch', '--quiet', 'main']);
  return head;
}

test('the checked-out branch, a branch head and a missing branch', async () => {
  assert.equal(await realDependencyGit.checkedOutBranch(project), 'main');
  const head = await branchWithCommit('task/head');
  assert.equal(await realDependencyGit.branchHead(project, 'task/head'), head);
  assert.equal(await realDependencyGit.branchHead(project, 'task/missing'), null);
});

test('a merge commit puts the parent\'s last commit in the branch; a squash does not, but its own commit is', async () => {
  const head = await branchWithCommit('task/merge');
  assert.equal(await realDependencyGit.isAncestor(project, head, 'main'), false);
  await git(dir, ['merge', '--no-ff', '--no-edit', 'task/merge']);
  assert.equal(await realDependencyGit.isAncestor(project, head, 'main'), true);

  const squashed = await branchWithCommit('task/squash');
  await git(dir, ['merge', '--squash', 'task/squash']);
  await git(dir, ['commit', '-m', 'squash of task/squash']);
  const squashCommit = await git(dir, ['rev-parse', 'HEAD']);
  assert.equal(await realDependencyGit.isAncestor(project, squashed, 'main'), false);
  assert.equal(await realDependencyGit.isAncestor(project, squashCommit, 'main'), true);
});

test('an unknown commit is simply not an ancestor', async () => {
  assert.equal(await realDependencyGit.isAncestor(project, 'f'.repeat(40), 'main'), false);
});

test('commits ahead counts a branch\'s own commits; null for an unknown branch', async () => {
  await branchWithCommit('task/ahead');
  assert.equal(await realDependencyGit.commitsAhead(project, 'task/ahead', 'main'), 1);
  await git(dir, ['branch', 'task/empty', 'main']);
  assert.equal(await realDependencyGit.commitsAhead(project, 'task/empty', 'main'), 0);
  assert.equal(await realDependencyGit.commitsAhead(project, 'task/none', 'main'), null);
});

test('a detached HEAD has no checked-out branch', async () => {
  await git(dir, ['switch', '--quiet', '--detach']);
  assert.equal(await realDependencyGit.checkedOutBranch(project), null);
  await git(dir, ['switch', '--quiet', 'main']);
});

test('the pull request reading is null when the provider has none for the branch', async () => {
  assert.equal(await realDependencyGit.pullRequest(project, 'feature/no-such-branch'), null);
});
