import { randomUUID } from 'node:crypto';
import { agentSessionCountersDb, agentSessionsDb } from '../db/collections.ts';
import type { FileDatabase } from '../db/FileDatabase.ts';
import type { ExecutorProfile, ProjectRecord } from '../domain/types.ts';
import { getExecutor } from '../executors/executorService.ts';
import { getProject, projectAbsolutePath } from '../projects/projectService.ts';
import { agentSessionMcpServer, AGENT_SESSION_INSTRUCTIONS } from './agentSessionTool.ts';
import type { McpServerLaunch } from './mcpServers.ts';
import { planTaskMcpServer } from './planTaskTool.ts';
import { terminalSessionManager, type TerminalExecutorKind, type TerminalSessionHost } from './terminalSessionManager.ts';
import { TESTING_TOOL_INSTRUCTIONS, testTaskMcpServer } from './testTaskTool.ts';

/** What the CLI needs to be relaunched exactly as first started (the same idea as `TaskRecord.sessionSetup` + `sessionExecutor`). */
export interface AgentSessionSetup {
  kind: TerminalExecutorKind;
  bin: string;
  env: Record<string, string>;
  systemPrompt: string;
}

export interface AgentSessionRecord {
  id: string;
  projectId: string;
  executorId: string;
  /** The Project's running number for this session; never reused, even after the session is deleted. */
  number: number;
  /** Set once the agent or the person chose a name; until then the default "Terminal <number>" shows. */
  name: string | null;
  /** The agent's own conversation id: assigned up front for Claude, discovered after launch for Codex. */
  agentSessionId: string | null;
  setup: AgentSessionSetup;
  /** Last known state. The live state is the terminal host's (see `toDto`); this one is what a restart leaves behind. */
  state: 'running' | 'ended';
  createdAt: string;
  updatedAt: string;
}

/** The last number handed out for a Project's sessions. Only ever increases. */
export interface AgentSessionCounterRecord {
  id: string;
  last: number;
}

/** What the web sees: nothing that identifies the agent's conversation, the launch environment or the working directory. */
export interface AgentSessionDto {
  id: string;
  projectId: string;
  executorId: string;
  name: string;
  state: 'running' | 'ended';
  createdAt: string;
  updatedAt: string;
}

export type AgentSessionEvent =
  | { type: 'agentSession'; session: AgentSessionDto }
  | { type: 'agentSessionDeleted'; id: string; projectId: string };

export class AgentSessionError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AgentSessionError';
    this.status = status;
  }
}

export const MAX_SESSION_NAME_LENGTH = 80;

export const defaultSessionName = (number: number): string => `Terminal ${number}`;

export const sessionDisplayName = (session: Pick<AgentSessionRecord, 'name' | 'number'>): string =>
  session.name ?? defaultSessionName(session.number);

/** Control characters (newlines included) become spaces; the result must be non-empty and at most MAX_SESSION_NAME_LENGTH. */
export function normalizeSessionName(raw: unknown): string {
  if (typeof raw !== 'string') throw new AgentSessionError('name must be a string', 400);
  const name = raw.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new AgentSessionError('name must not be empty', 400);
  if (name.length > MAX_SESSION_NAME_LENGTH) throw new AgentSessionError(`name must be at most ${MAX_SESSION_NAME_LENGTH} characters`, 400);
  return name;
}

/** The system prompt a session is launched with, and keeps on every resume. */
export function agentSessionSystemPrompt(project: Pick<ProjectRecord, 'name'>): string {
  return `You are working interactively with the user, step by step, on the project "${project.name}", in its checked-out working directory. You may edit files and run shell commands without asking for permission.\n\n${AGENT_SESSION_INSTRUCTIONS}\n\n${TESTING_TOOL_INSTRUCTIONS}`;
}

/** The app tools an Agent session gets, scoped to its own id. Resumed sessions get the same set. */
export function agentSessionMcpServers(sessionId: string): McpServerLaunch[] {
  return [agentSessionMcpServer(sessionId), planTaskMcpServer(sessionId), testTaskMcpServer(sessionId)];
}

export interface AgentSessionsDeps {
  host?: TerminalSessionHost;
  sessions?: FileDatabase<AgentSessionRecord>;
  counters?: FileDatabase<AgentSessionCounterRecord>;
}

export function createAgentSessions(deps: AgentSessionsDeps = {}) {
  const host = deps.host ?? terminalSessionManager;
  const sessions = deps.sessions ?? agentSessionsDb;
  const counters = deps.counters ?? agentSessionCountersDb;
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let numbering: Promise<unknown> = Promise.resolve();

  function emit(event: AgentSessionEvent): void {
    for (const listener of listeners) listener(event);
  }

  function toDto(record: AgentSessionRecord): AgentSessionDto {
    return {
      id: record.id,
      projectId: record.projectId,
      executorId: record.executorId,
      name: sessionDisplayName(record),
      // Running needs both: a live terminal, and no end requested (the kill's exit arrives a moment later).
      state: record.state === 'running' && host.has(record.id) ? 'running' : 'ended',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async function require(id: string): Promise<AgentSessionRecord> {
    const record = await sessions.get(id);
    if (!record) throw new AgentSessionError('Agent session not found', 404);
    return record;
  }

  /** Serialised so two simultaneous starts never share a number. */
  function nextNumber(projectId: string): Promise<number> {
    const next = numbering.then(async () => {
      const current = await counters.get(projectId);
      const last = (current?.last ?? 0) + 1;
      if (current) await counters.update(projectId, { last });
      else await counters.insert({ id: projectId, last });
      return last;
    });
    numbering = next.catch(() => undefined);
    return next;
  }

  async function update(id: string, patch: Partial<Omit<AgentSessionRecord, 'id'>>): Promise<AgentSessionRecord | undefined> {
    const updated = await sessions.update(id, { ...patch, updatedAt: new Date().toISOString() });
    if (updated) emit({ type: 'agentSession', session: toDto(updated) });
    return updated;
  }

  function launch(record: AgentSessionRecord, cwd: string, resume: boolean): void {
    host.start({
      taskId: record.id,
      kind: record.setup.kind,
      bin: record.setup.bin,
      cwd,
      env: record.setup.env,
      prompt: '',
      systemPrompt: record.setup.systemPrompt,
      autonomy: 'auto',
      mcpServers: agentSessionMcpServers(record.id),
      sessionId: record.agentSessionId,
      resume,
      // The session is not a Task: the daemon must not try to move a Task's state from its lifecycle hooks.
      reportHooks: false,
      onSessionId: (agentSessionId) => { void update(record.id, { agentSessionId }); },
      onExit: (_code, _signal, agentSessionId) => {
        void update(record.id, { state: 'ended', ...(agentSessionId ? { agentSessionId } : {}) });
      },
    });
  }

  async function requireCliExecutor(executorId: unknown): Promise<ExecutorProfile> {
    if (typeof executorId !== 'string' || !executorId) throw new AgentSessionError('executorId is required', 400);
    const executor = await getExecutor(executorId);
    if (!executor) throw new AgentSessionError('Coding agent not found', 404);
    if (executor.kind !== 'claude-cli' && executor.kind !== 'codex-cli') {
      throw new AgentSessionError(`${executor.label} cannot run an interactive terminal; pick a Claude or Codex CLI agent`, 422);
    }
    return executor;
  }

  async function list(projectId: string): Promise<AgentSessionDto[]> {
    await getProject(projectId);
    return (await sessions.find((s) => s.projectId === projectId)).map(toDto);
  }

  async function create(projectId: string, executorId: unknown): Promise<AgentSessionDto> {
    const project = await getProject(projectId);
    const executor = await requireCliExecutor(executorId);
    const now = new Date().toISOString();
    const record: AgentSessionRecord = {
      id: randomUUID(),
      projectId: project.id,
      executorId: executor.id,
      number: await nextNumber(project.id),
      name: null,
      agentSessionId: executor.kind === 'claude-cli' ? randomUUID() : null,
      setup: { kind: executor.kind, bin: executor.bin, env: executor.env, systemPrompt: agentSessionSystemPrompt(project) },
      state: 'running',
      createdAt: now,
      updatedAt: now,
    };
    await sessions.insert(record);
    try {
      launch(record, projectAbsolutePath(project), false);
    } catch (error) {
      await sessions.delete(record.id);
      throw error;
    }
    emit({ type: 'agentSession', session: toDto(record) });
    return toDto(record);
  }

  /** Reopens an ended session's agent conversation with its original permissions; a live one is returned as it is. */
  async function resume(id: string): Promise<AgentSessionDto> {
    const record = await require(id);
    if (host.has(id)) return toDto(record);
    const project = await getProject(record.projectId);
    // No stored conversation (the agent never reported one) or one the agent has lost: start the agent afresh instead of failing.
    const resumable = !!record.agentSessionId
      && (host.sessionExists?.({ kind: record.setup.kind, env: record.setup.env, sessionId: record.agentSessionId }) ?? true);
    const fresh = resumable ? record : { ...record, agentSessionId: record.setup.kind === 'claude-cli' ? randomUUID() : null };
    launch(fresh, projectAbsolutePath(project), resumable);
    const updated = (await update(id, { state: 'running', agentSessionId: fresh.agentSessionId })) ?? record;
    return toDto(updated);
  }

  async function rename(id: string, rawName: unknown): Promise<AgentSessionDto> {
    const name = normalizeSessionName(rawName);
    await require(id);
    const updated = await update(id, { name });
    if (!updated) throw new AgentSessionError('Agent session not found', 404);
    return toDto(updated);
  }

  /** Kills the terminal but keeps the record, so the session can be resumed. */
  async function end(id: string): Promise<AgentSessionDto> {
    const record = await require(id);
    host.stop(id);
    const updated = (await update(id, { state: 'ended' })) ?? record;
    return toDto(updated);
  }

  async function remove(id: string): Promise<void> {
    const record = await require(id);
    host.stop(id);
    await sessions.delete(id);
    emit({ type: 'agentSessionDeleted', id, projectId: record.projectId });
  }

  /** Stops every terminal of a Project's sessions as the Project is deleted. The records go with the Project's other records. */
  async function stopAllForProject(projectId: string): Promise<void> {
    for (const record of await sessions.find((s) => s.projectId === projectId)) {
      host.stop(record.id);
      emit({ type: 'agentSessionDeleted', id: record.id, projectId });
    }
  }

  /** The Project behind an agent-facing tool call, or null when `id` is not an Agent session (so callers can fall back to Tasks). */
  async function projectIdOf(id: string): Promise<string | null> {
    const record = await sessions.get(id);
    if (!record) return null;
    if (!host.has(id)) throw new AgentSessionError('This Agent session is not running', 409);
    return record.projectId;
  }

  async function exists(id: string): Promise<boolean> {
    return !!(await sessions.get(id));
  }

  /** After a daemon restart no terminal of the previous process is alive, so anything still marked running has ended. */
  async function markInterruptedEnded(): Promise<void> {
    const stale = await sessions.find((s) => s.state === 'running' && !host.has(s.id));
    for (const record of stale) await update(record.id, { state: 'ended' });
  }

  function onEvent(listener: (event: AgentSessionEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { list, create, resume, rename, end, remove, stopAllForProject, exists, projectIdOf, markInterruptedEnded, onEvent };
}

export type AgentSessions = ReturnType<typeof createAgentSessions>;

export const agentSessions = createAgentSessions();
