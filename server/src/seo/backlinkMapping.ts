import { SeoInputError } from './errors.ts';

export const BACKLINK_FIELDS = ['sourceUrl', 'targetUrl', 'anchor', 'linkType', 'firstSeen', 'lastSeen', 'sourceDr', 'sourceUr', 'sourceTraffic', 'pageDr', 'pageUr', 'pageTraffic'] as const;
export type BacklinkField = (typeof BACKLINK_FIELDS)[number];
export const REQUIRED_FIELDS: BacklinkField[] = ['sourceUrl', 'targetUrl'];

/** Which file column holds each field; fields without a column are absent. */
export type Mapping = Partial<Record<BacklinkField, string>>;

export const FIELD_LABELS: Record<BacklinkField, string> = {
  sourceUrl: 'Source URL', targetUrl: 'Target URL', anchor: 'Anchor text', linkType: 'Link type', firstSeen: 'First seen', lastSeen: 'Last seen',
  sourceDr: 'Source DR', sourceUr: 'Source UR', sourceTraffic: 'Source traffic', pageDr: 'Linking page DR', pageUr: 'Linking page UR', pageTraffic: 'Linking page traffic',
};

export interface Preset { id: string; name: string; headers: Partial<Record<BacklinkField, string[]>> }

/**
 * Export formats as their tools name the columns, written from the tools' documented exports and never checked against a
 * live export. Header text is compared ignoring case, spacing and punctuation.
 */
export const PRESETS: Preset[] = [
  {
    id: 'ahrefs', name: 'Ahrefs',
    headers: {
      sourceUrl: ['Referring page URL'], targetUrl: ['Target URL'], anchor: ['Anchor'], linkType: ['Type'], firstSeen: ['First seen'], lastSeen: ['Last seen'],
      sourceDr: ['Domain rating'], sourceUr: ['UR'], sourceTraffic: ['Domain traffic'], pageTraffic: ['Page traffic'],
    },
  },
  {
    id: 'semrush', name: 'Semrush',
    headers: {
      sourceUrl: ['Source url'], targetUrl: ['Target url'], anchor: ['Anchor'], firstSeen: ['First seen'], lastSeen: ['Last seen'], sourceDr: ['Page ascore'],
    },
  },
  {
    id: 'moz', name: 'Moz',
    headers: {
      sourceUrl: ['Source URL', 'Source Page'], targetUrl: ['Target URL', 'Target Page'], anchor: ['Anchor Text'], linkType: ['Link Type'],
      firstSeen: ['Date First Seen', 'First Seen'], lastSeen: ['Date Last Seen', 'Last Seen'], sourceDr: ['Source Domain Authority'], sourceUr: ['Source Page Authority'],
    },
  },
  {
    id: 'gsc', name: 'Google Search Console',
    headers: { sourceUrl: ['Linking page', 'Source page'], targetUrl: ['Target page', 'Linked page'], lastSeen: ['Last crawled', 'Last linked'] },
  },
];

export const normalizeHeader = (h: string): string => h.replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The columns of `headers` that a preset names; the result may miss required fields. */
export function applyPreset(preset: Preset, headers: string[]): Mapping {
  const byName = new Map(headers.map((h) => [normalizeHeader(h), h]));
  const mapping: Mapping = {};
  for (const field of BACKLINK_FIELDS) {
    for (const name of preset.headers[field] ?? []) {
      const found = byName.get(normalizeHeader(name));
      if (found !== undefined) { mapping[field] = found; break; }
    }
  }
  return mapping;
}

/** The single preset whose required columns are all present, or null when none or several fit (the person then maps by hand). */
export function suggestPreset(headers: string[]): Preset | null {
  const fits = PRESETS.filter((p) => REQUIRED_FIELDS.every((f) => applyPreset(p, headers)[f] !== undefined));
  if (fits.length === 1) return fits[0]!;
  if (fits.length < 2) return null;
  const score = (p: Preset) => Object.keys(applyPreset(p, headers)).length;
  const best = Math.max(...fits.map(score));
  const top = fits.filter((p) => score(p) === best);
  return top.length === 1 ? top[0]! : null;
}

/** Checks a mapping against the file's headers; the error says what the person must fix. */
export function validateMapping(mapping: unknown, headers: string[]): Mapping {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new SeoInputError('The column mapping is missing.');
  const out: Mapping = {};
  const used = new Map<string, BacklinkField>();
  for (const [field, column] of Object.entries(mapping as Record<string, unknown>)) {
    if (column === undefined || column === null || column === '') continue;
    if (!(BACKLINK_FIELDS as readonly string[]).includes(field)) throw new SeoInputError(`"${field}" is not a field that can be mapped.`);
    if (typeof column !== 'string' || !headers.includes(column)) throw new SeoInputError(`The column "${String(column).slice(0, 60)}" is not in the file.`);
    const taken = used.get(column);
    if (taken) throw new SeoInputError(`The column "${column}" cannot hold both ${FIELD_LABELS[taken]} and ${FIELD_LABELS[field as BacklinkField]}.`);
    used.set(column, field as BacklinkField);
    out[field as BacklinkField] = column;
  }
  for (const field of REQUIRED_FIELDS) if (!out[field]) throw new SeoInputError(`${FIELD_LABELS[field]} needs a column.`);
  return out;
}

export const MAX_MAPPING_NAME = 60;

export function mappingName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_MAPPING_NAME) throw new SeoInputError(`A saved mapping needs a name of 1 to ${MAX_MAPPING_NAME} characters.`);
  return name;
}
