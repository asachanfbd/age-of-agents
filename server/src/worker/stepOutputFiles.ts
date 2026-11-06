import { randomUUID } from 'node:crypto';
import { link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../redaction.ts';
import { DATA_DIR } from '../config.ts';

/**
 * Where a WorkflowRun's step outputs (UI mockups, test case lists, reports) are saved as files, so a
 * later step's prompt can reference each one by absolute path instead of pasting it in full:
 * `<root>/<projectId>/<runId>/<stepId>/round-<n>/<output slug>.<html|md>`. The root lives in the
 * daemon's data directory, never in a project's repository or a task's worktree, so the files are
 * never committed, never in a branch diff, and survive worktree removal. The run view keeps reading
 * outputs from the StepRun records; these files only feed prompts.
 */
export interface StepOutputFile {
  name: string;
  format: 'markdown' | 'html';
  content: string;
}

export interface StepOutputRound {
  projectId: string;
  runId: string;
  stepId: string;
  round: number;
  outputs: StepOutputFile[];
}

export interface StepOutputFiles {
  /** The run's folder — what a step session is granted read access to. */
  runDir(projectId: string, runId: string): string;
  /**
   * Each output's absolute file path, in order, writing any file not already there (a file is written
   * once and reused). `null` for an output whose file couldn't be written — the caller pastes that
   * one inline instead. Never throws; a failure is logged.
   */
  ensureRound(round: StepOutputRound): Promise<(string | null)[]>;
  /** Deletes the run's folder; a no-op when it doesn't exist. */
  removeRun(projectId: string, runId: string): Promise<void>;
  /** Deletes every run folder of the Project; a no-op when it doesn't exist. */
  removeProject(projectId: string): Promise<void>;
}

/** Ids are daemon-generated UUIDs or workflow step ids; anything else is refused so an id can never name a path outside the root. */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SLUG_LENGTH = 80;
const EXTENSIONS: Record<StepOutputFile['format'], string> = { html: '.html', markdown: '.md' };
/** Sessions only read these files; a read-only mode is defence in depth for a session that bypasses its CLI's permission rules. Deleting still works, since that depends on the folder's mode. */
const FILE_MODE = 0o444;

function safeId(id: string, label: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid ${label} for a step output path`);
  return id;
}

/** A file-name-safe form of an output's name: ASCII lowercase words joined by dashes, or '' when nothing usable is left. */
export function outputSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

/** One file name per output, in order: its slug (or `output-<n>` when it has none), de-duplicated with `-2`, `-3`… */
export function outputFileNames(outputs: Pick<StepOutputFile, 'name' | 'format'>[]): string[] {
  const used = new Set<string>();
  return outputs.map((output, index) => {
    const base = outputSlug(output.name) || `output-${index + 1}`;
    let stem = base;
    for (let n = 2; used.has(stem); n++) stem = `${base}-${n}`;
    used.add(stem);
    return `${stem}${EXTENSIONS[output.format]}`;
  });
}

/**
 * Writes `file` unless it already exists. The content goes to a temp file first and is linked into
 * place only once complete, so a failed write (a full disk) never leaves a partial file that a later
 * prompt would reuse as the output.
 */
async function writeOnce(file: string, content: string, write: typeof writeFile): Promise<void> {
  if (await stat(file).then((s) => s.isFile(), () => false)) return;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await write(temp, redactSecrets(content), { encoding: 'utf-8', flag: 'wx', mode: FILE_MODE });
    await link(temp, file).catch(async (error: NodeJS.ErrnoException) => {
      // Another prompt build linked the same complete output first.
      if (error.code !== 'EEXIST' || !(await stat(file)).isFile()) throw error;
    });
  } finally {
    await rm(temp, { force: true });
  }
}

/** `io.writeFile` is injectable so a test can simulate a write failing partway. */
export function createStepOutputFiles(root: string, io: { writeFile: typeof writeFile } = { writeFile }): StepOutputFiles {
  const projectDir = (projectId: string) => path.join(root, safeId(projectId, 'project id'));
  const runDir = (projectId: string, runId: string) => path.join(projectDir(projectId), safeId(runId, 'run id'));

  return {
    runDir,
    async ensureRound({ projectId, runId, stepId, round, outputs }) {
      if (outputs.length === 0) return [];
      let roundDir: string;
      try {
        if (!Number.isInteger(round) || round < 1) throw new Error('Invalid round for a step output path');
        roundDir = path.join(runDir(projectId, runId), safeId(stepId, 'step id'), `round-${round}`);
        await mkdir(roundDir, { recursive: true });
      } catch (error) {
        console.error(`Couldn't create the output folder for run ${runId}, step ${stepId}, round ${round}; pasting its outputs inline:`, error);
        return outputs.map(() => null);
      }
      const names = outputFileNames(outputs);
      return Promise.all(outputs.map(async (output, index) => {
        const file = path.join(roundDir, names[index]!);
        try {
          await writeOnce(file, output.content, io.writeFile);
          return file;
        } catch (error) {
          console.error(`Couldn't write output "${output.name}" of run ${runId}, step ${stepId}, round ${round}; pasting it inline:`, error);
          return null;
        }
      }));
    },
    async removeRun(projectId, runId) {
      await rm(runDir(projectId, runId), { recursive: true, force: true });
    },
    async removeProject(projectId) {
      await rm(projectDir(projectId), { recursive: true, force: true });
    },
  };
}

export const STEP_OUTPUTS_DIR = path.join(DATA_DIR, 'step-outputs');
export const stepOutputFiles = createStepOutputFiles(STEP_OUTPUTS_DIR);
