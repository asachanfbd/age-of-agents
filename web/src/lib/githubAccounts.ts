import { gitProviderOf, repositoryLinkOf } from './gitProvider';
import type { ProjectData } from '../types';

/** The shape of `GET /api/github/accounts` — see server/src/github/accounts.ts. Never carries a token. */
export type GhAvailability =
  | { state: 'ok'; version: string }
  | { state: 'missing' }
  | { state: 'too-old'; version: string }
  | { state: 'unavailable'; reason: string };

export interface GithubAccount {
  login: string;
  name: string | null;
  active: boolean;
  signedIn: boolean;
  identity: { name: string; email: string };
  hasCustomIdentity: boolean;
  usedByProjects: number;
}

export interface GithubAccountsResult {
  gh: GhAvailability;
  accounts: GithubAccount[];
  addCommand: string;
  minGhVersion: string;
}

export type AccountCheckStatus = 'default' | 'ok' | 'no-access' | 'signed-out' | 'unavailable';

export interface AccountCheck {
  status: AccountCheckStatus;
  account: string | null;
  repository: string | null;
  ownerMismatch: boolean;
  blocks: boolean;
  message: string;
  checkedAt: string;
}

export const MACHINE_DEFAULT = '';
export const GH_LOGIN_COMMAND = 'gh auth login -h github.com';
export const SESSIONS_KEEP_ACCOUNT_NOTE = 'Changing the account applies to new operations at once. Agent sessions that are already running keep the account they started with.';

/** The selector appears only for a project linked to a github.com repository. */
export function showsAccountCard(project: Pick<ProjectData, 'repositoryUrl' | 'gitProvider'>): boolean {
  return gitProviderOf(project) === 'github' && repositoryLinkOf(project) !== null;
}

/** Why `gh` cannot supply accounts, or null when it can. */
export function ghProblem(gh: GhAvailability | undefined, minVersion = '2.40.0'): string | null {
  if (!gh || gh.state === 'ok') return null;
  if (gh.state === 'missing') return 'The GitHub CLI (gh) is not installed. Install it to use per-project accounts; until then every project uses the machine default.';
  if (gh.state === 'too-old') return `The GitHub CLI ${gh.version} is too old for several accounts (needs ${minVersion} or newer). Update gh; until then every project uses the machine default.`;
  return gh.reason;
}

export function usedByLabel(count: number): string {
  if (count === 0) return 'Not used by any project';
  return `Used by ${count} project${count === 1 ? '' : 's'}`;
}

export function accountStatusLabel(account: Pick<GithubAccount, 'signedIn'>): string {
  return account.signedIn ? 'Signed in' : 'Needs sign-in';
}

export interface AccountOption { value: string; label: string; disabled: boolean }

/** "Machine default" plus each detected account; a stored account that is no longer detected stays visible, marked signed out. */
export function accountOptions(project: Pick<ProjectData, 'githubAccount'>, result: GithubAccountsResult | null): AccountOption[] {
  const usable = ghProblem(result?.gh) === null;
  const options: AccountOption[] = [{ value: MACHINE_DEFAULT, label: 'Machine default', disabled: false }];
  const accounts = result?.accounts ?? [];
  for (const account of accounts) {
    options.push({ value: account.login, label: account.signedIn ? account.login : `${account.login} (needs sign-in)`, disabled: !usable });
  }
  const stored = project.githubAccount;
  if (stored && !accounts.some((account) => account.login.toLowerCase() === stored.toLowerCase())) {
    options.push({ value: stored, label: `${stored} (signed out)`, disabled: true });
  }
  return options;
}

export type CardTone = 'neutral' | 'good' | 'warning' | 'bad';
export interface CardResult { tone: CardTone; text: string; blocks: boolean }

/** What the project card says about the chosen account; `check` is the latest access check, null while none ran, 'checking' while one is running. */
export function cardResult(project: Pick<ProjectData, 'githubAccount'>, check: AccountCheck | 'checking' | null): CardResult {
  if (!project.githubAccount) return { tone: 'neutral', text: 'This project uses the machine default GitHub identity.', blocks: false };
  if (check === 'checking') return { tone: 'neutral', text: `Checking access for ${project.githubAccount}…`, blocks: false };
  if (!check) return { tone: 'neutral', text: `Account ${project.githubAccount} has not been checked yet.`, blocks: false };
  const warning = check.status === 'ok' && check.ownerMismatch;
  const tone: CardTone = check.blocks ? 'bad' : warning ? 'warning' : check.status === 'ok' ? 'good' : 'neutral';
  const text = warning
    ? `${check.message} The repository's owner matches none of your signed-in accounts, so check this is the account you meant.`
    : check.message;
  return { tone, text, blocks: check.blocks };
}

export const canRecheck = (project: Pick<ProjectData, 'githubAccount'>, result: GithubAccountsResult | null): boolean =>
  Boolean(project.githubAccount) && ghProblem(result?.gh) === null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f<>]/;
/** Same rules as the daemon, so the form can refuse before sending. Returns an error message or null. */
export function identityDraftError(draft: { name: string; email: string }): string | null {
  const name = draft.name.trim();
  const parts = draft.email.trim().split('@');
  if (!name || CONTROL.test(name)) return 'Enter a commit author name without line breaks, < or >.';
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(draft.email.trim())) return 'Enter a valid commit email address.';
  return null;
}
