import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runClaudeTurn as runClaudeTurnDefault, STATUS_SCHEMA } from '../worker/claudeProcess.ts';
import { runCodexTurn as runCodexTurnDefault } from '../worker/codexProcess.ts';
import { listExecutors as listExecutorsDefault } from '../executors/executorService.ts';
import { getExecutorLimits as getExecutorLimitsDefault } from '../executors/claudeUsage.ts';
import { isCodex, selectLeastUsedExecutor } from '../executors/leastUsedExecutor.ts';
import { untrackedTurn, type BackgroundTurnContext, type BackgroundTurnTracker } from '../analytics/activityRecorder.ts';
import { trackBackgroundTurn } from '../analytics/index.ts';
import type { ExecutorProfile, PlanItemRecord, TaskRecord } from '../domain/types.ts';
import { tasksDb } from '../db/collections.ts';
import { getPlanItem as getPlanItemDefault, updatePlanItem as updatePlanItemDefault } from './planItemService.ts';

/**
 * Names a Task that was created from its description alone (the Tasks panel's prompt box), and a
 * planning session from its opening prompt. The item is saved right away under `provisionalTitle`
 * (a session shows its prompt's first line until then), then one throwaway, tool-less claude/codex
 * turn — on whichever configured agent has used the least of its rate limit — returns a short title
 * as JSON and replaces the placeholder: a scratch directory, `--json-schema`, no Task/Worker.
 */

export const TITLE_MAX_LENGTH = 80;

const TITLER_DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

const SESSION_TITLER_INSTRUCTIONS = `You name planning conversations about a software project. You are given the developer's opening message. Reply with a short, specific title for the conversation: 5 or 6 words (for example "Plan the notification delivery backend"), no trailing period, no quotes. Do not answer the message and do not use any tools. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line), and "title".`;

const TITLER_INSTRUCTIONS = `You name software tasks. You are given one task description written by a developer. Reply with a short, specific title for it: an imperative phrase of at most 8 words (for example "Add retry to webhook delivery"), no trailing period, no quotes. Do not do the task and do not use any tools. Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line), and "title".`;

export const TITLE_SCHEMA = {
  type: 'object',
  properties: { ...STATUS_SCHEMA.properties, title: { type: 'string' } },
  required: ['status', 'message', 'title'],
} as const;

/** The placeholder title shown until the generated one arrives: the description's first line, cut to TITLE_MAX_LENGTH. */
export function provisionalTitle(description: string): string {
  const firstLine = description.trim().split('\n')[0]?.trim() ?? '';
  return firstLine.length > TITLE_MAX_LENGTH ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : firstLine;
}

/** Tidies a model-written title: one line, no wrapping quotes or trailing period, capped length. Empty when nothing usable came back. */
export function cleanGeneratedTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const line = raw.trim().split('\n')[0]?.trim() ?? '';
  const unquoted = line.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').trim();
  return unquoted.length > TITLE_MAX_LENGTH ? `${unquoted.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : unquoted;
}

export type PlanItemTitlerEvent = { type: 'planItem'; planItem: PlanItemRecord } | { type: 'task'; task: TaskRecord };

export interface PlanItemTitlerDeps {
  runClaudeTurn: typeof runClaudeTurnDefault;
  runCodexTurn: typeof runCodexTurnDefault;
  listExecutors: typeof listExecutorsDefault;
  getExecutorLimits: typeof getExecutorLimitsDefault;
  getPlanItem: typeof getPlanItemDefault;
  updatePlanItem: typeof updatePlanItemDefault;
  getTask: (id: string) => Promise<TaskRecord | undefined>;
  updateTask: (id: string, patch: Pick<TaskRecord, 'title'>) => Promise<TaskRecord | undefined>;
  /** Records each title turn as background work. */
  trackTurn: BackgroundTurnTracker;
}

const DEFAULT_DEPS: PlanItemTitlerDeps = {
  runClaudeTurn: runClaudeTurnDefault,
  runCodexTurn: runCodexTurnDefault,
  listExecutors: listExecutorsDefault,
  getExecutorLimits: getExecutorLimitsDefault,
  getPlanItem: getPlanItemDefault,
  updatePlanItem: updatePlanItemDefault,
  getTask: (id) => tasksDb.get(id),
  updateTask: (id, patch) => tasksDb.update(id, patch),
  trackTurn: untrackedTurn,
};

export function createPlanItemTitler(deps: Partial<PlanItemTitlerDeps> = {}) {
  const { runClaudeTurn, runCodexTurn, listExecutors, getExecutorLimits, getPlanItem, updatePlanItem, getTask, updateTask, trackTurn } = { ...DEFAULT_DEPS, ...deps };
  const listeners = new Set<(event: PlanItemTitlerEvent) => void>();

  function onEvent(listener: (event: PlanItemTitlerEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(event: PlanItemTitlerEvent): void {
    for (const listener of listeners) listener(event);
  }

  const pickExecutor = () => selectLeastUsedExecutor({ listExecutors, getExecutorLimits });

  /** Runs one title turn for `description` under `instructions`. Returns '' when the turn gives nothing usable. */
  async function generateTitle(executor: ExecutorProfile, description: string, instructions: string, context: BackgroundTurnContext): Promise<string> {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'agent-visual-os-titler-'));
    try {
      const run = isCodex(executor) ? runCodexTurn : runClaudeTurn;
      const result = await trackTurn(executor, context, () => run({
        cwd: scratchDir,
        prompt: description,
        bin: executor.bin,
        env: executor.env,
        permissionMode: 'default',
        appendSystemPrompt: instructions,
        jsonSchema: TITLE_SCHEMA,
        disallowedTools: TITLER_DISALLOWED_TOOLS,
      }));
      return result.status === 'done' ? cleanGeneratedTitle(result.extra?.title) : '';
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Generates and saves a title for `item`, which was just created under `provisionalTitle`.
   * Leaves the item alone if someone renamed it meanwhile, it was deleted, or the turn failed.
   * Never throws: the placeholder title is a fine outcome.
   */
  async function titlePlanItem(item: PlanItemRecord): Promise<PlanItemRecord | null> {
    try {
      const executor = await pickExecutor();
      if (!executor) return null;
      const title = await generateTitle(executor, item.description, TITLER_INSTRUCTIONS, { purpose: 'Task naming', projectId: item.projectId, planItemId: item.id });
      if (!title) return null;
      const current = await getPlanItem(item.id);
      if (current.title !== item.title) return null;
      const updated = await updatePlanItem(item.id, { title });
      emit({ type: 'planItem', planItem: updated });
      return updated;
    } catch (error) {
      console.error(`Failed to generate a title for plan item ${item.id}:`, error);
      return null;
    }
  }

  /**
   * Generates and saves a 5–6 word title for a just-started planning session (`task`, its first Task),
   * from its opening prompt. Leaves it alone if it was renamed or deleted meanwhile, or the turn failed.
   * Never throws: the prompt's first line is a fine fallback.
   */
  async function titleSession(task: TaskRecord): Promise<TaskRecord | null> {
    try {
      const executor = await pickExecutor();
      if (!executor) return null;
      const title = await generateTitle(executor, task.description, SESSION_TITLER_INSTRUCTIONS, { purpose: 'Session naming', projectId: task.projectId });
      if (!title) return null;
      const current = await getTask(task.id);
      if (!current || current.title) return null;
      const updated = await updateTask(task.id, { title });
      if (!updated) return null;
      emit({ type: 'task', task: updated });
      return updated;
    } catch (error) {
      console.error(`Failed to generate a title for planning session ${task.id}:`, error);
      return null;
    }
  }

  /** Fire-and-forget entry point for the create route. */
  function requestTitle(item: PlanItemRecord): void {
    void titlePlanItem(item);
  }

  /** Fire-and-forget entry point for the start-planning-session route. */
  function requestSessionTitle(task: TaskRecord): void {
    void titleSession(task);
  }

  return { onEvent, selectLeastUsedExecutor: pickExecutor, titlePlanItem, requestTitle, titleSession, requestSessionTitle };
}

export type PlanItemTitler = ReturnType<typeof createPlanItemTitler>;

/** The daemon's one instance — see api/router.ts and api/ws.ts. */
export const planItemTitler = createPlanItemTitler({ trackTurn: trackBackgroundTurn });
