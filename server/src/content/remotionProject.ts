import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecordId } from './concepts.ts';
import type { ContentCtx } from './context.ts';
import { readMeta, writeMeta } from './db.ts';
import { ContentNotFoundError } from './errors.ts';
import { writeTextAtomic } from './files.ts';
import { contentJobs } from './jobs.ts';
import { videoDeps } from './videoDeps.ts';

/**
 * The Building's one shared Remotion project, `<building>/remotion/`, created on the first video session. Brand pieces in
 * `src/brand/` are shared by every video; each Concept owns `src/concepts/<conceptId>/`; media lives in
 * `public/concepts/<conceptId>/media/` so compositions load it with `staticFile`. The Images tab's still compositions live in
 * `src/concepts/<conceptId>/images/<postId>/<name>.tsx`, the Thumbnail tab's in `src/concepts/<conceptId>/thumbnail/<name>.tsx`. The
 * daemon owns `src/concepts/registry.ts`, which lists them all.
 */

/** The pinned template: Remotion 4 and the packages its TypeScript template uses, exact versions only. */
export const REMOTION_VERSION = '4.0.529';
export const REMOTION_PACKAGES = {
  dependencies: { '@remotion/cli': REMOTION_VERSION, remotion: REMOTION_VERSION, react: '19.2.8', 'react-dom': '19.2.8' },
  devDependencies: { '@types/react': '19.2.18', typescript: '5.9.3' },
} as const;

/** Default composition: vertical, for reels, shorts and feed video. */
export const DEFAULT_COMPOSITION = { width: 1080, height: 1920, fps: 30, durationInFrames: 150 } as const;
/** The size a still is registered with; every render passes its own width and height. */
const DEFAULT_STILL = { width: 1080, height: 1080 } as const;

/** The Concept folder of the Thumbnail tab's stills, in the code and in the archive. */
const THUMBNAIL_FOLDER = 'thumbnail';

const INSTALLED_MARKER = '.agent-visual-os-installed';

export const remotionDir = (ctx: ContentCtx): string => path.join(ctx.dir, 'remotion');
const conceptsSrc = (ctx: ContentCtx): string => path.join(remotionDir(ctx), 'src', 'concepts');

function safeConcept(conceptId: string): string {
  if (!isRecordId(conceptId)) throw new ContentNotFoundError('That concept does not exist');
  return conceptId;
}
export const conceptCodeDir = (ctx: ContentCtx, conceptId: string): string => path.join(conceptsSrc(ctx), safeConcept(conceptId));
export const publicConceptDir = (ctx: ContentCtx, conceptId: string): string => path.join(remotionDir(ctx), 'public', 'concepts', safeConcept(conceptId));
export const mediaDir = (ctx: ContentCtx, conceptId: string): string => path.join(publicConceptDir(ctx, conceptId), 'media');
/** The media folder as the agent sees it: relative to the Remotion project, its working folder. */
export const mediaFolderForAgent = (conceptId: string): string => `public/concepts/${safeConcept(conceptId)}/media`;
export const archiveDir = (ctx: ContentCtx, conceptId: string, round: number): string => path.join(remotionDir(ctx), 'archive', safeConcept(conceptId), `round-${round}`);

const COMPOSITION_KEY = 'composition:';
const STILL_PREFIX_KEY = 'stillPrefix:';
const THUMB_PREFIX_KEY = 'thumbPrefix:';

/** A still's file name without `.tsx`: lower-case letters, digits and dashes, so it is a valid part of a Remotion id. */
export const STILL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function safePost(postId: string): string {
  if (!isRecordId(postId)) throw new ContentNotFoundError('That post does not exist');
  return postId;
}
/** One image or carousel post's still compositions: `src/concepts/<conceptId>/images/<postId>/`. */
export const stillsDir = (ctx: ContentCtx, conceptId: string, postId: string): string => path.join(conceptCodeDir(ctx, conceptId), 'images', safePost(postId));
export const stillsArchiveDir = (ctx: ContentCtx, conceptId: string, postId: string, round: number): string =>
  path.join(remotionDir(ctx), 'archive', safeConcept(conceptId), 'images', safePost(postId), `round-${round}`);

/**
 * `<lead>-` plus the first 8 hex digits of `id`, assigned once under `<keyPrefix><id>` and kept. When another record of the
 * Building already holds it, a longer prefix is used, so two records never share one.
 */
function uniqueHexId(ctx: ContentCtx, keyPrefix: string, lead: string, id: string): string {
  const key = `${keyPrefix}${id}`;
  const known = readMeta(ctx.db, key);
  if (known) return known;
  const taken = new Set((ctx.db.prepare('SELECT value FROM meta WHERE key LIKE ?').all(`${keyPrefix}%`) as { value: string }[]).map((r) => r.value));
  const hex = id.replace(/-/g, '');
  let length = 8;
  while (taken.has(`${lead}-${hex.slice(0, length)}`) && length < hex.length) length += 4;
  const value = `${lead}-${hex.slice(0, length)}`;
  writeMeta(ctx.db, key, value);
  return value;
}

/** The Concept's video composition id: `concept-<first 8 hex digits of the Concept id>`. */
export const compositionIdFor = (ctx: ContentCtx, conceptId: string): string => uniqueHexId(ctx, COMPOSITION_KEY, 'concept', safeConcept(conceptId));

/** The prefix of every still composition id of a post: `still-<first 8 hex digits of the post id>-<name>`. */
export const stillPrefixFor = (ctx: ContentCtx, postId: string): string => uniqueHexId(ctx, STILL_PREFIX_KEY, 'still', safePost(postId));

/** The prefix of every thumbnail still id of a Concept: `thumb-<first 8 hex digits of the Concept id>-<name>`. */
export const thumbPrefixFor = (ctx: ContentCtx, conceptId: string): string => uniqueHexId(ctx, THUMB_PREFIX_KEY, 'thumb', safeConcept(conceptId));

/** The Concept's thumbnail stills: `src/concepts/<conceptId>/thumbnail/`. */
export const thumbnailStillsDir = (ctx: ContentCtx, conceptId: string): string => path.join(conceptCodeDir(ctx, conceptId), THUMBNAIL_FOLDER);
export const thumbnailArchiveDir = (ctx: ContentCtx, conceptId: string, round: number): string =>
  path.join(remotionDir(ctx), 'archive', safeConcept(conceptId), THUMBNAIL_FOLDER, `round-${round}`);

export interface StillEntry { conceptId: string; postId: string; name: string; id: string }
export interface ThumbnailEntry { conceptId: string; name: string; id: string }

const stillNames = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.tsx') && STILL_NAME.test(f.slice(0, -4))).map((f) => f.slice(0, -4)).sort();

/** The still compositions of one post, sorted by name: what `render_images` may render for it. */
export async function postStills(ctx: ContentCtx, conceptId: string, postId: string): Promise<StillEntry[]> {
  const names = await stillNames(stillsDir(ctx, conceptId, postId));
  if (!names.length) return [];
  const prefix = stillPrefixFor(ctx, postId);
  return names.map((name) => ({ conceptId, postId, name, id: `${prefix}-${name}` }));
}

/** The Concept's thumbnail stills, sorted by name: what `render_thumbnails` may render. */
export async function thumbnailStills(ctx: ContentCtx, conceptId: string): Promise<ThumbnailEntry[]> {
  const names = await stillNames(thumbnailStillsDir(ctx, conceptId));
  if (!names.length) return [];
  const prefix = thumbPrefixFor(ctx, conceptId);
  return names.map((name) => ({ conceptId, name, id: `${prefix}-${name}` }));
}

async function allThumbnails(ctx: ContentCtx, conceptIds: string[]): Promise<ThumbnailEntry[]> {
  const out: ThumbnailEntry[] = [];
  for (const conceptId of [...conceptIds].sort()) out.push(...await thumbnailStills(ctx, conceptId));
  return out;
}

async function allStills(ctx: ContentCtx, conceptIds: string[]): Promise<StillEntry[]> {
  const out: StillEntry[] = [];
  for (const conceptId of [...conceptIds].sort()) {
    const postIds = (await readdir(path.join(conceptsSrc(ctx), conceptId, 'images')).catch(() => [] as string[])).filter(isRecordId).sort();
    for (const postId of postIds) out.push(...await postStills(ctx, conceptId, postId));
  }
  return out;
}

/** Gives the post an empty still folder when it has none yet, and refreshes the registry. */
export async function scaffoldStills(ctx: ContentCtx, conceptId: string, postId: string): Promise<void> {
  await mkdir(stillsDir(ctx, conceptId, postId), { recursive: true });
  await mkdir(mediaDir(ctx, conceptId), { recursive: true });
  await writeRegistry(ctx);
}

/** Moves the post's still code to round N's archive and leaves an empty folder, so round N+1 starts from nothing. */
export async function archiveStills(ctx: ContentCtx, conceptId: string, postId: string, round: number): Promise<void> {
  await moveAside(stillsDir(ctx, conceptId, postId), stillsArchiveDir(ctx, conceptId, postId, round));
  await scaffoldStills(ctx, conceptId, postId);
}

/** Undoes `archiveStills`. */
export async function restoreStills(ctx: ContentCtx, conceptId: string, postId: string, round: number): Promise<void> {
  if (await moveBack(stillsArchiveDir(ctx, conceptId, postId, round), stillsDir(ctx, conceptId, postId))) await writeRegistry(ctx);
}

/** Moves a still folder to its archive, replacing an older archive of the same round. */
async function moveAside(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await rm(to, { recursive: true, force: true });
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
}

/** Puts an archived still folder back in place of the current one; false when there is no archive. */
async function moveBack(from: string, to: string): Promise<boolean> {
  if (!existsSync(from)) return false;
  await rm(to, { recursive: true, force: true });
  await rename(from, to);
  return true;
}

/** Gives the Concept an empty thumbnail folder when it has none yet, and refreshes the registry. */
export async function scaffoldThumbnail(ctx: ContentCtx, conceptId: string): Promise<void> {
  await mkdir(thumbnailStillsDir(ctx, conceptId), { recursive: true });
  await mkdir(mediaDir(ctx, conceptId), { recursive: true });
  await writeRegistry(ctx);
}

/** Moves the Concept's thumbnail code to round N's archive and leaves an empty folder, so round N+1 starts from nothing. */
export async function archiveThumbnail(ctx: ContentCtx, conceptId: string, round: number): Promise<void> {
  await moveAside(thumbnailStillsDir(ctx, conceptId), thumbnailArchiveDir(ctx, conceptId, round));
  await scaffoldThumbnail(ctx, conceptId);
}

/** Undoes `archiveThumbnail`. */
export async function restoreThumbnail(ctx: ContentCtx, conceptId: string, round: number): Promise<void> {
  if (await moveBack(thumbnailArchiveDir(ctx, conceptId, round), thumbnailStillsDir(ctx, conceptId))) await writeRegistry(ctx);
}

/** Removes a deleted post's still code and archives from the project. */
export async function removePostFromProject(ctx: ContentCtx, conceptId: string, postId: string): Promise<void> {
  if (!existsSync(remotionDir(ctx))) return;
  await rm(stillsDir(ctx, conceptId, postId), { recursive: true, force: true });
  await rm(path.join(remotionDir(ctx), 'archive', safeConcept(conceptId), 'images', safePost(postId)), { recursive: true, force: true });
  await writeRegistry(ctx);
}

/** The Concept's composition id once its code is scaffolded (`src/concepts/<conceptId>/index.tsx` exists), else null: the Remotion tab's enable rule. */
export function existingCompositionId(ctx: ContentCtx, conceptId: string): string | null {
  const known = readMeta(ctx.db, `${COMPOSITION_KEY}${safeConcept(conceptId)}`);
  return known && existsSync(path.join(conceptCodeDir(ctx, conceptId), 'index.tsx')) ? known : null;
}

const PROJECT_FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({
    name: 'content-studio-videos', private: true, version: '1.0.0',
    scripts: { studio: 'remotion studio src/index.ts', render: 'remotion render src/index.ts' },
    ...REMOTION_PACKAGES,
  }, null, 2)}\n`,
  'tsconfig.json': `${JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true },
    include: ['src'],
  }, null, 2)}\n`,
  'remotion.config.ts': `import { Config } from '@remotion/cli/config';\n\nConfig.setVideoImageFormat('jpeg');\nConfig.setOverwriteOutput(true);\n`,
  'src/index.ts': `import { registerRoot } from 'remotion';\nimport { RemotionRoot } from './Root';\n\nregisterRoot(RemotionRoot);\n`,
  'src/Root.tsx': `import React from 'react';\nimport { Composition } from 'remotion';\nimport { compositions } from './concepts/registry';\n\n// Every Concept's composition, listed by the generated registry.\nexport const RemotionRoot: React.FC = () => (\n  <>\n    {compositions.map((c) => <Composition key={c.id} {...c} />)}\n  </>\n);\n`,
  'src/concepts/types.ts': `import type { ComponentType } from 'react';\n\n/** What each Concept's index.tsx exports as \`composition\`. */\nexport interface ConceptComposition {\n  id: string;\n  component: ComponentType<Record<string, unknown>>;\n  durationInFrames: number;\n  fps: number;\n  width: number;\n  height: number;\n}\n`,
  'src/brand/README.md': `# Brand pieces\n\nShared by every Concept's video: fonts, colours, logo, intro and outro components, built over time from the Building's knowledge files. A change here changes every video, so never break another Concept's composition.\n`,
  'src/brand/index.ts': `// Export shared brand components from here.\nexport {};\n`,
  '.gitignore': 'node_modules\nout\n',
};

/** Writes the project's files that are missing; existing files (brand pieces, Concept code) are never overwritten. */
export async function scaffoldProject(ctx: ContentCtx): Promise<void> {
  const root = remotionDir(ctx);
  for (const [file, content] of Object.entries(PROJECT_FILES)) {
    const target = path.join(root, file);
    if (existsSync(target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(path.join(root, 'public', 'concepts'), { recursive: true });
  await writeRegistry(ctx);
}

export const conceptIndexSource = (compositionId: string): string => `import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { ConceptComposition } from '../types';

const Video: React.FC = () => <AbsoluteFill style={{ backgroundColor: '#000000' }} />;

// Keep the id: the daemon renders this Concept by it. Size 1080x1920 at 30 fps unless the owner asks for 1080x1080 or 1920x1080.
export const composition: ConceptComposition = {
  id: '${compositionId}',
  component: Video,
  durationInFrames: ${DEFAULT_COMPOSITION.durationInFrames},
  fps: ${DEFAULT_COMPOSITION.fps},
  width: ${DEFAULT_COMPOSITION.width},
  height: ${DEFAULT_COMPOSITION.height},
};
`;

/** Gives the Concept an empty composition when it has none yet, and lists it in the registry. */
export async function scaffoldConcept(ctx: ContentCtx, conceptId: string): Promise<void> {
  const dir = conceptCodeDir(ctx, conceptId);
  const index = path.join(dir, 'index.tsx');
  if (!existsSync(index)) {
    await mkdir(dir, { recursive: true });
    await writeFile(index, conceptIndexSource(compositionIdFor(ctx, conceptId)));
  }
  await mkdir(mediaDir(ctx, conceptId), { recursive: true });
  await writeRegistry(ctx);
}

/**
 * The registry's source for these Concept folders (sorted), image stills and thumbnail stills, in that order; valid TypeScript even
 * when empty. Each still is a one-frame composition, so the Root that lists `compositions` needs no change; `remotion still` sets its
 * real size.
 */
export function registrySource(conceptIds: string[], stills: StillEntry[] = [], thumbnails: ThumbnailEntry[] = []): string {
  const ids = [...conceptIds].sort();
  const imports = ids.map((id, i) => `import { composition as c${i} } from './${id}/index';`);
  const stillImports = stills.map((s, i) => `import { still as s${i} } from './${s.conceptId}/images/${s.postId}/${s.name}';`);
  const thumbImports = thumbnails.map((s, i) => `import { still as t${i} } from './${s.conceptId}/${THUMBNAIL_FOLDER}/${s.name}';`);
  const all = [...imports, ...stillImports, ...thumbImports].join('\n');
  const helper = stills.length || thumbnails.length
    ? `\n// A still is one frame; its size comes from the render.\nconst still = (id: string, s: { component: ConceptComposition['component'] }): ConceptComposition => ({ id, component: s.component, durationInFrames: 1, fps: 30, width: ${DEFAULT_STILL.width}, height: ${DEFAULT_STILL.height} });\n`
    : '';
  const entries = [...ids.map((_id, i) => `c${i}`), ...stills.map((s, i) => `still('${s.id}', s${i})`), ...thumbnails.map((s, i) => `still('${s.id}', t${i})`)];
  return `// Generated by Agent Visual OS. Do not edit: it is rewritten whenever a Concept's video folder is added or removed.\nimport type { ConceptComposition } from './types';\n${all ? `${all}\n` : ''}${helper}\nexport const compositions: ConceptComposition[] = [${entries.join(', ')}];\n`;
}

/** Rewrites `src/concepts/registry.ts` from the Concept folders that have an index, every post's stills and every thumbnail still; an unchanged registry is not touched. */
export async function writeRegistry(ctx: ContentCtx): Promise<void> {
  const dir = conceptsSrc(ctx);
  const folders = (await readdir(dir).catch(() => [] as string[])).filter(isRecordId);
  const ids = folders.filter((name) => existsSync(path.join(dir, name, 'index.tsx')));
  const file = path.join(dir, 'registry.ts');
  const next = registrySource(ids, await allStills(ctx, folders), await allThumbnails(ctx, folders));
  if ((await readFile(file, 'utf8').catch(() => null)) === next) return;
  await writeTextAtomic(file, next);
}

/** The Concept folder's `images/` and `thumbnail/` hold the other tabs' stills; the video's archive and restore leave them in place. */
const STILL_FOLDERS = ['images', THUMBNAIL_FOLDER];
const videoEntries = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).filter((name) => !STILL_FOLDERS.includes(name));

/** Moves the Concept's video composition code to round N's archive and starts it again from an empty scaffold; the stills and thumbnails stay. */
export async function archiveConceptCode(ctx: ContentCtx, conceptId: string, round: number): Promise<void> {
  const from = conceptCodeDir(ctx, conceptId);
  const to = archiveDir(ctx, conceptId, round);
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  for (const name of await videoEntries(from)) await rename(path.join(from, name), path.join(to, name));
  await scaffoldConcept(ctx, conceptId);
}

/** Undoes `archiveConceptCode`: round N's archived code goes back in place of the fresh scaffold; the stills stay as they are now. */
export async function restoreConceptCode(ctx: ContentCtx, conceptId: string, round: number): Promise<void> {
  const from = archiveDir(ctx, conceptId, round);
  if (!existsSync(from)) return;
  const to = conceptCodeDir(ctx, conceptId);
  for (const name of await videoEntries(to)) await rm(path.join(to, name), { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) await rename(path.join(from, name), path.join(to, name));
  await rm(from, { recursive: true, force: true });
  await writeRegistry(ctx);
}

/** Removes everything the Concept has in the Remotion project: code, media and archives. */
export async function removeConceptFromProject(ctx: ContentCtx, conceptId: string): Promise<void> {
  if (!existsSync(remotionDir(ctx))) return;
  await rm(conceptCodeDir(ctx, conceptId), { recursive: true, force: true });
  await rm(publicConceptDir(ctx, conceptId), { recursive: true, force: true });
  await rm(path.join(remotionDir(ctx), 'archive', conceptId), { recursive: true, force: true });
  await writeRegistry(ctx);
}

// ---- dependency install: a tracked background job, once per Building ----------------------------

export type SetupStatus = 'none' | 'running' | 'failed' | 'ready';
export interface SetupView { status: SetupStatus; error: string | null; percent: number | null }

interface Setup { view: SetupView; promise: Promise<boolean> | null; abort: AbortController | null; jobId: string }
const setups = new Map<string, Setup>();

const installed = (ctx: ContentCtx): boolean => {
  try { return existsSync(path.join(remotionDir(ctx), INSTALLED_MARKER)); } catch { return false; }
};

export function setupView(ctx: ContentCtx): SetupView {
  const known = setups.get(ctx.buildingId);
  if (known && known.view.status !== 'ready') return { ...known.view };
  return { status: installed(ctx) ? 'ready' : 'none', error: null, percent: null };
}

export const isProjectReady = (ctx: ContentCtx): boolean => setupView(ctx).status === 'ready';

/**
 * Scaffolds the project and installs its dependencies as a `remotion-setup` job; resolves true when it is ready. Concurrent calls
 * share one install. A project already installed resolves at once; a failed install runs again on the next call.
 */
export function ensureProject(ctx: ContentCtx, onChange: () => void = () => undefined): Promise<boolean> {
  if (installed(ctx)) return Promise.resolve(true);
  const known = setups.get(ctx.buildingId);
  if (known?.promise) return known.promise;
  const abort = new AbortController();
  const jobId = contentJobs.begin({ buildingId: ctx.buildingId, kind: 'remotion-setup', percent: null });
  const setup: Setup = { view: { status: 'running', error: null, percent: null }, promise: null, abort, jobId };
  setups.set(ctx.buildingId, setup);
  setup.promise = (async () => {
    try {
      await scaffoldProject(ctx);
      abort.signal.throwIfAborted();
      await videoDeps().installer.install(remotionDir(ctx), (percent) => {
        setup.view.percent = percent;
        contentJobs.progress(jobId, { percent });
      }, abort.signal);
      await writeFile(path.join(remotionDir(ctx), INSTALLED_MARKER), `${REMOTION_VERSION}\n`);
      setup.view = { status: 'ready', error: null, percent: 100 };
      contentJobs.end(jobId, 'complete');
      return true;
    } catch (error) {
      const message = abort.signal.aborted ? 'Remotion setup was stopped' : `Remotion setup failed: ${(error as Error).message}`;
      setup.view = { status: 'failed', error: message, percent: null };
      contentJobs.end(jobId, abort.signal.aborted ? 'stopped' : 'failed', message);
      return false;
    } finally {
      setup.promise = null;
      setup.abort = null;
      onChange();
    }
  })();
  onChange();
  return setup.promise;
}

/** Stops a running install (the Building is being deleted): its job ends at once, and this waits for the install to let go of the folder. */
export async function cancelSetup(buildingId: string): Promise<void> {
  const setup = setups.get(buildingId);
  setups.delete(buildingId);
  if (!setup) return;
  setup.abort?.abort();
  contentJobs.end(setup.jobId, 'stopped', 'Remotion setup was stopped');
  if (setup.promise) await setup.promise;
}
