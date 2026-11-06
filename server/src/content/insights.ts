import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeProject } from '../buildings/normalize.ts';
import { projectsDb } from '../db/collections.ts';
import { redactSecrets } from '../redaction.ts';
import type { ContentCtx } from './context.ts';
import { deleteMeta, readMeta, writeMeta } from './db.ts';
import { ContentConflictError } from './errors.ts';
import { readText, versionOf, writeTextAtomic } from './files.ts';
import { INSIGHTS_DEBOUNCE_MS, INSIGHTS_HISTORY_MAX, INSIGHTS_REASON_MAX, INSIGHTS_TIMEOUT_MS } from './limits.ts';
import { createInsightsAgent, INSIGHTS_DATA_FILE } from './insightsAgent.ts';
import type { InsightsAgent } from './insightsAgent.ts';
import { InsightsAnswerError, parseInsightsAnswer } from './insightsAnswer.ts';
import { insightsInstructions, insightsPath } from './insightsInstructions.ts';
import { contentJobs } from './jobs.ts';
import { INSIGHTS_POSTS_MAX, performanceItems } from './performance.ts';
import { contentCtx } from './runtime.ts';
import { evaluationDays, readAllTargets } from './targets.ts';
import { parseSectionContent, parseVersion } from './versioned.ts';

export type InsightsTrigger = 'stats' | 'targets' | 'manual';
export type InsightsState = 'never-run' | 'ready' | 'running' | 'failed';

export interface InsightsView {
  state: InsightsState;
  /** The generated document, without the owner notes; empty before the first refresh. */
  markdown: string;
  notes: string;
  notesVersion: string;
  lastError: { reason: string; at: string } | null;
  updatedAt: string | null;
  postCount: number | null;
  /** When the debounced refresh will start; null when none is waiting. */
  nextRefreshAt: string | null;
}
export interface InsightsVersion { id: number; at: string; trigger: InsightsTrigger; markdown: string; postCount: number }

export interface InsightsDeps {
  agent?: InsightsAgent;
  timeoutMs?: number;
  debounceMs?: number;
  /** Runs `fn` after `ms` and returns a function that cancels it (tests pass a manual clock). */
  schedule?: (fn: () => void, ms: number) => () => void;
  ctxFor?: (buildingId: string) => Promise<ContentCtx | null>;
  isReadOnly?: (buildingId: string) => Promise<boolean>;
}

const NOTES_KEY = 'insightsNotes';
const ERROR_KEY = 'insightsLastError';
export const NOTHING_TO_LEARN = 'No published post has stats yet, so there is nothing to learn from.';
const STOPPED = 'The refresh was stopped';

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
async function ctxOfBuilding(buildingId: string): Promise<ContentCtx | null> {
  const project = await projectsDb.get(buildingId);
  return project && project.typeId === 'content-studio' ? contentCtx(project) : null;
}
async function readOnlyBuilding(buildingId: string): Promise<boolean> {
  const project = await projectsDb.get(buildingId);
  return !project || normalizeProject(project).readOnly;
}

const notesOf = (ctx: ContentCtx): string => readMeta(ctx.db, NOTES_KEY) ?? '';
const lastVersion = (ctx: ContentCtx): (InsightsVersion & { atMs: number }) | undefined => {
  const row = ctx.db.prepare('SELECT * FROM insights_history ORDER BY id DESC LIMIT 1').get() as { id: number; at: number; trigger: InsightsTrigger; markdown: string; postCount: number } | undefined;
  return row && { id: row.id, atMs: row.at, at: new Date(row.at).toISOString(), trigger: row.trigger, markdown: row.markdown, postCount: row.postCount };
};

/** `knowledge/insights.md` as agents read it: the owner notes on top, then the generated text. */
export function composeInsightsFile(notes: string, generated: string): string {
  return `# Insights\n\n## Owner notes\n\n${notes.trim() || '(none)'}\n\n${generated.trim() || '_Not generated yet: no published post has stats._'}\n`;
}
/** Writes the file from what is stored, so an agent's edit of it on disk never survives the next write. */
export const writeInsightsFile = (ctx: ContentCtx): Promise<void> => writeTextAtomic(insightsPath(ctx.dir), composeInsightsFile(notesOf(ctx), lastVersion(ctx)?.markdown ?? ''));

export function insightsHistory(ctx: ContentCtx): InsightsVersion[] {
  const rows = ctx.db.prepare('SELECT * FROM insights_history ORDER BY id DESC LIMIT ?').all(INSIGHTS_HISTORY_MAX) as Array<{ id: number; at: number; trigger: InsightsTrigger; markdown: string; postCount: number }>;
  return rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), trigger: r.trigger, markdown: r.markdown, postCount: r.postCount }));
}

interface BuildingRun { abort: AbortController; follow: boolean; /** Stopped by the person or by the Building going away, as opposed to timing out. */ stopped: boolean }

/**
 * The living Insights document. A headless agent rewrites it from the published posts' stats. It refreshes on demand,
 * after a target change, and `debounceMs` after the last stats change. The agent runs outside the Building's write
 * queue; only recording its answer goes through it. A failed run keeps the previous document.
 */
export function createInsights(deps: InsightsDeps = {}) {
  const agent = deps.agent ?? createInsightsAgent();
  const timeoutMs = deps.timeoutMs ?? INSIGHTS_TIMEOUT_MS;
  const debounceMs = deps.debounceMs ?? INSIGHTS_DEBOUNCE_MS;
  const schedule = deps.schedule ?? defaultSchedule;
  const ctxFor = deps.ctxFor ?? ctxOfBuilding;
  const isReadOnly = deps.isReadOnly ?? readOnlyBuilding;
  const runs = new Map<string, BuildingRun>();
  const timers = new Map<string, { cancel: () => void; dueAt: number }>();

  const clearTimer = (buildingId: string) => { timers.get(buildingId)?.cancel(); timers.delete(buildingId); };

  function view(ctx: ContentCtx): InsightsView {
    const last = lastVersion(ctx);
    const raw = readMeta(ctx.db, ERROR_KEY);
    const lastError = raw ? (JSON.parse(raw) as { reason: string; at: string }) : null;
    const notes = notesOf(ctx);
    const state: InsightsState = runs.has(ctx.buildingId) ? 'running' : lastError ? 'failed' : last ? 'ready' : 'never-run';
    const due = timers.get(ctx.buildingId)?.dueAt;
    return {
      state, markdown: last?.markdown ?? '', notes, notesVersion: versionOf(notes), lastError, updatedAt: last?.at ?? null, postCount: last?.postCount ?? null,
      nextRefreshAt: due === undefined ? null : new Date(due).toISOString(),
    };
  }

  const failureReason = (error: unknown): string => {
    const message = error instanceof InsightsAnswerError ? `The answer was not the expected JSON (${error.message}).` : error instanceof Error ? error.message : String(error);
    return redactSecrets(message).slice(0, INSIGHTS_REASON_MAX);
  };

  async function record(ctx: ContentCtx, trigger: InsightsTrigger, markdown: string, postCount: number): Promise<void> {
    ctx.db.transaction(() => {
      ctx.db.prepare('INSERT INTO insights_history (at, trigger, markdown, postCount) VALUES (?, ?, ?, ?)').run(ctx.now(), trigger, markdown, postCount);
      ctx.db.prepare('DELETE FROM insights_history WHERE id NOT IN (SELECT id FROM insights_history ORDER BY id DESC LIMIT ?)').run(INSIGHTS_HISTORY_MAX);
      deleteMeta(ctx.db, ERROR_KEY);
    })();
    await writeInsightsFile(ctx);
  }

  function dataOf(ctx: ContentCtx): { postCount: number; json: string } {
    const posts = performanceItems(ctx, { limit: INSIGHTS_POSTS_MAX }, { statslessImported: true });
    const json = JSON.stringify({
      timeZone: ctx.timezone(), evaluationDays: evaluationDays(ctx), targets: readAllTargets(ctx), posts,
      previousInsights: lastVersion(ctx)?.markdown ?? null, ownerNotes: notesOf(ctx),
    }, null, 2);
    return { postCount: posts.length, json };
  }

  async function execute(ctx: ContentCtx, trigger: InsightsTrigger, run: BuildingRun, jobId: string, data: { postCount: number; json: string }): Promise<void> {
    const scratch = await mkdtemp(path.join(tmpdir(), 'agent-visual-os-insights-data-'));
    let timer: NodeJS.Timeout | undefined;
    let status: 'complete' | 'failed' | 'stopped' = 'complete', error: string | undefined;
    try {
      const dataFile = path.join(scratch, INSIGHTS_DATA_FILE);
      await writeFile(dataFile, data.json, 'utf8');
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { run.abort.abort(); reject(new Error(`The agent did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)); }, timeoutMs);
      });
      const text = await Promise.race([agent.run({ buildingId: ctx.buildingId, dataFile, instructions: insightsInstructions(), signal: run.abort.signal }), timeout]);
      if (run.stopped) throw new Error(STOPPED);
      const markdown = parseInsightsAnswer(text);
      const live = await ctxFor(ctx.buildingId);
      if (live && !run.stopped) await live.exclusive(() => record(live, trigger, markdown, data.postCount));
    } catch (e) {
      if (run.stopped) status = 'stopped';
      else {
        status = 'failed';
        error = failureReason(e);
        const live = await ctxFor(ctx.buildingId);
        if (live) await live.exclusive(async () => writeMeta(live.db, ERROR_KEY, JSON.stringify({ reason: error, at: new Date(live.now()).toISOString() })));
      }
    } finally {
      clearTimeout(timer);
      await rm(scratch, { recursive: true, force: true });
      runs.delete(ctx.buildingId);
      contentJobs.end(jobId, status, error);
      if (run.follow && status !== 'stopped') await ctxFor(ctx.buildingId).then((live) => live && fireNow(live, 'stats')).catch(() => undefined);
    }
  }

  /** Starts a refresh. 409 when one is running, or when no published post has stats. */
  function start(ctx: ContentCtx, trigger: InsightsTrigger): { status: 'running' } {
    if (runs.has(ctx.buildingId)) throw new ContentConflictError('An insights refresh is already running.');
    const data = dataOf(ctx);
    if (!data.postCount) throw new ContentConflictError(NOTHING_TO_LEARN);
    clearTimer(ctx.buildingId);
    const run: BuildingRun = { abort: new AbortController(), follow: false, stopped: false };
    runs.set(ctx.buildingId, run);
    const jobId = contentJobs.begin({ buildingId: ctx.buildingId, kind: 'insights' });
    void execute(ctx, trigger, run, jobId, data);
    return { status: 'running' };
  }

  /** A refresh for an event: a run in flight gets exactly one follow-up; nothing to learn from is not an error. */
  function fireNow(ctx: ContentCtx, trigger: InsightsTrigger): void {
    const running = runs.get(ctx.buildingId);
    if (running) { running.follow = true; return; }
    try { start(ctx, trigger); } catch (e) { if (!(e instanceof ContentConflictError)) throw e; }
  }

  /** A stats save, edit or delete: the refresh starts `debounceMs` after the last one. */
  function statsChanged(ctx: ContentCtx): void {
    const running = runs.get(ctx.buildingId);
    if (running) { running.follow = true; return; }
    clearTimer(ctx.buildingId);
    const id = ctx.buildingId;
    const cancel = schedule(() => {
      timers.delete(id);
      void (async () => {
        const live = await ctxFor(id);
        if (live && !(await isReadOnly(id))) fireNow(live, 'stats');
      })().catch(() => undefined);
    }, debounceMs);
    timers.set(id, { cancel, dueAt: ctx.now() + debounceMs });
  }

  /** A target change refreshes at once (joining a run in flight). */
  const targetsChanged = (ctx: ContentCtx): void => fireNow(ctx, 'targets');

  function stop(ctx: ContentCtx): { status: 'stopped' } {
    const run = runs.get(ctx.buildingId);
    if (!run) throw new ContentConflictError('No insights refresh is running.');
    run.follow = false;
    run.stopped = true;
    run.abort.abort();
    return { status: 'stopped' };
  }

  /** Owner notes, saved unless they changed since the caller read them. */
  async function putNotes(ctx: ContentCtx, body: Record<string, unknown>): Promise<{ content: string; version: string }> {
    const content = parseSectionContent(body.content), version = parseVersion(body.version);
    const current = versionOf(notesOf(ctx));
    if (current !== version) throw new ContentConflictError('Changed since you opened it', { current });
    writeMeta(ctx.db, NOTES_KEY, content);
    await writeInsightsFile(ctx);
    return { content, version: versionOf(content) };
  }

  /** Makes sure the file agents are pointed at exists (older Buildings have none). */
  async function ensureFile(ctx: ContentCtx): Promise<void> {
    if (!(await readText(insightsPath(ctx.dir))).changedAt) await writeInsightsFile(ctx);
  }

  /** The Building is deleted or closed: its timer is dropped and a run in flight is stopped. */
  function forget(buildingId: string): void {
    clearTimer(buildingId);
    const run = runs.get(buildingId);
    if (run) { run.follow = false; run.stopped = true; run.abort.abort(); }
  }

  function refresh(ctx: ContentCtx): { status: 'running' } {
    return start(ctx, 'manual');
  }

  return { view, history: insightsHistory, refresh, stop, putNotes, ensureFile, statsChanged, targetsChanged, forget };
}

export type Insights = ReturnType<typeof createInsights>;
export const insights = createInsights();
