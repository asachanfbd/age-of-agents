import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { CLAUDE_BIN } from '../config.ts';
import type { TokenUsage } from '../domain/types.ts';
import { claudeMcpArgs, type McpServerLaunch } from '../terminal/mcpServers.ts';

/**
 * One line of `claude -p --output-format stream-json` output. The daemon
 * doesn't model every event shape the CLI can emit — it only reads `type`
 * itself and passes the rest through untouched for the transcript/WS feed.
 * See docs/architecture.md, "CLI subprocess orchestration, not the Agent SDK".
 */
export interface StreamJsonEvent {
  type: string;
  [key: string]: unknown;
}

export type TurnOutcome = 'blocked' | 'done' | 'error';

export interface ClaudeTurnResult {
  /** Empty string if the CLI never emitted a session id (e.g. it errored before starting). */
  sessionId: string;
  status: TurnOutcome;
  message: string;
  /**
   * Every other top-level field of the final JSON besides `status`/`message`
   * (e.g. the Task titler's `title` — see
   * server/src/projects/planItemTitler.ts), when the model's
   * final message actually parsed as JSON matching the given schema.
   * Undefined when it didn't (the "fail open as done" path below), the turn
   * errored, or a caller/test constructs a result by hand without it.
   */
  extra?: Record<string, unknown>;
  /**
   * Token usage + cost for this one turn, extracted via `extractTokenUsage`
   * below — null when the result event carried no `usage` object at all
   * (an older CLI build, or a caller/test constructing a result by hand).
   */
  usage?: TokenUsage | null;
  raw: StreamJsonEvent;
}

/** Injectable so tests can verify argument-building and parsing without launching a real process. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessByStdio<null, Readable, Readable>;

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The structured status contract every Worker turn is required to end its
 * final message with, confirmed reliable by the Phase 0 spike over scanning
 * free text for something that looks like a question — see
 * docs/architecture.md#confirmed-by-spike-2026-09-12.
 */
export const STATUS_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['blocked', 'done'] },
    message: { type: 'string' },
  },
  required: ['status', 'message'],
} as const;

export interface RunClaudeTurnOptions {
  /** Previously recorded usage for a resumed Codex session; its CLI reports cumulative totals. */
  previousSessionUsage?: TokenUsage;
  /** The Project's own working directory — every tool call is scoped to this. */
  cwd: string;
  prompt: string;
  /** Which CLI binary to spawn — defaults to config.ts's CLAUDE_BIN. Set per the chosen ExecutorProfile. */
  bin?: string;
  /** Extra env vars merged over process.env (e.g. CLAUDE_CONFIG_DIR to pick a specific logged-in account). */
  env?: Record<string, string>;
  /** Pass the prior turn's sessionId to continue that session instead of starting a new one. */
  resumeSessionId?: string | null;
  /**
   * 'bypassPermissions' for full autonomy, 'default' for approval-gated.
   * 'default' currently denies gated tool calls outright rather than
   * pausing for one — see docs/domain/types.ts's Autonomy doc comment.
   */
  permissionMode: 'bypassPermissions' | 'default';
  appendSystemPrompt?: string;
  /** Overrides the default {status,message} contract — e.g. planItemTitler.ts's schema, which adds a required `title`. */
  jsonSchema?: object;
  /** Tool names to deny outright (`--disallowed-tools`) regardless of permission mode — e.g. plan.ts's PLAN_DISALLOWED_TOOLS, so a 'plan'-kind turn can't run commands even under bypassPermissions. */
  disallowedTools?: string[];
  /** Session-scoped MCP servers for this one headless turn (e.g. terminal/stepTaskTool.ts's step API, terminal/testTaskTool.ts's testing tools), registered through terminal/mcpServers.ts exactly as an interactive session registers them. */
  mcpServers?: McpServerLaunch[];
  /** Called for every parsed stream-json line, in order, as the turn runs. */
  onEvent?: (event: StreamJsonEvent) => void;
  /** Called once, right after a successful spawn, so a caller can later kill the process (e.g. a "stop" action). */
  onProcess?: (child: ChildProcessByStdio<null, Readable, Readable>) => void;
  spawnFn?: SpawnFn;
}

/**
 * Runs exactly one headless `claude -p` turn to completion and resolves with
 * its outcome. This is never a live, held-open pause — per the spike, a
 * "blocked" outcome is a normal finished turn; the caller resumes with a
 * fresh call carrying the same sessionId once it has an answer.
 */
export function runClaudeTurn(options: RunClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const args = buildArgs(options);

  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      const env = options.env ? { ...process.env, ...options.env } : process.env;
      child = spawnFn(options.bin ?? CLAUDE_BIN, args, { cwd: options.cwd, env });
    } catch (error) {
      reject(error);
      return;
    }
    options.onProcess?.(child);

    let lastResultEvent: StreamJsonEvent | null = null;
    let stderr = '';
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.on('error', fail);

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let event: StreamJsonEvent;
      try {
        event = JSON.parse(line) as StreamJsonEvent;
      } catch {
        return; // Not every line is guaranteed to be JSON (banners, etc.) — best-effort.
      }
      options.onEvent?.(event);
      if (event.type === 'result') lastResultEvent = event;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (!lastResultEvent) {
        reject(new Error(`claude exited (code ${code}) without a result event.${stderr.trim() ? ` stderr: ${stderr.trim()}` : ''}`));
        return;
      }
      resolve(interpretResult(lastResultEvent));
    });
  });
}

function buildArgs(options: RunClaudeTurnOptions): string[] {
  const args: string[] = ['-p'];
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  args.push('--output-format', 'stream-json', '--verbose');
  args.push('--permission-mode', options.permissionMode);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.disallowedTools?.length) args.push('--disallowed-tools', options.disallowedTools.join(','));
  args.push(...claudeMcpArgs(options.mcpServers ?? []));
  args.push('--json-schema', JSON.stringify(options.jsonSchema ?? STATUS_SCHEMA));
  args.push(options.prompt);
  return args;
}

function interpretResult(resultEvent: StreamJsonEvent): ClaudeTurnResult {
  const sessionId = typeof resultEvent.session_id === 'string' ? resultEvent.session_id : '';
  const usage = extractTokenUsage(resultEvent);

  if (resultEvent.is_error) {
    return { sessionId, status: 'error', message: resultText(resultEvent) || 'claude turn ended in error', extra: {}, usage, raw: resultEvent };
  }

  const text = resultText(resultEvent);
  try {
    const parsed = JSON.parse(text) as { status?: string; message?: string; [key: string]: unknown };
    const { status, message, ...extra } = parsed;
    if (status === 'blocked') return { sessionId, status: 'blocked', message: message ?? '', extra, usage, raw: resultEvent };
    return { sessionId, status: 'done', message: message ?? text, extra, usage, raw: resultEvent };
  } catch {
    // The final message didn't honor --json-schema (older CLI build, or the
    // worker's own model deviated). Fail open as "done" — see
    // docs/roadmap.md's Phase 1 checkpoint about re-verifying CLI behavior —
    // rather than leaving the Task stuck forever on a status it will never emit.
    return { sessionId, status: 'done', message: text, extra: {}, usage, raw: resultEvent };
  }
}

function resultText(resultEvent: StreamJsonEvent): string {
  return typeof resultEvent.result === 'string' ? resultEvent.result : '';
}

/**
 * Pulls token usage + cost off a turn's raw stream-json `result` event, when
 * present. Claude Code's `--output-format stream-json` result event carries
 * a `usage` object (`input_tokens`, `output_tokens`,
 * `cache_creation_input_tokens`, `cache_read_input_tokens`) plus a top-level
 * `total_cost_usd` — see docs/roadmap.md's footer-improvements item on
 * tracking session token counts. Returns null when the event carries no
 * `usage` object at all (an older CLI build, or a hand-built test event)
 * rather than fabricating zeros, so callers can tell "no data" from "zero
 * tokens used".
 */
export function extractTokenUsage(resultEvent: StreamJsonEvent): TokenUsage | null {
  const usage = resultEvent.usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    totalCostUsd: num(resultEvent.total_cost_usd),
  };
}
