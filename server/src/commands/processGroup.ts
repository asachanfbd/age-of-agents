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

/**
 * Signals the process group led by `pid` (a PTY child is its own session and group leader) with
 * SIGTERM, then SIGKILL after STOP_GRACE_MS, so background children a finished CLI session started,
 * such as a dev server, don't outlive it. Safe when the group is already gone.
 * The delayed SIGKILL may target a group id the OS has reused after the leader exited; that needs a
 * new group with the same id within STOP_GRACE_MS, which is accepted as vanishingly unlikely.
 */
export function terminateProcessGroup(pid: number): void {
  if (process.platform === 'win32') return;
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(-pid, name); } catch { /* Already gone. */ }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), STOP_GRACE_MS).unref();
}
