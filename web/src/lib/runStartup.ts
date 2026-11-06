import type { RunStartupStep, WorkflowRunRecord } from './serverApi';
import type { StepCardProgress } from './projectTasks';

/**
 * How a run's start-up reads on screen: the named steps between a start being accepted and the
 * first agent launching. Static text only — a step's state is a glyph and a word, never an animation.
 */

export type StartupRun = Pick<WorkflowRunRecord, 'status' | 'startup'>;

export interface StartupView {
  steps: RunStartupStep[];
  /** Steps finished so far. */
  done: number;
  total: number;
  /** The step in flight, else the one that failed; null when every step is pending or done. */
  current: RunStartupStep | null;
  /** The failed step and why, once a step has failed. */
  failure: { name: string; reason: string } | null;
}

/** The start-up of a run that has not finished it — null for a run from before the phase existed, or one whose steps all completed (an ordinary running run). */
export function startupView(run: StartupRun): StartupView | null {
  const steps = run.startup?.steps;
  if (!steps || steps.every((step) => step.state === 'done')) return null;
  const failed = steps.find((step) => step.state === 'failed');
  return {
    steps,
    done: steps.filter((step) => step.state === 'done').length,
    total: steps.length,
    current: steps.find((step) => step.state === 'running') ?? failed ?? null,
    failure: failed ? { name: failed.name, reason: failed.reason ?? 'Unknown error' } : null,
  };
}

/** The compact card line: "Creating worktree · 3/5", or "Creating worktree failed: <reason>". */
export function startupLabel(view: StartupView): string {
  if (view.failure) return `${view.failure.name} failed: ${view.failure.reason}`;
  const name = view.current?.name ?? view.steps.find((step) => step.state === 'pending')?.name ?? 'Starting';
  return `${name} · ${view.done}/${view.total}`;
}

const GLYPHS: Record<RunStartupStep['state'], string> = { done: '✓', running: '●', failed: '✕', pending: '○' };

/** The glyph shown beside a step in the full list. */
export function startupGlyph(step: RunStartupStep): string {
  return GLYPHS[step.state];
}

/** A Running or Needs-you card's progress line for a run that is starting (or failed starting); null when it has no unfinished start-up. */
export function startupCardProgress(run: StartupRun): StepCardProgress | null {
  const view = startupView(run);
  return view ? { stepName: startupLabel(view), elapsed: null, checklist: null } : null;
}
