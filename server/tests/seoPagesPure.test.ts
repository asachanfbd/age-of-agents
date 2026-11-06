import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { SeoInputError } from '../src/seo/errors.ts';
import { classifyKeyFile, INDEXNOW_BATCH_SIZE, mapIndexNowResponse, maskedKeyFileName, redactKey, selectNewOrChanged, splitBatches } from '../src/seo/indexNowRules.ts';
import { BACKGROUND_LIMIT, DAILY_INSPECTION_QUOTA, grantable, inspectionOrder, mapIndexStatus, nextQuotaReset, quotaDay } from '../src/seo/inspectionQuota.ts';
import { inflateIfGzip } from '../src/seo/limitedFetch.ts';
import { changeScore, coverageOf, defaultWindows, deltaOf, MAX_RANGE_DAYS, metricsOf, parseRange, previousWindow, windowsFor, zeroTotals } from '../src/seo/period.ts';
import { parseRobotsSitemaps, parseSitemap, SitemapParseError } from '../src/seo/sitemapParse.ts';
import { inspectionUrlFor, isOnProperty, isSiteHost, normalizePageUrl, pageUrlFromPath, pathOf, rawVariants } from '../src/seo/urls.ts';

/* ----- URL normalisation (U1-U10) ----- */

test('U1 scheme and host are lowercased and the fragment is dropped', () => {
  assert.equal(normalizePageUrl('HTTPS://Example.COM/Blog#top'), 'https://example.com/Blog');
});

test('U2 http and https forms of one URL merge into one page', () => {
  assert.equal(normalizePageUrl('http://example.com/a'), normalizePageUrl('https://example.com/a'));
});

test('U3 /a and /a/ merge, and the root stays /', () => {
  assert.equal(normalizePageUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(normalizePageUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizePageUrl('https://example.com//'), 'https://example.com/');
});

test('U4 tracking parameters are stripped, others kept and sorted, and ?page=2 stays distinct', () => {
  assert.equal(normalizePageUrl('https://example.com/a?utm_source=x&b=2&a=1&gclid=9&fbclid=1&msclkid=2&UTM_medium=m'), 'https://example.com/a?a=1&b=2');
  assert.equal(normalizePageUrl('https://example.com/a?utm_source=x'), 'https://example.com/a');
  assert.notEqual(normalizePageUrl('https://example.com/a?page=2'), normalizePageUrl('https://example.com/a'));
});

test('U5 default ports are dropped and other ports kept', () => {
  assert.equal(normalizePageUrl('https://example.com:443/a'), 'https://example.com/a');
  assert.equal(normalizePageUrl('http://example.com:80/a'), 'https://example.com/a');
  assert.equal(normalizePageUrl('http://example.com:8080/a'), 'https://example.com:8080/a');
});

test('U6 percent escapes compare equal across case, unicode equals its encoded form, path case is kept', () => {
  assert.equal(normalizePageUrl('https://example.com/%7ea'), normalizePageUrl('https://example.com/%7Ea'));
  assert.equal(normalizePageUrl('https://example.com/caf%C3%A9'), normalizePageUrl('https://example.com/café'));
  assert.notEqual(normalizePageUrl('https://example.com/Abc'), normalizePageUrl('https://example.com/abc'));
});

test('U7 anything that is not an absolute http(s) address is rejected, including over 2,048 characters', () => {
  for (const bad of ['', '   ', '/relative', 'mailto:a@b.c', 'javascript:alert(1)', 'ftp://example.com/a', 'https://u:p@example.com/', 42, null, undefined]) assert.equal(normalizePageUrl(bad), null, String(bad));
  assert.equal(normalizePageUrl(`https://example.com/${'a'.repeat(2048)}`), null);
  assert.notEqual(normalizePageUrl(`https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`), null);
});

test('U8 www and the bare domain are not merged', () => {
  assert.notEqual(normalizePageUrl('https://www.example.com/a'), normalizePageUrl('https://example.com/a'));
});

test('U9 host classification follows the property type', () => {
  assert.equal(isOnProperty('https://blog.example.com/a', 'sc-domain:example.com'), true);
  assert.equal(isOnProperty('https://example.com/a', 'sc-domain:example.com'), true);
  assert.equal(isOnProperty('https://notexample.com/a', 'sc-domain:example.com'), false);
  assert.equal(isOnProperty('https://example.com/a', 'https://example.com/'), true);
  assert.equal(isOnProperty('https://blog.example.com/a', 'https://example.com/'), false);
  assert.equal(isOnProperty('https://www.example.com/a', 'https://example.com/'), false);
  assert.equal(isOnProperty('https://example.com/blog/a', 'https://example.com/blog/'), true);
  assert.equal(isOnProperty('https://example.com/shop/a', 'https://example.com/blog/'), false);
  assert.equal(isOnProperty('https://example.com/a', 'not a property'), false);
  assert.equal(isSiteHost('https://EXAMPLE.com/a', 'https://example.com'), true);
  assert.equal(isSiteHost('https://www.example.com/a', 'https://example.com'), false);
  assert.equal(isSiteHost('https://blog.example.com/a', 'https://example.com', 'sc-domain:example.com'), true);
  assert.equal(inspectionUrlFor('https://example.com/a', 'http://example.com/'), 'http://example.com/a');
  assert.equal(inspectionUrlFor('https://example.com/a', 'sc-domain:example.com'), 'https://example.com/a');
});

test('U10 variants from every source collapse into one page address', () => {
  const site = 'https://example.com';
  const urls = new Set([
    normalizePageUrl('https://example.com/a'), normalizePageUrl('http://example.com/a/?utm_source=x'), pageUrlFromPath('/a', site), pageUrlFromPath('/a/?gclid=1', site),
  ]);
  assert.deepEqual([...urls], ['https://example.com/a']);
  assert.equal(pageUrlFromPath('a', site), null);
  assert.equal(pathOf('https://example.com/a?b=1'), '/a?b=1');
  assert.ok(rawVariants('https://example.com/a').includes('http://example.com/a/'));
  assert.ok(rawVariants('https://example.com/').includes('https://example.com'));
  assert.ok(rawVariants('https://example.com/caf%C3%A9').includes('https://example.com/café'));
});

/* ----- Period maths (U11-U18) ----- */

test('U11 the default window ends at the last final day, or yesterday in Pacific time, and the previous window precedes it', () => {
  const windows = defaultWindows('2026-03-12', new Date('2026-03-15T12:00:00Z'));
  assert.deepEqual(windows.current, { from: '2026-02-13', to: '2026-03-12' });
  assert.deepEqual(windows.previous, { from: '2026-01-16', to: '2026-02-12' });
  // 06:30Z on 15 March is still the 14th in Pacific time, so "yesterday" is the 13th.
  assert.equal(defaultWindows(null, new Date('2026-03-15T06:30:00Z')).current.to, '2026-03-13');
  assert.equal(defaultWindows(null, new Date('2026-03-15T12:00:00Z')).current.to, '2026-03-14');
});

test('U12 delta: up, down, from zero is new, both zero is none, a missing side is none', () => {
  assert.deepEqual(deltaOf(150, 100), { abs: 50, pct: 0.5, isNew: false });
  assert.deepEqual(deltaOf(50, 100), { abs: -50, pct: -0.5, isNew: false });
  assert.deepEqual(deltaOf(5, 0), { abs: 5, pct: null, isNew: true });
  assert.equal(deltaOf(0, 0), null);
  assert.equal(deltaOf(5, null), null);
  assert.equal(deltaOf(null, 5), null);
  assert.deepEqual(deltaOf(0, 10), { abs: -10, pct: -1, isNew: false });
});

const full = { covered: 28, total: 28, state: 'full' as const };
const none = { covered: 0, total: 28, state: 'none' as const };

test('U13 CTR is total clicks over total impressions, and no impressions gives no CTR', () => {
  const m = metricsOf({ ...zeroTotals(), clicks: 11, impressions: 110, positionImpressions: 220 }, full, none);
  assert.equal(m.ctr, 0.1);
  assert.equal(metricsOf({ ...zeroTotals(), clicks: 0, impressions: 0 }, full, none).ctr, null);
});

test('U14 position is weighted by impressions, and lower is better in the delta sign', () => {
  assert.equal(metricsOf({ ...zeroTotals(), clicks: 1, impressions: 100, positionImpressions: 300 }, full, none).position, 3);
  assert.equal(metricsOf({ ...zeroTotals(), impressions: 0, positionImpressions: 0 }, full, none).position, null);
  assert.ok(deltaOf(2, 4)!.abs < 0, 'an improvement in position is a negative change');
});

test('U15 missing days make a partial window and no days make no data, never zero', () => {
  const days = new Set(['2026-03-01', '2026-03-02']);
  assert.deepEqual(coverageOf({ from: '2026-03-01', to: '2026-03-04' }, days), { covered: 2, total: 4, state: 'partial' });
  assert.equal(coverageOf({ from: '2026-04-01', to: '2026-04-04' }, days).state, 'none');
  assert.equal(coverageOf({ from: '2026-03-01', to: '2026-03-02' }, days).state, 'full');
  const nothing = metricsOf({ ...zeroTotals(), clicks: 0 }, none, none);
  assert.deepEqual(nothing, { clicks: null, impressions: null, ctr: null, position: null, sessions: null, keyEvents: null });
  const gscOnly = metricsOf({ ...zeroTotals(), clicks: 3, impressions: 9, sessions: 4 }, full, none);
  assert.equal(gscOnly.sessions, null);
  assert.equal(gscOnly.clicks, 3);
});

test('U16 a previous window that starts before the stored history is flagged partial', () => {
  const windows = windowsFor({ from: '2026-03-01', to: '2026-03-10' }, true);
  assert.deepEqual(windows.previous, { from: '2026-02-19', to: '2026-02-28' });
  assert.equal(coverageOf(windows.previous!, new Set(['2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28'])).state, 'partial');
  assert.equal(windowsFor({ from: '2026-03-01', to: '2026-03-10' }, false).previous, null);
  assert.deepEqual(previousWindow({ from: '2026-03-01', to: '2026-03-01' }), { from: '2026-02-28', to: '2026-02-28' });
});

test('U17 range validation covers order, format, real dates, the future and the length limit', () => {
  const now = new Date('2026-03-15T12:00:00Z');
  assert.deepEqual(parseRange('2026-03-01', '2026-03-10', now), { from: '2026-03-01', to: '2026-03-10' });
  for (const [from, to] of [['2026-03-10', '2026-03-01'], ['2026-3-1', '2026-03-10'], ['2026-02-29', '2026-03-10'], ['2026-03-01', '2026-03-16'], ['x', 'y'], [undefined, '2026-03-10']] as const) {
    assert.throws(() => parseRange(from, to, now), SeoInputError, `${from}..${to}`);
  }
  assert.deepEqual(parseRange('2028-02-29', '2028-02-29', new Date('2028-03-15T12:00:00Z')), { from: '2028-02-29', to: '2028-02-29' });
  assert.throws(() => parseRange('2024-01-01', '2026-03-10', now), /at most 400 days/);
  assert.doesNotThrow(() => parseRange('2025-02-10', '2026-03-15', now));
  assert.equal(MAX_RANGE_DAYS, 400);
});

test('U18 sums above 2^31 do not overflow', () => {
  const m = metricsOf({ ...zeroTotals(), clicks: 3_000_000_000, impressions: 6_000_000_000, positionImpressions: 12_000_000_000 }, full, none);
  assert.deepEqual([m.clicks, m.impressions, m.ctr, m.position], [3_000_000_000, 6_000_000_000, 0.5, 2]);
});

test('U20 changed-most scoring: relative change, new largest, no change last', () => {
  assert.ok(changeScore(deltaOf(5, 0)) > changeScore(deltaOf(1000, 10)));
  assert.ok(changeScore(deltaOf(20, 10)) > changeScore(deltaOf(11, 10)));
  assert.ok(changeScore(deltaOf(5, 10)) === changeScore(deltaOf(15, 10)));
  assert.equal(changeScore(null), -1);
  assert.equal(changeScore(deltaOf(10, 10)), -1);
});

/* ----- Sitemap XML (U27-U39) ----- */

const urlset = (body: string, ns = '') => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${ns}>${body}</urlset>`;

test('U27 a basic urlset with lastmod', () => {
  const parsed = parseSitemap(urlset('<url><loc>https://example.com/a</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://example.com/b</loc></url>'));
  assert.equal(parsed.kind, 'urlset');
  assert.deepEqual(parsed.entries, [{ loc: 'https://example.com/a', lastmod: '2026-01-02' }, { loc: 'https://example.com/b', lastmod: null }]);
  assert.equal(parsed.truncated, false);
});

test('U28 a sitemap index lists its children', () => {
  const parsed = parseSitemap('<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap><sitemap><loc>https://example.com/s2.xml</loc><lastmod>2026-01-01</lastmod></sitemap></sitemapindex>');
  assert.equal(parsed.kind, 'index');
  assert.equal(parsed.entries.length, 2);
});

test('U29 malformed XML names the line and counts nothing', () => {
  assert.throws(() => parseSitemap(urlset('<url><loc>https://example.com/a</loc>')), /unexpected closing tag <\/urlset>/);
  assert.throws(() => parseSitemap('<urlset><url><loc>https://example.com/a</loc>'), /never closed/);
  assert.throws(() => parseSitemap(`<urlset>\n<url>\n<loc>x</url></urlset>`), (e: Error) => e instanceof SitemapParseError && /line 3/.test(e.message));
  assert.throws(() => parseSitemap('<urlset><url><loc>a</loc></url'), SitemapParseError);
  assert.throws(() => parseSitemap('<urlset><!-- open'), /unterminated comment/);
  assert.throws(() => parseSitemap('<urlset>stray text</urlset>'.replace('stray text', '') + 'extra'), /outside the root|after the root/);
});

test('U30 an empty urlset is valid, a wrong root is "not a sitemap", empty input is refused', () => {
  assert.deepEqual(parseSitemap('<urlset></urlset>'), { kind: 'urlset', entries: [], truncated: false });
  assert.deepEqual(parseSitemap('<urlset/>'), { kind: 'urlset', entries: [], truncated: false });
  assert.throws(() => parseSitemap('<html><body>Not found</body></html>'), /not a sitemap: the root element is <html>/);
  assert.throws(() => parseSitemap(''), /not a sitemap/);
});

test('U31 entities, CDATA, namespace prefixes, a byte-order mark and whitespace inside loc', () => {
  const parsed = parseSitemap(`﻿<sm:urlset xmlns:sm="x"><sm:url><sm:loc>  https://example.com/a?x=1&amp;y=2  </sm:loc></sm:url><sm:url><sm:loc><![CDATA[https://example.com/b?x=1&y=2]]></sm:loc></sm:url><sm:url><sm:loc>https://example.com/&#99;&#x64;</sm:loc></sm:url></sm:urlset>`);
  assert.deepEqual(parsed.entries.map((e) => e.loc), ['https://example.com/a?x=1&y=2', 'https://example.com/b?x=1&y=2', 'https://example.com/cd']);
  assert.throws(() => parseSitemap(urlset('<url><loc>https://example.com/&nope;</loc></url>')), /undefined entity/);
});

test('U32 a DOCTYPE or entity declaration is refused, so entity expansion cannot start', () => {
  const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><urlset><url><loc>&lol2;</loc></url></urlset>';
  assert.throws(() => parseSitemap(laughs), /DOCTYPE and ENTITY declarations are not allowed/);
  assert.throws(() => parseSitemap('<!ELEMENT x><urlset/>'), SitemapParseError);
});

test('U33 50,000 URLs are accepted and more are cut at the cap with a truncated flag', () => {
  const body = (n: number) => urlset(Array.from({ length: n }, (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`).join(''));
  const exact = parseSitemap(body(50_000));
  assert.equal(exact.entries.length, 50_000);
  assert.equal(exact.truncated, false);
  const over = parseSitemap(body(50_001));
  assert.equal(over.entries.length, 50_000);
  assert.equal(over.truncated, true);
});

test('U34 gzip: real gzip is inflated whatever the name, plain data passes through, corrupt and oversize data is refused', async () => {
  const xml = Buffer.from(urlset('<url><loc>https://example.com/a</loc></url>'));
  assert.equal((await inflateIfGzip(gzipSync(xml), 1_000_000)).toString(), xml.toString());
  assert.equal((await inflateIfGzip(xml, 1_000_000)).toString(), xml.toString());
  const corrupt = gzipSync(xml);
  corrupt.writeUInt8(0, corrupt.length - 6);
  corrupt[corrupt.length - 1] = 0xff;
  await assert.rejects(inflateIfGzip(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not really gzip')]), 1_000_000), /not valid gzip/);
  await assert.rejects(inflateIfGzip(gzipSync(Buffer.alloc(5_000_000)), 1_000_000), /not valid gzip data or expands beyond/);
});

test('U38 robots.txt Sitemap lines: case-insensitive, several, comments, CRLF, a BOM; relative values are reported not used', () => {
  const robots = '﻿User-agent: *\r\nDisallow: /x\r\nSITEMAP: https://example.com/a.xml\r\nsitemap : https://example.com/b.xml # main\r\n# Sitemap: https://example.com/commented.xml\r\nSitemap: /relative.xml\r\n';
  assert.deepEqual(parseRobotsSitemaps(robots), { urls: ['https://example.com/a.xml', 'https://example.com/b.xml'], ignored: ['/relative.xml'] });
  assert.deepEqual(parseRobotsSitemaps(''), { urls: [], ignored: [] });
});

/* ----- Quota (U40-U46) ----- */

test('U40 the quota day resets at Pacific midnight across both DST edges', () => {
  assert.equal(quotaDay(new Date('2026-07-01T06:59:00Z')), '2026-06-30');
  assert.equal(quotaDay(new Date('2026-07-01T07:00:00Z')), '2026-07-01');
  assert.equal(quotaDay(new Date('2026-01-01T07:59:00Z')), '2025-12-31');
  assert.equal(quotaDay(new Date('2026-01-01T08:00:00Z')), '2026-01-01');
  assert.equal(nextQuotaReset(new Date('2026-07-01T12:00:00Z')).toISOString(), '2026-07-02T07:00:00.000Z');
  assert.equal(nextQuotaReset(new Date('2026-01-01T12:00:00Z')).toISOString(), '2026-01-02T08:00:00.000Z');
  // Spring forward 2026-03-08 (day is 23 hours long) and fall back 2026-11-01 (25 hours).
  assert.equal(nextQuotaReset(new Date('2026-03-08T12:00:00Z')).toISOString(), '2026-03-09T07:00:00.000Z');
  assert.equal(nextQuotaReset(new Date('2026-03-08T09:00:00Z')).toISOString(), '2026-03-09T07:00:00.000Z');
  assert.equal(nextQuotaReset(new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(nextQuotaReset(new Date('2026-11-01T05:30:00Z')).toISOString(), '2026-11-01T07:00:00.000Z');
  assert.equal(nextQuotaReset(new Date('2026-11-01T08:30:00Z')).toISOString(), '2026-11-02T08:00:00.000Z');
});

test('U41 reserve boundaries: background stops at 1,800, manual at 2,000', () => {
  assert.equal(BACKGROUND_LIMIT, 1800);
  assert.equal(grantable(1799, 5, 'background'), 1);
  assert.equal(grantable(1800, 5, 'background'), 0);
  assert.equal(grantable(1800, 5, 'manual'), 5);
  assert.equal(grantable(1999, 5, 'manual'), 1);
  assert.equal(grantable(2000, 5, 'manual'), 0);
  assert.equal(grantable(2500, 5, 'manual'), 0);
  assert.equal(DAILY_INSPECTION_QUOTA, 2000);
});

test('U42 background order: waiting requests, never inspected, changed, then the oldest stale; ties by URL', () => {
  const now = new Date('2026-03-15T00:00:00Z');
  const row = (url: string, extra: Partial<Parameters<typeof inspectionOrder>[0][number]> = {}) => ({ url, pending: false, inspectedAt: null, lastmod: null, firstSeen: '', ...extra });
  const order = inspectionOrder([
    row('https://e.com/stale-new', { inspectedAt: '2026-03-01T00:00:00Z' }),
    row('https://e.com/stale-old', { inspectedAt: '2026-02-01T00:00:00Z' }),
    row('https://e.com/fresh', { inspectedAt: '2026-03-14T00:00:00Z' }),
    row('https://e.com/changed', { inspectedAt: '2026-03-10T00:00:00Z', lastmod: '2026-03-12' }),
    row('https://e.com/b-never'), row('https://e.com/a-never'),
    row('https://e.com/waiting', { pending: true, inspectedAt: '2026-03-14T00:00:00Z' }),
  ], now).map((c) => c.url.replace('https://e.com/', ''));
  assert.deepEqual(order, ['waiting', 'a-never', 'b-never', 'changed', 'stale-old', 'stale-new']);
});

test('U45 result mapping: indexed, not indexed with the reason, and unknown keeping the raw text', () => {
  assert.deepEqual(mapIndexStatus({ verdict: 'PASS', coverageState: 'Submitted and indexed' }), { state: 'indexed', reason: '', raw: 'Submitted and indexed' });
  assert.deepEqual(mapIndexStatus({ verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' }), { state: 'not-indexed', reason: 'Crawled - currently not indexed', raw: 'Crawled - currently not indexed' });
  assert.equal(mapIndexStatus({ verdict: 'FAIL' }).reason, 'Not indexed (Google gave no reason)');
  assert.deepEqual(mapIndexStatus({ verdict: 'VERDICT_UNSPECIFIED', coverageState: 'A state from the future' }), { state: 'unknown', reason: '', raw: 'A state from the future' });
  assert.equal(mapIndexStatus(undefined).state, 'unknown');
});

/* ----- IndexNow (U47-U52) ----- */

test('U47 batching: one URL is one batch, 10,000 is one, 10,001 is two', () => {
  assert.equal(splitBatches(['a']).length, 1);
  assert.equal(splitBatches(Array.from({ length: INDEXNOW_BATCH_SIZE }, (_, i) => `u${i}`)).length, 1);
  const two = splitBatches(Array.from({ length: INDEXNOW_BATCH_SIZE + 1 }, (_, i) => `u${i}`));
  assert.deepEqual(two.map((b) => b.length), [10_000, 1]);
  assert.deepEqual(splitBatches([]), []);
});

test('U49 response mapping: accepted, rejected with a reason, rate limited with Retry-After, server errors', () => {
  const now = new Date('2026-03-15T12:00:00Z');
  assert.equal(mapIndexNowResponse(200, null, now).result, 'accepted');
  assert.match(mapIndexNowResponse(202, null, now).message, /not a confirmation that the pages were indexed/);
  assert.match(mapIndexNowResponse(200, null, now).message, /not a confirmation/);
  assert.equal(mapIndexNowResponse(400, null, now).result, 'rejected');
  assert.match(mapIndexNowResponse(403, null, now).message, /key is not valid/);
  assert.match(mapIndexNowResponse(422, null, now).message, /do not belong to the key's host/);
  assert.equal(mapIndexNowResponse(429, '120', now).retryAfterMs, 120_000);
  assert.equal(mapIndexNowResponse(429, 'Sun, 15 Mar 2026 12:05:00 GMT', now).retryAfterMs, 300_000);
  assert.equal(mapIndexNowResponse(429, null, now).retryAfterMs, undefined);
  assert.equal(mapIndexNowResponse(503, null, now).result, 'error');
  assert.equal(mapIndexNowResponse(418, null, now).result, 'rejected');
});

test('U51 key file classification', () => {
  const key = 'abcdef1234567890';
  const ok = (body: string, extra: Partial<Parameters<typeof classifyKeyFile>[0]> = {}) => classifyKeyFile({ status: 200, body, contentType: 'text/plain', key, ...extra });
  assert.equal(ok(key), 'reachable');
  assert.equal(ok(`${key}\n`), 'reachable');
  assert.equal(ok(`${key}\r\n`), 'reachable');
  assert.equal(ok('another-key'), 'mismatch');
  assert.equal(ok('', { status: 404 }), 'not-found');
  assert.equal(ok('', { status: 500 }), 'error');
  assert.equal(ok('<!doctype html><html>Not found</html>', { contentType: 'text/html' }), 'html');
  assert.equal(ok('<html>', { contentType: 'text/plain' }), 'html');
});

test('U52 redaction removes the key wherever it appears, including inside a URL', () => {
  const key = 'secret-key-1234';
  assert.equal(redactKey(`failed for https://example.com/${key}.txt and ${key}`, key), 'failed for https://example.com/[key].txt and [key]');
  assert.equal(redactKey('nothing here', key), 'nothing here');
  assert.equal(redactKey('text', ''), 'text');
  assert.equal(maskedKeyFileName(key).includes(key), false);
  assert.equal(maskedKeyFileName(key), 'secr…34.txt');
});

test('U33b new or changed selection: new since the previous read, changed after the last accepted submission', () => {
  const listed = [
    { url: 'new', lastmod: null, firstSeen: '2026-03-10T00:00:00Z' },
    { url: 'old-submitted', lastmod: '2026-03-01', firstSeen: '2026-03-01T00:00:00Z' },
    { url: 'changed', lastmod: '2026-03-09', firstSeen: '2026-03-01T00:00:00Z' },
    { url: 'new-already-sent', lastmod: null, firstSeen: '2026-03-10T00:00:00Z' },
  ];
  const accepted = new Map([['old-submitted', '2026-03-05T00:00:00Z'], ['changed', '2026-03-05T00:00:00Z'], ['new-already-sent', '2026-03-11T00:00:00Z']]);
  assert.deepEqual(selectNewOrChanged(listed, '2026-03-05T00:00:00Z', accepted), ['new', 'changed']);
  assert.equal(selectNewOrChanged(listed, null, new Map()).length, 4, 'with no earlier read every address is new');
});

/* ----- Pages table model (U19-U22) ----- */

const { sortRows, filterRows, changedMost } = await import('../src/seo/pages.ts');
const { limitedFetch, LimitedFetchError } = await import('../src/seo/limitedFetch.ts');
const { deltasOf, emptyMetrics } = await import('../src/seo/period.ts');

const pageRow = (path: string, current: Partial<ReturnType<typeof emptyMetrics>>, previous: Partial<ReturnType<typeof emptyMetrics>> | null = null) => {
  const c = { ...emptyMetrics(), ...current };
  const p = previous ? { ...emptyMetrics(), ...previous } : null;
  return { url: `https://e.com${path}`, path, sources: { gsc: true, ga4: false, sitemaps: 0 }, current: c, previous: p, delta: deltasOf(c, p) };
};

test('U19 every column sorts both ways, no data goes last either way, ties break by path', () => {
  const rows = [pageRow('/b', { clicks: 5 }), pageRow('/a', { clicks: 5 }), pageRow('/none', {}), pageRow('/big', { clicks: 9 })];
  assert.deepEqual(sortRows(rows, 'clicks', 'desc').map((r) => r.path), ['/big', '/a', '/b', '/none']);
  assert.deepEqual(sortRows(rows, 'clicks', 'asc').map((r) => r.path), ['/a', '/b', '/big', '/none']);
  assert.deepEqual(sortRows(rows, 'path', 'desc').map((r) => r.path), ['/none', '/big', '/b', '/a']);
  for (const key of ['impressions', 'ctr', 'position', 'sessions', 'keyEvents'] as const) assert.equal(sortRows(rows, key, 'asc').length, 4);
});

test('U20b changed most ranks by relative clicks change with no-change and no-data rows left out', () => {
  const rows = [pageRow('/small', { clicks: 11 }, { clicks: 10 }), pageRow('/new', { clicks: 3 }, { clicks: 0 }), pageRow('/big', { clicks: 30 }, { clicks: 10 }), pageRow('/same', { clicks: 4 }, { clicks: 4 }), pageRow('/gap', { clicks: 4 }, {})];
  assert.deepEqual(changedMost(rows).map((r) => r.path), ['/new', '/big', '/small']);
});

test('U21 and U22 search, path prefix and the two impression filters', () => {
  const rows = [pageRow('/blog/Post', { clicks: 0, impressions: 10 }), pageRow('/blog/other', { clicks: 2, impressions: 10 }), pageRow('/shop', { clicks: 0, impressions: 0 }), pageRow('/gap', {})];
  const f = (extra: object) => filterRows(rows, { filter: 'all', search: '', prefix: '', ...extra }).map((r) => r.path);
  assert.deepEqual(f({ search: 'post' }), ['/blog/Post']);
  assert.deepEqual(f({ prefix: 'blog' }), ['/blog/Post', '/blog/other']);
  assert.deepEqual(f({ prefix: '/blog/(' }), []);
  assert.deepEqual(f({ filter: 'no-clicks' }), ['/blog/Post']);
  assert.deepEqual(f({ filter: 'no-impressions' }), ['/shop']);
  assert.deepEqual(f({ filter: 'no-clicks', prefix: '/shop' }), []);
});

test('limited fetch reports an unreachable site without naming the address', async () => {
  await assert.rejects(limitedFetch('http://127.0.0.1:1/secret-key.txt', { maxBytes: 100, timeoutMs: 1000 }), (e: Error) => e instanceof LimitedFetchError && e.kind === 'network' && !e.message.includes('secret-key'));
});
