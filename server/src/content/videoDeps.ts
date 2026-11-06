import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { IMAGES_CALL_TIMEOUT_MS, MEDIA_FILES_MAX, MEDIA_MAX_BYTES, RENDER_TIMEOUT_MS, STILL_TIMEOUT_MS } from './limits.ts';
import type { MediaKind } from './mediaTypes.ts';

/** What the Video and Images tabs reach the outside world through: npm, the Remotion CLI and its bundled ffprobe/ffmpeg. Tests replace every piece. */

export interface MediaProbe { durationMs: number | null; width: number | null; height: number | null }

export interface MediaProber {
  /** Reads duration and size; throws when it cannot (the Remotion project is not installed yet, or the file is unreadable). */
  probe(remotionDir: string, file: string, kind: MediaKind): Promise<MediaProbe>;
  /** Writes a small JPEG poster frame of a video to `out`. */
  thumbnail(remotionDir: string, file: string, out: string): Promise<void>;
}

export interface RemotionInstaller {
  /** Installs the project's pinned dependencies; `onProgress` gets a percent, or null while unknown. */
  install(dir: string, onProgress: (percent: number | null) => void, signal: AbortSignal): Promise<void>;
}

export interface RenderRequest {
  dir: string;
  compositionId: string;
  /** Absolute output file. */
  output: string;
  signal: AbortSignal;
  onProgress(frame: number, totalFrames: number): void;
}

export interface RemotionRenderer { render(request: RenderRequest): Promise<void> }

export interface StillRequest {
  dir: string;
  compositionId: string;
  /** Absolute output PNG. */
  output: string;
  width: number;
  height: number;
  signal: AbortSignal;
}

/** Renders one still composition of the Images tab to a PNG. */
export interface RemotionStillRenderer { still(request: StillRequest): Promise<void> }

/** The Images tab's two time limits: one image, and one whole `render_images` call. */
export interface ImageLimits { stillTimeoutMs: number; callTimeoutMs: number }

export interface VideoLimits { mediaMaxBytes: number; mediaFilesMax: number; renderTimeoutMs: number }

export interface VideoDeps {
  limits: VideoLimits;
  prober: MediaProber;
  installer: RemotionInstaller;
  renderer: RemotionRenderer;
  stillRenderer: RemotionStillRenderer;
  imageLimits: ImageLimits;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  /** The pause between typing the confirm message into the agent's terminal and pressing Enter, so the CLI does not read the Enter as part of a paste. */
  submitDelayMs: number;
}

export const remotionBin = (dir: string): string => path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'remotion.cmd' : 'remotion');

/** Runs a command; resolves with its stdout, rejects with the tail of its stderr. `onOutput` sees every chunk of both streams. */
function run(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; onOutput?: (text: string) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, signal: options.signal, env: { ...process.env, NODE_ENV: 'development' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); out += text; options.onOutput?.(text); });
    child.stderr.on('data', (chunk: Buffer) => { const text = chunk.toString(); err = (err + text).slice(-2_000); options.onOutput?.(text); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(command)} exited with code ${code}${err.trim() ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}`));
    });
  });
}

/** Remotion 4 bundles ffprobe and ffmpeg, reached through its own CLI once the project is installed. */
export const remotionProber: MediaProber = {
  async probe(remotionDir, file) {
    await access(remotionBin(remotionDir));
    const json = JSON.parse(await run(remotionBin(remotionDir), ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { cwd: remotionDir })) as {
      format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const visual = json.streams?.find((s) => s.codec_type === 'video');
    const seconds = Number(json.format?.duration);
    return { durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null, width: visual?.width ?? null, height: visual?.height ?? null };
  },
  async thumbnail(remotionDir, file, out) {
    await access(remotionBin(remotionDir));
    await run(remotionBin(remotionDir), ['ffmpeg', '-y', '-v', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1', '-vf', 'scale=240:-2', out], { cwd: remotionDir });
  },
};

export const npmInstaller: RemotionInstaller = {
  async install(dir, onProgress, signal) {
    onProgress(null);
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--include=dev', '--no-audit', '--no-fund'], { cwd: dir, signal });
  },
};

/** The CLI prints "Rendered 581/1260" style counters; the last one in a chunk wins. */
export function parseRenderProgress(text: string): { frame: number; totalFrames: number } | null {
  const all = [...text.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  const last = all[all.length - 1];
  if (!last) return null;
  const frame = Number(last[1]), totalFrames = Number(last[2]);
  return totalFrames > 0 && frame <= totalFrames ? { frame, totalFrames } : null;
}

export const remotionCliRenderer: RemotionRenderer = {
  async render({ dir, compositionId, output, signal, onProgress }) {
    await run(remotionBin(dir), ['render', 'src/index.ts', compositionId, output, '--codec=h264'], {
      cwd: dir, signal,
      onOutput: (text) => { const p = parseRenderProgress(text); if (p) onProgress(p.frame, p.totalFrames); },
    });
  },
};

export const remotionCliStillRenderer: RemotionStillRenderer = {
  async still({ dir, compositionId, output, width, height, signal }) {
    await run(remotionBin(dir), ['still', 'src/index.ts', compositionId, output, `--width=${width}`, `--height=${height}`, '--image-format=png'], { cwd: dir, signal });
  },
};

export const defaultVideoLimits = (): VideoLimits => ({ mediaMaxBytes: MEDIA_MAX_BYTES, mediaFilesMax: MEDIA_FILES_MAX, renderTimeoutMs: RENDER_TIMEOUT_MS });

const defaults = (): VideoDeps => ({
  limits: defaultVideoLimits(),
  prober: remotionProber,
  installer: npmInstaller,
  renderer: remotionCliRenderer,
  stillRenderer: remotionCliStillRenderer,
  imageLimits: { stillTimeoutMs: STILL_TIMEOUT_MS, callTimeoutMs: IMAGES_CALL_TIMEOUT_MS },
  setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); },
  submitDelayMs: 300,
});

let current = defaults();

export const videoDeps = (): VideoDeps => current;
/** Test seam: replaces some pieces; the rest stay. */
export function configureVideo(patch: Partial<VideoDeps>): void { current = { ...current, ...patch }; }
export function resetVideo(): void { current = defaults(); }
