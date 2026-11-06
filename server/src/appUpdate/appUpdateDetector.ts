/**
 * Task 7.001: compares the daemon's own checkout (APP_CHECKOUT_ROOT) against `origin/<branch>` —
 * structurally the same "fetch, then compare" shape as `projects/gitSyncPoller.ts`'s
 * `computeProjectSync`, but pointed at the app's own repo instead of a registered Project's, and
 * producing the richer `AppUpdateStatus` shape (classification, incoming commits, blocking-aware
 * apply gating) that drives the footer item and update popover.
 *
 * Ownership split with appUpdateService.ts (see that module's own doc comment for the full
 * reasoning): this module owns everything a fresh `git fetch` can tell you — availability, branch,
 * currentCommit, aheadBy/behindBy, classification, incoming commits, checkError/checkedAt/
 * lastSuccessfulCheckAt. `phase`/`updatedToCommit`/`failureMessage`/`failureLogPath` are the
 * service's own in-memory state, not this detector's — they're carried through from `previous`
 * unchanged on every call, and `canApply`/`applyBlockedReason` are derived from them via
 * `computeApplyFields` (exported so the service can re-derive them itself whenever it changes
 * `phase` directly, e.g. on apply/cancel, without re-running a git check). `blocking` is likewise not
 * computed here — see appUpdateBlocking.ts's `computeBlockingCounts`, which the service calls
 * separately and composes in, since it's cheap enough to always compute fresh rather than cache.
 */
import { git, currentBranch, fetchOrigin } from '../projects/git.ts';
import { checkBlockingChanges, describeFiles, NO_BLOCKING_CHANGES } from '../projects/incomingOverlap.ts';
import type { IncomingPaths } from '../projects/incomingOverlap.ts';
import { APP_CHECKOUT_ROOT, IS_PROD_MODE } from '../config.ts';
import { ZERO_APP_UPDATE_BLOCKING } from './appUpdateBlocking.ts';
import type { AppUpdateAvailability, AppUpdateClassification, AppUpdateCommit, AppUpdatePhase, AppUpdateStatus } from '../domain/types.ts';

const MAX_INCOMING_COMMITS = 10;

/**
 * Every file under `web/`, and at least one file — a zero-file diff (defensive: `git diff
 * --name-only` returning nothing when `behindBy > 0`, which should never happen but must never be
 * read as "nothing changed under server/ either") falls through `every` to `false` on an empty array,
 * which is exactly the fallback this needs. No special-cased "these files mean a server change"
 * list is needed: root package.json, scripts/prod-start.sh, scripts/prod-stop.sh and every module
 * under appUpdate/ itself all live outside `web/`, so they already force `classification: 'server'`
 * under this one rule for free.
 */
export function isWebOnly(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every((file) => file.startsWith('web/'));
}

export function needsWebInstall(changedFiles: string[]): boolean {
  return changedFiles.includes('web/package.json') || changedFiles.includes('web/package-lock.json');
}

/**
 * `canApply`/`applyBlockedReason` as a pure function of the three things they depend on, so both
 * `computeAppUpdateStatus` (on every check) and `appUpdateService.ts` (whenever it changes `phase`
 * directly — apply, cancel, the held watcher firing) derive them the same way instead of each
 * hand-rolling the same three-way branch.
 */
export function computeApplyFields(
  mode: AppUpdateStatus['mode'],
  availability: AppUpdateAvailability,
  phase: AppUpdatePhase,
): { canApply: boolean; applyBlockedReason: string | null } {
  if (phase === 'held' || phase === 'updating') {
    return { canApply: false, applyBlockedReason: `An update is already ${phase === 'held' ? 'held' : 'being applied'}.` };
  }
  if (mode === 'dev') {
    return {
      canApply: false,
      applyBlockedReason: "Updates can only be applied to a production-style install. Run 'npm run prod:update' from a terminal instead.",
    };
  }
  if (availability !== 'available') {
    // Self-explanatory from availability/cantUpdateReason/checkError already — nothing to add here.
    return { canApply: false, applyBlockedReason: null };
  }
  return { canApply: true, applyBlockedReason: null };
}

function overlapReason(paths: string[], total: number, fallbackReason: string | null): string {
  if (fallbackReason) return `This checkout has uncommitted changes to tracked files, and ${fallbackReason}.`;
  return `This checkout has uncommitted changes to files the update also changes: ${describeFiles(paths, total, 3)}.`;
}

/** Builds the 'could-not-check' result on any failure, carrying every other field forward from `previous` untouched — see this module's doc comment on the ownership split. */
function carryForwardOnFailure(previous: AppUpdateStatus | null, checkError: string): AppUpdateStatus {
  const mode: AppUpdateStatus['mode'] = IS_PROD_MODE ? 'prod' : 'dev';
  const phase = previous?.phase ?? 'idle';
  const availability: AppUpdateAvailability = 'could-not-check';
  const { canApply, applyBlockedReason } = computeApplyFields(mode, availability, phase);
  return {
    mode,
    canApply,
    applyBlockedReason,
    availability,
    branch: previous?.branch ?? '',
    currentCommit: previous?.currentCommit ?? null,
    aheadBy: previous?.aheadBy ?? 0,
    behindBy: previous?.behindBy ?? 0,
    classification: previous?.classification ?? null,
    installWebDeps: previous?.installWebDeps ?? false,
    incomingCommits: previous?.incomingCommits ?? [],
    incomingCommitsTruncated: previous?.incomingCommitsTruncated ?? false,
    cantUpdateReason: previous?.cantUpdateReason ?? null,
    blockingFiles: previous?.blockingFiles ?? [],
    blockingFilesTotal: previous?.blockingFilesTotal ?? 0,
    checkError,
    checkedAt: new Date().toISOString(),
    lastSuccessfulCheckAt: previous?.lastSuccessfulCheckAt ?? null,
    phase,
    blocking: previous?.blocking ?? ZERO_APP_UPDATE_BLOCKING,
    updatedToCommit: previous?.updatedToCommit ?? null,
    failureMessage: previous?.failureMessage ?? null,
    failureLogPath: previous?.failureLogPath ?? null,
  };
}

/** Parses `git log --format=%H%x1f%s`'s output (newest first) into commit entries, short-sha'd and capped at MAX_INCOMING_COMMITS. */
function parseIncomingCommits(log: string): AppUpdateCommit[] {
  return log.split('\n').filter(Boolean).map((line) => {
    const sep = line.indexOf('\x1f');
    const sha = sep === -1 ? line : line.slice(0, sep);
    const subject = sep === -1 ? '' : line.slice(sep + 1);
    return { sha: sha.slice(0, 7), subject };
  });
}

/**
 * Never throws. Pure async detection: a fresh `git fetch` + comparison of APP_CHECKOUT_ROOT against
 * `origin/<branch>`, classified web-only/server. `previous` carries forward the service-owned fields
 * (`phase`/`updatedToCommit`/`failureMessage`/`failureLogPath`) and, on any failure, every detection
 * field too (see carryForwardOnFailure).
 */
export async function computeAppUpdateStatus(
  previous: AppUpdateStatus | null,
  deps: { incomingPaths?: IncomingPaths } = {},
): Promise<AppUpdateStatus> {
  const mode: AppUpdateStatus['mode'] = IS_PROD_MODE ? 'prod' : 'dev';
  const cwd = APP_CHECKOUT_ROOT;
  const phase = previous?.phase ?? 'idle';

  let branch: string;
  try {
    branch = await currentBranch(cwd);
  } catch (error) {
    return carryForwardOnFailure(previous, `Could not determine the current branch: ${(error as Error).message}`);
  }

  try {
    await fetchOrigin(cwd);
  } catch (error) {
    return carryForwardOnFailure(previous, `Could not reach origin: ${(error as Error).message}`);
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  let hasRemote: boolean;
  try {
    hasRemote = (await git(cwd, ['for-each-ref', remoteRef])).length > 0;
  } catch (error) {
    return carryForwardOnFailure(previous, `Could not look up origin/${branch}: ${(error as Error).message}`);
  }
  if (!hasRemote) {
    return carryForwardOnFailure(previous, `origin/${branch} does not exist — nothing to compare against.`);
  }

  let aheadBy = 0;
  let behindBy = 0;
  try {
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
    const [a = 0, b = 0] = counts.split(/\s+/).map(Number);
    aheadBy = a;
    behindBy = b;
  } catch (error) {
    return carryForwardOnFailure(previous, `Could not compare HEAD to origin/${branch}: ${(error as Error).message}`);
  }

  let currentCommit: string;
  try {
    currentCommit = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  } catch (error) {
    return carryForwardOnFailure(previous, `Could not read HEAD: ${(error as Error).message}`);
  }

  let availability: AppUpdateAvailability;
  let cantUpdateReason: string | null = null;
  let classification: AppUpdateClassification | null = null;
  let installWebDeps = false;
  let incomingCommits: AppUpdateCommit[] = [];
  let incomingCommitsTruncated = false;

  let blocking = NO_BLOCKING_CHANGES;

  if (aheadBy > 0 && behindBy > 0) {
    availability = 'cant-auto-update';
    cantUpdateReason = `This checkout has diverged from origin/${branch} (${aheadBy} local commit(s), ${behindBy} remote commit(s)).`;
  } else if (aheadBy > 0) {
    availability = 'cant-auto-update';
    cantUpdateReason = `This checkout is ${aheadBy} commit(s) ahead of origin/${branch}.`;
  } else if (behindBy === 0) {
    availability = 'up-to-date';
  } else {
    let incoming: string[] | null;
    try {
      ({ incoming, blocking } = await checkBlockingChanges(cwd, remoteRef, { incomingPaths: deps.incomingPaths }));
    } catch (error) {
      return carryForwardOnFailure(previous, `Could not check for local changes: ${(error as Error).message}`);
    }
    if (blocking.total > 0) {
      availability = 'cant-auto-update';
      cantUpdateReason = overlapReason(blocking.files.map((file) => file.path), blocking.total, blocking.fallbackReason);
    } else {
      availability = 'available';
      // Unknown incoming paths can only be a server update: nothing proves it stays under web/.
      classification = incoming && isWebOnly(incoming) ? 'web-only' : 'server';
      installWebDeps = incoming ? needsWebInstall(incoming) : false;
      const log = await git(cwd, ['log', '--format=%H%x1f%s', `HEAD..${remoteRef}`]);
      incomingCommits = parseIncomingCommits(log).slice(0, MAX_INCOMING_COMMITS);
      incomingCommitsTruncated = behindBy > MAX_INCOMING_COMMITS;
    }
  }

  const { canApply, applyBlockedReason } = computeApplyFields(mode, availability, phase);
  const now = new Date().toISOString();

  return {
    mode,
    canApply,
    applyBlockedReason,
    availability,
    branch,
    currentCommit,
    aheadBy,
    behindBy,
    classification,
    installWebDeps,
    incomingCommits,
    incomingCommitsTruncated,
    cantUpdateReason,
    blockingFiles: blocking.files,
    blockingFilesTotal: blocking.total,
    checkError: null,
    checkedAt: now,
    lastSuccessfulCheckAt: now,
    phase,
    blocking: previous?.blocking ?? ZERO_APP_UPDATE_BLOCKING,
    updatedToCommit: previous?.updatedToCommit ?? null,
    failureMessage: previous?.failureMessage ?? null,
    failureLogPath: previous?.failureLogPath ?? null,
  };
}
