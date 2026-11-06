import { absoluteUrl, request, ApiError } from './serverApi';
import type * as T from './contentTypes';
import type { RetroStatusDto, StudioViewDto } from './contentStudio';
import type { ChecklistDto, MediaDto, RenderDto } from './contentVideo';
import type { RemotionStudioDto } from './contentRemotion';
import type { SpeakingRateSampleDto, SpeakingSpeedDto } from './contentScript';
import type { ImportSessionViewDto } from './contentImport';

export interface UploadFile { name: string; size: number; type?: string }

/**
 * Sends one media file as raw bytes (never base64 JSON), reporting progress. The browser's XMLHttpRequest gives upload progress;
 * where there is none (tests), `fetch` sends it and progress jumps to the end.
 */
function sendRaw(url: string, file: UploadFile & Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<MediaDto> {
  const fail = (status: number, body: { error?: string }) => new ApiError(body.error ?? `Upload failed with ${status}`, status, body);
  if (typeof XMLHttpRequest === 'undefined') {
    return fetch(url, { method: 'POST', body: file, signal, headers: { 'content-type': 'application/octet-stream' } }).then(async (res) => {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw fail(res.status, body);
      onProgress(file.size);
      return body as MediaDto;
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body: { error?: string } = {};
      try { body = JSON.parse(xhr.responseText); } catch { body = { error: xhr.statusText }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as MediaDto); else reject(fail(xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError('The upload failed. Check the connection.', 0, {}));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

const base = (id: string) => `/api/projects/${id}/content`;
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const postBase = (id: string, cid: string, pid: string) => `${base(id)}/concepts/${cid}/posts/${pid}`;
export const contentQuery = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** The Content Studio Building's HTTP client. Errors surface as `ApiError` with the server's `{ error }` text, status and body. */
export const contentApi = {
  concepts: (id: string, q: Record<string, string | number | boolean | undefined | null>) => request<T.ConceptPageDto>(`${base(id)}/concepts${contentQuery(q)}`),
  concept: (id: string, cid: string) => request<T.ConceptDto>(`${base(id)}/concepts/${cid}`),
  createConcept: (id: string, body: { title: string; brief: string; posts: T.NewPostInput[] }) => request<T.ConceptDto>(`${base(id)}/concepts`, json('POST', body)),
  patchConcept: (id: string, cid: string, body: { title?: string; brief?: string; archived?: boolean }) => request<T.ConceptDto>(`${base(id)}/concepts/${cid}`, json('PATCH', body)),
  deleteConcept: (id: string, cid: string) => request<void>(`${base(id)}/concepts/${cid}`, json('DELETE')),
  createPost: (id: string, cid: string, body: T.NewPostInput) => request<T.PostDto>(`${base(id)}/concepts/${cid}/posts`, json('POST', body)),
  patchPost: (id: string, cid: string, pid: string, body: { scheduledAt: string }) => request<T.PostDto>(`${base(id)}/concepts/${cid}/posts/${pid}`, json('PATCH', body)),
  deletePost: (id: string, cid: string, pid: string) => request<void>(`${base(id)}/concepts/${cid}/posts/${pid}`, json('DELETE')),
  finalizePost: (id: string, cid: string, pid: string) => request<T.PostDto>(`${base(id)}/concepts/${cid}/posts/${pid}/finalize`, json('POST', {})),
  unfinalizePost: (id: string, cid: string, pid: string) => request<T.PostDto>(`${base(id)}/concepts/${cid}/posts/${pid}/unfinalize`, json('POST', {})),
  publishPost: (id: string, cid: string, pid: string, body: { liveUrl?: string | null; publishedAt?: string }) => request<T.PostDto>(`${postBase(id, cid, pid)}/publish`, json('POST', body)),
  editPublish: (id: string, cid: string, pid: string, body: { liveUrl?: string | null; publishedAt?: string }) => request<T.PostDto>(`${postBase(id, cid, pid)}/publish`, json('PATCH', body)),
  unpublishPost: (id: string, cid: string, pid: string) => request<T.PostDto>(`${postBase(id, cid, pid)}/unpublish`, json('POST', {})),
  postMedia: (id: string, cid: string, pid: string) => request<T.PostMediaDto>(`${postBase(id, cid, pid)}/media`),
  imageUrl: (id: string, cid: string, pid: string, index: number) => absoluteUrl(`${postBase(id, cid, pid)}/media/images/${index}`),
  imagesZipUrl: (id: string, cid: string, pid: string) => absoluteUrl(`${postBase(id, cid, pid)}/media/images.zip`),
  videoUrl: (id: string, cid: string, pid: string) => absoluteUrl(`${postBase(id, cid, pid)}/media/video`),
  thumbnailUrl: (id: string, cid: string, pid: string) => absoluteUrl(`${postBase(id, cid, pid)}/media/thumbnail`),
  stats: (id: string, cid: string, pid: string) => request<{ snapshots: T.StatDto[] }>(`${postBase(id, cid, pid)}/stats`),
  createStat: (id: string, cid: string, pid: string, body: T.StatInput) => request<T.StatDto>(`${postBase(id, cid, pid)}/stats`, json('POST', body)),
  patchStat: (id: string, cid: string, pid: string, sid: string, body: Partial<T.StatInput>) => request<T.StatDto>(`${postBase(id, cid, pid)}/stats/${sid}`, json('PATCH', body)),
  deleteStat: (id: string, cid: string, pid: string, sid: string) => request<void>(`${postBase(id, cid, pid)}/stats/${sid}`, json('DELETE')),
  sourceUrl: (id: string, cid: string, pid: string, sid: string, sourceId: string) => absoluteUrl(`${postBase(id, cid, pid)}/stats/${sid}/sources/${sourceId}`),
  /** One multipart request with the raw image bytes (not base64) and the pasted text. */
  async extractStats(id: string, cid: string, pid: string, text: string, files: Blob[]): Promise<T.ExtractionReplyDto> {
    const form = new FormData();
    form.append('text', text);
    for (const file of files) form.append('images', file);
    const res = await fetch(absoluteUrl(`${postBase(id, cid, pid)}/stats/extractions`), { method: 'POST', body: form });
    const body = await res.json().catch(() => ({ error: res.status === 413 ? 'The upload is too large' : res.statusText }));
    if (!res.ok) throw new ApiError(body.error ?? `Extraction failed with ${res.status}`, res.status, body);
    return body as T.ExtractionReplyDto;
  },
  discardExtraction: (id: string, cid: string, pid: string, eid: string) => request<void>(`${postBase(id, cid, pid)}/stats/extractions/${eid}`, json('DELETE')),
  calendar: (id: string, month: string) => request<T.CalendarDto>(`${base(id)}/calendar${contentQuery({ month })}`),
  studio: (id: string, cid: string, aid: string) => request<StudioViewDto>(`${base(id)}/concepts/${cid}/assets/${aid}/session`),
  startStudio: (id: string, cid: string, aid: string) => request<StudioViewDto>(`${base(id)}/concepts/${cid}/assets/${aid}/session`, json('POST', {})),
  /** `action` is the route under the asset: `session/new-round`, `session/resume`, `finalize` or `reopen`. */
  studioAction: (id: string, cid: string, aid: string, action: 'session/new-round' | 'session/resume' | 'finalize' | 'reopen', body: object = {}) => request<StudioViewDto>(`${base(id)}/concepts/${cid}/assets/${aid}/${action}`, json('POST', body)),
  /** Types a comment on one line of the current draft into the asset's live session. */
  studioComment: (id: string, cid: string, aid: string, body: { line: number; lineText: string; comment: string }) =>
    request<{ line: number; sentAt: string; sentChars: number }>(`${base(id)}/concepts/${cid}/assets/${aid}/session/comment`, json('POST', body)),
  media: (id: string, cid: string) => request<{ media: MediaDto[] }>(`${base(id)}/concepts/${cid}/media`),
  uploadMedia: (id: string, cid: string, file: UploadFile & Blob, onProgress: (loaded: number) => void, signal: AbortSignal) =>
    sendRaw(absoluteUrl(`${base(id)}/concepts/${cid}/media${contentQuery({ name: file.name })}`), file, onProgress, signal),
  renameMedia: (id: string, cid: string, mid: string, name: string) => request<MediaDto>(`${base(id)}/concepts/${cid}/media/${mid}`, json('PATCH', { name })),
  deleteMedia: (id: string, cid: string, mid: string) => request<void>(`${base(id)}/concepts/${cid}/media/${mid}`, json('DELETE')),
  checklist: (id: string, cid: string) => request<ChecklistDto>(`${base(id)}/concepts/${cid}/video/checklist`),
  patchChecklistItem: (id: string, cid: string, itemId: string, body: { ticked?: boolean; mediaIds?: string[] }) => request<ChecklistDto>(`${base(id)}/concepts/${cid}/video/checklist/${encodeURIComponent(itemId)}`, json('PATCH', body)),
  confirmAssets: (id: string, cid: string) => request<ChecklistDto>(`${base(id)}/concepts/${cid}/video/confirm`, json('POST', {})),
  renders: (id: string, cid: string) => request<{ renders: RenderDto[] }>(`${base(id)}/concepts/${cid}/video/renders`),
  stopRender: (id: string, cid: string, rid: string) => request<RenderDto>(`${base(id)}/concepts/${cid}/video/renders/${rid}/stop`, json('POST', {})),
  stopThumbnailRender: (id: string, aid: string, rid: string) => request<unknown>(`${base(id)}/assets/${encodeURIComponent(aid)}/thumbnail/renders/${encodeURIComponent(rid)}/stop`, json('POST', {})),
  stopImageRender: (id: string, aid: string, rid: string) => request<unknown>(`${base(id)}/assets/${encodeURIComponent(aid)}/images/renders/${encodeURIComponent(rid)}/stop`, json('POST', {})),
  remotionStudio: (id: string) => request<RemotionStudioDto>(`${base(id)}/remotion/studio`),
  remotionStudioAction: (id: string, action: 'start' | 'stop' | 'heartbeat') => request<RemotionStudioDto>(`${base(id)}/remotion/studio/${action}`, json('POST', {})),
  /** A daemon-relative file URL (media, thumbnail, render) made absolute for `<img>`, `<video>` and downloads. */
  assetUrl: (path: string) => absoluteUrl(path),
  settings: (id: string) => request<T.ContentSettingsDto>(`${base(id)}/settings`),
  saveSettings: (id: string, body: { name?: string; timezone?: string; writingSkillFile?: string | null; autoApplyRetro?: boolean; evaluationDays?: number; speakingWpm?: number }) => request<T.ContentSettingsDto>(`${base(id)}/settings`, json('PATCH', body)),
  clearManualSpeakingSpeed: (id: string) => request<SpeakingSpeedDto>(`${base(id)}/settings/speaking-speed`, { method: 'DELETE' }),
  speakingRateSamples: (id: string) => request<SpeakingRateSampleDto[]>(`${base(id)}/speaking-rate-samples`),
  deleteSpeakingRateSample: (id: string, sampleId: string) => request<SpeakingSpeedDto>(`${base(id)}/speaking-rate-samples/${encodeURIComponent(sampleId)}`, { method: 'DELETE' }),
  targets: (id: string) => request<T.TargetsResponseDto>(`${base(id)}/targets`),
  saveTargets: (id: string, platform: string, body: Partial<Record<string, number | null>>) => request<{ platform: string; targets: T.TargetsDto }>(`${base(id)}/targets/${platform}`, json('PUT', body)),
  targetHistory: (id: string) => request<{ entries: T.TargetHistoryDto[] }>(`${base(id)}/targets/history`),
  insights: (id: string) => request<T.InsightsDto>(`${base(id)}/insights`),
  refreshInsights: (id: string) => request<{ status: 'running' }>(`${base(id)}/insights/refresh`, json('POST', {})),
  stopInsights: (id: string) => request<{ status: 'stopped' }>(`${base(id)}/insights/stop`, json('POST', {})),
  insightsHistory: (id: string) => request<{ entries: T.InsightsVersionDto[] }>(`${base(id)}/insights/history`),
  saveInsightsNotes: (id: string, body: { content: string; version: string }) => request<{ content: string; version: string }>(`${base(id)}/insights/notes`, json('PUT', body)),
  sections: (id: string) => request<{ sections: T.SectionMetaDto[] }>(`${base(id)}/knowledge/sections`),
  section: (id: string, sid: string) => request<T.SectionDto>(`${base(id)}/knowledge/sections/${encodeURIComponent(sid)}`),
  saveSection: (id: string, sid: string, body: { content: string; version: string }) => request<T.SectionDto>(`${base(id)}/knowledge/sections/${encodeURIComponent(sid)}`, json('PUT', body)),
  createSection: (id: string, name: string) => request<T.SectionMetaDto>(`${base(id)}/knowledge/sections`, json('POST', { name })),
  deleteSection: (id: string, sid: string) => request<void>(`${base(id)}/knowledge/sections/${encodeURIComponent(sid)}`, json('DELETE')),
  files: (id: string) => request<{ files: T.BrandFileDto[] }>(`${base(id)}/knowledge/files`),
  fileUrl: (id: string, name: string) => absoluteUrl(`${base(id)}/knowledge/files/${encodeURIComponent(name)}`),
  deleteFile: (id: string, name: string) => request<void>(`${base(id)}/knowledge/files/${encodeURIComponent(name)}`, json('DELETE')),
  /** Sends the file's raw bytes (not base64 JSON), always as octet-stream so no body parser reads them as JSON. */
  async uploadFile(id: string, file: { name: string; type: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<T.BrandFileDto> {
    const res = await fetch(absoluteUrl(`${base(id)}/knowledge/files${contentQuery({ name: file.name })}`), { method: 'POST', body: await file.arrayBuffer(), headers: { 'content-type': 'application/octet-stream' } });
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new ApiError(body.error ?? `Upload failed with ${res.status}`, res.status, body);
    return body as T.BrandFileDto;
  },
  colours: (id: string) => request<{ colours: T.ColourDto[] }>(`${base(id)}/knowledge/colours`),
  saveColours: (id: string, colours: T.ColourDto[]) => request<{ colours: T.ColourDto[] }>(`${base(id)}/knowledge/colours`, json('PUT', { colours })),
  style: (id: string) => request<T.StyleDto>(`${base(id)}/writing-style`),
  saveStyle: (id: string, body: { content: string; version: string }) => request<T.StyleDto>(`${base(id)}/writing-style`, json('PUT', body)),
  styleHistory: (id: string) => request<{ entries: T.StyleHistoryDto[] }>(`${base(id)}/writing-style/history`),
  retroLog: (id: string) => request<{ entries: T.RetroLogEntryDto[] }>(`${base(id)}/retros`),
  runRetro: (id: string, aid: string) => request<{ status: 'running' }>(`${base(id)}/assets/${aid}/retro`, json('POST', {})),
  learnStatus: (id: string, cid: string) => request<RetroStatusDto | null>(`${base(id)}/concepts/${cid}/learn`),
  startLearn: (id: string, cid: string) => request<{ status: 'running' }>(`${base(id)}/concepts/${cid}/learn`, json('POST', {})),
  importSession: (id: string) => request<ImportSessionViewDto>(`${base(id)}/import-session`),
  startImportSession: (id: string) => request<ImportSessionViewDto>(`${base(id)}/import-session`, json('POST', {})),
  /** `action` is the route under the import session. */
  importSessionAction: (id: string, action: 'resume' | 'new' | 'end') => request<ImportSessionViewDto>(`${base(id)}/import-session/${action}`, json('POST', {})),
  proposals: (id: string) => request<{ proposals: T.ProposalDto[] }>(`${base(id)}/style-proposals`),
  acceptProposal: (id: string, pid: string, body: T.AcceptBody) => request<T.StyleDto>(`${base(id)}/style-proposals/${pid}/accept`, json('POST', body)),
  discardProposal: (id: string, pid: string) => request<{ proposals: T.ProposalDto[] }>(`${base(id)}/style-proposals/${pid}/discard`, json('POST', {})),
};
