import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDatabase } from '../src/db/FileDatabase.ts';

interface Widget {
  id: string;
  name: string;
}

async function withTempFile(run: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'file-database-test-'));
  try {
    await run(path.join(dir, 'widgets.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('all() returns an empty array when the file has never been written', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    assert.deepEqual(await db.all(), []);
  }));

test('insert() persists a record and get() finds it back by id', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'Widget A' });
    assert.deepEqual(await db.get('a'), { id: 'a', name: 'Widget A' });

    const onDisk = JSON.parse(await readFile(filePath, 'utf-8'));
    assert.deepEqual(onDisk.records, [{ id: 'a', name: 'Widget A' }]);
  }));

test('insert() rejects a duplicate id without touching the existing record', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'first' });
    await assert.rejects(() => db.insert({ id: 'a', name: 'second' }));
    assert.deepEqual(await db.get('a'), { id: 'a', name: 'first' });
  }));

test('update() merges a patch and returns the updated record', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'first' });
    const updated = await db.update('a', { name: 'renamed' });
    assert.deepEqual(updated, { id: 'a', name: 'renamed' });
    assert.deepEqual(await db.get('a'), { id: 'a', name: 'renamed' });
  }));

test('update() on a missing id returns undefined and writes nothing new', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    assert.equal(await db.update('missing', { name: 'x' }), undefined);
    assert.deepEqual(await db.all(), []);
  }));

test('updateMany() commits every patch together and leaves the cache unchanged on failure', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'first' });
    await db.insert({ id: 'b', name: 'second' });
    await assert.rejects(() => db.updateMany([
      { id: 'a', patch: { name: 'changed' } },
      { id: 'missing', patch: { name: 'invalid' } },
    ]));
    assert.deepEqual((await db.all()).map((record) => record.name), ['first', 'second']);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf-8')).records.map((record: Widget) => record.name), ['first', 'second']);
    await db.updateMany([
      { id: 'a', patch: { name: 'changed' } },
      { id: 'b', patch: { name: 'updated' } },
    ]);
    assert.deepEqual((await db.all()).map((record) => record.name), ['changed', 'updated']);
  }));

test('delete() removes a record and reports whether it existed', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'first' });
    assert.equal(await db.delete('a'), true);
    assert.equal(await db.delete('a'), false);
    assert.deepEqual(await db.all(), []);
  }));

test('find() filters records with a predicate', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'apple' });
    await db.insert({ id: 'b', name: 'banana' });
    assert.deepEqual(await db.find((w) => w.name.startsWith('a')), [{ id: 'a', name: 'apple' }]);
  }));

test('a fresh instance reads back what a prior instance persisted', () =>
  withTempFile(async (filePath) => {
    await new FileDatabase<Widget>(filePath).insert({ id: 'a', name: 'first' });
    const reopened = new FileDatabase<Widget>(filePath);
    assert.deepEqual(await reopened.all(), [{ id: 'a', name: 'first' }]);
  }));

test('concurrent mutations against the same instance never interleave (no lost updates)', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: '' });
    await Promise.all(Array.from({ length: 20 }, (_, i) => db.update('a', { name: `write-${i}` })));
    const onDisk = JSON.parse(await readFile(filePath, 'utf-8'));
    assert.equal(onDisk.records.length, 1);
    assert.match(onDisk.records[0].name, /^write-\d+$/);
  }));

test('updateWith() computes the patch from the record\'s own current state', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'first' });
    const updated = await db.updateWith('a', (current) => ({ name: `${current.name}-suffixed` }));
    assert.deepEqual(updated, { id: 'a', name: 'first-suffixed' });
    assert.deepEqual(await db.get('a'), { id: 'a', name: 'first-suffixed' });
  }));

test('updateWith() on a missing id returns undefined and writes nothing new', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    assert.equal(await db.updateWith('missing', () => ({ name: 'x' })), undefined);
    assert.deepEqual(await db.all(), []);
  }));

test('updateWith() supports an async patch function', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'first' });
    const updated = await db.updateWith('a', async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { name: `${current.name}-async` };
    });
    assert.deepEqual(updated, { id: 'a', name: 'first-async' });
  }));

test('concurrent updateWith() calls against the same instance never lose an update (unlike a plain read-then-write)', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget & { count: number }>(filePath);
    await db.insert({ id: 'a', name: '', count: 0 });
    // 20 callers each incrementing from the record's *own* current state, run concurrently — if
    // updateWith ever computed its patch from a stale read instead of the live queued record, some
    // of these increments would be lost and the final count would come out below 20.
    await Promise.all(Array.from({ length: 20 }, () => db.updateWith('a', (current) => ({ count: current.count + 1 }))));
    assert.equal((await db.get('a'))?.count, 20);
  }));

test('a failed mutation does not wedge the queue for the next caller', () =>
  withTempFile(async (filePath) => {
    const db = new FileDatabase<Widget>(filePath);
    await db.insert({ id: 'a', name: 'first' });
    await assert.rejects(() => db.insert({ id: 'a', name: 'dup' }));
    // The queue must still be usable afterward.
    await db.insert({ id: 'b', name: 'second' });
    assert.deepEqual(await db.get('b'), { id: 'b', name: 'second' });
  }));
