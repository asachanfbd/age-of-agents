import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { TestProcess, TestRunnerDeps } from '../../src/testing/testRunner.ts';

/**
 * In-memory stand-ins for the Test Run engine's side effects (see TestRunnerDeps) so its tests
 * never start a real process: a scripted child process, a fake artifact "filesystem" and fixed
 * git metadata. Run log/result files use the real RunFiles, which writes under the test's own temp
 * AGENT_VISUAL_OS_DATA_DIR. Shared by testRunner.test.ts and testRunsApi.test.ts.
 */

export class FakeProcess extends EventEmitter implements TestProcess {
  stdout = new EventEmitter() as unknown as Readable;
  stderr = new EventEmitter() as unknown as Readable;
  killed = false;

  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(command: string, cwd: string, env: NodeJS.ProcessEnv) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.env = env;
  }

  get artifactDir(): string {
    return this.env.AGENT_VISUAL_OS_TEST_ARTIFACTS_DIR!;
  }

  write(chunk: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    (this[stream] as unknown as EventEmitter).emit('data', Buffer.from(chunk));
  }

  /** Exits normally: Node emits 'exit', then 'close' once the pipes shut. */
  exit(code: number | null): void {
    this.emit('exit', code);
    this.emit('close', code);
  }

  /** Exits while a background child keeps stdout open, so 'close' never comes on its own. */
  exitKeepingPipesOpen(code: number | null): void {
    this.emit('exit', code);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }

  kill(): void {
    this.killed = true;
    setImmediate(() => this.exit(null));
  }
}

export interface FakeHarness {
  deps: Partial<TestRunnerDeps>;
  processes: FakeProcess[];
  /** Reports the "command" wrote, keyed by artifact dir then relative path. */
  artifacts: Map<string, Map<string, string>>;
  createdDirs: string[];
  removedDirs: string[];
  /** Resolves with the next process to spawn. */
  nextProcess(): Promise<FakeProcess>;
  writeArtifact(process: FakeProcess, relativePath: string, content: string): void;
}

export function createFakeHarness(overrides: Partial<TestRunnerDeps> = {}): FakeHarness {
  const processes: FakeProcess[] = [];
  const artifacts = new Map<string, Map<string, string>>();
  const createdDirs: string[] = [];
  const removedDirs: string[] = [];
  const waiters: ((process: FakeProcess) => void)[] = [];
  let seq = 0;

  const deps: Partial<TestRunnerDeps> = {
    spawnProcess(command, { cwd, env }) {
      const process = new FakeProcess(command, cwd, env);
      processes.push(process);
      waiters.shift()?.(process);
      return process;
    },
    async createArtifactDir() {
      const dir = `/fake-artifacts/run-${(seq += 1)}`;
      createdDirs.push(dir);
      artifacts.set(dir, new Map());
      return dir;
    },
    async removeArtifactDir(dir) {
      removedDirs.push(dir);
      artifacts.delete(dir);
    },
    async readArtifact(dir, relativePath) {
      const content = artifacts.get(dir)?.get(relativePath);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${relativePath}`), { code: 'ENOENT' });
      return content;
    },
    async gitInfo(cwd) {
      return { branch: cwd.includes('.worktrees') ? 'task-branch' : 'main', commit: 'abc123' };
    },
    ...overrides,
  };

  return {
    deps,
    processes,
    artifacts,
    createdDirs,
    removedDirs,
    nextProcess() {
      const started = processes.find((p) => !(p as { claimed?: boolean }).claimed);
      if (started) {
        (started as { claimed?: boolean }).claimed = true;
        return Promise.resolve(started);
      }
      return new Promise((resolve) => waiters.push((p) => { (p as { claimed?: boolean }).claimed = true; resolve(p); }));
    },
    writeArtifact(process, relativePath, content) {
      artifacts.get(process.artifactDir)!.set(relativePath, content);
    },
  };
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const JUNIT_PASS = `<?xml version="1.0"?>
<testsuites time="1.5"><testsuite name="unit"><testcase classname="math" name="adds" time="0.5"/><testcase classname="math" name="subtracts" time="1"/></testsuite></testsuites>`;

export const JUNIT_FAIL = `<testsuite name="unit" time="2"><testcase classname="math" name="adds"/><testcase classname="math" name="divides"><failure message="expected 2, got 3">stack</failure></testcase></testsuite>`;

/** A config with: unit (junit, + utility), lint (no collectors), e2e (disabled), security (sarif). */
export function sampleConfig() {
  return {
    schemaVersion: 1,
    suites: [
      {
        id: 'unit', label: 'Unit tests', kind: 'unit', primaryActionId: 'run',
        actions: [
          { id: 'run', label: 'Run unit tests', workingDirectory: 'packages/api', command: 'npm test', collectors: [{ id: 'cases', format: 'junit-xml', path: 'junit.xml' }] },
          { id: 'snapshots', label: 'Update snapshots', purpose: 'utility', command: 'npm test -- -u' },
        ],
      },
      { id: 'lint', label: 'Lint', kind: 'custom', primaryActionId: 'check', actions: [{ id: 'check', label: 'Lint', command: 'npm run lint' }] },
      { id: 'e2e', label: 'E2E', kind: 'e2e', enabled: false, primaryActionId: 'run', actions: [{ id: 'run', label: 'Run e2e', command: 'npx playwright test' }] },
      {
        id: 'security', label: 'Security', kind: 'security', primaryActionId: 'scan',
        actions: [{ id: 'scan', label: 'Semgrep', command: 'semgrep --sarif', collectors: [{ id: 'sarif', format: 'sarif', path: 'out/semgrep.sarif' }] }],
      },
    ],
  };
}
