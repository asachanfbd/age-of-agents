import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { projectsDb, studioSessionsDb } from '../db/collections.ts';
import type { FileDatabase } from '../db/FileDatabase.ts';
import { defaultExecutor } from '../executors/defaultExecutorInstance.ts';
import { getExecutor } from '../executors/executorService.ts';
import { studioMcpServer } from '../terminal/studioSessionTool.ts';
import { terminalSessionManager, type TerminalExecutorKind, type TerminalSessionHost } from '../terminal/terminalSessionManager.ts';
import { assetRowOf, conceptDir, getConcept, nextAssetRound, postOfAsset, refuseImported, scriptFile, setAssetState, usedByPublishedPost } from './concepts.ts';
import type { AssetRow, ConceptView, PostView } from './concepts.ts';
import {
  archiveConceptCode, archiveStills, archiveThumbnail, restoreConceptCode, restoreStills, restoreThumbnail, cancelSetup, ensureProject, isProjectReady, remotionDir, removeConceptFromProject,
  removePostFromProject, scaffoldConcept, scaffoldStills, scaffoldThumbnail, compositionIdFor, stillPrefixFor, thumbPrefixFor,
} from './remotionProject.ts';
import { listBrandFiles } from './brandFiles.ts';
import { readColours } from './knowledge.ts';
import { defaultImageSize, parseAltText } from './imageRules.ts';
import { imagesSystemPrompt } from './imageInstructions.ts';
import { createImageStudio } from './imageStudio.ts';
import type { ImagesPart } from './imageStudio.ts';
import { thumbnailSystemPrompt } from './thumbnailInstructions.ts';
import { THUMBNAIL_SIZE } from './thumbnailRules.ts';
import { createThumbnailStudio } from './thumbnailStudio.ts';
import type { ThumbnailPart } from './thumbnailStudio.ts';
import { assetsToStart } from './studioDependencies.ts';
import type { AutoStart } from './studioDependencies.ts';
import type { AssetKind } from './rules.ts';
import { speakingSpeed } from './speakingSpeed.ts';
import { markScriptChanged } from './videoChecklist.ts';
import { videoSystemPrompt } from './videoInstructions.ts';
import { performanceSection } from './insightsInstructions.ts';
import { insights } from './insights.ts';
import { parsePerformanceQuery, parseReferenceQuery, performanceItems } from './performance.ts';
import { createImportSessions } from './importSessions.ts';
import type { ImportSessionEvent, ImportSessionRecord } from './importSessions.ts';
import { referenceItems, referenceSection } from './referenceContent.ts';
import { listMedia as conceptMedia, probeMedia, receiveMedia, unprobedMedia } from './videoMedia.ts';
import type { MediaItem, UploadInput } from './videoMedia.ts';
import { createVideoStudio, finalizedVideo, videoAssetOf } from './videoStudio.ts';
import type { VideoPart } from './videoStudio.ts';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentNotFoundError } from './errors.ts';
import { commentMessage, parseLineComment, splitDraftLines } from './studioComments.ts';
import { typeIntoSession } from './typeIntoSession.ts';
import { draftsOf, insertDraft, latestDraft, parseDraftText } from './studioDrafts.ts';
import type { StudioDraft } from './studioDrafts.ts';
import { removeFile, writeTextAtomic } from './files.ts';
import { resumeContext, studioSystemPrompt } from './studioInstructions.ts';
import type { PostBrief } from './studioInstructions.ts';
import { STUDIO_TABS, studioTabFor } from './studioTabs.ts';
import type { StudioTabDefinition } from './studioTabs.ts';
import { readWritingSkill, writingSkillPath } from './writingSkill.ts';
import { contentCtx } from './runtime.ts';
import { videoDeps } from './videoDeps.ts';
import { createRetros } from './retros.ts';
import type { RetroEvent, Retros } from './retros.ts';
import type { RetroStatusView } from './retroStore.ts';

/** What the CLI needs to be relaunched exactly as first started. */
export interface StudioSessionSetup {
  kind: TerminalExecutorKind;
  bin: string;
  env: Record<string, string>;
  systemPrompt: string;
}

/** One round of one asset's agent pane. It is not a Task: no branch, worktree, concurrency slot or board card. */
export interface StudioSessionRecord {
  id: string;
  buildingId: string;
  conceptId: string;
  assetId: string;
  tab: string;
  round: number;
  executorId: string;
  /** The agent's own conversation id: assigned up front for Claude, discovered after launch for Codex. */
  agentSessionId: string | null;
  setup: StudioSessionSetup;
  /** Set when the writing skill file could not be read at start. */
  skillWarning: string | null;
  /** Last known state; the live state is the terminal host's (see `toDto`). */
  state: 'running' | 'ended';
  createdAt: string;
  updatedAt: string;
}

/** What the web sees: never the conversation id, the launch environment or any folder path. */
export interface StudioSessionDto {
  id: string;
  conceptId: string;
  assetId: string;
  tab: string;
  round: number;
  state: 'running' | 'ended';
  executorId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioRoundView { round: number; startedAt: string; draft: { text: string; savedAt: string } | null }

export interface StudioView {
  /** Grows with every view built, so the web can drop an older view that arrives late. */
  rev: number;
  conceptId: string;
  assetId: string;
  asset: { state: AssetRow['state']; round: number; finalizedAt: string | null; /** The finalized text; null unless finalized. */ content: string | null };
  session: StudioSessionDto | null;
  rounds: StudioRoundView[];
  skillWarning: string | null;
  /** Why the asset has no session although it should (no usable agent, ...); null once a session exists. The Video, Images and Thumbnail parts carry the same reason. */
  blockedReason: string | null;
  /** The asset's last writing-style retro (running included), or null when it never had one. */
  retro: RetroStatusView | null;
  /** The Video tab's checklist, renders, media and setup; only on the video asset. */
  video?: VideoPart;
  /** The Images tab's renders, round images and setup; only on an image-set asset. */
  images?: ImagesPart;
  /** The Thumbnail tab's renders, round thumbnails, setup and the final pick; only on the thumbnail asset. */
  thumbnail?: ThumbnailPart;
}

export interface StudioDraftsView { rounds: { round: number; drafts: StudioDraft[] }[] }

export type StudioEvent = { type: 'studioAsset'; buildingId: string; view: StudioView } | RetroEvent | ImportSessionEvent;

export interface StudioSessionsDeps {
  host?: TerminalSessionHost;
  sessions?: FileDatabase<StudioSessionRecord>;
  /** The default coding agent's id, or null. */
  defaultAgentId?: () => Promise<string | null>;
  /** The Building's content context, or null when the Building is gone. */
  ctxFor?: (buildingId: string) => Promise<ContentCtx | null>;
  /** The home folder the default skill path is under (tests pass a temp folder). */
  home?: string;
  /** The writing-style retro every finalize starts (tests pass one with a fake agent). */
  retros?: Retros;
  /** Import session records (tests pass their own). */
  importRecords?: FileDatabase<ImportSessionRecord>;
  /** What a saved import tells the Insights refresh (tests pass a fake). */
  importInsights?: { statsChanged(ctx: ContentCtx): void };
}

/** Also the web's reason for a disabled Reopen. */
const USED_BY_PUBLISHED = 'Used by a published post';
const NO_AGENT = 'No default coding agent is set. Set one as the default coding agent to start a writing session.';

type Target = { concept: ConceptView; asset: AssetRow; post: PostView | null; tab: StudioTabDefinition };
/** The sections every kind of session carries. */
type SharedSections = { performance: string; reference: string };

const fileExists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);

/** What a post's session is told about its post, the script and the other posts, as they are when it starts. */
async function postBrief(ctx: ContentCtx, t: Target): Promise<PostBrief | null> {
  if (!t.post) return null;
  const script = t.concept.assets.find((a) => a.kind === 'script');
  const file = scriptFile(ctx, t.concept.id);
  const textOf = (p: PostView) => p.needs.find((a) => a.kind === 'post-text' || a.kind === 'article')?.state ?? null;
  return {
    platform: t.post.platform, format: t.post.format, scheduledAt: t.post.scheduledAt, timeZone: ctx.timezone(),
    scriptFile: script?.state === 'finalized' && await fileExists(file) ? file : null,
    others: t.concept.posts.filter((p) => p.id !== t.post!.id).map((p) => ({ platform: p.platform, format: p.format, scheduledAt: p.scheduledAt, textState: textOf(p) })),
  };
}

async function ctxOfBuilding(buildingId: string): Promise<ContentCtx | null> {
  const project = await projectsDb.get(buildingId);
  return project && project.typeId === 'content-studio' ? contentCtx(project) : null;
}

/** Starts from the clock so a view built after a daemon restart still outranks every view the web saw before it. */
let revision = Date.now() * 1000;

export function createStudioSessions(deps: StudioSessionsDeps = {}) {
  const host = deps.host ?? terminalSessionManager;
  const sessions = deps.sessions ?? studioSessionsDb;
  const defaultAgentId = deps.defaultAgentId ?? (() => defaultExecutor.current());
  const ctxFor = deps.ctxFor ?? ctxOfBuilding;
  const retros = deps.retros ?? createRetros({ home: deps.home });
  const listeners = new Set<(event: StudioEvent) => void>();
  const emit = (event: StudioEvent) => { for (const listener of listeners) listener(event); };
  /** Why a pane could not start, by asset id, until a start succeeds. */
  const startErrors = new Map<string, string>();
  /** Video, image-set and thumbnail assets waiting for their Building's Remotion setup to finish before their session starts, by Building id. */
  const waitingForSetup = new Map<string, Set<string>>();
  const imports = createImportSessions({ host, sessions: deps.importRecords, requireAgent: requireDefaultAgent, ctxFor, insights: deps.importInsights ?? insights, emit });
  const video = createVideoStudio({ host, publish, currentSession: async (assetId) => (await roundsOf(assetId)).pop() });
  const images = createImageStudio({ publish, queue: video.queue });
  const thumbnails = createThumbnailStudio({ publish, queue: video.queue });

  const toDto = (r: StudioSessionRecord): StudioSessionDto => ({
    id: r.id, conceptId: r.conceptId, assetId: r.assetId, tab: r.tab, round: r.round,
    // Running needs a live terminal too: a restart or a kill leaves the stored state behind for a moment.
    state: r.state === 'running' && host.has(r.id) ? 'running' : 'ended',
    executorId: r.executorId, createdAt: r.createdAt, updatedAt: r.updatedAt,
  });

  const roundsOf = async (assetId: string): Promise<StudioSessionRecord[]> =>
    (await sessions.find((s) => s.assetId === assetId)).sort((a, b) => a.round - b.round);

  async function view(ctx: ContentCtx, conceptId: string, assetId: string): Promise<StudioView> {
    const asset = assetRowOf(ctx, conceptId, assetId);
    const records = await roundsOf(assetId);
    const current = records[records.length - 1];
    // Read from disk before the rev is taken, so a view's rev follows the order its data was read in.
    const blockedReason = current ? null : startErrors.get(assetId) ?? null;
    const imagesPart = asset.kind === 'image-set' ? await images.part(ctx, asset, blockedReason) : null;
    const thumbnailPart = asset.kind === 'thumbnail' ? await thumbnails.part(ctx, asset, blockedReason) : null;
    return {
      rev: ++revision, conceptId, assetId,
      asset: {
        state: asset.state, round: asset.round,
        finalizedAt: asset.finalizedAt === null ? null : new Date(asset.finalizedAt).toISOString(),
        content: asset.state === 'finalized' ? asset.content : null,
      },
      session: current ? toDto(current) : null,
      rounds: records.map((r) => {
        const draft = latestDraft(ctx, assetId, r.round);
        return { round: r.round, startedAt: r.createdAt, draft: draft && { text: draft.text, savedAt: draft.savedAt } };
      }),
      skillWarning: current?.skillWarning ?? null,
      blockedReason,
      retro: retros.statusOf(ctx, assetId),
      ...(asset.kind === 'video' && { video: video.part(ctx, conceptId, asset, blockedReason) }),
      ...(imagesPart && { images: imagesPart }),
      ...(thumbnailPart && { thumbnail: thumbnailPart }),
    };
  }

  async function publish(ctx: ContentCtx, conceptId: string, assetId: string): Promise<StudioView> {
    const next = await view(ctx, conceptId, assetId);
    emit({ type: 'studioAsset', buildingId: ctx.buildingId, view: next });
    return next;
  }

  // A retro that ends is passed on, and an asset with a pane gets its view again so the retro status follows.
  retros.onEvent((event) => {
    emit(event);
    void (async () => {
      const ctx = await ctxFor(event.buildingId);
      if (ctx && studioTabFor(assetRowOf(ctx, event.conceptId, event.assetId).kind)) await publish(ctx, event.conceptId, event.assetId);
    })().catch(() => undefined);
  });

  async function update(id: string, patch: Partial<Omit<StudioSessionRecord, 'id'>>): Promise<StudioSessionRecord | undefined> {
    const updated = await sessions.update(id, { ...patch, updatedAt: new Date().toISOString() });
    if (updated && patch.state) {
      const ctx = await ctxFor(updated.buildingId);
      if (ctx) await publish(ctx, updated.conceptId, updated.assetId).catch(() => undefined);
    }
    return updated;
  }

  /** `prompt` is the session's first message; empty keeps an existing conversation or starting point as it is. */
  function launch(record: StudioSessionRecord, cwd: string, resume: boolean, prompt: string): void {
    host.start({
      taskId: record.id,
      kind: record.setup.kind,
      bin: record.setup.bin,
      cwd,
      env: record.setup.env,
      prompt,
      systemPrompt: record.setup.systemPrompt,
      autonomy: 'auto',
      mcpServers: [studioMcpServer(record.id, STUDIO_TABS[record.tab]!)],
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

  async function requireDefaultAgent() {
    const id = await defaultAgentId();
    const executor = id ? await getExecutor(id) : undefined;
    if (!executor) throw new ContentConflictError(NO_AGENT);
    if (executor.kind !== 'claude-cli' && executor.kind !== 'codex-cli') {
      throw new ContentConflictError(`${executor.label} cannot run an interactive terminal. Set a Claude or Codex CLI agent as the default coding agent.`);
    }
    return { ...executor, kind: executor.kind };
  }

  async function target(ctx: ContentCtx, conceptId: string, assetId: string): Promise<Target> {
    const concept = getConcept(ctx, conceptId);
    const asset = assetRowOf(ctx, conceptId, assetId);
    const post = postOfAsset(ctx, asset);
    const tab = studioTabFor(asset.kind, post?.platform ?? null);
    if (!tab) throw new ContentNotFoundError('This asset has no agent pane');
    return { concept, asset, post, tab };
  }

  const isVideo = (tab: { tab: string }): boolean => tab.tab === 'video';
  const isImages = (tab: { tab: string }): boolean => tab.tab === 'images';
  const isThumbnail = (tab: { tab: string }): boolean => tab.tab === 'thumbnail';
  /** The Video, Images and Thumbnail tabs work in the Building's shared Remotion project. */
  const usesRemotion = (tab: { tab: string }): boolean => isVideo(tab) || isImages(tab) || isThumbnail(tab);
  /** The agent's working folder: the Concept's folder, or the Building's Remotion project for a video, images or a thumbnail. */
  const cwdOf = (ctx: ContentCtx, record: { tab: string; conceptId: string }): string => (usesRemotion(record) ? remotionDir(ctx) : conceptDir(ctx, record.conceptId));

  /** What an images session is told about its post's text: the finalized text, else the newest draft of any round. */
  function postTextOf(ctx: ContentCtx, post: PostView): { text: string; finalized: boolean } | null {
    const asset = post.needs.find((a) => a.kind === 'post-text');
    if (!asset) return null;
    if (asset.state === 'finalized' && asset.content) return { text: asset.content, finalized: true };
    const draft = draftsOf(ctx, asset.id).pop();
    return draft ? { text: draft.text, finalized: false } : null;
  }

  async function imagesPrompt(ctx: ContentCtx, t: Target, reopened: boolean, skillText: string | null, sections: SharedSections): Promise<string> {
    const post = t.post!;
    const script = t.concept.assets.find((a) => a.kind === 'script');
    const file = scriptFile(ctx, t.concept.id);
    return imagesSystemPrompt({
      concept: t.concept, post, buildingDir: ctx.dir, size: defaultImageSize(post.platform, post.format)!, stillPrefix: stillPrefixFor(ctx, post.id),
      postText: postTextOf(ctx, post), scriptFile: script?.state === 'finalized' && await fileExists(file) ? file : null,
      brandFiles: (await listBrandFiles(ctx)).map((f) => f.name), colours: await readColours(ctx), skillText, reopened, ...sections,
    });
  }

  async function thumbnailPrompt(ctx: ContentCtx, t: Target, reopened: boolean, skillText: string | null, sections: SharedSections): Promise<string> {
    const script = t.concept.assets.find((a) => a.kind === 'script');
    const file = scriptFile(ctx, t.concept.id);
    return thumbnailSystemPrompt({
      concept: t.concept, buildingDir: ctx.dir, size: THUMBNAIL_SIZE, stillPrefix: thumbPrefixFor(ctx, t.concept.id),
      scriptFile: script?.state === 'finalized' && await fileExists(file) ? file : null, video: finalizedVideo(ctx, t.concept.id),
      brandFiles: (await listBrandFiles(ctx)).map((f) => f.name), colours: await readColours(ctx), skillText, reopened, ...sections,
    });
  }

  /** The system prompt of a writing or still-designing tab, which carries the writing skill. */
  async function writingPrompt(ctx: ContentCtx, t: Target, startingText: string | null, reopened: boolean, skillText: string | null, sections: SharedSections): Promise<string> {
    if (isImages(t.tab)) return imagesPrompt(ctx, t, reopened, skillText, sections);
    if (isThumbnail(t.tab)) return thumbnailPrompt(ctx, t, reopened, skillText, sections);
    return studioSystemPrompt({ tab: t.tab, concept: t.concept, buildingDir: ctx.dir, skillText, startingText, post: await postBrief(ctx, t), ...sections });
  }

  /** The system prompt and the skill warning of a new round. */
  async function instructions(ctx: ContentCtx, t: Target, startingText: string | null, reopened: boolean): Promise<{ systemPrompt: string; skillWarning: string | null }> {
    await insights.ensureFile(ctx);
    const platforms = t.post ? [t.post.platform] : t.concept.posts.map((p) => p.platform);
    const sections: SharedSections = { performance: performanceSection(ctx, platforms), reference: referenceSection(ctx, platforms) };
    if (isVideo(t.tab)) {
      return { systemPrompt: videoSystemPrompt({ concept: t.concept, buildingDir: ctx.dir, scriptFile: scriptFile(ctx, t.concept.id), compositionId: compositionIdFor(ctx, t.concept.id), reopened, ...sections }), skillWarning: null };
    }
    const skillFile = writingSkillPath(ctx, deps.home);
    const skillText = await readWritingSkill(skillFile);
    return {
      systemPrompt: await writingPrompt(ctx, t, startingText, reopened, skillText, sections),
      skillWarning: skillText === null ? `Writing skill not found at ${skillFile}` : null,
    };
  }

  /** Records and launches a fresh conversation for `round`; nothing stays behind when the launch fails. */
  async function begin(ctx: ContentCtx, t: Target, round: number, startingText: string | null, reopened = false): Promise<StudioSessionRecord> {
    const executor = await requireDefaultAgent();
    const { systemPrompt, skillWarning } = await instructions(ctx, t, startingText, reopened);
    const now = new Date().toISOString();
    const record: StudioSessionRecord = {
      id: randomUUID(), buildingId: ctx.buildingId, conceptId: t.concept.id, assetId: t.asset.id, tab: t.tab.tab, round, executorId: executor.id,
      agentSessionId: executor.kind === 'claude-cli' ? randomUUID() : null,
      setup: { kind: executor.kind, bin: executor.bin, env: executor.env, systemPrompt },
      skillWarning,
      state: 'running', createdAt: now, updatedAt: now,
    };
    await sessions.insert(record);
    try {
      const cwd = cwdOf(ctx, record);
      await mkdir(cwd, { recursive: true });
      if (isVideo(t.tab)) await scaffoldConcept(ctx, t.concept.id);
      if (isImages(t.tab)) await scaffoldStills(ctx, t.concept.id, t.post!.id);
      if (isThumbnail(t.tab)) await scaffoldThumbnail(ctx, t.concept.id);
      // A reopened asset continues from its starting text or code, so it gets no first message that would rewrite it.
      launch(record, cwd, false, reopened || startingText !== null ? '' : STUDIO_TABS[record.tab]!.startMessage);
    } catch (error) {
      await sessions.delete(record.id);
      throw error;
    }
    startErrors.delete(t.asset.id);
    return record;
  }

  /** Ends the asset's running sessions, except `keepId`. */
  async function endRunning(assetId: string, keepId?: string): Promise<void> {
    for (const record of await sessions.find((s) => s.assetId === assetId && s.state === 'running' && s.id !== keepId)) {
      host.stop(record.id);
      await update(record.id, { state: 'ended' });
    }
  }

  /** The target of an action that would change the asset, which an imported Concept's content refuses. */
  async function changeable(ctx: ContentCtx, conceptId: string, assetId: string): Promise<Target> {
    refuseImported(ctx, conceptId);
    return target(ctx, conceptId, assetId);
  }

  const refuseFinalized = (asset: AssetRow): void => {
    if (asset.state === 'finalized') throw new ContentConflictError('This is finalized. Reopen it to work on it again.');
  };

  async function get(ctx: ContentCtx, conceptId: string, assetId: string): Promise<StudioView> {
    await target(ctx, conceptId, assetId);
    return view(ctx, conceptId, assetId);
  }

  /** Records why a start failed so the pane can show it, then rethrows. */
  async function remembering<T>(assetId: string, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { startErrors.set(assetId, (error as Error).message); throw error; }
  }

  async function start(ctx: ContentCtx, conceptId: string, assetId: string): Promise<StudioView> {
    const t = await changeable(ctx, conceptId, assetId);
    refuseFinalized(t.asset);
    const existing = (await roundsOf(assetId)).find((s) => s.round === Math.max(t.asset.round, 1));
    if (existing) {
      throw new ContentConflictError(host.has(existing.id) ? 'A session is already running for this asset.' : 'This round has ended. Resume it or start a new session.');
    }
    if (usesRemotion(t.tab) && !isProjectReady(ctx)) {
      // The session starts once the shared Remotion project is installed; a failed install runs again on the next start.
      await remembering(assetId, requireDefaultAgent);
      waitFor(ctx, assetId);
      return publish(ctx, conceptId, assetId);
    }
    await remembering(assetId, () => begin(ctx, t, Math.max(t.asset.round, 1), null));
    if (t.asset.state === 'empty') setAssetState(ctx, assetId, 'drafting');
    return publish(ctx, conceptId, assetId);
  }

  /** Queues a Remotion asset's start behind its Building's Remotion setup, starting the setup when none runs. */
  function waitFor(ctx: ContentCtx, assetId: string): void {
    const waiting = waitingForSetup.get(ctx.buildingId) ?? new Set<string>();
    waiting.add(assetId);
    waitingForSetup.set(ctx.buildingId, waiting);
    void ensureProject(ctx, () => { void publishWaiting(ctx); }).then((ok) => afterSetup(ctx, ok));
  }

  async function publishWaiting(ctx: ContentCtx): Promise<void> {
    for (const assetId of waitingForSetup.get(ctx.buildingId) ?? []) {
      const row = ctx.db.prepare('SELECT conceptId FROM assets WHERE id = ?').get(assetId) as { conceptId: string } | undefined;
      if (row) await publish(ctx, row.conceptId, assetId).catch(() => undefined);
    }
  }

  /** Starts every session that waited for the setup, then reads the media that arrived before the tools were there. */
  async function afterSetup(ctx: ContentCtx, ok: boolean): Promise<void> {
    const waiting = [...(waitingForSetup.get(ctx.buildingId) ?? [])];
    waitingForSetup.delete(ctx.buildingId);
    if (!ok) {
      for (const assetId of waiting) await publishAsset(ctx, assetId);
      return;
    }
    for (const assetId of waiting) {
      const row = ctx.db.prepare('SELECT conceptId FROM assets WHERE id = ?').get(assetId) as { conceptId: string } | undefined;
      if (row) await ctx.exclusive(() => start(ctx, row.conceptId, assetId)).catch(() => publishAsset(ctx, assetId));
    }
    for (const media of unprobedMedia(ctx)) {
      if (await probeMedia(ctx, media.conceptId, media.id)) await video.publishVideo(ctx, media.conceptId).catch(() => undefined);
    }
  }

  async function publishAsset(ctx: ContentCtx, assetId: string): Promise<void> {
    const row = ctx.db.prepare('SELECT conceptId FROM assets WHERE id = ?').get(assetId) as { conceptId: string } | undefined;
    if (row) await publish(ctx, row.conceptId, assetId).catch(() => undefined);
  }

  /** A video session that already exists is flagged as working from an older script. */
  async function flagScriptChange(ctx: ContentCtx, conceptId: string): Promise<void> {
    const asset = videoAssetOf(ctx, conceptId);
    const current = (await roundsOf(asset.id)).pop();
    if (!current) return;
    markScriptChanged(ctx, asset.id, current.round);
    await publish(ctx, conceptId, asset.id);
  }

  /**
   * After an asset is finalized, the dependent assets (`studioDependencies.ts`) start in the background, one at a time through
   * the write queue, so the finalize answer never waits for or fails on them. A refusal is kept per asset for its tab to show.
   */
  async function afterFinalized(ctx: ContentCtx, concept: ConceptView, kind: AssetKind): Promise<void> {
    if (kind === 'script') await flagScriptChange(ctx, concept.id);
    if (concept.archived) return;
    const started = new Set((await sessions.find((s) => s.conceptId === concept.id)).map((s) => s.assetId));
    const targets = assetsToStart(concept, kind, (assetId) => started.has(assetId));
    if (targets.length) track(startDependents(ctx, concept.id, targets));
  }

  const background = new Set<Promise<void>>();
  function track(work: Promise<void>): void {
    background.add(work);
    void work.finally(() => background.delete(work));
  }
  /** Resolves when every background start has finished (the tests' way to wait for them). */
  async function settled(): Promise<void> {
    while (background.size) await Promise.allSettled([...background]);
  }

  async function startDependents(ctx: ContentCtx, conceptId: string, targets: AutoStart[]): Promise<void> {
    for (const { assetId } of targets) {
      await ctx.exclusive(() => startIfStillWanted(ctx, conceptId, assetId)).catch(() => publishAsset(ctx, assetId)).catch(() => undefined);
    }
  }

  /** Runs in the write queue, where the Concept may have been archived or deleted, or the post removed, since the finalize. */
  async function startIfStillWanted(ctx: ContentCtx, conceptId: string, assetId: string): Promise<void> {
    const concept = ctx.db.prepare('SELECT archived FROM concepts WHERE id = ?').get(conceptId) as { archived: number } | undefined;
    const asset = ctx.db.prepare('SELECT state FROM assets WHERE id = ? AND conceptId = ?').get(assetId, conceptId) as { state: AssetRow['state'] } | undefined;
    if (!concept || concept.archived === 1 || asset?.state !== 'empty' || (await roundsOf(assetId)).length) return;
    await start(ctx, conceptId, assetId);
  }

  async function newRound(ctx: ContentCtx, conceptId: string, assetId: string): Promise<StudioView> {
    const t = await changeable(ctx, conceptId, assetId);
    refuseFinalized(t.asset);
    if (t.asset.state === 'empty') throw new ContentConflictError('There is no round to replace yet. Open the tab to start the first one.');
    if (usesRemotion(t.tab) && !isProjectReady(ctx)) throw new ContentConflictError('Remotion is still being set up.');
    let next: StudioSessionRecord;
    if (usesRemotion(t.tab)) {
      // Round N+1's agent must never see round N's code: archive first, launch on the fresh scaffold, and put round N's code
      // back when the launch fails.
      await requireDefaultAgent();
      video.stopForAsset(ctx.buildingId, assetId);
      const { round } = t.asset;
      const archive = () => (isVideo(t.tab) ? archiveConceptCode(ctx, conceptId, round) : isThumbnail(t.tab) ? archiveThumbnail(ctx, conceptId, round) : archiveStills(ctx, conceptId, t.post!.id, round));
      const restore = () => (isVideo(t.tab) ? restoreConceptCode(ctx, conceptId, round) : isThumbnail(t.tab) ? restoreThumbnail(ctx, conceptId, round) : restoreStills(ctx, conceptId, t.post!.id, round));
      await archive();
      try {
        next = await begin(ctx, t, t.asset.round + 1, null);
      } catch (error) {
        await restore();
        throw error;
      }
    } else {
      // Launch first: when it cannot start, round N stays exactly as it was.
      next = await begin(ctx, t, t.asset.round + 1, null);
    }
    await endRunning(assetId, next.id);
    nextAssetRound(ctx, assetId);
    return publish(ctx, conceptId, assetId);
  }

  async function resume(ctx: ContentCtx, conceptId: string, assetId: string): Promise<StudioView> {
    const t = await changeable(ctx, conceptId, assetId);
    refuseFinalized(t.asset);
    const record = (await roundsOf(assetId)).pop();
    if (!record) throw new ContentNotFoundError('There is no session to resume');
    if (host.has(record.id)) return view(ctx, conceptId, assetId);
    const resumable = !!record.agentSessionId
      && (host.sessionExists?.({ kind: record.setup.kind, env: record.setup.env, sessionId: record.agentSessionId }) ?? true);
    const last = latestDraft(ctx, assetId, record.round);
    // A conversation the agent no longer has restarts in the same round, with the round's last draft as context.
    const relaunch: StudioSessionRecord = resumable ? record : {
      ...record,
      agentSessionId: record.setup.kind === 'claude-cli' ? randomUUID() : null,
      setup: { ...record.setup, systemPrompt: last ? `${record.setup.systemPrompt}\n\n${resumeContext(last.text)}` : record.setup.systemPrompt },
    };
    // A conversation that is gone and has no draft to continue from restarts with the tab's first message.
    launch(relaunch, cwdOf(ctx, record), resumable, resumable || last ? '' : STUDIO_TABS[record.tab]!.startMessage);
    await update(record.id, { state: 'running', agentSessionId: relaunch.agentSessionId, setup: relaunch.setup });
    return view(ctx, conceptId, assetId);
  }

  /** What a finalized text, image-set or thumbnail asset keeps: the newest draft's text, the image paths, or the owner's pick (`body.file`). */
  async function finalContent(ctx: ContentCtx, asset: AssetRow, body: { file?: unknown }): Promise<string> {
    if (asset.kind === 'image-set') return images.finalizeImages(ctx, asset);
    if (asset.kind === 'thumbnail') return thumbnails.finalizeThumbnail(ctx, asset, body);
    const draft = latestDraft(ctx, asset.id, asset.round);
    if (!draft) throw new ContentConflictError('Save a draft before finalizing.');
    return draft.text;
  }

  async function commitFinalize(ctx: ContentCtx, t: Target, content: string): Promise<StudioView> {
    await endRunning(t.asset.id);
    if (t.asset.kind === 'script') await writeTextAtomic(scriptFile(ctx, t.concept.id), content);
    setAssetState(ctx, t.asset.id, 'finalized', content);
    retros.assetFinalized(ctx, t.asset.id);
    const out = await publish(ctx, t.concept.id, t.asset.id);
    await afterFinalized(ctx, getConcept(ctx, t.concept.id), t.asset.kind);
    return out;
  }

  /** A video finalizes with its own render: when that render succeeds and the round is still the same and still drafting. Runs in the write queue. */
  const finalizeAfterRender = (ctx: ContentCtx, conceptId: string, assetId: string, round: number) => (renderId: string): Promise<void> =>
    ctx.exclusive(async () => {
      const t = await target(ctx, conceptId, assetId);
      if (t.asset.state === 'finalized' || Math.max(t.asset.round, 1) !== round || !video.doneRender(ctx, assetId, renderId)) return;
      await commitFinalize(ctx, t, renderId);
    });

  /**
   * Text, image sets and thumbnails finalize at once; a thumbnail's body names the pick (`{ file }`). A video queues its final render
   * and finalizes when it succeeds: the answer is the view with the render queued.
   */
  async function finalize(ctx: ContentCtx, conceptId: string, assetId: string, body: { file?: unknown } = {}): Promise<StudioView> {
    const t = await changeable(ctx, conceptId, assetId);
    refuseFinalized(t.asset);
    if (t.asset.kind === 'video') {
      video.startFinalRender(ctx, conceptId, t.asset, finalizeAfterRender(ctx, conceptId, assetId, Math.max(t.asset.round, 1)));
      return publish(ctx, conceptId, assetId);
    }
    return commitFinalize(ctx, t, await finalContent(ctx, t.asset, body));
  }

  async function reopen(ctx: ContentCtx, conceptId: string, assetId: string): Promise<StudioView> {
    const t = await changeable(ctx, conceptId, assetId);
    if (t.asset.state !== 'finalized') throw new ContentConflictError('Only a finalized asset can be reopened.');
    if (usedByPublishedPost(ctx, t.asset)) throw new ContentConflictError(USED_BY_PUBLISHED);
    if (usesRemotion(t.tab)) {
      if (!isProjectReady(ctx)) throw new ContentConflictError('Remotion is still being set up.');
      // The finalized round's code stays in place, so the new round continues from it.
      await begin(ctx, t, t.asset.round + 1, null, true);
      if (isVideo(t.tab)) video.carryChecklist(ctx, assetId, t.asset.round, t.asset.round + 1);
    } else {
      await begin(ctx, t, t.asset.round + 1, t.asset.content);
    }
    if (t.asset.kind === 'script') await removeFile(scriptFile(ctx, conceptId));
    setAssetState(ctx, assetId, 'drafting');
    return publish(ctx, conceptId, assetId);
  }

  async function drafts(ctx: ContentCtx, conceptId: string, assetId: string): Promise<StudioDraftsView> {
    await target(ctx, conceptId, assetId);
    const all = draftsOf(ctx, assetId);
    const rounds = [...new Set([...(await roundsOf(assetId)).map((r) => r.round), ...all.map((d) => d.round)])].sort((a, b) => a - b);
    return { rounds: rounds.map((round) => ({ round, drafts: all.filter((d) => d.round === round) })) };
  }

  /**
   * Pastes the owner's comment on one line of the round's draft into the live session, then presses Enter (see
   * `typeIntoSession`). It saves nothing; the agent saves the new draft. `sentChars` is the length pasted; nothing from the
   * CLI confirms delivery, and a CLI still running a turn queues the message until the turn ends.
   */
  async function comment(ctx: ContentCtx, conceptId: string, assetId: string, body: unknown): Promise<{ line: number; sentAt: string; sentChars: number }> {
    const t = await changeable(ctx, conceptId, assetId);
    if (usesRemotion(t.tab)) throw new ContentConflictError('Comments work on text drafts only');
    refuseFinalized(t.asset);
    const input = parseLineComment(body);
    const draft = latestDraft(ctx, assetId, t.asset.round);
    if (!draft) throw new ContentConflictError('There is no draft to comment on yet.');
    if (splitDraftLines(draft.text)[input.line - 1] !== input.lineText) throw new ContentConflictError('The draft changed. Check the line and send again.');
    const session = (await roundsOf(assetId)).pop();
    if (!session || session.round !== t.asset.round || !host.has(session.id)) throw new ContentConflictError('The agent session has ended. Press Resume, then send the comment again.');
    const sentChars = await typeIntoSession(host, session.id, commentMessage(draft.text, input, t.asset.kind === 'script'), videoDeps().submitDelayMs);
    return { line: input.line, sentAt: new Date(ctx.now()).toISOString(), sentChars };
  }

  /** A session an agent tool call is made for: it must exist (404) and be live on a not-finalized asset (409). */
  async function liveSession(sessionId: string): Promise<{ record: StudioSessionRecord; ctx: ContentCtx }> {
    const record = await sessions.get(sessionId);
    const ctx = record ? await ctxFor(record.buildingId) : null;
    if (!record || !ctx) throw new ContentNotFoundError('Studio session not found');
    return { record, ctx };
  }

  function requireWritable(ctx: ContentCtx, record: StudioSessionRecord): void {
    if (record.state !== 'running' || !host.has(record.id)) throw new ContentConflictError('This session has ended');
    const asset = assetRowOf(ctx, record.conceptId, record.assetId);
    if (asset.state === 'finalized') throw new ContentConflictError('This asset is finalized');
    if (asset.round !== record.round) throw new ContentConflictError('This round has ended');
  }

  /**
   * The `save_draft` tool: stores the text as the round's newest draft, within the post's platform limits (a script: only
   * the spoken text). Runs in the Building's write queue, so it never interleaves with a finalize or a post's delete (a session deleted meanwhile is 404).
   */
  async function saveDraft(sessionId: string, rawText: unknown): Promise<{ version: number; round: number; savedAt: string }> {
    const { record, ctx } = await liveSession(sessionId);
    return ctx.exclusive(async () => {
      if (!(await sessions.get(sessionId))) throw new ContentNotFoundError('Studio session not found');
      const asset = assetRowOf(ctx, record.conceptId, record.assetId);
      // An images or thumbnail session saves its alt text: one line per still.
      const text = isImages(record) || isThumbnail(record) ? parseAltText(rawText) : parseDraftText(rawText, postOfAsset(ctx, asset)?.platform ?? null, asset.kind);
      requireWritable(ctx, record);
      if (isVideo(record)) throw new ContentConflictError('The Video tab saves no drafts');
      const draft = insertDraft(ctx, record.assetId, record.round, text);
      await publish(ctx, record.conceptId, record.assetId);
      return { version: draft.id, round: draft.round, savedAt: draft.savedAt };
    });
  }

  /** A Remotion tool call (video, images or thumbnail): a live session of a not-finalized asset in its current round. */
  async function videoTool<T>(sessionId: string, work: (ctx: ContentCtx, record: StudioSessionRecord) => T | Promise<T>): Promise<T> {
    const { record, ctx } = await liveSession(sessionId);
    return ctx.exclusive(async () => {
      requireWritable(ctx, record);
      return work(ctx, record);
    });
  }

  /** The `set_checklist` tool. */
  const setChecklist = (sessionId: string, items: unknown) => videoTool(sessionId, async (ctx, record) => {
    const list = video.toolSetChecklist(ctx, record, items);
    await publish(ctx, record.conceptId, record.assetId);
    return list;
  });

  /** The `report_speaking_rate` tool. Publishes so the web refreshes the speaking speed it shows. */
  const reportSpeakingRate = (sessionId: string, body: Record<string, unknown>) => videoTool(sessionId, async (ctx, record) => {
    const sample = video.toolReportSpeakingRate(ctx, record, body);
    await publish(ctx, record.conceptId, record.assetId);
    return { ...sample, speakingSpeed: speakingSpeed(ctx) };
  });

  /** The `list_media` tool. */
  const listMedia = (sessionId: string) => videoTool(sessionId, (ctx, record) => video.toolListMedia(ctx, record));

  /** The `render_images` tool: checked, recorded and the round's old images removed in the write queue, then rendered outside it. */
  async function renderImages(sessionId: string, body: Record<string, unknown>) {
    const { record, ctx } = await liveSession(sessionId);
    const row = await videoTool(sessionId, (c, r) => images.prepare(c, r, body));
    return images.run(ctx, record, row);
  }

  /** The `render_thumbnails` tool, like `render_images`. */
  async function renderThumbnails(sessionId: string, body: Record<string, unknown>) {
    const { record, ctx } = await liveSession(sessionId);
    const row = await videoTool(sessionId, (c, r) => thumbnails.prepare(c, r, body));
    return thumbnails.run(ctx, record, row);
  }

  /** An upload of the Concept's media; its duration and thumbnail are read before the answer when the tools are there. */
  async function uploadMedia(ctx: ContentCtx, conceptId: string, input: UploadInput): Promise<MediaItem> {
    refuseImported(ctx, conceptId);
    videoAssetOf(ctx, conceptId);
    const item = await receiveMedia(ctx, conceptId, input);
    await probeMedia(ctx, conceptId, item.id);
    await video.publishVideo(ctx, conceptId);
    return conceptMedia(ctx, conceptId).find((m) => m.id === item.id) ?? item;
  }

  /** A session whose terminal is live, whatever its asset's state. */
  async function runningSession(sessionId: string): Promise<{ record: StudioSessionRecord; ctx: ContentCtx }> {
    const live = await liveSession(sessionId);
    if (live.record.state !== 'running' || !host.has(live.record.id)) throw new ContentConflictError('This session has ended');
    return live;
  }

  /** The `get_performance` tool. */
  async function performance(sessionId: string, query: Record<string, unknown>) {
    const { ctx } = await runningSession(sessionId);
    return { posts: performanceItems(ctx, parsePerformanceQuery(query)) };
  }

  /** The `get_reference_content` tool: any session that is still running may read it, an import session included. */
  async function reference(sessionId: string, query: Record<string, unknown>) {
    const ctx = await imports.liveCtx(sessionId) ?? (await runningSession(sessionId)).ctx;
    return { concepts: referenceItems(ctx, parseReferenceQuery(query)) };
  }

  /** The `get_concept` tool. */
  async function conceptOf(sessionId: string): Promise<ConceptView> {
    const { record, ctx } = await liveSession(sessionId);
    requireWritable(ctx, record);
    return getConcept(ctx, record.conceptId);
  }

  async function removeWhere(predicate: (r: StudioSessionRecord) => boolean): Promise<void> {
    for (const record of await sessions.find(predicate)) {
      host.stop(record.id);
      await sessions.delete(record.id);
    }
  }

  const removeForAssets = (assetIds: string[]) => removeWhere((r) => assetIds.includes(r.assetId));
  /** Deleting a post: its sessions end, its image render stops, and its still code leaves the Remotion project. */
  async function removeForPost(ctx: ContentCtx, conceptId: string, postId: string, assetIds: string[]): Promise<void> {
    for (const assetId of assetIds) images.stopForAsset(ctx.buildingId, assetId);
    await removeForAssets(assetIds);
    await removePostFromProject(ctx, conceptId, postId);
  }
  /** Deleting a Concept: its sessions end, its render stops, and its code and media leave the Remotion project. */
  async function removeForConcept(ctx: ContentCtx, conceptId: string): Promise<void> {
    video.stopForConcept(ctx.buildingId, conceptId);
    await removeWhere((r) => r.buildingId === ctx.buildingId && r.conceptId === conceptId);
    await removeConceptFromProject(ctx, conceptId);
  }
  async function removeForBuilding(buildingId: string): Promise<void> {
    await cancelSetup(buildingId);
    waitingForSetup.delete(buildingId);
    video.stopForBuilding(buildingId);
    await removeWhere((r) => r.buildingId === buildingId);
    await imports.removeForBuilding(buildingId);
  }

  const exists = async (id: string): Promise<boolean> => !!(await sessions.get(id)) || imports.exists(id);

  /** After a daemon restart no terminal of the previous process is alive, so anything still marked running has ended. */
  async function markInterruptedEnded(): Promise<void> {
    for (const record of await sessions.find((s) => s.state === 'running' && !host.has(s.id))) await update(record.id, { state: 'ended' });
    await imports.markInterruptedEnded();
  }

  function onEvent(listener: (event: StudioEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    get, start, newRound, resume, finalize, reopen, drafts, comment, saveDraft, conceptOf, performance, reference, removeForAssets, removeForPost, removeForConcept, removeForBuilding, exists, markInterruptedEnded, onEvent, retros, settled,
    setChecklist, reportSpeakingRate, listMedia, renderImages, renderThumbnails, uploadMedia, video, images, thumbnails, imports,
  };
}

export type StudioSessions = ReturnType<typeof createStudioSessions>;

export const studioSessions = createStudioSessions();
