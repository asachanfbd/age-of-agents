import { gunzip } from 'node:zlib';

export type FetchFailure = 'timeout' | 'too-large' | 'network' | 'redirect' | 'bad-gzip';

/** A fetch that failed or was cut off. The message never contains the address: some addresses (the IndexNow key file) are secrets. */
export class LimitedFetchError extends Error {
  readonly kind: FetchFailure;
  constructor(kind: FetchFailure, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'LimitedFetchError';
  }
}

export interface LimitedResponse { status: number; body: Buffer; finalUrl: string; contentType: string }

export interface LimitedFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  /** Called for each redirect target; return false to refuse it (a different host). */
  allowRedirect?: (url: string) => boolean;
  signal?: AbortSignal;
}

const messages: Record<FetchFailure, string> = {
  timeout: 'the site did not answer in time',
  'too-large': 'the file is larger than the allowed size',
  network: 'the site could not be reached',
  redirect: 'the address redirected somewhere that is not allowed',
  'bad-gzip': 'the file is not valid gzip data or expands beyond the allowed size',
};
const fail = (kind: FetchFailure) => new LimitedFetchError(kind, messages[kind]);

/**
 * GET with the limits applied while the body streams: a `content-length` above the cap is refused before reading, an endless
 * or lying body is cut at `maxBytes`, the whole call is bounded by `timeoutMs`, and redirects are followed by hand so a hop
 * to another host can be refused. A `Content-Encoding: gzip` body is counted after decoding.
 */
export async function limitedFetch(url: string, options: LimitedFetchOptions): Promise<LimitedResponse> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
  let target = url;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(target, { redirect: 'manual', signal, headers: { 'user-agent': 'agent-visual-os-seo/1.0', accept: '*/*' } });
    } catch (error) {
      throw fail(signal.aborted || (error as Error).name === 'TimeoutError' ? 'timeout' : 'network');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      if (hop >= (options.maxRedirects ?? 5)) throw fail('redirect');
      const next = new URL(res.headers.get('location')!, target).href;
      if (options.allowRedirect && !options.allowRedirect(next)) throw fail('redirect');
      target = next;
      continue;
    }
    if (Number(res.headers.get('content-length')) > options.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw fail('too-large');
    }
    return { status: res.status, body: await readCapped(res, options.maxBytes, signal), finalUrl: target, contentType: res.headers.get('content-type') ?? '' };
  }
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw fail('too-large'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof LimitedFetchError) throw error;
    throw fail(signal.aborted ? 'timeout' : 'network');
  }
  return Buffer.concat(chunks);
}

const isGzip = (body: Buffer) => body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;

/** Gunzips a body that starts with the gzip magic bytes (whatever the file is called); other bodies are returned as they are. The output is capped. */
export function inflateIfGzip(body: Buffer, maxBytes: number): Promise<Buffer> {
  if (!isGzip(body)) return Promise.resolve(body);
  return new Promise((resolve, reject) => {
    gunzip(body, { maxOutputLength: maxBytes }, (error, out) => (error ? reject(fail('bad-gzip')) : resolve(out)));
  });
}
