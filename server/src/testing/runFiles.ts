import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedTestResult } from '../domain/types.ts';

/**
 * Where each Test Run's bulky data lives: its log (`<id>.log`) and full normalized result
 * (`<id>.result.json`), one pair of files per run under the daemon's data directory. Kept out of
 * `test-runs.json` because FileDatabase holds that whole file in memory and rewrites it on every
 * change — per-run files let a log or a report be large without slowing every other write.
 */
export interface RunFiles {
  appendLog(runId: string, text: string): Promise<void>;
  /** '' when the run has no log yet (or it was removed). */
  readLog(runId: string): Promise<string>;
  writeResult(runId: string, result: NormalizedTestResult): Promise<void>;
  /** null when the run has no stored result. */
  readResult(runId: string): Promise<NormalizedTestResult | null>;
  /** Deletes both files; a no-op for files that don't exist. */
  remove(runId: string): Promise<void>;
}

/** Run ids are daemon-generated UUIDs; anything else is refused so an id can never name a path. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function createRunFiles(dir: string): RunFiles {
  function fileFor(runId: string, suffix: string): string {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error('Invalid test run id');
    return path.join(dir, `${runId}${suffix}`);
  }

  async function readIfPresent(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    async appendLog(runId, text) {
      await mkdir(dir, { recursive: true });
      await appendFile(fileFor(runId, '.log'), text);
    },
    async readLog(runId) {
      return (await readIfPresent(fileFor(runId, '.log'))) ?? '';
    },
    async writeResult(runId, result) {
      await mkdir(dir, { recursive: true });
      await writeFile(fileFor(runId, '.result.json'), JSON.stringify(result));
    },
    async readResult(runId) {
      const text = await readIfPresent(fileFor(runId, '.result.json'));
      return text === null ? null : (JSON.parse(text) as NormalizedTestResult);
    },
    async remove(runId) {
      await Promise.all(['.log', '.result.json'].map((suffix) => rm(fileFor(runId, suffix), { force: true })));
    },
  };
}
