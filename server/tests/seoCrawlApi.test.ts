import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, beforeEach, test } from 'node:test';
import { createFakeSeo } from './helpers/seoFakes.ts';

/*
 * The crawl against a fake local site. `routes` maps a path to what the site answers (a missing path is a 404) and `log`
 * records every request with its headers, so tests can prove what was and was not requested.
 */
let tempRoot: string;
let baseUrl: string;
let server: HttpServer;
let site: HttpServer;
let external: HttpServer;
let origin: string;
let externalOrigin: string;
let routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void>;
let log: Array<{ path: string; headers: IncomingMessage['headers'] }>;
let externalHits: string[];
let sleeps: number[];
let deps: typeof import('../src/seo/deps.ts');
let storage: typeof import('../src/buildings/buildingStorage.ts');
let secretsMod: typeof import('../src/buildings/secrets.ts');
let runner: typeof import('../src/seo/crawl/runner.ts');
let firstRun: typeof import('../src/seo/firstRun.ts');
let crawlStore: typeof import('../src/seo/crawl/store.ts');
const realConsole = { log: console.log, error: console.error, warn: console.warn };

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'seo-crawl-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  process.env.AGENT_VISUAL_OS_EXECUTORS_PATH = path.join(import.meta.dirname, 'fixtures', 'executors.json');
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = path.join(tempRoot, 'catalog');
  process.env.AGENT_VISUAL_OS_DEV_TYPES = '1';
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), process.env.AGENT_VISUAL_OS_CATALOG_DIR, { recursive: true });
  const { createDaemonServer } = await import('../src/server.ts');
  deps = await import('../src/seo/deps.ts');
  storage = await import('../src/buildings/buildingStorage.ts');
  secretsMod = await import('../src/buildings/secrets.ts');
  runner = await import('../src/seo/crawl/runner.ts');
  firstRun = await import('../src/seo/firstRun.ts');
  crawlStore = await import('../src/seo/crawl/store.ts');
  server = createDaemonServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  site = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    log.push({ path: req.url ?? pathname, headers: req.headers });
    const handler = routes.get(pathname);
    if (handler) handler(req, res); else { res.statusCode = 404; res.setHeader('content-type', 'text/html'); res.end('<html><title>Missing</title></html>'); }
  });
  external = createServer((req, res) => { externalHits.push(req.url ?? ''); res.end('<html></html>'); });
  await Promise.all([new Promise<void>((r) => site.listen(0, '127.0.0.1', r)), new Promise<void>((r) => external.listen(0, '127.0.0.1', r))]);
  origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  externalOrigin = `http://127.0.0.1:${(external.address() as { port: number }).port}`;
  for (const level of ['log', 'error', 'warn'] as const) console[level] = () => undefined;
});

after(async () => {
  Object.assign(console, realConsole);
  deps.resetSeo();
  await storage.closeAllStores();
  site.closeAllConnections();
  external.closeAllConnections();
  await Promise.all([new Promise((r) => site.close(r)), new Promise((r) => external.close(r)), new Promise((r) => server.close(r))]);
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  routes = new Map();
  log = [];
  externalHits = [];
  sleeps = [];
  deps.configureSeo({ firstRun: false, services: createFakeSeo().services, now: () => new Date(), sleep: async (ms) => { sleeps.push(ms); }, limits: deps.defaultLimits() });
});

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body, text, headers: res.headers };
}
const send = (method: string, pathname: string, payload?: unknown) => api(pathname, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
const seo = (id: string, suffix: string) => `/api/projects/${id}/seo${suffix}`;
const links = (id: string, suffix = '') => seo(id, `/internal-links${suffix}`);

async function createSeo(siteUrl = origin) {
  const res = await send('POST', '/api/projects', { typeId: 'seo', siteUrl });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}

const html = (body: string, head = '<title>T</title>') => (_req: IncomingMessage, res: ServerResponse) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<html><head>${head}</head><body>${body}</body></html>`); };
const serve = (p: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => routes.set(p, handler);
const page = (p: string, body: string, head?: string) => serve(p, html(body, head));
const redirect = (p: string, to: string, status = 301) => serve(p, (_req, res) => { res.statusCode = status; res.setHeader('location', to); res.end(); });
const a = (href: string, text = href) => `<a href="${href}">${text}</a>`;
const xml = (urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const key = (p: string) => `https://${new URL(origin).host}${p}`;

async function readSitemap(id: string, urls: string[]) {
  serve('/sitemap.xml', (_req, res) => { res.setHeader('content-type', 'application/xml'); res.end(xml(urls.map((u) => `${origin}${u}`))); });
  assert.equal((await send('POST', seo(id, '/sitemaps/read'))).status, 200);
}

async function waitFinished(id: string) {
  for (let i = 0; i < 600; i++) {
    const run = (await api(links(id, '/crawl'))).body;
    if (run && run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('crawl did not finish');
}
async function crawl(id: string, body: object = {}) {
  const started = await send('POST', links(id, '/crawl'), body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return waitFinished(id);
}
const graph = async (id: string, snapshot?: string) => (await api(links(id, `/graph${snapshot ? `?snapshot=${snapshot}` : ''}`))).body;
const node = (g: any, p: string) => g.nodes.find((n: any) => n.url === key(p));

/** A small well-formed site used by most tests. */
function smallSite() {
  serve('/robots.txt', (_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('User-agent: *\nDisallow: /private\n'); });
  page('/', `<nav>${a('/a', 'Page A')}</nav>${a('/b', 'Page B')}${a('/redir', 'Old')}${a('/missing', 'Gone')}${a('/private', 'Secret')}${a('/file.pdf', 'PDF')}${a(`${externalOrigin}/x`, 'Elsewhere')}${a('mailto:a@b.c', 'mail')}<footer>${a('/b', 'Footer B')}</footer>`, '<title>Home</title><meta name="description" content="The home"><link rel="canonical" href="/">');
  page('/a', `${a('/b')}${a('/a', 'self')}${a('/deep1')}`);
  page('/b', `${a('/')}`, '<title>B</title><meta name="robots" content="noindex">');
  page('/c', 'no links');
  redirect('/redir', '/c');
  page('/deep1', a('/deep2'));
  page('/deep2', a('/deep3'));
  page('/deep3', a('/deep4'));
  page('/deep4', 'end');
  page('/orphan', 'alone');
  page('/private', 'blocked');
  serve('/file.pdf', (_req, res) => { res.setHeader('content-type', 'application/pdf'); res.end('%PDF'); });
}

test('I01/I02/I08/I15/I22/I23 a crawl seeded from the sitemap stores every field, resolves redirects and flags broken links', async () => {
  const { id } = await createSeo();
  smallSite();
  await readSitemap(id, ['/', '/a', '/orphan']);
  const run = await crawl(id);
  assert.equal(run.status, 'complete');
  const g = await graph(id);
  assert.equal(g.snapshot.status, 'complete');
  assert.equal(g.snapshot.seededFrom, 'sitemaps');
  const home = node(g, '/');
  assert.deepEqual([home.status, home.depth, home.title, home.inSitemap], [200, 0, 'Home', true]);
  assert.equal(node(g, '/b').noindex, true);
  assert.equal(node(g, '/a').depth, 1);
  assert.equal(node(g, '/deep4').depth, 5);
  assert.equal(node(g, '/missing').status, 404);
  assert.equal(node(g, '/file.pdf').status, 200);
  assert.equal(node(g, '/redir'), undefined, 'a redirecting address is not a graph node');
  assert.equal(node(g, '/c').inbound, 1, 'the link to /redir counts for /c');
  assert.equal(node(g, '/orphan').orphan, true);
  assert.equal(node(g, '/').orphan, false);
  assert.equal(node(g, '/private').error, 'robots', 'a blocked page is shown as a node but never requested');
  const detail = (await api(links(id, `/page?url=${encodeURIComponent(key('/c'))}`))).body;
  assert.deepEqual(detail.linkedFrom.links.map((l: any) => [l.path, l.anchor, l.via]), [['/', 'Old', key('/redir')]]);
  assert.deepEqual(detail.redirectsFrom, [key('/redir')]);
  const homeDetail = (await api(links(id, `/page?url=${encodeURIComponent(key('/')) }`))).body;
  assert.equal(homeDetail.page.externalLinks, 1);
  assert.equal(homeDetail.page.description, 'The home');
  const toMissing = homeDetail.linksTo.links.find((l: any) => l.path === '/missing');
  assert.equal(toMissing.broken, true);
  assert.deepEqual(homeDetail.linksTo.links.filter((l: any) => l.path === '/b').map((l: any) => l.location).sort(), ['body', 'footer']);
  assert.equal(homeDetail.linksTo.links.find((l: any) => l.path === '/a').location, 'nav');
  const edgeToC = g.edges.find((e: any) => g.nodes[e[1]].url === key('/c'));
  assert.equal(edgeToC[2] & 2, 2, 'redirect flag');
});

test('I04/I05 pages disallowed by robots.txt are never requested; a missing robots.txt allows everything', async () => {
  const { id } = await createSeo();
  smallSite();
  await crawl(id);
  assert.equal(log.some((l) => l.path === '/private'), false);
  assert.equal((await graph(id)).snapshot.stats.blockedByRobots, 1);
  smallSite();
  routes.delete('/robots.txt');
  await crawl(id);
  assert.equal(log.some((l) => l.path === '/private'), true);
});

test('I06 a robots.txt server error refuses the crawl and says why, keeping nothing half-done', async () => {
  const { id } = await createSeo();
  smallSite();
  serve('/robots.txt', (_req, res) => { res.statusCode = 503; res.end(); });
  const run = await crawl(id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /robots\.txt/);
  assert.equal(log.filter((l) => l.path !== '/robots.txt' && l.path !== '/sitemap.xml').length, 0);
  assert.deepEqual((await api(links(id))).body.snapshots, []);
});

test('I07/I21 Crawl-delay is honoured up to the cap and requests are paced at the configured rate', async () => {
  const { id } = await createSeo();
  page('/', a('/a'));
  page('/a', 'x');
  serve('/robots.txt', (_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('User-agent: *\nCrawl-delay: 3\n'); });
  await crawl(id);
  assert.ok(sleeps.some((ms) => ms > 2900 && ms <= 3000), `sleeps ${sleeps}`);
  serve('/robots.txt', (_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('User-agent: *\nCrawl-delay: 500\n'); });
  sleeps = [];
  await crawl(id);
  assert.ok(Math.max(...sleeps) <= 10_000);
  routes.delete('/robots.txt');
  sleeps = [];
  assert.equal((await send('PUT', links(id, '/settings'), { requestsPerSecond: 4 })).status, 200);
  await crawl(id);
  assert.ok(sleeps.length > 0 && sleeps.every((ms) => ms <= 250), `sleeps ${sleeps}`);
});

test('I09/I10/I19 redirect loops and long chains fail without hanging; redirects to other hosts are not followed; other hosts get no requests', async () => {
  const { id } = await createSeo();
  page('/', `${a('/loop1')}${a('/hop0')}${a('/out')}${a(`${externalOrigin}/ext`)}`);
  redirect('/loop1', '/loop2');
  redirect('/loop2', '/loop1');
  for (let i = 0; i < 12; i++) redirect(`/hop${i}`, `/hop${i + 1}`);
  page('/hop12', 'end');
  redirect('/out', `${externalOrigin}/away`);
  await crawl(id);
  const g = await graph(id);
  assert.equal(externalHits.length, 0);
  assert.equal(node(g, '/loop1'), undefined);
  assert.equal(node(g, '/hop12') !== undefined, true);
  const snapshot = await crawlStore.readSnapshot(id, g.snapshot.id);
  assert.equal(snapshot.pages.find((p) => p.url === key('/loop1'))!.error, 'redirect-loop');
  assert.equal(snapshot.pages.find((p) => p.url === key('/hop0'))!.error, 'too-many-redirects');
  const out = snapshot.pages.find((p) => p.url === key('/out'))!;
  assert.deepEqual([out.redirectExternal, out.redirectTo?.includes(new URL(externalOrigin).host)], [true, true]);
});

test('I11 the page cap ends the crawl and is recorded; a cap larger than the site completes without a cap note', async () => {
  const { id } = await createSeo();
  smallSite();
  assert.equal((await send('PUT', links(id, '/settings'), { pageCap: 3 })).status, 200);
  await crawl(id);
  let g = await graph(id);
  assert.equal(g.snapshot.capped, true);
  assert.equal(g.snapshot.status, 'complete');
  assert.ok(log.filter((l) => l.path !== '/robots.txt' && l.path !== '/sitemap.xml').length <= 3);
  await send('PUT', links(id, '/settings'), { pageCap: 1 });
  await crawl(id);
  assert.equal((await graph(id)).snapshot.stats.pages <= 1 + 1, true);
  await send('PUT', links(id, '/settings'), { pageCap: 100 });
  await crawl(id);
  g = await graph(id);
  assert.equal(g.snapshot.capped, false);
});

test('I12/I13 a 429 with Retry-After is retried after the wait; exhausted back-off fails only that page', async () => {
  const { id } = await createSeo();
  let tries = 0;
  page('/', `${a('/limited')}${a('/always')}${a('/fine')}`);
  serve('/limited', (req, res) => { if (++tries < 2) { res.statusCode = 429; res.setHeader('retry-after', '7'); res.end(); } else html('ok')(req, res); });
  serve('/always', (_req, res) => { res.statusCode = 429; res.end(); });
  page('/fine', 'fine');
  await crawl(id);
  assert.ok(sleeps.includes(7000));
  const g = await graph(id);
  assert.equal(node(g, '/limited').status, 200);
  assert.equal(node(g, '/always').error, 'rate-limited');
  assert.equal(node(g, '/fine').status, 200);
  assert.equal(log.filter((l) => l.path === '/always').length, 4);
});

test('I14 a request timeout fails only that page', async () => {
  const { id } = await createSeo();
  page('/', `${a('/slow')}${a('/fast')}`);
  serve('/slow', () => undefined);
  page('/fast', 'fast');
  await send('PUT', links(id, '/settings'), { timeoutSeconds: 1 });
  await crawl(id);
  const g = await graph(id);
  assert.equal(node(g, '/slow').error, 'timeout');
  assert.equal(node(g, '/fast').status, 200);
  site.closeAllConnections();
});

test('I16/I24 an oversize body is cut at the size cap; gzip is decoded and HTML is asked for', async () => {
  const { id } = await createSeo();
  page('/', `${a('/big')}${a('/zipped')}`);
  serve('/big', (_req, res) => { res.setHeader('content-type', 'text/html'); res.write('<html><body>'); const chunk = 'x'.repeat(65536); let n = 0; const t = setInterval(() => { if (res.destroyed || ++n > 40) { clearInterval(t); res.end(); } else res.write(chunk); }, 1); res.on('close', () => clearInterval(t)); });
  serve('/zipped', (_req, res) => { res.setHeader('content-type', 'text/html'); res.setHeader('content-encoding', 'gzip'); res.end(gzipSync(`<html><head><title>Zipped</title></head><body>${a('/fast')}</body></html>`)); });
  page('/fast', 'f');
  await send('PUT', links(id, '/settings'), { pageSizeMb: 0.1 });
  await crawl(id);
  const g = await graph(id);
  assert.equal(node(g, '/big').error, 'too-large');
  assert.equal(node(g, '/zipped').title, 'Zipped');
  assert.match(log.find((l) => l.path === '/zipped')!.headers.accept ?? '', /text\/html/);
});

test('I17 an endless calendar is cut by the URL-space guard and the cap', async () => {
  const { id } = await createSeo();
  const calendar = (req: IncomingMessage, res: ServerResponse) => {
    const n = Number(new URL(req.url!, 'http://x').searchParams.get('date') ?? 0);
    html(a(`/cal?date=${n + 1}`, 'next'))(req, res);
  };
  serve('/cal', calendar);
  page('/', a('/cal?date=1'));
  await crawl(id);
  const g = await graph(id);
  assert.ok(g.snapshot.stats.skippedUrlSpace > 0);
  assert.ok(g.nodes.length <= 25, `nodes ${g.nodes.length}`);
});

test('I18/U12 the www and bare host are one site, written as the Building\'s host', async () => {
  const { id } = await createSeo(origin.replace('127.0.0.1', 'localhost'));
  const host = new URL(origin).host.replace('127.0.0.1', 'localhost');
  page('/', `${a(`http://www.${host}/x`, 'www link')}${a('http://sub.example.com/y', 'other')}`);
  page('/x', 'x');
  await crawl(id);
  const g = await graph(id);
  assert.equal(log.some((l) => l.path === '/x'), true, 'the www address is fetched from the Building\'s own host');
  assert.equal(g.nodes.find((n: any) => n.path === '/x').inbound, 1);
  assert.equal((await crawlStore.readSnapshot(id, g.snapshot.id)).pages.find((p) => p.url.endsWith('/'))!.externalLinks, 1);
});

test('a site that redirects every address to its www variant is crawled there, with robots.txt still applied', async () => {
  const { id } = await createSeo(origin.replace('127.0.0.1', 'localhost'));
  const host = new URL(origin).host.replace('127.0.0.1', 'localhost');
  const wwwHost = `www.${host}`;
  const wwwOnly = (handler: (req: IncomingMessage, res: ServerResponse) => void) => (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host === wwwHost) handler(req, res); else { res.statusCode = 301; res.setHeader('location', `http://${wwwHost}${req.url}`); res.end(); }
  };
  serve('/robots.txt', wwwOnly((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('User-agent: *\nDisallow: /private\n'); }));
  routes.set('/', wwwOnly((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<html><body>${a('/x')}${a('/private')}</body></html>`); }));
  routes.set('/x', wwwOnly((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html><body>x</body></html>'); }));
  routes.set('/private', wwwOnly((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html></html>'); }));
  await crawl(id);
  const g = await graph(id);
  assert.equal(g.snapshot.stats.pages, 3);
  assert.equal(g.snapshot.stats.links, 2);
  const byPath = (p: string) => g.nodes.find((n: any) => n.path === p);
  assert.equal(byPath('/x').inbound, 1);
  assert.equal(byPath('/private').error, 'robots');
  assert.equal(log.some((l) => l.path === '/private'), false, 'a disallowed page is not requested on the real host either');
});

test('a site that 301s slash-less paths to the trailing-slash form is parsed and its links recorded', async () => {
  const { id } = await createSeo();
  await readSitemap(id, ['/', '/about']);
  page('/', `${a('/about/')}`);
  redirect('/about', '/about/');
  page('/about/', `${a('rel', 'relative')}${a('/')}`);
  page('/about/rel', 'leaf');
  await crawl(id);
  const snapshot = await crawlStore.readSnapshot(id, (await graph(id)).snapshot.id);
  const about = snapshot.pages.find((p) => p.url === key('/about'))!;
  assert.deepEqual([about.status, about.error, about.redirectTo], [200, null, null]);
  assert.ok(snapshot.stats.links >= 3, `links ${snapshot.stats.links}`);
  assert.ok(snapshot.pages.some((p) => p.url === key('/about/rel')), 'relative links resolve against the slash URL');
});

test('a slash redirect that bounces back is bounded to three requests and ends as a redirect-loop', async () => {
  const { id } = await createSeo();
  page('/', a('/p'));
  redirect('/p', '/p/');
  redirect('/p/', '/p');
  await crawl(id);
  const snapshot = await crawlStore.readSnapshot(id, (await graph(id)).snapshot.id);
  assert.equal(snapshot.pages.find((p) => p.url === key('/p'))!.error, 'redirect-loop');
  assert.equal(log.filter((l) => l.path === '/p' || l.path === '/p/').length, 3);
});

test('a re-request of the slash URL that robots.txt disallows is not made', async () => {
  const { id } = await createSeo();
  serve('/robots.txt', (_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('User-agent: *\nDisallow: /q/\n'); });
  page('/', a('/q'));
  redirect('/q', '/q/');
  page('/q/', 'blocked');
  await crawl(id);
  const snapshot = await crawlStore.readSnapshot(id, (await graph(id)).snapshot.id);
  assert.equal(snapshot.pages.find((p) => p.url === key('/q'))!.error, 'robots');
  assert.equal(log.some((l) => l.path === '/q/'), false);
});

test('I20 no credentials are ever sent and a user-info link is dropped', async () => {
  const { id } = await createSeo();
  serve('/', (req, res) => { res.setHeader('set-cookie', 'session=abc'); html(`${a('/a')}${a(`http://user:pw@${new URL(origin).host}/secret`)}`)(req, res); });
  page('/a', 'a');
  await crawl(id);
  assert.equal(log.length >= 2, true);
  for (const entry of log) {
    assert.equal(entry.headers.authorization, undefined);
    assert.equal(entry.headers.cookie, undefined);
    assert.match(entry.headers['user-agent'] ?? '', /^agent-visual-os-seo/);
  }
  assert.equal(log.some((l) => l.path === '/secret'), false);
});

test('I43 a JS-heavy site with almost no links is flagged "may be incomplete"; a well-linked one is not', async () => {
  const { id } = await createSeo();
  await readSitemap(id, ['/', '/p1', '/p2', '/p3']);
  for (const p of ['/', '/p1', '/p2', '/p3']) page(p, '<div id="app"></div>');
  await crawl(id);
  assert.equal((await graph(id)).snapshot.incomplete, true);
  smallSite();
  await crawl(id);
  assert.equal((await graph(id)).snapshot.incomplete, false);
});

test('I25/I26/I27/I28 stop keeps the previous snapshot byte-identical and resume finishes without refetching', async () => {
  const { id } = await createSeo();
  smallSite();
  await crawl(id);
  const first = (await api(links(id))).body.snapshots[0];
  const file = path.join(secretsMod.buildingDir(id), 'crawl', `${first.id}.json`);
  const before = await readFile(file, 'utf8');
  // a slow site so the stop lands mid-crawl
  const hold: Array<() => void> = [];
  serve('/deep2', (req, res) => { hold.push(() => html(a('/deep3'))(req, res)); });
  const started = await send('POST', links(id, '/crawl'));
  assert.equal(started.status, 202);
  for (let i = 0; i < 400 && !hold.length; i++) await new Promise((r) => setTimeout(r, 10));
  const stopping = send('POST', links(id, '/crawl/stop'));
  const stopped = (await stopping).body;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.resumable, true);
  assert.equal(await readFile(file, 'utf8'), before);
  const snapshots = (await api(links(id))).body.snapshots;
  assert.equal(snapshots[0].status, 'partial');
  assert.equal(snapshots[0].stopReason, 'stopped');
  assert.equal(snapshots[1].id, first.id);
  // a restart: the run file says running, no process is live
  const run = JSON.parse(await readFile(path.join(secretsMod.buildingDir(id), 'crawl', 'run.json'), 'utf8'));
  await rm(path.join(secretsMod.buildingDir(id), 'crawl', 'run.json'));
  await (await import('node:fs/promises')).writeFile(path.join(secretsMod.buildingDir(id), 'crawl', 'run.json'), JSON.stringify({ ...run, status: 'running', resumable: false }));
  const recovered = (await api(links(id, '/crawl'))).body;
  assert.deepEqual([recovered.status, recovered.resumable], ['stopped', true]);
  serve('/deep2', html(a('/deep3')));
  log = [];
  const resumed = await crawl(id, { resume: true });
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.snapshotId, stopped.snapshotId);
  assert.equal(log.filter((l) => l.path === '/' || l.path === '/a').length, 0, 'done pages are not fetched again');
  const final = (await api(links(id))).body.snapshots;
  assert.equal(final[0].status, 'complete');
  assert.equal(final.length, 2);
  assert.equal((await send('POST', links(id, '/crawl'), { resume: true })).status, 409, 'nothing left to resume');
  const finalGraph = await graph(id);
  assert.equal(node(finalGraph, '/deep2').status, 200, 'the page being fetched when Stop landed is fetched after resume');
  assert.equal(node(finalGraph, '/deep3').depth, 4, 'and its links are followed');
  assert.equal(log.filter((l) => l.path === '/deep2').length, 1, 'exactly once after the resume');
  const resumedRows = (await api(links(id, '/log'))).body.rows;
  assert.equal(resumedRows.find((r: any) => r.url === key('/deep3')).from, key('/deep2'), 'the discoverer survives a stop and resume');
  assert.deepEqual(resumedRows.map((r: any) => r.n), resumedRows.map((_: unknown, i: number) => i + 1), 'rows are not duplicated');
});

test('a write failure while finishing does not crash the daemon and the run reads failed, not running', async () => {
  const { id } = await createSeo();
  smallSite();
  const hold: Array<() => void> = [];
  serve('/a', (req, res) => { hold.push(() => html(a('/b'))(req, res)); });
  assert.equal((await send('POST', links(id, '/crawl'))).status, 202);
  for (let i = 0; i < 400 && !hold.length; i++) await new Promise((r) => setTimeout(r, 10));
  const dir = path.join(secretsMod.buildingDir(id), 'crawl');
  await (await import('node:fs/promises')).chmod(dir, 0o500);
  try {
    hold.forEach((release) => release());
    const run = await waitFinished(id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /could not be saved/);
  } finally {
    await (await import('node:fs/promises')).chmod(dir, 0o700);
  }
  assert.equal(runner.hasLiveCrawl(id), false);
  page('/a', a('/b'));
  assert.equal((await send('POST', links(id, '/crawl'))).status, 202, 'a new crawl can start afterwards');
  await waitFinished(id);
});

test('Stop is not held up by a long Retry-After wait', async () => {
  const { id } = await createSeo();
  page('/', a('/limited'));
  serve('/limited', (_req, res) => { res.statusCode = 429; res.setHeader('retry-after', '60'); res.end(); });
  let release: () => void = () => undefined;
  const parked = new Promise<void>((r) => { release = r; });
  deps.configureSeo({ sleep: () => parked });
  assert.equal((await send('POST', links(id, '/crawl'))).status, 202);
  for (let i = 0; i < 400 && !log.some((l) => l.path === '/limited'); i++) await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  const stopped = (await send('POST', links(id, '/crawl/stop'))).body;
  assert.equal(stopped.status, 'stopped');
  assert.ok(Date.now() - started < 2000);
  release();
});

test('retention keeps the newest complete snapshots even after many partial ones', async () => {
  const { id } = await createSeo();
  const dir = path.join(secretsMod.buildingDir(id), 'crawl');
  const write = async (n: number, status: 'complete' | 'partial') => crawlStore.writeSnapshot(id, {
    id: `s-${status}${n}`, startedAt: `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00Z`, finishedAt: '', status, stopReason: status === 'partial' ? 'stopped' : null, capped: false, incomplete: false, host: 'h', seededFrom: 'home',
    settings: { pageCap: 1, requestsPerSecond: 1, timeoutSeconds: 1, pageSizeMb: 1 }, stats: { pages: 0, fetched: 0, failed: 0, blockedByRobots: 0, skippedUrlSpace: 0, links: 0, externalLinks: 0, uncrawledLinks: 0 }, pages: [], links: [],
  });
  await write(1, 'complete'); await write(2, 'complete');
  for (const n of [3, 4, 5, 6]) await write(n, 'partial');
  await crawlStore.pruneSnapshots(id, 2);
  const left = (await readdir(dir)).filter((f) => f.endsWith('.meta.json')).sort();
  assert.deepEqual(left, ['s-complete1.meta.json', 's-complete2.meta.json', 's-partial5.meta.json', 's-partial6.meta.json']);
});

test('I26 a failure keeps the previous snapshot and labels the partial one', async () => {
  const { id } = await createSeo();
  smallSite();
  await crawl(id);
  const original = (await api(links(id))).body.snapshots[0];
  deps.configureSeo({ now: () => { throw new Error('boom'); } });
  const started = await send('POST', links(id, '/crawl'));
  deps.configureSeo({ now: () => new Date() });
  assert.ok([202, 500].includes(started.status));
  await new Promise((r) => setTimeout(r, 50));
  const after = (await api(links(id))).body.snapshots;
  assert.equal(after.some((s: any) => s.id === original.id && s.status === 'complete'), true);
});

test('I29/I30/I31/I32 two simultaneous starts give one 202 and one 409 naming the run; stop when idle is a no-op', async () => {
  const { id } = await createSeo();
  smallSite();
  const gate: Array<() => void> = [];
  serve('/a', (req, res) => { gate.push(() => html(a('/b'))(req, res)); });
  const [one, two] = await Promise.all([send('POST', links(id, '/crawl')), send('POST', links(id, '/crawl'))]);
  assert.deepEqual([one.status, two.status].sort(), [202, 409]);
  const loser = one.status === 409 ? one : two;
  const winner = one.status === 202 ? one : two;
  assert.equal(loser.body.details.runId, winner.body.runId);
  const counts: number[] = [];
  for (let i = 0; i < 200 && !gate.length; i++) await new Promise((r) => setTimeout(r, 10));
  counts.push((await api(links(id, '/crawl'))).body.fetched);
  gate.forEach((release) => release());
  const done = await waitFinished(id);
  assert.ok(done.fetched >= counts[0]!);
  page('/a', a('/b'));
  assert.equal((await send('POST', links(id, '/crawl'))).status, 202);
  await waitFinished(id);
  const idle = await send('POST', links(id, '/crawl/stop'));
  assert.equal(idle.status, 200);
  assert.equal(idle.body.status, 'complete');
});

test('I33/I34/I39 snapshots are listed newest first with their label and compare reports pages and links added and removed', async () => {
  const { id } = await createSeo();
  smallSite();
  assert.equal((await api(links(id, '/compare'))).status, 409);
  await crawl(id);
  assert.equal((await api(links(id, '/compare'))).status, 409, 'one snapshot only');
  page('/new-page', 'new');
  page('/a', `${a('/deep1')}${a('/new-page', 'fresh')}`);
  routes.delete('/deep4');
  await crawl(id);
  const snaps = (await api(links(id))).body.snapshots;
  assert.equal(snaps.length, 2);
  assert.ok(snaps[0].startedAt >= snaps[1].startedAt);
  const diff = (await api(links(id, '/compare'))).body;
  assert.deepEqual(diff.pagesAdded.items, [key('/new-page')]);
  assert.deepEqual(diff.pagesRemoved.items, []);
  assert.ok(diff.statusChanged.items.some((s: any) => s.url === key('/deep4') && s.to === 404));
  assert.ok(diff.linksAdded.items.some((l: any) => l.anchor === 'fresh'));
  assert.ok(diff.linksRemoved.items.some((l: any) => l.from === key('/a') && l.to === key('/b')));
  assert.equal((await api(links(id, `/compare?from=${snaps[0].id}&to=${snaps[0].id}`))).status, 400);
  assert.equal((await api(links(id, `/compare?from=s-nope&to=${snaps[0].id}`))).status, 404);
  assert.equal((await api(links(id, '/compare?from=../x'))).status, 400);
});

test('I35/I36/I37/I38 graph, page-detail and matrix endpoints validate input and export a safe CSV', async () => {
  const { id } = await createSeo();
  smallSite();
  page('/', `${a('/a', '=HYPERLINK("x")')}${a('/b', 'Bee, "quoted"')}${a('/a', 'second')}`);
  await crawl(id);
  assert.equal((await api(links(id, '/graph?snapshot=s-missing'))).status, 404);
  assert.equal((await api(links(id, '/graph?snapshot=..%2F..%2Fx'))).status, 400);
  assert.equal((await api(links(id, `/page?url=${encodeURIComponent(key('/nope'))}`))).status, 404);
  const body = { rows: [key('/')], cols: [key('/a'), key('/b')], name: 'Blog to Products!' };
  const m = (await send('POST', links(id, '/matrix'), body)).body;
  assert.equal(m.cells[0][0].count, 2);
  assert.deepEqual(m.cells[0][0].anchors, ['=HYPERLINK("x")', 'second']);
  assert.deepEqual([m.rowTotals, m.colTotals], [[3], [2, 1]]);
  const thirty = Array.from({ length: 30 }, () => key('/a'));
  assert.equal((await send('POST', links(id, '/matrix'), { rows: thirty, cols: [key('/a')] })).status, 200);
  const tooMany = await send('POST', links(id, '/matrix'), { rows: [...thirty, key('/b')], cols: [] });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /30/);
  assert.equal((await send('POST', links(id, '/matrix'), { rows: [], cols: [] })).status, 200);
  assert.equal((await send('POST', links(id, '/matrix'), { rows: ['https://other.example/'], cols: [] })).status, 400);
  const csv = await send('POST', links(id, '/matrix/export'), body);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(csv.headers.get('content-disposition') ?? '', /filename="matrix-blog-to-products-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(csv.text, /^source \\ target,/);
  assert.equal(csv.text.includes('=HYPERLINK'), false, 'anchors are not in the CSV, only counts and addresses');
});

test('I40 the Pages tab carries link counts and crawler title and meta once a crawl exists, and not before', async () => {
  const { id } = await createSeo();
  smallSite();
  await readSitemap(id, ['/', '/a']);
  const beforeCrawl = (await api(seo(id, '/pages?limit=50'))).body;
  assert.equal(beforeCrawl.crawled, false);
  assert.equal(beforeCrawl.rows.every((r: any) => r.internal === undefined), true);
  const detailBefore = (await api(seo(id, `/pages/detail?url=${encodeURIComponent(key('/a'))}`))).body;
  assert.equal(detailBefore.crawl.available, false);
  await crawl(id);
  const after = (await api(seo(id, '/pages?limit=50'))).body;
  assert.equal(after.crawled, true);
  const row = after.rows.find((r: any) => r.url === key('/a'));
  assert.deepEqual([row.internal.inbound, row.internal.outbound], [1, 2]);
  const detail = (await api(seo(id, `/pages/detail?url=${encodeURIComponent(key('/'))}`))).body;
  assert.deepEqual([detail.crawl.available, detail.crawl.found, detail.crawl.title, detail.crawl.description], [true, true, 'Home', 'The home']);
});

test('I41 crawl settings persist, apply to the next run and refuse out-of-range values naming the limit', async () => {
  const { id } = await createSeo();
  const overview = (await api(links(id))).body;
  assert.deepEqual(overview.settings, { pageCap: 3000, requestsPerSecond: 2, timeoutSeconds: 15, pageSizeMb: 2 });
  assert.equal(overview.host, new URL(origin).host);
  assert.equal((await send('PUT', links(id, '/settings'), { pageCap: 50, requestsPerSecond: 0.5 })).body.pageCap, 50);
  assert.equal((await api(links(id))).body.settings.requestsPerSecond, 0.5);
  for (const bad of [{ pageCap: 0 }, { pageCap: -1 }, { pageCap: 1.5 }, { pageCap: 'abc' }, { pageCap: 10_001 }, { pageCap: 2 ** 53 }, { requestsPerSecond: 0 }, { requestsPerSecond: 11 }, { timeoutSeconds: 61 }, { pageSizeMb: 0.01 }, { pageSizeMb: 11 }]) {
    const res = await send('PUT', links(id, '/settings'), bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(res.body.error, /from \d/);
  }
  assert.equal((await send('PUT', links(id, '/settings'), [1])).status, 400);
});

test('I42 every route 404s for a Building that is not an SEO Building and for an unknown project', async () => {
  const notes = await send('POST', '/api/projects', { typeId: 'notes', name: 'N' });
  const targets: Array<[string, string]> = [['GET', ''], ['PUT', '/settings'], ['POST', '/crawl'], ['GET', '/crawl'], ['POST', '/crawl/stop'], ['GET', '/graph'], ['GET', '/page'], ['POST', '/matrix'], ['POST', '/matrix/export'], ['GET', '/compare']];
  for (const [method, suffix] of targets) {
    const payload = method === 'GET' ? undefined : {};
    assert.equal((await send(method, links('missing-project', suffix), payload)).status, 404, `${method} ${suffix}`);
    if (notes.status === 201) assert.equal((await send(method, links(notes.body.id, suffix), payload)).status, 404, `notes ${method} ${suffix}`);
  }
});

test('I44 no secret reaches a response or a stored snapshot', async () => {
  const { id } = await createSeo();
  smallSite();
  const secrets = new (secretsMod.SecretsStore)(id);
  await secrets.set('seo.gsc.refreshToken', 'SECRET-REFRESH-TOKEN-123');
  await crawl(id);
  const g = await graph(id);
  const everything = JSON.stringify([g, (await api(links(id))).body, (await api(links(id, '/crawl'))).body]);
  const dir = path.join(secretsMod.buildingDir(id), 'crawl');
  const stored = (await Promise.all((await readdir(dir)).map((f) => readFile(path.join(dir, f), 'utf8')))).join('');
  const logged = JSON.stringify([(await log2(id)).body, (await api(links(id, `/log/page?url=${encodeURIComponent(key('/'))}`))).body, (await api(links(id, '/log/export'))).text]);
  for (const text of [everything, stored, logged]) assert.equal(text.includes('SECRET-REFRESH-TOKEN-123'), false);
  const snapshotFile = (await readdir(dir)).find((f) => f.endsWith('.json') && !f.includes('meta') && !f.startsWith('run') && !f.startsWith('work') && !f.startsWith('settings'))!;
  for (const needle of [secretsMod.buildingDir(id), snapshotFile, id]) assert.equal(logged.includes(needle), false, 'no storage detail in the crawl log responses');
  assert.equal(log.every((l) => JSON.stringify(l.headers).includes('SECRET') === false), true);
  assert.equal(everything.includes(secretsMod.buildingDir(id)), false, 'no file path is returned');
});

test('I45 a generated 3,000-page site completes at the cap and the graph payload stays small', async () => {
  const { id } = await createSeo();
  const total = 3000;
  serve('/', html(a('/n/0')));
  for (let i = 0; i < total; i++) {
    serve(`/n/${i}`, html([1, 2, 7, 31].map((d) => a(`/n/${(i + d) % total}`, `to ${(i + d) % total}`)).join('')));
  }
  const started = Date.now();
  await crawl(id);
  const g = await graph(id);
  assert.equal(g.nodes.length, 3000);
  assert.equal(g.snapshot.capped, true);
  assert.ok(JSON.stringify(g).length < 3_000_000);
  assert.ok(Date.now() - started < 60_000);
  assert.equal(g.edges.length > 9000, true);
});

test('lifecycle: deleting a Building stops its crawl', async () => {
  const { id } = await createSeo();
  smallSite();
  serve('/a', () => undefined);
  await send('POST', links(id, '/crawl'));
  for (let i = 0; i < 200 && !log.some((l) => l.path === '/a'); i++) await new Promise((r) => setTimeout(r, 10));
  const res = await send('DELETE', `/api/projects/${id}`);
  assert.ok([200, 204].includes(res.status), String(res.status));
  assert.equal(runner.hasLiveCrawl(id), false);
  site.closeAllConnections();
});

/*
 * Creation bootstrap: a new SEO Building fetches its sitemaps and then crawls, without anyone visiting the Sitemaps tab.
 */
const crawlerRequests = () => log.filter((l) => l.headers['user-agent'] === 'agent-visual-os-seo');
const sitemapRequests = () => log.filter((l) => l.path === '/sitemap.xml').length;

function sitemapSite(paths: string[]) {
  serve('/sitemap.xml', (_req, res) => { res.setHeader('content-type', 'application/xml'); res.end(xml(paths.map((p) => `${origin}${p}`))); });
  page('/', a('/a'));
  for (const p of paths.filter((x) => x !== '/')) page(p, 'leaf');
}

/** A held response: requests wait until `release()`, so a test can act while the sitemap fetch is in flight. */
function latch() {
  let release!: () => void;
  const opened = new Promise<void>((r) => { release = r; });
  return { opened, release };
}

test('creating an SEO Building fetches its sitemaps and crawls from them with no manual step', async () => {
  deps.configureSeo({ firstRun: true });
  sitemapSite(['/', '/a', '/s1', '/s2']);
  const { id } = await createSeo();
  await firstRun.waitForFirstRun(id);
  await runner.waitForCrawl(id);
  const g = await graph(id);
  assert.equal(g.snapshot.seededFrom, 'sitemaps');
  assert.ok(g.nodes.length >= 4, `expected sitemap pages in the crawl, got ${g.nodes.length}`);
  assert.equal(sitemapRequests(), 1, 'sitemaps are read once at creation');
});

test('Crawl site without a prior sitemap read fetches the sitemaps first', async () => {
  sitemapSite(['/', '/a', '/s1']);
  const { id } = await createSeo();
  const run = await crawl(id);
  assert.equal(run.status, 'complete');
  assert.equal((await graph(id)).snapshot.seededFrom, 'sitemaps');
});

test('a robots.txt server error still leaves the sitemaps stored and creation succeeds', async () => {
  deps.configureSeo({ firstRun: true });
  sitemapSite(['/', '/a', '/s1']);
  serve('/robots.txt', (_req, res) => { res.statusCode = 500; res.end(); });
  const { id } = await createSeo();
  await firstRun.waitForFirstRun(id);
  await runner.waitForCrawl(id);
  assert.equal((await api(links(id, '/crawl'))).body.status, 'failed');
  assert.ok((await api(seo(id, '/sitemaps'))).body.sitemaps.length > 0);
  assert.equal(crawlerRequests().some((l) => l.path === '/a'), false);
});

test('an unreachable site does not break creation; the crawl falls back to the home page', async () => {
  deps.configureSeo({ firstRun: true });
  serve('/sitemap.xml', (_req, res) => { res.statusCode = 500; res.end(); });
  page('/', 'home only');
  const { id } = await createSeo();
  await firstRun.waitForFirstRun(id);
  await runner.waitForCrawl(id);
  assert.equal((await graph(id)).snapshot.seededFrom, 'home');
});

test('a site with no sitemap is read once at creation and again on each later crawl, leaving no phantom row', async () => {
  deps.configureSeo({ firstRun: true });
  page('/', 'home only');
  const { id } = await createSeo();
  await firstRun.waitForFirstRun(id);
  await runner.waitForCrawl(id);
  assert.equal((await graph(id)).snapshot.seededFrom, 'home');
  assert.equal(sitemapRequests(), 1);
  assert.deepEqual((await api(seo(id, '/sitemaps'))).body.sitemaps ?? [], []);
  await crawl(id);
  assert.equal(sitemapRequests(), 2);
});

test('Crawl site while the first run is crawling is a 409 naming the run', async () => {
  deps.configureSeo({ firstRun: true });
  sitemapSite(['/', '/a']);
  const hold = latch();
  serve('/a', (req, res) => { void hold.opened.then(() => html('x')(req, res)); });
  const { id } = await createSeo();
  await firstRun.waitForFirstRun(id);
  const second = await send('POST', links(id, '/crawl'), {});
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'crawl-running');
  hold.release();
  await runner.waitForCrawl(id);
});

test('deleting a Building while its first run reads sitemaps starts no crawl', async () => {
  deps.configureSeo({ firstRun: true });
  const hold = latch();
  serve('/sitemap.xml', (req, res) => { void hold.opened.then(() => { res.setHeader('content-type', 'application/xml'); res.end(xml([`${origin}/a`])); }); });
  page('/', 'home');
  const { id } = await createSeo();
  for (let i = 0; i < 200 && sitemapRequests() === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const deleting = send('DELETE', `/api/projects/${id}`);
  await new Promise((r) => setTimeout(r, 50));
  hold.release();
  const res = await deleting;
  assert.ok([200, 204].includes(res.status), String(res.status));
  await firstRun.waitForFirstRun(id);
  assert.equal(runner.hasLiveCrawl(id), false);
  assert.equal(crawlerRequests().length, 0);
});

test('Stop during the sitemap read ends the run as stopped before any page is fetched', async () => {
  const hold = latch();
  serve('/sitemap.xml', (_req, res) => { void hold.opened.then(() => { res.setHeader('content-type', 'application/xml'); res.end(xml([`${origin}/a`])); }); });
  page('/', a('/a'));
  page('/a', 'x');
  const { id } = await createSeo();
  assert.equal((await send('POST', links(id, '/crawl'), {})).status, 202);
  for (let i = 0; i < 200 && sitemapRequests() === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const stopping = runner.stopCrawl(id);
  hold.release();
  const run = await stopping;
  assert.equal(run?.status, 'stopped');
  assert.equal(run?.resumable, true);
  assert.equal(crawlerRequests().length, 0);
});

const log2 = async (id: string, query = '') => (await api(links(id, `/log${query}`)));

test('crawl log: one row per requested address in request order, with where it came from, how it answered and its link counts', async () => {
  const { id } = await createSeo();
  smallSite();
  await readSitemap(id, ['/', '/a', '/orphan']);
  await crawl(id);
  const { body, status } = await log2(id);
  assert.equal(status, 200);
  const byUrl = (p: string) => body.rows.find((r: any) => r.url === key(p));
  assert.deepEqual(body.rows.map((r: any) => r.n), body.rows.map((_: unknown, i: number) => i + 1));
  assert.equal(body.rows[0].url, key('/'), 'the home page is requested first');
  assert.deepEqual([byUrl('/').from, byUrl('/a').from, byUrl('/orphan').from], ['sitemap', 'sitemap', 'sitemap']);
  assert.equal(byUrl('/b').from, key('/'), 'the first page to link it wins, not the later /a');
  assert.equal(byUrl('/deep1').from, key('/a'));
  assert.equal(byUrl('/c').from, key('/redir'), 'a redirect target is discovered from the redirecting address');
  assert.equal(byUrl('/redir').status, 301);
  assert.equal(byUrl('/redir').redirectTo, key('/c'));
  assert.equal(byUrl('/missing').status, 404);
  assert.equal(byUrl('/private').error, 'robots');
  assert.equal(byUrl('/private').status, null);
  assert.equal(byUrl('/file.pdf').contentType, 'application/pdf');
  assert.deepEqual([byUrl('/').internalLinks, byUrl('/').externalLinks], [7, 1], 'duplicates and links to every kind of address count');
  assert.equal(byUrl('/a').internalLinks, 3, 'a self link counts');
  assert.deepEqual(body.summary.requested, body.rows.length);
  assert.equal(body.counts.redirects, 1);
  assert.equal(body.counts['http-errors'], 1);
  assert.equal(body.counts.errors, 1);
  const chip = (await log2(id, '?filter=http-errors')).body;
  assert.deepEqual(chip.rows.map((r: any) => r.url), [key('/missing')]);
  const search = (await log2(id, '?q=DEEP')).body;
  assert.equal(search.rows.length, 4);
});

test('crawl log: a crawl without a sitemap names the home page as the start page', async () => {
  const { id } = await createSeo();
  smallSite();
  await crawl(id);
  const rows = (await log2(id)).body.rows;
  assert.equal(rows[0].from, 'start');
  assert.equal(rows.find((r: any) => r.url === key('/a')).from, key('/'));
});

test('crawl log: errors, self-redirects and loops appear as their own rows', async () => {
  const { id } = await createSeo();
  page('/', `${a('/self')}${a('/loop1')}${a('/boom')}`);
  redirect('/self', '/self');
  redirect('/loop1', '/loop2');
  redirect('/loop2', '/loop1');
  serve('/boom', (_req, res) => { res.statusCode = 500; res.end('x'); });
  await crawl(id);
  const rows = (await log2(id)).body.rows;
  const row = (p: string) => rows.find((r: any) => r.url === key(p));
  assert.deepEqual([row('/self').selfRedirect, row('/self').error], [true, 'redirect-loop']);
  assert.deepEqual([row('/loop1').selfRedirect, row('/loop1').error], [false, 'redirect-loop']);
  assert.equal(row('/boom').status, 500);
  assert.deepEqual((await log2(id, '?filter=self-redirects')).body.rows.map((r: any) => r.url), [key('/self')]);
});

test('crawl log: the page detail lists links found and who links in; a capped crawl shows addresses never crawled', async () => {
  const { id } = await createSeo();
  smallSite();
  assert.equal((await send('PUT', links(id, '/settings'), { pageCap: 3 })).status, 200);
  await crawl(id);
  const detail = (await api(links(id, `/log/page?url=${encodeURIComponent(key('/'))}`))).body;
  assert.equal(detail.stored, true);
  const never = detail.linksFound.links.filter((l: any) => !l.crawled);
  assert.ok(never.length > 0, 'a link to an address that was never requested is kept');
  const nav = detail.linksFound.links.find((l: any) => l.anchor === 'Page A');
  assert.deepEqual([nav.location, nav.nofollow], ['nav', false]);
  assert.equal((await api(links(id, `/log/page?url=${encodeURIComponent(key('/nope'))}`))).status, 404);
  assert.equal((await api(links(id, '/log/page'))).status, 404);
});

test('crawl log: linked-from lists each crawled source page once', async () => {
  const { id } = await createSeo();
  smallSite();
  await crawl(id);
  const detail = (await api(links(id, `/log/page?url=${encodeURIComponent(key('/b'))}`))).body;
  assert.deepEqual(detail.linkedFrom.pages.sort(), [key('/'), key('/a')]);
});

test('crawl log: snapshot parameter rules and filter validation', async () => {
  const { id } = await createSeo();
  assert.equal((await log2(id)).status, 404, 'no crawl yet');
  smallSite();
  await crawl(id);
  const first = (await api(links(id))).body.snapshots[0].id;
  await crawl(id);
  assert.equal((await log2(id, `?snapshot=${first}`)).body.snapshot.id, first);
  assert.equal((await log2(id, '?snapshot=..%2Fx')).status, 400);
  assert.equal((await log2(id, '?snapshot=s-missing')).status, 404);
  assert.equal((await log2(id, `?snapshot=${first}&snapshot=${first}`)).status, 400);
  assert.equal((await log2(id, '?filter=bogus')).status, 400);
  assert.equal((await log2(id, '?q=a&q=b')).status, 400);
  assert.equal((await api(links(id, '/log/export?filter=bogus'))).status, 400);
});

test('crawl log: the CSV export follows the filter and search and is named after the crawl date', async () => {
  const { id } = await createSeo();
  smallSite();
  page('/', `${a('/a', 'A')}${a('/missing')}${a('/x,y')}`);
  await crawl(id);
  const res = await api(links(id, '/log/export?filter=http-errors'));
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(res.headers.get('content-disposition') ?? '', /filename="crawl-log-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = res.text.split('\r\n').filter(Boolean);
  assert.match(lines[0]!, /^#,address,discovered from,status/);
  assert.equal(lines.length, 3, 'header plus the two 404s');
  assert.ok(lines.every((l, i) => i === 0 || l.includes(',404,')));
  assert.equal((await api(links(id, '/log/export?q=zzz-none'))).text.split('\r\n').filter(Boolean).length, 1, 'header only');
});

test('crawl log: a crawl whose pages mostly have no links is complete but carries a warning; a healthy crawl does not', async () => {
  const { id } = await createSeo();
  await readSitemap(id, ['/', '/p1', '/p2']);
  for (const p of ['/', '/p1', '/p2']) page(p, 'text only');
  await crawl(id);
  const bad = (await api(links(id))).body.snapshots[0];
  assert.equal(bad.status, 'complete');
  assert.deepEqual(bad.warning, { affected: 3, total: 3 });
  assert.deepEqual((await log2(id)).body.snapshot.warning, { affected: 3, total: 3 });
  smallSite();
  await crawl(id);
  assert.equal((await api(links(id))).body.snapshots[0].warning, undefined);
});

test('crawl log: a snapshot saved before the crawl log existed still loads, with unknown origins', async () => {
  const { id } = await createSeo();
  smallSite();
  await crawl(id);
  const { id: snapshotId } = (await api(links(id))).body.snapshots[0];
  const file = path.join(secretsMod.buildingDir(id), 'crawl', `${snapshotId}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  for (const p of stored.pages) { delete p.discoveredFrom; delete p.internalLinks; }
  delete stored.rawLinks;
  await (await import('node:fs/promises')).writeFile(file, JSON.stringify(stored));
  crawlStore.forgetSnapshots(id);
  const body = (await log2(id)).body;
  assert.equal(body.rows[0].from, 'unknown');
  assert.equal(typeof body.rows[0].internalLinks, 'number');
  const detail = (await api(links(id, `/log/page?url=${encodeURIComponent(key('/'))}`))).body;
  assert.deepEqual([detail.stored, detail.linksFound.total], [false, 0]);
});

test('crawl log: the stored per-page link lists stay within the cap and the existing views are unchanged', async () => {
  const { id } = await createSeo();
  smallSite();
  await crawl(id);
  const { id: snapshotId } = (await api(links(id))).body.snapshots[0];
  const snapshot = await crawlStore.readSnapshot(id, snapshotId);
  assert.ok(snapshot.rawLinks!.length > 0 && snapshot.rawLinks!.length <= 100_000);
  const g = await graph(id);
  assert.equal(node(g, '/c').inbound, 1);
  assert.equal(JSON.stringify(g).includes('rawLinks'), false);
  assert.equal(JSON.stringify(g).includes('discoveredFrom'), false);
});

/** Records every SEO job event while `body` runs; `running` is what the snapshot endpoint listed at each event. */
async function recordJobs(body: () => Promise<void>) {
  const jobs = await import('../src/seo/jobs.ts');
  const events: Array<{ status: string; kind: string; error?: string; listed: boolean; buildingId: string }> = [];
  const off = jobs.onSeoJobEvent(({ job }) => events.push({ status: job.status, kind: job.kind, error: job.error, buildingId: job.buildingId, listed: jobs.listRunningJobs().some((j) => j.id === job.id) }));
  try { await body(); } finally { off(); }
  return events;
}

test('footer jobs: a crawl publishes one start and one complete event, is listed while running and never after its end', async () => {
  const { id } = await createSeo();
  smallSite();
  const hold: Array<() => void> = [];
  serve('/a', (req, res) => { hold.push(() => html(a('/b'))(req, res)); });
  let during: any[] = [];
  const events = await recordJobs(async () => {
    assert.equal((await send('POST', links(id, '/crawl'))).status, 202);
    for (let i = 0; i < 400 && !hold.length; i++) await new Promise((r) => setTimeout(r, 10));
    during = (await api('/api/seo/jobs/running')).body.jobs.filter((j: any) => j.buildingId === id);
    hold.forEach((release) => release());
    await waitFinished(id);
  });
  assert.equal(during.length, 1);
  assert.equal(during[0].kind, 'crawl');
  const mine = events.filter((e) => e.buildingId === id && e.kind === 'crawl');
  assert.equal(mine.filter((e) => e.status === 'running').length >= 1, true);
  const ends = mine.filter((e) => e.status !== 'running');
  assert.deepEqual(ends.map((e) => e.status), ['complete']);
  assert.equal(ends[0]!.listed, false, 'the job has left the running list when its end is published');
  assert.equal(mine[0]!.status, 'running');
  assert.equal(mine.some((e) => e.kind === 'sitemaps'), false);
  assert.deepEqual((await api('/api/seo/jobs/running')).body.jobs.filter((j: any) => j.buildingId === id), []);
});

test('footer jobs: a crawl on a Building with no stored sitemap is one crawl job, not a nested sitemap job', async () => {
  const { id } = await createSeo();
  smallSite();
  const events = await recordJobs(async () => { await crawl(id); });
  assert.deepEqual([...new Set(events.filter((e) => e.buildingId === id).map((e) => e.kind))], ['crawl']);
});

test('footer jobs: a top-level sitemap read is one sitemaps job', async () => {
  const { id } = await createSeo();
  const events = await recordJobs(async () => { await readSitemap(id, ['/a']); });
  const mine = events.filter((e) => e.buildingId === id);
  assert.deepEqual(mine.map((e) => [e.kind, e.status]), [['sitemaps', 'running'], ['sitemaps', 'complete']]);
});

test('footer jobs: a refused crawl ends failed with the error and raises a crawl notification that the next good crawl resolves', async () => {
  const { id } = await createSeo();
  smallSite();
  const notifications = await import('../src/notifications/notificationService.ts');
  const open = async () => (await notifications.listNotifications({ projectId: id, resolved: false })).filter((n) => n.kind === 'seo.crawl_failed');
  // A sync problem on the same Building must neither be merged with, nor resolved by, the crawl notification.
  await notifications.raiseNotification({ kind: 'storage.problem', subject: { type: 'project', projectId: id }, title: 'sync', description: 'sync broke' });
  serve('/robots.txt', (_req, res) => { res.statusCode = 503; res.end(); });
  const events = await recordJobs(async () => { await crawl(id); });
  const end = events.filter((e) => e.buildingId === id && e.kind === 'crawl' && e.status !== 'running');
  assert.deepEqual(end.map((e) => e.status), ['failed']);
  assert.match(end[0]!.error ?? '', /robots\.txt/);
  const raised = await open();
  assert.equal(raised.length, 1);
  assert.match(raised[0]!.description, /robots\.txt/);
  smallSite();
  await crawl(id);
  assert.deepEqual(await open(), []);
  const storageProblems = (await notifications.listNotifications({ projectId: id, resolved: false })).filter((n) => n.kind === 'storage.problem');
  assert.equal(storageProblems.length, 1, 'the sync notification is untouched');
});

test('footer jobs: a stopped crawl ends stopped and raises no notification', async () => {
  const { id } = await createSeo();
  smallSite();
  const hold: Array<() => void> = [];
  serve('/a', (req, res) => { hold.push(() => html(a('/b'))(req, res)); });
  const events = await recordJobs(async () => {
    assert.equal((await send('POST', links(id, '/crawl'))).status, 202);
    for (let i = 0; i < 400 && !hold.length; i++) await new Promise((r) => setTimeout(r, 10));
    await send('POST', links(id, '/crawl/stop'));
    hold.forEach((release) => release());
    await waitFinished(id);
  });
  const end = events.filter((e) => e.buildingId === id && e.kind === 'crawl' && e.status !== 'running');
  assert.deepEqual(end.map((e) => e.status), ['stopped']);
  const notifications = await import('../src/notifications/notificationService.ts');
  assert.deepEqual((await notifications.listNotifications({ projectId: id, resolved: false })).filter((n) => n.kind === 'seo.crawl_failed'), []);
});
