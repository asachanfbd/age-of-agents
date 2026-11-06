import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContentCtx } from './context.ts';
import { ContentInputError, ContentNotFoundError } from './errors.ts';
import { listDir } from './files.ts';
import { EXTRACTION_TIMEOUT_MS, EXTRACTION_TTL_MS, EXTRACT_IMAGES_MAX, EXTRACT_IMAGE_MAX_BYTES, EXTRACT_TEXT_MAX } from './limits.ts';
import type { Platform } from './rules.ts';
import { extractionPrompt, parseExtractionAnswer } from './statsAgent.ts';
import type { ExtractionAnswer, StatsAgent } from './statsAgent.ts';
import type { SourceMeta } from './statStore.ts';
import { charCount } from './validate.ts';
import { isRecordId } from './concepts.ts';

export interface ExtractionDeps {
  agent: StatsAgent;
  /** The default coding agent, or the reason there is none. */
  resolveAgent(): Promise<{ kind: 'claude-cli' | 'codex-cli'; bin: string; env: Record<string, string> } | string>;
  timeoutMs?: number;
}

export interface UploadedImage { bytes: Buffer; ext: string; contentType: string }
export interface ExtractionInput { text: string; images: UploadedImage[] }

const MAGIC: Array<{ ext: string; contentType: string; test: (b: Buffer) => boolean }> = [
  { ext: 'png', contentType: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', contentType: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', contentType: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
/** PNG, JPEG or WebP, judged by the bytes and not by the declared type. */
export const imageKind = (bytes: Buffer): { ext: string; contentType: string } | null => MAGIC.find((m) => m.test(bytes)) ?? null;

/** Reads the multipart body: a `text` field and up to ten `images` files. Every refusal is a 400 naming its field. */
export async function parseUpload(contentType: string | undefined, body: Buffer): Promise<ExtractionInput> {
  let form: FormData;
  try { form = await new Response(body, { headers: { 'content-type': contentType ?? '' } }).formData(); } catch { throw new ContentInputError('Send the text and the images as multipart form data', 'images'); }
  const rawText = form.get('text');
  if (rawText !== null && typeof rawText !== 'string') throw new ContentInputError('text must be text', 'text');
  const text = rawText ?? '';
  if (charCount(text) > EXTRACT_TEXT_MAX) throw new ContentInputError(`The pasted text can be at most ${EXTRACT_TEXT_MAX} characters`, 'text');
  const files = form.getAll('images');
  if (files.length > EXTRACT_IMAGES_MAX) throw new ContentInputError(`At most ${EXTRACT_IMAGES_MAX} images`, 'images');
  if (!files.length && !text.trim()) throw new ContentInputError('Paste the stats text or add at least one screenshot', 'text');
  const images: UploadedImage[] = [];
  for (const file of files) {
    if (typeof file === 'string') throw new ContentInputError('images must be files', 'images');
    if (file.size > EXTRACT_IMAGE_MAX_BYTES) throw new ContentInputError(`An image can be at most ${EXTRACT_IMAGE_MAX_BYTES / 1_048_576} MB`, 'images');
    const bytes = Buffer.from(await file.arrayBuffer());
    const kind = imageKind(bytes);
    if (!kind) throw new ContentInputError('Images must be PNG, JPEG or WebP', 'images');
    images.push({ bytes, ...kind });
  }
  return { text, images };
}

interface ExtractionMeta { postId: string; createdAt: number; sources: SourceMeta[] }
const extractionsRoot = (ctx: ContentCtx): string => path.join(ctx.dir, 'extractions');
const extractionDir = (ctx: ContentCtx, id: string): string => path.join(extractionsRoot(ctx), id);
const META = 'meta.json';

export const expired = (createdAt: number, now: number): boolean => now - createdAt >= EXTRACTION_TTL_MS;

async function readMeta(ctx: ContentCtx, id: string): Promise<ExtractionMeta | null> {
  if (!isRecordId(id)) return null;
  try { return JSON.parse(await readFile(path.join(extractionDir(ctx, id), META), 'utf8')) as ExtractionMeta; } catch { return null; }
}

/** Writes the inputs to the extraction's own folder and returns its id. The folder is the agent's only readable place. */
export async function stageExtraction(ctx: ContentCtx, postId: string, input: ExtractionInput): Promise<{ id: string; dir: string; sources: SourceMeta[] }> {
  const id = randomUUID(), dir = extractionDir(ctx, id);
  await mkdir(dir, { recursive: true });
  const sources: SourceMeta[] = [];
  const add = async (kind: SourceMeta['kind'], name: string, ext: string, contentType: string, bytes: Buffer) => {
    const sourceId = randomUUID(), file = `${sourceId}.${ext}`;
    await writeFile(path.join(dir, file), bytes);
    sources.push({ id: sourceId, kind, name, size: bytes.length, contentType, file });
  };
  if (input.text.trim()) await add('text', 'pasted-text.txt', 'txt', 'text/plain; charset=utf-8', Buffer.from(input.text, 'utf8'));
  for (const [i, image] of input.images.entries()) await add('image', `screenshot-${i + 1}.${image.ext}`, image.ext, image.contentType, image.bytes);
  await writeFile(path.join(dir, META), JSON.stringify({ postId, createdAt: ctx.now(), sources } satisfies ExtractionMeta));
  return { id, dir, sources };
}

/** Runs the agent on staged inputs. Never throws for an agent problem: the reason comes back for the form to show. */
export async function runExtraction(deps: ExtractionDeps, dir: string, platform: Platform, format: string, input: ExtractionInput, sources: SourceMeta[]): Promise<{ answer: ExtractionAnswer } | { reason: string }> {
  const agent = await deps.resolveAgent();
  if (typeof agent === 'string') return { reason: agent };
  const images = sources.filter((s) => s.kind === 'image').map((s) => s.file);
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? EXTRACTION_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`the agent took longer than ${Math.round(timeoutMs / 1000)} seconds`)); }, timeoutMs); });
  try {
    const text = await Promise.race([deps.agent({ ...agent, cwd: dir, prompt: extractionPrompt(platform, format, input.text, images), images, signal: controller.signal }), timeout]);
    return { answer: parseExtractionAnswer(text, platform) };
  } catch (e) {
    return { reason: e instanceof Error ? e.message : 'the agent failed' };
  } finally { clearTimeout(timer); }
}

export async function discardExtraction(ctx: ContentCtx, postId: string, id: string): Promise<void> {
  const meta = await readMeta(ctx, id);
  if (!meta || meta.postId !== postId) throw new ContentNotFoundError('That extraction does not exist');
  await rm(extractionDir(ctx, id), { recursive: true, force: true });
}

/** Moves a saved snapshot's evidence out of the extraction into `dest` and removes the extraction. 404 when it is unknown or belongs to another post. */
export async function claimExtraction(ctx: ContentCtx, postId: string, id: unknown, dest: string): Promise<SourceMeta[]> {
  if (typeof id !== 'string' || !isRecordId(id)) throw new ContentInputError('extractionId is not valid', 'extractionId');
  const meta = await readMeta(ctx, id);
  if (!meta || meta.postId !== postId) throw new ContentNotFoundError('That extraction does not exist');
  await mkdir(dest, { recursive: true });
  for (const s of meta.sources) await rename(path.join(extractionDir(ctx, id), s.file), path.join(dest, s.file));
  await rm(extractionDir(ctx, id), { recursive: true, force: true });
  return meta.sources;
}

/** Removes extractions older than 24 hours, and folders without readable metadata. */
export async function sweepExtractions(ctx: ContentCtx): Promise<void> {
  for (const id of await listDir(extractionsRoot(ctx))) {
    const meta = await readMeta(ctx, id);
    if (!meta || expired(meta.createdAt, ctx.now())) await rm(extractionDir(ctx, id), { recursive: true, force: true });
  }
}
