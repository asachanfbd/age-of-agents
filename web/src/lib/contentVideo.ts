/**
 * The Content Studio Video tab: what the daemon sends (mirrors server/src/content/videoStudio.ts, videoMedia.ts and
 * videoChecklist.ts) and the pure rules its three columns are drawn from.
 */
import type { StudioViewDto } from './contentStudio';

export type MediaKind = 'video' | 'image' | 'audio';
export interface MediaDto {
  id: string; name: string; kind: MediaKind; size: number; durationMs: number | null; width: number | null; height: number | null;
  hasThumbnail: boolean; createdAt: string; path: string; fileUrl: string; thumbnailUrl: string | null;
}
export interface ChecklistItemDto { id: string; label: string; detail: string | null; ticked: boolean; mediaIds: string[] }
export interface ChecklistDto { round: number; items: ChecklistItemDto[]; confirmedAt: string | null }
export type RenderStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';
export interface RenderDto {
  id: string; round: number; k: number; name: string; status: RenderStatus;
  percent: number | null; frame: number | null; totalFrames: number | null; queuePosition: number | null; waitingFor: string | null;
  durationMs: number | null; size: number | null; error: string | null; createdAt: string; finishedAt: string | null; fileUrl: string | null;
}
export interface SetupDto { status: 'none' | 'running' | 'failed' | 'ready'; error: string | null; percent: number | null }
export interface VideoPartDto {
  setup: SetupDto; blockedReason: string | null; scriptChanged: boolean; compositionId: string;
  checklist: ChecklistDto; renders: RenderDto[]; media: MediaDto[];
}

// ---- limits (server/src/content/limits.ts) -----------------------------------------------------

export const MEDIA_MAX_BYTES = 2_147_483_648;
export const MEDIA_FILES_MAX = 200;
export const MEDIA_NAME_MAX = 120;
/** Uploads sent at once; the rest wait. */
export const UPLOAD_CONCURRENCY = 2;
export const MEDIA_EXTENSIONS: Record<string, MediaKind> = {
  mp4: 'video', mov: 'video', webm: 'video', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio',
};
export const MEDIA_ACCEPT = Object.keys(MEDIA_EXTENSIONS).map((e) => `.${e}`).join(',');

// ---- the right pane's state machine ------------------------------------------------------------------

/**
 * What the right pane (and the agent column) shows. Precedence: finalized, then the Remotion setup, then a missing session, then the
 * checklist until it is confirmed (an ended session before that shows its own card), then the live preview. After Confirm the
 * preview stays whatever the session or a final render is doing.
 */
export type VideoPaneState = 'loading' | 'setup' | 'setupfail' | 'blocked' | 'starting' | 'ended' | 'waiting' | 'checklist' | 'ready' | 'preview' | 'finalized';

const roundRenders = (view: StudioViewDto): RenderDto[] => (view.video?.renders ?? []).filter((r) => r.round === Math.max(view.asset.round, 1));

export function videoPaneState(view: StudioViewDto | null): VideoPaneState {
  if (!view?.video) return 'loading';
  const { video } = view;
  if (view.asset.state === 'finalized') return 'finalized';
  if (!view.session) {
    if (video.setup.status === 'running') return 'setup';
    if (video.setup.status === 'failed') return 'setupfail';
    return video.blockedReason ? 'blocked' : 'starting';
  }
  const list = video.checklist;
  if (list.confirmedAt) return 'preview';
  if (view.session.state === 'ended') return 'ended';
  if (!list.items.length) return 'waiting';
  return list.items.every((i) => i.ticked) ? 'ready' : 'checklist';
}

/** The finalized render, which the player shows; none while drafting. */
export function playableRender(view: StudioViewDto): RenderDto | null {
  if (view.asset.state !== 'finalized') return null;
  return (view.video?.renders ?? []).find((r) => r.id === view.asset.content) ?? null;
}

/** The final render running or waiting in this round, for the progress box and Stop. */
export const activeRender = (view: StudioViewDto): RenderDto | null => roundRenders(view).find((r) => r.status === 'running' || r.status === 'queued') ?? null;

/** What the owner is told when the round's newest final render failed or was stopped (nothing was finalized); null otherwise. */
export function finalRenderAlert(view: StudioViewDto): string | null {
  if (view.asset.state === 'finalized') return null;
  const newest = roundRenders(view)[0];
  if (newest?.status === 'failed') return `Final render failed: ${newest.error}. Nothing was finalized.`;
  return newest?.status === 'stopped' ? 'The final render was stopped. Nothing was finalized.' : null;
}

/** Finalize renders the video, so it needs confirmed assets, a ready project and no render in progress; the session may have ended. */
export function canFinalize(view: StudioViewDto, readOnly: boolean): boolean {
  const video = view.video;
  if (readOnly || !video || view.asset.state === 'finalized') return false;
  return !!video.checklist.confirmedAt && video.setup.status === 'ready' && !activeRender(view);
}

export const FINALIZE_IDLE_HINT = 'Finalize renders the final MP4 (a few minutes), then locks this round.';

/** Why Finalize is disabled, or null. */
export function finalizeHint(view: StudioViewDto): string | null {
  if (activeRender(view)) return 'Finalize waits until the render finishes or is stopped.';
  if (!view.video?.checklist.confirmedAt) return 'Confirm the assets before finalizing.';
  if (view.video.setup.status !== 'ready') return 'Remotion is still being set up.';
  return null;
}

export const tickCount = (list: ChecklistDto): string => `${list.items.filter((i) => i.ticked).length} of ${list.items.length} ticked`;
export function confirmHint(list: ChecklistDto): string {
  if (!list.items.length) return 'The agent has not published a checklist yet.';
  const left = list.items.filter((i) => !i.ticked).length;
  return left ? `Tick every item to confirm · ${left} left` : 'Every item is ticked. Confirming locks the list.';
}

// ---- layout ------------------------------------------------------------------------------------------

/** Studio's own panels are cramped near 400px, so the preview step gives the right pane more room than the checklist step. */
export function tabColumnsClass(state: VideoPaneState): string {
  if (state === 'finalized') return 'min-[960px]:grid-cols-[minmax(112px,10%)_1fr]';
  return state === 'preview' ? 'min-[960px]:grid-cols-[minmax(112px,10%)_1fr_minmax(360px,44%)]' : 'min-[960px]:grid-cols-[minmax(112px,10%)_1fr_minmax(320px,34%)]';
}

// ---- media column -----------------------------------------------------------------------------------

/** Newest first, ties by name. */
export const orderMedia = (media: MediaDto[]): MediaDto[] => [...media].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "0:48", "2:14", "1:00:05"; empty when unknown. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function mediaFooter(media: MediaDto[]): string {
  if (!media.length) return `0 of ${MEDIA_FILES_MAX} files`;
  const size = media.reduce((n, m) => n + m.size, 0);
  return `${media.length} ${media.length === 1 ? 'file' : 'files'} · ${formatBytes(size)}`;
}

/** "video · 0:48 · 1080×1920 · 18 MB" */
export const mediaFacts = (media: MediaDto): string =>
  [media.kind, formatDuration(media.durationMs) || null, media.width && media.height ? `${media.width}×${media.height}` : null, formatBytes(media.size)].filter(Boolean).join(' · ');

export const dropText = (count: number): string => `Drop to add ${count} ${count === 1 ? 'file' : 'files'}`;

/** Keeps the previous item objects when nothing in them changed, so a render-progress update does not re-draw the media column. */
export function shareMedia(previous: MediaDto[] | undefined, next: MediaDto[]): MediaDto[] {
  if (!previous) return next;
  const byId = new Map(previous.map((m) => [m.id, m]));
  const merged = next.map((m) => { const old = byId.get(m.id); return old && JSON.stringify(old) === JSON.stringify(m) ? old : m; });
  return merged.length === previous.length && merged.every((m, i) => m === previous[i]) ? previous : merged;
}

// ---- uploads ----------------------------------------------------------------------------------------

export const UNSUPPORTED_TEXT = 'Unsupported file type. Use video, image or audio.';
export const TOO_BIG_TEXT = 'This file is over 2 GB.';
export const NO_ROOM_TEXT = `A Concept holds at most ${MEDIA_FILES_MAX} files.`;

export type UploadStatus = 'waiting' | 'uploading' | 'error';
export interface UploadRow { key: string; name: string; size: number; loaded: number; status: UploadStatus; error: string | null }

const extensionOf = (name: string): string => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };
export const kindOfName = (name: string): MediaKind | null => MEDIA_EXTENSIONS[extensionOf(name)] ?? null;

/** Checks dropped files before anything is sent: a refused file becomes an error row, the rest wait their turn. */
export function planUploads(files: { name: string; size: number }[], existingCount: number, pending: number, keyOf: (i: number) => string): UploadRow[] {
  let room = MEDIA_FILES_MAX - existingCount - pending;
  return files.map((f, i) => {
    const row: UploadRow = { key: keyOf(i), name: f.name, size: f.size, loaded: 0, status: 'waiting', error: null };
    const error = !kindOfName(f.name) ? UNSUPPORTED_TEXT : f.size > MEDIA_MAX_BYTES ? TOO_BIG_TEXT : room <= 0 ? NO_ROOM_TEXT : null;
    if (error) return { ...row, status: 'error', error };
    room -= 1;
    return row;
  });
}

/** Which waiting rows may start now under the concurrency cap. */
export function nextToStart(rows: UploadRow[], cap = UPLOAD_CONCURRENCY): string[] {
  const free = cap - rows.filter((r) => r.status === 'uploading').length;
  return free > 0 ? rows.filter((r) => r.status === 'waiting').slice(0, free).map((r) => r.key) : [];
}

/** Changes one row; every other row object stays the same. */
export const patchUpload = (rows: UploadRow[], key: string, patch: Partial<UploadRow>): UploadRow[] => rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
export const dropUpload = (rows: UploadRow[], key: string): UploadRow[] => rows.filter((r) => r.key !== key);

export function uploadProgressText(row: UploadRow): string {
  if (row.status === 'waiting') return 'Waiting…';
  if (row.status === 'error') return row.error ?? 'Upload failed';
  const pct = row.size ? Math.floor((row.loaded / row.size) * 100) : 0;
  return `${pct}% · ${formatBytes(row.loaded)} of ${formatBytes(row.size)}`;
}

// ---- rename -----------------------------------------------------------------------------------------

/** The editable base and the fixed extension of a name. */
export function splitMediaName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
}

const SAFE = /^[A-Za-z0-9 ._-]+$/;
export const RENAME_EMPTY = 'Enter a name.';
export const RENAME_TOO_LONG = `Names can be at most ${MEDIA_NAME_MAX} characters, extension included.`;
export const RENAME_BAD_CHARS = 'Use letters, digits, spaces, dots, dashes and underscores only.';
export const RENAME_TAKEN = 'Another file already has this name.';

/** The same rules as the server's rename (server/src/content/mediaTypes.ts `parseRename`): an error text, or null when valid. */
export function renameError(base: string, ext: string, otherNames: string[]): string | null {
  const name = `${base.trim()}${ext}`;
  if (!base.trim()) return RENAME_EMPTY;
  if (name.length > MEDIA_NAME_MAX) return RENAME_TOO_LONG;
  if (!SAFE.test(name) || name.startsWith('.')) return RENAME_BAD_CHARS;
  if (otherNames.some((o) => o.toLowerCase() === name.toLowerCase())) return RENAME_TAKEN;
  return null;
}

// ---- preview zoom -------------------------------------------------------------------------------------

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const ZOOM_BUTTON_STEP = 1.25;
export const ZOOM_WHEEL_STEP = 1.1;
export type ZoomMode = 'fit' | 'actual' | 'custom';
export interface Zoom { mode: ZoomMode; scale: number }
export const clampZoom = (scale: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
export const zoomBy = (zoom: Zoom, factor: number): Zoom => ({ mode: 'custom', scale: clampZoom(zoom.scale * factor) });
export const zoomFit = (fitScale: number): Zoom => ({ mode: 'fit', scale: clampZoom(fitScale) });
export const ZOOM_ACTUAL: Zoom = { mode: 'actual', scale: 1 };

// ---- renders ----------------------------------------------------------------------------------------

/** A finalized round's renders, newest first, with the Final badge on the finalized one. A drafting round lists none: its failed or stopped attempts show as the alert above the preview. */
export function roundRenderRows(view: StudioViewDto): { render: RenderDto; badge: 'Final' | null }[] {
  const final = playableRender(view);
  if (!final) return [];
  return (view.video?.renders ?? []).filter((r) => r.round === final.round).map((render) => ({ render, badge: render.id === final.id ? 'Final' : null }));
}

/** Renders of earlier rounds grouped by round, newest round first. */
export function previousRoundRenders(view: StudioViewDto): { round: number; renders: RenderDto[] }[] {
  const current = view.asset.state === 'finalized' ? playableRender(view)?.round ?? view.asset.round : Math.max(view.asset.round, 1);
  const rounds = new Map<number, RenderDto[]>();
  for (const r of view.video?.renders ?? []) if (r.round < current && r.status === 'done') rounds.set(r.round, [...(rounds.get(r.round) ?? []), r]);
  return [...rounds.entries()].sort((a, b) => b[0] - a[0]).map(([round, renders]) => ({ round, renders: renders.sort((a, b) => b.k - a.k) }));
}

/** "46% · frame 581 of 1,260". */
export function renderProgressText(render: RenderDto): string {
  if (render.status === 'queued') return render.queuePosition && render.queuePosition > 1 ? `Waiting · ${render.queuePosition - 1} ahead` : 'Waiting';
  const pct = render.percent ?? 0;
  return render.frame !== null && render.totalFrames !== null ? `${pct}% · frame ${render.frame.toLocaleString('en-US')} of ${render.totalFrames.toLocaleString('en-US')}` : `${pct}%`;
}

/** A remaining-time estimate from two progress samples; null before there are two. */
export function etaText(samples: { at: number; percent: number }[]): string | null {
  if (samples.length < 2) return null;
  const first = samples[0]!, last = samples[samples.length - 1]!;
  const rate = (last.percent - first.percent) / (last.at - first.at);
  if (!(rate > 0)) return null;
  const left = (100 - last.percent) / rate;
  const minutes = Math.round(left / 60_000);
  return minutes < 1 ? 'less than a minute left' : `about ${minutes} min left`;
}

export const queuedText = (render: RenderDto): string => `Final render is queued. ${render.waitingFor ? `Waiting for "${render.waitingFor}" to finish rendering.` : 'Waiting for another render to finish.'} One render at a time.`;

// ---- dialog texts ------------------------------------------------------------------------------------

export const discardTitle = 'Discard the session and start a new one?';
export const discardText = (round: number): string =>
  `Round ${round} ends and round ${round + 1} starts with a fresh conversation and an empty checklist. Round ${round}'s composition code moves to an archive, so the video is rebuilt from scratch.`;
export const DISCARD_KEEPS = `Your media stays. This round's renders stay under Previous rounds.`;

export function deleteMediaText(name: string, linkedLabels: string[]): string {
  const base = `Delete ${name}? The agent's code may still use this file, so the next render could fail.`;
  return linkedLabels.length ? `${base} It is unlinked from the checklist item ${linkedLabels.map((l) => `"${l}"`).join(', ')}.` : base;
}

export const SCRIPT_CHANGED_TEXT = 'The script changed after this session started. Ask the agent to re-read script.md if it should use the new version.';

/** Browsers list "Files" among a drag's types only when it carries files, so text and link drags are ignored. */
export const hasFiles = (types: readonly string[] | null | undefined): boolean => !!types && [...types].includes('Files');

/** True when the pointer left the column; a move onto one of its children (or itself) does not count. */
export const leavesColumn = (column: { contains(node: unknown): boolean }, next: unknown): boolean => !next || !column.contains(next);

/** The dropped files, or none when read-only. */
export const droppedFiles = (list: ArrayLike<File> | null | undefined, readOnly: boolean): File[] => (readOnly || !list ? [] : Array.from(list));

interface DragLikeEvent {
  preventDefault(): void;
  currentTarget: { contains(node: unknown): boolean };
  relatedTarget?: unknown;
  dataTransfer: { types?: readonly string[] | null; items?: { length: number }; files?: ArrayLike<File> | null };
}

/** Drag handlers for the whole media column. Read-only columns and non-file drags are left to the browser. */
export function mediaDropHandlers({ readOnly, onDragCount, onFiles }: { readOnly: boolean; onDragCount: (count: number | null) => void; onFiles: (files: File[]) => void }) {
  const accepts = (e: DragLikeEvent) => !readOnly && hasFiles(e.dataTransfer.types);
  return {
    onDragOver: (e: DragLikeEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      onDragCount(e.dataTransfer.items?.length ?? 1);
    },
    onDragLeave: (e: DragLikeEvent) => { if (leavesColumn(e.currentTarget, e.relatedTarget)) onDragCount(null); },
    onDrop: (e: DragLikeEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      onDragCount(null);
      const files = droppedFiles(e.dataTransfer.files, readOnly);
      if (files.length) onFiles(files);
    },
  };
}
