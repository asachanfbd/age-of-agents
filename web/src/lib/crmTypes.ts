/** Wire shapes of the CRM Building's API (`/api/projects/:id/crm`); see docs/crm-building.md. */

export type ChannelType = 'phone' | 'email' | 'instagram' | 'facebook' | 'linkedin' | 'other';
export type Segment = 'prospect' | 'customer' | 'lost_prospect' | 'lost_customer';
export type Stage = 'New' | 'Contacted' | 'Engaged' | 'Meeting set' | 'Proposal';
export type FollowupType = 'call' | 'message' | 'email' | 'dm' | 'online_meeting' | 'in_person_meeting' | 'appointment' | 'other';
export type FollowupState = 'planned' | 'pending' | 'approved' | 'sent' | 'failed' | 'cancelled' | 'done';
export type Outcome = 'interested' | 'not_interested' | 'later' | 'wrong_number' | 'no_response_yet' | 'became_customer';
export type TranscriptStatus = 'none' | 'automatic' | 'pasted';

export interface ChannelDto { id: number; type: ChannelType; label: string; handle: string; invalid: boolean; dnc: boolean }

export interface ContactDto {
  id: number; name: string | null; company: string | null; title: string | null; tags: string[]; custom: Record<string, string>;
  segment: Segment; stage: Stage | null; lostReason: string | null; lostAt: number | null; customerAt: number | null;
  noResponse: boolean; noResponseAt: number | null; resurfaceAt: number | null; callbackAt: number | null; dnc: boolean;
  source: string; batchId: number | null; createdAt: number; channels: ChannelDto[];
  pendingReachout?: boolean; awaitingApproval?: boolean;
}

export interface PageDto<T> { rows: T[]; total: number; limit: number; offset: number; hasMore: boolean }

export interface TimelineEntryDto { id: number; contactId: number; kind: string; at: number; text: string; data: Record<string, unknown>; deleted: boolean; editedAt: number | null }

export interface FollowupDto {
  id: number; contactId: number; contactName: string | null; channelId: number | null; channelType: ChannelType | null; channelHandle: string | null;
  kind: 'reachout' | 'followup' | 'task'; step: number; type: FollowupType; state: FollowupState; title: string; dueAt: number; message: string | null; draft: string | null;
  platform: string | null; defaultPlatform: string | null; sentAt: number | null; doneAt: number | null; tries: number; retryAt: number | null; delayReason: string | null;
  durationMin: number; catchUp: boolean; unknownFields: string[]; integrated: boolean; checkedAt: number | null;
}

export type CalendarItemDto = FollowupDto & { overdue: boolean };
export interface SessionDto { key: string; kind: 'messages' | 'calls'; minutes: number; count: number; start: number | null; end: number | null; state: 'suggested' | 'accepted' | 'unplaced'; items: CalendarItemDto[] }
export interface SlotDto { id: string; name: string; minutes: number; start: number | null; end: number | null; state: 'placed' | 'skipped' | 'no_room'; conflict: boolean; fixedStart: boolean }
export interface DayDto {
  day: string; label: string; window: { start: number; end: number } | null; overdue: CalendarItemDto[]; fixed: Array<{ item: CalendarItemDto; start: number; end: number }>;
  sessions: SessionDto[]; slots: SlotDto[]; freeMinutes: number; truncated: boolean; moreSessions: number;
}
export interface CalendarDto { timezone: string; today: string; from: string; days: DayDto[] }

export interface ExpandGroupDto { id: 'sent_no_response' | 'overdue' | 'awaiting_approval' | 'failed_retry' | 'agenda'; title: string; emptyText: string; cards: unknown[] }
export interface ExpandTodayDto { today: string; groups: ExpandGroupDto[]; total: number }

export interface ImportCountsDto { added: number; existing: number; duplicatesInFile: number; rejected: number }
export interface ImportResultDto extends ImportCountsDto {
  rejectedRows: Array<{ line: number; reason: string }>; rejectedTruncated: boolean; reopenOffers: Array<{ contactId: number; line: number }>; batchId: number | null; committed: boolean;
}
export interface BatchDto { id: number; name: string; kind: string; fileName: string | null; tags: string[]; counts: ImportCountsDto; createdAt: number }
export interface ChannelMappingDto { column: string; type: ChannelType; label?: string }
export interface MappingDto { channels: ChannelMappingDto[]; name?: string; company?: string; title?: string; tags?: string; custom?: Record<string, string> }
export type SeparatorName = 'tab' | 'comma' | 'semicolon' | 'pipe' | 'none';
export interface PasteSuggestDto {
  separator: SeparatorName; hasHeader: boolean; rows: number;
  columns: Array<{ name: string; samples: string[]; byAgent: boolean }>;
  mapping: MappingDto; agentUsed: boolean; agentError?: string;
}

export interface SuggestionDto { first: { id: number; name: string | null; company: string | null }; second: { id: number; name: string | null; company: string | null } }

export type BuildingPeekDto =
  | { state: 'ok'; name: string; typeId: string; status: string; summary: string | null }
  | { state: 'unavailable' }
  | { state: 'read_failed'; reason: string };
export interface WorkLogEntryDto { id: number; at: number; phase: 'started' | 'finished'; taskTitle: string; summary: string; rewritten: boolean; backfilled: boolean }
/** `workLog` and `workLogTotal` are absent from a server that predates work updates; they read as an empty log. */
export interface AttachedBuildingDto { buildingId: string; attachedAt: number; peek: BuildingPeekDto; workLog?: WorkLogEntryDto[] | null; workLogTotal?: number | null }
export type CustomerDto = ContactDto & { buildings: AttachedBuildingDto[] };

export interface MomFileDto { id: number; kind: 'attachment' | 'audio'; name: string; size: number }
export interface ActionItemDto { title: string; dueAt?: number; type?: string; followupId?: number | null }
export interface MomDto {
  id: number; contactId: number; contactName: string | null; targetKind: string; targetId: number; notes: string; transcript: string; transcriptStatus: TranscriptStatus;
  summary: string; decisions: string; attendees: number[]; actionItems: ActionItemDto[]; draft: { summary: string; decisions: string; actionItems: string[] } | null;
  files: MomFileDto[]; createdAt: number; updatedAt: number;
}

export interface MetricsDto {
  prospectsAdded: number | null; reachoutsSent: number | null; followupsSent: number | null; onTime: number | null; delayed: number | null;
  maxDelayMinutes: number | null; lostProspects: number | null; lostCustomers: number | null; newCustomers: number | null;
}
export interface PeriodDto { label: string; startDay: string; endDay: string; metrics: MetricsDto }
export interface BreakdownRowDto { label: string; added: number | null; reachoutsSent: number | null; followupsSent: number | null }
export interface ReportDto { period: PeriodDto; previous: PeriodDto; beforeFirstRecord: boolean; firstRecordDay: string | null; hasRecords: boolean; byChannel: BreakdownRowDto[]; bySource: BreakdownRowDto[] }

export type SmtpState = 'not_connected' | 'connected' | 'needs_attention';
export interface SmtpStatusDto { state: SmtpState; reason: string | null; passwordSaved: boolean; configured: boolean }
export interface WorkingDayDto { open: boolean; start: string; end: string }
export interface DailySlotDto { id: string; name: string; minutes: number; start: string | null }
export interface SettingsDto {
  cadence: { gapDays: [number, number]; followups: number; retryHours: number; retryTries: number; autoLost: boolean; resurfaceDays: number };
  approval: Record<string, boolean>; agentAutoApply: { messageDrafts: boolean; moms: boolean }; templates: Record<string, string>;
  durations: Record<FollowupType, number>; sessions: { messagesPer30: number; callsPer30: number }; workingHours: WorkingDayDto[]; timezone: string;
  dailySlots: DailySlotDto[]; lostReasons: string[]; customFields: Array<{ id: string; name: string }>; countryCode: string | null; emailFooter: string;
  email: { dailyCap: number; gapSeconds: number }; onTimeMinutes: number;
  smtp: { host: string; port: number; security: 'starttls' | 'ssl' | 'none'; user: string; from: string; status: SmtpStatusDto };
}

export interface ResponseResultDto { contact: ContactDto; outcome: Outcome; needsLostDecision?: boolean; createdFollowupId?: number }
