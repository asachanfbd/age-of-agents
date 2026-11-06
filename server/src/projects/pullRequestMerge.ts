import { GithubAccountError } from '../github/context.ts';
import { GhError, gh, ghEnvironmentFailure, git } from './git.ts';

/** One check on a PR's latest commit. `required` is null when the provider didn't say whether the base branch requires it. */
export interface PullRequestCheck {
  name: string;
  outcome: 'passing' | 'failing' | 'pending';
  required: boolean | null;
}

/** One pull request as its provider reports it right now, in provider-neutral terms. */
export interface PullRequestReading {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  /** Every check on the latest commit; empty when there are none. Required-ness is all known or all unknown. */
  checks: PullRequestCheck[];
  review: 'approved' | 'changes-requested' | 'review-required' | 'none';
  /** The base branch's protection rules refuse the merge for the PR as it stands. */
  protectionBlocked: boolean;
  /** The base requires the head to be up to date with it, and it isn't. */
  behindBase: boolean;
  /** Whether the signed-in account may merge in this repository at all. */
  canMerge: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  headBranchExists: boolean;
  isFork: boolean;
  /** The fork's clone URL for a PR from a fork that still exists; null otherwise. */
  headRepositoryUrl: string | null;
  defaultBranch: string;
  /** The provider's own words when it says the PR can't be merged and offers no fix. */
  refusal: string | null;
}

export type MergeStateStatus = 'clean' | 'conflicts' | 'blocked' | 'unmergeable';

/** What the PR tab's Merge does for a pull request — see `classifyMergeState`. */
export interface PullRequestMergeState {
  number: number;
  title: string;
  status: MergeStateStatus;
  /** Problems the person may override, in plain words. Kept on a conflicting PR too: they are confirmed after the conflicts are resolved. */
  blockers: string[];
  /** Problems that never block a merge (failing or running checks the base branch doesn't require), in plain words. */
  warnings: string[];
  /** Why the PR can't be merged at all; null unless `status` is `unmergeable`. */
  reason: string | null;
  headBranch: string;
  baseBranch: string;
  headBranchExists: boolean;
  isFork: boolean;
}

export const MERGE_BLOCKERS = {
  draft: 'This PR is a draft',
  checksFailing: 'Checks are failing',
  checksPending: 'Checks are still running',
  changesRequested: 'Changes were requested',
  reviewRequired: 'A review is required',
  behindBase: 'The branch is out of date with its base',
  protection: 'The base branch\'s protection rules are not satisfied',
  unknown: 'Merge state is not known yet',
} as const;

export const CHECKS_UNKNOWN_SUFFIX = '(could not tell which checks are required)';

export const OPTIONAL_CHECKS_WARNINGS = {
  failing: 'Optional checks failing',
  pending: 'Optional checks running',
} as const;

export const UNMERGEABLE_REASONS = {
  merged: 'This PR is already merged',
  closed: 'This PR is closed',
  noPermission: 'Your account can\'t merge in this repository',
  headGone: 'The head branch no longer exists',
} as const;

function unmergeableReason(reading: PullRequestReading): string | null {
  if (reading.state === 'merged') return UNMERGEABLE_REASONS.merged;
  if (reading.state === 'closed') return UNMERGEABLE_REASONS.closed;
  if (!reading.canMerge) return UNMERGEABLE_REASONS.noPermission;
  if (!reading.headBranchExists) return UNMERGEABLE_REASONS.headGone;
  return reading.refusal;
}

const CHECK_NAMES_SHOWN = 3;
const CHECK_NAME_LIMIT = 200;

/** "build, lint, test +2 more": distinct names in the order the provider listed them. */
function checkNames(checks: PullRequestCheck[]): string {
  const names = [...new Set(checks.map((check) => check.name.trim().slice(0, CHECK_NAME_LIMIT) || 'unnamed check'))];
  const shown = names.slice(0, CHECK_NAMES_SHOWN).join(', ');
  return names.length > CHECK_NAMES_SHOWN ? `${shown} +${names.length - CHECK_NAMES_SHOWN} more` : shown;
}

const namedLine = (line: string, checks: PullRequestCheck[], suffix = '') => `${line}: ${checkNames(checks)}${suffix}`;

/** Checks that stop a merge: the required ones, or every one when the provider didn't say which are required. */
const blockingChecks = (reading: PullRequestReading, outcome: PullRequestCheck['outcome']) =>
  reading.checks.filter((check) => check.outcome === outcome && check.required !== false);

function checkBlockers(reading: PullRequestReading): string[] {
  const failing = blockingChecks(reading, 'failing');
  const pending = blockingChecks(reading, 'pending');
  const suffix = reading.checks.some((check) => check.required === null) ? ` ${CHECKS_UNKNOWN_SUFFIX}` : '';
  return [
    ...(failing.length > 0 ? [namedLine(MERGE_BLOCKERS.checksFailing, failing, suffix)] : []),
    ...(pending.length > 0 ? [namedLine(MERGE_BLOCKERS.checksPending, pending, suffix)] : []),
  ];
}

function mergeWarnings(reading: PullRequestReading): string[] {
  const optional = (outcome: PullRequestCheck['outcome']) => reading.checks.filter((check) => check.outcome === outcome && check.required === false);
  return [
    ...(optional('failing').length > 0 ? [namedLine(OPTIONAL_CHECKS_WARNINGS.failing, optional('failing'))] : []),
    ...(optional('pending').length > 0 ? [namedLine(OPTIONAL_CHECKS_WARNINGS.pending, optional('pending'))] : []),
  ];
}

function mergeBlockers(reading: PullRequestReading): string[] {
  const reviewOrChecks = [
    ...checkBlockers(reading),
    reading.review === 'changes-requested' ? MERGE_BLOCKERS.changesRequested : null,
    reading.review === 'review-required' ? MERGE_BLOCKERS.reviewRequired : null,
    reading.behindBase ? MERGE_BLOCKERS.behindBase : null,
  ].filter((line): line is string => line !== null);
  return [
    ...(reading.isDraft ? [MERGE_BLOCKERS.draft] : []),
    ...reviewOrChecks,
    // Protection gets its own line only when nothing above already explains the block.
    ...(reading.protectionBlocked && reviewOrChecks.length === 0 ? [MERGE_BLOCKERS.protection] : []),
    ...(reading.mergeable === 'unknown' ? [MERGE_BLOCKERS.unknown] : []),
  ];
}

/**
 * The four classes the Merge button acts on. `unmergeable` wins over everything; `conflicts` wins
 * over `blocked` (conflicts are resolved first, the blockers confirmed afterwards); an unknown
 * merge state is a blocker, never `clean`. Only checks the base branch requires block (all of them
 * when the provider can't say which); the rest come back as `warnings` and never change the class.
 */
export function classifyMergeState(reading: PullRequestReading): PullRequestMergeState {
  const reason = unmergeableReason(reading);
  const blockers = mergeBlockers(reading);
  const status: MergeStateStatus = reason !== null ? 'unmergeable'
    : reading.mergeable === 'conflicting' ? 'conflicts'
      : blockers.length > 0 ? 'blocked' : 'clean';
  return {
    number: reading.number,
    title: reading.title,
    status,
    blockers: status === 'unmergeable' ? [] : blockers,
    warnings: mergeWarnings(reading),
    reason,
    headBranch: reading.headBranch,
    baseBranch: reading.baseBranch,
    headBranchExists: reading.headBranchExists,
    isFork: reading.isFork,
  };
}

export interface PullRequestMergeResult {
  /** The remote head branch is gone after the merge, whether this call deleted it or it already was. */
  branchDeleted: boolean;
  /** Why deleting the head branch failed, when it did. The merge itself still succeeded. */
  branchWarning: string | null;
  /** Why the head branch was deliberately left in place (it is the base or default branch, or lives in a fork). */
  branchNote: string | null;
}

export interface PullRequestMergeOptions {
  bypassProtection?: boolean;
}

export class PullRequestNotFoundError extends Error {
  constructor(number: number) { super(`Pull request #${number} was not found.`); this.name = 'PullRequestNotFoundError'; }
}

export class PullRequestHeadGoneError extends Error {
  constructor(number: number) { super(`The branch of pull request #${number} no longer exists.`); this.name = 'PullRequestHeadGoneError'; }
}

// ---- GitHub, through `gh` ----

const CHECK_CONTEXTS = (isRequired: string) => `contexts(first: 100) {
              pageInfo { hasNextPage }
              nodes {
                __typename
                ... on CheckRun { name status conclusion ${isRequired} }
                ... on StatusContext { context state ${isRequired} }
              }
            }`;

const readQuery = (withRequired: boolean) => `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    defaultBranchRef { name }
    pullRequest(number: $number) {
      number title state isDraft mergeable mergeStateStatus reviewDecision
      headRefName headRefOid baseRefName isCrossRepository
      headRef { name }
      headRepository { url }
      commits(last: 1) { nodes { commit { statusCheckRollup { ${CHECK_CONTEXTS(withRequired ? 'isRequired(pullRequestNumber: $number)' : '')} } } } }
    }
  }
}`;

const MERGE_PERMISSIONS = ['ADMIN', 'MAINTAIN', 'WRITE'];

interface RawPullRequest {
  number?: unknown; title?: unknown; state?: unknown; isDraft?: unknown; mergeable?: unknown; mergeStateStatus?: unknown;
  reviewDecision?: unknown; headRefName?: unknown; headRefOid?: unknown; baseRefName?: unknown; isCrossRepository?: unknown;
  headRef?: { name?: unknown } | null;
  headRepository?: { url?: unknown } | null;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: RawContexts | null } | null } }[] };
}

interface RawContexts {
  pageInfo?: { hasNextPage?: unknown } | null;
  nodes?: unknown;
}

interface RawContext {
  __typename?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; context?: unknown; state?: unknown; isRequired?: unknown;
}

const invalidReading = () => new GhError('GitHub returned an invalid pull request');

function oneOf<T extends string>(value: unknown, known: Record<string, T>): T {
  if (typeof value !== 'string' || !(value in known)) throw invalidReading();
  return known[value]!;
}

const CHECK_RUN_FAILED = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'];
const CHECK_RUN_PASSED = ['SUCCESS', 'SKIPPED', 'NEUTRAL'];

function checkOutcomeOf(node: RawContext): Pick<PullRequestCheck, 'name' | 'outcome'> {
  if (node.__typename === 'CheckRun' && typeof node.name === 'string') {
    // A run that has not completed has no conclusion yet.
    if (node.status !== 'COMPLETED') return { name: node.name, outcome: 'pending' };
    const conclusion = oneOf(node.conclusion, Object.fromEntries([...CHECK_RUN_FAILED, ...CHECK_RUN_PASSED].map((value) => [value, value])));
    return { name: node.name, outcome: CHECK_RUN_FAILED.includes(conclusion) ? 'failing' : 'passing' };
  }
  if (node.__typename === 'StatusContext' && typeof node.context === 'string') {
    return { name: node.context, outcome: oneOf(node.state, { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' }) };
  }
  throw invalidReading();
}

/**
 * The PR's checks with GitHub's own "is required" flag on each. Required-ness is all or nothing: a
 * missing flag on any check, or more checks than one page holds, makes it unknown for every check.
 */
function checksOf(raw: RawPullRequest): PullRequestCheck[] {
  const contexts = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  if (!contexts) return [];
  if (!Array.isArray(contexts.nodes)) throw invalidReading();
  const nodes = contexts.nodes as RawContext[];
  const known = contexts.pageInfo?.hasNextPage === false && nodes.every((node) => typeof node?.isRequired === 'boolean');
  return nodes.map((node) => ({ ...checkOutcomeOf(node ?? {}), required: known ? node.isRequired as boolean : null }));
}

function reviewOf(raw: RawPullRequest): PullRequestReading['review'] {
  if (raw.reviewDecision === null || raw.reviewDecision === undefined) return 'none';
  return oneOf(raw.reviewDecision, { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', REVIEW_REQUIRED: 'review-required' });
}

function parseReading(out: string): PullRequestReading {
  let repository: { viewerPermission?: unknown; defaultBranchRef?: { name?: unknown } | null; pullRequest?: RawPullRequest | null } | undefined;
  try { repository = (JSON.parse(out) as { data?: { repository?: typeof repository } }).data?.repository; } catch { throw invalidReading(); }
  const raw = repository?.pullRequest;
  if (!raw || typeof raw.number !== 'number' || typeof raw.title !== 'string' || typeof raw.headRefName !== 'string'
    || typeof raw.baseRefName !== 'string' || typeof raw.headRefOid !== 'string' || typeof raw.isDraft !== 'boolean') throw invalidReading();
  const mergeStateStatus = oneOf(raw.mergeStateStatus, {
    BEHIND: 'BEHIND', BLOCKED: 'BLOCKED', CLEAN: 'CLEAN', DIRTY: 'DIRTY', DRAFT: 'DRAFT', HAS_HOOKS: 'HAS_HOOKS', UNKNOWN: 'UNKNOWN', UNSTABLE: 'UNSTABLE',
  });
  const isFork = raw.isCrossRepository === true;
  const forkUrl = isFork && typeof raw.headRepository?.url === 'string' ? `${raw.headRepository.url}.git` : null;
  return {
    number: raw.number,
    title: raw.title,
    state: oneOf(raw.state, { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' }),
    isDraft: raw.isDraft,
    mergeable: oneOf(raw.mergeable, { MERGEABLE: 'mergeable', CONFLICTING: 'conflicting', UNKNOWN: 'unknown' }),
    checks: checksOf(raw),
    review: reviewOf(raw),
    protectionBlocked: mergeStateStatus === 'BLOCKED',
    behindBase: mergeStateStatus === 'BEHIND',
    canMerge: typeof repository?.viewerPermission === 'string' && MERGE_PERMISSIONS.includes(repository.viewerPermission),
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    headSha: raw.headRefOid,
    // A fork's branch is reachable only while the fork itself still is.
    headBranchExists: Boolean(raw.headRef) && (!isFork || forkUrl !== null),
    isFork,
    headRepositoryUrl: forkUrl,
    defaultBranch: typeof repository?.defaultBranchRef?.name === 'string' ? repository.defaultBranchRef.name : '',
    refusal: null,
  };
}

/** "Read PR merge state": one GraphQL call for everything `classifyMergeState` needs. */
export async function ghReadPullRequest(cwd: string, slug: string, number: number, run: typeof gh = gh): Promise<PullRequestReading> {
  const [owner = '', name = ''] = slug.split('/');
  const read = (withRequired: boolean) =>
    run(cwd, ['api', 'graphql', '-f', `query=${readQuery(withRequired)}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]);
  let out: string;
  try {
    try {
      out = await read(true);
    } catch (error) {
      // GitHub refusing the "is required" field must not hide the PR: ask again without it, so every check is unknown-required.
      if (!/isRequired/i.test((error as Error).message)) throw error;
      out = await read(false);
    }
  } catch (error) {
    if (/Could not resolve to a PullRequest/i.test((error as Error).message)) throw new PullRequestNotFoundError(number);
    throw error;
  }
  return parseReading(out);
}

const REFERENCE_GONE = /Reference does not exist/i;

/**
 * Deletes the remote branch. One that is already gone counts as deleted, as when GitHub removes the
 * head branch itself on merge. Only GitHub's "Reference does not exist" means that: a bare
 * "Not Found" is also its answer for a repository the account cannot see.
 */
async function deleteRemoteBranch(cwd: string, slug: string, branch: string, run: typeof gh): Promise<void> {
  try {
    await run(cwd, ['api', '-X', 'DELETE', `repos/${slug}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`]);
  } catch (error) {
    if (!REFERENCE_GONE.test((error as Error).message)) throw error;
  }
}

/**
 * "Merge PR": always a merge commit, then the remote head branch is deleted. `gh pr merge
 * --delete-branch` is deliberately not used: run inside a checkout it would also delete the local
 * branch and switch the working copy. Open pull requests stacked on the head branch are moved onto
 * this PR's base first, because deleting a branch through the API closes them. A failed deletion
 * never fails the merge; it comes back as `branchWarning`. A head branch that is already gone when
 * the delete runs is not a failure: it is reported as deleted. `bypassProtection` is for a merge the
 * person confirmed despite its blockers: it lets an account allowed to bypass the base branch's
 * protection do so, and changes nothing for one that isn't.
 */
export async function ghMergePullRequest(
  cwd: string,
  slug: string,
  pr: Pick<PullRequestReading, 'number' | 'headBranch' | 'baseBranch' | 'defaultBranch' | 'isFork'>,
  options: PullRequestMergeOptions = {},
  run: typeof gh = gh,
): Promise<PullRequestMergeResult> {
  // Without `--admin`, `gh` itself refuses a PR the base branch's protection blocks, before asking GitHub.
  await run(cwd, ['pr', 'merge', String(pr.number), '--repo', slug, '--merge', ...(options.bypassProtection ? ['--admin'] : [])]);
  if (pr.isFork) return { branchDeleted: false, branchWarning: null, branchNote: `"${pr.headBranch}" lives in a fork, so it was left in place.` };
  if (pr.headBranch === pr.baseBranch || pr.headBranch === pr.defaultBranch) {
    return { branchDeleted: false, branchWarning: null, branchNote: `"${pr.headBranch}" is the base or default branch, so it was kept.` };
  }
  try {
    const stacked = await run(cwd, ['api', '--paginate', '--jq', '.[].number', `repos/${slug}/pulls?state=open&base=${encodeURIComponent(pr.headBranch)}&per_page=100`]);
    for (const number of stacked.split('\n').map((line) => line.trim()).filter(Boolean)) {
      await run(cwd, ['api', '-X', 'PATCH', `repos/${slug}/pulls/${number}`, '-f', `base=${pr.baseBranch}`]);
    }
    await deleteRemoteBranch(cwd, slug, pr.headBranch, run);
    return { branchDeleted: true, branchWarning: null, branchNote: null };
  } catch (error) {
    return { branchDeleted: false, branchWarning: `The branch "${pr.headBranch}" was not deleted: ${ghActionFailure(error)}`, branchNote: null };
  }
}

/** Where `ghFetchPullRequestHead` keeps a fetched PR head, so a concurrent fetch can't move it the way it moves FETCH_HEAD. */
export function pullRequestHeadRef(number: number): string {
  return `refs/agent-visual-os/pull/${number}`;
}

/**
 * "Fetch PR head for checkout": fetches GitHub's own `pull/<n>/head` ref and resolves its commit, so
 * a PR from a fork works and a same-named branch on `origin` is never mistaken for it.
 */
export async function ghFetchPullRequestHead(cwd: string, number: number, run: typeof git = git): Promise<string> {
  const ref = pullRequestHeadRef(number);
  try {
    await run(cwd, ['fetch', '--quiet', 'origin', `+refs/pull/${number}/head:${ref}`]);
  } catch (error) {
    if (/couldn'?t find remote ref|could not find remote ref/i.test((error as Error).message)) throw new PullRequestHeadGoneError(number);
    throw error;
  }
  return run(cwd, ['rev-parse', '--verify', ref]);
}

const UNREACHABLE = /timed? ?out|network|ECONN|ENET|EAI_AGAIN|could not resolve host|dial tcp/i;

/** The provider's own explanation: what `gh` or `git` printed after the "Command failed" line. */
function providerText(message: string): string {
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  const own = lines.length > 1 ? lines.slice(1) : lines;
  return own.join(' ').replace(/^(?:gh command failed|Git operation failed):\s*/i, '').replace(/^(?:GraphQL|fatal|error):\s*/i, '').trim();
}

/**
 * A short human reason for a failed merge, merge-state read or PR-head fetch: the same environment
 * cases the list names (`gh` missing, signed out, rate limit, network), otherwise the provider's own text.
 */
export function ghActionFailure(error: unknown): string {
  if (error instanceof GithubAccountError) return error.message;
  const message = error instanceof Error ? error.message : '';
  const environment = ghEnvironmentFailure(message);
  if (environment) return environment;
  if (UNREACHABLE.test(message)) return 'Could not reach GitHub.';
  return providerText(message) || 'GitHub refused the request.';
}
