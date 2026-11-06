import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { githubIdentitiesDb } from '../db/collections.ts';
import { registerSecret } from '../buildings/secrets.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { githubRepository } from '../projects/git.ts';
import { GithubAccountError, githubEnv, githubScope, signInFix } from './context.ts';
import type { GithubContext } from './context.ts';

const exec = promisify(execFile);

const HOST = 'github.com';
/** `gh auth status` lists several accounts per host from this release on. */
export const MIN_GH_VERSION = [2, 40, 0] as const;
export const MIN_GH_VERSION_TEXT = MIN_GH_VERSION.join('.');
export const GH_LOGIN_COMMAND = 'gh auth login -h github.com';
const TOKEN_TIMEOUT_MS = 10_000;

// ---- gh detection ----

export type GhAvailability = { state: 'ok'; version: string } | { state: 'missing' } | { state: 'too-old'; version: string } | { state: 'unavailable'; reason: string };

export interface DetectedLogin { login: string; active: boolean; signedIn: boolean }

/** gh's own environment-sourced tokens would hide the stored accounts, so detection runs without them. */
function cleanGhEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: HOST };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.GH_ENTERPRISE_TOKEN;
  return env;
}

async function runGh(args: string[], env: NodeJS.ProcessEnv, timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  return exec('gh', args, { env, timeout, maxBuffer: 1024 * 1024 });
}

export function parseGhVersion(text: string): number[] | null {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function ghVersionSupportsAccounts(version: number[]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i]! !== MIN_GH_VERSION[i]) return version[i]! > MIN_GH_VERSION[i]!;
  }
  return true;
}

export async function ghAvailability(): Promise<GhAvailability> {
  try {
    const { stdout } = await runGh(['--version'], cleanGhEnv(), 10_000);
    const version = parseGhVersion(stdout);
    if (!version) return { state: 'unavailable', reason: 'Could not read the GitHub CLI version.' };
    const text = version.join('.');
    return ghVersionSupportsAccounts(version) ? { state: 'ok', version: text } : { state: 'too-old', version: text };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unavailable', reason: 'Could not run the GitHub CLI.' };
  }
}

/** Accounts from `gh auth status` text. Hosts other than github.com are not listed because the command is asked for github.com only. */
export function parseAuthStatus(text: string): DetectedLogin[] {
  const accounts: DetectedLogin[] = [];
  for (const line of text.split('\n')) {
    const entry = /(Logged in to|Failed to log in to) github\.com (?:account|as) (\S+)/.exec(line);
    if (entry) { accounts.push({ login: entry[2]!, active: false, signedIn: entry[1] === 'Logged in to' }); continue; }
    const active = /Active account:\s*(true|false)/.exec(line);
    if (active && accounts.length > 0) accounts[accounts.length - 1]!.active = active[1] === 'true';
  }
  return accounts;
}

export async function listLogins(): Promise<DetectedLogin[]> {
  try {
    const { stdout, stderr } = await runGh(['auth', 'status', '--hostname', HOST], cleanGhEnv());
    return parseAuthStatus(`${stdout}\n${stderr}`);
  } catch (error) {
    // `gh auth status` exits non-zero when any account is failed or none exists; the text still lists them.
    const failure = error as { stdout?: string; stderr?: string };
    return parseAuthStatus(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}`);
  }
}

// ---- tokens ----

/** The account's token from `gh`, fetched per operation and registered for redaction. Throws a message-ready error when it is unavailable. */
async function fetchToken(login: string, context: { projectName?: string; action: string }): Promise<string> {
  try {
    const { stdout } = await runGh(['auth', 'token', '--hostname', HOST, '--user', login], cleanGhEnv(), TOKEN_TIMEOUT_MS);
    const token = stdout.trim();
    if (!token) throw new Error('empty token');
    registerSecret(token);
    return token;
  } catch {
    const subject = context.projectName ? `Project "${context.projectName}", GitHub account ${login}` : `GitHub account ${login}`;
    throw new GithubAccountError(`${subject}, ${context.action}: the account is signed out or its token is unavailable. ${signInFix(login)}`);
  }
}

// ---- identity ----

export interface GithubProfile { login: string; id: number | null; name: string | null }
export interface CommitIdentity { name: string; email: string }

const profiles = new Map<string, GithubProfile>();

export function defaultIdentity(profile: { login: string; id?: number | null; name?: string | null }): CommitIdentity {
  const name = profile.name?.trim() || profile.login;
  const email = profile.id ? `${profile.id}+${profile.login}@users.noreply.github.com` : `${profile.login}@users.noreply.github.com`;
  return { name, email };
}

export class IdentityValidationError extends Error {}

const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;
export function isValidLogin(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 39 && USERNAME.test(value);
}

export function validateIdentity(input: { name?: unknown; email?: unknown }): CommitIdentity {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!name || /[\u0000-\u001f\u007f<>]/.test(name)) throw new IdentityValidationError('The commit author name must not be empty or contain line breaks, control characters, < or >.');
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(email)) throw new IdentityValidationError('Enter a valid commit email address.');
  return { name, email };
}

export async function identityFor(login: string, profile?: GithubProfile): Promise<CommitIdentity> {
  const stored = await githubIdentitiesDb.get(login.toLowerCase());
  const base = defaultIdentity(profile ?? profiles.get(login.toLowerCase()) ?? { login });
  return { name: stored?.name ?? base.name, email: stored?.email ?? base.email };
}

export class UnknownAccountError extends Error {}

/** An identity is only kept for an account `gh` lists, so a typo cannot silently create an override. */
export async function assertKnownLogin(login: string): Promise<void> {
  if (!(await listLogins()).some((entry) => entry.login.toLowerCase() === login.toLowerCase())) {
    throw new UnknownAccountError(`GitHub account ${login} was not found in the GitHub CLI. Add it with \`${GH_LOGIN_COMMAND}\` and refresh.`);
  }
}

export async function saveIdentity(login: string, input: { name?: unknown; email?: unknown }): Promise<void> {
  const identity = validateIdentity(input);
  await assertKnownLogin(login);
  const id = login.toLowerCase();
  if (await githubIdentitiesDb.get(id)) await githubIdentitiesDb.update(id, identity);
  else await githubIdentitiesDb.insert({ id, ...identity });
}

export async function resetIdentity(login: string): Promise<void> {
  await githubIdentitiesDb.delete(login.toLowerCase());
}

// ---- account list ----

export interface GithubAccount {
  login: string;
  name: string | null;
  active: boolean;
  signedIn: boolean;
  /** The commit identity in use: the saved override or the default. */
  identity: CommitIdentity;
  hasCustomIdentity: boolean;
  /** Projects whose account this is. */
  usedByProjects: number;
}

export interface GithubAccountsResult {
  gh: GhAvailability;
  accounts: GithubAccount[];
  addCommand: string;
  minGhVersion: string;
}

async function fetchProfile(login: string): Promise<GithubProfile> {
  const token = await fetchToken(login, { action: 'profile lookup' });
  const env = { ...cleanGhEnv(), GH_TOKEN: token };
  const { stdout } = await runGh(['api', 'user', '--jq', '{login,id,name}'], env, 15_000);
  const raw = JSON.parse(stdout) as { login?: string; id?: number; name?: string | null };
  return { login: raw.login ?? login, id: typeof raw.id === 'number' ? raw.id : null, name: raw.name ?? null };
}

export async function detectAccounts(projects: ProjectRecord[] = []): Promise<GithubAccountsResult> {
  const gh = await ghAvailability();
  const base = { gh, addCommand: GH_LOGIN_COMMAND, minGhVersion: MIN_GH_VERSION_TEXT };
  if (gh.state !== 'ok') return { ...base, accounts: [] };
  const logins = await listLogins();
  const accounts = await Promise.all(logins.map(async (entry): Promise<GithubAccount> => {
    const key = entry.login.toLowerCase();
    if (entry.signedIn) profiles.set(key, await fetchProfile(entry.login).catch(() => profiles.get(key) ?? { login: entry.login, id: null, name: null }));
    const profile = profiles.get(key);
    return {
      login: entry.login,
      name: profile?.name ?? null,
      active: entry.active,
      signedIn: entry.signedIn,
      identity: await identityFor(entry.login, profile),
      hasCustomIdentity: Boolean(await githubIdentitiesDb.get(key)),
      usedByProjects: projects.filter((project) => project.githubAccount?.toLowerCase() === key).length,
    };
  }));
  return { ...base, accounts };
}

// ---- project scope ----

export type RemoteForm = 'https' | 'ssh' | 'unsupported';

export function classifyRemote(url: string): RemoteForm {
  const trimmed = url.trim();
  if (!githubRepository(trimmed)) return 'unsupported';
  return trimmed.startsWith('https://') ? 'https' : 'ssh';
}

/** A remote that names github.com but in a form the app cannot authenticate (http://, ssh://, embedded credentials). */
function isUnsupportedGithubRemote(url: string): boolean {
  return githubRepository(url) === null && /github\.com/i.test(url);
}

/**
 * The project's GitHub account, or null for Machine default. The stored account is also ignored when the
 * repository is not on github.com at all; a github.com remote in an unsupported form is not ignored, so
 * it fails loudly instead of running under other credentials.
 */
export function projectAccount(project: ProjectRecord): string | null {
  if (!project.githubAccount || !project.repositoryUrl) return null;
  return githubRepository(project.repositoryUrl) || isUnsupportedGithubRemote(project.repositoryUrl) ? project.githubAccount : null;
}

async function buildContext(project: ProjectRecord, action: string): Promise<GithubContext | null> {
  const login = projectAccount(project);
  if (!login) return null;
  const repository = githubRepository(project.repositoryUrl!);
  const form = classifyRemote(project.repositoryUrl!);
  if (form === 'unsupported' || !repository) {
    throw new GithubAccountError(`Project "${project.name}", GitHub account ${login}, ${action}: the repository remote form is not supported with a project account. Use an https://github.com/ or git@github.com: URL.`);
  }
  const token = await fetchToken(login, { projectName: project.name, action });
  const identity = await identityFor(login);
  const stored = project.repositoryUrl!.trim().replace(/\/$/, '');
  return {
    projectName: project.name,
    action,
    login,
    token,
    authorName: identity.name,
    authorEmail: identity.email,
    sshRewrite: form === 'ssh' ? { from: stored, to: `${repository.url}${stored.endsWith('.git') ? '.git' : ''}` } : null,
  };
}

/**
 * Runs `action` so every git and gh call inside authenticates, and commits, as the project's account.
 * A project without an account runs exactly as before; one whose account cannot be used fails here
 * with a message instead of reaching GitHub under another identity.
 */
export async function withProjectGithub<T>(project: ProjectRecord, actionLabel: string, action: () => Promise<T>): Promise<T> {
  const context = await buildContext(project, actionLabel);
  return context ? githubScope.run(context, action) : action();
}

export interface SessionGithubEnv {
  /** Variables to add to the session's environment. */
  set: Record<string, string>;
  /** Inherited variables that must be removed so nothing but the project's account can authenticate. */
  unset: string[];
}

/**
 * Environment changes for an agent session of `project`, so a `git push` or `gh` typed by the agent uses the
 * project's account. Empty for Machine default.
 */
export async function githubSessionEnv(project: ProjectRecord, sessionEnv: Record<string, string>): Promise<SessionGithubEnv> {
  const context = await buildContext(project, 'start an agent session');
  if (!context) return { set: {}, unset: [] };
  const base: NodeJS.ProcessEnv = { ...process.env, ...sessionEnv };
  const merged = githubEnv(base, context);
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== base[key] && typeof value === 'string') set[key] = value;
  }
  return { set, unset: Object.keys(base).filter((key) => !(key in merged) && base[key] !== undefined) };
}

// ---- verification ----

export type AccountCheckStatus = 'default' | 'ok' | 'no-access' | 'signed-out' | 'unavailable';

export interface AccountCheck {
  status: AccountCheckStatus;
  account: string | null;
  repository: string | null;
  /** The repository owner matches none of the signed-in accounts or their organisations. Warns, never blocks. */
  ownerMismatch: boolean;
  blocks: boolean;
  message: string;
  checkedAt: string;
}

export const BLOCKING_STATUSES: AccountCheckStatus[] = ['no-access', 'signed-out', 'unavailable'];

async function ghApiAs(token: string, endpoint: string, jq: string): Promise<string> {
  const { stdout } = await runGh(['api', endpoint, '--jq', jq], { ...cleanGhEnv(), GH_TOKEN: token }, 20_000);
  return stdout.trim();
}

async function ownerMatchesSomeAccount(owner: string, logins: DetectedLogin[]): Promise<boolean> {
  const wanted = owner.toLowerCase();
  if (logins.some((entry) => entry.login.toLowerCase() === wanted)) return true;
  for (const entry of logins.filter((candidate) => candidate.signedIn)) {
    try {
      const token = await fetchToken(entry.login, { action: 'organisation lookup' });
      const orgs = (await ghApiAs(token, 'user/orgs', '.[].login')).split('\n').map((org) => org.trim().toLowerCase());
      if (orgs.includes(wanted)) return true;
    } catch { /* An account whose organisations cannot be read cannot vouch for the owner. */ }
  }
  return false;
}

export async function checkProjectAccount(project: ProjectRecord): Promise<AccountCheck> {
  const checkedAt = new Date().toISOString();
  const login = projectAccount(project);
  const repository = project.repositoryUrl ? githubRepository(project.repositoryUrl) : null;
  const result = (status: AccountCheckStatus, message: string, ownerMismatch = false): AccountCheck => ({
    status, account: login, repository: repository?.slug ?? null, ownerMismatch, blocks: BLOCKING_STATUSES.includes(status), message, checkedAt,
  });
  if (!login || !repository) return result('default', 'This project uses the machine default GitHub identity.');
  const gh = await ghAvailability();
  if (gh.state !== 'ok') return result('unavailable', gh.state === 'too-old' ? `The GitHub CLI ${gh.version} is too old for per-project accounts (needs ${MIN_GH_VERSION_TEXT}).` : 'The GitHub CLI is not available.');
  const logins = await listLogins();
  const entry = logins.find((candidate) => candidate.login.toLowerCase() === login.toLowerCase());
  if (!entry || !entry.signedIn) return result('signed-out', `Account ${login} is signed out. ${signInFix(login)}`);
  let token: string;
  try { token = await fetchToken(login, { projectName: project.name, action: 'check repository access' }); } catch (error) { return result('signed-out', (error as Error).message); }
  try {
    const raw = JSON.parse(await ghApiAs(token, `repos/${repository.slug}`, '{push: .permissions.push, owner: .owner.login}')) as { push?: boolean; owner?: string };
    if (!raw.push) return result('no-access', `Account ${login} can see ${repository.slug} but cannot push to it.`);
    const mismatch = !(await ownerMatchesSomeAccount(raw.owner ?? repository.slug.split('/')[0]!, logins));
    return result('ok', `Account ${login} can push to ${repository.slug}.`, mismatch);
  } catch (error) {
    const text = (error as Error & { stderr?: string }).stderr ?? (error as Error).message;
    if (/401|bad credentials/i.test(text)) return result('signed-out', `Account ${login} is signed out or its token expired. ${signInFix(login)}`);
    return result('no-access', `Account ${login} has no access to ${repository.slug}.`);
  }
}
