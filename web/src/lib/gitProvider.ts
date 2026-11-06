import type { ProjectData } from '../types';

export type GitProviderId = 'github';

export const DEFAULT_GIT_PROVIDER: GitProviderId = 'github';

/** Providers the Git provider setting offers. GitHub is the only one implemented so far. */
export const GIT_PROVIDERS: { id: GitProviderId; label: string }[] = [{ id: 'github', label: 'GitHub' }];

export interface RepositoryLink {
  slug: string;
  /** Browser URL of the repository. */
  repository: string;
}

const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/;

function githubRepositoryLink(repositoryUrl: string): RepositoryLink | null {
  const match = GITHUB_REMOTE.exec(repositoryUrl.trim());
  if (!match) return null;
  const slug = match[1]!.replace(/\.git$/, '');
  if (slug.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return { slug, repository: `https://github.com/${slug}` };
}

const REPOSITORY_LINKS: Record<GitProviderId, (repositoryUrl: string) => RepositoryLink | null> = {
  github: githubRepositoryLink,
};

/** A Project stored before the setting existed has no provider and reads as GitHub. */
export function gitProviderOf(project: Pick<ProjectData, 'gitProvider'>): GitProviderId {
  return project.gitProvider ?? DEFAULT_GIT_PROVIDER;
}

/** The Project's repository on its Git provider, or null when it has none or the provider doesn't recognise the URL. */
export function repositoryLinkOf(project: Pick<ProjectData, 'repositoryUrl' | 'gitProvider'>): RepositoryLink | null {
  if (!project.repositoryUrl) return null;
  return REPOSITORY_LINKS[gitProviderOf(project)](project.repositoryUrl);
}
