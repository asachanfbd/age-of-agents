import { absoluteUrl, request } from './serverApi';
import type * as T from './crmTypes';

const base = (id: string) => `/api/projects/${id}/crm`;
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const qs = (params: Record<string, string | number | undefined | null>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** The CRM Building's HTTP client. Errors surface as `ApiError` with the server's `{ error }` text and status. */
export const crmApi = {
  contacts: (id: string, q: Record<string, string | number | undefined | null>) => request<T.PageDto<T.ContactDto>>(`${base(id)}/contacts${qs(q)}`),
  contact: (id: string, cid: number) => request<T.ContactDto>(`${base(id)}/contacts/${cid}`),
  createContact: (id: string, body: unknown) => request<T.ContactDto>(`${base(id)}/contacts`, json('POST', body)),
  patchContact: (id: string, cid: number, body: unknown) => request<T.ContactDto>(`${base(id)}/contacts/${cid}`, json('PATCH', body)),
  addChannel: (id: string, cid: number, body: unknown) => request<T.ContactDto>(`${base(id)}/contacts/${cid}/channels`, json('POST', body)),
  patchChannel: (id: string, cid: number, chid: number, body: unknown) => request<T.ContactDto>(`${base(id)}/contacts/${cid}/channels/${chid}`, json('PATCH', body)),
  removeChannel: (id: string, cid: number, chid: number) => request<T.ContactDto>(`${base(id)}/contacts/${cid}/channels/${chid}`, json('DELETE')),
  setDnc: (id: string, cid: number, dnc: boolean) => request<T.ContactDto>(`${base(id)}/contacts/${cid}/dnc`, json('PUT', { dnc })),
  setStage: (id: string, cid: number, stage: T.Stage) => request<T.ContactDto>(`${base(id)}/contacts/${cid}/stage`, json('PUT', { stage })),
  markLost: (id: string, cid: number, reason: string) => request<T.ContactDto>(`${base(id)}/contacts/${cid}/lost`, json('POST', { reason })),
  reopen: (id: string, cid: number, stage?: T.Stage) => request<T.ContactDto>(`${base(id)}/contacts/${cid}/reopen`, json('POST', stage ? { stage } : {})),
  markCustomer: (id: string, cid: number) => request<T.ContactDto>(`${base(id)}/contacts/${cid}/customer`, json('POST', {})),
  logResponse: (id: string, cid: number, body: unknown) => request<T.ResponseResultDto>(`${base(id)}/contacts/${cid}/responses`, json('POST', body)),
  timeline: (id: string, cid: number, limit: number, offset: number) => request<T.PageDto<T.TimelineEntryDto>>(`${base(id)}/contacts/${cid}/timeline${qs({ limit, offset })}`),
  addComment: (id: string, cid: number, text: string) => request<T.TimelineEntryDto>(`${base(id)}/contacts/${cid}/timeline/comments`, json('POST', { text })),
  editComment: (id: string, cid: number, eid: number, text: string) => request<T.TimelineEntryDto>(`${base(id)}/contacts/${cid}/timeline/${eid}`, json('PATCH', { text })),
  deleteComment: (id: string, cid: number, eid: number) => request<void>(`${base(id)}/contacts/${cid}/timeline/${eid}`, json('DELETE')),
  reachout: (id: string, cid: number, body: unknown) => request<T.FollowupDto>(`${base(id)}/contacts/${cid}/reachouts`, json('POST', body)),
  createFollowup: (id: string, cid: number, body: unknown) => request<T.FollowupDto>(`${base(id)}/contacts/${cid}/followups`, json('POST', body)),
  followups: (id: string, q: Record<string, string | number | undefined | null>) => request<T.PageDto<T.FollowupDto>>(`${base(id)}/followups${qs(q)}`),
  editMessage: (id: string, fid: number, message: string) => request<T.FollowupDto>(`${base(id)}/followups/${fid}/message`, json('PUT', { message })),
  submitManual: (id: string, fid: number, body: { choice: 'sent' | 'retry' | 'stop'; platform?: string }) => request<T.FollowupDto>(`${base(id)}/followups/${fid}/submit`, json('POST', body)),
  catchUp: (id: string, fid: number, body: unknown) => request<T.FollowupDto>(`${base(id)}/followups/${fid}/catch-up`, json('POST', body)),
  approve: (id: string, fid: number, message?: string) => request<{ followup: T.FollowupDto; delivery: unknown }>(`${base(id)}/followups/${fid}/approve`, json('POST', message === undefined ? {} : { message })),
  reject: (id: string, fid: number) => request<T.FollowupDto>(`${base(id)}/followups/${fid}/reject`, json('POST', {})),
  complete: (id: string, fid: number) => request<T.FollowupDto>(`${base(id)}/followups/${fid}/complete`, json('POST', {})),
  requestDraft: (id: string, fid: number) => request<{ followup: T.FollowupDto; applied: boolean; agentError?: string }>(`${base(id)}/followups/${fid}/draft`, json('POST', {})),
  acceptDraft: (id: string, fid: number, message?: string) => request<T.FollowupDto>(`${base(id)}/followups/${fid}/draft/accept`, json('POST', message === undefined ? {} : { message })),
  discardDraft: (id: string, fid: number) => request<T.FollowupDto>(`${base(id)}/followups/${fid}/draft`, json('DELETE')),
  customers: (id: string, q: Record<string, string | number | undefined | null>) => request<T.PageDto<T.CustomerDto>>(`${base(id)}/customers${qs(q)}`),
  lost: (id: string, q: Record<string, string | number | undefined | null>) => request<{ prospects: T.PageDto<T.ContactDto>; customers: T.PageDto<T.ContactDto> }>(`${base(id)}/lost${qs(q)}`),
  buildings: (id: string) => request<{ buildings: Array<{ id: string; name: string; typeId: string; status: string }> }>(`${base(id)}/buildings`),
  attachBuilding: (id: string, cid: number, buildingId: string) => request<T.CustomerDto>(`${base(id)}/contacts/${cid}/buildings`, json('POST', { buildingId })),
  detachBuilding: (id: string, cid: number, buildingId: string) => request<T.CustomerDto>(`${base(id)}/contacts/${cid}/buildings/${encodeURIComponent(buildingId)}`, json('DELETE')),
  previewCsv: (id: string, body: unknown) => request<T.ImportResultDto>(`${base(id)}/import/csv/preview`, json('POST', body)),
  commitCsv: (id: string, body: unknown) => request<T.ImportResultDto>(`${base(id)}/import/csv/commit`, json('POST', body)),
  importPaste: (id: string, body: { text: string; mapping: T.MappingDto; separator: T.SeparatorName; hasHeader: boolean; batchName?: string; tags: string[]; commit: boolean }) => request<T.ImportResultDto>(`${base(id)}/import/paste`, json('POST', body)),
  suggestPaste: (id: string, body: { text: string; separator?: T.SeparatorName; hasHeader?: boolean }) => request<T.PasteSuggestDto>(`${base(id)}/import/paste/suggest`, json('POST', body)),
  batches: (id: string) => request<{ batches: T.BatchDto[] }>(`${base(id)}/batches`),
  merge: (id: string, body: unknown) => request<{ contact: T.ContactDto; mergeId: number }>(`${base(id)}/merge`, json('POST', body)),
  suggestions: (id: string, limit: number, offset: number) => request<{ rows: T.SuggestionDto[]; total: number; capped: boolean; limit: number; offset: number; hasMore: boolean }>(`${base(id)}/merge/suggestions${qs({ limit, offset })}`),
  dismissSuggestion: (id: string, firstId: number, secondId: number) => request<{ ok: true }>(`${base(id)}/merge/suggestions/dismiss`, json('POST', { firstId, secondId })),
  undoMerge: (id: string, mergeId: number, assignLaterEntries?: string) => request<{ survivor: T.ContactDto; restored: T.ContactDto }>(`${base(id)}/merge/${mergeId}/undo`, json('POST', assignLaterEntries ? { assignLaterEntries } : {})),
  merges: (id: string, cid: number) => request<Array<{ id: number; survivorId: number; absorbedId: number; at: number; undone: boolean }>>(`${base(id)}/contacts/${cid}/merges`),
  /** Runs time-driven work now (due items, retries, chain ends, approved sends). The calendar and series reads never do. */
  tick: (id: string) => request<{ due: number; retried: number; chainsEnded: number; sent: number; cancelled: number }>(`${base(id)}/tick`, json('POST', {})),
  calendar: (id: string, from?: string) => request<T.CalendarDto>(`${base(id)}/calendar${qs({ from })}`),
  expandToday: (id: string) => request<T.ExpandTodayDto>(`${base(id)}/expand-today`),
  decideBlock: (id: string, day: string, key: string, body: { action: 'accept' | 'skip' | 'move'; start?: string }) => request<{ ok: true }>(`${base(id)}/calendar/blocks/${day}/${encodeURIComponent(key)}`, json('POST', body)),
  overrideSlot: (id: string, day: string, slotId: string, body: { start?: string | null; minutes?: number; skipped?: boolean }) => request<{ ok: true }>(`${base(id)}/calendar/slots/${day}/${encodeURIComponent(slotId)}`, json('PUT', body)),
  moms: (id: string, q: Record<string, string | number | undefined | null>) => request<T.PageDto<T.MomDto>>(`${base(id)}/moms${qs(q)}`),
  mom: (id: string, mid: number) => request<T.MomDto>(`${base(id)}/moms/${mid}`),
  createMom: (id: string, body: unknown) => request<T.MomDto>(`${base(id)}/moms`, json('POST', body)),
  patchMom: (id: string, mid: number, body: unknown) => request<T.MomDto>(`${base(id)}/moms/${mid}`, json('PATCH', body)),
  /** Files travel as raw bytes so a 20 MB file fits under the daemon's body limit. */
  uploadMomFile: (id: string, mid: number, kind: 'attachment' | 'audio', file: File) =>
    request<T.MomFileDto>(`${base(id)}/moms/${mid}/files${qs({ kind, name: file.name })}`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } }),
  momFileUrl: (id: string, mid: number, fileId: number) => absoluteUrl(`${base(id)}/moms/${mid}/files/${fileId}`),
  deleteMomFile: (id: string, mid: number, fileId: number) => request<void>(`${base(id)}/moms/${mid}/files/${fileId}`, json('DELETE')),
  transcribe: (id: string, mid: number) => request<{ mom: T.MomDto; agentError?: string }>(`${base(id)}/moms/${mid}/transcribe`, json('POST', {})),
  analyse: (id: string, mid: number) => request<{ mom: T.MomDto; applied: boolean; agentError?: string }>(`${base(id)}/moms/${mid}/analyse`, json('POST', {})),
  acceptMomDraft: (id: string, mid: number, body: { summary?: string; decisions?: string }) => request<T.MomDto>(`${base(id)}/moms/${mid}/draft/accept`, json('POST', body)),
  discardMomDraft: (id: string, mid: number) => request<T.MomDto>(`${base(id)}/moms/${mid}/draft`, json('DELETE')),
  actionItemToFollowup: (id: string, mid: number, index: number) => request<{ followupId: number; created: boolean }>(`${base(id)}/moms/${mid}/action-items/${index}/followup`, json('POST', {})),
  report: (id: string, q: Record<string, string | undefined | null>) => request<T.ReportDto>(`${base(id)}/reports${qs(q)}`),
  reportExportUrl: (id: string, q: Record<string, string | undefined | null>) => absoluteUrl(`${base(id)}/reports/export${qs(q)}`),
  settings: (id: string) => request<T.SettingsDto>(`${base(id)}/settings`),
  patchSettings: (id: string, body: unknown) => request<T.SettingsDto>(`${base(id)}/settings`, json('PATCH', body)),
  addCustomField: (id: string, name: string) => request<{ id: string; name: string }>(`${base(id)}/settings/custom-fields`, json('POST', { name })),
  renameCustomField: (id: string, fieldId: string, name: string) => request<{ id: string; name: string }>(`${base(id)}/settings/custom-fields/${fieldId}`, json('PATCH', { name })),
  deleteCustomField: (id: string, fieldId: string) => request<void>(`${base(id)}/settings/custom-fields/${fieldId}`, json('DELETE')),
  renameLostReason: (id: string, from: string, name: string) => request<{ lostReasons: string[] }>(`${base(id)}/settings/lost-reasons/${encodeURIComponent(from)}`, json('PUT', { name })),
  testSmtp: (id: string, to: string) => request<{ sent: true }>(`${base(id)}/settings/smtp/test`, json('POST', { to })),
};
