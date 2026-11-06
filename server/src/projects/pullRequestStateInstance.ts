import { workerManager } from '../worker/workerManager.ts';
import { withProjectGithub } from '../github/accounts.ts';
import { pullRequestContext } from './pullRequestActions.ts';
import { createPullRequestStateService } from './pullRequestStateService.ts';
import { getProject, listProjects } from './projectService.ts';

/** The daemon's own reader of task pull request states, over the real provider. */
export const pullRequestStates = createPullRequestStateService({
  getProject,
  listProjects,
  lookup: (project, branches) => {
    const { provider, slug, cwd } = pullRequestContext(project);
    return withProjectGithub(project, 'read the tasks\' pull requests', () => provider.branchPullRequests(cwd, slug, branches));
  },
  onWorkerEvent: workerManager.onWorkerEvent,
  publish: workerManager.publishEvent,
});
