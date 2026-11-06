import * as robotsModule from 'robots-parser';

const robotsParser = ((robotsModule as unknown as { default?: unknown }).default ?? robotsModule) as typeof import('robots-parser').default;
import { CRAWL_USER_AGENT, MAX_CRAWL_DELAY_MS } from './rules.ts';

export interface RobotsRules { allows(url: string): boolean; crawlDelayMs: number }

export const ALLOW_ALL: RobotsRules = { allows: () => true, crawlDelayMs: 0 };

/** Rules from a robots.txt body read at `robotsUrl`. They apply to every address of the crawled site, whichever scheme or `www.` variant it is requested on. */
export function parseRobots(robotsUrl: string, body: string): RobotsRules {
  const robots = robotsParser(robotsUrl, body);
  const delay = robots.getCrawlDelay(CRAWL_USER_AGENT);
  return {
    allows: (url) => {
      const { pathname, search } = new URL(url);
      return robots.isAllowed(new URL(pathname + search, robotsUrl).href, CRAWL_USER_AGENT) !== false;
    },
    crawlDelayMs: typeof delay === 'number' && delay > 0 ? Math.min(delay * 1000, MAX_CRAWL_DELAY_MS) : 0,
  };
}
