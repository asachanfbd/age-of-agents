import * as pty from 'node-pty';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Autonomy, ExecutorProfile } from '../domain/types.ts';
import { createStreamRedactor } from '../redaction.ts';
import { PORT } from '../config.ts';
import { CLI_HOOK_TOKEN } from './projectCliHooks.ts';
import { claudeMcpArgs, codexMcpArgs, type McpServerLaunch } from './mcpServers.ts';

const MAX_BUFFER_CHARS = 2_000_000;
/** How long an `endWhenDetached` session survives with no terminal attached — covers a Summary/Session toggle or a reload. */
const DETACHED_GRACE_MS = 15_000;
export const HOOK_ENV_KEYS = ['AGENT_VISUAL_OS_TASK_ID', 'AGENT_VISUAL_OS_CLI_KIND', 'AGENT_VISUAL_OS_HOOK_URL', 'AGENT_VISUAL_OS_HOOK_TOKEN'];
const require = createRequire(import.meta.url);

/**
 * node-pty 1.1's macOS prebuild can arrive with its native spawn-helper missing
 * execute bits. The native addon then reports only the opaque
 * "posix_spawnp failed" for every command, including absolute binaries.
 * Repair the exact helper paired with the native addon before first spawn.
 */
export function nodePtySpawnHelperPath(): string | null {
  if (process.platform !== 'darwin') return null;
  const packageRoot = dirname(require.resolve('node-pty/package.json'));
  const nativeDirectories = [
    join(packageRoot, 'build', 'Release'),
    join(packageRoot, 'build', 'Debug'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`),
  ];
  const nativeDirectory = nativeDirectories.find((directory) => existsSync(join(directory, 'pty.node')));
  if (!nativeDirectory) return null;
  const helperPath = join(nativeDirectory, 'spawn-helper');
  return existsSync(helperPath) ? helperPath : null;
}

export function ensureNodePtySpawnHelperExecutable(): void {
  const helperPath = nodePtySpawnHelperPath();
  if (!helperPath) return; // node-pty itself will report a missing native module/helper.
  const mode = statSync(helperPath).mode;
  if ((mode & 0o111) !== 0) return;
  try {
    chmodSync(helperPath, (mode & 0o777) | 0o111);
  } catch (error) {
    throw new Error(`The node-pty macOS helper is not executable and could not be repaired at "${helperPath}": ${(error as Error).message}`);
  }
}

export type TerminalExecutorKind = Extract<ExecutorProfile['kind'], 'claude-cli' | 'codex-cli'>;

export interface TerminalSessionStart {
  taskId: string;
  kind: TerminalExecutorKind;
  bin: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  systemPrompt: string;
  autonomy: Autonomy;
  /** Tool names denied outright regardless of permission mode. Honoured by Claude CLI only — Codex has no per-tool deny flag, so it relies on `readOnly`. */
  disallowedTools?: string[];
  /** The session must never change files (a planning session). Codex then runs in its read-only sandbox with no approval escalation, whatever `autonomy` says; Claude is held to it through `disallowedTools`. */
  readOnly?: boolean;
  /** With `readOnly`: the session may run shell commands (install, test, build), so Codex runs in a command-permitting sandbox with network access and still no approval escalation. Claude is held to "no file edits" through `disallowedTools`. */
  canRunCommands?: boolean;
  /**
   * Absolute folders outside the working directory the session may read without prompting but never
   * write (a step's saved earlier outputs — see worker/stepOutputFiles.ts). Claude gets a Read allow
   * rule and an Edit deny rule per folder (deny rules hold even with --dangerously-skip-permissions).
   * Codex needs no flag: every sandbox mode reads the whole disk and none adds these as writable roots;
   * with its sandbox bypassed (auto autonomy) nothing stops a write beyond the files' read-only mode.
   */
  readOnlyDirs?: string[];
  /** Session-scoped MCP servers to register alongside the project's own (e.g. planTaskTool.ts's task-management API for a planning session, testTaskTool.ts's testing tools for a coding session). */
  mcpServers?: McpServerLaunch[];
  /** Exact persisted CLI conversation. Set up-front for Claude; discovered after launch for Codex. */
  sessionId?: string | null;
  /** Resume sessionId rather than creating a new conversation. */
  resume?: boolean;
  /** Inherited variables to remove from the session's environment (a project GitHub account removes ambient credentials). */
  unsetEnv?: string[];
  /** `false` withholds the hook-reporting env, so the CLI's lifecycle hooks never reach the daemon (an ad-hoc inspect session must not move its Task's state). Default true. */
  reportHooks?: boolean;
  /** Kill the process once no terminal has been attached for DETACHED_GRACE_MS — for a session nobody else owns the teardown of. */
  endWhenDetached?: boolean;
  onSessionId?: (sessionId: string) => void;
  onExit: (exitCode: number, signal?: number, sessionId?: string) => void;
}

interface TerminalSession {
  process: pty.IPty;
  buffer: string;
  ended: boolean;
  sessionId?: string;
  sessionDiscoveryTimer?: NodeJS.Timeout;
  endWhenDetached: boolean;
  detachedTimer?: NodeJS.Timeout;
  listeners: Set<(data: string) => void>;
  endListeners: Set<() => void>;
}

export interface TerminalSessionHost {
  start(input: TerminalSessionStart): void;
  /** `onEnd` fires once the process exits — immediately when it already has. */
  attach(taskId: string, listener: (data: string) => void, onEnd?: () => void): (() => void) | null;
  write(taskId: string, data: string): void;
  resize(taskId: string, cols: number, rows: number): void;
  stop(taskId: string): boolean;
  has(taskId: string): boolean;
  /** Whether a project-popup terminal is currently attached to this PTY. */
  isAttached(taskId: string): boolean;
  /** How many sessions are currently live (an ended PTY's entry does not count) — see appUpdate/appUpdateBlocking.ts's `computeBlockingCounts` ("terminalSessions"), which needs this independent of any one Task's own stored status (it also catches an ad-hoc inspect session whose PTY is still open on an otherwise-settled Task). */
  count(): number;
  /** Whether the CLI still has this saved conversation, so it can be resumed. A host without it is assumed to. */
  sessionExists?(input: CliSessionLookup): boolean;
}

export interface CliSessionLookup {
  kind: TerminalExecutorKind;
  env: Record<string, string>;
  sessionId: string;
}

/** A missing directory lists nothing; any other read error gives null, since the session may still be there. */
function readDirectoryNames(directory: string, recursive = false): string[] | null {
  try {
    return readdirSync(directory, { recursive }) as string[];
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

/**
 * Looks for the CLI's saved conversation file: Claude keeps `<config dir>/projects/<cwd key>/<id>.jsonl`,
 * Codex keeps `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. The executor's own env
 * picks the account's config dir, the same way the launched CLI resolves it. An unreadable directory
 * counts as found, leaving the CLI itself to decide.
 */
export function cliSessionExists({ kind, env, sessionId }: CliSessionLookup): boolean {
  if (kind === 'claude-cli') {
    const root = join(env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
    const projects = readDirectoryNames(root);
    return projects === null || projects.some((project) => existsSync(join(root, project, `${sessionId}.jsonl`)));
  }
  const root = join(env.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const files = readDirectoryNames(root, true);
  return files === null || files.some((file) => {
    const name = file.split(/[\\/]/).at(-1)!;
    return name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`);
  });
}

/**
 * A read-only session can't ask to escalate, since an approved escalation would run outside the sandbox and could write.
 * Codex's `read-only` and `workspace-write` sandboxes restrict writes only, so they can still Read absolute
 * paths outside the cwd, such as a Catalog skill's SKILL.md; no readable-roots option is needed for skills.
 */
function codexSandboxArgs({ readOnly, canRunCommands, autonomy }: Pick<TerminalSessionStart, 'readOnly' | 'canRunCommands' | 'autonomy'>): string[] {
  if (readOnly && canRunCommands) return ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '--ask-for-approval', 'never'];
  if (readOnly) return ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
  return autonomy === 'auto'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
}

/** Claude permission rules for `readOnlyDirs`; a rule's `//` prefix marks an absolute path. */
export function claudeReadOnlyDirArgs(dirs: string[]): string[] {
  if (!dirs.length) return [];
  const pattern = (dir: string) => `/${dir.replace(/\/+$/, '')}/**`;
  return [
    '--allowed-tools', ...dirs.map((dir) => `Read(${pattern(dir)})`),
    '--disallowed-tools', ...dirs.map((dir) => `Edit(${pattern(dir)})`),
  ];
}

export function interactiveCliArgs(input: Pick<TerminalSessionStart, 'kind' | 'prompt' | 'systemPrompt' | 'autonomy' | 'disallowedTools' | 'readOnly' | 'canRunCommands' | 'readOnlyDirs' | 'mcpServers' | 'sessionId' | 'resume'>): string[] {
  if (input.kind === 'claude-cli') {
    const args: string[] = [];
    // These flags are variadic, so they go first: the next flag (always --session-id for a Task) ends their lists before the prompt.
    if (input.disallowedTools?.length) args.push('--disallowed-tools', input.disallowedTools.join(','));
    args.push(...claudeReadOnlyDirArgs(input.readOnlyDirs ?? []));
    args.push(...claudeMcpArgs(input.mcpServers ?? []));
    if (input.autonomy === 'auto') args.push('--dangerously-skip-permissions');
    if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
    if (input.sessionId) args.push(input.resume ? '--resume' : '--session-id', input.sessionId);
    if (input.prompt) args.push(input.prompt);
    return args;
  }

  const options = codexSandboxArgs(input);
  if (input.systemPrompt) options.push('-c', `developer_instructions=${JSON.stringify(input.systemPrompt)}`);
  options.push(...codexMcpArgs(input.mcpServers ?? []));
  if (!input.resume || !input.sessionId) return input.prompt ? [...options, input.prompt] : options;
  return ['resume', ...options, '-c', 'tui.resume_cwd="current"', input.sessionId, ...(input.prompt ? [input.prompt] : [])];
}

function dateDirectory(root: string, date: Date): string {
  return join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
}

function recentCodexSessionFiles(root: string, now = new Date()): string[] {
  const directories = [0, -1, 1].map((offset) => {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    return dateDirectory(root, date);
  });
  return directories.flatMap((directory) => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
      .map((name) => join(directory, name));
  });
}

export function codexSessionIdFromNewFile(root: string, cwd: string, existingFiles: Set<string>, now = new Date()): string | undefined {
  for (const file of recentCodexSessionFiles(root, now)) {
    if (existingFiles.has(file)) continue;
    try {
      const firstLine = readFileSync(file, 'utf8').split('\n', 1)[0];
      if (!firstLine) continue;
      const event = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string } };
      if (event.type === 'session_meta' && event.payload?.id && event.payload.cwd && resolve(event.payload.cwd) === resolve(cwd)) {
        return event.payload.id;
      }
    } catch {
      // The CLI may still be writing the first JSONL record; the next poll retries it.
    }
  }
  return undefined;
}

export class TerminalSessionManager implements TerminalSessionHost {
  private sessions = new Map<string, TerminalSession>();

  private readonly changeListeners = new Set<() => void>();

  private readonly detachedGraceMs: number;

  constructor(detachedGraceMs = DETACHED_GRACE_MS) {
    this.detachedGraceMs = detachedGraceMs;
  }

  start(input: TerminalSessionStart): void {
    if (this.sessions.get(input.taskId) && !this.sessions.get(input.taskId)!.ended) {
      throw new Error('This task already has a live terminal');
    }
    if (input.sessionId && [...this.sessions.entries()].some(([taskId, session]) => taskId !== input.taskId && !session.ended && session.sessionId === input.sessionId)) {
      throw new Error('This CLI conversation already has a live terminal');
    }
    const hookEnv = input.reportHooks === false ? {} : {
      AGENT_VISUAL_OS_TASK_ID: input.taskId,
      AGENT_VISUAL_OS_CLI_KIND: input.kind,
      AGENT_VISUAL_OS_HOOK_URL: `http://127.0.0.1:${PORT}/api/cli-hooks`,
      AGENT_VISUAL_OS_HOOK_TOKEN: CLI_HOOK_TOKEN,
    };
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...input.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...hookEnv })
        // A daemon launched from inside a CLI session inherits that session's hook env; never pass it on unasked.
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && (entry[0] in hookEnv || !HOOK_ENV_KEYS.includes(entry[0])) && !input.unsetEnv?.includes(entry[0])),
    );
    ensureNodePtySpawnHelperExecutable();
    const codexSessionsRoot = join(input.env.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    const existingCodexFiles = input.kind === 'codex-cli' && !input.resume
      ? new Set(recentCodexSessionFiles(codexSessionsRoot))
      : new Set<string>();
    const processHandle = pty.spawn(input.bin, interactiveCliArgs(input), {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: input.cwd,
      env,
    });
    const session: TerminalSession = {
      process: processHandle,
      buffer: '',
      ended: false,
      sessionId: input.sessionId ?? undefined,
      endWhenDetached: input.endWhenDetached ?? false,
      listeners: new Set(),
      endListeners: new Set(),
    };
    this.sessions.set(input.taskId, session);
    this.notifyChange();
    this.scheduleDetachedEnd(session);
    if (input.kind === 'codex-cli' && !input.resume) {
      const discover = () => {
        const sessionId = codexSessionIdFromNewFile(codexSessionsRoot, input.cwd, existingCodexFiles);
        if (!sessionId || session.sessionId) return;
        session.sessionId = sessionId;
        if (session.sessionDiscoveryTimer) clearInterval(session.sessionDiscoveryTimer);
        input.onSessionId?.(sessionId);
      };
      session.sessionDiscoveryTimer = setInterval(discover, 100);
      session.sessionDiscoveryTimer.unref();
      discover();
    }
    const output = createStreamRedactor((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER_CHARS);
      for (const listener of session.listeners) listener(data);
    });
    processHandle.onData((raw) => output.push(raw));
    processHandle.onExit(({ exitCode, signal }) => {
      output.flush();
      session.ended = true;
      if (session.sessionDiscoveryTimer) clearInterval(session.sessionDiscoveryTimer);
      clearTimeout(session.detachedTimer);
      for (const onEnd of session.endListeners) onEnd();
      this.notifyChange();
      if (!session.sessionId && input.kind === 'codex-cli') {
        session.sessionId = codexSessionIdFromNewFile(codexSessionsRoot, input.cwd, existingCodexFiles);
        if (session.sessionId) input.onSessionId?.(session.sessionId);
      }
      input.onExit(exitCode, signal, session.sessionId);
    });
  }

  /** Fires after a session starts or exits. A throwing listener never disturbs the PTY lifecycle. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try { listener(); } catch { /* a broken listener must not fail a PTY start or exit */ }
    }
  }

  sessionExists(input: CliSessionLookup): boolean {
    return cliSessionExists(input);
  }

  attach(taskId: string, listener: (data: string) => void, onEnd?: () => void): (() => void) | null {
    const session = this.sessions.get(taskId);
    if (!session) return null;
    if (session.buffer) listener(session.buffer);
    session.listeners.add(listener);
    clearTimeout(session.detachedTimer);
    if (onEnd && session.ended) onEnd();
    else if (onEnd) session.endListeners.add(onEnd);
    return () => {
      session.listeners.delete(listener);
      if (onEnd) session.endListeners.delete(onEnd);
      this.scheduleDetachedEnd(session);
    };
  }

  private scheduleDetachedEnd(session: TerminalSession): void {
    if (!session.endWhenDetached || session.ended || session.listeners.size > 0) return;
    clearTimeout(session.detachedTimer);
    session.detachedTimer = setTimeout(() => {
      if (!session.ended && session.listeners.size === 0) session.process.kill();
    }, this.detachedGraceMs);
    session.detachedTimer.unref();
  }

  write(taskId: string, data: string): void {
    const session = this.sessions.get(taskId);
    if (session && !session.ended) session.process.write(data);
  }

  resize(taskId: string, cols: number, rows: number): void {
    const session = this.sessions.get(taskId);
    if (session && !session.ended && cols > 0 && rows > 0) session.process.resize(cols, rows);
  }

  stop(taskId: string): boolean {
    const session = this.sessions.get(taskId);
    if (!session || session.ended) return false;
    session.process.kill();
    return true;
  }

  has(taskId: string): boolean {
    const session = this.sessions.get(taskId);
    return !!session && !session.ended;
  }

  isAttached(taskId: string): boolean {
    return (this.sessions.get(taskId)?.listeners.size ?? 0) > 0;
  }

  /** Live sessions only — an ended PTY stays in `sessions` (nothing ever deletes the entry, only marks `ended`), so counting the map's raw size would count every session ever started on this process, not what's open right now. */
  count(): number {
    return this.liveIds().length;
  }

  /** Ids of the live sessions; `liveIds().length === count()`. */
  liveIds(): string[] {
    return [...this.sessions].filter(([, session]) => !session.ended).map(([id]) => id);
  }
}

export const terminalSessionManager = new TerminalSessionManager();
