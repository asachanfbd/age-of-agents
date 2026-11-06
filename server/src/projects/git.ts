import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../redaction.ts';
import { GithubAccountError, accountFailureMessage, githubScope, operationEnv } from '../github/context.ts';
const exec = promisify(execFile);
export class GitError extends Error {}

/** The failure as the person should see it: the active project account's sign-in/access message when the text is about credentials, otherwise the redacted tool text. */
function toolFailure(error: unknown, fallback: (message: string) => Error): Error {
  const message = redactSecrets((error as Error).message);
  const context = githubScope.getStore();
  const accountMessage = context ? accountFailureMessage(context, message) : null;
  return accountMessage ? new GithubAccountError(accountMessage) : fallback(message);
}

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: operationEnv() });
    return stdout.trim();
  } catch (error) { throw toolFailure(error, (message) => new GitError(`Git operation failed: ${message}`)); }
}
// https:// stays pinned to github.com (an https rewrite to another identity happens
// transparently via git's own url.<base>.insteadOf config, so the app never sees it).
// git@ SSH URLs loosen the host to any hostname-shaped string, because a per-identity
// setup commonly aliases it in ~/.ssh/config (e.g. `Host github.com-work`) rather than
// using the literal `github.com` — the owner/repo path stays restricted either way.
const GITHUB_HTTPS_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
const GITHUB_SSH_URL = /^git@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
export function validateRepository(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!GITHUB_HTTPS_URL.test(trimmed) && !GITHUB_SSH_URL.test(trimmed)) {
    throw new GitError('Enter a GitHub repository URL (https://github.com/owner/repo or git@host:owner/repo.git — host can be a custom SSH alias from your ~/.ssh/config).');
  }
  return trimmed;
}

/** Browser and CLI identity for a validated GitHub remote, including SSH aliases. */
export function githubRepository(value: string): { slug: string; url: string } | null {
  try { validateRepository(value); } catch { return null; }
  const slug = value.trim().replace(/^https:\/\/github\.com\/|^git@[^:]+:/, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (slug.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return { slug, url: `https://github.com/${slug}` };
}
/** True only when `root` is the top level of its own git repo — not merely nested inside some other repo (e.g. a hand-created Project living under this daemon's own repo-ignored projects/ directory), which would otherwise make git silently answer for the wrong repo. False for a missing directory too. */
export async function isOwnGitRepo(root: string): Promise<boolean> {
  try {
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    const [realTop, realRoot] = await Promise.all([
      realpath(top).catch(() => path.resolve(top)),
      realpath(root).catch(() => path.resolve(root)),
    ]);
    return realTop === realRoot;
  } catch {
    return false;
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ['symbolic-ref', '--short', 'HEAD']);
}

/**
 * Streams a NUL-separated git output (`-z` flags) one record at a time, so a huge listing never has
 * to fit in the buffered `git()` helper's output limit or in memory as one string. Throws a GitError
 * if git exits non-zero.
 */
export async function* gitRecords(cwd: string, args: string[]): AsyncGenerator<string> {
  const child = spawn('git', args, { cwd, env: operationEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill(), 120_000);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString(); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  exit.catch(() => undefined);
  child.stdout.setEncoding('utf8');
  let rest = '';
  try {
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      const parts = (rest + chunk).split('\0');
      rest = parts.pop() as string;
      for (const part of parts) yield part;
    }
    const code = await exit.catch((error: Error) => { throw toolFailure(error, (message) => new GitError(`Git operation failed: ${message}`)); });
    if (code !== 0) throw toolFailure(new Error(stderr.trim() || `git exited with code ${code}`), (message) => new GitError(`Git operation failed: ${message}`));
    if (rest) yield rest;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

const OPERATION_MARKERS: [string, GitOperation][] = [
  ['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'],
];

/** The unfinished merge, rebase, cherry-pick or revert in `cwd`'s repository, if any. Works for a worktree, whose `.git` is a file. */
export async function detectGitOperationInProgress(cwd: string): Promise<GitOperation | null> {
  const gitDir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
  for (const [marker, operation] of OPERATION_MARKERS) {
    if (await access(path.join(gitDir, marker)).then(() => true, () => false)) return operation;
  }
  return null;
}

/** `git status --porcelain` lines for every modified, added, deleted or untracked path (ignored files excluded) — empty for a clean working tree. */
export async function workingTreeChanges(cwd: string): Promise<string[]> {
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  return status ? status.split('\n').map((line) => line.trim()) : [];
}

/** Whether `branch` already has a local ref (`refs/heads/<branch>`) — used by `projectService.ts`'s `checkoutProjectBranch` and `projects/branchName.ts`'s `uniqueBranchName` to pick a name that doesn't collide with one a different task already created. */
export async function localBranchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ['for-each-ref', `refs/heads/${branch}`])).length > 0;
}

/**
 * The one place `git fetch origin` itself is spelled out, so every caller
 * that needs a fresh remote reading before doing something with it —
 * `gitSyncPoller.ts`'s background sweep, `projectService.ts`'s
 * `projectBranches` — goes through the same quiet fetch of every ref rather
 * than each hand-rolling its own args. `commandRunner.ts`'s `runProjectSync`
 * needs the fetch to run as *part of* one user-visible, trackable shell
 * command (not a separate awaited step, so its live output actually shows
 * the fetch happening) — see `FETCH_ORIGIN_COMMAND` for that case instead.
 */
export async function fetchOrigin(cwd: string): Promise<void> {
  await git(cwd, ['fetch', '--quiet', 'origin']);
}

/** The shell-command form of `fetchOrigin`, for a caller that needs it as one leg of a larger trackable CommandRun (see `commandRunner.ts`'s `runProjectSync`) rather than an awaited `git()` call of its own. */
export const FETCH_ORIGIN_COMMAND = 'git fetch origin';
/** Stages everything, commits it (when anything changed) and pushes `branch`. Resolves whether a new commit was made. */
export async function commitAndPush(cwd: string, branch: string, message: string): Promise<boolean> {
  if (await currentBranch(cwd) !== branch) throw new GitError(`Checkout changed during task; expected ${branch}. Restore that branch before retrying.`);
  const committed = await commitAll(cwd, message);
  await git(cwd, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`]);
  return committed;
}

/** Stages everything and commits it when anything changed (which also concludes a merge in progress). Resolves whether a commit was made. */
async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ['add', '--all']);
  const pending = Boolean(await git(cwd, ['diff', '--cached', '--name-only'])) || await mergeInProgress(cwd);
  if (pending) await git(cwd, ['commit', '-m', message]);
  return pending;
}

async function mergeInProgress(cwd: string): Promise<boolean> {
  try { await git(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']); return true; } catch { return false; }
}

/**
 * Commits whatever is left in `cwd` and pushes its HEAD to `branch` on `remote`, whatever the local
 * branch is called. Never forces: a remote branch that moved on meanwhile makes the push fail.
 */
export async function commitAndPushHeadTo(cwd: string, remote: string, branch: string, message: string): Promise<boolean> {
  const committed = await commitAll(cwd, message);
  await git(cwd, ['push', remote, `HEAD:refs/heads/${branch}`]);
  return committed;
}
/**
 * Creates an isolated git worktree for one concurrent Task: a fresh checkout
 * at `worktreePath`, on a brand-new `branch` created off `baseBranch`. `cwd`
 * is the Project's own primary working directory — any worktree of the same
 * repo can run `git worktree add`, but routing it through the main one keeps
 * every worktree-touching git call for a Project going through the same
 * working directory. See docs/architecture.md#concurrent-tasks-per-project
 * (amended) and `projects/projectService.ts`'s `projectWorktreePath`.
 */
export async function addWorktree(cwd: string, worktreePath: string, branch: string, baseBranch: string): Promise<void> {
  await git(cwd, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
}

/**
 * Like `addWorktree`, but reuses `branch` if it already exists instead of failing on `-b` — a
 * WorkflowRun's branch name is derived from its PlanItem (`task/<ref>-<slug>`), so retrying a
 * failed/stopped run for the same item must check out that same branch again rather than erroring.
 */
export async function addWorktreeForBranch(cwd: string, worktreePath: string, branch: string, baseBranch: string): Promise<void> {
  try {
    await addWorktree(cwd, worktreePath, branch, baseBranch);
  } catch {
    await git(cwd, ['worktree', 'add', worktreePath, branch]);
  }
}

/** Reopen an existing task branch without ever creating it from the base branch. */
export async function restoreWorktreeForBranch(cwd: string, worktreePath: string, branch: string): Promise<boolean> {
  if (!(await taskBranchExists(cwd, branch, true))) {
    // A failed remote lookup is surfaced as an error; only a confirmed absent ref returns false.
    const remote = await git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    if (!remote) return false;
    await git(cwd, ['fetch', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  }
  await git(cwd, ['worktree', 'add', worktreePath, branch]);
  return true;
}

/** Local ref first, then a confirmed remote lookup; a remote error remains retryable. */
export async function taskBranchExists(cwd: string, branch: string, localOnly = false): Promise<boolean> {
  try { await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return true; }
  catch { /* The branch may only exist on origin. */ }
  if (localOnly) return false;
  return Boolean(await git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]));
}

/**
 * Removes a settled Task's worktree directory. `--force` discards any
 * uncommitted local changes along with it: a `'done'` Task has already
 * committed and pushed everything worth keeping (`commitAndPush`), and a
 * `'failed'` Task's uncommitted changes were never reachable from any v1 UI
 * anyway (no worktree browser exists yet — see docs/roadmap.md). The branch
 * itself, and anything already pushed to it, is untouched — only the
 * checked-out directory goes away, by design: see the cleanup-policy note on
 * docs/architecture.md#concurrent-tasks-per-project.
 */
export async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  await git(cwd, ['worktree', 'remove', '--force', worktreePath]);
}

const busy = new Set<string>();
/** Projects with an automatic pull in flight, mapped to a promise that settles when it ends. */
const pullsInFlight = new Map<string, Promise<void>>();

/**
 * Runs `action` under the Project's operation lock, refusing when another holder has it. An automatic
 * pull is not a holder to refuse: a caller arriving while one runs waits for the (short) pull to end,
 * so a task start never races it.
 */
export async function withProjectLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  for (let pull = pullsInFlight.get(id); pull; pull = pullsInFlight.get(id)) await pull;
  if (busy.has(id)) throw new GitError('Another project operation is in progress. Try again.');
  busy.add(id);
  try { return await action(); } finally { busy.delete(id); }
}

/** Whether a lock holder or an automatic pull currently owns the Project. */
export function isProjectLocked(id: string): boolean {
  return busy.has(id) || pullsInFlight.has(id);
}

/**
 * Claims the Project for an automatic pull, synchronously, so nothing can slip in between the check
 * and the claim. Null when a lock holder (a task start or stop, a branch switch, a PR action) or
 * another pull already owns it. The returned function releases the claim.
 */
export function claimProjectPull(id: string): (() => void) | null {
  if (isProjectLocked(id)) return null;
  let settle!: () => void;
  pullsInFlight.set(id, new Promise<void>((resolve) => { settle = resolve; }));
  return () => { pullsInFlight.delete(id); settle(); };
}

// ---- Workflow-run support: diff paging (StepRun MCP tools) and gh PR/stacking helpers ----

/** `git diff --stat <base>...HEAD` — a WorkflowRun step's `diff_summary` MCP tool, so a review step gets an overview without paging the whole diff into its prompt. */
export async function diffStat(cwd: string, base: string): Promise<string> {
  return git(cwd, ['diff', '--stat', `${base}...HEAD`]);
}

/** The changed-files list (status + path) between `base` and HEAD, for a step deciding which file to pull with `diffForFile`. */
export async function diffNameStatus(cwd: string, base: string): Promise<{ status: string; path: string }[]> {
  const out = await git(cwd, ['diff', '--name-status', `${base}...HEAD`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status ?? '', path: rest.join('\t') };
  });
}

/** One file's diff against `base` — a WorkflowRun step's `diff_file` MCP tool. */
export async function diffForFile(cwd: string, base: string, filePath: string): Promise<string> {
  return git(cwd, ['diff', `${base}...HEAD`, '--', filePath]);
}

export class GhError extends Error {}

/** Runs one `gh` CLI command, the same shape as `git()` above. */
export async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: operationEnv() });
    return stdout.trim();
  } catch (error) { throw toolFailure(error, (message) => new GhError(`gh command failed: ${message}`)); }
}

export const MAX_LISTED_PULL_REQUESTS = 100;

export interface PullRequest {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  /** Null for a deleted account. */
  author: string | null;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OpenPullRequests {
  /** The true number of open pull requests, which can exceed `pullRequests.length`. */
  count: number;
  /** Newest first, at most `MAX_LISTED_PULL_REQUESTS`. */
  pullRequests: PullRequest[];
  truncated: boolean;
}

// One compact JSON object per open PR (drafts included) across every page, so the CLI output stays small.
const PULL_REQUEST_JQ = '.[] | {number, title, headBranch: .head.ref, baseBranch: .base.ref, author: .user.login, url: .html_url, isDraft: (.draft // false), createdAt: .created_at, updatedAt: .updated_at}';

function parsePullRequest(line: string): PullRequest {
  const raw = JSON.parse(line) as Partial<PullRequest>;
  if (typeof raw.number !== 'number' || typeof raw.title !== 'string' || typeof raw.url !== 'string' || typeof raw.createdAt !== 'string') {
    throw new GhError('GitHub returned an invalid pull request');
  }
  return {
    number: raw.number,
    title: raw.title,
    headBranch: raw.headBranch ?? '',
    baseBranch: raw.baseBranch ?? '',
    author: raw.author ?? null,
    url: raw.url,
    isDraft: raw.isDraft === true,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? raw.createdAt,
  };
}

/** Newest first by creation time; equal times fall back to the higher number so the order is deterministic. */
export function newestPullRequestsFirst(a: PullRequest, b: PullRequest): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number;
}

export async function ghOpenPullRequests(cwd: string, slug: string, run: typeof gh = gh): Promise<OpenPullRequests> {
  const out = await run(cwd, ['api', '--paginate', '--jq', PULL_REQUEST_JQ, `repos/${slug}/pulls?state=open&per_page=100`]);
  let all: PullRequest[];
  try {
    all = out.split('\n').filter((line) => line.trim()).map(parsePullRequest);
  } catch (error) {
    throw error instanceof GhError ? error : new GhError('GitHub returned an invalid pull request list');
  }
  all.sort(newestPullRequestsFirst);
  return { count: all.length, pullRequests: all.slice(0, MAX_LISTED_PULL_REQUESTS), truncated: all.length > MAX_LISTED_PULL_REQUESTS };
}

export type BranchPullRequestState = 'open' | 'merged' | 'closed' | 'none';
export interface BranchPullRequest { state: BranchPullRequestState; number: number | null }

interface BranchPullRequestNode { number: number; state: string; mergedAt: string | null; headRepository: { nameWithOwner: string } | null }

function branchPullRequestOf(nodes: BranchPullRequestNode[], slug: string): BranchPullRequest {
  // Only this repository's own branch counts: a fork's head branch of the same name is someone else's PR. The newest PR (highest number) decides.
  const own = nodes.filter((node) => node.headRepository?.nameWithOwner.toLowerCase() === slug.toLowerCase());
  const newest = own.reduce<BranchPullRequestNode | null>((best, node) => (best && best.number > node.number ? best : node), null);
  if (!newest) return { state: 'none', number: null };
  const state = newest.mergedAt || newest.state === 'MERGED' ? 'merged' : newest.state === 'OPEN' ? 'open' : 'closed';
  return { state, number: newest.number };
}

/**
 * The newest pull request of each branch, in one GraphQL call. Branch names travel as variables, never inside the query text.
 * Throws when the provider can't be reached or answers something unreadable.
 */
export async function ghBranchPullRequests(cwd: string, slug: string, branches: string[], run: typeof gh = gh): Promise<Map<string, BranchPullRequest>> {
  const result = new Map<string, BranchPullRequest>();
  if (branches.length === 0) return result;
  const [owner = '', name = ''] = slug.split('/');
  const declarations = branches.map((_, index) => `$b${index}: String!`).join(', ');
  const fields = branches.map((_, index) => `p${index}: pullRequests(headRefName: $b${index}, first: 20, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number state mergedAt headRepository { nameWithOwner } } }`).join(' ');
  const query = `query($owner: String!, $name: String!, ${declarations}) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...branches.flatMap((branch, index) => ['-f', `b${index}=${branch}`])];
  let repository: Record<string, { nodes: BranchPullRequestNode[] }> | undefined;
  try {
    repository = (JSON.parse(await run(cwd, args)) as { data?: { repository?: Record<string, { nodes: BranchPullRequestNode[] }> } }).data?.repository;
  } catch (error) {
    throw error instanceof GhError ? error : new GhError('GitHub returned an invalid pull request answer');
  }
  if (!repository) throw new GhError('GitHub returned an invalid pull request answer');
  branches.forEach((branch, index) => {
    const nodes = repository![`p${index}`]?.nodes;
    if (!Array.isArray(nodes)) throw new GhError('GitHub returned an invalid pull request answer');
    result.set(branch, branchPullRequestOf(nodes, slug));
  });
  return result;
}

/** The failures that are about this machine's `gh` rather than the request: not installed, rate limited, signed out. Null for anything else. */
export function ghEnvironmentFailure(message: string): string | null {
  if (/ENOENT|spawn gh|command not found/i.test(message)) return 'GitHub CLI is not installed.';
  if (/rate.?limit|abuse detection/i.test(message)) return 'GitHub rate limit reached.';
  if (/\b(?:HTTP|status(?: code)?)\s*:?\s*401\b|bad credentials|requires? authentication|authentication required|not authenticated|not logged in|to authenticate|gh auth login|expired token|invalid token/i.test(message)) return 'GitHub CLI is not signed in.';
  return null;
}

export function ghCountFailure(error: unknown): string {
  if (error instanceof GithubAccountError) return error.message;
  const message = error instanceof Error ? error.message : '';
  const environment = ghEnvironmentFailure(message);
  if (environment) return environment;
  if (/\b(?:HTTP|status(?: code)?)\s*:?\s*403\b|forbidden|resource not accessible|permission|access denied/i.test(message)) return 'GitHub denied access to pull requests.';
  if (/timed? ?out|network|connect|resolve|ENET|EAI_AGAIN/i.test(message)) return 'Could not reach GitHub.';
  return 'Could not check pull requests.';
}

export interface GhPrInfo {
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

/** `gh pr view <branch> --json url,state` for the given branch — null when `gh` is missing, unauthenticated, or no PR exists for that branch (never throws). */
export async function ghPrViewForBranch(cwd: string, branch: string): Promise<GhPrInfo | null> {
  try {
    const out = await gh(cwd, ['pr', 'view', branch, '--json', 'url,state']);
    const parsed = JSON.parse(out) as { url?: string; state?: string };
    if (!parsed.url || !parsed.state) return null;
    return { url: parsed.url, state: parsed.state as GhPrInfo['state'] };
  } catch {
    return null;
  }
}

export interface GhPrCreateResult {
  url: string;
}

/** `gh pr create --base <base> --head <head> --title <title> --body <body>`, returning the created PR's URL (the command's last stdout line). */
export async function ghPrCreate(cwd: string, input: { base: string; head: string; title: string; body: string }): Promise<GhPrCreateResult> {
  const out = await gh(cwd, ['pr', 'create', '--base', input.base, '--head', input.head, '--title', input.title, '--body', input.body]);
  const lines = out.split('\n').filter(Boolean);
  return { url: lines.at(-1) ?? out };
}
