import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The GitHub identity one operation runs under. `projects/git.ts`'s `git()` and `gh()` read it from the
 * async scope that `withProjectGithub` (accounts.ts) opened, so every nested call of that operation —
 * and only that operation — authenticates as the project's account. Two operations running at once
 * each see their own scope; neither can pick up the other's token.
 */
export interface GithubContext {
  projectName: string;
  /** What the operation is doing, for error messages ("push the task branch"). */
  action: string;
  login: string;
  token: string;
  authorName: string;
  authorEmail: string;
  /** The project's own remote, so an SSH-style URL can be mapped to HTTPS for just that repository. */
  sshRewrite: { from: string; to: string } | null;
}

export const githubScope = new AsyncLocalStorage<GithubContext>();

/** A GitHub action for a project could not run as the project's account; the message says why and how to fix it. */
export class GithubAccountError extends Error {
  constructor(message: string) { super(message); this.name = 'GithubAccountError'; }
}

/** Variables that could make git, gh or ssh authenticate as someone other than the chosen account. */
const AMBIENT_CREDENTIAL_VARS = ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_SSH'];

const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

/** Identity variables for commits only (no credentials). */
export function identityEnv(context: Pick<GithubContext, 'authorName' | 'authorEmail'>): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: context.authorName,
    GIT_AUTHOR_EMAIL: context.authorEmail,
    GIT_COMMITTER_NAME: context.authorName,
    GIT_COMMITTER_EMAIL: context.authorEmail,
  };
}

/**
 * `base` with the account's credentials and commit identity applied. The token reaches git only through
 * `GH_TOKEN`, read by an inline credential helper, so it is in no argument, URL or file. An existing
 * `GIT_CONFIG_COUNT` is extended, not replaced.
 */
export function githubEnv(base: NodeJS.ProcessEnv, context: GithubContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of AMBIENT_CREDENTIAL_VARS) delete env[name];
  const config: [string, string][] = [['credential.helper', ''], ['credential.helper', CREDENTIAL_HELPER]];
  if (context.sshRewrite) config.push([`url.${context.sshRewrite.to}.insteadOf`, context.sshRewrite.from]);
  const existing = Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${existing + index}`] = key;
    env[`GIT_CONFIG_VALUE_${existing + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(existing + config.length);
  return {
    ...env,
    ...identityEnv(context),
    GH_TOKEN: context.token,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** The environment for a child process of the current operation: unchanged unless a project account is active. */
export function operationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const context = githubScope.getStore();
  return context ? githubEnv(base, context) : { ...base, GIT_TERMINAL_PROMPT: '0' };
}

export const signInFix = (login: string) => `Sign in again with \`gh auth login -h github.com\` (account ${login}) or set the project back to Machine default.`;

const where = (context: Pick<GithubContext, 'projectName' | 'action' | 'login'>) => `Project "${context.projectName}", GitHub account ${context.login}, ${context.action}:`;

/** What an operation's failure text means for the active account, or null when it is unrelated to credentials. */
export function accountFailureMessage(context: GithubContext, failure: string): string | null {
  if (/rate.?limit|abuse detection/i.test(failure)) return null;
  const prefix = where(context);
  if (/\b(?:HTTP|status(?: code)?)\s*:?\s*401\b|bad credentials|authentication failed|invalid (?:token|credentials)|expired token|requires? authentication/i.test(failure)) {
    return `${prefix} the account is signed out or its token expired. ${signInFix(context.login)}`;
  }
  if (/GH007|private email|email privacy/i.test(failure)) {
    return `${prefix} GitHub rejected the commit email because it is private. Edit the account's commit email in Settings → GitHub accounts.`;
  }
  if (/permission to .* denied|repository not found|\b(?:HTTP|status(?: code)?)\s*:?\s*40[34]\b|could not read from remote|not accessible/i.test(failure)) {
    return `${prefix} the account has no access to this repository. Pick another account in the project's settings, or grant access on GitHub.`;
  }
  return null;
}
