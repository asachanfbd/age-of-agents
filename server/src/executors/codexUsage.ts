import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { ExecutorProfile } from '../domain/types.ts';
import { parseLimits, type ExecutorLimits } from './executorLimits.ts';
import { UsagePoller, UsageReadError } from './usagePoller.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

export function parseCodexLimits(value: unknown, observedAt: number): ExecutorLimits | null {
  const response = object(value);
  const buckets = object(response.rateLimitsByLimitId);
  const limits = object(response.rateLimitsByLimitId != null ? buckets.codex : response.rateLimits);
  const windows = [object(limits.primary), object(limits.secondary)];
  const convert = (minutes: number) => {
    const window = windows.find(w => w.windowDurationMins === minutes);
    return window ? { used_percentage: window.usedPercent, resets_at: window.resetsAt } : null;
  };
  return parseLimits({ observed_at: observedAt, rate_limits: { five_hour: convert(300), seven_day: convert(10080) } });
}

/** Let the installed CLI own authentication; never read or return its credential files. */
export function readCodexRateLimits(executor: ExecutorProfile, spawnFn: typeof spawn = spawn, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const child = spawnFn(executor.bin, ['app-server', '--listen', 'stdio://'], { cwd: homedir(), env: { ...process.env, ...executor.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.kill();
      if (error) reject(error); else resolveResult(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex usage request timed out')), timeoutMs);
    child.on('error', () => finish(new Error('Unable to start Codex usage reader')));
    child.on('close', () => finish(new Error('Codex usage reader exited early')));
    child.stdin?.on('error', () => finish(new Error('Codex usage reader disconnected')));
    child.stderr?.resume(); // Drain diagnostics without logging account details.
    const send = (value: unknown) => child.stdin?.write(JSON.stringify(value) + '\n');
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      let message: Record<string, unknown>;
      try { message = object(JSON.parse(line)); } catch { return; }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) { finish(new Error('Codex account usage unavailable')); return; }
      if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      } else finish(undefined, message.result);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_visual_os', version: '0.0.0' } } });
  });
}

function codexHome(executor: Pick<ExecutorProfile, 'env'>): string {
  return resolve(executor.env.CODEX_HOME || process.env.CODEX_HOME || `${homedir()}/.codex`);
}

/** Profiles with the same binary, Codex home and environment share one account, so one reading. */
export function codexAccountKey(executor: Pick<ExecutorProfile, 'bin' | 'env'>): string {
  return JSON.stringify([executor.bin, codexHome(executor), executor.env]);
}

export class CodexUsagePoller extends UsagePoller {
  constructor(read: (executor: ExecutorProfile) => Promise<unknown> = readCodexRateLimits, now: () => number = Date.now) {
    super({
      kind: 'codex-cli',
      accountKey: codexAccountKey,
      async read(executor) {
        // The CLI reports no timestamp, so the moment its answer arrived is the observation time.
        const limits = parseCodexLimits(await read(executor), now() / 1000);
        if (!limits) throw new UsageReadError('no-access', 0, true);
        return limits;
      },
    }, now);
  }
}
export const codexUsagePoller = new CodexUsagePoller();
