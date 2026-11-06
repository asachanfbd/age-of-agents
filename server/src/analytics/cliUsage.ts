import { readFile } from 'node:fs/promises';
import type { ExecutorProfile } from '../domain/types.ts';
import type { TokenCounts } from './types.ts';

export const NO_TOKENS: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const TOKEN_FIELDS = Object.keys(NO_TOKENS) as (keyof TokenCounts)[];

/** The app's token total: input, output, cache-creation and cache-read added together. */
export function totalTokens(counts: TokenCounts): number {
  return TOKEN_FIELDS.reduce((sum, field) => sum + counts[field], 0);
}

function combine(a: TokenCounts, b: TokenCounts, sign: 1 | -1): TokenCounts {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, a[field] + sign * b[field]])) as unknown as TokenCounts;
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return combine(a, b, 1);
}

/**
 * The part of a session's cumulative usage not yet assigned to any round. A CLI reports a running
 * total for the whole session, and a later round can resume an earlier round's session, so only the
 * increase since the last report belongs to the round reporting now. A total lower than what was
 * already assigned means the CLI started counting again, so all of it is new.
 */
export function usageIncrement(assigned: TokenCounts | null, cumulative: TokenCounts): TokenCounts {
  if (!assigned || TOKEN_FIELDS.some((field) => cumulative[field] < assigned[field])) return cumulative;
  return combine(cumulative, assigned, -1);
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

function parseLines(text: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(object(JSON.parse(line))); } catch { /* A partly written last line is skipped. */ }
  }
  return entries;
}

/** A session's cumulative usage as its CLI reports it. */
export interface CliUsageReport {
  usage: TokenCounts;
  /**
   * Identifies the conversation when the file itself can: the same value for every file that continues
   * one conversation. Null when only the CLI's own session id can tell sessions apart.
   */
  conversation: string | null;
}

/**
 * A Claude Code session's cumulative usage from its session file. Each assistant message carries its
 * own usage; one message is written several times as it streams, so each message id counts once.
 * The conversation is named by its first counted message: a resumed session written to a new file
 * repeats the earlier messages, so it keeps that name and its earlier usage is not assigned again.
 * Null when the file holds no usage at all.
 */
export function claudeSessionUsage(text: string): CliUsageReport | null {
  const byMessage = new Map<string, TokenCounts>();
  for (const entry of parseLines(text)) {
    if (entry.type !== 'assistant') continue;
    const message = object(entry.message);
    const usage = message.usage;
    if (!usage || typeof usage !== 'object' || typeof message.id !== 'string') continue;
    const reported = object(usage);
    byMessage.set(message.id, {
      inputTokens: count(reported.input_tokens),
      outputTokens: count(reported.output_tokens),
      cacheCreationInputTokens: count(reported.cache_creation_input_tokens),
      cacheReadInputTokens: count(reported.cache_read_input_tokens),
    });
  }
  const [first] = byMessage.keys();
  return first === undefined ? null : { usage: [...byMessage.values()].reduce(addTokens, NO_TOKENS), conversation: first };
}

/**
 * A Codex session's cumulative usage: the last running total its session file reports. Cached input
 * is split out of input so the total counts it once, as for a headless Codex turn. Null when the file
 * reports no total.
 */
export function codexSessionUsage(text: string): CliUsageReport | null {
  let latest: TokenCounts | null = null;
  for (const entry of parseLines(text)) {
    const payload = object(entry.payload);
    if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const total = object(payload.info).total_token_usage;
    if (!total || typeof total !== 'object') continue;
    const reported = object(total);
    const input = count(reported.input_tokens);
    const cached = Math.min(input, count(reported.cached_input_tokens));
    latest = { inputTokens: input - cached, outputTokens: count(reported.output_tokens), cacheCreationInputTokens: 0, cacheReadInputTokens: cached };
  }
  return latest && { usage: latest, conversation: null };
}

export type CliUsageReader = (kind: ExecutorProfile['kind'], sessionFile: string) => Promise<CliUsageReport | null>;

/** Reads only usage numbers out of the CLI's own session file; nothing else from it is kept. Null when it cannot be read. */
export const readCliSessionUsage: CliUsageReader = async (kind, sessionFile) => {
  try {
    const text = await readFile(sessionFile, 'utf8');
    return kind === 'codex-cli' ? codexSessionUsage(text) : claudeSessionUsage(text);
  } catch { return null; }
};
