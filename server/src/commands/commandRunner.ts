import { randomUUID } from 'node:crypto';
import { spawnInProcessGroup } from './processGroup.ts';
import type { GroupProcess } from './processGroup.ts';
import { getCommand } from './commandService.ts';
import { getProject, projectAbsolutePath } from '../projects/projectService.ts';
import { currentBranch, FETCH_ORIGIN_COMMAND } from '../projects/git.ts';
import { createStreamRedactor, redactSecrets } from '../redaction.ts';
import { withProjectGithub } from '../github/accounts.ts';
import { githubScope, operationEnv } from '../github/context.ts';
import { gitSyncPoller } from '../projects/gitSyncPoller.ts';
import { assertProjectFolderFree, defaultSessionRegistry, type SessionRegistry } from '../worker/projectFolderGuard.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { isRunWatched, ranLongEnough } from '../notifications/runWatch.ts';
import type { CommandRunRecord, NotificationSubject, CommandRunLocation, PlanItemRecord, ProjectRecord, WorkflowRunRecord } from '../domain/types.ts';
import { namedAtStart } from '../domain/displayName.ts';
import { readableLocation } from '../projects/quickLook.ts';
import { commandRunsDb, planItemsDb } from '../db/collections.ts';

/**
 * Command *runs* need a live WS feed since they change asynchronously in the
 * background (a running process's output/status) — command *definitions*
 * (create/update/delete) don't, the same way PlanItem CRUD doesn't emit a
 * WorkerEvent (see planItemService.ts): the store just folds the HTTP
 * response straight into local state. See docs/architecture.md's "Project
 * Commands" decision.
 */

export class CommandRunNotFoundError extends Error {
  constructor() {
    super('This command run no longer exists');
    this.name = 'CommandRunNotFoundError';
  }
}

export class CommandAlreadyRunningError extends Error {
  constructor(commandName: string) {
    super(`${namedAtStart('command', commandName)} is already running — wait for it to finish (or stop it) before running it again`);
    this.name = 'CommandAlreadyRunningError';
  }
}

export type CommandEvent =
  | { type: 'commandRun'; run: CommandRunRecord }
  | { type: 'commandRunLog'; runId: string; chunk: string };

type Listener = (event: CommandEvent) => void;

/** Where to run a command: omitted means the Project's own folder; `workflowRun` means that run's working copy (its Quick look). */
export interface CommandRunOptions {
  workflowRun?: WorkflowRunRecord;
  /** Marks the run as started by the scheduler rather than a person, so History shows it as automatic. */
  automatic?: boolean;
}

const MAIN_LOCATION: CommandRunLocation = { kind: 'main' };

/** "5.008" for an item from a planning session, the same number its title starts with. */
function planningRefLabel(item: PlanItemRecord | undefined): string | null {
  const ref = item?.planningRef;
  return ref ? `${ref.session}.${String(ref.task).padStart(3, '0')}` : null;
}

/**
 * The directory and recorded location for a run. A WorkflowRun's own worktree is a `task`
 * location; a run started without a separate branch works in the Project's folder, so its commands
 * run there as `main`. Refuses a WorkflowRun of another Project and a removed working copy.
 */
async function resolveCommandLocation(project: ProjectRecord, options: CommandRunOptions): Promise<{ cwd: string; location: CommandRunLocation }> {
  const run = options.workflowRun;
  if (!run) return { cwd: projectAbsolutePath(project), location: MAIN_LOCATION };
  const where = await readableLocation(run, project);
  if (where.kind === 'project-folder') return { cwd: where.root, location: MAIN_LOCATION };
  const item = await planItemsDb.get(run.planItemId);
  return {
    cwd: where.root,
    location: { kind: 'task', workflowRunId: run.id, planItemId: run.planItemId, branch: where.branch, taskRef: planningRefLabel(item) },
  };
}

/** The synthetic, never-persisted commandId `runProjectSync` tracks its runs under — see its doc comment. */
function syncCommandId(projectId: string): string {
  return `sync:${projectId}`;
}

/**
 * Runs user-defined ProjectCommands as plain shell subprocesses — no LLM, no
 * session, no autonomy setting; a `child_process.spawn(..., { shell: true })`
 * run in the Project's own root directory or a WorkflowRun's working copy. Structurally parallel to
 * `worker/workerManager.ts` (its own event bus + a `runningProcesses` map for
 * Stop), but much smaller since there's no turn/transcript/persona concept
 * here — see docs/architecture.md's "Project Commands" decision.
 */
export interface CommandRunnerDeps {
  /** Injectable terminal-session host for `runProjectSync`'s folder-busy check — overridable so a test can make it agree with a worker manager built with its own fake host. Every real caller uses the default (real) terminal-session host. */
  sessions?: SessionRegistry;
}

/** A sync run talks to GitHub, so it authenticates as the project's account; saved commands keep the daemon's environment. */
async function commandEnv(projectId: string, origin: CommandRunRecord['origin']): Promise<NodeJS.ProcessEnv> {
  if (origin !== 'sync') return process.env;
  return withProjectGithub(await getProject(projectId), 'sync the branch with origin', async () => (githubScope.getStore() ? operationEnv() : process.env));
}

export function createCommandRunner(deps: CommandRunnerDeps = {}) {
  const listeners = new Set<Listener>();
  const sessions = deps.sessions ?? defaultSessionRegistry();
  /** In-flight runs, keyed by commandId so a command can't be started twice concurrently — see CommandAlreadyRunningError. */
  const runningProcesses = new Map<string, { runId: string; child: GroupProcess }>();

  function onCommandEvent(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(event: CommandEvent): void {
    for (const listener of listeners) listener(event);
  }

  /**
   * The actual "spawn a shell command and track it as a CommandRun" core,
   * shared by `runCommand` (a persisted, user-defined ProjectCommand),
   * `runProjectSync` (the fixed branch-sync command), and `runAdHocCommand`
   * (a one-off typed command) below — all three just want the same
   * running/output/success-or-failure lifecycle in `cwd`, refused if that
   * exact `commandId` is already mid-run. `origin` and `location` are
   * recorded as-is on the CommandRunRecord — see CommandRunOrigin's doc
   * comment for what each caller passes and why.
   */
  async function startRun(
    projectId: string,
    commandId: string,
    commandName: string,
    commandText: string,
    cwd: string,
    origin: CommandRunRecord['origin'],
    location: CommandRunLocation = MAIN_LOCATION,
    automatic = false,
  ): Promise<CommandRunRecord> {
    if (runningProcesses.has(commandId)) throw new CommandAlreadyRunningError(commandName);

    const now = new Date().toISOString();
    const run: CommandRunRecord = {
      id: randomUUID(),
      projectId,
      commandId,
      commandName,
      commandText,
      origin,
      location,
      ...(automatic ? { automatic: true as const } : {}),
      status: 'running',
      exitCode: null,
      output: '',
      startedAt: now,
      completedAt: null,
    };
    await commandRunsDb.insert(run);
    emit({ type: 'commandRun', run });

    const child = spawnInProcessGroup(commandText, { cwd, env: await commandEnv(projectId, origin) });
    runningProcesses.set(commandId, { runId: run.id, child });

    const output = createStreamRedactor((safe) => void appendOutput(run.id, safe));
    const onChunk = (chunk: Buffer) => output.push(chunk.toString('utf-8'));
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (error) => { output.flush(); void settle(commandId, run.id, null, `Failed to start: ${error.message}`); });
    child.on('close', (code) => { output.flush(); void settle(commandId, run.id, code, null); });

    return run;
  }

  /**
   * Runs a saved command in the Project's folder, or in `options.workflowRun`'s working copy. A
   * saved command has at most one running instance wherever it runs: its commandId is the key.
   */
  async function runCommand(commandId: string, options: CommandRunOptions = {}): Promise<CommandRunRecord> {
    const command = await getCommand(commandId);
    const project = await getProject(command.projectId);
    const { cwd, location } = await resolveCommandLocation(project, options);
    return startRun(command.projectId, commandId, command.name, command.command, cwd, 'saved', location, options.automatic);
  }

  /**
   * Runs an arbitrary, never-saved shell command a person typed directly into
   * the "Run custom command" dialog (web/src/ui/ProjectWorkspaceModal.tsx's
   * RunCustomCommandDialog) — the same running/output/success-or-failure
   * lifecycle as any persisted ProjectCommand or `runProjectSync` above, just
   * with no ProjectCommandRecord behind it. Each call gets its own synthetic
   * commandId (unlike `runProjectSync`'s one-per-project constant): unlike a
   * branch sync, there's no single identity here worth deduping against — a
   * person may reasonably run two different one-off commands, or the same
   * one twice, at once.
   */
  async function runAdHocCommand(projectId: string, commandText: string, options: CommandRunOptions = {}): Promise<CommandRunRecord> {
    const project = await getProject(projectId);
    const { cwd, location } = await resolveCommandLocation(project, options);
    return startRun(projectId, `adhoc:${randomUUID()}`, 'Custom command', commandText, cwd, 'adhoc', location);
  }

  /**
   * The branch-sync button's click action
   * (web/src/ui/ProjectWorkspaceModal.tsx's `BranchSyncButton`): runs a
   * `git fetch` + fast-forward-only merge as a real, trackable CommandRun —
   * the same log popup, live output, and success/failure signal as any
   * user-defined Project Command, rather than a bespoke REST call with only
   * a boolean to show for it. Deliberately `--ff-only`: a diverged branch
   * (local commits of its own) fails the command outright rather than
   * silently rewriting or losing anything — the failure shows up in the log
   * exactly like any other failed command would.
   *
   * Not a persisted ProjectCommandRecord — `commandId` is a synthetic,
   * per-Project constant (`syncCommandId`) purely so two syncs on the same
   * Project can't run concurrently (the same `CommandAlreadyRunningError`
   * guard `startRun` already gives every real command). It never shows up
   * in the Commands settings tab's *definitions* list (there's no
   * ProjectCommandRecord backing it) but its runs do land in that same
   * tab's History (`listCommandRuns` below has no reason to filter them
   * out) — a real run is worth keeping a record of either way.
   *
   * Refused (`ProjectFolderBusyError`, 409) only while something really works in the Project's own
   * folder — the same `assertProjectFolderFree` rule a new in-place Task is held to. A planning
   * session, or a Task/WorkflowRun isolated in its own worktree, never blocks a sync.
   */
  async function runProjectSync(projectId: string): Promise<CommandRunRecord> {
    const project = await getProject(projectId);
    await assertProjectFolderFree(project, sessions, 'git');
    if (!project.repositoryUrl) throw new Error('This project has no linked repository');
    const cwd = projectAbsolutePath(project);
    const branch = await currentBranch(cwd);
    const run = await startRun(
      projectId,
      syncCommandId(projectId),
      'Sync branch with origin',
      `${FETCH_ORIGIN_COMMAND} && git merge --ff-only origin/${branch}`,
      cwd,
      'sync',
    );
    // Refresh the poller's cached reading (and broadcast it) the moment this run settles, so the
    // sync icon/rooftop dot reflect reality immediately rather than waiting up to GIT_SYNC_REFRESH_MS
    // for the next scheduled tick.
    const unsubscribe = onCommandEvent((event) => {
      if (event.type === 'commandRun' && event.run.id === run.id && event.run.status !== 'running') {
        unsubscribe();
        void gitSyncPoller.refreshOne(project);
      }
    });
    return run;
  }

  /**
   * The automatic counterpart of `runProjectSync`, run by `projects/autoPull.ts` once it has decided
   * a pull is safe: the same tracked fetch + fast-forward-only command under the same per-Project
   * identity (so it can't overlap a manual sync), recorded as an automatic run. Resolves with the
   * run once it has settled.
   */
  async function runAutoPull(project: ProjectRecord, branch: string): Promise<CommandRunRecord> {
    const started = await startRun(
      project.id,
      syncCommandId(project.id),
      'Sync branch with origin (automatic)',
      `${FETCH_ORIGIN_COMMAND} && git merge --ff-only origin/${branch}`,
      projectAbsolutePath(project),
      'sync',
      MAIN_LOCATION,
      true,
    );
    return awaitSettled(started.id);
  }

  /** Resolves with the run once it is no longer 'running'. */
  function awaitSettled(runId: string): Promise<CommandRunRecord> {
    return new Promise((resolve, reject) => {
      const unsubscribe = onCommandEvent((event) => {
        if (event.type === 'commandRun' && event.run.id === runId && event.run.status !== 'running') {
          unsubscribe();
          resolve(event.run);
        }
      });
      getCommandRun(runId).then((run) => {
        if (run.status !== 'running') { unsubscribe(); resolve(run); }
      }, (error: unknown) => { unsubscribe(); reject(error); });
    });
  }

  async function appendOutput(runId: string, chunk: string): Promise<void> {
    const safe = redactSecrets(chunk);
    await commandRunsDb.updateWith(runId, (record) => ({ output: redactSecrets(record.output + safe) }));
    emit({ type: 'commandRunLog', runId, chunk: safe });
  }

  /** Marks a run 'stopped' and broadcasts it — shared by a real Stop and by settling an orphaned record. */
  async function markStopped(run: CommandRunRecord): Promise<CommandRunRecord> {
    const stopped = await commandRunsDb.update(run.id, { status: 'stopped', completedAt: new Date().toISOString() });
    if (stopped) emit({ type: 'commandRun', run: stopped });
    return stopped ?? run;
  }

  /**
   * Kills an in-flight run's process. Its own 'close' handler still fires and settles it, but as 'stopped' rather than 'success'/'failed' — see the status precedence in `settle`.
   * A record still saying 'running' with no live process behind it (the daemon restarted since, so
   * `runningProcesses` forgot it) is an orphan: nothing will ever settle it, so Stop settles it here.
   */
  async function stopCommandRun(runId: string): Promise<CommandRunRecord> {
    const run = await getCommandRun(runId);
    const entry = [...runningProcesses.entries()].find(([, v]) => v.runId === runId);
    if (!entry) return run.status === 'running' ? markStopped(run) : run;
    const [commandId, { child }] = entry;
    const stopped = await markStopped(run);
    child.kill();
    runningProcesses.delete(commandId);
    return stopped;
  }

  /** Stops every in-flight run of a Project, as the Project is deleted. */
  async function stopProjectRuns(projectId: string): Promise<void> {
    for (const run of await commandRunsDb.find((r) => r.projectId === projectId && r.status === 'running')) await stopCommandRun(run.id);
  }

  /**
   * Signals every in-flight run's process group. Each runs in its own group, so a Ctrl-C to the
   * daemon never reaches it; index.ts calls this on the way out so no dev server outlives the daemon.
   */
  function killActiveProcesses(): void {
    for (const { child } of runningProcesses.values()) child.kill();
  }

  /**
   * Settles every run still recorded as 'running' as 'stopped'. Call once at daemon start, when no
   * process can possibly be live yet: the subprocesses belonged to the previous daemon, so a leftover
   * 'running' record would otherwise show as running forever.
   */
  async function reconcileOrphanedRuns(): Promise<void> {
    const orphans = await commandRunsDb.find((r) => r.status === 'running' && !runningProcesses.has(r.commandId));
    for (const run of orphans) await markStopped(run);
  }

  /**
   * Settles a run once its process closes. A run already marked 'stopped'
   * (by `stopCommandRun`, which fires before this close handler runs) keeps
   * that status rather than being overwritten by whatever exit code the
   * killed process happened to report — checked via the guard below.
   */
  async function settle(commandId: string, runId: string, exitCode: number | null, spawnError: string | null): Promise<void> {
    runningProcesses.delete(commandId);
    const current = await commandRunsDb.get(runId);
    if (!current || current.status !== 'running') return;
    const status: CommandRunRecord['status'] = spawnError || exitCode !== 0 ? 'failed' : 'success';
    const subject: NotificationSubject = { type: 'command', projectId: current.projectId, commandId, runId };
    // Raised before the DB write below flips this run out of 'running' — a caller polling
    // getCommandRun for that transition (the observable "this run has settled" signal) must never
    // observe it before the Notification it implies already exists.
    if (status === 'failed') {
      // A sync run's failure (an ff-only merge rejected, a fetch that can't reach origin, etc.) is
      // already covered by gitSyncPoller's own `git.out_of_sync` Notification for this same
      // underlying git state — raising a second `command.failed` here would just be a duplicate
      // "something's wrong with this branch" alert for the same condition.
      if (current.origin !== 'sync') {
        await raiseNotification({
          kind: 'command.failed',
          subject,
          title: `Command "${current.commandName}" failed`,
          description: spawnError ?? `Exited with code ${exitCode}`,
        });
      }
    } else {
      await resolveNotifications(subject, ['command.failed']);
      // A long success nobody is watching (no open log popup) is worth a heads-up; sync runs never notify.
      if (current.origin !== 'sync' && ranLongEnough(current.startedAt, Date.now()) && !isRunWatched('command', runId)) {
        await raiseNotification({
          kind: 'command.completed',
          subject,
          title: `Command "${current.commandName}" completed`,
          description: 'Exited successfully',
        });
      }
    }
    const updated = await commandRunsDb.update(runId, {
      status,
      exitCode,
      completedAt: new Date().toISOString(),
      ...(spawnError ? { output: current.output + spawnError } : {}),
      ...(status === 'failed' && current.origin !== 'sync' ? { failureUnopened: true as const } : {}),
    });
    if (updated) emit({ type: 'commandRun', run: updated });
  }

  /**
   * `status`, when given, narrows this to just runs in that state — used by the workspace header
   * and Settings → Commands → Manage to discover a project's currently-*running* commands (e.g. a
   * long-lived `npm run dev`) without pulling every run's full accumulated output over the wire just
   * to find the handful still going. Plain History (no filter) is unaffected.
   */
  function listCommandRuns(projectId: string, status?: CommandRunRecord['status'], filter: { failureUnopened?: boolean } = {}): Promise<CommandRunRecord[]> {
    return commandRunsDb.find((r) => r.projectId === projectId && (!status || r.status === status) && (!filter.failureUnopened || r.failureUnopened === true)).then((runs) =>
      runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    );
  }

  async function getCommandRun(id: string): Promise<CommandRunRecord> {
    const run = await commandRunsDb.get(id);
    if (!run) throw new CommandRunNotFoundError();
    return run;
  }

  /**
   * Records that someone opened a failed run's log, so the 3D village drops its red machine everywhere.
   * A no-op (no write, no event) for a run that has no unopened failure: one still running, one that
   * succeeded, or one already opened. 404s for an unknown run or one whose Project was deleted.
   */
  async function markCommandRunOpened(runId: string): Promise<CommandRunRecord> {
    const run = await getCommandRun(runId);
    await getProject(run.projectId);
    if (!run.failureUnopened) return run;
    const updated = await commandRunsDb.update(runId, { failureUnopened: undefined });
    if (!updated) return run;
    emit({ type: 'commandRun', run: updated });
    return updated;
  }

  return { runCommand, runAdHocCommand, runProjectSync, runAutoPull, stopCommandRun, stopProjectRuns, killActiveProcesses, reconcileOrphanedRuns, listCommandRuns, getCommandRun, markCommandRunOpened, onCommandEvent };
}

export type CommandRunner = ReturnType<typeof createCommandRunner>;

/** The one instance the daemon actually runs against — see server.ts / api/router.ts / api/ws.ts. */
export const commandRunner = createCommandRunner();
