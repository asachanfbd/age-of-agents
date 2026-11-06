import { writeFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import type { MediaProber, RemotionInstaller, RemotionRenderer, RemotionStillRenderer, RenderRequest, StillRequest } from '../../src/content/videoDeps.ts';

/** Fakes for the Video and Images tabs: npm install, the Remotion renderer and still renderer, and ffprobe. Nothing real is installed or rendered. */

/** A PNG signature and IHDR chunk of this size: enough for a reader of the header, no pixels. */
export function fakePng(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.set([8, 6, 0, 0, 0], 8);
  const type = Buffer.from('IHDR');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, type, data, crc]);
}

/** Width and height from a PNG's IHDR chunk. */
export const pngSize = (bytes: Buffer): { width: number; height: number } => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

export interface Gate { promise: Promise<void>; open(): void; fail(error: Error): void }
export function gate(): Gate {
  let open!: () => void, fail!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => { open = a; fail = b; });
  return { promise, open, fail };
}

export function fakeVideo() {
  const state = {
    installs: 0,
    installGate: null as Gate | null,
    installError: null as string | null,
    renders: [] as RenderRequest[],
    renderGate: null as Gate | null,
    renderError: null as string | null,
    proberFails: false,
    stills: [] as StillRequest[],
    /** Holds the still with this 1-based position in the call (counted over every still asked for) until `stillGate` opens. */
    stillGateAt: null as number | null,
    stillGate: null as Gate | null,
    /** Fails the still of this composition id. */
    stillErrorFor: null as string | null,
  };
  const installer: RemotionInstaller = {
    async install(_dir, onProgress, signal) {
      state.installs++;
      onProgress(10);
      const g = state.installGate;
      if (g) await new Promise<void>((resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); signal.addEventListener('abort', () => reject(new Error('aborted'))); g.promise.then(resolve, reject); });
      if (state.installError) throw new Error(state.installError);
    },
  };
  const renderer: RemotionRenderer = {
    async render(request) {
      state.renders.push(request);
      request.onProgress(50, 100);
      const g = state.renderGate;
      if (g) {
        await new Promise<void>((resolve, reject) => {
          // Like a spawned process, a signal that aborted before the render began ends it at once.
          if (request.signal.aborted) { reject(new Error('aborted')); return; }
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
          g.promise.then(resolve, reject);
        });
      }
      if (state.renderError) throw new Error(state.renderError);
      await writeFile(request.output, 'FAKE-MP4-'.repeat(20));
    },
  };
  const stillRenderer: RemotionStillRenderer = {
    async still(request) {
      state.stills.push(request);
      const g = state.stillGate;
      if (g && state.stillGateAt === state.stills.length) {
        await new Promise<void>((resolve, reject) => {
          if (request.signal.aborted) reject(new Error('aborted'));
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
          g.promise.then(resolve, reject);
        });
      }
      if (state.stillErrorFor === request.compositionId) throw new Error(`Cannot find module './${request.compositionId}'`);
      await writeFile(request.output, fakePng(request.width, request.height));
    },
  };
  const prober: MediaProber = {
    async probe(_dir, _file, kind) {
      if (state.proberFails) throw new Error('ffprobe is not available');
      return kind === 'image' ? { durationMs: null, width: 64, height: 32 } : { durationMs: 48_000, width: kind === 'video' ? 1080 : null, height: kind === 'video' ? 1920 : null };
    },
    async thumbnail(_dir, _file, out) { await writeFile(out, 'JPEG'); },
  };
  return { state, installer, renderer, stillRenderer, prober };
}

/** Polls until `check` returns a truthy value (a few seconds at most). */
export async function waitFor<T>(check: () => Promise<T> | T, what = 'condition'): Promise<NonNullable<T>> {
  for (let i = 0; i < 300; i++) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
