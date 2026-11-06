/**
 * Pure helpers behind a WorkflowRun step's Quick look (task 5.008): which view a step offers, the
 * labels its source strip and command menu show, and how the Diff view reads its data. The
 * components in web/src/ui/project-popup/quick-look/ stay thin wiring around these.
 */

import type { ChangedFile, ChangedFileStatus, CommandRun, CommandRunLocation, ProjectCommand, QuickLookDiff, QuickLookKind, RunLocation, WorkflowStep } from './serverApi';

/** The Catalog editor's choices for a step's Quick look, each with its one-line hint. */
export const QUICK_LOOK_OPTIONS: { value: QuickLookKind; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'No quick look for this step' },
  { value: 'code', label: 'Code', hint: 'Browse the task\'s working copy, read-only' },
  { value: 'diff', label: 'Diff', hint: 'The task branch\'s changes against its base branch' },
  { value: 'documents', label: 'Documents', hint: 'The task\'s documents, read-only' },
  { value: 'commands', label: 'Commands', hint: 'Run the project\'s commands in the task\'s working copy' },
];

/** A Quick look that is a view of its own in the step detail, beside Summary and Session. */
export type QuickLookView = 'code' | 'diff' | 'documents';

export const QUICK_LOOK_VIEW_LABELS: Record<QuickLookView, string> = { code: 'Code', diff: 'Diff', documents: 'Docs' };

/** The step's third view, or null for None and for Commands (a menu beside the switch, not a view). */
export function quickLookViewFor(step: Pick<WorkflowStep, 'quickLook'> | null | undefined): QuickLookView | null {
  const kind = step?.quickLook;
  return kind === 'code' || kind === 'diff' || kind === 'documents' ? kind : null;
}

export function hasQuickLookCommands(step: Pick<WorkflowStep, 'quickLook'> | null | undefined): boolean {
  return step?.quickLook === 'commands';
}

/** The source strip's location chip. */
export function runLocationLabel(location: RunLocation): string {
  if (location.kind === 'project-folder') return 'Project folder';
  if (location.kind === 'removed') return 'Working copy removed';
  return 'Task working copy';
}

/** The strip's reminder that the view is live, not the selected round's snapshot. */
export function liveNote(location: Pick<RunLocation, 'kind'>, roundNumber: number): string {
  return location.kind === 'project-folder'
    ? 'Live: this run works directly in the project folder'
    : `Live: current state, not a snapshot of Round ${roundNumber}`;
}

/** A daemon answer of 410: the run's working copy was removed when it completed. */
export function isWorkingCopyRemoved(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 410;
}

export const WORKING_COPY_REMOVED_TITLE = 'The task\'s working copy has been removed';

export function workingCopyRemovedDetail(branch: string | null): string {
  return branch ? `It was cleaned up when the run completed. The branch ${branch} is kept.` : 'It was cleaned up when the run completed.';
}

/** Where a command run ran, for the log popup's chip and History. Runs recorded before locations existed ran in the main checkout. */
export function commandLocationLabel(location: CommandRunLocation | undefined): string {
  if (!location || location.kind === 'main') return 'Main checkout';
  const task = location.taskRef ? `Task ${location.taskRef}` : 'Task';
  return location.branch ? `${task} · ${location.branch}` : task;
}

/** A run from a task's working copy has no Re-run: that working copy may be gone, and it's run again from the task's own Quick look. */
export function canRerunCommandRun(run: Pick<CommandRun, 'location'>): boolean {
  return run.location?.kind !== 'task';
}

/** Where a task's Commands menu runs things; while the location is still loading it assumes the task's own working copy. */
export function commandsWhereLabel(location: Pick<RunLocation, 'kind' | 'branch'> | null): string {
  if (location?.kind === 'project-folder') return 'Runs in the project folder (this task has no separate branch)';
  return `Runs in this task's working copy${location?.branch ? ` · ${location.branch}` : ''}`;
}

/** The header's command order: highlighted commands first, then the rest, each in saved order. */
export function orderedCommands(commands: ProjectCommand[]): { highlighted: ProjectCommand[]; rest: ProjectCommand[] } {
  return { highlighted: commands.filter((command) => command.highlighted), rest: commands.filter((command) => !command.highlighted) };
}

/**
 * A saved command's entry in a task's Commands menu:
 * - `idle`: choosing it runs it in this task's working copy.
 * - `minimized`: it's running in this task's working copy and its log is closed.
 * - `running-elsewhere`: one run at a time — it's running in the main checkout or another task; choosing it opens that log.
 */
export type CommandMenuState =
  | { kind: 'idle' }
  | { kind: 'minimized'; runId: string }
  | { kind: 'running-elsewhere'; runId: string; where: string };

export function commandMenuState(running: CommandRun | undefined, workflowRunId: string): CommandMenuState {
  if (!running) return { kind: 'idle' };
  if (isRunInTask(running, workflowRunId)) return { kind: 'minimized', runId: running.id };
  return { kind: 'running-elsewhere', runId: running.id, where: commandLocationLabel(running.location) };
}

function isRunInTask(run: CommandRun, workflowRunId: string): boolean {
  return run.location?.kind === 'task' && run.location.workflowRunId === workflowRunId;
}

/** Runs still going in this task's working copy whose log isn't open — each gets a button to reopen it. */
export function minimizedTaskRuns(runsById: Record<string, CommandRun>, workflowRunId: string, openRunId: string | null): CommandRun[] {
  return Object.values(runsById)
    .filter((run) => run.status === 'running' && run.id !== openRunId && isRunInTask(run, workflowRunId))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

const DIFF_BADGES: Record<ChangedFileStatus, { letter: string; label: string }> = {
  added: { letter: 'A', label: 'Added' },
  modified: { letter: 'M', label: 'Modified' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
};

export function diffBadge(status: ChangedFileStatus): { letter: string; label: string } {
  return DIFF_BADGES[status];
}

/** "N files changed" totals; binary files have no line counts. */
export function diffTotals(files: Pick<ChangedFile, 'additions' | 'deletions'>[]): { files: number; additions: number; deletions: number } {
  return files.reduce<{ files: number; additions: number; deletions: number }>(
    (totals, file) => ({ files: totals.files + 1, additions: totals.additions + (file.additions ?? 0), deletions: totals.deletions + (file.deletions ?? 0) }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context';

/** How one unified-diff line is drawn. File headers (`diff --git`, `---`, `+++`, `index`, …) are meta, never additions or deletions. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity |rename |old mode|new mode|Binary files|\\ No newline)/.test(line)) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/** The strip's chip for a diff: the branch against its base, or the project folder against HEAD. */
export function diffCompareLabel(diff: Pick<QuickLookDiff, 'source' | 'base' | 'branch'>): string {
  if (diff.source === 'project-folder') return 'Project folder vs HEAD';
  return `${diff.branch ?? 'This branch'} vs ${diff.base ?? 'its base'}`;
}

/** The Diff strip's live note: the kept branch, the project folder, or the worktree's current state. */
export function diffLiveNote(diff: Pick<QuickLookDiff, 'source'>, roundNumber: number): string {
  if (diff.source === 'branch') return `Live: the branch as it is now, not a snapshot of Round ${roundNumber}`;
  return liveNote({ kind: diff.source === 'project-folder' ? 'project-folder' : 'worktree' }, roundNumber);
}

/** Extra strip text when the diff was read from the kept branch after the worktree went away. */
export function diffSourceNote(diff: Pick<QuickLookDiff, 'source'>): string | null {
  return diff.source === 'branch' ? 'From the branch (working copy removed)' : null;
}

export function diffEmptyMessage(diff: Pick<QuickLookDiff, 'source' | 'base'>): string {
  return diff.source === 'project-folder' ? 'No uncommitted changes in the project folder.' : `No changes against ${diff.base ?? 'the base branch'} yet.`;
}
