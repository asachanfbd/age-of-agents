import { SeoConflictError } from './errors.ts';

/** The key for a run that covers every sitemap of the Building. */
export const ALL_SITEMAPS = '*';

interface Run { action: string; promise: Promise<unknown> }

const runs = new Map<string, Map<string, Run>>();

/**
 * One run per sitemap at a time. Asking again for the same action on the same sitemap joins the run in progress and shares
 * its result; a different action on a sitemap that is busy, or any action while a whole-Building run is going (and the other
 * way round), is a conflict (409). Finished runs are forgotten.
 */
export function runCoalesced<T>(buildingId: string, key: string, action: string, work: () => Promise<T>): Promise<T> {
  const mine = runs.get(buildingId) ?? new Map<string, Run>();
  runs.set(buildingId, mine);
  const same = mine.get(key);
  if (same) {
    if (same.action === action) return same.promise as Promise<T>;
    return Promise.reject(new SeoConflictError(`This sitemap is already busy with "${same.action}"; try again when it finishes`));
  }
  const clash = key === ALL_SITEMAPS ? mine.size > 0 : mine.has(ALL_SITEMAPS);
  if (clash) return Promise.reject(new SeoConflictError('Another sitemap action is running; try again when it finishes'));
  const promise = work().finally(() => {
    mine.delete(key);
    if (!mine.size) runs.delete(buildingId);
  });
  mine.set(key, { action, promise });
  return promise;
}

/** Forgets a Building's runs; called when the Building is deleted. */
export function clearRuns(buildingId: string): void {
  runs.delete(buildingId);
}
