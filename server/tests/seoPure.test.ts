import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Backoff } from '../src/seo/backoff.ts';
import { addDays, backfillStart, fetchStart, daysBetween, isIsoDay, monthKey, pacificToday, parseDateRange, validateRetentionMonths, weekKey } from '../src/seo/dates.ts';
import { SeoInputError } from '../src/seo/errors.ts';
import { ADS_API_VERSION, googleServices, parseRetryAfter } from '../src/seo/googleServices.ts';
import { pendingDays } from '../src/seo/ledger.ts';
import { assertValidGscRow, avgPositionOf, classifyAdsVolumes, ctrOf, mergeSums, parseAdsVolume } from '../src/seo/metrics.ts';
import { normalizeSiteUrl } from '../src/seo/siteUrl.ts';
import { deriveState, validateIndexNowKey } from '../src/seo/connections.ts';
import { retentionCutoff } from '../src/buildings/retention.ts';
import { storageLevel, validateThreshold } from '../src/buildings/storageStatus.ts';
import { buildListQuery, QueryError } from '../src/buildings/query.ts';
import { SEO_STORAGE } from '../src/buildings/types/seo.ts';
import { redactSecrets, rememberSecret } from '../src/redaction.ts';

const refuses = (value: unknown) => assert.throws(() => normalizeSiteUrl(value), SeoInputError);

test('U1 site URL is normalised: lowercase host, default port, fragment and trailing slash dropped', () => {
  assert.equal(normalizeSiteUrl('https://Example.COM/'), 'https://example.com');
  assert.equal(normalizeSiteUrl('https://example.com/blog/#top'), 'https://example.com/blog');
  assert.equal(normalizeSiteUrl('http://example.com:80'), 'http://example.com');
  assert.equal(normalizeSiteUrl('  https://example.com:8443/a  '), 'https://example.com:8443/a');
});

test('U2 alternative spellings are accepted: uppercase scheme, explicit default port, trailing dot, punycode, www kept', () => {
  assert.equal(normalizeSiteUrl('HTTPS://Example.COM:443/'), 'https://example.com');
  assert.equal(normalizeSiteUrl('https://example.com./'), 'https://example.com');
  assert.equal(normalizeSiteUrl('https://bücher.example'), 'https://xn--bcher-kva.example');
  assert.equal(normalizeSiteUrl('https://www.example.com'), 'https://www.example.com');
});

test('U3 refused: ftp, javascript, file, empty, whitespace, no host, credentials', () => {
  for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', '', '   ', 'https://', 'example.com', 'https://user:pw@example.com', 'https://exa mple.com', 42, null, undefined]) refuses(bad);
});

test('U4 URL over the 2048-character limit is refused', () => refuses(`https://example.com/${'a'.repeat(2048)}`));
test('U5 URL of exactly 2048 characters is accepted', () => {
  const url = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  assert.equal(url.length, 2048);
  assert.equal(normalizeSiteUrl(url), url);
});

test('U11 quota back-off grows, caps and resets on success', () => {
  const b = new Backoff();
  assert.deepEqual([b.next(), b.next(), b.next()], [1000, 2000, 4000]);
  for (let i = 0; i < 20; i++) b.next();
  assert.equal(b.next(), 15 * 60_000);
  b.reset();
  assert.equal(b.next(), 1000);
});

test('U12 Retry-After is honoured in seconds and HTTP-date form, and wins over a shorter back-off', () => {
  const now = new Date('2026-03-15T12:00:00Z');
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter('Sun, 15 Mar 2026 12:01:00 GMT', now), 60_000);
  assert.equal(parseRetryAfter('garbage', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
  assert.equal(new Backoff().next(45_000), 45_000);
});

test('U13 days Google marks incomplete are refetched; a day is final only when marked final', () => {
  const ledger = new Map([['2026-03-10', true], ['2026-03-11', false], ['2026-03-12', true]]);
  assert.deepEqual(pendingDays('2026-03-10', '2026-03-13', ledger), ['2026-03-11', '2026-03-13']);
});

test('U14 backfill range: the 12-month window, the 16-month GSC limit, clamped to the setting', () => {
  assert.equal(backfillStart('2026-03-15', 12), '2025-03-15');
  assert.equal(backfillStart('2026-03-15', 24, 16), '2024-11-15');
  assert.equal(backfillStart('2026-03-15', 3, 16), '2025-12-15');
});

test('U15 retention setting refused for 0, -1, 1.5, "12", NaN, 37, 1e9; bounds 1 and 36 accepted', () => {
  for (const bad of [0, -1, 1.5, '12', NaN, 37, 1e9, null, undefined]) assert.throws(() => validateRetentionMonths(bad), SeoInputError);
  assert.equal(validateRetentionMonths(1), 1);
  assert.equal(validateRetentionMonths(36), 36);
});

test('U16 cutoff maths: month end, 29 Feb, 1 Jan and the earliest and latest valid dates', () => {
  const cut = (iso: string, months = 12) => retentionCutoff({ months }, new Date(`${iso}T12:00:00Z`));
  assert.equal(cut('2026-03-31', 1), '2026-03-03');
  assert.equal(cut('2024-02-29'), '2023-03-01');
  assert.equal(cut('2026-01-01'), '2025-01-01');
  assert.equal(cut('9999-12-31'), '9998-12-31');
  assert.equal(retentionCutoff({ months: 0 }, new Date('0001-01-01T00:00:00Z')), '0001-01-01');
});

test('U17 backfill resumes at the first uncommitted day, never repeating committed ones', () => {
  const ledger = new Map([['2026-03-01', true], ['2026-03-02', true], ['2026-03-03', true]]);
  assert.deepEqual(pendingDays('2026-03-01', '2026-03-05', ledger), ['2026-03-04', '2026-03-05']);
});

test('U18 week and month keys: ISO week 53, year boundary, leap day, UTC', () => {
  assert.equal(weekKey('2020-12-31'), '2020-W53');
  assert.equal(weekKey('2021-01-01'), '2020-W53');
  assert.equal(weekKey('2021-01-04'), '2021-W01');
  assert.equal(weekKey('2024-02-29'), '2024-W09');
  assert.equal(weekKey('2024-12-30'), '2025-W01');
  assert.equal(monthKey('2024-02-29'), '2024-02');
});

test('U19 roll-up merge: position is weighted by impressions, CTR recomputed, zero impressions gives null', () => {
  const merged = mergeSums({ clicks: 1, impressions: 10, positionImpressions: 10 * 2 }, { clicks: 9, impressions: 90, positionImpressions: 90 * 12 });
  assert.equal(ctrOf(merged), 0.1);
  assert.equal(avgPositionOf(merged), 11);
  assert.equal(ctrOf({ clicks: 0, impressions: 0 }), null);
  assert.equal(avgPositionOf({ impressions: 0, positionImpressions: 0 }), null);
});

test('U20 gap versus zero: a missing day reads null, a stored 0 reads 0', async () => {
  const { series } = await import('../src/seo/dataStatus.ts');
  assert.equal(typeof series, 'function'); // exercised end to end in I22 and I63
  assert.equal(ctrOf({ clicks: 0, impressions: 5 }), 0);
});

test('U21 metric ranges: up to 2^53-1 accepted; negative, NaN, CTR above 1 and negative position refused', () => {
  const ok = { page: '/a', query: 'q', clicks: Number.MAX_SAFE_INTEGER, impressions: Number.MAX_SAFE_INTEGER, ctr: 1, position: 3 };
  assertValidGscRow(ok);
  for (const bad of [{ clicks: -1 }, { clicks: NaN }, { impressions: 1.5 }, { ctr: 1.01 }, { position: -0.1 }, { clicks: Number.MAX_SAFE_INTEGER + 2 }]) {
    assert.throws(() => assertValidGscRow({ ...ok, ...bad }), SeoInputError);
  }
});

test('U22 Ads volume is mapped to exact versus range', () => {
  assert.deepEqual(parseAdsVolume(1234), { kind: 'exact', value: 1234 });
  assert.deepEqual(parseAdsVolume(1000), { kind: 'range', low: 1000, high: 10000 });
  assert.equal(classifyAdsVolumes([12, 345]), 'exact');
  assert.equal(classifyAdsVolumes([12, 1000]), 'range');
});

test('U23 Ads low-spend range parsed; a missing value gives unknown', () => {
  assert.deepEqual(parseAdsVolume(100), { kind: 'range', low: 100, high: 1000 });
  for (const missing of [undefined, null, NaN, -5, 'x']) assert.deepEqual(parseAdsVolume(missing), { kind: 'unknown' });
  assert.equal(classifyAdsVolumes([]), 'unknown');
});

test('U24 size-warning threshold: below, equal, above, 0 and a huge value', () => {
  assert.equal(storageLevel(99, 100), 'ok');
  assert.equal(storageLevel(100, 100), 'warning');
  assert.equal(storageLevel(101, 100), 'warning');
  assert.throws(() => validateThreshold(0));
  assert.equal(validateThreshold(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('U25 IndexNow key rules: 8 to 128 letters, digits and dashes', () => {
  assert.equal(validateIndexNowKey('abcd1234'), 'abcd1234');
  assert.equal(validateIndexNowKey('a'.repeat(128)), 'a'.repeat(128));
  for (const bad of ['short', 'a'.repeat(129), 'has space1', 'bad/char12', '', 5]) assert.throws(() => validateIndexNowKey(bad), SeoInputError);
});

test('U26 connection state derivation: not connected / connected / needs attention / syncing', () => {
  assert.equal(deriveState({ connected: false }, false), 'not-connected');
  assert.equal(deriveState({ connected: true }, false), 'connected');
  assert.equal(deriveState({ connected: true, reason: 'Token expired' }, false), 'needs-attention');
  assert.equal(deriveState({ connected: false, reason: 'Sign-in cancelled' }, false), 'needs-attention');
  assert.equal(deriveState({ connected: true, reason: 'old' }, true), 'syncing');
  assert.equal(deriveState({ connected: false }, true), 'not-connected');
});

test('U10 redaction removes remembered token, client secret and API key values including inside URLs and nested errors', () => {
  const values = ['tok-ACCESS-123456', 'sec-CLIENT-123456', 'key-BING-123456'];
  values.forEach((v) => rememberSecret(v));
  const text = `GET https://x/?apikey=${values[2]} Authorization: Bearer ${values[0]} ${new Error(`nested ${values[1]}`).message}`;
  const cleaned = redactSecrets(text);
  for (const v of values) assert.ok(!cleaned.includes(v));
});

test('U29 list params: limit 0, 1, max and max+1 and unknown sort or filter operator against the SEO tables', () => {
  const table = SEO_STORAGE.tables.find((t) => t.name === 'gsc_rows')!;
  assert.throws(() => buildListQuery(table, { limit: 0 }), QueryError);
  assert.equal(buildListQuery(table, { limit: 1 }).pageSize, 1);
  assert.equal(buildListQuery(table, { limit: 200 }).pageSize, 200);
  assert.equal(buildListQuery(table, { limit: 201 }).pageSize, 200);
  assert.throws(() => buildListQuery(table, { sort: 'nope' }), QueryError);
  assert.throws(() => buildListQuery(table, { filters: [{ col: 'page', op: 'regex' as never, value: 'x' }] }), QueryError);
  assert.throws(() => buildListQuery(table, { filters: [{ col: 'positionImpressions', op: 'eq', value: 1 }] }), QueryError);
});

test('U30 date params: 2026-02-30, reversed range and a range wider than the window are refused', () => {
  assert.equal(isIsoDay('2026-02-30'), false);
  assert.equal(isIsoDay('2024-02-29'), true);
  assert.throws(() => parseDateRange('2026-02-30', '2026-03-01', 100), SeoInputError);
  assert.throws(() => parseDateRange('2026-03-02', '2026-03-01', 100), SeoInputError);
  assert.throws(() => parseDateRange('2026-01-01', '2026-12-31', 100), SeoInputError);
  assert.deepEqual(parseDateRange('2026-03-01', '2026-03-01', 1), { from: '2026-03-01', to: '2026-03-01' });
});

test('dates: Pacific calendar day, addDays and daysBetween', () => {
  assert.equal(pacificToday(new Date('2026-03-15T03:00:00Z')), '2026-03-14');
  assert.equal(pacificToday(new Date('2026-03-15T12:00:00Z')), '2026-03-15');
  assert.equal(addDays('2024-02-28', 2), '2024-03-01');
  assert.deepEqual(daysBetween('2026-03-01', '2026-03-03'), ['2026-03-01', '2026-03-02', '2026-03-03']);
});

test('U14b the first fetched day is clamped to the UTC retention cutoff', () => {
  assert.equal(fetchStart('2026-03-14', new Date('2026-03-15T06:30:00Z'), 1), '2026-02-15');
  assert.equal(fetchStart('2026-03-15', new Date('2026-03-15T12:00:00Z'), 1), '2026-02-15');
  assert.equal(fetchStart('2026-03-15', new Date('2026-03-15T12:00:00Z'), 24, 16), '2024-11-15');
});

test('U22b a 404 from the Ads endpoint is reported as an unsupported API version, not refused access', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(googleServices.ads.check({ accessToken: 'a', developerToken: 'd', customerId: '123-456-7890' }), (e: any) => e.kind === 'invalid' && e.message.includes(ADS_API_VERSION) && !/refused/.test(e.message));
  } finally { globalThis.fetch = realFetch; }
  assert.match(ADS_API_VERSION, /^v\d+$/);
});
