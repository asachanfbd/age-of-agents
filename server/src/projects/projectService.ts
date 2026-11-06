import { withProjectGithub } from '../github/accounts.ts';
import { DEFAULT_GIT_PROVIDER } from './gitProvider.ts';
import type { GitProviderId } from './gitProvider.ts';
import { GitError, currentBranch, fetchOrigin, git, localBranchExists, validateRepository, withProjectLock } from './git.ts';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECTS_DIR } from '../config.ts';
import { ensureProjectCliHooks } from '../terminal/projectCliHooks.ts';
import { stepOutputFiles } from '../worker/stepOutputFiles.ts';
import { agentSessionCountersDb, agentSessionsDb, commandRunsDb, notificationsDb, planItemQueueDb, planItemsDb, projectCommandsDb, projectsDb, stepRunsDb, taskContextsDb, tasksDb, workflowRunsDb } from '../db/collections.ts';
import { migrateLegacyPlot, resolveProjectPlot, samePlot } from './townPlots.ts';
import { DOCS_DIR } from './blueprint.ts';
import { DOCS_BOOTSTRAP_DESCRIPTION, DOCS_BOOTSTRAP_TITLE, DOCS_BOOTSTRAP_WORKFLOW } from './plan.ts';
import { assertProjectFolderFree, defaultSessionRegistry, type SessionRegistry } from '../worker/projectFolderGuard.ts';
import type { ProjectRecord, ProjectStatus, TaskRecord, WorkflowRecord } from '../domain/types.ts';
import { deleteBuildingData } from '../buildings/buildingStorage.ts';
import { SecretsStore } from '../buildings/secrets.ts';
import { withOwnership } from '../buildings/ownership.ts';
import { getBuildingType } from '../buildings/registry.ts';
import '../buildings/types/index.ts';

export class ProjectNotFoundError extends Error {
  constructor() {
    super('This project no longer exists — it may have been removed');
    this.name = 'ProjectNotFoundError';
  }
}

export class InvalidPlotError extends Error {
  constructor() {
    super('position must be [x, z] of one of the 240 project plots');
    this.name = 'InvalidPlotError';
  }
}

export class PlotTakenError extends Error {
  constructor() {
    super('That plot is already taken by another project');
    this.name = 'PlotTakenError';
  }
}

export class UnknownBuildingTypeError extends Error {
  constructor(typeId: string) {
    super(`Unknown Building type "${typeId}"`);
    this.name = 'UnknownBuildingTypeError';
  }
}

export class ProjectHasActiveTaskError extends Error {
  constructor(project: Pick<ProjectRecord, 'name'>) {
    super(`Project "${project.name}" already has an active task — only one active Task per Project is supported`);
    this.name = 'ProjectHasActiveTaskError';
  }
}

export const PROJECT_NAME_MAX = 80;

/** A name the Project popup's Settings (and Content Studio's) can save: 1 to 80 characters once trimmed. `field` lets the API point at the input. */
export class InvalidProjectNameError extends Error {
  readonly field = 'name';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProjectNameError';
  }
}

/** Characters, not UTF-16 units, so 80 emoji count as 80 (the web input counts the same way). */
export function parseProjectName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new InvalidProjectNameError('Name must be 1 to 80 characters.');
  if ([...name].length > PROJECT_NAME_MAX) throw new InvalidProjectNameError('Name must be 1 to 80 characters.');
  return name;
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'project';
}

/** Appends -2, -3, ... until the slug doesn't collide with an existing project's folder. */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set((await projectsDb.all()).map((p) => p.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function projectAbsolutePath(project: Pick<ProjectRecord, 'slug'>): string {
  return path.join(PROJECTS_DIR, project.slug);
}

/**
 * Where a concurrent Task's isolated git worktree lives: a sibling of every
 * Project's own folder, under one shared hidden directory — NOT inside
 * `projects/<slug>` itself, so it is never picked up by that Project's own
 * `git status` or file-tree scan (see `fileTree.ts`). Namespaced by slug so
 * `deleteProject` can sweep up any worktree left behind by a cleanup that
 * failed at settle time (see `removeWorktree` in `git.ts`).
 */
export function projectWorktreesRoot(project: Pick<ProjectRecord, 'slug'>): string {
  return path.join(PROJECTS_DIR, '.worktrees', project.slug);
}

/** One concurrent Task's own worktree directory, keyed by its Task id so several active Tasks on the same Project never collide. */
export function projectWorktreePath(project: Pick<ProjectRecord, 'slug'>, taskId: string): string {
  return path.join(projectWorktreesRoot(project), taskId);
}

/**
 * The directory a Task's turn actually runs in: its own isolated worktree if
 * it was assigned one, otherwise the Project's own primary working directory
 * — the common single-Task case, unchanged from pre-worktree v1 behavior.
 * See `TaskRecord.worktreePath` and `workerManager.ts`'s `assignTaskWorkspace`.
 */
export function taskWorkingDirectory(project: Pick<ProjectRecord, 'slug'>, task: Pick<TaskRecord, 'worktreePath'>): string {
  return task.worktreePath ?? projectAbsolutePath(project);
}

/**
 * Creates a real folder under projects/ (see docs/architecture.md's amended
 * "Manual project registration only" section) with its .docs/ scaffold, plus
 * the registry record. This is the one place a Project comes into existence.
 *
 * Writes no documentation scaffold: the working folder (cloned from the
 * repository when one is given), an empty `.docs`, and the CLI hooks written by
 * `ensureProjectCliHooks`. Real documentation comes from the setup task
 * (`startDocsBootstrapTask`), which is created as an ordinary board item.
 */
export async function createProject(input: { name: string; position: [number, number] | null; repositoryUrl?: string; typeId?: string }): Promise<ProjectRecord> {
  return withProjectLock('project-creation', async () => {
    const type = getBuildingType(input.typeId ?? 'software');
    if (!type) throw new UnknownBuildingTypeError(input.typeId ?? '');
    const repositoryUrl = type.repository && input.repositoryUrl ? validateRepository(input.repositoryUrl) : undefined;
    const slug = await uniqueSlug(input.name);
    const absolutePath = path.join(PROJECTS_DIR, slug);

    await mkdir(PROJECTS_DIR, { recursive: true });
    await mkdir(absolutePath); // Reserve the destination; never overwrite an existing folder.
    try {
      if (repositoryUrl) await git(PROJECTS_DIR, ['clone', '--', repositoryUrl, absolutePath]);
      // The documents API, blueprint and plan writers all assume `.docs` exists; the folders under it are made on demand.
      if (type.repository) await mkdir(path.join(absolutePath, DOCS_DIR), { recursive: true });
      await ensureProjectCliHooks(absolutePath);

      const now = new Date().toISOString();
      const record = withOwnership<ProjectRecord>({
        id: randomUUID(),
        typeId: type.id,
        typeVersion: type.version,
        name: input.name,
        repositoryUrl,
        slug,
        relativePath: path.join('projects', slug),
        status: 'idle',
        position: input.position,
        activeTaskId: null,
        activeTaskIds: [],
        taskCount: 0,
        gitProvider: DEFAULT_GIT_PROVIDER,
        createdAt: now,
        updatedAt: now,
      });
      return await projectsDb.insert(record);
    } catch (error) {
      await rm(absolutePath, { recursive: true, force: true });
      throw error;
    }
  });
}

export function listProjects(): Promise<ProjectRecord[]> {
  return projectsDb.all();
}

/**
 * Moves Projects saved on the earlier 32-plot block grid onto the same-numbered street plots, once:
 * a second call finds nothing left to move. A target plot that another Project already holds is
 * skipped; the web app's position repair places that Project on the next load.
 */
export async function migrateLegacyPositions(): Promise<number> {
  const records = await projectsDb.all();
  const taken = records.filter((record) => record.position && resolveProjectPlot(record.position)).map((record) => record.position!);
  const patches: { id: string; patch: { position: [number, number] } }[] = [];
  for (const record of records) {
    const target = migrateLegacyPlot(record.position);
    if (!target || taken.some((other) => samePlot(other, target))) continue;
    taken.push(target);
    patches.push({ id: record.id, patch: { position: target } });
  }
  if (patches.length > 0) await projectsDb.updateMany(patches);
  return patches.length;
}

/** Migrates every registered Project to the same local interactive-CLI hook configuration used for new Projects. */
export async function ensureAllProjectCliHooks(): Promise<void> {
  for (const project of await projectsDb.all()) {
    try {
      await ensureProjectCliHooks(projectAbsolutePath(project));
    } catch (error) {
      console.error(`Failed to install local CLI hooks for ${project.name}: ${(error as Error).message}`);
    }
  }
}

export async function getProject(id: string): Promise<ProjectRecord> {
  const project = await projectsDb.get(id);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

/** Moves a Project to exactly one free project plot: InvalidPlotError (400) for a non-plot, PlotTakenError (409) when another Project holds it. */
export async function updateProjectPosition(id: string, position: unknown): Promise<ProjectRecord> {
  // A client still showing the earlier block grid may send one of its coordinates.
  const plot = resolveProjectPlot(position) ?? migrateLegacyPlot(position);
  if (!plot) throw new InvalidPlotError();
  const updated = await projectsDb.updateWith(id, (_project, records) => {
    if (records.some((other) => other.id !== id && other.position && samePlot(other.position, plot))) throw new PlotTakenError();
    return { position: plot, updatedAt: new Date().toISOString() };
  });
  if (!updated) throw new ProjectNotFoundError();
  return updated;
}

export async function setProjectStatus(id: string, status: ProjectStatus): Promise<ProjectRecord> {
  return patchProject(id, { status });
}

/** `PATCH /api/projects/:id/workflow` — null resets the Project back to the Catalog's default Workflow. Validated by the router against the Workflow catalog before this is called. */
export async function setProjectGitProvider(id: string, gitProvider: GitProviderId): Promise<ProjectRecord> {
  return patchProject(id, { gitProvider });
}

/** `PATCH /api/projects/:id/github-account` — null selects the machine default. The caller validates the login. */
export async function setProjectGithubAccount(id: string, githubAccount: string | null): Promise<ProjectRecord> {
  return patchProject(id, { githubAccount });
}

/** `PATCH /api/projects/:id/auto-pull` — see ProjectRecord.autoPullEnabled. */
export async function setProjectAutoPull(id: string, autoPullEnabled: boolean): Promise<ProjectRecord> {
  return patchProject(id, { autoPullEnabled });
}

export async function setProjectWorkflowId(id: string, workflowId: string | null): Promise<ProjectRecord> {
  return patchProject(id, { workflowId });
}

/** General-purpose patch for the runtime fields workerManager needs to flip together (status, activeTaskId, taskCount). */
export async function patchProject(id: string, patch: Partial<Omit<ProjectRecord, 'id'>>): Promise<ProjectRecord> {
  const updated = await projectsDb.update(id, { ...patch, updatedAt: new Date().toISOString() });
  if (!updated) throw new ProjectNotFoundError();
  return updated;
}

/**
 * Changes only the display name: the slug, folder and repository keep their names. Runs under the
 * Project lock so a rename racing a delete either lands first or finds the Project gone (404).
 * Both the Project popup and Content Studio's settings come through here.
 */
export function renameProject(id: string, name: unknown): Promise<ProjectRecord> {
  const parsed = parseProjectName(name);
  return withProjectLock(id, () => patchProject(id, { name: parsed }));
}

/**
 * Like `patchProject`, but the patch is a function of the Project's own live
 * state rather than a value read earlier — race-safe when several concurrent
 * Tasks on the *same* Project each need to adjust shared fields (its
 * active-task set, aggregate `status`) around the same time. See
 * `FileDatabase.updateWith` and `workerManager.ts`'s active-task helpers,
 * the only current callers.
 */
export async function patchProjectWith(
  id: string,
  fn: (project: ProjectRecord) => Partial<Omit<ProjectRecord, 'id'>> | Promise<Partial<Omit<ProjectRecord, 'id'>>>,
): Promise<ProjectRecord> {
  const updated = await projectsDb.updateWith(id, async (project) => ({ ...(await fn(project)), updatedAt: new Date().toISOString() }));
  if (!updated) throw new ProjectNotFoundError();
  return updated;
}

/**
 * `beforeRemove` runs once deletion is allowed and before anything is removed — how the API layer
 * stops and discards the Project's Test Runs (testing/testRunner.ts's `discardProjectRuns`) without
 * this module depending on the runner, which itself depends on this module.
 */
export async function deleteProject(id: string, options: { beforeRemove?: () => Promise<void> } = {}): Promise<void> {
  return withProjectLock(id, async () => {
    const project = await getProject(id);
    if (project.activeTaskId) throw new ProjectHasActiveTaskError(project);
    await options.beforeRemove?.();
    await rm(projectAbsolutePath(project), { recursive: true, force: true });
    // Sweeps up any worktree directory a best-effort cleanup at settle time (see
    // workerManager.ts's cleanupWorktree) failed to remove — nothing should be actively using one
    // here since deletion is refused above while any Task is still active.
    await rm(projectWorktreesRoot(project), { recursive: true, force: true });
    // The saved step outputs of every run (they live in the daemon's data directory, not the project folder).
    await stepOutputFiles.removeProject(id)
      .catch((error) => console.error(`Couldn't delete the saved step outputs of project ${id}:`, error));
    await new SecretsStore(id).deleteAll().catch((error) => console.error(`Couldn't delete the secrets of project ${id}:`, error));
    await deleteBuildingData(id);
    await deleteProjectRecords(id);
    await projectsDb.delete(id);
  });
}

/** The Project's Tasks, plan items, runs, saved commands and their runs, notifications and Agent sessions; a deleted Project leaves none of them behind. */
async function deleteProjectRecords(id: string): Promise<void> {
  const tasks = await tasksDb.find((task) => task.projectId === id);
  for (const task of tasks) await taskContextsDb.delete(task.id);
  const remove = async <T extends { id: string }>(db: { find(p: (r: T) => boolean): Promise<T[]>; delete(id: string): Promise<boolean> }, belongs: (r: T) => boolean) => {
    for (const record of await db.find(belongs)) await db.delete(record.id);
  };
  await remove(tasksDb, (task) => task.projectId === id);
  await remove(planItemsDb, (item) => item.projectId === id);
  await remove(planItemQueueDb, (entry) => entry.projectId === id);
  const runIds = new Set((await workflowRunsDb.find((run) => run.projectId === id)).map((run) => run.id));
  await remove(stepRunsDb, (stepRun) => runIds.has(stepRun.runId));
  await remove(workflowRunsDb, (run) => runIds.has(run.id));
  await remove(notificationsDb, (n) => n.projectId === id);
  await remove(projectCommandsDb, (command) => command.projectId === id);
  await remove(commandRunsDb, (run) => run.projectId === id);
  await remove(agentSessionsDb, (session) => session.projectId === id);
  await agentSessionCountersDb.delete(id);
}

/**
 * Fetches from `origin` first, so the branch list a "switch branch" popup
 * shows is never stale local refs from whenever this Project was last
 * fetched — see docs/architecture.md's "Fetch before listing branches"
 * decision. A fetch failure (no network, remote gone) surfaces as an
 * ordinary `GitError` (409, same as any other git operation in this router)
 * rather than silently falling back to a possibly-stale local list.
 */
export async function projectBranches(id: string) {
  const project = await getProject(id);
  if (!project.repositoryUrl) throw new Error('This project has no linked repository');
  const cwd = projectAbsolutePath(project);
  await withProjectGithub(project, 'fetch the repository', () => fetchOrigin(cwd));
  const current = await currentBranch(cwd);
  const refs = await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
  const branches = [...new Set(refs.split('\n').filter(Boolean).filter(b => b !== 'refs/remotes/origin/HEAD').map(b => b.replace(/^refs\/(heads\/|remotes\/origin\/)/, '')))];
  return { current, branches };
}

/**
 * Creating a branch is always allowed, even over uncommitted changes or while something is working in
 * the Project's own directory: `git switch -c` carries the working tree over untouched, which is
 * exactly how someone who forgot to branch before starting work on main/develop moves that work
 * onto a branch of its own. `onBranchCreated` runs inside the same project lock, so whatever still
 * expects the previous branch (see workerManager.ts's `retargetPrimaryTasks`) is moved over before
 * anything else can commit. Switching to an existing branch still needs a clean tree and the
 * Project's own folder free (`assertProjectFolderFree` — the same rule a new in-place Task is held
 * to), since that would swap files out from under work really happening there. A planning session,
 * or a Task/WorkflowRun isolated in its own worktree, never blocks this — see that function's doc
 * comment. `sessions` is overridable only for tests that need to see the same session host a test's
 * own worker manager was built with; every real caller uses the default (real) terminal-session host.
 */
export async function checkoutProjectBranch(
  id: string,
  branch: string,
  create = false,
  onBranchCreated?: (from: string, to: string) => Promise<void>,
  sessions: SessionRegistry = defaultSessionRegistry(),
) {
  if (!create) {
    await switchProjectBranch(id, branch, sessions);
    return projectBranches(id);
  }
  return withProjectLock(id, async () => {
    const cwd = await repositoryDirectory(id);
    await git(cwd, ['check-ref-format', '--branch', branch]);
    const previous = await currentBranch(cwd);
    await git(cwd, ['switch', '-c', branch]);
    await onBranchCreated?.(previous, branch);
    await forgetPullRequestCheckout(id);
    return projectBranches(id);
  });
}

async function repositoryDirectory(id: string): Promise<string> {
  const project = await getProject(id);
  if (!project.repositoryUrl) throw new Error('This project has no linked repository');
  return projectAbsolutePath(project);
}

/** The branch switcher's clean-tree rule: tracked changes refuse a switch, untracked files don't. */
export async function assertCleanForSwitch(cwd: string): Promise<void> {
  if (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new GitError('Commit or discard local changes before switching branches, or create a new branch to carry them over.');
  }
}

/**
 * Switches the Project's own folder to an existing branch, local or only on the remote, under the
 * rules in `checkoutProjectBranch`'s doc comment. The folder is then no longer on a pull request's
 * checked-out branch, so that record is dropped.
 */
export async function switchProjectBranch(id: string, branch: string, sessions: SessionRegistry = defaultSessionRegistry()): Promise<void> {
  await withProjectLock(id, async () => {
    const cwd = await repositoryDirectory(id);
    await git(cwd, ['check-ref-format', '--branch', branch]);
    await assertProjectFolderFree(await getProject(id), sessions, 'git');
    await assertCleanForSwitch(cwd);
    if (await localBranchExists(cwd, branch)) {
      await git(cwd, ['switch', branch]);
    } else {
      // No local ref for this branch yet — it exists only on the remote (a branch someone else
      // pushed, just surfaced by projectBranches' fetch). `git switch <name>` DWIMs a tracking
      // branch for a uniquely-matching remote branch on modern git by default, but that behavior
      // depends on the `checkout.guess` config and git version — check it out explicitly instead
      // of relying on it, so this always works regardless of the caller's git config.
      await git(cwd, ['switch', '-c', branch, '--track', `origin/${branch}`]);
    }
    await forgetPullRequestCheckout(id);
  });
}

async function forgetPullRequestCheckout(id: string): Promise<void> {
  if ((await getProject(id)).prCheckout) await patchProject(id, { prCheckout: null });
}


/**
 * Creates the 'Set up project documentation' PlanItem for a new Project and
 * starts it like a user-started task: `enqueuePlanItemExecution` runs it when a
 * slot is free and queues it behind the task limit otherwise. It always runs the
 * fixed one-step `DOCS_BOOTSTRAP_WORKFLOW` (documentation agent plus the
 * `maintain-project-context` skill), not the Project's own workflow, which
 * would put a documentation job through planning, development and review. The item exists on the Tasks board as soon as it is
 * created, so if the start fails it stays there not-started and the owner can
 * retry it from the board. The description frames a bootstrap (blank) or
 * migrate (existing repository) run for the `maintain-project-context` skill.
 *
 * Takes its services as parameters rather than importing workerManager to avoid
 * a cycle (workerManager already imports this module); `api/router.ts` wires in
 * the real ones.
 */
export async function startDocsBootstrapTask(
  project: Pick<ProjectRecord, 'id'>,
  deps: {
    createPlanItem: (input: { projectId: string; title: string; description: string }) => Promise<{ id: string }>;
    enqueuePlanItemExecution: (planItemId: string, options: { workflow: WorkflowRecord }) => Promise<unknown>;
  },
): Promise<{ id: string }> {
  const item = await deps.createPlanItem({ projectId: project.id, title: DOCS_BOOTSTRAP_TITLE, description: DOCS_BOOTSTRAP_DESCRIPTION });
  await deps.enqueuePlanItemExecution(item.id, { workflow: DOCS_BOOTSTRAP_WORKFLOW });
  return item;
}
