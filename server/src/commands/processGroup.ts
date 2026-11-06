import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

/** How long Stop waits for a process group to exit after SIGTERM before SIGKILLing it. */
export const STOP_GRACE_MS = 5_000;

/** The slice of a child process the runners use. */
export interface GroupProcess {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** The command itself exited; its stdio may still be held open by a background child. */
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  /** The command exited and every stdio pipe closed. */
  on(event: 'close', listener: (code: number | null) => void): unknown;
  /** Signals the whole process tree; a no-op once the process has closed. */
  kill(): void;
}

/**
 * `spawn(command, { shell: true })` as the leader of its own process group, so `kill()` reaches the
 * whole tree the shell forks (a dev server, test workers, browsers) rather than just the shell, with
 * a SIGKILL if the group ignores SIGTERM for STOP_GRACE_MS.
 */
export function spawnInProcessGroup(command: string, options: { cwd: string; env: NodeJS.ProcessEnv }): GroupProcess {
  const detached = process.platform !== 'win32';
  const child = spawn(command, { shell: true, cwd: options.cwd, env: options.env, detached });
  // Once every pipe has closed the group may be empty and its id reusable, so stop signalling it.
  let closed = false;
  child.on('close', () => { closed = true; });
  const signal = (name: NodeJS.Signals) => {
    if (closed) return;
    try {
      if (detached && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch { /* Already gone. */ }
  };
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    on: ((event: string, listener: (...args: unknown[]) => void) => child.on(event, listener)) as GroupProcess['on'],
    kill() {
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), STOP_GRACE_MS).unref();
    },
  };
}
