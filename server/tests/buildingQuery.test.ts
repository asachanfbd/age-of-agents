import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, QueryError, buildAggregateQuery, buildListQuery, decodeCursor, encodeCursor, escapeLike, parseLimit, toRowArray } from '../src/buildings/query.ts';
import { describeRetention, retentionCutoff } from '../src/buildings/retention.ts';
import { DEFAULT_WARNING_BYTES, storageLevel, validateThreshold } from '../src/buildings/storageStatus.ts';
import { NOTES_STORAGE } from '../src/buildings/types/notes.ts';

const metrics = NOTES_STORAGE.tables.find((t) => t.name === 'metrics')!;
const daily = NOTES_STORAGE.rollups.find((r) => r.name === 'daily')!;

test('U31/U35 no limit gives the default page; over the maximum is clamped', () => {
  assert.equal(parseLimit(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(parseLimit(''), DEFAULT_PAGE_SIZE);
  assert.equal(parseLimit('25'), 25);
  assert.equal(parseLimit(10_000), MAX_PAGE_SIZE);
  assert.equal(buildListQuery(metrics, {}).pageSize, DEFAULT_PAGE_SIZE);
  assert.match(buildListQuery(metrics, {}).sql, new RegExp(`LIMIT ${DEFAULT_PAGE_SIZE + 1}$`));
});

test('U32 zero, negative and non-numeric limits are rejected', () => {
  for (const bad of [0, -1, 'abc', '1.5', 2.5, 'all', NaN]) assert.throws(() => parseLimit(bad), QueryError);
});

test('U33/U34 a cursor round-trips its sort key and id, and a garbled one is rejected', () => {
  assert.deepEqual(decodeCursor(encodeCursor('2025-01-01', 42)), ['2025-01-01', 42]);
  assert.deepEqual(decodeCursor(encodeCursor(7, 1)), [7, 1]);
  for (const bad of ['not base64 json', Buffer.from('[1]').toString('base64url'), Buffer.from('{"a":1}').toString('base64url'), Buffer.from('["x","y"]').toString('base64url')]) {
    assert.throws(() => decodeCursor(bad), QueryError);
  }
  assert.throws(() => buildListQuery(metrics, { cursor: 'garbage' }), /cursor/);
});

test('U36 sort columns and directions are allow-listed', () => {
  assert.throws(() => buildListQuery(metrics, { sort: 'query' }), /cannot sort/);
  assert.throws(() => buildListQuery(metrics, { sort: 'id; DROP TABLE metrics' }), /cannot sort/);
  assert.throws(() => buildListQuery(metrics, { sort: 'day', dir: 'sideways' }), /dir/);
  assert.match(buildListQuery(metrics, { sort: 'clicks', dir: 'DESC' }).sql, /ORDER BY clicks DESC, id DESC/);
});

test('U37 filters are allow-listed per column and values are always bound', () => {
  assert.throws(() => buildListQuery(metrics, { filters: [{ col: 'id', op: 'eq', value: 1 }] }), /cannot filter/);
  assert.throws(() => buildListQuery(metrics, { filters: [{ col: 'page', op: 'DROP' as never, value: 'x' }] }), /operator/);
  assert.throws(() => buildListQuery(metrics, { filters: [{ col: 'clicks', op: 'gt', value: 'abc' }] }), /numeric/);
  const injection = "'; DROP TABLE metrics;--";
  const q = buildListQuery(metrics, { filters: [{ col: 'page', op: 'eq', value: injection }] });
  assert.ok(!q.sql.includes('DROP'));
  assert.deepEqual(q.params, [injection]);
});

test('U38 search escapes LIKE wildcards and requires searchable columns', () => {
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
  const q = buildListQuery(metrics, { search: "100% o'neil" });
  assert.deepEqual(q.params, ["%100\\% o'neil%", "%100\\% o'neil%"]);
  assert.throws(() => buildListQuery({ ...metrics, searchable: undefined }, { search: 'x' }), /not searchable/);
});

test('the cursor adds a keyset condition on the sort key and id, in the sort direction', () => {
  const cursor = encodeCursor(5, 99);
  assert.match(buildListQuery(metrics, { sort: 'clicks', dir: 'asc', cursor }).sql, /\(clicks, id\) > \(\?, \?\)/);
  assert.match(buildListQuery(metrics, { sort: 'clicks', dir: 'desc', cursor }).sql, /\(clicks, id\) < \(\?, \?\)/);
  assert.match(buildListQuery(metrics, { cursor }).sql, /id > \?/);
});

test('aggregates read only the roll-up table and allow-list group, range and order columns', () => {
  const q = buildAggregateQuery(daily, { groupBy: ['day'], range: { col: 'day', from: '2025-01-01', to: '2025-12-31' }, orderBy: 'clicks', limit: 5 });
  assert.match(q.sql, /FROM rollup_daily WHERE day >= \? AND day <= \? GROUP BY day ORDER BY clicks DESC LIMIT 5/);
  assert.deepEqual(q.params, ['2025-01-01', '2025-12-31']);
  assert.match(buildAggregateQuery(daily, {}).sql, /LIMIT 1$/);
  assert.throws(() => buildAggregateQuery(daily, { groupBy: ['page'] }), /cannot group/);
  assert.throws(() => buildAggregateQuery(daily, { range: { col: 'page' } }), /cannot range/);
  assert.throws(() => buildAggregateQuery(daily, { groupBy: ['day'], orderBy: 'query' }), /cannot order/);
  assert.throws(() => buildAggregateQuery(daily, { groupBy: ['day'], limit: 0 }), QueryError);
});

test('toRowArray puts values in column order and rejects missing or mistyped columns', () => {
  const row = { day: '2025-01-01', page: '/a', query: 'q', clicks: 1, impressions: 2 };
  assert.deepEqual(toRowArray(metrics, row), ['2025-01-01', '/a', 'q', 1, 2]);
  assert.throws(() => toRowArray(metrics, { ...row, clicks: undefined }), /clicks is required/);
  assert.throws(() => toRowArray(metrics, { ...row, clicks: 1.5 }), /whole number/);
  assert.throws(() => toRowArray(metrics, { ...row, page: 3 }), /must be text/);
  assert.throws(() => toRowArray(metrics, 'nope'), /object/);
});

test('U39 the cutoff comes from the window and the clock; a row on the cutoff day is kept', () => {
  assert.equal(retentionCutoff({ months: 12 }, new Date('2026-03-15T10:00:00Z')), '2025-03-15');
  assert.equal(retentionCutoff({ months: 1 }, new Date('2026-01-31T00:00:00Z')), '2025-12-31');
  assert.ok(!('2025-03-15' < '2025-03-15'), 'rows dated exactly at the cutoff are not before it');
});

test('U40/U42 no rule means nothing is discarded; a rule reads in plain words', () => {
  assert.match(describeRetention(undefined), /Nothing is discarded/);
  assert.match(describeRetention(NOTES_STORAGE.retention), /"metrics" dated more than 12 months ago are discarded.*reduced/);
  assert.match(describeRetention({ ...NOTES_STORAGE.retention!, months: 1, mode: 'rollup' }), /1 month ago.*keep covering/);
});

test('U44/U45 the size level turns to warning at the threshold, and the threshold must be positive', () => {
  assert.equal(storageLevel(99, 100), 'ok');
  assert.equal(storageLevel(100, 100), 'warning');
  assert.equal(storageLevel(101, 100), 'warning');
  assert.equal(storageLevel(DEFAULT_WARNING_BYTES - 1), 'ok');
  assert.equal(storageLevel(DEFAULT_WARNING_BYTES), 'warning');
  assert.equal(validateThreshold(1024.9), 1024);
  for (const bad of [0, -5, NaN, Infinity, '10', null]) assert.throws(() => validateThreshold(bad), RangeError);
});
