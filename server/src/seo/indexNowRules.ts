import { parseRetryAfter } from './googleServices.ts';

/** The IndexNow protocol allows up to 10,000 URLs per request. */
export const INDEXNOW_BATCH_SIZE = 10_000;
/** Our own limit: one submission (of any size) per host per minute, so a double click or a retry loop cannot hammer the endpoint. */
export const INDEXNOW_MIN_INTERVAL_MS = 60_000;
/** Submission log rows kept per Building; the oldest batches are pruned beyond this. */
export const INDEXNOW_LOG_CAP = 50_000;

export function splitBatches<T>(items: T[], size = INDEXNOW_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type SubmissionResult = 'accepted' | 'rejected' | 'error';
export interface MappedResponse { result: SubmissionResult; message: string; retryAfterMs?: number }

/** What an IndexNow answer means, in words the person can act on. 200 and 202 mean "received", never "indexed". */
export function mapIndexNowResponse(status: number, retryAfter: string | null | undefined, now: Date): MappedResponse {
  if (status === 200) return { result: 'accepted', message: 'Received by IndexNow. This is not a confirmation that the pages were indexed.' };
  if (status === 202) return { result: 'accepted', message: 'Received by IndexNow; the key is still being checked. This is not a confirmation that the pages were indexed.' };
  if (status === 400) return { result: 'rejected', message: 'Rejected: the request was malformed (HTTP 400).' };
  if (status === 403) return { result: 'rejected', message: 'Rejected: the key is not valid or its file cannot be found on the site (HTTP 403).' };
  if (status === 422) return { result: 'rejected', message: 'Rejected: the URLs do not belong to the key\'s host or the key does not match (HTTP 422).' };
  if (status === 429) return { result: 'rejected', message: 'Rejected: too many requests (HTTP 429). Try again later.', retryAfterMs: parseRetryAfter(retryAfter, now) };
  if (status >= 500) return { result: 'error', message: `IndexNow had a problem (HTTP ${status}). Try again later.` };
  return { result: 'rejected', message: `Rejected with an unexpected answer (HTTP ${status}).` };
}

export type KeyFileStatus = 'reachable' | 'mismatch' | 'not-found' | 'redirected' | 'html' | 'timeout' | 'too-large' | 'error';

/** Sorts what the key file address returned. The body must be exactly the key (a trailing newline is fine). */
export function classifyKeyFile(input: { status: number; body: string; contentType: string; key: string }): KeyFileStatus {
  if (input.status === 404 || input.status === 410) return 'not-found';
  if (input.status < 200 || input.status >= 300) return 'error';
  if (/html/i.test(input.contentType) || /^\s*<(!doctype|html)/i.test(input.body)) return 'html';
  return input.body.trim() === input.key ? 'reachable' : 'mismatch';
}

/** The key file name shown in the tab: enough to recognise, never the whole key. */
export function maskedKeyFileName(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-2)}.txt`;
}

/** Removes the key (wherever it appears, including inside URLs) from text that may be shown or stored. */
export function redactKey(text: string, key: string): string {
  return key ? text.split(key).join('[key]') : text;
}

export interface ListedUrl { url: string; lastmod: string | null; firstSeen: string }

/**
 * The addresses of one sitemap that are new or changed. New: first seen after the read before the latest one (all of them
 * when there was no earlier read) and not yet accepted since. Changed: the sitemap's `lastmod` is later than the last time
 * IndexNow accepted the address.
 */
export function selectNewOrChanged(listed: ListedUrl[], previousReadAt: string | null, lastAccepted: ReadonlyMap<string, string>): string[] {
  return listed.filter(({ url, lastmod, firstSeen }) => {
    const accepted = lastAccepted.get(url);
    const isNew = (previousReadAt === null || firstSeen > previousReadAt) && (!accepted || accepted < firstSeen);
    const lastmodTime = lastmod ? Date.parse(lastmod) : NaN;
    const changed = accepted !== undefined && !Number.isNaN(lastmodTime) && lastmodTime > Date.parse(accepted);
    return isNew || changed;
  }).map((u) => u.url);
}
