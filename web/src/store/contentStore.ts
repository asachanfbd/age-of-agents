import { create } from 'zustand';
import { contentApi } from '../lib/contentApi';
import type { AcceptBody, AssetDto, CalendarDto, ConceptDto, ConceptPageDto, ExtractionReplyDto, FailedChangeDto, NewPostInput, PostMediaDto, ProposalDto, RetroLogEntryDto, StatDto, StatInput } from '../lib/contentTypes';
import { LEARN_CONFLICT, newerImportView } from '../lib/contentImport';
import type { ImportSessionViewDto } from '../lib/contentImport';
import { retroConflictText } from '../lib/contentRetro';
import { listParams } from '../lib/contentView';
import type { ListFilters } from '../lib/contentView';
import { ApiError } from '../lib/serverApi';
import { failedChangesFrom, missingFrom } from '../lib/contentView';
import type { AssetKind } from '../lib/contentRules';
import { newerView } from '../lib/contentStudio';
import type { RetroStatusDto, StudioEvent, StudioViewDto } from '../lib/contentStudio';
import { dropUpload, nextToStart, patchUpload, planUploads, shareMedia } from '../lib/contentVideo';
import { shareImages } from '../lib/contentImages';
import { shareThumbnail } from '../lib/contentThumbnail';
import type { UploadRow } from '../lib/contentVideo';
import type { RemotionStudioDto, RemotionStudioEvent } from '../lib/contentRemotion';
import type { SpeakingRateSampleDto, SpeakingSpeedDto } from '../lib/contentScript';

export type ContentResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export function contentFailure(error: unknown): ContentResult & { ok: false } {
  if (error instanceof ApiError) return { ok: false, status: error.status, error: error.message };
  return { ok: false, status: 0, error: error instanceof Error ? error.message : 'The request failed' };
}

interface ListView { filters: ListFilters; offset?: number; page: ConceptPageDto | null; loading: boolean; error: string | null }
interface CalendarView { month: string; data: CalendarDto | null; loading: boolean; error: string | null }

export interface ContentState {
  listByProject: Record<string, ListView>;
  calendarByProject: Record<string, CalendarView>;
  conceptsById: Record<string, ConceptDto>;
  /** The assets a refused finalize named, per post, for the inline reason on its row. */
  missingByPost: Record<string, AssetKind[]>;
  /** Each agent pane's latest view, by asset id. */
  studioByAsset: Record<string, StudioViewDto>;
  /** Why an agent pane could not start (no default agent, for one), by asset id. */
  studioBlocked: Record<string, string>;
  /** Snapshots of each published post, newest captured first, by post id. */
  statsByPost: Record<string, StatDto[]>;
  /** What the Publish dialog hands over, by post id. */
  mediaByPost: Record<string, PostMediaDto>;
  publishPost: (id: string, cid: string, pid: string, body: { liveUrl?: string | null; publishedAt?: string }) => Promise<ContentResult>;
  editPublish: (id: string, cid: string, pid: string, body: { liveUrl?: string | null; publishedAt?: string }) => Promise<ContentResult>;
  unpublishPost: (id: string, cid: string, pid: string) => Promise<ContentResult>;
  loadMedia: (id: string, cid: string, pid: string) => Promise<ContentResult>;
  loadStats: (id: string, cid: string, pid: string) => Promise<ContentResult>;
  createStat: (id: string, cid: string, pid: string, body: StatInput) => Promise<ContentResult<{ stat: StatDto }>>;
  patchStat: (id: string, cid: string, pid: string, sid: string, body: Partial<StatInput>) => Promise<ContentResult>;
  deleteStat: (id: string, cid: string, pid: string, sid: string) => Promise<ContentResult>;
  /** The agent reads text and screenshots; a refused request (413, 409, 400) is a failure, an agent that could not read them is `{ ok: true, reply: { ok: false } }`. Nothing is saved. */
  extractStats: (id: string, cid: string, pid: string, text: string, files: Blob[]) => Promise<ContentResult<{ reply: ExtractionReplyDto }>>;
  discardExtraction: (id: string, cid: string, pid: string, eid: string) => Promise<ContentResult>;
  /** Opens a pane: reads it and, with `autoStart` (default) and no session for a not-finalized asset, starts the first round. A refused start is kept in `studioBlocked`, not returned as a failure. */
  openStudio: (id: string, cid: string, aid: string, autoStart?: boolean) => Promise<ContentResult>;
  studioAction: (id: string, cid: string, aid: string, action: 'session/start' | 'session/new-round' | 'session/resume' | 'finalize' | 'reopen', body?: object) => Promise<ContentResult>;
  /** Sends a line comment to the live session; the view is not refetched, since the agent's next draft arrives as an event. */
  sendLineComment: (id: string, cid: string, aid: string, body: { line: number; lineText: string; comment: string }) => Promise<ContentResult<{ sentAt: string }>>;
  /** A live update from the daemon: keeps the newer view and moves the Concept's asset along, so tab rules follow without a refetch. A retro event refetches the proposals and the retro log of a Building already shown. */
  applyStudioEvent: (event: StudioEvent) => void;
  /** Pending writing-style proposals per Building, newest first; also the Writing style tab's badge count. */
  proposalsByProject: Record<string, ProposalDto[]>;
  retroLogByProject: Record<string, RetroLogEntryDto[]>;
  /** The changes a refused accept named, by proposal id. */
  staleByProposal: Record<string, FailedChangeDto[]>;
  /** Grows when a proposal is applied, so a writing-style editor without unsaved edits reloads. */
  styleRevByProject: Record<string, number>;
  /** The Building's speaking speed, read by the Script footer. */
  speakingSpeedByProject: Record<string, SpeakingSpeedDto>;
  loadSpeakingSpeed: (id: string) => Promise<ContentResult>;
  /** The recordings behind the detected speed, oldest first; read by the Settings tab. */
  speakingSamplesByProject: Record<string, SpeakingRateSampleDto[]>;
  loadSpeakingSamples: (id: string) => Promise<ContentResult>;
  deleteSpeakingSample: (id: string, sampleId: string) => Promise<ContentResult>;
  /** "Use detected speed": drops the owner's value. */
  clearManualSpeed: (id: string) => Promise<ContentResult>;
  /** Puts a speed the Settings form just saved. */
  putSpeakingSpeed: (id: string, speed: SpeakingSpeedDto) => void;
  /** Saves only the speed (the Script footer); the Settings tab saves it with its own form. */
  saveSpeakingWpm: (id: string, wpm: number) => Promise<ContentResult>;
  loadProposals: (id: string) => Promise<ContentResult>;
  loadRetroLog: (id: string) => Promise<ContentResult>;
  acceptProposal: (id: string, pid: string, body: AcceptBody) => Promise<ContentResult>;
  discardProposal: (id: string, pid: string) => Promise<ContentResult>;
  /** Run retro on a finalized text; a 409 because one is already running reads as that, in words. */
  runRetro: (id: string, aid: string, kind: AssetKind) => Promise<ContentResult>;
  /** The import session's latest view, by Building id. */
  importByProject: Record<string, ImportSessionViewDto>;
  /** Reads the import session; a view that was just opened (`autoStart`) with no session starts one. A refused start shows as the view's reason. */
  openImport: (id: string, autoStart: boolean) => Promise<ContentResult>;
  importAction: (id: string, action: 'start' | 'resume' | 'new' | 'end') => Promise<ContentResult>;
  /** "Learn from this": each Concept's last run, and why a start was refused. */
  learnByConcept: Record<string, { status: RetroStatusDto | null; refusal: string | null }>;
  loadLearn: (id: string, cid: string) => Promise<ContentResult>;
  startLearn: (id: string, cid: string) => Promise<ContentResult>;
  /** Media uploads in flight or refused, per Concept, newest drop first. */
  uploadsByConcept: Record<string, UploadRow[]>;
  /** Starts the video session by hand (the Start and Retry setup buttons). */
  startVideo: (id: string, cid: string, aid: string) => Promise<ContentResult>;
  uploadMedia: (id: string, cid: string, aid: string, files: File[]) => void;
  cancelUpload: (cid: string, key: string) => void;
  renameMedia: (id: string, cid: string, aid: string, mid: string, name: string) => Promise<ContentResult>;
  deleteMedia: (id: string, cid: string, aid: string, mid: string) => Promise<ContentResult>;
  patchChecklistItem: (id: string, cid: string, aid: string, itemId: string, body: { ticked?: boolean; mediaIds?: string[] }) => Promise<ContentResult>;
  confirmAssets: (id: string, cid: string, aid: string) => Promise<ContentResult>;
  stopRender: (id: string, cid: string, aid: string, rid: string) => Promise<ContentResult>;
  /** Stops a running or waiting image render of an image-set asset. */
  stopImageRender: (id: string, cid: string, aid: string, rid: string) => Promise<ContentResult>;
  stopThumbnailRender: (id: string, cid: string, aid: string, rid: string) => Promise<ContentResult>;
  /** Remotion Studio of each Building (one per Building, shared by its Concepts), by Building id. */
  remotionByBuilding: Record<string, RemotionStudioDto>;
  /** Opening the Remotion tab: reads Studio, then starts it, or reuses the one already starting or running. */
  openRemotion: (id: string) => Promise<ContentResult>;
  /** Start Studio and Retry. */
  startRemotion: (id: string) => Promise<ContentResult>;
  stopRemotion: (id: string) => Promise<ContentResult>;
  /** The tab is visible. A failed heartbeat is silent: the next one, or the live event, catches up. */
  heartbeatRemotion: (id: string) => void;
  applyRemotionEvent: (event: RemotionStudioEvent) => void;
  loadList: (id: string, filters: ListFilters, offset?: number) => Promise<ContentResult>;
  loadCalendar: (id: string, month: string) => Promise<ContentResult>;
  loadConcept: (id: string, cid: string) => Promise<ContentResult>;
  createConcept: (id: string, body: { title: string; brief: string; posts: NewPostInput[] }) => Promise<ContentResult<{ concept: ConceptDto }>>;
  patchConcept: (id: string, cid: string, body: { title?: string; brief?: string; archived?: boolean }) => Promise<ContentResult>;
  deleteConcept: (id: string, cid: string) => Promise<ContentResult>;
  createPost: (id: string, cid: string, body: NewPostInput) => Promise<ContentResult>;
  patchPost: (id: string, cid: string, pid: string, scheduledAt: string) => Promise<ContentResult>;
  deletePost: (id: string, cid: string, pid: string) => Promise<ContentResult>;
  finalizePost: (id: string, cid: string, pid: string) => Promise<ContentResult>;
  unfinalizePost: (id: string, cid: string, pid: string) => Promise<ContentResult>;
}

/** Only the newest request of each kind may change what is shown; an older answer that arrives late is dropped. */
const newest = new Map<string, number>();
const without = <T>(record: Record<string, T>, keys: string[]): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
const claim = (key: string): number => { const n = (newest.get(key) ?? 0) + 1; newest.set(key, n); return n; };

/** Files waiting or uploading, and their cancel handles, by upload row key. */
const uploadFiles = new Map<string, File>();
const uploadAborts = new Map<string, AbortController>();
let uploadSeq = 0;

export const useContentStore = create<ContentState>((set, get) => {
  const putConcept = (concept: ConceptDto) => set((s) => ({ conceptsById: { ...s.conceptsById, [concept.id]: concept } }));
  /** A post change: reload its Concept so the rows, tab rules and progress all follow the server. */
  const refreshConcept = async (id: string, cid: string) => { putConcept(await contentApi.concept(id, cid)); };
  /**
   * Keeps the newer view and moves the asset along wherever the Concept shows it: its own assets (the script, the video) or a
   * post's needs (a post's text, for the switcher chips). Untouched posts keep their object, so their chips do not redraw.
   */
  const putStudio = (incoming: StudioViewDto) => set((s) => {
    const previous = s.studioByAsset[incoming.assetId];
    // Unchanged media items keep their objects, so a render-progress update leaves the media column alone; an unchanged images part keeps its object too.
    const view = incoming.video && previous?.video ? { ...incoming, video: { ...incoming.video, media: shareMedia(previous.video.media, incoming.video.media) } }
      : incoming.images ? { ...incoming, images: shareImages(previous?.images, incoming.images) }
        : incoming.thumbnail ? { ...incoming, thumbnail: shareThumbnail(previous?.thumbnail, incoming.thumbnail) } : incoming;
    const kept = newerView(previous, view);
    const studioByAsset = { ...s.studioByAsset, [view.assetId]: kept };
    let concept = s.conceptsById[kept.conceptId];
    const known = concept && [...concept.assets, ...concept.posts.flatMap((p) => p.needs)].find((a) => a.id === kept.assetId);
    if (!concept || !known) return { studioByAsset };
    // A video session scaffolds the Concept's composition, which enables the Remotion tab.
    const composed = !!(kept.video && kept.session) && concept.compositionId === null;
    if (composed) concept = { ...concept, compositionId: kept.video!.compositionId };
    const { state, round, finalizedAt, content } = kept.asset;
    if (known.state === state && known.round === round && known.finalizedAt === finalizedAt) return composed ? { studioByAsset, conceptsById: { ...s.conceptsById, [concept.id]: concept } } : { studioByAsset };
    const moved = (a: AssetDto): AssetDto => (a.id === kept.assetId ? { ...a, state, round, finalizedAt, content: state === 'finalized' ? content : a.content } : a);
    const assets = concept.assets.map(moved);
    const posts = concept.posts.map((p) => (p.needs.some((a) => a.id === kept.assetId) ? { ...p, needs: p.needs.map(moved) } : p));
    return { studioByAsset, conceptsById: { ...s.conceptsById, [concept.id]: { ...concept, assets, posts } } };
  });
  const setBlocked = (aid: string, reason: string | null) => set((s) => {
    const { [aid]: _old, ...rest } = s.studioBlocked;
    return { studioBlocked: reason ? { ...rest, [aid]: reason } : rest };
  });
  /** Replaces one post's list only, so other posts keep their object references. */
  const putStats = (pid: string, snapshots: StatDto[]) => set((s) => ({ statsByPost: { ...s.statsByPost, [pid]: snapshots } }));
  /** A snapshot change: reload the list and the Concept, whose post carries the latest numbers and their change. */
  const reloadStats = async (id: string, cid: string, pid: string) => {
    const { snapshots } = await contentApi.stats(id, cid, pid);
    putStats(pid, snapshots);
    await refreshConcept(id, cid);
  };
  const putLearn = (cid: string, status: RetroStatusDto | null, refusal: string | null) => set((s) => ({ learnByConcept: { ...s.learnByConcept, [cid]: { status, refusal } } }));
  /** Keeps the newer view; a save the view had not seen also refreshes a Concept list already shown. */
  const putImport = (id: string, incoming: ImportSessionViewDto) => {
    const before = get().importByProject[id];
    const kept = newerImportView(before, incoming);
    set((s) => ({ importByProject: { ...s.importByProject, [id]: kept } }));
    const list = get().listByProject[id];
    if (list && before && kept.saved.some((c) => !before.saved.some((b) => b.id === c.id))) void get().loadList(id, list.filters, list.offset);
  };
  const act = async (work: () => Promise<unknown>): Promise<ContentResult> => { try { await work(); return { ok: true }; } catch (error) { return contentFailure(error); } };
  const putProposals = (id: string, proposals: ProposalDto[]) => set((s) => ({ proposalsByProject: { ...s.proposalsByProject, [id]: proposals } }));
  const clearStale = (pid: string) => set((s) => { const { [pid]: _gone, ...rest } = s.staleByProposal; return { staleByProposal: rest }; });
  const putSpeakingSpeed = (id: string, speed: SpeakingSpeedDto) => set((s) => ({ speakingSpeedByProject: { ...s.speakingSpeedByProject, [id]: speed } }));
  const loadSamples = async (id: string) => { const samples = await contentApi.speakingRateSamples(id); set((s) => ({ speakingSamplesByProject: { ...s.speakingSamplesByProject, [id]: samples } })); };
  const loadProposals = (id: string) => act(async () => putProposals(id, (await contentApi.proposals(id)).proposals));
  const loadRetroLog = (id: string) => act(async () => {
    const { entries } = await contentApi.retroLog(id);
    set((s) => ({ retroLogByProject: { ...s.retroLogByProject, [id]: entries } }));
  });

  /** A Video tab change, then the pane's fresh view (the live update may lag behind the answer). */
  const videoAct = (id: string, cid: string, aid: string, work: () => Promise<unknown>) => act(async () => { await work(); putStudio(await contentApi.studio(id, cid, aid)); });
  const putRemotion = (id: string, studio: RemotionStudioDto) => set((s) => ({ remotionByBuilding: { ...s.remotionByBuilding, [id]: studio } }));
  const remotionAct = (id: string, action: 'start' | 'stop') => act(async () => putRemotion(id, await contentApi.remotionStudioAction(id, action)));
  const setUploads = (cid: string, change: (rows: UploadRow[]) => UploadRow[]) => set((s) => ({ uploadsByConcept: { ...s.uploadsByConcept, [cid]: change(s.uploadsByConcept[cid] ?? []) } }));
  /** Starts waiting uploads up to the concurrency cap; each finished one starts the next. */
  const pump = (id: string, cid: string, aid: string) => {
    for (const key of nextToStart(useContentStore.getState().uploadsByConcept[cid] ?? [])) {
      const file = uploadFiles.get(key)!;
      const abort = new AbortController();
      uploadAborts.set(key, abort);
      setUploads(cid, (rows) => patchUpload(rows, key, { status: 'uploading' }));
      void contentApi.uploadMedia(id, cid, file, (loaded) => setUploads(cid, (rows) => patchUpload(rows, key, { loaded })), abort.signal)
        .then(async () => {
          setUploads(cid, (rows) => dropUpload(rows, key));
          putStudio(await contentApi.studio(id, cid, aid));
        })
        .catch((error) => {
          if ((error as Error).name === 'AbortError') setUploads(cid, (rows) => dropUpload(rows, key));
          else setUploads(cid, (rows) => patchUpload(rows, key, { status: 'error', error: contentFailure(error).error }));
        })
        .finally(() => { uploadFiles.delete(key); uploadAborts.delete(key); pump(id, cid, aid); });
    }
  };

  return {
    listByProject: {}, calendarByProject: {}, conceptsById: {}, missingByPost: {}, studioByAsset: {}, studioBlocked: {}, statsByPost: {}, mediaByPost: {}, uploadsByConcept: {}, remotionByBuilding: {},
    proposalsByProject: {}, retroLogByProject: {}, staleByProposal: {}, styleRevByProject: {}, speakingSpeedByProject: {}, speakingSamplesByProject: {}, importByProject: {}, learnByConcept: {},
    loadProposals, loadRetroLog,
    loadSpeakingSpeed: (id) => act(async () => putSpeakingSpeed(id, (await contentApi.settings(id)).speakingSpeed)),
    putSpeakingSpeed,
    loadSpeakingSamples: (id) => act(() => loadSamples(id)),
    deleteSpeakingSample: (id, sampleId) => act(async () => { putSpeakingSpeed(id, await contentApi.deleteSpeakingRateSample(id, sampleId)); await loadSamples(id); }),
    clearManualSpeed: (id) => act(async () => { putSpeakingSpeed(id, await contentApi.clearManualSpeakingSpeed(id)); }),
    saveSpeakingWpm: (id, wpm) => act(async () => putSpeakingSpeed(id, (await contentApi.saveSettings(id, { speakingWpm: wpm })).speakingSpeed)),
    async acceptProposal(id, pid, body) {
      try {
        const style = await contentApi.acceptProposal(id, pid, body);
        putProposals(id, style.proposals);
        clearStale(pid);
        set((s) => ({ styleRevByProject: { ...s.styleRevByProject, [id]: (s.styleRevByProject[id] ?? 0) + 1 } }));
        return { ok: true };
      } catch (error) {
        const failed = failedChangesFrom(error);
        if (failed) set((s) => ({ staleByProposal: { ...s.staleByProposal, [pid]: failed } }));
        return contentFailure(error);
      }
    },
    discardProposal: (id, pid) => act(async () => { putProposals(id, (await contentApi.discardProposal(id, pid)).proposals); clearStale(pid); }),
    async runRetro(id, aid, kind) {
      try {
        await contentApi.runRetro(id, aid);
        set((s) => {
          const view = s.studioByAsset[aid];
          return view ? { studioByAsset: { ...s.studioByAsset, [aid]: { ...view, retro: { status: 'running', at: new Date().toISOString() } } } } : {};
        });
        return { ok: true };
      } catch (error) {
        const failed = contentFailure(error);
        return failed.status === 409 && /already running/.test(failed.error) ? { ...failed, error: retroConflictText(kind) } : failed;
      }
    },
    async openImport(id, autoStart) {
      try {
        const view = await contentApi.importSession(id);
        putImport(id, view);
        if (autoStart && !view.session && !view.blockedReason) {
          // Another tab may have started it first, and a refused start is kept as the view's reason: the view is read again either way.
          try { putImport(id, await contentApi.startImportSession(id)); } catch { putImport(id, await contentApi.importSession(id)); }
        }
        return { ok: true };
      } catch (error) {
        return contentFailure(error);
      }
    },
    async importAction(id, action) {
      try {
        putImport(id, await (action === 'start' ? contentApi.startImportSession(id) : contentApi.importSessionAction(id, action)));
        return { ok: true };
      } catch (error) {
        const failed = contentFailure(error);
        await contentApi.importSession(id).then((view) => putImport(id, view), () => undefined);
        return failed;
      }
    },
    loadLearn: (id, cid) => act(async () => putLearn(cid, await contentApi.learnStatus(id, cid), null)),
    async startLearn(id, cid) {
      try {
        await contentApi.startLearn(id, cid);
        // Read, not assumed: a run that failed fast may already have ended, and its event may have arrived before this answer.
        putLearn(cid, await contentApi.learnStatus(id, cid), null);
        return { ok: true };
      } catch (error) {
        const failed = contentFailure(error);
        putLearn(cid, get().learnByConcept[cid]?.status ?? null, /already going/.test(failed.error) ? LEARN_CONFLICT : failed.error);
        return failed;
      }
    },
    openRemotion: (id) => act(async () => {
      putRemotion(id, await contentApi.remotionStudio(id));
      putRemotion(id, await contentApi.remotionStudioAction(id, 'start'));
    }),
    startRemotion: (id) => remotionAct(id, 'start'),
    stopRemotion: (id) => remotionAct(id, 'stop'),
    heartbeatRemotion(id) {
      contentApi.remotionStudioAction(id, 'heartbeat').then((studio) => putRemotion(id, studio), () => undefined);
    },
    applyRemotionEvent: (event) => putRemotion(event.buildingId, event.studio),
    // A refused start is shown from the view's own reason, so the view is read again either way.
    startVideo: (id, cid, aid) => act(async () => {
      try { putStudio(await contentApi.startStudio(id, cid, aid)); } finally { putStudio(await contentApi.studio(id, cid, aid)); }
    }),
    uploadMedia(id, cid, aid, files) {
      const s = useContentStore.getState();
      const existing = s.studioByAsset[aid]?.video?.media.length ?? 0;
      const pending = (s.uploadsByConcept[cid] ?? []).filter((r) => r.status !== 'error').length;
      const rows = planUploads(files, existing, pending, () => `u${++uploadSeq}`);
      rows.forEach((row, i) => { if (row.status === 'waiting') uploadFiles.set(row.key, files[i]!); });
      setUploads(cid, (current) => [...rows, ...current]);
      pump(id, cid, aid);
    },
    cancelUpload(cid, key) {
      uploadAborts.get(key)?.abort();
      uploadFiles.delete(key);
      setUploads(cid, (rows) => dropUpload(rows, key));
    },
    renameMedia: (id, cid, aid, mid, name) => videoAct(id, cid, aid, () => contentApi.renameMedia(id, cid, mid, name)),
    deleteMedia: (id, cid, aid, mid) => videoAct(id, cid, aid, () => contentApi.deleteMedia(id, cid, mid)),
    patchChecklistItem: (id, cid, aid, itemId, body) => videoAct(id, cid, aid, () => contentApi.patchChecklistItem(id, cid, itemId, body)),
    confirmAssets: (id, cid, aid) => videoAct(id, cid, aid, () => contentApi.confirmAssets(id, cid)),
    stopRender: (id, cid, aid, rid) => videoAct(id, cid, aid, () => contentApi.stopRender(id, cid, rid)),
    stopImageRender: (id, cid, aid, rid) => videoAct(id, cid, aid, () => contentApi.stopImageRender(id, aid, rid)),
    stopThumbnailRender: (id, cid, aid, rid) => videoAct(id, cid, aid, () => contentApi.stopThumbnailRender(id, aid, rid)),
    publishPost: (id, cid, pid, body) => act(async () => { await contentApi.publishPost(id, cid, pid, body); await refreshConcept(id, cid); }),
    editPublish: (id, cid, pid, body) => act(async () => { await contentApi.editPublish(id, cid, pid, body); await refreshConcept(id, cid); }),
    unpublishPost: (id, cid, pid) => act(async () => { await contentApi.unpublishPost(id, cid, pid); await refreshConcept(id, cid); }),
    loadMedia: (id, cid, pid) => act(async () => { const media = await contentApi.postMedia(id, cid, pid); set((s) => ({ mediaByPost: { ...s.mediaByPost, [pid]: media } })); }),
    loadStats: (id, cid, pid) => act(async () => { const { snapshots } = await contentApi.stats(id, cid, pid); putStats(pid, snapshots); }),
    async createStat(id, cid, pid, body) {
      try { const stat = await contentApi.createStat(id, cid, pid, body); await reloadStats(id, cid, pid); return { ok: true, stat }; } catch (error) { return contentFailure(error); }
    },
    patchStat: (id, cid, pid, sid, body) => act(async () => { await contentApi.patchStat(id, cid, pid, sid, body); await reloadStats(id, cid, pid); }),
    deleteStat: (id, cid, pid, sid) => act(async () => { await contentApi.deleteStat(id, cid, pid, sid); await reloadStats(id, cid, pid); }),
    async extractStats(id, cid, pid, text, files) {
      try { return { ok: true, reply: await contentApi.extractStats(id, cid, pid, text, files) }; } catch (error) { return contentFailure(error); }
    },
    discardExtraction: (id, cid, pid, eid) => act(() => contentApi.discardExtraction(id, cid, pid, eid)),
    async openStudio(id, cid, aid, autoStart = true) {
      try {
        let view = await contentApi.studio(id, cid, aid);
        putStudio(view);
        // A start the daemon already tried and was refused waits for the owner's Start.
        if (autoStart && view.asset.state !== 'finalized' && !view.session && !view.blockedReason) {
          try {
            view = await contentApi.startStudio(id, cid, aid);
            putStudio(view);
          } catch (error) {
            // Another open of the same tab may have started it first; only a pane still without a session is blocked.
            view = await contentApi.studio(id, cid, aid);
            putStudio(view);
            if (!view.session) { setBlocked(aid, contentFailure(error).error); return { ok: true }; }
          }
        }
        setBlocked(aid, null);
        return { ok: true };
      } catch (error) {
        return contentFailure(error);
      }
    },
    studioAction: (id, cid, aid, action, body) => act(async () => {
      putStudio(await (action === 'session/start' ? contentApi.startStudio(id, cid, aid) : contentApi.studioAction(id, cid, aid, action, body)));
      setBlocked(aid, null);
      // Finalizing and reopening change which tabs are enabled and which posts are finalized.
      if (action === 'finalize' || action === 'reopen') await refreshConcept(id, cid);
    }),
    async sendLineComment(id, cid, aid, body) {
      try { return { ok: true, sentAt: (await contentApi.studioComment(id, cid, aid, body)).sentAt }; } catch (error) { return contentFailure(error); }
    },
    applyStudioEvent(event) {
      if (event.type === 'studioAsset') {
        putStudio(event.view);
        // The video agent reports speaking rates through its view updates; reread what is already on screen.
        const shown = useContentStore.getState();
        if (event.view.video && shown.speakingSpeedByProject[event.buildingId]) void shown.loadSpeakingSpeed(event.buildingId);
        if (event.view.video && shown.speakingSamplesByProject[event.buildingId]) void loadSamples(event.buildingId);
        return;
      }
      if (event.type === 'contentImportSession') { if (get().importByProject[event.buildingId]) putImport(event.buildingId, event.view); return; }
      const shown = useContentStore.getState();
      if (shown.learnByConcept[event.conceptId]) void get().loadLearn(event.buildingId, event.conceptId);
      if (shown.proposalsByProject[event.buildingId]) void loadProposals(event.buildingId);
      if (shown.retroLogByProject[event.buildingId]) void loadRetroLog(event.buildingId);
    },
    async loadList(id, filters, offset = 0) {
      const token = claim(`list:${id}`);
      const view = (patch: Partial<ListView>) => set((s) => ({ listByProject: { ...s.listByProject, [id]: { ...(s.listByProject[id] ?? { filters, page: null, loading: false, error: null }), ...patch } } }));
      view({ filters, offset, loading: true, error: null });
      try {
        const page = await contentApi.concepts(id, listParams(filters, offset));
        if (newest.get(`list:${id}`) === token) view({ page, loading: false });
        return { ok: true };
      } catch (error) {
        const failed = contentFailure(error);
        if (newest.get(`list:${id}`) === token) view({ loading: false, error: failed.error });
        return failed;
      }
    },
    async loadCalendar(id, month) {
      const token = claim(`calendar:${id}`);
      const view = (patch: Partial<CalendarView>) => set((s) => ({ calendarByProject: { ...s.calendarByProject, [id]: { ...(s.calendarByProject[id] ?? { month, data: null, loading: false, error: null }), ...patch } } }));
      view({ month, loading: true, error: null });
      try {
        const data = await contentApi.calendar(id, month);
        if (newest.get(`calendar:${id}`) === token) view({ data, loading: false });
        return { ok: true };
      } catch (error) {
        const failed = contentFailure(error);
        if (newest.get(`calendar:${id}`) === token) view({ loading: false, error: failed.error });
        return failed;
      }
    },
    loadConcept: (id, cid) => act(() => refreshConcept(id, cid)),
    async createConcept(id, body) {
      try { const concept = await contentApi.createConcept(id, body); putConcept(concept); return { ok: true, concept }; } catch (error) { return contentFailure(error); }
    },
    patchConcept: (id, cid, body) => act(async () => putConcept(await contentApi.patchConcept(id, cid, body))),
    deleteConcept: (id, cid) => act(async () => {
      await contentApi.deleteConcept(id, cid);
      set((s) => { const { [cid]: _gone, ...rest } = s.conceptsById; return { conceptsById: rest }; });
    }),
    createPost: (id, cid, body) => act(async () => { await contentApi.createPost(id, cid, body); await refreshConcept(id, cid); }),
    patchPost: (id, cid, pid, scheduledAt) => act(async () => { await contentApi.patchPost(id, cid, pid, { scheduledAt }); await refreshConcept(id, cid); }),
    deletePost: (id, cid, pid) => act(async () => {
      await contentApi.deletePost(id, cid, pid);
      // The post's own assets (its text, images, article) went with it; the Concept's video is shared and stays.
      const own = (get().conceptsById[cid]?.posts.find((p) => p.id === pid)?.needs ?? []).filter((a) => a.postId === pid).map((a) => a.id);
      set((s) => ({ studioByAsset: without(s.studioByAsset, own), studioBlocked: without(s.studioBlocked, own) }));
      await refreshConcept(id, cid);
    }),
    async finalizePost(id, cid, pid) {
      try {
        await contentApi.finalizePost(id, cid, pid);
        set((s) => { const { [pid]: _cleared, ...rest } = s.missingByPost; return { missingByPost: rest }; });
        await refreshConcept(id, cid);
        return { ok: true };
      } catch (error) {
        const missing = missingFrom(error);
        if (missing) set((s) => ({ missingByPost: { ...s.missingByPost, [pid]: missing } }));
        return contentFailure(error);
      }
    },
    unfinalizePost: (id, cid, pid) => act(async () => {
      await contentApi.unfinalizePost(id, cid, pid);
      set((s) => { const { [pid]: _cleared, ...rest } = s.missingByPost; return { missingByPost: rest }; });
      await refreshConcept(id, cid);
    }),
  };

});
