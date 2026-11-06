import { ContentConflictError, ContentInputError } from './errors.ts';
import { MEDIA_NAME_MAX } from './limits.ts';

/** What a Video tab media file is: the agent and the web read the kind, the browser reads the type. */
export type MediaKind = 'video' | 'image' | 'audio';

interface MediaType { kind: MediaKind; mime: string; matches: (head: Buffer) => boolean }

const ascii = (head: Buffer, at: number, text: string): boolean => head.length >= at + text.length && head.toString('latin1', at, at + text.length) === text;
const bytes = (head: Buffer, at: number, sig: number[]): boolean => head.length >= at + sig.length && sig.every((b, i) => head[at + i] === b);

/** ISO base media (mp4, mov, m4a share it): a box type at offset 4. QuickTime files may open with a box other than `ftyp`. */
const isoBmff = (head: Buffer): boolean => ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].some((box) => ascii(head, 4, box));
/** An MPEG audio frame header (layer bits not 00, so an AAC ADTS header does not pass). */
const mpegFrame = (head: Buffer): boolean => head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x06) !== 0;
const adts = (head: Buffer): boolean => head.length >= 2 && head[0] === 0xff && (head[1]! & 0xf6) === 0xf0;
const id3 = (head: Buffer): boolean => ascii(head, 0, 'ID3');

/** An SVG document: an `<svg` root after any byte-order mark, XML declaration, comments, doctype and whitespace. */
function isSvg(head: Buffer): boolean {
  let text = head.toString('utf8').replace(/^﻿/, '');
  for (;;) {
    const before = text;
    text = text.replace(/^\s+/, '').replace(/^<\?xml[\s\S]*?\?>/, '').replace(/^<!--[\s\S]*?-->/, '').replace(/^<!DOCTYPE\s+svg[^>]*>/i, '');
    if (text === before) break;
  }
  return /^<svg[\s>/]/.test(text);
}

/** The allowed types by extension, each checked against the file's first bytes. */
export const MEDIA_TYPES: Record<string, MediaType> = {
  mp4: { kind: 'video', mime: 'video/mp4', matches: isoBmff },
  mov: { kind: 'video', mime: 'video/quicktime', matches: isoBmff },
  webm: { kind: 'video', mime: 'video/webm', matches: (h) => bytes(h, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
  png: { kind: 'image', mime: 'image/png', matches: (h) => bytes(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { kind: 'image', mime: 'image/jpeg', matches: (h) => bytes(h, 0, [0xff, 0xd8, 0xff]) },
  jpeg: { kind: 'image', mime: 'image/jpeg', matches: (h) => bytes(h, 0, [0xff, 0xd8, 0xff]) },
  webp: { kind: 'image', mime: 'image/webp', matches: (h) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WEBP') },
  gif: { kind: 'image', mime: 'image/gif', matches: (h) => ascii(h, 0, 'GIF87a') || ascii(h, 0, 'GIF89a') },
  svg: { kind: 'image', mime: 'image/svg+xml', matches: isSvg },
  mp3: { kind: 'audio', mime: 'audio/mpeg', matches: (h) => id3(h) || mpegFrame(h) },
  wav: { kind: 'audio', mime: 'audio/wav', matches: (h) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WAVE') },
  m4a: { kind: 'audio', mime: 'audio/mp4', matches: isoBmff },
  aac: { kind: 'audio', mime: 'audio/aac', matches: (h) => id3(h) || adts(h) },
};

/** How many leading bytes the sniffing reads (an SVG may open with a long comment). */
export const SNIFF_BYTES = 8_192;

export const UNSUPPORTED = 'Unsupported file type';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The type an allowed extension names; any other extension is 400. */
export function mediaTypeOf(name: string): MediaType & { ext: string } {
  const ext = extensionOf(name);
  const type = MEDIA_TYPES[ext];
  if (!type) throw new ContentInputError(UNSUPPORTED, 'file');
  return { ...type, ext };
}

/** The kind of a file whose first bytes match its extension; an empty file or a mismatch is 400. */
export function sniffMedia(name: string, head: Buffer): MediaKind {
  const type = mediaTypeOf(name);
  if (head.length === 0) throw new ContentInputError('The file is empty', 'file');
  if (!type.matches(head)) throw new ContentInputError(UNSUPPORTED, 'file');
  return type.kind;
}

const SAFE = /^[A-Za-z0-9 ._-]+$/;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot + 1) } : { base: name, ext: '' };
}

/** Fits `base` plus `suffix` and the extension into the name limit by trimming the base. */
function fit(base: string, suffix: string, ext: string): string {
  const room = MEDIA_NAME_MAX - suffix.length - (ext ? ext.length + 1 : 0);
  return `${[...base].slice(0, Math.max(1, room)).join('')}${suffix}${ext ? `.${ext}` : ''}`;
}

/**
 * An uploaded file's stored name: every unsafe character becomes `-`, leading dots go, an empty base becomes `file`, the
 * name is trimmed to the limit keeping its extension, and a name already taken (ignoring case) gets `-2`, `-3` and so on.
 */
export function cleanUploadName(raw: string, taken: readonly string[]): string {
  const cleaned = [...raw.trim()].map((ch) => (SAFE.test(ch) ? ch : '-')).join('');
  const { base: rawBase, ext } = splitName(cleaned);
  const base = rawBase.replace(/^\.+/, '').trim() || 'file';
  for (let n = 1; ; n++) {
    const name = fit(base, n === 1 ? '' : `-${n}`, ext);
    if (!taken.some((t) => sameName(t, name))) return name;
  }
}

/** A rename: the full name, 1 to the limit, safe characters, no leading dot, the same extension (ignoring case) and not another file's name (409). */
export function parseRename(raw: unknown, current: string, others: readonly string[]): string {
  if (typeof raw !== 'string') throw new ContentInputError('name must be text', 'name');
  const name = raw.trim();
  const dot = name.lastIndexOf('.');
  const base = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  if (!name || name.length > MEDIA_NAME_MAX || !base.trim()) throw new ContentInputError(`name must be 1 to ${MEDIA_NAME_MAX} characters`, 'name');
  if (!SAFE.test(name) || name.startsWith('.')) throw new ContentInputError('name may only use letters, digits, spaces, dots, dashes and underscores', 'name');
  if (ext.toLowerCase() !== extensionOf(current)) throw new ContentInputError('The file extension cannot change', 'name');
  if (others.some((o) => sameName(o, name))) throw new ContentConflictError('Another file already has that name');
  return name;
}
