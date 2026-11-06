import { create } from 'zustand';
import { serverApi } from '../lib/serverApi';
import { reportBody } from '../lib/seoReports';
import type { Controls, ReportDto, SavedMetaDto, SavedReportDto, ScheduleStateDto, SummaryDto } from '../lib/seoReports';
import { SCHEDULE_ACTION, SCHEDULE_CRON, reportParams } from '../lib/seoReports';
import { failure } from './seoStore';
import type { SeoResult } from './seoStore';

/**
 * What the Reports tab shows for each SEO Building: the live report for the chosen period, the AI summary the person asked
 * for, the saved reports, and the schedule state. Only the newest live request may change what is shown, so a slow answer
 * for an old period never replaces the one for the current period.
 */
export interface SeoReportsState {
  reportByProject: Record<string, ReportDto | undefined>;
  summaryByProject: Record<string, SummaryDto | null | undefined>;
  summaryBusy: Record<string, boolean>;
  summaryError: Record<string, string | null>;
  savedByProject: Record<string, SavedMetaDto[] | undefined>;
  openedByProject: Record<string, SavedReportDto | null | undefined>;
  scheduleByProject: Record<string, ScheduleStateDto | undefined>;
  loadReport: (id: string, controls: Controls) => Promise<SeoResult>;
  writeSummary: (id: string, controls: Controls) => Promise<SeoResult>;
  loadSaved: (id: string) => Promise<SeoResult>;
  openSaved: (id: string, reportId: string) => Promise<SeoResult>;
  closeSaved: (id: string) => void;
  saveReport: (id: string, controls: Controls, name: string) => Promise<SeoResult<{ saved: SavedMetaDto }>>;
  deleteSaved: (id: string, reportId: string) => Promise<SeoResult>;
  loadSchedule: (id: string) => Promise<SeoResult>;
  setSchedule: (id: string, cadence: 'weekly' | 'monthly', enabled: boolean) => Promise<SeoResult>;
}

export const useSeoReportsStore = create<SeoReportsState>((set, get) => {
  const attempt = async <T extends object>(work: () => Promise<T>): Promise<SeoResult<T>> => {
    try { return { ok: true, ...(await work()) }; } catch (error) { return failure(error); }
  };
  const put = <K extends keyof SeoReportsState>(field: K, id: string, value: unknown) =>
    set((s) => ({ [field]: { ...(s[field] as Record<string, unknown>), [id]: value } }) as Partial<SeoReportsState>);
  let reportCounter = 0;

  return {
    reportByProject: {}, summaryByProject: {}, summaryBusy: {}, summaryError: {}, savedByProject: {}, openedByProject: {}, scheduleByProject: {},
    loadReport: (id, controls) => {
      const mine = ++reportCounter;
      return attempt(async () => {
        const report = await serverApi.seoReport(id, reportParams(controls));
        if (mine === reportCounter) put('reportByProject', id, report);
        return {};
      });
    },
    writeSummary: async (id, controls) => {
      if (get().summaryBusy[id]) return { ok: false, status: 409, error: 'A summary is already being written', requiresConfirmation: false };
      put('summaryBusy', id, true);
      put('summaryError', id, null);
      const result = await attempt(async () => { put('summaryByProject', id, await serverApi.seoReportSummary(id, reportBody(controls))); return {}; });
      put('summaryBusy', id, false);
      if (!result.ok) put('summaryError', id, result.error);
      return result;
    },
    loadSaved: (id) => attempt(async () => { put('savedByProject', id, (await serverApi.seoSavedReports(id)).reports); return {}; }),
    openSaved: (id, reportId) => attempt(async () => { put('openedByProject', id, await serverApi.seoSavedReport(id, reportId)); return {}; }),
    closeSaved: (id) => put('openedByProject', id, null),
    saveReport: (id, controls, name) => attempt(async () => {
      const summary = get().summaryByProject[id];
      const saved = await serverApi.seoSaveReport(id, { ...reportBody(controls), ...(name.trim() ? { name: name.trim() } : {}), ...(summary ? { summary } : {}) });
      await get().loadSaved(id);
      return { saved };
    }),
    deleteSaved: (id, reportId) => attempt(async () => {
      await serverApi.seoDeleteReport(id, reportId);
      if (get().openedByProject[id]?.id === reportId) put('openedByProject', id, null);
      await get().loadSaved(id);
      return {};
    }),
    loadSchedule: (id) => attempt(async () => { put('scheduleByProject', id, await serverApi.seoReportSchedule(id)); return {}; }),
    setSchedule: (id, cadence, enabled) => attempt(async () => {
      const existing = get().scheduleByProject[id]?.schedules.find((s) => s.cadence === cadence);
      if (existing) await serverApi.seoUpdateSchedule(id, existing.id, { enabled });
      else if (enabled) await serverApi.seoCreateSchedule(id, { name: cadence === 'weekly' ? 'Weekly SEO report' : 'Monthly SEO report', actionId: SCHEDULE_ACTION[cadence], cron: SCHEDULE_CRON[cadence] });
      await get().loadSchedule(id);
      return {};
    }),
  };
});
