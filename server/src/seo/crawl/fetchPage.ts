import { backoffMs, MAX_RETRIES } from './rules.ts';
import type { PageRecord } from './types.ts';

export interface FetchedPage {
  status: number | null;
  error: PageRecord['error'];
  location: string | null;
  contentType: string | null;
  xRobots: string | null;
  html: string | null;
}

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Read the body whatever its content type (robots.txt is plain text). */
  anyType?: boolean;
}

/** A pause that a Stop cuts short: rejects with an AbortError as soon as the signal fires. */
export function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)\b/i;
export const isHtml = (contentType: string | null) => !!contentType && HTML_TYPES.test(contentType.trim());

const empty = (error: PageRecord['error']): FetchedPage => ({ status: null, error, location: null, contentType: null, xRobots: null, html: null });

async function readCapped(res: Response, maxBytes: number): Promise<string | 'too-large'> {
  if (Number(res.headers.get('content-length')) > maxBytes) { await res.body?.cancel().catch(() => undefined); return 'too-large'; }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); return 'too-large'; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One GET with the crawl's rules: no redirects followed (the caller records them), no cookies or credentials (only a user
 * agent and accept header are sent), a timeout, a size cap that applies while the body streams, and 429 or 503 answers retried
 * with back-off. Non-HTML bodies are never read.
 */
export async function fetchPage(url: string, userAgent: string, options: FetchOptions): Promise<FetchedPage> {
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal, credentials: 'omit', headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } });
    } catch {
      if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return empty(signal.aborted ? 'timeout' : 'network');
    }
    if (res.status === 429 || (res.status === 503 && res.headers.has('retry-after'))) {
      await res.body?.cancel().catch(() => undefined);
      if (attempt >= MAX_RETRIES) return { ...empty('rate-limited'), status: res.status };
      await abortableSleep(options.sleep, backoffMs(attempt, res.headers.get('retry-after'), options.now()), options.signal);
      continue;
    }
    const contentType = res.headers.get('content-type');
    const base = { status: res.status, error: null, location: res.headers.get('location'), contentType, xRobots: res.headers.get('x-robots-tag'), html: null };
    if (res.status >= 300 && res.status < 400 || (!options.anyType && !isHtml(contentType)) || res.status >= 400) {
      await res.body?.cancel().catch(() => undefined);
      return base;
    }
    try {
      const body = await readCapped(res, options.maxBytes);
      return body === 'too-large' ? { ...base, error: 'too-large' } : { ...base, html: body };
    } catch {
      if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { ...base, error: signal.aborted ? 'timeout' : 'network' };
    }
  }
}
