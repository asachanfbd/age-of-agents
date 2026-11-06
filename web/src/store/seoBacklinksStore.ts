import { create } from 'zustand';
import { serverApi } from '../lib/serverApi';
import type { BacklinksDto, BatchDto, CommitDto, Controls, DomainRollupDto, ImportRequestDto, MappingDto, OverviewDto, PreviewDto, TargetRollupDto } from '../lib/seoBacklinks';
import { listParams } from '../lib/seoBacklinks';
import { failure } from './seoStore';
import type { SeoResult } from './seoStore';

/**
 * What the Backlinks tab shows for each SEO Building. Only the newest list request may change what is shown, so a slow older
 * answer cannot overwrite a newer one. An import is previewed (nothing saved) and then committed with the same file and mapping.
 */
export interface SeoBacklinksState {
  listByProject: Record<string, BacklinksDto>;
  overviewByProject: Record<string, OverviewDto>;
  domainsByProject: Record<string, DomainRollupDto[]>;
  targetsByProject: Record<string, TargetRollupDto[]>;
  batchesByProject: Record<string, BatchDto[]>;
  mappingsByProject: Record<string, MappingDto[]>;
  loadList: (id: string, controls: Controls, offset?: number) => Promise<SeoResult>;
  loadOverview: (id: string, period: number) => Promise<SeoResult>;
  loadRollups: (id: string) => Promise<SeoResult>;
  loadImports: (id: string) => Promise<SeoResult>;
  previewImport: (id: string, body: ImportRequestDto) => Promise<SeoResult<{ preview: PreviewDto }>>;
  commitImport: (id: string, body: ImportRequestDto, controls: Controls) => Promise<SeoResult<{ result: CommitDto }>>;
  saveNote: (id: string, uid: string, note: string) => Promise<SeoResult>;
  deleteLink: (id: string, uid: string, controls: Controls) => Promise<SeoResult>;
}

export const useSeoBacklinksStore = create<SeoBacklinksState>((set, get) => {
  const attempt = async <T extends object>(work: () => Promise<T>): Promise<SeoResult<T>> => {
    try { return { ok: true, ...(await work()) }; } catch (error) { return failure(error); }
  };
  let listCounter = 0;
  const put = <K extends keyof SeoBacklinksState>(field: K, id: string, value: SeoBacklinksState[K] extends Record<string, infer V> ? V : never) =>
    set((s) => ({ [field]: { ...(s[field] as Record<string, unknown>), [id]: value } }) as Partial<SeoBacklinksState>);
  const refresh = async (id: string, controls: Controls) => {
    await Promise.all([get().loadList(id, controls), get().loadOverview(id, controls.period), get().loadRollups(id), get().loadImports(id)]);
  };

  return {
    listByProject: {}, overviewByProject: {}, domainsByProject: {}, targetsByProject: {}, batchesByProject: {}, mappingsByProject: {},
    loadList: (id, controls, offset = 0) => {
      const mine = ++listCounter;
      return attempt(async () => {
        const data = await serverApi.seoBacklinks(id, listParams(controls, offset));
        if (mine !== listCounter) return {};
        const earlier = offset > 0 ? get().listByProject[id]?.links ?? [] : [];
        put('listByProject', id, { ...data, links: [...earlier, ...data.links] });
        return {};
      });
    },
    loadOverview: (id, period) => attempt(async () => { put('overviewByProject', id, await serverApi.seoBacklinkOverview(id, period)); return {}; }),
    loadRollups: (id) => attempt(async () => {
      const [domains, targets] = await Promise.all([serverApi.seoBacklinkDomains(id), serverApi.seoBacklinkTargets(id)]);
      put('domainsByProject', id, domains.domains);
      put('targetsByProject', id, targets.targets);
      return {};
    }),
    loadImports: (id) => attempt(async () => {
      const [batches, mappings] = await Promise.all([serverApi.seoBacklinkBatches(id), serverApi.seoBacklinkMappings(id)]);
      put('batchesByProject', id, batches.batches);
      put('mappingsByProject', id, mappings.mappings);
      return {};
    }),
    previewImport: (id, body) => attempt(async () => ({ preview: await serverApi.seoPreviewBacklinkImport(id, body) })),
    commitImport: (id, body, controls) => attempt(async () => { const result = await serverApi.seoCommitBacklinkImport(id, body); await refresh(id, controls); return { result }; }),
    saveNote: (id, uid, note) => attempt(async () => {
      const saved = await serverApi.seoSetBacklinkNote(id, uid, note);
      const list = get().listByProject[id];
      if (list) put('listByProject', id, { ...list, links: list.links.map((l) => (l.uid === uid ? { ...l, note: saved.note } : l)) });
      return {};
    }),
    deleteLink: (id, uid, controls) => attempt(async () => { await serverApi.seoDeleteBacklink(id, uid); await refresh(id, controls); return {}; }),
  };
});
