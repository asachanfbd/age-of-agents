import type { KpiItem } from './kpi';
import type { SeoTab } from './seoWorkspace';

/** What the SEO stores have already loaded; null means that slice has not been read yet. */
export interface SeoKpiData {
  keywords: number | null; clusters: number | null; pendingSuggestions: number | null; pages: number | null; sitemaps: number | null; urls: number | null;
  backlinks: number | null; referringDomains: number | null; newBacklinks: number | null; lostBacklinks: number | null;
}
export const noSeoKpiData = (): SeoKpiData => ({ keywords: null, clusters: null, pendingSuggestions: null, pages: null, sitemaps: null, urls: null, backlinks: null, referringDomains: null, newBacklinks: null, lostBacklinks: null });

const item = (key: keyof SeoKpiData, label: string, data: SeoKpiData): KpiItem => ({ key, label, value: data[key] });

/** The KPI row of each SEO tab, from data its own tab already loaded; tabs with nothing countable have none. */
export function seoKpisForTab(tab: SeoTab, data: SeoKpiData): KpiItem[] {
  switch (tab) {
    case 'keywords': return [item('keywords', 'Keywords', data), item('clusters', 'Clusters', data), item('pendingSuggestions', 'To review', data)];
    case 'sitemaps': return [item('sitemaps', 'Sitemaps', data), item('urls', 'URLs', data)];
    case 'pages': return [item('pages', 'Pages', data)];
    case 'backlinks': return [item('backlinks', 'Backlinks', data), item('referringDomains', 'Referring domains', data), item('newBacklinks', 'New', data), item('lostBacklinks', 'Lost', data)];
    default: return [];
  }
}
