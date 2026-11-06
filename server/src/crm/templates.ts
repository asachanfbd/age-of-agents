import type { CrmSettings } from './settings.ts';

export interface TemplateContext { name?: string | null; company?: string | null; title?: string | null; custom?: Record<string, string> }
export interface Rendered { text: string; unknownFields: string[]; emptyFields: string[] }

const FIELD = /\{([^{}]*)\}/g;

/** Substitutes {name}, {company}, {title} and custom fields (matched ignoring case). An unknown field stays visible; a known empty one renders empty. */
export function renderTemplate(template: string, ctx: TemplateContext): Rendered {
  const values = new Map<string, string>([
    ['name', ctx.name ?? ''], ['company', ctx.company ?? ''], ['title', ctx.title ?? ''],
  ]);
  for (const [k, v] of Object.entries(ctx.custom ?? {})) values.set(k.toLowerCase(), v ?? '');
  const unknown = new Set<string>(), empty = new Set<string>();
  const text = template.replace(FIELD, (whole, raw: string) => {
    const key = raw.trim().toLowerCase();
    if (!key || !values.has(key)) { if (key) unknown.add(raw.trim()); return whole; }
    const v = values.get(key)!;
    if (!v) empty.add(key);
    return v;
  });
  return { text, unknownFields: [...unknown], emptyFields: [...empty] };
}

export const templateKey = (channel: string, step: number) => `${channel}:${step}`;

export function templateFor(settings: CrmSettings, channel: string, step: number): string | null {
  return settings.templates[templateKey(channel, step)] ?? null;
}

/** Appends the opt-out footer once; an empty footer, or text that already ends with it, is left alone. */
export function withFooter(body: string, footer: string): string {
  const f = footer.trim();
  if (!f || body.includes(f)) return body;
  return `${body.trimEnd()}\n\n${f}`;
}
