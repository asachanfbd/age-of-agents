import { createHash } from 'node:crypto';
import type { ExecutorProfile } from '../domain/types.ts';
import { claudeAccountKey } from '../executors/claudeUsage.ts';
import { codexAccountKey } from '../executors/codexUsage.ts';

export type AccountProfile = Pick<ExecutorProfile, 'kind' | 'bin' | 'env'>;

/**
 * A stable identifier for the provider account a profile uses. Profiles that share an account, and so
 * its limits, get the same identifier. The pollers' own keys hold paths and environment values, so
 * only a hash of them is ever stored or returned.
 */
export function accountIdentity(profile: AccountProfile): string {
  const key = profile.kind === 'codex-cli' ? codexAccountKey(profile) : claudeAccountKey(profile);
  return createHash('sha256').update(`${profile.kind}\n${key}`).digest('hex').slice(0, 16);
}
