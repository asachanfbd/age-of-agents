import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { analyse, looksIncomplete, resolveFinal } from '../src/seo/crawl/analysis.ts';
import { parseHtml } from '../src/seo/crawl/parse.ts';
import { ALLOW_ALL, parseRobots } from '../src/seo/crawl/robots.ts';
import { backoffMs, DEFAULT_CRAWL_SETTINGS, isUrlSpaceTrap, mergeSettings, paceMs } from '../src/seo/crawl/rules.ts';
import { CrawlSite } from '../src/seo/crawl/site.ts';
import type { PageRecord, RawLink, Snapshot } from '../src/seo/crawl/types.ts';

let tempRoot: string;
let views: typeof import('../src/seo/crawl/views.ts');

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'seo-crawl-pure-'));
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  views = await import('../src/seo/crawl/views.ts');
});
after(() => rm(tempRoot, { recursive: true, force: true }));

const site = new CrawlSite('https://example.com');
const parse = (html: string, url = 'https://example.com/dir/page', xRobots: string | null = null) => parseHtml(html, url, site, xRobots);
const k = (p: string) => `https://example.com${p}`;

test('U01 anchors resolve relative, root-relative, protocol-relative and ../ hrefs', () => {
  const out = parse('<a href="x">1</a><a href="/y">2</a><a href="//example.com/z">3</a><a href="../up">4</a><a href="https://example.com/abs?utm_source=a#frag">5</a>');
  assert.deepEqual(out.links.map((l) => l.target), [k('/dir/x'), k('/y'), k('/z'), k('/up'), k('/abs')]);
});

test('U02 mailto, tel, javascript, data and bare fragments are skipped', () => {
  const out = parse('<a href="mailto:a@b.c">m</a><a href="tel:1">t</a><a href="javascript:void(0)">j</a><a href="data:text/html,x">d</a><a href="#top">f</a><a href="">e</a>');
  assert.deepEqual([out.links.length, out.externalCount], [0, 0]);
});

test('U03 a base href changes resolution', () => {
  assert.equal(parse('<base href="/base/"><a href="x">x</a>').links[0]!.target, k('/base/x'));
});

test('U04 anchor text is trimmed and collapsed; an image uses alt; empty gives ""; long text is truncated', () => {
  const out = parse(`<a href="/a">  Hello \n  world </a><a href="/b"><img alt="Logo" src="x"></a><a href="/c"></a><a href="/d">${'x'.repeat(500)}</a>`);
  assert.deepEqual(out.links.map((l) => l.anchor.length), [11, 4, 0, 200]);
  assert.equal(out.links[0]!.anchor, 'Hello world');
  assert.equal(out.links[1]!.anchor, 'Logo');
});

test('U05 nofollow is read case-insensitively inside a rel list; follow and no rel are not flagged', () => {
  const out = parse('<a href="/1" rel="nofollow">1</a><a href="/2" rel="NoFollow">2</a><a href="/3" rel="noopener NOFOLLOW">3</a><a href="/4" rel="follow">4</a><a href="/5">5</a>');
  assert.deepEqual(out.links.map((l) => l.nofollow), [true, true, true, false, false]);
});

test('U06 location is footer, nav, header or body, the closest landmark winning in that order', () => {
  const out = parse('<header><a href="/h">h</a></header><nav><a href="/n">n</a></nav><footer><nav><a href="/fn">fn</a></nav></footer><div role="navigation"><a href="/r">r</a></div><aside><a href="/s">s</a></aside><a href="/b">b</a>');
  assert.deepEqual(out.links.map((l) => l.location), ['header', 'nav', 'footer', 'nav', 'body', 'body']);
});

test('U07/U08 title, description, canonical and noindex are read; missing and long values are handled', () => {
  const out = parse('<head><title> A  title </title><meta name="description" content="Desc"><link rel="canonical" href="/canon"><meta name="robots" content="NOINDEX, nofollow"></head>');
  assert.deepEqual([out.title, out.description, out.canonical, out.noindex], ['A title', 'Desc', k('/canon'), true]);
  assert.equal(parse('<meta name="googlebot" content="none">').noindex, true);
  assert.equal(parse('<p>x</p>', undefined, 'noindex').noindex, true);
  assert.equal(parse('<meta name="robots" content="index, follow">').noindex, false);
  const bare = parse('<p>nothing</p>');
  assert.deepEqual([bare.title, bare.description, bare.canonical], [null, null, null]);
  const long = parse(`<title>${'t'.repeat(900)}</title><meta name="description" content="${'d'.repeat(900)}">`);
  assert.deepEqual([long.title!.length, long.description!.length], [300, 500]);
});

test('U09 malformed, empty and binary bodies do not throw', () => {
  for (const body of ['<a href="/x"', '', '\u0000\u0001\u0002<<<>>>', '<div><a href=/x>unclosed']) assert.doesNotThrow(() => parse(body));
});

test('U10 external hosts, subdomains and schemes are counted and not queued', () => {
  const out = parse('<a href="https://other.com/a">o</a><a href="https://blog.example.com/">s</a><a href="ftp://example.com/f">f</a><a href="/in">i</a>');
  assert.deepEqual([out.links.length, out.externalCount], [1, 2]);
});

test('U11 addresses use the shared normaliser: tracking params, fragments, trailing slash, host case and user info', () => {
  assert.equal(site.keyOf('HTTP://Example.COM:80/A/?b=2&a=1&utm_x=1#f', 'https://example.com/'), k('/A?a=1&b=2'));
  assert.equal(site.keyOf('https://user:pw@example.com/', 'https://example.com/'), null);
  assert.equal(site.keyOf(`/${'a'.repeat(2100)}`, 'https://example.com/'), null);
});

test('U12 www and the bare host are one site, written as the Building host; other hosts are external', () => {
  const bare = new CrawlSite('https://example.com');
  assert.equal(bare.keyOf('https://www.example.com/x', 'https://example.com/'), k('/x'));
  const www = new CrawlSite('https://www.example.com');
  assert.equal(www.keyOf('https://example.com/x', 'https://www.example.com/'), 'https://www.example.com/x');
  assert.equal(bare.isInternal('https://other.com/'), false);
  assert.equal(new CrawlSite('http://example.com').fetchUrl(k('/a')), 'http://example.com/a');
});

test('a redirect to the other scheme or www variant of the host moves requests there; other hosts and schemes are ignored', () => {
  const bare = new CrawlSite('http://example.com');
  assert.equal(bare.adoptOrigin('https://www.example.com/', 'http://example.com/'), true);
  assert.equal(bare.fetchUrl(k('/a')), 'https://www.example.com/a');
  assert.equal(bare.adoptOrigin('/other', 'https://www.example.com/a'), false, 'already on that origin');
  assert.equal(bare.adoptOrigin('https://other.com/', 'https://www.example.com/'), false);
  assert.equal(bare.adoptOrigin('ftp://example.com/', 'https://www.example.com/'), false);
  assert.equal(bare.adoptOrigin('http://', 'https://www.example.com/'), false);
  assert.equal(bare.fetchUrl(k('/a')), 'https://www.example.com/a');
});

test('sameKeyRedirect returns the literal Location only for the same page on the same site', () => {
  const site = new CrawlSite('https://example.com');
  const base = 'https://example.com/about';
  assert.equal(site.sameKeyRedirect('/about/', base, k('/about')), 'https://example.com/about/');
  assert.equal(site.sameKeyRedirect('/about', base, k('/about')), null, 'unchanged address');
  assert.equal(site.sameKeyRedirect('/other/', base, k('/about')), null, 'another page');
  assert.equal(site.sameKeyRedirect('https://other.com/about/', base, k('/about')), null, 'another host');
  assert.equal(site.sameKeyRedirect('https://www.example.com/about/', base, k('/about')), 'https://www.example.com/about/');
  assert.equal(site.fetchUrl(k('/about')), 'https://www.example.com/about', 'the www origin is adopted');
});

test('robots rules read on one origin still apply to the same site requested on another', () => {
  const rules = parseRobots('https://www.example.com/robots.txt', 'User-agent: *\nDisallow: /private\n');
  assert.deepEqual([rules.allows('http://example.com/private/x'), rules.allows('https://example.com/ok')], [false, true]);
});

test('U13 the URL-space guard skips endless parameters, deep paths and repeated segments', () => {
  const seen = new Map<string, number>();
  assert.equal(isUrlSpaceTrap(k('/a/b'), seen), false);
  assert.equal(isUrlSpaceTrap(k('/a/b/a/b/a/b'), seen), true);
  assert.equal(isUrlSpaceTrap(k('/p?a=1&b=2&c=3&d=4'), seen), true);
  assert.equal(isUrlSpaceTrap(k(`/${Array(12).fill('x').map((x, i) => x + i).join('/')}`), seen), true);
  const calendar = new Map<string, number>();
  const verdicts = Array.from({ length: 25 }, (_, i) => isUrlSpaceTrap(k(`/cal?date=${i}`), calendar));
  assert.deepEqual([verdicts.slice(0, 20).some(Boolean), verdicts.slice(20).every(Boolean)], [false, true]);
});

test('U14 robots.txt: allow precedence, wildcards, group choice, crawl-delay cap, empty file', () => {
  const rules = parseRobots('https://example.com/robots.txt', 'User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nCrawl-delay: 99\n\nUser-agent: agent-visual-os-seo\nDisallow: /mine\n');
  assert.equal(rules.allows(k('/mine/x')), false);
  assert.equal(rules.allows(k('/private')), true, 'the specific group replaces the * group');
  const star = parseRobots('https://example.com/robots.txt', 'User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nCrawl-delay: 99\n');
  assert.deepEqual([star.allows(k('/private/x')), star.allows(k('/private/ok')), star.allows(k('/a.pdf')), star.allows(k('/a.pdf?x=1')), star.crawlDelayMs], [false, true, false, true, 10_000]);
  assert.equal(parseRobots('https://example.com/robots.txt', '').allows(k('/anything')), true);
  assert.equal(ALLOW_ALL.allows('x'), true);
});

test('U15 pacing: delay between requests at several rates; zero, negative and NaN are refused', () => {
  assert.deepEqual([0.5, 1, 2, 10].map(paceMs), [2000, 1000, 500, 100]);
  for (const bad of [0, -1, NaN]) assert.throws(() => paceMs(bad), /above 0/);
});

test('U16 back-off: Retry-After as seconds and as a date, past, negative, huge, absent, and exponential growth', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  assert.equal(backoffMs(0, '7', now), 7000);
  assert.equal(backoffMs(0, 'Wed, 14 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(backoffMs(0, 'Wed, 14 Oct 2026 11:00:00 GMT', now), 1000, 'a date in the past falls back to the exponential wait');
  assert.equal(backoffMs(0, '0', now), 0);
  assert.equal(backoffMs(0, '-5', now), 1000);
  assert.equal(backoffMs(0, '999999', now), 60_000);
  assert.deepEqual([0, 1, 2, 3].map((n) => backoffMs(n, null, now)), [1000, 2000, 4000, 8000]);
  assert.equal(backoffMs(20, null, now), 60_000);
});

test('U17 settings validation names the limit; defaults are 3,000 pages, 2 per second, 15 s and 2 MB', () => {
  assert.deepEqual(DEFAULT_CRAWL_SETTINGS, { pageCap: 3000, requestsPerSecond: 2, timeoutSeconds: 15, pageSizeMb: 2 });
  assert.deepEqual(mergeSettings(DEFAULT_CRAWL_SETTINGS, { pageCap: 10_000, pageSizeMb: 0.1 }), { ...DEFAULT_CRAWL_SETTINGS, pageCap: 10_000, pageSizeMb: 0.1 });
  for (const bad of [{ pageCap: 0 }, { pageCap: NaN }, { pageCap: '5' }, { pageCap: 2 ** 53 }, { timeoutSeconds: 0.5 }, { requestsPerSecond: 10.5 }]) assert.throws(() => mergeSettings(DEFAULT_CRAWL_SETTINGS, bad), /from/);
  assert.throws(() => mergeSettings(DEFAULT_CRAWL_SETTINGS, null), /object/);
});

const page = (url: string, patch: Partial<PageRecord> = {}): PageRecord => ({
  url, status: 200, redirectTo: null, redirectExternal: false, contentType: 'text/html', title: null, description: null, canonical: null, noindex: false, error: null,
  externalLinks: 0, fetchedAt: '2026-10-14T00:00:00Z', depth: null, inbound: 0, outbound: 0, inSitemap: false, orphan: false, ...patch,
});
const link = (from: string, to: string, anchor = ''): RawLink => ({ from: k(from), to: k(to), anchor, nofollow: false, location: 'body' });

test('U18/U19 redirect chains resolve to the final page, loops and long chains are marked, broken targets are flagged', () => {
  const pages = [page(k('/')), page(k('/old'), { status: 301, redirectTo: k('/mid') }), page(k('/mid'), { status: 302, redirectTo: k('/new') }), page(k('/new')), page(k('/gone'), { status: 404 }),
    page(k('/l1'), { status: 301, redirectTo: k('/l2') }), page(k('/l2'), { status: 301, redirectTo: k('/l1') }), page(k('/ext'), { status: 301, redirectTo: 'https://other.com/', redirectExternal: true }),
    page(k('/to-gone'), { status: 301, redirectTo: k('/gone') })];
  const map = new Map(pages.map((p) => [p.url, p]));
  assert.equal((resolveFinal(k('/old'), map) as { page: PageRecord }).page.url, k('/new'));
  assert.deepEqual([resolveFinal(k('/l1'), map).kind, resolveFinal(k('/ext'), map).kind, resolveFinal(k('/nope'), map).kind], ['loop', 'external', 'unknown']);
  const out = analyse(pages, [link('/', '/old', 'Old'), link('/', '/to-gone'), link('/', '/ext'), link('/', '/l1'), link('/', '/nope')], [], k('/'));
  assert.deepEqual(out.links.map((l) => [l.to, l.via, l.broken]), [[k('/new'), k('/old'), false], [k('/gone'), k('/to-gone'), true]]);
  assert.equal(out.uncrawledLinks, 2);
  assert.equal(out.pages.find((p) => p.url === k('/l1'))!.error, 'redirect-loop');
  const long = Array.from({ length: 13 }, (_, i) => page(k(`/h${i}`), i < 12 ? { status: 301, redirectTo: k(`/h${i + 1}`) } : {}));
  assert.equal(resolveFinal(k('/h0'), new Map(long.map((p) => [p.url, p]))).kind, 'too-many');
});

test('U20/U21/U22 depth is the fewest clicks from home, counts are per unique page pair, orphans are sitemap pages nobody links to', () => {
  const pages = ['/', '/a', '/b', '/c', '/island', '/lonely', '/via'].map((p) => page(k(p)));
  pages.push(page(k('/redir'), { status: 301, redirectTo: k('/via') }));
  const out = analyse(pages, [link('/', '/a'), link('/', '/b'), link('/a', '/c'), link('/b', '/c'), link('/b', '/c', 'again'), link('/a', '/a', 'self'), link('/', '/redir'), link('/island', '/a')],
    [k('/lonely'), k('/island'), k('/'), k('/via'), k('/c')], k('/'));
  const by = (p: string) => out.pages.find((x) => x.url === k(p))!;
  assert.deepEqual(['/', '/a', '/c', '/island'].map((p) => by(p).depth), [0, 1, 2, null]);
  assert.deepEqual([by('/c').inbound, by('/a').outbound, by('/a').inbound], [2, 1, 2]);
  assert.deepEqual(['/lonely', '/island', '/', '/via', '/c'].map((p) => by(p).orphan), [true, true, false, false, false]);
});

test('U23/U25 only HTML pages count when judging "may be incomplete", and the threshold is a boundary', () => {
  const html = (n: number, outbound: number) => Array.from({ length: n }, (_, i) => page(k(`/${i}`), { outbound }));
  assert.equal(looksIncomplete(html(2, 0)), false, 'too few pages to judge');
  assert.equal(looksIncomplete(html(3, 0)), true);
  assert.equal(looksIncomplete(html(3, 1)), false, 'one link per page on average is enough');
  assert.equal(looksIncomplete([...html(3, 0), page(k('/pdf'), { contentType: 'application/pdf', outbound: 100 })]), true);
  assert.equal(looksIncomplete([]), false);
});

test('U26 snapshot comparison: pages and links added or removed, status changes, identical and empty snapshots', () => {
  const snap = (pages: PageRecord[], links: Array<[string, string, string]>): Snapshot => ({
    id: 's-x', startedAt: '2026-10-14T00:00:00Z', finishedAt: '', status: 'complete', stopReason: null, capped: false, incomplete: false, host: 'example.com', seededFrom: 'home', settings: DEFAULT_CRAWL_SETTINGS,
    stats: { pages: pages.length, fetched: 0, failed: 0, blockedByRobots: 0, skippedUrlSpace: 0, links: 0, externalLinks: 0, uncrawledLinks: 0 }, pages,
    links: links.map(([from, to, anchor]) => ({ from: k(from), to: k(to), anchor, nofollow: false, location: 'body', via: null, broken: false })),
  });
  const older = snap([page(k('/')), page(k('/a')), page(k('/b'))], [['/', '/a', 'A'], ['/', '/b', 'B']]);
  const newer = snap([page(k('/')), page(k('/a'), { status: 404 }), page(k('/c'))], [['/', '/a', 'A'], ['/', '/c', 'C']]);
  const diff = views.compareSnapshots(older, newer);
  assert.deepEqual([diff.pagesAdded.items, diff.pagesRemoved.items], [[k('/c')], [k('/b')]]);
  assert.deepEqual(diff.statusChanged.items, [{ url: k('/a'), from: 200, to: 404 }]);
  assert.deepEqual([diff.linksAdded.items.map((l) => l.anchor), diff.linksRemoved.items.map((l) => l.anchor)], [['C'], ['B']]);
  const same = views.compareSnapshots(older, older);
  assert.deepEqual([same.pagesAdded.total, same.linksRemoved.total, same.statusChanged.total], [0, 0, 0]);
  const empty = views.compareSnapshots(snap([], []), older);
  assert.deepEqual([empty.pagesAdded.total, empty.pagesRemoved.total, empty.linksAdded.total], [3, 0, 2]);
});

test('U31/U32 the matrix keeps 30 per side, counts links and anchors, neutralises formulas and quotes in the CSV', () => {
  const pages = ['/', '/a', '/b'].map((p) => page(k(p)));
  const snapshot = {
    id: 's-x', startedAt: '2026-10-14T09:00:00Z', links: [
      { from: k('/'), to: k('/a'), anchor: '=SUM(1)', nofollow: false, location: 'body', via: null, broken: false },
      { from: k('/'), to: k('/a'), anchor: 'two', nofollow: false, location: 'nav', via: null, broken: false },
      { from: k('/a'), to: k('/b'), anchor: 'x', nofollow: false, location: 'body', via: null, broken: false },
    ], pages,
  } as unknown as Snapshot;
  const m = views.matrixOf(snapshot, { rows: [k('/'), k('/a')], cols: [k('/a'), k('/b')] });
  assert.deepEqual([m.cells[0]![0]!.count, m.cells[0]![0]!.locations, m.cells[1]![0], m.rowTotals, m.colTotals], [2, ['body', 'nav'], null, [2, 1], [2, 1]]);
  assert.throws(() => views.matrixOf(snapshot, { rows: Array(31).fill(k('/')).map((u, i) => `${u}${i}`), cols: [] }), /30/);
  assert.throws(() => views.matrixOf(snapshot, { rows: 'x', cols: [] }), /list/);
  assert.equal(views.csvCell('=1+1'), "'=1+1");
  for (const lead of ['+', '-', '@']) assert.equal(views.csvCell(`${lead}x`), `'${lead}x`);
  assert.equal(views.csvCell('a,"b"\nc'), '"a,""b""\nc"');
  const csv = views.matrixCsv(views.matrixOf(snapshot, { rows: [], cols: [] }));
  assert.equal(csv, 'source \\ target,total\r\ntotal,0\r\n');
  assert.equal(views.matrixFileName('Blog -> Products', snapshot), 'matrix-blog-products-2026-10-14.csv');
  assert.equal(views.matrixFileName(undefined, snapshot), 'matrix-2026-10-14.csv');
  assert.equal(views.sectionOf(k('/')), 'home');
  assert.equal(views.sectionOf(k('/blog/post')), 'blog');
});
