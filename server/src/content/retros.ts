import { randomUUID } from 'node:crypto';
import { projectsDb } from '../db/collections.ts';
import { redactSecrets } from '../redaction.ts';
import { getConcept, refuseImported } from './concepts.ts';
import type { AssetRow } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { writeMeta } from './db.ts';
import { ContentConflictError, ContentNotFoundError } from './errors.ts';
import { readText, versionOf, writeTextAtomic } from './files.ts';
import { RETRO_REASON_MAX, RETRO_TIMEOUT_MS } from './limits.ts';
import { createRetroAgent } from './retroAgent.ts';
import type { RetroAgent } from './retroAgent.ts';
import { applyChanges, chooseChanges, isWrittenKind, learnInstructions, learnPrompt, parseRetroAnswer, RetroAnswerError, retroInstructions, retroLabel, retroPrompt, retroSkipped } from './retroRules.ts';
import type { ImportedText, RetroAnswer, StyleChange } from './retroRules.ts';
import { changesOf, insertProposal, insertRetro, lastRetro, pendingProposals, proposalRow, setAutoApplyError, settleProposal } from './retroStore.ts';
import type { ProposalDto, ProposalRow, RetroStatusView } from './retroStore.ts';
import type { Platform } from './rules.ts';
import { contentCtx } from './runtime.ts';
import { autoApplyRetro } from './settings.ts';
import { INSIGHTS_FILE, insightsPath, performanceSection } from './insightsInstructions.ts';
import { diffSummary, noteDiskEdit, readStyle, recordStyleHistory, STYLE_VERSION_KEY, styleFile } from './style.ts';
import type { StyleView } from './style.ts';
import { draftsOf } from './studioDrafts.ts';
import { readWritingSkill, writingSkillPath } from './writingSkill.ts';

/** A retro ended or a proposal changed; the web refetches proposals and the asset's retro status. */
export type RetroEvent = { type: 'contentRetro'; buildingId: string; conceptId: string; assetId: string };

export interface RetrosDeps {
  agent?: RetroAgent;
  /** How long to wait for the agent (tests pass a few milliseconds). */
  timeoutMs?: number;
  /** The home folder the default skill path is under (tests pass a temp folder). */
  home?: string;
  /** The Building's content context, or null when the Building is gone. */
  ctxFor?: (buildingId: string) => Promise<ContentCtx | null>;
}

/** What a retro reviews, taken when it starts, so a later reopen or new draft does not change it. */
interface RetroInput {
  conceptId: string; platforms: Platform[]; drafts: { round: number; text: string }[]; finalized: string; label: string; skillFile: string; roundCount: number;
  /** Set for "Learn from this": the imported Concept's finished text, which it reads instead of comparing drafts. */
  imported?: { title: string; script: string | null; posts: ImportedText[] };
}
type Outcome = { status: 'skipped' | 'nothing' } | { status: 'failed'; reason: string } | { status: 'proposal'; answer: RetroAnswer; styleVersion: string };

const TIMEOUT_REASON = `The agent did not answer within ${RETRO_TIMEOUT_MS / 1000} seconds.`;

async function ctxOfBuilding(buildingId: string): Promise<ContentCtx | null> {
  const project = await projectsDb.get(buildingId);
  return project && project.typeId === 'content-studio' ? contentCtx(project) : null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(TIMEOUT_REASON)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const failureReason = (error: unknown): string => {
  const message = error instanceof RetroAnswerError ? `The answer was not the expected JSON (${error.message}).` : error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, RETRO_REASON_MAX);
};

/** The targets and the Insights document in the retro's instructions: the retro agent has no tools, so it gets the text itself. */
async function retroPerformance(ctx: ContentCtx, platforms: Platform[]): Promise<string> {
  const insightsText = (await readText(insightsPath(ctx.dir))).content.trim();
  return `${performanceSection(ctx, platforms, `knowledge/${INSIGHTS_FILE}`)}${insightsText ? `\n\nThe Insights document, as it is now:\n\n${insightsText}` : ''}`;
}

const assetRow = (ctx: ContentCtx, assetId: string): AssetRow | undefined => ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow | undefined;

/**
 * The writing-style retro: after a written asset is finalized (or on Run retro) a one-shot agent compares its drafts
 * with the finalized text and proposes style changes. The agent is awaited outside the Building's write queue; only
 * recording the outcome and applying a proposal go through it. A running retro lives only in memory, so one still
 * running when the daemon stops is never recorded.
 */
export function createRetros(deps: RetrosDeps = {}) {
  const agent = deps.agent ?? createRetroAgent();
  const timeoutMs = deps.timeoutMs ?? RETRO_TIMEOUT_MS;
  const ctxFor = deps.ctxFor ?? ctxOfBuilding;
  const running = new Map<string, { at: number; done: Promise<void> }>();
  const listeners = new Set<(event: RetroEvent) => void>();
  const keyOf = (buildingId: string, assetId: string) => `${buildingId}:${assetId}`;

  const emit = (event: RetroEvent) => { for (const listener of listeners) listener(event); };

  function snapshot(ctx: ContentCtx, asset: AssetRow): RetroInput {
    const post = asset.postId ? ctx.db.prepare('SELECT platform, format FROM posts WHERE id = ?').get(asset.postId) as { platform: Platform; format: string } | undefined : undefined;
    const drafts = draftsOf(ctx, asset.id).map((d) => ({ round: d.round, text: d.text }));
    const platforms = asset.postId ? (post ? [post.platform] : []) : (ctx.db.prepare('SELECT DISTINCT platform FROM posts WHERE conceptId = ?').all(asset.conceptId) as { platform: Platform }[]).map((p) => p.platform);
    return {
      conceptId: asset.conceptId, platforms, drafts, finalized: asset.content ?? '', label: retroLabel(asset.kind, post?.platform ?? null, post?.format ?? null),
      skillFile: writingSkillPath(ctx, deps.home), roundCount: new Set(drafts.map((d) => d.round)).size,
    };
  }

  async function review(ctx: ContentCtx, input: RetroInput): Promise<Outcome> {
    if (!input.imported && retroSkipped(input.drafts.map((d) => d.text), input.finalized)) return { status: 'skipped' };
    try {
      const style = (await readText(styleFile(ctx))).content;
      const skillText = await readWritingSkill(input.skillFile);
      const prompt = input.imported ? learnPrompt({ ...input.imported, style }) : retroPrompt({ label: input.label, drafts: input.drafts, finalized: input.finalized, style });
      const instructions = (input.imported ? learnInstructions : retroInstructions)(skillText, await retroPerformance(ctx, input.platforms));
      const text = await withTimeout(agent.run({ buildingId: ctx.buildingId, prompt, instructions }), timeoutMs);
      const answer = parseRetroAnswer(text, style);
      return answer.changes.length ? { status: 'proposal', answer, styleVersion: versionOf(style) } : { status: 'nothing' };
    } catch (error) {
      return { status: 'failed', reason: failureReason(error) };
    }
  }

  /** Writes the changes to the writing style and logs them; 409 with every failing change when any no longer fits. */
  async function applyProposal(ctx: ContentCtx, row: ProposalRow, changes: StyleChange[], autoApplied: boolean): Promise<void> {
    const before = (await readText(styleFile(ctx))).content;
    const result = applyChanges(before, changes);
    if ('failed' in result) throw new ContentConflictError('Some changes no longer fit the writing style, so nothing was applied.', { failed: result.failed });
    await writeTextAtomic(styleFile(ctx), result.content);
    noteDiskEdit(ctx, before);
    recordStyleHistory(ctx, 'retro', `${row.summary} (${diffSummary(before, result.content)})`, autoApplied);
    writeMeta(ctx.db, STYLE_VERSION_KEY, versionOf(result.content));
    settleProposal(ctx, row, 'applied');
  }

  async function record(ctx: ContentCtx, asset: AssetRow, input: RetroInput, outcome: Outcome): Promise<void> {
    const retroId = randomUUID(), proposalId = randomUUID();
    ctx.db.transaction(() => {
      insertRetro(ctx, {
        id: retroId, assetId: asset.id, conceptId: input.conceptId, status: outcome.status, reason: outcome.status === 'failed' ? outcome.reason : null,
        draftCount: input.drafts.length, roundCount: input.roundCount, sourceKind: input.imported ? 'imported' : 'asset',
      });
      if (outcome.status === 'proposal') {
        insertProposal(ctx, { id: proposalId, retroId, assetId: asset.id, summary: outcome.answer.summary, styleVersion: outcome.styleVersion, changes: outcome.answer.changes });
      }
    })();
    if (outcome.status !== 'proposal' || !autoApplyRetro(ctx)) return;
    const row = proposalRow(ctx, proposalId)!;
    try { await applyProposal(ctx, row, changesOf(row), true); }
    catch (error) {
      const failed = error instanceof ContentConflictError ? (error.details.failed as { reason: string }[] | undefined) : undefined;
      setAutoApplyError(ctx, proposalId, failed ? failed.map((f) => f.reason).join('; ') : failureReason(error));
    }
  }

  async function execute(buildingId: string, asset: AssetRow, input: RetroInput, ctx: ContentCtx): Promise<void> {
    const outcome = await review(ctx, input);
    // The Building may have been deleted while the agent ran; then nothing is written.
    const live = await ctxFor(buildingId);
    if (!live) return;
    await live.exclusive(async () => {
      // A Concept deleted while the agent ran takes its retro with it.
      if (assetRow(live, asset.id)) await record(live, asset, input, outcome);
    });
  }

  function begin(ctx: ContentCtx, asset: AssetRow, input: RetroInput = snapshot(ctx, asset)): void {
    const key = keyOf(ctx.buildingId, asset.id);
    const entry = { at: ctx.now(), done: Promise.resolve() };
    running.set(key, entry);
    entry.done = execute(ctx.buildingId, asset, input, ctx).catch(() => undefined).finally(() => {
      running.delete(key);
      emit({ type: 'contentRetro', buildingId: ctx.buildingId, conceptId: asset.conceptId, assetId: asset.id });
    });
  }

  /** The hook every finalize calls: starts a retro for a written asset, in the background. It never throws, so a finalize never fails because of it. */
  function assetFinalized(ctx: ContentCtx, assetId: string): void {
    try {
      const asset = assetRow(ctx, assetId);
      if (asset && asset.state === 'finalized' && isWrittenKind(asset.kind) && !running.has(keyOf(ctx.buildingId, assetId))) begin(ctx, asset);
    } catch { /* a retro is optional; the finalize already happened */ }
  }

  /** Run retro: 409 unless the asset is a finalized written text with no retro running. */
  function run(ctx: ContentCtx, assetId: string): { status: 'running' } {
    const asset = assetRow(ctx, assetId);
    if (!asset) throw new ContentNotFoundError('That asset does not exist');
    refuseImported(ctx, asset.conceptId);
    if (!isWrittenKind(asset.kind)) throw new ContentConflictError('A retro runs only on a script, a post text or an article.');
    if (asset.state !== 'finalized') throw new ContentConflictError('Finalize the text before running a retro.');
    if (running.has(keyOf(ctx.buildingId, assetId))) throw new ContentConflictError('A retro is already running for this asset.');
    begin(ctx, asset);
    return { status: 'running' };
  }

  /** Learning has no asset of its own, so it is stored on, and runs one at a time per, the Concept's script asset. */
  const scriptAssetOf = (ctx: ContentCtx, conceptId: string): AssetRow =>
    ctx.db.prepare("SELECT * FROM assets WHERE conceptId = ? AND postId IS NULL AND kind = 'script'").get(conceptId) as AssetRow;

  /** What "Learn from this" reads, taken when it starts. */
  function importedInput(ctx: ContentCtx, conceptId: string, script: AssetRow): RetroInput {
    const concept = getConcept(ctx, conceptId);
    const posts = concept.posts.flatMap((p) => p.needs.filter((a) => a.content && isWrittenKind(a.kind)).map((a) => ({ label: retroLabel(a.kind, p.platform, p.format), text: a.content! })));
    return {
      conceptId, platforms: [...new Set(concept.posts.map((p) => p.platform))], drafts: [], finalized: '', label: 'Imported Concept', skillFile: writingSkillPath(ctx, deps.home), roundCount: 0,
      imported: { title: concept.title, script: script.state === 'finalized' ? script.content : null, posts },
    };
  }

  /** "Learn from this": a retro-style run over an imported Concept's finished text. 409 for any other Concept, with no text to read, or while one runs. */
  function learn(ctx: ContentCtx, conceptId: string): { status: 'running' } {
    if (!getConcept(ctx, conceptId).imported) throw new ContentConflictError('Learn from this works only on an imported Concept.');
    const script = scriptAssetOf(ctx, conceptId);
    if (running.has(keyOf(ctx.buildingId, script.id))) throw new ContentConflictError('A learning run for this Concept is already going.');
    const input = importedInput(ctx, conceptId, script);
    if (input.imported!.script === null && !input.imported!.posts.length) throw new ContentConflictError('This Concept has no script or post text to learn from.');
    begin(ctx, script, input);
    return { status: 'running' };
  }

  /** The Concept's last learning run; 404 when there is no such Concept. */
  function learnStatus(ctx: ContentCtx, conceptId: string): RetroStatusView | null {
    getConcept(ctx, conceptId);
    return statusOf(ctx, scriptAssetOf(ctx, conceptId).id);
  }

  function statusOf(ctx: ContentCtx, assetId: string): RetroStatusView | null {
    const live = running.get(keyOf(ctx.buildingId, assetId));
    return live ? { status: 'running', at: new Date(live.at).toISOString() } : lastRetro(ctx, assetId);
  }

  function pendingRow(ctx: ContentCtx, proposalId: string): ProposalRow {
    const row = proposalRow(ctx, proposalId);
    if (!row) throw new ContentNotFoundError('That proposal does not exist');
    if (row.state !== 'pending') throw new ContentConflictError(`This proposal was already ${row.state}.`);
    return row;
  }

  const emitFor = (ctx: ContentCtx, row: ProposalRow) => {
    const asset = assetRow(ctx, row.assetId);
    if (asset) emit({ type: 'contentRetro', buildingId: ctx.buildingId, conceptId: asset.conceptId, assetId: asset.id });
  };

  /** Accept, accept with exclusions, or apply the owner's edited changes. Answers with the writing style as it is now. */
  async function accept(ctx: ContentCtx, proposalId: string, body: Record<string, unknown>): Promise<StyleView> {
    const row = pendingRow(ctx, proposalId);
    await applyProposal(ctx, row, chooseChanges(changesOf(row), body), false);
    emitFor(ctx, row);
    return readStyle(ctx);
  }

  function discard(ctx: ContentCtx, proposalId: string): { proposals: ProposalDto[] } {
    const row = pendingRow(ctx, proposalId);
    settleProposal(ctx, row, 'discarded');
    emitFor(ctx, row);
    return { proposals: pendingProposals(ctx) };
  }

  /** Resolves when every retro running now has been recorded (tests and shutdown). */
  const settled = async (): Promise<void> => { await Promise.all([...running.values()].map((r) => r.done)); };

  function onEvent(listener: (event: RetroEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { assetFinalized, run, learn, learnStatus, statusOf, accept, discard, settled, onEvent };
}

export type Retros = ReturnType<typeof createRetros>;
