import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorProfile } from '../domain/types.ts';

export interface LimitWindow { usedPercentage: number; resetsAt: number | null }
export interface ExecutorLimits {
  observedAt: number;
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
}

export function parseLimits(value: unknown): ExecutorLimits | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.observed_at !== 'number' || !Number.isFinite(data.observed_at) || data.observed_at <= 0) return null;
  const limits = data.rate_limits as Record<string, unknown> | undefined;
  if (!limits || typeof limits !== 'object') return null;
  const window = (value: unknown): LimitWindow | null => {
    if (!value || typeof value !== 'object') return null;
    const w = value as Record<string, unknown>;
    if (typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage) || w.used_percentage < 0 || w.used_percentage > 100) return null;
    return {
      usedPercentage: w.used_percentage,
      resetsAt: typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) && w.resets_at > 0 ? w.resets_at : null,
    };
  };
  const fiveHour = window(limits.five_hour);
  const sevenDay = window(limits.seven_day);
  return fiveHour || sevenDay ? { observedAt: data.observed_at, fiveHour, sevenDay } : null;
}

/** Read only the status-line cache; never access account credentials. */
export async function readExecutorLimits(executor: ExecutorProfile): Promise<ExecutorLimits | null> {
  if (executor.kind !== 'claude-cli') return null;
  const configured = executor.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const directory = configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  try {
    return parseLimits(JSON.parse(await readFile(join(directory, 'context-village-usage.json'), 'utf8')));
  } catch { return null; }
}
