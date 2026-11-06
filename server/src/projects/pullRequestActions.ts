import type { ProjectRecord } from '../domain/types.ts';
import { gitProviderFor } from './gitProvider.ts';
import type { GitProvider } from './gitProvider.ts';
import { gitSyncPoller } from './gitSyncPoller.ts';
import { PullRequestHeadGoneError, PullRequestNotFoundError } from './pullRequestMerge.ts';
import type { PullRequestMergeOptions, PullRequestMergeResult, PullRequestReading } from './pullRequestMerge.ts';
import { withProjectGithub } from '../github/accounts.ts';
import { projectAbsolutePath } from './projectService.ts';

/**
 * The provider calls behind the PR tab's actions, for one Project: shared by the routes
 * (`pullRequestService.ts`) and by a conflict-resolution run's own re-check and merge
 * (`workerManager.ts`), so both report provider failures the same way.
 */

export class NoLinkedRepositoryError extends Error {
  constructor() { super('This project has no linked repository for its Git provider'); this.name = 'NoLinkedRepositoryError'; }
}

/** The Git provider couldn't do what was asked; the message is its own reason, ready to show. */
export class GitProviderError extends Error {
  constructor(reason: string) { super(reason); this.name = 'GitProviderError'; }
}

export interface PullRequestContext {
  provider: GitProvider;
  slug: string;
  cwd: string;
}

export function pullRequestContext(project: ProjectRecord): PullRequestContext {
  const provider = gitProviderFor(project.gitProvider);
  const repository = project.repositoryUrl ? provider.repositoryLink(project.repositoryUrl) : null;
  if (!repository) throw new NoLinkedRepositoryError();
  return { provider, slug: repository.slug, cwd: projectAbsolutePath(project) };
}

async function describing<T>(provider: GitProvider, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PullRequestNotFoundError || error instanceof PullRequestHeadGoneError) throw error;
    throw new GitProviderError(provider.describeActionFailure(error));
  }
}

export function readPullRequest(project: ProjectRecord, number: number): Promise<PullRequestReading> {
  const { provider, slug, cwd } = pullRequestContext(project);
  return describing(provider, () => withProjectGithub(project, 'read the pull request', () => provider.readPullRequest(cwd, slug, number)));
}

export function fetchPullRequestHead(project: ProjectRecord, number: number): Promise<string> {
  const { provider, cwd } = pullRequestContext(project);
  return describing(provider, () => withProjectGithub(project, 'fetch the pull request head', () => provider.fetchPullRequestHead(cwd, number)));
}

/** Merges the pull request and refreshes the Project's sync reading, so the merged base shows as something to pull. */
export async function mergePullRequest(project: ProjectRecord, reading: PullRequestReading, options: PullRequestMergeOptions = {}): Promise<PullRequestMergeResult> {
  const { provider, slug, cwd } = pullRequestContext(project);
  const result = await describing(provider, () => withProjectGithub(project, 'merge the pull request', () => provider.mergePullRequest(cwd, slug, reading, options)));
  await gitSyncPoller.refreshOne(project);
  return result;
}
