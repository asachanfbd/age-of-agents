import { codexUsagePoller } from './codexUsage.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExecutorProfile } from '../domain/types.ts';
import { parseLimits, readExecutorLimits, type ExecutorLimits } from './executorLimits.ts';
import { UsagePoller, UsageReadError, type UsageSource } from './usagePoller.ts';

const run = promisify(execFile);
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

export function credentialLocation(executor: Pick<ExecutorProfile, 'env'>) {
  const env = { ...process.env, ...executor.env };
  const configured = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR;
  const path = configured || join(homedir(), '.claude');
  const directory = resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path).normalize('NFC');
  const suffix = configured ? `-${createHash('sha256').update(directory).digest('hex').slice(0, 8)}` : '';
  return { directory, service: `Claude Code-credentials${suffix}` };
}

/** Tokens stay in this process and are sent only to Anthropic's fixed usage endpoint. */
async function readAccessToken(executor: ExecutorProfile): Promise<string | null> {
  const { directory, service } = credentialLocation(executor);
  let raw: string;
  try {
    if (process.platform === 'darwin') {
      const username = process.env.USER || userInfo().username;
      const account = /^[a-zA-Z0-9._-]+$/.test(username) ? username : 'claude-code-user';
      raw = (await run('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], { timeout: 5000 })).stdout;
    } else {
      raw = await readFile(join(directory, '.credentials.json'), 'utf8');
    }
    const oauth = JSON.parse(raw).claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null;
    // Claude owns token refresh. Re-read its store on every poll; never rotate tokens here.
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return null;
    return oauth.accessToken;
  } catch { return null; }
}

async function readVersion(executor: ExecutorProfile): Promise<string | null> {
  try {
    const { stdout } = await run(executor.bin, ['--version'], { env: { ...process.env, ...executor.env }, timeout: 5000 });
    return stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  } catch { return null; }
}

export function parseOAuthUsage(value: unknown, observedAt: number): ExecutorLimits | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const convert = (input: unknown) => {
    if (!input || typeof input !== 'object') return null;
    const window = input as Record<string, unknown>;
    return { used_percentage: window.utilization, resets_at: typeof window.resets_at === 'string' ? Date.parse(window.resets_at) / 1000 : null };
  };
  return parseLimits({ observed_at: observedAt, rate_limits: { five_hour: convert(body.five_hour), seven_day: convert(body.seven_day) } });
}

interface Dependencies {
  now: () => number;
  token: (executor: ExecutorProfile) => Promise<string | null>;
  version: (executor: ExecutorProfile) => Promise<string | null>;
  fetch: typeof globalThis.fetch;
}

function retryAfterMs(header: string | null, now: number): number {
  if (header === null) return 0;
  const ms = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? ms : 0;
}

/** Profiles sharing a credential store share one account, so one reading. */
export function claudeAccountKey(executor: Pick<ExecutorProfile, 'env'>): string {
  return credentialLocation(executor).service;
}

function claudeUsageSource({ now, token, version, fetch }: Dependencies): UsageSource {
  return {
    kind: 'claude-cli',
    accountKey: claudeAccountKey,
    async read(executor) {
      const accessToken = await token(executor);
      if (!accessToken) throw new UsageReadError('no-access');
      const installedVersion = await version(executor);
      if (!installedVersion) throw new UsageReadError('no-access');
      const response = await fetch(ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': `claude-code/${installedVersion}` },
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UsageReadError('provider-error', retryAfterMs(response.headers.get('retry-after'), now()));
      }
      // The endpoint returns no timestamp, so the moment its response arrived is the observation time.
      const limits = parseOAuthUsage(await response.json(), now() / 1000);
      if (!limits) throw new UsageReadError('provider-error');
      return limits;
    },
  };
}

export class ClaudeUsagePoller extends UsagePoller {
  constructor(dependencies: Partial<Dependencies> = {}) {
    const resolved = { now: Date.now, token: readAccessToken, version: readVersion, fetch: globalThis.fetch, ...dependencies };
    super(claudeUsageSource(resolved), resolved.now);
  }
}

export const claudeUsagePoller = new ClaudeUsagePoller();

export async function getExecutorLimits(executor: ExecutorProfile): Promise<ExecutorLimits | null> {
  if (executor.kind === 'codex-cli') return codexUsagePoller.get(executor);
  if (executor.kind !== 'claude-cli') return null;
  const cached = await readExecutorLimits(executor);
  const polled = claudeUsagePoller.get(executor);
  return cached && (!polled || cached.observedAt > polled.observedAt) ? cached : polled;
}
