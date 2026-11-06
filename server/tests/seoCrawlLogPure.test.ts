import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crawlLogCsv, crawlLogFileName, crawlLogOf, crawlLogPage, crawlWarning, LOG_FILTERS, MAX_LOG_ROWS, storedLinks } from '../src/seo/crawl/crawlLog.ts';
import { analyse } from '../src/seo/crawl/analysis.ts';
import { parseHtml } from '../src/seo/crawl/parse.ts';
import { MAX_LINKS_PER_PAGE, MAX_STORED_LINKS } from '../src/seo/crawl/rules.ts';
import { CrawlSite } from '../src/seo/crawl/site.ts';
import type { PageRecord, RawLink, Snapshot } from '../src/seo/crawl/types.ts';

const k = (p: string) => `https://example.com${p}`;

function pg(path: string, patch: Partial<PageRecord> = {}): PageRecord {
  return {
    url: k(path), status: 200, redirectTo: null, redirectExternal: false, contentType: 'text/html', title: null, description: null, canonical: null, noindex: false, error: null,
    externalLinks: 0, internalLinks: 1, discoveredFrom: 'sitemap', fetchedAt: '2026-01-01T00:00:00Z', depth: null, inbound: 0, outbound: 0, inSitemap: false, orphan: false, ...patch,
  };
}
const raw = (from: string, to: string, anchor = 'a', extra: Partial<RawLink> = {}): RawLink => ({ from: k(from), to: k(to), anchor, nofollow: false, location: 'body', ...extra });

function snap(pages: PageRecord[], rawLinks?: RawLink[]): Snapshot {
  return {
    id: 's-1', startedAt: '2026-03-04T10:00:00Z', finishedAt: '2026-03-04T10:05:00Z', status: 'complete', stopReason: null, capped: false, incomplete: false, host: 'example.com', seededFrom: 'sitemaps',
    settings: { pageCap: 10, requestsPerSecond: 1, timeoutSeconds: 5, pageSizeMb: 1 }, stats: { pages: pages.length, fetched: 0, failed: 0, blockedByRobots: 0, skippedUrlSpace: 0, links: 0, externalLinks: 0, uncrawledLinks: 0 },
    pages, links: [], rawLinks,
  };
}

const mixed = () => snap([
  pg('/', { discoveredFrom: null, internalLinks: 3, externalLinks: 2 }),
  pg('/moved', { status: 301, redirectTo: k('/new'), contentType: null, internalLinks: 0, discoveredFrom: k('/') }),
  pg('/self', { status: 301, redirectTo: k('/self'), error: 'redirect-loop', contentType: null, internalLinks: 0 }),
  pg('/gone', { status: 404, internalLinks: 0 }),
  pg('/boom', { status: 503, internalLinks: 0 }),
  pg('/blocked', { status: null, error: 'robots', contentType: null, internalLinks: 0 }),
  pg('/empty', { internalLinks: 0, externalLinks: 0 }),
  pg('/video', { contentType: 'video/mp4', internalLinks: 0 }),
  pg('/new', { internalLinks: 2, discoveredFrom: k('/moved') }),
]);

const filtered = (filter: string, q?: string) => crawlLogOf(mixed(), { filter, q }).rows.map((r) => r.url.replace('https://example.com', ''));

test('rows come out in request order with every column', () => {
  const log = crawlLogOf(mixed(), {});
  assert.deepEqual(log.rows.map((r) => r.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(log.rows[0], { n: 1, url: k('/'), from: 'start', status: 200, contentType: 'text/html', redirectTo: null, selfRedirect: false, error: null, internalLinks: 3, externalLinks: 2, zeroLinks: false });
  assert.equal(log.rows[1]!.from, k('/'));
  assert.equal(log.rows[2]!.from, 'sitemap');
  assert.equal(log.rows[5]!.status, null);
});

test('a snapshot saved before the crawl log existed reads as unknown and falls back to outgoing pages', () => {
  const old = pg('/a', { outbound: 4 });
  delete old.internalLinks;
  delete old.discoveredFrom;
  const [row] = crawlLogOf(snap([old]), {}).rows;
  assert.deepEqual([row!.from, row!.internalLinks], ['unknown', 4]);
});

test('summary buckets: a self-redirect counts once, as failed', () => {
  const { summary } = crawlLogOf(mixed(), {});
  assert.deepEqual(summary, { requested: 9, ok: 4, redirected: 1, failed: 4, other: 0, internalLinks: 5, externalLinks: 2 });
});

test('summary of an empty snapshot is all zeros', () => {
  const log = crawlLogOf(snap([]), {});
  assert.deepEqual(log.summary, { requested: 0, ok: 0, redirected: 0, failed: 0, other: 0, internalLinks: 0, externalLinks: 0 });
  assert.equal(log.matched, 0);
});

test('filters pick redirects, http errors, errors, self-redirects and zero-link pages', () => {
  assert.deepEqual(filtered('redirects'), ['/moved', '/self']);
  assert.deepEqual(filtered('http-errors'), ['/gone', '/boom']);
  assert.deepEqual(filtered('errors'), ['/self', '/blocked']);
  assert.deepEqual(filtered('self-redirects'), ['/self']);
  assert.deepEqual(filtered('zero-links'), ['/empty'], 'errors, redirects, 4xx and non-HTML pages are not "zero links"');
  assert.equal(filtered('all').length, 9);
});

test('chip counts equal the length of each filter result', () => {
  const log = crawlLogOf(mixed(), {});
  for (const f of LOG_FILTERS) assert.equal(log.counts[f], crawlLogOf(mixed(), { filter: f }).matched, f);
});

test('4xx/5xx boundaries', () => {
  const at = (status: number | null) => crawlLogOf(snap([pg('/x', { status })]), { filter: 'http-errors' }).matched;
  assert.deepEqual([null, 0, 399, 400, 599, 600].map(at), [0, 0, 0, 1, 1, 1]);
});

test('search is a trimmed, case-insensitive, literal substring of the address and combines with a filter', () => {
  assert.deepEqual(filtered('all', '  GONE '), ['/gone']);
  assert.deepEqual(filtered('errors', 'self'), ['/self']);
  assert.deepEqual(filtered('http-errors', 'self'), []);
  assert.equal(filtered('all', '').length, 9);
  assert.deepEqual(['.*', '(', '[', '\\', 'x'.repeat(3000)].map((q) => crawlLogOf(mixed(), { q }).matched), [0, 0, 0, 0, 0]);
  assert.equal(crawlLogOf(snap([pg('/a.b'), pg('/axb')]), { q: 'a.b' }).matched, 1);
});

test('an unknown filter or a non-text search is refused', () => {
  assert.throws(() => crawlLogOf(mixed(), { filter: 'bogus' }), /filter must be one of/);
  assert.throws(() => crawlLogOf(mixed(), { filter: ['all', 'all'] }), /filter must be one of/);
  assert.throws(() => crawlLogOf(mixed(), { q: ['a', 'b'] }), /q must be text/);
});

test('the screen gets at most MAX_LOG_ROWS rows while matched keeps the true total', () => {
  const many = snap(Array.from({ length: MAX_LOG_ROWS + 5 }, (_, i) => pg(`/p${i}`)));
  const log = crawlLogOf(many, {});
  assert.deepEqual([log.rows.length, log.matched], [MAX_LOG_ROWS, MAX_LOG_ROWS + 5]);
  assert.equal(crawlLogCsv(many, {}).split('\r\n').length, MAX_LOG_ROWS + 5 + 2, 'the export is not cut');
});

test('CSV: header, CRLF, filtered rows and a formula-safe address', () => {
  const csv = crawlLogCsv(mixed(), { filter: 'self-redirects' });
  assert.deepEqual(csv.split('\r\n'), [
    '#,address,discovered from,status,content type,redirect to,redirects to itself,error,internal links,external links',
    `3,${k('/self')},sitemap,301,,${k('/self')},yes,redirect-loop,0,0`,
    '',
  ]);
  const tricky = crawlLogCsv(snap([pg('/a,"b"', { discoveredFrom: '=cmd', status: null, contentType: null })]), {});
  assert.match(tricky, /"https:\/\/example.com\/a,""b""",'=cmd,/);
  assert.equal(crawlLogCsv(snap([]), {}).split('\r\n').length, 2, 'header only');
  assert.equal(crawlLogFileName(snap([])), 'crawl-log-2026-03-04.csv');
});

test('warning: exactly half is fine, just over half warns, a page with both causes counts once', () => {
  const bad = (p: string) => pg(p, { internalLinks: 0 });
  assert.equal(crawlWarning([bad('/a'), pg('/b')]), null);
  assert.deepEqual(crawlWarning([bad('/a'), bad('/b'), pg('/c')]), { affected: 2, total: 3 });
  assert.deepEqual(crawlWarning([pg('/s', { status: 301, redirectTo: k('/s'), internalLinks: 0 })]), { affected: 1, total: 1 });
  assert.equal(crawlWarning([]), null);
  assert.equal(crawlWarning([pg('/a', { status: 404, internalLinks: 0 }), pg('/b', { status: 404, internalLinks: 0 })]), null, 'failures are reported elsewhere');
});

test('detail: links found for a page, not-crawled flag, empty page, unknown address and old snapshots', () => {
  const s = snap([pg('/', { internalLinks: 3 }), pg('/a'), pg('/none', { internalLinks: 0 })], [raw('/', '/a', 'A', { nofollow: true, location: 'nav' }), raw('/', '/never', 'N'), raw('/a', '/a', 'self'), raw('/ghost', '/a', 'x'), raw('/', '/a', 'again')]);
  assert.deepEqual(crawlLogPage(s, k('/a')).linkedFrom, { total: 1, pages: [k('/')], complete: true }, 'once each, no self link, no uncrawled source');
  const home = crawlLogPage(s, k('/'));
  assert.deepEqual(home.linksFound.links, [
    { url: k('/a'), anchor: 'A', location: 'nav', nofollow: true, crawled: true },
    { url: k('/never'), anchor: 'N', location: 'body', nofollow: false, crawled: false },
    { url: k('/a'), anchor: 'again', location: 'body', nofollow: false, crawled: true },
  ]);
  assert.equal(home.stored, true);
  assert.deepEqual(crawlLogPage(s, k('/none')).linksFound, { total: 0, links: [] });
  assert.equal(crawlLogPage(s, k('/none')).stored, true);
  assert.throws(() => crawlLogPage(s, k('/nope')), /not in this crawl/);
  assert.throws(() => crawlLogPage(s, undefined), /not in this crawl/);
  const oldSnapshot = snap([pg('/')]);
  assert.equal(crawlLogPage(oldSnapshot, k('/')).stored, false);
  const cut = snap([pg('/', { internalLinks: 5 })], [raw('/', '/a')]);
  assert.equal(crawlLogPage(cut, k('/')).stored, false, 'beyond the storage cap');
});

test('detail lists are cut at 500 and report the true total', () => {
  const links = Array.from({ length: 600 }, (_, i) => raw('/', `/t${i}`));
  const detail = crawlLogPage(snap([pg('/', { internalLinks: 600 })], links), k('/'));
  assert.deepEqual([detail.linksFound.total, detail.linksFound.links.length], [600, 500]);
});

test('analyse output is unchanged by the new page fields', () => {
  const pages = [pg('/', { internalLinks: 1 }), pg('/a')];
  const out = analyse(pages, [raw('/', '/a')], [k('/')], k('/'));
  assert.equal(out.pages[1]!.inbound, 1);
  assert.equal(out.pages[0]!.internalLinks, 1, 'the new fields survive the analysis');
  assert.equal(out.pages[0]!.discoveredFrom, 'sitemap');
});

test('a row says whether it is a zero-links page, the same test the filter uses; non-HTML 200s are not', () => {
  const rows = crawlLogOf(mixed(), {}).rows;
  assert.deepEqual(rows.filter((r) => r.zeroLinks).map((r) => r.url), [k('/empty')]);
  assert.equal(rows.find((r) => r.url === k('/video'))!.zeroLinks, false);
  assert.equal(crawlLogOf(snap([pg('/img', { contentType: 'image/png', internalLinks: 0 })]), {}).rows[0]!.zeroLinks, false);
});

test('summary: an answer that is neither OK, redirected nor failed is an "other" bucket, so the buckets add up', () => {
  const { summary } = crawlLogOf(snap([pg('/a'), pg('/odd', { status: 304, internalLinks: 0 }), pg('/noloc', { status: 302, internalLinks: 0 })]), {});
  assert.deepEqual([summary.ok, summary.redirected, summary.failed, summary.other], [1, 0, 0, 2]);
  const m = crawlLogOf(mixed(), {}).summary;
  assert.equal(m.ok + m.redirected + m.failed + m.other, m.requested);
});

test('stored links: the cap keeps the first links in crawl order; per-page parsing stops at 500', () => {
  const many = Array.from({ length: MAX_STORED_LINKS + 1 }, (_, i) => raw('/', `/t${i}`));
  assert.equal(storedLinks(many).length, MAX_STORED_LINKS);
  assert.equal(storedLinks(many)[0], many[0]);
  assert.equal(storedLinks(many.slice(0, 5)).length, 5);
  const site = new CrawlSite('https://example.com');
  const count = (n: number) => parseHtml(Array.from({ length: n }, (_, i) => `<a href="/p${i}">x</a>`).join(''), 'https://example.com/', site).links.length;
  assert.deepEqual([MAX_LINKS_PER_PAGE - 1, MAX_LINKS_PER_PAGE, MAX_LINKS_PER_PAGE + 1].map(count), [499, 500, 500]);
});

test('the sources that link here are marked incomplete once the stored lists hit the cap or are absent', () => {
  const full = Array.from({ length: MAX_STORED_LINKS }, (_, i) => raw('/', `/t${i}`));
  assert.equal(crawlLogPage(snap([pg('/')], full), k('/')).linkedFrom.complete, false);
  assert.equal(crawlLogPage(snap([pg('/')], [raw('/', '/a')]), k('/')).linkedFrom.complete, true);
  assert.equal(crawlLogPage(snap([pg('/')]), k('/')).linkedFrom.complete, false);
});

test('a 10,000-row snapshot is filtered, searched and exported quickly, with the screen rows bounded', () => {
  const big = snap(Array.from({ length: 10_000 }, (_, i) => pg(`/p${i}`, i % 3 === 0 ? { status: 404 } : {})));
  const started = Date.now();
  const log = crawlLogOf(big, { filter: 'http-errors', q: 'p9' });
  const csv = crawlLogCsv(big, {});
  assert.ok(Date.now() - started < 3000);
  assert.ok(log.rows.length <= MAX_LOG_ROWS && log.matched > 0);
  assert.equal(csv.split('\r\n').length, 10_002);
  assert.ok(JSON.stringify(crawlLogOf(big, {})).length < 1_000_000, 'the response stays bounded');
});
