import { ghBranchPullRequests, ghCountFailure, ghOpenPullRequests, githubRepository } from './git.ts';
import type { BranchPullRequest, OpenPullRequests } from './git.ts';
import { ghActionFailure, ghFetchPullRequestHead, ghMergePullRequest, ghReadPullRequest } from './pullRequestMerge.ts';
import type { PullRequestMergeOptions, PullRequestMergeResult, PullRequestReading } from './pullRequestMerge.ts';

export type { BranchPullRequest, OpenPullRequests, PullRequest } from './git.ts';

export const GIT_PROVIDER_IDS = ['github'] as const;
export type GitProviderId = (typeof GIT_PROVIDER_IDS)[number];
export const DEFAULT_GIT_PROVIDER: GitProviderId = 'github';

export class UnsupportedGitProviderError extends Error {
  constructor(id: unknown) { super(`Unsupported Git provider: ${String(id)}`); }
}

/**
 * Everything the app needs from the place a Project's repository is hosted. The PR routes and
 * the Project header depend only on this interface, so a new provider is one more entry in
 * `PROVIDERS`.
 */
export interface GitProvider {
  id: GitProviderId;
  /** Browser URL and CLI identity for a stored repository URL, or null when this provider doesn't recognise it. */
  repositoryLink(repositoryUrl: string): { slug: string; url: string } | null;
  /** Every open pull request, newest first and capped, with the true total. Throws when the provider can't be reached. */
  listOpenPullRequests(cwd: string, slug: string): Promise<OpenPullRequests>;
  /** The newest pull request of each branch (a fork's same-named branch excluded), keyed by branch. Throws when the provider can't be reached. */
  branchPullRequests(cwd: string, slug: string, branches: string[]): Promise<Map<string, BranchPullRequest>>;
  /** A short human reason for a failure thrown by `listOpenPullRequests`. */
  describeFailure(error: unknown): string;
  /** One pull request's merge-relevant state, for `classifyMergeState`. Throws `PullRequestNotFoundError` for an unknown number. */
  readPullRequest(cwd: string, slug: string, number: number): Promise<PullRequestReading>;
  /** Merges with a merge commit, then deletes the remote head branch (never the base or default branch). `bypassProtection` uses the account's right to merge past the base branch's protection, when it has one. Throws when the provider refuses the merge; a failed deletion is reported in the result. */
  mergePullRequest(cwd: string, slug: string, pullRequest: PullRequestReading, options?: PullRequestMergeOptions): Promise<PullRequestMergeResult>;
  /** Fetches the pull request's head commit into the local repository (a fork's head included) and resolves its SHA. Throws `PullRequestHeadGoneError` when the provider no longer has it. */
  fetchPullRequestHead(cwd: string, number: number): Promise<string>;
  /** A short human reason for a failure thrown by the three operations above: the provider's own text unless it is an environment problem. */
  describeActionFailure(error: unknown): string;
}

const github: GitProvider = {
  id: 'github',
  repositoryLink: githubRepository,
  listOpenPullRequests: (cwd, slug) => ghOpenPullRequests(cwd, slug),
  branchPullRequests: (cwd, slug, branches) => ghBranchPullRequests(cwd, slug, branches),
  describeFailure: ghCountFailure,
  readPullRequest: (cwd, slug, number) => ghReadPullRequest(cwd, slug, number),
  mergePullRequest: (cwd, slug, pullRequest, options) => ghMergePullRequest(cwd, slug, pullRequest, options),
  fetchPullRequestHead: (cwd, number) => ghFetchPullRequestHead(cwd, number),
  describeActionFailure: ghActionFailure,
};

const PROVIDERS: Record<GitProviderId, GitProvider> = { github };

export function isGitProviderId(value: unknown): value is GitProviderId {
  return typeof value === 'string' && (GIT_PROVIDER_IDS as readonly string[]).includes(value);
}

/** A Project stored before the setting existed has no provider and reads as GitHub. */
export function gitProviderFor(id: string | undefined | null): GitProvider {
  const resolved = id ?? DEFAULT_GIT_PROVIDER;
  if (!isGitProviderId(resolved)) throw new UnsupportedGitProviderError(id);
  return PROVIDERS[resolved];
}
