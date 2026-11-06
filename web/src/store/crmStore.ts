import { create } from 'zustand';
import { crmApi } from '../lib/crmApi';
import type { ContactDto, PageDto, SettingsDto } from '../lib/crmTypes';
import { queryParams } from '../lib/crmProspects';
import type { ListQuery } from '../lib/crmProspects';
import { ApiError } from '../lib/serverApi';

export type CrmResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string; details: Record<string, unknown> };

export function crmFailure(error: unknown): CrmResult & { ok: false } {
  if (error instanceof ApiError) return { ok: false, status: error.status, error: error.message, details: error.details };
  return { ok: false, status: 0, error: error instanceof Error ? error.message : 'The request failed', details: {} };
}

interface ContactsView { query: ListQuery; page: PageDto<ContactDto> | null; loading: boolean; error: string | null }

export interface CrmState {
  contactsByProject: Record<string, ContactsView>;
  settingsByProject: Record<string, SettingsDto>;
  /** Only the newest list request may change what is shown; an older answer that arrives late is dropped. */
  loadContacts: (id: string, query: ListQuery) => Promise<CrmResult>;
  loadSettings: (id: string) => Promise<CrmResult>;
  saveSettings: (id: string, patch: unknown) => Promise<CrmResult>;
}

const newest = new Map<string, number>();

export const useCrmStore = create<CrmState>((set) => {
  const view = (id: string, patch: Partial<ContactsView>) => set((s) => {
    const cur = s.contactsByProject[id] ?? { query: patch.query!, page: null, loading: false, error: null };
    return { contactsByProject: { ...s.contactsByProject, [id]: { ...cur, ...patch } } };
  });
  return {
    contactsByProject: {},
    settingsByProject: {},
    async loadContacts(id, query) {
      const token = (newest.get(id) ?? 0) + 1;
      newest.set(id, token);
      view(id, { query, loading: true, error: null });
      try {
        const page = await crmApi.contacts(id, queryParams(query));
        if (newest.get(id) === token) view(id, { page, loading: false });
        return { ok: true };
      } catch (error) {
        const failed = crmFailure(error);
        if (newest.get(id) === token) view(id, { loading: false, error: failed.error });
        return failed;
      }
    },
    async loadSettings(id) {
      try { const settings = await crmApi.settings(id); set((s) => ({ settingsByProject: { ...s.settingsByProject, [id]: settings } })); return { ok: true }; }
      catch (error) { return crmFailure(error); }
    },
    async saveSettings(id, patch) {
      try { const settings = await crmApi.patchSettings(id, patch); set((s) => ({ settingsByProject: { ...s.settingsByProject, [id]: settings } })); return { ok: true }; }
      catch (error) { return crmFailure(error); }
    },
  };
});
