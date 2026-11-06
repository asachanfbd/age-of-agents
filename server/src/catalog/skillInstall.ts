import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CATALOG_SKILLS_DIR } from '../config.ts';
import { syncCatalogIndex } from './catalogIndex.ts';
import { assertValidId } from './paths.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';

/**
 * Runs `npx skills add <owner/repo>` as a real subprocess to pull a
 * community skill into the Catalog's `catalog/skills/`. Structurally
 * parallel to `commands/commandRunner.ts` (its own small event bus: running
 * → settled, streamed stdout/stderr, a run id the API layer can poll or
 * broadcast over the same `/ws` channel — see api/ws.ts), but kept as its
 * own module rather than folded into CommandRunner: an install isn't scoped
 * to a Project and has no ProjectCommandRecord behind it, so it doesn't
 * belong in commandRunsDb/FileDatabase. Runs are kept in memory only, for
 * this daemon process's lifetime — losing track of one across a restart is
 * fine, since re-running `npx skills add` is idempotent.
 *
 * `npx skills add` is a real third-party CLI (`skills` on npm) with no
 * `--dir`/output-path flag (confirmed via `npx skills --help`) — it always
 * writes into whatever `.claude/skills/` it finds relative to its own `cwd`.
 * Since this feature must never write into this repo's real `.claude/`, the
 * subprocess is instead run with `cwd` set to a fresh temp directory it owns
 * exclusively, so it writes into `<tmpdir>/.claude/skills/<id>/` — a
 * harmless scratch location — and the resulting skill folder(s) are then
 * copied from there into the real `catalog/skills/` target once the process
 * exits successfully. `-y`/`--copy`/`--agent claude-code` are passed
 * explicitly: `-y` skips an interactive confirmation prompt that would
 * otherwise hang forever (stdin is piped, not a real TTY), `--copy` forces
 * real files instead of symlinks (a symlink into the temp dir would dangle
 * the moment that directory is cleaned up), and `--agent claude-code`
 * guarantees the `.claude/skills/` layout this install step expects, rather
 * than leaving agent selection to auto-detection of an empty temp directory.
 *
 * `spawnFn` is injectable the same way `worker/claudeProcess.ts`'s
 * `runClaudeTurn` takes a `spawnFn` — so tests can drive this with a fake
 * child process instead of ever shelling out to `npx` or touching the
 * network.
 */

export type SkillInstallStatus = 'running' | 'success' | 'failed';

export interface SkillInstallRun {
  id: string;
  repo: string;
  status: SkillInstallStatus;
  output: string;
  startedAt: string;
  completedAt: string | null;
}

export type SkillInstallEvent =
  | { type: 'skillInstall'; run: SkillInstallRun }
  | { type: 'skillInstallLog'; runId: string; chunk: string };

export type SkillInstallSpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

const defaultSpawnFn: SkillInstallSpawnFn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * A plain "owner/repo" GitHub slug — deliberately strict since this string
 * becomes an argv element passed to `npx skills add <repo>`. `spawn` is
 * always called with an argv array, never `shell: true`, so there is no
 * shell-injection surface even before this check; the pattern exists to
 * reject nonsense input early with a clear error rather than handing it to
 * `npx` and surfacing whatever cryptic failure that produces.
 */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export class InvalidRepoSlugError extends Error {
  constructor(repo: string) {
    super(`"${repo}" is not a valid "owner/repo" GitHub slug`);
    this.name = 'InvalidRepoSlugError';
  }
}

export class SkillInstallNotFoundError extends Error {
  constructor() {
    super('This skill install no longer exists');
    this.name = 'SkillInstallNotFoundError';
  }
}

export function createSkillInstallRunner(spawnFn: SkillInstallSpawnFn = defaultSpawnFn) {
  const runs = new Map<string, SkillInstallRun>();
  const listeners = new Set<(event: SkillInstallEvent) => void>();

  function onEvent(listener: (event: SkillInstallEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(event: SkillInstallEvent): void {
    for (const listener of listeners) listener(event);
  }

  function install(repo: string): SkillInstallRun {
    if (!REPO_SLUG_PATTERN.test(repo)) throw new InvalidRepoSlugError(repo);

    const run: SkillInstallRun = {
      id: randomUUID(),
      repo,
      status: 'running',
      output: '',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    runs.set(run.id, run);
    emit({ type: 'skillInstall', run });

    let workDir: string;
    try {
      workDir = mkdtempSync(path.join(tmpdir(), 'agent-visual-os-skill-install-'));
    } catch (error) {
      void settle(run, null, `Failed to create a temp install dir: ${(error as Error).message}`, null);
      return run;
    }

    let child: ChildProcess;
    try {
      child = spawnFn('npx', ['skills', 'add', repo, '-y', '--copy', '--agent', 'claude-code'], { cwd: workDir, env: process.env });
    } catch (error) {
      void settle(run, null, `Failed to start: ${(error as Error).message}`, workDir);
      return run;
    }

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      run.output += text;
      emit({ type: 'skillInstallLog', runId: run.id, chunk: text });
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (error) => void settle(run, null, `Failed to start: ${error.message}`, workDir));
    child.on('close', (code) => void settle(run, code, null, workDir));

    return run;
  }

  /**
   * Copies every skill folder `npx skills add` wrote into the temp dir's
   * `.claude/skills/` over into the real Catalog's `catalog/skills/`. Each
   * folder name is sanity-checked against the same id shape `paths.ts` uses
   * for every other Catalog write before it's treated as usable — the source
   * is a real filesystem tree this process itself just created (not
   * attacker-controlled archive data like `skillZip.ts`'s upload path), so a
   * straightforward recursive copy is enough; there's no zip-slip-style
   * escape to guard against here.
   */
  async function copyInstalledSkills(workDir: string): Promise<void> {
    const installedSkillsDir = path.join(workDir, '.claude', 'skills');
    let entries;
    try {
      entries = await readdir(installedSkillsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // Nothing installed — e.g. a repo with no skills.
      throw error;
    }

    await mkdir(CATALOG_SKILLS_DIR, { recursive: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      assertValidId('skill', entry.name);
      await cp(path.join(installedSkillsDir, entry.name), path.join(CATALOG_SKILLS_DIR, entry.name), { recursive: true });
    }
  }

  async function settle(run: SkillInstallRun, exitCode: number | null, spawnError: string | null, workDir: string | null): Promise<void> {
    if (run.status !== 'running') return; // Already settled (e.g. both 'error' and 'close' fired).
    run.status = !spawnError && exitCode === 0 ? 'success' : 'failed';
    run.completedAt = new Date().toISOString();
    if (spawnError) run.output += spawnError;

    if (run.status === 'success' && workDir) {
      try {
        await copyInstalledSkills(workDir);
        // Re-run auto-discovery so the newly-installed skill appears in the Catalog right away.
        await syncCatalogIndex();
      } catch (error) {
        run.output += `\n(Copying the installed skill into the Catalog failed: ${(error as Error).message})`;
      }
    }

    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {}); // Best-effort — a leftover temp dir is harmless.
    }

    // Raised before the terminal `skillInstall` event below — a caller waiting on that event (the
    // observable "this run has settled" signal) must never observe it before the Notification it
    // implies already exists.
    if (run.status === 'failed') {
      await raiseNotification({
        kind: 'skill.install_failed',
        subject: { type: 'skill', repo: run.repo },
        title: `Skill install "${run.repo}" failed`,
        description: run.output || 'The install exited with an error but produced no output.',
      });
    } else {
      await resolveNotifications({ type: 'skill', repo: run.repo }, ['skill.install_failed']);
    }

    emit({ type: 'skillInstall', run });
  }

  function getRun(id: string): SkillInstallRun {
    const run = runs.get(id);
    if (!run) throw new SkillInstallNotFoundError();
    return run;
  }

  return { install, getRun, onEvent };
}

export type SkillInstallRunner = ReturnType<typeof createSkillInstallRunner>;

/** The one instance the daemon actually runs against — see api/router.ts / api/ws.ts. */
export const skillInstallRunner = createSkillInstallRunner();
