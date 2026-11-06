import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFileName, checkFileSize, decodeBytes, detectDelimiter, readFile, uniqueHeaders } from '../src/seo/backlinkCsv.ts';
import { parseCsv as parseDelimited } from '../src/seo/keywordCsv.ts';
import { planImport, statusOf } from '../src/seo/backlinkImport.ts';
import type { LinkRec } from '../src/seo/backlinkImport.ts';
import { applyPreset, BACKLINK_FIELDS, mappingName, PRESETS, suggestPreset, validateMapping } from '../src/seo/backlinkMapping.ts';
import { domainRollup, requireNote, requirePeriod, selectLinks, summarise, targetRollup, validateQuery } from '../src/seo/backlinkMetrics.ts';
import type { LinkQuery } from '../src/seo/backlinkMetrics.ts';
import { linkKey, parseLinkDate, parseLinkType, parseMetric, parseRow } from '../src/seo/backlinkRows.ts';
import type { LinkInput } from '../src/seo/backlinkRows.ts';

const SITE = 'https://example.com';
const TODAY = '2026-10-14';

/* ----- file and format ----- */

test('U1 a UTF-8 byte-order mark is stripped', () => {
  assert.equal(decodeBytes(Buffer.from('﻿a,b')).text, 'a,b');
});

test('U2/U3 UTF-16 with a byte-order mark is decoded in both byte orders', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,é', 'utf16le')]);
  assert.deepEqual(decodeBytes(le), { text: 'a,é', encoding: 'utf-16le' });
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('a,é', 'utf16le').swap16()]);
  assert.deepEqual(decodeBytes(be), { text: 'a,é', encoding: 'utf-16be' });
});

test('U4/U5 invalid UTF-8 is read as windows-1252; valid non-ASCII UTF-8 is untouched', () => {
  assert.deepEqual(decodeBytes(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xfc])), { text: 'café ü', encoding: 'windows-1252' });
  assert.equal(decodeBytes(Buffer.from('日本 😀')).text, '日本 😀');
});

test('U6/U7/U8 delimiters: comma, semicolon, tab and pipe are detected; quoted ones are ignored; nothing found means comma', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.equal(detectDelimiter('a|b|c'), '|');
  assert.equal(detectDelimiter('"a,b,c";d'), ';');
  assert.equal(detectDelimiter('single\nvalue'), ',');
});

test('U9 CRLF, LF and CR end rows, and a quoted cell can hold a line break and doubled quotes', () => {
  assert.deepEqual(parseDelimited('a,b\r\n1,2\n3,4\r5,6', ','), [['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
  assert.deepEqual(parseDelimited('a,b\n"x\ny","say ""hi"""', ','), [['a', 'b'], ['x\ny', 'say "hi"']]);
});

test('U10 an empty, whitespace-only and header-only file each get a clear error', () => {
  assert.throws(() => readFile('a.csv', Buffer.from(''), 1000), /empty/);
  assert.throws(() => readFile('a.csv', Buffer.from('  \n '), 1000), /empty/);
  assert.throws(() => readFile('a.csv', Buffer.from('source,target'), 1000), /no links/);
});

test('U11 binary content is refused as not a CSV', () => {
  assert.throws(() => readFile('a.csv', Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), 1000), /not a CSV/);
  assert.throws(() => readFile('a.csv', Buffer.from('a,b\n1\u0000,2'), 1000), /not a CSV/);
});

test('U12 .csv, .tsv and .txt are accepted in any case; other extensions are refused', () => {
  for (const ok of ['a.csv', 'A.CSV', 'b.tsv', 'c.TXT']) assert.equal(checkFileName(ok), ok);
  for (const bad of ['a.xlsx', 'a.json', 'a.pdf', 'noext', '', undefined]) assert.throws(() => checkFileName(bad), /not a CSV or TSV file/);
});

test('U13 the size cap passes exactly the cap and refuses one byte over, naming the limit', () => {
  checkFileSize(15_000_000, 15_000_000);
  assert.throws(() => checkFileSize(15_000_001, 15_000_000), /15 MB limit/);
});

test('U15 a short row is kept; a row longer than the header is a row error', () => {
  const ctx = { siteUrl: SITE, today: TODAY, headers: ['s', 't', 'a'], mapping: { sourceUrl: 's', targetUrl: 't' } };
  assert.equal(parseRow(['https://x.com/p', '/pricing'], ctx).ok, true);
  const long = parseRow(['https://x.com/p', '/pricing', 'a', 'extra'], ctx);
  assert.deepEqual(long.ok ? null : long.error, 'The row has more cells than the header');
});

test('U25 empty and repeated headers get distinct names', () => {
  assert.deepEqual(uniqueHeaders(['A', 'A', '', ' B ']), ['A', 'A (2)', 'Column 3', 'B']);
});

/* ----- mapping ----- */

const HEADERS = {
  ahrefs: ['Referring page URL', 'Target URL', 'Anchor', 'Domain rating', 'UR', 'Domain traffic', 'Page traffic', 'First seen', 'Last seen', 'Type', 'Title'],
  semrush: ['Page ascore', 'Source url', 'Target url', 'Anchor', 'First seen', 'Last seen', 'Nofollow'],
  moz: ['Source URL', 'Target URL', 'Anchor Text', 'Source Domain Authority', 'Source Page Authority', 'Link Type', 'Date First Seen', 'Date Last Seen'],
  gsc: ['Linking page', 'Target page', 'Last crawled'],
};

test('U16-U19 each preset maps every field its export has', () => {
  for (const preset of PRESETS) {
    const headers = HEADERS[preset.id as keyof typeof HEADERS];
    const mapping = applyPreset(preset, headers);
    for (const field of Object.keys(preset.headers)) assert.ok(headers.includes(mapping[field as keyof typeof mapping]!), `${preset.id} ${field}`);
    assert.equal(validateMapping(mapping, headers).sourceUrl !== undefined, true);
  }
});

test('U20 header matching ignores case, spacing, punctuation and a byte-order mark', () => {
  assert.equal(applyPreset(PRESETS[0]!, ['﻿referring  PAGE-url', 'target_url']).sourceUrl, '﻿referring  PAGE-url');
});

test('U21 a preset is suggested from the headers; none or an ambiguous fit gives null', () => {
  assert.equal(suggestPreset(HEADERS.ahrefs)?.id, 'ahrefs');
  assert.equal(suggestPreset(['x', 'y']), null);
  assert.equal(suggestPreset(['Source URL', 'Source url', 'Target URL', 'Target url']), null);
});

test('U22/U24 a mapping without a required column, with a clash, or naming a missing column is refused', () => {
  assert.throws(() => validateMapping({ sourceUrl: 'a' }, ['a', 'b']), /Target URL needs a column/);
  assert.throws(() => validateMapping({ sourceUrl: 'a', targetUrl: 'a' }, ['a']), /cannot hold both/);
  assert.throws(() => validateMapping({ sourceUrl: 'a', targetUrl: 'zzz' }, ['a']), /not in the file/);
  assert.throws(() => validateMapping({ sourceUrl: 'a', targetUrl: 'b', bogus: 'c' }, ['a', 'b', 'c']), /not a field/);
  assert.throws(() => validateMapping(null, ['a']), /missing/);
  assert.deepEqual(validateMapping({ sourceUrl: 'a', targetUrl: 'b', anchor: '' }, ['a', 'b']), { sourceUrl: 'a', targetUrl: 'b' });
});

test('U23 columns no field uses become extras keyed by header', () => {
  const ctx = { siteUrl: SITE, today: TODAY, headers: ['s', 't', 'Title', 'Empty'], mapping: { sourceUrl: 's', targetUrl: 't' } };
  const result = parseRow(['https://x.com/p', '/a', ' A title ', ''], ctx);
  assert.deepEqual(result.ok ? result.link.extras : null, { Title: 'A title' });
});

test('Ahrefs UR is the source UR, the same field the Moz page authority fills', () => {
  assert.equal(applyPreset(PRESETS[0]!, HEADERS.ahrefs).sourceUr, 'UR');
  assert.equal(applyPreset(PRESETS[2]!, HEADERS.moz).sourceUr, 'Source Page Authority');
});

test('U26 a saved mapping name is 1 to 60 characters', () => {
  assert.throws(() => mappingName(' '), /name/);
  assert.equal(mappingName('x'.repeat(60)).length, 60);
  assert.throws(() => mappingName('x'.repeat(61)), /name/);
});

test('U92 every preset has required fields and a unique id', () => {
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  for (const p of PRESETS) assert.ok(p.headers.sourceUrl && p.headers.targetUrl);
  assert.ok(BACKLINK_FIELDS.includes('pageDr'));
});

/* ----- row parsing ----- */

const mapping = { sourceUrl: 'src', targetUrl: 'tgt', anchor: 'anchor', linkType: 'type', firstSeen: 'first', lastSeen: 'last', sourceDr: 'dr', sourceUr: 'ur', sourceTraffic: 'traffic', pageTraffic: 'ptraffic' };
const headers = ['src', 'tgt', 'anchor', 'type', 'first', 'last', 'dr', 'ur', 'traffic', 'ptraffic'];
const ctx = { siteUrl: SITE, today: TODAY, headers, mapping };
const row = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = { src: 'https://Blog.Other.com/post/#frag', tgt: 'https://example.com/pricing', anchor: '  Best   tool ', type: '', first: '', last: '', dr: '', ur: '', traffic: '', ptraffic: '', ...over };
  return parseRow(headers.map((h) => base[h]!), ctx);
};
const bad = (over: Record<string, string>) => { const r = row(over); assert.equal(r.ok, false, JSON.stringify(over)); return r.ok ? '' : r.error; };
const good = (over: Record<string, string> = {}) => { const r = row(over); assert.equal(r.ok, true, JSON.stringify(r)); return r.ok ? r.link : (null as never); };

test('U28/U37 the source URL is normalised and the anchor is trimmed and collapsed', () => {
  const link = good();
  assert.equal(link.sourceUrl, 'https://blog.other.com/post');
  assert.equal(link.anchor, 'Best tool');
  assert.equal(link.sourceHost, 'blog.other.com');
});

test('U29/U30 source URLs that cannot be used are refused', () => {
  for (const s of ['htp:/bad', 'ftp://x.com/a', 'javascript:alert(1)', 'mailto:a@b.c', '', '   ', 'https://u:p@x.com/a', `https://x.com/${'a'.repeat(2049)}`, 'example.com/p']) bad({ src: s });
  good({ src: `https://x.com/${'a'.repeat(2048 - 14)}` });
});

test('U32/U33/U35/U36 targets: missing, relative, other host and unparsable', () => {
  assert.equal(bad({ tgt: '' }), 'Target URL missing');
  assert.equal(good({ tgt: '/pricing' }).targetUrl, 'https://example.com/pricing');
  assert.equal(good({ tgt: '/pricing' }).otherHost, false);
  assert.equal(good({ tgt: 'https://elsewhere.com/x' }).otherHost, true);
  assert.equal(good({ tgt: 'https://www.example.com/x' }).otherHost, true);
  assert.equal(good({ tgt: 'HTTP://Example.com:443/x' }).otherHost, false);
  assert.match(bad({ tgt: 'not a url' }), /Target URL is not a valid address/);
});

test('U37 anchor of 1000 characters is accepted and 1001 refused', () => {
  good({ anchor: 'a'.repeat(1000) });
  assert.match(bad({ anchor: 'a'.repeat(1001) }), /Anchor text/);
});

test('U38 link type is case-insensitive, multi-valued, blank is null, unknown is an error', () => {
  assert.equal(parseLinkType('DoFollow'), 'follow');
  assert.equal(parseLinkType('nofollow, ugc'), 'nofollow,ugc');
  assert.equal(parseLinkType('ugc nofollow'), 'nofollow,ugc');
  assert.equal(parseLinkType('  '), null);
  assert.throws(() => parseLinkType('weird'), /Link type/);
});

test('U39-U43 DR and UR: blank is null, 0 stays 0, 0..100 allowed, text and out-of-range refused, decimal comma read', () => {
  assert.equal(parseMetric('', 'DR', 100), null);
  assert.equal(parseMetric('0', 'DR', 100), 0);
  assert.equal(parseMetric('100', 'DR', 100), 100);
  for (const t of ['-1', '100.01', '101']) assert.throws(() => parseMetric(t, 'DR', 100), /out of range/);
  for (const t of ['n/a', '—', 'abc', '1e2', 'Infinity', 'NaN']) assert.throws(() => parseMetric(t, 'DR', 100), /DR is not a number/);
  assert.equal(parseMetric('62,5', 'DR', 100), 62.5);
  assert.equal(parseMetric('62.5', 'DR', 100), 62.5);
  assert.equal(good({ ur: '38' }).sourceUr, 38);
  assert.match(bad({ ur: '200' }), /UR is out of range/);
});

test('U44 traffic: blank null, 0 kept, thousands separator, rounding, negative and unsafe refused', () => {
  assert.equal(good({ traffic: '' }).sourceTraffic, null);
  assert.equal(good({ traffic: '0' }).sourceTraffic, 0);
  assert.equal(good({ traffic: '12,400' }).sourceTraffic, 12400);
  assert.equal(good({ traffic: '12.6' }).sourceTraffic, 13);
  assert.equal(good({ traffic: '9007199254740991' }).sourceTraffic, 9007199254740991);
  assert.match(bad({ traffic: '-5' }), /out of range/);
  assert.match(bad({ traffic: '99999999999999999999' }), /out of range/);
  assert.equal(good({ ptraffic: '7' }).pageTraffic, 7);
});

test('U46-U50 dates: ISO forms accepted, ambiguous or impossible refused, range and order checked, missing is null', () => {
  for (const ok of ['2026-10-01', '2026-10-01T12:30:00Z', '2026-10-01 12:30:00', '2026-10-01T12:30:00+05:30']) assert.equal(parseLinkDate(ok, 'D', TODAY), '2026-10-01');
  for (const t of ['2026-02-30', 'yesterday', '10/01/2026', '0000-00-00']) assert.throws(() => parseLinkDate(t, 'D', TODAY), /not a date/);
  assert.throws(() => parseLinkDate('1989-12-31', 'D', TODAY), /outside/);
  assert.equal(parseLinkDate('1990-01-01', 'D', TODAY), '1990-01-01');
  assert.equal(parseLinkDate('2026-10-15', 'D', TODAY), '2026-10-15');
  assert.throws(() => parseLinkDate('2026-10-16', 'D', TODAY), /outside/);
  assert.equal(parseLinkDate('', 'D', TODAY), null);
  assert.match(bad({ first: '2026-10-05', last: '2026-10-01' }), /First seen is after last seen/);
});

test('U31 an internationalised host and its punycode spelling are one source', () => {
  assert.equal(good({ src: 'https://bücher.example/p' }).key, good({ src: 'https://xn--bcher-kva.example/p' }).key);
});

test('U45 linking-page metrics parse like the source ones', () => {
  const pageCtx = { siteUrl: SITE, today: TODAY, headers: ['s', 't', 'pd', 'pu', 'pt'], mapping: { sourceUrl: 's', targetUrl: 't', pageDr: 'pd', pageUr: 'pu', pageTraffic: 'pt' } };
  const ok = parseRow(['https://x.com/p', '/a', '45,5', '0', '1,000'], pageCtx);
  assert.deepEqual(ok.ok ? [ok.link.pageDr, ok.link.pageUr, ok.link.pageTraffic] : null, [45.5, 0, 1000]);
  const blank = parseRow(['https://x.com/p', '/a', '', '', ''], pageCtx);
  assert.deepEqual(blank.ok ? [blank.link.pageDr, blank.link.pageUr, blank.link.pageTraffic] : null, [null, null, null]);
  assert.equal(parseRow(['https://x.com/p', '/a', '101', '', ''], pageCtx).ok, false);
});

test('U51 an extra value over 500 characters is truncated and at most 50 extra columns are kept', () => {
  const many = Array.from({ length: 60 }, (_, i) => `x${i}`);
  const c = { siteUrl: SITE, today: TODAY, headers: ['s', 't', ...many], mapping: { sourceUrl: 's', targetUrl: 't' } };
  const r = parseRow(['https://x.com/p', '/a', 'v'.repeat(600), ...many.slice(1).map(() => 'v')], c);
  assert.ok(r.ok);
  const extras = r.ok ? r.link.extras : {};
  assert.equal(Object.keys(extras).length, 50);
  assert.equal(extras.x0!.length, 500);
});

test('U52 the link key joins source, target and anchor; another anchor is another link', () => {
  assert.equal(good({ src: 'HTTPS://blog.other.com/post' }).key, good().key);
  assert.notEqual(good({ anchor: 'other' }).key, good().key);
  assert.equal(good().key, linkKey('https://blog.other.com/post', 'https://example.com/pricing', 'Best tool'));
});

test('U58 values that look like formulas are stored raw', () => {
  assert.equal(good({ anchor: '=HYPERLINK("x")' }).anchor, '=HYPERLINK("x")');
});

test('a bad row that still names a link carries its key', () => {
  const r = row({ dr: 'oops' });
  assert.ok(!r.ok && r.key !== null);
  const noKey = row({ src: '' });
  assert.ok(!noKey.ok && noKey.key === null);
});

/* ----- import diff and lost links ----- */

const input = (n: string, over: Partial<LinkInput> = {}): LinkInput => ({
  key: `k${n}`, sourceUrl: `https://s${n}.com/`, sourceHost: `s${n}.com`, targetUrl: 'https://example.com/a', anchor: '', linkType: null, firstSeen: null, lastSeen: null,
  sourceDr: null, sourceUr: null, sourceTraffic: null, pageDr: null, pageUr: null, pageTraffic: null, otherHost: false, extras: {}, ...over,
});
let uid = 0;
const newUid = () => `u${++uid}`;
const apply = (stored: LinkRec[], inputs: LinkInput[], mode: 'full' | 'partial', batch: number, skipped: string[] = [], today = TODAY) => {
  const existing = new Map(stored.map((l) => [l.key, l]));
  const plan = planImport(existing, inputs, new Set(skipped), mode, batch, today, newUid);
  const next = new Map(existing);
  for (const c of plan.changes) next.set(c.key, c);
  return { plan, links: [...next.values()] };
};

test('U59/U68 rows classify as added, updated or unchanged; the first full import marks nothing lost', () => {
  const first = apply([], [input('1', { firstSeen: '2026-01-01', lastSeen: '2026-01-02' }), input('2')], 'full', 1);
  assert.deepEqual(first.plan.counts, { added: 2, updated: 0, unchanged: 0, lost: 0, returned: 0 });
  const again = apply(first.links, [input('1', { firstSeen: '2026-01-01', lastSeen: '2026-01-02' }), input('2', { sourceDr: 50 })], 'full', 2);
  assert.deepEqual(again.plan.counts, { added: 0, updated: 1, unchanged: 1, lost: 0, returned: 0 });
});

test('U60/U61 a full export marks absent live links lost; a partial update never does', () => {
  const stored = apply([], [input('1'), input('2')], 'full', 1).links;
  const full = apply(stored, [input('1')], 'full', 2);
  assert.equal(full.plan.counts.lost, 1);
  assert.equal(full.links.find((l) => l.key === 'k2')!.lostAt, TODAY);
  assert.equal(apply(stored, [input('1')], 'partial', 2).plan.counts.lost, 0);
});

test('U62/U63 a lost link that returns is live with its first seen kept; one that stays absent keeps its lost date', () => {
  const stored = apply([], [input('1', { firstSeen: '2026-01-01' }), input('2', { lastSeen: '2026-01-05' })], 'full', 1).links;
  const lost = apply(stored, [input('1')], 'full', 2, [], '2026-02-01').links;
  const stay = apply(lost, [input('1')], 'full', 3, [], '2026-03-01');
  assert.equal(stay.plan.counts.lost, 0);
  assert.equal(stay.links.find((l) => l.key === 'k2')!.lostAt, '2026-02-01');
  const back = apply(lost, [input('1'), input('2', { lastSeen: '2026-04-01' })], 'full', 4, [], '2026-04-02');
  const k2 = back.links.find((l) => l.key === 'k2')!;
  assert.equal(k2.lostAt, '');
  assert.equal(back.plan.counts.returned, 1);
  assert.equal(k2.lastSeen, '2026-04-01');
  assert.equal(statusOf(k2, 4), 'live');
});

test('U65 an invalid row that still names a link does not mark it lost', () => {
  const stored = apply([], [input('1'), input('2')], 'full', 1).links;
  assert.equal(apply(stored, [input('1')], 'full', 2, ['k2']).plan.counts.lost, 0);
});

test('U66 an empty value never overwrites a stored metric; a given one does', () => {
  const stored = apply([], [input('1', { sourceDr: 40, linkType: 'follow' })], 'full', 1).links;
  const same = apply(stored, [input('1', { sourceTraffic: 9 })], 'partial', 2).links[0]!;
  assert.deepEqual([same.sourceDr, same.sourceTraffic, same.linkType], [40, 9, 'follow']);
  assert.equal(apply(stored, [input('1', { sourceDr: 41 })], 'partial', 2).links[0]!.sourceDr, 41);
});

test('U67 a link is new only in the batch that first brought it', () => {
  const one = apply([], [input('1')], 'full', 1).links;
  assert.equal(statusOf(one[0]!, 1), 'new');
  const two = apply(one, [input('1', { sourceDr: 10 })], 'partial', 2).links;
  assert.equal(statusOf(two[0]!, 2), 'live');
});

test('U69 first seen takes the earliest date and last seen the latest', () => {
  const stored = apply([], [input('1', { firstSeen: '2026-03-01', lastSeen: '2026-03-05' })], 'full', 1).links;
  const next = apply(stored, [input('1', { firstSeen: '2026-02-01', lastSeen: '2026-02-10' })], 'partial', 2).links[0]!;
  assert.deepEqual([next.firstSeen, next.lastSeen], ['2026-02-01', '2026-03-05']);
});

/* ----- metrics ----- */

const rec = (n: string, over: Partial<LinkRec> = {}): LinkRec => ({
  uid: `u-${n}`, key: `k${n}`, sourceUrl: `https://${n}.com/p`, sourceHost: `${n}.com`, targetUrl: 'https://example.com/a', anchor: n, linkType: 'follow', firstSeen: '2026-10-10', lastSeen: '2026-10-10',
  sourceDr: null, sourceUr: null, sourceTraffic: null, pageDr: null, pageUr: null, pageTraffic: null, otherHost: false, extras: {}, note: '', firstBatch: 1, lostAt: '', ...over,
});

test('U70-U73 domain rollup: links, best DR, traffic sum; nulls stay null; lost links are excluded', () => {
  const links = [
    rec('a', { sourceDr: 50, sourceTraffic: 100 }), rec('a2', { sourceHost: 'a.com', sourceDr: 70, sourceTraffic: 0 }),
    rec('b'), rec('c', { sourceDr: 0, sourceTraffic: 5 }), rec('gone', { sourceDr: 99, lostAt: '2026-10-01' }),
  ];
  const rollup = new Map(domainRollup(links).map((d) => [d.domain, d]));
  assert.deepEqual(rollup.get('a.com'), { domain: 'a.com', links: 2, bestDr: 70, totalTraffic: 100 });
  assert.deepEqual(rollup.get('b.com'), { domain: 'b.com', links: 1, bestDr: null, totalTraffic: null });
  assert.equal(rollup.get('c.com')!.bestDr, 0);
  assert.equal(rollup.has('gone.com'), false);
});

test('U73/U74/U77 summary: totals, average DR over domains with DR (1 decimal), coverage counts DR 0', () => {
  const links = [rec('a', { sourceDr: 50 }), rec('a2', { sourceHost: 'a.com', sourceDr: 60 }), rec('b', { sourceDr: 0 }), rec('c'), rec('gone', { lostAt: '2026-10-12' })];
  const s = summarise(links, 28, TODAY);
  assert.deepEqual(s, { total: 4, referringDomains: 3, newInPeriod: 4, lostInPeriod: 1, averageDr: 30, withDr: 3 });
  assert.equal(summarise([rec('x')], 28, TODAY).averageDr, null);
  assert.equal(summarise([rec('x', { sourceDr: 33 }), rec('y', { sourceDr: 34 }), rec('z', { sourceDr: 34 })], 28, TODAY).averageDr, 33.7);
});

test('U75 hosts are grouped exactly: www, subdomains and bare domain are separate', () => {
  const links = [rec('a', { sourceHost: 'a.com' }), rec('b', { sourceHost: 'www.a.com' }), rec('c', { sourceHost: 'blog.a.com' }), rec('d', { sourceHost: 'a.com' })];
  assert.equal(domainRollup(links).length, 3);
});

test('U76 target rollup: links, referring domains, best DR; other-host targets are separate', () => {
  const links = [rec('a', { sourceDr: 10 }), rec('b', { sourceDr: 20 }), rec('c', { targetUrl: 'https://elsewhere.com/', otherHost: true })];
  const t = targetRollup(links);
  assert.deepEqual(t[0], { target: 'https://example.com/a', links: 2, domains: 2, bestDr: 20, otherHost: false });
  assert.equal(t[1]!.otherHost, true);
});

const query = (over: Partial<LinkQuery> = {}): LinkQuery => ({ view: 'all', period: 28, status: null, type: null, drMin: null, drMax: null, domain: '', target: '', search: '', sort: 'firstSeen', dir: 'desc', ...over });

test('U78/U79 period windows use the injected day; new uses first seen and lost uses the lost date', () => {
  const links = [rec('in', { firstSeen: '2026-09-16' }), rec('edge', { firstSeen: '2026-09-16' }), rec('out', { firstSeen: '2026-09-15' }), rec('lostin', { lostAt: '2026-10-01', firstSeen: '2026-01-01' }), rec('lostout', { lostAt: '2026-08-01' })];
  const names = (q: LinkQuery) => selectLinks(links, q, 1, TODAY).map((l) => l.uid.slice(2)).sort();
  assert.deepEqual(names(query({ view: 'new' })), ['edge', 'in']);
  assert.deepEqual(names(query({ view: 'new', period: 90 })), ['edge', 'in', 'out']);
  assert.deepEqual(names(query({ view: 'lost' })), ['lostin']);
  assert.deepEqual(names(query({ view: 'lost', period: 90 })), ['lostin', 'lostout']);
  assert.deepEqual(names(query({ view: 'new', period: 7 })), []);
  assert.equal(requirePeriod(undefined), 28);
  assert.throws(() => requirePeriod('30'), /period must be/);
});

test('U81/U82 DR range: bounds, null excluded when any bound is set, DR 0 included, min above max refused', () => {
  const links = [rec('a', { sourceDr: 0 }), rec('b', { sourceDr: 50 }), rec('c', { sourceDr: 80 }), rec('d')];
  const pick = (q: Partial<LinkQuery>) => selectLinks(links, query(q), 1, TODAY).map((l) => l.uid.slice(2)).sort();
  assert.deepEqual(pick({ drMin: 0 }), ['a', 'b', 'c']);
  assert.deepEqual(pick({ drMax: 50 }), ['a', 'b']);
  assert.deepEqual(pick({ drMin: 50, drMax: 50 }), ['b']);
  assert.deepEqual(pick({}), ['a', 'b', 'c', 'd']);
  assert.throws(() => validateQuery(query({ drMin: 60, drMax: 10 })), /cannot be above/);
});

test('U83/U84 status, type, domain, target filters combine; search is literal and case-insensitive', () => {
  const links = [rec('a', { linkType: 'nofollow,ugc' }), rec('b', { targetUrl: 'https://example.com/b', anchor: '50% off (now)' }), rec('c', { lostAt: '2026-10-01' })];
  const pick = (q: Partial<LinkQuery>) => selectLinks(links, query(q), 1, TODAY).map((l) => l.uid.slice(2)).sort();
  assert.deepEqual(pick({ status: 'lost' }), ['c']);
  assert.deepEqual(pick({ status: 'new' }), ['a', 'b']);
  assert.deepEqual(pick({ type: 'ugc' }), ['a']);
  assert.deepEqual(pick({ domain: 'B.com' }), ['b']);
  assert.deepEqual(pick({ target: 'https://example.com/b', status: 'new' }), ['b']);
  assert.deepEqual(pick({ search: '50% OFF (' }), ['b']);
  assert.deepEqual(pick({ search: '.*(' }), []);
  assert.throws(() => validateQuery(query({ status: 'bogus' as never })), /status must be/);
  assert.throws(() => validateQuery(query({ type: 'bogus' })), /type must be/);
  assert.throws(() => validateQuery(query({ search: 'x'.repeat(201) })), /search can be/);
});

test('U85 sort puts empty values last in both directions and breaks ties on the link id', () => {
  const links = [rec('a', { sourceDr: 10 }), rec('b'), rec('c', { sourceDr: 30 }), rec('d', { sourceDr: 10 })];
  const order = (dir: 'asc' | 'desc') => selectLinks(links, query({ sort: 'dr', dir }), 1, TODAY).map((l) => l.uid.slice(2));
  assert.deepEqual(order('asc'), ['a', 'd', 'c', 'b']);
  assert.deepEqual(order('desc'), ['c', 'a', 'd', 'b']);
});

test('U90 notes are trimmed, empty clears, 2000 characters accepted and 2001 refused', () => {
  assert.equal(requireNote('  hi '), 'hi');
  assert.equal(requireNote(undefined), '');
  assert.equal(requireNote('x'.repeat(2000)).length, 2000);
  assert.throws(() => requireNote('x'.repeat(2001)), /2,000/);
  assert.throws(() => requireNote(5), /text/);
});
