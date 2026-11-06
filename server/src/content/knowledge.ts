import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { ContentConflictError, ContentInputError, ContentNotFoundError } from './errors.ts';
import { saveVersioned } from './versioned.ts';
import { knowledgeDir, readText, removeFile, versionOf, writeTextAtomic } from './files.ts';
import { COLOURS_MAX, COLOUR_NAME_MAX, CUSTOM_SECTIONS_MAX, SECTION_NAME_MAX } from './limits.ts';
import { charCount } from './validate.ts';
import { STYLE_FILE, STYLE_VERSION_KEY, starterStyle } from './style.ts';
import { writeMeta } from './db.ts';
import { INSIGHTS_FILE } from './insightsInstructions.ts';

export interface SectionDef { id: string; name: string; builtin: boolean; file: string }
export interface SectionMeta extends SectionDef { version: string; changedAt: string | null }
export interface SectionView extends SectionMeta { content: string }

export const BUILTIN_SECTIONS: readonly SectionDef[] = [
  { id: 'about', name: 'About the business', builtin: true, file: 'about.md' },
  { id: 'audience', name: 'Audience', builtin: true, file: 'audience.md' },
  { id: 'products', name: 'Products and offers', builtin: true, file: 'products.md' },
  { id: 'facts', name: 'Facts and numbers', builtin: true, file: 'facts.md' },
  { id: 'links', name: 'Links', builtin: true, file: 'links.md' },
  { id: 'dos-donts', name: "Do's and don'ts", builtin: true, file: 'dos-donts.md' },
];

const REGISTRY = 'sections.json';
const COLOURS = 'colours.json';
const README = 'README.md';
const kdir = (ctx: { dir: string }) => knowledgeDir(ctx.dir);

async function customSections(dir: string): Promise<SectionDef[]> {
  try {
    const parsed = JSON.parse((await readText(path.join(dir, REGISTRY))).content) as { custom?: Array<{ id?: unknown; name?: unknown }> };
    return (parsed.custom ?? []).filter((c) => typeof c.id === 'string' && typeof c.name === 'string')
      .map((c) => ({ id: c.id as string, name: c.name as string, builtin: false, file: `${c.id as string}.md` }));
  } catch { return []; }
}
const saveCustom = (dir: string, custom: SectionDef[]) => writeTextAtomic(path.join(dir, REGISTRY), `${JSON.stringify({ custom: custom.map(({ id, name }) => ({ id, name })) }, null, 2)}\n`);

async function allSections(dir: string): Promise<SectionDef[]> { return [...BUILTIN_SECTIONS, ...await customSections(dir)]; }

async function metaOf(dir: string, def: SectionDef): Promise<SectionView> {
  const { content, changedAt } = await readText(path.join(dir, def.file));
  return { ...def, content, version: versionOf(content), changedAt };
}
const withoutContent = ({ content: _content, ...meta }: SectionView): SectionMeta => meta;

export async function listSections(ctx: ContentCtx): Promise<SectionMeta[]> {
  const dir = kdir(ctx);
  return Promise.all((await allSections(dir)).map(async (def) => withoutContent(await metaOf(dir, def))));
}

async function find(ctx: ContentCtx, id: string): Promise<SectionDef> {
  const def = (await allSections(kdir(ctx))).find((s) => s.id === id);
  if (!def) throw new ContentNotFoundError('That section does not exist');
  return def;
}

export async function readSection(ctx: ContentCtx, id: string): Promise<SectionView> {
  return metaOf(kdir(ctx), await find(ctx, id));
}

export async function putSection(ctx: ContentCtx, id: string, body: unknown): Promise<SectionView> {
  const def = await find(ctx, id);
  const saved = await saveVersioned(path.join(kdir(ctx), def.file), (body ?? {}) as Record<string, unknown>);
  return { ...def, ...saved };
}

const slugOf = (name: string): string => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

export async function createSection(ctx: ContentCtx, body: unknown): Promise<SectionMeta> {
  const raw = ((body ?? {}) as { name?: unknown }).name;
  if (typeof raw !== 'string' || !raw.trim()) throw new ContentInputError('name is required', 'name');
  const name = raw.trim();
  if (charCount(name) > SECTION_NAME_MAX) throw new ContentInputError(`name must be at most ${SECTION_NAME_MAX} characters`, 'name');
  const dir = kdir(ctx);
  const sections = await allSections(dir);
  if (sections.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new ContentConflictError('A section with that name already exists');
  const custom = sections.filter((s) => !s.builtin);
  if (custom.length >= CUSTOM_SECTIONS_MAX) throw new ContentInputError(`At most ${CUSTOM_SECTIONS_MAX} custom sections`, 'name');
  const base = `custom-${slugOf(name)}`;
  let id = base;
  for (let n = 2; sections.some((s) => s.id === id); n++) id = `${base}-${n}`;
  const def: SectionDef = { id, name, builtin: false, file: `${id}.md` };
  await writeTextAtomic(path.join(dir, def.file), `# ${name}\n\n`);
  await saveCustom(dir, [...custom, def]);
  await writeReadme(ctx.dir);
  return withoutContent(await metaOf(dir, def));
}

export async function deleteSection(ctx: ContentCtx, id: string): Promise<void> {
  const def = await find(ctx, id);
  if (def.builtin) throw new ContentInputError('The built-in sections cannot be deleted', 'id');
  const dir = kdir(ctx);
  await saveCustom(dir, (await customSections(dir)).filter((s) => s.id !== id));
  await removeFile(path.join(dir, def.file));
  await writeReadme(ctx.dir);
}

// ---- colours -------------------------------------------------------------

export interface Colour { name: string; hex: string }

export async function readColours(ctx: ContentCtx): Promise<Colour[]> {
  try {
    const parsed = JSON.parse((await readText(path.join(kdir(ctx), COLOURS))).content) as unknown;
    return Array.isArray(parsed) ? parsed.filter((c): c is Colour => typeof c?.name === 'string' && typeof c?.hex === 'string') : [];
  } catch { return []; }
}

export async function putColours(ctx: ContentCtx, body: unknown): Promise<Colour[]> {
  const list = (body as { colours?: unknown } | undefined)?.colours;
  if (!Array.isArray(list)) throw new ContentInputError('colours must be a list', 'colours');
  if (list.length > COLOURS_MAX) throw new ContentInputError(`At most ${COLOURS_MAX} colours`, 'colours');
  const seen = new Set<string>();
  const colours = list.map((item: { name?: unknown; hex?: unknown }): Colour => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name || charCount(name) > COLOUR_NAME_MAX) throw new ContentInputError(`A colour name must be 1 to ${COLOUR_NAME_MAX} characters`, 'colours');
    if (typeof item.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(item.hex)) throw new ContentInputError('A colour must be a hex value such as #1A2B3C', 'colours');
    if (seen.has(name.toLowerCase())) throw new ContentInputError(`The colour name "${name}" is used twice`, 'colours');
    seen.add(name.toLowerCase());
    return { name, hex: item.hex.toUpperCase() };
  });
  await writeTextAtomic(path.join(kdir(ctx), COLOURS), `${JSON.stringify(colours, null, 2)}\n`);
  return colours;
}

// ---- folder bootstrap ----------------------------------------------------

/** Tells agents what each file in the folder is. Written by the daemon and never edited in the web. */
export async function writeReadme(buildingDir: string): Promise<void> {
  const dir = knowledgeDir(buildingDir);
  const custom = await customSections(dir);
  const lines = [
    '# Business knowledge',
    '',
    'What agents must know about this business before writing content. Each text file is Markdown that the owner edits in the Knowledge tab; agents may edit it too.',
    '',
    ...[...BUILTIN_SECTIONS, ...custom].map((s) => `- \`${s.file}\`: ${s.name}`),
    `- \`${STYLE_FILE}\`: the writing style (a General section and one per platform).`,
    `- \`${INSIGHTS_FILE}\`: what has worked and not worked on published posts, with the owner's notes on top. Written by the app from the stats; read it before proposing anything and do not edit it.`,
    `- \`${COLOURS}\`: the brand colours, a JSON list of \`{ "name", "hex" }\`.`,
    '- `files/`: brand files (logo, fonts, reference images, documents), as uploaded.',
    `- \`${REGISTRY}\`: the list of owner-added sections. Managed by the app; do not edit.`,
    '',
  ];
  await writeTextAtomic(path.join(dir, README), lines.join('\n'));
}

/** Creates the starter files of a new Building: one heading per section, the writing style skeleton and the README. */
export async function bootstrapKnowledge(ctx: ContentCtx): Promise<void> {
  const dir = kdir(ctx);
  for (const s of BUILTIN_SECTIONS) await writeTextAtomic(path.join(dir, s.file), `# ${s.name}\n\n`);
  const style = starterStyle();
  await writeTextAtomic(path.join(dir, STYLE_FILE), style);
  writeMeta(ctx.db, STYLE_VERSION_KEY, versionOf(style));
  await writeReadme(ctx.dir);
}
