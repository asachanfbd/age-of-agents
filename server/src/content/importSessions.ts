import { randomUUID } from 'node:crypto';
import { normalizeProject } from '../buildings/normalize.ts';
import { importSessionsDb, projectsDb } from '../db/collections.ts';
import type { FileDatabase } from '../db/FileDatabase.ts';
import { studioMcpServer } from '../terminal/studioSessionTool.ts';
import type { TerminalExecutorKind, TerminalSessionHost } from '../terminal/terminalSessionManager.ts';
import { conceptsOfImportSession } from './concepts.ts';
import type { ConceptView } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentNotFoundError } from './errors.ts';
import { IMPORT_START_MESSAGE, importSystemPrompt } from './importInstructions.ts';
import { parseImportedConcept, saveImportedConcept } from './importedConcepts.ts';
import type { ImportedConceptSaved } from './importedConcepts.ts';
import { IMPORT_SESSION_TOOLS } from './studioTabs.ts';

/** What the CLI needs to be relaunched exactly as first started. */
interface ImportSessionSetup { kind: TerminalExecutorKind; bin: string; env: Record<string, string>; systemPrompt: string }

/** The Building's agent session for importing past Concepts. It belongs to no Concept or asset, so it is not a studio session record. */
export interface ImportSessionRecord {
  id: string;
  buildingId: string;
  executorId: string;
  /** The agent's own conversation id: assigned up front for Claude, discovered after launch for Codex. */
  agentSessionId: string | null;
  setup: ImportSessionSetup;
  /** Last known state; the live state is the terminal host's. */
  state: 'running' | 'ended';
  createdAt: string;
  updatedAt: string;
}

/** What the web sees: never the conversation id, the launch environment or any folder path. */
export interface ImportSessionView {
  /** Grows with every view built, so the web can drop an older view that arrives late. */
  rev: number;
  session: { id: string; state: 'running' | 'ended'; executorId: string; createdAt: string; updatedAt: string } | null;
  /** The Concepts this session saved, oldest first. */
  saved: ConceptView[];
  /** Why no session could start; null once one exists. */
  blockedReason: string | null;
}

export type ImportSessionEvent = { type: 'contentImportSession'; buildingId: string; view: ImportSessionView };

export interface ImportSessionsDeps {
  host: TerminalSessionHost;
  sessions?: FileDatabase<ImportSessionRecord>;
  /** The default coding agent, or a 409 saying why there is no usable one. */
  requireAgent: () => Promise<{ id: string; kind: TerminalExecutorKind; bin: string; env: Record<string, string> }>;
  ctxFor: (buildingId: string) => Promise<ContentCtx | null>;
  insights: { statsChanged(ctx: ContentCtx): void };
  emit: (event: ImportSessionEvent) => void;
  /** Why the Building takes no writes now, or null. */
  readOnlyReason?: (buildingId: string) => Promise<string | null>;
}

async function buildingReadOnlyReason(buildingId: string): Promise<string | null> {
  const project = await projectsDb.get(buildingId);
  if (!project) return null;
  const view = normalizeProject(project);
  return view.readOnly ? view.readOnlyReason ?? 'This Building is read-only.' : null;
}

/** Starts from the clock so a view built after a daemon restart still outranks every view the web saw before it. */
let revision = Date.now() * 1000;

/**
 * The live agent session the owner gives past content to. One runs per Building; its records stay after it ends, so the
 * Concepts it saved stay listed and the conversation can be resumed. Every route runs in the Building's write queue.
 */
export function createImportSessions(deps: ImportSessionsDeps) {
  const { host, ctxFor, emit } = deps;
  const sessions = deps.sessions ?? importSessionsDb;
  const readOnlyReason = deps.readOnlyReason ?? buildingReadOnlyReason;
  /** Why a start failed, by Building id, until a start succeeds. */
  const startErrors = new Map<string, string>();

  const isLive = (r: ImportSessionRecord): boolean => r.state === 'running' && host.has(r.id);
  /** The Building's newest session: the one the view shows. */
  const latest = async (buildingId: string): Promise<ImportSessionRecord | undefined> =>
    (await sessions.find((s) => s.buildingId === buildingId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();

  async function view(ctx: ContentCtx): Promise<ImportSessionView> {
    const record = await latest(ctx.buildingId);
    return {
      rev: ++revision,
      session: record ? { id: record.id, state: isLive(record) ? 'running' : 'ended', executorId: record.executorId, createdAt: record.createdAt, updatedAt: record.updatedAt } : null,
      saved: record ? conceptsOfImportSession(ctx, record.id) : [],
      blockedReason: record ? null : startErrors.get(ctx.buildingId) ?? null,
    };
  }

  async function publish(ctx: ContentCtx): Promise<ImportSessionView> {
    const next = await view(ctx);
    emit({ type: 'contentImportSession', buildingId: ctx.buildingId, view: next });
    return next;
  }

  async function update(id: string, patch: Partial<Omit<ImportSessionRecord, 'id'>>): Promise<void> {
    const updated = await sessions.update(id, { ...patch, updatedAt: new Date().toISOString() });
    if (!updated || !patch.state) return;
    const ctx = await ctxFor(updated.buildingId);
    if (ctx) await publish(ctx).catch(() => undefined);
  }

  function launch(record: ImportSessionRecord, cwd: string, resume: boolean, prompt: string): void {
    host.start({
      taskId: record.id, kind: record.setup.kind, bin: record.setup.bin, cwd, env: record.setup.env, prompt, systemPrompt: record.setup.systemPrompt,
      autonomy: 'auto',
      mcpServers: [studioMcpServer(record.id, { tools: IMPORT_SESSION_TOOLS })],
      sessionId: record.agentSessionId,
      resume,
      // The session is not a Task: the daemon must not try to move a Task's state from its lifecycle hooks.
      reportHooks: false,
      onSessionId: (agentSessionId) => { void update(record.id, { agentSessionId }); },
      onExit: (_code, _signal, agentSessionId) => { void update(record.id, { state: 'ended', ...(agentSessionId ? { agentSessionId } : {}) }); },
    });
  }

  /** Records and launches a fresh conversation; nothing stays behind when the launch fails, and the reason shows in the view. */
  async function begin(ctx: ContentCtx): Promise<ImportSessionView> {
    try {
      const executor = await deps.requireAgent();
      const now = new Date().toISOString();
      const record: ImportSessionRecord = {
        id: randomUUID(), buildingId: ctx.buildingId, executorId: executor.id, agentSessionId: executor.kind === 'claude-cli' ? randomUUID() : null,
        setup: { kind: executor.kind, bin: executor.bin, env: executor.env, systemPrompt: importSystemPrompt(ctx.dir) }, state: 'running', createdAt: now, updatedAt: now,
      };
      await sessions.insert(record);
      try { launch(record, ctx.dir, false, IMPORT_START_MESSAGE); } catch (error) { await sessions.delete(record.id); throw error; }
    } catch (error) {
      startErrors.set(ctx.buildingId, (error as Error).message);
      throw error;
    }
    startErrors.delete(ctx.buildingId);
    return publish(ctx);
  }

  const refuseRunning = (record: ImportSessionRecord | undefined): void => {
    if (record && isLive(record)) throw new ContentConflictError('An import session is already running.');
  };

  async function start(ctx: ContentCtx): Promise<ImportSessionView> {
    const record = await latest(ctx.buildingId);
    refuseRunning(record);
    if (record) throw new ContentConflictError('This session has ended. Resume it or start a new session.');
    return begin(ctx);
  }

  async function startNew(ctx: ContentCtx): Promise<ImportSessionView> {
    refuseRunning(await latest(ctx.buildingId));
    return begin(ctx);
  }

  /** A conversation the agent no longer has restarts fresh under the same session, so what it saved stays listed. */
  async function resume(ctx: ContentCtx): Promise<ImportSessionView> {
    const record = await latest(ctx.buildingId);
    if (!record) throw new ContentNotFoundError('There is no session to resume');
    if (host.has(record.id)) return view(ctx);
    const resumable = !!record.agentSessionId && (host.sessionExists?.({ kind: record.setup.kind, env: record.setup.env, sessionId: record.agentSessionId }) ?? true);
    const relaunch = resumable ? record : { ...record, agentSessionId: record.setup.kind === 'claude-cli' ? randomUUID() : null };
    launch(relaunch, ctx.dir, resumable, resumable ? '' : IMPORT_START_MESSAGE);
    await update(record.id, { state: 'running', agentSessionId: relaunch.agentSessionId });
    return view(ctx);
  }

  async function end(ctx: ContentCtx): Promise<ImportSessionView> {
    const record = await latest(ctx.buildingId);
    if (!record || !isLive(record)) return view(ctx);
    host.stop(record.id);
    await update(record.id, { state: 'ended' });
    return view(ctx);
  }

  /** The Building of a live import session; null when the id is no import session, 409 when it has ended. */
  async function liveCtx(sessionId: string): Promise<ContentCtx | null> {
    const record = await sessions.get(sessionId);
    const ctx = record ? await ctxFor(record.buildingId) : null;
    if (!record || !ctx) return null;
    if (!isLive(record)) throw new ContentConflictError('This session has ended');
    return ctx;
  }

  /**
   * The `save_imported_concept` tool. Runs in the Building's write queue, where the session and the Building's read-only
   * state are checked again, so nothing lands after the session ended or the Building was locked.
   */
  async function save(sessionId: string, body: unknown): Promise<ImportedConceptSaved> {
    const ctx = await liveCtx(sessionId);
    if (!ctx) throw new ContentNotFoundError('Import session not found');
    return ctx.exclusive(async () => {
      if (!(await liveCtx(sessionId))) throw new ContentNotFoundError('Import session not found');
      const reason = await readOnlyReason(ctx.buildingId);
      if (reason) throw new ContentConflictError(reason);
      const saved = await saveImportedConcept(ctx, parseImportedConcept(body, ctx.now()), sessionId);
      deps.insights.statsChanged(ctx);
      await publish(ctx);
      return saved;
    });
  }

  async function removeForBuilding(buildingId: string): Promise<void> {
    startErrors.delete(buildingId);
    for (const record of await sessions.find((s) => s.buildingId === buildingId)) {
      host.stop(record.id);
      await sessions.delete(record.id);
    }
  }

  const exists = async (id: string): Promise<boolean> => !!(await sessions.get(id));

  /** After a daemon restart no terminal of the previous process is alive, so anything still marked running has ended. */
  async function markInterruptedEnded(): Promise<void> {
    for (const record of await sessions.find((s) => s.state === 'running' && !host.has(s.id))) await update(record.id, { state: 'ended' });
  }

  return { get: view, start, startNew, resume, end, liveCtx, save, removeForBuilding, exists, markInterruptedEnded };
}

export type ImportSessions = ReturnType<typeof createImportSessions>;
