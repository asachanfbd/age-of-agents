import type { RunStartup, RunStartupStep, RunStartupStepId } from '../domain/types.ts';

/**
 * The visible start-up of a WorkflowRun: the slow work between accepting a start and launching the
 * first step's agent, kept as named steps on the run so the board, the detail view and a reload can
 * show where it is.
 */

const STEP_NAMES: Record<RunStartupStepId, string> = {
  name: 'Choosing branch name',
  worktree: 'Creating worktree',
  hooks: 'Installing CLI hooks',
  launch: 'Launching agent',
};

export type StartupKind =
  /** A new branch and worktree for the task. */
  | 'branch'
  /** A worktree at a pull request's head, on a run-local branch (conflict resolution). */
  | 'conflict'
  /** The Project's own folder, or a repository-less Project: nothing to set up. */
  | 'in-place';

const STEP_IDS: Record<StartupKind, RunStartupStepId[]> = {
  branch: ['name', 'worktree', 'hooks', 'launch'],
  conflict: ['worktree', 'hooks', 'launch'],
  'in-place': ['launch'],
};

export function planStartup(kind: StartupKind, reuseBranch: boolean): RunStartup {
  return {
    reuseBranch,
    steps: STEP_IDS[kind].map((id): RunStartupStep => ({ id, name: STEP_NAMES[id], state: 'pending' })),
  };
}

/** Drops steps that no longer exist, so a start-up saved by an older version (with a `stack` step) is read as the current plan. */
export function normalizeStartup(startup: RunStartup): RunStartup {
  return { ...startup, steps: startup.steps.filter((step) => (step.id as string) !== 'stack') };
}

/** Whether the run's start-up was left unfinished: some step never completed, so the agent was never launched. */
export function isStartupIncomplete(startup: RunStartup | undefined): startup is RunStartup {
  return Boolean(startup) && normalizeStartup(startup!).steps.some((step) => step.state !== 'done');
}

export function startupKindOf(startup: RunStartup): StartupKind {
  const ids = startup.steps.map((step) => step.id);
  if (ids.includes('name')) return 'branch';
  return ids.includes('worktree') ? 'conflict' : 'in-place';
}

function withStep(startup: RunStartup, id: RunStartupStepId, change: Partial<RunStartupStep>): RunStartup {
  return { ...startup, steps: startup.steps.map((step) => (step.id === id ? { ...step, ...change } : step)) };
}

export function beginStartupStep(startup: RunStartup, id: RunStartupStepId): RunStartup {
  return withStep(startup, id, { state: 'running' });
}

export function finishStartupStep(startup: RunStartup, id: RunStartupStepId): RunStartup {
  return withStep(startup, id, { state: 'done' });
}

export function failStartupStep(startup: RunStartup, id: RunStartupStepId, reason: string): RunStartup {
  return withStep(startup, id, { state: 'failed', reason });
}

/** Every step back to pending, for a retry. */
export function resetStartup(startup: RunStartup): RunStartup {
  return { ...startup, steps: normalizeStartup(startup).steps.map(({ id, name }) => ({ id, name, state: 'pending' as const })) };
}

/** The step a person should read as current: the running one, else the failed one. */
export function currentStartupStep(startup: RunStartup): RunStartupStep | undefined {
  return startup.steps.find((step) => step.state === 'running') ?? startup.steps.find((step) => step.state === 'failed');
}
